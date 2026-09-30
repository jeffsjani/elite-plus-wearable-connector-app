package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.AutoTestMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

/** Packets are decoded by the real vendor SDK (v8sdk2.0.jar) before normalization. */
class JCVitalV8EventNormalizerTest {
    private val normalizer = JCVitalV8EventNormalizer()
    private val ctx = JCVitalV8EventNormalizer.Context(
        deviceId = "D6:AE:FB:AE:33:CC",
        firmwareVersion = "0.0.3.4",
        sessionId = "session-1",
        receiptMillis = 0L,
        timezone = "Europe/London",
    )

    private fun vendorParse(vararg bytes: Int, size: Int = 16): List<Map<String?, Any?>> {
        val packet = ByteArray(size)
        bytes.forEachIndexed { i, b -> packet[i] = b.toByte() }
        val collected = mutableListOf<Map<String?, Any?>>()
        BleSDK.DataParsingWithData(packet, object : DataListener2301 {
            override fun dataCallback(maps: MutableMap<String?, Any?>?) {
                maps?.let { collected += it }
            }

            override fun dataCallback(value: ByteArray?) = Unit
        })
        return collected
    }

    private fun events(vararg bytes: Int, size: Int = 16) = vendorParse(*bytes, size = size).flatMap { normalizer.normalize(it, ctx) }

    private fun realtimePacket(heartRate: Int): IntArray = IntArray(25).also {
        it[0] = 0x09
        it[1] = 0xCE; it[2] = 0x01 // 462 steps
        it[21] = heartRate
    }

    @Test
    fun batteryResponse() {
        val battery = events(0x13, 71, 0, 0x40, 0x35).single { it.name == "jcvitalBattery" }.payload
        assertEquals(71, battery["level"])
        assertEquals(false, battery["charging"])
        assertEquals(0, battery["chargingStateRaw"])
        assertEquals(13632, battery["voltageRaw"])
        assertEquals("9", battery["vendorDataType"])
        assertEquals("D6:AE:FB:AE:33:CC", battery["deviceId"])
    }

    @Test
    fun firmwareVersionResponse() {
        val info = events(0x27, 0, 0, 3, 4).single { it.name == "jcvitalDeviceInfo" }.payload
        assertEquals(mapOf("firmwareVersion" to "0.0.3.4"), info)
    }

    @Test
    fun macAndNameResponses() {
        assertEquals(
            mapOf("macAddress" to "D6:AE:FB:AE:33:CC"),
            events(0x22, 0xD6, 0xAE, 0xFB, 0xAE, 0x33, 0xCC).single { it.name == "jcvitalDeviceInfo" }.payload,
        )
        assertEquals(
            mapOf("deviceName" to "V8"),
            events(0x3E, 'V'.code, '8'.code).single { it.name == "jcvitalDeviceInfo" }.payload,
        )
    }

    @Test
    fun realtimeHeartRateObservationPreservesProvenance() {
        val all = events(*realtimePacket(78), size = 25)
        val hr = all.single { it.name == "jcvitalHeartRate" }.payload
        assertEquals("JCVITAL_V8", hr["source"])
        assertEquals("HEART_RATE", hr["type"])
        assertEquals(78, hr["value"])
        assertEquals("bpm", hr["unit"])
        assertEquals("REALTIME", hr["acquisitionMode"])
        assertEquals("D6:AE:FB:AE:33:CC", hr["deviceId"])
        assertEquals("0.0.3.4", hr["firmwareVersion"])
        assertEquals("v8sdk2.0", hr["sdkVersion"])
        assertEquals("23", hr["vendorDataType"])
        assertTrue(hr.containsKey("timestamp"))
        assertNull(hr["timestamp"])
        assertEquals("1970-01-01T00:00:00.000Z", hr["receiptTimestamp"])
        assertEquals("Europe/London", hr["timezone"])
        assertEquals("session-1", hr["sessionId"])
        @Suppress("UNCHECKED_CAST")
        val raw = hr["rawVendorPayload"] as Map<String, Any?>
        assertEquals("462", raw["step"])
        assertTrue(all.any { it.name == "jcvitalRawVendorData" })
    }

