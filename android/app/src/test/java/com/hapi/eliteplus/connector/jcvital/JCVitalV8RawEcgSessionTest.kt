package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8RawEcgSessionTest {
    private val source = linkedMapOf<String, Any?>(
        "connector" to "JCVITAL_NATIVE",
        "provider" to "JCVITAL",
        "deviceModel" to "PRO_V8",
        "firmwareVersion" to "0.0.8.8",
    )

    private fun create(id: String = "ecg-session-1") = JCVitalV8RawEcgSession(
        sessionId = id,
        deviceId = "D6:AE:FB:AE:33:CC",
        firmwareVersion = "0.0.8.8",
        startedAt = "2026-09-30T10:00:00.000Z",
        source = source,
    )

    private fun notification(packetId: Int, vararg values: Int): ByteArray {
        val result = ByteArray(2 + values.size * 3)
        result[0] = JCVitalV8RawEcgSession.ECG_COMMAND_BYTE.toByte()
        result[1] = packetId.toByte()
        values.forEachIndexed { index, value ->
            val offset = 2 + index * 3
            result[offset] = value.toByte()
            result[offset + 1] = (value shr 8).toByte()
            result[offset + 2] = (value shr 16).toByte()
        }
        return result
    }

    @Test
    fun startStopAndIdleStopBehavior() {
        val idle = create()
        assertEquals("IDLE", idle.status)
        assertThrows(IllegalStateException::class.java) { idle.stop("2026-09-30T10:01:00.000Z") }
        idle.start()
        assertEquals("STARTING", idle.status)
        idle.markRunning()
        idle.markStopping()
        assertEquals("STOPPING", idle.status)
        idle.stop("2026-09-30T10:01:00.000Z")
        assertEquals("STOPPED", idle.status)
    }

    @Test
    fun duplicateStartIsRejected() {
        val session = create()
        session.start()
        assertThrows(IllegalStateException::class.java) { session.start() }
    }

    @Test
    fun packetParsingPreservesPacketIdAndUnsignedTwentyFourBitSamples() {
        val session = create().apply { start(); markRunning() }
        val frame = notification(201, 0, 0x7FFFFF, 0x800000, 0xFFFFFF)
        val result = session.acceptNotification(frame, "2026-09-30T10:00:01.000Z")

        assertNull(result.parseError)
        assertNull(result.chunk)
        assertEquals(1L, session.packetCount)
        assertEquals(4L, session.sampleCount)
        assertEquals(0, session.minRawSample)
        assertEquals(0xFFFFFF, session.maxRawSample)
        val chunk = session.flush()!!
        assertEquals(201, chunk["firstPacketId"])
        assertEquals(201, chunk["lastPacketId"])
        assertEquals(listOf(0, 0x7FFFFF, 0x800000, 0xFFFFFF), chunk["samples"])
        assertEquals(JCVitalV8RawEcgSession.SAMPLE_FORMAT, chunk["sampleFormat"])
        assertEquals(JCVitalV8RawEcgSession.UNKNOWN_UNIT, chunk["unit"])
        @Suppress("UNCHECKED_CAST")
        val rawPackets = chunk["rawPacketBytes"] as List<List<Int>>
        assertEquals(frame.map { it.toInt() and 0xFF }, rawPackets.single())
    }

    @Test
    fun packagedSdkDecodesCommand07AsType64WithPacketIdAndSamples() {
        val frame = notification(29, 1, 0x123456, 0xFFFFFF, 0x800000, 7, 9)
        val callbacks = mutableListOf<Map<String?, Any?>>()
        BleSDK.setECGRealtimeDuringHRVEnabled(true)
        try {
            BleSDK.DataParsingWithData(frame, object : DataListener2301 {
                override fun dataCallback(maps: MutableMap<String?, Any?>?) {
                    maps?.let { callbacks += HashMap(it) }
                }

                override fun dataCallback(value: ByteArray?) = Unit
            })
        } finally {
            BleSDK.setECGRealtimeDuringHRVEnabled(false)
        }

        val callback = callbacks.single()
        assertEquals(BleConst.GetECG, callback[DeviceKey.DataType])
        @Suppress("UNCHECKED_CAST")
        val fields = callback[DeviceKey.Data] as Map<String, String>
        assertEquals("29", fields[DeviceKey.packetID])
        assertEquals("1,1193046,16777215,8388608,7,9", fields[DeviceKey.arrayEcgRawData])
    }

    @Test
    fun emitsPacketBoundaryChunkAfterEightFramesAndFlushesTail() {
        val session = create().apply { start(); markRunning() }
        var emitted: Map<String, Any?>? = null
        repeat(8) { packetId ->
            val result = session.acceptNotification(notification(packetId, packetId, packetId + 1), "t$packetId")
            if (result.chunk != null) emitted = result.chunk
        }
        assertEquals(0L, emitted?.get("sequenceNumber"))
        assertEquals(8, emitted?.get("packetCount"))
        assertEquals(0, emitted?.get("firstPacketId"))
        assertEquals(7, emitted?.get("lastPacketId"))
        assertEquals(1L, session.chunksEmitted)

        session.acceptNotification(notification(8, 8), "t8")
        session.markStopping()
        val tail = session.stop("t9")
        assertEquals(1, tail?.get("packetCount"))
        assertEquals(2L, session.chunksEmitted)
    }

    @Test
    fun detectsSequenceGapDuplicateAndOutOfOrderWithoutDroppingFrames() {
        val session = create().apply { start(); markRunning() }
        listOf(10, 12, 12, 11, 13).forEachIndexed { index, packetId ->
            session.acceptNotification(notification(packetId, index), "t$index")
        }

        assertEquals(5L, session.packetCount)
        assertEquals(1L, session.missingPacketCount)
        assertEquals(1L, session.duplicatePacketCount)
        assertEquals(1L, session.outOfOrderPacketCount)
        assertEquals(13, session.lastPacketId)
    }

    @Test
    fun packetIdWraparoundIsSequential() {
        val session = create().apply { start(); markRunning() }
        listOf(254, 255, 0, 1).forEachIndexed { index, packetId ->
            session.acceptNotification(notification(packetId, index), "t$index")
        }
        assertEquals(0L, session.missingPacketCount)
        assertEquals(0L, session.outOfOrderPacketCount)
    }

    @Test
    fun boundedBufferFlushesBeforeHardLimitAndTracksMaximum() {
        val session = create().apply { start(); markRunning() }
        repeat(64) { packetId ->
            session.acceptNotification(notification(packetId % 256, *IntArray(64) { it }), "t$packetId")
            assertTrue(session.maxBufferedEstimateBytes <= JCVitalV8RawEcgSession.MAX_CHUNK_ESTIMATED_BYTES)
        }
        assertTrue(session.chunksEmitted > 0)
        assertTrue(session.maxBufferedEstimateBytes <= JCVitalV8RawEcgSession.MAX_CHUNK_ESTIMATED_BYTES)
        assertTrue(session.chunksEmitted >= 8)
    }

    @Test
    fun trailingBytesAreReportedButOriginalFrameAndWholeSamplesAreRetained() {
        val session = create().apply { start(); markRunning() }
        val frame = notification(4, 0xABCDEF) + byteArrayOf(0x55)
        val result = session.acceptNotification(frame, "t0")
        assertEquals(1L, session.parseErrorCount)
        assertTrue(result.parseError?.get("message").toString().contains("trailing byte"))
        session.markStopping()
        val chunk = session.stop("t1")!!
        assertEquals(listOf(0xABCDEF), chunk["samples"])
        @Suppress("UNCHECKED_CAST")
        assertEquals(frame.map { it.toInt() and 0xFF }, (chunk["rawPacketBytes"] as List<List<Int>>).single())
    }

    @Test
    fun disconnectFlushesTailAndASecondSessionStartsClean() {
        val first = create("first").apply { start(); markRunning() }
        first.acceptNotification(notification(4, 123), "t0")
        val tail = first.disconnect("t1")
        assertEquals("DISCONNECTED", first.status)
        assertEquals(1, tail?.get("packetCount"))

        val second = create("second")
        second.start()
        second.markRunning()
        assertEquals(0L, second.packetCount)
        assertEquals(0L, second.sampleCount)
        assertEquals(0L, second.missingPacketCount)
        assertFalse(second.sessionId == first.sessionId)
    }
}
