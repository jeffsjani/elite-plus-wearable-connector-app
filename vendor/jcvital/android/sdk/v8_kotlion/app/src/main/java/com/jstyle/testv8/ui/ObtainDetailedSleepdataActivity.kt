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
import com.jstyle.testv8.databinding.ActivityInfoSleepDataReadBinding

lateinit var activityInfoSleepDataReadBinding: ActivityInfoSleepDataReadBinding

class ObtainDetailedSleepdataActivity : BaseActivity() {
    private var hrvDataAdapter: HrvDataAdapter? = null
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityInfoSleepDataReadBinding=ActivityInfoSleepDataReadBinding.inflate(layoutInflater)
        setContentView(activityInfoSleepDataReadBinding.getRoot());
    }
    override fun init() {
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityInfoSleepDataReadBinding.RecyclerViewHrvData  .setLayoutManager(linearLayoutManager)
        hrvDataAdapter = HrvDataAdapter()
        activityInfoSleepDataReadBinding.RecyclerViewHrvData .setAdapter(hrvDataAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityInfoSleepDataReadBinding.RecyclerViewHrvData .addItemDecoration(dividerItemDecoration)
        activityInfoSleepDataReadBinding.btReadData.setOnClickListener {
            list.clear()
            dataCount = 0
            getObtainDetailedSleepData(ModeStart)
        }
        activityInfoSleepDataReadBinding.btDeleteData.setOnClickListener {
            getObtainDetailedSleepData(ModeDelete)
        }

    }


    var dataCount: Int = 0
    var list: MutableList<MutableMap<String?, String?>?> = ArrayList<MutableMap<String?, String?>?>()

    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        Log.e("info", maps.toString())
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.DeleteSleep -> showDialogInfo(maps.toString())
            BleConst.Obtain_detailed_sleep_data -> {
                dataCount++
                list.addAll((maps?.get(DeviceKey.Data) as kotlin.collections.MutableList<kotlin.collections.MutableMap<kotlin.String?, kotlin.String?>?>?)!!)
                if (finish) {
                    hrvDataAdapter!!.setData(list)
                }
                if (dataCount == 50) {
                    if (finish) {
                        hrvDataAdapter!!.setData(list)
                    } else {
                        getObtainDetailedSleepData(ModeContinue)
                    }
                }
            }
        }
    }



    private fun getObtainDetailedSleepData(mode: Byte) {
        /**
         * dateOfLastData 设备返回所有数据后最后的时间戳，第一次没有的情况为null，或者“”，同步数据后保存数据库
         * dateOfLastData The last timestamp after the device returns all data,
         * null if there is no data for the first time, or "", save the database after synchronizing the data
         */
        sendValue(BleSDK.getObtainDetailedSleepData(mode, ""))
    }




}
