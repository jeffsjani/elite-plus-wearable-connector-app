package com.hapi.eliteplus.connector.jcvital

import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream

/** Length-prefixed original PPG-workflow notifications in persistent app-private storage. */
internal class RawPpgPacketStore private constructor(val file: File) : AutoCloseable {
    private val stream = FileOutputStream(file, false)
    private val output = DataOutputStream(BufferedOutputStream(stream))
    var sourceFileId: String? = null
    var packetCount: Long = 0
        private set
    var byteCount: Long = 0
        private set
    private val firstChunkSamples = mutableListOf<Map<String, Any?>>()
    private val lastChunkSamples = mutableListOf<Map<String, Any?>>()

    init {
        try {
            output.write(STORE_MAGIC)
            output.flush()
            stream.fd.sync()
            byteCount += STORE_MAGIC.size
        } catch (error: Throwable) {
            try { output.close() } catch (closeError: Throwable) { error.addSuppressed(closeError) }
            throw error
        }
    }

    @Synchronized
    fun appendChunk(rawPackets: List<ByteArray>, exportSample: Map<String, Any?>) {
        rawPackets.forEach { packet ->
            output.writeInt(packet.size)
            packet.forEach { output.writeByte(it.toInt()) }
            packetCount++
            byteCount += Integer.BYTES + packet.size
        }
        if (firstChunkSamples.size < MAX_SAMPLE_CHUNKS) firstChunkSamples.add(exportSample)
        lastChunkSamples.add(exportSample)
        while (lastChunkSamples.size > MAX_SAMPLE_CHUNKS) lastChunkSamples.removeAt(0)
        output.flush()
        stream.fd.sync()
    }

    /**
     * VC29: appends exactly one original notification (length prefix + unmodified bytes) and fsyncs before
     * returning. Returns (lengthPrefixOffset, payloadOffset) within the spool file.
     */
    @Synchronized
    fun appendPacket(packet: ByteArray): Pair<Long, Long> {
        val prefixOffset = byteCount
        output.writeInt(packet.size)
        output.write(packet)
        output.flush()
        stream.fd.sync()
        packetCount++
        byteCount += Integer.BYTES + packet.size
        return prefixOffset to prefixOffset + Integer.BYTES
    }

    @Synchronized
    fun firstThreeChunks(): List<Map<String, Any?>> = firstChunkSamples.toList()

    @Synchronized
    fun lastThreeChunks(): List<Map<String, Any?>> = lastChunkSamples.toList()

    @Synchronized
    override fun close() {
        output.flush()
        stream.fd.sync()
        output.close()
    }

    companion object {
        private const val MAX_SAMPLE_CHUNKS = 3
        private val STORE_MAGIC = byteArrayOf('J'.code.toByte(), 'C'.code.toByte(), 'V'.code.toByte(), '8'.code.toByte(), 'P'.code.toByte(), 'P'.code.toByte(), 'G'.code.toByte(), '1'.code.toByte())

        fun create(directory: File, sessionId: String): RawPpgPacketStore {
            require(sessionId.matches(Regex("[A-Za-z0-9_-]+")))
            val spool = File(directory, "jcvital-source-spool")
            check(spool.isDirectory || spool.mkdirs()) { "Could not create source spool" }
            val file = File(spool, "jcvital-ppg-$sessionId-${java.util.UUID.randomUUID()}.bin")
            check(file.createNewFile()) { "Source spool collision" }
            return try { RawPpgPacketStore(file) }
            catch (error: Throwable) { file.delete(); throw error }
        }
    }
}