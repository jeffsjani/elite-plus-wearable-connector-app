package com.jstyle.testv8.ui

import android.content.DialogInterface
import android.content.DialogInterface.OnMultiChoiceClickListener
import android.os.Bundle
import android.text.TextUtils
import android.util.Log
import androidx.appcompat.app.AlertDialog
import com.jstyle.testv8.R
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityMotionReminderPeriodBinding
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.MySedentaryReminder

import kotlin.math.pow

/**
 * 设置/获取运动提醒时段（Set / get motion reminder period）
 */
lateinit var activitymotonBinding: ActivityMotionReminderPeriodBinding

class ActivityAlarmSetActivity : BaseActivity() {
    var weekArray: Array<String?>? = null
    var weekPosition: IntArray? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        weekArray = getResources().getStringArray(R.array.weekarray)
        activitymotonBinding=ActivityMotionReminderPeriodBinding.inflate(layoutInflater)
        setContentView(activitymotonBinding.getRoot());
    }
    override fun init() {
        weekPosition=IntArray(7)
        activitymotonBinding.timePickerStart.setIs24HourView(true);
        activitymotonBinding.timePickerStop.setIs24HourView(true);
        sendValue(BleSDK.GetSedentaryReminder());

        activitymotonBinding.buttonWeekchoose.setOnClickListener {  showWeekDialog() }
        activitymotonBinding.buttonSetActivitytime.setOnClickListener {  setActivityTimeAlarm()}
        activitymotonBinding.buttonGetActivitytime.setOnClickListener { sendValue(BleSDK.GetSedentaryReminder()) }
    }




    var weekDialog: AlertDialog? = null
    private fun showWeekDialog() {
        val checked = BooleanArray(7)
        for (i in 0..6) {
            checked[i] = weekPosition?.get(i) == 1
        }
        weekDialog = AlertDialog.Builder(this)
            .setMultiChoiceItems(weekArray, checked, object : OnMultiChoiceClickListener {
                override fun onClick(dialog: DialogInterface?, which: Int, isChecked: Boolean) {
                    weekPosition?.set(which, if (isChecked) 1 else 0)
                }
            })
            .setPositiveButton("Ok", object : DialogInterface.OnClickListener {
                override fun onClick(dialog: DialogInterface?, which: Int) {
                }
            }).setNegativeButton("Cancel", null).create()

        weekDialog!!.show()
    }

    private fun setActivityTimeAlarm() {
        if (TextUtils.isEmpty(activitymotonBinding.editMinute.getText().toString())
            || TextUtils.isEmpty(activitymotonBinding.editStep.getText().toString())
        ) return
        val hourStart: Int = activitymotonBinding.timePickerStart.getCurrentHour()
        val minStart: Int = activitymotonBinding.timePickerStart.getCurrentMinute()
        val hourEnd: Int = activitymotonBinding.timePickerStop.getCurrentHour()
        val minEnd: Int = activitymotonBinding.timePickerStop.getCurrentMinute()
        val minInterval = activitymotonBinding.editMinute.getText().toString().toInt()
        val minStep = activitymotonBinding.editStep.getText().toString().toInt()
        var week = 0
        for (i in 0..6) {
            if (weekPosition?.get(i) == 1) week = (week + 2.0.pow(i.toDouble())).toInt()
        }
        val sportPeriod = MySedentaryReminder()
        sportPeriod.setStartHour(hourStart) //提醒开始小时 Reminder start hour
        sportPeriod.setStartMinute(minStart) //提醒开始分钟Reminder start minutes
        sportPeriod.setEndHour(hourEnd) //提醒结束小时 Reminder hours end
        sportPeriod.setEndMinute(minEnd) //提醒结束分钟 Reminder end minutes
        sportPeriod.setIntervalTime(minInterval) //持续时间（分钟） Duration (minutes)
        sportPeriod.setLeastStep(minStep) //最少运动步数 Minimum movement steps
        sportPeriod.setWeek(week) //星期选中详情 Week selection details
        sportPeriod.isEnable = activitymotonBinding.radioGroupGender.getCheckedRadioButtonId() === R.id.open // open or close
        sendValue(BleSDK.SetSedentaryReminder(sportPeriod)) //发送给设备 Send to device
    }

    override fun dataCallback(data: MutableMap<String?, Any?>?) {
        super.dataCallback(data)
        val dataType = getDataType(data)
        val maps: Map<String?, Any?>? = getData(data)
        when (dataType) {
            BleConst.SetSedentaryReminder -> showSetSuccessfulDialogInfo(dataType)
            BleConst.GetSedentaryReminder -> {
                val startHour = maps!![DeviceKey.StartTimeHour]
                val startMin = maps[DeviceKey.StartTimeMin]
                val endHour = maps[DeviceKey.EndTimeHour]
                val endMin = maps[DeviceKey.EndTimeMin]
                val KSportswitch = maps[DeviceKey.KSportswitch]
                val timeInterval = maps[DeviceKey.IntervalTime]
                val week: String = maps[DeviceKey.Week]!! as String
                val step = maps[DeviceKey.LeastSteps]
                val weekStrings: List<String> = week.split("-")

               // Log.e("dsfsdfsdfsfs", "$weekStrings***$maps")
                for (i in 0..6) {
                    weekPosition?.set(i, weekStrings[i].trim().toInt())
                }

                activitymotonBinding.timePickerStart.setCurrentHour(startHour.toString().toInt())
                activitymotonBinding.timePickerStart.setCurrentMinute(startMin.toString().toInt())
                activitymotonBinding.timePickerStop.setCurrentHour(endHour.toString() .toInt())
                activitymotonBinding.timePickerStop.setCurrentMinute(endMin.toString() .toInt())
                activitymotonBinding.radioGroupGender.check(if (1 == KSportswitch) R.id.open else R.id.close)
                activitymotonBinding.editMinute.setText(timeInterval.toString())
                activitymotonBinding.editStep.setText(step.toString())
            }
        }
    }


    companion object {
        private const val TAG = "ActivityAlarmSetActivit"
    }
}
