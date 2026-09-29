package com.jstyle.test2025.activity;

import android.os.Bundle;
import android.support.v7.widget.DividerItemDecoration;
import android.support.v7.widget.GridLayoutManager;
import android.support.v7.widget.LinearLayoutManager;
import android.support.v7.widget.RecyclerView;
import android.view.View;
import android.widget.TextView;

import com.jstyle.blesdkv8.Util.BleSDK;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.blesdkv8.constant.DeviceKey;
import com.jstyle.blesdkv8.model.ExerciseMode;
import com.jstyle.test2025.R;
import com.jstyle.test2025.adapter.ActivityModeAdapter;

import java.util.Map;

import butterknife.BindArray;
import butterknife.BindView;
import butterknife.ButterKnife;
import butterknife.OnClick;
import io.reactivex.disposables.Disposable;

/**
 * 运动模式控制开关 (Sport mode control switch)
 */
public class ActivityModeActivity extends BaseActivity {
    @BindView(R.id.tv_activityModeData)
    TextView tvActivityModeData;
    @BindView(R.id.RecyclerView_mode)
    RecyclerView RecyclerViewMode;
    @BindArray(R.array.mode_name)
    String[] modeName;
    private ActivityModeAdapter activityModeAdapter;
    Disposable mDisposable;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_mode);
        ButterKnife.bind(this);
        init();
    }

    private void init() {
        GridLayoutManager linearLayoutManager = new GridLayoutManager(this, 3);
        linearLayoutManager.setOrientation(LinearLayoutManager.VERTICAL);
        RecyclerViewMode.setLayoutManager(linearLayoutManager);
        activityModeAdapter = new ActivityModeAdapter(modeName);
        RecyclerViewMode.setAdapter(activityModeAdapter);
        DividerItemDecoration dividerItemDecoration = new DividerItemDecoration(this, DividerItemDecoration.HORIZONTAL);
        DividerItemDecoration dividerItemDecorationVERTICAL = new DividerItemDecoration(this, DividerItemDecoration.VERTICAL);
        RecyclerViewMode.addItemDecoration(dividerItemDecoration);
        RecyclerViewMode.addItemDecoration(dividerItemDecorationVERTICAL);
    }

    int mode;

    @OnClick({R.id.bt_startMode, R.id.suspend, R.id.continues, R.id.bt_stopMode,R.id.bt_Find})
    public void onViewClicked(View view) {
        switch (view.getId()) {
            case R.id.bt_startMode://开始运动 start exercising
                mode = activityModeAdapter.getSelectPosition();
                if (mode == -1) return;
                if (ExerciseMode.Mode_Breathing_Training == mode) {//如果是冥想，status 级别0,1,2，冥想分钟，开始，暂停，继续，停止等
                    sendValue(BleSDK.setExerciseModeByBreath(0, 2, ExerciseMode.Status_START));
                } else {
                    sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_START));
                }

                break;
            case R.id.suspend://暂停运动 Pause exercise
                mode = activityModeAdapter.getSelectPosition();
                if (mode == -1) return;
                if (ExerciseMode.Mode_Breathing_Training  == mode) {
                    sendValue(BleSDK.setExerciseModeByBreath(0, 2, ExerciseMode.Status_PAUSE));
                } else {
                    sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_PAUSE));
                }
                break;
            case R.id.continues://继续运动 keep exercising
                mode = activityModeAdapter.getSelectPosition();
                if (mode == -1) return;
                if (6 == mode) {
                    sendValue(BleSDK.setExerciseModeByBreath(0, 2, ExerciseMode.Status_CONTUINE));
                } else {
                    sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_CONTUINE));
                }
                break;
            case R.id.bt_stopMode://结束运动 end the movement
                mode = activityModeAdapter.getSelectPosition();
                if (mode == -1) return;
                if (ExerciseMode.Mode_Breathing_Training  == mode) {
                    sendValue(BleSDK.setExerciseModeByBreath(0, 2, ExerciseMode.Status_FINISH));
                } else {
                    sendValue(BleSDK.EnterActivityMode(2,mode, ExerciseMode.Status_FINISH));
                }

                break;
            case R.id.bt_Find:
                sendValue(BleSDK.FindActivityMode());
                break;
        }

    }


    @Override
    public void dataCallback(Map<String, Object> maps) {
        super.dataCallback(maps);
        String dataType= getDataType(maps);
        boolean finish=getEnd(maps);
        switch (dataType){
            case BleConst.FindActivityMode:
                tvActivityModeData.setText(maps.toString());
                break;
            case BleConst.EnterActivityMode:
                Map<String,String>mapEnterActivityMode= getData(maps);
                int status = Integer.parseInt(mapEnterActivityMode.get(DeviceKey.enterActivityModeSuccess));
                if(0==status){
                    showToast("Please quit the exercise");
                }
                break;
            case BleConst.SportData:
                Map<String,String>map= getData(maps);
                String step = map.get(DeviceKey.Step);
                String cal = map.get(DeviceKey.Calories);
                String heart = map.get(DeviceKey.HeartRate);
                StringBuffer stringBuffer=new StringBuffer();
                stringBuffer.append("Step: "+step).append("\n")
                        .append("Cal: "+cal).append("\n")
                        .append("HeartRate: "+heart);
                tvActivityModeData.setText(stringBuffer.toString());
                break;
    }}


    @Override
    protected void onDestroy() {
        super.onDestroy();

    }
}
