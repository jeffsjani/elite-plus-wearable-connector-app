package com.jstyle.testv8.ui

import android.os.Bundle
import android.util.Log
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.AutoTestMode
import com.jstyle.testv8.R
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityRealTimeStepBinding


/**
 * 实时计步 (Real time step counting)
 */
lateinit var activityRealTimeStepBinding: ActivityRealTimeStepBinding

class RealTimeStepCountingActivity : BaseActivity() {
    var isStartReal: Boolean = false


    var autoTestMode: AutoTestMode? = null
    var open: Boolean = false
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityRealTimeStepBinding=ActivityRealTimeStepBinding.inflate(layoutInflater);
        setContentView(activityRealTimeStepBinding.getRoot());

    }
    override fun init() {
        activityRealTimeStepBinding.buttonStartreal.setOnClickListener {

            isStartReal = !isStartReal
            if(isStartReal){
                activityRealTimeStepBinding.buttonStartreal.text="Stop"
            }else{
                activityRealTimeStepBinding.buttonStartreal.text= "Start"
            }
            sendValue(BleSDK.RealTimeStep(isStartReal,activityRealTimeStepBinding.SwitchCompatTemp.isChecked));
        }

             autoTestMode=AutoTestMode.AutoHeartRate;

        activityRealTimeStepBinding.radioGroupMian.setOnCheckedChangeListener { group, checkedId ->
            when (checkedId){
                R.id.heart -> {
                    autoTestMode=AutoTestMode.AutoHeartRate
                }
                R.id.oxygen -> {
                    autoTestMode=AutoTestMode.AutoSpo2
                }
            }

        }
        activityRealTimeStepBinding.switchinfo  .setOnCheckedChangeListener {buttonView, isChecked ->   open = isChecked
            open=isChecked;

        }


        activityRealTimeStepBinding. send.setOnClickListener {
            if(null!=activityRealTimeStepBinding.second.getText()){
                val time=activityRealTimeStepBinding.second.getText().toString().toLong()
                sendValue(BleSDK.SetDeviceMeasurementWithType(autoTestMode,time,open));
            }
        };



    }

    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        Log.e("dataCallback", maps.toString())
        when (dataType) {
            BleConst.RealTimeStep -> {
                val mmp: MutableMap<String?, Any?>? = getData(maps)
                val step = mmp!![DeviceKey.Step] //步数  Number of steps
                val cal = mmp[DeviceKey.Calories] // 卡路里 calorie
                val distance = mmp[DeviceKey.Distance] //距离 distance
                val time = mmp[DeviceKey.ExerciseMinutes] //锻炼分钟 Exercise minutes
                val ActiveTime = mmp[DeviceKey.ActiveMinutes] //活动分钟 Activity minutes
                val heart = mmp[DeviceKey.HeartRate] //心率 HeartRate
                val TEMP = mmp[DeviceKey.TempData] //温度 temperature
                activityRealTimeStepBinding.textViewCal.text=cal.toString()
                activityRealTimeStepBinding.textViewStep.text=step.toString()
                activityRealTimeStepBinding.textViewDistance.text=distance.toString()
                activityRealTimeStepBinding.textViewTime.text=time.toString()
                activityRealTimeStepBinding.textViewHeartValue.text=heart.toString()
                activityRealTimeStepBinding.textViewActiveTime.text=ActiveTime.toString()
                activityRealTimeStepBinding.textViewTempValue.text=TEMP.toString()
                activityRealTimeStepBinding.dataInfo.text=maps.toString()

            }
        }
    }


}
