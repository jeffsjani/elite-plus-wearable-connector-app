package com.hapi.eliteplus.connector.jcvital

internal data class RawSignalChunk(
    val sessionId: String,
    val sequenceNumber: Long,
    val receivedAtStart: String,
    val receivedAtEnd: String,
    val packets: List<Map<String, Any?>>,
    val packetCount: Int,
    val bytesReceived: Int,
    val decodedSampleCount: Int,
    val estimatedBytes: Int,
) {
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "signalType" to RawPpgSession.SIGNAL_TYPE,
        "sessionId" to sessionId,
        "sequenceNumber" to sequenceNumber,
        "receivedAtStart" to receivedAtStart,
        "receivedAtEnd" to receivedAtEnd,
        "sampleRateHz" to null,
        "sampleIntervalMs" to null,
        "unit" to RawPpgSession.UNKNOWN_UNIT,
        "packets" to packets,
        "packetCount" to packetCount,
        "bytesReceived" to bytesReceived,
        "decodedSampleCount" to decodedSampleCount,
        "estimatedBytes" to estimatedBytes,
    )
}
    internal data class RawPpgChunkFlush(
        val liveSummary: Map<String, Any?>,
        val rawPackets: List<ByteArray>,
    )

    internal data class RawPpgNotificationCapture(
        val sequenceNumber: Long?,
        val completedChunk: RawPpgChunkFlush?,
    )