    @Test
    fun zeroHeartRateMeansNoMeasurementAndEmitsOnlyRawData() {
        val all = events(*realtimePacket(0), size = 25)
        assertFalse(all.any { it.name == "jcvitalHeartRate" })
        assertEquals(listOf("jcvitalRawVendorData"), all.map { it.name })
    }

    @Test
    fun measurementHeartRateCallback() {
        BleSDK.SetDeviceMeasurementWithType(AutoTestMode.AutoHeartRate, 60, true)
        val hr = events(0x28, 0x02, 81).single { it.name == "jcvitalHeartRate" }.payload
        assertEquals(81, hr["value"])
        assertEquals("74", hr["vendorDataType"])
        BleSDK.SetDeviceMeasurementWithType(AutoTestMode.AutoHeartRate, 0, false)
    }

    @Test
    fun realtimeTemperatureIsIndependentFromHeartRate() {
        val packet = realtimePacket(78)
        packet[22] = 0x6D
        packet[23] = 0x01
        val temperature = events(*packet, size = 25).single {
            it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION && it.payload["metricType"] == "WEARABLE_TEMPERATURE"
        }.payload
        assertEquals(36.5, temperature["value"])
        assertEquals("REALTIME", temperature["acquisitionMode"])
        assertNull(temperature["observedAt"])
    }

    @Test
    fun rawVendorEventIsSanitizedCopy() {
        val raw = events(0x27, 0, 0, 3, 4).single { it.name == "jcvitalRawVendorData" }.payload
        assertEquals("11", raw["vendorDataType"])
        assertEquals(true, raw["dataEnd"])
        assertEquals(mapOf("deviceVersion" to "0.0.3.4"), raw["data"])
        assertTrue(raw["data"] is LinkedHashMap<*, *>)
    }

    @Test
    fun missingDataTypeIsParseFailure() {
        val error = assertThrows(JCVitalV8Exception::class.java) { normalizer.normalize(mapOf("dicData" to emptyMap<String, String>()), ctx) }
        assertEquals(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, error.code)
    }

    @Test
    fun realtimePacketTruncatedByDefaultMtuCannotBeParsedBySdk() {
        // 20 bytes = default ATT MTU 23 payload; the SDK reads up to byte 24. This is why MTU is negotiated.
        assertThrows(ArrayIndexOutOfBoundsException::class.java) { vendorParse(*realtimePacket(78).copyOf(20), size = 20) }
    }

    private fun historical(dataType: String, records: List<Map<String, Any?>>, end: Boolean = true) = normalizer.normalize(
        mapOf(DeviceKey.DataType to dataType, DeviceKey.End to end, DeviceKey.Data to records),
        ctx,
    )

    @Test
    fun continuousHeartRatePreservesAllSamplesAtNativeCadence() {
        val observations = historical(
            BleConst.GetDynamicHR,
            listOf(mapOf(DeviceKey.Date to "2026.09.30 10:00:00", DeviceKey.ArrayDynamicHR to "70 71 0 73")),
        ).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload }

