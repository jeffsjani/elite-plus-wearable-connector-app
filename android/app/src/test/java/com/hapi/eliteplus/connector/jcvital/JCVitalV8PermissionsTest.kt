package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.assertEquals
import org.junit.Test

class JCVitalV8PermissionsTest {
    @Test
    fun unavailableAdapterWinsOverEverything() {
        assertEquals(JCVitalV8PermissionStatus.BLUETOOTH_UNAVAILABLE, JCVitalV8Permissions.normalize(false, false, "granted"))
        assertEquals(JCVitalV8PermissionStatus.BLUETOOTH_UNAVAILABLE, JCVitalV8Permissions.normalize(false, true, null))
    }

    @Test
    fun grantedAndEnabledIsAuthorized() {
        assertEquals(JCVitalV8PermissionStatus.AUTHORIZED, JCVitalV8Permissions.normalize(true, true, "granted"))
    }

    @Test
    fun grantedButAdapterOffIsBluetoothDisabled() {
        assertEquals(JCVitalV8PermissionStatus.BLUETOOTH_DISABLED, JCVitalV8Permissions.normalize(true, false, "granted"))
    }

    @Test
    fun capacitorPromptStatesMapToNotRequested() {
        assertEquals(JCVitalV8PermissionStatus.NOT_REQUESTED, JCVitalV8Permissions.normalize(true, true, "prompt"))
        assertEquals(JCVitalV8PermissionStatus.NOT_REQUESTED, JCVitalV8Permissions.normalize(true, true, null))
    }

    @Test
    fun deniedAndRationaleMapToDenied() {
        assertEquals(JCVitalV8PermissionStatus.DENIED, JCVitalV8Permissions.normalize(true, true, "denied"))
        assertEquals(JCVitalV8PermissionStatus.DENIED, JCVitalV8Permissions.normalize(true, false, "prompt-with-rationale"))
    }

    @Test
    fun android12UsesNearbyDevicePermissionsAndOlderUsesLocation() {
        assertEquals(JCVitalV8Permissions.ALIAS_BLUETOOTH, JCVitalV8Permissions.alias(31))
        assertEquals(
            listOf("android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_CONNECT"),
            JCVitalV8Permissions.requiredPermissions(36),
        )
        assertEquals(JCVitalV8Permissions.ALIAS_LOCATION, JCVitalV8Permissions.alias(30))
        assertEquals(listOf("android.permission.ACCESS_FINE_LOCATION"), JCVitalV8Permissions.requiredPermissions(24))
    }
}
