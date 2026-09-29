package com.jstyle.testv8.ble.ota

import android.annotation.TargetApi
import android.bluetooth.BluetoothAdapter
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.os.Build
import android.os.ParcelUuid
import android.text.TextUtils
import java.util.Locale

/**
 * @see BLEScanner
 */
@TargetApi(Build.VERSION_CODES.LOLLIPOP)
class BLEScannerLollipop : ScanCallback(), BLEScanner {
    private var mFilterDeviceAddress: String? = null
    private var mFilterDeviceName: String? = null
    private var mFilterServiceUUID: ParcelUuid? = null
    private var scanCallback: BLEScanCallback? = null
    private var searchAll = false
    private var scanner: BluetoothLeScanner? = null
    private var mFound = false
    private var mStart = false





    override fun searchForAddress(
        deviceAddress: String?,
        scanCallback: BLEScanCallback?
    ) {
        mFilterDeviceAddress = deviceAddress
        this.scanCallback = scanCallback
        startScan()
    }

    override fun searchForName(
        devcieName: String?,
        scanCallback: BLEScanCallback?
    ) {
        mFilterDeviceName = devcieName
        this.scanCallback = scanCallback
        startScan()
    }

    override fun searchForServiceUUID(
        uuid: ParcelUuid?,
        scanCallback: BLEScanCallback?
    ) {
        mFilterServiceUUID = uuid
        this.scanCallback = scanCallback
        startScan()
    }

    override fun searchAll(scanCallback: BLEScanCallback?) {
        searchAll = true
        this.scanCallback = scanCallback
        startScan()
    }

    override fun stopScan() {
        mStart = false
        val adapter = BluetoothAdapter.getDefaultAdapter()
        if (adapter == null || adapter.getState() != BluetoothAdapter.STATE_ON) {
            scanCallback!!.onScanError()
            return
        }
        scanner!!.stopScan(this)

        mFilterDeviceAddress = null
        mFilterDeviceName = null
        mFilterServiceUUID = null
    }


    private fun startScan() {
        mStart = true
        val adapter = BluetoothAdapter.getDefaultAdapter()
        if (adapter == null || adapter.getState() != BluetoothAdapter.STATE_ON) {
            scanCallback!!.onScanError()
            return
        }

        scanner = adapter.getBluetoothLeScanner()
        if (scanner == null) {
            scanCallback!!.onScanError()
            return
        }

        mFound = false
        // Add timeout
        Thread(Runnable {
            try {
                Thread.sleep( /*BLEScanner.TIMEOUT*/40000)
            } catch (e: InterruptedException) {
                // do nothing
            }
            if (mStart) {
                scanCallback!!.onScanTimeOut(mFound)
                stopScan()
                mFound = false
            }
        }, "Scanner timer").start()

        if (mFilterServiceUUID != null) {
            val settings =
                ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build()
            val filters: MutableList<ScanFilter?> = ArrayList<ScanFilter?>()
            filters.add(ScanFilter.Builder().setServiceUuid(mFilterServiceUUID).build())
            scanner!!.startScan(filters, settings, this)
        } else {
            scanner!!.startScan(
                null, ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setReportDelay(0).build(), this
            )
        }


        /*final ScanSettings settings = new ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).build();
        final List<ScanFilter> filters = new ArrayList<>();
        if (mFilterServiceUUID != null) {
            filters.add(new ScanFilter.Builder().setServiceUuid(mFilterServiceUUID).build());
            scanner.startScan(filters, settings, this);
        } else if (mFilterDeviceName != null) {
            filters.add(new ScanFilter.Builder().setDeviceName(mFilterDeviceName).build());
            scanner.startScan(filters, settings, this);
        } else if (mFilterDeviceAddress != null) {
            filters.add(new ScanFilter.Builder().setDeviceAddress(mFilterDeviceAddress).build());
            scanner.startScan(filters, settings, this);
        } else {
            scanner.startScan(null, new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setReportDelay(0).build(), this);
           */
        /* scanner.startScan(*/ /**/ /*filters*/ /**/ /* null, settings, this);*/ /*
        }*/
    }


    override fun onScanResult(callbackType: Int, result: ScanResult) {
        super.onScanResult(callbackType, result)
        if (!mStart) return

        if (searchAll) {
            //Log.e("kmksmada",""+result.getDevice().getName());
            if ((null != result.getDevice() && !TextUtils.isEmpty(
                    result.getDevice().getName()
                )) && (result.getDevice().getName().trim { it <= ' ' }.lowercase(
                    Locale.getDefault()
                ).contains("j2223") ||
                        result.getDevice().getName().trim { it <= ' ' }
                            .lowercase(Locale.getDefault()).contains("dfu"))
            ) {
                scanCallback!!.onScanResult(result.getDevice(), result.getRssi())
            }
        } else {
            if (mFilterServiceUUID != null) {
                mFound = true
                // Log.e("kmksmada","bbb"+result.getDevice().getName());
                scanCallback!!.onScanResult(result.getDevice(), result.getRssi())
            } else {
                val address = result.getDevice().getAddress()
                val name = result.getDevice().getName()

                /*   if (mFilterDeviceAddress != null) {
                    if (address.equals(mFilterDeviceAddress)) {
                        mFound = true;
                        scanCallback.onScanResult(result.getDevice(), result.getRssi());
                        return;
                    }
                }*/
                if (mFilterDeviceName != null) {
                    if (name != null && name == mFilterDeviceName) {
                        mFound = true
                        scanCallback!!.onScanResult(result.getDevice(), result.getRssi())
                    }
                }
            }
        }
    }

    override fun onBatchScanResults(results: MutableList<ScanResult?>?) {
        super.onBatchScanResults(results)
    }

    override fun onScanFailed(errorCode: Int) {
        super.onScanFailed(errorCode)
    }
}