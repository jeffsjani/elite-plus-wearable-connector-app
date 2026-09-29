package lecho.lib.hellocharts.renderer;

import lecho.lib.hellocharts.ChartComputator;
import lecho.lib.hellocharts.model.AxisValue;
import lecho.lib.hellocharts.model.BpValue;
import lecho.lib.hellocharts.model.Column;
import lecho.lib.hellocharts.model.ColumnChartData;
import lecho.lib.hellocharts.model.ColumnValue;
import lecho.lib.hellocharts.provider.ColumnChartDataProvider;
import lecho.lib.hellocharts.util.Utils;
import lecho.lib.hellocharts.view.Chart;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Matrix;
import android.graphics.Paint;
import android.graphics.Paint.Cap;
import android.graphics.Path;
import android.graphics.PointF;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Rect;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.Log;

import java.util.List;

/**
 * Magic renderer for ColumnChart.
 */
public class ColumnChartRenderer extends AbstractChartRenderer {
    public static final int DEFAULT_SUBCOLUMN_SPACING_DP = 1;
    public static final int DEFAULT_COLUMN_TOUCH_ADDITIONAL_WIDTH_DP = 4;

    private static final int MODE_DRAW = 0;
    private static final int MODE_CHECK_TOUCH = 1;
    private static final int MODE_HIGHLIGHT = 2;
    private final PorterDuffXfermode porterDuffXfermode;

    protected ColumnChartDataProvider dataProvider;

    /**
     * Additional width for hightlighted column, used to give tauch feedback.
     */
    private int touchAdditionalWidth;

    /**
     * Spacing between sub-columns.
     */
    private int subcolumnSpacing;

    /**
     * Paint used to draw every column.
     */
    private Paint columnPaint = new Paint();

    /**
     * Holds coordinates for currently processed column/sub-column.
     */
    private RectF drawRect = new RectF();

    /**
     * Coordinated of user tauch.
     */
    private PointF touchedPoint = new PointF();

    /**
     * Used to pass tauched value to tauch listener.
     */
    private float[] valuesBuff = new float[1];

    private float fillRatio;

    private float baseValue;

    public ColumnChartRenderer(Context context, Chart chart, ColumnChartDataProvider dataProvider) {
        super(context, chart);
        this.dataProvider = dataProvider;
        porterDuffXfermode = new PorterDuffXfermode(PorterDuff.Mode.DST);

        subcolumnSpacing = Utils.dp2px(density, DEFAULT_SUBCOLUMN_SPACING_DP);
        touchAdditionalWidth = Utils.dp2px(density, DEFAULT_COLUMN_TOUCH_ADDITIONAL_WIDTH_DP);

        columnPaint.setAntiAlias(true);
        columnPaint.setStyle(Paint.Style.FILL);
        columnPaint.setStrokeCap(Cap.ROUND);
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
        chart.getChartComputator().setInternalMargin(labelMargin);// Using label margin because I'm lazy:P
    }

    @Override
    public void initDataAttributes() {
        super.initDataAttributes();

        ColumnChartData data = dataProvider.getColumnChartData();
        fillRatio = data.getFillRatio();
        baseValue = data.getBaseValue();

    }

    public void draw(Canvas canvas) {
        final ColumnChartData data = dataProvider.getColumnChartData();
        if (data.isStacked()) {
            drawColumnForStacked(canvas);
            if (isTouched()) {
                highlightColumnForStacked(canvas);
            }
        } else {
            drawColumnsForSubcolumns(canvas);
            if (isTouched()) {
                List<BpValue> bpValues = data.getBpValues();
                if (bpValues== null) {
                    highlightColumnsForSubcolumns(canvas);
                } else {
                    highlightColumnsForBpColumns(canvas);
                }

            }
        }
    }

    private void highlightColumnsForBpColumns(Canvas canvas) {
        final ColumnChartData data = dataProvider.getColumnChartData();
        final float columnWidth = calculateColumnWidth();

        BpValue bpValue=data.getBpValues().get(selectedValue.getFirstIndex());
        processColumnForSubcolumns(canvas,  columnWidth, selectedValue.getFirstIndex(), MODE_HIGHLIGHT,bpValue);
    }

    @Override
    public void drawUnclipped(Canvas canvas) {
        // Do nothing, for this kind of chart there is nothing to draw beyond clipped area
    }

    public boolean checkTouch(float touchX, float touchY) {
        selectedValue.clear();
        final ColumnChartData data = dataProvider.getColumnChartData();
        if (data.isStacked()) {
            checkTouchForStacked(touchX, touchY);
        } else {
            checkTouchForSubcolumns(touchX, touchY);
        }
        return isTouched();
    }

