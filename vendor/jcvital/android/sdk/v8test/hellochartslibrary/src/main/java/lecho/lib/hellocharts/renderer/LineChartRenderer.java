package lecho.lib.hellocharts.renderer;

import lecho.lib.hellocharts.ChartComputator;
import lecho.lib.hellocharts.model.Line;
import lecho.lib.hellocharts.model.LineChartData;
import lecho.lib.hellocharts.model.PointValue;
import lecho.lib.hellocharts.model.RangeColor;
import lecho.lib.hellocharts.model.ValueShape;
import lecho.lib.hellocharts.provider.LineChartDataProvider;
import lecho.lib.hellocharts.util.Utils;
import lecho.lib.hellocharts.view.Chart;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.RectF;
import android.graphics.Shader;
import android.graphics.Paint.Cap;
import android.graphics.Path;
import android.graphics.PathEffect;
import android.graphics.PorterDuff.Mode;
import android.graphics.Rect;
import android.util.Log;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.Date;
import java.util.List;

import static lecho.lib.hellocharts.renderer.ColumnChartRenderer.DEFAULT_SUBCOLUMN_SPACING_DP;

/**
 * Renderer for line chart. Can draw lines, cubic lines, filled area chart and
 * scattered chart.
 *
 * @author Leszek Wach
 */
public class LineChartRenderer extends AbstractChartRenderer {
    private static final float LINE_SMOOTHNES = 0.15f;
    private static final int DEFAULT_LINE_STROKE_WIDTH_DP = 3;
    private static final int DEFAULT_TOUCH_TOLLERANCE_MARGIN_DP = 4;

    private static final int MODE_DRAW = 0;
    private static final int MODE_HIGHLIGHT = 1;

    private LineChartDataProvider dataProvider;

    private int checkPrecission;

    private float baseValue;

    private int touchTolleranceMargin;
    private Path path = new Path();
    private Paint linePaint = new Paint();
    private Paint pointPaint = new Paint();
    private float[] valuesBuff = new float[2];

    /**
     * Not hardware accelerated bitmap used to draw Path(smooth lines and filled
     * area). Bitmap has size of contentRect so it is usually smaller than the
     * view so you should used relative coordinates to draw on it.
     */
    private Bitmap swBitmap;

    /**
     * Canvas to draw on secondBitmap.
     */
    private Canvas swCanvas = new Canvas();
    private float lX;

    private float lY;
    private int subcolumnSpacing;

    public LineChartRenderer(Context context, Chart chart,
                             LineChartDataProvider dataProvider) {
        super(context, chart);
        this.dataProvider = dataProvider;

        touchTolleranceMargin = Utils.dp2px(density,
                DEFAULT_TOUCH_TOLLERANCE_MARGIN_DP);

        linePaint.setAntiAlias(true);
        linePaint.setStyle(Paint.Style.STROKE);
        linePaint.setStrokeCap(Cap.ROUND);
        linePaint.setStrokeWidth(Utils.dp2px(density,
                DEFAULT_LINE_STROKE_WIDTH_DP));

        pointPaint.setAntiAlias(true);
        pointPaint.setStyle(Paint.Style.FILL);

        checkPrecission = Utils.dp2px(density, 2);

    }

    @Override
    public void initMaxViewport() {
        if (isViewportCalculationEnabled) {
            calculateMaxViewport();
            chart.getChartComputator().setMaxViewport(tempMaxViewport);
        }
    }

    @Override
    public void initDataMeasuremetns() {
        final ChartComputator computator = chart.getChartComputator();

        computator.setInternalMargin(calculateContentAreaMargin());
        computator.setInternalMargin(0);
        if (computator.getChartWidth() > 0 && computator.getChartHeight() > 0) {
            swBitmap = Bitmap.createBitmap(computator.getChartWidth(),
                    computator.getChartHeight(), Bitmap.Config.ARGB_8888);
            swCanvas.setBitmap(swBitmap);
        }
    }

    @Override
    public void initDataAttributes() {
        super.initDataAttributes();

        LineChartData data = dataProvider.getLineChartData();

        // Set base value for this chart - default is 0.
        baseValue = data.getBaseValue();

    }

    private Canvas mCanvas;

    private static final String TAG = "LineChartRenderer";

    @Override
    public void draw(Canvas canvas) {
        final LineChartData data = dataProvider.getLineChartData();

        final Canvas drawCanvas;
        int bgColor = data.getBgChartColor();
        // swBitmap can be null if chart is rendered in layout editor. In that
        // case use default canvas and not swCanvas.
        if (null != swBitmap) {
            drawCanvas = swCanvas;

            drawCanvas.drawColor(Color.TRANSPARENT, Mode.CLEAR);
        } else {
            drawCanvas = canvas;
        }

        if (bgColor != 0) {
            drawBgChart(bgColor, calculateColumnWidth(), canvas);
        }
        drawBackground(drawCanvas, data);
        for (Line line : data.getLines()) {

            if (line.isOnlyDrawMaxMin()) {
            //    drawMaxMinLaber(line, drawCanvas);
            }
            if (line.hasLines()) {
                if (line.isCubic()) {
                    drawSmoothPath(drawCanvas, line);
                    drawGoBed(drawCanvas, line);
                    drawUpBed(drawCanvas, line);
                } else {
                    drawPath(drawCanvas, line);
                }
            }
            if (line.getMaxBitmap() != null && drawCanvas != null) {
                drawMaxMinBitMap(line, drawCanvas);
            }
        }
        //	drawFirstCheckedPoint(canvas,2);
        if (null != swBitmap) {
            canvas.drawBitmap(swBitmap, 0, 0, null);
        }
       // drawAxisCircle(canvas,data);
    }




