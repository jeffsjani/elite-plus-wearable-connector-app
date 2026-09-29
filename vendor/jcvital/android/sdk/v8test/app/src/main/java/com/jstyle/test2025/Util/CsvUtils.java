package com.jstyle.test2025.Util;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.support.v4.content.FileProvider;
import android.text.TextUtils;
import android.util.Log;
import android.util.SparseArray;


import com.jstyle.test2025.BuildConfig;
import com.jstyle.test2025.R;
import com.jstyle.test2025.daomananger.HeartDataDaoManager;
import com.jstyle.test2025.daomananger.SleepDataDaoManager;
import com.jstyle.test2025.daomananger.StepDetailDataDaoManager;
import com.jstyle.test2025.model.CsvModel;
import com.jstyle.test2025.model.HeartData;
import com.jstyle.test2025.model.SleepData;
import com.jstyle.test2025.model.StepDetailData;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.OutputStreamWriter;
import java.text.ParseException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.List;

public class CsvUtils {
    private final static String baseDir = Environment.getExternalStorageDirectory()
            .getAbsolutePath() + "/" + BuildConfig.APPLICATION_ID;
    public final static String testPath = baseDir + "/test/";
    private static final long oneMinMillis = 60 * 1000l;

    public static void createCsvFile(Context context, String dataDate) {
        File csvFile = null;
        BufferedWriter csvWtriter = null;
        csvFile = new File(testPath + "test.csv");
        File parent = csvFile.getParentFile();
        if (parent != null && !parent.exists()) {
            parent.mkdirs();
        }
        try {
            if (csvFile.exists()) csvFile.delete();
            csvFile.createNewFile();
            csvWtriter = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(csvFile), "GB2312"), 1024);
            String[] head = {"Date", "Heart Rate", "Calorie", "Distance", "Step", "Sleep Quality"};
            List<String> headList = Arrays.asList(head);
            SparseArray<CsvModel> dataHashMap = new SparseArray<>();
            String endDate = DateUtil.getTomorrowDateString(dataDate);
            String startDate = DateUtil.getDateString(dataDate, 30);
            Log.i(TAG, "createCsvFile: " + startDate + " " + endDate);
            initData(dataHashMap, startDate + " 00:00:00");
            Log.i(TAG, "createCsvFile: step start");
            List<StepDetailData> stepDetailDataList = StepDetailDataDaoManager.queryData(startDate, endDate);
            Log.i(TAG, "createCsvFile: step end");
            List<HeartData> heartDataList = HeartDataDaoManager.queryData(startDate, endDate);
            Log.i(TAG, "createCsvFile: heart end");
            for (HeartData heartData : heartDataList) {
                String date = heartData.getTime();
                int count = get1MIndex(startDate, date);
                int heartRate = heartData.getHeart();
                //String[]data=dataHashMap.get(count);
                CsvModel csvModel = dataHashMap.get(count);

                if (csvModel != null) csvModel.setHeartRate(String.valueOf(heartRate));
                //   data[1]= String.valueOf(heartRate);

            }
            for (StepDetailData stepDetailData : stepDetailDataList) {
                String date = stepDetailData.getDate();
                int count = get1MIndex(startDate, date);
                String cal = stepDetailData.getCal();
                String distance = stepDetailData.getDistance();
                String detailSteps = stepDetailData.getMinterStep();
                String[] stepArray = detailSteps.split(" ");
                for (int i = 0; i < stepArray.length; i++) {
                    //  String[]data=dataHashMap.get(count+i);
                    CsvModel csvModel = dataHashMap.get(count + i);
                    if (csvModel != null) {
                        csvModel.setCal(cal);
                        csvModel.setDistance(distance);
                        csvModel.setStep(stepArray[i]);
                    }
//                    if(data!=null){
//                        data[2]=cal;
//                        data[3]=distance;
//                        data[4]=stepArray[i];
//                    }

                }


            }

