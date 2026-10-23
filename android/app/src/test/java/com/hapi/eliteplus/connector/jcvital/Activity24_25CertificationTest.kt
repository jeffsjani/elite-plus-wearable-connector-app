package com.hapi.eliteplus.connector.jcvital

import android.app.Application
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
class Activity24_25CertificationTest {
    private fun packet(type: Int, stride: Int): ByteArray = ByteArray(stride).also {
        it[0] = type.toByte()
        val dateOffset = if (type == 0x51) 2 else 3
        it[dateOffset] = 0x26; it[dateOffset + 1] = 0x10; it[dateOffset + 2] = 0x04
        if (type == 0x52) {
            it[6] = 0x12
            for (index in 0..9) it[15 + index] = index.toByte()
        }
    }
    @Suppress("UNCHECKED_CAST")
    private fun records(map: Map<String, Any?>) = map[DeviceKey.Data] as List<Map<String, Any?>>

    @Test fun type24ParserInventoryBothPhysicalStrides() {
        for (stride in listOf(26, 27)) {
            val bytes = packet(0x51, stride)
            bytes[5] = 42
            bytes[9] = 3
            bytes[13] = 100
            bytes[17] = 50
            bytes[21] = 7
            val parsed = ResolveUtil.getTotalStepData(bytes)
            assertEquals("24", parsed[DeviceKey.DataType])
            assertEquals(false, parsed[DeviceKey.End])
            val source = records(parsed).single()
            assertEquals(setOf("date", "step", "exerciseMinutes", "calories", "distance", "goal"), source.keys)
            assertTrue(source.values.all { it is String })
            assertEquals("2026.10.04", source["date"])
            assertEquals("42", source["step"])
            assertEquals("3", source["exerciseMinutes"])
            assertEquals("0.50", source["calories"])
            assertEquals("1.00", source["distance"])
            assertEquals("7", source["goal"])
            assertFalse(source.containsKey("activeMinutes"))
        }
    }
    @Test fun type25IsTenSlotBlockWithOneExplicitRecordDateAndNoSerial() {
        val parsed = ResolveUtil.getDetailData(packet(0x52, 25))
        assertEquals("25", parsed[DeviceKey.DataType])
        val source = records(parsed).single()
        assertEquals(setOf("date", "detailMinterStep", "calories", "distance", "arraySteps"), source.keys)
        assertTrue(source.values.all { it is String })
        assertEquals("2026.10.04 12:00:00", source["date"])
        assertEquals("0 1 2 3 4 5 6 7 8 9", source["arraySteps"])
        assertEquals("0", source["detailMinterStep"])
        assertEquals("0", source["calories"])
        assertEquals("0", source["distance"])
    }
    @Test fun sdkDispatchReturnsDistinctTypesAndPreservesRepeatedRecords() {
        for ((command, stride, type) in listOf(Triple(0x51, 27, "24"), Triple(0x52, 25, "25"))) {
            val bytes = packet(command, stride)
            val received = ArrayList<Map<String?, Any?>>()
            BleSDK.DataParsingWithData(bytes + bytes, object : DataListener2301 {
                override fun dataCallback(maps: MutableMap<String?, Any?>?) { maps?.let(received::add) }
                override fun dataCallback(value: ByteArray?) = Unit
            })
            assertEquals(type, received.single()[DeviceKey.DataType])
            val values = received.single()[DeviceKey.Data] as List<*>
            assertEquals(2, values.size)
            assertEquals(values[0], values[1])
        }
    }
    @Test fun l0JournalPreservesFullAncestryUnknownNullZeroAndRepeatedType25Records() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        val journal = JCVitalV8SourceJournal(context)
        try {
            journal.configure("activity-owner", "activity-device", true, null, null, null)
            journal.setDeviceContext("1", "HISTORICAL_SYNC", "physical-session")
            val raw = packet(0x52, 25)
            val rawId = journal.appendRaw(raw, 0, "UTC")
            val source = records(ResolveUtil.getDetailData(raw)).single().toMutableMap().apply {
                put("unknownNull", null); put("unknownZero", 0)
            }
            val capture = journal.appendCallback(mapOf(DeviceKey.DataType to "25", DeviceKey.Data to listOf(source, source)), 0, "UTC", rawId)
            assertEquals(2, capture.recordIds.toSet().size)
            for ((index, id) in capture.recordIds.withIndex()) {
                val record = JSONObject(journal.read("activity-owner", "activity-device", id)["envelopeJson"] as String)
                assertEquals(index, record.getInt("recordIndex"))
                assertEquals(capture.callbackId, record.getString("sourceRecordGroupId"))
                assertEquals(rawId, record.getString("notificationEnvelopeId"))
                assertEquals("2026.10.04 12:00:00", record.getString("sourceDate"))
                assertTrue(record.getJSONObject("sdkSnapshot").toString().contains("unknownNull"))
                assertTrue(record.getJSONObject("sdkSnapshot").toString().contains("unknownZero"))
            }
            val notification = JSONObject(journal.read("activity-owner", "activity-device", rawId)["envelopeJson"] as String)
            assertEquals(25, notification.getInt("byteLength"))
            assertEquals(64, notification.getString("sha256").length)
        } finally { journal.close(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun existingNormalizerRetainsTenZerosAndExplicitlyUsesNominalOffsets() {
        val normalizer = JCVitalV8EventNormalizer()
        val parsed = ResolveUtil.getDetailData(packet(0x52, 25))
        val events = normalizer.normalize(parsed, JCVitalV8EventNormalizer.Context(
            deviceId = "AA:BB:CC:DD:EE:FF", firmwareVersion = "1", sessionId = "physical",
            receiptMillis = 0, timezone = "UTC", sourceRecordEnvelopeIds = listOf("exact-record"),
        )).filter { it.name == "jcvitalObservation" }
        val epochs = events.filter { it.payload["metricType"] == "DETAILED_ACTIVITY_EPOCH" }
        assertEquals(10, epochs.size)
        assertEquals(0, epochs.first().payload["value"])
        assertEquals("2026-10-04T12:01:00.000Z", epochs[1].payload["observedAt"])
        assertTrue(epochs.all { it.payload["observedAtSource"] == "2026.10.04 12:00:00" })
        assertEquals((0..9).toList(), epochs.map { it.payload["sequenceNumber"] })
        assertTrue(events.all { (it.payload["provenance"] as Map<*, *>)["sourceEnvelopeId"] == "exact-record" })
    }
    @Test fun nativeSnapshotSurvivesRestartAboveCursorWindowSizeWithExactUnicodeAndOwnerIsolation() {
        val context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        var journal = JCVitalV8SourceJournal(context)
        try {
            journal.configure("activity-owner", "activity-device", true, null, null, null)
            assertNull(journal.readActivityCertification("activity-owner", "activity-device")["json"])
            val prefix = """{"kind":"Activity24_25Certification","context":{"scope":{"accountId":"activity-owner","deviceScopeId":"activity-device"}},"unknown":""" + "\""
            val json = prefix + "x".repeat(65536 - prefix.length - 1) + "\uD83D\uDE00" + "z".repeat(3_000_000) + "\"}"
            journal.writeActivityCertification("activity-owner", "activity-device", json)
            journal.close()
            journal = JCVitalV8SourceJournal(context)
            journal.configure("activity-owner", "activity-device", true, null, null, null)
            assertEquals(json, journal.readActivityCertification("activity-owner", "activity-device")["json"])
            assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
                journal.readActivityCertification("wrong-owner", "activity-device")
            }
            assertThrows(IllegalArgumentException::class.java) {
                journal.writeActivityCertification("activity-owner", "activity-device",
                    json.replace("\"accountId\":\"activity-owner\"", "\"accountId\":\"wrong-owner\""))
            }
            assertEquals(json, journal.readActivityCertification("activity-owner", "activity-device")["json"])
            assertEquals(0L, journal.diagnostics("activity-owner", "activity-device")["totalEnvelopeCount"])
        } finally { journal.close(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun oneNativeSequenceStartsSummaryThenDetailOnceWithSameSessionAndNoProductionDedupChange() {
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
        var completed: Map<String, Any?>? = null
        try {
            manager.sourceJournal.configure("activity-owner", "activity-device", true, null, null, null)
            manager.syncActivityCertification { result, error -> assertNull(error); completed = result }
            shadowOf(Looper.getMainLooper()).idle()
            val summaryRequest = field("historicalRequest").get(manager)!!
            fun requestField(request: Any, name: String) = request.javaClass.getDeclaredField(name).apply { isAccessible = true }.get(request)
            assertEquals("24", requestField(summaryRequest, "dataType"))
            assertEquals(true, requestField(summaryRequest, "preservePhysicalRecords"))
            val session = requestField(summaryRequest, "syncId")
            val repeated = listOf("occurrence-1", "occurrence-2").map { id ->
                JCVitalV8EventNormalizer.Event(JCVitalV8EventNormalizer.EVENT_OBSERVATION,
                    mapOf("id" to "same-production-id", "provenance" to mapOf("sourceEnvelopeId" to id)))
            }
            val capture = JCVitalV8SourceJournal.Capture("callback", listOf("occurrence-1", "occurrence-2"), 0, "UTC")
            response.invoke(manager, "24", mapOf(DeviceKey.End to true, DeviceKey.Data to listOf(emptyMap<String, Any>(), emptyMap<String, Any>())), repeated, capture)
            shadowOf(Looper.getMainLooper()).idle()
            val detailRequest = field("historicalRequest").get(manager)!!
            assertEquals("25", requestField(detailRequest, "dataType"))
            assertEquals(session, requestField(detailRequest, "syncId"))
            response.invoke(manager, "25", mapOf(DeviceKey.End to true, DeviceKey.Data to emptyList<Any>()), emptyList<Any>(), null)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(session, completed!!["acquisitionSessionId"])
            assertEquals(2, (completed!!["results"] as List<*>).size)
            val summary = (completed!!["results"] as List<*>)[0] as Map<*, *>
            assertEquals(2, (summary["observations"] as List<*>).size)
            assertEquals(listOf("occurrence-1", "occurrence-2"), summary["sourceRecordEnvelopeIds"])
            assertEquals(0, summary["recordsDeduplicated"])
            assertNull(field("historicalRequest").get(manager))
            var ordinary: Map<String, Any?>? = null
            manager.syncHistoricalActivity { result, _ -> ordinary = result }
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(false, requestField(field("historicalRequest").get(manager)!!, "preservePhysicalRecords"))
            response.invoke(manager, "24", mapOf(DeviceKey.End to true, DeviceKey.Data to emptyList<Any>()), repeated, capture)
            assertEquals(1, (ordinary!!["observations"] as List<*>).size)
            assertEquals(1, ordinary!!["recordsDeduplicated"])
        } finally { manager.release(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
}
