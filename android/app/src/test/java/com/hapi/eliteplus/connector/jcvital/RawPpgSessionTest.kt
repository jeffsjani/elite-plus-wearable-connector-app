package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class RawPpgSessionTest {
    private fun session() = RawPpgSession(
        sessionId = "ppg-session",
        deviceId = "device-1",
        firmwareVersion = "1.0",
        startedAt = "2026-09-30T10:00:00Z",
        source = mapOf("provider" to "JCVITAL"),
    ).apply { start(); markRunning() }

    private fun parserFields(values: List<Int>) = mapOf("Time" to "2026.09.30 10:00:01", "PPG" to values.joinToString(prefix = "[", postfix = "]"))

    @Test
    fun preserves153And203ByteNotificationsWithoutMergingLayouts() {
        val session = session()
        val first = ByteArray(153) { it.toByte() }.apply { this[0] = 0x3A }
        val second = ByteArray(203) { (it * 3).toByte() }.apply { this[0] = 0x3A }
        val firstSequence = session.captureNotification(first, "t1")!!
        session.recordParserOutput(firstSequence, "119", false, parserFields((0 until 50).toList()), "t1")
        session.completeNotification(firstSequence)
        val secondSequence = session.captureNotification(second, "t2")!!
        session.recordParserOutput(secondSequence, "119", false, parserFields((50 until 100).toList()), "t2")
        val secondChunk = session.completeNotification(secondSequence)
        val chunk = secondChunk ?: session.flush()!!

        assertEquals(2L, session.packetCount)
        assertEquals(356L, session.bytesReceived)
        assertEquals(2L, session.vendorDataType119Count)
        assertEquals(100L, session.decodedSampleCount)
        assertEquals(mapOf("153" to 1L, "203" to 1L, "other" to 0L), session.toMap()["notificationLengthCounts"])
        assertEquals(50, ((session.toMap()["rawSampleDiagnostics"] as Map<*, *>)["153"] as Map<*, *>)["decodedSampleCount"])
        assertEquals(50, ((session.toMap()["rawSampleDiagnostics"] as Map<*, *>)["203"] as Map<*, *>)["decodedSampleCount"])
        assertEquals("PPG_WORKFLOW_RAW_VENDOR", chunk["signalType"])
        assertEquals(null, chunk["sampleRateHz"])
        assertEquals("UNKNOWN_VENDOR_UNIT", chunk["unit"])
        val packets = chunk["packets"] as List<*>
        assertEquals(first.map { it.toInt() and 0xFF }, (packets[0] as Map<*, *>)["originalBytes"])
        assertEquals(second.map { it.toInt() and 0xFF }, (packets[1] as Map<*, *>)["originalBytes"])
    }

    @Test
    fun recordsUnknownLengthsAndUnsupportedVendorParserLayoutsWithoutDroppingBytes() {
        val session = session()
        val bytes = byteArrayOf(0x3A, 0x00, 0x01, 0x02)
        val sequence = session.captureNotification(bytes, "t1")!!
        session.recordParserOutput(sequence, "119", false, mapOf("Time" to "time"), "t1")
        val chunk = session.completeNotification(sequence) ?: session.flush()!!

        assertEquals(mapOf("153" to 0L, "203" to 0L, "other" to 1L), session.toMap()["notificationLengthCounts"])
        assertEquals(1L, session.parseErrorCount)
        assertEquals(bytes.map { it.toInt() and 0xFF }, ((chunk["packets"] as List<*>).first() as Map<*, *>)["originalBytes"])
    }

    @Test
    fun retainsVendorDerivedBiomarkerFieldsByOriginalNameWithoutGlucoseUnits() {
        val session = session()
        val bytes = byteArrayOf(0x78, 0x00)
        val sequence = session.captureNotification(bytes, "t1")!!
        session.recordParserOutput(
            sequence,
            "118",
            true,
            mapOf("bloodTestValue" to "raw-vendor-value", "bloodPercent" to 82),
            "t1",
        )
        val report = session.toMap()
        val fields = report["vendorDerivedFields"] as List<*>
        assertTrue(fields.any { (it as Map<*, *>)["fieldName"] == "bloodTestValue" })
        assertTrue(fields.any { (it as Map<*, *>)["fieldName"] == "bloodPercent" })
        assertFalse(report.containsKey("glucoseMgDl"))
        assertEquals("UNKNOWN_VENDOR_UNIT", report["unit"])
    }
}