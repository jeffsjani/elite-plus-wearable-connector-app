package com.jstyle.testv8

import android.app.ProgressDialog
import android.bluetooth.BluetoothAdapter
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Build
import android.os.Bundle
import android.text.TextUtils
import android.util.Log
import android.widget.Button
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.recyclerview.widget.GridLayoutManager
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.testv8.MainActivity.ListenerReceiver
import com.jstyle.testv8.adapter.MainAdapter
import com.jstyle.testv8.base.BaseActivity
import com.jstyle.testv8.ble.BleData
import com.jstyle.testv8.ble.BleManager
import com.jstyle.testv8.ble.BleService
import com.jstyle.testv8.ble.RxBus
import com.jstyle.testv8.databinding.ActivityMainBinding
import com.jstyle.testv8.ui.ActivityAlarmSetActivity
import com.jstyle.testv8.ui.ActivityDevicesNameActivity
import com.jstyle.testv8.ui.ActivityModeActivity
import com.jstyle.testv8.ui.AlarmListActivity
import com.jstyle.testv8.ui.AutoModeSetActivity
import com.jstyle.testv8.ui.AutoTemperatureHistoryActivity
import com.jstyle.testv8.ui.Automatically_test_blood_oxygen_dataActivity
import com.jstyle.testv8.ui.BasicActivity
import com.jstyle.testv8.ui.Basic_parameters_of_equipmentActivity
import com.jstyle.testv8.ui.BatteryActivity
import com.jstyle.testv8.ui.BloodGlucoseActivity
import com.jstyle.testv8.ui.DetailDataActivity
import com.jstyle.testv8.ui.DetailSleepActivity
import com.jstyle.testv8.ui.ECGActivity
import com.jstyle.testv8.ui.ExerciseHistoryDataActivity
import com.jstyle.testv8.ui.ExfactoryActivity
import com.jstyle.testv8.ui.HeartRateInfoActivity
import com.jstyle.testv8.ui.HeartRateStaticInfoActivity
import com.jstyle.testv8.ui.HrvDataReadActivity
import com.jstyle.testv8.ui.MCUActivity
import com.jstyle.testv8.ui.MacAddressActivity
import com.jstyle.testv8.ui.ObtainDetailedSleepdataActivity
import com.jstyle.testv8.ui.OtaInfoActivity
import com.jstyle.testv8.ui.PPIDataActivity
import com.jstyle.testv8.ui.RealTimeStepCountingActivity
import com.jstyle.testv8.ui.RealTimeTemperatureActivity
import com.jstyle.testv8.ui.TimeActivity
import com.jstyle.testv8.ui.TotalDataActivity
import com.jstyle.testv8.ui.VersionActivity
import io.reactivex.android.schedulers.AndroidSchedulers
import io.reactivex.disposables.Disposable
import io.reactivex.functions.Consumer
import io.reactivex.schedulers.Schedulers
import java.util.Objects
import kotlin.jvm.java