    private void calculateMaxViewport() {
        final ColumnChartData data = dataProvider.getColumnChartData();
        // Column chart always has X values from 0 to numColumns-1, to add some margin on the left and right I added
        // extra 0.5 to the each side, that margins will be negative scaled according to number of columns, so for more
        // columns there will be less margin.
        tempMaxViewport.set(-0.5f, baseValue, data.getColumns().size() - 0.5f, baseValue);
        if (data.isStacked()) {
            calculateMaxViewportForStacked(data);
        } else {
            calculateMaxViewportForSubcolumns(data);
        }
    }

    private void calculateMaxViewportForSubcolumns(ColumnChartData data) {
        for (Column column : data.getColumns()) {
            for (ColumnValue columnValue : column.getValues()) {
                if (columnValue.getValue() >= baseValue && columnValue.getValue() > tempMaxViewport.top) {
                    tempMaxViewport.top = columnValue.getValue();
                }
                if (columnValue.getValue() < baseValue && columnValue.getValue() < tempMaxViewport.bottom) {
                    tempMaxViewport.bottom = columnValue.getValue();
                }
            }
        }
    }

    private void calculateMaxViewportForStacked(ColumnChartData data) {
        for (Column column : data.getColumns()) {
            float sumPositive = baseValue;
            float sumNegative = baseValue;
            for (ColumnValue columnValue : column.getValues()) {
                if (columnValue.getValue() >= baseValue) {
                    sumPositive += columnValue.getValue();
                } else {
                    sumNegative += columnValue.getValue();
                }
            }
            if (sumPositive > tempMaxViewport.top) {
                tempMaxViewport.top = sumPositive;
            }
            if (sumNegative < tempMaxViewport.bottom) {
                tempMaxViewport.bottom = sumNegative;
            }
        }
    }

    private void drawColumnsForSubcolumns(Canvas canvas) {
        final ColumnChartData data = dataProvider.getColumnChartData();
        final float columnWidth = calculateColumnWidth();
        int columnIndex = 0;
        //  int bgChartColor = data.getBgChartColor();
        List<BpValue> bpValues = data.getBpValues();
        if (bpValues== null) {
            for (Column column : data.getColumns()) {
                processColumnForSubcolumns(canvas, column, columnWidth, columnIndex, MODE_DRAW);
                ++columnIndex;
            }
        } else {
            final float rawBgTopB = chart.getChartComputator().computeRawY(59);
            final float rawBgBottomB = chart.getChartComputator().computeRawY(0);


            final float rawBgBottomHigh = chart.getChartComputator().computeRawY(140);
            columnPaint.setColor(Color.parseColor("#303239"));
            final Rect contentRect = chart.getChartComputator().getContentRect();
            canvas.drawRect(contentRect.left, contentRect.top, contentRect.right, rawBgBottomHigh, columnPaint);
            canvas.drawRect(contentRect.left, rawBgTopB, contentRect.right, contentRect.bottom, columnPaint);

            for (BpValue bpValue : bpValues) {
                processColumnForSubcolumns(canvas, columnWidth, columnIndex, MODE_DRAW, bpValue);
                ++columnIndex;
            }


        }
    }

    private void drawBgChart(int index, Canvas canvas, ColumnChartData data) {
        final ChartComputator computator = chart.getChartComputator();
        List<ColumnValue> columnValues = data.getColumns().get(index).getValues();

        float columnWidth = calculateColumnWidth();
        final float baseRawY = computator.computeRawY(baseValue);
        float subcolumnWidth = (columnWidth - subcolumnSpacing) / 2;
        float rawX = computator.computeRawX(0) + index * 9 * (subcolumnWidth + subcolumnSpacing);

        columnPaint.setStrokeWidth(subcolumnWidth + touchAdditionalWidth);
        int valueIndex = 0;

        for (ColumnValue value : columnValues) {
            if (valueIndex == selectedValue.getSecondIndex()) {
                columnPaint.setColor(value.getDarkenColor());
                rawX += valueIndex * (subcolumnWidth + subcolumnSpacing);
                final float rawY = computator.computeRawY(value.getValue());
                canvas.drawLine(rawX, baseRawY - subcolumnWidth / 2 - subcolumnSpacing, rawX, rawY, columnPaint);
            }
            valueIndex++;
        }

    }

