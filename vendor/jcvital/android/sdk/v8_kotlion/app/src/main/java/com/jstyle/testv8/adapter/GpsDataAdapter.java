package com.jstyle.testv8.adapter;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;


import androidx.recyclerview.widget.RecyclerView;

import com.jstyle.testv8.R;

import java.util.ArrayList;
import java.util.List;



/**
 * Created by Administrator on 2018/4/26.
 */

public class GpsDataAdapter extends RecyclerView.Adapter {
    List<String> list = new ArrayList<>();

    public void setData(List<String> list) {
        this.list = list;
        notifyDataSetChanged();
    }
    public void ADDData(String list) {
        this.list.add(list);
        notifyDataSetChanged();
    }
    public void Notify() {
        notifyDataSetChanged();
    }
    public void Clear() {
        list=new ArrayList<>();
        notifyDataSetChanged();
    }
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_activitymodedataer, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        String map = list.get(position);
        viewHolder.textTotalDate.setText(map);
    }

    @Override
    public int getItemCount() {
        return list.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView textTotalDate;
        ViewHolder(View view) {
            super(view);
            textTotalDate=view.findViewById(R.id.text_totalDate);
        }
    }
}
