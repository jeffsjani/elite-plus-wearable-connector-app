package com.jstyle.testv8.ui

import android.annotation.SuppressLint
import android.os.Bundle
import android.util.Log
import android.widget.ProgressBar
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.ble.BleManager
import com.jstyle.testv8.databinding.ActivityBloodGlucoseBinding
import com.jstyle.testv8.utils.CustomCountDownTimer


lateinit var activityBloodGlucoseBinding: ActivityBloodGlucoseBinding



class BloodGlucoseActivity : BaseActivity() {
    var progressBar: ProgressBar? = null

    var customCountDownTimer: CustomCountDownTimer? = null //计时器
    var alldata: MutableList<MutableMap<String?, Any?>?>? = null
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityBloodGlucoseBinding=ActivityBloodGlucoseBinding.inflate(layoutInflater)
        setContentView(activityBloodGlucoseBinding.getRoot());
    }
    override fun init() {
        activityBloodGlucoseBinding.start.setOnClickListener {
            if (BleManager.instance?.isConnected == true) {
                alldata = ArrayList<MutableMap<String?, Any?>?>()
                sendValue(BleSDK.ppgWithMode(1, 0))
            } else {
                showToast("设备未连接 device not connected")
            }
        }
        activityBloodGlucoseBinding.send.setOnClickListener {
            if (null != customCountDownTimer) {
                customCountDownTimer?.cancel()
                customCountDownTimer = null
            }
            if (BleManager.instance?.isConnected == true) {
                sendValue(BleSDK.ppgWithMode(2, 2))
            } else {
                showToast("设备未连接 device not connected")
            }
        }


    }
    private fun StartTime() {
        val alltime = 5 * 60 * 1000f //五分钟 Five minutes
        if (null == customCountDownTimer) {
            customCountDownTimer =
                object : CustomCountDownTimer(alltime.toLong(), 1000, object : TimerTickListener {
                    @SuppressLint("DefaultLocale")
                    public override fun onTick(millisLeft: Long) {
                        if (null != progressBar) {
                            this@BloodGlucoseActivity.runOnUiThread(object : Runnable {
                                override fun run() {
                                    var baifenbi = (alltime - millisLeft) / alltime * 100f
                                    Log.e(
                                        "sdnbamndamdn",
                                        alltime.toString() + "***" + millisLeft + "***" + baifenbi
                                    )
                                    progressBar!!.setProgress((baifenbi).toInt())
                                    if (baifenbi > 100) {
                                        baifenbi = 100.0f
                                    }
                                    //Log.e("sdnbamndamdn","ssdsds");
                                    if (baifenbi - baifenbi.toInt() == 0f) {
                                        sendValue(BleSDK.ppgWithMode(4, baifenbi.toInt()))
                                    }
                                }
                            })
                        }
                    }

                    public override fun onFinish() {
                        this.onCancel()
                        if (null != customCountDownTimer) {
                            customCountDownTimer!!.cancel()
                            sendValue(BleSDK.ppgWithMode(3, 0))
                        }
                    }

                    public override fun onCancel() {}
                }) {}
            customCountDownTimer?.start()
        }
    }




    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        val data = getData(maps)
        when (dataType) {
            BleConst.Blood_glucose_status -> {
                val status = data!![DeviceKey.Type].toString().toInt()
                when (status) {
                    0 -> StartTime()
                    2 -> {}
                    3 -> {}
                }
                if (null != activityBloodGlucoseBinding.info) {
                    activityBloodGlucoseBinding.info.text = maps.toString()
                }
            }

            BleConst.Blood_glucose_data -> {
                if (null != alldata) {
                    alldata!!.add(maps)
                }
                if (null != activityBloodGlucoseBinding.info) {
                    activityBloodGlucoseBinding.info.text = maps.toString()
                }
            }
        }
    }




    protected override fun onDestroy() {
        super.onDestroy()
        sendValue(BleSDK.ppgWithMode(5, 0))
    }
}
