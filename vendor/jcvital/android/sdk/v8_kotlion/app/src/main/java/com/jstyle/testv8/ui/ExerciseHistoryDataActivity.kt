package com.jstyle.testv8.ui

import android.os.Bundle
import androidx.annotation.Nullable
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.R
import com.jstyle.testv8.adapter.ActivityModeDataAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityExercisehistoryBinding



/**
 * 获得运动数据（这里指运动模式里的数据，如跑步，自行车。。。）
 * Obtain exercise data (referring to data within exercise modes, such as running, cycling, etc.)
 */

lateinit var activityExerciseHistoryBinding: ActivityExercisehistoryBinding

class ExerciseHistoryDataActivity : BaseActivity() {
    var modeNames: Array<String?>? = null
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data
    private var list: MutableList<MutableMap<String?, String?>?>? = null
    private var activityModeDataAdapter: ActivityModeDataAdapter? = null
    private var dataCount = 0
    override fun onCreate(@Nullable savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityExerciseHistoryBinding=ActivityExercisehistoryBinding.inflate(layoutInflater)
        setContentView(activityExerciseHistoryBinding.getRoot());
    }
    override fun init() {
        modeNames = getResources().getStringArray(R.array.mode_name)
        list = ArrayList<MutableMap<String?, String?>?>()
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityExerciseHistoryBinding.RecyclerViewExerciseHistory.setLayoutManager(linearLayoutManager)
        activityModeDataAdapter = ActivityModeDataAdapter(modeNames)
        activityExerciseHistoryBinding.RecyclerViewExerciseHistory.setAdapter(activityModeDataAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityExerciseHistoryBinding.RecyclerViewExerciseHistory.addItemDecoration(dividerItemDecoration)
        activityExerciseHistoryBinding.btGetData.setOnClickListener {
            list!!.clear()
            dataCount = 0
            getData(ModeStart)
        }
        activityExerciseHistoryBinding.btDeleteData.setOnClickListener {
            getData(ModeDelete)
        }
    }



    private fun getData(mode: Byte) {
        sendValue(BleSDK.GetActivityModeDataWithMode(mode))
    }

    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.Delete_ActivityModeData -> showDialogInfo(maps.toString())
            BleConst.GetActivityModeData -> {
                list!!.addAll((maps?.get(DeviceKey.Data) as kotlin.collections.MutableList<kotlin.collections.MutableMap<kotlin.String?, kotlin.String?>?>?)!!)
                dataCount++
                if (finish) {
                    dataCount = 0
                    disMissProgressDialog()
                    activityModeDataAdapter!!.setData(list)
                }
                if (dataCount == 50) {
                    dataCount = 0
                    if (finish) {
                        disMissProgressDialog()
                        activityModeDataAdapter!!.setData(list)
                    } else {
                        getData(ModeContinue)
                    }
                }
            }
        }
    }


}
