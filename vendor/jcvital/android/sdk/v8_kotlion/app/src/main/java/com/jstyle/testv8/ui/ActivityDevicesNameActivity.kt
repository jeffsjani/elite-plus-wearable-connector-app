package com.jstyle.testv8.ui

import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivitySetBinding

lateinit var activitySetBinding: ActivitySetBinding


class ActivityDevicesNameActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: android.os.Bundle?) {
        super.onCreate(savedInstanceState)
        activitySetBinding=ActivitySetBinding.inflate(layoutInflater)
        setContentView(activitySetBinding.getRoot());
    }
    override fun init() {
        activitySetBinding.set.setOnClickListener {
            if (android.text.TextUtils.isEmpty(activitySetBinding.edContentName.getText())) {
                showToast("设备名未输入 Device name not entered")
                return@setOnClickListener
            }
            val NAME = activitySetBinding.edContentName.getText().toString()
            sendValue(BleSDK.SetDeviceName(NAME))
        }

        activitySetBinding.get.setOnClickListener {
            sendValue(BleSDK.GetDeviceName())
        }
    }







    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)

        when (dataType) {
            BleConst.CMD_Set_Name -> if (null != activitySetBinding.info) {
                activitySetBinding.info.setText(maps.toString())
            }

            BleConst.CMD_Get_Name -> if (null != activitySetBinding.info) {
                activitySetBinding.info.setText(maps.toString())
            }
        }
    }


}
