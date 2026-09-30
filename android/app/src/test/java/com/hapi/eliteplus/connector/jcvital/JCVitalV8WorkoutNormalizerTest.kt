package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8WorkoutNormalizerTest {
    private val normalizer = JCVitalV8WorkoutNormalizer()
    private val context = JCVitalV8WorkoutNormalizer.Context(
        sessionId = "workout-1",
        deviceId = "D6:AE:FB:AE:33:CC",
        firmwareVersion = "0.0.8.8",
        packetSequence = 3,
        receivedAt = "2026-09-30T10:00:03.000Z",
        activityMode = 0,
    )

    @Test
    fun normalizesOnlyAndroidReturnedWorkoutFieldsAndKeepsRawPayload() {
        val vendor = mapOf(
            DeviceKey.DataType to BleConst.SportData,
            DeviceKey.End to true,
            DeviceKey.Data to mapOf(
                DeviceKey.HeartRate to "117",
                DeviceKey.Step to "42",
                DeviceKey.Calories to "1.25",
                DeviceKey.ActiveMinutes to "3",
            ),
        )
        val packet = normalizer.normalize(vendor, context)

        assertEquals("workout-1", packet["sessionId"])
        assertEquals(3L, packet["packetSequence"])
        assertEquals(117, packet["heartRate"])
        assertEquals(42, packet["steps"])
        assertEquals(1.25, packet["calories"])
        assertEquals("3", packet["exerciseTimeRaw"])
        assertNull(packet["elapsedSeconds"])
        assertNull(packet["distance"])
        assertNull(packet["pace"])
        assertNull(packet["mets"])
        assertNull(packet["rssi"])
        assertNull(packet["temperature"])
        assertNull(packet["spo2"])
        assertEquals("82", packet["vendorDataType"])
        assertEquals("WORKOUT_REALTIME", packet["acquisitionMode"])
        assertTrue(packet["rawVendorPayload"].toString().contains("1.25"))
    }

    @Test
    fun retainsMissingAndZeroHeartRateSemantics() {
        val zeroPacket = normalizer.normalize(
            mapOf(DeviceKey.DataType to BleConst.SportData, DeviceKey.Data to mapOf(DeviceKey.HeartRate to "0")),
            context,
        )
        val missingPacket = normalizer.normalize(
            mapOf(DeviceKey.DataType to BleConst.SportData, DeviceKey.Data to mapOf(DeviceKey.Step to "1")),
            context,
        )
        assertEquals(0, zeroPacket["heartRate"])
        assertNull(missingPacket["heartRate"])
    }

    @Test
    fun rejectsUnexpectedResponseTypeAndMalformedDataObject() {
        assertThrows(JCVitalV8Exception::class.java) {
            normalizer.normalize(mapOf(DeviceKey.DataType to "29", DeviceKey.Data to emptyMap<String, String>()), context)
        }
        assertThrows(JCVitalV8Exception::class.java) {
            normalizer.normalize(mapOf(DeviceKey.DataType to BleConst.SportData, DeviceKey.Data to "bad"), context)
        }
    }
}
