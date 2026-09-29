package com.jstyle.testv8.ui

import android.annotation.SuppressLint
import android.os.Bundle
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.adapter.TotalDataAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityTotalDataBinding



/**
 * 获得计步总数据 (Obtain step total data)
 */
@SuppressLint("StaticFieldLeak")
lateinit var activityTotalDataBinding: ActivityTotalDataBinding

class TotalDataActivity : BaseActivity() {
    private var toatlDataAdapter: TotalDataAdapter? = null
    var ModeStart: Byte = 0
    var ModeContinue: Byte = 2
    var ModeDelete: Byte = 0x99.toByte()

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityTotalDataBinding=ActivityTotalDataBinding.inflate(layoutInflater)
        setContentView(activityTotalDataBinding.getRoot());
    }
    override fun init() {
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityTotalDataBinding.RecyclerViewTotalData.setLayoutManager(linearLayoutManager)
        toatlDataAdapter = TotalDataAdapter()
        activityTotalDataBinding.RecyclerViewTotalData.setAdapter(toatlDataAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityTotalDataBinding.RecyclerViewTotalData.addItemDecoration(dividerItemDecoration)

        activityTotalDataBinding.btReadData.setOnClickListener {
            dataCount = 0
            list.clear()
            getTotalData(ModeStart) }
        activityTotalDataBinding.btDeleteData.setOnClickListener {
            getTotalData(ModeDelete)
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
            BleConst.Delete_GetTotalActivityData -> showDialogInfo(maps.toString())
            BleConst.GetTotalActivityData -> {
                dataCount++
                list.addAll((maps?.get(DeviceKey.Data) as kotlin.collections.MutableList<kotlin.collections.MutableMap<kotlin.String?, kotlin.String?>?>?)!!)
                if (finish) {
                    toatlDataAdapter?.setData(list)
                }
                if (dataCount == 50) {
                    dataCount = 0
                    if (finish) {
                        toatlDataAdapter?.setData(list)
                    } else {
                        getTotalData(ModeContinue)
                    }
                }
            }
        }
    }


    private fun getTotalData(mode: Byte) { //发送命令给设备 send command to device
        /**
         * dateOfLastData 设备返回所有数据后最后的时间戳，第一次没有的情况为null，或者“”，同步数据后保存数据库
         * dateOfLastData The last timestamp after the device returns all data, null if there is no data for the first time, or "", save the database after synchronizing the data
         */
        sendValue(BleSDK.GetTotalActivityDataWithMode(mode, ""))
    }


}
