package com.jstyle.blesdkv8.model;



/**
 * 怀孕周期
 * 算法 开始到生产 280天 每7天算一周
 */

public class PregnancyCycle {
    String address="";
    String userId="";
    String MenstrualPeriod_StartTime="1990-01-01";//经期开始时间  yyyy-MM-dd
    String DueDateTime="";//预产期
    long MenstrualPeriod_Period=30;//经期周期，默认30天 21-35


    public PregnancyCycle() {
    }


    public PregnancyCycle(String address, String userId,
                          String MenstrualPeriod_StartTime, String DueDateTime,
                          long MenstrualPeriod_Period) {
        this.address = address;
        this.userId = userId;
        this.MenstrualPeriod_StartTime = MenstrualPeriod_StartTime;
        this.DueDateTime = DueDateTime;
        this.MenstrualPeriod_Period = MenstrualPeriod_Period;
    }


    public String getUserId() {
        return userId;
    }

    public void setUserId(String userId) {
        this.userId = userId;
    }

    public String getMenstrualPeriod_StartTime() {
        return MenstrualPeriod_StartTime;
    }

    public void setMenstrualPeriod_StartTime(String menstrualPeriod_StartTime) {
        MenstrualPeriod_StartTime = menstrualPeriod_StartTime;
    }

    public String getDueDateTime() {
        return DueDateTime;
    }

    public void setDueDateTime(String dueDateTime) {
        DueDateTime = dueDateTime;
    }

    public long getMenstrualPeriod_Period() {
        return MenstrualPeriod_Period;
    }

    public void setMenstrualPeriod_Period(long menstrualPeriod_Period) {
        MenstrualPeriod_Period = menstrualPeriod_Period;
    }

    public String getAddress() {
        return address;
    }

    public void setAddress(String address) {
        this.address = address;
    }

    @Override
    public String toString() {
        return "PregnancyCycle{" +
                "address='" + address + '\'' +
                ", userId='" + userId + '\'' +
                ", MenstrualPeriod_StartTime='" + MenstrualPeriod_StartTime + '\'' +
                ", DueDateTime='" + DueDateTime + '\'' +
                ", MenstrualPeriod_Period=" + MenstrualPeriod_Period +
                '}';
    }
}



