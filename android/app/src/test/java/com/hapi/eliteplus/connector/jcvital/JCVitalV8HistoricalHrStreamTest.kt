package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.text.SimpleDateFormat
import java.util.Locale
import java.util.TimeZone

class JCVitalV8HistoricalHrStreamTest {
    private val normalizer = JCVitalV8EventNormalizer()
    private val ctx = JCVitalV8EventNormalizer.Context(
        deviceId = "D6:AE:FB:AE:33:CC",
        firmwareVersion = "0.0.3.4",
        sessionId = "sync-1",
        receiptMillis = 1_790_000_000_000L,
        timezone = "UTC",
    )
    private val vendorDate = SimpleDateFormat("yyyy.MM.dd HH:mm:ss", Locale.US).apply { timeZone = TimeZone.getTimeZone("UTC") }
    private val chunkSize = JCVitalV8HistoricalHrStream.DEFAULT_CHUNK_SIZE

    /** Repeated BPM runs plus periodic zero (no-measurement) samples. */
    private fun bpm(index: Int): Int = if (index % 97 == 13) 0 else 60 + (index / 3) % 40

    /**
     * Vendor packets as produced by the SDK: 15 samples per record (75 s), 10 records per packet. [newestFirst] matches
     * the physical V8 (records newest-to-oldest, samples ascending inside each record); [gapEveryRecords] inserts a
     * 3-minute gap between records like real monitoring pauses.
     */
    private fun packets(samples: Int, newestFirst: Boolean = false, gapEveryRecords: Int = 0): List<Map<String?, Any?>> {
        var start = 1_700_000_000_000L
        val records = (0 until samples step 15).mapIndexed { recordIndex, first ->
            if (gapEveryRecords > 0 && recordIndex > 0 && recordIndex % gapEveryRecords == 0) start += 180_000L
            val record = mapOf(
                DeviceKey.Date to vendorDate.format(start),
                DeviceKey.ArrayDynamicHR to (first until minOf(first + 15, samples)).joinToString(" ") { bpm(it).toString() },
            )
            start += 75_000L
            record
        }
        val ordered = if (newestFirst) records.reversed() else records
        val groups = ordered.chunked(10)
        return groups.mapIndexed { index, group ->
            mapOf(DeviceKey.DataType to BleConst.GetDynamicHR, DeviceKey.End to (index == groups.lastIndex), DeviceKey.Data to group)
        }
    }

    private class Run(val stream: JCVitalV8HistoricalHrStream, val chunks: List<Map<String, Any?>>, val packetsAccepted: Int) {
        @Suppress("UNCHECKED_CAST")
        val observations get() = chunks.flatMap { it["observations"] as List<Map<String, Any?>> }
    }

    /**
     * Records whose 75 s span overlaps the next record's start: every [overlapEveryRecords]th record begins only
     * [overlapStartDeltaMs] after the previous one (instead of the normal 75,000 ms), reproducing the physical
     * Build 5B-1 full-scale defect (sorting by record start alone is not sufficient for sample-level order).
     */
    private fun overlappingPackets(recordCount: Int, overlapEveryRecords: Int, overlapStartDeltaMs: Long): List<Map<String?, Any?>> {
        var start = 1_700_000_000_000L
        var sampleCursor = 0
        val records = (0 until recordCount).map { recordIndex ->
            if (recordIndex > 0) start += if (recordIndex % overlapEveryRecords == 0) overlapStartDeltaMs else 75_000L
            val record = mapOf(
                DeviceKey.Date to vendorDate.format(start),
                DeviceKey.ArrayDynamicHR to (0 until 15).joinToString(" ") { bpm(sampleCursor + it).toString() },
            )
            sampleCursor += 15
            record
        }
        val groups = records.chunked(10)
        return groups.mapIndexed { index, group ->
            mapOf(DeviceKey.DataType to BleConst.GetDynamicHR, DeviceKey.End to (index == groups.lastIndex), DeviceKey.Data to group)
        }
    }

