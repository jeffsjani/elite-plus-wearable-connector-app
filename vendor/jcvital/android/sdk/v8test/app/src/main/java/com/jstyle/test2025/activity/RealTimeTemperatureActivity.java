package com.jstyle.test2025.activity;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.TextView;

import com.jstyle.blesdkv8.Util.BleSDK;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.test2025.R;

import java.util.Map;

import butterknife.BindView;
import butterknife.ButterKnife;
import butterknife.OnClick;


public class RealTimeTemperatureActivity extends BaseActivity {
    @BindView(R.id.info)
    TextView info;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_real_time_temperature);
        ButterKnife.bind(this);
    }

    @OnClick({R.id.set})
    public void onViewClicked(View view) {
        switch (view.getId()){
            case R.id.set:
                sendValue(BleSDK.RealTimeTemperature());
                break;
        }
    }


    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType= getDataType(maps);
        Log.e("dataCallback",maps.toString());
        switch (dataType){
            case BleConst.Temperature_3NTC:
            if(null!=info){
                info.setText(maps.toString());
            }
                break;
        }}

}
