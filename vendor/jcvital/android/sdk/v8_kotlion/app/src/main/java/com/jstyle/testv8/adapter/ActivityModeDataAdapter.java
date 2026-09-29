package com.jstyle.testv8.adapter;


import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.recyclerview.widget.RecyclerView;

import com.jstyle.blesdkv8.constant.DeviceKey;
import com.jstyle.testv8.R;


import java.util.ArrayList;
import java.util.List;
import java.util.Map;


/**
 * Created by Administrator on 2018/4/26.
 */

public class ActivityModeDataAdapter extends RecyclerView.Adapter {
    List<Map<String, String>> list = new ArrayList<>();
    String[]modeNames;
    public ActivityModeDataAdapter(String[]modeNames) {
       this.modeNames=modeNames;
    }

    public void setData(List<Map<String, String>> list) {
        this.list = list;
        notifyDataSetChanged();
    }

    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_activitymodedata, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        Map<String, String> map = list.get(position);
        String date = map.get(DeviceKey.Date);
        String time = map.get(DeviceKey.ActiveMinutes);
        String totalStep = map.get(DeviceKey.Step);
        String distance = map.get(DeviceKey.Distance);
        String cal = map.get(DeviceKey.Calories);
        String heartRate = map.get(DeviceKey.HeartRate);
        String pace = map.get(DeviceKey.Pace);
        String mode = map.get(DeviceKey.ActivityMode);
        StringBuffer stringBuffer=new StringBuffer();
        stringBuffer.append("mode: "+modeNames[mode.equals("6")?3:Integer.valueOf(mode)]).append("\n")
                .append("Time: "+time+" s").append("\n")
                .append("TotalStep: " + totalStep).append("\n")
                .append("Distance: " + distance + " Km").append("\n")
                .append("Calories: " + cal + " Kcal").append("\n")
                .append("HeartRate: "+heartRate+" Bpm").append("\n")
                .append("Pace: "+pace);

        viewHolder.textTotalDate.setText(date);
        viewHolder.textActivityModeData.setText(stringBuffer.toString());


    }

    @Override
    public int getItemCount() {
        return list.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView textTotalDate;
        TextView textActivityModeData;
        ViewHolder(View view) {
            super(view);
            textTotalDate= view.findViewById(R.id.text_totalDate);
            textActivityModeData= view.findViewById(R.id.text_activityModeData);
        }
    }
}
