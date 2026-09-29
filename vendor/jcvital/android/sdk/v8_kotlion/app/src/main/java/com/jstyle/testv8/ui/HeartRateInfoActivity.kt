package com.jstyle.testv8.ui

import android.os.Bundle

import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.adapter.HeartRateDataAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityHeartRateInfoBinding


/**
 * 获得心率历史数据 (Get historical heart rate data)
 */
lateinit var activityHeartRateBinding: ActivityHeartRateInfoBinding

class HeartRateInfoActivity : BaseActivity() {
    private var heartRateDataAdapter: HeartRateDataAdapter? = null
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityHeartRateBinding=ActivityHeartRateInfoBinding.inflate(layoutInflater)
        setContentView(activityHeartRateBinding.getRoot())
    }
    override fun init() {
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityHeartRateBinding.RecyclerViewHeartData.setLayoutManager(linearLayoutManager)
        heartRateDataAdapter = HeartRateDataAdapter()
        activityHeartRateBinding.RecyclerViewHeartData.setAdapter(heartRateDataAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityHeartRateBinding.RecyclerViewHeartData.addItemDecoration(dividerItemDecoration)
        activityHeartRateBinding.btReadData.setOnClickListener {
            list.clear()
            dataCount = 0
            getHeartHistoryData(ModeStart)
        }
        activityHeartRateBinding.btDeleteData.setOnClickListener {
            getHeartHistoryData(ModeDelete)
        }
    }



    var list: MutableList<MutableMap<String?, String?>?> = ArrayList<MutableMap<String?, String?>?>()
    var dataCount: Int = 0
    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.Delete_GetDynamicHR -> showDialogInfo(maps.toString())
            BleConst.GetDynamicHR -> {
                dataCount++
                list.addAll((maps?.get(DeviceKey.Data) as kotlin.collections.MutableList<kotlin.collections.MutableMap<kotlin.String?, kotlin.String?>?>?)!!)
                if (finish) {
                    heartRateDataAdapter!!.setData(list, HeartRateDataAdapter.GET_HEART_DATA)
                }
                if (dataCount == 50) {
                    dataCount = 0
                    if (finish) {
                        heartRateDataAdapter!!.setData(list, HeartRateDataAdapter.GET_HEART_DATA)
                    } else {
                        getHeartHistoryData(ModeContinue) //继续读取心率历史数据Continue reading heart rate history data
                    }
                }
            }
        }
    }


    private fun getHeartHistoryData(mode: Byte) {
        /**
         * dateOfLastData 设备返回所有数据后最后的时间戳，第一次没有的情况为null，或者“”，同步数据后保存数据库
         * dateOfLastData The last timestamp after the device returns all data, null if there is no data for the first time, or "", save the database after synchronizing the data
         */
        sendValue(BleSDK.GetDynamicHRWithMode(mode, ""))
    }



    companion object {
        private const val TAG = "HeartRateInfoActivity"
    }
}
