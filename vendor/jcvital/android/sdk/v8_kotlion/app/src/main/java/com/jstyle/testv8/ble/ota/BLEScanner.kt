package com.jstyle.testv8.ble.ota

import android.os.ParcelUuid

interface BLEScanner {
    fun searchForAddress(deviceAddress: String?, scanCallback: BLEScanCallback?)

    fun searchForName(devcieName: String?, scanCallback: BLEScanCallback?)

    fun searchForServiceUUID(uuid: ParcelUuid?, scanCallback: BLEScanCallback?)

    fun searchAll(scanCallback: BLEScanCallback?)

    fun stopScan()

    companion object {
        /**
         * After the buttonless jump from the application mode to the bootloader mode the service
         * will wait this long for the advertising bootloader (in milliseconds).
         */
        const val TIMEOUT: Long = 20000L // ms
    }
}