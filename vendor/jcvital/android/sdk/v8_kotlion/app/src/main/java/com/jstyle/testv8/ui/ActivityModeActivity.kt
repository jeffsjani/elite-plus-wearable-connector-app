package com.jstyle.testv8.ui

import android.os.Bundle
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.GridLayoutManager
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.ExerciseMode
import com.jstyle.testv8.R
import com.jstyle.testv8.adapter.ActivityModeAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityModeBinding



/**
 * 运动模式控制开关 (Sport mode control switch)
 */
lateinit var activityActivityModeBinding: ActivityModeBinding

class ActivityModeActivity : BaseActivity() {
    var modeName: Array<String?>? = null
    private var activityModeAdapter: ActivityModeAdapter? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityActivityModeBinding=ActivityModeBinding.inflate(layoutInflater)
        setContentView(activityActivityModeBinding.getRoot());
    }
    override fun init() {
        modeName = getResources().getStringArray(R.array.mode_name)
        val linearLayoutManager = GridLayoutManager(this, 3)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityActivityModeBinding.RecyclerViewMode.setLayoutManager(linearLayoutManager)
        activityModeAdapter = ActivityModeAdapter(modeName)
        activityActivityModeBinding.RecyclerViewMode.setAdapter(activityModeAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.HORIZONTAL)
        val dividerItemDecorationVERTICAL =
            DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityActivityModeBinding.RecyclerViewMode.addItemDecoration(dividerItemDecoration)
        activityActivityModeBinding.RecyclerViewMode.addItemDecoration(dividerItemDecorationVERTICAL)

        activityActivityModeBinding.btStartMode.setOnClickListener {

            /**
             *  你需要每秒发送心跳包给设备 sendHeartPackage(float distance, int space, int rssi)
             *  distance 两个经纬度的距离 km
             *  space  配速
             *  rssi 信号
             */
            /**
             *  You need to send heartbeat packets to the device every second: sendHeartPackage(float distance, int pace, int rssi)
             *  distance: Distance between two latitudes/longitudes in km
             *  pace: Pacing speed
             *  rssi: Signal strength  0-6
             */
            mode = activityModeAdapter!!.getSelectPosition()
            if (mode == -1) return@setOnClickListener
            sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_START))
        }
        activityActivityModeBinding.suspend.setOnClickListener {
            mode = activityModeAdapter!!.getSelectPosition()
            if (mode == -1) return@setOnClickListener
            sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_PAUSE))
        }
        activityActivityModeBinding.continues.setOnClickListener {
            mode = activityModeAdapter!!.getSelectPosition()
            if (mode == -1) return@setOnClickListener
            sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_CONTUINE))
        }
        activityActivityModeBinding.btStopMode.setOnClickListener {
            mode = activityModeAdapter!!.getSelectPosition()
            if (mode == -1) return@setOnClickListener
            sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_FINISH))
        }

    }


    var mode: Int = 0




    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        when (dataType) {
            BleConst.EnterActivityMode -> {
                val mapEnterActivityMode: MutableMap<String?, String?>? = getData(maps) as MutableMap<String?, String?>?
                val status =
                    mapEnterActivityMode!!.get(DeviceKey.enterActivityModeSuccess)!!.toInt()
                if (0 == status) {
                    showToast("Please quit the exercise")
                }
            }

            BleConst.SportData -> {
                val map: MutableMap<String?, String?>? = getData(maps) as MutableMap<String?, String?>?
                val step = map!!.get(DeviceKey.Step)
                val cal = map.get(DeviceKey.Calories)
                val heart = map.get(DeviceKey.HeartRate)
                val stringBuffer = StringBuffer()
                stringBuffer.append("Step: " + step).append("\n")
                    .append("Cal: " + cal).append("\n")
                    .append("HeartRate: " + heart)
                activityActivityModeBinding.tvActivityModeData.setText(stringBuffer.toString())
            }
        }
    }


}
