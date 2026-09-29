package com.jstyle.test2025.activity;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.TextView;

import com.jstyle.blesdkv8.Util.BleSDK;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.blesdkv8.constant.DeviceKey;
import com.jstyle.blesdkv8.model.AutoTestMode;
import com.jstyle.test2025.R;
import com.jstyle.test2025.ble.BleManager;
import com.jstyle.test2025.views.PPGChartsView;

import java.util.Collections;
import java.util.Deque;
import java.util.LinkedList;
import java.util.Map;
import java.util.concurrent.ScheduledThreadPoolExecutor;
import java.util.concurrent.TimeUnit;

import butterknife.BindView;
import butterknife.ButterKnife;
import butterknife.OnClick;


public class ECGActivity extends BaseActivity {
    @BindView(R.id.info)
    TextView info;

    private  Deque<Float> queues= new LinkedList<>();
    private ScheduledThreadPoolExecutor timer = null;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_ecgtest);
        ButterKnife.bind(this);

    }

    @OnClick({R.id.start,R.id.end})
    public void onViewClicked(View view) {
     switch (view.getId()){
         case R.id.start:
             BleManager.getInstance().offerValue(BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG,50*1000,true));
             BleManager.getInstance().offerValue(BleSDK.setECGRealtimeDuringHRVEnabled(true));
             BleManager.getInstance().writeValue();
             break;
         case R.id.end:
             BleManager.getInstance().offerValue(BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG,50*1000,false));
             BleManager.getInstance().offerValue(BleSDK.setECGRealtimeDuringHRVEnabled(false));
             BleManager.getInstance().writeValue();
             break;
     }
    }


    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType = getDataType(maps);
        switch (dataType) {
            case BleConst.GetECG:
                Log.e("info",maps.toString());

                Map<String,String>map= getData(maps);


                if(null!=info){
                    info.setText(map.toString());
                }

                break;
        }

    }
}