    /**
     * 背景柱状图
     *
     * @param bgChartColor
     */
    private void drawBgChart(int bgChartColor, float columnWidth, Canvas canvas, ColumnChartData data) {

        final ChartComputator computator = chart.getChartComputator();
        final float rawX = computator.computeRawX(0);
        final float halfColumnWidth = columnWidth / 2;
        float subcolumnRawX = rawX;
        float subcolumnWidth = (columnWidth - subcolumnSpacing) / 2;
        int count = (int) ((computator.computeRawX(computator.getContentRect().right) - rawX) / subcolumnWidth);
        final float baseRawY = computator.computeRawY(baseValue);
        List<AxisValue> axisValues = data.getAxisXBottom().getValues();

        // calculateRectToDraw(columnValue, subcolumnRawX, subcolumnRawX + subcolumnWidth, baseRawY, rawY);
        RectF rectF = new RectF();

        columnPaint.setStrokeCap(Cap.ROUND);
        columnPaint.setStrokeWidth(subcolumnWidth);
        columnPaint.setTextSize(Utils.dp2px(density, data.getAxisXBottom().getTextSize()));
        for (int i = 0; i < count; i++) {
            columnPaint.setColor(bgChartColor);
            rectF.left = subcolumnRawX;
            rectF.right = subcolumnRawX + subcolumnWidth;
            rectF.bottom = baseRawY - subcolumnSpacing;
            rectF.top = computator.getContentRect().top;
            subcolumnRawX += subcolumnWidth + subcolumnSpacing;
            if (canvas != null)
                canvas.drawLine(rectF.left, baseRawY - subcolumnWidth / 2 - subcolumnSpacing, rectF.left, rectF.top, columnPaint);
            //  canvas.drawRoundRect(rectF, 10,  10,columnPaint);
            if ((i - 1) % 9 == 0) {
                int index = i / 9;
                if (index >= data.getColumns().size()) continue;
                ColumnValue value = data.getColumns().get(index).getValues().get(1);
                if (value.getValue() == 0) continue;
                columnPaint.setColor(value.getColor());
                float left = rectF.left;
                calculateRectToDraw(value, left, left + subcolumnWidth, baseRawY, computator.computeRawY(value.getValue()));
                columnPaint.setStrokeCap(Cap.ROUND);
                columnPaint.setStrokeWidth(subcolumnWidth);
                if (canvas == null) {
                    checkRectToDraw(index, 1);
                } else {
                    canvas.drawLine(left, baseRawY - subcolumnWidth / 2 - subcolumnSpacing, left, computator.computeRawY(value.getValue()), columnPaint);
                }
            }

            if (i % 9 == 0) {
                int index = i / 9;
                if (index >= data.getColumns().size()) continue;
                ColumnValue value = data.getColumns().get(index).getValues().get(0);
                if (value.getValue() == 0) continue;
                columnPaint.setColor(value.getColor());
                float left = rectF.left;
                //   canvas.drawText(axisValues.get(index).getLabel(),0,axisValues.get(index).getLabel().length,left,computator.getContentRectWithMargins().bottom,columnPaint);
                calculateRectToDraw(value, left, left + subcolumnWidth, baseRawY, computator.computeRawY(value.getValue()));
                columnPaint.setStrokeCap(Cap.SQUARE);
                columnPaint.setStrokeWidth(subcolumnWidth);
                if (canvas == null) {
                    checkRectToDraw(index, 0);
                } else {
                    canvas.drawLine(left, baseRawY - subcolumnWidth / 2 - subcolumnSpacing, left, computator.computeRawY(value.getValue()), columnPaint);
                }
            }
        }
    }

    private void highlightColumnsForSubcolumns(Canvas canvas) {

        final ColumnChartData data = dataProvider.getColumnChartData();
        final float columnWidth = calculateColumnWidth();
        Column column = data.getColumns().get(selectedValue.getFirstIndex());
        processColumnForSubcolumns(canvas, column, columnWidth, selectedValue.getFirstIndex(), MODE_HIGHLIGHT);
    }

    private void checkTouchForSubcolumns(float touchX, float touchY) {
        // Using member variable to hold touch point to avoid too much parameters in methods.
        touchedPoint.x = touchX;
        touchedPoint.y = touchY;
        final ColumnChartData data = dataProvider.getColumnChartData();
        final float columnWidth = calculateColumnWidth();
        int columnIndex = 0;
       List<BpValue>list= data.getBpValues();
       if(list==null){
           for (Column column : data.getColumns()) {
               // canvas is not needed for checking touch
               processColumnForSubcolumns(null, column, columnWidth, columnIndex, MODE_CHECK_TOUCH);
               ++columnIndex;
           }
       }else{
           for(BpValue bpValue:list){
               processColumnForSubcolumns(null, columnWidth, columnIndex, MODE_CHECK_TOUCH,bpValue);
               ++columnIndex;
           }


       }

    }