private var subscription: Disposable? = null
private var progressDialog: ProgressDialog? = null
var mainAdapter: MainAdapter? =null
private var address: String? = null
private var name: String? = null
var isStartReal: Boolean = false
var phoneDataLength: Int = 200 //手机一个包能发送的最多数据
var receiver: ListenerReceiver? = null
val MY_PERMISSIONS_REQUEST_CALL_PHONE: Int = 321
const val TAG = "MainActivity"
var btConnect: Button? = null
class MainActivity : BaseActivity() {
   lateinit var activityMainBinding: ActivityMainBinding

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)
    }
    override fun init() {
        enableEdgeToEdge()
        activityMainBinding = ActivityMainBinding.inflate(layoutInflater);
        setContentView(activityMainBinding.getRoot());
        val options = getResources().getStringArray(com.jstyle.testv8.R.array.item_options)
        mainAdapter = MainAdapter(options, {position->
            when(position){
              0->startActivity(Intent(this, TimeActivity::class.java))
              1->startActivity(Intent(this, BasicActivity::class.java))
              2->startActivity(Intent(this, ExfactoryActivity::class.java))
              3->startActivity(Intent(this, BatteryActivity::class.java))
              4->startActivity(Intent(this, MacAddressActivity::class.java))
              5->startActivity(Intent(this, VersionActivity::class.java))
              6->startActivity(Intent(this, MCUActivity::class.java))
              7->startActivity(Intent(this, RealTimeStepCountingActivity::class.java))
              8->startActivity(Intent(this, AutoModeSetActivity::class.java))
              9->startActivity(Intent(this, TotalDataActivity::class.java))
              10->startActivity(Intent(this, DetailDataActivity::class.java))
              11->startActivity(Intent(this, DetailSleepActivity::class.java))
              12->startActivity(Intent(this, HeartRateInfoActivity::class.java))
              13->startActivity(Intent(this, HeartRateStaticInfoActivity::class.java))
              14->startActivity(Intent(this, HrvDataReadActivity::class.java))
              15->startActivity(Intent(this, AutoTemperatureHistoryActivity::class.java))
              16->startActivity(Intent(this, Automatically_test_blood_oxygen_dataActivity::class.java))
              17->startActivity(Intent(this, ActivityModeActivity::class.java))
              18->startActivity(Intent(this, ActivityDevicesNameActivity::class.java))
              19->startActivity(Intent(this, ExerciseHistoryDataActivity::class.java))

              20->startActivity(Intent(this, BloodGlucoseActivity::class.java))
              21->startActivity(Intent(this, ObtainDetailedSleepdataActivity::class.java))
              22->startActivity(Intent(this, RealTimeTemperatureActivity::class.java))
              23->startActivity(Intent(this, Basic_parameters_of_equipmentActivity::class.java))
              24->startActivity(Intent(this, ECGActivity::class.java))


              25->startActivity(Intent(this, AlarmListActivity::class.java))
              26->startActivity(Intent(this, ActivityAlarmSetActivity::class.java))
              27->startActivity(Intent(this, PPIDataActivity::class.java))
              28->startActivity(Intent(this, OtaInfoActivity::class.java)
                    .putExtra("address", address)
                    .putExtra("name", name))


            }
        })
        activityMainBinding.mainRecyclerview.adapter=mainAdapter
        var gridLayoutManager =  GridLayoutManager(this, 3);
        activityMainBinding.mainRecyclerview.setLayoutManager(gridLayoutManager);
        ViewCompat.setOnApplyWindowInsetsListener(findViewById(com.jstyle.testv8.R.id.main)) { v, insets ->
            val systemBars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            v.setPadding(systemBars.left, systemBars.top, systemBars.right, systemBars.bottom)
            insets
        }
        btConnect=activityMainBinding.BTCONNECT
        connectDevice()
        registerReceiver()
        subscription = RxBus.instance.toObservable(BleData::class.java as Class<BleData?>)
            ?.subscribeOn(Schedulers.io())
            ?.observeOn(AndroidSchedulers.mainThread())?.subscribe(Consumer<BleData?> { bleData ->
                val action = bleData?.action
                if (action == BleService.ACTION_GATT_onDescriptorWrite) {
                    mainAdapter!!.setEnable(true)
                    btConnect!!.setEnabled(false)
                    dissMissDialog()
                } else if (action == BleService.ACTION_GATT_DISCONNECTED) {
                    mainAdapter!!.setEnable(false)
                    btConnect!!.setEnabled(true)

                    isStartReal = false
                    dissMissDialog()
                }
            })
    }

    override fun dataCallback(maps: MutableMap<String?, Any?>?) {
        super.dataCallback(maps)
        Log.e("info", maps.toString())
        val dataType = getDataType(maps)
        if(Objects.equals(dataType, BleConst.SOS)){
            showToast("SOS");
        }

    }


     class ListenerReceiver : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent) {
            if (Objects.requireNonNull<String?>(intent.getAction()) == BluetoothAdapter.ACTION_STATE_CHANGED) {
                val state = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
                when (state) {
                    BluetoothAdapter.STATE_ON -> {
                        if (TextUtils.isEmpty(address)) {
                            Log.i(TAG, "onCreate: address null ")
                            return
                        }
                        BleManager.instance?.connectDevice(address)
                    }

                    BluetoothAdapter.STATE_OFF -> {

                        mainAdapter?.setEnable(false)
                        btConnect?.setEnabled(true)
                        BleManager.instance?.disconnectDevice()
                    }
                }
            }
        }
    }

    private fun connectDevice() {

        address = getIntent().getStringExtra("address")
        name = getIntent().getStringExtra("name")
        if (TextUtils.isEmpty(address)) {
            Log.i(TAG, "onCreate: address null ")
            return
        }
        Log.i(TAG, "onCreate: ")
        if( BleManager.instance?.isConnected==true){
            mainAdapter?.setEnable(true)
            btConnect?.setEnabled(false)
            return
        }
        BleManager.instance?.connectDevice(address)
        showConnectDialog()
    }

    /**
     * 蓝牙状态监听
     * Bluetooth status monitoring
     */
    private fun registerReceiver() {
        val filter = IntentFilter()
        filter.addAction(BluetoothAdapter.ACTION_STATE_CHANGED)
        receiver = ListenerReceiver()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            registerReceiver(receiver, filter, RECEIVER_EXPORTED)
        } else {
            registerReceiver(receiver, filter)
        }
    }
    private fun showConnectDialog() {
        progressDialog = ProgressDialog(this)
        progressDialog?.setMessage("Connecting")
        progressDialog?.isShowing?.let { if (!it) progressDialog?.show() }
    }

    private fun dissMissDialog() {
        if (progressDialog != null && progressDialog?.isShowing() == true) progressDialog?.dismiss()
    }
}