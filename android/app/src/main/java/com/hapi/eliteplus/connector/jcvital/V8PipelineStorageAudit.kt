package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject

/** Reads retained evidence without opening the journal helper or changing its schema/retention. */
internal object V8PipelineStorageAudit {
    fun read(context: Context): Map<String, Any?> {
        val scopes = mutableListOf<Map<String, Any?>>()
        val sources = linkedMapOf<String, MutableMap<String, Any?>>()
        val journal = context.getDatabasePath("jcvital-source-envelope-v1.db")
        if (journal.exists()) {
            SQLiteDatabase.openDatabase(journal.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
                db.rawQuery("SELECT account,device,COUNT(*),MAX(sequence) FROM envelopes GROUP BY account,device", null).use { cursor ->
                    while (cursor.moveToNext()) scopes.add(mapOf("accountId" to cursor.getString(0),
                        "deviceScopeId" to cursor.getString(1), "envelopeCount" to cursor.getLong(2),
                        "lastSequence" to cursor.getLong(3)))
                }
                db.rawQuery("SELECT account,device,json FROM envelopes WHERE kind='SDK_RECORD' ORDER BY sequence", null).use { cursor ->
                    while (cursor.moveToNext()) {
                        val json = JSONObject(cursor.getString(2))
                        val type = json.optString("vendorDataType", "UNKNOWN")
                        val account = cursor.getString(0)
                        val device = cursor.getString(1)
                        val key = "$account|$device|$type"
                        val summary = sources.getOrPut(key) { linkedMapOf("accountId" to account,
                            "deviceScopeId" to device, "vendorDataType" to type, "sourceRecordCount" to 0L,
                            "latestVendorTimestamp" to null, "latestCaptureTimestamp" to null,
                            "timestampAuthority" to "UNKNOWN") }
                        summary["sourceRecordCount"] = (summary["sourceRecordCount"] as Long) + 1
                        val observed = json.optString("observedAt").takeUnless { it.isBlank() || it == "null" }
                        if (observed != null && json.optString("sourceDateParseStatus") == "VALID"
                            && (summary["latestVendorTimestamp"] == null || observed > summary["latestVendorTimestamp"].toString())) {
                            summary["latestVendorTimestamp"] = observed
                            summary["vendorDate"] = json.optString("sourceDate")
                            summary["timestampAuthority"] = "VENDOR_DEVICE_TIMESTAMP"
                        }
                        summary["latestCaptureTimestamp"] = json.optString("receivedAt")
                    }
                }
            }
        }
        val queueOwners = mutableListOf<Map<String, Any?>>()
        val queue = context.getDatabasePath("elite_plus_connectorSQLite.db")
        if (queue.exists()) {
            SQLiteDatabase.openDatabase(queue.path, null, SQLiteDatabase.OPEN_READONLY).use { db ->
                db.rawQuery("SELECT owner_user_id,state,COUNT(*) FROM observation_queue GROUP BY owner_user_id,state", null).use { cursor ->
                    while (cursor.moveToNext()) queueOwners.add(mapOf("ownerUserId" to cursor.getString(0),
                        "state" to cursor.getString(1), "count" to cursor.getLong(2)))
                }
            }
        }
        return mapOf("journalExists" to journal.exists(), "queueExists" to queue.exists(),
            "retainedScopes" to scopes, "sourceRecords" to sources.values.toList(), "queueOwners" to queueOwners,
            "localObservationCountAuthority" to "SOURCE_RECORDS_ARE_NOT_SCALAR_OBSERVATION_COUNTS")
    }
}
