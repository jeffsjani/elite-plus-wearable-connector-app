package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.*
import org.junit.Test

class JCVitalV8SourceSnapshotTest {
    @Test fun preservesPrimitiveArraysNullKeysAndLexicalStrings() {
        val input = linkedMapOf<Any?, Any?>(
            null to null, "array" to intArrayOf(0, -1, 255), "lexical" to "[01, 0,,bad,-2]",
            "unknown" to byteArrayOf(-128, 127), "large" to 9007199254740993L,
        )
        val encoded = JCVitalV8SourceSnapshot.encode(input, 10000)
        assertTrue(encoded.contains("\"key\":null,\"value\":null"))
        assertTrue(encoded.contains("\"type\":\"int[]\""))
        assertTrue(encoded.contains("\"type\":\"byte[]\""))
        assertTrue(encoded.contains("[01, 0,,bad,-2]"))
        assertTrue(encoded.contains("\"value\":\"9007199254740993\""))
        assertFalse(encoded.contains("[I@"))
        assertFalse(encoded.contains("[B@"))
    }

    @Test fun copyIsDetachedAndPrimitiveArrayTypeIsPreserved() {
        val array = intArrayOf(1, 2)
        val input = linkedMapOf("values" to array, "objects" to arrayOf(hashMapOf("x" to 1)))
        val copied = JCVitalV8SourceSnapshot.copy(input) as Map<*, *>
        array[0] = 42
        input.clear()
        assertArrayEquals(intArrayOf(1, 2), copied["values"] as IntArray)
        assertEquals(1, (((copied["objects"] as Array<*>)[0]) as Map<*, *>)["x"])
    }

    @Test fun everyLexicalCharacterAndInvalidTokenPositionIsRetained() {
        val text = "[01, 0,,bad,-2]"
        val tokens = JCVitalV8SourceSnapshot.lexicalTokens(text)
        assertEquals(text, tokens.joinToString("") { it["lexeme"] as String })
        val bad = tokens.single { it["lexeme"] == "bad" }
        assertEquals(8, bad["start"])
        assertEquals(11, bad["endExclusive"])
        assertEquals("INVALID_INT32", bad["integerParseStatus"])
        assertEquals("VALID_INT32", tokens.single { it["lexeme"] == "0" }["integerParseStatus"])
    }

    @Test fun unsupportedCyclicOversizedAndDeepObjectsFailExplicitly() {
        assertThrows(JCVitalV8SourceSnapshot.Unsupported::class.java) {
            JCVitalV8SourceSnapshot.encode(Any(), 1000)
        }
        val cyclic = ArrayList<Any?>().apply { add(this) }
        assertThrows(JCVitalV8SourceSnapshot.Unsupported::class.java) {
            JCVitalV8SourceSnapshot.encode(cyclic, 1000)
        }
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8SourceSnapshot.encode("large".repeat(100), 50)
        }
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8SourceSnapshot.lexicalTokens(",".repeat(4097))
        }
    }

    @Test fun preservesNonFiniteNumbersAndUnpairedSurrogatesWithoutJsonCoercion() {
        val encoded = JCVitalV8SourceSnapshot.encode(listOf(Double.NaN, Double.POSITIVE_INFINITY, "\uD800"), 1000)
        assertTrue(encoded.contains("\"value\":\"NaN\""))
        assertTrue(encoded.contains("\"value\":\"Infinity\""))
        assertTrue(encoded.contains("\\ud800"))
    }
}