    private fun overlappingStream(recordCount: Int, overlapEveryRecords: Int, overlapStartDeltaMs: Long): Run {
        val chunks = mutableListOf<Map<String, Any?>>()
        val stream = JCVitalV8HistoricalHrStream("sync-1", null, normalizer, { chunks += it })
        var accepted = 0
        for (packet in overlappingPackets(recordCount, overlapEveryRecords, overlapStartDeltaMs)) {
            accepted++
            if (!stream.acceptPacket(packet, ctx)) break
        }
        stream.completeAcquisition()
        while (stream.emitNextChunk()) Unit
        return Run(stream, chunks, accepted)
    }

    private fun stream(
        samples: Int,
        maxValid: Int? = null,
        newestFirst: Boolean = false,
        gapEveryRecords: Int = 0,
        keepChunks: Boolean = true,
        onChunk: (Map<String, Any?>) -> Unit = {},
    ): Run {
        val chunks = mutableListOf<Map<String, Any?>>()
        val stream = JCVitalV8HistoricalHrStream("sync-1", maxValid, normalizer, { chunk ->
            onChunk(chunk)
            if (keepChunks) chunks += chunk
        })
        var accepted = 0
        for (packet in packets(samples, newestFirst, gapEveryRecords)) {
            accepted++
            if (!stream.acceptPacket(packet, ctx)) break
        }
        stream.completeAcquisition()
        while (stream.emitNextChunk()) Unit
        return Run(stream, chunks, accepted)
    }

    /** Pre-streaming path: normalize() every packet in vendor order; (id, value, observedAt, sequence) per observation. */
    private fun legacy(samples: Int, newestFirst: Boolean = false, gapEveryRecords: Int = 0): List<List<Any?>> =
        packets(samples, newestFirst, gapEveryRecords).flatMap { packet ->
            normalizer.normalize(packet, ctx).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.map {
                listOf(it.payload["id"], it.payload["value"], it.payload["observedAt"], it.payload["sequenceNumber"])
            }
        }

    private fun fingerprint(observation: Map<String, Any?>) =
        listOf(observation["id"], observation["value"], observation["observedAt"], observation["sequenceNumber"])

    private fun intervalsSeconds(observations: List<Map<String, Any?>>): List<Long> {
        val times = observations.map { java.time.Instant.parse(it["observedAt"] as String).toEpochMilli() }
        return times.zipWithNext { a, b -> (b - a) / 1000 }
    }

    @Test
    fun fullSyncAtScaleStreamsEveryObservationInBoundedChunks() {
        for (samples in listOf(300, 1_300, 17_280, 34_560)) {
            val run = stream(samples)
            val observations = run.observations

            assertTrue("chunk > max at $samples", run.chunks.all { (it["sampleCount"] as Int) <= chunkSize })
            assertTrue("multiple chunks at $samples", samples <= chunkSize || run.chunks.size > 1)
            assertEquals(samples / chunkSize + 1, run.chunks.size)
            assertEquals(true, run.chunks.last()["isFinal"])
            assertTrue(run.chunks.dropLast(1).none { it["isFinal"] == true })
            assertEquals(run.chunks.indices.toList(), run.chunks.map { it["chunkIndex"] })
            assertEquals(samples, observations.size)
            assertEquals(samples, run.stream.emittedSampleCount)
            assertTrue("O(chunk) retention at $samples", run.stream.maxPendingCount <= chunkSize)

            // IDs, values (incl. repeated BPM and zero placeholders), timestamps and sequence numbers are unchanged.
            assertEquals(legacy(samples), observations.map(::fingerprint))
            assertEquals((0 until samples).map(::bpm), observations.map { it["value"] })
            val times = observations.map { it["observedAt"] as String }
            assertEquals(times.sorted(), times)
            assertEquals(times.first(), run.stream.earliestObservation)
            assertEquals(times.last(), run.stream.latestObservation)
            assertTrue(observations.any { it["value"] == 0 })
        }
    }

