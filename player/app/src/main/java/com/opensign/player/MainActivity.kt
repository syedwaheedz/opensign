package com.opensign.player

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.MotionEvent
import android.widget.LinearLayout
import android.widget.Toast
import android.view.View
import android.webkit.WebView
import android.widget.Button
import android.widget.FrameLayout
import android.widget.ImageView
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.lifecycle.lifecycleScope
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.load
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue
import android.graphics.Color
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var api: Api
    private lateinit var cache: MediaCache
    private lateinit var player: ExoPlayer
    private lateinit var root: FrameLayout
    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var webView: WebView
    private lateinit var statusView: TextView
    private lateinit var alertView: TextView
    private val pendingPlays = ConcurrentLinkedQueue<JSONObject>() // proof-of-play, sent with the next heartbeat
    private lateinit var setupButton: Button
    private lateinit var controlsBar: LinearLayout
    private var hideControlsJob: Job? = null
    private var syncJob: Job? = null
    private var itemJob: Job? = null // the item currently on screen, cancelled by "Next"

    @Volatile private var config: Config? = null
    @Volatile private var pairingCode: String? = null
    @Volatile private var nowPlaying: String? = null
    @Volatile private var connectError: String? = null // why the last sync failed, shown on the status screen
    @Volatile private var clockOffset = 0L // server time minus local time, keeps wall screens in step
    private var appliedWall: Wall? = null
    private var appliedSize = 0 to 0
    private val jobs = mutableListOf<Job>()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        setContentView(R.layout.activity_main)
        api = Api(prefs)
        cache = MediaCache(this, api)
        root = findViewById(R.id.root)
        playerView = findViewById(R.id.playerView)
        imageView = findViewById(R.id.imageView)
        webView = findViewById(R.id.webView)
        statusView = findViewById(R.id.statusView)
        alertView = findViewById(R.id.alertView)
        setupButton = findViewById(R.id.setupButton)
        setupButton.setOnClickListener { openSetup() } // works with a mouse, touch or the remote's OK
        controlsBar = findViewById(R.id.controlsBar)
        findViewById<Button>(R.id.nextButton).setOnClickListener { skipItem() }
        findViewById<Button>(R.id.refreshButton).setOnClickListener { refreshNow() }
        findViewById<Button>(R.id.settingsButton).setOnClickListener { openSetup() }
        root.setOnLongClickListener { openSetup(); true }

        player = ExoPlayer.Builder(this).build().also { playerView.player = it }
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
        }
        prefs.cachedConfig?.let { runCatching { config = Config.parse(it) } }
        hideSystemBars()
    }

    override fun onStart() {
        super.onStart()
        syncJob = lifecycleScope.launch { syncLoop() }.also { jobs += it }
        jobs += lifecycleScope.launch { heartbeatLoop() }
        jobs += lifecycleScope.launch { alertLoop() }
        jobs += lifecycleScope.launch { playbackLoop() }
        showControls() // visible briefly at start so people can find them
    }

    override fun onStop() {
        super.onStop()
        jobs.forEach { it.cancel() }
        jobs.clear()
    }

    override fun onDestroy() {
        super.onDestroy()
        if (::player.isInitialized) player.release()
        if (::webView.isInitialized) webView.destroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemBars()
    }

    private fun hideSystemBars() {
        WindowCompat.setDecorFitsSystemWindows(window, false)
        WindowInsetsControllerCompat(window, window.decorView).apply {
            hide(WindowInsetsCompat.Type.systemBars())
            systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        }
    }

    // MENU, or holding OK on the remote, opens server settings.
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        showControls() // any remote key brings the buttons back
        return when (keyCode) {
            KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> { openSetup(); true }
            // On a focused button, OK must press it; elsewhere a long press opens settings.
            KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER ->
                if (currentFocus is Button) super.onKeyDown(keyCode, event) else { event.startTracking(); true }
            else -> super.onKeyDown(keyCode, event)
        }
    }

    // Touch or mouse movement anywhere on screen brings the on-screen buttons back.
    override fun dispatchTouchEvent(ev: MotionEvent): Boolean {
        showControls()
        return super.dispatchTouchEvent(ev)
    }

    override fun dispatchGenericMotionEvent(ev: MotionEvent): Boolean {
        if (ev.actionMasked == MotionEvent.ACTION_HOVER_MOVE) showControls()
        return super.dispatchGenericMotionEvent(ev)
    }

    /** Shows the buttons and hides them again after a few idle seconds. */
    private fun showControls() {
        if (!::controlsBar.isInitialized) return
        hideControlsJob?.cancel()
        controlsBar.animate().cancel() // a half-finished fade-out must not hide the buttons again
        if (controlsBar.visibility != View.VISIBLE) {
            controlsBar.alpha = 0f
            controlsBar.visibility = View.VISIBLE
        }
        controlsBar.animate().alpha(1f).setDuration(150).start()
        hideControlsJob = lifecycleScope.launch {
            delay(4_000)
            controlsBar.animate().alpha(0f).setDuration(300).withEndAction { controlsBar.visibility = View.GONE }.start()
        }
    }

    private fun skipItem() {
        if (config?.wall != null) {
            Toast.makeText(this, "Not available in a video wall (screens play in sync)", Toast.LENGTH_SHORT).show()
            return
        }
        itemJob?.cancel()
    }

    private fun refreshNow() {
        syncJob?.cancel()
        syncJob = lifecycleScope.launch { syncLoop() }.also { jobs += it }
        Toast.makeText(this, "Refreshing…", Toast.LENGTH_SHORT).show()
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean =
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) { openSetup(); true }
        else super.onKeyLongPress(keyCode, event)

    private fun openSetup() = startActivity(Intent(this, SetupActivity::class.java))

    // ---- background loops ---------------------------------------------------

    private suspend fun syncLoop() {
        var failures = 0
        while (true) {
            var wait = 0L // 0 = long-poll for changes instead of sleeping
            if (prefs.serverUrl == null) {
                // First run: look for the server on the network instead of asking for an address.
                val found = withContext(Dispatchers.IO) { Discovery.find() }
                if (found == null) { delay(2_000); continue }
                prefs.serverUrl = found
            }
            try {
                when (val r = withContext(Dispatchers.IO) { api.fetchConfig() }) {
                    is ConfigResult.Pairing -> {
                        pairingCode = r.code
                        config = null
                        prefs.cachedConfig = null
                        wait = 5_000L
                    }
                    is ConfigResult.Ready -> {
                        pairingCode = null
                        if (r.config.serverTime > 0) clockOffset = r.config.serverTime - System.currentTimeMillis()
                        if (r.config.version != config?.version) {
                            prefs.cachedConfig = r.json
                            config = r.config
                        }
                        withContext(Dispatchers.IO) { cache.sync(r.config) }
                    }
                }
                failures = 0
                connectError = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                connectError = e.message ?: e.javaClass.simpleName
                // Offline or server down: keep playing the cached config. If the server's address
                // changed (router gave it a new IP), look for it again.
                if (++failures >= 3) {
                    withContext(Dispatchers.IO) { Discovery.find() }?.let { prefs.serverUrl = it; failures = 0 }
                }
            }
            if (wait > 0) {
                delay(wait)
            } else {
                // Returns as soon as the server has something new; fails fast when offline.
                val ok = try {
                    withContext(Dispatchers.IO) { api.waitForChange(config?.version) }
                    true
                } catch (e: CancellationException) {
                    throw e
                } catch (e: Exception) {
                    false
                }
                if (!ok) delay(10_000)
            }
        }
    }

    private suspend fun heartbeatLoop() {
        while (true) {
            val batch = generateSequence { pendingPlays.poll() }.take(200).toList()
            val sent = runCatching {
                withContext(Dispatchers.IO) { api.heartbeat(nowPlaying, config?.version, JSONArray(batch)) }
            }.isSuccess
            if (!sent && pendingPlays.size < 2_000) pendingPlays.addAll(batch) // keep for the next try
            delay(30_000)
        }
    }

    private suspend fun playbackLoop() {
        var playlistId: String? = null
        var index = 0
        while (root.width == 0) delay(50) // wait for first layout so wall tiles are sized correctly
        while (true) {
            val active = config?.activePlaylist()
            if (active == null || active.second.isEmpty()) {
                nowPlaying = null
                showStatus(statusText())
                delay(2_000)
                continue
            }
            val (id, items) = active
            val wall = config?.wall
            applyWall(wall)
            if (id != playlistId) { playlistId = id; index = 0 }

            // Normal mode walks the playlist in order; wall mode derives the item from the
            // shared server clock so every screen in the wall shows the same frame.
            val item: Item
            var startMs = 0L
            var forMs: Long? = null
            if (wall != null) {
                val cycle = items.sumOf { it.duration * 1000L }
                var pos = (System.currentTimeMillis() + clockOffset) % cycle
                var i = 0
                while (pos >= items[i].duration * 1000L) { pos -= items[i].duration * 1000L; i++ }
                item = items[i]
                startMs = pos
                forMs = item.duration * 1000L - pos
            } else {
                item = items[index % items.size]
                index = (index + 1) % items.size
            }
            nowPlaying = item.name
            val startedAt = System.currentTimeMillis()
            coroutineScope {
                val job = launch {
                    try {
                        when (item.type) {
                            "image" -> showImage(item, forMs ?: (item.duration * 1000L))
                            "video" -> showVideo(item, startMs, forMs)
                            "web" -> showWeb(item, forMs ?: (item.duration * 1000L))
                            else -> delay(1_000)
                        }
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        delay(2_000) // bad item: skip rather than getting stuck
                    }
                }
                itemJob = job
                job.join() // "Next" cancels only this child, so the loop moves on to the following item
            }
            itemJob = null
            val shownMs = System.currentTimeMillis() - startedAt
            if (shownMs >= 1_000 && pendingPlays.size < 2_000) {
                pendingPlays.add(
                    JSONObject().put("itemId", item.id).put("name", item.name)
                        .put("start", startedAt + clockOffset).put("ms", shownMs)
                )
            }
        }
    }

    /** Says what is actually wrong, so a stuck screen can be fixed without guessing. */
    private fun statusText(): String {
        val server = prefs.serverUrl
        val err = connectError
        return when {
            pairingCode != null ->
                "Almost done!\n\nOn your computer open OpenSign, go to Screens and click Add this screen.\nCode: $pairingCode\n\nServer: $server"
            server == null ->
                "Looking for your OpenSign server...\n\nMake sure it is running and on the same Wi-Fi/network.\nOr choose \"Enter server address\" below to type it."
            err != null && config == null ->
                "Can't reach the OpenSign server\n\n$server\n\n($err)\n\nCheck it is running and on the same network, or choose \"Enter server address\" to correct it."
            config == null -> "Connecting to $server ..."
            else -> "Connected as \"${config?.name ?: "this screen"}\"\n\nNo content is assigned yet.\nIn the admin open Screens and choose a playlist for this screen.\n\nServer: $server"
        }
    }

    /** Shows or hides the emergency alert overlay; playback keeps running underneath. */
    private suspend fun alertLoop() {
        while (true) {
            val a = config?.alert
            val active = a != null && a.until > System.currentTimeMillis() + clockOffset
            if (active && a != null) {
                alertView.text = a.message
                alertView.setBackgroundColor(runCatching { Color.parseColor(a.color) }.getOrDefault(Color.RED))
                alertView.visibility = View.VISIBLE
            } else {
                alertView.visibility = View.GONE
            }
            delay(1_000)
        }
    }

    /** Scales the content views to the whole wall and offsets them so this screen shows only its tile. */
    private fun applyWall(wall: Wall?) {
        val size = root.width to root.height
        if (size.first == 0 || (wall == appliedWall && size == appliedSize)) return
        appliedWall = wall
        appliedSize = size
        for (v in listOf<View>(playerView, imageView, webView)) {
            v.layoutParams = FrameLayout.LayoutParams(
                if (wall == null) FrameLayout.LayoutParams.MATCH_PARENT else size.first * wall.cols,
                if (wall == null) FrameLayout.LayoutParams.MATCH_PARENT else size.second * wall.rows,
            )
            v.translationX = if (wall == null) 0f else -wall.col * size.first.toFloat()
            v.translationY = if (wall == null) 0f else -wall.row * size.second.toFloat()
        }
    }

    // ---- renderers ----------------------------------------------------------

    private fun show(view: View) {
        for (v in listOf<View>(playerView, imageView, webView, statusView)) v.visibility = if (v === view) View.VISIBLE else View.GONE
        setupButton.visibility = statusView.visibility
        if (statusView.visibility == View.VISIBLE && !setupButton.hasFocus()) setupButton.requestFocus()
    }

    private fun showStatus(text: String) {
        statusView.text = text
        show(statusView)
    }

    private suspend fun showImage(item: Item, forMs: Long) {
        val local = cache.localOrNull(item)
        imageView.load(local ?: item.src) { crossfade(true) }
        show(imageView)
        delay(forMs)
    }

    private suspend fun showWeb(item: Item, forMs: Long) {
        webView.loadUrl(item.src)
        show(webView)
        delay(forMs)
        webView.loadUrl("about:blank")
    }

    /** forMs == null: play once to the end. Otherwise (video wall) start at startMs, loop, and stop after forMs. */
    private suspend fun showVideo(item: Item, startMs: Long, forMs: Long?) {
        val uri = cache.localOrNull(item)?.let { Uri.fromFile(it) } ?: Uri.parse(item.src)
        val done = CompletableDeferred<Unit>()
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_ENDED) done.complete(Unit) }
            override fun onPlayerError(error: PlaybackException) { done.complete(Unit) }
        }
        player.addListener(listener)
        try {
            player.repeatMode = if (forMs != null) Player.REPEAT_MODE_ONE else Player.REPEAT_MODE_OFF
            player.setMediaItem(MediaItem.fromUri(uri), startMs)
            player.prepare()
            player.play()
            show(playerView)
            withTimeoutOrNull(forMs ?: (30 * 60_000L)) { done.await() }
        } finally {
            player.removeListener(listener)
            player.stop()
        }
    }
}
