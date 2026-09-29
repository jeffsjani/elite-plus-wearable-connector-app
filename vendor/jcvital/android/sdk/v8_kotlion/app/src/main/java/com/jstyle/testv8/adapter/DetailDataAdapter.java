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

public class DetailDataAdapter extends RecyclerView.Adapter {
    List<Map<String, String>> list = new ArrayList<>();

    private final static int View_Type_Empty = 2;
    private final static int View_Type_Sleep = 1;
    private final static int View_Type_Step = 0;
    private int sendCmdState;
    public static final int GET_STEP_DETAIL=0;
    public static final int GET_SLEEP_DETAIL=1;

    public void setData(List<Map<String, String>> list,int type) {
        this.list = list;
        this.sendCmdState=type;
        notifyDataSetChanged();
    }
    public void Clear() {
        this.list.clear();
        notifyDataSetChanged();
    }
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        switch (viewType) {
            case View_Type_Empty:
                View viewEmpty = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_empty, parent, false);
                return new EmptyViewHolder(viewEmpty);
            case View_Type_Sleep:
                View viewSleep = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_detailsleepdata, parent, false);
                return new SleepViewHolder(viewSleep);
            case View_Type_Step:
                View viewStep = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_detaildata, parent, false);
                return new ViewHolder(viewStep);
            default:
                View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_empty, parent, false);
                return new EmptyViewHolder(view);
        }

    }

    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, int position) {
        switch (getItemViewType(position)) {
            case View_Type_Empty:
                bindEmptyData();
                break;
            case View_Type_Sleep:
                bindSleepData(holder,position);
                break;
            case View_Type_Step:
                bindStepData(holder,position);
                break;
        }
    }

    private void bindStepData(RecyclerView.ViewHolder holder, int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        Map<String, String> map = list.get(position);
        String time = map.get(DeviceKey.Date);
        String totalStep = map.get(DeviceKey.KDetailMinterStep);
        String distance = map.get(DeviceKey.Distance);
        String cal = map.get(DeviceKey.Calories);
        String detailStep = map.get(DeviceKey.ArraySteps).replace(" ", ",");
        viewHolder.textDetailTime.setText("Time: " + time);
        viewHolder.textDetailTotalStep.setText("TotalStep: " + totalStep);
        viewHolder.textDetailDistance.setText("Distance: " + distance + " km");
        viewHolder.textDetailCal.setText("Calories: " + cal + " kcal");
        viewHolder.textDetailStep.setText("DetailStep: " + detailStep);
    }

    private void bindSleepData(RecyclerView.ViewHolder holder, int position) {
        SleepViewHolder viewHolder = (SleepViewHolder) holder;
        Map<String, String> map = list.get(position);
        viewHolder.textSleepData.setText(map.toString());
    }

    private void bindEmptyData() {

    }

    @Override
    public int getItemCount() {
        return list.size() == 0 ? 1 : list.size();
    }

    @Override
    public int getItemViewType(int position) {
        int type = 0;
        if (list.size() == 0) return View_Type_Empty;
        switch (sendCmdState) {
            case GET_STEP_DETAIL:
                type = View_Type_Step;
                break;
            case GET_SLEEP_DETAIL:
                type = View_Type_Sleep;
                break;
        }
        return type;
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView textDetailTime;
        TextView textDetailTotalStep;
        TextView textDetailDistance;
        TextView textDetailCal;
        TextView textDetailStep;

        ViewHolder(View view) {
            super(view);
            textDetailTime=view.findViewById(R.id.text_detailTime);
            textDetailTotalStep=view.findViewById(R.id.text_detailTotalStep);
            textDetailDistance=view.findViewById(R.id.text_detailDistance);
            textDetailCal=view.findViewById(R.id.text_detailCal);
            textDetailStep=view.findViewById(R.id.text_detailStep);
        }
    }

    static class SleepViewHolder extends RecyclerView.ViewHolder {
        TextView textSleepData;
        SleepViewHolder(View view) {
            super(view);
            textSleepData=view.findViewById(R.id.text_detailsleepdata);

        }
    }

    static class EmptyViewHolder extends RecyclerView.ViewHolder {

        TextView textSleepTime;
        EmptyViewHolder(View view) {
            super(view);
            textSleepTime=view.findViewById(R.id.tv_empty);

        }
    }
}
