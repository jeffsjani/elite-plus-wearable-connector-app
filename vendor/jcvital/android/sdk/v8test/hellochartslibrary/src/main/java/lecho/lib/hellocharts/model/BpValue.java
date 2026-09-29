package lecho.lib.hellocharts.model;

import android.graphics.Color;

/**
 * Created by Administrator on 2018/9/6.
 */

public class BpValue {
    String date;
    String showValue;

    public String getDate() {
        return date;
    }

    public void setDate(String date) {
        this.date = date;
    }

    public String getShowValue() {
        showValue=getHighValue()+"/"+getLowValue();
        return showValue;
    }

    public void setShowValue(String showValue) {
        this.showValue = showValue;
    }

    public final static int defaultHighValueColor = Color.parseColor("#d3042c");
    public final static int defaultLowValueColor = Color.parseColor("#264cef");
    public final static int defaultErrorValueColor = Color.parseColor("#f5eb6b");
    int HighValueColor = defaultHighValueColor;
    int LowValueColor = defaultLowValueColor;
    int ErrorValueColor = defaultErrorValueColor;

    int highValue;
    int lowValue;

    int errorLowValue=60;
    int errorHighValue=139;
    int bgColor=Color.parseColor("#c8c8c6");

    public int getBgColor() {
        return bgColor;
    }

    public void setBgColor(int bgColor) {
        this.bgColor = bgColor;
    }

    public BpValue(int highValue, int lowValue) {
        this.highValue = highValue;
        this.lowValue = lowValue;
    }

    public int getHighValue() {
        return highValue;
    }

    public void setHighValue(int highValue) {
        this.highValue = highValue;
    }

    public int getLowValue() {
        return lowValue;
    }

    public void setLowValue(int lowValue) {
        this.lowValue = lowValue;
    }

    public int getHighValueColor() {
        return highValue>=errorHighValue?ErrorValueColor:HighValueColor;
    }

    public void setHighValueColor(int highValueColor) {
        HighValueColor = highValueColor;
    }

    public int getLowValueColor() {
        return lowValue>=errorLowValue?LowValueColor:ErrorValueColor;
    }

    public void setLowValueColor(int lowValueColor) {
        LowValueColor = lowValueColor;
    }

    public int getErrorValueColor() {
        return ErrorValueColor;
    }

    public void setErrorValueColor(int errorValueColor) {
        ErrorValueColor = errorValueColor;
    }

    public int getBgTop(){
        if(highValue==0)return errorHighValue;
        return highValue<=errorHighValue?errorHighValue:highValue;
    }
    public int getBgBottom(){
        if(lowValue==0)return  errorLowValue;
        return lowValue<=errorLowValue?lowValue:errorLowValue;
    }
}
