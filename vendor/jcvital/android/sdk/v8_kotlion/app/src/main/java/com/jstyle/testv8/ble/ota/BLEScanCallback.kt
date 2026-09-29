package com.jstyle.testv8.ble.ota

import android.bluetooth.BluetoothDevice

interface BLEScanCallback {
    fun onScanTimeOut(found: Boolean)

    fun onScanResult(device: BluetoothDevice?, rssi: Int)

    fun onScanError()
}