internal class RawPpgSession(
    val sessionId: String,
    val deviceId: String?,
    val firmwareVersion: String?,
    val startedAt: String,
    private val source: Map<String, Any?>,
) {
    private data class Packet(
        val sequenceNumber: Long,
        val receivedAt: String,
        val originalBytes: ByteArray,
        val parserOutputs: MutableList<Map<String, Any?>> = mutableListOf(),
        var decodedSampleCount: Int = 0,
        var minimumRawDecodedValue: Int? = null,
        var maximumRawDecodedValue: Int? = null,
        var estimatedBytes: Int = 0,
    )

    private data class LayoutDiagnostics(
        var packetCount: Int = 0,
        var decodedSampleCount: Int = 0,
        var minimumRawDecodedValue: Int? = null,
        var maximumRawDecodedValue: Int? = null,
    ) {
        fun toMap() = linkedMapOf<String, Any?>(
            "packetCount" to packetCount,
            "decodedSampleCount" to decodedSampleCount,
            "minimumRawDecodedValue" to minimumRawDecodedValue,
            "maximumRawDecodedValue" to maximumRawDecodedValue,
        )
    }

    var status: String = STATUS_IDLE
        private set
    var stoppedAt: String? = null
        private set
    var packetCount: Long = 0
        private set
    var chunkCount: Long = 0
        private set
    var bytesReceived: Long = 0
        private set
    var bufferHighWaterMark: Int = 0
        private set
    var parseErrorCount: Long = 0
        private set
    var vendorDataType119Count: Long = 0
        private set
    var decodedSampleCount: Long = 0
        private set
    var firstPacketAt: String? = null
        private set
    var lastPacketAt: String? = null
        private set
    var minimumRawDecodedValue: Int? = null
        private set
    var maximumRawDecodedValue: Int? = null
        private set

    val parseErrors = mutableListOf<Map<String, Any?>>()
    private val notificationLengthCounts = linkedMapOf<Int, Long>()
    private var overflowNotificationLengthCount = 0L
    private val decodedFieldNames = linkedSetOf<String>()
    private val vendorDerivedFields = linkedMapOf<String, Any?>()
    private val layoutDiagnostics = linkedMapOf(
        LENGTH_153 to LayoutDiagnostics(),
        LENGTH_203 to LayoutDiagnostics(),
    )
    private val bufferedPackets = ArrayList<Packet>()
    private var bufferedEstimatedBytes = 0
    private var bufferedWireBytes = 0
    private var nextPacketSequence = 0L
    private var parseErrorCountAtLastChunk = 0L
    private var vendorType119CountAtLastChunk = 0L

    fun start() {
        check(status == STATUS_IDLE) { "Raw PPG session has already started" }
        status = STATUS_STARTING
    }

    fun markRunning() {
        check(status == STATUS_STARTING) { "Raw PPG session is not starting" }
        status = STATUS_RUNNING
    }

    fun markStopping() {
        check(status == STATUS_RUNNING) { "Raw PPG session is not running" }
        status = STATUS_STOPPING
    }

    fun captureNotification(notification: ByteArray, receivedAt: String): RawPpgNotificationCapture? {
        if (status !in ACTIVE_STATUSES || notification.isEmpty()) return null
        val estimatedBytes = notification.size * RAW_PACKET_MULTIPLIER + PACKET_OVERHEAD_BYTES
        val completedChunk = if (bufferedPackets.isNotEmpty() &&
            (bufferedPackets.size >= MAX_CHUNK_PACKETS || bufferedEstimatedBytes + estimatedBytes > MAX_CHUNK_ESTIMATED_BYTES)
        ) flushChunk() else null
        if (estimatedBytes > MAX_CHUNK_ESTIMATED_BYTES) {
            recordParseError("PPG notification exceeds bounded chunk capacity", receivedAt, notification.size)
            return RawPpgNotificationCapture(null, completedChunk)
        }
        val packet = Packet(nextPacketSequence++, receivedAt, notification.copyOf(), estimatedBytes = estimatedBytes)
        bufferedPackets.add(packet)
        bufferedEstimatedBytes += estimatedBytes
        bufferedWireBytes += notification.size
        bufferHighWaterMark = maxOf(bufferHighWaterMark, bufferedEstimatedBytes)
        packetCount++
        bytesReceived += notification.size
        if (notification.size == LENGTH_153 || notification.size == LENGTH_203 ||
            notificationLengthCounts.containsKey(notification.size) || notificationLengthCounts.size < MAX_EXACT_NOTIFICATION_LENGTHS
        ) {
            notificationLengthCounts[notification.size] = (notificationLengthCounts[notification.size] ?: 0L) + 1L
        } else {
            overflowNotificationLengthCount++
        }
        if (firstPacketAt == null) firstPacketAt = receivedAt
        lastPacketAt = receivedAt
        return RawPpgNotificationCapture(packet.sequenceNumber, completedChunk)
    }

    fun recordParserOutput(
        sequenceNumber: Long,
        dataType: String?,
        dataEnd: Boolean?,
        rawFields: Map<*, *>?,
        receivedAt: String,
    ) {
        val packet = bufferedPackets.firstOrNull { it.sequenceNumber == sequenceNumber } ?: return
        val fields = sanitizeFields(rawFields)
        val output = linkedMapOf<String, Any?>("dataType" to dataType, "dataEnd" to dataEnd)
        if (fields.isNotEmpty()) output["fields"] = fields
        val outputBytes = fields.toString().length * 2
        if (packet.parserOutputs.size < MAX_PARSER_OUTPUTS_PER_PACKET && bufferedEstimatedBytes + outputBytes <= MAX_CHUNK_ESTIMATED_BYTES) {
            packet.parserOutputs.add(output)
            packet.estimatedBytes += outputBytes
            bufferedEstimatedBytes += outputBytes
        }
        bufferHighWaterMark = maxOf(bufferHighWaterMark, bufferedEstimatedBytes)

        fields.keys.take(MAX_DECODED_FIELD_NAMES).forEach { if (decodedFieldNames.size < MAX_DECODED_FIELD_NAMES) decodedFieldNames.add(it) }
        fields.forEach { (name, value) ->
            if (name in VENDOR_DERIVED_FIELD_NAMES) {
                vendorDerivedFields[name] = linkedMapOf(
                    "semanticType" to "VENDOR_DERIVED_BIOMARKER",
                    "fieldName" to name,
                    "value" to boundDiagnosticValue(value),
                )
            }
        }

        if (dataType == VENDOR_DATA_TYPE_119) {
            vendorDataType119Count++
            val values = parseVendorPpgValues(fields[FIELD_PPG])
            if (values.isNotEmpty()) {
                packet.decodedSampleCount += values.size
                decodedSampleCount += values.size
                minimumRawDecodedValue = values.minOrNull()?.let { current -> minimumRawDecodedValue?.let { minOf(it, current) } ?: current }
                maximumRawDecodedValue = values.maxOrNull()?.let { current -> maximumRawDecodedValue?.let { maxOf(it, current) } ?: current }
                packet.minimumRawDecodedValue = values.minOrNull()?.let { current -> packet.minimumRawDecodedValue?.let { minOf(it, current) } ?: current }
                packet.maximumRawDecodedValue = values.maxOrNull()?.let { current -> packet.maximumRawDecodedValue?.let { maxOf(it, current) } ?: current }
                val layout = layoutDiagnostics[packet.originalBytes.size]
                if (layout != null) {
                    layout.packetCount++
                    layout.decodedSampleCount += values.size
                    values.forEach { value ->
                        layout.minimumRawDecodedValue = layout.minimumRawDecodedValue?.let { minOf(it, value) } ?: value
                        layout.maximumRawDecodedValue = layout.maximumRawDecodedValue?.let { maxOf(it, value) } ?: value
                    }
                }
            } else if (packet.originalBytes.size == LENGTH_153 || packet.originalBytes.size == LENGTH_203) {
                recordParseError("Type-119 callback did not contain a decodable ${FIELD_PPG} field", receivedAt, packet.originalBytes.size)
            } else {
                recordParseError("Type-119 notification length has no checked-in SDK layout", receivedAt, packet.originalBytes.size)
            }
        }
    }

    fun completeNotification(sequenceNumber: Long): RawPpgChunkFlush? {
        val packet = bufferedPackets.firstOrNull { it.sequenceNumber == sequenceNumber } ?: return null
        if (bufferedPackets.size >= MAX_CHUNK_PACKETS || bufferedWireBytes >= FLUSH_WIRE_BYTES || bufferedEstimatedBytes >= MAX_CHUNK_ESTIMATED_BYTES) {
            return flushChunk()
        }
        packet.estimatedBytes = maxOf(packet.estimatedBytes, packet.originalBytes.size * RAW_PACKET_MULTIPLIER + PACKET_OVERHEAD_BYTES)
        return null
    }

    fun recordParseError(message: String, receivedAt: String, notificationLength: Int? = null) {
        parseErrorCount++
        if (parseErrors.size >= MAX_PARSE_ERROR_SAMPLES) return
        parseErrors.add(
            linkedMapOf(
                "message" to message,
                "receivedAt" to receivedAt,
                "notificationLength" to notificationLength,
            ),
        )
    }

    fun flush(): RawPpgChunkFlush? = flushChunk()

    fun stop(stoppedAt: String): RawPpgChunkFlush? {
        if (status == STATUS_STOPPED || status == STATUS_ERROR || status == STATUS_DISCONNECTED) return null
        check(status == STATUS_STOPPING) { "Raw PPG session must be stopping before it can stop" }
        val chunk = flushChunk()
        status = STATUS_STOPPED
        this.stoppedAt = stoppedAt
        return chunk
    }

    fun fail(stoppedAt: String): RawPpgChunkFlush? {
        if (status in TERMINAL_STATUSES) return null
        val chunk = flushChunk()
        status = STATUS_ERROR
        this.stoppedAt = stoppedAt
        return chunk
    }

    fun disconnect(stoppedAt: String): RawPpgChunkFlush? {
        if (status in TERMINAL_STATUSES) return null
        val chunk = flushChunk()
        status = STATUS_DISCONNECTED
        this.stoppedAt = stoppedAt
        return chunk
    }

    fun toMap(): Map<String, Any?> = linkedMapOf(
        "sessionId" to sessionId,
        "deviceId" to deviceId,
        "startedAt" to startedAt,
        "stoppedAt" to stoppedAt,
        "status" to status,
        "signalType" to SIGNAL_TYPE,
        "packetCount" to packetCount,
        "chunkCount" to chunkCount,
        "bytesReceived" to bytesReceived,
        "bufferHighWaterMark" to bufferHighWaterMark,
        "parseErrorCount" to parseErrorCount,
        "notificationLengthCounts" to categorizedNotificationLengthCounts(),
        "notificationLengthsExactCounts" to notificationLengthCounts.entries.take(MAX_EXACT_NOTIFICATION_LENGTHS).associate { it.key.toString() to it.value },
        "vendorDataType119Count" to vendorDataType119Count,
        "firstPacketAt" to firstPacketAt,
        "lastPacketAt" to lastPacketAt,
        "decodedSampleCount" to decodedSampleCount,
        "minimumRawDecodedValue" to minimumRawDecodedValue,
        "maximumRawDecodedValue" to maximumRawDecodedValue,
        "sampleRateHz" to null,
        "sampleIntervalMs" to null,
        "unit" to UNKNOWN_UNIT,
        "sampleFormat" to "UNKNOWN_VENDOR_LAYOUT",
        "rawSampleDiagnostics" to layoutDiagnostics.mapKeys { it.key.toString() }.mapValues { it.value.toMap() },
        "decodedFieldNames" to decodedFieldNames.take(MAX_DECODED_FIELD_NAMES),
        "vendorDerivedFields" to vendorDerivedFields.values.toList(),
        "temporaryStorePath" to null,
        "persistedPacketCount" to 0,
        "persistedBytes" to 0,
        "storageErrorCount" to 0,
        "source" to source,
        "parseErrors" to parseErrors.take(MAX_PARSE_ERROR_SAMPLES),
    )

    private fun categorizedNotificationLengthCounts(): Map<String, Long> = linkedMapOf(
        LENGTH_153.toString() to (notificationLengthCounts[LENGTH_153] ?: 0L),
        LENGTH_203.toString() to (notificationLengthCounts[LENGTH_203] ?: 0L),
        "other" to (notificationLengthCounts.filterKeys { it != LENGTH_153 && it != LENGTH_203 }.values.sum() + overflowNotificationLengthCount),
    )

    private fun flushChunk(): RawPpgChunkFlush? {
        if (bufferedPackets.isEmpty()) return null
        val lengthCounts = linkedMapOf(
            LENGTH_153.toString() to bufferedPackets.count { it.originalBytes.size == LENGTH_153 },
            LENGTH_203.toString() to bufferedPackets.count { it.originalBytes.size == LENGTH_203 },
            "other" to bufferedPackets.count { it.originalBytes.size != LENGTH_153 && it.originalBytes.size != LENGTH_203 },
        )
        fun layoutSummary(length: Int): Map<String, Any?> {
            val packets = bufferedPackets.filter { it.originalBytes.size == length }
            return linkedMapOf(
                "packetCount" to packets.size,
                "decodedSampleCount" to packets.sumOf { it.decodedSampleCount },
                "minimumRawDecodedValue" to packets.mapNotNull { it.minimumRawDecodedValue }.minOrNull(),
                "maximumRawDecodedValue" to packets.mapNotNull { it.maximumRawDecodedValue }.maxOrNull(),
            )
        }
        val sequenceStart = bufferedPackets.first().sequenceNumber
        val sequenceEnd = bufferedPackets.last().sequenceNumber
        val parseErrorsInChunk = parseErrorCount - parseErrorCountAtLastChunk
        parseErrorCountAtLastChunk = parseErrorCount
        val vendorType119InChunk = vendorDataType119Count - vendorType119CountAtLastChunk
        vendorType119CountAtLastChunk = vendorDataType119Count
        val summary = linkedMapOf<String, Any?>(
            "sessionId" to sessionId,
            "sequenceStart" to sequenceStart,
            "sequenceEnd" to sequenceEnd,
            "packetCount" to bufferedPackets.size,
            "chunkCount" to 1,
            "wireBytes" to bufferedWireBytes,
            "firstReceivedAt" to bufferedPackets.first().receivedAt,
            "lastReceivedAt" to bufferedPackets.last().receivedAt,
            "notificationLengthCounts" to lengthCounts,
            "vendorType119Count" to vendorType119InChunk,
            "decoded153Summary" to layoutSummary(LENGTH_153),
            "decoded203Summary" to layoutSummary(LENGTH_203),
            "parseErrorCount" to parseErrorsInChunk,
        )
        val chunk = RawPpgChunkFlush(summary, bufferedPackets.map { it.originalBytes.copyOf() })
        chunkCount++
        bufferedPackets.clear()
        bufferedEstimatedBytes = 0
        bufferedWireBytes = 0
        return chunk
    }

    private fun sanitizeFields(rawFields: Map<*, *>?): Map<String, Any?> {
        if (rawFields == null) return emptyMap()
        @Suppress("UNCHECKED_CAST")
        return JCVitalV8EventNormalizer.sanitize(rawFields) as? Map<String, Any?> ?: emptyMap()
    }

    private fun boundDiagnosticValue(value: Any?, depth: Int = 0): Any? = when (value) {
        null, is Number, is Boolean -> value
        is String -> value.take(MAX_DIAGNOSTIC_STRING_LENGTH)
        is Map<*, *> -> if (depth >= MAX_DIAGNOSTIC_DEPTH) value.toString().take(MAX_DIAGNOSTIC_STRING_LENGTH) else
            value.entries.take(MAX_DIAGNOSTIC_COLLECTION_ITEMS).associate { (key, item) ->
                key.toString().take(MAX_DIAGNOSTIC_STRING_LENGTH) to boundDiagnosticValue(item, depth + 1)
            }
        is Iterable<*> -> value.take(MAX_DIAGNOSTIC_COLLECTION_ITEMS).map { boundDiagnosticValue(it, depth + 1) }
        else -> value.toString().take(MAX_DIAGNOSTIC_STRING_LENGTH)
    }

    private fun parseVendorPpgValues(raw: Any?): List<Int> = when (raw) {
        is Iterable<*> -> raw.mapNotNull { (it as? Number)?.toInt() }
        is String -> raw.removePrefix("[").removeSuffix("]")
            .split(',')
            .mapNotNull { it.trim().toIntOrNull() }
        else -> emptyList()
    }

    companion object {
        const val SIGNAL_TYPE = "PPG_WORKFLOW_RAW_VENDOR"
        const val UNKNOWN_UNIT = "UNKNOWN_VENDOR_UNIT"
        const val STATUS_IDLE = "IDLE"
        const val STATUS_STARTING = "STARTING"
        const val STATUS_RUNNING = "RUNNING"
        const val STATUS_STOPPING = "STOPPING"
        const val STATUS_STOPPED = "STOPPED"
        const val STATUS_ERROR = "ERROR"
        const val STATUS_DISCONNECTED = "DISCONNECTED"
        const val VENDOR_DATA_TYPE_119 = "119"
        const val LENGTH_153 = 153
        const val LENGTH_203 = 203
        const val MAX_CHUNK_ESTIMATED_BYTES = 64 * 1024
        const val MAX_CHUNK_PACKETS = 16
        const val FLUSH_WIRE_BYTES = 8 * 1024
        private const val MAX_PARSE_ERROR_SAMPLES = 50
        private const val MAX_EXACT_NOTIFICATION_LENGTHS = 32
        private const val MAX_DECODED_FIELD_NAMES = 32
        private const val MAX_PARSER_OUTPUTS_PER_PACKET = 8
        private const val MAX_DIAGNOSTIC_COLLECTION_ITEMS = 32
        private const val MAX_DIAGNOSTIC_DEPTH = 2
        private const val MAX_DIAGNOSTIC_STRING_LENGTH = 256
        private const val RAW_PACKET_MULTIPLIER = 2
        private const val PACKET_OVERHEAD_BYTES = 128
        private const val FIELD_PPG = "PPG"
        // Vendor BGEM/glucose-risk workflow is not equivalent to measured blood glucose.
        private val VENDOR_DERIVED_FIELD_NAMES = setOf(
            "bloodTestLength",
            "bloodTestProgress",
            "bloodTestValue",
            "bloodTestCurve",
            "bloodPercent",
            "bloodRebound",
            "bloodResultMax",
            "bloodResultRank",
        )
        private val ACTIVE_STATUSES = setOf(STATUS_STARTING, STATUS_RUNNING, STATUS_STOPPING)
        private val TERMINAL_STATUSES = setOf(STATUS_STOPPED, STATUS_ERROR, STATUS_DISCONNECTED)
    }
}