    private void drawGoBed(Canvas drawCanvas, Line line) {
        Bitmap go = line.getGoBedBitmap();
        List<Integer>list=line.getGoBedList();
        if (list.size() == 0) return;
        final ChartComputator computator = chart.getChartComputator();
        for(Integer integer:list) {
            PointValue linePoint = line.getValues().get(integer>=288?287:integer);
            float currentPointX = computator.computeRawX(linePoint.getX()-1);
            float currentPointY = computator.computeRawY(8);
            Paint paint=new Paint();
            paint.setColor(Color.WHITE);
            paint.setTextSize(Utils.dp2px(DEFAULT_LABEL_MARGIN_DP,8));

            drawCanvas.drawText(getCountTime(integer)
                    ,currentPointX-Utils.dp2px(DEFAULT_LABEL_MARGIN_DP,10),
                    currentPointY-Utils.dp2px(DEFAULT_LABEL_MARGIN_DP,15),paint);
            drawCanvas.drawBitmap(go,currentPointX-go.getWidth()/2,currentPointY-go.getHeight(),paint);

        }
    }

    private void drawUpBed(Canvas drawCanvas, Line line) {
        Bitmap up = line.getUpBedBitmap();
        List<Integer>list=line.getUpBedList();
        if(list.size()==0)return;

        final ChartComputator computator = chart.getChartComputator();
        for(Integer integer:list) {
            PointValue linePoint = line.getValues().get(integer >= 480 ? 479 : integer);
            float currentPointX = computator.computeRawX(linePoint.getX()+1);
            float currentPointY = computator.computeRawY(8);
            Paint paint = new Paint();
            paint.setColor(Color.WHITE);
            paint.setTextSize(Utils.dp2px(DEFAULT_LABEL_MARGIN_DP, 8));
           // Log.i(TAG, "drawUpBed: "+getCountTime(integer));
            drawCanvas.drawText(getCountTime(integer)
                    , currentPointX - up.getWidth() / 2, currentPointY - up.getHeight(), paint);
            drawCanvas.drawBitmap(up, currentPointX - up.getWidth() / 2, currentPointY - up.getHeight(), paint);
            //    drawCanvas.drawBitmap(up,x,y,linePaint);
            }
    }

    private String getCountTime(int count) {
        SimpleDateFormat format = new SimpleDateFormat("HH:mm");
        String base = "12:00";
        long time = 0;
        try {
            time = format.parse(base).getTime() + count * 5 * 60 * 1000l;
        } catch (Exception e) {
            // TODO: handle exception
        }
        return format.format(new Date(time));
    }

    private void drawBackground(Canvas canvas, LineChartData data) {
        Bitmap bitmap = data.getBitmap();
        if (bitmap == null) return;
        final ChartComputator computator = chart.getChartComputator();
        Rect rectSrc = new Rect(0, 0, bitmap.getWidth(), bitmap.getHeight());
        Rect rectDes = new Rect();
        rectDes.left = computator.getContentRect().left;
        rectDes.right = computator.getContentRect().right;
        rectDes.top = computator.getContentRect().top;
        rectDes.bottom = computator.getContentRect().bottom;
        linePaint.setColor(Color.WHITE);
        // linePaint.setStrokeWidth(10);
        canvas.drawBitmap(bitmap, rectSrc, rectDes, linePaint);

    }

    private void drawMaxMinBitMap(Line line, Canvas canvas) {
        final List<PointValue> pointValues = line.getValues();
        List<PointValue> tempValue = new ArrayList<>();
        float rangeValue = line.getRangeValue();
        for (PointValue value : pointValues) {
            if (value.getY() != rangeValue)
                tempValue.add(value);
        }
        Collections.sort(tempValue, new ComArrays());
        if (tempValue.size() != 0) {
            PointValue pointValueMax = tempValue.get(0);
            PointValue pointValueMin = tempValue.get(tempValue.size() - 1);
            int positionMax=pointValues.indexOf(pointValueMax);

            drawMinBitMap(canvas, line.getMinBitmap(), pointValueMin,pointValues);
            drawMaxBitMap(canvas, line.getMaxBitmap(), pointValueMax,pointValues);
        }
    }

