package com.jstyle.testv8.ui

import android.os.Bundle
import androidx.recyclerview.widget.DividerItemDecoration
import androidx.recyclerview.widget.LinearLayoutManager
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.adapter.DetailDataAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivitySleepDataBinding


/**
 * 睡眠历史数据 （sleep history data）
 */

lateinit var activityDetailSleepBinding: ActivitySleepDataBinding
class DetailSleepActivity : BaseActivity() {
    private var detailDataAdapter: DetailDataAdapter? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityDetailSleepBinding=ActivitySleepDataBinding.inflate(layoutInflater)
        setContentView(activityDetailSleepBinding.getRoot());
    }
    override fun init() {
        val linearLayoutManager = LinearLayoutManager(this)
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL)
        activityDetailSleepBinding.RecyclerViewDetailData.setLayoutManager(linearLayoutManager)
        detailDataAdapter = DetailDataAdapter()
        activityDetailSleepBinding.RecyclerViewDetailData.setAdapter(detailDataAdapter)
        val dividerItemDecoration = DividerItemDecoration(this, DividerItemDecoration.VERTICAL)
        activityDetailSleepBinding.RecyclerViewDetailData.addItemDecoration(dividerItemDecoration)


        activityDetailSleepBinding.btReadData.setOnClickListener {
            list.clear()
            dataCount = 0
            getDetailData(ModeStart)
        }
        activityDetailSleepBinding.btDeleteData.setOnClickListener {
            list.clear()
            detailDataAdapter!!.Clear()
            getDetailData(ModeDelete)
        }
    }


    var ModeStart: Byte = 0x00 //开始获取数据 start getting data
    var ModeContinue: Byte = 0x02 //继续读取数据 continue reading data
    var ModeDelete: Byte = 0x99.toByte() //删除数据  delete data


    var list: MutableList<MutableMap<String?, String?>?> =
        ArrayList<MutableMap<String?, String?>?>()
    var dataCount: Int = 0
    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val finish = getEnd(maps)
        when (dataType) {
            BleConst.GetDetailSleepData -> {
                list.addAll((maps?.get(DeviceKey.Data) as kotlin.collections.MutableList<kotlin.collections.MutableMap<kotlin.String?, kotlin.String?>?>?)!!)
                dataCount++
                if (finish) {
                    disMissProgressDialog()
                    detailDataAdapter!!.setData(list, DetailDataAdapter.GET_SLEEP_DETAIL)
                }
                if (dataCount == 50) {
                    dataCount = 0
                    if (finish) {
                        disMissProgressDialog()
                        detailDataAdapter!!.setData(list, DetailDataAdapter.GET_SLEEP_DETAIL)
                    } else {
                        getDetailData(ModeContinue)
                    }
                }
            }

            BleConst.Delete_GetDetailSleepData -> {
                showDialogInfo(maps.toString())
                disMissProgressDialog()
            }
        }
    }

    private fun getDetailData(mode: Byte) {
        showProgressDialog("Synchronous Data") //同步数据
        /**
         * dateOfLastData 设备返回所有数据后最后的时间戳，第一次没有的情况为null，或者“”，同步数据后保存数据库
         * dateOfLastData The last timestamp after the device returns all data, null if there is no data for the first time, or "", save the database after synchronizing the data
         */
        sendValue(BleSDK.GetDetailSleepDataWithMode(mode, "")) //发送命令给设备 send command to device
    }



    companion object {
        private const val TAG = "DetailDataActivity"
    }
}
