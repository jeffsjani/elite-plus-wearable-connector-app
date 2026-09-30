package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.DeviceConst
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8RawEcgNotificationDiagnosticsTest {
    @Test
    fun capturesOnlyFirstTenNotificationsWithinFifteenSecondsAndRecordsAckTiming() {
        val trace = JCVitalV8RawEcgNotificationDiagnostics(1_000L)
        trace.recordMeasurementCommandAck(1_100L)
        trace.recordRealtimeFlagCommandAck(1_200L)

        repeat(11) { index ->
            trace.captureNotification(
                byteArrayOf(0x22, index.toByte()),
                "time-$index",
                1_050L + index,
            )
        }
        val first = trace.genericNotificationsAfterStart.first()

        assertEquals(10, trace.genericNotificationsAfterStart.size)
        assertEquals(1, first["sequence"])
        assertEquals(false, first["afterMeasurementCommandAck"])
        assertEquals(false, first["afterRealtimeFlagCommandAck"])
        assertEquals("2200", first["first16BytesHex"])
        assertEquals("NO_RESULT", first["sdkParserResult"])
        assertNull(trace.captureNotification(byteArrayOf(1), "late", 16_001L))
    }

    @Test
    fun recordsOnlyParserMetadataAndClassifiesSupportedNotificationBytes() {
        val trace = JCVitalV8RawEcgNotificationDiagnostics(0L)
        val command = byteArrayOf(DeviceConst.MeasurementWithType, 0x04, 0x01)
        trace.recordMeasurementCommand(command)
        trace.recordMeasurementCommandAck(500L)
        trace.recordRealtimeFlagCommandAck(600L)
        val response = byteArrayOf(DeviceConst.MeasurementWithType, 0x04, 0x03)
        val capture = trace.captureNotification(response, "measurement-response", 700L)!!
        trace.recordParserResult(capture, "74", true)
        trace.recordParserResult(capture, "66", false)
        trace.finishNotification(capture, command)

        assertEquals("MULTIPLE_RESULTS", capture.payload["sdkParserResult"])
        assertEquals(2, capture.payload["parserResultCount"])
        assertEquals(listOf(mapOf("dataType" to "74", "dataEnd" to true), mapOf("dataType" to "66", "dataEnd" to false)), capture.payload["parserResults"])
        assertFalse(capture.payload.containsKey("data"))
        assertEquals(true, capture.payload["afterMeasurementCommandAck"])
        assertEquals(true, capture.payload["afterRealtimeFlagCommandAck"])
        assertEquals("MEASUREMENT_COMMAND_RESPONSE", trace.firstNotificationClassification)
    }

    @Test
    fun classifiesRealtimeFlagResponseOnlyWhenItMatchesTheGeneratedCommand() {
        val trace = JCVitalV8RawEcgNotificationDiagnostics(0L)
        val command = byteArrayOf(0x07, 0x01, 0x22)
        trace.recordRealtimeFlagCommand(command)
        val capture = trace.captureNotification(command.copyOf(), "realtime-response", 1L)!!
        trace.finishNotification(capture, command)
        assertEquals("REALTIME_FLAG_RESPONSE", trace.firstNotificationClassification)
    }

    @Test
    fun leavesUnmappedNotificationUnknownAndRecognizesLongRawEcgFrames() {
        val unknownTrace = JCVitalV8RawEcgNotificationDiagnostics(0L)
        val unknown = byteArrayOf(0x55, 0x01)
        val unknownCapture = unknownTrace.captureNotification(unknown, "unknown", 1L)!!
        unknownTrace.finishNotification(unknownCapture, unknown)
        assertEquals("UNKNOWN_NOTIFICATION", unknownTrace.firstNotificationClassification)

        val rawTrace = JCVitalV8RawEcgNotificationDiagnostics(0L)
        val rawPacket = ByteArray(17).apply { this[0] = 0x07 }
        val rawCapture = rawTrace.captureNotification(rawPacket, "raw", 1L)!!
        rawTrace.finishNotification(rawCapture, rawPacket)
        assertEquals("RAW_ECG_0X07", rawTrace.firstNotificationClassification)
        assertTrue(rawCapture.payload["fullBytesHex"] is String)

        val oversized = rawTrace.captureNotification(ByteArray(65), "oversized", 2L)!!
        assertFalse(oversized.payload.containsKey("fullBytesHex"))

        val statusTrace = JCVitalV8RawEcgNotificationDiagnostics(0L)
        val statusBytes = byteArrayOf(0x33, 0x03)
        val statusCapture = statusTrace.captureNotification(statusBytes, "status", 1L)!!
        statusTrace.recordParserResult(statusCapture, "66", true)
        statusTrace.finishNotification(statusCapture, statusBytes)
        assertEquals("VENDOR_STATUS", statusTrace.firstNotificationClassification)
    }
}