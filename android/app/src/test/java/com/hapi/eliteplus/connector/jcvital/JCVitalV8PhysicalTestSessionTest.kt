package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.model.ExerciseMode
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.annotation.Config
import org.json.JSONObject
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
class JCVitalV8PhysicalTestSessionTest {
    @Test fun activityAllowsExactlyType24And25StartAndContinueAndBlocksEveryOtherOpcode() {
        val test = JCVitalV8PhysicalTestSession(RuntimeEnvironment.getApplication(), "activity")
        for (mode in listOf(0.toByte(), 2.toByte())) {
            for (bytes in listOf(BleSDK.GetTotalActivityDataWithMode(mode, ""), BleSDK.GetDetailActivityDataWithMode(mode, ""))) {
                assertEquals(true, test.command("activity", bytes)["allowed"])
            }
        }
        val allowed = setOf(0x51, 0x52)
        for (opcode in 0..255) {
            if (opcode !in allowed) {
                assertEquals("unexpected opcode $opcode", false, test.command("forbidden", ByteArray(16).also { it[0] = opcode.toByte() })["allowed"])
            }
        }
        assertEquals(false, test.snapshot()["commandsAllowed"])
        assertEquals(false, test.command("delete history", BleSDK.GetTotalActivityDataWithMode(0x99.toByte(), ""))["allowed"])
    }

    @Test fun type25AnchorAllowsOnlyType25StartAndContinue() {
        val test = JCVitalV8PhysicalTestSession(RuntimeEnvironment.getApplication(), "activity_type25_anchor")
        for (mode in listOf(0.toByte(), 2.toByte())) {
            assertEquals(true, test.command("type25", BleSDK.GetDetailActivityDataWithMode(mode, ""))["allowed"])
        }
        assertEquals(true, test.snapshot()["commandsAllowed"])
        test.terminal("25", "COMPLETE", dataEndReached = true)
        val terminal = test.snapshot()["diagnostics"] as Map<*, *>
        assertEquals(true, (terminal["dataEndByType"] as Map<*, *>)["25"])
        assertEquals(false, test.command("type24", BleSDK.GetTotalActivityDataWithMode(0, ""))["allowed"])
        assertEquals(false, test.snapshot()["commandsAllowed"])
        assertEquals(false, test.command("wrong continuation", BleSDK.GetDetailActivityDataWithMode(1, ""))["allowed"])
    }

    @Test fun workoutAllowsOnlyModeZeroStartFinishHeartbeatAndType29StartContinue() {
        val test = JCVitalV8PhysicalTestSession(RuntimeEnvironment.getApplication(), "workout")
        for (bytes in listOf(
            BleSDK.EnterActivityMode(2, 0, ExerciseMode.Status_START),
            BleSDK.EnterActivityMode(2, 0, ExerciseMode.Status_FINISH),
            BleSDK.sendHeartPackage(0f, 0, 0),
            BleSDK.GetActivityModeDataWithMode(0), BleSDK.GetActivityModeDataWithMode(2),
        )) assertEquals(true, test.command("supported", bytes)["allowed"])
        assertEquals(true, test.snapshot()["commandsAllowed"])
        assertEquals(false, test.command("wrong mode", BleSDK.EnterActivityMode(2, 1, ExerciseMode.Status_START))["allowed"])
        assertEquals(false, test.command("activity", BleSDK.GetTotalActivityDataWithMode(0, ""))["allowed"])
    }

    @Test fun wellnessAssertionReadsWithoutWritingAndDetectsChanges() {
        val context = RuntimeEnvironment.getApplication()
        val preferences = context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE)
        preferences.edit().clear().commit()
        val before = preferences.all.toMap()
        val test = JCVitalV8PhysicalTestSession(context, "activity")
        assertEquals(true, test.snapshot()["digitalWellnessUnchanged"])
        assertEquals(before, preferences.all)
        preferences.edit().putString("test-state", "changed").commit()
        assertEquals(false, test.snapshot()["digitalWellnessUnchanged"])
        preferences.edit().clear().commit()
    }

    @Test fun persistsEachNativeBoundaryAndRetainsFailureAndPartialSourceWithoutChangingWellness() {
        val context = RuntimeEnvironment.getApplication()
        val key = "owner:device:activity"
        val preferences = context.getSharedPreferences("v8_physical_test_evidence_v1", Context.MODE_PRIVATE)
        val wellness = context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE).all.toMap()
        val test = JCVitalV8PhysicalTestSession(context, "activity", "attempt-1", key)
        test.completed("NATIVE_SESSION_CREATED")
        assertEquals("NATIVE_SESSION_CREATED", JSONObject(preferences.getString(key, null)!!).getString("lastCompletedStage"))
        val command = test.command("GetTotalActivityDataWithMode", BleSDK.GetTotalActivityDataWithMode(0, ""))
        assertEquals(0, JSONObject(preferences.getString(key, null)!!).getInt("commandsIssued"))
        test.issued(command)
        assertEquals(1, JSONObject(preferences.getString(key, null)!!).getInt("commandsIssued"))
        test.notification(0x51)
        test.callback("24", "callback-1", listOf("record-1"))
        test.failed("SOURCE_JOURNAL_PERSISTENCE", "JOURNAL_WRITE_FAILED", "storage full")
        val saved = JSONObject(preferences.getString(key, null)!!)
        assertEquals("attempt-1", saved.getString("attemptId"))
        assertEquals("SOURCE_JOURNAL_PERSISTENCE", saved.getString("failureStage"))
        assertEquals("storage full", saved.getString("errorMessage"))
        assertEquals(1, saved.getInt("callbacksReceived"))
        assertEquals(2, saved.getJSONArray("sourceEnvelopeIds").length())
        assertEquals(1, saved.getJSONObject("diagnostics").getJSONObject("recordsByType").getInt("24"))
        assertEquals(wellness, context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE).all)
    }

    @Test fun capacitorPhysicalMethodsAreActuallyAnnotatedAndRegisteredAsPluginMethods() {
        for (name in listOf("beginPhysicalSemanticTest", "endPhysicalSemanticTest", "readPhysicalSemanticTestEvidence")) {
            val method = JCVitalV8Plugin::class.java.getDeclaredMethod(name, PluginCall::class.java)
            assertNotNull(name, method.getAnnotation(PluginMethod::class.java))
        }
    }
}
