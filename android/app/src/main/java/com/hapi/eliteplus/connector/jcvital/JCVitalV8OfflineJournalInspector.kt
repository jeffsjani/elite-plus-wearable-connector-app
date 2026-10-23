package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import java.io.File
import java.security.MessageDigest

/**
 * Build 32B.8: independent, SELECT-only inspector of the retained Source Journal database.
 * It never uses JCVitalV8SourceJournal's helper (no configure/open/bind, no schema creation, no latch changes)
 * and never creates the database file. Needs no Bluetooth or account scope.
 */
internal class JCVitalV8OfflineJournalInspector(context: Context) {
    private val appContext = context.applicationContext
    private val dbFile: File = appContext.getDatabasePath(DB_NAME)
    private val prefsFile = File(File(appContext.applicationInfo.dataDir, "shared_prefs"), "$PREFS_NAME.xml")

    fun inspect(): Map<String, Any?> {
        val exists = dbFile.isFile
        val prefs = appContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)
        val failedClosed = prefs.getBoolean("failedClosed", false)
        val analysisMaxBytes = prefs.getLong("maxBytes", LEGACY_MAX_BYTES)
        val result = linkedMapOf<String, Any?>(
            "schema" to "offline-journal-inspection/1",
            "databasePath" to dbFile.absolutePath,
            "databaseExists" to exists,
            "openedReadOnly" to false,
            "normalJournalState" to if (failedClosed) "JOURNAL_FAILED_CLOSED" else "NOT_FAILED_CLOSED_NORMAL_OPEN_NOT_ATTEMPTED_BY_INSPECTOR",
            "failedClosedAtStartup" to failedClosed,
            "mutationDetected" to false,
            "status" to if (exists) "OK" else "JOURNAL_DATABASE_NOT_FOUND",
            "bluetoothRequired" to false,
            "analysisMaxBytesAssumption" to if (prefs.contains("maxBytes")) "PERSISTED_CONFIGURED_LIMIT" else "LEGACY_64_MIB_LIMIT",
        )
        if (!exists) return result
        return try {
            val before = snapshot(prefs)
            val analysis = openReadOnly().use { db ->
                result["openedReadOnly"] = db.isReadOnly
                JCVitalV8SourceJournal.CapacityAnalyzer.analyze(db, System.currentTimeMillis(), failedClosed,
                    prefs.getString("lastFailure", null), analysisMaxBytes)
            }
            val after = snapshot(prefs)
            val differing = before.keys.filter { before[it] != after[it] }
            result["mutationDetected"] = differing.isNotEmpty()
            result["mutatedFields"] = differing
            result["before"] = before
            result["after"] = after
            result["beforeEqualsAfter"] = differing.isEmpty()
            val shm = File(dbFile.path + "-shm")
            result["shmFileSizeBytesInformational"] = if (shm.exists()) shm.length() else 0L
            result["hashNote"] = "Main DB and -wal files are SHA-256 hashed (an absent and a zero-byte -wal are equivalent). The -shm index is excluded from equality " +
                "(a read-only WAL reader may legitimately create or touch it); only its size is reported."
            result["analysis"] = analysis
            result
        } catch (error: Exception) {
            result["status"] = "INSPECTION_FAILED"
            result["errorCode"] = error.javaClass.simpleName
            result["errorMessage"] = error.message
            result
        }
    }

    private fun openReadOnly(): SQLiteDatabase =
        SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY)

    /** Each snapshot uses and closes its own read-only handle. */
    private fun snapshot(prefs: android.content.SharedPreferences): Map<String, Any?> {
        val values = linkedMapOf<String, Any?>()
        val wal = File(dbFile.path + "-wal")
        values["dbFileSizeBytes"] = dbFile.length()
        values["dbFileSha256"] = sha256(dbFile)
        values["walFileSizeBytes"] = if (wal.exists()) wal.length() else 0L
        // A read-only open of a WAL database may materialize a zero-byte -wal; that carries no content change.
        values["walFileSha256"] = if (wal.exists() && wal.length() > 0) sha256(wal) else "EMPTY_OR_ABSENT"
        openReadOnly().use { db ->
            db.rawQuery("SELECT envelopes,bytes FROM journal_totals WHERE singleton=1", null).use {
                if (it.moveToFirst()) {
                    values["journalTotalsEnvelopes"] = it.getLong(0); values["journalTotalsBytes"] = it.getLong(1)
                } else {
                    values["journalTotalsEnvelopes"] = null; values["journalTotalsBytes"] = null
                }
            }
            values["maxSequence"] = db.rawQuery("SELECT MAX(sequence) FROM envelopes", null).use {
                it.moveToFirst(); if (it.isNull(0)) null else it.getLong(0)
            }
            values["envelopeCount"] = db.rawQuery("SELECT COUNT(*) FROM envelopes", null).use { it.moveToFirst(); it.getLong(0) }
            values["sourceFileCount"] = db.rawQuery("SELECT COUNT(*) FROM source_files", null).use { it.moveToFirst(); it.getLong(0) }
        }
        values["failedClosedPreference"] = prefs.getBoolean("failedClosed", false)
        values["lastFailurePreference"] = prefs.getString("lastFailure", null)
        values["lastOutcomePreference"] = prefs.getString("lastOutcome", null)
        values["refusedCountPreference"] = prefs.getLong("refusedCount", 0)
        values["prefsFileSizeBytes"] = if (prefsFile.exists()) prefsFile.length() else 0L
        return values
    }

    private fun sha256(file: File): String {
        val digest = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(buffer)
                if (read < 0) break
                digest.update(buffer, 0, read)
            }
        }
        return digest.digest().joinToString("") { "%02x".format(it) }
    }

    private companion object {
        const val DB_NAME = "jcvital-source-envelope-v1.db"
        const val PREFS_NAME = "jcvital-source-journal-outcomes-v1"
        const val LEGACY_MAX_BYTES = 64L * 1024 * 1024
    }
}
