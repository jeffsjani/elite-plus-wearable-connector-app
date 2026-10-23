package com.hapi.eliteplus.connector.jcvital

import android.Manifest
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.Context
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.util.Log
import androidx.core.content.ContextCompat

/** Engineering-only: reads each Android Bluetooth prerequisite separately (never one coarse AUTHORIZED flag). */
object JCVitalV8ConnectionDiagnosticState {
    private const val ANDROID_12 = 31

    fun read(context: Context, sdkInt: Int = Build.VERSION.SDK_INT): Map<String, Any?> {
        val errors = mutableListOf<Map<String, String>>()
        fun <T> inspect(field: String, read: () -> T): T? = try {
            read()
        } catch (error: Exception) {
            Log.w("V8ConnectionDiagnostic", "Cannot inspect $field", error)
            errors.add(mapOf("field" to field, "code" to error.javaClass.simpleName,
                "message" to (error.message ?: "Android state unavailable")))
            null
        }
        val adapter = inspect("adapter") {
            (context.getSystemService(Context.BLUETOOTH_SERVICE) as? BluetoothManager)?.adapter
        }
        val declared = inspect("declaredPermissions") {
            @Suppress("DEPRECATION")
            context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_PERMISSIONS)
                .requestedPermissions?.toSet() ?: emptySet()
        }
        fun permission(name: String, appliesFromSdk: Int? = null, appliesThroughSdk: Int? = null): Map<String, Any?> {
            val applies = (appliesFromSdk == null || sdkInt >= appliesFromSdk) &&
                (appliesThroughSdk == null || sdkInt <= appliesThroughSdk)
            return mapOf(
                "name" to name,
                "requiredOnThisSdk" to applies,
                "declaredInManifest" to declared?.contains(name),
                "granted" to (ContextCompat.checkSelfPermission(context, name) == PackageManager.PERMISSION_GRANTED),
            )
        }
        val adapterState = inspect("adapterState") { adapter?.state }
        return mapOf(
            "sdkInt" to sdkInt,
            "manufacturer" to Build.MANUFACTURER,
            "model" to Build.MODEL,
            "bluetoothLeFeature" to context.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE),
            "adapterSupported" to if (errors.any { it["field"] == "adapter" }) null else (adapter != null),
            "bluetoothEnabled" to inspect("bluetoothEnabled") { adapter?.isEnabled },
            "adapterState" to adapterStateName(adapterState),
            "leScannerAvailable" to inspect("leScannerAvailable") { adapter?.bluetoothLeScanner != null },
            "locationServicesEnabled" to inspect("locationServicesEnabled") {
                val manager = context.getSystemService(Context.LOCATION_SERVICE) as? LocationManager
                if (manager == null || Build.VERSION.SDK_INT < Build.VERSION_CODES.P) null else manager.isLocationEnabled
            },
            "inspectionErrors" to errors,
            "permissions" to mapOf(
                "BLUETOOTH_SCAN" to permission(Manifest.permission.BLUETOOTH_SCAN, appliesFromSdk = ANDROID_12),
                "BLUETOOTH_CONNECT" to permission(Manifest.permission.BLUETOOTH_CONNECT, appliesFromSdk = ANDROID_12),
                "ACCESS_FINE_LOCATION" to permission(Manifest.permission.ACCESS_FINE_LOCATION, appliesThroughSdk = ANDROID_12 - 1),
                "BLUETOOTH" to permission(Manifest.permission.BLUETOOTH, appliesThroughSdk = ANDROID_12 - 1),
                "BLUETOOTH_ADMIN" to permission(Manifest.permission.BLUETOOTH_ADMIN, appliesThroughSdk = ANDROID_12 - 1),
            ),
        )
    }

    fun adapterStateName(state: Int?): String = when (state) {
        null -> "UNAVAILABLE"
        BluetoothAdapter.STATE_OFF -> "OFF"
        BluetoothAdapter.STATE_TURNING_ON -> "TURNING_ON"
        BluetoothAdapter.STATE_ON -> "ON"
        BluetoothAdapter.STATE_TURNING_OFF -> "TURNING_OFF"
        else -> "UNKNOWN_$state"
    }

}
