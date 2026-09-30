package com.hapi.eliteplus.connector.jcvital

object JCVitalV8Errors {
    /** Error for a link that dropped without the user asking; null when the drop is expected. */
    fun forLinkDrop(previous: JCVitalV8ConnectionState, gattStatus: Int, userInitiated: Boolean): JCVitalV8ErrorCode? {
        if (userInitiated) return null
        return when (previous) {
            JCVitalV8ConnectionState.CONNECTING -> JCVitalV8ErrorCode.CONNECTION_FAILED
            JCVitalV8ConnectionState.CONNECTED,
            JCVitalV8ConnectionState.INITIALIZING,
            JCVitalV8ConnectionState.READY -> JCVitalV8ErrorCode.CONNECTION_LOST
            else -> if (gattStatus != 0) JCVitalV8ErrorCode.CONNECTION_FAILED else null
        }
    }

    /** Names for android.bluetooth.le.ScanCallback.SCAN_FAILED_* codes. */
    fun scanFailureReason(errorCode: Int): String = when (errorCode) {
        1 -> "SCAN_FAILED_ALREADY_STARTED"
        2 -> "SCAN_FAILED_APPLICATION_REGISTRATION_FAILED"
        3 -> "SCAN_FAILED_INTERNAL_ERROR"
        4 -> "SCAN_FAILED_FEATURE_UNSUPPORTED"
        5 -> "SCAN_FAILED_OUT_OF_HARDWARE_RESOURCES"
        6 -> "SCAN_FAILED_SCANNING_TOO_FREQUENTLY"
        else -> "SCAN_FAILED_UNKNOWN_$errorCode"
    }

    fun toPayload(
        code: JCVitalV8ErrorCode,
        message: String,
        state: JCVitalV8ConnectionState,
        deviceId: String?,
        timestampMillis: Long,
    ): Map<String, Any?> = linkedMapOf(
        "code" to code.name,
        "message" to message,
        "state" to state.name,
        "deviceId" to deviceId,
        "timestamp" to JCVitalV8Time.isoUtc(timestampMillis),
    )

    fun fromThrowable(t: Throwable, fallback: JCVitalV8ErrorCode): JCVitalV8Exception = when (t) {
        is JCVitalV8Exception -> t
        is SecurityException -> JCVitalV8Exception(JCVitalV8ErrorCode.PERMISSION_DENIED, t.message ?: "Bluetooth permission missing")
        else -> JCVitalV8Exception(fallback, t.message ?: t.javaClass.simpleName)
    }
}