    private void drawMaxMinLaber(Line line, Canvas canvas) {
        final ChartComputator computator = chart.getChartComputator();
        final List<PointValue> pointValues = line.getValues();
        List<PointValue> tempValue = new ArrayList<>();
        float rangeValue = line.getRangeValue();
        for (PointValue value : pointValues) {
            if (value.getY() != rangeValue)
                tempValue.add(value);
        }
        Collections.sort(tempValue, new ComArrays());
        if (tempValue.size() != 0) {
            PointValue pointValueMax = tempValue.get(0);
            PointValue pointValueMin = tempValue.get(tempValue.size() - 1);
            int pointRadius = Utils.dp2px(density, line.getPointRadius());
            final int labelHeight = Math.abs(fontMetrics.ascent);
            Rect rect = new Rect();
            String maxValue=String.valueOf(pointValueMax.getY());
            labelPaint.getTextBounds(maxValue,0,maxValue.length(),rect);
            int labelMaxWidth = rect.width();
            String minValue=String.valueOf(pointValueMin.getY());
            labelPaint.getTextBounds(minValue,0,minValue.length(),rect);
            int labelMinWidth = rect.width();
            drawLabel(canvas, line, pointValueMax, computator.computeRawX(pointValueMax.getX())+labelMaxWidth, computator.computeRawY(pointValueMax.getY()),
                    pointRadius + labelOffset);
            drawLabel(canvas, line, pointValueMin, computator.computeRawX(pointValueMin.getX())+labelMinWidth, computator.computeRawY(pointValueMin.getY()) + pointRadius + labelOffset + labelHeight + labelMargin,
                    pointRadius + labelOffset);
            //  canvas.drawText((int)pointValueMax.getY()+"",computator.computeRawX(pointValueMax.getX())-,computator.computeRawY(pointValueMax.getY())-labelMargin*2,labelPaint);
            //   canvas.drawText((int)pointValueMin.getY()+"",computator.computeRawX(pointValueMin.getX()),computator.computeRawY(pointValueMin.getY())+labelMargin*2,labelPaint);
        }
    }

    protected float calculateColumnWidth() {
        final ChartComputator computator = chart.getChartComputator();
        // columnWidht should be at least 2 px
        float columnWidth = 0.2f * computator.getContentRect().width() / computator.getVisibleViewport().width();
        if (columnWidth < 2) {
            columnWidth = 2;
        }

        return columnWidth;
    }

    @Override
    public void drawUnclipped(Canvas canvas) {
        final LineChartData data = dataProvider.getLineChartData();
        int lineIndex = 0;

        for (Line line : data.getLines()) {

            if (line.hasPoints()) {
                drawPoints(canvas, line, lineIndex, MODE_DRAW);
            }
            ++lineIndex;
        }
        if (isTouched()) {
            // Redraw touched point to bring it to the front
            highlightPoints(canvas);
        }

    }

    @Override
    public boolean checkTouch(float touchX, float touchY) {
        selectedValue.clear();
        final LineChartData data = dataProvider.getLineChartData();
        final ChartComputator computator = chart.getChartComputator();
        int lineIndex = 0;
        for (Line line : data.getLines()) {
            int pointRadius = Utils.dp2px(density, line.getPointRadius());
            int valueIndex = 0;
            for (PointValue pointValue : line.getValues()) {
                final float rawValueX = computator.computeRawX(pointValue
                        .getX());
                final float rawValueY = computator.computeRawY(pointValue
                        .getY());
                if (isInArea(rawValueX, rawValueY, touchX, touchY, pointRadius
                        + touchTolleranceMargin)) {
                    selectedValue.set(lineIndex, valueIndex, 0);
                }
                ++valueIndex;
            }
            ++lineIndex;
        }
        return isTouched();
    }

    private void calculateMaxViewport() {
        tempMaxViewport.set(Float.MAX_VALUE, Float.MIN_VALUE, Float.MIN_VALUE,
                Float.MAX_VALUE);
        LineChartData data = dataProvider.getLineChartData();

        for (Line line : data.getLines()) {
            // Calculate max and min for viewport.
            for (PointValue pointValue : line.getValues()) {
                if (pointValue.getX() < tempMaxViewport.left) {
                    tempMaxViewport.left = pointValue.getX();
                }
                if (pointValue.getX() > tempMaxViewport.right) {
                    tempMaxViewport.right = pointValue.getX();
                }
                if (pointValue.getY() < tempMaxViewport.bottom) {
                    tempMaxViewport.bottom = pointValue.getY();
                }
                if (pointValue.getY() > tempMaxViewport.top) {
                    tempMaxViewport.top = pointValue.getY();
                }

            }
        }
    }

    private int calculateContentAreaMargin() {
        int contentAreaMargin = 0;
        final LineChartData data = dataProvider.getLineChartData();

        for (Line line : data.getLines()) {
            if (line.hasPoints()) {
                int margin = line.getPointRadius()
                        + DEFAULT_TOUCH_TOLLERANCE_MARGIN_DP;
                if (margin > contentAreaMargin) {
                    contentAreaMargin = margin;
                }
            }
        }
        return Utils.dp2px(density, contentAreaMargin);
    }

