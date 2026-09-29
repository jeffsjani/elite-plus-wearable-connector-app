package com.jstyle.testv8.ui

import android.os.Bundle
import android.util.Log
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityTimeBinding

import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.model.MyDeviceTime
import java.util.Calendar

/**
 * 设置/获取设备时间
 * Set / get device time
 */
lateinit var activityMainBinding: ActivityTimeBinding

class TimeActivity : BaseActivity() {
    /* override fun layoutId(): Int {
        return R.layout.activity_time
    }*/

     override fun init() {
         activityMainBinding.set.setOnClickListener {
             setTime(); //设置设备时间Set device time
         }
         activityMainBinding.get.setOnClickListener {
             sendValue(BleSDK.GetDeviceTime())//获取设备时间 Get device time
         }
    }

     override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
         activityMainBinding = ActivityTimeBinding.inflate(layoutInflater);
         setContentView(activityMainBinding.getRoot());


    }


    private fun setTime() {
        val calendar = Calendar.getInstance()
        val year = calendar.get(Calendar.YEAR) //年 YEAR
        val month = calendar.get(Calendar.MONTH) + 1 //月 MONTH
        val day = calendar.get(Calendar.DAY_OF_MONTH) //日 DAY_OF_MONTH
        val hour = calendar.get(Calendar.HOUR_OF_DAY) //时 HOUR_OF_DAY
        val min = calendar.get(Calendar.MINUTE) //分 MINUTE
        val second = calendar.get(Calendar.SECOND) //秒 SECOND
        val setTime = MyDeviceTime()
        setTime.setYear(year)
        setTime.setMonth(month)
        setTime.setDay(day)
        setTime.setHour(hour)
        setTime.setMinute(min)
        setTime.setSecond(second)
        sendValue(BleSDK.SetDeviceTime(setTime)) //发送 Send
    }


     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        Log.e("info", maps.toString())
        val dataType = getDataType(maps)
        when (dataType) {
            BleConst.SetDeviceTime -> if (null != activityMainBinding.info) {
                activityMainBinding.info!!.setText(maps.toString())
            }

            BleConst.GetDeviceTime -> if (null != activityMainBinding.info) {
                activityMainBinding.info!!.setText(maps.toString())
            }
        }
    }



}