    @Test
    fun physicalNewestFirstRecordsAreEmittedChronologically() {
        // Physical V8: record A newer than record B arrives first, samples ascending inside each record.
        for (samples in listOf(1_300, 34_560)) {
            val legacyOrder = legacy(samples, newestFirst = true, gapEveryRecords = 4)
            val legacyIntervals = legacyOrder.map { java.time.Instant.parse(it[2] as String).toEpochMilli() }.zipWithNext { a, b -> (b - a) / 1000 }
            assertTrue("fixture reproduces negative intervals", legacyIntervals.any { it < 0 })

            val run = stream(samples, newestFirst = true, gapEveryRecords = 4)
            val observations = run.observations
            val intervals = intervalsSeconds(observations)

            assertEquals("NEWEST_FIRST", run.stream.vendorOrder())
            assertEquals(0, run.stream.outOfOrderEmitted)
            assertTrue(intervals.all { it >= 0 })
            assertEquals(5L, intervals.groupingBy { it }.eachCount().maxByOrNull { it.value }!!.key)
            assertTrue(intervals.all { it == 5L || it == 185L })
            // Same observations (IDs, values, timestamps, sequence numbers); only the order changed.
            assertEquals(legacyOrder.sortedBy { it[2] as String }, observations.map(::fingerprint))
            assertTrue(run.chunks.all { (it["sampleCount"] as Int) <= chunkSize })
            assertEquals(samples / chunkSize + 1, run.chunks.size)
        }
    }

    @Test
    fun rawVendorPacketIsNeverDuplicatedPerSample() {
        val observations = stream(1_300).observations
        observations.forEach { observation ->
            val raw = observation["rawPayload"]
            if (observation["sequenceNumber"] == 0) {
                assertEquals(setOf("record"), (raw as Map<*, *>).keys)
            } else {
                assertNull(raw)
            }
        }
        // One raw record per 15-sample source record, never the packet envelope.
        assertEquals((1_300 + 14) / 15, observations.count { it["rawPayload"] != null })
    }

    @Test
    fun safeTestBridgesOnlyTheFirstValidSamplesAndStopsExpanding() {
        for (newestFirst in listOf(false, true)) {
            for (samples in listOf(300, 1_300, 17_280, 34_560)) {
                val run = stream(samples, maxValid = 300, newestFirst = newestFirst)
                val observations = run.observations
                val expectedValid = (0 until samples).map(::bpm).count { it in 1..250 }.coerceAtMost(300)

                assertTrue(observations.size <= 300)
                assertEquals(expectedValid, observations.size)
                assertTrue(observations.all { JCVitalV8HistoricalHrStream.isValidSample(it) })
                assertTrue(run.chunks.all { (it["sampleCount"] as Int) <= chunkSize })
                // Same selection as before (first valid samples in vendor order), now emitted chronologically.
                val selected = legacy(samples, newestFirst).filter { (it[1] as Int) in 1..250 }.take(300)
                assertEquals(selected.sortedBy { it[2] as String }, observations.map(::fingerprint))
                assertEquals(0, run.stream.outOfOrderEmitted)
                if (samples > 1_300) {
                    assertTrue(run.stream.limitReached)
                    assertTrue("packets read ${run.packetsAccepted}", run.packetsAccepted <= 3)
                    assertTrue(run.stream.expandedSampleCount < 320)
                    assertTrue(run.stream.vendorRecordCount <= 22)
                }
            }
        }
    }

