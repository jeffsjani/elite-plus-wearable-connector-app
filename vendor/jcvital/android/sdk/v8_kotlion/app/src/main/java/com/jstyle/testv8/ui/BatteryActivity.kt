package com.jstyle.testv8.ui

import android.os.Bundle
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityBatteryBinding



/**
 * 设备电池电量获取 Equipment power acquisition
 */
lateinit var activityBatteryBinding: ActivityBatteryBinding
class BatteryActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityBatteryBinding = ActivityBatteryBinding.inflate(layoutInflater);
        setContentView(activityBatteryBinding.getRoot());
    }
    override fun init() {
        activityBatteryBinding.set.setOnClickListener {
            //设备电量获取 Equipment power acquisition
            sendValue(BleSDK.GetDeviceBatteryLevel());
        }
    }
     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        when (dataType) {
            BleConst.GetDeviceBatteryLevel -> if (null != activityBatteryBinding.info) {
                activityBatteryBinding.info.setText(maps.toString())
            }
        }
    }


}
