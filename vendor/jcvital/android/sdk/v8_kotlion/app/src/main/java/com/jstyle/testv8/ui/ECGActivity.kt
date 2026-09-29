package com.jstyle.testv8.ui

import android.os.Bundle
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.model.AutoTestMode
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.ble.BleManager
import com.jstyle.testv8.databinding.ActivityEcgtestBinding
lateinit var activityEcgtest: ActivityEcgtestBinding

class ECGActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityEcgtest=ActivityEcgtestBinding.inflate(layoutInflater)
        setContentView(activityEcgtest.getRoot());
    }
    override fun init() {
        activityEcgtest.start.setOnClickListener {
            offerData(BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, (50 * 1000).toLong(), true))
            offerData(BleSDK.setECGRealtimeDuringHRVEnabled(true))
            BleManager.instance?.writeValue()

        }
        activityEcgtest.end.setOnClickListener {
            offerData(BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, (50 * 1000).toLong(), false))
            offerData(BleSDK.setECGRealtimeDuringHRVEnabled(false))
            BleManager.instance?.writeValue()
        }
    }


    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        when (dataType) {
            BleConst.GetECG -> {
                val maps: Map<String?, Any?>? = getData(maps)
                if (null != activityEcgtest.info) {
                    activityEcgtest.info.text = maps.toString()
                }
            }
        }
    }


}
