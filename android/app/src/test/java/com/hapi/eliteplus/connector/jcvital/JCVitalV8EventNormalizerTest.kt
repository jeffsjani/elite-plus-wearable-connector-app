package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
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
}
