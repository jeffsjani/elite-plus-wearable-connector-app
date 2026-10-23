package com.hapi.eliteplus.connector.jcvital

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
class WorkoutHistoryCertificationTest {
    private val vc25PhysicalBase64 = "XAAAJgkVFiNJAH3CBRIBAAB97IJCAAAAAE5cAQAmCRUWFUUAdNgByQA+IMk4o0FQzgA+3lwCACYJFBUkEAluWAIYAgAAcjyFQQAAAAAdXP8="

    @Test fun exactPhysicalVc25PacketProvesVendorStrideAndEndMarkerBugWithoutPatchingJar() {
        val bytes = java.util.Base64.getDecoder().decode(vc25PhysicalBase64)
        assertEquals(80, bytes.size)
        assertEquals(listOf(0, 1, 2), (0..2).map { i ->
            val offset = i * 26
            assertEquals(0x5c, bytes[offset].toInt() and 255)
            assertEquals(0, bytes[offset + 2].toInt())
            bytes[offset + 1].toInt()
        })
        assertEquals(0x5c, bytes[78].toInt() and 255)
        assertEquals(0xff, bytes[79].toInt() and 255)
        val vendor = ResolveUtil.getExerciseData(bytes)
        assertEquals(false, vendor[DeviceKey.End])
        val records = (vendor[DeviceKey.Data] as List<*>).map { it as Map<*, *> }
        assertEquals(listOf("2026.09.15 16:23:49", "2000.26.09 15:16:15", "2002.00.26 09:14:15"),
            records.map { it["date"] })
        assertEquals(listOf("125", "0", "16"), records.map { it["heartRate"] })
        assertEquals(listOf("1474", "55412", "28169"), records.map { it["ExerciseTime"] })
        assertEquals(listOf("274", "51457", "600"), records.map { it["step"] })
        assertEquals(listOf("00'00\"", "00'62\"", "24'02\""), records.map { it["sportModelSpeed"] })
        assertEquals(listOf("65.5", "-0", "0"), records.map { it["calories"] })
        assertEquals(listOf("0", "0", "0"), records.map { it["distance"] })
        assertEquals(listOf("0", "69", "36"), records.map { it["sportModel"] })
        assertEquals("914bd3f2f4fd47c46cb15414cc091505e1054c4780407cdeb303993f5a0c361f",
            java.security.MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) })
    }

    @Test fun stoppedWorkoutFinalizationPersistsOfflineWithoutConfiguringCaptureAndRejectsStaleOriginal() {
        val context = clean()
        var journal = JCVitalV8SourceJournal(context)
        try {
            journal.configure("owner", "device", true, null, null, null)
            journal.writeWorkoutCertification("owner", "device", snapshot())
            journal.setDeviceContext("firmware", "HISTORICAL_SYNC", "session")
            val id = journal.appendRaw(java.util.Base64.getDecoder().decode(vc25PhysicalBase64), 0, "UTC")
            val stopped = snapshot("STOPPED")
            journal.writeWorkoutCertification("owner", "device", stopped)
            val originalEntry = journal.readWorkoutSourceEnvelope("owner", "device", id)
            val certified = JSONObject(stopped).put("state", "CERTIFIED")
                .put("sourceStatus", "CERTIFIED_E2E_LOSSLESS_SOURCE")
                .put("diagnostic", "VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG")
                .put("canonicalAuthority", "NONE_UNTIL_SEMANTICS_CONFIRMED")
                .put("deliveryDisposition", "LOCAL_SOURCE_EVIDENCE_ONLY")
                .put("localFinalization", JSONObject().put("originalStoppedSnapshot", JSONObject(stopped)))
            journal.close()
            journal = JCVitalV8SourceJournal(context)
            assertFalse(journal.captureEnabled())
            val stale = JSONObject(certified.toString())
            stale.getJSONObject("localFinalization").getJSONObject("originalStoppedSnapshot").put("state", "CAPTURED")
            assertThrows(IllegalArgumentException::class.java) {
                journal.writeWorkoutCertification("owner", "device", stale.toString())
            }
            assertEquals(stopped, journal.readWorkoutCertification("owner", "device")["json"])
            journal.writeWorkoutCertification("owner", "device", certified.toString())
            journal.close()
            journal = JCVitalV8SourceJournal(context)
            assertEquals(certified.toString(), journal.readWorkoutCertification("owner", "device")["json"])
            assertEquals(originalEntry, journal.readWorkoutSourceEnvelope("owner", "device", id))
            assertEquals(vc25PhysicalBase64, originalEntry["rawBytesBase64"])
            assertFalse(journal.captureEnabled())
            assertNull(journal.readWorkoutCertification("other", "device")["json"])
            assertThrows(JCVitalV8SourceJournal.Failure::class.java) { journal.readSleepCertification("owner", "device") }
            assertThrows(JCVitalV8SourceJournal.Failure::class.java) { journal.readActivityCertification("owner", "device") }
        } finally { journal.close(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }

    private fun packet(records: Int = 1, terminal: Boolean = true): ByteArray = ByteArray(records * 25 + if (terminal) 2 else 0).also { bytes ->
        repeat(records) { i ->
            val offset = i * 25
            bytes[offset] = 0x5c
            bytes[offset + 3] = 0x26; bytes[offset + 4] = 0x10; bytes[offset + 5] = 0x05
            bytes[offset + 6] = 0x12; bytes[offset + 7] = 0x03; bytes[offset + 8] = 0x04
            bytes[offset + 9] = 0xff.toByte()
        }
        if (terminal) { bytes[bytes.size - 2] = 0x5c; bytes[bytes.size - 1] = 0xff.toByte() }
    }
    private fun clean(): Context {
        val context = RuntimeEnvironment.getApplication()
        shadowOf(context).grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        return context
    }
    private fun snapshot(state: String = "ACQUIRING") = JSONObject().put("kind", "WorkoutHistoryCertification")
        .put("state", state).put("context", JSONObject().put("scope",
            JSONObject().put("accountId", "owner").put("deviceScopeId", "device")))
        .put("acquisition", JSONObject().put("syncId", "session")).toString()

    @Test fun exactSdkCommandOpcodeModesChecksumAndCallbackMapping() {
        for (mode in listOf(0, 2)) {
            val command = BleSDK.GetActivityModeDataWithMode(mode.toByte())
            assertEquals(16, command.size)
            assertEquals(0x5c, command[0].toInt() and 255)
            assertEquals(mode, command[1].toInt() and 255)
            assertEquals((0x5c + mode) and 255, command[15].toInt() and 255)
            val callbacks = mutableListOf<Map<String?, Any?>>()
            BleSDK.DataParsingWithData(packet(2), object : DataListener2301 {
                override fun dataCallback(maps: MutableMap<String?, Any?>?) { maps?.let(callbacks::add) }
                override fun dataCallback(value: ByteArray?) = Unit
            })
            assertEquals(1, callbacks.size)
            assertEquals("29", callbacks.single()[DeviceKey.DataType])
            assertEquals(true, callbacks.single()[DeviceKey.End])
            val records = callbacks.single()[DeviceKey.Data] as List<*>
            assertEquals(2, records.size)
            assertEquals(records[0], records[1])
            val record = records[0] as Map<*, *>
            assertEquals(JCVitalV8WorkoutHistorySource.fields.toSet(), record.keys)
            assertEquals("2026.10.05 12:03:04", record["date"])
            assertEquals("255", record["sportModel"])
            assertEquals("0", record["heartRate"])
            assertEquals("0", record["ExerciseTime"])
            assertEquals("0", record["step"])
            assertEquals("00'00\"", record["sportModelSpeed"])
            assertFalse(record.keys.any { it.toString().contains("met", ignoreCase = true) })
        }
    }
    @Test fun sdkShortFrameEndIsNotProofOfTerminalAndPopulatedFramingIsExact() {
        for (bytes in listOf(byteArrayOf(0x5c, 0xff.toByte()), byteArrayOf(0x5c, 0))) {
            val parsed = ResolveUtil.getExerciseData(bytes)
            assertEquals("29", parsed[DeviceKey.DataType])
            assertEquals(true, parsed[DeviceKey.End])
            assertEquals(emptyList<Any>(), parsed[DeviceKey.Data])
        }
        assertEquals(false, ResolveUtil.getExerciseData(packet(1, false))[DeviceKey.End])
        assertEquals(true, ResolveUtil.getExerciseData(packet(1, true))[DeviceKey.End])
    }
    @Test fun nativeSourceObservationPreservesNullZeroUnknownFieldsAndRepeatsWithoutCanonicalMapping() {
        val records = (ResolveUtil.getExerciseData(packet(2))[DeviceKey.Data] as List<*>).map { raw ->
            LinkedHashMap(raw as Map<*, *>).apply { put("heartRate", null); put("unknown", listOf(0, null, "opaque")) }
        }
        val vendor = mapOf<String?, Any?>(DeviceKey.DataType to "29", DeviceKey.End to true, DeviceKey.Data to records)
        val capture = JCVitalV8SourceJournal.Capture("callback", listOf("record-1", "record-2"), 0, "UTC")
        val observations = JCVitalV8WorkoutHistorySource.observations(vendor, capture, "session")
        assertEquals(2, observations.size)
        assertEquals(listOf("record-1", "record-2"), observations.map { it.payload["sourceEnvelopeId"] })
        for (observation in observations) {
            assertEquals("NONE_UNTIL_SEMANTICS_CONFIRMED", observation.payload["canonicalAuthority"])
            assertEquals("WORKOUT_HISTORY_NATIVE_SOURCE", observation.payload["metricType"])
            assertFalse(observation.payload.containsKey("value"))
            val original = observation.payload["sdkRecord"] as String
            assertTrue(original.contains("\"heartRate\""))
            assertTrue(original.contains("\"unknown\""))
            assertTrue(original.contains("\"Integer\",\"value\":\"0\""))
            assertEquals(JCVitalV8SourceSnapshot.encode(records[0], 1024 * 1024), original)
        }
        assertEquals(JCVitalV8EventNormalizer.EVENT_PARSE_ERROR,
            JCVitalV8WorkoutHistorySource.observations(mapOf(DeviceKey.Data to listOf("bad")), capture, "session").single().name)
    }
    @Test fun workoutClaimAndSnapshotsSurviveRestartAndOfflineInspectionDoesNotConfigureAcquisition() {
        val context = clean()
        var journal = JCVitalV8SourceJournal(context)
        try {
            journal.configure("owner", "device", true, null, null, null)
            journal.writeWorkoutCertification("owner", "device", snapshot())
            journal.claimWorkoutAcquisition()
            assertThrows(JCVitalV8SourceJournal.Failure::class.java) { journal.claimWorkoutAcquisition() }
            journal.setDeviceContext("firmware", "HISTORICAL_SYNC", "session")
            val rawId = journal.appendRaw(packet(0), 0, "UTC")
            journal.writeWorkoutCertification("owner", "device", snapshot("CAPTURED"))
            journal.close()
            journal = JCVitalV8SourceJournal(context)
            assertFalse(journal.captureEnabled())
            assertEquals(snapshot("CAPTURED"), journal.readWorkoutCertification("owner", "device")["json"])
            assertNotNull(journal.readWorkoutSourceEnvelope("owner", "device", rawId)["rawBytesBase64"])
            assertNull(journal.readWorkoutCertification("other", "device")["json"])
            assertThrows(JCVitalV8SourceJournal.Failure::class.java) { journal.readWorkoutSourceEnvelope("other", "device", rawId) }
            assertFalse(journal.captureEnabled())
            journal.configure("owner", "device", true, null, null, null)
            assertThrows(IllegalArgumentException::class.java) { journal.claimWorkoutAcquisition() }
            assertThrows(IllegalArgumentException::class.java) { journal.writeWorkoutCertification("owner", "device", snapshot()) }
            assertNull(journal.readSleepCertification("owner", "device")["json"])
            assertNull(journal.readActivityCertification("owner", "device")["json"])
        } finally { journal.close(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun physicalNotificationIsJournaledBeforeParserAndDedicatedNativeRouteNeverEmitsDeliveryEvents() {
        val context = clean()
        val emitted = mutableListOf<String>()
        val manager = JCVitalV8Manager(context) { name, _ -> emitted.add(name) }
        fun field(name: String) = JCVitalV8Manager::class.java.getDeclaredField(name).apply { isAccessible = true }
        val requestClass = JCVitalV8Manager::class.java.declaredClasses.single { it.simpleName == "HistoricalRequest" }
        val constructor = requestClass.declaredConstructors.single { candidate ->
            val parameters = candidate.parameterTypes
            parameters.size == 10 && parameters.last() == Long::class.javaPrimitiveType
        }.apply { isAccessible = true }
        var completed: Map<String, Any?>? = null
        val callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit = { result, error -> assertNull(error); completed = result }
        val command: (Byte) -> ByteArray = { BleSDK.GetActivityModeDataWithMode(it) }
        val request = constructor.newInstance("session", "GetActivityModeDataWithMode", "29", command, 0L, callback, null, true, null, 0L)
        val notify = JCVitalV8Manager::class.java.getDeclaredMethod("handleNotification", ByteArray::class.java).apply { isAccessible = true }
        try {
            manager.sourceJournal.configure("owner", "device", true, null, null, null)
            manager.sourceJournal.writeWorkoutCertification("owner", "device", snapshot())
            field("historicalRequest").set(manager, request)
            BleSDK.GetActivityModeDataWithMode(0)
            notify.invoke(manager, packet(2))
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("COMPLETE", completed!!["completionStatus"])
            assertEquals(2, completed!!["recordsReceived"])
            assertEquals(0, completed!!["recordsDeduplicated"])
            assertEquals(0, completed!!["recordsRejected"])
            assertEquals(0, completed!!["retryCount"])
            assertEquals("LOCAL_SOURCE_EVIDENCE_ONLY", completed!!["deliveryDisposition"])
            assertFalse(emitted.contains(JCVitalV8EventNormalizer.EVENT_OBSERVATION))
            assertFalse(emitted.contains(JCVitalV8EventNormalizer.EVENT_WORKOUT_HEART_RATE))
            manager.sourceJournal.writeWorkoutCertification("owner", "device", snapshot("CAPTURED"))
            val ids = completed!!["sourceNotificationEnvelopeIds"] as List<*>
            val raw = manager.sourceJournal.readWorkoutSourceEnvelope("owner", "device", ids.single() as String)
            val callbacks = completed!!["sourceCallbackEnvelopeIds"] as List<*>
            val sdk = manager.sourceJournal.readWorkoutSourceEnvelope("owner", "device", callbacks.single() as String)
            assertTrue((raw["sequence"] as Long) < (sdk["sequence"] as Long))
            val outcomes = completed!!["sourceParserOutcomeEnvelopeIds"] as List<*>
            val parsed = manager.sourceJournal.readWorkoutSourceEnvelope("owner", "device", outcomes.single() as String)
            assertTrue((sdk["sequence"] as Long) < (parsed["sequence"] as Long))
            assertEquals("COMPLETE", JSONObject(parsed["envelopeJson"] as String).getString("status"))
            assertEquals(27 + 25, JSONObject(raw["envelopeJson"] as String).getInt("byteLength"))
        } finally { manager.release(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun physicalSemanticTestBypassesVendorStrideAndRetainsExactRawPacketsWithoutObservations() {
        val context = clean()
        val emitted = mutableListOf<String>()
        val manager = JCVitalV8Manager(context) { name, _ -> emitted.add(name) }
        fun field(name: String) = JCVitalV8Manager::class.java.getDeclaredField(name).apply { isAccessible = true }
        val requestClass = JCVitalV8Manager::class.java.declaredClasses.single { it.simpleName == "HistoricalRequest" }
        val constructor = requestClass.declaredConstructors.single { candidate ->
            val parameters = candidate.parameterTypes
            parameters.size == 10 && parameters.last() == Long::class.javaPrimitiveType
        }.apply { isAccessible = true }
        var completed: Map<String, Any?>? = null
        val callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit = { result, error -> assertNull(error); completed = result }
        val command: (Byte) -> ByteArray = { BleSDK.GetActivityModeDataWithMode(it) }
        val request = constructor.newInstance("session", "GetActivityModeDataWithMode", "29", command, 0L, callback, null, true, null, 0L)
        val notify = JCVitalV8Manager::class.java.getDeclaredMethod("handleNotification", ByteArray::class.java).apply { isAccessible = true }
        val bytes = android.util.Base64.decode(
            "XAAAJgkVFiNJAH3CBRIBAAB97IJCAAAAAE5cAQAmCRUWFUUAdNgByQA+IMk4o0FQzgA+3lwCACYJFBUkEAluWAIYAgAAcjyFQQAAAAAdXP8=",
            android.util.Base64.DEFAULT)
        try {
            manager.sourceJournal.configure("owner", "device", true, null, null, null)
            field("physicalTestSession").set(manager, JCVitalV8PhysicalTestSession(context, "workout"))
            field("historicalRequest").set(manager, request)
            notify.invoke(manager, bytes)
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("COMPLETE", completed!!["completionStatus"])
            assertEquals(0, completed!!["recordsReceived"])
            assertEquals(emptyList<Any>(), completed!!["observations"])
            assertEquals(emptyList<Any>(), completed!!["sourceCallbackEnvelopeIds"])
            assertFalse(emitted.contains(JCVitalV8EventNormalizer.EVENT_OBSERVATION))
            assertFalse(emitted.contains(JCVitalV8EventNormalizer.EVENT_WORKOUT_HEART_RATE))
            val rawId = (completed!!["sourceNotificationEnvelopeIds"] as List<*>).single() as String
            val raw = manager.sourceJournal.read("owner", "device", rawId)
            assertArrayEquals(bytes, android.util.Base64.decode(raw["rawBytesBase64"] as String, android.util.Base64.DEFAULT))
            val outcomeId = (completed!!["sourceParserOutcomeEnvelopeIds"] as List<*>).single() as String
            val outcome = manager.sourceJournal.read("owner", "device", outcomeId)
            assertEquals("DIRECT_26_BYTE_DECODER_REQUIRED_SDK_BYPASSED", JSONObject(outcome["envelopeJson"] as String).getString("status"))
        } finally { manager.release(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
    @Test fun legacyHistoryAcquisitionCannotBypassTheSavedAttemptLock() {
        val context = clean()
        val manager = JCVitalV8Manager(context) { _, _ -> }
        var failure: JCVitalV8Exception? = null
        try {
            manager.sourceJournal.configure("owner", "device", true, null, null, null)
            manager.sourceJournal.writeWorkoutCertification("owner", "device", snapshot())
            manager.syncHistoricalWorkouts { result, error -> assertNull(result); failure = error }
            shadowOf(Looper.getMainLooper()).idle()
            assertTrue(failure!!.message!!.contains("WORKOUT_CAPTURE_ALREADY_ATTEMPTED"))
            val request = JCVitalV8Manager::class.java.getDeclaredField("historicalRequest").apply { isAccessible = true }
            assertNull(request.get(manager))
            assertEquals(0L, manager.sourceJournal.diagnostics("owner", "device")["totalEnvelopeCount"])
        } finally { manager.release(); context.deleteDatabase("jcvital-source-envelope-v1.db") }
    }
}
