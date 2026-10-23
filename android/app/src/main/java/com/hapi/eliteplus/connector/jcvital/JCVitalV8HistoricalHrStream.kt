package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import java.util.PriorityQueue

/**
 * Streams historical continuous HR (vendor type 27) to JS chronologically in bounded chunks.
 *
 * Acquisition buffers only compact source records (date + 15-value string, ~O(records)); the V8 sends them
 * newest-to-oldest, so they are sorted by record start once acquisition ends and only then expanded lazily into
 * ≤[chunkSize]-sample chunks pulled one at a time via [emitNextChunk]. With a Safe Test limit, acquisition stops once
 * [maxValidSamples] valid samples were selected (in vendor order), and only those samples are expanded and bridged.
 *
 * Sorting source records by start time is not sufficient for sample-level chronological emission: one record's
 * 75 s span can overlap the next record's start. Expansion therefore uses a bounded k-way merge: only source
 * records whose start falls within (or before) the earliest sample currently pending emission are expanded at
 * once, each contributing one "active cursor" to a small min-heap ordered by next sample time. Memory stays
 * bounded by the number of concurrently overlapping records (typically a handful), never the full history.
 * Not thread-safe: the manager drives it from the main looper.
 */
class JCVitalV8HistoricalHrStream(
    val syncSessionId: String,
    val maxValidSamples: Int?,
    private val normalizer: JCVitalV8EventNormalizer,
    private val emitChunk: (Map<String, Any?>) -> Unit,
    private val breadcrumb: (String, Map<String, Any?>) -> Unit = { _, _ -> },
    val chunkSize: Int = DEFAULT_CHUNK_SIZE,
) {
    init {
        require(chunkSize > 0) { "chunkSize must be positive" }
        require(maxValidSamples == null || maxValidSamples > 0) { "maxValidSamples must be positive" }
    }

    private class SourceRecord(
        val record: Map<String, Any?>,
        val startMillis: Long?,
        val arrival: Int,
        val ctx: JCVitalV8EventNormalizer.Context,
        val receipt: String,
        /** Safe Test: number of valid samples selected from this record; null = all samples. */
        val take: Int?,
    )

    var packetCount = 0
        private set
    var vendorRecordCount = 0
        private set
    var bufferedRecordCount = 0
        private set
    var plannedSampleCount = 0
        private set
    var expandedSampleCount = 0
        private set
    var emittedSampleCount = 0
        private set
    var validSampleCount = 0
        private set
    var skippedNoMeasurementCount = 0
        private set
    var duplicateCount = 0
        private set
    var chunkCount = 0
        private set
    var largestChunkCount = 0
        private set
    var largestChunkBytes = 0L
        private set
    var maxPendingCount = 0
        private set
    var parseErrorCount = 0
        private set
    var vendorAscendingTransitions = 0
        private set
    var vendorDescendingTransitions = 0
        private set
    var vendorEqualTransitions = 0
        private set
    var outOfOrderEmitted = 0
        private set
    var earliestObservation: String? = null
        private set
    var latestObservation: String? = null
        private set
    var acquisitionComplete = false
        private set
    var finished = false
        private set
    var finalEmitted = false
        private set
    val parseErrors = ArrayList<Map<String, Any?>>()

    private var selectedValidCount = 0
    val limitReached: Boolean get() = maxValidSamples != null && selectedValidCount >= maxValidSamples

    private var records = ArrayList<SourceRecord?>()
    private val recordKeys = HashSet<String>()
    private var previousArrivalStart: Long? = null
    // IDs only (no payloads): keeps the pre-streaming per-sample dedup semantics.
    private val seenIds = HashSet<String>()
    private var recordIndex = 0
    /** Bounded min-heap of records currently being merged by next-sample time (see class doc). */
    private val activeCursors = PriorityQueue<ActiveCursor>(compareBy<ActiveCursor> { it.currentMillis }.thenBy { it.source.arrival })
    private var lastEmittedObservedAt: String? = null

    /** One source record's expansion cursor while it participates in the chronological merge. */
    private class ActiveCursor(
        val source: SourceRecord,
        val iterator: Iterator<Map<String, Any?>>,
        val intervalMs: Long,
        val takeLimit: Int?,
        var takenValid: Int,
        var current: Map<String, Any?>,
        var index: Int,
        /** Null (undated) cursors sort after every dated cursor via Long.MAX_VALUE. */
        val baseMillis: Long?,
    ) {
        val currentMillis: Long get() = baseMillis?.let { it + index.toLong() * intervalMs } ?: Long.MAX_VALUE
    }

    /** Returns false once the Safe Test limit is reached; the caller must stop requesting further history. */
    fun acceptPacket(vendor: Map<*, *>, ctx: JCVitalV8EventNormalizer.Context): Boolean {
        check(!acquisitionComplete) { "acquisition already complete" }
        if (limitReached) return false
        packetCount++
        if (packetCount == 1) breadcrumb("NATIVE_HR_CALLBACK_RECEIVED", mapOf("safeTestLimit" to maxValidSamples))
        val receipt = JCVitalV8Time.isoUtc(ctx.receiptMillis)
        val data = when (val raw = vendor[DeviceKey.Data]) {
            is List<*> -> raw
            null -> emptyList<Any?>()
            else -> {
                addParseError("Historical data is not an array", raw, receipt)
                return true
            }
        }
        for ((recordIndex, raw) in data.withIndex()) {
            if (limitReached) break
            vendorRecordCount++
            @Suppress("UNCHECKED_CAST")
            val record = JCVitalV8EventNormalizer.sanitize(raw) as? Map<String, Any?>
            if (record == null) {
                addParseError("Historical record is not an object", raw, receipt)
                continue
            }
            val values = normalizer.continuousHeartRateValues(record)
            val start = normalizer.vendorRecordStartMillis(record, ctx.timezone)
            trackVendorOrder(start)
            // An identical record (same date and values) can only yield already-seen observation IDs.
            if (!recordKeys.add("${record[DeviceKey.Date]}|${record[DeviceKey.ArrayDynamicHR]}")) {
                duplicateCount += values.size
                continue
            }
            val take = maxValidSamples?.let { limit ->
                val valid = if (start == null) 0 else values.count { it in 1..MAX_VALID_BPM }
                minOf(valid, limit - selectedValidCount).also { selectedValidCount += it }
            }
            if (take == 0) continue
            plannedSampleCount += take ?: values.size
            val recordContext = if (ctx.sourceRecordEnvelopeIds.isEmpty()) ctx else ctx.copy(
                sourceEnvelopeId = ctx.sourceRecordEnvelopeIds.getOrNull(recordIndex),
            )
            records.add(SourceRecord(record, start, vendorRecordCount, recordContext, receipt, take))
            bufferedRecordCount++
        }
        return !limitReached
    }

    /** Ends acquisition and orders buffered source records chronologically (stable; undated records last). */
    fun completeAcquisition() {
        if (acquisitionComplete) return
        acquisitionComplete = true
        records = ArrayList(records.sortedWith(compareBy(nullsLast()) { it?.startMillis }))
        recordKeys.clear()
        breadcrumb("NATIVE_HR_VENDOR_RECORD_COUNT", mapOf("vendorRecordCount" to vendorRecordCount, "packets" to packetCount, "bufferedRecords" to bufferedRecordCount))
        breadcrumb(
            "NATIVE_HR_RECORDS_ORDERED",
            mapOf(
                "vendorAscending" to vendorAscendingTransitions,
                "vendorDescending" to vendorDescendingTransitions,
                "vendorEqual" to vendorEqualTransitions,
                "plannedSamples" to plannedSampleCount,
            ),
        )
        breadcrumb("NATIVE_HR_EXPANSION_STARTED", mapOf("chunkSize" to chunkSize))
    }

    /** Expands and emits the next ≤chunkSize chunk; returns true while more chunks follow. */
    fun emitNextChunk(): Boolean {
        check(acquisitionComplete) { "acquisition not complete" }
        if (finished) return false
        val observations = ArrayList<Map<String, Any?>>(minOf(chunkSize, maxOf(1, plannedSampleCount)))
        while (observations.size < chunkSize) {
            val sample = nextSample() ?: break
            observations.add(sample)
            track(sample)
            if (observations.size > maxPendingCount) maxPendingCount = observations.size
        }
        val isFinal = !hasMoreSamples()
        flush(observations, isFinal)
        if (isFinal) {
            finished = true
            finalEmitted = true
            breadcrumb("NATIVE_HR_SYNC_COMPLETE", stats())
        }
        return !isFinal
    }

    /** Stops without emitting further chunks (disconnect or JS acknowledgement timeout). */
    fun abort(reason: String) {
        if (finished) return
        finished = true
        records = ArrayList()
        activeCursors.clear()
        breadcrumb("NATIVE_HR_SYNC_ABORTED", mapOf("reason" to reason, "emitted" to emittedSampleCount, "chunks" to chunkCount))
    }

    fun stats(): Map<String, Any?> = linkedMapOf(
        "syncSessionId" to syncSessionId,
        "chunkSize" to chunkSize,
        "safeTestLimit" to maxValidSamples,
        "safeTestLimitReached" to limitReached,
        "packetCount" to packetCount,
        "vendorRecordCount" to vendorRecordCount,
        "bufferedRecordCount" to bufferedRecordCount,
        "vendorRecordOrder" to vendorOrder(),
        "vendorAscendingTransitions" to vendorAscendingTransitions,
        "vendorDescendingTransitions" to vendorDescendingTransitions,
        "emittedOrder" to "CHRONOLOGICAL_BY_RECORD_START",
        "outOfOrderEmitted" to outOfOrderEmitted,
        "plannedSampleCount" to plannedSampleCount,
        "expandedSampleCount" to expandedSampleCount,
        "emittedSampleCount" to emittedSampleCount,
        "validSampleCount" to validSampleCount,
        "skippedNoMeasurementCount" to skippedNoMeasurementCount,
        "duplicateCount" to duplicateCount,
        "chunkCount" to chunkCount,
        "largestChunkCount" to largestChunkCount,
        "estimatedSerializedChunkBytes" to largestChunkBytes,
        "parseErrorCount" to parseErrorCount,
        "finalEmitted" to finalEmitted,
    )

    fun vendorOrder(): String = when {
        vendorAscendingTransitions == 0 && vendorDescendingTransitions == 0 -> "UNKNOWN"
        vendorDescendingTransitions == 0 -> "OLDEST_FIRST"
        vendorAscendingTransitions == 0 -> "NEWEST_FIRST"
        else -> "MIXED"
    }

    private fun trackVendorOrder(start: Long?) {
        val previous = previousArrivalStart
        if (start != null && previous != null) {
            when {
                start > previous -> vendorAscendingTransitions++
                start < previous -> vendorDescendingTransitions++
                else -> vendorEqualTransitions++
            }
        }
        if (start != null) previousArrivalStart = start
    }

    private fun hasMoreSamples(): Boolean = activeCursors.isNotEmpty() || recordIndex < records.size

    /** Opens any buffered records that could contribute a sample no later than the current merge frontier. */
    private fun admitReadyRecords() {
        while (recordIndex < records.size) {
            val candidate = records[recordIndex] ?: break
            val heapMinMillis = activeCursors.peek()?.currentMillis
            val effectiveStart = candidate.startMillis ?: Long.MAX_VALUE
            if (heapMinMillis != null && effectiveStart > heapMinMillis) break
            records[recordIndex] = null
            recordIndex++
            openCursor(candidate)?.let { activeCursors.add(it) }
        }
    }

    private fun openCursor(source: SourceRecord): ActiveCursor? {
        val iterator = normalizer.continuousHeartRateSamples(source.record, source.ctx, source.receipt).iterator()
        if (!iterator.hasNext()) return null
        val first = iterator.next()
        val intervalMs = (first["samplingIntervalMs"] as? Number)?.toLong() ?: DEFAULT_SAMPLE_INTERVAL_MS
        return ActiveCursor(source, iterator, intervalMs, source.take, takenValid = 0, current = first, index = 0, baseMillis = source.startMillis)
    }

    /** Applies the existing no-measurement/dedup/Safe-Test filters to one candidate sample. */
    private fun considerCandidate(cursor: ActiveCursor, sample: Map<String, Any?>): Boolean {
        expandedSampleCount++
        val valid = isValidSample(sample)
        if (maxValidSamples != null && !valid) {
            skippedNoMeasurementCount++
            return false
        }
        if (!seenIds.add(sample["id"] as String)) {
            duplicateCount++
            return false
        }
        if (valid) validSampleCount++
        if (cursor.takeLimit != null) cursor.takenValid++
        return true
    }

    /** Pulls the cursor's next sample and requeues it, unless its Safe Test allotment or source data is exhausted. */
    private fun pullNext(cursor: ActiveCursor) {
        if (cursor.takeLimit != null && cursor.takenValid >= cursor.takeLimit) return
        if (!cursor.iterator.hasNext()) return
        cursor.current = cursor.iterator.next()
        cursor.index++
        activeCursors.add(cursor)
    }

    /**
     * Bounded k-way merge: only records whose start is at or before the earliest sample currently pending are
     * opened (see [admitReadyRecords]), so the heap only ever holds the handful of records whose spans overlap.
     */
    private fun nextSample(): Map<String, Any?>? {
        while (true) {
            admitReadyRecords()
            val cursor = activeCursors.poll() ?: return null
            val sample = cursor.current
            val accepted = considerCandidate(cursor, sample)
            pullNext(cursor)
            if (accepted) return sample
        }
    }

    private fun track(sample: Map<String, Any?>) {
        emittedSampleCount++
        val observedAt = sample["observedAt"] as? String ?: return
        lastEmittedObservedAt?.let { if (observedAt < it) outOfOrderEmitted++ }
        lastEmittedObservedAt = observedAt
        if (earliestObservation == null || observedAt < earliestObservation!!) earliestObservation = observedAt
        if (latestObservation == null || observedAt > latestObservation!!) latestObservation = observedAt
    }

    private fun flush(observations: List<Map<String, Any?>>, isFinal: Boolean) {
        val index = chunkCount
        val chunk = linkedMapOf<String, Any?>(
            "syncSessionId" to syncSessionId,
            "chunkIndex" to index,
            "isFinal" to isFinal,
            "vendorDataType" to BleConst.GetDynamicHR,
            "safeTestLimit" to maxValidSamples,
            "sourceRecordCount" to bufferedRecordCount,
            "plannedSampleCount" to plannedSampleCount,
            "sampleCount" to observations.size,
            "emittedSampleCountTotal" to emittedSampleCount,
            "observations" to observations,
            "sourceEnvelopeIds" to observations.mapNotNull {
                (it["provenance"] as? Map<*, *>)?.get("sourceEnvelopeId") as? String
            }.distinct(),
        )
        val bytes = JCVitalV8JsonSize.estimate(chunk)
        chunk["estimatedSerializedBytes"] = bytes
        chunkCount++
        if (observations.size > largestChunkCount) largestChunkCount = observations.size
        if (bytes > largestChunkBytes) largestChunkBytes = bytes
        breadcrumb("NATIVE_HR_CHUNK_READY_$index", mapOf("sampleCount" to observations.size, "estimatedSerializedChunkBytes" to bytes))
        emitChunk(chunk)
        breadcrumb("NATIVE_HR_CHUNK_EMITTED_$index", mapOf("sampleCount" to observations.size, "isFinal" to isFinal))
    }

    private fun addParseError(message: String, raw: Any?, receipt: String) {
        parseErrorCount++
        if (parseErrors.size < MAX_PARSE_ERRORS) parseErrors += normalizer.parseError(BleConst.GetDynamicHR, message, raw, receipt)
    }

    companion object {
        const val DEFAULT_CHUNK_SIZE = 250
        const val MAX_PARSE_ERRORS = 20
        private const val MAX_VALID_BPM = 250
        /** Fallback only; continuous HR samples always carry their own samplingIntervalMs. */
        private const val DEFAULT_SAMPLE_INTERVAL_MS = 5_000L

        /** Mirrors the JS heartRateHistory contract: integer 1..250 bpm with a parseable record time. */
        fun isValidSample(sample: Map<String, Any?>): Boolean {
            val value = sample["value"] as? Int ?: return false
            return value in 1..MAX_VALID_BPM && sample["observedAt"] != null
        }
    }
}

/** Cheap JSON byte-size estimate (ASCII payloads) without serializing. */
object JCVitalV8JsonSize {
    fun estimate(value: Any?): Long = when (value) {
        null -> 4L
        is String -> value.length + 2L
        is Boolean -> if (value) 4L else 5L
        is Number -> value.toString().length.toLong()
        is Map<*, *> -> 2L + value.entries.sumOf { (key, item) -> key.toString().length + 3L + estimate(item) } + maxOf(0, value.size - 1)
        is Iterable<*> -> {
            var count = 0
            var total = 2L
            for (item in value) {
                total += estimate(item)
                count++
            }
            total + maxOf(0, count - 1)
        }
        else -> value.toString().length + 2L
    }
}
