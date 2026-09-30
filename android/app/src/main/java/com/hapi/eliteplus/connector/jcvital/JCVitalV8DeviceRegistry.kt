package com.hapi.eliteplus.connector.jcvital

import java.util.Locale

class JCVitalV8DeviceRegistry(private val emitIntervalMs: Long = 1_000L) {
    data class Upsert(val device: JCVitalV8DiscoveredDevice, val isNew: Boolean, val shouldEmit: Boolean)

    private val devices = LinkedHashMap<String, JCVitalV8DiscoveredDevice>()
    private val lastEmittedAt = HashMap<String, Long>()

    @Synchronized
    fun upsert(
        address: String,
        name: String?,
        rssi: Int,
        bonded: Boolean,
        connectable: Boolean,
        advertisesJcvitalService: Boolean,
        seenAt: Long,
    ): Upsert {
        val id = normalizeId(address)
        val existing = devices[id]
        val device = JCVitalV8DiscoveredDevice(
            id = id,
            name = name?.takeIf { it.isNotBlank() } ?: existing?.name,
            macAddress = id,
            rssi = rssi,
            bonded = bonded,
            connectable = connectable,
            lastSeenAt = seenAt,
            advertisesJcvitalService = advertisesJcvitalService || existing?.advertisesJcvitalService == true,
        )
        devices[id] = device
        val isNew = existing == null
        val shouldEmit = isNew || existing?.name != device.name || seenAt - (lastEmittedAt[id] ?: 0L) >= emitIntervalMs
        if (shouldEmit) lastEmittedAt[id] = seenAt
        return Upsert(device, isNew, shouldEmit)
    }

    @Synchronized
    fun get(id: String): JCVitalV8DiscoveredDevice? = devices[normalizeId(id)]

    /** JCVital-service advertisers first, then strongest signal. */
    @Synchronized
    fun all(): List<JCVitalV8DiscoveredDevice> =
        devices.values.sortedWith(compareByDescending<JCVitalV8DiscoveredDevice> { it.advertisesJcvitalService }.thenByDescending { it.rssi })

    @Synchronized
    fun clear() {
        devices.clear()
        lastEmittedAt.clear()
    }

    companion object {
        fun normalizeId(address: String): String = address.trim().uppercase(Locale.US)
    }
}