    private void processColumnForSubcolumns(Canvas canvas, Column column, float columnWidth, int columnIndex, int mode) {
        final ChartComputator computator = chart.getChartComputator();
        // For n subcolumns there will be n-1 spacing and there will be one
        // subcolumn for every columnValue

        float subcolumnWidth = (columnWidth - (subcolumnSpacing * (column.getValues().size() - 1)))
                / column.getValues().size();
        if (subcolumnWidth < 1) {
            subcolumnWidth = 1;
        }

        // Columns are indexes from 0 to n, column index is also column X value
        final float rawX = computator.computeRawX(columnIndex);

        final float halfColumnWidth = columnWidth / 2;
        final float baseRawY = computator.computeRawY(baseValue);
        // First subcolumn will starts at the left edge of current column,
        // rawValueX is horizontal center of that column
        float subcolumnRawX = rawX - halfColumnWidth;
        int valueIndex = 0;
        for (ColumnValue columnValue : column.getValues()) {

            boolean isGradient = columnValue.isHasGradient();
            if (subcolumnRawX > rawX + halfColumnWidth) {

                break;
            }
            final float rawY = computator.computeRawY(columnValue.getValue());
            //	Log.i(TAG, "processColumnForSubcolumns: "+rawY+" "+computator.computeRawY(rawY));
            float topY=computator.getContentRect().top;
            if (isGradient) {
                LinearGradient linearGradient = new LinearGradient(subcolumnRawX, baseRawY, subcolumnRawX, topY, new int[]{Color.parseColor("#53d37e"), Color.parseColor("#04ff58")}, null, Shader.TileMode.MIRROR);
                columnPaint.setShader(linearGradient);
            } else {
                columnPaint.setColor(columnValue.getColor());
            }
            calculateRectToDraw(columnValue, subcolumnRawX, subcolumnRawX + subcolumnWidth, baseRawY, rawY);
            switch (mode) {
                case MODE_DRAW:
                    drawSubcolumn(canvas, column, columnValue, false);
                    break;
                case MODE_HIGHLIGHT:
                    highlightSubcolumn(canvas, column, columnValue, valueIndex, false);
                    break;
                case MODE_CHECK_TOUCH:
                    checkRectToDraw(columnIndex, valueIndex);
                    break;
                default:
                    // There no else, every case should be handled or exception will
                    // be thrown
                    throw new IllegalStateException("Cannot process column in mode: " + mode);
            }
            subcolumnRawX += subcolumnWidth + subcolumnSpacing;

            int maxIndex=dataProvider.getColumnChartData().getMaxIndex();
          //  Log.i(TAG, "processColumnForSubcolumns: "+maxIndex+" "+column.getValues().indexOf(columnValue));
            if(maxIndex!=0&&columnIndex==maxIndex){
                drawMaxLabel(canvas, column, columnValue, labelOffset);
           //  drawLabel(canvas, column, columnValue, false, labelOffset);
            }
            ++valueIndex;
        }
    }

    private void drawMaxLabel(Canvas canvas, Column column, ColumnValue columnValue, int labelOffset) {
        if(canvas==null)return;
        final ChartComputator computator = chart.getChartComputator();

        Bitmap bitmap=dataProvider.getColumnChartData().getMaxStepBitmap();
        float rawX=drawRect.centerX();
        float rawY=computator.computeRawY(columnValue.getValue());
     //   int positionMin=pointValues.indexOf(pointValue);
        Paint paint = new Paint();
        String value=String.valueOf((int)columnValue.getValue());
        Rect rect=new Rect();
        labelPaint.getTextBounds(value,0,value.length(),rect);
        if(bitmap!=null)
        canvas.drawBitmap(bitmap, rawX - bitmap.getWidth(), drawRect.top-bitmap.getHeight()-labelOffset
                , paint);
        //if(positionMin>=pointValues.size()-2){
         //   canvas.drawText(value,rawX-bitmap.getWidth()-rect.width()/2-labelOffset,rawY+rect.height()+labelOffset,labelPaint);
       // }else{
            canvas.drawText(value,rawX- bitmap.getWidth()+rect.width()/2+labelOffset,drawRect.top-labelOffset-bitmap.getHeight()+rect.height(),labelPaint);
      //  }

          //  canvas.drawBitmap(bitmap,left,top-bitmap.getHeight(),labelPaint);
      //  canvas.drawText(String.valueOf(columnValue.getValue()),left+bitmap.getWidth(),top,labelPaint);
    }

