package com.hapi.eliteplus.connector.jcvital

import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream

/** Length-prefixed original PPG-workflow notifications stored in app cache. */
internal class RawPpgPacketStore private constructor(val file: File) : AutoCloseable {
    private val output = DataOutputStream(BufferedOutputStream(FileOutputStream(file, false)))
    var packetCount: Long = 0
        private set
    var byteCount: Long = 0
        private set
    private val firstChunkSamples = mutableListOf<Map<String, Any?>>()
    private val lastChunkSamples = mutableListOf<Map<String, Any?>>()

    init {
        output.write(STORE_MAGIC)
        output.flush()
        byteCount += STORE_MAGIC.size
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
    }

    @Synchronized
    fun firstThreeChunks(): List<Map<String, Any?>> = firstChunkSamples.toList()

    @Synchronized
    fun lastThreeChunks(): List<Map<String, Any?>> = lastChunkSamples.toList()

    @Synchronized
    override fun close() {
        output.flush()
        output.close()
    }

    companion object {
        private const val MAX_SAMPLE_CHUNKS = 3
        private val STORE_MAGIC = byteArrayOf('J'.code.toByte(), 'C'.code.toByte(), 'V'.code.toByte(), '8'.code.toByte(), 'P'.code.toByte(), 'P'.code.toByte(), 'G'.code.toByte(), '1'.code.toByte())

        fun create(cacheDirectory: File, sessionId: String): RawPpgPacketStore {
            val prefix = "jcvital-ppg-${sessionId.take(8)}-"
            return RawPpgPacketStore(File.createTempFile(prefix, ".bin", cacheDirectory))
        }
    }
}