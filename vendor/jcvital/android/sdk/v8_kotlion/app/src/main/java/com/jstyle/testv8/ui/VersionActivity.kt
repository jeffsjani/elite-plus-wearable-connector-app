package com.jstyle.testv8.ui

import android.os.Bundle
import android.util.Log
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst

import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityVersionBinding


/**
 * 读取设备版本号 （Read device version number）
 */
lateinit var versionBinding: ActivityVersionBinding

class VersionActivity : BaseActivity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        versionBinding = ActivityVersionBinding.inflate(layoutInflater);
        setContentView(versionBinding.getRoot());
    }

    override fun init() {
        versionBinding.set.setOnClickListener {
            //读取设备版本号 （Read device version number）
            sendValue(BleSDK.GetDeviceVersion());
        }
    }

     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        Log.e("dataCallback", maps.toString())
        when (dataType) {
            BleConst.GetDeviceVersion -> if (null != versionBinding.info) {
                versionBinding.info!!.text = maps.toString()
            }
        }
    }


}
