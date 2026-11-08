package io.github.aftab355.weightsync

import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.format.DateUtils
import android.view.View
import android.view.inputmethod.InputMethodManager
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.result.ActivityResultLauncher
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.lifecycle.lifecycleScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {
    private lateinit var store: Store
    private lateinit var engine: SyncEngine
    private lateinit var askHealth: ActivityResultLauncher<Set<String>>
    private var busy = false

    private val siteInput by lazy { findViewById<EditText>(R.id.site) }
    private val passInput by lazy { findViewById<EditText>(R.id.passphrase) }
    private val connectBtn by lazy { findViewById<Button>(R.id.connect) }
    private val connectForm by lazy { findViewById<View>(R.id.connectForm) }
    private val connectedBox by lazy { findViewById<View>(R.id.connectedBox) }
    private val connectedText by lazy { findViewById<TextView>(R.id.connectedText) }
    private val connectMsg by lazy { findViewById<TextView>(R.id.connectMsg) }
    private val healthText by lazy { findViewById<TextView>(R.id.healthText) }
    private val healthBtn by lazy { findViewById<Button>(R.id.healthBtn) }
    private val syncText by lazy { findViewById<TextView>(R.id.syncText) }
    private val syncBtn by lazy { findViewById<Button>(R.id.syncBtn) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
        store = Store(this)
        engine = SyncEngine(this)

        // targetSdk 35 draws edge to edge; keep content clear of the bars.
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val b = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(b.left, b.top, b.right, b.bottom)
            insets
        }

        askHealth = registerForActivityResult(PermissionController.createRequestPermissionResultContract()) { granted ->
            refresh()
            if (Health.READ_WEIGHT in granted) syncNow()
        }

        connectBtn.setOnClickListener { connect() }
        findViewById<Button>(R.id.disconnect).setOnClickListener {
            SyncWorker.cancel(this); store.disconnect(); refresh()
        }
        healthBtn.setOnClickListener { requestHealth() }
        syncBtn.setOnClickListener { syncNow() }
        findViewById<Button>(R.id.privacyBtn).setOnClickListener { startActivity(Intent(this, PrivacyActivity::class.java)) }
    }

    override fun onResume() {
        super.onResume()
        refresh()
        // Opening the app is a sync, so it works even without background access.
        if (store.connected && !busy) lifecycleScope.launch {
            if (hasWeightPermission()) syncNow()
        }
    }

    private suspend fun hasWeightPermission(): Boolean =
        Health.available(this) &&
            Health.READ_WEIGHT in HealthConnectClient.getOrCreate(this).permissionController.getGrantedPermissions()

    private fun refresh() {
        val connected = store.connected
        connectForm.visibility = if (connected) View.GONE else View.VISIBLE
        connectedBox.visibility = if (connected) View.VISIBLE else View.GONE
        if (connected) connectedText.text = getString(R.string.connected_to, store.site)

        lifecycleScope.launch {
            when (HealthConnectClient.getSdkStatus(this@MainActivity)) {
                HealthConnectClient.SDK_AVAILABLE -> {
                    val client = HealthConnectClient.getOrCreate(this@MainActivity)
                    val granted = client.permissionController.getGrantedPermissions()
                    val bg = androidx.health.connect.client.permission.HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND in granted
                    if (Health.READ_WEIGHT in granted) {
                        healthText.text = getString(if (bg) R.string.health_ok_bg else R.string.health_ok_fg)
                        healthBtn.text = getString(R.string.health_manage)
                    } else {
                        healthText.text = getString(R.string.health_needed)
                        healthBtn.text = getString(R.string.health_allow)
                    }
                    healthBtn.isEnabled = true
                }
                HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                    healthText.text = getString(R.string.health_update)
                    healthBtn.text = getString(R.string.health_install)
                    healthBtn.isEnabled = true
                }
                else -> {
                    healthText.text = getString(R.string.health_unavailable)
                    healthBtn.isEnabled = false
                }
            }
        }
        showLastSync()
        syncBtn.isEnabled = connected && !busy
    }

    private fun showLastSync() {
        val at = store.lastSyncAt
        syncText.text = when {
            !store.connected -> getString(R.string.sync_not_connected)
            at == 0L -> getString(R.string.sync_never)
            else -> DateUtils.getRelativeTimeSpanString(at, System.currentTimeMillis(), DateUtils.MINUTE_IN_MILLIS)
                .toString().replaceFirstChar { it.uppercase() } + " — " + (store.lastMessage ?: "")
        }
        syncText.setTextColor(getColor(if (store.lastOk || at == 0L) R.color.ink2 else R.color.bad))
    }

    private fun connect() {
        val site = SyncCore.normaliseSite(siteInput.text.toString())
        val pass = passInput.text.toString()
        if (site == null) return say(getString(R.string.err_site))
        if (pass.length < 8) return say(getString(R.string.err_pass))
        (getSystemService(INPUT_METHOD_SERVICE) as InputMethodManager).hideSoftInputFromWindow(passInput.windowToken, 0)
        connectBtn.isEnabled = false
        say(getString(R.string.connecting))
        lifecycleScope.launch {
            try {
                val key = withContext(Dispatchers.Default) { SyncCore.deriveKey(pass) }
                engine.verify(site, key)
                store.site = site; store.key = key
                store.historyDone = false
                passInput.setText("")
                say("")
                SyncWorker.schedule(this@MainActivity)
                refresh()
                if (hasWeightPermission()) syncNow() else requestHealth()
            } catch (e: SyncException) {
                say(e.message ?: "")
            } finally {
                connectBtn.isEnabled = true
            }
        }
    }

    private fun requestHealth() {
        when (HealthConnectClient.getSdkStatus(this)) {
            HealthConnectClient.SDK_AVAILABLE -> lifecycleScope.launch {
                val client = HealthConnectClient.getOrCreate(this@MainActivity)
                val granted = client.permissionController.getGrantedPermissions()
                val wanted = Health.wantedPermissions(client)
                if (granted.containsAll(wanted)) {
                    // Everything granted: open Health Connect so access can be reviewed or revoked.
                    runCatching { startActivity(Intent(HealthConnectClient.ACTION_HEALTH_CONNECT_SETTINGS)) }
                } else askHealth.launch(wanted)
            }
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> runCatching {
                startActivity(Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://details?id=com.google.android.apps.healthdata&url=healthconnect%3A%2F%2Fonboarding")))
            }
            else -> Unit
        }
    }

    private fun syncNow() {
        if (busy || !store.connected) return
        busy = true
        syncBtn.isEnabled = false
        syncText.setTextColor(getColor(R.color.ink2))
        syncText.text = getString(R.string.syncing)
        lifecycleScope.launch {
            try {
                store.lastMessage = engine.sync(); store.lastOk = true
            } catch (e: SyncException) {
                store.lastMessage = e.message; store.lastOk = false
            } catch (e: Exception) {
                store.lastMessage = "Sync failed: ${e.message ?: e.javaClass.simpleName}"; store.lastOk = false
            }
            store.lastSyncAt = System.currentTimeMillis()
            busy = false
            refresh()
        }
    }

    private fun say(msg: String) {
        connectMsg.text = msg
        connectMsg.visibility = if (msg.isEmpty()) View.GONE else View.VISIBLE
    }
}
