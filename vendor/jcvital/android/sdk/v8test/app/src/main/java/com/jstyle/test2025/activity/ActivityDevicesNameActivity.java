package com.jstyle.test2025.activity;

import android.os.Bundle;
import android.text.TextUtils;
import android.view.View;
import android.widget.EditText;
import android.widget.TextView;

import com.jstyle.blesdkv8.Util.BleSDK;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.test2025.R;

import java.util.Map;

import butterknife.BindView;
import butterknife.ButterKnife;
import butterknife.OnClick;

public class ActivityDevicesNameActivity extends BaseActivity {
    @BindView(R.id.ed_content_name)
    EditText ed_content_name;
    @BindView(R.id.info)
    TextView info;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_set);
        ButterKnife.bind(this);
    }

    @OnClick({R.id.set, R.id.get})
    public void onViewClicked(View view) {
        switch (view.getId()) {
            case R.id.set:
                if(TextUtils.isEmpty(ed_content_name.getText())){
                    showToast("设备名未输入 Device name not entered");
                    return;
                }
                String NAME=ed_content_name.getText().toString();
                sendValue(BleSDK.SetDeviceName(NAME));
                break;
            case R.id.get:
                sendValue(BleSDK.GetDeviceName());
                break;

        }}


    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType= getDataType(maps);
        boolean finish=getEnd(maps);
        switch (dataType){
            case BleConst.CMD_Set_Name:
               if(null!=info){
                   info.setText(maps.toString());
               }
                break;
            case BleConst.CMD_Get_Name:
                if(null!=info){
                    info.setText(maps.toString());
                }
                break;
        }}

}
