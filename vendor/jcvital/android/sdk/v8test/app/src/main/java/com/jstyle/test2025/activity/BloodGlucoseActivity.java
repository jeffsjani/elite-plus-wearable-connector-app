package com.jstyle.test2025.activity;

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.jstyle.blesdkv8.Util.BleSDK;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.blesdkv8.constant.DeviceKey;
import com.jstyle.test2025.R;
import com.jstyle.test2025.Util.CustomCountDownTimer;
import com.jstyle.test2025.ble.BleManager;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import butterknife.BindView;
import butterknife.ButterKnife;
import butterknife.OnClick;

public class BloodGlucoseActivity extends BaseActivity {
    @BindView(R.id.progressBar)
    ProgressBar progressBar;

    @BindView(R.id.info)
    TextView info;
    CustomCountDownTimer customCountDownTimer;//计时器
    List<Map<String, Object>> alldata;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_blood_glucose);
        ButterKnife.bind(this);

    }

    private void StartTime(){
        final float alltime=5*60*1000f;//五分钟 Five minutes
        if(null==customCountDownTimer){
            customCountDownTimer = new CustomCountDownTimer((long) alltime, 1000, new CustomCountDownTimer.TimerTickListener() {
                @SuppressLint("DefaultLocale")
                @Override
                public void onTick(final long millisLeft) {
                    if(null!=progressBar){
                        BloodGlucoseActivity.this.runOnUiThread(new Runnable() {
                            @Override
                            public void run() {
                                float baifenbi=(alltime-millisLeft)/alltime*100f;
                                Log.e("sdnbamndamdn",alltime+"***"+millisLeft+"***"+baifenbi);
                                progressBar.setProgress((int) (baifenbi));
                                if(baifenbi>100){
                                    baifenbi=100.0f;
                                }
                                //Log.e("sdnbamndamdn","ssdsds");
                                if(baifenbi-Float.valueOf(baifenbi).intValue()==0){
                                    BleManager.getInstance().writeValue(BleSDK.ppgWithMode(4,(int) baifenbi));
                                }
                            }
                        });


                    }
                }
                @Override
                public void onFinish() {
                    this.onCancel();
                    if(null!=customCountDownTimer){
                        customCountDownTimer.cancel();
                        BleManager.getInstance().writeValue(BleSDK.ppgWithMode(3,0));
                    }
                }
                @Override
                public void onCancel() { }
            }) {};
            customCountDownTimer.start();
        }

    }

    @OnClick({R.id.start, R.id.send})
    public void onViewClicked(View view) {
        switch (view.getId()) {
            case R.id.start:
                if(BleManager.getInstance().isConnected()){
                    alldata=new ArrayList<>();
                    BleManager.getInstance().writeValue(BleSDK.ppgWithMode(1,0));
                }else{
                    showToast("设备未连接 device not connected");
                }
                break;
            case R.id.send://发送结果
                if(null!=customCountDownTimer){
                    customCountDownTimer.cancel();
                    customCountDownTimer=null;
                }
                if(BleManager.getInstance().isConnected()){
                    BleManager.getInstance().writeValue(BleSDK.ppgWithMode(2,2));
                }else{
                    showToast("设备未连接 device not connected");
                }
                break;
        }
    }


    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType = getDataType(maps);
        Map<String, String> data = getData(maps);
        switch (dataType) {
            case BleConst.Blood_glucose_status:
                int status = Integer.parseInt(data.get(DeviceKey.Type));
                switch (status){
                    case 0://设备状态正常 The device status is normal
                        StartTime();
                        break;
                    case 2://电池电量过低，少于10% The battery level is too low, less than 10%
                        break;
                    case 3://在跑步模式，不能开始测试 Unable to start testing in running mode
                        break;
                }
                if (null != info) {
                    info.setText(maps.toString());
                }
                break;
            case BleConst.Blood_glucose_data:
                if(null!=alldata){
                    alldata.add(maps);
                }
                if (null != info) {
                    info.setText(maps.toString());
                }
                break;
        }
    }


    @Override
    protected void onDestroy() {
        super.onDestroy();
        BleManager.getInstance().writeValue(BleSDK.ppgWithMode(5,0));
    }
}
