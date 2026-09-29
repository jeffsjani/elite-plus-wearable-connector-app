package com.jstyle.testv8.base

import android.app.ProgressDialog
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.R
import com.jstyle.testv8.ble.BleData
import com.jstyle.testv8.ble.BleManager
import com.jstyle.testv8.ble.BleService
import com.jstyle.testv8.ble.RxBus


import io.reactivex.android.schedulers.AndroidSchedulers
import io.reactivex.disposables.Disposable
import io.reactivex.functions.Consumer
import io.reactivex.schedulers.Schedulers

/**
 * Created by Administrator on 2026/1/18.
 */
abstract class BaseActivity : AppCompatActivity(), DataListener2301 {
    private var subscription: Disposable? = null
    private var progressDialog: ProgressDialog? = null
   // abstract fun layoutId(): Int
    abstract fun init()
  /*  override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        this.setContentView(this.layoutId());
        this.init();
        subscribe()
    }*/


   override fun onResume() {
        super.onResume()
        this.init();
       subscribe()
    }


    protected fun subscribe() {
        subscription = RxBus.Companion.instance.toObservable<BleData?>(BleData::class.java as Class<BleData?>)!!
            .subscribeOn(Schedulers.io()).observeOn(AndroidSchedulers.mainThread())
            .subscribe(object : Consumer<BleData?> {
                @Throws(Exception::class)
                override fun accept(bleData: BleData?) {
                    val action = bleData?.action
                    if (action == BleService.ACTION_DATA_AVAILABLE) {
                        if(null!=bleData.value){
                            val value = bleData.value
                                BleSDK.DataParsingWithData(value, this@BaseActivity)
                        }

                    }
                }
            })
    }

   // protected fun on3bBind(value: ByteArray?) {}
    protected fun unSubscribe(disposable: Disposable?) {
        if (disposable != null && !disposable.isDisposed()) {
            disposable.dispose()
        }
    }

    override fun onDestroy() {
        super.onDestroy()
        unSubscribe(subscription)
    }

    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
    }

    override fun dataCallback(value: ByteArray?) {
    }


    /**
     * 当蓝牙设备是连接的状态，发送指令给设备
     * When the Bluetooth device is connected, send instructions to the device
     * @param value
     */
    protected fun sendValue(value: ByteArray?) {
        if (!BleManager.Companion.instance!!.isConnected) {
            showToast(getString(R.string.pair_device))
            return
        }
        if (value == null) return
        BleManager.Companion.instance!!.writeValue(value)
    }

    protected fun showToast(text: String?) {
        Toast.makeText(this, text, Toast.LENGTH_SHORT).show()
    }

    var alertDialog: AlertDialog? = null
    protected fun showDialogInfo(message: String?) {
        if (null == alertDialog) {
            alertDialog = AlertDialog.Builder(this)
                .setMessage(message).setPositiveButton("Ok", null).create()
            alertDialog!!.show()
        } else {
            alertDialog!!.dismiss()
            alertDialog = null
            alertDialog = AlertDialog.Builder(this)
                .setMessage(message).setPositiveButton("Ok", null).create()
            alertDialog!!.show()
        }
    }

    protected fun showSetSuccessfulDialogInfo(message: String?) {
        AlertDialog.Builder(this)
            .setMessage(message + " Successful").setPositiveButton("Ok", null).create().show()
    }

    protected fun getDataType(maps: MutableMap<String?, Any?>?): String? {
        if (null == maps) {
            return ""
        }
        return maps.get(DeviceKey.DataType) as String?
    }

    protected fun getEnd(maps: MutableMap<String?, Any?>?): Boolean {
        return maps?.get(DeviceKey.End) as Boolean
    }

    protected fun getData(maps: MutableMap<String?, Any?>?): MutableMap<String?, Any?>? {
        return maps?.get(DeviceKey.Data) as MutableMap<*, *>? as MutableMap<String?, Any?>?
    }


    protected fun offerData(value: ByteArray?) {
        BleManager.Companion.instance!!.offerValue(value)
    }

    protected fun offerData() {
        BleManager.Companion.instance!!.writeValue()
    }

    protected fun showProgressDialog(message: String?) {
        if (progressDialog == null) {
            progressDialog = ProgressDialog(this)
            progressDialog!!.setMessage(message)
        }
        if (!progressDialog!!.isShowing()) progressDialog!!.show()
    }

    protected fun disMissProgressDialog() {
        if (progressDialog != null && progressDialog!!.isShowing()) progressDialog!!.dismiss()
    }



}
