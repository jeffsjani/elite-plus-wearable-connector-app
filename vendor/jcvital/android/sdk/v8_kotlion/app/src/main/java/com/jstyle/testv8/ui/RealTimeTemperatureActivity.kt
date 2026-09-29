package com.jstyle.testv8.ui

import android.os.Bundle
import android.util.Log
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityRealTimeTemperatureBinding
lateinit var activityRealTimeTemperature: ActivityRealTimeTemperatureBinding

class RealTimeTemperatureActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityRealTimeTemperature=ActivityRealTimeTemperatureBinding.inflate(layoutInflater)
        setContentView(activityRealTimeTemperature.getRoot());
    }
    override fun init() {
        activityRealTimeTemperature.set.setOnClickListener {
            sendValue(BleSDK.RealTimeTemperature())
        }
    }


    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        Log.e("dataCallback", maps.toString())
        when (dataType) {
            BleConst.Temperature_3NTC -> if (null != activityRealTimeTemperature.info) {
                activityRealTimeTemperature.info.text = maps.toString()
            }
        }
    }


}
