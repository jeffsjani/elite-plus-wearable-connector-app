package com.hapi.eliteplus.connector.jcvital

import java.io.BufferedOutputStream
import java.io.DataOutputStream
import java.io.File
import java.io.FileOutputStream

/** Length-prefixed original notifications, synchronously written to persistent app-private storage. */
class JCVitalV8RawEcgPacketStore private constructor(val file: File) : AutoCloseable {
    private val stream = FileOutputStream(file, false)
    private val output = DataOutputStream(BufferedOutputStream(stream))
    var sourceFileId: String? = null
    var packetCount: Long = 0
        private set
    var byteCount: Long = 0
        private set

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
    fun appendPackets(rawPackets: List<List<Int>>) {
        rawPackets.forEach { packet ->
            output.writeInt(packet.size)
            packet.forEach { output.writeByte(it and 0xFF) }
            packetCount++
            byteCount += Integer.BYTES + packet.size
        }
        output.flush()
        stream.fd.sync()
    }

    @Synchronized
    override fun close() {
        output.flush()
        stream.fd.sync()
        output.close()
    }

    companion object {
        private val STORE_MAGIC = byteArrayOf('J'.code.toByte(), 'C'.code.toByte(), 'V'.code.toByte(), '8'.code.toByte(), 'E'.code.toByte(), 'C'.code.toByte(), 'G'.code.toByte(), '1'.code.toByte())

        fun create(directory: File, sessionId: String): JCVitalV8RawEcgPacketStore {
            require(sessionId.matches(Regex("[A-Za-z0-9_-]+")))
            val spool = File(directory, "jcvital-source-spool")
            check(spool.isDirectory || spool.mkdirs()) { "Could not create source spool" }
            val file = File(spool, "jcvital-ecg-$sessionId-${java.util.UUID.randomUUID()}.bin")
            check(file.createNewFile()) { "Source spool collision" }
            return try { JCVitalV8RawEcgPacketStore(file) }
            catch (error: Throwable) { file.delete(); throw error }
        }
    }
}
