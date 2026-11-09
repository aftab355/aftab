package io.github.aftab355.weightsync

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class SyncCoreTest {
    /* Expected values computed with the browser's algorithm (Node's
     * crypto.pbkdf2Sync, which is the same PBKDF2-SHA256 WebCrypto runs). */
    @Test fun keyMatchesWebApp() {
        assertEquals("49a38c8b2ca91b62d917066adab830befe46ee84ac18990dedf16cdb255d2fd8", SyncCore.deriveKey("correct horse battery"))
        assertEquals("e07d07a1c23b362dd9ae5aaf492ad42fc455a8107475e07c3918c0b9de527162", SyncCore.deriveKey("pässwörd ✓ 体重"))
    }

    private fun doc(): JSONObject {
        val days = JSONObject()
        days.put("2026-11-06", JSONObject().put("entries", JSONArray().put(JSONObject().put("id", "a").put("name", "Toast")))
            .put("activity", JSONObject.NULL).put("u", 5))
        days.put("2026-11-07", JSONObject().put("entries", JSONArray()).put("weight", JSONObject().put("kg", 80.0).put("source", "manual")).put("u", 6))
        days.put("2026-11-08", JSONObject().put("entries", JSONArray()).put("weight", JSONObject().put("kg", 84.3).put("source", "samsung")).put("u", 7))
        return JSONObject().put("settings", JSONObject().put("weightUnit", "kg")).put("settingsU", 42).put("days", days)
    }

    @Test fun mergeRules() {
        val readings = mapOf(
            "2026-11-05" to SyncCore.Reading(85.123, 1, "samsung"),       // new day
            "2026-11-06" to SyncCore.Reading(84.9, 1, "samsung"),         // day with food
            "2026-11-07" to SyncCore.Reading(84.7, 1, "samsung"),         // manual: keep
            "2026-11-08" to SyncCore.Reading(84.3, 1, "samsung"),         // same value: skip
            "2026-11-04" to SyncCore.Reading(86.0, 1, "samsung")          // in ledger: skip
        )
        val r = SyncCore.merge(doc(), readings, mapOf("2026-11-04" to 86.0), 999)
        assertEquals(setOf("2026-11-05", "2026-11-06"), r.changedDays.keys().asSequence().toSet())
        assertEquals(85.12, r.changedDays.getJSONObject("2026-11-05").getJSONObject("weight").getDouble("kg"), 1e-9)
        val d6 = r.changedDays.getJSONObject("2026-11-06")
        assertEquals("Toast", d6.getJSONArray("entries").getJSONObject(0).getString("name"))   // food preserved
        assertEquals(999L, d6.getLong("u")); assertEquals(999L, d6.getLong("wu"))
        assertEquals(1, r.keptManual); assertEquals(1, r.alreadyThere)
        assertFalse(r.sent.containsKey("2026-11-04"))
        assertTrue(r.sent.keys.containsAll(listOf("2026-11-05", "2026-11-06", "2026-11-07", "2026-11-08")))
        val body = SyncCore.uploadBody(doc(), r.changedDays)
        assertEquals(42L, body.getLong("settingsU"))
        assertEquals(2, body.getJSONObject("days").length())
    }

    @Test fun deletedOnWebStaysDeleted() {
        val d = doc(); d.getJSONObject("days").getJSONObject("2026-11-08").remove("weight")
        val r = SyncCore.merge(d, mapOf("2026-11-08" to SyncCore.Reading(84.3, 1, "samsung")), mapOf("2026-11-08" to 84.3), 1)
        assertEquals(0, r.changedDays.length())
        val changedReading = SyncCore.merge(d, mapOf("2026-11-08" to SyncCore.Reading(84.0, 1, "samsung")), mapOf("2026-11-08" to 84.3), 1)
        assertEquals(1, changedReading.changedDays.length())
    }

    @Test fun formatting() {
        assertEquals("84.3 kg", SyncCore.formatWeight(84.3, "kg"))
        assertEquals("13 st 4 lb", SyncCore.formatWeight(186 / 2.2046226218, "st"))
        assertEquals("https://x.netlify.app", SyncCore.normaliseSite(" x.netlify.app/ "))
        assertEquals("https://x.netlify.app", SyncCore.normaliseSite("https://x.netlify.app/some/path"))
        assertNull(SyncCore.normaliseSite("http://x.netlify.app"))
        assertNull(SyncCore.normaliseSite("nonsense"))
    }
}