    private void processColumnForSubcolumns(Canvas canvas, float columnWidth, int columnIndex, int mode, BpValue columnValue) {
        final ChartComputator computator = chart.getChartComputator();
        // For n subcolumns there will be n-1 spacing and there will be one
        // subcolumn for every columnValue

        int size = 1;
        float subcolumnWidth = (columnWidth - (subcolumnSpacing * (size - 1)))
                / size;

        if (subcolumnWidth < 1) {
            subcolumnWidth = 1;
        }
        // Columns are indexes from 0 to n, column index is also column X value
        final float rawX = computator.computeRawX(columnIndex);

        final float halfColumnWidth = columnWidth / 2;
        final float baseRawY = computator.computeRawY(60);
        // First subcolumn will starts at the left edge of current column,
        // rawValueX is horizontal center of that column
        float subcolumnRawX = rawX - halfColumnWidth;
        int valueIndex = 0;
        final float rawY = computator.computeRawY(139);


        calculateBpToDraw(subcolumnRawX, subcolumnRawX + subcolumnWidth, baseRawY, rawY);
        switch (mode){
            case  MODE_DRAW:
                drawBpColumn(columnIndex,computator,columnValue,canvas,subcolumnRawX,subcolumnWidth);
                break;
            case MODE_CHECK_TOUCH:
                checkBpToDraw(columnIndex,valueIndex);
                break;
            case MODE_HIGHLIGHT:
              //  highlightBpColumn(canvas,valueIndex);
                break;
        }

        subcolumnRawX += subcolumnWidth + subcolumnSpacing;
        ++valueIndex;

    }
    private void calculateBpToDraw(float left, float right, float rawBaseY, float rawY) {
        // Calculate rect that will be drawn as column, subcolumn or label background.

        drawRect.left = left;
        drawRect.right = right;
        drawRect.top = rawY;
        drawRect.bottom = rawBaseY - subcolumnSpacing;

    }
    int selectedBpValue=-1;
    private void checkBpToDraw(int columnIndex, int valueIndex) {

        if (drawRect.contains(touchedPoint.x, touchedPoint.y)) {
            selectedBpValue=columnIndex;
            selectedValue.set(columnIndex, valueIndex, 0);
        }
    }
    private void drawBpColumn(int columnIndex,ChartComputator computator,BpValue columnValue,Canvas canvas,float subcolumnRawX,float subcolumnWidth ) {


        if(selectedBpValue!=-1&&selectedBpValue==columnIndex){
            final ColumnChartData data = dataProvider.getColumnChartData();
            Bitmap highBitmap=data.getHighBitmap();
            Bitmap lowBitmap=data.getLowBitmap();
            float cx=subcolumnRawX+subcolumnWidth/2;

            final float rawBgTopSelected = computator.computeRawY(columnValue.getBgTop()+20);
            final float rawBgBottomSelected = computator.computeRawY(columnValue.getBgBottom()-20);
            columnPaint.setColor(Color.parseColor("#c8c8c6"));

            final float rawBitmapHighY = computator.computeRawY(columnValue.getBgTop()+10);
            final float rawBitmapLowY = computator.computeRawY(columnValue.getBgBottom()-10);
            canvas.drawRect(subcolumnRawX, rawBgTopSelected, subcolumnRawX + subcolumnWidth, rawBgBottomSelected, columnPaint);
            canvas.drawBitmap(highBitmap,cx-highBitmap.getWidth()/2,rawBitmapHighY-highBitmap.getHeight(),columnPaint);
            canvas.drawBitmap(lowBitmap,cx-lowBitmap.getWidth()/2,rawBitmapLowY,columnPaint);
            columnPaint.setColor(Color.WHITE);
            columnPaint.setTextSize(Utils.dp2px(density,8));
            Rect rectText = new Rect();
            String highValue=String.valueOf(columnValue.getHighValue());
            String LowValue=String.valueOf(columnValue.getLowValue());
            float textWidth = columnPaint.measureText(highValue);
            Paint.FontMetrics metrics = columnPaint.getFontMetrics();
            float dy = -(metrics.descent + metrics.ascent) / 2;
            canvas.drawText(highValue,cx-textWidth/2,rawBitmapHighY-highBitmap.getHeight()/2+dy/2,columnPaint);
            float textWidthLow = columnPaint.measureText(LowValue);
            Paint.FontMetrics metricsLow = columnPaint.getFontMetrics();
            float dyLow = -(metricsLow.descent + metricsLow.ascent) / 2;
            canvas.drawText(LowValue,cx-textWidthLow/2,rawBitmapLowY+lowBitmap.getHeight()/2+dy*3/2,columnPaint);

            // canvas.restoreToCount(sc);
        }
        final float rawBgTop = computator.computeRawY(columnValue.getBgTop());
        final float rawBgBottom = computator.computeRawY(columnValue.getBgBottom());
        columnPaint.setColor(columnValue.getBgColor());
        canvas.drawRect(subcolumnRawX, rawBgTop, subcolumnRawX + subcolumnWidth, rawBgBottom, columnPaint);

        if (columnValue.getHighValue() == 0 && columnValue.getLowValue() == 0) return;
        final float rawHighY = computator.computeRawY(columnValue.getHighValue());
        final float rawHighYBottom = computator.computeRawY(columnValue.getHighValue() - 5);
        columnPaint.setColor(columnValue.getHighValueColor());
        canvas.drawRect(subcolumnRawX, rawHighY, subcolumnRawX + subcolumnWidth, rawHighYBottom, columnPaint);
        //int sc = canvas.saveLayer(contentRect.left, contentRect.top, contentRect.right, contentRect.bottom, null, Canvas.ALL_SAVE_FLAG);

        final float rawLowY = computator.computeRawY(columnValue.getLowValue());
        final float rawLowTop= computator.computeRawY(columnValue.getLowValue()+ 5);
        columnPaint.setColor(columnValue.getLowValueColor());
        canvas.drawRect(subcolumnRawX, rawLowTop, subcolumnRawX + subcolumnWidth, rawLowY, columnPaint);
    }