    @Test
    fun physicalShapedBoundedTestMatchesCounters() {
        // 1,300 valid from a newest-first history: 6 chunks (5 × 250 + 50) plus skipped zero placeholders.
        val run = stream(34_560, maxValid = 1_300, newestFirst = true, gapEveryRecords = 4)
        assertEquals(1_300, run.stream.emittedSampleCount)
        assertEquals(6, run.stream.chunkCount)
        assertEquals(250, run.stream.largestChunkCount)
        assertTrue(run.stream.skippedNoMeasurementCount > 0)
        assertEquals(0, run.stream.outOfOrderEmitted)
        assertTrue(intervalsSeconds(run.observations).all { it >= 0 })
    }

    /**
     * Build 5B-1 full-scale physical regression: 2,482 records (37,230 samples, matching the physical acquisition
     * exactly) with one record every 149th starting only 45 s after the previous one instead of the normal 75 s.
     * The preceding record's span ends at +70 s, so the pre-fix (sort-by-record-start, then flatten per record)
     * behavior emits that overlapping record's first sample 25 s *before* the previous sample: exactly the
     * minimumIntervalSeconds = -25 / outOfOrderTimestamps = 1 observed physically. The bounded merge must emit
     * every sample chronologically (ties allowed) without ever reordering or dropping legitimate observations.
     */
    @Test
    fun overlappingSourceRecordsAtFullScaleReproduceAndFixTheNegative25SecondBoundary() {
        val recordCount = 2_482
        val overlapEveryRecords = 149
        val overlapStartDeltaMs = 45_000L
        check((overlapStartDeltaMs - 70_000L) / 1000 == -25L) { "fixture must reproduce exactly a -25s boundary" }

        val run = overlappingStream(recordCount, overlapEveryRecords, overlapStartDeltaMs)
        val observations = run.observations
        val intervals = intervalsSeconds(observations)

        assertEquals(recordCount * 15, run.stream.emittedSampleCount)
        assertEquals(recordCount, run.stream.bufferedRecordCount)
        assertEquals(0, run.stream.outOfOrderEmitted)
        assertTrue("minimum interval was ${intervals.min()}s", intervals.all { it >= 0 })
        // No legitimate observation is lost or merged away merely because its timestamp ties with another record's.
        assertEquals(recordCount * 15, observations.size)
        assertEquals(recordCount * 15, observations.map { it["id"] }.distinct().size)
        assertEquals(0, run.stream.duplicateCount)
        // Values, timestamps and sequence numbers for every observation are unchanged by the merge.
        assertEquals((0 until recordCount * 15).map(::bpm).sorted(), observations.map { it["value"] as Int }.sorted())
    }

    @Test
    fun retainedMemoryIsRecordsPlusOneChunk() {
        val run = stream(34_560, keepChunks = false)
        assertEquals(34_560 / 15, run.stream.bufferedRecordCount)
        assertTrue(run.stream.maxPendingCount <= chunkSize)
    }

    @Test
    fun largestChunkSizeIsIndependentOfHistoryLength() {
        val small = stream(17_280, keepChunks = false).stream
        val large = stream(34_560, keepChunks = false).stream
        assertEquals(small.largestChunkCount, large.largestChunkCount)
        assertTrue(large.largestChunkBytes <= small.largestChunkBytes * 1.05)
        assertTrue("chunk bytes ${large.largestChunkBytes}", large.largestChunkBytes < 400_000)
    }

    @Test
    fun repeatedPacketIsDeduplicatedNotReEmitted() {
        val stream = JCVitalV8HistoricalHrStream("sync-1", null, normalizer, {})
        val packet = packets(150).single()
        stream.acceptPacket(packet, ctx)
        stream.acceptPacket(packet, ctx)
        stream.completeAcquisition()
        while (stream.emitNextChunk()) Unit
        assertEquals(150, stream.emittedSampleCount)
        assertEquals(150, stream.duplicateCount)
    }

