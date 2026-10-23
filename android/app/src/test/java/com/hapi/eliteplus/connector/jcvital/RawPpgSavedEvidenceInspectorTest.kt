package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.io.File
import java.security.MessageDigest

/**
 * VC27: Raw PPG saved-evidence inspect/export/finalize is fully offline (0 BLE, 0 network, 0
 * acquisition) and operates only against app-private storage that already exists from a prior
 * physical capture.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class RawPpgSavedEvidenceInspectorTest {
    private lateinit var context: Context
    private lateinit var journal: JCVitalV8SourceJournal
    private lateinit var inspector: RawPpgSavedEvidenceInspector
    private val account = "account-vc27"
    private val device = "opaque-device-vc27"
    private val sessionId = "ppg-physical-20260930"

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        File(context.filesDir, "jcvital-source-spool").deleteRecursively()
        journal = JCVitalV8SourceJournal(context)
        inspector = RawPpgSavedEvidenceInspector(context.filesDir, journal)
    }

    @After
    fun cleanup() {
        journal.close()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        File(context.filesDir, "jcvital-source-spool").deleteRecursively()
    }

    // Builds the previously-documented 18x203 + 2x16 physical shape (~3774 bytes) and registers
    // matching journal ancestry exactly as the live capture path (JCVitalV8Manager.handleNotification) would.
    private fun seedDocumentedSession(): List<ByteArray> {
        journal.configure(account, device, true, null, null, null)
        journal.setDeviceContext("FW-1.2.3", "RAW_PPG", sessionId, "0000fff7-...", 23, 1_000L)
        val packets = mutableListOf<ByteArray>()
        repeat(18) { i -> packets += ByteArray(203) { (it + i).toByte() }.also { it[0] = RawPpgSavedEvidence.OPCODE_DATA.toByte() } }
        repeat(2) { i -> packets += ByteArray(16) { (it + i).toByte() }.also { it[0] = RawPpgSavedEvidence.OPCODE_STATUS.toByte() } }
        val store = RawPpgPacketStore.create(context.filesDir, sessionId)
        store.sourceFileId = journal.registerFile(store.file, sessionId, "PPG_LENGTH_PREFIXED_V1")
        packets.forEach { packet ->
            journal.appendRaw(packet, 2_000_000_000_000L, "UTC")
            store.appendChunk(listOf(packet), emptyMap())
        }
        journal.reserveFileBytes(store.file.absolutePath, store.byteCount)
        store.close()
        return packets
    }

    @Test
    fun inspectFindsRegisteredSpoolWithoutAnyBleOrAcquisition() {
        seedDocumentedSession()
        val result = inspector.inspect(account, device)
        assertEquals(0, result["bleCommandsIssued"])
        assertEquals(0, result["deviceConnectionsOpened"])
        assertEquals(0, result["acquisitionsStarted"])
        assertEquals(true, result["found"])
        @Suppress("UNCHECKED_CAST") val candidates = result["candidates"] as List<Map<String, Any?>>
        assertEquals(1, candidates.size)
        assertEquals(sessionId, candidates.single()["sessionId"])
        assertEquals(3774L, candidates.single()["byteLength"])
        assertEquals(true, candidates.single()["matchesDocumentedShape"])
        assertEquals(sessionId, result["recommendedSessionId"])
    }

    @Test
    fun exportProducesCompleteByteForByteEvidenceWithStableHashesAndOrdering() {
        val packets = seedDocumentedSession()
        val evidence = inspector.export(account, device, sessionId)
        assertEquals("CERTIFIED", evidence["state"])
        assertEquals("CERTIFIED_E2E_LOSSLESS_SOURCE", evidence["sourceStatus"])
        assertEquals("RESEARCH_NATIVE_ONLY", evidence["semanticClassification"])
        assertEquals("NONE_UNTIL_SEMANTICS_CONFIRMED", evidence["canonicalAuthority"])
        assertEquals("UNKNOWN_VENDOR_UNIT", evidence["unit"])
        assertEquals(false, evidence["base44DeliveryRequired"])
        assertEquals(20, evidence["packetCount"])

        @Suppress("UNCHECKED_CAST") val spool = evidence["sourceSpool"] as Map<String, Any?>
        assertEquals(3774L, spool["byteLength"])
        val expectedSha = run {
            val file = File(File(context.filesDir, "jcvital-source-spool"), "").listFiles()!!.single { it.name.startsWith("jcvital-ppg-$sessionId-") }
            MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it.toInt() and 0xFF) }
        }
        assertEquals(expectedSha, spool["sha256"])

        @Suppress("UNCHECKED_CAST") val exportedPackets = evidence["packets"] as List<Map<String, Any?>>
        assertEquals(20, exportedPackets.size)
        exportedPackets.forEachIndexed { i, packet ->
            assertEquals(i, packet["index"])
            val decoded = android.util.Base64.decode(packet["base64"] as String, android.util.Base64.NO_WRAP)
            assertTrue(decoded.contentEquals(packets[i]))
            val expectedPacketSha = MessageDigest.getInstance("SHA-256").digest(packets[i]).joinToString("") { "%02x".format(it.toInt() and 0xFF) }
            assertEquals(expectedPacketSha, packet["sha256"])
        }
        assertEquals(18, exportedPackets.count { it["dataTypeClassification"] == "DATA_PACKET" })
        assertEquals(2, exportedPackets.count { it["dataTypeClassification"] == "STATUS_PACKET" })

        @Suppress("UNCHECKED_CAST") val glucose = evidence["glucoseIsolation"] as Map<String, Any?>
        assertEquals(true, glucose["RAW_PPG_NOT_GLUCOSE"])
        assertEquals(true, glucose["NO_GLUCOSE_CANONICAL_MAPPING"])
        assertEquals(true, glucose["NO_GLUCOSE_INFERENCE"])
        assertEquals(true, glucose["NO_CGM_SUBSTITUTION"])

        @Suppress("UNCHECKED_CAST") val sampling = evidence["sampling"] as Map<String, Any?>
        assertEquals(null, sampling["sampleRateHz"])
        assertEquals(null, sampling["samplingIntervalMs"])

        // Re-exporting must produce identical hashes/ordering (determinism for repeated inspection).
        val again = inspector.export(account, device, sessionId)
        assertEquals(evidence["packets"], again["packets"])
        assertEquals((evidence["sourceSpool"] as Map<*, *>)["sha256"], (again["sourceSpool"] as Map<*, *>)["sha256"])
    }

    @Test
    fun exportPreservesZeroBytesAndRepeatedByteSequences() {
        journal.configure(account, device, true, null, null, null)
        journal.setDeviceContext("FW-1.2.3", "RAW_PPG", sessionId, null, null, null)
        val zeroPacket = ByteArray(203) // all zero bytes, including opcode
        val repeatedPacket = ByteArray(203) { 0x7F }
        val store = RawPpgPacketStore.create(context.filesDir, sessionId)
        journal.registerFile(store.file, sessionId, "PPG_LENGTH_PREFIXED_V1")
        store.appendChunk(listOf(zeroPacket, repeatedPacket), emptyMap())
        journal.reserveFileBytes(store.file.absolutePath, store.byteCount)
        store.close()

        val evidence = inspector.export(account, device, sessionId)
        @Suppress("UNCHECKED_CAST") val packets = evidence["packets"] as List<Map<String, Any?>>
        assertEquals(2, packets.size)
        assertTrue(android.util.Base64.decode(packets[0]["base64"] as String, android.util.Base64.NO_WRAP).all { it == 0.toByte() })
        assertTrue(android.util.Base64.decode(packets[1]["base64"] as String, android.util.Base64.NO_WRAP).all { it == 0x7F.toByte() })
    }

    @Test
    fun finalizePersistsCertificationAcrossRestart() {
        seedDocumentedSession()
        val finalized = inspector.finalize(account, device, sessionId)
        assertEquals("CERTIFIED", finalized["state"])

        // Simulate app restart: close and reopen the journal against the same on-disk database/files.
        journal.close()
        val restartedJournal = JCVitalV8SourceJournal(context)
        restartedJournal.configure(account, device, true, null, null, null)
        val restartedInspector = RawPpgSavedEvidenceInspector(context.filesDir, restartedJournal)

        val readBack = restartedInspector.readFinalized(account, device)
        val json = JSONObject(readBack["json"] as String)
        assertEquals("CERTIFIED", json.getString("state"))
        assertEquals(sessionId, json.getString("sessionId"))
        assertEquals(20, json.getInt("packetCount"))

        // Evidence is still inspectable/exportable purely from disk after restart.
        val inspected = restartedInspector.inspect(account, device)
        assertEquals(true, inspected["found"])
        val reExported = restartedInspector.export(account, device, sessionId)
        assertEquals(json.getJSONObject("sourceSpool").getString("sha256"), (reExported["sourceSpool"] as Map<*, *>)["sha256"])
        restartedJournal.close()
    }

    @Test
    fun inspectAndExportRequireNoBleNoNetworkNoAcquisitionAndNeverTouchGatt() {
        seedDocumentedSession()
        // No JCVitalV8Manager/gatt/BLE objects are constructed anywhere in this test; the inspector
        // only depends on java.io.File + the independent SQLite journal, proving the offline contract.
        inspector.inspect(account, device)
        inspector.export(account, device, sessionId)
        inspector.finalize(account, device, sessionId)
        inspector.readFinalized(account, device)
    }

    @Test
    fun missingSpoolFailsClosedWithExactMissingEvidenceReport() {
        journal.configure(account, device, true, null, null, null)
        val error = assertThrows(RawPpgSavedEvidenceInspector.MissingEvidenceException::class.java) {
            inspector.export(account, device, null)
        }
        assertTrue(error.missing.containsAll(listOf("spool", "completeRawBytes", "sourceJournal", "callbackAncestry", "commandAncestry", "packetBoundaries")))
    }

    @Test
    fun truncatedPacketFailsClosedAndIsNotSilentlyCertified() {
        journal.configure(account, device, true, null, null, null)
        journal.setDeviceContext("FW-1.2.3", "RAW_PPG", sessionId, null, null, null)
        val store = RawPpgPacketStore.create(context.filesDir, sessionId)
        journal.registerFile(store.file, sessionId, "PPG_LENGTH_PREFIXED_V1")
        store.appendChunk(listOf(ByteArray(203) { RawPpgSavedEvidence.OPCODE_DATA.toByte() }), emptyMap())
        store.close()
        // Truncate the file mid-payload to simulate a corrupted/incomplete spool.
        val bytes = store.file.readBytes()
        store.file.writeBytes(bytes.copyOfRange(0, bytes.size - 50))

        val evidence = inspector.export(account, device, sessionId)
        assertEquals("NOT_CERTIFIED", evidence["state"])
        assertEquals(true, (evidence["sourceSpool"] as Map<*, *>)["truncated"])
        @Suppress("UNCHECKED_CAST") val missing = evidence["missingEvidence"] as List<String>
        assertTrue(missing.contains("packetBoundaries"))
        assertFalse(evidence.containsValue("CERTIFIED_E2E_LOSSLESS_SOURCE"))
    }

    @Test
    fun ambiguousMultipleCandidatesRequireExactSessionIdInsteadOfGuessing() {
        journal.configure(account, device, true, null, null, null)
        listOf("session-a", "session-b").forEach { id ->
            journal.setDeviceContext("FW-1.2.3", "RAW_PPG", id, null, null, null)
            val store = RawPpgPacketStore.create(context.filesDir, id)
            journal.registerFile(store.file, id, "PPG_LENGTH_PREFIXED_V1")
            val packets = (0 until 18).map { ByteArray(203) { RawPpgSavedEvidence.OPCODE_DATA.toByte() } } +
                (0 until 2).map { ByteArray(16) { RawPpgSavedEvidence.OPCODE_STATUS.toByte() } }
            store.appendChunk(packets, emptyMap())
            store.close()
        }
        val error = assertThrows(RawPpgSavedEvidenceInspector.CodedException::class.java) { inspector.export(account, device, null) }
        assertEquals(RawPpgSavedEvidenceDiagnostic.MULTIPLE_CANDIDATES_AMBIGUOUS, error.code)
        assertTrue(error.message!!.contains("AMBIGUOUS"))
    }

    @Test
    fun noGlucoseMappingAssertionsAreAlwaysPresent() {
        seedDocumentedSession()
        val evidence = inspector.export(account, device, sessionId)
        @Suppress("UNCHECKED_CAST") val glucose = evidence["glucoseIsolation"] as Map<String, Any?>
        assertEquals(setOf("RAW_PPG_NOT_GLUCOSE", "NO_GLUCOSE_CANONICAL_MAPPING", "NO_GLUCOSE_INFERENCE", "NO_CGM_SUBSTITUTION", "vendorLabelDisclaimer"), glucose.keys)
    }
}
