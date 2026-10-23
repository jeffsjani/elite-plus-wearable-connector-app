package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import android.database.sqlite.SQLiteDatabase
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class V8PipelineStorageAuditTest {
    private lateinit var context: Context

    @Before fun prepare() {
        context = RuntimeEnvironment.getApplication()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        context.deleteDatabase("elite_plus_connectorSQLite.db")
    }

    @Test fun missingEvidenceRemainsUnknownWithoutCreatingDatabases() {
        val result = V8PipelineStorageAudit.read(context)
        assertEquals(false, result["journalExists"])
        assertEquals(false, result["queueExists"])
        assertFalse(context.getDatabasePath("jcvital-source-envelope-v1.db").exists())
    }

    @Test fun auditsOwnersAndVendorTimestampWithoutMutatingRows() {
        val db = context.openOrCreateDatabase("jcvital-source-envelope-v1.db", Context.MODE_PRIVATE, null)
        db.execSQL("CREATE TABLE envelopes(sequence INTEGER PRIMARY KEY,account TEXT,device TEXT,kind TEXT,json TEXT)")
        val source = JSONObject().put("vendorDataType", "42").put("observedAt", "2026-10-01T00:00:00Z")
            .put("sourceDateParseStatus", "VALID").put("sourceDate", "2026.10.01")
            .put("receivedAt", "2026-10-04T00:00:00Z").toString()
        db.execSQL("INSERT INTO envelopes VALUES(1,'athlete-a','physical','SDK_RECORD',?)", arrayOf(source))
        db.execSQL("INSERT INTO envelopes VALUES(2,'athlete-b','diag-device','SDK_RECORD',?)", arrayOf(source))
        db.close()
        val result = V8PipelineStorageAudit.read(context)
        val scopes = result["retainedScopes"] as List<*>
        assertEquals(2, scopes.size)
        val records = result["sourceRecords"] as List<*>
        val first = records.first() as Map<*, *>
        assertEquals("2026-10-01T00:00:00Z", first["latestVendorTimestamp"])
        assertEquals("2026-10-04T00:00:00Z", first["latestCaptureTimestamp"])
        assertEquals("VENDOR_DEVICE_TIMESTAMP", first["timestampAuthority"])
        SQLiteDatabase.openDatabase(context.getDatabasePath("jcvital-source-envelope-v1.db").path, null, SQLiteDatabase.OPEN_READONLY).use {
            it.rawQuery("SELECT COUNT(*) FROM envelopes", null).use { cursor -> cursor.moveToFirst(); assertEquals(2, cursor.getInt(0)) }
        }
    }

    @Test fun captureOnlyTimestampIsNotPromotedToDeviceTime() {
        context.openOrCreateDatabase("jcvital-source-envelope-v1.db", Context.MODE_PRIVATE, null).use {
            it.execSQL("CREATE TABLE envelopes(sequence INTEGER PRIMARY KEY,account TEXT,device TEXT,kind TEXT,json TEXT)")
            it.execSQL("INSERT INTO envelopes VALUES(1,'a','v8','SDK_RECORD',?)",
                arrayOf(JSONObject().put("vendorDataType", "127").put("receivedAt", "2026-10-04T00:00:00Z").toString()))
        }
        val first = (V8PipelineStorageAudit.read(context)["sourceRecords"] as List<*>).first() as Map<*, *>
        assertNull(first["latestVendorTimestamp"])
        assertEquals("UNKNOWN", first["timestampAuthority"])
    }
}
