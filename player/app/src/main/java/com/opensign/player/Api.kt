package com.opensign.player

import android.os.Build
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

sealed interface ConfigResult {
    data class Pairing(val code: String) : ConfigResult
    data class Ready(val json: String, val config: Config) : ConfigResult
}

class Api(private val prefs: Prefs) {
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .build()
    private val jsonType = "application/json".toMediaType()

    private fun base() = prefs.serverUrl ?: throw IOException("server not set")

    private fun register() {
        val body = JSONObject().put("deviceId", prefs.deviceId).put("model", Build.MODEL).toString()
        val req = Request.Builder().url("${base()}/api/player/register").post(body.toRequestBody(jsonType)).build()
        http.newCall(req).execute().use { if (!it.isSuccessful) throw IOException("register ${it.code}") }
    }

    fun fetchConfig(): ConfigResult {
        repeat(2) {
            val req = Request.Builder().url("${base()}/api/player/${prefs.deviceId}/config").build()
            http.newCall(req).execute().use { r ->
                if (r.code == 404) { register(); return@repeat } // first run, or removed from the server
                if (!r.isSuccessful) throw IOException("config ${r.code}")
                val text = r.body!!.string()
                val o = JSONObject(text)
                return if (o.getBoolean("paired")) ConfigResult.Ready(text, Config.parse(text))
                else ConfigResult.Pairing(o.getString("pairingCode"))
            }
        }
        throw IOException("could not register")
    }

    // Held open by the server until something changes (or ~25 s), so edits and alerts arrive within seconds.
    private val longPoll = http.newBuilder().readTimeout(40, TimeUnit.SECONDS).build()

    fun waitForChange(version: String?) {
        val v = version?.let { "?v=$it" } ?: ""
        val req = Request.Builder().url("${base()}/api/player/${prefs.deviceId}/wait$v").build()
        longPoll.newCall(req).execute().use { if (!it.isSuccessful) throw IOException("wait ${it.code}") }
    }

    fun heartbeat(nowPlaying: String?, version: String?, plays: JSONArray) {
        val body = JSONObject()
            .put("nowPlaying", nowPlaying ?: JSONObject.NULL)
            .put("version", version ?: JSONObject.NULL)
            .put("appVersion", BuildConfigVersion.NAME)
            .put("plays", plays)
            .toString()
        val req = Request.Builder().url("${base()}/api/player/${prefs.deviceId}/heartbeat").post(body.toRequestBody(jsonType)).build()
        http.newCall(req).execute().close()
    }

    /** Downloads to a .part file and renames on success so a half-finished file is never played. */
    fun download(url: String, dest: File) {
        val part = File(dest.parentFile, dest.name + ".part")
        http.newCall(Request.Builder().url(url).build()).execute().use { r ->
            if (!r.isSuccessful) throw IOException("download ${r.code}")
            r.body!!.byteStream().use { input -> part.outputStream().use { input.copyTo(it) } }
        }
        if (!part.renameTo(dest)) throw IOException("rename failed")
    }
}

object BuildConfigVersion { const val NAME = "0.1.0" }
