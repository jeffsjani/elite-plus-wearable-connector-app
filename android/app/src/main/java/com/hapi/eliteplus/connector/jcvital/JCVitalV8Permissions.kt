package com.hapi.eliteplus.connector.jcvital

import android.Manifest

object JCVitalV8Permissions {
    const val ALIAS_BLUETOOTH = "bluetooth"
    const val ALIAS_LOCATION = "location"

    private const val ANDROID_12 = 31

    fun alias(sdkInt: Int): String = if (sdkInt >= ANDROID_12) ALIAS_BLUETOOTH else ALIAS_LOCATION

    fun requiredPermissions(sdkInt: Int): List<String> =
        if (sdkInt >= ANDROID_12) listOf(Manifest.permission.BLUETOOTH_SCAN, Manifest.permission.BLUETOOTH_CONNECT)
        else listOf(Manifest.permission.ACCESS_FINE_LOCATION)

    /** [capacitorState] is Capacitor's PermissionState string for the alias returned by [alias]. */
    fun normalize(adapterPresent: Boolean, adapterEnabled: Boolean, capacitorState: String?): JCVitalV8PermissionStatus {
        if (!adapterPresent) return JCVitalV8PermissionStatus.BLUETOOTH_UNAVAILABLE
        return when (capacitorState) {
            "granted" -> if (adapterEnabled) JCVitalV8PermissionStatus.AUTHORIZED else JCVitalV8PermissionStatus.BLUETOOTH_DISABLED
            "denied", "prompt-with-rationale" -> JCVitalV8PermissionStatus.DENIED
            else -> JCVitalV8PermissionStatus.NOT_REQUESTED
        }
    }
}
