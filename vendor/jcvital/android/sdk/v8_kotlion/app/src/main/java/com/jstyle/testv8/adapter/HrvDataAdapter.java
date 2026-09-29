package com.jstyle.testv8.adapter;


import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.TextView;
import androidx.recyclerview.widget.RecyclerView;
import com.jstyle.testv8.R;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;


/**
 * Created by Administrator on 2018/4/26.
 */

public class HrvDataAdapter extends RecyclerView.Adapter {
    List<Map<String, String>> list = new ArrayList<>();
    private final static int View_Type_Empty = 1;
    private final static int View_Type_HrvData = 0;

    public void setData(List<Map<String, String>> list) {
        this.list = list;
        notifyDataSetChanged();
    }
    public void addData(List<Map<String, String>> list) {
        this.list.addAll(list);
        notifyDataSetChanged();
    }
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        switch (viewType) {
            case View_Type_Empty:
                View viewEmpty = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_empty, parent, false);
                return new EmptyViewHolder(viewEmpty);
            case View_Type_HrvData:
                View viewStep = LayoutInflater.from(parent.getContext()).inflate(R.layout.item_hrvdata, parent, false);
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
                break;
            case View_Type_HrvData:
                bindHrvData(holder, position);
                break;

        }
    }

    private void bindHrvData(RecyclerView.ViewHolder holder, int position) {
        ViewHolder viewHolder = (ViewHolder) holder;
        Map<String, String> map = list.get(position);
        viewHolder.text_all.setText(map.toString());

    }

    @Override
    public int getItemCount() {
        return list.size()==0?1:list.size();
    }

    @Override
    public int getItemViewType(int position) {
        int type = View_Type_HrvData;
        if (list.size() == 0) return View_Type_Empty;
        return type;
    }

    static class ViewHolder extends RecyclerView.ViewHolder {
        TextView text_all;
        ViewHolder(View view) {
            super(view);
            text_all=view.findViewById(R.id.text_all);
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
