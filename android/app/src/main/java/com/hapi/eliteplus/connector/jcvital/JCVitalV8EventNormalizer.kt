package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import java.nio.charset.StandardCharsets
import java.text.ParsePosition
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

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
                val temperature = fields[DeviceKey.TempData].asDouble()
                if (dataType == BleConst.RealTimeStep && temperature != null && temperature > 0) {
                    events += Event(
                        EVENT_OBSERVATION,
                        observation(
                            "WEARABLE_TEMPERATURE", temperature, "celsius", null, null,
                            dataType, DeviceKey.TempData, false, "WEARABLE_TEMPERATURE_REALTIME", null, null, null,
                            fields, vendor, ctx, receipt, acquisitionMode = "REALTIME",
                        ),
                    )
                }
            }
            BleConst.GetDynamicHR -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::continuousHeartRate)
            BleConst.GetAutomaticSpo2Monitoring -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::spo2)
            BleConst.Temperature_history -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::temperature)
            BleConst.GetHRVData -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::hrv)
            BleConst.GetPPIData -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::ppi)
            BleConst.GetTotalActivityData -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::dailyActivity)
            BleConst.GetDetailActivityData -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::detailedActivity)
            BleConst.GetDetailSleepData -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::sleepStages)
            BleConst.Obtain_detailed_sleep_data -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::sleepMovement)
            BleConst.GetActivityModeData -> events += historicalRecords(vendor, fields, dataType, ctx, receipt, ::workout)
        }
        return events
    }

    private fun historicalRecords(
        envelope: Map<*, *>,
        fields: Map<String, Any?>,
        dataType: String,
        ctx: Context,
        receipt: String,
        mapper: (Map<String, Any?>, Map<*, *>, String, Context, String) -> List<Map<String, Any?>>,
    ): List<Event> {
        val rawData: Any? = if (fields.isNotEmpty()) fields else sanitize(envelope[DeviceKey.Data])
        val records = when (rawData) {
            is List<*> -> rawData
            null -> emptyList<Any?>()
            else -> return listOf(Event(EVENT_PARSE_ERROR, parseError(dataType, "Historical data is not an array", rawData, receipt)))
        }
        return records.flatMap { rawRecord ->
            @Suppress("UNCHECKED_CAST")
            val record = rawRecord as? Map<String, Any?> ?: return@flatMap listOf(
                Event(EVENT_PARSE_ERROR, parseError(dataType, "Historical record is not an object", rawRecord, receipt)),
            )
            mapper(record, envelope, dataType, ctx, receipt).flatMap { observation ->
                val hasValue = observation["value"] != null || (observation["values"] as? List<*>)?.isNotEmpty() == true
                buildList {
                    add(Event(EVENT_OBSERVATION, observation))
                    if (!hasValue) add(Event(EVENT_PARSE_ERROR, parseError(dataType, "${observation["vendorField"]} is missing or malformed", record, receipt)))
                }
            }
        }
    }

    private fun continuousHeartRate(
        record: Map<String, Any?>,
        envelope: Map<*, *>,
        dataType: String,
        ctx: Context,
        receipt: String,
    ): List<Map<String, Any?>> {
        val values = record[DeviceKey.ArrayDynamicHR].integerArray()
        val sourceTime = record[DeviceKey.Date]?.toString()
        return values.mapIndexed { sequence, value ->
            observation(
                metricType = "HEART_RATE_CONTINUOUS",
                value = value,
                unit = "bpm",
                observedAtSource = sourceTime,
                observedAt = parseVendorDate(sourceTime, ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time + sequence * CONTINUOUS_HR_INTERVAL_MS) },
                dataType = dataType,
                vendorField = DeviceKey.ArrayDynamicHR,
                vendorDerived = false,
                context = "CONTINUOUS_HISTORY",
                sequence = sequence,
                samplingIntervalMs = CONTINUOUS_HR_INTERVAL_MS,
                packetId = null,
                record = record,
                envelope = envelope,
                ctx = ctx,
                receipt = receipt,
            )
        }
    }

    private fun spo2(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String) = listOf(
        observation(
            "SPO2", record[DeviceKey.Blood_oxygen].asInt(), "percent", record[DeviceKey.Date]?.toString(),
            parseVendorDate(record[DeviceKey.Date]?.toString(), ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time) },
            dataType, DeviceKey.Blood_oxygen, false, "AUTOMATIC", null, null, null, record, envelope, ctx, receipt,
        ),
    )

    private fun temperature(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String) = listOf(
        observation(
            "WEARABLE_TEMPERATURE", record[DeviceKey.temperature].asDouble(), "celsius", record[DeviceKey.Date]?.toString(),
            parseVendorDate(record[DeviceKey.Date]?.toString(), ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time) },
            dataType, DeviceKey.temperature, false, "WEARABLE_TEMPERATURE_C", null, null, null, record, envelope, ctx, receipt,
        ),
    )

    private fun hrv(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String): List<Map<String, Any?>> {
        val sourceTime = record[DeviceKey.Date]?.toString()
        val observedAt = parseVendorDate(sourceTime, ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time) }
        val fields = listOf(
            ObservationField("HRV_VENDOR", DeviceKey.HRV, "UNKNOWN_VENDOR_UNIT", true),
            ObservationField("HEART_RATE_AUTOMATIC", DeviceKey.HeartRate, "bpm", false),
            ObservationField("STRESS_VENDOR", DeviceKey.Stress, "UNKNOWN_VENDOR_UNIT", true),
            ObservationField("BP_SYSTOLIC_ESTIMATED", DeviceKey.highBP, "UNKNOWN_VENDOR_UNIT", true),
            ObservationField("BP_DIASTOLIC_ESTIMATED", DeviceKey.lowBP, "UNKNOWN_VENDOR_UNIT", true),
            ObservationField("FATIGUE_VENDOR", DeviceKey.Fatiguedegree, "UNKNOWN_VENDOR_UNIT", true),
        )
        return fields.filter { record.containsKey(it.vendorField) }.map { field ->
            observation(
                field.metricType, record[field.vendorField].asDoubleOrInt(), field.unit, sourceTime, observedAt,
                dataType, field.vendorField, field.vendorDerived, "HRV_HISTORY", null, null, null,
                record, envelope, ctx, receipt,
            )
        }
    }

    private fun ppi(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String): List<Map<String, Any?>> {
        val sourceTime = record[DeviceKey.Date]?.toString()
        val packetId = record[DeviceKey.serial_number]?.toString()
        return listOf(
            observation(
                "PPI", null, "UNKNOWN_VENDOR_UNIT", sourceTime,
                parseVendorDate(sourceTime, ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time) },
                dataType, DeviceKey.KPPIData, false, "PPI_HISTORY", null, null, packetId,
                record, envelope, ctx, receipt, record[DeviceKey.KPPIData].integerArray(),
            ),
        )
    }

    private fun dailyActivity(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String): List<Map<String, Any?>> {
        val sourceTime = record[DeviceKey.Date]?.toString()
        val observedAt = parseVendorDate(sourceTime, ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time) }
        val fields = listOf(
            ObservationField("DAILY_STEPS", DeviceKey.Step, "count", false),
            ObservationField("DAILY_EXERCISE_MINUTES", DeviceKey.ExerciseMinutes, "minute", false),
            ObservationField("DAILY_DISTANCE", DeviceKey.Distance, "UNKNOWN_VENDOR_UNIT", false),
            ObservationField("DAILY_CALORIES", DeviceKey.Calories, "UNKNOWN_VENDOR_UNIT", false),
            ObservationField("DAILY_GOAL_COMPLETION", DeviceKey.Goal, "UNKNOWN_VENDOR_UNIT", false),
            ObservationField("DAILY_ACTIVE_MINUTES", DeviceKey.ActiveMinutes, "minute", false),
        )
        return fields.filter { record.containsKey(it.vendorField) }.map { field ->
            observation(
                field.metricType, record[field.vendorField].asDoubleOrInt(), field.unit, sourceTime, observedAt,
                dataType, field.vendorField, field.vendorDerived, "DAILY_ACTIVITY", null, null, null,
                record, envelope, ctx, receipt,
            )
        }
    }

    private fun detailedActivity(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String): List<Map<String, Any?>> {
        val sourceTime = record[DeviceKey.Date]?.toString()
        val startedAt = parseVendorDate(sourceTime, ctx.timezone)
        val values = record[DeviceKey.ArraySteps].integerArray()
        val observations = values.mapIndexed { sequence, value ->
            observation(
                "DETAILED_ACTIVITY_EPOCH", value, "count", sourceTime,
                startedAt?.let { JCVitalV8Time.isoUtc(it.time + sequence * DETAIL_ACTIVITY_INTERVAL_MS) },
                dataType, DeviceKey.ArraySteps, false, "ONE_MINUTE_STEP_EPOCH", sequence,
                DETAIL_ACTIVITY_INTERVAL_MS, null, record, envelope, ctx, receipt,
            )
        }.toMutableList()
        val summaryFields = listOf(
            ObservationField("DETAILED_ACTIVITY_STEPS_TOTAL", DeviceKey.KDetailMinterStep, "count", false),
            ObservationField("DETAILED_ACTIVITY_DISTANCE", DeviceKey.Distance, "UNKNOWN_VENDOR_UNIT", false),
            ObservationField("DETAILED_ACTIVITY_CALORIES", DeviceKey.Calories, "UNKNOWN_VENDOR_UNIT", false),
        )
        summaryFields.filter { record.containsKey(it.vendorField) }.forEach { field ->
            observations += observation(
                field.metricType, record[field.vendorField].asDoubleOrInt(), field.unit, sourceTime,
                startedAt?.let { JCVitalV8Time.isoUtc(it.time) }, dataType, field.vendorField, false,
                "DETAIL_ACTIVITY_BLOCK", null, null, null, record, envelope, ctx, receipt,
            )
        }
        return observations
    }

    private fun sleepStages(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String): List<Map<String, Any?>> {
        val sourceTime = record[DeviceKey.Date]?.toString()
        val startedAt = parseVendorDate(sourceTime, ctx.timezone)
        val sourceCodes = record[DeviceKey.ArraySleep].integerArray()
        val epochMinutes = record[DeviceKey.sleepUnitLength].asInt()
        val epochMs = epochMinutes?.takeIf { it > 0 }?.times(60_000L)
        val episode = observation(
            "SLEEP_EPISODE", null, "source_stage_code", sourceTime,
            startedAt?.let { JCVitalV8Time.isoUtc(it.time) }, dataType, DeviceKey.ArraySleep, false,
            "SLEEP_EPISODE_SOURCE_ARRAY", null, epochMs, null, record, envelope, ctx, receipt, sourceCodes,
            acquisitionMode = "SLEEP",
        )
        val epochs = sourceCodes.mapIndexed { sequence, sourceCode ->
            observation(
                "SLEEP_STAGE", sourceCode, "source_stage_code", sourceTime,
                if (epochMs == null) null else startedAt?.let { JCVitalV8Time.isoUtc(it.time + sequence * epochMs) },
                dataType, DeviceKey.ArraySleep, false, "CANONICAL_STAGE_UNKNOWN", sequence, epochMs,
                null, record, envelope, ctx, receipt, acquisitionMode = "SLEEP",
            )
        }
        return listOf(episode) + epochs
    }

    private fun sleepMovement(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String): List<Map<String, Any?>> {
        val sourceTime = record[DeviceKey.Date]?.toString()
        val observedAt = parseVendorDate(sourceTime, ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time) }
        return listOf(
            observation(
                "SLEEP_STAGE_DETAIL_RAW", null, "source_stage_code", sourceTime, observedAt, dataType,
                DeviceKey.Sleep_level, false, "UNALIGNED_DETAIL_STAGE_ARRAY", null, null, null,
                record, envelope, ctx, receipt, record[DeviceKey.Sleep_level].integerArray(), "SLEEP",
            ),
            observation(
                "SLEEP_MOVEMENT", null, "UNKNOWN_VENDOR_UNIT", sourceTime, observedAt, dataType,
                DeviceKey.ActivityData, false, "UNALIGNED_MOVEMENT_ARRAY", null, null, null,
                record, envelope, ctx, receipt, record[DeviceKey.ActivityData].integerArray(), "SLEEP",
            ),
        )
    }

    private fun workout(record: Map<String, Any?>, envelope: Map<*, *>, dataType: String, ctx: Context, receipt: String): List<Map<String, Any?>> {
        val sourceTime = record[DeviceKey.Date]?.toString()
        val observedAt = parseVendorDate(sourceTime, ctx.timezone)?.let { JCVitalV8Time.isoUtc(it.time) }
        val vendorMode = record[DeviceKey.ActivityMode].asInt()
        val fields = listOf(
            ObservationField("WORKOUT_TYPE", DeviceKey.ActivityMode, "vendor_mode", false),
            ObservationField("WORKOUT_HR", DeviceKey.HeartRate, "bpm", false),
            ObservationField("WORKOUT_DURATION", DeviceKey.ActiveMinutes, "UNKNOWN_VENDOR_UNIT", false),
            ObservationField("WORKOUT_STEPS", DeviceKey.Step, "count", false),
            ObservationField("WORKOUT_PACE", DeviceKey.Pace, "UNKNOWN_VENDOR_UNIT", false),
            ObservationField("WORKOUT_DISTANCE", DeviceKey.Distance, "UNKNOWN_VENDOR_UNIT", false),
            ObservationField("WORKOUT_CALORIES", DeviceKey.Calories, "UNKNOWN_VENDOR_UNIT", false),
        )
        return fields.filter { record.containsKey(it.vendorField) }.map { field ->
            val value = if (field.vendorField == DeviceKey.ActivityMode) JCVitalV8ActivityModes.canonicalType(vendorMode) else record[field.vendorField].asNumberOrString()
            observation(
                field.metricType, value, field.unit, sourceTime, observedAt, dataType, field.vendorField, false,
                "VENDOR_ACTIVITY_MODE_${vendorMode ?: "UNKNOWN"}", null, null, null,
                record, envelope, ctx, receipt,
            )
        }
    }

    private fun observation(
        metricType: String,
        value: Any?,
        unit: String,
        observedAtSource: String?,
        observedAt: String?,
        dataType: String,
        vendorField: String,
        vendorDerived: Boolean,
        context: String,
        sequence: Int?,
        samplingIntervalMs: Long?,
        packetId: String?,
        record: Map<String, Any?>,
        envelope: Map<*, *>,
        ctx: Context,
        receipt: String,
        values: List<Int>? = null,
        acquisitionMode: String = "HISTORICAL_SYNC",
    ): Map<String, Any?> {
        val sourceRecordId = listOf(ctx.deviceId, dataType, vendorField, observedAtSource, packetId, sequence, value, values).joinToString("|")
        val id = UUID.nameUUIDFromBytes(sourceRecordId.toByteArray(StandardCharsets.UTF_8)).toString()
        return linkedMapOf(
            "id" to id,
            "source" to linkedMapOf(
                "connector" to "JCVITAL_NATIVE", "provider" to "JCVITAL", "deviceModel" to "PRO_V8",
                "deviceId" to ctx.deviceId, "macAddress" to ctx.deviceId,
                "firmwareVersion" to ctx.firmwareVersion, "sdkVersion" to SDK_VERSION,
            ),
            "metricType" to metricType,
            "observedAt" to observedAt,
            "observedAtSource" to observedAtSource,
            "receivedAt" to receipt,
            "timezone" to ctx.timezone,
            "value" to value,
            "values" to values,
            "unit" to unit,
            "acquisitionMode" to acquisitionMode,
            "measurementContext" to context,
            "sessionId" to ctx.sessionId,
            "packetId" to packetId,
            "sequenceNumber" to sequence,
            "samplingIntervalMs" to samplingIntervalMs,
            "sampleRateHz" to null,
            "signalQuality" to null,
            "completeness" to null,
            "vendorDataType" to dataType,
            "vendorField" to vendorField,
            "vendorDerived" to vendorDerived,
            "rawPayload" to linkedMapOf("vendorEnvelope" to sanitize(envelope), "record" to sanitize(record)),
            "provenance" to linkedMapOf(
                "sourceConnector" to "JCVITAL_NATIVE", "provider" to "JCVITAL",
                "sourceRecordId" to sourceRecordId, "parserVersion" to PARSER_VERSION,
            ),
        )
    }

    private fun parseError(dataType: String, message: String, rawRecord: Any?, receipt: String) = linkedMapOf(
        "vendorDataType" to dataType, "message" to message, "rawRecord" to sanitize(rawRecord), "receivedAt" to receipt,
    )

    private fun parseVendorDate(value: String?, timezone: String): Date? {
        if (value.isNullOrBlank()) return null
        val formats = listOf("yyyy.MM.dd HH:mm:ss", "yyyy-MM-dd HH:mm:ss", "yyyy.MM.dd", "yyyy-MM-dd")
        for (pattern in formats) {
            val format = SimpleDateFormat(pattern, Locale.US).apply {
                isLenient = false
                timeZone = TimeZone.getTimeZone(timezone)
            }
            val position = ParsePosition(0)
            val parsed = format.parse(value, position)
            if (parsed != null && position.index == value.length) return parsed
        }
        return null
    }

    private fun Any?.integerArray(): List<Int> = when (this) {
        is Iterable<*> -> mapNotNull { it.asInt() }
        is String -> trim().removePrefix("[").removeSuffix("]").split(Regex("[,\\s]+"))
            .filter { it.isNotBlank() }.mapNotNull(String::toIntOrNull)
        else -> emptyList()
    }

    private fun Any?.asDouble(): Double? = when (this) {
        is Number -> toDouble()
        is String -> trim().toDoubleOrNull()
        else -> null
    }

    private fun Any?.asDoubleOrInt(): Number? = asDouble()?.let { if (it % 1.0 == 0.0) it.toInt() else it }

    private fun Any?.asNumberOrString(): Any? = asDoubleOrInt() ?: toString().takeIf { it.isNotBlank() }

    private data class ObservationField(val metricType: String, val vendorField: String, val unit: String, val vendorDerived: Boolean)

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
        const val EVENT_OBSERVATION = "jcvitalObservation"
        const val EVENT_PARSE_ERROR = "jcvitalParseError"
        const val EVENT_RAW_VENDOR_DATA = "jcvitalRawVendorData"
        const val EVENT_ERROR = "jcvitalError"
        const val PARSER_VERSION = "phase3b-1"
        private const val CONTINUOUS_HR_INTERVAL_MS = 5_000L
        private const val DETAIL_ACTIVITY_INTERVAL_MS = 60_000L

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
