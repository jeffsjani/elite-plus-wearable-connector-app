package com.hapi.eliteplus.connector.jcvital

import android.content.ContentValues
import android.content.Context
import android.database.sqlite.SQLiteDatabase
import android.database.sqlite.SQLiteOpenHelper
import android.os.StatFs
import android.util.Base64
import com.jstyle.blesdkv8.constant.DeviceKey
import org.json.JSONArray
import org.json.JSONObject
import java.util.UUID

/** Independent, append-only L0 journal. Scalar acknowledgement never touches this database. */
internal class JCVitalV8SourceJournal(context: Context) : SQLiteOpenHelper(
    context.applicationContext, "jcvital-source-envelope-v1.db", null, 1,
) {
    private val outcomePrefs = context.applicationContext.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE)
    private val appContext = context.applicationContext
    data class Scope(val accountId: String, val deviceScopeId: String)
    data class Capture(val callbackId: String, val recordIds: List<String>, val receivedMillis: Long, val timezone: String,
        val snapshotBytes: Int = 0)
    class Failure(val reason: String, cause: Exception? = null) : IllegalStateException(reason, cause)
    private var scope: Scope? = null
    private var maxBytes = outcomePrefs.getLong("maxBytes", LEGACY_MAX_BYTES)
    private var maxEnvelopes = 100_000L
    private var maxEntryBytes = 1024 * 1024
    private var failed = outcomePrefs.getBoolean("failedClosed", false)
    private var refusedCount = outcomePrefs.getLong("refusedCount", 0)
    private var lastOutcome = outcomePrefs.getString("lastOutcome", "DISABLED") ?: "DISABLED"
    private var lastFailure = outcomePrefs.getString("lastFailure", null)
    private var lastFailureMessage = outcomePrefs.getString("lastFailureMessage", null)
    private var lastFailureTimestamp = outcomePrefs.getString("lastFailureTimestamp", null)
    private val failedClosedAtStartup = failed
    private var requestedScope: Scope? = null
    private var openAttempted = false
    private var openSucceeded = false
    private var openFailureCode: String? = null
    private var openFailureMessage: String? = null
    private var configuring = false
    private var openedDatabase: SQLiteDatabase? = null
    private var firmwareVersion: String? = null
    private var acquisitionMode: String? = null
    private var acquisitionSessionId: String? = null
    private var characteristicUuid: String? = null
    private var negotiatedMtu: Int? = null
    private var receivedMonotonicMillis: Long? = null
    private var requestId: String? = null
    private var connectionGeneration: Long? = null

    override fun onConfigure(db: SQLiteDatabase) {
        db.setForeignKeyConstraintsEnabled(true)
        db.execSQL("PRAGMA synchronous=FULL")
    }

    override fun onCreate(db: SQLiteDatabase) {
        db.execSQL("CREATE TABLE envelopes(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,account TEXT NOT NULL,device TEXT NOT NULL,callback_id TEXT,record_index INTEGER,kind TEXT NOT NULL,received INTEGER NOT NULL,timezone TEXT NOT NULL,json TEXT NOT NULL,raw BLOB,bytes INTEGER NOT NULL)")
        db.execSQL("CREATE INDEX envelopes_owner_sequence ON envelopes(account,device,sequence)")
        db.execSQL("CREATE TABLE source_files(id TEXT PRIMARY KEY,account TEXT NOT NULL,device TEXT NOT NULL,path TEXT NOT NULL UNIQUE,session_id TEXT NOT NULL,kind TEXT NOT NULL,bytes INTEGER NOT NULL DEFAULT 0)")
        db.execSQL("CREATE TABLE journal_totals(singleton INTEGER PRIMARY KEY CHECK(singleton=1),envelopes INTEGER NOT NULL,bytes INTEGER NOT NULL)")
        db.execSQL("INSERT INTO journal_totals VALUES(1,0,0)")
        db.execSQL("CREATE TRIGGER envelope_totals AFTER INSERT ON envelopes BEGIN UPDATE journal_totals SET envelopes=envelopes+1,bytes=bytes+new.bytes WHERE singleton=1; END")
        db.execSQL("CREATE TRIGGER file_totals_insert AFTER INSERT ON source_files BEGIN UPDATE journal_totals SET bytes=bytes+new.bytes WHERE singleton=1; END")
        db.execSQL("CREATE TRIGGER file_totals_update AFTER UPDATE OF bytes ON source_files BEGIN UPDATE journal_totals SET bytes=bytes+new.bytes-old.bytes WHERE singleton=1; END")
    }
    override fun onUpgrade(db: SQLiteDatabase, oldVersion: Int, newVersion: Int) {
        throw Failure("UNSUPPORTED_SCHEMA_UPGRADE")
    }
    override fun onOpen(db: SQLiteDatabase) {
        super.onOpen(db)
        db.execSQL("CREATE TABLE IF NOT EXISTS activity_certification_chunks(account TEXT NOT NULL,device TEXT NOT NULL,chunk_index INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(account,device,chunk_index))")
        db.execSQL("CREATE TABLE IF NOT EXISTS sleep_certification_chunks(account TEXT NOT NULL,device TEXT NOT NULL,chunk_index INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(account,device,chunk_index))")
        db.execSQL("CREATE TABLE IF NOT EXISTS workout_certification_chunks(account TEXT NOT NULL,device TEXT NOT NULL,chunk_index INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(account,device,chunk_index))")
        db.execSQL("CREATE TABLE IF NOT EXISTS workout_acquisition_claims(account TEXT NOT NULL,device TEXT NOT NULL,PRIMARY KEY(account,device))")
        db.execSQL("CREATE TABLE IF NOT EXISTS ppg_certification_chunks(account TEXT NOT NULL,device TEXT NOT NULL,chunk_index INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(account,device,chunk_index))")
        db.execSQL("CREATE TABLE IF NOT EXISTS ppg_physical_certification_chunks(account TEXT NOT NULL,device TEXT NOT NULL,chunk_index INTEGER NOT NULL,json TEXT NOT NULL,PRIMARY KEY(account,device,chunk_index))")
        db.execSQL("CREATE TABLE IF NOT EXISTS ppg_certification_attempt_claims(account TEXT NOT NULL,device TEXT NOT NULL,session_id TEXT NOT NULL,certification_group_id TEXT NOT NULL,claimed_at INTEGER NOT NULL,PRIMARY KEY(account,device))")
    }

    /**
     * VC29 one-shot Raw PPG physical certification. The claim row and the ACQUIRING snapshot are committed in a
     * single transaction BEFORE any PPG command is journaled or written, so the attempt survives restart and can
     * never be repeated for this account/device (no retry, no automatic second capture).
     */
    @Synchronized
    fun beginRawPpgCertificationAttempt(json: String) {
        val active = scope ?: throw Failure("SCOPE_NOT_CONFIGURED")
        if (failed) throw Failure("JOURNAL_FAILED_CLOSED")
        val snapshot = JSONObject(json)
        require(snapshot.getString("state") == "ACQUIRING") { "PPG_CERTIFICATION_ATTEMPT_STATE_INVALID" }
        val db = writableDatabase
        db.beginTransaction()
        try {
            if (rawPpgCertificationClaim(active.accountId, active.deviceScopeId) != null
                || readCertification(active.accountId, active.deviceScopeId, PPG_PHYSICAL_TABLE, active)["json"] != null) {
                throw Failure("PPG_CERTIFICATION_ALREADY_ATTEMPTED")
            }
            val row = ContentValues().apply {
                put("account", active.accountId); put("device", active.deviceScopeId)
                put("session_id", snapshot.getString("sessionId"))
                put("certification_group_id", snapshot.getString("certificationGroupId"))
                put("claimed_at", System.currentTimeMillis())
            }
            if (db.insertWithOnConflict("ppg_certification_attempt_claims", null, row, SQLiteDatabase.CONFLICT_IGNORE) == -1L) {
                throw Failure("PPG_CERTIFICATION_ALREADY_ATTEMPTED")
            }
            writeCertification(active.accountId, active.deviceScopeId, json, PPG_PHYSICAL_KIND, PPG_PHYSICAL_TABLE)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    /** Terminal write: only replaces the ACQUIRING snapshot of the same claimed session; final snapshots are immutable. */
    @Synchronized
    fun finalizeRawPpgCertificationAttempt(json: String): Map<String, Any?> {
        return saveRawPpgCertificationProgress(json, terminal = true)
    }

    @Synchronized
    fun checkpointRawPpgCertificationAttempt(json: String): Map<String, Any?> {
        return saveRawPpgCertificationProgress(json, terminal = false)
    }

    private fun saveRawPpgCertificationProgress(json: String, terminal: Boolean): Map<String, Any?> {
        val next = JSONObject(json)
        val nextScope = next.getJSONObject("context").getJSONObject("scope")
        val owner = Scope(nextScope.getString("accountId"), nextScope.getString("deviceScopeId"))
        require(if (terminal) next.getString("state") in setOf("CERTIFIED", "NOT_CERTIFIED")
            else next.getString("state") == "ACQUIRING") { "PPG_CERTIFICATION_STATE_INVALID" }
        val claim = rawPpgCertificationClaim(owner.accountId, owner.deviceScopeId) ?: throw Failure("PPG_CERTIFICATION_CLAIM_REQUIRED")
        val existing = readCertification(owner.accountId, owner.deviceScopeId, PPG_PHYSICAL_TABLE, owner)["json"] as? String
            ?: throw Failure("PPG_CERTIFICATION_ATTEMPT_REQUIRED")
        val acquiring = JSONObject(existing)
        require(acquiring.getString("state") == "ACQUIRING") { "PPG_CERTIFICATION_ALREADY_FINALIZED" }
        require(acquiring.getString("sessionId") == next.getString("sessionId") && claim["sessionId"] == next.getString("sessionId")
            && acquiring.getString("certificationGroupId") == next.getString("certificationGroupId")) { "PPG_CERTIFICATION_SESSION_MISMATCH" }
        return writeCertification(owner.accountId, owner.deviceScopeId, json, PPG_PHYSICAL_KIND, PPG_PHYSICAL_TABLE, owner)
    }

    @Synchronized
    fun rawPpgCertificationClaim(accountId: String, deviceScopeId: String): Map<String, Any?>? =
        readableDatabase.rawQuery("SELECT session_id,certification_group_id,claimed_at FROM ppg_certification_attempt_claims WHERE account=? AND device=?",
            arrayOf(accountId, deviceScopeId)).use { c ->
            if (!c.moveToFirst()) null else mapOf("sessionId" to c.getString(0), "certificationGroupId" to c.getString(1), "claimedAt" to c.getLong(2))
        }

    /**
     * Offline saved owner for the VC29 certification: the persisted authenticated account plus an optional opaque
     * device scope. When the device scope is unknown (e.g. disconnected), the single claimed device for the account
     * is used; ambiguity fails closed. Never requires the live capture scope, never touches BLE.
     */
    @Synchronized
    fun savedRawPpgCertificationOwner(accountId: String?, deviceScopeId: String?): Scope? {
        val (account, device) = savedPpgOwner(accountId, deviceScopeId)
        if (device != null) return Scope(account, device)
        val devices = readableDatabase.rawQuery("SELECT DISTINCT device FROM ppg_certification_attempt_claims WHERE account=?", arrayOf(account)).use { c ->
            buildList { while (c.moveToNext()) add(c.getString(0)) }
        }
        if (devices.size > 1) throw Failure("PPG_CERTIFICATION_DEVICE_SCOPE_AMBIGUOUS")
        return devices.firstOrNull()?.let { Scope(account, it) }
    }

    @Synchronized
    fun readRawPpgPhysicalCertification(accountId: String?, deviceScopeId: String?): Map<String, Any?> {
        val owner = savedRawPpgCertificationOwner(accountId, deviceScopeId)
            ?: return mapOf("json" to null, "claim" to null, "deviceScopeId" to null)
        return mapOf("json" to readCertification(owner.accountId, owner.deviceScopeId, PPG_PHYSICAL_TABLE, owner)["json"],
            "claim" to rawPpgCertificationClaim(owner.accountId, owner.deviceScopeId), "deviceScopeId" to owner.deviceScopeId)
    }

    @Synchronized
    fun readRawPpgCertificationEnvelope(owner: Scope, id: String): Map<String, Any?> = readOwned(owner, id)

    @Synchronized
    fun writeWorkoutCertification(accountId: String?, deviceScopeId: String?, json: String): Map<String, Any?> {
        val next = JSONObject(json)
        if (next.getString("state") == "CERTIFIED") {
            val existing = readWorkoutCertification(accountId, deviceScopeId)["json"] as? String
                ?: throw Failure("WORKOUT_SAVED_ATTEMPT_REQUIRED")
            val stopped = JSONObject(existing)
            require(stopped.getString("state") == "STOPPED"
                && next.getJSONObject("localFinalization").getJSONObject("originalStoppedSnapshot").toString() == stopped.toString()
                && next.getString("sourceStatus") == "CERTIFIED_E2E_LOSSLESS_SOURCE"
                && next.getString("diagnostic") == "VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG"
                && next.getString("canonicalAuthority") == "NONE_UNTIL_SEMANTICS_CONFIRMED"
                && next.getString("deliveryDisposition") == "LOCAL_SOURCE_EVIDENCE_ONLY") {
                "WORKOUT_STOPPED_SNAPSHOT_CHANGED_OR_FINALIZATION_INVALID"
            }
            return writeCertification(accountId, deviceScopeId, json, "WorkoutHistoryCertification",
                "workout_certification_chunks", savedWorkoutOwner(accountId, deviceScopeId))
        }
        if (next.getString("state") == "ACQUIRING") {
            require(readWorkoutCertification(accountId, deviceScopeId)["json"] == null) { "WORKOUT_CAPTURE_ALREADY_ATTEMPTED" }
        }
        return writeCertification(accountId, deviceScopeId, json, "WorkoutHistoryCertification", "workout_certification_chunks")
    }

    @Synchronized
    fun readWorkoutCertification(accountId: String?, deviceScopeId: String?): Map<String, Any?> =
        readCertification(accountId, deviceScopeId, "workout_certification_chunks", savedWorkoutOwner(accountId, deviceScopeId))

    private fun savedWorkoutOwner(accountId: String?, deviceScopeId: String?): Scope {
        require(!accountId.isNullOrBlank() && accountId.length <= 256) { "WORKOUT_ACCOUNT_REQUIRED" }
        require(deviceScopeId != null && deviceScopeId.matches(Regex("[A-Za-z0-9_-]{1,256}"))) { "WORKOUT_DEVICE_SCOPE_REQUIRED" }
        return Scope(accountId, deviceScopeId)
    }

    @Synchronized
    fun readWorkoutSourceEnvelope(accountId: String?, deviceScopeId: String?, id: String): Map<String, Any?> {
        val active = savedWorkoutOwner(accountId, deviceScopeId)
        val saved = readWorkoutCertification(accountId, deviceScopeId)["json"] as? String
            ?: throw Failure("WORKOUT_SAVED_ATTEMPT_REQUIRED")
        val session = JSONObject(saved).getJSONObject("acquisition").getString("syncId")
        val entry = readOwned(active, id)
        val envelope = JSONObject(entry["envelopeJson"] as String)
        require(envelope.getString("sessionId") == session && envelope.getString("acquisitionMode") == "HISTORICAL_SYNC") {
            "WORKOUT_SAVED_SESSION_MISMATCH"
        }
        return entry
    }

    @Synchronized
    fun claimWorkoutAcquisition() {
        val active = scope ?: throw Failure("SCOPE_NOT_CONFIGURED")
        val saved = readWorkoutCertification(active.accountId, active.deviceScopeId)["json"] as? String
            ?: throw Failure("WORKOUT_SAVED_ATTEMPT_REQUIRED")
        require(JSONObject(saved).getString("state") == "ACQUIRING") { "WORKOUT_CAPTURE_ALREADY_ATTEMPTED" }
        val row = ContentValues().apply { put("account", active.accountId); put("device", active.deviceScopeId) }
        if (writableDatabase.insertWithOnConflict("workout_acquisition_claims", null, row, SQLiteDatabase.CONFLICT_IGNORE) == -1L) {
            throw Failure("WORKOUT_CAPTURE_ALREADY_ATTEMPTED")
        }
    }

    @Synchronized
    fun writeActivityCertification(accountId: String?, deviceScopeId: String?, json: String): Map<String, Any?> {
        return writeCertification(accountId, deviceScopeId, json, "Activity24_25Certification", "activity_certification_chunks")
    }

    @Synchronized
    fun writeSleepCertification(accountId: String?, deviceScopeId: String?, json: String): Map<String, Any?> {
        return writeCertification(accountId, deviceScopeId, json, "SleepCertification", "sleep_certification_chunks")
    }

    @Synchronized
    fun writeRawPpgCertification(accountId: String?, deviceScopeId: String?, json: String): Map<String, Any?> {
        return writeCertification(accountId, deviceScopeId, json, "RawPpgSavedCertification", "ppg_certification_chunks")
    }

    @Synchronized
    fun readRawPpgCertification(accountId: String?, deviceScopeId: String?): Map<String, Any?> {
        return readCertification(accountId, deviceScopeId, "ppg_certification_chunks")
    }

    /**
     * Offline PPG owner check: like the VC26 saved-workout path, historical PPG evidence is read with the
     * persisted authenticated account (and optionally an opaque device scope) instead of the live capture scope,
     * so inspection works after restart and while disconnected. Rows are always filtered by account.
     */
    private fun savedPpgOwner(accountId: String?, deviceScopeId: String?): Pair<String, String?> {
        if (accountId.isNullOrBlank() || accountId.length > 256) throw Failure("PPG_SCOPE_NOT_RESOLVED")
        if (deviceScopeId != null && !deviceScopeId.matches(Regex("[A-Za-z0-9_-]{1,256}"))) throw Failure("PPG_SCOPE_NOT_RESOLVED")
        return accountId to deviceScopeId
    }

    private fun ownerClause(device: String?) = if (device == null) "account=?" else "account=? AND device=?"
    private fun ownerArgs(account: String, device: String?) = if (device == null) arrayOf(account) else arrayOf(account, device)

    /**
     * Read-only PPG evidence census for the diagnostic: registered PPG spool manifests plus per-session counts of
     * journal rows captured while acquisitionMode was RAW_PPG. Returns IDs/hashes/counts only, never payloads.
     */
    @Synchronized
    fun ppgEvidenceCensus(accountId: String?, deviceScopeId: String?, rowLimit: Int = 20_000): Map<String, Any?> {
        val (account, device) = savedPpgOwner(accountId, deviceScopeId)
        val files = mutableListOf<Map<String, Any?>>()
        readableDatabase.rawQuery(
            "SELECT id,device,path,session_id,bytes FROM source_files WHERE ${ownerClause(device)} AND kind='PPG_LENGTH_PREFIXED_V1' ORDER BY rowid",
            ownerArgs(account, device),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val file = java.io.File(cursor.getString(2))
                files.add(linkedMapOf(
                    "fileId" to cursor.getString(0), "deviceScopeId" to cursor.getString(1),
                    "filename" to file.name, "path" to file.absolutePath, "sessionId" to cursor.getString(3),
                    "reservedBytes" to cursor.getLong(4), "existsOnDisk" to file.isFile,
                    "actualBytes" to if (file.isFile) file.length() else null,
                ))
            }
        }
        val sessions = linkedMapOf<String, MutableMap<String, Any?>>()
        var scanned = 0
        readableDatabase.rawQuery(
            "SELECT id,device,kind,received,json FROM envelopes WHERE ${ownerClause(device)} AND json LIKE ? ORDER BY sequence LIMIT ?",
            ownerArgs(account, device) + arrayOf("%\"acquisitionMode\":\"RAW_PPG\"%", (rowLimit + 1).toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                if (++scanned > rowLimit) break
                val json = JSONObject(cursor.getString(4))
                if (json.optString("acquisitionMode") != "RAW_PPG") continue
                val sessionId = json.optString("sessionId").ifBlank { "UNKNOWN_SESSION" }
                val kind = cursor.getString(2)
                val entry = sessions.getOrPut(sessionId) {
                    linkedMapOf(
                        "sessionId" to sessionId, "deviceScopeId" to cursor.getString(1),
                        "firmwareVersion" to json.opt("firmwareVersion").takeUnless { it == JSONObject.NULL },
                        "firstReceivedAt" to JCVitalV8Time.isoUtc(cursor.getLong(3)),
                        "bleNotificationCount" to 0, "sdkByteCallbackCount" to 0, "sdkMapCallbackCount" to 0,
                        "sdkRecordCount" to 0, "sdkParseOutcomeCount" to 0, "commandRequestCount" to 0, "otherCount" to 0,
                        "notificationSha256" to mutableListOf<String>(),
                    )
                }
                entry["lastReceivedAt"] = JCVitalV8Time.isoUtc(cursor.getLong(3))
                val counter = when {
                    kind == "BLE_NOTIFICATION" -> "bleNotificationCount"
                    kind == "SDK_BYTE_CALLBACK" -> "sdkByteCallbackCount"
                    kind == "SDK_CALLBACK" -> "sdkMapCallbackCount"
                    kind == "SDK_RECORD" -> "sdkRecordCount"
                    kind == "SDK_PARSE_OUTCOME" -> "sdkParseOutcomeCount"
                    kind.contains("COMMAND") -> "commandRequestCount"
                    else -> "otherCount"
                }
                entry[counter] = (entry[counter] as Int) + 1
                if (kind == "BLE_NOTIFICATION") {
                    @Suppress("UNCHECKED_CAST")
                    (entry["notificationSha256"] as MutableList<String>).add(json.optString("sha256"))
                }
            }
        }
        return linkedMapOf(
            "accountFiltered" to true, "deviceScopeFilter" to device,
            "ppgSourceFiles" to files, "ppgSessions" to sessions.values.toList(),
            "rowsScanned" to minOf(scanned, rowLimit), "rowLimitReached" to (scanned > rowLimit),
        )
    }

    /** Envelopes captured while the Raw PPG workflow was the active acquisition for [sessionId]; bounded, read-only. */
    @Synchronized
    fun rawNotificationEnvelopesForSession(accountId: String?, deviceScopeId: String?, sessionId: String, limit: Int = 256): List<Map<String, Any?>> {
        val (account, device) = savedPpgOwner(accountId, deviceScopeId)
        require(sessionId.matches(Regex("[A-Za-z0-9_-]+"))) { "INVALID_SESSION_ID" }
        val results = mutableListOf<Map<String, Any?>>()
        readableDatabase.rawQuery(
            "SELECT sequence,id,received,timezone,json FROM envelopes WHERE ${ownerClause(device)} AND kind='BLE_NOTIFICATION' AND json LIKE ? ORDER BY sequence LIMIT ?",
            ownerArgs(account, device) + arrayOf("%\"sessionId\":\"$sessionId\"%", limit.toString()),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val envelope = JSONObject(cursor.getString(4))
                results.add(linkedMapOf(
                    "envelopeId" to cursor.getString(1), "sequence" to cursor.getLong(0),
                    "receivedAt" to JCVitalV8Time.isoUtc(cursor.getLong(2)), "timezone" to cursor.getString(3),
                    "sha256" to envelope.opt("sha256"), "byteLength" to envelope.opt("byteLength"),
                    "firmwareVersion" to envelope.opt("firmwareVersion"), "deviceModel" to envelope.opt("deviceModel"),
                    "characteristicUuid" to envelope.opt("characteristicUuid"), "sdkVersion" to envelope.opt("sdkVersion"),
                    "parserVersion" to envelope.opt("parserVersion"), "callbackIdentifier" to envelope.opt("callbackIdentifier"),
                ))
            }
        }
        return results
    }

    /** Registered raw-session spool files for [sessionId]; read-only manifest lookup, independent of the spool bytes on disk. */
    @Synchronized
    fun sourceFilesForSession(accountId: String?, deviceScopeId: String?, sessionId: String): List<Map<String, Any?>> {
        val (account, device) = savedPpgOwner(accountId, deviceScopeId)
        require(sessionId.matches(Regex("[A-Za-z0-9_-]+"))) { "INVALID_SESSION_ID" }
        val results = mutableListOf<Map<String, Any?>>()
        readableDatabase.rawQuery(
            "SELECT id,path,kind,bytes,device FROM source_files WHERE ${ownerClause(device)} AND session_id=?",
            ownerArgs(account, device) + arrayOf(sessionId),
        ).use { cursor ->
            while (cursor.moveToNext()) {
                val file = java.io.File(cursor.getString(1))
                results.add(linkedMapOf(
                    "fileId" to cursor.getString(0), "deviceScopeId" to cursor.getString(4),
                    "path" to cursor.getString(1), "format" to cursor.getString(2),
                    "reservedBytes" to cursor.getLong(3), "actualBytes" to file.length(), "available" to file.isFile,
                    "integrityStatus" to if (!file.isFile) "MISSING" else if (file.length() != cursor.getLong(3)) "RESERVED_LENGTH_MISMATCH" else "RESERVED_LENGTH_MATCH",
                ))
            }
        }
        return results
    }

    private fun writeCertification(accountId: String?, deviceScopeId: String?, json: String, kind: String, table: String,
        savedWorkoutScope: Scope? = null): Map<String, Any?> {
        val active = savedWorkoutScope ?: owner(accountId, deviceScopeId)
        val label = when (kind) {
            "WorkoutHistoryCertification" -> "WORKOUT"; "SleepCertification" -> "SLEEP"
            "RawPpgSavedCertification" -> "PPG"; PPG_PHYSICAL_KIND -> "PPG_PHYSICAL"; else -> "ACTIVITY"
        }
        require(json.toByteArray(Charsets.UTF_8).size <= 64 * 1024 * 1024) { "${label}_SNAPSHOT_TOO_LARGE" }
        val snapshot = JSONObject(json)
        require(snapshot.getString("kind") == kind) { "INVALID_${label}_SNAPSHOT" }
        val snapshotScope = snapshot.getJSONObject("context").getJSONObject("scope")
        require(snapshotScope.getString("accountId") == active.accountId && snapshotScope.getString("deviceScopeId") == active.deviceScopeId) { "OWNER_MISMATCH" }
        val db = writableDatabase
        db.beginTransaction()
        try {
            db.delete(table, "account=? AND device=?", arrayOf(active.accountId, active.deviceScopeId))
            var offset = 0
            var index = 0
            while (offset < json.length) {
                var end = minOf(offset + 64 * 1024, json.length)
                if (end < json.length && json[end - 1].isHighSurrogate() && json[end].isLowSurrogate()) end--
                val row = ContentValues().apply {
                    put("account", active.accountId); put("device", active.deviceScopeId)
                    put("chunk_index", index++); put("json", json.substring(offset, end))
                }
                db.insertOrThrow(table, null, row)
                offset = end
            }
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        return mapOf("saved" to true)
    }

    @Synchronized
    fun readActivityCertification(accountId: String?, deviceScopeId: String?): Map<String, Any?> {
        return readCertification(accountId, deviceScopeId, "activity_certification_chunks")
    }

    @Synchronized
    fun readSleepCertification(accountId: String?, deviceScopeId: String?): Map<String, Any?> {
        return readCertification(accountId, deviceScopeId, "sleep_certification_chunks")
    }

    private fun readCertification(accountId: String?, deviceScopeId: String?, table: String,
        active: Scope = owner(accountId, deviceScopeId)): Map<String, Any?> {
        val label = when (table) {
            "workout_certification_chunks" -> "WORKOUT"; "sleep_certification_chunks" -> "SLEEP"
            "ppg_certification_chunks" -> "PPG"; PPG_PHYSICAL_TABLE -> "PPG_PHYSICAL"; else -> "ACTIVITY"
        }
        val text = StringBuilder()
        var expected = 0
        readableDatabase.rawQuery("SELECT chunk_index,json FROM $table WHERE account=? AND device=? ORDER BY chunk_index",
            arrayOf(active.accountId, active.deviceScopeId)).use { cursor ->
            while (cursor.moveToNext()) {
                check(cursor.getInt(0) == expected++) { "${label}_SNAPSHOT_CHUNK_MISSING" }
                text.append(cursor.getString(1))
            }
        }
        return mapOf("json" to if (expected == 0) null else text.toString())
    }

    @Synchronized
    fun configure(accountId: String?, deviceScopeId: String?, enabled: Boolean, bytes: Long?, envelopes: Long?, entryBytes: Int?): Map<String, Any?> {
        if (!enabled) return configureInternal(accountId, deviceScopeId, false, bytes, envelopes, entryBytes)
        requestedScope = Scope(accountId.orEmpty(), deviceScopeId.orEmpty())
        openAttempted = false
        openSucceeded = false
        openFailureCode = null
        openFailureMessage = null
        configuring = true
        var recoveryApplied = false
        try {
            if (!failed) scope = null
            val targetBytes = configuredByteLimit(bytes)
            val targetEnvelopes = (envelopes ?: 100_000L).also { require(it in 1..1_000_000) }
            require(entryBytes == null || entryBytes in 256..(1024 * 1024))
            require(!accountId.isNullOrBlank() && accountId.length <= 256)
            require(deviceScopeId != null && deviceScopeId.matches(Regex("[A-Za-z0-9_-]{1,256}"))) { "INVALID_OPAQUE_DEVICE_SCOPE" }
            if (failed) {
                if (lastFailure != STORAGE_PRESSURE) throw Failure("JOURNAL_FAILED_CLOSED")
                recoverStoragePressure(accountId, deviceScopeId, targetBytes, targetEnvelopes)
                recoveryApplied = true
            }
            return configureInternal(accountId, deviceScopeId, true, bytes, envelopes, entryBytes)
        } catch (error: Exception) {
            if (recoveryApplied && !failed) {
                failed = true
                refusedCount++
                lastOutcome = "JOURNAL_RECOVERY_REOPEN_FAILED"
                lastFailure = (error as? Failure)?.reason ?: error.javaClass.simpleName
                lastFailureMessage = error.message
                lastFailureTimestamp = JCVitalV8Time.isoUtc(System.currentTimeMillis())
                try {
                    persistOutcome()
                } catch (persistError: Exception) {
                    error.addSuppressed(persistError)
                }
            }
            openFailureCode = (error as? Failure)?.reason ?: error.javaClass.simpleName
            openFailureMessage = error.message
            throw error
        } finally {
            configuring = false
        }
    }

    private fun configureInternal(accountId: String?, deviceScopeId: String?, enabled: Boolean, bytes: Long?, envelopes: Long?, entryBytes: Int?): Map<String, Any?> {
        scope = null
        if (!enabled && failed) return diagnostics(accountId, deviceScopeId)
        require(!enabled || (!accountId.isNullOrBlank() && !deviceScopeId.isNullOrBlank())) { "Authenticated accountId and opaque deviceScopeId are required" }
        require(accountId == null || accountId.length <= 256)
        require(deviceScopeId == null || deviceScopeId.length <= 256)
        require(deviceScopeId == null || deviceScopeId.matches(Regex("[A-Za-z0-9_-]{1,256}"))) { "INVALID_OPAQUE_DEVICE_SCOPE" }
        maxBytes = configuredByteLimit(bytes)
        maxEnvelopes = (envelopes ?: 100_000L).also { require(it in 1..1_000_000) }
        // Below Android's default CursorWindow row limit, including BLOB + envelope metadata.
        maxEntryBytes = (entryBytes ?: 1024 * 1024).also { require(it in 256..(1024 * 1024)) }
        if (enabled) {
            openAttempted = true
            openedDatabase = writableDatabase
            openSucceeded = true
            scope = Scope(accountId!!, deviceScopeId!!)
        }
        if (!failed) lastOutcome = if (enabled) "CONFIGURED" else "DISABLED"
        if (!outcomePrefs.edit().putLong("maxBytes", maxBytes).commit()) throw Failure("OUTCOME_PERSISTENCE_FAILED")
        persistOutcome()
        return diagnostics(accountId, deviceScopeId)
    }

    private data class RecoveryInspection(
        val envelopeCount: Long,
        val accountedBytes: Long,
        val integrityResult: String,
        val availableFilesystemBytes: Long,
    )

    private fun configuredByteLimit(bytes: Long?): Long {
        val saved = outcomePrefs.getLong("maxBytes", LEGACY_MAX_BYTES)
        val requested = bytes ?: maxOf(saved, DEFAULT_MAX_BYTES)
        require(requested in 1024..(1024L * 1024 * 1024))
        return if (outcomePrefs.contains("maxBytes")) maxOf(requested, saved) else requested
    }

    private fun recoveryAuditHistory(): JSONArray {
        val history = outcomePrefs.getString("recoveryAuditHistory", null)?.let { JSONArray(it) } ?: JSONArray()
        if (history.length() == 0) {
            outcomePrefs.getString("recoveryAudit", null)?.let { history.put(JSONObject(it)) }
        }
        return history
    }

    private fun recoverStoragePressure(accountId: String?, deviceScopeId: String?, targetBytes: Long, targetEnvelopes: Long) {
        if (!failed || lastFailure != STORAGE_PRESSURE) throw Failure("JOURNAL_RECOVERY_NOT_STORAGE_PRESSURE")
        require(!accountId.isNullOrBlank() && !deviceScopeId.isNullOrBlank()) {
            "Authenticated accountId and opaque deviceScopeId are required"
        }
        val dbFile = appContext.getDatabasePath(DATABASE_NAME)
        if (!dbFile.isFile) throw Failure("JOURNAL_RECOVERY_DATABASE_MISSING")
        val inspection = try {
            SQLiteDatabase.openDatabase(dbFile.absolutePath, null, SQLiteDatabase.OPEN_READONLY).use { db ->
                if (!db.isReadOnly || db.inTransaction() || openedDatabase?.inTransaction() == true) {
                    throw Failure("JOURNAL_RECOVERY_PENDING_WRITE")
                }
                val integrityResults = mutableListOf<String>()
                db.rawQuery("PRAGMA quick_check", null).use { cursor ->
                    while (cursor.moveToNext()) integrityResults.add(cursor.getString(0))
                }
                if (integrityResults != listOf("ok")) throw Failure("JOURNAL_RECOVERY_INTEGRITY_CHECK_FAILED")

                val (envelopeCount, minSequence, maxSequence) = db.rawQuery(
                    "SELECT COUNT(*),COALESCE(MIN(sequence),0),COALESCE(MAX(sequence),0) FROM envelopes", null,
                ).use { cursor ->
                    cursor.moveToFirst()
                    Triple(cursor.getLong(0), cursor.getLong(1), cursor.getLong(2))
                }
                if (envelopeCount > 0 && (minSequence != 1L || maxSequence != envelopeCount)) {
                    throw Failure("JOURNAL_RECOVERY_SEQUENCE_INTEGRITY_FAILED")
                }
                val envelopeBytes = db.rawQuery("SELECT COALESCE(SUM(bytes),0) FROM envelopes", null)
                    .use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
                val fileBytes = db.rawQuery("SELECT COALESCE(SUM(bytes),0) FROM source_files", null)
                    .use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
                val (storedCount, storedBytes) = db.rawQuery(
                    "SELECT envelopes,bytes FROM journal_totals WHERE singleton=1", null,
                ).use { cursor ->
                    if (!cursor.moveToFirst()) throw Failure("JOURNAL_RECOVERY_ACCOUNTING_MISMATCH")
                    cursor.getLong(0) to cursor.getLong(1)
                }
                if (storedCount != envelopeCount || storedBytes != envelopeBytes + fileBytes ||
                    envelopeBytes < 0 || fileBytes < 0 || storedBytes < 0) {
                    throw Failure("JOURNAL_RECOVERY_ACCOUNTING_MISMATCH")
                }

                val retainedScopes = mutableListOf<Pair<String, String>>()
                db.rawQuery(
                    "SELECT account,device FROM envelopes UNION SELECT account,device FROM source_files", null,
                ).use { cursor ->
                    while (cursor.moveToNext()) retainedScopes.add(cursor.getString(0) to cursor.getString(1))
                }
                if (retainedScopes.isEmpty()) throw Failure("JOURNAL_RECOVERY_RETAINED_SCOPE_MISSING")
                if (retainedScopes.any { it.first != accountId }) throw Failure("JOURNAL_RECOVERY_ACCOUNT_MISMATCH")
                if (retainedScopes.any { it.second != deviceScopeId }) throw Failure("JOURNAL_RECOVERY_DEVICE_SCOPE_MISMATCH")

                val available = StatFs(appContext.filesDir.absolutePath).availableBytes
                val minimumHeadroom = maxOf(MIN_RECOVERY_HEADROOM_BYTES, targetBytes * 4)
                if (available < minimumHeadroom) {
                    throw Failure("JOURNAL_RECOVERY_BLOCKED_INSUFFICIENT_DEVICE_STORAGE")
                }
                if (envelopeCount >= targetEnvelopes) throw Failure("JOURNAL_RECOVERY_ENVELOPE_LIMIT_REACHED")
                if (storedBytes >= targetBytes) throw Failure("JOURNAL_RECOVERY_BYTE_LIMIT_REACHED")
                if (envelopeCount > targetEnvelopes * 80 / 100) throw Failure("JOURNAL_RECOVERY_INSUFFICIENT_ENVELOPE_HEADROOM")
                if (storedBytes > targetBytes * 80 / 100) throw Failure("JOURNAL_RECOVERY_INSUFFICIENT_BYTE_HEADROOM")
                RecoveryInspection(envelopeCount, storedBytes, integrityResults.joinToString(","), available)
            }
        } catch (error: Failure) {
            throw error
        } catch (error: Exception) {
            throw Failure("JOURNAL_RECOVERY_DATABASE_OPEN_FAILED", error)
        }

        val recoveredAt = System.currentTimeMillis()
        val priorMaxBytes = outcomePrefs.getLong("maxBytes", maxBytes)
        val priorTimestamp = lastFailureTimestamp
        val audit = JSONObject()
            .put("recoveryType", STORAGE_PRESSURE_BUDGET_RECOVERY)
            .put("priorMaxBytes", priorMaxBytes)
            .put("newMaxBytes", targetBytes)
            .put("bytesAtRecovery", inspection.accountedBytes)
            .put("envelopesAtRecovery", inspection.envelopeCount)
            .put("maxEnvelopes", targetEnvelopes)
            .put("byteHeadroomAtRecovery", targetBytes - inspection.accountedBytes)
            .put("envelopeHeadroomAtRecovery", targetEnvelopes - inspection.envelopeCount)
            .put("recoveryUtilizationLimitPercent", 80)
            .put("availableFilesystemBytes", inspection.availableFilesystemBytes)
            .put("integrityCheckResult", inspection.integrityResult)
            .put("accountId", accountId)
            .put("deviceScopeId", deviceScopeId)
            .put("recoveredAt", JCVitalV8Time.isoUtc(recoveredAt))
            .put("priorFailureCode", lastFailure)
            .put("priorFailureMessage", lastFailureMessage ?: JSONObject.NULL)
            .put("priorFailureTimestamp", priorTimestamp ?: JSONObject.NULL)
        val history = recoveryAuditHistory().put(audit)
        val update = outcomePrefs.edit()
            .putLong("maxBytes", targetBytes)
            .putBoolean("failedClosed", false)
            .putString("lastOutcome", STORAGE_PRESSURE_BUDGET_RECOVERY)
            .putString("priorFailureCode", lastFailure)
            .putString("priorFailureMessage", lastFailureMessage)
            .putString("priorFailureTimestamp", priorTimestamp)
            .putString("recoveryAuditHistory", history.toString())
            .putString("latestRecoveryAudit", audit.toString())
        if (!outcomePrefs.contains("recoveryAudit")) update.putString("recoveryAudit", audit.toString())
        if (!update.commit()) throw Failure("JOURNAL_RECOVERY_AUDIT_PERSISTENCE_FAILED")
        maxBytes = targetBytes
        failed = false
        lastOutcome = STORAGE_PRESSURE_BUDGET_RECOVERY
    }

    @Synchronized fun currentScope(): Scope? = scope
    @Synchronized fun captureEnabled(): Boolean = scope != null
    @Synchronized fun hasFailedClosed(): Boolean = failed

    /** Does not open storage, rebind scope, clear failures or mutate retained envelopes. */
    @Synchronized fun handshakeSnapshot(): Map<String, Any?> {
        val owner = scope ?: requestedScope
        var count: Long? = null
        var inspectionFailureCode: String? = null
        var inspectionFailureMessage: String? = null
        val db = openedDatabase
        if (owner != null && db?.isOpen == true) {
            try {
                count = db.rawQuery("SELECT COUNT(*) FROM envelopes WHERE account=? AND device=?",
                    arrayOf(owner.accountId, owner.deviceScopeId)).use { cursor ->
                    cursor.moveToFirst()
                    cursor.getLong(0)
                }
            } catch (error: Exception) {
                inspectionFailureCode = error.javaClass.simpleName
                inspectionFailureMessage = error.message
            }
        }
        return linkedMapOf(
            "journalState" to when {
                failed -> "JOURNAL_FAILED_CLOSED"
                configuring -> "JOURNAL_INITIALIZING"
                openFailureCode != null -> "JOURNAL_OPEN_FAILED"
                scope != null -> "JOURNAL_READY"
                else -> "JOURNAL_UNBOUND"
            },
            "journalAccountId" to owner?.accountId,
            "journalDeviceScopeId" to owner?.deviceScopeId,
            "journalOpenAttempted" to openAttempted,
            "journalOpenSucceeded" to openSucceeded,
            "journalFailureCode" to (if (failed) lastFailure else openFailureCode),
            "journalFailureMessage" to (if (failed) lastFailureMessage ?: lastFailure else openFailureMessage),
            "failedClosed" to failed,
            "priorFailureCode" to outcomePrefs.getString("priorFailureCode", null),
            "priorFailureMessage" to outcomePrefs.getString("priorFailureMessage", null),
            "priorFailureTimestamp" to outcomePrefs.getString("priorFailureTimestamp", null),
            "recoveryAudit" to outcomePrefs.getString("recoveryAudit", null)?.let { JSONObject(it) },
            "recoveryAuditHistory" to recoveryAuditHistory(),
            "latestRecoveryAudit" to outcomePrefs.getString("latestRecoveryAudit", outcomePrefs.getString("recoveryAudit", null))?.let { JSONObject(it) },
            "journalFailedClosedAtStartup" to failedClosedAtStartup,
            "journalLastOutcome" to lastOutcome,
            "journalRefusedCount" to refusedCount,
            "journalEnvelopeCount" to count,
            "journalInspectionFailureCode" to inspectionFailureCode,
            "journalInspectionFailureMessage" to inspectionFailureMessage,
            "journalPressure" to pressureSnapshot(),
        )
    }

    /** Reads the exact global accounting used by checkCapacity without opening storage or changing its latch. */
    private fun pressureSnapshot(): Map<String, Any?> {
        val db = openedDatabase
        var total: Pair<Long, Long>? = null
        var errorCode: String? = null
        var errorMessage: String? = null
        var largestRecentEnvelopeBytes: Long? = null
        var reservedSourceFileBytes: Long? = null
        if (db?.isOpen == true) {
            try {
                total = totals(db)
                largestRecentEnvelopeBytes = db.rawQuery(
                    "SELECT MAX(bytes) FROM (SELECT bytes FROM envelopes ORDER BY sequence DESC LIMIT 100)", null,
                ).use { cursor -> cursor.moveToFirst(); if (cursor.isNull(0)) null else cursor.getLong(0) }
                reservedSourceFileBytes = db.rawQuery(
                    "SELECT COALESCE(SUM(bytes),0) FROM source_files", null,
                ).use { cursor -> cursor.moveToFirst(); cursor.getLong(0) }
            } catch (error: Exception) {
                errorCode = error.javaClass.simpleName
                errorMessage = error.message
            }
        }
        return linkedMapOf(
            "globalEnvelopeCount" to total?.first,
            "globalAccountedBytes" to total?.second,
            "maxEnvelopes" to maxEnvelopes,
            "maxBytes" to maxBytes,
            "envelopeHeadroom" to total?.let { maxEnvelopes - it.first },
            "byteHeadroom" to total?.let { maxBytes - it.second },
            "budgetAtOrOverLimit" to total?.let { it.first >= maxEnvelopes || it.second >= maxBytes },
            "limitsScope" to "GLOBAL_DATABASE_ALL_OWNERS",
            "metricSource" to "journal_totals",
            "triggerRule" to "globalEnvelopeCount + pendingEnvelopeCount > maxEnvelopes OR globalAccountedBytes + pendingBytes > maxBytes",
            "pendingEnvelopeCountAtFailure" to null,
            "pendingBytesAtFailure" to null,
            "largestRecentEnvelopeBytes" to largestRecentEnvelopeBytes,
            "recentEnvelopeSampleLimit" to 100,
            "maxEntryBytes" to maxEntryBytes,
            "reservedSourceFileBytes" to reservedSourceFileBytes,
            "safeHeadroomForNextWrite" to null,
            "inspectionErrorCode" to errorCode,
            "inspectionErrorMessage" to errorMessage,
        )
    }
    @Synchronized fun recordOutcome(reason: String) {
        if (!failed) lastOutcome = reason
        try {
            persistOutcome()
        } catch (error: Exception) {
            failed = true
            lastFailure = "OUTCOME_PERSISTENCE_FAILED"
            lastFailureMessage = error.message
            throw Failure("OUTCOME_PERSISTENCE_FAILED", error)
        }
    }

    /** On-demand global inventory; only SELECTs against storage already opened by the existing lifecycle. */
    @Synchronized
    fun capacityAnalysis(now: Long = System.currentTimeMillis()): Map<String, Any?> {
        val db = openedDatabase?.takeIf { it.isOpen } ?: throw Failure("JOURNAL_ANALYSIS_STORAGE_NOT_OPEN")
        return CapacityAnalyzer.analyze(db, now, failed, lastFailure, maxBytes)
    }

    /** Stateless SELECT-only analyzer; usable on any database handle, including an independent read-only one. */
    object CapacityAnalyzer {
    fun analyze(db: SQLiteDatabase, now: Long, failed: Boolean, lastFailure: String?, maxBytes: Long): Map<String, Any?> {
        val groups = linkedMapOf<String, MutableMap<String, LongArray>>()
        val largest = mutableListOf<Map<String, Any?>>()
        val topRecords = mutableListOf<Map<String, Any?>>()
        val contentHashes = linkedMapOf<String, LongArray>()
        val contentFirstSequence = hashMapOf<String, Long>()
        val blobFamilies = linkedMapOf<String, LongArray>()
        var blobCount = 0L
        var largestBlob = 0L
        var certificationMarkerBytes = 0L
        var diagnosticMarkerBytes = 0L
        var rawPpgBytes = 0L
        val rawHashes = linkedMapOf<List<String>, Pair<Long, Long>>()
        var jsonBytes = 0L
        var rawBytes = 0L
        var overhead = 0L
        var envelopeBytes = 0L
        var fileBytes = 0L
        var count = 0L
        fun group(axis: String, key: String, bytes: Long, envelopes: Long = 1L) {
            val values = groups.getOrPut(axis) { linkedMapOf() }
            val entry = values.getOrPut(key) { LongArray(2) }
            entry[0] += bytes; entry[1] += envelopes
        }
        fun prefill(axis: String, keys: List<String>) { keys.forEach { group(axis, it, 0L, 0L) } }
        prefill("vendorBucket", listOf("27", "68", "59", "24/25", "26/121", "42", "127", "29", "118/119", "OTHER"))
        prefill("displayFamily", listOf("PRODUCTION_PHYSIOLOGICAL", "CERTIFICATION", "DIAGNOSTICS", "PPG", "WORKOUT", "SLEEP", "ACTIVITY", "UNKNOWN"))
        prefill("ageDistribution", listOf("UNDER_24_HOURS", "1_TO_7_DAYS", "8_TO_30_DAYS", "31_TO_90_DAYS", "OVER_90_DAYS"))
        fun ageDistribution(received: Long?): String = when {
            received == null -> "UNKNOWN"
            received > now -> "FUTURE_TIMESTAMP"
            now - received < 86_400_000L -> "UNDER_24_HOURS"
            now - received <= 7L * 86_400_000 -> "1_TO_7_DAYS"
            now - received <= 30L * 86_400_000 -> "8_TO_30_DAYS"
            now - received <= 90L * 86_400_000 -> "31_TO_90_DAYS"
            else -> "OVER_90_DAYS"
        }
        fun vendorBucket(type: String): String = when (type) {
            "27", "68", "59", "42", "127", "29" -> type
            "24", "25" -> "24/25"
            "26", "121" -> "26/121"
            "118", "119" -> "118/119"
            else -> "OTHER"
        }
        // Display label only: never evidence of exclusive purpose or archive eligibility.
        fun displayFamily(kind: String, mode: String, type: String): String = when {
            kind.contains("CERTIFICATION") -> "CERTIFICATION"
            kind.contains("DIAGNOSTIC") -> "DIAGNOSTICS"
            mode == "RAW_PPG" || kind.contains("PPG") -> "PPG"
            kind.contains("WORKOUT") || type == "29" -> "WORKOUT"
            type == "26" || type == "121" -> "SLEEP"
            type == "24" || type == "25" -> "ACTIVITY"
            type in setOf("27", "68", "59", "42", "127") -> "PRODUCTION_PHYSIOLOGICAL"
            else -> "UNKNOWN"
        }
        fun topRecord(row: Map<String, Any?>) {
            topRecords.add(row)
            topRecords.sortByDescending { it["totalAccountedBytes"] as Long }
            if (topRecords.size > 20) topRecords.removeAt(20)
        }
        fun age(received: Long?): String = when {
            received == null -> "UNKNOWN"
            received > now -> "FUTURE_TIMESTAMP"
            now - received <= 7L * 86_400_000 -> "0_TO_7_DAYS"
            now - received <= 30L * 86_400_000 -> "8_TO_30_DAYS"
            now - received <= 90L * 86_400_000 -> "31_TO_90_DAYS"
            else -> "OVER_90_DAYS"
        }
        fun contributor(row: Map<String, Any?>) {
            largest.add(row)
            largest.sortByDescending { it["accountedBytes"] as Long }
            if (largest.size > 5) largest.removeAt(5)
        }
        // The journal lock serializes this inventory with capture; no write transaction or schema changes.
        db.rawQuery("SELECT envelopes,bytes FROM journal_totals WHERE singleton=1", null).use { totalsCursor ->
            if (!totalsCursor.moveToFirst()) throw Failure("JOURNAL_TOTALS_MISSING")
            val totalCount = totalsCursor.getLong(0)
            val totalBytes = totalsCursor.getLong(1)
            db.rawQuery("SELECT sequence,id,account,device,kind,received,json,COALESCE(length(raw),0),bytes FROM envelopes ORDER BY sequence", null).use { cursor ->
                while (cursor.moveToNext()) {
                    val jsonText = cursor.getString(6)
                    val json = JSONObject(jsonText)
                    fun text(key: String): String = if (json.isNull(key)) "UNKNOWN" else json.getString(key).ifBlank { "UNKNOWN" }
                    val bytes = cursor.getLong(8)
                    val blobBytes = cursor.getLong(7)
                    val kind = cursor.getString(4)
                    val mode = text("acquisitionMode")
                    val vendorType = text("vendorDataType")
                    val evidence = when {
                        kind.contains("CERTIFICATION") -> "EXPLICIT_CERTIFICATION_MARKER_NOT_ARCHIVE_PROOF"
                        mode == "RAW_PPG" -> "RAW_PPG_CAPTURE_REQUIRES_PURPOSE_AND_CLOSURE_REVIEW"
                        kind.contains("DIAGNOSTIC") -> "EXPLICIT_DIAGNOSTIC_MARKER_NOT_ARCHIVE_PROOF"
                        else -> "PURPOSE_UNKNOWN"
                    }
                    val received = cursor.getLong(5)
                    val envelopeJsonBytes = jsonText.toByteArray(Charsets.UTF_8).size.toLong()
                    count++
                    jsonBytes += envelopeJsonBytes
                    rawBytes += blobBytes
                    overhead += 1024L
                    envelopeBytes += bytes
                    group("accountId", cursor.getString(2), bytes)
                    group("deviceScopeId", cursor.getString(3), bytes)
                    group("vendorDataType", vendorType, bytes)
                    group("captureFamily", "$mode / $kind / vendor:$vendorType", bytes)
                    group("captureFamilyAgeBucket", "$mode / $kind / vendor:$vendorType / ${age(cursor.getLong(5))}", bytes)
                    group("evidencePurpose", evidence, bytes)
                    group("ageBucket", age(cursor.getLong(5)), bytes)
                    group("ageDistribution", ageDistribution(received), bytes)
                    group("vendorBucket", vendorBucket(vendorType), bytes)
                    group("displayFamily", displayFamily(kind, mode, vendorType), bytes)
                    group("receivedUtcDate", JCVitalV8Time.isoUtc(cursor.getLong(5)).take(10), bytes)
                    if (kind.contains("CERTIFICATION")) certificationMarkerBytes += bytes
                    if (kind.contains("DIAGNOSTIC")) diagnosticMarkerBytes += bytes
                    if (mode == "RAW_PPG") rawPpgBytes += bytes
                    topRecord(linkedMapOf(
                        "sequence" to cursor.getLong(0), "accountId" to cursor.getString(2),
                        "deviceScopeId" to cursor.getString(3), "vendorDataType" to vendorType, "kind" to kind,
                        "timestamp" to JCVitalV8Time.isoUtc(received), "jsonBytes" to envelopeJsonBytes,
                        "blobBytes" to blobBytes, "overheadBytes" to 1024L, "totalAccountedBytes" to bytes,
                        "sourceRecordId" to text("sourceRecordId"), "envelopeId" to cursor.getString(1),
                    ))
                    if (blobBytes > 0) {
                        blobCount++
                        if (blobBytes > largestBlob) largestBlob = blobBytes
                        val family = blobFamilies.getOrPut("$mode / $kind / vendor:$vendorType") { LongArray(2) }
                        family[0] += blobBytes; family[1] += 1
                        val digest = java.security.MessageDigest.getInstance("SHA-256")
                        db.rawQuery("SELECT raw FROM envelopes WHERE sequence=?", arrayOf(cursor.getLong(0).toString())).use { blob ->
                            if (blob.moveToFirst()) digest.update(blob.getBlob(0))
                        }
                        val hash = digest.digest().joinToString("") { "%02x".format(it) } + ":" + blobBytes
                        val entry = contentHashes.getOrPut(hash) { LongArray(2).also { contentFirstSequence[hash] = cursor.getLong(0) } }
                        entry[0] += 1; entry[1] = blobBytes
                    }
                    contributor(linkedMapOf(
                        "storage" to "ENVELOPE", "envelopeId" to cursor.getString(1), "sequence" to cursor.getLong(0),
                        "sourceRecordId" to text("sourceRecordId"), "accountId" to cursor.getString(2),
                        "deviceScopeId" to cursor.getString(3), "kind" to kind, "vendorDataType" to vendorType,
                        "captureFamily" to mode, "receivedAt" to JCVitalV8Time.isoUtc(cursor.getLong(5)),
                        "accountedBytes" to bytes, "rawBlobBytes" to blobBytes,
                        "retrievalPointer" to "readSourceEnvelope:${cursor.getString(1)}",
                    ))
                    if (blobBytes > 0 && text("sha256") != "UNKNOWN") {
                        val key = listOf(cursor.getString(2), cursor.getString(3), kind, text("sha256"), blobBytes.toString())
                        val previous = rawHashes[key] ?: (0L to 0L)
                        rawHashes[key] = previous.first + 1 to previous.second + blobBytes
                    }
                }
            }
            val files = mutableListOf<Map<String, Any?>>()
            db.rawQuery("SELECT f.id,f.account,f.device,f.session_id,f.kind,f.bytes,e.received FROM source_files f LEFT JOIN envelopes e ON e.id=f.id ORDER BY f.bytes DESC", null).use { cursor ->
                while (cursor.moveToNext()) {
                    val bytes = cursor.getLong(5)
                    val bucket = age(if (cursor.isNull(6)) null else cursor.getLong(6))
                    fileBytes += bytes
                    group("accountId", cursor.getString(1), bytes, 0L)
                    group("deviceScopeId", cursor.getString(2), bytes, 0L)
                    group("vendorDataType", "UNKNOWN_SOURCE_FILE", bytes, 0L)
                    group("captureFamily", "SOURCE_FILE / ${cursor.getString(4)}", bytes, 0L)
                    group("captureFamilyAgeBucket", "SOURCE_FILE / ${cursor.getString(4)} / $bucket", bytes, 0L)
                    group("evidencePurpose", "SOURCE_FILE_PURPOSE_UNKNOWN", bytes, 0L)
                    group("ageBucket", bucket, bytes, 0L)
                    group("ageDistribution", ageDistribution(if (cursor.isNull(6)) null else cursor.getLong(6)), bytes, 0L)
                    group("vendorBucket", "OTHER", bytes, 0L)
                    group("displayFamily", "UNKNOWN", bytes, 0L)
                    group("receivedUtcDate", if (cursor.isNull(6)) "UNKNOWN" else JCVitalV8Time.isoUtc(cursor.getLong(6)).take(10), bytes, 0L)
                    val row = linkedMapOf<String, Any?>(
                        "storage" to "SOURCE_FILE_RESERVATION", "fileId" to cursor.getString(0),
                        "accountId" to cursor.getString(1), "deviceScopeId" to cursor.getString(2),
                        "sessionId" to cursor.getString(3), "kind" to cursor.getString(4),
                        "accountedBytes" to bytes, "ageBucket" to bucket,
                        "ageBasis" to "MANIFEST_RECEIPT_NOT_FILE_MTIME",
                        "retrievalPointer" to "readSourceEnvelope:${cursor.getString(0)}",
                    )
                    if (files.size < 20) files.add(row)
                    contributor(row)
                }
            }
            val certification = listOf(
                "activity_certification_chunks", "sleep_certification_chunks", "workout_certification_chunks",
                "ppg_certification_chunks", "ppg_physical_certification_chunks",
            ).flatMap { table ->
                val rows = mutableListOf<Map<String, Any?>>()
                val exists = db.rawQuery("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", arrayOf(table)).use { it.moveToFirst() }
                if (!exists) return@flatMap rows
                db.rawQuery("SELECT account,device,COUNT(*),SUM(length(CAST(json AS BLOB))) FROM $table GROUP BY account,device", null).use { cursor ->
                    while (cursor.moveToNext()) rows.add(linkedMapOf(
                        "table" to table, "accountId" to cursor.getString(0), "deviceScopeId" to cursor.getString(1),
                        "chunks" to cursor.getLong(2), "utf8Bytes" to cursor.getLong(3),
                        "includedInMaxBytes" to false, "closureAndReferencesVerified" to false,
                    ))
                }
                rows
            }.sortedByDescending { it["utf8Bytes"] as Long }
            val ranked = groups.mapValues { (_, values) ->
                values.entries.sortedByDescending { it.value[0] }.map { mapOf("key" to it.key, "accountedBytes" to it.value[0], "envelopes" to it.value[1]) }
            }
            val duplicates = rawHashes.filterValues { it.first > 1 }.map { (key, value) ->
                linkedMapOf<String, Any?>(
                    "accountId" to key[0], "deviceScopeId" to key[1], "kind" to key[2], "declaredSha256" to key[3],
                    "copies" to value.first, "rawBlobBytes" to value.second,
                    "potentialRepeatedRawBytes" to value.second - key[4].toLong(),
                    "verifiedByteEquality" to false,
                )
            }.sortedByDescending { it["potentialRepeatedRawBytes"] as Long }
            val duplicateContent = contentHashes.filterValues { it[0] > 1 }
            val duplicateContentBytes = duplicateContent.values.sumOf { (it[0] - 1) * it[1] }
            val target80 = maxBytes * 80 / 100
            val target90 = maxBytes * 90 / 100
            val componentSum = jsonBytes + rawBytes + overhead + fileBytes
            val reasons = mutableListOf<String>()
            if (totalCount != count) reasons.add("JOURNAL_TOTALS_ENVELOPE_COUNT_DIFFERS_FROM_ROWS")
            if (totalBytes != envelopeBytes + fileBytes) reasons.add("JOURNAL_TOTALS_BYTES_DIFFER_FROM_ROW_BYTES_PLUS_FILE_RESERVATIONS")
            if (envelopeBytes != jsonBytes + rawBytes + overhead) reasons.add("ROW_BYTES_DIFFER_FROM_JSON_PLUS_BLOB_PLUS_OVERHEAD")
            val unsafe = "NOT_SAFE_TO_REMOVE_UNTIL_PROVENANCE_AND_ARCHIVE_PROOF"
            return linkedMapOf(
                "schema" to "journal-capacity-analysis/1",
                "globalEnvelopeCount" to totalCount, "componentSumBytes" to componentSum,
                "reconciliationDifferenceBytes" to totalBytes - componentSum,
                "reconciliationStatus" to if (reasons.isEmpty() && totalBytes == componentSum) "RECONCILED" else "NOT_RECONCILED",
                "reconciliationReasons" to reasons,
                "topRecords20" to topRecords,
                "rawBlobAnalysis" to linkedMapOf(
                    "rawBlobBytesTotal" to rawBytes, "rawBlobCount" to blobCount, "largestRawBlobBytes" to largestBlob,
                    "topRawBlobFamilies" to blobFamilies.entries.sortedByDescending { it.value[0] }.take(10).map {
                        mapOf("family" to it.key, "rawBlobBytes" to it.value[0], "blobs" to it.value[1])
                    },
                    "duplicateBlobCandidateCount" to duplicateContent.size,
                    "duplicateBlobCandidateBytes" to duplicateContentBytes,
                    "duplicateBasis" to "GLOBAL_SHA256_COMPUTED_FROM_STORED_BLOB_BYTES_PLUS_EQUAL_LENGTH",
                    "topDuplicateGroups" to duplicateContent.entries.sortedByDescending { (it.value[0] - 1) * it.value[1] }.take(20).map {
                        mapOf("sha256AndLength" to it.key, "copies" to it.value[0], "blobBytesEach" to it.value[1],
                            "repeatedBytes" to (it.value[0] - 1) * it.value[1], "firstSequence" to contentFirstSequence[it.key])
                    },
                    "removalStatus" to unsafe,
                ),
                "evidenceInventory" to linkedMapOf(
                    "certificationEvidenceBytes" to certificationMarkerBytes,
                    "certificationEvidenceScope" to "INSIDE_MAX_BYTES_EXPLICIT_KIND_MARKER_ONLY",
                    "diagnosticEvidenceBytes" to diagnosticMarkerBytes,
                    "diagnosticEvidenceScope" to "INSIDE_MAX_BYTES_EXPLICIT_KIND_MARKER_ONLY",
                    "rawPpgEnvelopeBytes" to rawPpgBytes,
                    "certificationSnapshotBytes" to certification.sumOf { it["utf8Bytes"] as Long },
                    "certificationSnapshotScope" to "OUTSIDE_MAX_BYTES",
                    "reservedSourceFileBytes" to fileBytes,
                    "reservedSourceFileScope" to "INSIDE_MAX_BYTES_RESERVED_ACCOUNTED_ONLY_FILE_PAYLOAD_NOT_IN_SQLITE",
                    "sourceFileCount" to db.rawQuery("SELECT COUNT(*) FROM source_files", null).use { it.moveToFirst(); it.getLong(0) },
                    "largestSourceFiles" to files.take(5),
                ),
                "recoveryPlanning" to linkedMapOf(
                    "currentBytes" to totalBytes, "maxBytes" to maxBytes,
                    "currentUtilizationPercent" to if (maxBytes > 0) totalBytes * 100.0 / maxBytes else null,
                    "target80PercentBytes" to target80, "bytesToRelieveFor80Percent" to maxOf(0L, totalBytes - target80),
                    "pressureWarning90PercentBytes" to target90,
                    "bytesToRelieveBelow90Percent" to maxOf(0L, totalBytes - target90),
                    "pressureWarning90Active" to (totalBytes >= target90),
                    "potentialArchivableCertificationBytes" to null,
                    "markerBasedCertificationBytes" to certificationMarkerBytes,
                    "potentialDuplicateBlobBytes" to duplicateContentBytes,
                    "potentialColdDiagnosticBytes" to diagnosticMarkerBytes,
                    "candidatesOverlapAndAreNotAdditive" to true,
                    "candidateStatus" to unsafe,
                    "recoveryThresholdStatus" to "REQUIRES_AT_MOST_80_PERCENT_BYTES_AND_ENVELOPES_PLUS_INTEGRITY_SCOPE_FILESYSTEM_GATES",
                    "archiveSemantics" to "Copying evidence to an archive does not reduce the active journal's accounted bytes. Capacity relief requires a later governed operation that both proves immutable archive preservation and removes/reclassifies the archived payload from the active hot-budget accounting. No such operation exists in this build.",
                ), "generatedAt" to JCVitalV8Time.isoUtc(now),
                "readOnly" to true, "limitsScope" to "GLOBAL_DATABASE_ALL_OWNERS",
                "failedClosed" to failed, "lastFailureCode" to lastFailure, "maxBytes" to maxBytes,
                "totalAccountedBytes" to totalBytes, "envelopeJsonBytes" to jsonBytes,
                "rawBlobBytes" to rawBytes, "perEnvelopeOverheadBytes" to overhead,
                "reservedSourceFileBytes" to fileBytes,
                "otherAccountedBytes" to totalBytes - jsonBytes - rawBytes - overhead - fileBytes,
                "accountingMatches" to (totalCount == count && totalBytes == envelopeBytes + fileBytes
                    && envelopeBytes == jsonBytes + rawBytes + overhead),
                "hotProductionBytes" to null, "coldCertificationBytes" to null,
                "classificationReason" to "Capture mode/type/age alone cannot establish exclusive purpose, terminal certification state or archive eligibility.",
                "groups" to ranked, "top5ByteContributors" to largest,
                "sourceFilesTop20" to files,
                "sourceFileCount" to db.rawQuery("SELECT COUNT(*) FROM source_files", null).use { it.moveToFirst(); it.getLong(0) },
                "certificationSnapshotsOutsideBudget" to certification,
                "duplicateRawCandidatesTop20" to duplicates.take(20), "duplicateRawCandidateGroups" to duplicates.size,
                "duplicateCaveat" to "Declared hash matches only; repeated notifications may be legitimate. Cross-file/BLOB duplication and byte equality are not verified. No relief is authorized.",
                "expectedNextSyncBytes" to null, "safeHeadroomForNextWrite" to null,
            )
        }
    }
    }
    @Synchronized fun failClosed(reason: String) {
        failed = true
        refusedCount++
        lastOutcome = reason
        lastFailure = reason
        lastFailureMessage = reason
        lastFailureTimestamp = JCVitalV8Time.isoUtc(System.currentTimeMillis())
        persistOutcome()
    }
    private fun persistOutcome() {
        if (!outcomePrefs.edit().putLong("refusedCount", refusedCount).putString("lastOutcome", lastOutcome)
                .putString("lastFailure", lastFailure)
                .putString("lastFailureMessage", lastFailureMessage)
                .putString("lastFailureTimestamp", lastFailureTimestamp)
                .putBoolean("failedClosed", failed).commit()) throw Failure("OUTCOME_PERSISTENCE_FAILED")
    }
    @Synchronized fun setDeviceContext(firmware: String?, acquisition: String? = null, sessionId: String? = null,
        characteristic: String? = null, mtu: Int? = null, monotonicMillis: Long? = null,
        requestId: String? = null, connectionGeneration: Long? = null) {
        firmwareVersion = firmware
        acquisitionMode = acquisition
        acquisitionSessionId = sessionId
        characteristicUuid = characteristic
        negotiatedMtu = mtu
        receivedMonotonicMillis = monotonicMillis
        this.requestId = requestId
        this.connectionGeneration = connectionGeneration
    }

    private fun sourceHeader(json: JSONObject, owner: Scope): JSONObject = json
        .put("accountId", owner.accountId).put("provider", "JCVITAL")
        .put("deviceScopeId", owner.deviceScopeId)
        .put("deviceModel", "PRO_V8")
        .put("firmwareVersion", firmwareVersion ?: JSONObject.NULL)
        .put("acquisitionMode", acquisitionMode ?: JSONObject.NULL)
        .put("sessionId", acquisitionSessionId ?: JSONObject.NULL)
        .put("requestId", requestId ?: JSONObject.NULL)
        .put("connectionGeneration", connectionGeneration ?: JSONObject.NULL)
        .put("characteristicUuid", characteristicUuid ?: JSONObject.NULL)
        .put("negotiatedMtu", negotiatedMtu ?: JSONObject.NULL)
        .put("receivedMonotonicMillis", receivedMonotonicMillis ?: JSONObject.NULL)
        .put("semanticClassification", "UNCLASSIFIED_L0_ORIGINAL_VENDOR_SOURCE")
        .put("semanticConfidence", "UNKNOWN_VENDOR_SEMANTICS")
        .put("parserVersion", JCVitalV8EventNormalizer.PARSER_VERSION)
        .put("normalizerVersion", JCVitalV8EventNormalizer.PARSER_VERSION)
        .put("sdkVersion", JCVitalV8EventNormalizer.SDK_VERSION)
        .put("callbackIdentifier", "BleSDK.DataParsingWithData")
        .put("sourceRecordId", JSONObject.NULL)
        .put("observedAt", JSONObject.NULL).put("sourceDate", JSONObject.NULL)
        .put("sourceIndex", JSONObject.NULL).put("vendorDataType", JSONObject.NULL)
        .put("vendorDerived", JSONObject.NULL)
        .put("sourceRecordGroupId", JSONObject.NULL)
        .put("sdkDecoder", "BleSDK.DataParsingWithData").put("sourceConnector", "JCVITAL_NATIVE")

    private fun owner(accountId: String?, deviceScopeId: String?): Scope {
        val active = scope ?: throw Failure("SCOPE_NOT_CONFIGURED")
        if (active.accountId != accountId || active.deviceScopeId != deviceScopeId) throw Failure("OWNER_MISMATCH")
        return active
    }

    private fun totals(db: SQLiteDatabase): Pair<Long, Long> {
        return db.rawQuery("SELECT envelopes,bytes FROM journal_totals WHERE singleton=1", null).use {
            it.moveToFirst(); it.getLong(0) to it.getLong(1)
        }
    }

    private fun checkCapacity(db: SQLiteDatabase, count: Long, bytes: Long) {
        val total = totals(db)
        if (total.first + count > maxEnvelopes || total.second + bytes > maxBytes) throw Failure("STORAGE_PRESSURE")
    }

    private fun <T> guarded(block: (Scope, SQLiteDatabase) -> T): T {
        val active = scope ?: run { refusedCount++; lastOutcome = "DISABLED"; persistOutcome(); throw Failure("SCOPE_NOT_CONFIGURED") }
        if (failed) { refusedCount++; persistOutcome(); throw Failure("JOURNAL_FAILED_CLOSED") }
        try {
            return block(active, writableDatabase).also { lastOutcome = "PERSISTED"; persistOutcome() }
        } catch (t: Exception) {
            failed = true; refusedCount++
            lastOutcome = (t as? Failure)?.reason ?: if (t is IllegalArgumentException) t.message ?: "SNAPSHOT_FAILED" else "STORAGE_FAILURE"
            lastFailure = lastOutcome
            lastFailureMessage = "${t.javaClass.simpleName}: ${t.message}"
            lastFailureTimestamp = JCVitalV8Time.isoUtc(System.currentTimeMillis())
            try { persistOutcome() } catch (persistError: Exception) { t.addSuppressed(persistError) }
            throw Failure(lastOutcome, t)
        }
    }

    private fun insert(db: SQLiteDatabase, owner: Scope, id: String, callbackId: String?, index: Int?, kind: String, received: Long, timezone: String, json: String, raw: ByteArray? = null) {
        val values = ContentValues().apply {
            put("id", id); put("account", owner.accountId); put("device", owner.deviceScopeId)
            put("callback_id", callbackId); put("record_index", index); put("kind", kind)
            put("received", received); put("timezone", timezone); put("json", json); put("raw", raw)
            put("bytes", json.toByteArray(Charsets.UTF_8).size.toLong() + (raw?.size ?: 0) + 1024)
        }
        db.insertOrThrow("envelopes", null, values)
    }

    @Synchronized
    fun appendRaw(bytes: ByteArray?, received: Long, timezone: String, parentId: String? = null, kind: String = "BLE_NOTIFICATION",
        extra: Map<String, Any?>? = null): String =
        guarded { owner, db ->
            require((bytes?.size ?: 0) <= maxEntryBytes) { "ENTRY_TOO_LARGE" }
            val id = UUID.randomUUID().toString()
            val json = sourceHeader(JSONObject(), owner).put("modelVersion", MODEL_VERSION).put("envelopeId", id)
                .put("kind", kind).put("parentEnvelopeId", parentId ?: JSONObject.NULL)
                .put("sourceRecordId", id).put("sourceRecordGroupId", parentId ?: id)
                .put("callbackIdentifier", when (kind) {
                    "SDK_BYTE_CALLBACK" -> "DataListener2301.dataCallback(byte[])"
                    "WORKOUT_COMMAND_REQUEST" -> "BleSDK.GetActivityModeDataWithMode(byte)"
                    "WORKOUT_COMMAND_WRITE_ACK" -> "BluetoothGattCallback.onCharacteristicWrite"
                    "PPG_COMMAND_REQUEST" -> "BleSDK.ppgWithMode(int,int)"
                    "PPG_COMMAND_WRITE_ACK", "PPG_COMMAND_WRITE_FAILED" -> "BluetoothGattCallback.onCharacteristicWrite"
                    "PPG_CERTIFICATION_SESSION_OPEN", "PPG_CERTIFICATION_TERMINAL" -> "RawPpgCertificationCapture"
                    else -> "BluetoothGattCallback.onCharacteristicChanged"
                })
                .apply {
                    if (kind.startsWith("WORKOUT_COMMAND_")) {
                        put("sdkCommand", "GetActivityModeDataWithMode"); put("vendorDataType", "29")
                    }
                    extra?.forEach { (key, value) ->
                        require(!has(key)) { "ENVELOPE_EXTRA_KEY_COLLISION" }
                        put(key, value ?: JSONObject.NULL)
                    }
                }
                .put("callbackId", if (kind == "SDK_BYTE_CALLBACK") id else JSONObject.NULL)
                .put("receivedAt", JCVitalV8Time.isoUtc(received)).put("timezone", timezone)
                .put("sdkVersion", JCVitalV8EventNormalizer.SDK_VERSION)
                .put("sha256", bytes?.let { data ->
                    java.security.MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it.toInt() and 255) }
                } ?: JSONObject.NULL)
                .put("byteLength", bytes?.size ?: JSONObject.NULL).toString()
            require(json.toByteArray().size.toLong() + (bytes?.size ?: 0) <= maxEntryBytes) { "ENTRY_TOO_LARGE" }
            db.beginTransaction()
            try {
                checkCapacity(db, 1, json.toByteArray().size.toLong() + (bytes?.size ?: 0) + 1024)
                insert(db, owner, id, if (kind == "SDK_BYTE_CALLBACK") id else null, null, kind, received, timezone, json, bytes)
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            id
        }

    @Synchronized
    fun appendParserOutcome(notificationId: String, status: String, callbackCount: Int, errorClass: String?,
        received: Long, timezone: String) = guarded { owner, db ->
        val id = UUID.randomUUID().toString()
        val json = sourceHeader(JSONObject(), owner).put("modelVersion", MODEL_VERSION)
            .put("envelopeId", id).put("kind", "SDK_PARSE_OUTCOME").put("notificationEnvelopeId", notificationId)
            .put("sourceRecordId", id).put("sourceRecordGroupId", notificationId)
            .put("status", status).put("mapCallbackCount", callbackCount).put("errorClass", errorClass ?: JSONObject.NULL)
            .put("receivedAt", JCVitalV8Time.isoUtc(received)).put("timezone", timezone).toString()
        require(json.toByteArray().size <= maxEntryBytes) { "ENTRY_TOO_LARGE" }
        db.beginTransaction()
        try {
            checkCapacity(db, 1, json.toByteArray().size.toLong() + 1024)
            insert(db, owner, id, null, null, "SDK_PARSE_OUTCOME", received, timezone, json)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        id
    }

    @Synchronized
    fun appendCallback(vendor: Map<*, *>?, received: Long, timezone: String, notificationId: String?): Capture =
        guarded { owner, db ->
            val callbackId = UUID.randomUUID().toString()
            // Encode BEFORE copying or parsing, rejecting unsupported objects explicitly.
            val snapshot = JCVitalV8SourceSnapshot.encode(vendor, maxEntryBytes)
            val data = vendor?.get(DeviceKey.Data)
            val records = when (data) {
                is List<*> -> data
                else -> listOf(data)
            }
            val ids = records.map { UUID.randomUUID().toString() }
            fun header(id: String, kind: String): JSONObject = sourceHeader(JSONObject(), owner)
                .put("modelVersion", MODEL_VERSION).put("snapshotVersion", JCVitalV8SourceSnapshot.VERSION)
                .put("envelopeId", id).put("callbackId", callbackId).put("notificationEnvelopeId", notificationId ?: JSONObject.NULL)
                .put("sourceRecordGroupId", callbackId).put("sourceRecordId", id)
                .put("callbackIdentifier", "DataListener2301.dataCallback(Map)")
                .put("vendorDerived", when (vendor?.get(DeviceKey.DataType)?.toString()) {
                    "42" -> true
                    "27", "68", "59", "127" -> false
                    else -> JSONObject.NULL
                })
                .put("kind", kind).put("receivedAt", JCVitalV8Time.isoUtc(received)).put("timezone", timezone)
                .put("vendorDataType", vendor?.get(DeviceKey.DataType)?.toString() ?: JSONObject.NULL)
                .put("parserVersion", JCVitalV8EventNormalizer.PARSER_VERSION).put("sdkVersion", JCVitalV8EventNormalizer.SDK_VERSION)
            val callback = header(callbackId, "SDK_CALLBACK").put("recordEnvelopeIds", JSONArray(ids))
                .put("sdkSnapshot", if (snapshot == "null") JSONObject.NULL else JSONObject(snapshot)).toString()
            require(callback.toByteArray().size <= maxEntryBytes) { "ENTRY_TOO_LARGE" }
            // Capacity is checked incrementally inside a single transaction: no partially journaled callback.
            db.beginTransaction()
            try {
                checkCapacity(db, 1, callback.toByteArray().size.toLong() + 1024)
                insert(db, owner, callbackId, callbackId, null, "SDK_CALLBACK", received, timezone, callback)
                records.forEachIndexed { index, record ->
                    val recordSnapshot = JCVitalV8SourceSnapshot.encode(record, maxEntryBytes)
                    val date = (record as? Map<*, *>)?.get(DeviceKey.Date)
                    val tokens = JSONArray()
                    var tokenFieldCount = 0
                    var tokenCount = 0
                    if (record is Map<*, *>) record.forEach { (key, value) ->
                        if (value is String) {
                            require(++tokenFieldCount <= 128) { "LEXICAL_FIELD_LIMIT_EXCEEDED" }
                            val encodedKey = JCVitalV8SourceSnapshot.encode(key, maxEntryBytes)
                            val lexicalTokens = JCVitalV8SourceSnapshot.lexicalTokens(value)
                            tokenCount += lexicalTokens.size
                            require(tokenCount <= 8192) { "LEXICAL_RECORD_TOKEN_LIMIT_EXCEEDED" }
                            tokens.put(JSONObject().put("fieldKeySnapshot",
                                if (encodedKey == "null") JSONObject.NULL else JSONObject(encodedKey))
                                .put("sourceText", value)
                                .put("tokens", JSONArray(lexicalTokens.map { JSONObject(it) })))
                        }
                    }
                    val sourceDate = date?.toString()
                    val dateMillis = if (record is Map<*, *>) {
                        @Suppress("UNCHECKED_CAST")
                        JCVitalV8EventNormalizer().vendorRecordStartMillis(record as Map<String, Any?>, timezone)
                    } else null
                    val json = header(ids[index], "SDK_RECORD").put("recordIndex", index)
                        .put("sourceIndex", index)
                        .put("packetId", (record as? Map<*, *>)?.get(DeviceKey.packetID)?.toString() ?: JSONObject.NULL)
                        .put("sdkSnapshot", if (recordSnapshot == "null") JSONObject.NULL else JSONObject(recordSnapshot))
                        .put("sourceDate", sourceDate ?: JSONObject.NULL)
                        .put("sourceDateParseStatus", if (date == null) "MISSING" else if (dateMillis == null) "INVALID" else "VALID")
                        .put("parsedSourceDateMillis", dateMillis ?: JSONObject.NULL)
                        .put("observedAt", dateMillis?.let { JCVitalV8Time.isoUtc(it) } ?: JSONObject.NULL)
                        .put("sourceArrays", JCVitalV8SourceSnapshot.arrayAnnotations(record, maxEntryBytes))
                        .put("lexicalParserVersion", "lexical-int32-token-1")
                        .put("lexicalInterpretation", "ALL_STRING_FIELDS_CANDIDATE_INT32_TOKENS_NOT_SAMPLE_SEMANTICS")
                        .put("lexicalArrays", tokens).toString()
                    require(json.toByteArray().size <= maxEntryBytes) { "ENTRY_TOO_LARGE" }
                    checkCapacity(db, 1, json.toByteArray().size.toLong() + 1024)
                    insert(db, owner, ids[index], callbackId, index, "SDK_RECORD", received, timezone, json)
                }
                db.setTransactionSuccessful()
            } finally { db.endTransaction() }
            Capture(callbackId, ids, received, timezone, snapshot.toByteArray().size)
        }

    @Synchronized
    fun registerFile(file: java.io.File, sessionId: String, kind: String): String = guarded { owner, db ->
        val id = UUID.randomUUID().toString()
        val now = System.currentTimeMillis()
        val timezone = java.util.TimeZone.getDefault().id
        val manifest = sourceHeader(JSONObject(), owner).put("modelVersion", MODEL_VERSION).put("envelopeId", id)
            .put("sourceRecordId", id).put("sourceRecordGroupId", sessionId).put("timezone", timezone)
            .put("fileId", id).put("path", file.absolutePath).put("sessionId", sessionId).put("format", kind)
            .put("kind", "RAW_SESSION_FILE").put("receivedAt", JCVitalV8Time.isoUtc(now))
            .put("byteEncoding", "MAGIC_8_BYTES_THEN_BIG_ENDIAN_INT32_LENGTH_AND_ORIGINAL_BYTES")
            .put("durability", "FD_SYNC_AFTER_EACH_CHUNK").toString()
        require(manifest.toByteArray().size <= maxEntryBytes) { "ENTRY_TOO_LARGE" }
        db.beginTransaction()
        try {
            checkCapacity(db, 1, file.length() + manifest.toByteArray().size + 1024)
            db.insertOrThrow("source_files", null, ContentValues().apply {
                put("id", id); put("account", owner.accountId); put("device", owner.deviceScopeId)
                put("path", file.absolutePath); put("session_id", sessionId); put("kind", kind); put("bytes", file.length())
            })
            insert(db, owner, id, null, null, "RAW_SESSION_FILE", now, timezone, manifest)
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
        id
    }

    @Synchronized fun reserveFileBytes(path: String, additionalBytes: Long) = guarded { owner, db ->
        require(additionalBytes >= 0)
        db.beginTransaction()
        try {
            checkCapacity(db, 0, additionalBytes)
            val changed = db.compileStatement("UPDATE source_files SET bytes=bytes+? WHERE path=? AND account=? AND device=?").use {
                it.bindLong(1, additionalBytes); it.bindString(2, path); it.bindString(3, owner.accountId); it.bindString(4, owner.deviceScopeId)
                it.executeUpdateDelete()
            }
            if (changed != 1) throw Failure("FILE_NOT_CATALOGUED")
            db.setTransactionSuccessful()
        } finally { db.endTransaction() }
    }

    @Synchronized
    fun diagnostics(accountId: String?, deviceScopeId: String?): Map<String, Any?> {
        if (scope != null) owner(accountId, deviceScopeId)
        val active = scope
        val total = if (active != null) readableDatabase.rawQuery(
            "SELECT COUNT(*),COALESCE(SUM(bytes),0) FROM envelopes WHERE account=? AND device=?",
            arrayOf(active.accountId, active.deviceScopeId)).use { c ->
                c.moveToFirst(); c.getLong(0) to c.getLong(1)
            } else 0L to 0L
        val fileBytes = if (active != null) readableDatabase.rawQuery(
            "SELECT COALESCE(SUM(bytes),0) FROM source_files WHERE account=? AND device=?",
            arrayOf(active.accountId, active.deviceScopeId)).use { c -> c.moveToFirst(); c.getLong(0) } else 0L
        return linkedMapOf("modelVersion" to MODEL_VERSION, "enabled" to (scope != null),
            "failedClosed" to failed, "lastOutcome" to lastOutcome, "refusedCount" to refusedCount,
            "lastFailure" to lastFailure,
            "priorFailureCode" to outcomePrefs.getString("priorFailureCode", null),
            "priorFailureMessage" to outcomePrefs.getString("priorFailureMessage", null),
            "priorFailureTimestamp" to outcomePrefs.getString("priorFailureTimestamp", null),
            "recoveryAudit" to outcomePrefs.getString("recoveryAudit", null)?.let { JSONObject(it) },
            "recoveryAuditHistory" to recoveryAuditHistory(),
            "latestRecoveryAudit" to outcomePrefs.getString("latestRecoveryAudit", outcomePrefs.getString("recoveryAudit", null))?.let { JSONObject(it) },
            "previousFailedClosed" to outcomePrefs.getBoolean("failedClosed", false),
            "totalEnvelopeCount" to total.first, "totalStoredBytes" to total.second + fileBytes,
            "maxBytes" to maxBytes, "maxEnvelopes" to maxEnvelopes, "maxEntryBytes" to maxEntryBytes,
            "byteAccounting" to "UTF8_ENVELOPES_PLUS_RAW_BLOBS_PLUS_1024_PER_ENVELOPE_PLUS_RESERVED_FILES",
            "limitsScope" to "GLOBAL_DATABASE_ALL_OWNERS",
            "retentionPolicy" to "APPEND_ONLY_NO_AUTOMATIC_EVICTION", "rawStorage" to "SQLITE_BLOB_AND_PERSISTENT_SESSION_FILES")
    }

    @Synchronized
    fun list(accountId: String?, deviceScopeId: String?, after: Long, limit: Int, includePayload: Boolean = false): Map<String, Any?> {
        val owner = owner(accountId, deviceScopeId)
        require(after >= 0 && limit in 1..100)
        val items = ArrayList<Map<String, Any?>>()
        var next = after
        var responseBytes = 0L
        readableDatabase.rawQuery("SELECT sequence,id,callback_id,record_index,kind,received,timezone,json,raw FROM envelopes WHERE account=? AND device=? AND sequence>? ORDER BY sequence LIMIT ?",
            arrayOf(owner.accountId, owner.deviceScopeId, after.toString(), (limit + 1).toString())).use { cursor ->
            while (cursor.moveToNext()) {
                val json = if (includePayload) cursor.getString(7) else null
                val raw = if (includePayload && !cursor.isNull(8)) cursor.getBlob(8) else null
                val size = (json?.toByteArray()?.size ?: 0) + (raw?.size?.times(4L)?.div(3) ?: 0) + 1024
                if (items.size >= limit || (items.isNotEmpty() && responseBytes + size > 8L * 1024 * 1024)) break
                next = cursor.getLong(0); responseBytes += size
                items.add(linkedMapOf("sequence" to next, "envelopeId" to cursor.getString(1),
                    "callbackId" to cursor.getString(2), "recordIndex" to if (cursor.isNull(3)) null else cursor.getInt(3),
                    "kind" to cursor.getString(4), "receivedAt" to JCVitalV8Time.isoUtc(cursor.getLong(5)),
                    "timezone" to cursor.getString(6), "envelopeJson" to json,
                    "rawBytesBase64" to raw?.let { Base64.encodeToString(it, Base64.NO_WRAP) }))
            }
        }
        val hasMore = readableDatabase.rawQuery("SELECT 1 FROM envelopes WHERE account=? AND device=? AND sequence>? LIMIT 1",
            arrayOf(owner.accountId, owner.deviceScopeId, next.toString())).use { it.moveToFirst() }
        return mapOf("modelVersion" to MODEL_VERSION, "envelopes" to items, "nextSequence" to next, "hasMore" to hasMore)
    }

    @Synchronized
    fun read(accountId: String?, deviceScopeId: String?, id: String): Map<String, Any?> {
        return readOwned(owner(accountId, deviceScopeId), id)
    }

    private fun readOwned(owner: Scope, id: String): Map<String, Any?> {
        return readableDatabase.rawQuery("SELECT sequence,json,raw FROM envelopes WHERE account=? AND device=? AND id=?",
            arrayOf(owner.accountId, owner.deviceScopeId, id)).use { cursor ->
            if (!cursor.moveToFirst()) throw Failure("ENVELOPE_NOT_FOUND")
            mapOf("envelopeId" to id, "sequence" to cursor.getLong(0), "envelopeJson" to cursor.getString(1),
                "rawBytesBase64" to if (cursor.isNull(2)) null else Base64.encodeToString(cursor.getBlob(2), Base64.NO_WRAP),
                "sourceFile" to readableDatabase.rawQuery("SELECT path,session_id,kind,bytes FROM source_files WHERE account=? AND device=? AND id=?",
                    arrayOf(owner.accountId, owner.deviceScopeId, id)).use { file ->
                    if (file.moveToFirst()) {
                        val rawFile = java.io.File(file.getString(0))
                        val actualBytes = rawFile.length()
                        mapOf("fileId" to id, "path" to file.getString(0), "sessionId" to file.getString(1),
                            "format" to file.getString(2), "reservedBytes" to file.getLong(3), "actualBytes" to actualBytes,
                            "available" to rawFile.isFile,
                            "integrityStatus" to if (!rawFile.isFile) "MISSING" else if (actualBytes != file.getLong(3)) "RESERVED_LENGTH_MISMATCH" else "RESERVED_LENGTH_MATCH")
                    } else null
                })
        }
    }

    companion object {
        const val MODEL_VERSION = JCVitalV8SourceSnapshot.MODEL_VERSION
        const val PPG_PHYSICAL_KIND = "RawPpgPhysicalCertification"
        const val PPG_PHYSICAL_TABLE = "ppg_physical_certification_chunks"
        private const val DATABASE_NAME = "jcvital-source-envelope-v1.db"
        private const val STORAGE_PRESSURE = "STORAGE_PRESSURE"
        private const val STORAGE_PRESSURE_BUDGET_RECOVERY = "STORAGE_PRESSURE_BUDGET_RECOVERY"
        private const val LEGACY_MAX_BYTES = 64L * 1024 * 1024
        private const val DEFAULT_MAX_BYTES = 256L * 1024 * 1024
        private const val MIN_RECOVERY_HEADROOM_BYTES = 512L * 1024 * 1024
    }
}
