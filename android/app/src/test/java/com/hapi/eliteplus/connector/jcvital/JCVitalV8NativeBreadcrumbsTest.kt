package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8NativeBreadcrumbsTest {
    private class MemoryStore : JCVitalV8NativeBreadcrumbs.Store {
        val values = mutableMapOf<String, String>()
        override fun read(key: String): String? = values[key]
        override fun write(key: String, value: String) {
            values[key] = value
        }
    }

    @Test
    fun trailIsPersistedOnEveryRecordAndRotatedOnRestart() {
        val store = MemoryStore()
        val first = JCVitalV8NativeBreadcrumbs(store) { 0L }
        first.record("NATIVE_HR_SYNC_REQUESTED", mapOf("safeTestLimit" to 300))
        first.record("NATIVE_HR_CHUNK_READY_0", mapOf("sampleCount" to 250, "estimatedSerializedChunkBytes" to 212_345L, "isFinal" to false))

        // Simulated process death: nothing flushed beyond the per-record writes.
        val second = JCVitalV8NativeBreadcrumbs(store) { 0L }
        @Suppress("UNCHECKED_CAST")
        val previous = second.snapshot()["previous"] as List<Map<String, Any?>>
        assertEquals(listOf("NATIVE_HR_SYNC_REQUESTED", "NATIVE_HR_CHUNK_READY_0"), previous.map { it["stage"] })
        assertEquals(mapOf("sampleCount" to 250L, "estimatedSerializedChunkBytes" to 212_345L, "isFinal" to false), previous.last()["detail"])
        assertEquals(emptyList<Any?>(), second.snapshot()["current"])
    }

    @Test
    fun trailIsBoundedAndSanitized() {
        val store = MemoryStore()
        val crumbs = JCVitalV8NativeBreadcrumbs(store) { 0L }
        repeat(200) { crumbs.record("NATIVE_HR_CHUNK_EMITTED_$it", mapOf("note" to "a\tb;c=d\n".repeat(50))) }
        @Suppress("UNCHECKED_CAST")
        val current = crumbs.snapshot()["current"] as List<Map<String, Any?>>
        assertEquals(JCVitalV8NativeBreadcrumbs.MAX_ENTRIES, current.size)
        assertEquals("NATIVE_HR_CHUNK_EMITTED_199", current.last()["stage"])
        val note = (current.last()["detail"] as Map<*, *>)["note"] as String
        assertTrue(note.length <= 80 && note.none { it == '\t' || it == '\n' || it == ';' || it == '=' })
    }
}
