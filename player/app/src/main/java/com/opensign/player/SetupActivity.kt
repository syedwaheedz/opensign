package com.opensign.player

import android.content.Intent
import android.os.Bundle
import android.view.inputmethod.EditorInfo
import android.widget.Button
import android.widget.EditText
import androidx.appcompat.app.AppCompatActivity

class SetupActivity : AppCompatActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_setup)
        val prefs = Prefs(this)
        val input = findViewById<EditText>(R.id.serverInput)
        input.setText(prefs.serverUrl ?: "")

        fun save() {
            var url = input.text.toString().trim()
            if (url.isEmpty()) return
            if (!url.startsWith("http://") && !url.startsWith("https://")) url = "http://$url"
            if (url.trimEnd('/') != prefs.serverUrl) prefs.cachedConfig = null
            prefs.serverUrl = url
            startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP))
            finish()
        }
        findViewById<Button>(R.id.saveButton).setOnClickListener { save() }
        input.setOnEditorActionListener { _, id, _ -> (id == EditorInfo.IME_ACTION_DONE).also { if (it) save() } }
    }
}
