package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey

/**
 * Converts vendor `DataListener2301.dataCallback(Map)` maps into Elite+ events. Vendor maps never
 * cross the bridge directly; every emitted payload is a sanitized copy with provenance attached.
 */
class JCVitalV8EventNormalizer {
    data class Context(
        val deviceId: String?,
        val firmwareVersion: String?,
        val sessionId: String?,
        val receiptMillis: Long,
        val timezone: String,
    )

    data class Event(val name: String, val payload: Map<String, Any?>)

    fun normalize(vendor: Map<*, *>, ctx: Context): List<Event> {
        val dataType = vendor[DeviceKey.DataType]?.toString()
            ?: throw JCVitalV8Exception(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, "Vendor callback has no ${DeviceKey.DataType}")
        val data = sanitize(vendor[DeviceKey.Data])
        @Suppress("UNCHECKED_CAST")
        val fields = data as? Map<String, Any?> ?: emptyMap()
        val receipt = JCVitalV8Time.isoUtc(ctx.receiptMillis)

        val events = mutableListOf(
            Event(
                EVENT_RAW_VENDOR_DATA,
                linkedMapOf(
                    "source" to SOURCE,
                    "vendorDataType" to dataType,
                    "dataEnd" to vendor[DeviceKey.End] as? Boolean,
                    "data" to data,
                    "deviceId" to ctx.deviceId,
                    "receiptTimestamp" to receipt,
                ),
            ),
        )

        when (dataType) {
            BleConst.GetDeviceBatteryLevel -> {
                val chargingStateRaw = fields[DeviceKey.Chargingstate].asInt()
                events += Event(
                    EVENT_BATTERY,
                    linkedMapOf(
                        "deviceId" to ctx.deviceId,
                        "level" to fields[DeviceKey.BatteryLevel].asInt(),
                        "charging" to chargingStateRaw?.let { it != 0 },
                        "chargingStateRaw" to chargingStateRaw,
                        "voltageRaw" to fields[DeviceKey.Voltage_value].asInt(),
                        "vendorDataType" to dataType,
                        "receiptTimestamp" to receipt,
                    ),
                )
            }
            BleConst.GetDeviceVersion -> events += deviceInfo("firmwareVersion", fields[DeviceKey.DeviceVersion])
            BleConst.GetDeviceMacAddress -> events += deviceInfo("macAddress", fields[DeviceKey.MacAddress])
            BleConst.CMD_Get_Name -> events += deviceInfo("deviceName", fields[DeviceKey.DeviceName])
            BleConst.GetPersonalInfo -> events += deviceInfo("vendorDeviceId", fields[DeviceKey.KUserDeviceId])
            BleConst.RealTimeStep, BleConst.MeasurementHeartCallback -> {
                val bpm = fields[DeviceKey.HeartRate].asInt()
                // The V8 reports 0 when no heart-rate measurement is running.
                if (bpm != null && bpm > 0) events += Event(EVENT_HEART_RATE, heartRate(bpm, dataType, fields, ctx, receipt))
            }
        }
        return events
    }

    private fun deviceInfo(field: String, value: Any?): List<Event> {
        val text = value?.toString()?.trim()?.takeIf { it.isNotEmpty() } ?: return emptyList()
        return listOf(Event(EVENT_DEVICE_INFO, mapOf(field to text)))
    }

    private fun heartRate(bpm: Int, dataType: String, fields: Map<String, Any?>, ctx: Context, receipt: String): Map<String, Any?> =
        linkedMapOf(
            "source" to SOURCE,
            "type" to "HEART_RATE",
            "value" to bpm,
            "unit" to "bpm",
            "acquisitionMode" to "REALTIME",
            "deviceId" to ctx.deviceId,
            "firmwareVersion" to ctx.firmwareVersion,
            "sdkVersion" to SDK_VERSION,
            "vendorDataType" to dataType,
            // Neither realtime packet (23) nor measurement packet (74) carries a device timestamp.
            "timestamp" to null,
            "receiptTimestamp" to receipt,
            "timezone" to ctx.timezone,
            "sessionId" to ctx.sessionId,
            "packetId" to fields["packetID"]?.toString(),
            "rawVendorPayload" to fields,
        )

    private fun Any?.asInt(): Int? = when (this) {
        is Number -> toInt()
        is String -> trim().toIntOrNull()
        else -> null
    }

    companion object {
        const val SOURCE = "JCVITAL_V8"
        const val SDK_VERSION = "v8sdk2.0"

        const val EVENT_SCAN_RESULT = "jcvitalScanResult"
        const val EVENT_CONNECTION_STATE = "jcvitalConnectionState"
        const val EVENT_DEVICE_INFO = "jcvitalDeviceInfo"
        const val EVENT_BATTERY = "jcvitalBattery"
        const val EVENT_HEART_RATE = "jcvitalHeartRate"
        const val EVENT_RAW_VENDOR_DATA = "jcvitalRawVendorData"
        const val EVENT_ERROR = "jcvitalError"

        fun sanitize(value: Any?): Any? = when (value) {
            null -> null
            is Map<*, *> -> value.entries.associateTo(LinkedHashMap()) { (k, v) -> k.toString() to sanitize(v) }
            is Iterable<*> -> value.map { sanitize(it) }
            is Array<*> -> value.map { sanitize(it) }
            is String, is Number, is Boolean -> value
            else -> value.toString()
        }
    }
}
