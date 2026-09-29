package com.jstyle.testv8.adapter;


import android.annotation.SuppressLint;
import android.view.LayoutInflater;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;

import androidx.annotation.NonNull;
import androidx.recyclerview.widget.RecyclerView;
import com.jstyle.testv8.R;


/**
 * Created by Administrator on 2018/4/9.
 */

public class MainAdapter extends RecyclerView.Adapter {
    String[]arrays;
    onItemClickListener onItemClickListener=null;
    public MainAdapter(String[]arrays,MainAdapter.onItemClickListener onItemClickListener) {
        this.onItemClickListener=onItemClickListener;
        this.arrays=arrays;
    }

    @NonNull
    @Override
    public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int viewType) {
        CmdViewHolder cmdViewHolder=null;
        View view= LayoutInflater.from(parent.getContext()).inflate(R.layout.item_cmd,parent,false);
        cmdViewHolder= new CmdViewHolder(view);
        return cmdViewHolder;
    }

    @Override
    public void onBindViewHolder(RecyclerView.ViewHolder holder, @SuppressLint("RecyclerView") int position) {

        CmdViewHolder cmdViewHolder=(CmdViewHolder)holder;
        cmdViewHolder.bt_cmd.setEnabled(enable);
        cmdViewHolder.bt_cmd.setText(arrays[position]);
        cmdViewHolder.bt_cmd.setOnClickListener(new View.OnClickListener() {
            @Override
            public void onClick(View v) {
                onItemClickListener.onItemClick(position);
            }
        });
    }

    private boolean enable;
    public void setEnable(boolean enable){
        this.enable=enable;
        notifyDataSetChanged();
    }




    @Override
    public int getItemCount() {
        return arrays==null?0:arrays.length;
    }
    static class CmdViewHolder extends RecyclerView.ViewHolder{

        Button bt_cmd;
        public CmdViewHolder(View itemView) {
            super(itemView);
            bt_cmd=itemView.findViewById(R.id.button_cmd);
        }
    }
    public interface onItemClickListener{
         void onItemClick(int position);
    }
}
