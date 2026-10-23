package com.hapi.eliteplus.connector.jcvital

import android.bluetooth.BluetoothManager
import android.content.Context
import android.os.Looper
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.other.ResolveUtil
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class SleepCertificationTest {
    private fun packet(command: Int, length: Int = 130) = ByteArray(length).also {
        it[0] = command.toByte()
        it[3] = 0x26; it[4] = 0x10; it[5] = 0x04; it[6] = 0x23
        it[9] = 2; it[10] = 0; it[11] = 0x0A
        if (length >= 130) { it[70] = 0x0B; it[71] = 0 }
    }
    @Test fun exactSleepCommandsStartAndContinueNeverDelete() {
        for (mode in listOf(0x00, 0x02)) {
            val stages = BleSDK.GetDetailSleepDataWithMode(mode.toByte(), "")
            val movement = BleSDK.getObtainDetailedSleepData(mode.toByte(), "")
            assertEquals(0x53, stages[0].toInt() and 255)
            assertEquals(0x6B, movement[0].toInt() and 255)
            assertEquals(mode, stages[1].toInt() and 255)
            assertEquals(mode, movement[1].toInt() and 255)
        }
    }
    @Test fun type26ParserPreservesFieldsOriginalZeroAndSdkUnitLength() {
        for ((length, unit) in listOf(130 to "1", 34 to "5")) {
            val parsed = ResolveUtil.getSleepData(packet(0x53, length))
            assertEquals("26", parsed[DeviceKey.DataType])
            val records = parsed[DeviceKey.Data] as List<*>
            val record = records.single() as Map<*, *>
            assertEquals(setOf("date", "arraySleepQuality", "sleepUnitLength"), record.keys)
            assertEquals("2026-10-04 23:00:00", record["date"])
            assertEquals(unit, record["sleepUnitLength"])
            assertEquals("0 10 ", record["arraySleepQuality"])
            assertTrue(record.values.all { it is String })
        }
    }
    @Test fun type121ParserPreservesHexNibbleStringsWithoutAssigningCanonicalStages() {
        val parsed = ResolveUtil.getObtainDetailedSleepData(packet(0x6B))
        assertEquals("121", parsed[DeviceKey.DataType])
        val record = (parsed[DeviceKey.Data] as List<*>).single() as Map<*, *>
        assertEquals(setOf("date", "sleepLength", "Sleep_level", "ActivityData"), record.keys)
        assertEquals("2026.10.04 23:00:00", record["date"])
        assertEquals("2", record["sleepLength"])
        assertEquals("[0, 0, 0, A]", record["Sleep_level"])
        assertEquals("[0, B, 0, 0]", record["ActivityData"])
        assertTrue(record.values.all { it is String })
    }
    @Test fun sdkDispatchProducesValidEmptyTerminalCallbacksForBothPaths() {
        BleSDK.GetDetailSleepDataWithMode(0x00, "")
        BleSDK.getObtainDetailedSleepData(0x00, "")
        for ((command, type) in listOf(0x53 to "26", 0x6B to "121")) {
            val callbacks = ArrayList<Map<String?, Any?>>()
            BleSDK.DataParsingWithData(byteArrayOf(command.toByte(), 0xFF.toByte()), object : DataListener2301 {
                override fun dataCallback(maps: MutableMap<String?, Any?>?) { maps?.let(callbacks::add) }
                override fun dataCallback(value: ByteArray?) = Unit
            })
            assertEquals(1, callbacks.size)
            assertEquals(type, callbacks.single()[DeviceKey.DataType])
            assertEquals(true, callbacks.single()[DeviceKey.End])
            assertEquals(emptyList<Any>(), callbacks.single()[DeviceKey.Data])
        }
    }
    @Test fun emptyCallbackHasDurableBleAncestryEvenWithoutSdkRecords() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        val journal = JCVitalV8SourceJournal(context)
        try {
            journal.configure("sleep-owner", "sleep-device", true, null, null, null)
            journal.setDeviceContext("1", "HISTORICAL_SYNC", "sleep-session")
            val rawId = journal.appendRaw(byteArrayOf(0x53, 0xFF.toByte()), 0, "UTC")
            val capture = journal.appendCallback(ResolveUtil.getSleepData(byteArrayOf(0x53, 0xFF.toByte())), 0, "UTC", rawId)
            assertTrue(capture.recordIds.isEmpty())
            val callback = JSONObject(journal.read("sleep-owner", "sleep-device", capture.callbackId)["envelopeJson"] as String)
            assertEquals(rawId, callback.getString("notificationEnvelopeId"))
            assertEquals(0, callback.getJSONArray("recordEnvelopeIds").length())
            val raw = JSONObject(journal.read("sleep-owner", "sleep-device", rawId)["envelopeJson"] as String)
            assertEquals(2, raw.getInt("byteLength"))
            assertEquals("sleep-session", raw.getString("sessionId"))
        } finally { journal.close(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun sleepSnapshotSurvivesRestartAndIsSeparateFromActivityAndOtherOwners() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        var journal = JCVitalV8SourceJournal(context)
        try {
            journal.configure("sleep-owner", "sleep-device", true, null, null, null)
            val json = JSONObject().put("kind", "SleepCertification").put("context",
                JSONObject().put("scope", JSONObject().put("accountId", "sleep-owner").put("deviceScopeId", "sleep-device")))
                .put("evidence", "0A\uD83D\uDE00".repeat(400_000)).toString()
            journal.writeSleepCertification("sleep-owner", "sleep-device", json)
            journal.close()
            journal = JCVitalV8SourceJournal(context)
            journal.configure("sleep-owner", "sleep-device", true, null, null, null)
            assertEquals(json, journal.readSleepCertification("sleep-owner", "sleep-device")["json"])
            assertNull(journal.readActivityCertification("sleep-owner", "sleep-device")["json"])
            assertThrows(JCVitalV8SourceJournal.Failure::class.java) { journal.readSleepCertification("other", "sleep-device") }
            assertThrows(IllegalArgumentException::class.java) {
                journal.writeSleepCertification("sleep-owner", "sleep-device", json.replace("SleepCertification", "Activity24_25Certification"))
            }
            assertEquals(json, journal.readSleepCertification("sleep-owner", "sleep-device")["json"])
        } finally { journal.close(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun oneNativeSessionRetainsEmptyCallbackIdsAndPhysicalRepeatsAcrossBothPaths() {
        val context = RuntimeEnvironment.getApplication()
        shadowOf(context).grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        val manager = JCVitalV8Manager(context) { _, _ -> }
        fun field(name: String) = JCVitalV8Manager::class.java.getDeclaredField(name).apply { isAccessible = true }
        val adapter = context.getSystemService(BluetoothManager::class.java).adapter
        field("gatt").set(manager, adapter.getRemoteDevice("AA:BB:CC:DD:EE:FF").connectGatt(context, false, object : android.bluetooth.BluetoothGattCallback() {}))
        val machine = field("stateMachine").get(manager) as JCVitalV8ConnectionStateMachine
        listOf(JCVitalV8ConnectionState.CONNECTING, JCVitalV8ConnectionState.CONNECTED,
            JCVitalV8ConnectionState.INITIALIZING, JCVitalV8ConnectionState.READY).forEach { assertTrue(machine.transition(it)) }
        val response = JCVitalV8Manager::class.java.getDeclaredMethod("handleHistoricalResponse", String::class.java,
            Map::class.java, List::class.java, JCVitalV8SourceJournal.Capture::class.java).apply { isAccessible = true }
        fun requestField(request: Any, name: String) = request.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(request)
        var completed: Map<String, Any?>? = null
        try {
            manager.sourceJournal.configure("sleep-owner", "sleep-device", true, null, null, null)
            manager.syncSleepCertification { result, error -> assertNull(error); completed = result }
            shadowOf(Looper.getMainLooper()).idle()
            val stages = field("historicalRequest").get(manager)!!
            assertEquals("26", requestField(stages, "dataType"))
            assertEquals(true, requestField(stages, "preservePhysicalRecords"))
            val session = requestField(stages, "syncId")
            response.invoke(manager, "24", mapOf(DeviceKey.End to true, DeviceKey.Data to emptyList<Any>()),
                emptyList<Any>(), JCVitalV8SourceJournal.Capture("unrelated", emptyList(), 0, "UTC"))
            assertSame(stages, field("historicalRequest").get(manager))
            response.invoke(manager, "26", mapOf(DeviceKey.End to true, DeviceKey.Data to emptyList<Any>()),
                emptyList<Any>(), JCVitalV8SourceJournal.Capture("empty-callback", emptyList(), 0, "UTC"))
            shadowOf(Looper.getMainLooper()).idle()
            val movement = field("historicalRequest").get(manager)!!
            assertEquals("121", requestField(movement, "dataType"))
            assertEquals(session, requestField(movement, "syncId"))
            val events = listOf("record-1", "record-2").map { id ->
                JCVitalV8EventNormalizer.Event(JCVitalV8EventNormalizer.EVENT_OBSERVATION,
                    mapOf("id" to "same-normalized-id", "provenance" to mapOf("sourceEnvelopeId" to id)))
            }
            response.invoke(manager, "121", mapOf(DeviceKey.End to true,
                DeviceKey.Data to listOf(emptyMap<String, Any>(), emptyMap<String, Any>())), events,
                JCVitalV8SourceJournal.Capture("populated-callback", listOf("record-1", "record-2"), 0, "UTC"))
            shadowOf(Looper.getMainLooper()).idle()
            val results = completed!!["results"] as List<*>
            assertEquals("COMPLETE", completed!!["outcome"])
            assertNull(completed!!["acquisitionError"])
            assertEquals(session, completed!!["acquisitionSessionId"])
            assertEquals(2, results.size)
            val first = results[0] as Map<*, *>
            val second = results[1] as Map<*, *>
            assertEquals("EMPTY_VALID", first["completionStatus"])
            assertEquals(listOf("empty-callback"), first["sourceCallbackEnvelopeIds"])
            assertEquals(emptyList<String>(), first["sourceRecordEnvelopeIds"])
            assertEquals(listOf("record-1", "record-2"), second["sourceRecordEnvelopeIds"])
            assertEquals(2, (second["observations"] as List<*>).size)
            assertEquals(0, second["recordsDeduplicated"])
            assertNull(field("historicalRequest").get(manager))
        } finally { manager.release(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun notReadyAcquisitionReturnsExplicitFailedEvidenceNotEmptySuccess() {
        val context = RuntimeEnvironment.getApplication()
        shadowOf(context).grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        val manager = JCVitalV8Manager(context) { _, _ -> }
        var completed: Map<String, Any?>? = null
        try {
            manager.syncSleepCertification { result, error -> assertNull(error); completed = result }
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("FAILED", completed!!["outcome"])
            assertNotNull(completed!!["acquisitionSessionId"])
            assertNotNull(completed!!["acquisitionError"])
            assertEquals(emptyList<Any>(), completed!!["results"])
        } finally { manager.release() }
    }
}
