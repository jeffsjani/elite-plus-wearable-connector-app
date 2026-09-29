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

public class HeartRateDataAdapter extends RecyclerView.Adapter {
    List<Map<String, String>> list = new ArrayList<>();
        public static final int GET_HEART_DATA=0;
        public static final int GET_ONCE_HEARTDATA=1;
    private final static int View_Type_Empty = 2;
    private final static int View_Type_OnceHeart = 1;
    private final static int View_Type_HistoryHeart = 0;
    private int sendCmdState;

    public void setData(List<Map<String, String>> list, int type) {
        this.list = list;
        this.sendCmdState = type;
        notifyDataSetChanged();
    }


    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        switch (viewType) {
            case View_Type_Empty:
                View viewEmpty = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_empty, parent, false);
                return new EmptyViewHolder(viewEmpty);
            case View_Type_OnceHeart:
                View viewSleep = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_onceheartdata, parent, false);
                return new OnceHeartViewHolder(viewSleep);
            case View_Type_HistoryHeart:
                View viewStep = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_hearthistorydata, parent, false);
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
            case View_Type_OnceHeart:
                bindOnceHeartData(holder,position);
                break;
            case View_Type_HistoryHeart:
                bindHistoryHeartData(holder,position);
                break;
        }
    }

    private void bindHistoryHeartData(RecyclerView.ViewHolder holder, int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        Map<String, String> map = list.get(position);
        String time = map.get(DeviceKey.Date);
        String heartValue = map.get(DeviceKey.ArrayDynamicHR);
        viewHolder.textDetailTime.setText("Time: " + time);
        viewHolder.textHistoryHeartValue.setText("HeartRate: " +heartValue);
    }

    private void bindOnceHeartData(RecyclerView.ViewHolder holder, int position) {
        OnceHeartViewHolder viewHolder = (OnceHeartViewHolder) holder;
        Map<String, String> map = list.get(position);
        String time = map.get(DeviceKey.Date);
        String heartData = map.get(DeviceKey.StaticHR);
        viewHolder.textSleepData.setText(heartData);
        viewHolder.textSleepTime.setText(time);
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
            case GET_HEART_DATA:
                type = View_Type_HistoryHeart;
                break;
            case GET_ONCE_HEARTDATA:
                type = View_Type_OnceHeart;
                break;
        }
        return type;
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView textDetailTime;
        TextView textHistoryHeartValue;


        ViewHolder(View view) {
            super(view);
            textDetailTime=view.findViewById(R.id.text_historyHeartTime);
            textHistoryHeartValue=view.findViewById(R.id.text_historyHeartValue);
        }
    }

    static class OnceHeartViewHolder extends RecyclerView.ViewHolder {
        TextView textSleepTime;
        TextView textSleepData;


        OnceHeartViewHolder(View view) {
            super(view);
            textSleepTime=view.findViewById(R.id.text_onceHeartTime);
            textSleepData=view.findViewById(R.id.item_onceHeartValue);

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
