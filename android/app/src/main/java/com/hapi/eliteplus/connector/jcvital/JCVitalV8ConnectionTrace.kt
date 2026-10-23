package com.hapi.eliteplus.connector.jcvital

import java.util.Locale

/**
 * Engineering-only Bluetooth discovery/connection trace (Build 32B.1-D).
 * Every method is a no-op unless [enabled]; production builds construct it disabled.
 * It never sees credentials, tokens, or physiological payloads.
 */
class JCVitalV8ConnectionTrace(
    val enabled: Boolean,
    private val clock: () -> Long = System::currentTimeMillis,
    private val maxEvents: Int = 600,
    private val maxCandidates: Int = 200,
) {
    data class Event(val sequence: Long, val at: Long, val event: String, val detail: Map<String, Any?>)

    class Candidate(val address: String, val firstSeenAt: Long, val scanSession: Long) {
        var name: String? = null
        var rssi: Int = 0
        var serviceUuids: List<String> = emptyList()
        var advertisesJcvitalService = false
        var connectable: Boolean? = null
        var lastSeenAt: Long = firstSeenAt
        var advertisementCount = 0
        var emittedToJs = 0
        var emittedWithJsListener = 0
        var acceptedByNativeFilter = false
        var rejectionReason: String? = null
    }

    private val lock = Any()
    private val events = ArrayDeque<Event>()
    private val candidates = LinkedHashMap<String, Candidate>()
    private var sequence = 0L
    private var droppedEvents = 0L
    private var scanSession = 0L
    private var scanRequested = 0L
    private var scanStartedAt: Long? = null
    private var scanActive = false
    private var scanCallbackRegistered = false
    private var advertisementsReceived = 0L
    private var lateAdvertisementsIgnored = 0L
    private var droppedCandidates = 0L
    private var pluginLoadedAt: Long? = null

    fun pluginLoaded() {
        if (!enabled) return
        synchronized(lock) { pluginLoadedAt = clock() }
        record("PLUGIN_INITIALIZED")
    }

    fun record(event: String, detail: Map<String, Any?> = emptyMap()) {
        if (!enabled) return
        synchronized(lock) {
            if (events.size >= maxEvents) {
                events.removeFirst()
                droppedEvents++
            }
            events.addLast(Event(++sequence, clock(), event, detail))
        }
    }

    fun scanRequested(timeoutMs: Long) {
        if (!enabled) return
        synchronized(lock) { scanRequested++ }
        record("SCAN_REQUESTED", mapOf("timeoutMs" to timeoutMs))
    }

    fun scanStarted() {
        if (!enabled) return
        synchronized(lock) {
            scanSession++
            scanStartedAt = clock()
            scanActive = true
            scanCallbackRegistered = true
        }
        record("SCAN_STARTED", mapOf("scanSession" to scanSession))
    }

    fun scanStartFailed(code: String, message: String?) {
        if (!enabled) return
        synchronized(lock) { scanActive = false; scanCallbackRegistered = false }
        record("SCAN_START_FAILED", mapOf("code" to code, "message" to message))
    }

    fun scanStopped(reason: String, registryDevices: Int) {
        if (!enabled) return
        val received = synchronized(lock) {
            scanActive = false
            scanCallbackRegistered = false
            candidates.values.count { it.scanSession == scanSession }
        }
        record("SCAN_STOPPED", mapOf("reason" to reason, "registryDevices" to registryDevices,
            "advertisersThisSession" to received))
    }

    fun lateAdvertisementIgnored() {
        if (!enabled) return
        synchronized(lock) { lateAdvertisementsIgnored++ }
    }

    /** Records one advertisement and the native list filter decision applied to it. */
    fun advertisement(
        address: String,
        name: String?,
        rssi: Int,
        serviceUuids: List<String>,
        advertisesJcvitalService: Boolean,
        connectable: Boolean?,
        accepted: Boolean,
        rejectionReason: String?,
    ) {
        if (!enabled) return
        var firstAdvertisement = false
        var firstCandidateMatch = false
        synchronized(lock) {
            advertisementsReceived++
            val key = "$scanSession:${address.uppercase(Locale.US)}"
            val existing = candidates[key]
            firstAdvertisement = existing == null
            val candidate = existing ?: run {
                if (candidates.size >= maxCandidates) {
                    droppedCandidates++
                    val noise = candidates.entries.firstOrNull {
                        !isV8Candidate(it.value.name, it.value.advertisesJcvitalService)
                    }
                    if (!isV8Candidate(name, advertisesJcvitalService) || noise == null) return
                    candidates.remove(noise.key)
                }
                Candidate(address.uppercase(Locale.US), clock(), scanSession).also { candidates[key] = it }
            }
            val wasCandidate = existing != null && isV8Candidate(existing.name, existing.advertisesJcvitalService)
            ElitePlusV8Advertisement.normalizedName(name)?.let { candidate.name = it }
            candidate.rssi = rssi
            if (serviceUuids.isNotEmpty()) candidate.serviceUuids = serviceUuids
            candidate.advertisesJcvitalService = candidate.advertisesJcvitalService || advertisesJcvitalService
            candidate.connectable = connectable
            candidate.lastSeenAt = clock()
            candidate.advertisementCount++
            candidate.acceptedByNativeFilter = candidate.acceptedByNativeFilter || accepted
            if (!candidate.acceptedByNativeFilter) candidate.rejectionReason = rejectionReason
            else candidate.rejectionReason = null
            firstCandidateMatch = !wasCandidate && isV8Candidate(candidate.name, candidate.advertisesJcvitalService)
        }
        if (firstAdvertisement) record("ADVERTISEMENT_RECEIVED", mapOf("address" to address, "name" to name,
            "rssi" to rssi, "serviceUuids" to serviceUuids, "acceptedByNativeFilter" to accepted,
            "rejectionReason" to rejectionReason))
        if (firstCandidateMatch) {
            record("V8_CANDIDATE_MATCHED", mapOf("address" to address, "name" to name,
                "advertisesJcvitalService" to advertisesJcvitalService, "acceptedByNativeFilter" to accepted,
                "rejectionReason" to rejectionReason))
            if (!accepted) record("V8_FILTERED", mapOf("address" to address, "reason" to rejectionReason))
        }
    }

    fun scanResultEmitted(address: String, jsListenerRegistered: Boolean) {
        if (!enabled) return
        var firstEmission = false
        synchronized(lock) {
            val candidate = candidates["$scanSession:${address.uppercase(Locale.US)}"] ?: return@synchronized
            firstEmission = candidate.emittedToJs == 0
            candidate.emittedToJs++
            if (jsListenerRegistered) candidate.emittedWithJsListener++
        }
        if (firstEmission) record("SCAN_RESULT_EMITTED_TO_JS", mapOf("address" to address,
            "jsListenerRegistered" to jsListenerRegistered))
    }

    fun snapshot(): Map<String, Any?> = synchronized(lock) {
        mapOf(
            "enabled" to enabled,
            "pluginLoadedAt" to pluginLoadedAt?.let(JCVitalV8Time::isoUtc),
            "scanRequestedCount" to scanRequested,
            "scanSession" to scanSession,
            "scanStartedAt" to scanStartedAt?.let(JCVitalV8Time::isoUtc),
            "scanActive" to scanActive,
            "scanCallbackRegistered" to scanCallbackRegistered,
            "advertisementsReceived" to advertisementsReceived,
            "lateAdvertisementsIgnored" to lateAdvertisementsIgnored,
            "droppedEvents" to droppedEvents,
            "droppedCandidates" to droppedCandidates,
            "candidates" to candidates.values.map { candidate ->
                mapOf(
                    "address" to candidate.address,
                    "name" to candidate.name,
                    "rssi" to candidate.rssi,
                    "serviceUuids" to candidate.serviceUuids,
                    "advertisesJcvitalService" to candidate.advertisesJcvitalService,
                    "connectable" to candidate.connectable,
                    "firstSeenAt" to JCVitalV8Time.isoUtc(candidate.firstSeenAt),
                    "lastSeenAt" to JCVitalV8Time.isoUtc(candidate.lastSeenAt),
                    "scanSession" to candidate.scanSession,
                    "advertisementCount" to candidate.advertisementCount,
                    "v8Candidate" to isV8Candidate(candidate.name, candidate.advertisesJcvitalService),
                    "acceptedByNativeFilter" to candidate.acceptedByNativeFilter,
                    "rejectionReason" to candidate.rejectionReason,
                    "emittedToJs" to candidate.emittedToJs,
                    "emittedWithJsListener" to candidate.emittedWithJsListener,
                )
            },
            "events" to events.map { event ->
                mapOf("sequence" to event.sequence, "at" to JCVitalV8Time.isoUtc(event.at),
                    "event" to event.event, "detail" to event.detail)
            },
        )
    }

    companion object {
        fun isV8Candidate(name: String?, advertisesJcvitalService: Boolean): Boolean =
            ElitePlusV8Advertisement.isElitePlusV8Advertisement(name, advertisesJcvitalService)
    }
}
