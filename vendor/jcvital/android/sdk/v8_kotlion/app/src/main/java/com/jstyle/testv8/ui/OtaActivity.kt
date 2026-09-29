package com.jstyle.testv8.ui

import android.app.Activity
import android.app.ProgressDialog
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothAdapter.LeScanCallback
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothManager
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.text.TextUtils
import android.util.Log
import android.view.View
import android.view.WindowManager
import android.widget.Toast
import androidx.localbroadcastmanager.content.LocalBroadcastManager
import com.jstyle.testv8.R
import com.jstyle.testv8.ble.BleData
import com.jstyle.testv8.ble.DfuService
import com.jstyle.testv8.ble.RxBus
import com.jstyle.testv8.databinding.ActivityOtaBinding

import no.nordicsemi.android.dfu.DfuBaseService
import no.nordicsemi.android.dfu.DfuProgressListener
import no.nordicsemi.android.dfu.DfuServiceInitiator
import no.nordicsemi.android.dfu.DfuServiceListenerHelper
import java.util.Locale
import kotlin.collections.dropLastWhile
import kotlin.collections.toTypedArray
import kotlin.jvm.java
import kotlin.text.contains
import kotlin.text.endsWith
import kotlin.text.format
import kotlin.text.isEmpty
import kotlin.text.lowercase
import kotlin.text.split
import kotlin.text.toInt
import kotlin.text.toRegex

lateinit var activityotainfoBinding: ActivityOtaBinding
class OtaActivity : Activity(), View.OnClickListener {
    private var mAdapter: BluetoothAdapter? = null
    private var mFilePath: String? = null
    private var mFileStreamUri: Uri? = null
    private val handler: Handler? = Handler()

    private var dialog: ProgressDialog? = null

    protected var version: String? = null

    private var deviceAddress: String? = null
    private var devicesname: String? = null //设备mac地址，搜索到这个表示设备未进入dfu模式，或者已经从dfu模式恢复
    private var isDfuAddress = false
    private var isbootMode = false
    private var targetAddress: String? = null


    override fun onCreate(savedInstanceState: Bundle?) {
        // TODO Auto-generated method stub
        super.onCreate(savedInstanceState)
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        activityotainfoBinding=ActivityOtaBinding.inflate(layoutInflater)
        setContentView(activityotainfoBinding.getRoot());

        Log.i(TAG, "onCreate:OtaActivity ")
        val manager = getSystemService(BLUETOOTH_SERVICE) as BluetoothManager
        mAdapter = manager.getAdapter()

        mFilePath = getIntent().getStringExtra(EXTRA_FILE_PATH)
        mFileStreamUri = getIntent().getParcelableExtra<Uri?>(EXTRA_FILE_URI)
        deviceAddress = getIntent().getStringExtra(Device_Address)
        devicesname = getIntent().getStringExtra(Device_name)
        isDfuAddress = getIntent().getBooleanExtra(IsDfuAddress, false)
        isbootMode = getIntent().getBooleanExtra(IsisbootMode, false)
        if (!TextUtils.isEmpty(deviceAddress)) {
            targetAddress = getCovertAddress(isDfuAddress, deviceAddress!!)
        }

        startScan(true)
        initView()
    }

    private fun getCovertAddress(isDfuAddress: Boolean, address: String): String? {
        if (isDfuAddress) return address
        val macArray = address.split(":".toRegex()).dropLastWhile { it.isEmpty() }.toTypedArray()
        val length = macArray.size
        val lastHex = macArray[length - 1]
        val value = lastHex.toInt(16)
        val covertValue = value + 1
        val covertHex = String.format("%02X", covertValue and 0xff)
        val covertAddress = StringBuffer()
        for (i in 0..<length - 1) {
            val mac: String? = macArray[i]
            covertAddress.append(mac).append(":")
        }
        return covertAddress.append(covertHex).toString()
    }

