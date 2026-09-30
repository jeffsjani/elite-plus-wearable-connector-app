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

    override fun load() {
        manager = JCVitalV8Manager(context) { name, payload -> notifyListeners(name, toJsObject(payload)) }
    }

    override fun handleOnDestroy() {
        manager.release()
    }

    @PluginMethod
    fun isAvailable(call: PluginCall) {
        call.resolve(JSObject().put("available", manager.isAvailable()).put("enabled", manager.isEnabled()))
    }

    @PluginMethod
    fun getPermissionStatus(call: PluginCall) {
        call.resolve(permissionPayload())
    }

    @PluginMethod
    override fun requestPermissions(call: PluginCall) {
        val status = permissionStatus()
        if (status == JCVitalV8PermissionStatus.BLUETOOTH_UNAVAILABLE || getPermissionState(alias())?.toString() == "granted") {
            return call.resolve(permissionPayload())
        }
        Log.i(TAG, "requesting ${JCVitalV8Permissions.requiredPermissions(Build.VERSION.SDK_INT).joinToString()}")
        requestPermissionForAlias(alias(), call, "permissionsCallback")
    }

    @PermissionCallback
    private fun permissionsCallback(call: PluginCall) {
        call.resolve(permissionPayload())
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
    fun syncHistoricalHeartRate(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalHeartRate)

    @PluginMethod
    fun syncHistoricalSpo2(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalSpo2)

    @PluginMethod
    fun syncHistoricalTemperature(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalTemperature)

    @PluginMethod
    fun syncHistoricalHrv(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalHrv)

    @PluginMethod
    fun syncHistoricalPpi(call: PluginCall) = resolveHistorical(call, manager::syncHistoricalPpi)

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
