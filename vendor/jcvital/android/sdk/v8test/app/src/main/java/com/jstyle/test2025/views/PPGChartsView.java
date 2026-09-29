package com.jstyle.test2025.views;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Looper;
import android.util.AttributeSet;
import android.view.View;



import java.util.ArrayList;
import java.util.List;

public class PPGChartsView extends View {
    private float showTime;
    private int singleNumber;
    private float minValue;
    private float maxValue;
    private int maxCount;
    private int blankCount = 20;
    private float lineWidth;
    private int lineColor = Color.parseColor("#588BF8");
    private final List<Float> allDatas = new ArrayList<>();
    private int index = 0;
    private boolean start = false;
    private int dataBase;
    private float chartWidth;
    private float chartHeight;

    private Paint gridPaint;
    private Paint shadowPaint;
    private Paint linePaint;
    private Path linePath;
    private Paint cicle;//圆形光标
    private Paint cicleER;//圆形光标
    private static final int Fengedian=2;//分割点  默认2

    private Rect rect3;//透明范围绘制区域

    public PPGChartsView(Context context) {
        super(context);
        init(null,context);
    }

    public PPGChartsView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init(attrs,context);
    }

    public PPGChartsView(Context context, int singleNumber, int maxSeconds) {
        super(context);
        this.singleNumber = singleNumber;
        this.showTime = maxSeconds;
        init(null,context);
    }

    private void init(AttributeSet attrs,Context context) {
        // initialize defaults
        if (showTime == 0) showTime = 5;
        if (singleNumber == 0) singleNumber = 50;
        maxCount = (int) (showTime * singleNumber);
        lineWidth =1f;
        gridPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        gridPaint.setStyle(Paint.Style.STROKE);
        gridPaint.setStrokeWidth(0.3f);
        gridPaint.setColor(Color.argb(51, 1, 52, 73));

        linePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
        linePaint.setStyle(Paint.Style.STROKE);
        linePaint.setStrokeWidth(lineWidth);
        linePaint.setColor(lineColor);
        linePaint.setStrokeJoin(Paint.Join.ROUND);


        this.shadowPaint = new Paint();
        this.shadowPaint.setColor(Color.WHITE);
        this.shadowPaint.setAlpha(60);
        this.shadowPaint.setAntiAlias(true);


        cicle = new Paint(Paint.ANTI_ALIAS_FLAG);
        cicle.setColor(Color.WHITE);
        cicle.setAntiAlias(true);
        cicle.setDither(true);

        cicleER = new Paint(Paint.ANTI_ALIAS_FLAG);
        cicleER.setColor(Color.parseColor("#45588BF8"));
        cicleER.setAntiAlias(true);
        cicleER.setDither(true);

        rect3 = new Rect();
        linePath = new Path();
    }

    @Override
    protected void onSizeChanged(int w, int h, int oldw, int oldh) {
        super.onSizeChanged(w, h, oldw, oldh);
        chartWidth = w;
        chartHeight = h - 30; // adjust for labels
    }

    private float xx = 0;
    private float yy = 0;

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
       if (allDatas.isEmpty()) return;
        float px, py;
        int startIdx = (index == 0 ? allDatas.size() - 1 : index - 1);
        if (startIdx < 0 || startIdx >= allDatas.size()) startIdx = 0;
        float startVal = allDatas.get(startIdx);
        px = startIdx * (chartWidth / maxCount);
        py = (dataBase - startVal) / (maxValue - minValue) * chartHeight;



            for (int i = 0; i <allDatas.size(); i++) {

                float x = i * (chartWidth / maxCount);
                float y = (dataBase - allDatas.get(i)) / (maxValue - minValue) * chartHeight;

                if(allDatas.size()<250){
                    if (0 == i) {
                        linePath.moveTo(x, y);
                    }
                    linePath.lineTo(x, y);
                }else {
                     if (i == startIdx||i >= index && i < index + blankCount) {
                         linePath.moveTo(x, y);
                     }else {
                         if (0 == i) {
                             linePath.moveTo(x, y);
                         }
                     }

                    linePath.lineTo(x, y);

                /*    if(i > index-Fengedian){//后半段
                                if(i==index){
                                    linePath.moveTo(x, y);
                                }
                                if (0 == i) {
                                    linePath.moveTo(x, y);
                                }
                                linePath.lineTo(x, y);
                            }else {//前半段数据
                                if (0 == i) {
                                    linePath.moveTo(x, y);
                                }
                                linePath.lineTo(x, y);
                  }*/

                }

            }


        canvas.drawPath(linePath, linePaint);
        if(maxCount==allDatas.size()){
            DrasPoint(canvas, px, py);
        }
        linePath.reset();
        if(allDatas.size()<maxCount){
            canvas.save();
           /* xx=px;
             yy=py;
            Log.e("adsdasfafasfafafa", "当前绘制下标："+index + "***" + allDatas.size());
            canvas.drawCircle(this.xx, this.yy, getResources().getDimension(R.dimen.dp_3), cicle);
            canvas.drawCircle(this.xx, this.yy, getResources().getDimension(R.dimen.dp_6), cicleER);*/
            DrasPoint(canvas, px, py);
            canvas.restore();
        }



      /*  if (allDatas.isEmpty()) return;
        linePath.reset();

        // start point

        float px, py;

        int startIdx = (index == 0 ? allDatas.size() - 1 : index - 1);

        if (startIdx < 0 || startIdx >= allDatas.size()) startIdx = 0;

        float startVal = allDatas.get(startIdx);

        px = startIdx * (chartWidth / maxCount);

        py = (dataBase - startVal) / (maxValue - minValue) * chartHeight;

     //   linePath.moveTo(px, py);



        for (int i = 0; i < allDatas.size(); i++) {

            if (i == startIdx) continue;

            if (i >= index && i < index + blankCount) continue;

            float x = i * (chartWidth / maxCount);

            float y = (dataBase - allDatas.get(i)) / (maxValue - minValue) * chartHeight;

            linePath.lineTo(x, y);

        }

        canvas.drawPath(linePath, linePaint);*/


    }

    private void DrasPoint(Canvas canvas, float px, float py) {
        xx= px;
        yy= py;
        canvas.drawCircle(xx, yy, 3f, cicle);
        canvas.drawCircle(xx, yy, 6f, cicleER);
    }

    public void addShowDatasECG(List<Float> datas) {
        if (datas.isEmpty()) {
            index = 0;
            start = false;
            allDatas.clear();
        }
        if (allDatas.size() + datas.size() <= maxCount) {
            allDatas.addAll(datas);
        } else {
            // replace old data
            for (Float v : datas) {
                allDatas.set(index, v);
                index = (index + 1) % maxCount;
            }
        }
        maxValue = 2;
        minValue = -2;
        dataBase = 2;
        if (Looper.myLooper() == Looper.getMainLooper()) {
            invalidate();
        } else {
            postInvalidate();
        }
    }

    public void addShowDatasPPG(List<Float> datas) {
     /*   if (!datas.isEmpty()) {
            index = 0;
            allDatas.clear();
        }*/
        if (allDatas.size() + datas.size() <= maxCount) {
            allDatas.addAll(datas);
        } else {
            int diff = (allDatas.size() + datas.size()) - maxCount;
            // remove or circular insert
            for (Float v : datas) {
                allDatas.set(index, v);
                index = (index + 1) % maxCount;
            }
        }
        // recalc bounds
        float max = Float.MIN_VALUE;
        float min = Float.MAX_VALUE;
        for (Float v : allDatas) {
            if (v > max) max = v;
            if (v < min) min = v;
        }
        float range = max - min;
        maxValue = max + range / 4;
        minValue = min - range / 4;
        dataBase = (int) (max + range / 4);
        if (Looper.myLooper() == Looper.getMainLooper()) {
            invalidate();
        } else {
            postInvalidate();
        }
    }

    // setters and getters for properties
    public void setBlankCount(int blankCount) {
        this.blankCount = blankCount;
    }

    public void setLineColor(int color) {
        this.lineColor = color;
        linePaint.setColor(color);
    }

    public void setLineWidth(float width) {
        this.lineWidth = width;
        linePaint.setStrokeWidth(width);
    }
}
