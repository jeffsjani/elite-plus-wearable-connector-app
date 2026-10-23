package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class JCVitalV8OfflineJournalInspectorTest {
    private lateinit var context: Context
    private val received = 1_800_000_000_000L
    private val dbName = "jcvital-source-envelope-v1.db"
    private val prefsName = "jcvital-source-journal-outcomes-v1"
    private fun prefs() = context.getSharedPreferences(prefsName, Context.MODE_PRIVATE)
    private fun dbFile() = context.getDatabasePath(dbName)

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        prefs().edit().clear().commit()
        context.deleteDatabase(dbName)
    }
    @After fun cleanup() {
        context.deleteDatabase(dbName)
        File(context.filesDir, "jcvital-source-spool").deleteRecursively()
    }

    /** Builds a retained database through the real journal, then latches failed-closed and closes it. */
    private fun seedFailedClosedDatabase() {
        val journal = JCVitalV8SourceJournal(context)
        journal.configure("account-A", "opaque-device-A", true, 2_000_000, 1000, 100_000)
        journal.setDeviceContext("test", "RAW_PPG", "ppg-session")
        journal.appendRaw(byteArrayOf(1, 2, 3), received, "UTC")
        journal.appendRaw(byteArrayOf(1, 2, 3), received, "UTC")
        journal.appendCallback(linkedMapOf<String, Any?>(DeviceKey.DataType to "27", DeviceKey.End to false,
            DeviceKey.Data to listOf(mapOf("a" to 1))), received, "UTC", null)
        val file = File(context.filesDir, "inspector-test.bin")
        file.writeBytes(byteArrayOf(4, 5))
        journal.registerFile(file, "ppg-session", "RAW_PPG")
        journal.reserveFileBytes(file.absolutePath, 100)
        journal.failClosed("STORAGE_PRESSURE")
        journal.close()
    }

    @Suppress("UNCHECKED_CAST")
    private fun Map<String, Any?>.map(key: String) = this[key] as Map<String, Any?>

    @Test fun missingDatabaseReturnsNotFoundAndIsNotCreated() {
        val result = JCVitalV8OfflineJournalInspector(context).inspect()
        assertEquals("JOURNAL_DATABASE_NOT_FOUND", result["status"])
        assertEquals(false, result["databaseExists"])
        assertEquals(false, result["openedReadOnly"])
        assertEquals(result.toString(), false, result["mutationDetected"])
        assertFalse(dbFile().exists())
        assertFalse(File(dbFile().path + "-wal").exists())
        assertFalse(File(dbFile().path + "-journal").exists())
    }

    @Test fun existingFailedClosedDatabaseOpensReadOnlyWithoutMutation() {
        seedFailedClosedDatabase()
        val prefsBefore = prefs().all.toMap()
        assertEquals(true, prefs().getBoolean("failedClosed", false))
        val sizeBefore = dbFile().length()

        val result = JCVitalV8OfflineJournalInspector(context).inspect()

        assertEquals(result.toString(), "OK", result["status"])
        assertEquals(true, result["databaseExists"])
        assertEquals(true, result["openedReadOnly"])
        assertEquals("JOURNAL_FAILED_CLOSED", result["normalJournalState"])
        assertEquals(true, result["failedClosedAtStartup"])
        assertEquals(result.toString(), false, result["mutationDetected"])
        assertEquals(emptyList<String>(), result["mutatedFields"])
        assertEquals(true, result["beforeEqualsAfter"])
        val before = result.map("before"); val after = result.map("after")
        assertEquals(before, after)
        for (key in listOf("dbFileSizeBytes", "dbFileSha256", "walFileSizeBytes", "walFileSha256", "journalTotalsEnvelopes",
            "journalTotalsBytes", "maxSequence", "envelopeCount", "sourceFileCount", "failedClosedPreference",
            "lastFailurePreference")) {
            assertTrue("missing $key", before.containsKey(key))
            assertEquals(key, before[key], after[key])
        }
        assertEquals(5L, before["envelopeCount"])
        assertEquals(5L, before["journalTotalsEnvelopes"])
        assertEquals(1L, before["sourceFileCount"])
        assertEquals(5L, before["maxSequence"])
        assertEquals(true, before["failedClosedPreference"])
        assertEquals("STORAGE_PRESSURE", before["lastFailurePreference"])
        // Independent verification outside the inspector.
        assertEquals(sizeBefore, dbFile().length())
        assertEquals(prefsBefore, prefs().all.toMap())
        val analysis = result.map("analysis")
        assertEquals(5L, analysis["globalEnvelopeCount"])
        assertEquals(true, analysis["readOnly"])
        assertEquals(true, analysis["accountingMatches"])
        assertEquals("RECONCILED", analysis["reconciliationStatus"])
        assertEquals(102L, analysis["reservedSourceFileBytes"])
    }

    @Test fun missingOptionalCertificationTablesAreSkippedAndNotCreated() {
        seedFailedClosedDatabase()
        SQLiteDatabase.openDatabase(dbFile().path, null, SQLiteDatabase.OPEN_READWRITE).use { db ->
            db.execSQL("DROP TABLE ppg_certification_chunks")
            db.execSQL("DROP TABLE workout_certification_chunks")
            db.execSQL("DROP TABLE sleep_certification_chunks")
        }
        val result = JCVitalV8OfflineJournalInspector(context).inspect()
        assertEquals(result.toString(), "OK", result["status"])
        assertEquals(result.toString(), false, result["mutationDetected"])
        assertEquals(5L, result.map("analysis")["globalEnvelopeCount"])
        SQLiteDatabase.openDatabase(dbFile().path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
            db.rawQuery("SELECT COUNT(*) FROM sqlite_master WHERE name IN ('ppg_certification_chunks','workout_certification_chunks','sleep_certification_chunks')", null)
                .use { it.moveToFirst(); assertEquals(0L, it.getLong(0)) }
        }
    }

    @Test fun repeatedInspectionsLeaveDatabaseFileByteIdentical() {
        seedFailedClosedDatabase()
        val inspector = JCVitalV8OfflineJournalInspector(context)
        val first = inspector.inspect().map("after")
        val second = inspector.inspect().map("after")
        assertEquals(first["dbFileSha256"], second["dbFileSha256"])
        assertEquals(first["walFileSha256"], second["walFileSha256"])
    }
}
