package com.jstyle.testv8.ui

import android.content.Intent
import android.os.Bundle
import android.util.Log
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.Clock
import com.jstyle.testv8.R
import com.jstyle.testv8.adapter.ClockAdapter
import com.jstyle.testv8.adapter.ClockAdapter.onClockItemClickListener
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityAlarmSetBinding


import java.io.Serializable
import kotlin.math.pow

/**
 * 闹钟列表 （Alarm list）
 */
lateinit var activityAlarmListBinding: ActivityAlarmSetBinding

class AlarmListActivity : BaseActivity(), onClockItemClickListener {
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data

    var weekArray: Array<String?>? = null
    private var clockAdapter: ClockAdapter? = null
    var list: MutableList<MutableMap<String?, String?>?> =
        ArrayList<MutableMap<String?, String?>?>()
    private val REQUEST_Clock = 2

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityAlarmListBinding=ActivityAlarmSetBinding.inflate(layoutInflater)
        setContentView(activityAlarmListBinding.getRoot());

    }



    override fun init() {
        weekArray = getResources().getStringArray(R.array.weekarray)
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityAlarmListBinding.RecyclerViewAlarm .setLayoutManager(linearLayoutManager)
        clockAdapter = ClockAdapter(this)
        activityAlarmListBinding.RecyclerViewAlarm.setAdapter(clockAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityAlarmListBinding.RecyclerViewAlarm.addItemDecoration(dividerItemDecoration)
        sendValue(BleSDK.GetAlarmClock())

        activityAlarmListBinding.btAdd.setOnClickListener {
            val list = clockAdapter!!.getClockList()
            if (list.size == 10) {
                showToast("No more alarm clock")
                return@setOnClickListener
            }
            val intent = Intent(this, AlarmSetActivity::class.java)
            intent.putExtra(KEY_CLOCK_LIST, clockAdapter!!.clockList as Serializable?)
            startActivityForResult(intent, REQUEST_Clock)
        }
        activityAlarmListBinding.btEdit.setOnClickListener {
            clockAdapter?.enableDelete();
        }
    }


    /**
     * 编辑闹钟
     * Edit alarm clock
     * @param clock
     */
    override fun onItemClick(clock: Clock) {
        val intent: Intent = Intent(this, AlarmSetActivity::class.java)
        intent.putExtra("clockid", clock.getNumber())
        intent.putExtra(KEY_CLOCK_LIST, clockAdapter!!.clockList as Serializable?)
        startActivityForResult(intent, REQUEST_Clock)
    }

    /**
     * 删除闹钟
     * @param clock
     * Delete alarm clock
     */
    override fun onDelete(clock: Clock?) {
        updateClock(clockAdapter!!.getClockList())
    }


    /**
     * 更新闹钟
     * @param clockList
     * Update alarm clock
     */
    override fun onUpdate(clockList: MutableList<Clock>) {
        updateClock(clockList)
    }

     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        Log.e("ddddd", maps.toString())
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.Delete_AlarmClock -> showDialogInfo(maps.toString())
            BleConst.GetAlarmClock -> {
                val mapValue = (maps?.get(DeviceKey.Data) as MutableList<MutableMap<String?, String?>>?)
                for (map in mapValue!!) {
                    val hour = String.format("%02d", map.get(DeviceKey.ClockTime)!!.toInt())
                    val min = String.format("%02d", map.get(DeviceKey.KAlarmMinter)!!.toInt())
                    val content = map[DeviceKey.KAlarmContent]
                    val clockType = map[DeviceKey.ClockType]!!.toInt()
                    val id = map[DeviceKey.KAlarmId]!!.toInt()
                    val enable = map[DeviceKey.OpenOrClose]!!.toInt()
                    val week = map[DeviceKey.Week]
                    val clock = Clock()
                    clock.setContent(content)
                    clock.setNumber(id)
                    clock.isEnable = enable == 1
                    clock.setHour(hour.toInt())
                    clock.setMinute(min.toInt())
                    clock.setType(clockType)
                    var weekByte: Byte = 0
                    val weekString =
                        week!!.split("-".toRegex()).dropLastWhile { it.isEmpty() }.toTypedArray()
                    var i = 0
                    while (i < 7) {
                        val weekEnable = weekString[i]
                        if (weekEnable == "1") {
                            weekByte = (weekByte + 2.0.pow(i.toDouble())).toInt().toByte()
                        }
                        i++
                    }
                    clock.setWeek(weekByte)
                    clockAdapter!!.setData(weekArray, clock)
                }
            }
        }
    }

    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == REQUEST_Clock && resultCode == RESULT_OK) {
            clockAdapter!!.clear()
            sendValue(BleSDK.GetAlarmClock())
        }
    }

    private fun updateClock(clockList: MutableList<Clock>) {
        for (i in clockList.indices) {
            val clock = clockList[i]
            clock.setNumber(i)
        }
        val value = if (clockList.isEmpty()) BleSDK.deleteAllClock() else BleSDK.setClockData(clockList)
        val maxLength = 200
        if (value.size > maxLength) {
            val size = maxLength / 38 //一个包最多发的闹钟个数
            val length = size * 38 //最大闹钟数占用的字节
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
    }




    companion object {
        const val KEY_CLOCK_LIST: String = "CLOCK_LIST"
    }
}
