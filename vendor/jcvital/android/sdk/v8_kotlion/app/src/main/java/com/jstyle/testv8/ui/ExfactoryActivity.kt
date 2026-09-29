package com.jstyle.testv8.ui

import android.content.DialogInterface
import android.os.Bundle
import androidx.appcompat.app.AlertDialog
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.R
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.databinding.ActivityFactoryBinding



/**
 * 恢复出厂设置
 * Restore factory settings
 */

lateinit var activityexfactoryBinding: ActivityFactoryBinding

class ExfactoryActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        activityexfactoryBinding = ActivityFactoryBinding.inflate(layoutInflater);
        setContentView(activityexfactoryBinding.getRoot());
    }
    override fun init() {
        activityexfactoryBinding.set.setOnClickListener {
            //恢复出厂设置 Restore factory settings
            showResetDialog();
        }
    }

    private fun showResetDialog() {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.Restore_factory))
            .setMessage(getString(R.string.Restore_factory_tips))
            .setPositiveButton("Ok", object : DialogInterface.OnClickListener {
                override fun onClick(dialog: DialogInterface?, which: Int) {
                    sendValue(BleSDK.Reset())
                }
            })
            .setNegativeButton("Cancel", null)
            .create().show()
    }

    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        val dataType = getDataType(maps)
        when (dataType) {
            BleConst.CMD_Reset -> if (null != activityexfactoryBinding.info) {
                activityexfactoryBinding.info.setText(maps.toString())
            }
        }
    }


}
