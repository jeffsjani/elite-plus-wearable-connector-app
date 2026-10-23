package com.hapi.eliteplus.connector.jcvital

import android.util.Base64
import java.io.File
import java.security.MessageDigest

/**
 * Offline, read-only inspection/export of already-persisted Raw PPG spool evidence.
 *
 * Every function here operates purely on bytes already written to app-private storage
 * (files/jcvital-source-spool) plus the independent Source Envelope Journal. Nothing in this
 * object issues a BLE command, opens a device connection, or starts a new acquisition.
 */
internal object RawPpgSavedEvidence {
    const val SPOOL_DIR_NAME = "jcvital-source-spool"
    private val STORE_MAGIC = byteArrayOf(
        'J'.code.toByte(), 'C'.code.toByte(), 'V'.code.toByte(), '8'.code.toByte(),
        'P'.code.toByte(), 'P'.code.toByte(), 'G'.code.toByte(), '1'.code.toByte(),
    )
    const val LENGTH_PREFIX_BYTES = 4
    const val BYTE_ENCODING = "MAGIC_8_BYTES_THEN_BIG_ENDIAN_INT32_LENGTH_AND_ORIGINAL_BYTES"

    // Previously documented physically-validated session shape (18 x 203-byte data + 2 x 16-byte status).
    const val EXPECTED_PACKET_COUNT = 20
    const val EXPECTED_DATA_PACKET_LENGTH = 203
    const val EXPECTED_DATA_PACKET_COUNT = 18
    const val EXPECTED_STATUS_PACKET_LENGTH = 16
    const val EXPECTED_STATUS_PACKET_COUNT = 2
    const val EXPECTED_SPOOL_BYTES = 3774L

    const val OPCODE_STATUS = 0x78 // DeviceConst.CMD_Get_Bloodsugar
    const val OPCODE_DATA = 0x3A // DeviceConst.Bloodsugar_data
    const val CHECKSUM_ALGORITHM_NOT_PROVEN = "CHECKSUM_ALGORITHM_NOT_PROVEN"

    data class PacketRecord(
        val index: Int,
        val opcode: Int,
        val byteLength: Int,
        val sha256Hex: String,
        val payloadOffset: Long,
        val lengthPrefixOffset: Long,
        val base64: String,
    )

    data class SpoolParseResult(
        val file: File,
        val sessionId: String?,
        val magicValid: Boolean,
        val fileByteLength: Long,
        val fileSha256Hex: String,
        val packets: List<PacketRecord>,
        val truncated: Boolean,
        val truncationOffset: Long?,
    )

    fun sha256Hex(bytes: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 0xFF) }

    /** Lists candidate PPG spool files in app-private storage. Performs no I/O beyond directory listing. */
    fun discoverSpoolFiles(filesDir: File): List<File> {
        val dir = File(filesDir, SPOOL_DIR_NAME)
        if (!dir.isDirectory) return emptyList()
        return (dir.listFiles { candidate -> candidate.isFile && candidate.name.startsWith("jcvital-ppg-") } ?: emptyArray())
            .sortedBy { it.name }
    }

    private val UUID_SUFFIX = Regex("-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

    fun sessionIdFromFileName(name: String): String? {
        val withoutPrefix = name.removePrefix("jcvital-ppg-")
        if (withoutPrefix == name) return null
        val withoutExtension = withoutPrefix.removeSuffix(".bin")
        val match = UUID_SUFFIX.find(withoutExtension) ?: return null
        return withoutExtension.removeRange(match.range).ifBlank { null }
    }

    /** Parses the length-prefixed spool format byte-for-byte. Never mutates or rewrites the source file. */
    fun parseSpool(file: File): SpoolParseResult {
        val bytes = file.readBytes()
        val fileSha256 = sha256Hex(bytes)
        val magicValid = bytes.size >= STORE_MAGIC.size && STORE_MAGIC.indices.all { bytes[it] == STORE_MAGIC[it] }
        val packets = mutableListOf<PacketRecord>()
        var truncated = !magicValid
        var truncationOffset: Long? = if (magicValid) null else 0L
        if (magicValid) {
            var cursor = STORE_MAGIC.size
            var index = 0
            while (cursor < bytes.size) {
                if (cursor + LENGTH_PREFIX_BYTES > bytes.size) {
                    truncated = true; truncationOffset = cursor.toLong(); break
                }
                val length = ((bytes[cursor].toInt() and 0xFF) shl 24) or
                    ((bytes[cursor + 1].toInt() and 0xFF) shl 16) or
                    ((bytes[cursor + 2].toInt() and 0xFF) shl 8) or
                    (bytes[cursor + 3].toInt() and 0xFF)
                val payloadStart = cursor + LENGTH_PREFIX_BYTES
                if (length < 0 || payloadStart.toLong() + length > bytes.size) {
                    truncated = true; truncationOffset = cursor.toLong(); break
                }
                val payload = bytes.copyOfRange(payloadStart, payloadStart + length)
                packets.add(
                    PacketRecord(
                        index = index,
                        opcode = if (payload.isNotEmpty()) payload[0].toInt() and 0xFF else -1,
                        byteLength = length,
                        sha256Hex = sha256Hex(payload),
                        payloadOffset = payloadStart.toLong(),
                        lengthPrefixOffset = cursor.toLong(),
                        base64 = Base64.encodeToString(payload, Base64.NO_WRAP),
                    ),
                )
                cursor = payloadStart + length
                index++
            }
        }
        return SpoolParseResult(file, sessionIdFromFileName(file.name), magicValid, bytes.size.toLong(), fileSha256, packets, truncated, truncationOffset)
    }

    fun matchesDocumentedShape(result: SpoolParseResult): Boolean {
        if (result.truncated || result.packets.size != EXPECTED_PACKET_COUNT) return false
        val dataCount = result.packets.count { it.byteLength == EXPECTED_DATA_PACKET_LENGTH }
        val statusCount = result.packets.count { it.byteLength == EXPECTED_STATUS_PACKET_LENGTH }
        return dataCount == EXPECTED_DATA_PACKET_COUNT && statusCount == EXPECTED_STATUS_PACKET_COUNT
    }

    fun candidateSummary(result: SpoolParseResult): Map<String, Any?> = linkedMapOf(
        "filename" to result.file.name,
        "sessionId" to result.sessionId,
        "byteLength" to result.fileByteLength,
        "sha256" to result.fileSha256Hex,
        "packetCount" to result.packets.size,
        "truncated" to result.truncated,
        "truncationOffset" to result.truncationOffset,
        "matchesDocumentedShape" to matchesDocumentedShape(result),
        "documentedShape" to linkedMapOf(
            "expectedPacketCount" to EXPECTED_PACKET_COUNT,
            "expectedDataPackets" to "${EXPECTED_DATA_PACKET_COUNT}x${EXPECTED_DATA_PACKET_LENGTH}",
            "expectedStatusPackets" to "${EXPECTED_STATUS_PACKET_COUNT}x${EXPECTED_STATUS_PACKET_LENGTH}",
            "expectedSpoolBytes" to EXPECTED_SPOOL_BYTES,
        ),
    )
}
