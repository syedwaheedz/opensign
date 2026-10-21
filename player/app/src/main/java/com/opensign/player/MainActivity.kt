package com.opensign.player

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.view.KeyEvent
import android.view.View
import android.webkit.WebView
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
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

class MainActivity : AppCompatActivity() {
    private lateinit var prefs: Prefs
    private lateinit var api: Api
    private lateinit var cache: MediaCache
    private lateinit var player: ExoPlayer
    private lateinit var playerView: PlayerView
    private lateinit var imageView: ImageView
    private lateinit var webView: WebView
    private lateinit var statusView: TextView

    @Volatile private var config: Config? = null
    @Volatile private var pairingCode: String? = null
    @Volatile private var nowPlaying: String? = null
    private val jobs = mutableListOf<Job>()

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = Prefs(this)
        if (prefs.serverUrl == null) {
            startActivity(Intent(this, SetupActivity::class.java))
            finish()
            return
        }
        setContentView(R.layout.activity_main)
        api = Api(prefs)
        cache = MediaCache(this, api)
        playerView = findViewById(R.id.playerView)
        imageView = findViewById(R.id.imageView)
        webView = findViewById(R.id.webView)
        statusView = findViewById(R.id.statusView)

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
        if (prefs.serverUrl == null) return
        jobs += lifecycleScope.launch { syncLoop() }
        jobs += lifecycleScope.launch { heartbeatLoop() }
        jobs += lifecycleScope.launch { playbackLoop() }
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
    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean = when (keyCode) {
        KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SETTINGS -> { openSetup(); true }
        KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> { event.startTracking(); true }
        else -> super.onKeyDown(keyCode, event)
    }

    override fun onKeyLongPress(keyCode: Int, event: KeyEvent): Boolean =
        if (keyCode == KeyEvent.KEYCODE_DPAD_CENTER || keyCode == KeyEvent.KEYCODE_ENTER) { openSetup(); true }
        else super.onKeyLongPress(keyCode, event)

    private fun openSetup() = startActivity(Intent(this, SetupActivity::class.java))

    // ---- background loops ---------------------------------------------------

    private suspend fun syncLoop() {
        while (true) {
            var wait = 60_000L
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
                        if (r.config.version != config?.version) {
                            prefs.cachedConfig = r.json
                            config = r.config
                        }
                        withContext(Dispatchers.IO) { cache.sync(r.config) }
                    }
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Offline or server down: keep playing the cached config.
            }
            delay(wait)
        }
    }

    private suspend fun heartbeatLoop() {
        while (true) {
            runCatching { withContext(Dispatchers.IO) { api.heartbeat(nowPlaying, config?.version) } }
            delay(30_000)
        }
    }

    private suspend fun playbackLoop() {
        var playlistId: String? = null
        var index = 0
        while (true) {
            val active = config?.activePlaylist()
            if (active == null || active.second.isEmpty()) {
                nowPlaying = null
                showStatus(
                    pairingCode?.let { "Pair this screen\n\nOpen the OpenSign admin, go to Screens and enter code\n\n$it\n\n(hold OK to change server)" }
                        ?: "No content scheduled"
                )
                delay(2_000)
                continue
            }
            val (id, items) = active
            if (id != playlistId) { playlistId = id; index = 0 }
            val item = items[index % items.size]
            index = (index + 1) % items.size
            nowPlaying = item.name
            try {
                when (item.type) {
                    "image" -> showImage(item)
                    "video" -> showVideo(item)
                    "web" -> showWeb(item)
                    else -> delay(1_000)
                }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                delay(2_000) // bad item: skip rather than getting stuck
            }
        }
    }

    // ---- renderers ----------------------------------------------------------

    private fun show(view: View) {
        for (v in listOf<View>(playerView, imageView, webView, statusView)) v.visibility = if (v === view) View.VISIBLE else View.GONE
    }

    private fun showStatus(text: String) {
        statusView.text = text
        show(statusView)
    }

    private suspend fun showImage(item: Item) {
        val local = cache.localOrNull(item)
        imageView.load(local ?: item.src) { crossfade(true) }
        show(imageView)
        delay(item.duration * 1000L)
    }

    private suspend fun showWeb(item: Item) {
        webView.loadUrl(item.src)
        show(webView)
        delay(item.duration * 1000L)
        webView.loadUrl("about:blank")
    }

    private suspend fun showVideo(item: Item) {
        val uri = cache.localOrNull(item)?.let { Uri.fromFile(it) } ?: Uri.parse(item.src)
        val done = CompletableDeferred<Unit>()
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_ENDED) done.complete(Unit) }
            override fun onPlayerError(error: PlaybackException) { done.complete(Unit) }
        }
        player.addListener(listener)
        try {
            player.setMediaItem(MediaItem.fromUri(uri))
            player.prepare()
            player.play()
            show(playerView)
            withTimeoutOrNull(30 * 60_000L) { done.await() }
        } finally {
            player.removeListener(listener)
            player.stop()
        }
    }
}
