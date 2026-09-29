package com.jstyle.testv8.ui

import android.os.Bundle
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityMcuBinding
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst


/**
 * 重置MUC (Reset MUC)
 */
lateinit var activitymcuBinding: ActivityMcuBinding

class MCUActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activitymcuBinding = ActivityMcuBinding.inflate(layoutInflater);
        setContentView(activitymcuBinding.getRoot());
    }

    override fun init() {
        activitymcuBinding.set.setOnClickListener {
            sendValue(BleSDK.MCUReset());
        }
    }

     override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        when (dataType) {
            BleConst.CMD_MCUReset -> if (null != activitymcuBinding.info) {
                activitymcuBinding.info.text = maps.toString()
            }
        }
    }


}