    /**
     * Draws lines, uses path for drawing filled area on secondCanvas. Line is
     * drawn with canvas.drawLines() method.
     */
    private void drawPath(Canvas canvas, final Line line) {
        final ChartComputator computator = chart.getChartComputator();

        prepareLinePaint(line);
        float max=0;
        if (line.isDefauleLine()) {// 本来的demo
            int valueIndex = 0;
            boolean hasLine = false;
            for (PointValue pointValue : line.getValues()) {

                final float rawX = computator.computeRawX(pointValue.getX());
                final float rawY = computator.computeRawY(pointValue.getY());

                if (valueIndex == 0) {
                    path.moveTo(rawX, rawY);
                } else {
                    if (line.getShape() == ValueShape.BITMAP) {
                        if (pointValue.getY() != 0) {
                            if (hasLine) {
                                path.moveTo(rawX, rawY);
                            }
                            path.lineTo(rawX, rawY);
                            hasLine = false;
                        } else {
                            hasLine = true;
                            path.moveTo(rawX, rawY);
                        }
                    } else {
                        path.lineTo(rawX, rawY);
                    }
                }

                ++valueIndex;

            }


            if (line.isGradient()) {
                drawAreaGradient(canvas, line.getGradientColor());
            } else {
                canvas.drawPath(path, linePaint);
            }
            if (line.isFilled()) {
                drawArea(canvas, (int) max);
            }
            path.reset();
        } else {
            drawPathCustomer(canvas, line);
        }
    }

    private void drawPathCustomer(Canvas canvas, Line line) {
        // TODO Auto-generated method stub
        final ChartComputator computator = chart.getChartComputator();
        LineChartData lineChartData = dataProvider.getLineChartData();
        final int lineSize = line.getValues().size();
        float prepreviousPointX = Float.NaN;
        float prepreviousPointY = Float.NaN;
        float previousPointX = Float.NaN;
        float previousPointY = Float.NaN;
        float currentPointX = Float.NaN;
        float currentPointY = Float.NaN;
        float nextPointX = Float.NaN;
        float nextPointY = Float.NaN;
        for (int valueIndex = 0; valueIndex < lineSize; ++valueIndex) {
            if (Float.isNaN(currentPointX)) {
                PointValue linePoint = line.getValues().get(valueIndex);
                currentPointX = computator.computeRawX(linePoint.getX());
                currentPointY = computator.computeRawY(linePoint.getY());
            }
            if (Float.isNaN(previousPointX)) {
                if (valueIndex > 0) {
                    PointValue linePoint = line.getValues().get(valueIndex - 1);
                    previousPointX = computator.computeRawX(linePoint.getX());
                    previousPointY = computator.computeRawY(linePoint.getY());
                } else {
                    previousPointX = currentPointX;
                    previousPointY = currentPointY;
                }
            }

            if (Float.isNaN(prepreviousPointX)) {
                if (valueIndex > 1) {
                    PointValue linePoint = line.getValues().get(valueIndex - 2);
                    prepreviousPointX = computator
                            .computeRawX(linePoint.getX());
                    prepreviousPointY = computator
                            .computeRawY(linePoint.getY());
                } else {
                    prepreviousPointX = previousPointX;
                    prepreviousPointY = previousPointY;
                }
            }

            // nextPoint is always new one or it is equal currentPoint.
            if (valueIndex < lineSize - 1) {
                PointValue linePoint = line.getValues().get(valueIndex + 1);
                nextPointX = computator.computeRawX(linePoint.getX());
                nextPointY = computator.computeRawY(linePoint.getY());
            } else {
                nextPointX = currentPointX;
                nextPointY = currentPointY;
            }

            // Calculate control points.
            final float firstDiffX = (currentPointX - prepreviousPointX);
            final float firstDiffY = (currentPointY - prepreviousPointY);
            final float secondDiffX = (nextPointX - previousPointX);
            final float secondDiffY = (nextPointY - previousPointY);
            final float firstControlPointX = previousPointX
                    + (LINE_SMOOTHNES * firstDiffX);
            float firstControlPointY = previousPointY
                    + (LINE_SMOOTHNES * firstDiffY);
            final float secondControlPointX = currentPointX
                    - (LINE_SMOOTHNES * secondDiffX);
            float secondControlPointY = currentPointY
                    - (LINE_SMOOTHNES * secondDiffY);


            if (valueIndex == 0) {
                // Move to start point.
                path.moveTo(currentPointX, currentPointY);
            } else {
                float baseY = computator.computeRawY(lineChartData.getBaseValue());
             //   Log.i(TAG, "drawSmoothPath: " + line.getValues().get(valueIndex).getX() + " " + currentPointY + " " + firstControlPointY + " " + secondControlPointY);
                if (currentPointY == baseY && (firstControlPointY > baseY || secondControlPointY > baseY)) {
                    firstControlPointY = baseY;
                    secondControlPointY = baseY;
                }
                path.cubicTo(firstControlPointX, firstControlPointY,
                        secondControlPointX, secondControlPointY,
                        currentPointX, currentPointY);
            }
            prepreviousPointX = previousPointX;
            prepreviousPointY = previousPointY;
            previousPointX = currentPointX;
            previousPointY = currentPointY;
            currentPointX = nextPointX;
            currentPointY = nextPointY;
        }
//        Rect rect = chart.getChartComputator().getContentRect();
//        int sc = canvas.saveLayer(rect.left, rect.top, rect.right, rect.bottom, null, Canvas.ALL_SAVE_FLAG);
//        Bitmap bitmapDst = drawDst(line);
//        Bitmap bitmapSrc=drawSrc(line);
//        int width = bitmapDst.getWidth();
//        int left=(rect.right-width)/2;
//        canvas.drawBitmap(bitmapDst, left, rect.top, linePaint);
//        linePaint.setStyle(Paint.Style.STROKE);
//        linePaint.setXfermode(new PorterDuffXfermode(Mode.DST_IN));
//        canvas.drawBitmap(bitmapSrc, left, rect.top, linePaint);
//        linePaint.setXfermode(null);
//        canvas.restoreToCount(sc);
        if (line.isFilled()) {
            drawArea(canvas, line.getAreaTransparency());
        }
        path.reset();
//        bitmapDst.recycle();
//        bitmapSrc.recycle();
    }

