package com.jstyle.testv8.ui

import android.app.Activity
import android.bluetooth.BluetoothDevice
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.text.TextUtils
import android.util.Log
import androidx.appcompat.app.AppCompatActivity
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.ble.BleManager
import com.jstyle.testv8.databinding.ActivityOtaInfoBinding
import com.jstyle.testv8.databinding.ActivityPpiDataReadBinding
import com.jstyle.testv8.utils.ZipUtils

import java.io.File
import java.util.Locale
import kotlin.jvm.java
import kotlin.text.contains
import kotlin.text.toUpperCase
import kotlin.text.trim


/**
 *
 */
lateinit var activityotaBinding: ActivityOtaInfoBinding

class OtaInfoActivity : BaseActivity() {

    val TAG: String = "OtaInfoActivity"

    private var resPath = "" //bin 文件升级的路径

    private var address: String? = ""
    private var name: String? = ""

    private var targetDevice: BluetoothDevice? = null

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        address =getIntent().getStringExtra("address")
        name = getIntent().getStringExtra("name")

        activityotaBinding=ActivityOtaInfoBinding.inflate(layoutInflater)
        setContentView(activityotaBinding.getRoot());
    }

    override fun init() {

        ZipUtils.WRITE_READ(this, object : ZipUtils.PermissionsUtilsListener {
            override fun onSuccess() {
                //从 assets目录中 复制文件到手机本地目录，并且解压文件一定要注意权限，android q
                ZipUtils.copyFileToDisk(
                    this@OtaInfoActivity,
                    "V8_V003_8_20260304.zip",
                    true,
                    object : ZipUtils.copyFileListener {
                        override fun onSuccess() {
                            //获得zip 包中的bin文件路径
                            resPath = ZipUtils.UPDATEPATH + ZipUtils.getFilesAllName("firmware")


                            if (null != activityotaBinding.tvFileType) {
                                activityotaBinding.tvFileType.text = resPath
                            }

                        }

                        override fun onfail() {
                        }
                    })
            }

            override fun onfail() {
            }
        })



        activityotaBinding.btOta.setOnClickListener {
            //disconnectDevice


            if (TextUtils.isEmpty(address)) {
                showDialogInfo("请选择设备 Please select a device")
                return@setOnClickListener
            }

            targetDevice = BleManager.instance?. bluetoothAdapter?.getRemoteDevice(
                address?.trim()?.toUpperCase(
                    Locale.getDefault())
            );
            BleManager.instance?.writeValue(BleSDK.enterOTA())
            BleManager.instance?.disconnectDevice()
            activityotaBinding.btOta.postDelayed({
                otav8()
            },2000)

        }

    }








    private var mFileStreamUri: Uri? = null
    private fun otav8() {
        mFileStreamUri = Uri.fromFile(File(resPath))
        val intent = Intent(this@OtaInfoActivity, OtaActivity::class.java)
        Log.e("msmsmsmsm", "startOta: " + resPath + " uri " + mFileStreamUri)
        intent.putExtra(OtaActivity.EXTRA_FILE_PATH, resPath)
        intent.putExtra(OtaActivity.EXTRA_FILE_URI, mFileStreamUri)
        intent.putExtra(OtaActivity.IsDfuAddress, name?.toUpperCase(Locale.US)?.contains("DFU"))
        startActivity(intent)
    }






     override fun onDestroy() {
        super.onDestroy()

    }


}
