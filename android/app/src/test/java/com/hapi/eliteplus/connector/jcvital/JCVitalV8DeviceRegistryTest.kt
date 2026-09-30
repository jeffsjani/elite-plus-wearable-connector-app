package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8DeviceRegistryTest {
    private fun upsert(
        registry: JCVitalV8DeviceRegistry,
        address: String = "d6:ae:fb:ae:33:cc",
        name: String? = "V8",
        rssi: Int = -60,
        advertises: Boolean = false,
        seenAt: Long = 1_000L,
    ) = registry.upsert(address, name, rssi, bonded = false, connectable = true, advertisesJcvitalService = advertises, seenAt = seenAt)

    @Test
    fun deduplicatesByCaseInsensitiveAddress() {
        val registry = JCVitalV8DeviceRegistry()
        assertTrue(upsert(registry, address = "d6:ae:fb:ae:33:cc").isNew)
        assertFalse(upsert(registry, address = "D6:AE:FB:AE:33:CC", seenAt = 1_100L).isNew)
        assertEquals(1, registry.all().size)
        assertEquals("D6:AE:FB:AE:33:CC", registry.all().single().id)
        assertEquals("D6:AE:FB:AE:33:CC", registry.all().single().macAddress)
    }

    @Test
    fun updatesRssiAndLastSeen() {
        val registry = JCVitalV8DeviceRegistry()
        upsert(registry, rssi = -80, seenAt = 1_000L)
        upsert(registry, rssi = -55, seenAt = 5_000L)
        val device = registry.get("D6:AE:FB:AE:33:CC")!!
        assertEquals(-55, device.rssi)
        assertEquals(5_000L, device.lastSeenAt)
    }

    @Test
    fun keepsLastKnownNameAndServiceFlag() {
        val registry = JCVitalV8DeviceRegistry()
        upsert(registry, name = "V8", advertises = true)
        upsert(registry, name = null, advertises = false, seenAt = 2_000L)
        val device = registry.get("d6:ae:fb:ae:33:cc")!!
        assertEquals("V8", device.name)
        assertTrue(device.advertisesJcvitalService)
    }

    @Test
    fun throttlesRepeatEmissionsPerDevice() {
        val registry = JCVitalV8DeviceRegistry(emitIntervalMs = 1_000L)
        assertTrue(upsert(registry, seenAt = 10_000L).shouldEmit)
        assertFalse(upsert(registry, seenAt = 10_400L).shouldEmit)
        assertTrue(upsert(registry, seenAt = 11_000L).shouldEmit)
        assertTrue(upsert(registry, name = "V8 renamed", seenAt = 11_100L).shouldEmit)
    }

    @Test
    fun ordersServiceAdvertisersThenStrongestSignal() {
        val registry = JCVitalV8DeviceRegistry()
        upsert(registry, address = "00:00:00:00:00:01", name = "Phone", rssi = -40)
        upsert(registry, address = "00:00:00:00:00:02", name = "V8", rssi = -90, advertises = true)
        upsert(registry, address = "00:00:00:00:00:03", name = "Speaker", rssi = -70)
        assertEquals(listOf("00:00:00:00:00:02", "00:00:00:00:00:01", "00:00:00:00:00:03"), registry.all().map { it.id })
    }

    @Test
    fun clearRemovesDevices() {
        val registry = JCVitalV8DeviceRegistry()
        upsert(registry)
        registry.clear()
        assertTrue(registry.all().isEmpty())
        assertTrue(upsert(registry).isNew)
    }

    @Test
    fun deviceMapHasNormalizedShape() {
        val registry = JCVitalV8DeviceRegistry()
        val map = upsert(registry, seenAt = 0L).device.toMap()
        assertEquals(
            listOf("id", "name", "macAddress", "rssi", "bonded", "connectable", "lastSeenAt", "advertisesJcvitalService"),
            map.keys.toList(),
        )
        assertEquals("1970-01-01T00:00:00.000Z", map["lastSeenAt"])
    }
}
