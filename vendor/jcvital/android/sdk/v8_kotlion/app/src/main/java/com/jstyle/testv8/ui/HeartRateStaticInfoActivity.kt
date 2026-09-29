package com.jstyle.testv8.ui

import android.os.Bundle
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.adapter.HeartRateDataAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityHeartRateStaticInfoBinding



/**
 * 获得静态心率历史数据 (Get static heart rate historical data)
 */
lateinit var activityHeartRateStaticBinding: ActivityHeartRateStaticInfoBinding

class HeartRateStaticInfoActivity : BaseActivity() {
    private var heartRateDataAdapter: HeartRateDataAdapter? = null
    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityHeartRateStaticBinding=ActivityHeartRateStaticInfoBinding.inflate(layoutInflater)
        setContentView(activityHeartRateStaticBinding.getRoot());
    }
    override fun init() {
        val linearLayoutManager: LinearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityHeartRateStaticBinding.RecyclerViewHeartData.setLayoutManager(linearLayoutManager)
        heartRateDataAdapter = HeartRateDataAdapter()
        activityHeartRateStaticBinding. RecyclerViewHeartData.setAdapter(heartRateDataAdapter)
        val dividerItemDecoration: DividerItemDecoration =
            DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityHeartRateStaticBinding.RecyclerViewHeartData.addItemDecoration(dividerItemDecoration)

        activityHeartRateStaticBinding.btReadData.setOnClickListener {
            list.clear()
            dataCount = 0
            GetStaticHRWithMode(ModeStart)
        }
        activityHeartRateStaticBinding.btDeleteData.setOnClickListener {
            GetStaticHRWithMode(ModeDelete)
        }
    }




    var list: MutableList<MutableMap<String?, String?>?> =
        ArrayList<MutableMap<String?, String?>?>()
    var dataCount: Int = 0
    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.Delete_GetStaticHR -> showDialogInfo(maps.toString())
            BleConst.GetStaticHR -> {
                dataCount++
                list.addAll((maps?.get(DeviceKey.Data) as kotlin.collections.MutableList<kotlin.collections.MutableMap<kotlin.String?, kotlin.String?>?>?)!!)
                if (finish) {
                    heartRateDataAdapter!!.setData(list, HeartRateDataAdapter.GET_ONCE_HEARTDATA)
                }
                if (dataCount == 50) {
                    dataCount = 0
                    if (finish) {
                        heartRateDataAdapter!!.setData(
                            list,
                            HeartRateDataAdapter.GET_ONCE_HEARTDATA
                        )
                    } else {
                        GetStaticHRWithMode(ModeContinue)
                    }
                }
            }
        }
    }


    private fun GetStaticHRWithMode(mode: Byte) {
        /**
         * dateOfLastData 设备返回所有数据后最后的时间戳，第一次没有的情况为null，或者“”，同步数据后保存数据库
         * dateOfLastData The last timestamp after the device returns all data, null if there is no data for the first time, or "", save the database after synchronizing the data
         */
        sendValue(BleSDK.GetStaticHRWithMode(mode, ""))
    }



    companion object {
        private const val TAG = "HeartRateInfoActivity"
    }
}
