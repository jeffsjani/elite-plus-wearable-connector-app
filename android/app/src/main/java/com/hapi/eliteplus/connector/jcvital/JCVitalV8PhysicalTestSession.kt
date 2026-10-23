package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import android.util.Base64
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.model.ExerciseMode
import java.security.MessageDigest
import org.json.JSONObject
import android.util.Log

internal class JCVitalV8PhysicalTestSession(
    private val context: Context, val kind: String,
    private val attemptId: String? = null, private val evidenceKey: String? = null,
) {
    private val commands = mutableListOf<MutableMap<String, Any?>>()
    private val sourceIds = linkedSetOf<String>()
    private val callbackCounts = mutableMapOf<String, Int>()
    private val recordCounts = mutableMapOf<String, Int>()
    private var notifications = 0
    private var acquisitionStarted = false
    private var sessionClosed = false
    private var rawType29 = 0
    private var type82SchedulerStarted = false
    private val completions = mutableMapOf<String, String>()
    private val dataEndByType = mutableMapOf<String, Boolean>()
    private val unexpectedCallbackTypes = mutableListOf<String>()
    private var stage = "NATIVE_SESSION_CREATED"
    private var failureStage: String? = null
    private var errorCode: String? = null
    private var errorMessage: String? = null
    private var evidencePersistenceError: String? = null
    private val stages = mutableListOf<Map<String, String>>()
    private val wellnessBefore = wellnessHash()
    private val allowed = when (kind) {
        "activity" -> listOf(
            BleSDK.GetTotalActivityDataWithMode(0, ""), BleSDK.GetTotalActivityDataWithMode(2, ""),
            BleSDK.GetDetailActivityDataWithMode(0, ""), BleSDK.GetDetailActivityDataWithMode(2, ""),
        )
        "activity_type25_anchor" -> listOf(
            BleSDK.GetDetailActivityDataWithMode(0, ""), BleSDK.GetDetailActivityDataWithMode(2, ""),
        )
        "workout" -> listOf(
            BleSDK.EnterActivityMode(2, 0, ExerciseMode.Status_START),
            BleSDK.EnterActivityMode(2, 0, ExerciseMode.Status_FINISH),
            BleSDK.sendHeartPackage(0f, 0, 0),
            BleSDK.GetActivityModeDataWithMode(0), BleSDK.GetActivityModeDataWithMode(2),
        )
        else -> throw IllegalArgumentException("Unknown physical test kind")
    }

    fun command(name: String, bytes: ByteArray): MutableMap<String, Any?> {
        val permitted = allowed.any { it.contentEquals(bytes) }
        val evidence = linkedMapOf<String, Any?>(
            "name" to name, "opcode" to (bytes.firstOrNull()?.toInt()?.and(255)),
            "rawBytesBase64" to Base64.encodeToString(bytes, Base64.NO_WRAP),
            "allowed" to permitted, "writeAcknowledged" to false,
            "writeAccepted" to false,
        )
        commands.add(evidence)
        completed("COMMAND_REQUESTED")
        return evidence
    }

    fun completed(value: String) {
        stage = value
        stages.add(mapOf("stage" to value, "at" to JCVitalV8Time.isoUtc(System.currentTimeMillis())))
        persist()
    }

    fun issued(command: MutableMap<String, Any?>) {
        command["writeAccepted"] = true
        completed("COMMAND_WRITTEN")
    }

    fun acknowledged() = persist()

    fun notification(opcode: Int) {
        notifications++
        if (opcode == 0x5c) rawType29++
        completed("CALLBACK_RECEIVED")
    }

    fun journaled(ids: List<String>) {
        sourceIds.addAll(ids)
        completed("SOURCE_JOURNALED")
    }

    fun callback(type: String?, callbackId: String?, ids: List<String>) {
        if (type != null) {
            callbackCounts[type] = (callbackCounts[type] ?: 0) + 1
            recordCounts[type] = (recordCounts[type] ?: 0) + ids.size
        }
        journaled(listOfNotNull(callbackId) + ids)
    }

    fun unexpectedCallback(type: String) {
        unexpectedCallbackTypes.add(type)
        failed("CALLBACK_COLLECTION", "UNEXPECTED_VENDOR_CALLBACK", "Unexpected vendor data type $type during $kind")
    }

    fun failed(failedStage: String, code: String, message: String) {
        failureStage = failedStage
        errorCode = code
        errorMessage = message
        persist()
    }

    fun schedulerStarted() {
        type82SchedulerStarted = true
        persist()
    }

    fun acquisitionStarted() {
        acquisitionStarted = true
        persist()
    }

    fun close() {
        sessionClosed = true
        persist()
    }

    fun terminal(type: String, status: String, dataEndReached: Boolean = false) {
        completions[type] = status
        dataEndByType[type] = dataEndReached
        persist()
    }

    fun persist() {
        if (evidenceKey == null) return
        val saved = context.getSharedPreferences("v8_physical_test_evidence_v1", Context.MODE_PRIVATE)
            .edit().putString(evidenceKey, JSONObject(snapshot()).toString()).commit()
        if (!saved) {
            evidencePersistenceError = "PHYSICAL_TEST_EVIDENCE_PERSISTENCE_FAILED"
            Log.e("V8PhysicalTestEvidence", evidencePersistenceError!!)
        }
    }

    fun snapshot(): Map<String, Any?> {
        val after = wellnessHash()
        fun commandDiagnostics(prefix: String) = mapOf(
            "requested" to commands.any { (it["name"] as? String)?.startsWith(prefix) == true },
            "written" to commands.any { (it["name"] as? String)?.startsWith(prefix) == true && it["writeAccepted"] == true },
            "acknowledged" to commands.any { (it["name"] as? String)?.startsWith(prefix) == true && it["writeAcknowledged"] == true },
        )
        return mapOf(
            "kind" to kind, "commands" to commands.map { it.toMap() },
            "commandsAllowed" to commands.all { it["allowed"] == true },
            "digitalWellnessBeforeSha256" to wellnessBefore,
            "digitalWellnessAfterSha256" to after, "digitalWellnessUnchanged" to (wellnessBefore == after),
            "attemptId" to attemptId, "lastCompletedStage" to stage, "stages" to stages.toList(),
            "failureStage" to failureStage, "errorCode" to errorCode, "errorMessage" to errorMessage,
            "evidencePersistenceError" to evidencePersistenceError,
            "commandsIssued" to commands.count { it["writeAccepted"] == true },
            "acquisitionStarted" to acquisitionStarted,
            "sessionClosed" to sessionClosed,
            "commandTypes" to commands.filter { it["writeAccepted"] == true }.map {
                val name = it["name"] as? String ?: ""
                when {
                    name.startsWith("GetTotalActivityDataWithMode") -> "24"
                    name.startsWith("GetDetailActivityDataWithMode") -> "25"
                    name.startsWith("GetActivityModeDataWithMode") -> "29"
                    name.startsWith("sendHeartPackage") -> "82"
                    name.startsWith("EnterActivityMode") -> "WORKOUT_CONTROL"
                    else -> "UNKNOWN"
                }
            }.distinct(),
            "callbacksReceived" to notifications, "sourceEnvelopeIds" to sourceIds.toList(),
            "diagnostics" to mapOf("callbacksByType" to callbackCounts.toMap(),
                "recordsByType" to recordCounts.toMap(), "rawType29Notifications" to rawType29,
                "type24" to commandDiagnostics("GetTotalActivityDataWithMode"),
                "type25" to commandDiagnostics("GetDetailActivityDataWithMode"),
                "type24Requested" to commandDiagnostics("GetTotalActivityDataWithMode")["requested"],
                "type24CommandWritten" to commandDiagnostics("GetTotalActivityDataWithMode")["written"],
                "type24Callbacks" to (callbackCounts["24"] ?: 0),
                "type24Records" to (recordCounts["24"] ?: 0),
                "type25Requested" to commandDiagnostics("GetDetailActivityDataWithMode")["requested"],
                "type25CommandWritten" to commandDiagnostics("GetDetailActivityDataWithMode")["written"],
                "type25Callbacks" to (callbackCounts["25"] ?: 0),
                "type25Records" to (recordCounts["25"] ?: 0),
                "dataEndByType" to dataEndByType.toMap(),
                "unexpectedCallbackTypes" to unexpectedCallbackTypes.toList(),
                "type29" to commandDiagnostics("GetActivityModeDataWithMode"),
                "type29HistoryRequested" to commandDiagnostics("GetActivityModeDataWithMode")["requested"],
                "type29CommandWritten" to commandDiagnostics("GetActivityModeDataWithMode")["written"],
                "terminalCompletionStatus" to completions.toMap(),
                "type82SchedulerStarted" to type82SchedulerStarted,
                "workoutStart" to commandDiagnostics("EnterActivityMode(start"),
                "workoutStop" to commandDiagnostics("EnterActivityMode(finish"),
                "type82Callbacks" to (callbackCounts["82"] ?: 0),
                "type82CommandsSent" to commands.count { (it["name"] as? String)?.startsWith("sendHeartPackage") == true && it["writeAccepted"] == true }),
        )
    }

    private fun wellnessHash(): String {
        val preferences = context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE)
        val bytes = preferences.all.toSortedMap().entries.joinToString("") { (key, value) ->
            "$key:${value.toString().length}:$value;"
        }.toByteArray(Charsets.UTF_8)
        return MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it) }
    }
}
