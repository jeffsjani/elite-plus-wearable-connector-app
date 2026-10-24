package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import android.util.Base64
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import org.robolectric.shadows.ShadowStatFs

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class JCVitalV8SourceJournalTest {
    private lateinit var context: Context
    private lateinit var journal: JCVitalV8SourceJournal
    private val received = 1_800_000_000_000L
    private val account = "account-A"
    private val device = "opaque-device-A"

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        journal = JCVitalV8SourceJournal(context)
    }
    @After fun cleanup() {
        journal.close()
        ShadowStatFs.reset()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        java.io.File(context.filesDir, "jcvital-source-spool").deleteRecursively()
    }
    private fun grantRecoveryHeadroom() {
        ShadowStatFs.registerStats(context.filesDir, 4096, 600_000, 400_000)
    }
    private fun configure(maxBytes: Long = 2_000_000, maxEnvelopes: Long = 1000) =
        journal.configure(account, device, true, maxBytes, maxEnvelopes, 100_000)
    private fun globalJournalMetrics(): Triple<Long, Long, Long> =
        journal.readableDatabase.rawQuery(
            "SELECT envelopes,COALESCE((SELECT MAX(sequence) FROM envelopes),0),bytes FROM journal_totals WHERE singleton=1",
            null,
        ).use { cursor ->
            cursor.moveToFirst()
            Triple(cursor.getLong(0), cursor.getLong(1), cursor.getLong(2))
        }

    private fun assertRecoveryBlockedWithoutMutation(expectedReason: String, action: () -> Unit) {
        val before = globalJournalMetrics()
        val error = assertThrows(JCVitalV8SourceJournal.Failure::class.java, action)
        assertEquals(expectedReason, error.reason)
        assertTrue(journal.hasFailedClosed())
        assertEquals(before, globalJournalMetrics())
        assertNull(journal.diagnostics(account, device)["recoveryAudit"])
    }

    private fun vendor(data: Any?, type: String = BleConst.GetDynamicHR): Map<String, Any?> =
        linkedMapOf(DeviceKey.DataType to type, DeviceKey.End to false, DeviceKey.Data to data, "unknownCallbackField" to null)
    private fun record(values: String = "[0, 01,,bad,-2]") = linkedMapOf<String, Any?>(
        DeviceKey.Date to "2026.10.04 12:00:00", DeviceKey.ArrayDynamicHR to values,
        "unknown" to intArrayOf(0, -1, 255), "nullable" to null,
    )
    @Suppress("UNCHECKED_CAST")
    private fun items(export: Boolean = false, after: Long = 0, limit: Int = 100) =
        journal.list(account, device, after, limit, export)["envelopes"] as List<Map<String, Any?>>

    @Test fun handshakeInspectionDoesNotOpenOrCreateStorage() {
        assertFalse(context.getDatabasePath("jcvital-source-envelope-v1.db").exists())
        val snapshot = journal.handshakeSnapshot()
        assertEquals("JOURNAL_UNBOUND", snapshot["journalState"])
        assertEquals(false, snapshot["journalOpenAttempted"])
        assertEquals(false, snapshot["journalOpenSucceeded"])
        assertNull(snapshot["journalEnvelopeCount"])
        val pressure = snapshot["journalPressure"] as Map<*, *>
        assertNull(pressure["globalEnvelopeCount"])
        assertNull(pressure["globalAccountedBytes"])
        assertNull(pressure["budgetAtOrOverLimit"])
        assertNull(pressure["largestRecentEnvelopeBytes"])
        assertNull(pressure["reservedSourceFileBytes"])
        assertNull(pressure["safeHeadroomForNextWrite"])
        assertFalse(context.getDatabasePath("jcvital-source-envelope-v1.db").exists())
    }

    @Test fun pressureInspectionUsesGlobalAccountingNotOnlyActiveOwner() {
        configure()
        journal.appendRaw(byteArrayOf(1, 2, 3), received, "UTC")
        journal.configure("account-B", "opaque-device-B", true, 2_000_000, 1000, 100_000)
        journal.appendRaw(byteArrayOf(4), received, "UTC")
        val snapshot = journal.handshakeSnapshot()
        val pressure = snapshot["journalPressure"] as Map<*, *>
        val global = journal.readableDatabase.rawQuery(
            "SELECT envelopes,bytes FROM journal_totals WHERE singleton=1", null,
        ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) to cursor.getLong(1) }
        assertEquals(1L, snapshot["journalEnvelopeCount"])
        assertEquals(2L, pressure["globalEnvelopeCount"])
        assertEquals(global.second, pressure["globalAccountedBytes"])
        assertEquals(1000L - 2L, pressure["envelopeHeadroom"])
        assertEquals(2_000_000L - global.second, pressure["byteHeadroom"])
        assertEquals(false, pressure["budgetAtOrOverLimit"])
        assertEquals("GLOBAL_DATABASE_ALL_OWNERS", pressure["limitsScope"])
        assertNull(pressure["pendingBytesAtFailure"])
        assertEquals(pressure, journal.handshakeSnapshot()["journalPressure"])
    }

    @Test fun pressureInspectionIncludesReservedFilesAndDoesNotClearFailure() {
        configure()
        val file = java.io.File(context.filesDir, "pressure-inspection.bin")
        try {
            file.writeBytes(byteArrayOf(1, 2, 3))
            journal.registerFile(file, "session-A", "RAW_PPG")
            val before = (journal.handshakeSnapshot()["journalPressure"] as Map<*, *>)["globalAccountedBytes"] as Long
            journal.reserveFileBytes(file.absolutePath, 100L)
            val after = (journal.handshakeSnapshot()["journalPressure"] as Map<*, *>)["globalAccountedBytes"] as Long
            assertEquals(before + 100L, after)
            val pressure = journal.handshakeSnapshot()["journalPressure"] as Map<*, *>
            assertEquals(103L, pressure["reservedSourceFileBytes"])
            assertEquals(100_000, pressure["maxEntryBytes"])
            assertEquals(100, pressure["recentEnvelopeSampleLimit"])
            assertTrue((pressure["largestRecentEnvelopeBytes"] as Long) > 1024L)
            assertNull(pressure["safeHeadroomForNextWrite"])
            journal.failClosed("STORAGE_PRESSURE")
            val rows = items(export = true)
            val snapshot = journal.handshakeSnapshot()
            assertEquals("JOURNAL_FAILED_CLOSED", snapshot["journalState"])
            assertEquals(after, (snapshot["journalPressure"] as Map<*, *>)["globalAccountedBytes"])
            assertTrue(journal.hasFailedClosed())
            assertEquals(rows, items(export = true))
        } finally {
            file.delete()
        }
    }

    @Test fun capacityAnalysisRequiresAlreadyOpenStorage() {
        assertEquals("JOURNAL_ANALYSIS_STORAGE_NOT_OPEN", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.capacityAnalysis(received)
        }.reason)
        assertFalse(context.getDatabasePath("jcvital-source-envelope-v1.db").exists())
        assertFalse(journal.hasFailedClosed())
    }

    @Test fun storagePressureRecoveryKeepsEvidenceHistoryAndPersistsRaisedBudget() {
        val oldBudget = 64L * 1024 * 1024
        configure(oldBudget, 100_000)
        val retainedCount = 10_495
        val retainedBytes = 67_038_912L
        val db = journal.writableDatabase
        db.beginTransaction()
        try {
            db.execSQL(
                """WITH RECURSIVE seq(n) AS (
                    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < ?
                )
                INSERT INTO envelopes(sequence,id,account,device,callback_id,record_index,kind,received,timezone,json,raw,bytes)
                SELECT n,'retained-'||n,?,?,NULL,NULL,'SDK_CALLBACK',?,'UTC','{}',NULL,
                    CASE WHEN n=1 THEN ? ELSE 1024 END FROM seq""",
                arrayOf(retainedCount, account, device, received, retainedBytes - (retainedCount - 1) * 1024L),
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        val beforeMetrics = globalJournalMetrics()
        assertEquals(Triple(retainedCount.toLong(), retainedCount.toLong(), retainedBytes), beforeMetrics)
        val rowsBefore = items(export = true)
        journal.failClosed("STORAGE_PRESSURE")

        grantRecoveryHeadroom()
        val configured = journal.configure(account, device, true, null, null, null)
        assertFalse(journal.hasFailedClosed())
        assertEquals(256L * 1024 * 1024, configured["maxBytes"])
        assertEquals(100_000L, configured["maxEnvelopes"])
        assertEquals("STORAGE_PRESSURE", configured["lastFailure"])
        assertEquals("STORAGE_PRESSURE", configured["priorFailureCode"])
        assertEquals("STORAGE_PRESSURE", configured["priorFailureMessage"])
        assertNotNull(configured["priorFailureTimestamp"])
        assertEquals(rowsBefore, items(export = true))
        assertEquals(beforeMetrics, globalJournalMetrics())
        val audit = configured["recoveryAudit"] as JSONObject
        assertEquals("STORAGE_PRESSURE_BUDGET_RECOVERY", audit.getString("recoveryType"))
        assertEquals(oldBudget, audit.getLong("priorMaxBytes"))
        assertEquals(256L * 1024 * 1024, audit.getLong("newMaxBytes"))
        assertEquals(retainedCount.toLong(), audit.getLong("envelopesAtRecovery"))
        assertEquals(retainedBytes, audit.getLong("bytesAtRecovery"))
        assertEquals("ok", audit.getString("integrityCheckResult"))
        assertEquals(account, audit.getString("accountId"))
        assertEquals(device, audit.getString("deviceScopeId"))
        assertEquals("STORAGE_PRESSURE", audit.getString("priorFailureCode"))
        assertEquals("STORAGE_PRESSURE", audit.getString("priorFailureMessage"))
        assertTrue(audit.getString("priorFailureTimestamp").isNotBlank())
        assertTrue(audit.getString("recoveredAt").isNotBlank())
        assertTrue(audit.getLong("availableFilesystemBytes") >= 512L * 1024 * 1024)

        journal.close()
        journal = JCVitalV8SourceJournal(context)
        grantRecoveryHeadroom()
        val reopened = journal.configure(account, device, true, null, null, null)
        assertEquals(256L * 1024 * 1024, reopened["maxBytes"])
        assertEquals("STORAGE_PRESSURE", reopened["lastFailure"])
        assertEquals(rowsBefore, items(export = true))
        assertEquals(beforeMetrics, globalJournalMetrics())
        journal.configure(null, null, false, null, null, null)
        val afterLogout = journal.configure(account, device, true, null, null, null)
        assertEquals(256L * 1024 * 1024, afterLogout["maxBytes"])
        assertEquals("STORAGE_PRESSURE", afterLogout["priorFailureCode"])
        assertEquals(beforeMetrics, globalJournalMetrics())
    }

    @Test fun storagePressureRecoveryRequiresMatchingRetainedScope() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.failClosed("STORAGE_PRESSURE")

        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_ACCOUNT_MISMATCH") {
            journal.configure("different-account", device, true, null, null, null)
        }
        assertEquals("STORAGE_PRESSURE", journal.handshakeSnapshot()["journalFailureCode"])
    }

    @Test fun storagePressureRecoveryRequiresMatchingRetainedDeviceScope() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.failClosed("STORAGE_PRESSURE")

        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_DEVICE_SCOPE_MISMATCH") {
            journal.configure(account, "different-device", true, null, null, null)
        }
    }

    @Test fun storagePressureRecoveryLeavesLatchSetWithoutFilesystemHeadroom() {
        configure(64L * 1024 * 1024, 100_000)
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.failClosed("STORAGE_PRESSURE")
        ShadowStatFs.registerStats(context.filesDir, 4096, 300_000, 100_000)

        val before = globalJournalMetrics()
        val error = assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.configure(account, device, true, null, null, null)
        }
        assertEquals("JOURNAL_RECOVERY_BLOCKED_INSUFFICIENT_DEVICE_STORAGE", error.reason)
        assertTrue(journal.hasFailedClosed())
        assertEquals(64L * 1024 * 1024, journal.diagnostics(account, device)["maxBytes"])
        assertNull(journal.diagnostics(account, device)["recoveryAudit"])
        assertEquals(before, globalJournalMetrics())
    }

    @Test fun storagePressureRecoveryBlocksWhenFailureHistoryIsMissing() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.failClosed("STORAGE_PRESSURE")
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE)
            .edit().remove("lastFailure").commit()
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        grantRecoveryHeadroom()

        assertRecoveryBlockedWithoutMutation("JOURNAL_FAILED_CLOSED") {
            journal.configure(account, device, true, null, null, null)
        }
        assertNull(journal.diagnostics(account, device)["priorFailureCode"])
    }

    @Test fun storagePressureRecoveryBlocksWhenAccountingDoesNotReconcile() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.writableDatabase.execSQL("UPDATE journal_totals SET bytes=bytes+1 WHERE singleton=1")
        journal.failClosed("STORAGE_PRESSURE")
        grantRecoveryHeadroom()

        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_ACCOUNTING_MISMATCH") {
            journal.configure(account, device, true, null, null, null)
        }
    }

    @Test fun storagePressureRecoveryBlocksWhenSequenceContinuityIsBroken() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.appendRaw(byteArrayOf(2), received + 1, "UTC")
        journal.writableDatabase.execSQL("UPDATE envelopes SET sequence=3 WHERE sequence=2")
        journal.failClosed("STORAGE_PRESSURE")
        grantRecoveryHeadroom()

        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_SEQUENCE_INTEGRITY_FAILED") {
            journal.configure(account, device, true, null, null, null)
        }
    }

    @Test fun storagePressureRecoveryBlocksAtGlobalEnvelopeLimit() {
        configure(maxEnvelopes = 100_000)
        val db = journal.writableDatabase
        db.beginTransaction()
        try {
            db.execSQL(
                """WITH RECURSIVE seq(n) AS (
                    SELECT 1 UNION ALL SELECT n + 1 FROM seq WHERE n < 100000
                )
                INSERT INTO envelopes(sequence,id,account,device,callback_id,record_index,kind,received,timezone,json,raw,bytes)
                SELECT n,'limit-'||n,?,?,NULL,NULL,'SDK_CALLBACK',?,'UTC','{}',NULL,1024 FROM seq""",
                arrayOf(account, device, received),
            )
            db.setTransactionSuccessful()
        } finally {
            db.endTransaction()
        }
        journal.failClosed("STORAGE_PRESSURE")
        grantRecoveryHeadroom()

        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_ENVELOPE_LIMIT_REACHED") {
            journal.configure(account, device, true, null, null, null)
        }
    }

    @Test fun storagePressureRecoveryBlocksAtNewGlobalByteLimit() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.writableDatabase.execSQL(
            "UPDATE envelopes SET bytes=? WHERE sequence=1", arrayOf(134_217_728L),
        )
        journal.writableDatabase.execSQL(
            "UPDATE journal_totals SET bytes=? WHERE singleton=1", arrayOf(134_217_728L),
        )
        journal.failClosed("STORAGE_PRESSURE")
        grantRecoveryHeadroom()

        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_BYTE_LIMIT_REACHED") {
            journal.configure(account, device, true, 134_217_728L, null, null)
        }
    }

    private fun retainPhysicalSizedJournal() {
        journal.configure(account, device, true, 134_217_728L, 100_000L, null)
        journal.writableDatabase.execSQL(
            """WITH RECURSIVE seq(n) AS (
                SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<21712
            )
            INSERT INTO envelopes(sequence,id,account,device,kind,received,timezone,json,bytes)
            SELECT n,'physical-fixture-'||n,?,?,'SDK_RECORD',?,'UTC','{}',
                CASE WHEN n=1 THEN 134217498-21711*1024 ELSE 1024 END FROM seq""",
            arrayOf(account, device, received),
        )
        journal.failClosed("STORAGE_PRESSURE")
    }

    @Test fun physicalNearFull128MiBRecoveryIsBlockedWithoutDatabaseOrPreferenceMutation() {
        retainPhysicalSizedJournal()
        grantRecoveryHeadroom()
        val prefs = context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE)
        val beforePrefs = prefs.all.toMap()
        val before = globalJournalMetrics()
        assertEquals(Triple(21_712L, 21_712L, 134_217_498L), before)
        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_INSUFFICIENT_BYTE_HEADROOM") {
            journal.configure(account, device, true, 134_217_728L, 100_000L, null)
        }
        assertEquals(beforePrefs, prefs.all)
        assertEquals(before, globalJournalMetrics())
    }

    @Test fun physicalJournalRecoversAt256MiBPreservingAllSequencesBytesAndLegacyAuditAcrossRestart() {
        retainPhysicalSizedJournal()
        ShadowStatFs.registerStats(context.filesDir, 4096, 600_000, 400_000)
        val prefs = context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE)
        val legacy = JSONObject().put("recoveryType", "STORAGE_PRESSURE_BUDGET_RECOVERY")
            .put("priorMaxBytes", 67_108_864L).put("newMaxBytes", 134_217_728L)
            .put("bytesAtRecovery", 67_102_139L).put("envelopesAtRecovery", 10_519L)
        prefs.edit().putString("recoveryAudit", legacy.toString()).commit()
        val before = globalJournalMetrics()
        val rowsBefore = items(export = true)
        val recovered = journal.configure(account, device, true, 268_435_456L, 100_000L, null)
        assertFalse(journal.hasFailedClosed())
        assertEquals(before, globalJournalMetrics())
        assertEquals(rowsBefore, items(export = true))
        assertEquals(legacy.toString(), prefs.getString("recoveryAudit", null))
        val history = recovered["recoveryAuditHistory"] as org.json.JSONArray
        assertEquals(2, history.length())
        assertEquals(legacy.toString(), history.getJSONObject(0).toString())
        val latest = history.getJSONObject(1)
        assertEquals(134_217_728L, latest.getLong("priorMaxBytes"))
        assertEquals(268_435_456L, latest.getLong("newMaxBytes"))
        assertEquals(134_217_498L, latest.getLong("bytesAtRecovery"))
        assertEquals(21_712L, latest.getLong("envelopesAtRecovery"))
        assertEquals("STORAGE_PRESSURE", latest.getString("priorFailureCode"))
        assertEquals(latest.toString(), (recovered["latestRecoveryAudit"] as JSONObject).toString())
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        val reopened = journal.configure(account, device, true, null, null, null)
        assertEquals(history.toString(), (reopened["recoveryAuditHistory"] as org.json.JSONArray).toString())
        assertEquals(before, globalJournalMetrics())
        assertEquals("STORAGE_PRESSURE", reopened["priorFailureCode"])
    }

    @Test fun recoveryRequiresByteAndEnvelopeUtilizationAtMost80Percent() {
        journal.configure(account, device, true, 10_000L, 10L, null)
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        val db = journal.writableDatabase
        db.execSQL("UPDATE envelopes SET bytes=8001")
        db.execSQL("UPDATE journal_totals SET bytes=8001")
        journal.failClosed("STORAGE_PRESSURE")
        grantRecoveryHeadroom()
        assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_INSUFFICIENT_BYTE_HEADROOM") {
            journal.configure(account, device, true, 10_000L, 10L, null)
        }
        db.execSQL("UPDATE envelopes SET bytes=8000")
        db.execSQL("UPDATE journal_totals SET bytes=8000")
        journal.configure(account, device, true, 10_000L, 10L, null)
        assertFalse(journal.hasFailedClosed())
        db.execSQL(
            """INSERT INTO envelopes(id,account,device,kind,received,timezone,json,bytes)
               SELECT 'slot-'||sequence,account,device,kind,received,timezone,json,0 FROM envelopes WHERE sequence=1""",
        )
        repeat(7) {
            db.execSQL("INSERT INTO envelopes(id,account,device,kind,received,timezone,json,bytes) VALUES(?,?,?,'SDK_RECORD',?,'UTC','{}',0)",
                arrayOf("slot-extra-$it", account, device, received))
        }
        journal.failClosed("STORAGE_PRESSURE")
        val before = globalJournalMetrics()
        assertEquals(9L, before.first)
        val error = assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.configure(account, device, true, 10_000L, 10L, null)
        }
        assertEquals("JOURNAL_RECOVERY_INSUFFICIENT_ENVELOPE_HEADROOM", error.reason)
        assertTrue(journal.hasFailedClosed())
        assertEquals(before, globalJournalMetrics())
    }

    @Test fun storagePressureRecoveryBlocksWhileDatabaseWriteIsPending() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        val db = journal.writableDatabase
        db.beginTransaction()
        try {
            db.execSQL("UPDATE envelopes SET received=received+1 WHERE sequence=1")
            journal.failClosed("STORAGE_PRESSURE")
            grantRecoveryHeadroom()

            val before = globalJournalMetrics()
            assertRecoveryBlockedWithoutMutation("JOURNAL_RECOVERY_PENDING_WRITE") {
                journal.configure(account, device, true, null, null, null)
            }
            assertEquals(before, globalJournalMetrics())
        } finally {
            db.endTransaction()
        }
        val retainedReceived = journal.readableDatabase.rawQuery(
            "SELECT received FROM envelopes WHERE sequence=1", null,
        ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
        assertEquals(received, retainedReceived)
    }

    @Test fun storagePressureRecoveryBlocksOnMalformedDatabaseSchema() {
        configure()
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.failClosed("STORAGE_PRESSURE")
        journal.writableDatabase.execSQL("PRAGMA writable_schema=ON")
        journal.writableDatabase.execSQL("UPDATE sqlite_master SET sql='invalid schema' WHERE name='envelopes'")
        journal.writableDatabase.execSQL("PRAGMA writable_schema=OFF")
        journal.close()
        val dbFile = context.getDatabasePath("jcvital-source-envelope-v1.db")
        val sizeBefore = dbFile.length()
        val hashBefore = java.security.MessageDigest.getInstance("SHA-256").digest(dbFile.readBytes())
        journal = JCVitalV8SourceJournal(context)
        grantRecoveryHeadroom()

        val error = assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.configure(account, device, true, null, null, null)
        }
        assertTrue(error.reason == "JOURNAL_RECOVERY_INTEGRITY_CHECK_FAILED" ||
            error.reason == "JOURNAL_RECOVERY_DATABASE_OPEN_FAILED")
        assertTrue(journal.hasFailedClosed())
        assertEquals(2_000_000L, journal.diagnostics(null, null)["maxBytes"])
        assertEquals(sizeBefore, dbFile.length())
        assertArrayEquals(hashBefore, java.security.MessageDigest.getInstance("SHA-256").digest(dbFile.readBytes()))
        assertNull(journal.diagnostics(account, device)["recoveryAudit"])
    }

    @Test fun nonStoragePressureFailureCannotBeClearedByConfiguration() {
        configure()
        journal.appendRaw(byteArrayOf(1, 2, 3), received, "UTC")
        journal.failClosed("SEQUENCE_INTEGRITY_FAILURE")

        assertRecoveryBlockedWithoutMutation("JOURNAL_FAILED_CLOSED") {
            journal.configure(account, device, true, null, null, null)
        }
        assertEquals("SEQUENCE_INTEGRITY_FAILURE", journal.handshakeSnapshot()["journalFailureCode"])
    }

    @Test fun capacityAnalysisReconcilesGlobalUtf8BlobsOverheadFilesAndRetainsFailure() {
        configure()
        journal.setDeviceContext("test", "RAW_PPG", "ppg-session")
        journal.appendRaw(byteArrayOf(1, 2, 3), received - 91L * 86_400_000, "UTC")
        journal.appendRaw(byteArrayOf(1, 2, 3), received - 91L * 86_400_000, "UTC")
        journal.appendCallback(vendor(listOf(mapOf("unicode" to "\u00e9\u6f22")), "27"), received, "UTC", null)
        val file = java.io.File(context.filesDir, "capacity-test.bin")
        try {
            file.writeBytes(byteArrayOf(4, 5))
            journal.registerFile(file, "ppg-session", "RAW_PPG")
            journal.reserveFileBytes(file.absolutePath, 100)
            val firstOwner = items(export = true)
            journal.configure("account-B", "opaque-device-B", true, 2_000_000, 1000, 100_000)
            journal.appendRaw(byteArrayOf(6), received + 1, "UTC")
            val secondOwner = journal.list("account-B", "opaque-device-B", 0, 100, true)
            journal.failClosed("STORAGE_PRESSURE")
            val prefsBefore = context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).all
            val analysis = journal.capacityAnalysis(received)
            var expectedJson = 0L
            journal.readableDatabase.rawQuery("SELECT json FROM envelopes", null).use { cursor ->
                while (cursor.moveToNext()) expectedJson += cursor.getString(0).toByteArray(Charsets.UTF_8).size
            }
            assertEquals(expectedJson, analysis["envelopeJsonBytes"])
            assertEquals(7L, analysis["rawBlobBytes"])
            assertEquals(6L * 1024, analysis["perEnvelopeOverheadBytes"])
            assertEquals(102L, analysis["reservedSourceFileBytes"])
            assertEquals(0L, analysis["otherAccountedBytes"])
            assertEquals(true, analysis["accountingMatches"])
            assertNull(analysis["hotProductionBytes"])
            assertNull(analysis["coldCertificationBytes"])
            assertNull(analysis["expectedNextSyncBytes"])
            assertEquals(true, analysis["failedClosed"])
            val groups = analysis["groups"] as Map<*, *>
            assertEquals(2, (groups["accountId"] as List<*>).size)
            for (entries in groups.values) {
                val sum = (entries as List<*>).sumOf { (it as Map<*, *>)["accountedBytes"] as Long }
                assertEquals(analysis["totalAccountedBytes"], sum)
            }
            val ages = (groups["ageBucket"] as List<*>).map { (it as Map<*, *>)["key"] }
            assertTrue(ages.contains("OVER_90_DAYS"))
            assertTrue(ages.contains("FUTURE_TIMESTAMP"))
            val duplicates = analysis["duplicateRawCandidatesTop20"] as List<*>
            assertEquals(1, duplicates.size)
            assertEquals(3L, (duplicates.single() as Map<*, *>)["potentialRepeatedRawBytes"])
            assertEquals(false, (duplicates.single() as Map<*, *>)["verifiedByteEquality"])
            val top = analysis["top5ByteContributors"] as List<*>
            assertEquals(5, top.size)
            val topBytes = top.map { (it as Map<*, *>)["accountedBytes"] as Long }
            assertEquals(topBytes.sortedDescending(), topBytes)
            assertEquals("RECONCILED", analysis["reconciliationStatus"])
            assertEquals(0L, analysis["reconciliationDifferenceBytes"])
            assertEquals(analysis["totalAccountedBytes"], analysis["componentSumBytes"])
            val raw = analysis["rawBlobAnalysis"] as Map<*, *>
            assertEquals(7L, raw["rawBlobBytesTotal"])
            assertEquals(3L, raw["rawBlobCount"])
            assertEquals(3L, raw["largestRawBlobBytes"])
            assertEquals(1, raw["duplicateBlobCandidateCount"])
            assertEquals(3L, raw["duplicateBlobCandidateBytes"])
            val records = analysis["topRecords20"] as List<*>
            assertEquals(6, records.size)
            val record = records.first() as Map<*, *>
            assertEquals((record["jsonBytes"] as Long) + (record["blobBytes"] as Long) + (record["overheadBytes"] as Long), record["totalAccountedBytes"])
            val bucketKeys = (groups["ageDistribution"] as List<*>).map { (it as Map<*, *>)["key"] }
            for (key in listOf("UNDER_24_HOURS", "1_TO_7_DAYS", "8_TO_30_DAYS", "31_TO_90_DAYS", "OVER_90_DAYS")) assertTrue(bucketKeys.contains(key))
            val vendor = (groups["vendorBucket"] as List<*>).associate { (it as Map<*, *>)["key"] to (it as Map<*, *>)["envelopes"] }
            assertEquals(10, vendor.size)
            val plan = analysis["recoveryPlanning"] as Map<*, *>
            val total = analysis["totalAccountedBytes"] as Long
            assertEquals(2_000_000L * 80 / 100, plan["target80PercentBytes"])
            assertEquals(maxOf(0L, total - 1_600_000L), plan["bytesToRelieveFor80Percent"])
            assertNull(plan["potentialArchivableCertificationBytes"])
            assertEquals(3L, plan["potentialDuplicateBlobBytes"])
            assertTrue((analysis["evidenceInventory"] as Map<*, *>)["sourceFileCount"] == 1L)
            assertEquals(prefsBefore, context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).all)
            assertEquals(secondOwner, journal.list("account-B", "opaque-device-B", 0, 100, true))
            journal.readableDatabase.rawQuery("SELECT COUNT(*) FROM envelopes WHERE account=?", arrayOf(account)).use {
                it.moveToFirst(); assertEquals(firstOwner.size.toLong(), it.getLong(0))
            }
            assertTrue(journal.hasFailedClosed())
        } finally { file.delete() }
    }

    @Test fun capacityAnalysisReportsDriftAndMalformedJsonWithoutChangingLatch() {
        configure()
        val id = journal.appendRaw(byteArrayOf(1), received, "UTC")
        journal.writableDatabase.execSQL("UPDATE journal_totals SET bytes=bytes+7 WHERE singleton=1")
        val analysis = journal.capacityAnalysis(received)
        assertEquals(7L, analysis["otherAccountedBytes"])
        assertEquals(false, analysis["accountingMatches"])
        journal.writableDatabase.execSQL("UPDATE envelopes SET json='invalid' WHERE id=?", arrayOf(id))
        assertThrows(org.json.JSONException::class.java) { journal.capacityAnalysis(received) }
        assertFalse(journal.hasFailedClosed())
    }

    @Test fun capacityAnalysisDoesNotCountCertificationSnapshotTablesInBudget() {
        configure()
        val snapshot = JSONObject().put("kind", "SleepCertification")
            .put("context", JSONObject().put("scope", JSONObject().put("accountId", account).put("deviceScopeId", device)))
            .put("evidence", "\u00e9").toString()
        journal.writeSleepCertification(account, device, snapshot)
        val analysis = journal.capacityAnalysis(received)
        assertEquals(0L, analysis["totalAccountedBytes"])
        assertEquals(0L, analysis["otherAccountedBytes"])
        assertEquals(true, analysis["accountingMatches"])
        val snapshots = analysis["certificationSnapshotsOutsideBudget"] as List<*>
        assertEquals(1, snapshots.size)
        assertEquals(snapshot.toByteArray(Charsets.UTF_8).size.toLong(), (snapshots.single() as Map<*, *>)["utf8Bytes"])
        assertEquals(false, (snapshots.single() as Map<*, *>)["includedInMaxBytes"])
    }

    @Test fun retainedScopeAndSequencesSurviveReconnectAndInspection() {
        configure()
        journal.appendRaw(byteArrayOf(1, 2, 3), received, "UTC")
        val before = items(export = true)
        journal.configure(null, null, false, null, null, null)
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        configure()
        val snapshot = journal.handshakeSnapshot()
        assertEquals("JOURNAL_READY", snapshot["journalState"])
        assertEquals(account, snapshot["journalAccountId"])
        assertEquals(device, snapshot["journalDeviceScopeId"])
        assertEquals(true, snapshot["journalOpenAttempted"])
        assertEquals(true, snapshot["journalOpenSucceeded"])
        assertEquals(1L, snapshot["journalEnvelopeCount"])
        assertEquals(before, items(export = true))
        journal.appendRaw(byteArrayOf(4), received + 1, "UTC")
        assertTrue((items().last()["sequence"] as Long) > (before.single()["sequence"] as Long))
    }

    @Test fun persistedStoragePressureRecoversWithoutLosingEnvelopes() {
        configure(maxEnvelopes = 1)
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.appendRaw(byteArrayOf(2), received, "UTC")
        }
        val before = items(export = true)
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        assertEquals(true, journal.handshakeSnapshot()["journalFailedClosedAtStartup"])
        grantRecoveryHeadroom()
        configure(maxEnvelopes = 100)
        val snapshot = journal.handshakeSnapshot()
        assertEquals("JOURNAL_READY", snapshot["journalState"])
        assertEquals(true, snapshot["journalFailedClosedAtStartup"])
        assertFalse(journal.hasFailedClosed())
        assertEquals(true, snapshot["journalOpenSucceeded"])
        assertEquals(1L, snapshot["journalEnvelopeCount"])
        assertEquals(before, items(export = true))
        assertEquals("STORAGE_PRESSURE", journal.diagnostics(account, device)["lastFailure"])
        journal.appendRaw(byteArrayOf(3), received, "UTC")
        assertEquals(2, items().size)
    }

    @Test fun invalidBindReportsRequestedOwnerAndDoesNotPretendStorageWasOpened() {
        assertThrows(IllegalArgumentException::class.java) {
            journal.configure(account, "invalid:scope", true, null, null, null)
        }
        val snapshot = journal.handshakeSnapshot()
        assertEquals("JOURNAL_OPEN_FAILED", snapshot["journalState"])
        assertEquals(account, snapshot["journalAccountId"])
        assertEquals("invalid:scope", snapshot["journalDeviceScopeId"])
        assertEquals(false, snapshot["journalOpenAttempted"])
        assertEquals(false, snapshot["journalOpenSucceeded"])
        assertEquals("INVALID_OPAQUE_DEVICE_SCOPE", snapshot["journalFailureMessage"])
        assertFalse(journal.hasFailedClosed())
    }

    @Test fun disabledByDefaultAndNeverCapturesWithoutExplicitOwner() {
        assertFalse(journal.captureEnabled())
        assertEquals("SCOPE_NOT_CONFIGURED", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.appendRaw(byteArrayOf(1), received, "UTC")
        }.reason)
        assertThrows(IllegalArgumentException::class.java) { journal.configure(null, device, true, null, null, null) }
        assertEquals(0L, journal.diagnostics(null, null)["totalEnvelopeCount"])
        configure()
        assertTrue(items().isEmpty())
    }

    @Test fun managerPersistsEvenEmptyNotificationBeforeEarlyDropWithoutAcquisition() {
        org.robolectric.Shadows.shadowOf(context as android.app.Application)
            .grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        val events = ArrayList<Pair<String, Map<String, Any?>>>()
        val manager = JCVitalV8Manager(context) { name, payload -> events.add(name to payload) }
        val notification = JCVitalV8Manager::class.java.getDeclaredMethod("handleNotification", ByteArray::class.java)
            .apply { isAccessible = true }
        try {
            notification.invoke(manager, byteArrayOf())
            assertTrue(events.any { it.first == "sourceJournalOutcome" && it.second["status"] == "DISABLED_NO_SCOPE" })
            manager.sourceJournal.configure(account, device, true, null, null, null)
            notification.invoke(manager, byteArrayOf())
            val result = manager.sourceJournal.list(account, device, 0, 10, true)["envelopes"] as List<*>
            assertEquals(1, result.size)
            assertEquals("BLE_NOTIFICATION", (result.single() as Map<*, *>)["kind"])
            assertEquals("", (result.single() as Map<*, *>)["rawBytesBase64"])
        } finally { manager.release() }
    }

    @Test fun managerFailureBlocksSdkParsingAndNewCommands() {
        org.robolectric.Shadows.shadowOf(context as android.app.Application)
            .grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        val manager = JCVitalV8Manager(context) { _, _ -> }
        val notification = JCVitalV8Manager::class.java.getDeclaredMethod("handleNotification", ByteArray::class.java)
            .apply { isAccessible = true }
        try {
            manager.sourceJournal.configure(account, device, true, null, 1, null)
            notification.invoke(manager, byteArrayOf())
            // Capacity exhausted: packet cannot enter SDK or normalizer.
            notification.invoke(manager, byteArrayOf(0x07, 1, 1, 0, 0))
            assertTrue(manager.sourceJournal.hasFailedClosed())
            assertEquals(1, (manager.sourceJournal.list(account, device, 0, 10)["envelopes"] as List<*>).size)
            var error: JCVitalV8Exception? = null
            manager.startRealtime(5) { _, failure -> error = failure }
            assertEquals("JOURNAL_FAILED_CLOSED", error?.message)
        } finally { manager.release() }
    }

    @Test fun everyRepeatedOccurrenceHasSeparateRecordIdentityAndSharedCallback() {
        configure()
        val same = record()
        val first = journal.appendCallback(vendor(listOf(same, same)), received, "Asia/Kolkata", null)
        val second = journal.appendCallback(vendor(listOf(same)), received, "Asia/Kolkata", null)
        assertEquals(2, first.recordIds.size)
        assertEquals(3, (first.recordIds + second.recordIds).toSet().size)
        assertNotEquals(first.callbackId, second.callbackId)
        assertEquals(5, items().size)
        assertEquals(first.callbackId, items().single { it["envelopeId"] == first.callbackId }["callbackId"])
        val envelope = JSONObject(journal.read(account, device, first.recordIds[0])["envelopeJson"] as String)
        assertEquals(first.callbackId, envelope.getString("callbackId"))
        assertEquals("VALID", envelope.getString("sourceDateParseStatus"))
        assertEquals("2026.10.04 12:00:00", envelope.getString("sourceDate"))
        assertEquals("Asia/Kolkata", envelope.getString("timezone"))
        assertTrue(envelope.getJSONObject("sdkSnapshot").toString().contains("\"type\":\"int[]\""))
        assertTrue(envelope.getJSONArray("lexicalArrays").toString().contains("INVALID_INT32"))
    }

    @Test fun callbackTransactionRollsBackAllRowsAndFailsClosedOnPressure() {
        configure(maxEnvelopes = 2)
        assertEquals("STORAGE_PRESSURE", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.appendCallback(vendor(listOf(record(), record())), received, "UTC", null)
        }.reason)
        assertTrue(items().isEmpty())
        assertTrue(journal.diagnostics(account, device)["failedClosed"] as Boolean)
        assertEquals("JOURNAL_FAILED_CLOSED", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.appendRaw(byteArrayOf(7), received, "UTC")
        }.reason)
        assertEquals("JOURNAL_RECOVERY_RETAINED_SCOPE_MISSING", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            configure(maxEnvelopes = 10)
        }.reason)
        assertTrue(journal.hasFailedClosed())
    }

    @Test fun unsupportedInputsAreExplicitNotToStringSnapshots() {
        configure()
        assertTrue(assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.appendCallback(vendor(listOf(mapOf("unsupported" to Any()))), received, "UTC", null)
        }.reason.startsWith("UNSUPPORTED_OBJECT"))
        assertTrue(items().isEmpty())
    }

    @Test fun oversizedInputsAreExplicitAndFailClosed() {
        configure()
        assertEquals("ENTRY_TOO_LARGE", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.appendRaw(ByteArray(100001), received, "UTC")
        }.reason)
        assertTrue(items().isEmpty())
    }

    @Test fun recoveredPressureRetainsFailureHistoryAndRefusedCount() {
        configure(maxEnvelopes = 1)
        journal.appendRaw(byteArrayOf(1), received, "UTC")
        assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.appendRaw(byteArrayOf(2), received, "UTC")
        }
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        val diagnostics = journal.diagnostics(null, null)
        assertEquals("STORAGE_PRESSURE", diagnostics["lastOutcome"])
        assertEquals(1L, diagnostics["refusedCount"])
        assertTrue(diagnostics["failedClosed"] as Boolean)
        assertFalse(diagnostics["enabled"] as Boolean)
        grantRecoveryHeadroom()
        configure(maxEnvelopes = 100)
        assertFalse(journal.diagnostics(account, device)["failedClosed"] as Boolean)
        assertEquals("STORAGE_PRESSURE", journal.diagnostics(account, device)["lastFailure"])
        assertEquals(1L, journal.diagnostics(account, device)["refusedCount"])
        journal.appendRaw(byteArrayOf(3), received, "UTC")
    }

    @Test fun exactType42AndTypedArrayPositionsExportAfterRestart() {
        configure()
        journal.setDeviceContext("0.0.8.8", "HISTORICAL_SYNC", "sync-42")
        val row = linkedMapOf<String, Any?>(
            "date" to "2026.10.04 12:00:00", "hrv" to "00", "vascularAging" to "003",
            "heartRate" to "060", "stress" to "07", "highBP" to "120", "lowBP" to "080",
        )
        val capture = journal.appendCallback(vendor(listOf(row), "42"), received, "UTC", null)
        val arrayCapture = journal.appendCallback(vendor(listOf(mapOf("slots" to listOf(0, null, "bad", 0, "01"))), "127"), received, "UTC", null)
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        configure()
        val exported = items(true).single { it["envelopeId"] == capture.recordIds.single() }
        val envelope = JSONObject(exported["envelopeJson"] as String)
        assertEquals(JCVitalV8SourceSnapshot.encode(row, 100000), envelope.getJSONObject("sdkSnapshot").toString())
        assertEquals(account, envelope.getString("accountId"))
        assertEquals(device, envelope.getString("deviceScopeId"))
        assertEquals("HISTORICAL_SYNC", envelope.getString("acquisitionMode"))
        assertEquals(capture.callbackId, envelope.getString("sourceRecordGroupId"))
        assertEquals(capture.recordIds.single(), envelope.getString("sourceRecordId"))
        assertEquals("2026-10-04T12:00:00.000Z", envelope.getString("observedAt"))
        assertTrue(envelope.getBoolean("vendorDerived"))
        assertEquals("UNKNOWN_VENDOR_SEMANTICS", envelope.getString("semanticConfidence"))
        val arrays = JSONObject(journal.read(account, device, arrayCapture.recordIds.single())["envelopeJson"] as String)
            .getJSONArray("sourceArrays").getJSONObject(0)
        assertEquals(5, arrays.getInt("sourceLength"))
        val slots = arrays.getJSONArray("slots")
        assertEquals(5, slots.length())
        assertEquals("NULL", slots.getJSONObject(1).getString("parseStatus"))
        assertEquals("INVALID_INT32", slots.getJSONObject(2).getString("parseStatus"))
        assertEquals("0", slots.getJSONObject(3).getJSONObject("originalValue").getString("value"))
        for (index in 0 until slots.length()) assertEquals(index, slots.getJSONObject(index).getInt("sourceIndex"))
    }

    @Test fun scalarAckPurgeInSeparateQueueDatabaseNeverDeletesSourceEnvelopes() {
        configure()
        val capture = journal.appendCallback(vendor(listOf(record())), received, "UTC", null)
        val queue = context.openOrCreateDatabase("elite-plus-observation-queueSQLite.db", Context.MODE_PRIVATE, null)
        try {
            queue.execSQL("CREATE TABLE IF NOT EXISTS observation_queue(observation_id TEXT,state TEXT,source_envelope_id TEXT)")
            queue.execSQL("INSERT INTO observation_queue VALUES(?, 'PENDING', ?)", arrayOf("scalar-id", capture.recordIds.single()))
            queue.execSQL("UPDATE observation_queue SET state='ACKNOWLEDGED' WHERE observation_id='scalar-id'")
            queue.execSQL("DELETE FROM observation_queue WHERE state='ACKNOWLEDGED'")
            assertEquals(capture.recordIds.single(), journal.read(account, device, capture.recordIds.single())["envelopeId"])
            journal.close()
            journal = JCVitalV8SourceJournal(context)
            configure()
            assertEquals(2, items(true).size)
        } finally {
            queue.close()
            context.deleteDatabase("elite-plus-observation-queueSQLite.db")
        }
    }

    @Test fun scopeDisableAndSwitchTerminateContextsAndStaleCallbacksAreSurfaced() {
        org.robolectric.Shadows.shadowOf(context as android.app.Application)
            .grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        val events = ArrayList<Pair<String, Map<String, Any?>>>()
        val manager = JCVitalV8Manager(context) { name, payload -> events.add(name to payload) }
        fun configureManager(owner: String?, scope: String?, enabled: Boolean) {
            var failure: Throwable? = null
            manager.configureSourceJournal(owner, scope, enabled, null, null, null) { _, error -> failure = error }
            assertNull(failure)
        }
        val realtime = JCVitalV8Manager::class.java.getDeclaredField("realtimeSessionId").apply { isAccessible = true }
        try {
            configureManager(account, device, true)
            realtime.set(manager, "prior-session")
            configureManager("account-B", "device-B", true)
            assertNull(realtime.get(manager))
            realtime.set(manager, "session-B")
            configureManager(null, null, false)
            assertNull(realtime.get(manager))
            val callback = JCVitalV8Manager::class.java.getDeclaredField("gattCallback").apply { isAccessible = true }
                .get(manager) as android.bluetooth.BluetoothGattCallback
            val oldGatt = org.robolectric.util.ReflectionHelpers.newInstance(android.bluetooth.BluetoothGatt::class.java)
            val characteristic = android.bluetooth.BluetoothGattCharacteristic(java.util.UUID.randomUUID(), 0, 0)
            @Suppress("DEPRECATION")
            characteristic.value = byteArrayOf(1)
            @Suppress("DEPRECATION")
            callback.onCharacteristicChanged(oldGatt, characteristic)
            org.robolectric.Shadows.shadowOf(android.os.Looper.getMainLooper()).idle()
            assertTrue(events.any { it.first == "sourceJournalOutcome" && it.second["operation"] == "STALE_BLE_CALLBACK" })
            var connectError: JCVitalV8Exception? = null
            manager.connect("00:11:22:33:44:55") { connectError = it }
            assertEquals(JCVitalV8ErrorCode.BLUETOOTH_UNAVAILABLE, connectError?.code)
            manager.startRealtime(5) { _, error -> connectError = error }
            assertEquals("SCOPE_NOT_CONFIGURED", connectError?.message)
        } finally { manager.release() }
    }

    @Test fun partialParserOutcomesAndWireChecksumsRemainRecoverable() {
        configure()
        journal.setDeviceContext("fw", "HISTORICAL_SYNC", "sync", "fff7", 247, 1234)
        val raw = journal.appendRaw(byteArrayOf(1, 2, 3), received, "UTC")
        journal.appendCallback(vendor(listOf(record())), received, "UTC", raw)
        journal.appendParserOutcome(raw, "PARTIAL_PARSE_ERROR", 1, "java.lang.IllegalArgumentException", received, "UTC")
        val wire = JSONObject(journal.read(account, device, raw)["envelopeJson"] as String)
        assertEquals(64, wire.getString("sha256").length)
        assertEquals(247, wire.getInt("negotiatedMtu"))
        assertEquals(1234L, wire.getLong("receivedMonotonicMillis"))
        assertEquals(account, wire.getString("accountId"))
        assertFalse(wire.has("transportDeviceId"))
        val outcome = items(true).single { it["kind"] == "SDK_PARSE_OUTCOME" }
        assertEquals("PARTIAL_PARSE_ERROR", JSONObject(outcome["envelopeJson"] as String).getString("status"))
        assertEquals(4, items().size)
    }

    @Test fun crossThreadCallbacksHaveUniqueTransactionalSequences() {
        configure()
        val failures = java.util.concurrent.ConcurrentLinkedQueue<Exception>()
        val threads = List(3) {
            Thread {
                try { repeat(3) { journal.appendCallback(vendor(listOf(record())), received, "UTC", null) } }
                catch (error: Exception) { failures.add(error) }
            }
        }
        threads.forEach { it.start() }
        threads.forEach { it.join() }
        assertTrue(failures.isEmpty())
        val rows = items()
        assertEquals(18, rows.size)
        assertEquals(18, rows.map { it["sequence"] }.toSet().size)
    }

    @Test fun rawNotificationAndByteCallbackSurviveReopenAndOwnerMismatchCannotRead() {
        configure()
        val bytes = byteArrayOf(0, -128, 127, -1)
        val notification = journal.appendRaw(bytes, received, "UTC")
        val callback = journal.appendRaw(bytes, received, "UTC", notification, "SDK_BYTE_CALLBACK")
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        assertFalse(journal.captureEnabled())
        configure()
        val read = journal.read(account, device, callback)
        assertArrayEquals(bytes, Base64.decode(read["rawBytesBase64"] as String, Base64.NO_WRAP))
        assertEquals(notification, JSONObject(read["envelopeJson"] as String).getString("parentEnvelopeId"))
        assertEquals("OWNER_MISMATCH", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.read("account-B", device, notification)
        }.reason)
        assertEquals("OWNER_MISMATCH", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.list(account, "device-B", 0, 10)
        }.reason)
    }

    @Test fun ownerSwitchDoesNotEvictOrExposeOtherOwners() {
        configure()
        val id = journal.appendRaw(byteArrayOf(42), received, "UTC")
        journal.configure("account-B", "device-B", true, null, null, null)
        assertTrue((journal.list("account-B", "device-B", 0, 10)["envelopes"] as List<*>).isEmpty())
        assertEquals(0L, journal.diagnostics("account-B", "device-B")["totalEnvelopeCount"])
        assertEquals("ENVELOPE_NOT_FOUND", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.read("account-B", "device-B", id)
        }.reason)
        configure()
        assertEquals(id, journal.read(account, device, id)["envelopeId"])
    }

    @Test fun nullCallbacksAndUnknownDataAreRecordedWithoutNormalization() {
        configure()
        val nullCapture = journal.appendCallback(null, received, "UTC", null)
        assertTrue(JSONObject(journal.read(account, device, nullCapture.callbackId)["envelopeJson"] as String).isNull("sdkSnapshot"))
        val unknown = journal.appendCallback(vendor(listOf(null, 0, intArrayOf(1, 2)), "UNKNOWN"), received, "UTC", null)
        assertEquals(3, unknown.recordIds.size)
        assertEquals(6, items().size)
    }

    @Test fun listAndExportUseStableBoundedCursorWithoutPurging() {
        configure()
        repeat(5) { journal.appendRaw(byteArrayOf(it.toByte()), received + it, "UTC") }
        val first = journal.list(account, device, 0, 2, true)
        assertTrue(first["hasMore"] as Boolean)
        assertEquals(2, (first["envelopes"] as List<*>).size)
        val second = items(true, first["nextSequence"] as Long, 2)
        assertEquals(2, second.size)
        assertNotEquals((first["envelopes"] as List<*>).first(), second.first())
        assertEquals(5, items().size)
    }

    @Test fun exportCursorIntegerFlowsFromCapacitorCallThroughParserIntoJournalQuery() {
        configure()
        repeat(250) { journal.appendRaw(byteArrayOf(it.toByte()), received + it, "UTC") }
        val call = PluginCall(
            null, "JCVitalV8", "test", "exportSourceJournal",
            JSObject().put("afterSequence", 100).put("limit", 100),
        )

        assertNull(call.getLong("afterSequence"))
        val afterSequence = JCVitalV8JournalArguments.afterSequence(call)
        val limit = JCVitalV8JournalArguments.limit(call)
        val result = journal.list(account, device, afterSequence, limit, includePayload = true)
        val rows = result["envelopes"] as List<Map<String, Any?>>

        assertEquals(100L, afterSequence)
        assertEquals(100, limit)
        assertEquals((101L..200L).toList(), rows.map { it["sequence"] as Long })
        assertEquals(200L, result["nextSequence"])
        assertEquals(true, result["hasMore"])
        assertNotNull(rows.first()["envelopeJson"])
    }

    @Test fun exportCursorParserAcceptsIntegralNumbersAndRejectsInvalidValues() {
        fun call(value: Any) = PluginCall(
            null, "JCVitalV8", "test", "exportSourceJournal",
            JSObject().put("afterSequence", value),
        )

        assertEquals(100L, JCVitalV8JournalArguments.afterSequence(call(100)))
        assertEquals(100L, JCVitalV8JournalArguments.afterSequence(call(100L)))
        assertEquals(100L, JCVitalV8JournalArguments.afterSequence(call(100.0)))
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8JournalArguments.afterSequence(call(100.5))
        }
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8JournalArguments.afterSequence(call(-1))
        }
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8JournalArguments.afterSequence(call(Long.MAX_VALUE.toString() + "0"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8JournalArguments.afterSequence(call("100"))
        }
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8JournalArguments.afterSequence(call(JSONObject.NULL))
        }
        fun limitCall(value: Any) = PluginCall(
            null, "JCVitalV8", "test", "exportSourceJournal",
            JSObject().put("limit", value),
        )
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8JournalArguments.limit(limitCall(0))
        }
        assertThrows(IllegalArgumentException::class.java) {
            JCVitalV8JournalArguments.limit(limitCall(101))
        }
    }

    @Test fun sourceJournalPaginationUsesExclusiveLastSequenceCursorAndRetainsTerminalCursor() {
        configure()
        val empty = journal.list(account, device, 0, 2, true)
        assertTrue((empty["envelopes"] as List<*>).isEmpty())
        assertEquals(0L, empty["nextSequence"])
        assertEquals(false, empty["hasMore"])

        repeat(5) { journal.appendRaw(byteArrayOf(it.toByte()), received + it, "UTC") }
        val first = journal.list(account, device, 0, 2, true)
        val firstRecords = first["envelopes"] as List<*>
        val firstSequences = firstRecords.map { (it as Map<*, *>)["sequence"] as Long }
        assertEquals(firstSequences.sorted(), firstSequences)
        assertTrue(first["hasMore"] as Boolean)
        assertEquals(firstSequences.last(), first["nextSequence"])
        assertTrue(firstRecords.all { (it as Map<*, *>)["envelopeJson"] is String })

        val second = journal.list(account, device, first["nextSequence"] as Long, 2, true)
        val secondRecords = second["envelopes"] as List<*>
        val secondSequences = secondRecords.map { (it as Map<*, *>)["sequence"] as Long }
        assertEquals(2, secondRecords.size)
        assertTrue(second["hasMore"] as Boolean)
        assertTrue(secondSequences.first() > firstSequences.last())
        assertEquals(secondSequences.last(), second["nextSequence"])

        val final = journal.list(account, device, second["nextSequence"] as Long, 2, true)
        val finalRecords = final["envelopes"] as List<*>
        val finalSequence = (finalRecords.single() as Map<*, *>)["sequence"]
        assertEquals(1, finalRecords.size)
        assertEquals(false, final["hasMore"])
        assertEquals(finalSequence, final["nextSequence"])

        val terminal = journal.list(account, device, final["nextSequence"] as Long, 2, true)
        assertTrue((terminal["envelopes"] as List<*>).isEmpty())
        assertEquals(final["nextSequence"], terminal["nextSequence"])
        assertEquals(false, terminal["hasMore"])

        val exactBoundary = journal.list(account, device, 0, 5, true)
        assertEquals(5, (exactBoundary["envelopes"] as List<*>).size)
        assertEquals(false, exactBoundary["hasMore"])
        assertEquals(final["nextSequence"], exactBoundary["nextSequence"])
    }

    @Test fun fileManifestIsDurableOwnerScopedAndReservationsAreBounded() {
        configure(maxBytes = 10000)
        val store = RawPpgPacketStore.create(context.filesDir, "test-session")
        val id = journal.registerFile(store.file, "test-session", "PPG_LENGTH_PREFIXED_V1")
        journal.reserveFileBytes(store.file.absolutePath, 7)
        store.appendChunk(listOf(byteArrayOf(1, 2, 3)), emptyMap())
        store.close()
        val file = journal.read(account, device, id)["sourceFile"] as Map<*, *>
        assertEquals(15L, file["actualBytes"])
        assertEquals(15L, file["reservedBytes"])
        assertEquals("RAW_SESSION_FILE", JSONObject(journal.read(account, device, id)["envelopeJson"] as String).getString("kind"))
        assertEquals("STORAGE_PRESSURE", assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            journal.reserveFileBytes(store.file.absolutePath, 10000)
        }.reason)
        assertEquals(15L, store.file.length())
    }

    @Test fun type42SiblingsLinkToTheirExactSourceOccurrenceWithoutChangingScalarIds() {
        configure()
        val row = linkedMapOf<String, Any?>(
            DeviceKey.Date to "2026.10.04 12:00:00", DeviceKey.HRV to "0",
            DeviceKey.Stress to "7", DeviceKey.HeartRate to "60",
        )
        val callback = vendor(listOf(row, row), BleConst.GetHRVData)
        val capture = journal.appendCallback(callback, received, "UTC", null)
        val normalizer = JCVitalV8EventNormalizer()
        val context = JCVitalV8EventNormalizer.Context("device", "firmware", "session", received, "UTC")
        val baseline = normalizer.normalize(callback, context).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }
        val linked = normalizer.normalize(callback, context.copy(
            sourceCallbackId = capture.callbackId, sourceRecordEnvelopeIds = capture.recordIds,
        )).filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }
        assertEquals(baseline.map { it.payload["id"] }, linked.map { it.payload["id"] })
        assertTrue(linked.isNotEmpty())
        val grouped = linked.groupBy { (it.payload["provenance"] as Map<*, *>)["sourceEnvelopeId"] }
        assertEquals(capture.recordIds.toSet(), grouped.keys)
        assertEquals(grouped[capture.recordIds[0]]!!.size, grouped[capture.recordIds[1]]!!.size)
    }

    @Test fun safeTestHrFilteringAndChunkAcknowledgementDoNotRemoveSourceOccurrences() {
        configure()
        val row = record("60,0,bad,70,80")
        val callback = vendor(listOf(row, row, record("0,0,0")))
        val capture = journal.appendCallback(callback, received, "UTC", null)
        val chunks = ArrayList<Map<String, Any?>>()
        val stream = JCVitalV8HistoricalHrStream("sync", 2, JCVitalV8EventNormalizer(), { chunks.add(it) })
        assertFalse(stream.acceptPacket(callback, JCVitalV8EventNormalizer.Context(
            "device", "firmware", "sync", received, "UTC", sourceCallbackId = capture.callbackId,
            sourceRecordEnvelopeIds = capture.recordIds,
        )))
        stream.completeAcquisition()
        stream.emitNextChunk()
        assertEquals(listOf(capture.recordIds[0]), chunks.single()["sourceEnvelopeIds"])
        val samples = chunks.single()["observations"] as List<*>
        assertEquals(listOf(60, 70), samples.map { (it as Map<*, *>)["value"] })
        assertEquals(4, items().size)
        capture.recordIds.forEach { assertEquals(it, journal.read(account, device, it)["envelopeId"]) }
    }
}