    private void drawWeekColumns(Canvas canvas, float rawx, int cicleSquare) {
        columnPaint.setStrokeWidth(Utils.dp2px(density, 2));
        canvas.drawLine(rawx, drawRect.bottom, rawx, drawRect.top, columnPaint);
        canvas.drawCircle(rawx, drawRect.top, Utils.dp2px(density, cicleSquare), columnPaint);
    }

    private void drawColumnForStacked(Canvas canvas) {
        final ColumnChartData data = dataProvider.getColumnChartData();
        final float columnWidth = calculateColumnWidth();
        // Columns are indexes from 0 to n, column index is also column X value
        int columnIndex = 0;
        for (Column column : data.getColumns()) {
            processColumnForStacked(canvas, column, columnWidth, columnIndex, MODE_DRAW);
            ++columnIndex;
        }
    }

    private void highlightColumnForStacked(Canvas canvas) {
        final ColumnChartData data = dataProvider.getColumnChartData();
        final float columnWidth = calculateColumnWidth();
        // Columns are indexes from 0 to n, column index is also column X value
        Column column = data.getColumns().get(selectedValue.getFirstIndex());
        processColumnForStacked(canvas, column, columnWidth, selectedValue.getFirstIndex(), MODE_HIGHLIGHT);
    }

    private void checkTouchForStacked(float touchX, float touchY) {
        touchedPoint.x = touchX;
        touchedPoint.y = touchY;
        final ColumnChartData data = dataProvider.getColumnChartData();
        final float columnWidth = calculateColumnWidth();
        int columnIndex = 0;
        for (Column column : data.getColumns()) {
            // canvas is not needed for checking touch
            processColumnForStacked(null, column, columnWidth, columnIndex, MODE_CHECK_TOUCH);
            ++columnIndex;
        }
    }

    private void processColumnForStacked(Canvas canvas, Column column, float columnWidth, int columnIndex, int mode) {
        final ChartComputator computator = chart.getChartComputator();
        final float rawX = computator.computeRawX(columnIndex);
        final float halfColumnWidth = columnWidth / 2;
        float mostPositiveValue = baseValue;
        float mostNegativeValue = baseValue;
        float subcolumnBaseValue = baseValue;
        int valueIndex = 0;
        for (ColumnValue columnValue : column.getValues()) {
            columnPaint.setColor(columnValue.getColor());
            if (columnValue.getValue() >= baseValue) {
                // Using values instead of raw pixels make code easier to
                // understand(for me)
                subcolumnBaseValue = mostPositiveValue;
                mostPositiveValue += columnValue.getValue();
            } else {
                subcolumnBaseValue = mostNegativeValue;
                mostNegativeValue += columnValue.getValue();
            }
            final float rawBaseY = computator.computeRawY(subcolumnBaseValue);
            final float rawY = computator.computeRawY(subcolumnBaseValue + columnValue.getValue());
            calculateRectToDraw(columnValue, rawX - halfColumnWidth, rawX + halfColumnWidth, rawBaseY, rawY);
            switch (mode) {
                case MODE_DRAW:
                    drawSubcolumn(canvas, column, columnValue, true);
                    break;
                case MODE_HIGHLIGHT:
                    highlightSubcolumn(canvas, column, columnValue, valueIndex, true);
                    break;
                case MODE_CHECK_TOUCH:
                    checkRectToDraw(columnIndex, valueIndex);
                    break;
                default:
                    // There no else, every case should be handled or exception will
                    // be thrown
                    throw new IllegalStateException("Cannot process column in mode: " + mode);
            }
            ++valueIndex;
        }
    }

