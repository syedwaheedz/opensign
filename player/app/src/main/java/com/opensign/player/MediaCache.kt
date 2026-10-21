package com.opensign.player

import android.content.Context
import java.io.File

/** Keeps every file referenced by the current config on disk so playback survives network loss. */
class MediaCache(ctx: Context, private val api: Api) {
    private val dir = File(ctx.filesDir, "media").apply { mkdirs() }

    private fun fileFor(item: Item) = File(dir, item.id + item.src.substringAfterLast('.', "").let { if (it.length in 1..5) ".$it" else "" })

    fun localOrNull(item: Item): File? = fileFor(item).takeIf { it.exists() }

    fun sync(config: Config) {
        val wanted = config.playlists.values.flatten().filter { it.type != "web" }.distinctBy { it.id }
        for (item in wanted) {
            val f = fileFor(item)
            if (!f.exists()) runCatching { api.download(item.src, f) } // retried on the next sync cycle
        }
        val keep = wanted.map { fileFor(it).name }.toSet()
        dir.listFiles()?.filter { it.name !in keep && !it.name.endsWith(".part") }?.forEach { it.delete() }
    }
}
