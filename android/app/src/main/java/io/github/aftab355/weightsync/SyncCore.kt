package io.github.aftab355.weightsync

import org.json.JSONArray
import org.json.JSONObject
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec
import kotlin.math.abs
import kotlin.math.roundToLong

/* The parts of the sync that don't touch Android, so they run as plain JVM
 * unit tests. */
object SyncCore {

    /* Must produce exactly what the web app's deriveKey() does:
     * PBKDF2-HMAC-SHA256, 200 000 rounds, fixed salt, 32 bytes, lowercase hex,
     * over the passphrase's UTF-8 bytes. Written out by hand rather than via
     * SecretKeyFactory because Android's providers have differed in how they
     * turn a char[] passphrase into bytes, which would silently derive a
     * different key for any non-ASCII passphrase. */
    const val SALT = "calorie-tracker/v1/sync"
    const val ITERATIONS = 200_000

    fun deriveKey(passphrase: String, iterations: Int = ITERATIONS): String {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(passphrase.toByteArray(Charsets.UTF_8), "HmacSHA256"))
        // One 32-byte block is all a 256-bit key needs.
        mac.update(SALT.toByteArray(Charsets.UTF_8))
        mac.update(byteArrayOf(0, 0, 0, 1))
        var u = mac.doFinal()
        val out = u.copyOf()
        for (i in 1 until iterations) {
            u = mac.doFinal(u)
            for (j in out.indices) out[j] = (out[j].toInt() xor u[j].toInt()).toByte()
        }
        return out.joinToString("") { "%02x".format(it) }
    }

    data class Reading(val kg: Double, val timeMs: Long, val source: String)

    class Result(
        /** Only the days that changed, ready to upload — the server merges. */
        val changedDays: JSONObject,
        /** day -> kg now recorded as sent, to merge into the ledger. */
        val sent: Map<String, Double>,
        val keptManual: Int,
        val alreadyThere: Int
    )

    fun round2(kg: Double): Double = (kg * 100).roundToLong() / 100.0

    /* Fold one reading per day into the server's document.
     *
     * - A weight typed into the website ('manual') is never overwritten.
     * - The ledger holds what this app last sent for each day. A day whose
     *   reading hasn't changed since is skipped even if the website no longer
     *   has it, so deleting a weigh-in on the website sticks — until the
     *   reading itself changes in Health Connect.
     * - A changed day is sent whole (food entries and all, as fetched) with a
     *   new `u`, and a new `wu` — the weight's own timestamp, which the server
     *   and website merge separately so a meal logged elsewhere on the same day
     *   can't erase the weigh-in, nor the weigh-in the meal. */
    fun merge(doc: JSONObject, readings: Map<String, Reading>, ledger: Map<String, Double>, now: Long): Result {
        val days = doc.optJSONObject("days") ?: JSONObject()
        val changed = JSONObject()
        val sent = HashMap<String, Double>()
        var keptManual = 0
        var already = 0
        for ((date, r) in readings.toSortedMap()) {
            val kg = round2(r.kg)
            if (ledger[date]?.let { abs(it - kg) < 0.005 } == true) continue
            val day = days.optJSONObject(date)
                ?: JSONObject().put("entries", JSONArray()).put("activity", JSONObject.NULL)
            val cur = day.optJSONObject("weight")
            val curSource = cur?.optString("source", "") ?: ""
            if (cur != null && (curSource == "manual" || curSource.isEmpty())) {
                keptManual++; sent[date] = kg; continue
            }
            if (cur != null && abs(cur.optDouble("kg", -1.0) - kg) < 0.005) {
                already++; sent[date] = kg; continue
            }
            day.put("weight", JSONObject().put("kg", kg).put("source", r.source))
            day.put("u", now)
            day.put("wu", now)   // weight's own clock: survives a later meal upload of the same day
            changed.put(date, day)
            sent[date] = kg
        }
        return Result(changed, sent, keptManual, already)
    }

    /* The upload body: just the changed days. Settings are echoed back with
     * their own timestamp so the server's newer-wins rule leaves them alone. */
    fun uploadBody(doc: JSONObject, changed: JSONObject): JSONObject =
        JSONObject()
            .put("version", 1)
            .put("settings", doc.optJSONObject("settings") ?: JSONObject())
            .put("settingsU", doc.optLong("settingsU", 0))
            .put("days", changed)

    /* Weight in the unit chosen on the website. */
    fun formatWeight(kg: Double, unit: String): String {
        val lb = kg * 2.2046226218
        return when (unit) {
            "lb" -> "%.1f lb".format(lb)
            "st" -> {
                var st = (lb / 14).toInt()
                var rem = Math.round((lb - st * 14) * 10) / 10.0
                if (rem >= 14) { st++; rem = 0.0 }
                "$st st ${if (rem % 1.0 == 0.0) rem.toInt().toString() else "%.1f".format(rem)} lb"
            }
            else -> "%.1f kg".format(kg)
        }
    }

    private val KEY_RE = Regex("^[a-f0-9]{64}$")
    fun validKey(k: String?): Boolean = k != null && KEY_RE.matches(k)

    /** The short ID the website shows under Sync across devices. */
    fun keyId(key: String): String = key.take(6)

    /* "mysite.netlify.app/" -> "https://mysite.netlify.app". Plain http is
     * refused: the sync key would cross the network in the clear. */
    fun normaliseSite(raw: String): String? {
        var s = raw.trim().trimEnd('/')
        if (s.isEmpty()) return null
        if (s.startsWith("http://", ignoreCase = true)) return null
        if (!s.startsWith("https://", ignoreCase = true)) s = "https://$s"
        val host = s.removePrefix("https://").removePrefix("HTTPS://").substringBefore('/')
        if (!host.contains('.') || host.contains(' ')) return null
        return "https://$host"
    }
}
