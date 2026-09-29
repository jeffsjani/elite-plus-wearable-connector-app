package com.jstyle.test2025.activity;

import android.os.Bundle;
import android.support.v7.widget.SwitchCompat;
import android.util.Log;
import android.widget.Button;
import android.widget.EditText;
import android.widget.RadioGroup;
import android.widget.TextView;

import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.blesdkv8.model.AutoTestMode;
import com.jstyle.test2025.R;

import java.util.Map;

import butterknife.BindView;
import butterknife.ButterKnife;

public class MeasurementActivity extends BaseActivity {

    @BindView(R.id.radioGroup_mian)
    RadioGroup radioGroup_mian;
    @BindView(R.id._switch)
    SwitchCompat _switch;
    @BindView(R.id.data_info)
    TextView data_info;
    @BindView(R.id.send)
    Button send;

    @BindView(R.id.second)
    EditText secondText;

    AutoTestMode autoTestMode;
    boolean open=false;


    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_measurement);
        ButterKnife.bind(this);


    }




    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType= getDataType(maps);
        Log.e("dataCallback",maps.toString());
        switch (dataType){
            case BleConst.MeasurementHrvCallback:
            case BleConst.MeasurementHeartCallback:
            case BleConst.MeasurementOxygenCallback:
            case BleConst.StopMeasurementHrvCallback:
            case BleConst.StopMeasurementHeartCallback:
            case BleConst.StopMeasurementOxygenCallback:
                data_info.setText("");
                data_info.setText(maps.toString());
                break;
        }}

}
