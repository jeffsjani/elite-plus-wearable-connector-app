package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.DataInputStream
import java.io.FileInputStream
import java.nio.file.Files

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
        val firstSequence = session.captureNotification(first, "t1")!!.sequenceNumber!!
        session.recordParserOutput(firstSequence, "119", false, parserFields((0 until 50).toList()), "t1")
        session.completeNotification(firstSequence)
        val secondSequence = session.captureNotification(second, "t2")!!.sequenceNumber!!
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
        assertEquals(0L, chunk.liveSummary["sequenceStart"])
        assertEquals(1L, chunk.liveSummary["sequenceEnd"])
        assertEquals(2, chunk.liveSummary["packetCount"])
        assertEquals(2L, chunk.liveSummary["vendorType119Count"])
        assertFalse(chunk.liveSummary.containsKey("packets"))
        val packets = chunk.exportSample["packets"] as List<*>
        assertEquals(first.map { it.toInt() and 0xFF }, (packets[0] as Map<*, *>)["originalBytes"])
        assertEquals(second.map { it.toInt() and 0xFF }, (packets[1] as Map<*, *>)["originalBytes"])
        assertEquals(listOf(first, second).map { it.toList() }, chunk.rawPackets.map { it.toList() })
    }

    @Test
    fun recordsUnknownLengthsAndUnsupportedVendorParserLayoutsWithoutDroppingBytes() {
        val session = session()
        val bytes = byteArrayOf(0x3A, 0x00, 0x01, 0x02)
        val sequence = session.captureNotification(bytes, "t1")!!.sequenceNumber!!
        session.recordParserOutput(sequence, "119", false, mapOf("Time" to "time"), "t1")
        val chunk = session.completeNotification(sequence) ?: session.flush()!!

        assertEquals(mapOf("153" to 0L, "203" to 0L, "other" to 1L), session.toMap()["notificationLengthCounts"])
        assertEquals(1L, session.parseErrorCount)
        assertEquals(bytes.map { it.toInt() and 0xFF }, (((chunk.exportSample["packets"] as List<*>).first() as Map<*, *>)["originalBytes"]))
        assertFalse(chunk.liveSummary.containsKey("packets"))
    }

    @Test
    fun retainsVendorDerivedBiomarkerFieldsByOriginalNameWithoutGlucoseUnits() {
        val session = session()
        val bytes = byteArrayOf(0x78, 0x00)
        val sequence = session.captureNotification(bytes, "t1")!!.sequenceNumber!!
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

    @Test
    fun capsParseErrorSamplesWhileKeepingTheAggregateCount() {
        val session = session()
        repeat(60) { session.recordParseError("unsupported packet", "t$it", 1) }

        assertEquals(60L, session.parseErrorCount)
        assertEquals(50, (session.toMap()["parseErrors"] as List<*>).size)
    }

    @Test
    fun returnsAnyCapacityFlushAlongsideTheNextPacketSequence() {
        val session = session()
        val firstSequence = session.captureNotification(byteArrayOf(1, 2, 3), "t1")!!.sequenceNumber!!
        session.completeNotification(firstSequence)

        val nextCapture = session.captureNotification(ByteArray(RawPpgSession.MAX_CHUNK_ESTIMATED_BYTES), "t2")!!

        assertEquals(1, nextCapture.completedChunk?.liveSummary?.get("packetCount"))
        assertEquals(null, nextCapture.sequenceNumber)
        assertEquals(1L, session.packetCount)
    }

    @Test
    fun spoolKeepsEveryPacketAndOnlyThreeFirstAndLastChunkSamples() {
        val directory = Files.createTempDirectory("raw-ppg-test").toFile()
        val store = RawPpgPacketStore.create(directory, "ppg-session")
        val expectedPackets = (0 until 8).map { byteArrayOf(it.toByte(), (it + 1).toByte()) }

        try {
            expectedPackets.forEachIndexed { index, packet ->
                store.appendChunk(listOf(packet), mapOf("sequenceStart" to index, "packets" to listOf(packet.map { it.toInt() and 0xFF })))
            }
            store.close()

            val spooledPackets = DataInputStream(FileInputStream(store.file)).use { input ->
                assertEquals("JCV8PPG1", String(ByteArray(8).also { input.readFully(it) }))
                buildList {
                    repeat(expectedPackets.size) {
                        val packet = ByteArray(input.readInt()).also { input.readFully(it) }
                        add(packet.toList())
                    }
                }
            }

            assertEquals(expectedPackets.map { it.toList() }, spooledPackets)
            assertEquals(listOf(0, 1, 2), store.firstThreeChunks().map { it["sequenceStart"] })
            assertEquals(listOf(5, 6, 7), store.lastThreeChunks().map { it["sequenceStart"] })
            assertEquals(3, store.firstThreeChunks().size)
            assertEquals(3, store.lastThreeChunks().size)
        } finally {
            runCatching { store.close() }
            directory.deleteRecursively()
        }
    }
}