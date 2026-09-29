package com.jstyle.testv8.adapter;

import android.annotation.SuppressLint;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.CheckBox;
import android.widget.CompoundButton;

import androidx.recyclerview.widget.RecyclerView;

import com.jstyle.testv8.R;

/**
 * Created by Administrator on 2018/4/27.
 */

public class ClockWeekAdapter extends RecyclerView.Adapter {
    String[]arrays;
    int[]positions;
    public ClockWeekAdapter(String[]arrays,int[]position) {
        this.arrays=arrays;
        this.positions=position;
    }

    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_clock_week, parent, false);
        return new ViewHolder(view);
    }


    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, @SuppressLint("RecyclerView") final int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        viewHolder.checkbox_clock_week.setText(arrays[position]);
        viewHolder.checkbox_clock_week.setOnCheckedChangeListener(new CompoundButton.OnCheckedChangeListener() {
            @Override
            public void onCheckedChanged(CompoundButton buttonView, boolean isChecked) {
                positions[position]=isChecked?1:0;
            }
        });
        viewHolder.checkbox_clock_week.setChecked(positions[position]==1);
    }

    public int[] getCheckWeek(){
        return positions;
    }
    @Override
    public int getItemCount() {
        return arrays==null?0:arrays.length;
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        CheckBox checkbox_clock_week;
        ViewHolder(View view) {
            super(view);
            checkbox_clock_week=view.findViewById(R.id.checkbox_clock_week);
        }
    }
}
