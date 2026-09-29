package com.jstyle.testv8.adapter;

import android.graphics.Color;

import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;

import androidx.recyclerview.widget.RecyclerView;

import com.jstyle.blesdkv8.model.ExerciseMode;
import com.jstyle.testv8.R;



/**
 * Created by Administrator on 2018/11/19.
 */

public class ActivityModeAdapter extends RecyclerView.Adapter {
    String[] modeNames;


    public ActivityModeAdapter(String[] modeNames) {
        this.modeNames = modeNames;
    }

    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_selectactivitymode, parent, false);
        return new ViewHolder(view);
    }

    int selectPosition=-1;
    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, final int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        viewHolder.radioButton.setText(modeNames[position]);
        viewHolder.itemView.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                selectPosition=position;
                notifyDataSetChanged();
            }
        });
        viewHolder.radioButton.setTextColor(selectPosition==position? Color.RED:Color.GRAY);
    }

    public int getSelectPosition(){
        if(selectPosition==-1)return -1;
        return ExerciseMode.modes[selectPosition];
    }
    @Override
    public int getItemCount() {
        return modeNames.length;
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView radioButton;
        ViewHolder(View view) {
            super(view);
            radioButton=view.findViewById(R.id.radioButton);
        }
    }
}
