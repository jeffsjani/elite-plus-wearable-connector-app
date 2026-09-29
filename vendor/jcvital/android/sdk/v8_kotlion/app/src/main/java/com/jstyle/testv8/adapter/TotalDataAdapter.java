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

public class TotalDataAdapter extends RecyclerView.Adapter {
    List<Map<String, String>> list = new ArrayList<>();

    public void setData(List<Map<String, String>> list){
        this.list=list;
        notifyDataSetChanged();
    }
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_totaldata, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        Map<String, String> map = list.get(position);
        String time=map.get(DeviceKey.ExerciseMinutes);
        String totalStep=map.get(DeviceKey.Step);
        String distance=map.get(DeviceKey.Distance);
        String cal=map.get(DeviceKey.Calories);
        String goal=map.get(DeviceKey.Goal);
        String date=map.get(DeviceKey.Date);
        viewHolder.textTotalTime.setText("Time: "+time+"s");
        viewHolder.textTotalDate.setText(date);
        viewHolder.textTotalTotalStep.setText("TotalStep: "+totalStep);
        viewHolder.textTotalDistance.setText("Distance: "+distance+" Km");
        viewHolder.textTotalCal.setText("Calories: "+cal+" Kcal");
        viewHolder.textTotalStep.setText("Goal: "+goal+"%");
    }

    @Override
    public int getItemCount() {
        return list.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView textTotalTime;
        TextView textTotalDate;
        TextView textTotalTotalStep;
        TextView textTotalDistance;
        TextView textTotalCal;
        TextView textTotalStep;

        ViewHolder(View view) {
            super(view);
            textTotalTime=view.findViewById(R.id.text_totalTime);
            textTotalDate=view.findViewById(R.id.text_totalDate);
            textTotalTotalStep=view.findViewById(R.id.text_totalTotalStep);
            textTotalDistance=view.findViewById(R.id.text_totalDistance);
            textTotalCal=view.findViewById(R.id.text_totalCal);
            textTotalStep=view.findViewById(R.id.text_totalGoal);
        }
    }
}
