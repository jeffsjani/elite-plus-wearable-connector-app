package com.hapi.eliteplus.connector.jcvital

import android.Manifest
import android.os.Build
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import org.json.JSONObject

@CapacitorPlugin(
    name = "JCVitalV8",
    permissions = [
        Permission(
            alias = JCVitalV8Permissions.ALIAS_BLUETOOTH,
            strings = [Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT],
        ),
        Permission(alias = JCVitalV8Permissions.ALIAS_LOCATION, strings = [Manifest.permission.ACCESS_FINE_LOCATION]),
    ],
)
class JCVitalV8Plugin : Plugin() {
    private lateinit var manager: JCVitalV8Manager
    private var lastPermissionStatus: JCVitalV8PermissionStatus? = null

    private val connectionTrace = JCVitalV8ConnectionTrace(true)

    override fun load() {
        manager = JCVitalV8Manager(context, connectionTrace) { name, payload ->
            if (connectionTrace.enabled && name == JCVitalV8EventNormalizer.EVENT_SCAN_RESULT) {
                (payload["id"] as? String)?.let { connectionTrace.scanResultEmitted(it, hasListeners(name)) }
            }
            notifyListeners(name, toJsObject(payload))
        }
        connectionTrace.pluginLoaded()
    }

    override fun handleOnDestroy() {
        manager.release()
    }

    @PluginMethod
    fun initialize(call: PluginCall) {
        if (!::manager.isInitialized) {
            Log.e(TAG, "V8 native manager did not load")
            call.reject("V8 native manager did not load", "SDK_INITIALIZATION_FAILED")
            return
        }
        call.resolve(JSObject().put("initialized", true).put("pluginName", "JCVitalV8"))
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        call.resolve(JSObject().put("available", manager.isAvailable()).put("enabled", manager.isEnabled()))
    }

    @PluginMethod
    fun configureSourceJournal(call: PluginCall) {
        val owner = journalOwner(call)
        val enabled = call.getBoolean("enabled")
        if (enabled == null) {
            call.reject("enabled is required", "SOURCE_JOURNAL_FAILED")
            return
        }
        manager.configureSourceJournal(owner, journalDevice(call),
            enabled, call.getLong("maxBytes"), call.getLong("maxEnvelopes"),
            call.getInt("maxEntryBytes")) { result, error ->
            if (error != null) call.reject(error.message ?: "SOURCE_JOURNAL_FAILED", "SOURCE_JOURNAL_FAILED")
            else call.resolve(toJsObject(result!!))
        }
    }

    private fun journalOwner(call: PluginCall): String? = call.getString("accountId")
    private fun journalDevice(call: PluginCall): String? = call.getString("deviceScopeId")

    private fun journalCall(call: PluginCall, operation: () -> Map<String, Any?>) {
        try { call.resolve(toJsObject(operation())) }
        catch (error: Exception) { call.reject(error.message ?: "SOURCE_JOURNAL_FAILED", "SOURCE_JOURNAL_FAILED") }
    }