        assertEquals(listOf(70, 71, 0, 73), observations.map { it["value"] })
        assertEquals(listOf(0, 1, 2, 3), observations.map { it["sequenceNumber"] })
        assertTrue(observations.all { it["metricType"] == "HEART_RATE_CONTINUOUS" })
        assertTrue(observations.all { it["samplingIntervalMs"] == 5_000L })
        assertEquals("2026-09-30T09:00:00.000Z", observations.first()["observedAt"])
        assertEquals("2026-09-30T09:00:15.000Z", observations.last()["observedAt"])
    }

    @Test
    fun automaticSpo2AndTemperatureRemainIndependentObservations() {
        val spo2 = historical(
            BleConst.GetAutomaticSpo2Monitoring,
            listOf(mapOf(DeviceKey.Date to "2026.09.30 01:02:03", DeviceKey.Blood_oxygen to "97")),
        ).single { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.payload
        val temperature = historical(
            BleConst.Temperature_history,
            listOf(mapOf(DeviceKey.Date to "2026.09.30 01:02:03", DeviceKey.temperature to "36.4")),
        ).single { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.payload

        assertEquals("SPO2", spo2["metricType"])
        assertEquals(97, spo2["value"])
        assertEquals("percent", spo2["unit"])
        assertEquals("WEARABLE_TEMPERATURE", temperature["metricType"])
        assertEquals(36.4, temperature["value"])
        assertEquals("celsius", temperature["unit"])
        assertEquals("WEARABLE_TEMPERATURE_C", temperature["measurementContext"])
    }

    @Test
    fun hrvRecordKeepsVendorMetricsSeparateAndDoesNotInterpretScales() {
        val record = mapOf<String, Any?>(
            DeviceKey.Date to "2026.09.30 01:02:03", DeviceKey.HRV to "42", DeviceKey.HeartRate to "66",
            DeviceKey.Stress to "3", DeviceKey.highBP to "118", DeviceKey.lowBP to "76", DeviceKey.Fatiguedegree to "5",
            "unexpected" to "preserved",
        )
        val observations = historical(BleConst.GetHRVData, listOf(record))
            .filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload }

        assertEquals(
            setOf("HRV_VENDOR", "HEART_RATE_AUTOMATIC", "STRESS_VENDOR", "BP_SYSTOLIC_ESTIMATED", "BP_DIASTOLIC_ESTIMATED", "FATIGUE_VENDOR"),
            observations.map { it["metricType"] }.toSet(),
        )
        assertEquals("UNKNOWN_VENDOR_UNIT", observations.single { it["metricType"] == "HRV_VENDOR" }["unit"])
        assertEquals(true, observations.single { it["metricType"] == "BP_SYSTOLIC_ESTIMATED" }["vendorDerived"])
        @Suppress("UNCHECKED_CAST")
        val rawPayload = observations.first()["rawPayload"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        val rawRecord = rawPayload["record"] as Map<String, Any?>
        assertEquals("preserved", rawRecord["unexpected"])
    }

    @Test
    fun ppiArrayPreservesGroupAndUnknownUnit() {
        val observation = historical(
            BleConst.GetPPIData,
            listOf(mapOf(DeviceKey.Date to "2026.09.30 01:02:03", DeviceKey.serial_number to "513", DeviceKey.KPPIData to "[812, 0, 799]")),
        ).single { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.payload

        assertEquals("PPI", observation["metricType"])
        assertEquals(listOf(812, 0, 799), observation["values"])
        assertEquals("UNKNOWN_VENDOR_UNIT", observation["unit"])
        assertEquals("513", observation["packetId"])
    }

    @Test
    fun emptyCompletionResponseRetainsRawEnvelopeWithoutInventingRecords() {
        val events = historical(BleConst.GetHRVData, emptyList())
        assertEquals(listOf(JCVitalV8EventNormalizer.EVENT_RAW_VENDOR_DATA), events.map { it.name })
        assertEquals(true, events.single().payload["dataEnd"])
    }

    @Test
    fun missingAndMalformedRecordsProduceParseErrorsWithoutDroppingRawData() {
        val missing = historical(BleConst.GetAutomaticSpo2Monitoring, listOf(mapOf(DeviceKey.Date to "2026.09.30 01:02:03")))
        assertTrue(missing.any { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION && it.payload["value"] == null })
        assertTrue(missing.any { it.name == JCVitalV8EventNormalizer.EVENT_PARSE_ERROR })

        val malformed = normalizer.normalize(
            mapOf(DeviceKey.DataType to BleConst.GetHRVData, DeviceKey.End to true, DeviceKey.Data to "not-a-list"),
            ctx,
        )
        assertTrue(malformed.any { it.name == JCVitalV8EventNormalizer.EVENT_RAW_VENDOR_DATA })
        assertTrue(malformed.any { it.name == JCVitalV8EventNormalizer.EVENT_PARSE_ERROR })
    }

    @Test
    fun multiRecordResponsesAndDuplicateFingerprintsAreDeterministic() {
        val records = listOf(
            mapOf<String, Any?>(DeviceKey.Date to "2026.09.30 01:02:03", DeviceKey.Blood_oxygen to "97"),
            mapOf<String, Any?>(DeviceKey.Date to "2026.09.30 01:07:03", DeviceKey.Blood_oxygen to "96"),
        )
        val observations = historical(BleConst.GetAutomaticSpo2Monitoring, records)
            .filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }
        assertEquals(2, observations.size)
        val duplicate = historical(BleConst.GetAutomaticSpo2Monitoring, listOf(records.first()))
            .single { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }
        assertEquals(observations.first().payload["id"], duplicate.payload["id"])
    }

    @Test
    fun dailyActivityRecordPreservesEveryAndroidField() {
        val observations = historical(
            BleConst.GetTotalActivityData,
            listOf(mapOf(
                DeviceKey.Date to "2026.09.30", DeviceKey.Step to "1234", DeviceKey.ExerciseMinutes to "44",
                DeviceKey.Distance to "1.23", DeviceKey.Calories to "45.60", DeviceKey.Goal to "80",
                "unexpectedDailyField" to "preserved",
            )),
        ).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload }

        assertEquals(
            setOf("DAILY_STEPS", "DAILY_EXERCISE_MINUTES", "DAILY_DISTANCE", "DAILY_CALORIES", "DAILY_GOAL_COMPLETION"),
            observations.map { it["metricType"] }.toSet(),
        )
        assertEquals("count", observations.single { it["metricType"] == "DAILY_STEPS" }["unit"])
        @Suppress("UNCHECKED_CAST")
        val raw = observations.first()["rawPayload"] as Map<String, Any?>
        @Suppress("UNCHECKED_CAST")
        assertEquals("preserved", (raw["record"] as Map<String, Any?>)["unexpectedDailyField"])
    }

    @Test
    fun detailedActivityPreservesTenOneMinuteStepEpochsAndBlockSummaries() {
        val observations = historical(
            BleConst.GetDetailActivityData,
            listOf(mapOf(
                DeviceKey.Date to "2026.09.30 10:00:00", DeviceKey.ArraySteps to "1 2 3 4 5 6 7 8 9 10",
                DeviceKey.KDetailMinterStep to "55", DeviceKey.Distance to "0.50", DeviceKey.Calories to "4.20",
            )),
        ).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload }

        val epochs = observations.filter { it["metricType"] == "DETAILED_ACTIVITY_EPOCH" }
        assertEquals(10, epochs.size)
        assertEquals(60_000L, epochs.first()["samplingIntervalMs"])
        assertEquals("2026-09-30T09:00:00.000Z", epochs.first()["observedAt"])
        assertEquals("2026-09-30T09:09:00.000Z", epochs.last()["observedAt"])
        assertEquals(55, observations.single { it["metricType"] == "DETAILED_ACTIVITY_STEPS_TOTAL" }["value"])
    }

    @Test
    fun sleepEpisodeUsesVendorEpochLengthAndPreservesAllSourceCodesAsUnknown() {
        val observations = historical(
            BleConst.GetDetailSleepData,
            listOf(mapOf(
                DeviceKey.Date to "2026-09-30 22:00:00", DeviceKey.ArraySleep to "0 1 2 3 4",
                DeviceKey.sleepUnitLength to "5",
            )),
        ).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload }

        val episode = observations.single { it["metricType"] == "SLEEP_EPISODE" }
        val epochs = observations.filter { it["metricType"] == "SLEEP_STAGE" }
        assertEquals(listOf(0, 1, 2, 3, 4), episode["values"])
        assertEquals(300_000L, episode["samplingIntervalMs"])
        assertEquals(5, epochs.size)
        assertTrue(epochs.all { it["measurementContext"] == "CANONICAL_STAGE_UNKNOWN" })
        assertEquals(listOf(0, 1, 2, 3, 4), epochs.map { it["value"] })
    }

    @Test
    fun sleepMovementArraysRemainSeparateWhenAlignmentIsUnknown() {
        val observations = historical(
            BleConst.Obtain_detailed_sleep_data,
            listOf(mapOf(
                DeviceKey.Date to "2026.09.30 22:00:00", DeviceKey.KSleepLength to "4",
                DeviceKey.Sleep_level to "[0, 1, 2, 3]", DeviceKey.ActivityData to "[4, 5, 6]",
            )),
        ).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload }

        assertEquals(listOf(0, 1, 2, 3), observations.single { it["metricType"] == "SLEEP_STAGE_DETAIL_RAW" }["values"])
        assertEquals(listOf(4, 5, 6), observations.single { it["metricType"] == "SLEEP_MOVEMENT" }["values"])
        assertTrue(observations.all { it["samplingIntervalMs"] == null })
    }

    @Test
    fun emptyAndMalformedSleepResponsesAreExplicit() {
        val empty = historical(BleConst.GetDetailSleepData, emptyList())
        assertEquals(listOf(JCVitalV8EventNormalizer.EVENT_RAW_VENDOR_DATA), empty.map { it.name })

        val malformed = historical(
            BleConst.GetDetailSleepData,
            listOf(mapOf(DeviceKey.Date to "not-a-date", DeviceKey.ArraySleep to "bad", DeviceKey.sleepUnitLength to "bad")),
        )
        assertTrue(malformed.any { it.name == JCVitalV8EventNormalizer.EVENT_PARSE_ERROR })
        assertTrue(malformed.any { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION })
    }

    @Test
    fun workoutHistoryMapsKnownAndUnknownModesWithoutFabricatingMets() {
        val knownRecord = mapOf<String, Any?>(
            DeviceKey.Date to "2026.09.30 12:00:00", DeviceKey.ActivityMode to "0", DeviceKey.HeartRate to "120",
            DeviceKey.ActiveMinutes to "600", DeviceKey.Step to "1234", DeviceKey.Pace to "05'30\"",
            DeviceKey.Distance to "2.50", DeviceKey.Calories to "123.4",
        )
        val known = historical(BleConst.GetActivityModeData, listOf(knownRecord))
            .filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload }
        assertEquals("RUN", known.single { it["metricType"] == "WORKOUT_TYPE" }["value"])
        assertFalse(known.any { it["metricType"] == "WORKOUT_METS" })

        val unknown = historical(BleConst.GetActivityModeData, listOf(knownRecord + (DeviceKey.ActivityMode to "99")))
            .filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }
        assertEquals("OTHER_VENDOR_MODE_99", unknown.single { it.payload["metricType"] == "WORKOUT_TYPE" }.payload["value"])
    }

    @Test
    fun workoutSessionFingerprintIsDeterministicAndCompletionMarkerIsRetained() {
        val record = mapOf<String, Any?>(DeviceKey.Date to "2026.09.30 12:00:00", DeviceKey.ActivityMode to "9", DeviceKey.Step to "50")
        val first = historical(BleConst.GetActivityModeData, listOf(record), end = false)
            .filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }
        val duplicate = historical(BleConst.GetActivityModeData, listOf(record), end = true)
        assertEquals(first.map { it.payload["id"] }, duplicate.filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map { it.payload["id"] })
        assertEquals(true, duplicate.single { it.name == JCVitalV8EventNormalizer.EVENT_RAW_VENDOR_DATA }.payload["dataEnd"])
    }
}
