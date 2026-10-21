package com.opensign.player

import android.annotation.SuppressLint
import android.content.Context
import android.graphics.Color
import android.net.Uri
import android.view.View
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.ImageView
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil.load
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Shows images, videos and web pages inside one rectangle of a multi-zone layout.
 * The video player and web view are created on first use, so a text-only zone costs no video decoder.
 */
class ZonePlayer(private val context: Context, private val cache: MediaCache) {
    val container = FrameLayout(context).apply { setBackgroundColor(Color.BLACK) }
    private val imageView = ImageView(context).apply {
        scaleType = ImageView.ScaleType.FIT_CENTER
        visibility = View.GONE
        container.addView(this, fill())
    }
    private var webView: WebView? = null
    private var playerView: PlayerView? = null
    private var exo: ExoPlayer? = null

    private fun fill() = FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT)

    @SuppressLint("SetJavaScriptEnabled")
    private fun web(): WebView = webView ?: WebView(context).apply {
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        setBackgroundColor(Color.BLACK)
        visibility = View.GONE
        container.addView(this, fill())
    }.also { webView = it }

    private fun video(): Pair<PlayerView, ExoPlayer> {
        val p = exo ?: ExoPlayer.Builder(context).build().also { exo = it }
        val v = playerView ?: PlayerView(context).apply {
            useController = false
            player = p
            visibility = View.GONE
            container.addView(this, fill())
        }.also { playerView = it }
        return v to p
    }

    private fun show(target: View) {
        for (v in listOfNotNull<View>(imageView, webView, playerView)) v.visibility = if (v === target) View.VISIBLE else View.GONE
    }

    /** Puts an image or web page on screen and returns immediately; the caller decides how long it stays. */
    fun display(item: Item) {
        when (item.type) {
            "image" -> {
                imageView.load(cache.localOrNull(item) ?: item.src) { crossfade(true) }
                show(imageView)
            }
            "web" -> {
                val w = web()
                w.loadUrl(item.src)
                show(w)
            }
        }
    }

    /** Plays a video once, to the end (or until an error / 30 minutes). */
    suspend fun playVideo(item: Item) {
        val (view, player) = video()
        val uri = cache.localOrNull(item)?.let { Uri.fromFile(it) } ?: Uri.parse(item.src)
        val done = CompletableDeferred<Unit>()
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) { if (state == Player.STATE_ENDED) done.complete(Unit) }
            override fun onPlayerError(error: PlaybackException) { done.complete(Unit) }
        }
        player.addListener(listener)
        try {
            player.repeatMode = Player.REPEAT_MODE_OFF
            player.setMediaItem(MediaItem.fromUri(uri))
            player.prepare()
            player.play()
            show(view)
            withTimeoutOrNull(30 * 60_000L) { done.await() }
        } finally {
            player.removeListener(listener)
            player.stop()
        }
    }

    /** Loops one video forever; used when a zone's playlist holds just that video. */
    fun loopVideo(item: Item) {
        val (view, player) = video()
        val uri = cache.localOrNull(item)?.let { Uri.fromFile(it) } ?: Uri.parse(item.src)
        player.repeatMode = Player.REPEAT_MODE_ONE
        player.setMediaItem(MediaItem.fromUri(uri))
        player.prepare()
        player.play()
        show(view)
    }

    fun release() {
        exo?.release()
        exo = null
        webView?.let { container.removeView(it); it.destroy() }
        webView = null
    }
}
