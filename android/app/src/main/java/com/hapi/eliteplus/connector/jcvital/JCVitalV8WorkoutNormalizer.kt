package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey

class JCVitalV8WorkoutNormalizer {
    data class Context(
        val sessionId: String,
        val deviceId: String?,
        val firmwareVersion: String?,
        val packetSequence: Long,
        val receivedAt: String,
        val activityMode: Int,
    )

    fun normalize(vendor: Map<*, *>, context: Context): Map<String, Any?> {
        val vendorDataType = vendor[DeviceKey.DataType]?.toString()
            ?: throw JCVitalV8Exception(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, "Workout response has no ${DeviceKey.DataType}")
        if (vendorDataType != BleConst.SportData) {
            throw JCVitalV8Exception(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, "Unexpected workout response type $vendorDataType")
        }
        @Suppress("UNCHECKED_CAST")
        val data = JCVitalV8EventNormalizer.sanitize(vendor[DeviceKey.Data]) as? Map<String, Any?>
            ?: throw JCVitalV8Exception(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, "Workout response data is not an object")
        val returnedFields = data.keys.sorted()
        return linkedMapOf(
            "sessionId" to context.sessionId,
            "deviceId" to context.deviceId,
            "receivedAt" to context.receivedAt,
            "vendorTimestamp" to null,
            "packetSequence" to context.packetSequence,
            "heartRate" to data[DeviceKey.HeartRate].asInt(),
            "elapsedSeconds" to null,
            "exerciseTimeRaw" to data[DeviceKey.ActiveMinutes],
            "steps" to data[DeviceKey.Step].asInt(),
            "calories" to data[DeviceKey.Calories].asDouble(),
            "distance" to null,
            "pace" to null,
            "mets" to null,
            "rssi" to null,
            "temperature" to null,
            "spo2" to null,
            "vendorActivityMode" to context.activityMode,
            "vendorDataType" to vendorDataType,
            "acquisitionMode" to "WORKOUT_REALTIME",
            "returnedVendorFields" to returnedFields,
            "rawVendorPayload" to JCVitalV8EventNormalizer.sanitize(vendor),
            "firmwareVersion" to context.firmwareVersion,
        )
    }

    private fun Any?.asInt(): Int? = when (this) {
        is Number -> toInt()
        is String -> trim().toIntOrNull()
        else -> null
    }

    private fun Any?.asDouble(): Double? = when (this) {
        is Number -> toDouble()
        is String -> trim().toDoubleOrNull()
        else -> null
    }

}
