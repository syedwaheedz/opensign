package com.opensign.player

import android.content.Context
import java.util.UUID

class Prefs(ctx: Context) {
    private val sp = ctx.getSharedPreferences("opensign", Context.MODE_PRIVATE)

    var serverUrl: String?
        get() = sp.getString("server", null)
        set(v) = sp.edit().putString("server", v?.trimEnd('/')).apply()

    /** Last config received from the server, kept so playback continues offline and after reboot. */
    var cachedConfig: String?
        get() = sp.getString("config", null)
        set(v) = sp.edit().putString("config", v).apply()

    val deviceId: String
        get() = sp.getString("deviceId", null)
            ?: UUID.randomUUID().toString().also { sp.edit().putString("deviceId", it).apply() }
}
