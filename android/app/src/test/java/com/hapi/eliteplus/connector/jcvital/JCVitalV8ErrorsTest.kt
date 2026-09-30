package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8ErrorsTest {
    @Test
    fun linkDropDuringConnectIsConnectionFailed() {
        assertEquals(JCVitalV8ErrorCode.CONNECTION_FAILED, JCVitalV8Errors.forLinkDrop(JCVitalV8ConnectionState.CONNECTING, 133, false))
    }

    @Test
    fun linkDropAfterConnectIsConnectionLost() {
        for (state in listOf(JCVitalV8ConnectionState.CONNECTED, JCVitalV8ConnectionState.INITIALIZING, JCVitalV8ConnectionState.READY)) {
            assertEquals(JCVitalV8ErrorCode.CONNECTION_LOST, JCVitalV8Errors.forLinkDrop(state, 8, false))
        }
    }

    @Test
    fun userDisconnectIsNotAnError() {
        assertNull(JCVitalV8Errors.forLinkDrop(JCVitalV8ConnectionState.READY, 0, true))
        assertNull(JCVitalV8Errors.forLinkDrop(JCVitalV8ConnectionState.DISCONNECTED, 0, false))
    }

    @Test
    fun scanFailureCodesAreNamed() {
        assertEquals("SCAN_FAILED_SCANNING_TOO_FREQUENTLY", JCVitalV8Errors.scanFailureReason(6))
        assertEquals("SCAN_FAILED_UNKNOWN_42", JCVitalV8Errors.scanFailureReason(42))
    }

    @Test
    fun throwablesNormalizeToErrorCodes() {
        assertEquals(JCVitalV8ErrorCode.PERMISSION_DENIED, JCVitalV8Errors.fromThrowable(SecurityException("no"), JCVitalV8ErrorCode.SCAN_FAILED).code)
        assertEquals(JCVitalV8ErrorCode.SCAN_FAILED, JCVitalV8Errors.fromThrowable(IllegalStateException("x"), JCVitalV8ErrorCode.SCAN_FAILED).code)
        val original = JCVitalV8Exception(JCVitalV8ErrorCode.DEVICE_NOT_FOUND, "missing")
        assertTrue(original === JCVitalV8Errors.fromThrowable(original, JCVitalV8ErrorCode.CONNECTION_FAILED))
    }

    @Test
    fun errorPayloadShape() {
        val payload = JCVitalV8Errors.toPayload(JCVitalV8ErrorCode.CONNECTION_LOST, "dropped", JCVitalV8ConnectionState.READY, "AA:BB", 0L)
        assertEquals(
            mapOf("code" to "CONNECTION_LOST", "message" to "dropped", "state" to "READY", "deviceId" to "AA:BB", "timestamp" to "1970-01-01T00:00:00.000Z"),
            payload,
        )
    }

    @Test
    fun allRequiredCodesExist() {
        val expected = listOf(
            "BLUETOOTH_UNAVAILABLE", "BLUETOOTH_DISABLED", "PERMISSION_DENIED", "SCAN_FAILED", "DEVICE_NOT_FOUND",
            "CONNECTION_FAILED", "CONNECTION_LOST", "SERVICE_DISCOVERY_FAILED", "NOTIFICATION_SETUP_FAILED",
            "SDK_INITIALIZATION_FAILED", "COMMAND_FAILED", "RESPONSE_PARSE_FAILED", "UNSUPPORTED_OPERATION",
        )
        assertEquals(expected, JCVitalV8ErrorCode.values().map { it.name })
    }
}
