package com.hapi.eliteplus.connector.jcvital

class JCVitalV8RawEcgSession(
    val sessionId: String,
    val deviceId: String?,
    val firmwareVersion: String?,
    val startedAt: String,
    private val source: Map<String, Any?>,
) {
    data class AppendResult(
        val chunk: Map<String, Any?>?,
        val parseError: Map<String, Any?>?,
    )

    private data class BufferedPacket(
        val packetId: Int,
        val sequenceNumber: Long,
        val receivedAt: String,
        val raw: List<Int>,
        val samples: List<Int>,
        val estimatedFootprintBytes: Int,
    )

    var status: String = STATUS_IDLE
        private set
    var stoppedAt: String? = null
        private set
    var packetCount: Long = 0
        private set
    var sampleCount: Long = 0
        var missingPacketCount: Long = 0
        private set
    var duplicatePacketCount: Long = 0
        private set
    var outOfOrderPacketCount: Long = 0
        private set
    var parseErrorCount: Long = 0
        private set
    var bytesReceived: Long = 0
        private set
    var chunksEmitted: Long = 0
        private set
    var droppedPacketCount: Long = 0
        private set
    var minRawSample: Int? = null
        private set
    var maxRawSample: Int? = null
        private set
    var lastPacketId: Int? = null
        private set
    var averageSamplesPerPacket: Double? = null
        private set
    var maxBufferedEstimateBytes: Int = 0
        private set

    private var nextPacketSequence = 0L
    private var previousForwardPacketId: Int? = null
    private val bufferedPackets = ArrayList<BufferedPacket>()
    private var bufferedEstimatedBytes = 0
    private var bufferedWireBytes = 0
    private var receivedAtStart: String? = null
    private var receivedAtEnd: String? = null
    private var samples = ArrayList<Int>()

    fun start() {
        check(status == STATUS_IDLE) { "Raw ECG session has already started" }
        status = STATUS_STARTING
    }

    fun markRunning() {
        check(status == STATUS_STARTING) { "Raw ECG session is not starting" }
        status = STATUS_RUNNING
    }

    fun markStopping() {
        check(status == STATUS_RUNNING) { "Raw ECG session is not running" }
        status = STATUS_STOPPING
    }

    fun recordSdkParseError() {
        parseErrorCount++
    }

    fun acceptNotification(notification: ByteArray, receivedAt: String): AppendResult {
        if (status !in ACTIVE_STATUSES) {
            parseErrorCount++
            return AppendResult(null, error("ECG packet arrived while session is $status", receivedAt, notification))
        }
        bytesReceived += notification.size
        if (notification.size < 2 || (notification[0].toInt() and 0xFF) != ECG_COMMAND_BYTE) {
            parseErrorCount++
            droppedPacketCount++
            return AppendResult(null, error("Malformed or non-ECG notification", receivedAt, notification))
        }
        if (notification.size > MAX_NOTIFICATION_BYTES) {
            parseErrorCount++
            droppedPacketCount++
            return AppendResult(null, error("ECG notification exceeds native packet size limit", receivedAt, notification))
        }

        val packetId = notification[1].toInt() and 0xFF
        val payloadBytes = notification.size - 2
        val sampleCountInPacket = payloadBytes / BYTES_PER_SAMPLE
        val trailingByteCount = payloadBytes % BYTES_PER_SAMPLE
        if (trailingByteCount != 0) parseErrorCount++

        updateContinuity(packetId)
        val decodedSamples = ArrayList<Int>(sampleCountInPacket)
        var offset = 2
        while (offset + 2 < notification.size) {
            val sample = (notification[offset].toInt() and 0xFF) or
                ((notification[offset + 1].toInt() and 0xFF) shl 8) or
                ((notification[offset + 2].toInt() and 0xFF) shl 16)
            decodedSamples += sample
            minRawSample = minRawSample?.let { minOf(it, sample) } ?: sample
            maxRawSample = maxRawSample?.let { maxOf(it, sample) } ?: sample
            offset += BYTES_PER_SAMPLE
        }

        val estimatedFootprint = notification.size * RAW_PACKET_MULTIPLIER + decodedSamples.size * SAMPLE_OBJECT_ESTIMATE_BYTES + PACKET_OVERHEAD_BYTES
        if (bufferedPackets.isNotEmpty() && (bufferedPackets.size >= MAX_CHUNK_PACKETS || bufferedEstimatedBytes + estimatedFootprint > MAX_CHUNK_ESTIMATED_BYTES)) {
            flushChunk()
        }
        if (estimatedFootprint > MAX_CHUNK_ESTIMATED_BYTES) {
            parseErrorCount++
            droppedPacketCount++
            return AppendResult(null, error("ECG notification cannot fit in bounded chunk", receivedAt, notification))
        }

        val packet = BufferedPacket(
            packetId = packetId,
            sequenceNumber = nextPacketSequence++,
            receivedAt = receivedAt,
            raw = notification.map { it.toInt() and 0xFF },
            samples = decodedSamples,
            estimatedFootprintBytes = estimatedFootprint,
        )
        bufferedPackets += packet
        bufferedEstimatedBytes += estimatedFootprint
        bufferedWireBytes += notification.size
        maxBufferedEstimateBytes = maxOf(maxBufferedEstimateBytes, bufferedEstimatedBytes)
        samples.addAll(decodedSamples)
        packetCount++
        this.sampleCount += decodedSamples.size
        averageSamplesPerPacket = this.sampleCount.toDouble() / packetCount
        lastPacketId = packetId
        if (receivedAtStart == null) receivedAtStart = receivedAt
        receivedAtEnd = receivedAt

        val chunk = if (bufferedPackets.size >= MAX_CHUNK_PACKETS || bufferedWireBytes >= FLUSH_WIRE_BYTES) flushChunk() else null
        val parseError = if (trailingByteCount > 0) {
            error("ECG payload has $trailingByteCount trailing byte(s) after complete UINT24 samples", receivedAt, notification)
        } else {
            null
        }
        return AppendResult(chunk, parseError)
    }

    fun flush(): Map<String, Any?>? = flushChunk()

    fun stop(stoppedAt: String): Map<String, Any?>? {
        if (status == STATUS_STOPPED || status == STATUS_ERROR || status == STATUS_DISCONNECTED) return null
        check(status == STATUS_STOPPING) { "Raw ECG session must be stopping before it can stop" }
        val finalChunk = flushChunk()
        status = STATUS_STOPPED
        this.stoppedAt = stoppedAt
        return finalChunk
    }

    fun fail(stoppedAt: String): Map<String, Any?>? {
        if (status == STATUS_STOPPED || status == STATUS_ERROR || status == STATUS_DISCONNECTED) return null
        val finalChunk = flushChunk()
        status = STATUS_ERROR
        this.stoppedAt = stoppedAt
        return finalChunk
    }

    fun disconnect(stoppedAt: String): Map<String, Any?>? {
        if (status == STATUS_STOPPED || status == STATUS_ERROR || status == STATUS_DISCONNECTED) return null
        val finalChunk = flushChunk()
        status = STATUS_DISCONNECTED
        this.stoppedAt = stoppedAt
        return finalChunk
    }

    fun toMap(): Map<String, Any?> = linkedMapOf(
        "sessionId" to sessionId,
        "deviceId" to deviceId,
        "startedAt" to startedAt,
        "stoppedAt" to stoppedAt,
        "status" to status,
        "packetCount" to packetCount,
        "sampleCount" to sampleCount,
        "missingPacketCount" to missingPacketCount,
        "duplicatePacketCount" to duplicatePacketCount,
        "outOfOrderPacketCount" to outOfOrderPacketCount,
        "parseErrorCount" to parseErrorCount,
        "bytesReceived" to bytesReceived,
        "chunksEmitted" to chunksEmitted,
        "droppedPacketCount" to droppedPacketCount,
        "lastPacketId" to lastPacketId,
        "averageSamplesPerPacket" to averageSamplesPerPacket,
        "minimumRawSample" to minRawSample,
        "maximumRawSample" to maxRawSample,
        "maxBufferedEstimateBytes" to maxBufferedEstimateBytes,
        "hardChunkBufferLimitBytes" to MAX_CHUNK_ESTIMATED_BYTES,
        "sampleRateHz" to null,
        "sampleIntervalMs" to null,
        "sampleFormat" to SAMPLE_FORMAT,
        "unit" to UNKNOWN_UNIT,
        "source" to source,
    )

    private fun updateContinuity(packetId: Int) {
        val previous = previousForwardPacketId
        lastPacketId = packetId
        if (previous == null) {
            previousForwardPacketId = packetId
            return
        }
        val forwardDistance = (packetId - previous + PACKET_ID_MODULUS) % PACKET_ID_MODULUS
        when {
            forwardDistance == 0 -> duplicatePacketCount++
            forwardDistance < MAX_FORWARD_DISTANCE -> {
                if (forwardDistance > 1) missingPacketCount += forwardDistance - 1
                previousForwardPacketId = packetId
            }
            else -> outOfOrderPacketCount++
        }
    }

    private fun flushChunk(): Map<String, Any?>? {
        if (bufferedPackets.isEmpty()) return null
        val first = bufferedPackets.first()
        val last = bufferedPackets.last()
        val chunk = linkedMapOf<String, Any?>(
            "signalType" to "ECG_RAW",
            "sessionId" to sessionId,
            "deviceId" to deviceId,
            "sequenceNumber" to chunksEmitted,
            "firstPacketId" to first.packetId,
            "lastPacketId" to last.packetId,
            "packetSequenceStart" to first.sequenceNumber,
            "packetSequenceEnd" to last.sequenceNumber,
            "receivedAtStart" to receivedAtStart,
            "receivedAtEnd" to receivedAtEnd,
            "sampleRateHz" to null,
            "sampleIntervalMs" to null,
            "sampleFormat" to SAMPLE_FORMAT,
            "unit" to UNKNOWN_UNIT,
            "samples" to samples.toList(),
            "rawPacketBytes" to bufferedPackets.map { it.raw },
            "packetIds" to bufferedPackets.map { it.packetId },
            "packetCount" to bufferedPackets.size,
            "sampleCount" to samples.size,
            "estimatedBytes" to bufferedWireBytes,
            "source" to source,
            "firmwareVersion" to source["firmwareVersion"],
            "sdkVersion" to JCVitalV8EventNormalizer.SDK_VERSION,
        )
        chunksEmitted++
        bufferedPackets.clear()
        bufferedEstimatedBytes = 0
        bufferedWireBytes = 0
        receivedAtStart = null
        receivedAtEnd = null
        samples = ArrayList()
        return chunk
    }

    private fun error(message: String, receivedAt: String, packet: ByteArray) = linkedMapOf<String, Any?>(
        "sessionId" to sessionId,
        "message" to message,
        "receivedAt" to receivedAt,
        "byteCount" to packet.size,
        "rawPacketBytes" to packet.map { it.toInt() and 0xFF },
    )

    companion object {
        const val STATUS_IDLE = "IDLE"
        const val STATUS_STARTING = "STARTING"
        const val STATUS_RUNNING = "RUNNING"
        const val STATUS_STOPPING = "STOPPING"
        const val STATUS_STOPPED = "STOPPED"
        const val STATUS_ERROR = "ERROR"
        const val STATUS_DISCONNECTED = "DISCONNECTED"
        const val SAMPLE_FORMAT = "UINT24_LE_VENDOR_RAW"
        const val UNKNOWN_UNIT = "UNKNOWN_VENDOR_UNIT"
        const val ECG_COMMAND_BYTE = 0x07
        const val MAX_CHUNK_PACKETS = 8
        const val FLUSH_WIRE_BYTES = 16 * 1024
        const val MAX_CHUNK_ESTIMATED_BYTES = 32 * 1024
        const val MAX_NOTIFICATION_BYTES = 4 * 1024
        private const val BYTES_PER_SAMPLE = 3
        private const val RAW_PACKET_MULTIPLIER = 2
        private const val SAMPLE_OBJECT_ESTIMATE_BYTES = 4
        private const val PACKET_OVERHEAD_BYTES = 64
        private const val PACKET_ID_MODULUS = 256
        private const val MAX_FORWARD_DISTANCE = 128
        private val ACTIVE_STATUSES = setOf(STATUS_STARTING, STATUS_RUNNING, STATUS_STOPPING)
    }
}