    /**
     * 得到垂直偏移量
     *
     * @param thickness 厚度
     * @param angle     角度
     * @return 垂直偏移量
     */
    public double getOffsetY(double thickness, double angle) {
        return thickness * Math.sin(angle * Math.PI / 180);
    }

    public double getOffsetX(double thickness, double angle) {
        return thickness * Math.cos(angle * Math.PI / 180);
    }

    private int mAngle = 45;
    private int mAxisBaseThickness = 20;

    private void drawSubcolumn(Canvas canvas, Column column, ColumnValue columnValue, boolean isStacked) {
        Bitmap bitmap = column.getBitmap();
        if (bitmap != null) {
            drawBitmap(canvas, bitmap);
            return;
        }
        if (column.isHasRectF()) {
            final ColumnChartData data = dataProvider.getColumnChartData();
            final ChartComputator computator = chart.getChartComputator();
            final float columnWidth = calculateColumnWidth();
            float subcolumnWidth = (columnWidth - subcolumnSpacing) / 2;
            columnPaint.setStrokeWidth(columnWidth / 2);
            float maxValue = data.getMaxValue();
            drawRect.left = drawRect.left + subcolumnWidth / 2;
            drawRect.right = drawRect.right - subcolumnWidth / 2;
            if (data.getBgChartColor() != 0) {
                columnPaint.setColor(data.getBgChartColor());
                RectF rectF = new RectF(drawRect.left, computator.computeRawY(maxValue), drawRect.right, drawRect.bottom);
                canvas.drawRoundRect(rectF,
                        subcolumnWidth, subcolumnWidth, columnPaint);
            }
            columnPaint.setColor(columnValue.getColor());
            int sc = canvas.saveLayer(drawRect.left, drawRect.top,
                    drawRect.right, drawRect.bottom, null, Canvas.ALL_SAVE_FLAG);
            if (maxValue != 0) {
                RectF rectF = new RectF(drawRect.left, computator.computeRawY(maxValue), drawRect.right, drawRect.bottom);
                canvas.drawRoundRect(rectF,
                        subcolumnWidth, subcolumnWidth, columnPaint);
                columnPaint.setXfermode(porterDuffXfermode);
            }

            canvas.drawRoundRect(drawRect, subcolumnWidth, subcolumnWidth, columnPaint);
            columnPaint.setXfermode(null);
            canvas.restoreToCount(sc);
//
        } else {
            if (columnValue.getValue() != 0) {
                columnPaint.setAlpha(255);
                canvas.drawRect(drawRect, columnPaint);
                if (column.isIs3D()) draw3D(canvas);
            }
        }
        if (column.hasLabels()) {
            drawLabel(canvas, column, columnValue, isStacked, labelOffset);
        }

    }

    private void drawBitmap(Canvas canvas, Bitmap bitmap) {
        if (bitmap != null) {
            final float columnWidth = calculateColumnWidth();
            final ChartComputator computator = chart.getChartComputator();
            Matrix matrix = new Matrix();
            float height = computator.getContentRect().bottom - computator.getContentRect().top;
            float bitmapHeight = bitmap.getHeight();
            matrix.preScale(1, height / bitmapHeight);
            matrix.postTranslate(drawRect.left - bitmap.getWidth() / 2 + columnWidth / 2, Utils.dp2px(density, 4));
            canvas.drawBitmap(bitmap, matrix, columnPaint);
        }
    }

    private void draw3D(Canvas canvas) {

        //水平偏移量
        double offsetX = getOffsetX(mAxisBaseThickness, mAngle);
        //垂直偏移量
        double offsetY = getOffsetY(mAxisBaseThickness, mAngle);
        //柱状图顶部
        float topLeft = Math.round(drawRect.left + offsetX);
        float topTop = Math.round(drawRect.top - offsetY);
        float topRight = Math.round(drawRect.right + offsetX);
        float topBottom = Math.round(drawRect.top);

        Path path = new Path();
        path.moveTo(drawRect.left, drawRect.top);
        path.lineTo(topLeft, topTop);
        path.lineTo(topRight, topTop);
        path.lineTo(drawRect.right, topBottom);
        columnPaint.setAlpha(200);
        canvas.drawPath(path, columnPaint);
        path.reset();
        //柱状图右侧
        float rightLeft = Math.round(drawRect.right);
        float rightTop = Math.round(drawRect.top - offsetY);
        float rightRight = Math.round(drawRect.right + offsetX);
        float rightBottom = Math.round(drawRect.bottom - offsetY);

        path.moveTo(drawRect.right, drawRect.top);
        path.lineTo(rightRight, rightTop);
        path.lineTo(rightRight, rightBottom);
        path.lineTo(rightLeft, drawRect.bottom);
        columnPaint.setAlpha(100);
        canvas.drawPath(path, columnPaint);
    }