    @PluginMethod
    fun getSourceJournalDiagnostics(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.diagnostics(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun getJournalCapacityAnalysis(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.capacityAnalysis()
    }

    @PluginMethod
    fun analyzeExistingJournalOffline(call: PluginCall) = journalCall(call) {
        JCVitalV8OfflineJournalInspector(context).inspect()
    }

    @PluginMethod
    fun getPipelineDiagnosticSnapshot(call: PluginCall) = journalCall(call) {
        manager.pipelineSnapshot()
    }

    @PluginMethod
    fun listSourceEnvelopes(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.list(journalOwner(call), journalDevice(call),
            call.getLong("afterSequence") ?: 0, call.getInt("limit") ?: 50)
    }

    @PluginMethod
    fun readSourceEnvelope(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.read(journalOwner(call), journalDevice(call),
            call.getString("envelopeId") ?: throw IllegalArgumentException("envelopeId is required"))
    }

    @PluginMethod
    fun exportSourceJournal(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.list(journalOwner(call), journalDevice(call),
            call.getLong("afterSequence") ?: 0, call.getInt("limit") ?: 50, includePayload = true)
    }

    @PluginMethod
    fun readActivityCertificationSnapshot(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.readActivityCertification(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun writeActivityCertificationSnapshot(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.writeActivityCertification(journalOwner(call), journalDevice(call),
            call.getString("json") ?: throw IllegalArgumentException("json is required"))
    }

    @PluginMethod
    fun readSleepCertificationSnapshot(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.readSleepCertification(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun writeSleepCertificationSnapshot(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.writeSleepCertification(journalOwner(call), journalDevice(call),
            call.getString("json") ?: throw IllegalArgumentException("json is required"))
    }

    @PluginMethod
    fun getPermissionStatus(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val status = permissionStatus()
        connectionTrace.record("PERMISSION_REQUEST_INVOKED", mapOf("status" to status.name,
            "aliasState" to getPermissionState(alias())?.toString()))
        if (status == JCVitalV8PermissionStatus.BLUETOOTH_UNAVAILABLE || getPermissionState(alias())?.toString() == "granted") {
            connectionTrace.record("PERMISSION_REQUEST_RESOLVED_WITHOUT_PROMPT", mapOf("status" to status.name,
                "bluetoothEnabled" to manager.isEnabled()))
            return call.resolve(permissionPayload())
        }
        Log.i(TAG, "requesting ${JCVitalV8Permissions.requiredPermissions(Build.VERSION.SDK_INT).joinToString()}")
        connectionTrace.record("PERMISSION_PROMPT_SHOWN", mapOf("alias" to alias()))
        requestPermissionForAlias(alias(), call, "permissionsCallback")
    }

    @PermissionCallback
    private fun permissionsCallback(call: PluginCall) {
        val payload = permissionPayload()
        connectionTrace.record("PERMISSION_PROMPT_RESULT", mapOf("status" to payload.getString("status"),
            "aliasState" to getPermissionState(alias())?.toString(), "bluetoothEnabled" to manager.isEnabled()))
        call.resolve(payload)
    }

    @PluginMethod
    fun getConnectionDiagnosticSnapshot(call: PluginCall) {
        val android = JCVitalV8ConnectionDiagnosticState.read(context)
        call.resolve(toJsObject(mapOf(
            "android" to android,
            "capacitorPermissionAlias" to alias(),
            "capacitorAliasState" to getPermissionState(alias())?.toString(),
            "normalizedPermissionStatus" to permissionStatus().name,
            "connectionState" to manager.state.name,
            "connectedDeviceId" to manager.connectedDeviceId(),
            "jsListeners" to mapOf(
                "jcvitalScanResult" to hasListeners(JCVitalV8EventNormalizer.EVENT_SCAN_RESULT),
                "jcvitalConnectionState" to hasListeners(JCVitalV8EventNormalizer.EVENT_CONNECTION_STATE),
                "jcvitalError" to hasListeners(JCVitalV8EventNormalizer.EVENT_ERROR),
            ),
            "registryDevices" to manager.discoveredDevices().size,
            "trace" to connectionTrace.snapshot(),
            "journalHandshake" to manager.journalHandshakeSnapshot(),
        )))
    }

    @PluginMethod
    fun startScan(call: PluginCall) {
        val timeoutMs = call.getLong("timeoutMs") ?: JCVitalV8Manager.DEFAULT_SCAN_TIMEOUT_MS
        manager.startScan(timeoutMs.coerceIn(1_000L, 120_000L)) { error ->
            if (error != null) reject(call, error) else call.resolve()
        }
    }

    @PluginMethod
    fun stopScan(call: PluginCall) {
        manager.stopScan()
        call.resolve()
    }

    @PluginMethod
    fun getDiscoveredDevices(call: PluginCall) {
        call.resolve(JSObject().put("devices", toJsArray(manager.discoveredDevices())))
    }

    @PluginMethod
    fun connect(call: PluginCall) {
        val deviceId = call.getString("deviceId")
        if (deviceId.isNullOrBlank()) return call.reject("deviceId is required", JCVitalV8ErrorCode.DEVICE_NOT_FOUND.name)
        manager.connect(deviceId) { error ->
            if (error != null) reject(call, error) else call.resolve(stateObject())
        }
    }

    @PluginMethod
    fun disconnect(call: PluginCall) {
        manager.disconnect { call.resolve(stateObject()) }
    }

    @PluginMethod
    fun getConnectionState(call: PluginCall) {
        call.resolve(stateObject())
    }

    @PluginMethod
    fun getDeviceInfo(call: PluginCall) {
        manager.requestDeviceInfo { info, error -> if (error != null) reject(call, error) else call.resolve(toJsObject(info!!)) }
    }

    @PluginMethod
    fun getBattery(call: PluginCall) {
        manager.requestBattery { battery, error -> if (error != null) reject(call, error) else call.resolve(toJsObject(battery!!)) }
    }

    @PluginMethod
    fun startRealtimeData(call: PluginCall) {
        val seconds = call.getLong("measurementSeconds") ?: JCVitalV8Manager.DEFAULT_MEASUREMENT_SECONDS
        manager.startRealtime(seconds) { result, error -> if (error != null) reject(call, error) else call.resolve(toJsObject(result!!)) }
    }

    @PluginMethod
    fun stopRealtimeData(call: PluginCall) {
        manager.stopRealtime { result, error -> if (error != null) reject(call, error) else call.resolve(toJsObject(result!!)) }
    }

    @PluginMethod
    fun startWorkoutCapture(call: PluginCall) {
        manager.startWorkoutCapture(call.getInt("activityMode") ?: 0) { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun stopWorkoutCapture(call: PluginCall) {
        manager.stopWorkoutCapture { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun pauseWorkoutCapture(call: PluginCall) {
        manager.pauseWorkoutCapture { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun resumeWorkoutCapture(call: PluginCall) {
        manager.resumeWorkoutCapture { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun getWorkoutCaptureStatus(call: PluginCall) {
        call.resolve(toJsObject(manager.workoutCaptureStatus()))
    }

    @PluginMethod
    fun startRawEcg(call: PluginCall) {
        manager.startRawEcg { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun stopRawEcg(call: PluginCall) {
        manager.stopRawEcg { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun getRawEcgStatus(call: PluginCall) {
        call.resolve(toJsObject(manager.rawEcgStatus()))
    }

    @PluginMethod
    fun startRawPpg(call: PluginCall) {
        manager.startRawPpg { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun stopRawPpg(call: PluginCall) {
        manager.stopRawPpg { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun getRawPpgStatus(call: PluginCall) {
        call.resolve(toJsObject(manager.rawPpgStatus()))
    }

    // Offline saved-evidence controls: read-only against app-private storage. 0 BLE commands, 0 connections,
    // 0 acquisitions, 0 network, 0 Base44, 0 enqueue, 0 delivery, 0 canonicalization.
    /**
     * PPG saved-evidence calls keep the exact native code/class instead of collapsing to SOURCE_JOURNAL_FAILED:
     * reject(message, code, exception, data{errorCode, exceptionClass, errorMessage}).
     */
    private fun ppgEvidenceCall(call: PluginCall, operation: () -> Map<String, Any?>) {
        try { call.resolve(toJsObject(operation())) }
        catch (error: Exception) {
            val code = (error as? RawPpgSavedEvidenceInspector.CodedException)?.code
                ?: (error as? JCVitalV8SourceJournal.Failure)?.reason?.takeIf { it.startsWith("PPG_") }
                ?: RawPpgSavedEvidenceDiagnostic.INSPECTION_INTERNAL_ERROR
            val message = "$code: ${error.javaClass.simpleName}: ${error.message ?: "(no message)"}"
            call.reject(message, code, error, JSObject().put("errorCode", code)
                .put("exceptionClass", error.javaClass.name).put("errorMessage", message))
        }
    }

    @PluginMethod
    fun inspectSavedRawPpgEvidence(call: PluginCall) = ppgEvidenceCall(call) {
        manager.inspectSavedRawPpgEvidence(journalOwner(call), journalDevice(call), call.getString("sessionId"))
    }

    @PluginMethod
    fun readSavedRawPpgDiagnostic(call: PluginCall) = ppgEvidenceCall(call) { manager.readSavedRawPpgDiagnostic() }

    @PluginMethod
    fun exportSavedRawPpgEvidence(call: PluginCall) = ppgEvidenceCall(call) {
        manager.exportSavedRawPpgEvidence(journalOwner(call), journalDevice(call), call.getString("sessionId"))
    }

    @PluginMethod
    fun finalizeSavedRawPpgCertification(call: PluginCall) = ppgEvidenceCall(call) {
        manager.finalizeSavedRawPpgCertification(journalOwner(call), journalDevice(call), call.getString("sessionId"))
    }

    @PluginMethod
    fun readSavedRawPpgCertification(call: PluginCall) = ppgEvidenceCall(call) {
        manager.readSavedRawPpgCertification(journalOwner(call), journalDevice(call))
    }

    // VC29 one-shot physical Raw PPG certification. Capture is the only BLE-issuing method here; it is gated on
    // READY + authenticated scope and on the restart-persistent attempt claim. All other methods are offline.
    @PluginMethod
    fun captureRawPpgCertification(call: PluginCall) {
        manager.captureRawPpgCertification { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result!!))
        }
    }

    @PluginMethod
    fun getRawPpgCertificationStatus(call: PluginCall) = ppgEvidenceCall(call) {
        manager.rawPpgCertificationStatus(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun inspectSavedRawPpgPhysicalCertification(call: PluginCall) = ppgEvidenceCall(call) {
        manager.inspectSavedRawPpgCertification(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun readSavedRawPpgPhysicalCertification(call: PluginCall) = ppgEvidenceCall(call) {
        manager.readSavedRawPpgPhysicalCertification(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun exportRawPpgCertificationSpool(call: PluginCall) = ppgEvidenceCall(call) {
        manager.exportRawPpgCertificationSpool(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun syncHistoricalHeartRate(call: PluginCall) {
        val maxValidSamples = call.getInt("maxValidSamples")
        if (maxValidSamples != null && maxValidSamples !in 1..MAX_SAFE_TEST_SAMPLES) {
            return call.reject("maxValidSamples must be 1..$MAX_SAFE_TEST_SAMPLES", JCVitalV8ErrorCode.UNSUPPORTED_OPERATION.name)
        }
        resolveHistorical(call) { callback -> manager.syncHistoricalHeartRate(maxValidSamples, callback) }
    }

    @PluginMethod
    fun ackHistoricalHrChunk(call: PluginCall) {
        val syncSessionId = call.getString("syncSessionId")
        val chunkIndex = call.getInt("chunkIndex")
        if (syncSessionId.isNullOrBlank() || chunkIndex == null) {
            return call.reject("syncSessionId and chunkIndex are required", JCVitalV8ErrorCode.UNSUPPORTED_OPERATION.name)
        }
        manager.ackHistoricalHrChunk(syncSessionId, chunkIndex)
        call.resolve()
    }

    @PluginMethod
    fun getNativeBreadcrumbs(call: PluginCall) {
        call.resolve(toJsObject(manager.nativeBreadcrumbs()))
    }

    @PluginMethod
    fun syncHistoricalSpo2(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalSpo2)

    @PluginMethod
    fun syncHistoricalTemperature(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalTemperature)

    @PluginMethod
    fun syncHistoricalHrv(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalHrv)

    @PluginMethod
    fun syncHistoricalPpi(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalPpi)

    @PluginMethod
    fun syncHistoricalActivity(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalActivity)

    @PluginMethod
    fun syncDetailedActivity(call: PluginCall) = resolveHistorical(call, manager::syncDetailedActivity)

    @PluginMethod
    fun beginPhysicalSemanticTest(call: PluginCall) {
        manager.beginPhysicalSemanticTest(call.getString("kind") ?: "", call.getString("attemptId")) { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result ?: emptyMap()))
        }
    }

    @PluginMethod
    fun readPhysicalSemanticTestEvidence(call: PluginCall) = journalCall(call) {
        mapOf("json" to manager.readPhysicalSemanticTestEvidence(
            journalOwner(call), journalDevice(call), call.getString("kind") ?: ""))
    }

    @PluginMethod
    fun endPhysicalSemanticTest(call: PluginCall) {
        manager.endPhysicalSemanticTest { result, error ->
            if (error != null) reject(call, error) else call.resolve(toJsObject(result ?: emptyMap()))
        }
    }

    @PluginMethod
    fun syncActivityCertification(call: PluginCall) = resolveHistorical(call, manager::syncActivityCertification)

    @PluginMethod
    fun syncHistoricalSleepStages(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalSleepStages)

    @PluginMethod
    fun syncHistoricalSleepMovement(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalSleepMovement)

    @PluginMethod
    fun syncSleepCertification(call: PluginCall) = resolveHistorical(call, manager::syncSleepCertification)

    @PluginMethod
    fun syncHistoricalWorkouts(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalWorkouts)

    @PluginMethod
    fun syncWorkoutHistoryCertification(call: PluginCall) = resolveHistorical(call, manager::syncWorkoutHistoryCertification)

    @PluginMethod
    fun readWorkoutCertificationSnapshot(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.readWorkoutCertification(journalOwner(call), journalDevice(call))
    }

    @PluginMethod
    fun readWorkoutSourceEnvelope(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.readWorkoutSourceEnvelope(journalOwner(call), journalDevice(call),
            call.getString("envelopeId") ?: throw IllegalArgumentException("envelopeId is required"))
    }

    @PluginMethod
    fun writeWorkoutCertificationSnapshot(call: PluginCall) = journalCall(call) {
        manager.sourceJournal.writeWorkoutCertification(journalOwner(call), journalDevice(call),
            call.getString("json") ?: throw IllegalArgumentException("json is required"))
    }

    @PluginMethod
    fun getMonitoringConfiguration(call: PluginCall) = resolveHistorical(call, manager::requestMonitoringConfiguration)

    private fun resolveHistorical(
        call: PluginCall,
        operation: ((Map<String, Any?>?, JCVitalV8Exception?) -> Unit) -> Unit,
    ) {
        operation { result, error -> if (error != null) reject(call, error) else call.resolve(toJsObject(result!!)) }
    }

    private fun alias(): String = JCVitalV8Permissions.alias(Build.VERSION.SDK_INT)

    private fun permissionStatus(): JCVitalV8PermissionStatus {
        val status = JCVitalV8Permissions.normalize(manager.isAvailable(), manager.isEnabled(), getPermissionState(alias())?.toString())
        if (status != lastPermissionStatus) {
            Log.i(TAG, "permission status ${lastPermissionStatus ?: "unknown"} -> $status")
            lastPermissionStatus = status
        }
        return status
    }

    private fun permissionPayload(): JSObject = JSObject()
        .put("status", permissionStatus().name)
        .put("bluetoothEnabled", manager.isEnabled())
        .put("permissions", toJsArray(JCVitalV8Permissions.requiredPermissions(Build.VERSION.SDK_INT)))

    private fun stateObject(): JSObject = JSObject()
        .put("state", manager.state.name)
        .put("deviceId", manager.connectedDeviceId() ?: JSONObject.NULL)

    private fun reject(call: PluginCall, error: JCVitalV8Exception) {
        call.reject(error.message ?: error.code.name, error.code.name)
    }

    companion object {
        private const val TAG = "JCVitalV8"
        private const val MAX_SAFE_TEST_SAMPLES = 50_000

        fun toJsObject(map: Map<String, Any?>): JSObject {
            val result = JSObject()
            map.forEach { (key, value) -> result.put(key, toJsValue(value)) }
            return result
        }

        private fun toJsArray(list: List<*>): JSArray {
            val result = JSArray()
            list.forEach { result.put(toJsValue(it)) }
            return result
        }

        @Suppress("UNCHECKED_CAST")
        private fun toJsValue(value: Any?): Any = when (value) {
            null -> JSONObject.NULL
            is Map<*, *> -> toJsObject(value as Map<String, Any?>)
            is List<*> -> toJsArray(value)
            else -> value
        }
    }
}
