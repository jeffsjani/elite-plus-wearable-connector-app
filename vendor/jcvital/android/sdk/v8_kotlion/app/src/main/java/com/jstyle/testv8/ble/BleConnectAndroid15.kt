package com.jstyle.testv8.ble

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.le.BluetoothLeScanner
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanFilter
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.text.TextUtils
import android.util.Log
import com.jstyle.testv8.ble.BleManager.Companion.instance
import java.util.Objects

@SuppressLint("MissingPermission")
class BleConnectAndroid15(private var mycontext: Context?) {
    private var mac: BluetoothDevice? = null
    private var macdat: BluetoothDevice? = null
    var rr: OnScanResults? = null
    private var isScanning = false
    private var bluetoothLeScanner: BluetoothLeScanner? = null
    var filters: MutableList<ScanFilter?> = ArrayList<ScanFilter?>()
    var settingsback: ScanSettings? = null
    var settings: ScanSettings? = null
    private val handler = Handler(Looper.getMainLooper())

    interface OnScanResults {
        fun Success(date: BluetoothDevice?)

        fun Fail() //只代表超时
    }

    var registerReceiver: Boolean = false

    fun SetResultsClear() {
        stopScan()
        this.rr = null
        this.macdat = null
    }

    fun SetBluetoothDevice(MAC: BluetoothDevice?, onScanResults: OnScanResults?) {
        this.mac = MAC
        this.rr = onScanResults
        this.macdat = null
        Log.e("BleService", "SetBluetoothDevice")
        handler.postDelayed(object : Runnable {
            override fun run() {
                if (null == macdat) {
                    if (null != rr && instance!!.isBleEnable) {
                        rr!!.Fail()
                        /* stopScan();*/
                    }
                }
            }
        }, 20000)
        startScan()
    }

    fun unregisterReceiver() {
        if (registerReceiver) {
            stopScan()
            registerReceiver = false
        }
    }

    fun startScan() {
        if (isScanning) return

        isScanning = true

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // 开始扫描
            if (null != bluetoothLeScanner) {
                if (null != mac) {
                    filters.clear()
                    val filter = ScanFilter.Builder().setDeviceAddress(mac!!.getAddress())
                        .build()
                    filters.add(filter)
                }
                bluetoothLeScanner!!.startScan( /*null != mac ? filters :*/null,
                    settings,
                    scanCallback
                )
            }
        } else {
            if (!Objects.requireNonNull<BleManager?>(instance).bluetoothAdapter!!.isDiscovering()) {
                instance!!.bluetoothAdapter!!.startDiscovery()
            }
        }
    }

    fun stopScan() {
        if (!isScanning) return

        isScanning = false
        // 停止扫描
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                if (null != bluetoothLeScanner) {
                    bluetoothLeScanner!!.stopScan(scanCallback)
                }
            } else {
                if (Objects.requireNonNull<BleManager?>(instance).bluetoothAdapter!!.isDiscovering()) {
                    instance!!.bluetoothAdapter!!.cancelDiscovery()
                }
            }
        } catch (E: Exception) {
        }
    }

    private val scanCallback: ScanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            super.onScanResult(callbackType, result)
            //Log.i(TAG, "onScanResult: " + callbackType + " ScanResult:" + result);
            if (result.getScanRecord() != null && null != result.getDevice()) {
                if (null != result.getDevice() && null != mac && mac!!.getAddress() == result.getDevice()
                        .getAddress() && null == macdat
                ) {
                    synchronized(this) {
                        macdat = result.getDevice()
                        if (null != rr) {
                            rr!!.Success(result.getDevice())
                        }
                        SetResultsClear()
                    }

                    // Log.d("BleService", "发现设备: " + deviceName + " 地址: " + deviceAddress);
                } else {
                    if (null != result.getDevice() && !TextUtils.isEmpty(
                            result.getDevice().getName()
                        )
                    ) {
                        Log.d(
                            "BleService",
                            "发现设备2: " + result.getDevice().getName() + "**" + result.getDevice()
                                .getAddress()
                        )
                    }
                }
            }
        }
    }


    private val bluetoothReceiver: BroadcastReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent) {
            val action = intent.getAction()
            if (BluetoothDevice.ACTION_FOUND == action) {
                val device =
                    intent.getParcelableExtra<BluetoothDevice?>(BluetoothDevice.EXTRA_DEVICE)
                /*String deviceName = device.getName();
                String deviceAddress = device.getAddress();*/
                if (null != mac && mac!!.getAddress() == device!!.getAddress() && null == macdat) {
                    synchronized(this) {
                        macdat = device
                        if (null != rr) {
                            rr!!.Success(device)
                        }
                        SetResultsClear()
                    }
                    // Log.d("BleService", "发现设备: " + deviceName + " 地址: " + deviceAddress);
                } else {
                    Log.d("BleService", "发现设备2: ")
                }
            }
        }
    }

    init {
        // 注册广播接收器
        if (!registerReceiver) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
                this.bluetoothLeScanner = Objects.requireNonNull<BluetoothAdapter?>(
                    Objects.requireNonNull<BleManager?>(
                        instance
                    ).bluetoothAdapter
                ).getBluetoothLeScanner()
                settings = ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY)
                    .setReportDelay(0) // 可以设置报告延迟，单位为毫秒
                    .build()
                settingsback = ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER) //改为低功耗
                    .setReportDelay(0) // 可以设置报告延迟，单位为毫秒
                    .build()
            } else {
                // 注册广播接收器
                val filter = IntentFilter(BluetoothDevice.ACTION_FOUND)
                mycontext?.registerReceiver(bluetoothReceiver, filter)
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                    mycontext?.registerReceiver(bluetoothReceiver, filter, Context.RECEIVER_EXPORTED)
                } else {
                    mycontext?.registerReceiver(bluetoothReceiver, filter)
                }
            }
            registerReceiver = true
        }

    }
}



