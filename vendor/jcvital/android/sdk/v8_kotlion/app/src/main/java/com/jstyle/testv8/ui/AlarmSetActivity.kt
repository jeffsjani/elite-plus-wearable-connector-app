package com.jstyle.testv8.ui

import android.os.Bundle
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.model.Clock
import com.jstyle.blesdkv8.other.ResolveUtil
import com.jstyle.testv8.R
import com.jstyle.testv8.adapter.ClockWeekAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityClockSetBinding


import kotlin.math.pow

lateinit var activityAlarmSetBinding: ActivityClockSetBinding
class AlarmSetActivity : BaseActivity() {
    var weekArray: Array<String?>? = null
    private var clock: Clock? = null
    private var clockWeekAdapter: ClockWeekAdapter? = null
    private var clockId = 0
    private var clockList: MutableList<Clock>? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityAlarmSetBinding=ActivityClockSetBinding.inflate(layoutInflater)
        setContentView(activityAlarmSetBinding.getRoot())
    }
    override fun init() {
        weekArray = getResources().getStringArray(R.array.weekarray)

        clockId = intent.getIntExtra("clockid", -1)
        clockList = intent.getSerializableExtra(AlarmListActivity.KEY_CLOCK_LIST) as MutableList<Clock>?
        activityAlarmSetBinding.timePickerClockSet .setIs24HourView(true)
        if (clockId != -1) {
            clock = clockList!!.get(clockId)
            val hour = clock!!.getHour()
            val min = clock!!.getMinute()
            val type = clock!!.getType()
            val week = clock!!.getWeek()
            activityAlarmSetBinding.SwitchCompat.setChecked(clock!!.isEnable())
            initGroup(type)
            initWeek(week)
            activityAlarmSetBinding.timePickerClockSet.setCurrentHour(hour)
            activityAlarmSetBinding.timePickerClockSet.setCurrentMinute(min)
        } else {
            initWeek(0)
            clock = Clock()
            if (clockList == null) {
                clockList = ArrayList<Clock>()
                clock!!.setNumber(0)
            } else {
                clock!!.setNumber(clockList!!.size)
            }
            clockList!!.add(clock!!)
        }

        activityAlarmSetBinding.btClockSave.setOnClickListener {
            val hour: Int = activityAlarmSetBinding.timePickerClockSet.getCurrentHour()
            val min: Int = activityAlarmSetBinding.timePickerClockSet.getCurrentMinute()
            val type = this.clockType
            val week = this.checkWeek
            clock!!.setHour(hour)
            clock!!.setMinute(min)
            clock!!.setType(type)
            clock!!.setWeek(week.toByte())
            clock!!.isEnable = activityAlarmSetBinding.SwitchCompat.isChecked
            clock!!.setContent("")
            val value = BleSDK.setClockData(clockList)
            val maxLength: Int = 200
            if (value.size > maxLength) {
                val size = maxLength / 39 //一个包最多发的闹钟个数
                val length = size * 39 //最大闹钟数占用的字节
                val count =
                    if (value.size % length == 0) value.size / length else value.size / length + 1 //需要多少个包来发送
                for (i in 0..<count) {
                    val end = length * (i + 1)
                    var endLength = length
                    if (end >= value.size) endLength = value.size - length * i
                    val data = ByteArray(endLength)
                    System.arraycopy(value, length * i, data, 0, endLength)

                    offerData(data)
                }
                offerData()
            } else {
                sendValue(value)
            }
            setResult(RESULT_OK)
            finish()
        }

    }




    private fun initWeek(week: Int) {
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityAlarmSetBinding. RecyclerViewAlarmSet.setLayoutManager(linearLayoutManager)
        val positions = IntArray(7)
        val weekString = ResolveUtil.getByteString(week.toByte())
        val weekArrs: Array<String?> =
            weekString.split("-".toRegex()).dropLastWhile { it.isEmpty() }.toTypedArray()
        for (i in 0..6) {
            if (weekArrs[i] == "1") {
                positions[i] = 1
            }
        }
        clockWeekAdapter = ClockWeekAdapter(weekArray, positions)
        activityAlarmSetBinding.RecyclerViewAlarmSet.setAdapter(clockWeekAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityAlarmSetBinding.RecyclerViewAlarmSet.addItemDecoration(dividerItemDecoration)
    }

    private fun initGroup(type: Int) {
        var id = R.id.radio_normal
        when (type) {
            1 -> id = R.id.radio_normal
            2 -> id = R.id.radio_Medicine
            3 -> id = R.id.radio_Drink
        }
        activityAlarmSetBinding.radioGroupGender.check(id)
    }

    private val clockType: Int
        get() {
            var id = 0
            when (activityAlarmSetBinding.radioGroupGender.checkedRadioButtonId) {
                R.id.radio_normal -> id = 1
                R.id.radio_Medicine -> id = 2
                R.id.radio_Drink -> id = 3
            }
            return id
        }

    private val checkWeek: Int
        get() {
            var week = 0
            val positions = clockWeekAdapter!!.checkWeek
            for (i in 0..6) {
                if (positions[i] == 1) week = (week + 2.0.pow(i.toDouble())).toInt()
            }
            return week
        }

}
