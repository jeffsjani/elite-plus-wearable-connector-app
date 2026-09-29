package com.jstyle.test2025.activity;

import android.os.Bundle;
import android.util.Log;
import android.view.View;
import android.widget.RadioGroup;
import android.widget.TextView;

import com.jstyle.blesdkv8.Util.BleSDK;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.test2025.R;

import java.util.Map;

import butterknife.BindView;
import butterknife.ButterKnife;
import butterknife.OnClick;

/**
 *
 */
public class Basic_parameters_of_equipmentActivity extends BaseActivity {
    @BindView(R.id.info)
    TextView info;
    @BindView(R.id.radioGroup_mian)
    RadioGroup radioGroup_mian;
    @BindView(R.id.radioGroup_mian2)
    RadioGroup radioGroup_mian2;
    boolean Is_the_sports_mode_flashing=true;
    boolean Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode=true;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_base);
        ButterKnife.bind(this);
        radioGroup_mian.check( R.id.radio_yes);
        radioGroup_mian2.check( R.id.radio_yes2);
        radioGroup_mian.setOnCheckedChangeListener((group, checkedId) -> {
            switch (checkedId){
                case R.id.radio_yes:
                    Is_the_sports_mode_flashing=true;
                    break;
                case R.id.radio_no:
                    Is_the_sports_mode_flashing=false;
                    break;
            }
        });

        radioGroup_mian2.setOnCheckedChangeListener((group, checkedId) -> {
            switch (checkedId){
                case R.id.radio_yes2:
                    Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode=true;
                    break;
                case R.id.radio_no2:
                    Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode=false;
                    break;
            }
        });
    }

    @OnClick({R.id.set,R.id.get})
    public void onViewClicked(View view) {
        switch (view.getId()){
            case R.id.set:
                sendValue(BleSDK.SetBasic_parameters_of_equipment(Is_the_sports_mode_flashing,Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode));
                break;
            case R.id.get:
                sendValue(BleSDK.GetBasic_parameters_of_equipment());
                break;
        }
    }


    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType= getDataType(maps);
        Log.e("dataCallback",maps.toString());
        switch (dataType){
            case BleConst.SetBasic_parameters_of_equipment:
            case BleConst.GetBasic_parameters_of_equipment:
            if(null!=info){
                info.setText(maps.toString());
            }
                break;
        }}

}
