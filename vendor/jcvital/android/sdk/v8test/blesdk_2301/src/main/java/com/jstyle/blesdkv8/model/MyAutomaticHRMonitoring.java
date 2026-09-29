package com.jstyle.blesdkv8.model;

/**
 * Created by Administrator on 2018/1/16.
 */

public class MyAutomaticHRMonitoring extends SendData{
    int open;//1 开启整个时间段都测量 2时间段内间隔测量 0关闭  1. Measure the entire time period. 2. Measure the interval within the time period. 0. Close
    // 1. Enable measurement throughout the entire time period 2. Measure intervals within the time period 0. Close
    int startHour;//开始小时 Starting hours
    int startMinute;//开始分钟  Start minute
    int endHour;//结束小时  End Hour
    int endMinute;//结束分钟  End minute
    int week;//星期一到星期日 开启选择  Monday to Sunday open selection
    int time;//多少时间测试一次，单位是分钟。 How many times does it take to test, in minutes.

    public int getTime() {
        return time;
    }

    public void setTime(int time) {
        this.time = time;
    }

    public int getOpen() {
        return open;
    }

    public void setOpen(int open) {
        this.open = open;
    }

    public int getStartHour() {
        return startHour;
    }

    public void setStartHour(int startHour) {
        this.startHour = startHour;
    }

    public int getStartMinute() {
        return startMinute;
    }

    public void setStartMinute(int startMinute) {
        this.startMinute = startMinute;
    }

    public int getEndHour() {
        return endHour;
    }

    public void setEndHour(int endHour) {
        this.endHour = endHour;
    }

    public int getEndMinute() {
        return endMinute;
    }

    public void setEndMinute(int endMinute) {
        this.endMinute = endMinute;
    }

    public int getWeek() {
        return week;
    }

    public void setWeek(int week) {
        this.week = week;
    }

    @Override
    public String toString() {
        return "MyAutomaticHRMonitoring{" +
                "open=" + open +
                ", startHour=" + startHour +
                ", startMinute=" + startMinute +
                ", endHour=" + endHour +
                ", endMinute=" + endMinute +
                ", week=" + week +
                ", time=" + time +
                '}';
    }
}
