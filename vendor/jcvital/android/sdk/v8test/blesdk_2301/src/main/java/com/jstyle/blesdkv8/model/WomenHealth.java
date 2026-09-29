package com.jstyle.blesdkv8.model;

/**
 * 女性健康
 */
public class WomenHealth {
    String userId="";
    String address="";
    String MenstrualPeriod_StartTime="1990-01-01";//经期开始时间  yyyy-MM-dd
    long MenstrualPeriod_Lenth=7;//经期长度，默认7天,2-8
    long MenstrualPeriod_Period=30;//经期周期，默认30天 21-35
    long FlowRate=-1;//流量 -1没有数据 0-4等级
    long Dysmenorrhea=-1;//痛经 -1没有数据 0-4等级
    boolean Love=false;//爱爱
    long mood=-1;//心情 -1没有数据 0-4等级
    boolean start=false;//是否是第一个日期
    boolean yuejinqi=false;//是否是月经期 经期七天
    boolean yuceyuejinqi=false;//预测月经期 经期前3天

    boolean yiyunqi=false;//是否是易孕期 经期七天后10天的日期
    boolean yuceyiyunqi=false;//预测易孕期 易孕期前3天
    boolean pailuanqi=false;//是否是排卵期 开始15后的一天

    boolean up=false;//上升期还是下降器


    boolean edidt=false;//是否被编辑过
    int day=0;//每次循环的第几天

    int[] Menstrual_symptoms = new int[32];//经期症状



    public WomenHealth() {
    }

    public WomenHealth(String userId, String address,
                       String MenstrualPeriod_StartTime, long MenstrualPeriod_Lenth,
                       long MenstrualPeriod_Period, long FlowRate, long Dysmenorrhea,
                       boolean Love, long mood, boolean start, boolean yuejinqi,
                       boolean yuceyuejinqi, boolean yiyunqi, boolean yuceyiyunqi,
                       boolean pailuanqi, boolean up, boolean edidt, int day,
                       int[] Menstrual_symptoms) {
        this.userId = userId;
        this.address = address;
        this.MenstrualPeriod_StartTime = MenstrualPeriod_StartTime;
        this.MenstrualPeriod_Lenth = MenstrualPeriod_Lenth;
        this.MenstrualPeriod_Period = MenstrualPeriod_Period;
        this.FlowRate = FlowRate;
        this.Dysmenorrhea = Dysmenorrhea;
        this.Love = Love;
        this.mood = mood;
        this.start = start;
        this.yuejinqi = yuejinqi;
        this.yuceyuejinqi = yuceyuejinqi;
        this.yiyunqi = yiyunqi;
        this.yuceyiyunqi = yuceyiyunqi;
        this.pailuanqi = pailuanqi;
        this.up = up;
        this.edidt = edidt;
        this.day = day;
        this.Menstrual_symptoms = Menstrual_symptoms;
    }



    public String getAddress() {
        return address;
    }

    public void setAddress(String address) {
        this.address = address;
    }

    public boolean isUp() {
        return up;
    }

    public void setUp(boolean up) {
        this.up = up;
    }

    public boolean isYuceyuejinqi() {
        return yuceyuejinqi;
    }

    public void setYuceyuejinqi(boolean yuceyuejinqi) {
        this.yuceyuejinqi = yuceyuejinqi;
    }

    public boolean isYuceyiyunqi() {
        return yuceyiyunqi;
    }

    public void setYuceyiyunqi(boolean yuceyiyunqi) {
        this.yuceyiyunqi = yuceyiyunqi;
    }

    public int getDay() {
        return day;
    }

    public void setDay(int day) {
        this.day = day;
    }

    public boolean isStart() {
        return start;
    }

    public boolean isYuejinqi() {
        return yuejinqi;
    }

    public void setYuejinqi(boolean yuejinqi) {
        this.yuejinqi = yuejinqi;
    }

    public boolean isEdidt() {
        return edidt;
    }

    public void setEdidt(boolean edidt) {
        this.edidt = edidt;
    }

    public boolean isYiyunqi() {
        return yiyunqi;
    }

    public void setYiyunqi(boolean yiyunqi) {
        this.yiyunqi = yiyunqi;
    }

    public boolean isPailuanqi() {
        return pailuanqi;
    }

    public void setPailuanqi(boolean pailuanqi) {
        this.pailuanqi = pailuanqi;
    }

    public void setStart(boolean start) {
        this.start = start;
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

    public long getMenstrualPeriod_Lenth() {
        return MenstrualPeriod_Lenth;
    }

    public void setMenstrualPeriod_Lenth(long menstrualPeriod_Lenth) {
        MenstrualPeriod_Lenth = menstrualPeriod_Lenth;
    }

    public long getMenstrualPeriod_Period() {
        return MenstrualPeriod_Period;
    }

    public void setMenstrualPeriod_Period(long menstrualPeriod_Period) {
        MenstrualPeriod_Period = menstrualPeriod_Period;
    }

    public long getFlowRate() {
        return FlowRate;
    }

    public void setFlowRate(long flowRate) {
        FlowRate = flowRate;
    }

    public long getDysmenorrhea() {
        return Dysmenorrhea;
    }

    public void setDysmenorrhea(long dysmenorrhea) {
        Dysmenorrhea = dysmenorrhea;
    }

    public boolean isLove() {
        return Love;
    }

    public void setLove(boolean love) {
        Love = love;
    }

    public long getMood() {
        return mood;
    }

    public void setMood(long mood) {
        this.mood = mood;
    }

    public int[] getMenstrual_symptoms() {
        return Menstrual_symptoms;
    }

    public void setMenstrual_symptoms(int[] menstrual_symptoms) {
        Menstrual_symptoms = menstrual_symptoms;
    }


    public boolean getLove() {
        return this.Love;
    }

    public boolean getStart() {
        return this.start;
    }

    public boolean getYuejinqi() {
        return this.yuejinqi;
    }

    public boolean getYiyunqi() {
        return this.yiyunqi;
    }

    public boolean getPailuanqi() {
        return this.pailuanqi;
    }

    public boolean getEdidt() {
        return this.edidt;
    }


    public boolean getYuceyuejinqi() {
        return this.yuceyuejinqi;
    }

    public boolean getYuceyiyunqi() {
        return this.yuceyiyunqi;
    }



    public boolean getUp() {
        return this.up;
    }



}