    private void highlightSubcolumn(Canvas canvas, Column column, ColumnValue columnValue, int valueIndex,
                                    boolean isStacked) {
        if (column.isHasRectF()) return;
        if (selectedValue.getSecondIndex() == valueIndex) {
            columnPaint.setColor(columnValue.getDarkenColor());
            if (column.isHasRectF()) {
                canvas.drawRoundRect(drawRect, 10, 10, columnPaint);
            } else {
                canvas.drawRect(drawRect.left - touchAdditionalWidth, drawRect.top, drawRect.right + touchAdditionalWidth,
                        drawRect.bottom, columnPaint);
            }
            if (column.hasLabels() || column.hasLabelsOnlyForSelected()) {
                drawLabel(canvas, column, columnValue, isStacked, labelOffset);
            }
        }
    }
    private void highlightBpColumn(Canvas canvas,  int valueIndex
                                   ) {
        Log.i(TAG, "highlightBpColumn: ");
        if (selectedValue.getSecondIndex() == valueIndex) {
            columnPaint.setColor(Color.parseColor("#80ffffff"));
            canvas.drawRect(drawRect.left, drawRect.top, drawRect.right ,
                        drawRect.bottom, columnPaint);


        }
    }

    private void checkRectToDraw(int columnIndex, int valueIndex) {

        if (drawRect.contains(touchedPoint.x, touchedPoint.y)) {
            selectedValue.set(columnIndex, valueIndex, 0);
        }
    }

    private static final String TAG = "ColumnChartRenderer";

    protected float calculateColumnWidth() {
        final ChartComputator computator = chart.getChartComputator();
        // columnWidht should be at least 2 px
        float columnWidth = fillRatio * computator.getContentRect().width() / computator.getVisibleViewport().width();
        if (columnWidth < 2) {
            columnWidth = 2;
        }

        return columnWidth;
    }

    private void calculateRectToDraw(ColumnValue columnValue, float left, float right, float rawBaseY, float rawY) {
        // Calculate rect that will be drawn as column, subcolumn or label background.

        drawRect.left = left;
        drawRect.right = right;
        if (columnValue.getValue() >= baseValue) {
            drawRect.top = rawY;
            drawRect.bottom = rawBaseY - subcolumnSpacing;
        } else {
            drawRect.bottom = rawY;
            drawRect.top = rawBaseY + subcolumnSpacing;
        }
    }

    private void drawLabel(Canvas canvas, Column column, ColumnValue columnValue, boolean isStacked, float offset) {
        final ChartComputator computator = chart.getChartComputator();
        valuesBuff[0] = columnValue.getValue();
        final int numChars = column.getFormatter().formatValue(labelBuffer, valuesBuff, columnValue.getLabel());
        if (numChars == 0) {
            // No need to draw empty label
            return;
        }
        final float labelWidth = labelPaint.measureText(labelBuffer, labelBuffer.length - numChars, numChars);
        final int labelHeight = Math.abs(fontMetrics.ascent);
        float left = drawRect.centerX() - labelWidth / 2 - labelMargin;
        float right = drawRect.centerX() + labelWidth / 2 + labelMargin;
        float top;
        float bottom;
        if (isStacked && labelHeight < drawRect.height() - (2 * labelMargin)) {
            // For stacked columns draw label only if label height is less than subcolumn height - (2 * labelMargin).
            if (columnValue.getValue() >= baseValue) {
                top = drawRect.top;
                bottom = drawRect.top + labelHeight + labelMargin * 2;
            } else {
                top = drawRect.bottom - labelHeight - labelMargin * 2;
                bottom = drawRect.bottom;
            }
        } else if (!isStacked) {
            // For not stacked draw label at the top for positive and at the bottom for negative values
            if (columnValue.getValue() >= baseValue) {
                top = drawRect.top - offset - labelHeight - labelMargin * 2;
                if (top < computator.getContentRect().top) {
                    top = drawRect.top + offset;
                    bottom = drawRect.top + offset + labelHeight + labelMargin * 2;
                } else {
                    bottom = drawRect.top - offset;
                }
            } else {
                bottom = drawRect.bottom + offset + labelHeight + labelMargin * 2;
                if (bottom > computator.getContentRect().bottom) {
                    top = drawRect.bottom - offset - labelHeight - labelMargin * 2;
                    bottom = drawRect.bottom - offset;
                } else {
                    top = drawRect.bottom + offset;
                }
            }
        } else {
            // Draw nothing.
            return;
        }

        labelBackgroundRect.set(left, top, right, bottom);
        drawLabelTextAndBackground(canvas, labelBuffer, labelBuffer.length - numChars, numChars,
                columnValue.getDarkenColor());

    }

}
