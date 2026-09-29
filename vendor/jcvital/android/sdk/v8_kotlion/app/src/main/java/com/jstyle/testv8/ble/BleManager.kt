package com.jstyle.testv8.ble


import android.app.Service
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothManager
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.os.IBinder
import android.text.TextUtils
import com.jstyle.testv8.ble.BleService.LocalBinder


/**
 * 蓝牙管理类 Bluetooth management class
 */
class BleManager private constructor(context: Context) {
    private var address: String? = null
    private var bleService: BleService? = null
    private val serviceConnection: ServiceConnection = object : ServiceConnection {
        override fun onServiceDisconnected(name: ComponentName?) { // TODO Auto-generated method stub
            bleService = null
        }

        override fun onServiceConnected(name: ComponentName?, service: IBinder?) {
            if (service is LocalBinder) {
                bleService = service.service
                if (!TextUtils.isEmpty(address)) {
                    bleService!!.initBluetoothDevice(address, context)
                }
            }
        }
    }
    private var serviceIntent: Intent? = null
    @JvmField
    var bluetoothAdapter: BluetoothAdapter?
    var context: Context?

    val isBleEnable: Boolean
        get() = bluetoothAdapter!!.enable()

    /**
     * 连接蓝牙设备
     * Connect Bluetooth device
     * @param address
     */
    fun connectDevice(address: String?) {
        if (!bluetoothAdapter!!.isEnabled() || TextUtils.isEmpty(address) || this.isConnected) return

        if (bleService == null) {
            this.address = address
        } else {
            bleService!!.initBluetoothDevice(address, this.context)
        }
    }


    /**
     * 关闭蓝牙服务通知
     * Turn off Bluetooth service notification
     */
    fun enableNotifaction() {
        if (bleService == null) return
        bleService!!.setCharacteristicNotification(true)
    }


    /**
     * 写入指令到蓝牙设备
     * Write command to Bluetooth device
     */
    fun writeValue(value: ByteArray?) {
        if (bleService == null || instance == null || !this.isConnected) return
        bleService!!.writeValue(value)
    }


    /**
     * 多条指令同时添加后发送到设备
     * Multiple instructions are added at the same time and sent to the device
     * @param data
     */
    fun offerValue(data: ByteArray?) {
        if (bleService == null) return
        bleService!!.offerValue(data)
    }


    /**
     * 写入指令到蓝牙设备
     * Write command to Bluetooth device
     */
    fun writeValue() {
        if (bleService == null) return
        bleService!!.nextQueue()
    }


    /**
     * 断开设备  Disconnect the device
     */
    fun disconnectDevice() {
        if (bleService == null) return
        bleService!!.disconnect()
    }


    val isConnected: Boolean
        /**
         * 查询设备是否已经连接
         * Query whether the device is connected
         * @return
         */
        get() {
            if (bleService == null) return false
            return bleService!!.isConnected
        }







    init {
        this.context = context
        if (serviceIntent == null) {
            serviceIntent = Intent(context, BleService::class.java)
            context.bindService(
                serviceIntent!!, serviceConnection,
                Service.BIND_AUTO_CREATE
            )
        }
        val bluetoothManager =
            context.getSystemService(Context.BLUETOOTH_SERVICE) as BluetoothManager
        bluetoothAdapter = bluetoothManager.getAdapter()
    }



    /**
     * 是否已经配对
     * @param address
     * @return
     */
    fun isPairDevices(address: String?): Boolean {
        if (bluetoothAdapter != null || !TextUtils.isEmpty(address)) {
            val pairedDevices = bluetoothAdapter!!.getBondedDevices()
            if (null == pairedDevices || pairedDevices.isEmpty()) {
                return false
            }
            val flag = false
            for (device in pairedDevices) {
                val deviceHardwareAddress = device.getAddress() // MAC address
                if (deviceHardwareAddress == address) {
                    return true
                }
            }
            return flag
        } else {
            return false
        }
    }

    companion object {
        var instance: BleManager? = null
            private set

        fun init(context: Context) {
            if (instance == null) {
                synchronized(BleManager::class.java) {
                    if (instance == null) {
                        instance = BleManager(context)
                    }
                }
            }
        }
    }
}
