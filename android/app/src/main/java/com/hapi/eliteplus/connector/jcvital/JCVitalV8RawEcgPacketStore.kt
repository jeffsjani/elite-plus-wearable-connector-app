package com.hapi.eliteplus.connector.jcvital

import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream

/** Length-prefixed original notifications, written chunk-by-chunk to app cache. */
class JCVitalV8RawEcgPacketStore private constructor(val file: File) : AutoCloseable {
    private val output = DataOutputStream(BufferedOutputStream(FileOutputStream(file, false)))
    var packetCount: Long = 0
        private set
    var byteCount: Long = 0
        private set

    init {
        output.write(STORE_MAGIC)
        output.flush()
        byteCount += STORE_MAGIC.size
    }

    @Synchronized
    fun appendPackets(rawPackets: List<List<Int>>) {
        rawPackets.forEach { packet ->
            output.writeInt(packet.size)
            packet.forEach { output.writeByte(it and 0xFF) }
            packetCount++
            byteCount += Integer.BYTES + packet.size
        }
        output.flush()
    }

    @Synchronized
    override fun close() {
        output.flush()
        output.close()
    }

    companion object {
        private val STORE_MAGIC = byteArrayOf('J'.code.toByte(), 'C'.code.toByte(), 'V'.code.toByte(), '8'.code.toByte(), 'E'.code.toByte(), 'C'.code.toByte(), 'G'.code.toByte(), '1'.code.toByte())

        fun create(cacheDirectory: File, sessionId: String): JCVitalV8RawEcgPacketStore {
            val prefix = "jcvital-ecg-${sessionId.take(8)}-"
            return JCVitalV8RawEcgPacketStore(File.createTempFile(prefix, ".bin", cacheDirectory))
        }
    }
}
