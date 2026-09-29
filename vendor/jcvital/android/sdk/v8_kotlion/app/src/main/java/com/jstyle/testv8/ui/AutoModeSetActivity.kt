package com.jstyle.testv8.ui

import android.os.Bundle
import android.text.TextUtils
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.AutoMode
import com.jstyle.blesdkv8.model.MyAutomaticHRMonitoring
import com.jstyle.testv8.R
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityHeartRateSetBinding
import kotlin.math.pow


/**
 * 心率，血氧，心率变异性，体温自动监测设置
 * （Heart rate, blood oxygen, heart rate variability, body temperature automatic monitoring settings）
 */
lateinit var activityAutoModeSetBinding: ActivityHeartRateSetBinding

class AutoModeSetActivity : BaseActivity() {
    var weekPosition: IntArray?=null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityAutoModeSetBinding=ActivityHeartRateSetBinding.inflate(layoutInflater)
        setContentView(activityAutoModeSetBinding.getRoot());
    }
    override fun init() {
        weekPosition=IntArray(7)
        activityAutoModeSetBinding.timePickerStart.setIs24HourView(true);
        activityAutoModeSetBinding.timePickerStop.setIs24HourView(true);

        sendValue(BleSDK.GetAutomatic(AutoMode.AutoHeartRate));

        activityAutoModeSetBinding.buttonSetActivitytime.setOnClickListener {
            setAutoMode()
        }
        activityAutoModeSetBinding.buttonGetActivitytime.setOnClickListener {
            when (activityAutoModeSetBinding.radioGroupAll.checkedRadioButtonId){
               R.id.radio_1->{
                    //获取自动监测心率设置 Get automatic heart rate monitoring settings
                    sendValue(BleSDK.GetAutomatic(AutoMode.AutoHeartRate))
                }
                R.id.radio_2->{
                    //获取自动监测血氧设置 Get settings for automatic monitoring of blood oxygen
                    sendValue(BleSDK.GetAutomatic(AutoMode.AutoSpo2))
                }
                R.id.radio_3->{
                    //获取自动监测温度设置 Get automatic monitoring temperature settings
                    sendValue(BleSDK.GetAutomatic(AutoMode.AutoTemp))
                }
                R.id.radio_4->{
                    //获取自动监测心率变异性设置 Get settings for automatic monitoring of heart rate variability
                    sendValue(BleSDK.GetAutomatic(AutoMode.AutoHrv))
                }
            }
        }




    }



    private fun setAutoMode() {
        // TODO Auto-generated method stub
        if (TextUtils.isEmpty(activityAutoModeSetBinding.editMinute.getText().toString())) return


        var autoMode = AutoMode.AutoHeartRate
        when (activityAutoModeSetBinding.radioGroupAll.checkedRadioButtonId) {
            R.id.radio_1 -> autoMode = AutoMode.AutoHeartRate
            R.id.radio_2 -> autoMode = AutoMode.AutoSpo2
            R.id.radio_3 -> autoMode = AutoMode.AutoTemp
            R.id.radio_4 -> autoMode = AutoMode.AutoHrv
        }
        if (TextUtils.isEmpty(activityAutoModeSetBinding.editMinute.getText().toString())) return;
        val hourStart = activityAutoModeSetBinding.timePickerStart.getCurrentHour();
        val minStart = activityAutoModeSetBinding.timePickerStart.getCurrentMinute();
        val hourEnd = activityAutoModeSetBinding.timePickerStop.getCurrentHour();
        val minEnd = activityAutoModeSetBinding.timePickerStop.getCurrentMinute();
        val minInterval = activityAutoModeSetBinding.editMinute.getText().toString().toInt()

        var week = 0
        for(i in 0..6) {
            if (weekPosition?.get(i) == 1)
                week += 2.0.pow(i.toDouble()).toInt()
        }
        val automicHeart =  MyAutomaticHRMonitoring();
        automicHeart.setStartHour(hourStart);
        automicHeart.setStartMinute(minStart);
        automicHeart.setEndHour(hourEnd);
        automicHeart.setEndMinute(minEnd);
        automicHeart.setTime(minInterval);
        automicHeart.setWeek(week);
        automicHeart.setOpen(getWorkModel());
        sendValue(BleSDK.SetAutomaticHRMonitoring(automicHeart,autoMode));
    }
    fun  getWorkModel(): Int {
        var id=0;
        when (activityAutoModeSetBinding.radioGroupAutoHeart.checkedRadioButtonId){
            R.id.radio_autoheart_disable->{
                id=0;
            }
            R.id.radio_autoheart_enable->{
                id=1;
            }
            R.id.radio_autoheart_interval->{
                id=2;
            }
        }
        return id
    }
    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val data: Map<String?, Any?>? = getData(maps)
        when (dataType) {
            BleConst.SetAutomatic -> showSetSuccessfulDialogInfo(dataType)
            BleConst.GetAutomatic -> {
                val timeInterval = data!![DeviceKey.IntervalTime].toString()


                val startHour = data[DeviceKey.StartTime].toString().toInt()
                val startMin = data[DeviceKey.KHeartStartMinter].toString().toInt()
                val endHour =data[DeviceKey.EndTime].toString().toInt()
                val endMin =data[DeviceKey.KHeartEndMinter].toString().toInt()

                val week = data[DeviceKey.Weeks].toString()
                val model = data[DeviceKey.WorkMode].toString()
                initGroup(Integer.parseInt(model));
                val weekStrings = week.split("-");
                for(i in 0..6){
                    weekPosition?.set(i, Integer.valueOf(weekStrings[i]));
                }
                activityAutoModeSetBinding.timePickerStart.setCurrentHour(startHour);
                activityAutoModeSetBinding.timePickerStart.setCurrentMinute(startMin);
                activityAutoModeSetBinding.timePickerStop.setCurrentHour(endHour);
                activityAutoModeSetBinding.timePickerStop.setCurrentMinute(endMin);
                activityAutoModeSetBinding.editMinute.setText(timeInterval);
                activityAutoModeSetBinding.editMinute.setText(timeInterval.toString())
            }
        }
    }


        fun initGroup( type: Int) {
           var id=R.id.radio_autoheart_disable
            when (type){
                0->{
                    id=  R.id.radio_autoheart_disable
                }
                1->{
                    id=  R.id.radio_autoheart_enable
                }
                2->{
                    id=  R.id.radio_autoheart_interval
                }
        }
            activityAutoModeSetBinding.radioGroupAutoHeart.check(id);
    }

}
