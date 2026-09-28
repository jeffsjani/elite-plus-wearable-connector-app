package com.hapi.eliteplus.connector

import android.content.Intent
import android.os.Build
import androidx.activity.result.ActivityResult
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.PermissionController
import androidx.health.connect.client.changes.DeletionChange
import androidx.health.connect.client.changes.UpsertionChange
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.*
import androidx.health.connect.client.request.ChangesTokenRequest
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Instant
import java.time.Duration
import kotlin.reflect.KClass

@CapacitorPlugin(name = "EliteHealthConnect")
class EliteHealthConnectPlugin : Plugin() {
    private val scope = CoroutineScope(Dispatchers.IO)
    private val types: Map<String, KClass<out Record>> = mapOf(
        "heartRate" to HeartRateRecord::class,
        "restingHeartRate" to RestingHeartRateRecord::class,
        "hrv" to HeartRateVariabilityRmssdRecord::class,
        "sleep" to SleepSessionRecord::class,
        "steps" to StepsRecord::class,
        "activeCalories" to ActiveCaloriesBurnedRecord::class,
        "exercise" to ExerciseSessionRecord::class,
        "respiratoryRate" to RespiratoryRateRecord::class,
        "oxygenSaturation" to OxygenSaturationRecord::class,
        "weight" to WeightRecord::class,
        "height" to HeightRecord::class,
        "bodyTemperature" to BodyTemperatureRecord::class,
    )

    private fun sdkStatus(): Int = if (Build.VERSION.SDK_INT < 28) HealthConnectClient.SDK_UNAVAILABLE else HealthConnectClient.getSdkStatus(context)
    private fun client(): HealthConnectClient = HealthConnectClient.getOrCreate(context)

    private fun requested(call: PluginCall): Map<String, KClass<out Record>>? {
        val selected = call.getArray("types") ?: return null
        val keys = (0 until selected.length()).map { selected.optString(it) }
        if (keys.isEmpty() || keys.any { !types.containsKey(it) }) return null
        return keys.associateWith { types.getValue(it) }
    }

    @PluginMethod
    fun availability(call: PluginCall) {
        val status = when (sdkStatus()) {
            HealthConnectClient.SDK_AVAILABLE -> "AVAILABLE"
            HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> {
                val installed = try { context.packageManager.getPackageInfo("com.google.android.apps.healthdata", 0); true }
                    catch (_: Exception) { false }
                if (installed || Build.VERSION.SDK_INT >= 34) "UPDATE_REQUIRED" else "NOT_INSTALLED"
            }
            else -> "UNSUPPORTED"
        }
        call.resolve(JSObject().put("status", status))
    }

    @PluginMethod
    fun openHealthConnect(call: PluginCall) {
        try {
            val intent = if (Build.VERSION.SDK_INT >= 34) Intent("android.health.connect.action.HEALTH_CONNECT_SETTINGS")
                else Intent("androidx.health.ACTION_HEALTH_CONNECT_SETTINGS").setPackage("com.google.android.apps.healthdata")
            if (intent.resolveActivity(context.packageManager) == null) {
                val market = Intent(Intent.ACTION_VIEW, android.net.Uri.parse("market://details?id=com.google.android.apps.healthdata"))
                activity.startActivity(market)
            } else activity.startActivity(intent)
            call.resolve()
        } catch (error: Exception) { call.reject("Unable to open Health Connect", null, error) }
    }

    @PluginMethod
    fun grantedPermissions(call: PluginCall) {
        val selected = requested(call) ?: run { call.reject("Invalid health data types"); return }
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect unavailable"); return }
        scope.launch {
            try {
                val grants = client().permissionController.getGrantedPermissions()
                val names = selected.filterValues { HealthPermission.getReadPermission(it) in grants }.keys
                call.resolve(JSObject().put("granted", JSArray(names.toList())))
            } catch (error: Exception) { call.reject("Unable to check Health Connect permissions", null, error) }
        }
    }

    @PluginMethod
    fun requestReadPermissions(call: PluginCall) {
        val selected = requested(call) ?: run { call.reject("Invalid health data types"); return }
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect unavailable"); return }
        try {
            val permissions = selected.values.map { HealthPermission.getReadPermission(it) }.toSet()
            val intent = PermissionController.createRequestPermissionResultContract().createIntent(context, permissions)
            startActivityForResult(call, intent, "permissionResult")
        } catch (error: Exception) { call.reject("Unable to request Health Connect permissions", null, error) }
    }

    @ActivityCallback
    private fun permissionResult(call: PluginCall, result: ActivityResult) {
        val selected = requested(call) ?: run { call.reject("Invalid health data types"); return }
        val granted = PermissionController.createRequestPermissionResultContract().parseResult(result.resultCode, result.data)
        call.resolve(JSObject().put("granted", JSArray(selected.filterValues { HealthPermission.getReadPermission(it) in granted }.keys.toList())))
    }

    @PluginMethod
    fun getChangesToken(call: PluginCall) {
        val selected = requested(call) ?: run { call.reject("Invalid health data types"); return }
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect unavailable"); return }
        scope.launch {
            try {
                val token = client().getChangesToken(ChangesTokenRequest(selected.values.toSet()))
                call.resolve(JSObject().put("token", token))
            } catch (error: Exception) { call.reject("Unable to start Health Connect changes", null, error) }
        }
    }