    @Test
    fun emptyHistoryEmitsSingleEmptyFinalChunk() {
        val chunks = mutableListOf<Map<String, Any?>>()
        val stream = JCVitalV8HistoricalHrStream("sync-1", null, normalizer, { chunks += it })
        stream.acceptPacket(mapOf(DeviceKey.DataType to BleConst.GetDynamicHR, DeviceKey.End to true, DeviceKey.Data to emptyList<Any?>()), ctx)
        stream.completeAcquisition()
        assertFalse(stream.emitNextChunk())
        assertEquals(1, chunks.size)
        assertEquals(0, chunks.single()["sampleCount"])
        assertEquals(true, chunks.single()["isFinal"])
    }

    @Test
    fun abortStopsEmission() {
        val chunks = mutableListOf<Map<String, Any?>>()
        val stream = JCVitalV8HistoricalHrStream("sync-1", null, normalizer, { chunks += it })
        packets(1_300).forEach { stream.acceptPacket(it, ctx) }
        stream.completeAcquisition()
        stream.emitNextChunk()
        stream.abort("JS_ACK_TIMEOUT")
        assertFalse(stream.emitNextChunk())
        assertEquals(1, chunks.size)
        assertEquals(false, stream.stats()["finalEmitted"])
    }

    @Test
    fun malformedDataIsBoundedParseError() {
        val stream = JCVitalV8HistoricalHrStream("sync-1", null, normalizer, {})
        stream.acceptPacket(mapOf(DeviceKey.DataType to BleConst.GetDynamicHR, DeviceKey.Data to "bogus"), ctx)
        stream.acceptPacket(mapOf(DeviceKey.DataType to BleConst.GetDynamicHR, DeviceKey.Data to listOf("not an object")), ctx)
        stream.completeAcquisition()
        while (stream.emitNextChunk()) Unit
        assertEquals(2, stream.parseErrorCount)
        assertEquals(0, stream.emittedSampleCount)
    }

    @Test
    fun breadcrumbsCarryOnlyBoundedNumbers() {
        val crumbs = mutableListOf<Pair<String, Map<String, Any?>>>()
        val stream = JCVitalV8HistoricalHrStream("sync-1", 300, normalizer, {}, { stage, detail -> crumbs += stage to detail })
        for (packet in packets(1_300, newestFirst = true)) if (!stream.acceptPacket(packet, ctx)) break
        stream.completeAcquisition()
        while (stream.emitNextChunk()) Unit
        val stages = crumbs.map { it.first }
        assertEquals("NATIVE_HR_CALLBACK_RECEIVED", stages.first())
        assertTrue(stages.containsAll(listOf("NATIVE_HR_VENDOR_RECORD_COUNT", "NATIVE_HR_RECORDS_ORDERED", "NATIVE_HR_EXPANSION_STARTED", "NATIVE_HR_CHUNK_READY_0", "NATIVE_HR_CHUNK_EMITTED_0")))
        assertEquals("NATIVE_HR_SYNC_COMPLETE", stages.last())
        assertTrue(crumbs.all { (_, detail) -> detail.values.all { it == null || it is Number || it is Boolean || (it is String && it.length < 64) } })
        val complete = crumbs.last().second
        assertTrue((complete["largestChunkCount"] as Int) <= 250)
        assertTrue((complete["estimatedSerializedChunkBytes"] as Long) > 0)
        assertEquals("NEWEST_FIRST", complete["vendorRecordOrder"])
    }

    @Test
    fun reportsFormerAndBoundedSerializedSizes() {
        for (samples in listOf(300, 1_300, 17_280, 34_560)) {
            var legacyBytes = 0L
            packets(samples).forEach { packet ->
                normalizer.normalize(packet, ctx).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.forEach { event ->
                    legacyBytes += JCVitalV8JsonSize.estimate(event.payload)
                }
            }
            var streamedBytes = 0L
            val run = stream(samples, keepChunks = false) { streamedBytes += it["estimatedSerializedBytes"] as Long }
            assertTrue("streamed $streamedBytes vs legacy $legacyBytes", streamedBytes * 2 < legacyBytes)
            assertFalse(run.stream.largestChunkBytes > 400_000)
        }
    }
}
