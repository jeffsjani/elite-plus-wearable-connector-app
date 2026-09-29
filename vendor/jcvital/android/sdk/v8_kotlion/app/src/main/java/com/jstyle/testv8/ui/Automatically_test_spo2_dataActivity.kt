package com.jstyle.testv8.ui

import android.os.Bundle
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.adapter.OxyAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityAutoSpo2InfoBinding



/**
 * 自动测试血氧数据 (Automatically test blood oxygen data)
 */
lateinit var activityAutoSpo2Binding: ActivityAutoSpo2InfoBinding

class Automatically_test_blood_oxygen_dataActivity : BaseActivity() {
    private var heartRateDataAdapter: OxyAdapter? = null
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityAutoSpo2Binding=ActivityAutoSpo2InfoBinding.inflate(layoutInflater)
        setContentView(activityAutoSpo2Binding.getRoot())
    }
    override fun init() {
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityAutoSpo2Binding.RecyclerViewHeartData.setLayoutManager(linearLayoutManager)
        heartRateDataAdapter = OxyAdapter()
        activityAutoSpo2Binding.RecyclerViewHeartData.setAdapter(heartRateDataAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityAutoSpo2Binding.RecyclerViewHeartData.addItemDecoration(dividerItemDecoration)

        activityAutoSpo2Binding.GetAutomaticSpo2Monitoring.setOnClickListener {
            heartRateDataAdapter!!.Clear()
            sendValue(BleSDK.Oxygen_data(ModeStart, ""))
        }

        activityAutoSpo2Binding.btDeleteDataGetAutomaticSpo2Monitoring.setOnClickListener {
            heartRateDataAdapter!!.Clear()
            sendValue(BleSDK.Oxygen_data(ModeDelete, ""))
        }
    }





    var dataCount: Int = 0
     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.GetAutomaticSpo2Monitoring -> {
                heartRateDataAdapter!!.ADDData(maps.toString())
                dataCount++
                if (finish) {
                    dataCount = 0
                }
                if (dataCount == 50) {
                    dataCount = 0
                    if (finish) {
                        disMissProgressDialog()
                    } else {
                        sendValue(
                            BleSDK.Oxygen_data(
                                ModeContinue,
                                ""
                            )
                        )
                    }
                }
            }

            BleConst.Delete_Obtain_The_data_of_manual_blood_oxygen_test -> heartRateDataAdapter!!.ADDData(
                maps.toString()
            )
        }
    }


}
