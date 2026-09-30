package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceConst

internal class JCVitalV8RawEcgNotificationDiagnostics(
    private val startedAtEpochMillis: Long,
) {
    internal class CapturedNotification(
        val payload: MutableMap<String, Any?>,
    ) {
        var parserResultCount = 0
        val parserDataTypes = mutableListOf<String>()
    }

    val genericNotificationsAfterStart = mutableListOf<MutableMap<String, Any?>>()
    var firstNotificationClassification: String? = null
        private set

    private var measurementCommandBytes: ByteArray? = null
    private var realtimeFlagCommandBytes: ByteArray? = null
    private var measurementCommandAckAtMillis: Long? = null
    private var realtimeFlagCommandAckAtMillis: Long? = null

    fun recordMeasurementCommand(bytes: ByteArray) {
        measurementCommandBytes = bytes.copyOf()
    }

    fun recordRealtimeFlagCommand(bytes: ByteArray) {
        realtimeFlagCommandBytes = bytes.copyOf()
    }

    fun recordMeasurementCommandAck(atMillis: Long) {
        measurementCommandAckAtMillis = atMillis
    }

    fun recordRealtimeFlagCommandAck(atMillis: Long) {
        realtimeFlagCommandAckAtMillis = atMillis
    }

    fun captureNotification(bytes: ByteArray, receivedAt: String, receivedAtEpochMillis: Long): CapturedNotification? {
        val elapsedMillis = receivedAtEpochMillis - startedAtEpochMillis
        if (bytes.isEmpty() || elapsedMillis !in 0..CAPTURE_WINDOW_MS || genericNotificationsAfterStart.size >= MAX_NOTIFICATIONS) return null

        val payload = linkedMapOf<String, Any?>(
            "sequence" to genericNotificationsAfterStart.size + 1,
            "receivedAt" to receivedAt,
            "length" to bytes.size,
            "commandByteUnsigned" to (bytes[0].toInt() and 0xFF),
            "secondByteUnsigned" to bytes.getOrNull(1)?.toInt()?.and(0xFF),
            "first16BytesHex" to bytes.copyOfRange(0, minOf(16, bytes.size)).toHex(),
            "afterMeasurementCommandAck" to (measurementCommandAckAtMillis?.let { receivedAtEpochMillis >= it } ?: false),
            "afterRealtimeFlagCommandAck" to (realtimeFlagCommandAckAtMillis?.let { receivedAtEpochMillis >= it } ?: false),
            "parserResultCount" to 0,
            "sdkParserResult" to "NO_RESULT",
            "parserResults" to mutableListOf<Map<String, Any?>>(),
        )
        if (bytes.size <= MAX_FULL_HEX_BYTES) payload["fullBytesHex"] = bytes.toHex()
        genericNotificationsAfterStart.add(payload)
        return CapturedNotification(payload)
    }

    fun recordParserResult(capture: CapturedNotification, dataType: String?, dataEnd: Boolean?) {
        capture.parserResultCount += 1
        capture.payload["parserResultCount"] = capture.parserResultCount
        capture.payload["sdkParserResult"] = when {
            capture.parserResultCount > 1 -> "MULTIPLE_RESULTS"
            dataType != null -> "RESULT_WITH_DATA_TYPE"
            else -> "RESULT_WITHOUT_DATA_TYPE"
        }
        if (dataType != null) {
            if (capture.parserDataTypes.size < MAX_PARSER_RESULTS_PER_NOTIFICATION) capture.parserDataTypes.add(dataType)
            @Suppress("UNCHECKED_CAST")
            val results = capture.payload["parserResults"] as MutableList<Map<String, Any?>>
            if (results.size < MAX_PARSER_RESULTS_PER_NOTIFICATION) {
                results.add(linkedMapOf("dataType" to dataType, "dataEnd" to dataEnd))
            }
        }
    }

    fun finishNotification(capture: CapturedNotification, bytes: ByteArray) {
        if (genericNotificationsAfterStart.firstOrNull() !== capture.payload || firstNotificationClassification != null) return
        val commandByte = bytes.firstOrNull()?.toInt()?.and(0xFF)
        val secondByte = bytes.getOrNull(1)?.toInt()?.and(0xFF)
        firstNotificationClassification = when {
            commandByte == (DeviceConst.MeasurementWithType.toInt() and 0xFF) &&
                secondByte == measurementCommandBytes?.getOrNull(1)?.toInt()?.and(0xFF) -> "MEASUREMENT_COMMAND_RESPONSE"
            realtimeFlagCommandBytes.contentEqualsBytes(bytes) -> "REALTIME_FLAG_RESPONSE"
            commandByte == JCVitalV8RawEcgSession.ECG_COMMAND_BYTE && bytes.size > ECG_STREAM_MIN_NOTIFICATION_BYTES -> "RAW_ECG_0X07"
            capture.parserDataTypes.any { it == BleConst.GetEcgPpgStatus || it == BleConst.EcgppGstatus } -> "VENDOR_STATUS"
            else -> "UNKNOWN_NOTIFICATION"
        }
    }

    private fun ByteArray?.contentEqualsBytes(other: ByteArray): Boolean = this != null && this.contentEquals(other)

    private fun ByteArray.toHex(): String = joinToString("") { "%02X".format(it.toInt() and 0xFF) }

    companion object {
        const val CAPTURE_WINDOW_MS = 15_000L
        const val MAX_NOTIFICATIONS = 10
        const val MAX_FULL_HEX_BYTES = 64
        const val MAX_PARSER_RESULTS_PER_NOTIFICATION = 10
        private const val ECG_STREAM_MIN_NOTIFICATION_BYTES = 16
    }
}