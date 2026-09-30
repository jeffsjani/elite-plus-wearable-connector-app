package com.hapi.eliteplus.connector.jcvital

import java.nio.file.Files
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class JCVitalV8RawEcgPacketStoreTest {
    @Test
    fun appendsLengthPrefixedOriginalPacketsAndClosesIncrementally() {
        val directory = Files.createTempDirectory("jcvital-ecg-store-test").toFile()
        try {
            val store = JCVitalV8RawEcgPacketStore.create(directory, "session-1234")
            store.appendPackets(listOf(listOf(0x07, 0xFF, 0xFF, 0xFF, 0xFF), listOf(0x07, 0x00, 1, 2)))
            store.appendPackets(listOf(listOf(0x07, 0x01, 3, 4)))
            store.close()

            assertTrue(store.file.exists())
            assertEquals(3L, store.packetCount)
            assertEquals(store.file.length(), store.byteCount)
            val bytes = store.file.readBytes()
            assertEquals("JCV8ECG1", String(bytes.copyOfRange(0, 8)))
            val lengths = mutableListOf<Int>()
            var offset = 8
            repeat(3) {
                val length = java.nio.ByteBuffer.wrap(bytes, offset, 4).int
                lengths += length
                offset += 4 + length
            }
            assertEquals(listOf(5, 4, 4), lengths)
            assertEquals(0x07.toByte(), bytes[12])
        } finally {
            directory.deleteRecursively()
        }
    }
}
