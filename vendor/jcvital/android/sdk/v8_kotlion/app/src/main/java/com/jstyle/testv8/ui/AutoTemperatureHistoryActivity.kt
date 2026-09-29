package com.jstyle.testv8.ui

import android.os.Bundle
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.adapter.TempAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityAutoTempDataBinding



/**
 * 设备自动测试出的温度数据 （Temperature data automatically tested by the device）
 */
lateinit var activityAutoTemperatureHistoryBinding: ActivityAutoTempDataBinding

class AutoTemperatureHistoryActivity : BaseActivity() {
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data
    private var list: MutableList<String?>? = null
    private var activityModeDataAdapter: TempAdapter? = null
    private var dataCount = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityAutoTemperatureHistoryBinding=ActivityAutoTempDataBinding.inflate(layoutInflater)
        setContentView(activityAutoTemperatureHistoryBinding.getRoot());
    }
    override fun init() {
        list = ArrayList<String?>()
        val linearLayoutManager: LinearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityAutoTemperatureHistoryBinding. RecyclerViewExerciseHistory.setLayoutManager(linearLayoutManager)
        activityModeDataAdapter = TempAdapter()
        activityAutoTemperatureHistoryBinding.RecyclerViewExerciseHistory.setAdapter(activityModeDataAdapter)
        val dividerItemDecoration: DividerItemDecoration =
            DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityAutoTemperatureHistoryBinding.RecyclerViewExerciseHistory.addItemDecoration(dividerItemDecoration)

        activityAutoTemperatureHistoryBinding.read.setOnClickListener {
            list!!.clear()
            dataCount = 0
            getDatafortemp(ModeStart)
        }
        activityAutoTemperatureHistoryBinding.delete.setOnClickListener {
            list!!.clear()
            dataCount = 0
            getDatafortemp(ModeDelete)
        }
    }




    private fun getDatafortemp(mode: Byte) {
        /**
         * dateOfLastData 设备返回所有数据后最后的时间戳，第一次没有的情况为null，或者“”，同步数据后保存数据库
         * dateOfLastData The last timestamp after the device returns all data, null if there is no data for the first time, or "", save the database after synchronizing the data
         */
        sendValue(BleSDK.GetTemperature_historyData(mode, ""))
    }


     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.Temperature_history -> {
                list!!.add(maps.toString())
                activityModeDataAdapter!!.setData(list)
            }

            BleConst.GetAxillaryTemperatureDataWithMode -> {
                list!!.add(maps.toString())
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
                        getDatafortemp(ModeContinue)
                    }
                }
            }
        }
    }


}
