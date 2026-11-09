package io.github.aftab355.weightsync

import android.content.Context
import org.json.JSONObject

/* App-private settings. The sync key is the derived key, never the
 * passphrase, the same as the website keeps it. */
class Store(ctx: Context) {
    private val p = ctx.getSharedPreferences("weight-sync", Context.MODE_PRIVATE)

    var site: String?
        get() = p.getString("site", null)
        set(v) = p.edit().putString("site", v).apply()
    var key: String?
        get() = p.getString("key", null)
        set(v) = p.edit().putString("key", v).apply()
    var unit: String
        get() = p.getString("unit", "kg") ?: "kg"
        set(v) = p.edit().putString("unit", v).apply()
    var lastSyncAt: Long
        get() = p.getLong("lastSyncAt", 0)
        set(v) = p.edit().putLong("lastSyncAt", v).apply()
    var lastMessage: String?
        get() = p.getString("lastMessage", null)
        set(v) = p.edit().putString("lastMessage", v).apply()
    var lastOk: Boolean
        get() = p.getBoolean("lastOk", true)
        set(v) = p.edit().putBoolean("lastOk", v).apply()
    /** Whether a full-history read has been done since connecting. */
    var historyDone: Boolean
        get() = p.getBoolean("historyDone", false)
        set(v) = p.edit().putBoolean("historyDone", v).apply()

    val connected get() = site != null && key != null

    /* day -> kg last sent. Trimmed to ~15 months so it can't grow forever. */
    fun ledger(): MutableMap<String, Double> {
        val o = JSONObject(p.getString("ledger", "{}") ?: "{}")
        return o.keys().asSequence().associateWith { o.getDouble(it) }.toMutableMap()
    }
    fun saveLedger(m: Map<String, Double>, oldestKept: String) {
        val o = JSONObject()
        m.filterKeys { it >= oldestKept }.forEach { (k, v) -> o.put(k, v) }
        p.edit().putString("ledger", o.toString()).apply()
    }

    fun disconnect() {
        p.edit().clear().apply()
    }
}