    @PluginMethod
    fun readHistory(call: PluginCall) {
        val type = call.getString("type")?.let { types[it] } ?: run { call.reject("Unsupported health data type"); return }
        val start = try { Instant.parse(call.getString("startTime")) } catch (_: Exception) { null }
        val end = try { Instant.parse(call.getString("endTime")) } catch (_: Exception) { null }
        if (start == null || end == null || start >= end) { call.reject("Invalid history window"); return }
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect unavailable"); return }
        scope.launch {
            try {
                val records = JSArray()
                var page: String? = null
                do {
                    val response = client().readRecords(ReadRecordsRequest(type, TimeRangeFilter.between(start, end), pageSize = 1000, pageToken = page))
                    for (record in response.records) {
                        for (entry in convert(record)) records.put(entry)
                    }
                    if (records.length() > 50000) throw IllegalStateException("History limit reached")
                    page = response.pageToken
                } while (page != null)
                call.resolve(JSObject().put("records", records))
            } catch (error: Exception) { call.reject("Unable to read Health Connect history", null, error) }
        }
    }

    @PluginMethod
    fun getChanges(call: PluginCall) {
        val token = call.getString("token") ?: run { call.reject("Missing changes token"); return }
        if (sdkStatus() != HealthConnectClient.SDK_AVAILABLE) { call.reject("Health Connect unavailable"); return }
        scope.launch {
            try {
                val changes = client().getChanges(token)
                val upsertions = JSArray()
                val deletions = JSArray()
                for (change in changes.changes) when (change) {
                    is UpsertionChange -> for (entry in convert(change.record)) upsertions.put(entry)
                    is DeletionChange -> deletions.put(change.recordId)
                }
                call.resolve(JSObject().put("upsertions", upsertions).put("deletions", deletions)
                    .put("nextToken", changes.nextChangesToken).put("hasMore", changes.hasMore)
                    .put("expired", changes.changesTokenExpired))
            } catch (error: Exception) { call.reject("Unable to read Health Connect changes", null, error) }
        }
    }

    private fun convert(record: Record): List<JSObject> {
        val result = mutableListOf<JSObject>()
        val id = record.metadata.id
        val modified = record.metadata.lastModifiedTime.toString()
        val origin = record.metadata.dataOrigin.packageName
        val device = record.metadata.device
        fun entry(metric: String, value: Double, unit: String, start: Instant, end: Instant, suffix: String = "") {
            if (!value.isFinite() || id.isBlank()) return
            val json = JSObject().put("recordId", id + suffix).put("lastModifiedTime", modified)
                .put("originPackage", origin).put("metric", metric).put("value", value).put("unit", unit)
                .put("startTime", start.toString()).put("endTime", end.toString())
            device?.manufacturer?.let { json.put("deviceManufacturer", it) }
            device?.model?.let { json.put("deviceModel", it) }
            val offset = when (record) {
                is HeartRateRecord -> record.startZoneOffset
                is SleepSessionRecord -> record.startZoneOffset
                is StepsRecord -> record.startZoneOffset
                is ActiveCaloriesBurnedRecord -> record.startZoneOffset
                is ExerciseSessionRecord -> record.startZoneOffset
                is RestingHeartRateRecord -> record.zoneOffset
                is HeartRateVariabilityRmssdRecord -> record.zoneOffset
                is RespiratoryRateRecord -> record.zoneOffset
                is OxygenSaturationRecord -> record.zoneOffset
                is WeightRecord -> record.zoneOffset
                is HeightRecord -> record.zoneOffset
                is BodyTemperatureRecord -> record.zoneOffset
                else -> null
            }
            offset?.let { json.put("zoneOffset", it.id) }
            result.add(json)
        }
        when (record) {
            is HeartRateRecord -> record.samples.forEachIndexed { index, sample -> entry("heartRate", sample.beatsPerMinute.toDouble(), "bpm", sample.time, sample.time, ":$index") }
            is RestingHeartRateRecord -> entry("restingHeartRate", record.beatsPerMinute.toDouble(), "bpm", record.time, record.time)
            is HeartRateVariabilityRmssdRecord -> entry("hrv_rmssd", record.heartRateVariabilityMillis, "millisecond", record.time, record.time)
            is SleepSessionRecord -> {
                entry("sleep_session", Duration.between(record.startTime, record.endTime).toMinutes().toDouble(), "minute", record.startTime, record.endTime)
                record.stages.forEachIndexed { index, stage -> entry("sleep_stage_${stage.stage}", Duration.between(stage.startTime, stage.endTime).toMinutes().toDouble(), "minute", stage.startTime, stage.endTime, ":$index") }
            }
            is StepsRecord -> entry("steps", record.count.toDouble(), "count", record.startTime, record.endTime)
            is ActiveCaloriesBurnedRecord -> entry("active_energy", record.energy.inKilocalories, "kilocalorie", record.startTime, record.endTime)
            is ExerciseSessionRecord -> entry("exercise_${record.exerciseType}", Duration.between(record.startTime, record.endTime).seconds.toDouble(), "second", record.startTime, record.endTime)
            is RespiratoryRateRecord -> entry("respiratoryRate", record.rate, "breaths/minute", record.time, record.time)
            is OxygenSaturationRecord -> entry("oxygenSaturation", record.percentage.value, "percent", record.time, record.time)
            is WeightRecord -> entry("weight", record.weight.inKilograms, "kilogram", record.time, record.time)
            is HeightRecord -> entry("height", record.height.inMeters, "meter", record.time, record.time)
            is BodyTemperatureRecord -> entry("bodyTemperature", record.temperature.inCelsius, "celsius", record.time, record.time)
        }
        return result
    }
}