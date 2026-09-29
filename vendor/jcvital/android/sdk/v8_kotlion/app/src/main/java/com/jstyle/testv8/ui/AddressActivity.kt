package com.jstyle.testv8.ui

import android.os.Bundle
import android.util.Log
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityMacAddressBinding
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst


/**
 * 读取设备MAC Read device mac
 */
lateinit var activityMACBinding: ActivityMacAddressBinding
class MacAddressActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityMACBinding = ActivityMacAddressBinding.inflate(layoutInflater);
        setContentView(activityMACBinding.getRoot());
    }

    override fun init() {
        activityMACBinding.set.setOnClickListener {
            //读取设备MAC Read device mac
            sendValue(BleSDK.GetDeviceMacAddress());
        }
    }

     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        Log.e("dataCallback", maps.toString())
        when (dataType) {
            BleConst.GetDeviceMacAddress -> if (null != activityMACBinding.info) {
                activityMACBinding.info.setText(maps.toString())
            }
        }
    }


}
