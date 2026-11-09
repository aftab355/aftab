package io.github.aftab355.weightsync

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.HealthConnectFeatures
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.time.temporal.ChronoUnit

class SyncException(message: String) : Exception(message)

object Health {
    const val SAMSUNG_HEALTH = "com.sec.android.app.shealth"
    val READ_WEIGHT = HealthPermission.getReadPermission(WeightRecord::class)

    fun available(ctx: Context) = HealthConnectClient.getSdkStatus(ctx) == HealthConnectClient.SDK_AVAILABLE

    /* Weight is required. Background and history reads are extras that older
     * Health Connect versions don't offer; asking for one it doesn't know
     * about can make the whole request fail, so only ask when supported. */
    suspend fun wantedPermissions(client: HealthConnectClient): Set<String> {
        val f = client.features
        val out = mutableSetOf(READ_WEIGHT)
        if (f.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_IN_BACKGROUND) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE) out += HealthPermission.PERMISSION_READ_HEALTH_DATA_IN_BACKGROUND
        if (f.getFeatureStatus(HealthConnectFeatures.FEATURE_READ_HEALTH_DATA_HISTORY) ==
            HealthConnectFeatures.FEATURE_STATUS_AVAILABLE) out += HealthPermission.PERMISSION_READ_HEALTH_DATA_HISTORY
        return out
    }
}

class SyncEngine(private val ctx: Context) {
    private val store = Store(ctx)

    /* Checks a site + key before saving them: the site must be running the
     * merging sync, and must already hold a log under this passphrase. The
     * second check is the typo guard — a mistyped passphrase would otherwise
     * quietly start a separate, empty log that the website never sees. */
    suspend fun verify(site: String, key: String): JSONObject {
        val body = request("GET", site, key, null)
        if (body.optInt("merge", 0) != 1) throw SyncException(
            "That site is running an older version of the tracker. Deploy the latest version first — " +
            "the old one would let this app overwrite your log.")
        return body.optJSONObject("doc") ?: throw SyncException(
            "No synced log found for that passphrase (key ID ${SyncCore.keyId(key)}). The website shows its " +
            "key ID under Settings → Sync across devices; if they differ, the passphrases differ. Easiest fix: " +
            "on the website tap \"Connect the app on this phone\" — no typing needed.")
    }

    /** Runs one sync and returns a one-line summary. Throws SyncException with a readable message. */
    suspend fun sync(): String {
        val site = store.site ?: throw SyncException("Not connected to your tracker yet.")
        val key = store.key ?: throw SyncException("Not connected to your tracker yet.")
        if (!Health.available(ctx)) throw SyncException("Health Connect isn't available on this phone.")
        val client = HealthConnectClient.getOrCreate(ctx)
        if (Health.READ_WEIGHT !in client.permissionController.getGrantedPermissions())
            throw SyncException("Health Connect access not granted yet.")

        // First run reaches back a year (Health Connect only hands over more
        // than 30 days before the grant if history access was allowed);
        // after that the last 45 days is plenty to catch late edits.
        val now = Instant.now()
        val days = if (store.historyDone) 45L else 366L
        val readings = readWeights(client, now.minus(days, ChronoUnit.DAYS), now)

        val doc = verify(site, key)
        doc.optJSONObject("settings")?.optString("weightUnit")?.takeIf { it.isNotEmpty() }?.let { store.unit = it }

        val ledger = store.ledger()
        val result = SyncCore.merge(doc, readings, ledger, System.currentTimeMillis())
        if (result.changedDays.length() > 0) {
            request("PUT", site, key, SyncCore.uploadBody(doc, result.changedDays).toString())
        }
        ledger.putAll(result.sent)
        store.saveLedger(ledger, LocalDate.now().minusDays(460).toString())
        store.historyDone = true

        val n = result.changedDays.length()
        val latest = readings.maxByOrNull { it.key }
        return buildString {
            append(if (n == 0) "Up to date" else "Sent $n weigh-in${if (n == 1) "" else "s"}")
            if (latest != null) {
                val d = LocalDate.parse(latest.key).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
                append(". Latest: ${SyncCore.formatWeight(latest.value.kg, store.unit)} on $d")
            } else append(". No weigh-ins found in Health Connect")
            if (result.keptManual > 0) append(". ${result.keptManual} day${if (result.keptManual == 1) "" else "s"} kept as typed on the website")
            // Say how far back Health Connect actually goes, so missing history
            // is visibly a Health Connect/Samsung limit, not a silent failure.
            readings.keys.minOrNull()?.let { oldest ->
                val d = LocalDate.parse(oldest).format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM))
                append(". Health Connect has ${readings.size} day${if (readings.size == 1) "" else "s"} of weigh-ins, back to $d")
            }
            append('.')
        }
    }

    /* One reading per local calendar day: the latest, which is what Samsung
     * Health itself shows. The day comes from the record's own UTC offset
     * when it has one, so a weigh-in made abroad lands on the day it was. */
    private suspend fun readWeights(client: HealthConnectClient, from: Instant, to: Instant): Map<String, SyncCore.Reading> {
        val byDay = HashMap<String, SyncCore.Reading>()
        var token: String? = null
        do {
            val resp = client.readRecords(ReadRecordsRequest(
                recordType = WeightRecord::class,
                timeRangeFilter = TimeRangeFilter.between(from, to),
                pageSize = 1000,
                pageToken = token
            ))
            for (r in resp.records) {
                val kg = r.weight.inKilograms
                if (kg < 20 || kg > 350) continue
                val offset = r.zoneOffset ?: ZoneId.systemDefault().rules.getOffset(r.time)
                val day = r.time.atOffset(offset).toLocalDate().toString()
                val ms = r.time.toEpochMilli()
                val src = if (r.metadata.dataOrigin.packageName == Health.SAMSUNG_HEALTH) "samsung" else "healthconnect"
                val prev = byDay[day]
                if (prev == null || ms >= prev.timeMs) byDay[day] = SyncCore.Reading(kg, ms, src)
            }
            token = resp.pageToken?.takeIf { it.isNotEmpty() }
        } while (token != null)
        return byDay
    }

    private suspend fun request(method: String, site: String, key: String, body: String?): JSONObject =
        withContext(Dispatchers.IO) {
            val conn = (URL("$site/api/sync").openConnection() as HttpURLConnection).apply {
                requestMethod = method
                connectTimeout = 15_000
                readTimeout = 30_000
                setRequestProperty("x-sync-key", key)
                setRequestProperty("accept", "application/json")
                if (body != null) {
                    doOutput = true
                    setRequestProperty("content-type", "application/json")
                }
            }
            try {
                if (body != null) conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                val code = conn.responseCode
                val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                    ?.bufferedReader()?.use { it.readText() } ?: ""
                if (code == 404) throw SyncException("No tracker sync at $site — check the address.")
                if (code !in 200..299) throw SyncException("The site answered $code. ${text.take(120)}")
                try { JSONObject(text) } catch (e: Exception) {
                    throw SyncException("$site doesn't look like the calorie tracker (unexpected reply).")
                }
            } catch (e: IOException) {
                throw SyncException("Couldn't reach $site — ${e.message ?: "network error"}.")
            } finally {
                conn.disconnect()
            }
        }
}
