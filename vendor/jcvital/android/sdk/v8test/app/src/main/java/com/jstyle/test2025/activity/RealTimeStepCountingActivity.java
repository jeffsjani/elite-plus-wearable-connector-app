package com.jstyle.test2025.activity;

import android.os.Bundle;
import android.support.v7.widget.SwitchCompat;
import android.util.Log;
import android.view.View;
import android.widget.Button;
import android.widget.CompoundButton;
import android.widget.EditText;
import android.widget.RadioGroup;
import android.widget.TextView;
import com.jstyle.blesdkv8.Util.BleSDK;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.blesdkv8.constant.DeviceKey;
import com.jstyle.blesdkv8.model.AutoTestMode;
import com.jstyle.test2025.R;
import java.util.Map;
import butterknife.BindView;
import butterknife.ButterKnife;
import butterknife.OnClick;

/**
 * 实时计步 (Real time step counting)
 */
public class RealTimeStepCountingActivity extends BaseActivity {
    @BindView(R.id.button_startreal)
    Button buttonStartreal;
    @BindView(R.id.SwitchCompat_temp)
    SwitchCompat SwitchCompatTemp;
    @BindView(R.id.textView_step)
    TextView textViewStep;
    @BindView(R.id.textView_cal)
    TextView textViewCal;
    @BindView(R.id.textView_distance)
    TextView textViewDistance;
    @BindView(R.id.textView_time)
    TextView textViewTime;
    @BindView(R.id.textView_heartValue)
    TextView textViewHeartValue;
    @BindView(R.id.textView_ActiveTime)
    TextView textViewActiveTime;
    @BindView(R.id.textView_tempValue)
    TextView textViewTempValue;
    @BindView(R.id.Blood_oxygen)
    TextView textViewBlood_oxygen;



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

    boolean isStartReal;
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_real_time_step);
        ButterKnife.bind(this);


        autoTestMode=AutoTestMode.AutoHeartRate;
        radioGroup_mian.setOnCheckedChangeListener(new RadioGroup.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(RadioGroup group, int checkedId) {
                switch (checkedId){
                    case R.id.heart:
                        autoTestMode=AutoTestMode.AutoHeartRate;
                        break;
                    case R.id.oxygen:
                        autoTestMode=AutoTestMode.AutoSpo2;
                        break;
                }

            }
        });
        _switch.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                open=isChecked;
            }
        });
        send.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                if(null!=secondText.getText()){
                    long time=Integer.parseInt(secondText.getText().toString());
                    sendValue(BleSDK.SetDeviceMeasurementWithType(autoTestMode,time,open));
                }

            }
        });
    }

    @OnClick({R.id.button_startreal})
    public void onViewClicked(View view) {
        switch (view.getId()){
            case R.id.button_startreal:
                isStartReal = !isStartReal;
                buttonStartreal.setText(isStartReal ? "Stop Measurement" : "Start Measurement");
                sendValue(BleSDK.RealTimeStep(isStartReal,SwitchCompatTemp.isChecked()));
                break;
        }
    }


    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType= getDataType(maps);
        Log.e("dataCallback",maps.toString());
        switch (dataType){
            case BleConst.RealTimeStep:
                Map<String, String> mmp = getData(maps);
                String step = mmp.get(DeviceKey.Step);//步数  Number of steps
                String cal = mmp.get(DeviceKey.Calories); // 卡路里 calorie
                String distance = mmp.get(DeviceKey.Distance);//距离 distance
                String time = mmp.get(DeviceKey.ExerciseMinutes);//锻炼分钟 Exercise minutes
                String ActiveTime = mmp.get(DeviceKey.ActiveMinutes);//活动分钟 Activity minutes
                String heart = mmp.get(DeviceKey.HeartRate);//心率 HeartRate
                String TEMP= mmp.get(DeviceKey.TempData);//温度 temperature
                String Blood_oxygen= mmp.get(DeviceKey.Blood_oxygen);//血氧
                textViewCal.setText(cal);
                textViewStep.setText(step);
                textViewDistance.setText(distance);
                textViewTime.setText(time);
                textViewHeartValue.setText(heart);
                textViewActiveTime.setText(ActiveTime);
                textViewTempValue.setText(TEMP);
                textViewBlood_oxygen.setText(Blood_oxygen);
                data_info.setText("");
                data_info.setText(maps.toString());
                break;

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
