package com.jstyle.testv8.adapter;

import android.text.TextUtils;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;
import android.widget.TextView;

import androidx.appcompat.widget.SwitchCompat;
import androidx.recyclerview.widget.RecyclerView;

import com.jstyle.blesdkv8.model.Clock;
import com.jstyle.blesdkv8.other.ResolveUtil;
import com.jstyle.testv8.R;



import java.util.ArrayList;
import java.util.List;

/**
 * Created by Administrator on 2018/4/26.
 */

public class ClockAdapter extends RecyclerView.Adapter {
    List<Clock> list = new ArrayList<>();
    String[]array;
    onClockItemClickListener onClockItemClickListener;
    private boolean deleteEnable;

    public ClockAdapter(onClockItemClickListener onClockItemClickListener) {
        this.onClockItemClickListener=onClockItemClickListener;
    }

    public void setData(String[]array, Clock clock){
        this.list.add(clock);
        this.array=array;
        notifyDataSetChanged();
    }
    public void clear(){
        this.list.clear();
        notifyDataSetChanged();
    }
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        View view = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_clock, parent, false);
        return new ViewHolder(view);
    }

    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, final int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
       final Clock clock = list.get(position);
        String hour = String.format("%02d", clock.getHour());
        String min = String.format("%02d", clock.getMinute());
        int week = clock.getWeek();
        boolean enable=clock.isEnable();
        String clockTime = hour + ":" + min;
        String weekString= ResolveUtil.getByteString((byte) week);
        String[] weekStringArray = weekString.split("-");
        String showWeek = "";
        for (int i = 0; i < 7; i++) {
            String weekEnable = weekStringArray[i];
            if (weekEnable.equals("1")) {
                showWeek += array[i];
                showWeek += ",";
            }
        }

        viewHolder.itemView.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onClockItemClickListener.onItemClick(clock);
            }
        });
        viewHolder.textClockTime.setText(clockTime);

        if(!TextUtils.isEmpty(showWeek))
        viewHolder.textWeek.setText(showWeek.substring(0,showWeek.length()-1));


        viewHolder.switchCompatClock.setChecked(enable);
        viewHolder.ivClockDelete.setVisibility(deleteEnable ? View.VISIBLE : View.GONE);
        viewHolder.ivClockDelete.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                list.remove(position);
                notifyItemRemoved(position);
                notifyItemRangeRemoved(0,list.size());
                onClockItemClickListener.onDelete(clock);
            }
        });
    }
    public void enableDelete() {
        deleteEnable = !deleteEnable;
        notifyDataSetChanged();
    }
    @Override
    public int getItemCount() {
        return list.size();
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView textClockTime;
        TextView textWeek;
        ImageView ivClockDelete;
        SwitchCompat switchCompatClock;


        ViewHolder(View view) {
            super(view);
            textClockTime=view.findViewById(R.id.textView_clockitem_time);
            textWeek=view.findViewById(R.id.textView_clockitem_week);
            ivClockDelete=view.findViewById(R.id.iv_clock_delete);
            switchCompatClock=view.findViewById(R.id.clocklist_switch);
        }
    }
    public interface onClockItemClickListener{
         void onItemClick(Clock clock);
         void onDelete(Clock clock);
         void onUpdate(List<Clock> clockList);
    }
    public List<Clock> getClockList(){
        return this.list;
    }
}
