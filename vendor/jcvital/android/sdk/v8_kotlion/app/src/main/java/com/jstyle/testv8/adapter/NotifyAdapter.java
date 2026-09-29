package com.jstyle.testv8.adapter;

import android.annotation.SuppressLint;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.RadioButton;

import androidx.recyclerview.widget.RecyclerView;

import com.jstyle.testv8.R;


/**
 * Created by Administrator on 2018/4/27.
 */

public class NotifyAdapter extends RecyclerView.Adapter {
    String[]arrays;
   // int[]positions;
    public NotifyAdapter(String[]arrays) {
        this.arrays=arrays;
     //   this.positions=position;
    }

    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_notify, parent, false);
        return new ViewHolder(view);
    }

    private static final String TAG = "ClockWeekAdapter";
    int checkedPosition=0;
    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, @SuppressLint("RecyclerView") final int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        viewHolder.checkbox_clock_week.setText(arrays[position]);
        viewHolder.itemView.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                checkedPosition=position;
                  notifyDataSetChanged();
            }
        });
        viewHolder.checkbox_clock_week.setChecked(position==checkedPosition);
    }

    public int getCheck(){
        return checkedPosition;
    }
    @Override
    public int getItemCount() {
        return arrays==null?0:arrays.length;
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        RadioButton checkbox_clock_week;
        ViewHolder(View view) {
            super(view);
            checkbox_clock_week=view.findViewById(R.id.item_radio_notify);
        }
    }
}