    private fun initView() {
        dialog = ProgressDialog(this)
        dialog!!.setTitle(getString(R.string.Please_wait))
        dialog!!.setCanceledOnTouchOutside(false)

        //	if(device.deviceName.equals("DfuTarg")){
        //		sendHex(device.deviceName,device.deviceMac);
        //	}
    }


    override fun onClick(arg0: View) {
        when (arg0.getId()) {
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        // TODO Auto-generated method stub
        super.onActivityResult(requestCode, resultCode, data)
    }

    override fun onDestroy() {
        // TODO Auto-generated method stub
        super.onDestroy()
        Log.i(TAG, "onDestroy: ")
        val manager = LocalBroadcastManager.getInstance(this)

        getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (handler != null) handler.removeCallbacksAndMessages(null)
    }



    protected fun onTransferCompleted() {
        activityotainfoBinding. progressbarFile?.setVisibility(View.INVISIBLE)
        activityotainfoBinding.  textviewProgress?.setVisibility(View.INVISIBLE)
        Toast.makeText(this, R.string.ota_success, Toast.LENGTH_SHORT).show()
        sendDfuAction(Action_Dfu_Complete)
         finish()

    }

    private fun sendDfuAction(action: String?, data: String?) {
        val rxBus: RxBus = RxBus.instance
        val bleData = BleData()
        bleData.data = data
        bleData.action = action
        rxBus.post(bleData)
        finish()
    }

    private fun sendDfuAction(action: String?) {
        val rxBus: RxBus = RxBus.instance
        val bleData = BleData()
        bleData.action = action
        rxBus.post(bleData)
        finish()
    }

    private var isStart = false //防止扫描速度过快导致重复进入dfubaservice
    private val callback: LeScanCallback = object : LeScanCallback {
        override fun onLeScan(device: BluetoothDevice, arg1: Int, arg2: ByteArray?) {
            runOnUiThread(object : Runnable {
                override fun run() {
                    val name = device.getName()
                    val address = device.getAddress()
                    if ((!TextUtils.isEmpty(name))){
                        Log.i(TAG, "run: " + address+"***"+name)
                    }

                    //本来根据mac地址来判断，但是有的设备没有根据mac地址+1来的，所以还是用名字带dfu的来识别
                    if ((!TextUtils.isEmpty(name))) {
                        if (name!!.lowercase(Locale.getDefault()).contains("dfu")) {
                            if (!isStart) {
                                isStart = true
                                startScan(false)
                                Handler().postDelayed(object : Runnable {
                                    override fun run() {
                                        sendHex(name, address)
                                    }
                                }, 2000)
                            }
                        }
                    }
                }
            })
        }
    }
    var dfuServiceInitiator: DfuServiceInitiator? = null
    private fun sendHex(name: String?, address: String) {
        if (TextUtils.isEmpty(mFilePath) && mFileStreamUri == null) return
        Log.e(
            "msmsmsmsm",
            "sendHex: " + name + "***" + address + "***" + mFilePath + "***" + mFileStreamUri
        )
        val starter = DfuServiceInitiator(address)
            .setDeviceName(name)
            .setKeepBond(false)
            .setForceDfu(false)
            .setForeground(false)
            .setPacketsReceiptNotificationsEnabled(Build.VERSION.SDK_INT < Build.VERSION_CODES.M)
            .setPacketsReceiptNotificationsValue(DfuServiceInitiator.DEFAULT_PRN_VALUE)
            .setUnsafeExperimentalButtonlessServiceInSecureDfuEnabled(true)
        if (!TextUtils.isEmpty(mFilePath)) {
            if (mFilePath!!.endsWith("zip")) {
                dfuServiceInitiator = starter.setZip(mFileStreamUri, mFilePath)
            } else {
                dfuServiceInitiator =
                    starter.setBinOrHex(DfuBaseService.TYPE_APPLICATION, mFileStreamUri, mFilePath)
            }
        } else {
            dfuServiceInitiator = starter.setZip(mFileStreamUri, mFilePath)
        }

        starter.start(this, DfuService::class.java)

        DfuServiceListenerHelper.registerProgressListener(this, object : DfuProgressListener {
            override fun onDeviceConnecting(deviceAddress: String?) {
                dialog!!.cancel()
                activityotainfoBinding. progressbarFile?.visibility = View.VISIBLE
                activityotainfoBinding.  textviewProgress?.visibility = View.VISIBLE
                activityotainfoBinding. progressbarFile?.isIndeterminate = true
                activityotainfoBinding.  textviewProgress?.setText(R.string.dfu_status_connecting)
            }

            override fun onDeviceConnected(deviceAddress: String?) {
                activityotainfoBinding. progressbarFile?.isIndeterminate = true
                activityotainfoBinding.  textviewProgress?.setText(R.string.dfu_status_starting)

            }
            override fun onDfuProcessStarting(deviceAddress: String?) {}
            override fun onDfuProcessStarted(deviceAddress: String?) {}
            override fun onEnablingDfuMode(deviceAddress: String?) {}
            override fun onProgressChanged(
                deviceAddress: String?,
                percent: Int,
                speed: Float,
                avgSpeed: Float,
                currentPart: Int,
                partsTotal: Int
            ) {
                activityotainfoBinding. progressbarFile?.setIndeterminate(false)
                activityotainfoBinding. progressbarFile?.setProgress(percent)
                //Log.i(TAG, "updateProgressBar: "+progress);
                activityotainfoBinding.  textviewProgress?.setText(getString(R.string.progress, percent))

            }
            override fun onFirmwareValidating(deviceAddress: String?) {}
            override fun onDeviceDisconnecting(deviceAddress: String?) {}
            override fun onDeviceDisconnected(deviceAddress: String?) {}
            override fun onDfuCompleted(deviceAddress: String?) {
                activityotainfoBinding.  textviewProgress?.setText(R.string.dfu_status_completed)
                // let's wait a bit until we cancel the notification. When canceled immediately it will be recreated by service again.
                Handler().postDelayed(object : Runnable {
                    override fun run() {
                        onTransferCompleted()
                        //isOtaSuccess=true;
                    }
                }, 200)

            }

            override fun onDfuAborted(deviceAddress: String?) {
            }

            override fun onError(
                deviceAddress: String?,
                error: Int,
                errorType: Int,
                message: String?
            ) {
            }
        })
    }

    protected fun startScan(b: Boolean) {
        if (b) {
            handler!!.postDelayed(object : Runnable {
                override fun run() {    // TODO Auto-generated method stub
                    mAdapter!!.stopLeScan(callback)
                    //Log.i(TAG, "run: 扫描超时");
                    sendDfuAction(Action_Dfu_Failed, "扫描超时")
                    Log.i(TAG, "startScan: stop超时")
                }
            }, 20000)
            Log.i(TAG, "startScan: start")
            mAdapter!!.startLeScan(callback)
        } else {
            Log.i(TAG, "startScan: stop")
            mAdapter!!.stopLeScan(callback)
            handler!!.removeCallbacksAndMessages(null)
        }
    }


    companion object {
        private const val EXTRA_URI = "uri"
        const val EXTRA_FILE_URI: String = "jstyle.dfu.extra.EXTRA_FILE_URI"
        const val EXTRA_FILE_PATH: String = "jstyle.dfu.extra.EXTRA_FILE_PATH"
        const val IsDfuAddress: String = "jstyle.dfu.extra.IsDfuAddress"
        const val IsisbootMode: String = "jstyle.dfu.extra.isbootMode"
        var Device_Address: String = "device_address"
        var Device_name: String = "device_Device_name"
        private const val SELECT_FILE_REQ = 1
        const val REQUEST_ENABLE_BT: Int = 2
        const val Action_Dfu_Complete: String = "Action_Dfu_Complete"
        const val Action_Dfu_Failed: String = "Action_Dfu_Failed"
        const val Action_EnterDfuMode_Failed: String = "Action_EnterDfuMode_Failed"
        private const val TAG = "OtaActivity"
    }
}
