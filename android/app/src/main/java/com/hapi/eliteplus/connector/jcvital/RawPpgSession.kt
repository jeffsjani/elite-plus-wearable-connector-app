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

    fun captureNotification(notification: ByteArray, receivedAt: String): Long? {
        if (status !in ACTIVE_STATUSES || notification.isEmpty()) return null
        val estimatedBytes = notification.size * RAW_PACKET_MULTIPLIER + PACKET_OVERHEAD_BYTES
        if (bufferedPackets.isNotEmpty() && (bufferedPackets.size >= MAX_CHUNK_PACKETS || bufferedEstimatedBytes + estimatedBytes > MAX_CHUNK_ESTIMATED_BYTES)) {
            flushChunk()
        }
        if (estimatedBytes > MAX_CHUNK_ESTIMATED_BYTES) {
            recordParseError("PPG notification exceeds bounded chunk capacity", receivedAt, notification.size)
            return null
        }
        val packet = Packet(nextPacketSequence++, receivedAt, notification.copyOf(), estimatedBytes = estimatedBytes)
        bufferedPackets.add(packet)
        bufferedEstimatedBytes += estimatedBytes
        bufferedWireBytes += notification.size
        bufferHighWaterMark = maxOf(bufferHighWaterMark, bufferedEstimatedBytes)
        packetCount++
        bytesReceived += notification.size
        notificationLengthCounts[notification.size] = (notificationLengthCounts[notification.size] ?: 0L) + 1L
        if (firstPacketAt == null) firstPacketAt = receivedAt
        lastPacketAt = receivedAt
        return packet.sequenceNumber
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
        packet.parserOutputs.add(output)
        packet.estimatedBytes += fields.toString().length * 2
        bufferedEstimatedBytes += fields.toString().length * 2
        bufferHighWaterMark = maxOf(bufferHighWaterMark, bufferedEstimatedBytes)

        fields.keys.forEach(decodedFieldNames::add)
        fields.forEach { (name, value) ->
            if (name in VENDOR_DERIVED_FIELD_NAMES) {
                vendorDerivedFields[name] = linkedMapOf(
                    "semanticType" to "VENDOR_DERIVED_BIOMARKER",
                    "fieldName" to name,
                    "value" to value,
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

    fun completeNotification(sequenceNumber: Long): Map<String, Any?>? {
        val packet = bufferedPackets.firstOrNull { it.sequenceNumber == sequenceNumber } ?: return null
        if (bufferedPackets.size >= MAX_CHUNK_PACKETS || bufferedWireBytes >= FLUSH_WIRE_BYTES || bufferedEstimatedBytes >= MAX_CHUNK_ESTIMATED_BYTES) {
            return flushChunk()
        }
        packet.estimatedBytes = maxOf(packet.estimatedBytes, packet.originalBytes.size * RAW_PACKET_MULTIPLIER + PACKET_OVERHEAD_BYTES)
        return null
    }

    fun recordParseError(message: String, receivedAt: String, notificationLength: Int? = null) {
        parseErrorCount++
        parseErrors.add(
            linkedMapOf(
                "message" to message,
                "receivedAt" to receivedAt,
                "notificationLength" to notificationLength,
            ),
        )
    }

    fun flush(): Map<String, Any?>? = flushChunk()

    fun stop(stoppedAt: String): Map<String, Any?>? {
        if (status == STATUS_STOPPED || status == STATUS_ERROR || status == STATUS_DISCONNECTED) return null
        check(status == STATUS_STOPPING) { "Raw PPG session must be stopping before it can stop" }
        val chunk = flushChunk()
        status = STATUS_STOPPED
        this.stoppedAt = stoppedAt
        return chunk
    }

    fun fail(stoppedAt: String): Map<String, Any?>? {
        if (status in TERMINAL_STATUSES) return null
        val chunk = flushChunk()
        status = STATUS_ERROR
        this.stoppedAt = stoppedAt
        return chunk
    }

    fun disconnect(stoppedAt: String): Map<String, Any?>? {
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
        "notificationLengthsExactCounts" to notificationLengthCounts.mapKeys { it.key.toString() },
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
        "decodedFieldNames" to decodedFieldNames.toList(),
        "vendorDerivedFields" to vendorDerivedFields.values.toList(),
        "temporaryStorePath" to null,
        "persistedPacketCount" to 0,
        "persistedBytes" to 0,
        "storageErrorCount" to 0,
        "source" to source,
        "parseErrors" to parseErrors.toList(),
    )

    private fun categorizedNotificationLengthCounts(): Map<String, Long> = linkedMapOf(
        LENGTH_153.toString() to (notificationLengthCounts[LENGTH_153] ?: 0L),
        LENGTH_203.toString() to (notificationLengthCounts[LENGTH_203] ?: 0L),
        "other" to notificationLengthCounts.filterKeys { it != LENGTH_153 && it != LENGTH_203 }.values.sum(),
    )

    private fun flushChunk(): Map<String, Any?>? {
        if (bufferedPackets.isEmpty()) return null
        val chunk = RawSignalChunk(
            sessionId = sessionId,
            sequenceNumber = chunkCount,
            receivedAtStart = bufferedPackets.first().receivedAt,
            receivedAtEnd = bufferedPackets.last().receivedAt,
            packets = bufferedPackets.map { packet ->
                linkedMapOf(
                    "sessionId" to sessionId,
                    "sequenceNumber" to packet.sequenceNumber,
                    "receivedAt" to packet.receivedAt,
                    "notificationLength" to packet.originalBytes.size,
                    "vendorCommandByte" to (packet.originalBytes[0].toInt() and 0xFF),
                    "originalBytes" to packet.originalBytes.map { it.toInt() and 0xFF },
                    "vendorDataType119" to (packet.parserOutputs.any { it["dataType"] == VENDOR_DATA_TYPE_119 }),
                    "vendorParserOutput" to packet.parserOutputs.toList(),
                    "decodedSampleCount" to packet.decodedSampleCount,
                )
            },
            packetCount = bufferedPackets.size,
            bytesReceived = bufferedWireBytes,
            decodedSampleCount = bufferedPackets.sumOf { it.decodedSampleCount },
            estimatedBytes = bufferedEstimatedBytes,
        ).toMap()
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