            List<SleepData> sleepDataList = SleepDataDaoManager.queryData(startDate, endDate);
            Log.i(TAG, "createCsvFile: sleep end");
            for (SleepData sleepData : sleepDataList) {
                String time = sleepData.getTime();
                String data = sleepData.getDateString();
                int startCount = get1MIndex(startDate, time);
                for (int i = startCount; i < startCount + 5; i++) {
                    //String[]dataArray=dataHashMap.get(i);
                    CsvModel csvModel = dataHashMap.get(i);
                    if (csvModel != null)
                        csvModel.setSleepQuality(Integer.valueOf(data) == 0 ? "--" : Integer.valueOf(data) + "");
                    //  if(dataArray!=null)
                    // dataArray[5]= Integer.valueOf(data) == 0 ? "--" : Integer.valueOf(data)+"";
                }


            }
            writeRow(headList, csvWtriter);
//            for (Map.Entry<Integer, String[]> entry : dataHashMap.entrySet()) {
//                String[] values = entry.getValue();
//                writeRowContent(values, csvWtriter);
//            }
//            for (Map.Entry<Integer, CsvModel> entry : dataHashMap.entrySet()) {
//                CsvModel csvModel = entry.getValue();
//                writeRowContent(csvModel, csvWtriter);
//            }
            int size=dataHashMap.size();
            for (int i=0;i<size;i++) {
                CsvModel csvModel = dataHashMap.get(i);
                writeRowContent(csvModel, csvWtriter);
            }
//            for (List<String> list : dataList) {
//                writeRow(list, csvWtriter);
//            }
            // List<String> contentList = Arrays.asList(dataArrays);
            //writeRowContent(contentList, csvWtriter);
            csvWtriter.flush();
            csvWtriter.close();
        } catch (
                IOException e) {
            e.printStackTrace();
        }
        shareByPhone(context, csvFile.getAbsolutePath());
    }

    public static void shareByPhone(Context context, String path) {
        Uri imageUri = null;
        if (Build.VERSION.SDK_INT >= 24) {
            imageUri = FileProvider.getUriForFile(context.getApplicationContext(),
                    context.getString(R.string.fileprovider), new File(path));
        } else {
            imageUri = Uri.fromFile(new File(path));
        }
        Intent shareIntent = new Intent();
        shareIntent.setAction(Intent.ACTION_SEND);
        shareIntent.putExtra(Intent.EXTRA_STREAM, imageUri);
        shareIntent.setType("*/*");
        context.startActivity(Intent.createChooser(shareIntent, "分享到"));
    }

    private static final String TAG = "CsvUtils";

    private static void writeRow(List<String> row, BufferedWriter csvWriter) throws IOException {
        for (Object data : row) {
            StringBuffer sb = new StringBuffer();
            String rowStr = sb.append("\"").append(data).append("\",").toString();
            csvWriter.write(rowStr);
        }
        csvWriter.newLine();
    }

    private static void writeRowContent(String[] values, BufferedWriter csvWriter) throws IOException {
        for (String data : values) {
            StringBuffer sb = new StringBuffer();
            String rowStr = sb.append("\"").append(TextUtils.isEmpty(data)?"--":data).append("\",").toString();
            csvWriter.write(rowStr);
        }
        csvWriter.newLine();

    }

    private static void writeRowContent(CsvModel csvModel, BufferedWriter csvWriter) throws IOException {

        // for (String data : values) {
        StringBuffer sb = new StringBuffer();
        String rowStr = sb.append("\"").append(csvModel.getDate()).append("\",").toString();
        csvWriter.write(rowStr);
        sb = new StringBuffer();
        String heartRateString = sb.append("\"").append(csvModel.getHeartRate()).append("\",").toString();
        csvWriter.write(heartRateString);
        sb = new StringBuffer();
        String calS = sb.append("\"").append(csvModel.getCal()).append("\",").toString();
        csvWriter.write(calS);
        sb = new StringBuffer();
        String disS = sb.append("\"").append(csvModel.getDistance()).append("\",").toString();
        csvWriter.write(disS);
        sb = new StringBuffer();
        String stepS = sb.append("\"").append(csvModel.getStep()).append("\",").toString();
        csvWriter.write(stepS);
        sb = new StringBuffer();
        String sleepS = sb.append("\"").append(csvModel.getSleepQuality()).append("\",").toString();
        csvWriter.write(sleepS);
        //  }
        csvWriter.newLine();

    }

    private static void initData(SparseArray<CsvModel> hashMap, String startDate) throws IOException {
        int size = 1440 * 31;
        try {
            long startTime=format.parse(startDate).getTime();
            for (int i = 0; i < size; i++) {
                String date = getCountTime(i, startTime);
                CsvModel csvModel = new CsvModel();
                csvModel.setDate(date);
                hashMap.put(i, csvModel);

            }
        } catch (ParseException e) {
            e.printStackTrace();
        }


    }
    private static void initDataString(HashMap<Integer, String[]> hashMap, String startDate) throws IOException {

        int length = 6;
        int size = 1440 * 31;
//        for (int i = 0; i < size; i++) {
//            String[] data = new String[length];
//            String date = getCountTime(i, startDate);
//            data[0]=date;
//            hashMap.put(i, data);
//        }

    }

    private static List<Integer> getSleepTime(int[] fiveSleepData) {
        List<Integer> list = new ArrayList<>();
        int goBed = -1;
        int upBed = 0;
        int offCount = 0;
        for (int i = 0; i < fiveSleepData.length; i++) {
            int data = fiveSleepData[i];
            if (data != -1) {
                offCount = 0;
                if (goBed == -1) {
                    list.add(i);
                    goBed = i;
                }

            } else {
                offCount++;
                if (offCount == 6 && goBed != -1) {//30分钟离床
                    list.add(i - 5);
                    offCount = 0;
                    goBed = -1;
                }
            }
            if (i == fiveSleepData.length - 1 && goBed != -1) {
                list.add(i);
            }
        }
        return list;
    }

    public static int get1MIndex(String time, String defaultTime) {
        SimpleDateFormat format = new SimpleDateFormat("yy.MM.dd HH:mm:ss");
        int count = 0;
        try {
            Date date = format.parse(time + " 00:00:00");
            Date dateBase = format.parse(defaultTime);
            long min = dateBase.getTime() - date.getTime();
            count = (int) (min / oneMinMillis);
        } catch (Exception e) {
            // TODO: handle exception
        }
        return count;
    }
    static SimpleDateFormat format = new SimpleDateFormat("yy.MM.dd HH:mm:ss");
    public static String getCountTime(int count, long defaultTime) {

        //   String base = "00:00:00";
        long time = defaultTime + count * oneMinMillis;

        return format.format(new Date(time));
    }

}
