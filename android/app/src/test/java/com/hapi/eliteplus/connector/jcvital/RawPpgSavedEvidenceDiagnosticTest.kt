package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
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
 * VC28: the Raw PPG saved-evidence diagnostic is offline, filesystem-first, never requires the live
 * capture scope/READY/BLE, persists a snapshot on success and failure, and reports exact failure codes.
 */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class RawPpgSavedEvidenceDiagnosticTest {
    private lateinit var context: Context
    private lateinit var journal: JCVitalV8SourceJournal
    private val account = "account-vc28"
    private val device = "opaque-device-vc28"
    private val sessionId = "6f1c2b9e-0d3a-4b8e-9c71-2a5d4e6f7a80"

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        File(context.filesDir, "jcvital-source-spool").deleteRecursively()
        File(context.filesDir, RawPpgSavedEvidenceDiagnostic.DIAGNOSTIC_DIR).deleteRecursively()
        journal = JCVitalV8SourceJournal(context)
    }

    @After
    fun cleanup() {
        journal.close()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        File(context.filesDir, "jcvital-source-spool").deleteRecursively()
        File(context.filesDir, RawPpgSavedEvidenceDiagnostic.DIAGNOSTIC_DIR).deleteRecursively()
    }

    private fun packets(): List<ByteArray> {
        val packets = mutableListOf<ByteArray>()
        repeat(18) { i -> packets += ByteArray(203) { (it + i).toByte() }.also { it[0] = RawPpgSavedEvidence.OPCODE_DATA.toByte() } }
        repeat(2) { i -> packets += ByteArray(16) { (it + i).toByte() }.also { it[0] = RawPpgSavedEvidence.OPCODE_STATUS.toByte() } }
        return packets
    }

    /** Mirrors the live path: spool registered + BLE notifications + SDK byte callbacks journaled under RAW_PPG. */
    private fun seedPhysicalSession(id: String = sessionId, withJournal: Boolean = true, withCommand: Boolean = false): File {
        val store = RawPpgPacketStore.create(context.filesDir, id)
        if (withJournal) {
            journal.configure(account, device, true, null, null, null)
            journal.setDeviceContext("FW-1.2.3", "RAW_PPG", id, "0000fff7", 23, 1_000L)
            store.sourceFileId = journal.registerFile(store.file, id, "PPG_LENGTH_PREFIXED_V1")
            if (withCommand) journal.appendRaw(byteArrayOf(0x78, 1, 0), 1_999_999_999_000L, "UTC", kind = "PPG_COMMAND_REQUEST")
        }
        packets().forEach { packet ->
            if (withJournal) {
                val notification = journal.appendRaw(packet, 2_000_000_000_000L, "UTC")
                journal.appendRaw(packet, 2_000_000_000_000L, "UTC", notification, "SDK_BYTE_CALLBACK")
            }
            store.appendChunk(listOf(packet), emptyMap())
        }
        if (withJournal) journal.reserveFileBytes(store.file.absolutePath, store.byteCount)
        store.close()
        // Simulate app restart / disconnected V8: the live capture scope is gone.
        if (withJournal) journal.configure(null, null, false, null, null, null)
        return store.file
    }

    private fun restartedInspector(): RawPpgSavedEvidenceInspector {
        journal.close()
        journal = JCVitalV8SourceJournal(context) // never configured: no live/active source-journal scope
        return RawPpgSavedEvidenceInspector(context.filesDir, journal)
    }

    @Suppress("UNCHECKED_CAST")
    private fun findings(result: Map<String, Any?>) = result["findings"] as List<String>

    @Test
    fun spoolDirectoryWithMatchingEvidenceIsInspectedOfflineWithoutLiveScope() {
        val file = seedPhysicalSession()
        val result = restartedInspector().inspect(account, null)
        assertEquals(true, result["scopeResolved"]); assertEquals(true, result["accountIdResolved"])
        assertEquals(false, result["deviceScopeIdResolved"])
        assertEquals(true, result["appFilesDirAccessible"]); assertEquals(true, result["spoolDirectoryExists"])
        assertEquals(1, result["candidateSpoolCount"])
        assertEquals(listOf(file.name), result["candidateFilenames"])
        assertEquals(listOf(3774L), result["candidateByteSizes"])
        val sha = MessageDigest.getInstance("SHA-256").digest(file.readBytes()).joinToString("") { "%02x".format(it) }
        assertEquals(listOf(sha), result["candidateSha256"])
        assertEquals(sessionId, result["selectedSessionId"])
        assertEquals(true, result["rawPpgPacketStoreMetadataExists"])
        assertEquals(true, result["journalRowsAssociatedWithPpgExist"])
        assertEquals(20, result["matchingBleNotificationCount"])
        assertEquals(20, result["matchingSdkCallbackCount"])
        // The production PPG start command is not journaled, so the chain is honestly incomplete.
        assertEquals(0, result["matchingCommandRequestCount"])
        assertEquals(0, result["packetsWithoutMatchingNotification"])
        assertEquals(listOf("commandRequestAncestry"), result["sourceChainMissing"])
        assertEquals(false, result["completeSourceChainConstructible"])
        assertEquals("FAILED", result["status"])
        assertEquals(RawPpgSavedEvidenceDiagnostic.SOURCE_CHAIN_INCOMPLETE, result["errorCode"])
        assertEquals("NONE_UNTIL_SEMANTICS_CONFIRMED", result["canonicalAuthority"])
        assertEquals("NONE_DIAGNOSTIC_ONLY", result["certificationTransition"])
    }

    @Test
    fun completeChainIncludingCommandRowReportsOkButNeverCertifies() {
        seedPhysicalSession(withCommand = true)
        val result = restartedInspector().inspect(account, device)
        assertEquals("OK", result["status"])
        assertEquals(RawPpgSavedEvidenceDiagnostic.OK, result["errorCode"])
        assertNull(result["failureStage"])
        assertEquals(1, result["matchingCommandRequestCount"])
        assertEquals(true, result["completeSourceChainConstructible"])
        assertEquals("NONE_DIAGNOSTIC_ONLY", result["certificationTransition"])
        assertNull(journal.readRawPpgCertificationOrNullForTest())
    }

    private fun JCVitalV8SourceJournal.readRawPpgCertificationOrNullForTest(): String? = runCatching {
        configure(account, device, true, null, null, null)
        readRawPpgCertification(account, device)["json"] as String?
    }.getOrNull()

    @Test
    fun spoolExistsButJournalMissingStillReportsTheSpool() {
        val file = seedPhysicalSession(withJournal = false)
        val result = restartedInspector().inspect(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.SPOOL_FOUND_METADATA_MISSING, result["errorCode"])
        assertTrue(findings(result).contains(RawPpgSavedEvidenceDiagnostic.SPOOL_FOUND_JOURNAL_MISSING))
        assertEquals(listOf(file.name), result["candidateFilenames"])
        assertEquals(listOf(3774L), result["candidateByteSizes"])
        assertEquals(false, result["rawPpgPacketStoreMetadataExists"])
        assertEquals(false, result["journalRowsAssociatedWithPpgExist"])
        assertEquals(0, result["matchingBleNotificationCount"])
    }

    @Test
    fun journalExistsButSpoolMissingStillReportsJournalRows() {
        val file = seedPhysicalSession()
        assertTrue(file.delete())
        val result = restartedInspector().inspect(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.JOURNAL_FOUND_SPOOL_MISSING, result["errorCode"])
        assertEquals(true, result["spoolDirectoryExists"])
        assertEquals(0, result["candidateSpoolCount"])
        assertEquals(true, result["rawPpgPacketStoreMetadataExists"])
        assertEquals(20, result["matchingBleNotificationCount"])
        @Suppress("UNCHECKED_CAST") val manifest = (result["journalPpgSourceFiles"] as List<Map<String, Any?>>).single()
        assertEquals(file.name, manifest["filename"]); assertEquals(false, manifest["existsOnDisk"])
        assertEquals(sessionId, manifest["sessionId"])
    }

    @Test
    fun neitherSpoolNorJournalExists() {
        val result = restartedInspector().inspect(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.SPOOL_DIRECTORY_NOT_FOUND, result["errorCode"])
        assertEquals("CHECK_SPOOL_DIRECTORY", result["failureStage"])
        assertEquals(false, result["spoolDirectoryExists"])
        assertTrue((result["spoolDirectoryPath"] as String).endsWith("jcvital-source-spool"))
        assertTrue(File(context.filesDir, "jcvital-source-spool").mkdirs())
        val empty = RawPpgSavedEvidenceInspector(context.filesDir, journal).inspect(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.SAVED_EVIDENCE_NOT_FOUND, empty["errorCode"])
    }

    @Test
    fun multipleCandidateSpoolsAreAmbiguousUnlessExactSessionIdIsGiven() {
        seedPhysicalSession("session-a")
        seedPhysicalSession("session-b")
        val inspector = restartedInspector()
        val result = inspector.inspect(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.MULTIPLE_CANDIDATES_AMBIGUOUS, result["errorCode"])
        assertEquals(2, result["candidateSpoolCount"])
        assertNull(result["selectedSessionId"])
        assertEquals("session-b", inspector.inspect(account, device, "session-b")["selectedSessionId"])
        val error = assertThrows(RawPpgSavedEvidenceInspector.CodedException::class.java) { inspector.export(account, device, null) }
        assertEquals(RawPpgSavedEvidenceDiagnostic.MULTIPLE_CANDIDATES_AMBIGUOUS, error.code)
    }

    @Test
    fun noResolvedAccountReportsScopeCodeButStillListsSpoolFiles() {
        val file = seedPhysicalSession()
        val result = restartedInspector().inspect(null, null)
        assertEquals(RawPpgSavedEvidenceDiagnostic.SCOPE_NOT_RESOLVED, result["errorCode"])
        assertEquals("RESOLVE_SCOPE", result["failureStage"])
        assertEquals(false, result["scopeResolved"])
        assertEquals(false, result["journalQueried"])
        assertEquals(listOf(file.name), result["candidateFilenames"])
    }

    @Test
    fun otherAccountsJournalRowsAreNeverAssociated() {
        seedPhysicalSession()
        val result = restartedInspector().inspect("someone-else", null)
        assertEquals(false, result["journalRowsAssociatedWithPpgExist"])
        assertEquals(RawPpgSavedEvidenceDiagnostic.SPOOL_FOUND_METADATA_MISSING, result["errorCode"])
    }

    @Test
    fun truncatedSpoolReportsTruncationCode() {
        val file = seedPhysicalSession()
        file.writeBytes(file.readBytes().copyOf(3774 - 10))
        val result = restartedInspector().inspect(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.SPOOL_TRUNCATED, result["errorCode"])
        assertTrue((result["sourceChainMissing"] as List<*>).contains("packetBoundaries"))
    }

    @Test
    fun journalInternalErrorIsExplicitAndDoesNotHideSpool() {
        val file = seedPhysicalSession(withJournal = false)
        val diagnostic = RawPpgSavedEvidenceDiagnostic(context.filesDir, { _, _ -> throw IllegalStateException("db locked") })
        val result = diagnostic.diagnose(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.INSPECTION_INTERNAL_ERROR, result["errorCode"])
        assertTrue((result["errorMessage"] as String).contains("java.lang.IllegalStateException: db locked"))
        assertEquals(listOf(file.name), result["candidateFilenames"])
    }

    @Test
    fun inaccessibleFilesDirFailsWithStageAndExceptionClass() {
        val result = RawPpgSavedEvidenceDiagnostic(null, { _, _ -> emptyMap() }).diagnose(account, device)
        assertEquals(RawPpgSavedEvidenceDiagnostic.INSPECTION_INTERNAL_ERROR, result["errorCode"])
        assertEquals("RESOLVE_FILES_DIR", result["failureStage"])
        assertEquals("java.lang.IllegalStateException", result["exceptionClass"])
        assertEquals(false, result["appFilesDirAccessible"])
    }

    @Test
    fun diagnosticIsPersistedOnFailureAndReadableAfterRestart() {
        val failed = restartedInspector().inspect(account, device)
        assertEquals("FAILED", failed["status"])
        assertNull(failed["diagnosticPersistenceError"])
        val restarted = restartedInspector()
        val json = restarted.readPersistedDiagnostic()["json"] as String
        val saved = JSONObject(json)
        assertEquals(RawPpgSavedEvidenceDiagnostic.SPOOL_DIRECTORY_NOT_FOUND, saved.getString("errorCode"))
        // Explicit nulls survive serialization so every field is present.
        assertTrue(saved.has("selectedSessionId")); assertTrue(saved.isNull("selectedSessionId"))
        for (key in listOf("status", "errorCode", "errorMessage", "failureStage", "scopeResolved", "accountIdResolved",
            "deviceScopeIdResolved", "appFilesDirAccessible", "spoolDirectoryExists", "spoolDirectoryPath", "candidateSpoolCount",
            "candidateFilenames", "candidateByteSizes", "candidateSha256", "rawPpgPacketStoreMetadataExists",
            "historicalRawPpgSessionExists", "journalRowsAssociatedWithPpgExist", "matchingBleNotificationCount",
            "matchingSdkCallbackCount", "matchingCommandRequestCount", "completeSourceChainConstructible")) {
            assertTrue("missing $key", saved.has(key))
        }
        // No unrelated journal payloads.
        assertFalse(json.contains("sdkSnapshot")); assertFalse(json.contains("base64"))
    }

    @Test
    fun diagnosticNeverIssuesBleNetworkBase44EnqueueOrCanonicalization() {
        seedPhysicalSession()
        val result = restartedInspector().inspect(account, device)
        for (key in listOf("bleCommandsIssued", "deviceConnectionsOpened", "acquisitionsStarted", "networkCalls",
            "base44Calls", "enqueued", "delivered", "canonicalized")) assertEquals(key, 0, result[key])
        assertNotNull(result["generatedAt"])
    }
}
