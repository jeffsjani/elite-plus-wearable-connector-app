package com.jstyle.testv8.ui

import android.os.Bundle
import android.util.Log
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.adapter.HrvDataAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityPpiDataReadBinding



lateinit var activityPpiData: ActivityPpiDataReadBinding

class PPIDataActivity : BaseActivity() {
    private var hrvDataAdapter: HrvDataAdapter? = null
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityPpiData=ActivityPpiDataReadBinding.inflate(layoutInflater)
        setContentView(activityPpiData.getRoot());
    }
    override fun init() {
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityPpiData. RecyclerViewHrvData.setLayoutManager(linearLayoutManager)
        hrvDataAdapter = HrvDataAdapter()
        activityPpiData. RecyclerViewHrvData.setAdapter(hrvDataAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityPpiData. RecyclerViewHrvData.addItemDecoration(dividerItemDecoration)

        activityPpiData.btReadData.setOnClickListener {
            list.clear()
            dataCount = 0
            getPPIData(ModeStart)
        }
        activityPpiData.btDeleteData.setOnClickListener { getPPIData(ModeDelete) }

    }


    var dataCount: Int = 0
    var list: MutableList<MutableMap<String?, String?>?> = ArrayList<MutableMap<String?, String?>?>()
    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        Log.e("info", maps.toString())
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.DeletePPIData -> showDialogInfo(maps.toString())
            BleConst.GetPPIData -> {
                dataCount++
                list.addAll((maps?.get(DeviceKey.Data) as kotlin.collections.MutableList<kotlin.collections.MutableMap<kotlin.String?, kotlin.String?>?>?)!!)
                if (finish) {
                    hrvDataAdapter!!.setData(list)
                }
                if (dataCount == 50) {
                    dataCount = 0
                    if (finish) {
                        hrvDataAdapter!!.setData(list)
                    } else {
                        getPPIData(ModeContinue)
                    }
                }
            }
        }
    }



    private fun getPPIData(mode: Byte) {
        /**
         * dateOfLastData 设备返回所有数据后最后的时间戳，第一次没有的情况为null，或者“”，同步数据后保存数据库
         * dateOfLastData The last timestamp after the device returns all data,
         * null if there is no data for the first time, or "", save the database after synchronizing the data
         */
        sendValue(BleSDK.GetPPI(mode, ""))
    }


}