    private Bitmap drawDst(Line line) {
        Rect rect = chart.getChartComputator().getContentRect();
        int top=rect.bottom/5;
        int bottom=rect.bottom;
        Bitmap bm = Bitmap.createBitmap(rect.right, rect.bottom - rect.top, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bm);
        RectF rectDst=new RectF();
        rectDst.left=rect.left;
        rectDst.right=rect.right;
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.FILL);
        List<RangeColor>rangeColors=line.getRangeColors();
        if(rangeColors==null)return bm;

        rectDst.bottom=bottom;
        for(RangeColor rangeColor:rangeColors){
            int color=rangeColor.getColor();
            float value= chart.getChartComputator().computeRawY(rangeColor.getValue());
            rectDst.top=value;
            p.setColor(color);
            c.drawRect(rectDst, p);
            rectDst.bottom=value;
        }

        return bm;
    }
    private Bitmap drawSrc(Line line) {
        Rect rect = chart.getChartComputator().getContentRect();
        Log.i(TAG, "drawDst: " + (rect.bottom - rect.top) + "");
        Bitmap bm = Bitmap.createBitmap(rect.right , rect.bottom - rect.top, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bm);
        Paint p = new Paint(Paint.ANTI_ALIAS_FLAG);
        p.setStyle(Paint.Style.STROKE);
        p.setColor(Color.RED);
        p.setStrokeWidth(Utils.dp2px(density, line.getStrokeWidth()));
        c.drawPath(path,p);
        return bm;
    }

    /**
     * Draws Besier's curve. Uses path so drawing has to be done on secondCanvas
     * to avoid problem with hardware acceleration.
     */
    private void drawSmoothPath(Canvas canvas, final Line line) {
        final ChartComputator computator = chart.getChartComputator();
        LineChartData lineChartData = dataProvider.getLineChartData();
        prepareLinePaint(line);
        if (!line.isDefauleLine()) {
            drawPathCustomer(canvas, line);
            return;
        }
        final int lineSize = line.getValues().size();
        float prepreviousPointX = Float.NaN;
        float prepreviousPointY = Float.NaN;
        float previousPointX = Float.NaN;
        float previousPointY = Float.NaN;
        float currentPointX = Float.NaN;
        float currentPointY = Float.NaN;
        float nextPointX = Float.NaN;
        float nextPointY = Float.NaN;
        boolean hasLine=false;
        float max=0;
        for (int valueIndex = 0; valueIndex < lineSize; ++valueIndex) {
            max=Math.max(max,line.getValues().get(valueIndex).getY());

//                if(linePoint.getY()==0){
//                    path.moveTo(currentPointX,currentPointY);
//                    hasLine=true;
//                    //continue;
//                }else{
//                    if(hasLine){
//                        hasLine=false;
//                        path.moveTo(currentPointX,currentPointY);
//                     //   continue;
//                    }
//                }
//
//            }
            if (Float.isNaN(currentPointX)) {
                PointValue linePoint = line.getValues().get(valueIndex);
                currentPointX = computator.computeRawX(linePoint.getX());
                currentPointY = computator.computeRawY(linePoint.getY());
            }
            if (Float.isNaN(previousPointX)) {
                if (valueIndex > 0) {
                    PointValue linePoint = line.getValues().get(valueIndex - 1);
                    previousPointX = computator.computeRawX(linePoint.getX());
                    previousPointY = computator.computeRawY(linePoint.getY());
//                    if(linePoint.getY()==0&&value.getY()!=0){
//                        previousPointY=computator.computeRawY(value.getY());
//                    }
                } else {
                    previousPointX = currentPointX;
                    previousPointY = currentPointY;
                }
            }

            if (Float.isNaN(prepreviousPointX)) {
                if (valueIndex > 1) {
                    PointValue linePoint = line.getValues().get(valueIndex - 2);
                    prepreviousPointX = computator
                            .computeRawX(linePoint.getX());
                    prepreviousPointY = computator
                            .computeRawY(linePoint.getY());
//                    if(linePoint.getY()==0&&value.getY()!=0){
//                        prepreviousPointY=computator.computeRawY(value.getY());
//                    }
                } else {
                    prepreviousPointX = previousPointX;
                    prepreviousPointY = previousPointY;
                }
            }

            // nextPoint is always new one or it is equal currentPoint.
            if (valueIndex < lineSize - 1) {
                PointValue linePoint = line.getValues().get(valueIndex + 1);
                nextPointX = computator.computeRawX(linePoint.getX());
                nextPointY = computator.computeRawY(linePoint.getY());
            } else {
                nextPointX = currentPointX;
                nextPointY = currentPointY;
            }

            // Calculate control points.
            final float firstDiffX = (currentPointX - prepreviousPointX);
            final float firstDiffY = (currentPointY - prepreviousPointY);
            final float secondDiffX = (nextPointX - previousPointX);
            final float secondDiffY = (nextPointY - previousPointY);
            final float firstControlPointX = previousPointX
                    + (LINE_SMOOTHNES * firstDiffX);
            float firstControlPointY = previousPointY
                    + (LINE_SMOOTHNES * firstDiffY);
            final float secondControlPointX = currentPointX
                    - (LINE_SMOOTHNES * secondDiffX);
            float secondControlPointY = currentPointY
                    - (LINE_SMOOTHNES * secondDiffY);

            if (valueIndex == 0) {
                // Move to start point.
                path.moveTo(currentPointX, currentPointY);
            } else {

                float baseY = computator.computeRawY(lineChartData.getBaseValue());
               // Log.i(TAG, "drawSmoothPath: "+currentPointY+" "+baseY);
               // Log.i(TAG, "drawSmoothPath: " + line.getValues().get(valueIndex).getX() + " " + currentPointY + " " + firstControlPointY + " " + secondControlPointY);
                if (currentPointY == baseY && (firstControlPointY > baseY || secondControlPointY > baseY)) {
                    firstControlPointY = baseY;
                    secondControlPointY = baseY;
                }
                path.cubicTo(firstControlPointX, firstControlPointY,
                        secondControlPointX, secondControlPointY,
                        currentPointX, currentPointY);


            }

            // Shift values by one back to prevent recalculation of values that
            // have
            // been already calculated.
            prepreviousPointX = previousPointX;
            prepreviousPointY = previousPointY;
            previousPointX = currentPointX;
            previousPointY = currentPointY;
            currentPointX = nextPointX;
            currentPointY = nextPointY;
        }

        //canvas.drawPath(path, linePaint);
        if (line.isGradient()) {
            drawAreaGradient(canvas, line.getGradientColor());
        } else {
            canvas.drawPath(path, linePaint);
            if (line.isFilled()) {
                drawArea(canvas, (int) max);
            }
        }

        path.reset();

    }

    private void prepareLinePaint(final Line line) {
        linePaint.setStrokeWidth(Utils.dp2px(density, line.getStrokeWidth()));
        linePaint.setColor(line.getColor());
        linePaint.setShader(null);
        PathEffect pathEffect = line.getPathEffect();
        if (null != pathEffect) {
            linePaint.setPathEffect(pathEffect);
        }
    }

    class ComArrays implements Comparator<PointValue> {
        public int compare(PointValue p1, PointValue p2) {
            if (p1.getY() > p2.getY()) return -1;
            else if (p1.getY() < p2.getY()) return 1;
            else return 0;
        }
    }

    // TODO Drawing points can be done in the same loop as drawing lines but it
    // may cause problems in the future with
    // implementing point styles.
    private void drawPoints(Canvas canvas, Line line, int lineIndex, int mode) {

        final ChartComputator computator = chart.getChartComputator();
        pointPaint.setColor(line.getColor());
        int valueIndex = 0;

        for (PointValue pointValue : line.getValues()) {
            int pointRadius = Utils.dp2px(density, line.getPointRadius());
            final float rawX = computator.computeRawX(pointValue.getX());
            final float rawY = computator.computeRawY(pointValue.getY());
            if (computator.isWithinContentRect(rawX, rawY, checkPrecission)) {
                // Draw points only if they are within contentRect, using
                // contentRect instead of viewport to avoid some
                // float rounding problems.
                if (MODE_DRAW == mode) {
                    drawPoint(canvas, line, pointValue, rawX, rawY, pointRadius);
                    if (line.getHasLaberColor()) {
                        setLaberPaintColr(line.getLaberTextColor());
                    }
                    if (line.hasLabels()) {
                        drawLabel(canvas, line, pointValue, rawX, rawY,
                                pointRadius + labelOffset);
                    }

                } else if (MODE_HIGHLIGHT == mode) {
                    if (line.hasPoints())
                        highlightPoint(canvas, line, pointValue, rawX, rawY,
                                lineIndex, valueIndex);
                } else {
                    throw new IllegalStateException(
                            "Cannot process points in mode: " + mode);
                }
            }
            ++valueIndex;
        }
    }

    /**
     * 指定点显示
     *
     * @param location
     */
    public void drawFirstCheckedPoint(Canvas canvas, int location) {
        final ChartComputator computator = chart.getChartComputator();
        Line line = dataProvider.getLineChartData().getLines().get(0);
        PointValue pointValue = line.getValues().get(location);
        int pointRadius = Utils.dp2px(density, line.getPointRadius());
        final float rawX = computator.computeRawX(pointValue.getX());
        final float rawY = computator.computeRawY(pointValue.getY());
        drawLabel(canvas, line, pointValue, rawX, rawY, pointRadius
                + labelOffset);
    }

    private void drawPoint(Canvas canvas, Line line, PointValue pointValue,
                           float rawX, float rawY, float pointRadius) {
        if (ValueShape.SQUARE.equals(line.getShape())) {
            canvas.drawRect(rawX - pointRadius, rawY - pointRadius, rawX
                    + pointRadius, rawY + pointRadius, pointPaint);
        } else if (ValueShape.CIRCLE.equals(line.getShape())) {
            int pointColor = line.getPointColor();
            if (pointColor != 0) pointPaint.setColor(pointColor);
            if (pointValue.getY() != 0)
                canvas.drawCircle(rawX, rawY, pointRadius, pointPaint);

        } else if (ValueShape.BITMAP.equals(line.getShape())) {

            float x = pointValue.getY();
            if (x == 0)
                return;
            canvas.drawBitmap(line.getHeartBitmap(x), rawX - pointRadius, rawY
                    - pointRadius, pointPaint);

        } else if (ValueShape.JSTYLE.equals(line.getShape())) {
            Bitmap bitmap = line.getJstyleBitMap();
            canvas.drawBitmap(bitmap, rawX - bitmap.getWidth() / 2, rawY - bitmap.getHeight() / 2
                    , pointPaint);
        } else if (ValueShape.JSTYLE_PLUS.equals(line.getShape())) {
            float x = pointValue.getY();
            if (x == 0)
                return;
            int state = pointValue.getRangeState();
            canvas.drawBitmap(line.getHeartBitmapsTATE(state), rawX - pointRadius, rawY
                    - pointRadius, pointPaint);
        } else {
            throw new IllegalArgumentException("Invalid point shape: "
                    + line.getShape());
        }
    }

    private void drawMaxBitMap(Canvas canvas, Bitmap bitmap, PointValue pointValue,List<PointValue> pointValues) {
        ChartComputator chartComputator=chart.getChartComputator();
        float rawX=chartComputator.computeRawX(pointValue.getX());
        float rawY=chartComputator.computeRawY(pointValue.getY());
        Paint paint = new Paint();
        int positionMax=pointValues.indexOf(pointValue);
        String value=String.valueOf((int)pointValue.getY());
        Rect rect=new Rect();
        labelPaint.getTextBounds(value,0,value.length(),rect);
        canvas.drawBitmap(bitmap, rawX - bitmap.getWidth() / 2, rawY - bitmap.getHeight() - labelOffset
                , paint);
        if(positionMax>=pointValues.size()-2){
            canvas.drawText(value,rawX-bitmap.getWidth()-rect.width()-labelOffset,rawY- bitmap.getHeight()-labelOffset+rect.height(),labelPaint);

        }else{
            canvas.drawText(value,rawX+bitmap.getWidth(),rawY- bitmap.getHeight()-labelOffset+rect.height(),labelPaint);

        }
    }

    private void drawMinBitMap(Canvas canvas, Bitmap bitmap, PointValue pointValue,List<PointValue> pointValues) {
        ChartComputator chartComputator=chart.getChartComputator();
        float rawX=chartComputator.computeRawX(pointValue.getX());
        float rawY=chartComputator.computeRawY(pointValue.getY());
        int positionMin=pointValues.indexOf(pointValue);
        Paint paint = new Paint();
        String value=String.valueOf((int)pointValue.getY());
        Rect rect=new Rect();
        labelPaint.getTextBounds(value,0,value.length(),rect);
        canvas.drawBitmap(bitmap, rawX - bitmap.getWidth() / 2, rawY+labelOffset
                , paint);
        if(positionMin>=pointValues.size()-2){
            canvas.drawText(value,rawX-bitmap.getWidth()-rect.width()/2-labelOffset,rawY+rect.height()+labelOffset,labelPaint);
        }else{
            canvas.drawText(value,rawX+rect.width()/2+labelOffset,rawY+rect.height()+labelOffset,labelPaint);
        }

    }

    private void highlightPoints(Canvas canvas) {
        int lineIndex = selectedValue.getFirstIndex();
        Line line = dataProvider.getLineChartData().getLines().get(lineIndex);
        drawPoints(canvas, line, lineIndex, MODE_HIGHLIGHT);
    }

    private void highlightPoint(Canvas canvas, Line line,
                                PointValue pointValue, float rawX, float rawY, int lineIndex,
                                int valueIndex) {
        if (selectedValue.getFirstIndex() == lineIndex
                && selectedValue.getSecondIndex() == valueIndex) {
            int pointRadius = Utils.dp2px(density, line.getPointRadius());
            pointPaint.setColor(line.getDarkenColor());
            drawPoint(canvas, line, pointValue, rawX, rawY, pointRadius
                    + touchTolleranceMargin);
            if (line.hasLabels() || line.hasLabelsOnlyForSelected()) {
                drawLabel(canvas, line, pointValue, rawX, rawY, pointRadius
                        + labelOffset);
            }
        }
    }

    private void drawBgChart(int bgChartColor, float columnWidth, Canvas canvas) {
        subcolumnSpacing = Utils.dp2px(density, DEFAULT_SUBCOLUMN_SPACING_DP);
        final ChartComputator computator = chart.getChartComputator();
        final float rawX = computator.computeRawX(0);
        float subcolumnRawX = rawX;
        float subcolumnWidth = (columnWidth - subcolumnSpacing) / 2;
        int count = (int) ((computator.computeRawX(computator.getContentRect().right) - rawX) / subcolumnWidth);
        final float baseRawY = computator.computeRawY(baseValue);
        RectF rectF = new RectF();
        linePaint.setStrokeCap(Cap.ROUND);
        linePaint.setStrokeWidth(subcolumnWidth);
        for (int i = 0; i < count; i++) {
            linePaint.setColor(bgChartColor);
            rectF.left = subcolumnRawX;
            rectF.right = subcolumnRawX + subcolumnWidth;
            rectF.bottom = baseRawY - subcolumnSpacing;
            rectF.top = computator.getContentRect().top;
            subcolumnRawX += subcolumnWidth + subcolumnSpacing;
            if (canvas != null && computator.isWithinContentRect(rectF.left, rectF.top, checkPrecission))
                canvas.drawLine(rectF.left, baseRawY - subcolumnWidth / 2 - subcolumnSpacing, rectF.left, rectF.top, linePaint);
        }
    }


    private void setLaberPaintColr(int color) {
        this.labelPaint.setColor(color);
    }


    private void drawLabel(Canvas canvas, Line line, PointValue pointValue,
                           float rawX, float rawY, float offset) {
        final ChartComputator computator = chart.getChartComputator();
        final Rect contentRect = computator.getContentRect();
        valuesBuff[0] = pointValue.getX();
        valuesBuff[1] = pointValue.getY();

        final int numChars = line.getFormatter().formatValue(labelBuffer,
                valuesBuff, pointValue.getLabel());

        if (numChars == 0) {
            // No need to draw empty label
            return;
        }

        final float labelWidth = labelPaint.measureText(labelBuffer,
                labelBuffer.length - numChars, numChars);
        final int labelHeight = Math.abs(fontMetrics.ascent);
        float left = rawX - labelWidth / 2 - labelMargin;
        float right = rawX + labelWidth / 2 + labelMargin;

        float top;
        float bottom;

        if (pointValue.getY() >= baseValue) {
            top = rawY - offset - labelHeight - labelMargin * 2;
            bottom = rawY - offset;
        } else {
            top = rawY + offset;
            bottom = rawY + offset + labelHeight + labelMargin * 2;
        }

        if (top < contentRect.top) {
            top = rawY + offset;
            bottom = rawY + offset + labelHeight + labelMargin * 2;
        }
        if (bottom > contentRect.bottom) {
            top = rawY - offset - labelHeight - labelMargin * 2;
            bottom = rawY - offset;
        }
        if (left < contentRect.left) {
            left = rawX;
            right = rawX + labelWidth + labelMargin * 2;
        }
        if (right > contentRect.right) {
            left = rawX - labelWidth - labelMargin * 2;
            right = rawX;
        }

        labelBackgroundRect.set(left, top, right, bottom);
        Bitmap laberBitmap = line.getLaberBitmap();
        if (laberBitmap == null) {
            drawLabelTextAndBackground(canvas, labelBuffer, labelBuffer.length
                    - numChars, numChars, line.getDarkenColor());
        } else {
            drawLabelTextAndBackgroundBitmap(canvas, labelBuffer, labelBuffer.length - numChars, numChars, laberBitmap, rawX, rawY);
        }


    }

    private void drawArea(Canvas canvas, int max) {
        final ChartComputator computator = chart.getChartComputator();
        final Rect contentRect = computator.getContentRect();

        float baseRawValue = computator.computeRawY(baseValue);

        baseRawValue = Math.min(contentRect.bottom,
                Math.max(baseRawValue, contentRect.top));


        path.lineTo(contentRect.right, baseRawValue);
        path.lineTo(contentRect.left, baseRawValue);
        path.close();
        linePaint.setStyle(Paint.Style.FILL);
        Log.i(TAG, "drawArea: "+max);
        int[]gradientColor=new int[]{Color.parseColor("#20940621"),Color.parseColor("#60fc0435")};
        LinearGradient linearGradient = new LinearGradient(contentRect.left, baseRawValue,
                contentRect.left,max,
                gradientColor, null, Shader.TileMode.MIRROR);
        linePaint.setShader(linearGradient);
      //  linePaint.setAlpha(transparency);
        canvas.drawPath(path, linePaint);
        linePaint.setStyle(Paint.Style.STROKE);
    }

    private void drawAreaGradient(Canvas canvas, int[] gradientColor) {
        final ChartComputator computator = chart.getChartComputator();
        final Rect contentRect = computator.getContentRect();
        float baseRawValue = computator.computeRawY(baseValue);
        baseRawValue = Math.min(contentRect.bottom,
                Math.max(baseRawValue, contentRect.top));

        path.lineTo(contentRect.right, baseRawValue);
        path.lineTo(contentRect.left, baseRawValue);
        path.close();


        LinearGradient linearGradient = new LinearGradient(contentRect.left, 0, contentRect.left, baseRawValue,
                gradientColor, new float[]{0f, 0.7f, 1f}, Shader.TileMode.MIRROR);
        linePaint.setShader(linearGradient);
        linePaint.setStrokeWidth(0);
        linePaint.setStyle(Paint.Style.FILL);
        canvas.drawPath(path, linePaint);
        linePaint.setStyle(Paint.Style.STROKE);
    }

    private boolean isInArea(float x, float y, float touchX, float touchY,
                             float radius) {
        float diffX = touchX - x;
        float diffY = touchY - y;
        return Math.pow(diffX, 2) + Math.pow(diffY, 2) <= 2 * Math.pow(radius,
                2);
    }

}
