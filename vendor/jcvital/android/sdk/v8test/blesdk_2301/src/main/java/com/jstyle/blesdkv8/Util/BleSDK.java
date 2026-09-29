package com.jstyle.blesdkv8.Util;


import android.text.TextUtils;
import android.util.Log;

import com.jstyle.blesdkv8.callback.DataListener2301;
import com.jstyle.blesdkv8.constant.BleConst;
import com.jstyle.blesdkv8.constant.DeviceConst;

import com.jstyle.blesdkv8.constant.DeviceKey;
import com.jstyle.blesdkv8.model.AutoMode;
import com.jstyle.blesdkv8.model.AutoTestMode;
import com.jstyle.blesdkv8.model.Clock;
import com.jstyle.blesdkv8.model.MyAutomaticHRMonitoring;
import com.jstyle.blesdkv8.model.MyPersonalInfo;
import com.jstyle.blesdkv8.model.MyDeviceTime;
import com.jstyle.blesdkv8.model.MySedentaryReminder;
import com.jstyle.blesdkv8.other.ResolveUtil;

import java.io.UnsupportedEncodingException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Date;
import java.util.HashMap;
import java.util.List;
import java.util.Map;


/**
 * Created by Administrator on 2018/4/9.
 */

public class BleSDK {
    public static final int DATA_READ_START = 0;
    public static final int DATA_READ_CONTINUE = 2;
    public static final int DATA_DELETE = 99;
    public static final byte DistanceMode_MILE = (byte) 0x81;
    public static final byte DistanceMode_KM = (byte) 0x80;
    public static final byte TimeMode_12h = (byte) 0x81;
    public static final byte TimeMode_24h = (byte) 0x80;
    public static final byte WristOn_Enable = (byte) 0x81;
    public static final byte WristOn_DisEnable = (byte) 0x80;
    public static final byte TempUnit_C = (byte) 0x80;
    public static final byte TempUnit_F = (byte) 0x81;

    public static final String TAG = "BleSDK";
    public static boolean isruning = false;

    private static byte[] getByteArray(float f) {
        int intbits = Float.floatToIntBits(f);//将float里面的二进制串解释为int整数
        return getByteArrays(intbits);
    }

    public static byte[] getByteArrays(int i) {
        byte[] b = new byte[4];
        b[3] = (byte) ((i & 0xff000000) >> 24);
        b[2] = (byte) ((i & 0x00ff0000) >> 16);
        b[1] = (byte) ((i & 0x0000ff00) >> 8);
        b[0] = (byte) (i & 0x000000ff);
        return b;
    }


    public static void DataParsingWithData(byte[] value, final DataListener2301 dataListener) {
        Map<String, String> map = new HashMap<>();
        switch (value[0]) {

            case DeviceConst.CMD_Set_UseInfo:
                dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.SetPersonalInfo));
                break;
            case DeviceConst.CMD_Set_Auto:
                dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.SetAutomatic));
                break;
            case DeviceConst.CMD_Set_DeviceID:
                dataListener.dataCallback(ResolveUtil.setMacSuccessful());
                break;
            case DeviceConst.CMD_SET_TIME:
                dataListener.dataCallback(ResolveUtil.setTimeSuccessful(value));
                break;

            case DeviceConst.CMD_GET_TIME:
                dataListener.dataCallback(ResolveUtil.getDeviceTime(value));
                break;
            case DeviceConst.CMD_GET_USERINFO:
                dataListener.dataCallback(ResolveUtil.getUserInfo(value));
                break;
            case DeviceConst.CMD_Enable_Activity:
                dataListener.dataCallback(ResolveUtil.getActivityData(value));
                break;
            case DeviceConst.CMD_Get_BatteryLevel:
                dataListener.dataCallback(ResolveUtil.getDeviceBattery(value));
                break;
            case DeviceConst.CMD_Get_Address:
                dataListener.dataCallback(ResolveUtil.getDeviceAddress(value));
                break;
            case DeviceConst.CMD_Get_Version:
                dataListener.dataCallback(ResolveUtil.getDeviceVersion(value));
                break;
            case DeviceConst.CMD_Get_Auto:
                dataListener.dataCallback(ResolveUtil.getAutoHeart(value));
                break;
            case DeviceConst.CMD_Reset:
                dataListener.dataCallback(ResolveUtil.Reset());
                break;
            case DeviceConst.CMD_Mcu_Reset:
                dataListener.dataCallback(ResolveUtil.MCUReset());
                break;
            case DeviceConst.CMD_Get_TotalData:
                if (GetTotalActivityDataWithMode) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.Delete_GetTotalActivityData));
                } else {
                    dataListener.dataCallback(ResolveUtil.getTotalStepData(value));
                }
                break;
            case DeviceConst.CMD_Get_DetailData:
                if (GetDetailActivityDataWithMode) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.deleteGetDetailActivityDataWithMode));
                } else {
                    dataListener.dataCallback(ResolveUtil.getDetailData(value));
                }
                break;
            case DeviceConst.CMD_Get_SleepData:
                if (Delete_GetDetailSleepData) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.Delete_GetDetailSleepData));
                } else {
                    dataListener.dataCallback(ResolveUtil.getSleepData(value));
                }
                break;
            case DeviceConst.CMD_Get_HeartData:
                if (GetDynamicHRWithMode) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.Delete_GetDynamicHR));
                } else {
                    dataListener.dataCallback(ResolveUtil.getHeartData(value));
                }

                break;
            case DeviceConst.CMD_Get_OnceHeartData:
                if (GetStaticHRWithMode) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.Delete_GetStaticHR));
                } else {
                    dataListener.dataCallback(ResolveUtil.getOnceHeartData(value));
                }

                break;
            case DeviceConst.CMD_Get_HrvTestData:
                if (readhrv) {
                    dataListener.dataCallback(ResolveUtil.getHrvTestData(value));
                } else {
                    dataListener.dataCallback(ResolveUtil.DeleteHrv());
                }
                break;
            case DeviceConst.Obtain_detailed_sleep_data:
                if (readgetObtainDetailedSleepData) {
                    dataListener.dataCallback(ResolveUtil.getObtainDetailedSleepData(value));
                } else {
                    dataListener.dataCallback(ResolveUtil.DeletesLEEP());
                }
                break;
            case DeviceConst.Temperature_3NTC:
                dataListener.dataCallback(ResolveUtil.Temperature_3NTC(value));
                break;
            case DeviceConst.SetBasic_parameters_of_equipment:
                dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.SetBasic_parameters_of_equipment));
                break;
            case DeviceConst.GetBasic_parameters_of_equipment:
                dataListener.dataCallback(ResolveUtil.GetBasic_parameters_of_equipment(value));
                break;
            case DeviceConst.PPG:
                if (setECGRealtimeDuringHRVEnable && value.length > 16) {
                    dataListener.dataCallback(ResolveUtil.getECG(value));
                }
                break;
            case DeviceConst.ReadTempHisrory:
                if (GetTemperature_historyDataWithMode) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.deleteGetTemperature_historyDataWithMode));
                } else {
                    dataListener.dataCallback(ResolveUtil.getTempData(value));
                }
                break;
            case DeviceConst.Oxygen_data:
                if (Obtain_The_data_of_manual_blood_oxygen_test) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.Delete_Obtain_The_data_of_manual_blood_oxygen_test));
                } else {
                    dataListener.dataCallback(ResolveUtil.GetAutomaticSpo2Monitoring(value));
                }
                break;
            case DeviceConst.CMD_HeartPackageFromDevice:
                dataListener.dataCallback(ResolveUtil.getActivityExerciseData(value));
                break;
            case DeviceConst.CMD_Set_Name:
                dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.CMD_Set_Name));
                break;
            case DeviceConst.CMD_Get_Name:
                dataListener.dataCallback(ResolveUtil.getDeviceName(value));
                break;
            case DeviceConst.CMD_Get_SPORTData:
                if (GetActivityModeDataWithMode) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.Delete_ActivityModeData));
                } else {
                    dataListener.dataCallback(ResolveUtil.getExerciseData(value));
                }
                break;
            case DeviceConst.MeasurementWithType:
                if (StartDeviceMeasurementWithType) {
                    Map<String, Object> vv = new HashMap<>();
                    switch (value[1]) {
                        case 1://hrv
                            vv.put(DeviceKey.DataType, BleConst.MeasurementHrvCallback);
                            vv.put(DeviceKey.End, true);
                            Map<String, String> lm = new HashMap<>();
                            lm.put(DeviceKey.Type, ResolveUtil.getValue(value[1], 0) + "");
                            lm.put(DeviceKey.HeartRate, ResolveUtil.getValue(value[2], 0) + "");
                            lm.put(DeviceKey.Blood_oxygen, ResolveUtil.getValue(value[3], 0) + "");
                            lm.put(DeviceKey.HRV, ResolveUtil.getValue(value[4], 0) + "");
                            lm.put(DeviceKey.Stress, ResolveUtil.getValue(value[5], 0) + "");
                            lm.put(DeviceKey.HighPressure, ResolveUtil.getValue(value[6], 0) + "");
                            lm.put(DeviceKey.LowPressure, ResolveUtil.getValue(value[7], 0) + "");
                            vv.put(DeviceKey.Data, lm);
                            dataListener.dataCallback(vv);
                            break;
                        case 2://heart
                            vv.put(DeviceKey.DataType, BleConst.MeasurementHeartCallback);
                            vv.put(DeviceKey.End, true);
                            Map<String, String> lmB = new HashMap<>();
                            lmB.put(DeviceKey.Type, ResolveUtil.getValue(value[1], 0) + "");
                            lmB.put(DeviceKey.HeartRate, ResolveUtil.getValue(value[2], 0) + "");
                            lmB.put(DeviceKey.Blood_oxygen, ResolveUtil.getValue(value[3], 0) + "");
                            lmB.put(DeviceKey.HRV, ResolveUtil.getValue(value[4], 0) + "");
                            lmB.put(DeviceKey.Stress, ResolveUtil.getValue(value[5], 0) + "");
                            lmB.put(DeviceKey.HighPressure, ResolveUtil.getValue(value[6], 0) + "");
                            lmB.put(DeviceKey.LowPressure, ResolveUtil.getValue(value[7], 0) + "");
                            vv.put(DeviceKey.Data, lmB);
                            dataListener.dataCallback(vv);
                            break;
                        case 3://0xy
                            vv.put(DeviceKey.DataType, BleConst.MeasurementOxygenCallback);
                            vv.put(DeviceKey.End, true);
                            Map<String, String> lmC = new HashMap<>();
                            lmC.put(DeviceKey.Type, ResolveUtil.getValue(value[1], 0) + "");
                            lmC.put(DeviceKey.HeartRate, ResolveUtil.getValue(value[2], 0) + "");
                            lmC.put(DeviceKey.Blood_oxygen, ResolveUtil.getValue(value[3], 0) + "");
                            lmC.put(DeviceKey.HRV, ResolveUtil.getValue(value[4], 0) + "");
                            lmC.put(DeviceKey.Stress, ResolveUtil.getValue(value[5], 0) + "");
                            lmC.put(DeviceKey.HighPressure, ResolveUtil.getValue(value[6], 0) + "");
                            lmC.put(DeviceKey.LowPressure, ResolveUtil.getValue(value[7], 0) + "");
                            vv.put(DeviceKey.Data, lmC);
                            dataListener.dataCallback(vv);
                            break;
                    }
                } else {
                    Map<String, Object> vv = new HashMap<>();
                    switch (value[1]) {
                        case 1://hrv
                            vv.put(DeviceKey.DataType, BleConst.StopMeasurementHrvCallback);
                            vv.put(DeviceKey.End, true);
                            vv.put(DeviceKey.Data, new HashMap<>());
                            dataListener.dataCallback(vv);
                            break;
                        case 2://heart
                            vv.put(DeviceKey.DataType, BleConst.StopMeasurementHeartCallback);
                            vv.put(DeviceKey.End, true);
                            vv.put(DeviceKey.Data, new HashMap<>());
                            dataListener.dataCallback(vv);
                            break;
                        case 3://0xy
                            vv.put(DeviceKey.DataType, BleConst.StopMeasurementOxygenCallback);
                            vv.put(DeviceKey.End, true);
                            vv.put(DeviceKey.Data, new HashMap<>());
                            dataListener.dataCallback(vv);
                            break;
                    }
                }
                break;
            case DeviceConst.CMD_Get_Bloodsugar:
                if (startBloodsugar) {//只有开始测量才返回状态
                    Map<String, Object> vv = new HashMap<>();
                    vv.put(DeviceKey.DataType, BleConst.Blood_glucose_status);
                    vv.put(DeviceKey.End, true);
                    Map<String, String> lm = new HashMap<>();
                    lm.put(DeviceKey.Type, ResolveUtil.getValue(value[1], 0) + "");
                    vv.put(DeviceKey.Data, lm);
                    dataListener.dataCallback(vv);
                }
                break;
            case DeviceConst.Bloodsugar_data:
                Map<String, Object> vv = new HashMap<>();
                vv.put(DeviceKey.DataType, BleConst.Blood_glucose_data);
                vv.put(DeviceKey.End, false);
                Map<String, String> lm = new HashMap<>();
                lm.put(DeviceKey.Time, getFormatTimeString(System.currentTimeMillis(), "yyyy.MM.dd HH:mm:ss"));
                List<Integer> simplePpg = new ArrayList<>();
                if (value.length == 153) {//新血糖解析
                    byte[] valueer = new byte[value.length - 3];
                    System.arraycopy(value, 3, valueer, 0, valueer.length);
                    for (int i = 0; i < valueer.length / 3; i++) {
                        int valuedata = ResolveUtil.getValue(valueer[3 * i], 2)
                                + ResolveUtil.getValue(valueer[3 * i + 1], 1)
                                + ResolveUtil.getValue(valueer[3 * i + 2], 0);
                        simplePpg.add(valuedata);
                    }
                    lm.put(DeviceKey.PPG, Arrays.toString(simplePpg.toArray()));
                } else if (value.length == 203) {
                    byte[] valueer = new byte[value.length - 3];
                    System.arraycopy(value, 3, valueer, 0, valueer.length);
                    for (int i = 0; i < valueer.length / 4; i++) {
                        int valuedata = ResolveUtil.getValue(valueer[4 * i], 3)
                                + ResolveUtil.getValue(valueer[4 * i], 2)
                                + ResolveUtil.getValue(valueer[4 * i + 1], 1)
                                + ResolveUtil.getValue(valueer[4 * i + 2], 0);
                        simplePpg.add(valuedata);
                    }
                    lm.put(DeviceKey.PPG, Arrays.toString(simplePpg.toArray()));
                }


                vv.put(DeviceKey.Data, lm);
                dataListener.dataCallback(vv);
                break;

            case DeviceConst.CMD_Start_EXERCISE:
                if (FindActivityMode) {
                    Map<String, Object> mapEXERCISE = new HashMap<>();
                    mapEXERCISE.put(DeviceKey.DataType, BleConst.FindActivityMode);
                    mapEXERCISE.put(DeviceKey.End, true);
                    Map<String, String> mapsx = new HashMap<>();
                    mapsx.put(DeviceKey.Type, ResolveUtil.getValue(value[1], 0) + "");
                    mapsx.put(DeviceKey.Status, ResolveUtil.getValue(value[2], 0) + "");
                    mapEXERCISE.put(DeviceKey.Data, mapsx);
                    dataListener.dataCallback(mapEXERCISE);
                } else {
                    Map<String, Object> mapEXERCISE = new HashMap<>();
                    mapEXERCISE.put(DeviceKey.DataType, BleConst.EnterActivityMode);
                    mapEXERCISE.put(DeviceKey.End, true);
                    Map<String, String> mapsx = new HashMap<>();
                    mapsx.put(DeviceKey.enterActivityModeSuccess, ResolveUtil.getValue(value[1], 0) + "");
                    mapEXERCISE.put(DeviceKey.Data, mapsx);
                    dataListener.dataCallback(mapEXERCISE);
                }
                break;
            case DeviceConst.CMD_Set_Clock:
                dataListener.dataCallback(ResolveUtil.updateClockSuccessful(value));
                break;
            case DeviceConst.CMD_Get_Clock:
                if (deleteAlarmClock) {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.Delete_AlarmClock));
                } else {
                    dataListener.dataCallback(ResolveUtil.getClockData(value));
                }

                break;
            case DeviceConst.CMD_Set_ActivityAlarm:
                dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.SetSedentaryReminder));
                break;
            case DeviceConst.CMD_Get_ActivityAlarm:
                dataListener.dataCallback(ResolveUtil.getActivityAlarm(value));
                break;

            case DeviceConst.ppi:

                if (GetPPIData) {
                    dataListener.dataCallback(ResolveUtil.getppiData(value));
                } else {
                    dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.DeletePPIData));
                }
                break;
            case DeviceConst.SOS:
                dataListener.dataCallback(ResolveUtil.setMethodSuccessful(BleConst.SOS));
                break;

        }
        //  return map;
    }

    protected static boolean Delete_GetDetailSleepData = false;

    public static byte[] GetDetailSleepDataWithMode(byte mode, String dateOfLastData) {
        Delete_GetDetailSleepData = ((byte) 0x99 == mode);
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_SleepData;
        value[1] = mode;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }


    protected static boolean GetPPIData = false;

    public static byte[] GetPPI(byte mode, String dateOfLastData) {
        GetPPIData = ((byte) 0x99 != mode);
        byte[] value = new byte[16];
        value[0] = DeviceConst.ppi;
        value[1] = mode;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }

    /**
     * 开始实时计步
     *
     * @return
     */
    public static byte[] RealTimeStep(boolean enable, boolean tempEnable) {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Enable_Activity;
        value[1] = (byte) (enable ? 1 : 0);
        value[2] = (byte) (tempEnable ? 1 : 0);
        crcValue(value);
        return value;
    }


    /**
     * 设置个人信息
     *
     * @param
     * @return
     */
    public static byte[] SetPersonalInfo(MyPersonalInfo info) {
        byte[] value = new byte[16];
        int male = info.getSex();
        int age = info.getAge();
        int height = info.getHeight();
        int weight = info.getWeight();
        int stepLength = info.getStepLength();
        value[0] = DeviceConst.CMD_Set_UseInfo;
        value[1] = (byte) male;
        value[2] = (byte) age;
        value[3] = (byte) height;
        value[4] = (byte) weight;
        value[5] = (byte) stepLength;
        crcValue(value);

        return value;
    }


    /**
     * 获取个人信息
     *
     * @return
     */
    public static byte[] GetPersonalInfo() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_GET_USERINFO;
        crcValue(value);
        return value;
    }


    /**
     * 设置设备时间
     *
     * @param
     * @return
     */
    public static byte[] SetDeviceTime(MyDeviceTime time) {
        byte[] value = new byte[16];
        String timeZone = ResolveUtil.getCurrentTimeZone();
        String zone = timeZone.substring(3);
        byte zoneValue = 0;
        if (zone.contains("-")) {
            zone = zone.replace("-", "");
            zoneValue = Byte.valueOf(String.valueOf(zone));
        } else {
            zoneValue = (byte) (Byte.valueOf(zone) + 0x80);
        }
        int year = time.getYear();
        int month = time.getMonth();
        int day = time.getDay();
        int hour = time.getHour();
        int min = time.getMinute();
        int second = time.getSecond();
        value[0] = DeviceConst.CMD_SET_TIME;
        value[1] = ResolveUtil.getTimeValue(year);
        value[2] = ResolveUtil.getTimeValue(month);
        value[3] = ResolveUtil.getTimeValue(day);
        value[4] = ResolveUtil.getTimeValue(hour);
        value[5] = ResolveUtil.getTimeValue(min);
        value[6] = ResolveUtil.getTimeValue(second);
        value[8] = zoneValue;
        crcValue(value);

        return value;
    }


    /**
     * 获取设备时间
     *
     * @return
     */
    public static byte[] GetDeviceTime() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_GET_TIME;
        crcValue(value);
        return value;
    }


    /**
     * 99: 删除步数详细数据 ,
     * 0:读最近的步数详细数据。
     * 1：读指定位置的步数详细数据。
     * 2：继续上次读的位置下一段数据
     *
     * @param
     * @return * dateOfLastData "yyyy-MM-dd HH:mm:ss   or  yyyy.MM.dd HH:mm:ss"
     */
    private static boolean GetDetailActivityDataWithMode = false;

    public static byte[] GetDetailActivityDataWithMode(byte mode, String dateOfLastData) {
        GetDetailActivityDataWithMode = ((byte) 0x99 == mode);
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_DetailData;
        value[1] = (byte) mode;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }

    /**
     * 99: 删除温度数据 ,
     * 0:读最近的温度详细数据。
     * 1：读指定位置的步数详细数据。
     * 2：继续上次读的位置下一段数据
     *
     * @param
     * @return
     */
    protected static boolean GetTemperature_historyDataWithMode;

    public static byte[] GetTemperature_historyData(byte mode, String dateOfLastData) {
        GetTemperature_historyDataWithMode = ((byte) 0x99 == mode);
        byte[] value = new byte[16];
        value[0] = DeviceConst.ReadTempHisrory;
        value[1] = mode;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }

    public static boolean StartDeviceMeasurementWithType = false;

    public static byte[] SetDeviceMeasurementWithType(AutoTestMode dataType, long second, boolean open) {
        StartDeviceMeasurementWithType = open;
        byte[] value = new byte[16];
        value[0] = DeviceConst.MeasurementWithType;
        switch (dataType) {
            case AutoHRV:
                value[1] = (byte) 0x01;
                break;
            case AutoHeartRate:
                value[1] = (byte) 0x02;
                break;
            case AutoSpo2:
                value[1] = (byte) 0x03;
                break;
            case ECG:
                value[1] = (byte) 0x04;
                value[6] = (byte) 0x01;
                break;

        }
        value[2] = open ? (byte) 0x01 : (byte) 0x00;
        value[4] = (byte) ((second) & 0xff);
        value[5] = (byte) ((second >> 8) & 0xff);
        crcValue(value);
        return value;
    }

    static boolean setECGRealtimeDuringHRVEnable = false;

    public static byte[] setECGRealtimeDuringHRVEnabled(boolean open) {
        setECGRealtimeDuringHRVEnable = open;
        byte[] value = new byte[16];
        value[0] = DeviceConst.PPG;
        value[1] = open ? (byte) 0x01 : (byte) 0x00;
        crcValue(value);
        return value;
    }


    public static byte[] SetAutomaticHRMonitoring(MyAutomaticHRMonitoring autoHeart, AutoMode type) {
        byte[] value = new byte[16];
        int time = autoHeart.getTime();
        value[0] = DeviceConst.CMD_Set_Auto;
        value[1] = (byte) autoHeart.getOpen();
        value[2] = ResolveUtil.getTimeValue(autoHeart.getStartHour());
        value[3] = ResolveUtil.getTimeValue(autoHeart.getStartMinute());
        value[4] = ResolveUtil.getTimeValue(autoHeart.getEndHour());
        value[5] = ResolveUtil.getTimeValue(autoHeart.getEndMinute());
        value[6] = (byte) autoHeart.getWeek();
        value[7] = (byte) (time & 0xff);
        value[8] = (byte) ((time >> 8) & 0xff);
        if (null == type) {
            value[9] = (byte) 0x01;
        } else {
            switch (type) {
                case AutoHeartRate:
                    value[9] = (byte) 0x01;
                    break;
                case AutoSpo2:
                    value[9] = (byte) 0x02;
                    break;
                case AutoTemp:
                    value[9] = (byte) 0x03;
                    break;
                case AutoHrv:
                    value[9] = (byte) 0x04;
                    break;
            }
        }
        crcValue(value);
        return value;
    }


    public static byte[] GetAutomatic(AutoMode type) {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Auto;
        if (null == type) {
            value[1] = (byte) 0x01;
        } else {
            switch (type) {
                case AutoHeartRate:
                    value[1] = (byte) 0x01;
                    break;
                case AutoSpo2:
                    value[1] = (byte) 0x02;
                    break;
                case AutoTemp:
                    value[1] = (byte) 0x03;
                    break;
                case AutoHrv:
                    value[1] = (byte) 0x04;
                    break;
            }
        }
        crcValue(value);
        return value;
    }

    /**
     * 设置运动提醒
     *
     * @param activityAlarm
     * @return
     */
    public static byte[] SetSedentaryReminder(MySedentaryReminder activityAlarm) {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Set_ActivityAlarm;
        value[1] = ResolveUtil.getTimeValue(activityAlarm.getStartHour());
        value[2] = ResolveUtil.getTimeValue(activityAlarm.getStartMinute());
        value[3] = ResolveUtil.getTimeValue(activityAlarm.getEndHour());
        value[4] = ResolveUtil.getTimeValue(activityAlarm.getEndMinute());
        value[5] = (byte) activityAlarm.getWeek();
        value[6] = (byte) activityAlarm.getIntervalTime();
        value[7] = (byte) (activityAlarm.getLeastStep() & 0xff);
        value[8] = (byte) (activityAlarm.isEnable() ? 1 : 0);
        crcValue(value);
        return value;
    }


    /**
     * 获取运动提醒
     *
     * @return
     */
    public static byte[] GetSedentaryReminder() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_ActivityAlarm;
        crcValue(value);
        return value;
    }

    /**
     * 获取某天总数据
     * 0
     *
     * @param mode 0:表⽰是从最新的位置开始读取(最多50组数据)  2:表⽰接着读取(当数据总数⼤于50的时候) 0x99:表⽰删除所有运
     * 动数据
     * @return
     */
    protected static boolean GetTotalActivityDataWithMode;

    public static byte[] GetTotalActivityDataWithMode(byte mode, String dateOfLastData) {
        GetTotalActivityDataWithMode = (byte) 0x99 == mode;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_TotalData;
        value[1] = mode;
        insertDateValueNoH(value, dateOfLastData);
        crcValue(value);
        return value;
    }


    /**
     * 获取设备版本号
     *
     * @return
     */
    public static byte[] GetDeviceVersion() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Version;
        crcValue(value);
        return value;
    }


    /**
     * 恢复出厂设置
     *
     * @return
     */
    public static byte[] Reset() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Reset;
        crcValue(value);
        return value;
    }


    /**
     * 获取设备mac地址
     *
     * @return
     */
    public static byte[] GetDeviceMacAddress() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Address;
        crcValue(value);
        return value;
    }
    public static byte[] enterOTA() {
        byte[] value = new byte[16];
        value[0] = 71;
        crcValue(value);
        return value;
    }
    public static byte[] RealTimeTemperature() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.Temperature_3NTC;
        crcValue(value);
        return value;
    }


    /**
     * Is_the_sports_mode_flashing  运动模式是否闪灯
     * Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode 运动模式心率过高是否闪灯
     */
    public static byte[] SetBasic_parameters_of_equipment(boolean Is_the_sports_mode_flashing, boolean Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode) {
        byte[] value = new byte[16];
        value[0] = DeviceConst.SetBasic_parameters_of_equipment;
        value[5] = Is_the_sports_mode_flashing ? (byte) 0x81 : (byte) 0x80;
        value[6] = Is_the_light_flashing_when_the_Heart_Rate_is_too_high_in_sports_mode ? (byte) 0x81 : (byte) 0x80;
        crcValue(value);
        return value;
    }

    public static byte[] GetBasic_parameters_of_equipment() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.GetBasic_parameters_of_equipment;
        crcValue(value);
        return value;
    }


    /**
     * 获取设备电量
     *
     * @return
     */
    public static byte[] GetDeviceBatteryLevel() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_BatteryLevel;
        crcValue(value);
        return value;
    }


    /**
     * 重启设备
     *
     * @return
     */
    public static byte[] MCUReset() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Mcu_Reset;
        crcValue(value);
        return value;
    }


    private static boolean readhrv = false;

    public static byte[] GetHRVDataWithMode(byte mode, String dateOfLastData) {
        readhrv = (byte) 0x99 != mode;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_HrvTestData;
        value[1] = mode;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }

    private static boolean readgetObtainDetailedSleepData = false;

    public static byte[] getObtainDetailedSleepData(byte mode, String dateOfLastData) {
        readgetObtainDetailedSleepData = (byte) 0x99 != mode;
        byte[] value = new byte[16];
        value[0] = DeviceConst.Obtain_detailed_sleep_data;
        value[1] = mode;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }


    protected static boolean GetStaticHRWithMode;

    public static byte[] GetStaticHRWithMode(byte mode, String dateOfLastData) {
        GetStaticHRWithMode = ((byte) 0x99 == mode);
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_OnceHeartData;
        value[1] = mode;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }


    protected static boolean GetDynamicHRWithMode;

    public static byte[] GetDynamicHRWithMode(byte Number, String dateOfLastData) {
        GetDynamicHRWithMode = (byte) 0x99 == Number;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_HeartData;
        value[1] = (byte) Number;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }


    public static byte[] SetDeviceID(String deviceId) {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Set_DeviceID;
        for (int i = 0; i < 6; i++) {
            value[i + 1] = (byte) deviceId.charAt(i);
        }
        crcValue(value);
        return value;
    }


    public static byte[] intTobyte(int num) {
        return new byte[]{(byte) ((num >> 8) & 0xff), (byte) (num & 0xff)};
    }

    public static int byteArrayToInt(byte[] arr) {
        short targets = (short) ((arr[1] & 0xff) | ((arr[0] << 8) & 0xff00));

        return targets;
    }


    public static byte[] getInfoValue(String info, int maxLength) {
        byte[] nameBytes = null;
        try {
            nameBytes = info.getBytes("UTF-8");
            if (nameBytes.length >= maxLength) {//两条命令总共32个字节，内容只占24个字节（32-2*（1cmd+1消息类型+1长度+1校验））
                byte[] real = new byte[maxLength];
                char[] chars = info.toCharArray();
                int length = 0;
                for (int i = 0; i < chars.length; i++) {
                    String s = String.valueOf(chars[i]);
                    byte[] nameB = s.getBytes("UTF-8");
                    ;
                    if (length + nameB.length == maxLength) {
                        System.arraycopy(nameBytes, 0, real, 0, real.length);
                        return real;
                    } else if (length + nameB.length > maxLength) {//大于24会导致有个字节发不到下位机导致乱码
                        System.arraycopy(nameBytes, 0, real, 0, length);
                        return real;
                    }
                    length += nameB.length;
                }
            }
        } catch (UnsupportedEncodingException e) {
            // TODO Auto-generated catch block
            e.printStackTrace();
        }

        return nameBytes;
    }

    public static void crcValue(byte[] value) {
        byte crc = 0;
        for (int i = 0; i < value.length - 1; i++) {
            crc += value[i];
        }
        value[value.length - 1] = (byte) (crc & 0xff);
    }


    public static void insertDateValue(byte[] value, String time) {
        if (!TextUtils.isEmpty(time) && time.length() > 8) {
            String[] timeArray = time.split(" ");
            String INDEX;
            if (time.contains("-")) {
                INDEX = "-";
            } else {
                INDEX = "\\.";
            }
            int year = Integer.parseInt(timeArray[0].split(INDEX)[0]);
            int month = Integer.parseInt(timeArray[0].split(INDEX)[1]);
            int day = Integer.parseInt(timeArray[0].split(INDEX)[2]);
            int hour = Integer.parseInt(timeArray[1].split(":")[0]);
            int min = Integer.parseInt(timeArray[1].split(":")[1]);
            int second = Integer.parseInt(timeArray[1].split(":")[2]);
            value[4] = ResolveUtil.getTimeValue(year);
            value[5] = ResolveUtil.getTimeValue(month);
            value[6] = ResolveUtil.getTimeValue(day);
            value[7] = ResolveUtil.getTimeValue(hour);
            value[8] = ResolveUtil.getTimeValue(min);
            value[9] = ResolveUtil.getTimeValue(second);
        }

    }


    public static void insertDateValueNoH(byte[] value, String time) {
        if (!TextUtils.isEmpty(time) && time.contains("-")) {
            String[] timeArray = time.split(" ");
            String INDEX;
            if (time.contains("-")) {
                INDEX = "-";
            } else {
                INDEX = "\\.";
            }
            int year = Integer.parseInt(timeArray[0].split(INDEX)[0]);
            int month = Integer.parseInt(timeArray[0].split(INDEX)[1]);
            int day = Integer.parseInt(timeArray[0].split(INDEX)[2]);
            value[4] = ResolveUtil.getTimeValue(year);
            value[5] = ResolveUtil.getTimeValue(month);
            value[6] = ResolveUtil.getTimeValue(day);
        }


    }


    /**
     * 转十六进制字符串
     *
     * @param data
     * @return
     */
    public static String byte2Hex(byte[] data) {
        if (data != null && data.length > 0) {
            StringBuilder sb = new StringBuilder(data.length);
            for (byte tmp : data) {
                sb.append(String.format("%02X ", tmp));
            }
            return sb.toString();
        }
        return "no data";
    }


    /**
     * OObtain automated test oximetry data
     * 获得自动测试血氧数据
     */
    protected static boolean Obtain_The_data_of_manual_blood_oxygen_test;

    public static byte[] Oxygen_data(byte Number, String dateOfLastData) {
        Obtain_The_data_of_manual_blood_oxygen_test = ((byte) 0x99 == Number);
        byte[] value = new byte[16];
        value[0] = DeviceConst.Oxygen_data;
        value[1] = (byte) Number;
        insertDateValue(value, dateOfLastData);
        crcValue(value);
        return value;
    }

    public static byte[] EnterActivityMode(int time, int activityMode, int WorkMode) {
        FindActivityMode = false;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Start_EXERCISE;
        value[1] = (byte) WorkMode;
        value[2] = (byte) activityMode;
        value[4] = (byte) time;
        crcValue(value);
        return value;
    }

    private static boolean FindActivityMode = false;

    public static byte[] FindActivityMode() {
        FindActivityMode = true;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Start_EXERCISE;
        value[1] = (byte) 0x05;
        crcValue(value);
        return value;
    }

    /**
     * @param status   级别 level 0,1,2
     * @param time     分钟  minute
     * @param WorkMode START=1;PAUSE=2;CONTUINE=3;FINISH=4;
     * @return
     */
    public static byte[] setExerciseModeByBreath(int status, int time, int WorkMode) {
        FindActivityMode = false;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Start_EXERCISE;
        value[1] = (byte) WorkMode;
        value[2] = (byte) 0x06;
        value[3] = (byte) status;
        value[4] = (byte) time;
        crcValue(value);
        return value;
    }

    public static byte[] sendHeartPackage(float distance, int space, int rssi) {
        byte[] value = new byte[16];
        byte[] distanceValue = getByteArray(distance);
        int min = space / 60;
        int second = space % 60;
        value[0] = DeviceConst.CMD_heart_package;
        System.arraycopy(distanceValue, 0, value, 1, distanceValue.length);
        value[5] = (byte) min;
        value[6] = (byte) second;
        value[7] = (byte) rssi;
        crcValue(value);
        return value;
    }

    /**
     * 设置设备名字
     *
     * @param
     * @return
     */
    public static byte[] SetDeviceName(String strDeviceName) {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Set_Name;
        int length = strDeviceName.length() > 14 ? 14 : strDeviceName.length();
        for (int i = 0; i < length; i++) {
            value[i + 1] = (byte) strDeviceName.charAt(i);
        }
        crcValue(value);
        return value;
    }


    /**
     * 获取设备名字
     *
     * @return
     */
    public static byte[] GetDeviceName() {
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Name;
        crcValue(value);
        return value;
    }


    /**
     * 获取多模式运动数据
     *
     * @param mode 0:表⽰是从最新的位置开始读取(最多50组数据)  2:表⽰接着读取(当数据总数⼤于50的时候) 0x99:表⽰删除所有
     * GPS数据
     * @return
     */
    protected static boolean GetActivityModeDataWithMode;

    public static byte[] GetActivityModeDataWithMode(byte mode) {
        GetActivityModeDataWithMode = ((byte) 0x99 == mode);
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_SPORTData;
        value[1] = mode;
        crcValue(value);
        return value;
    }


    /*!
     *  @method ppgWithMode::
     *  @param ppgMode  1 表示开启ppg测量   2表示给设备发送测量结果  3表示停止ppg测量  4表示给设备发送ppg测量的进度  5表示退出ppg测量
     *  @param ppgStatus 当 ppgMode=2或者 ppgMode=4的时候才有效。当ppgMode=2时，0表示测量失败  1 表示测量结果偏低  2表示测量结果正常 3表示测量结果偏高 。 当ppgMode=4时，ppgStatus表示测量的进度值，范围是0-100
     *  @discussion Turn on ECG measurement 开启ECG测量
     *
     */
    public static boolean startBloodsugar = false;

    public static byte[] ppgWithMode(int ppgMode, int ppgStatus) {
        startBloodsugar = (1 == ppgMode);
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Bloodsugar;
        value[1] = (byte) ppgMode;
        if (1 != ppgMode) {
            value[2] = (byte) ppgStatus;
        }
        crcValue(value);
        return value;
    }

    /**
     * 停止血氧测量
     * Stop blood oxygen measurement
     */
   /* public static byte[] BloodsugarStop() {
        startBloodsugar = false;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Bloodsugar;
        value[1] = (byte) 0x05;
        crcValue(value);
        return value;
    }*/

    /**
     * 血氧测量停止信号采集
     * Blood oxygen measurement stop signal acquisition
     */
  /*  public static byte[] BloodsugarStopSiss() {
        startBloodsugar = false;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Bloodsugar;
        value[1] = (byte) 0x03;
        crcValue(value);
        return value;
    }*/


    /**
     * 血氧测量进度更新
     * Blood oxygen measurement progress update
     */
 /*   public static byte[] BloodsugarProgress(int Progress) {
        startBloodsugar = false;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Bloodsugar;
        value[1] = (byte) 0x04;
        value[2] = (byte) Progress;//0-100
        crcValue(value);
        return value;
    }*/

    /**
     * 血氧测量结果
     * Send blood glucose results to the device
     * status 1低 2中 3高  0测试失败
     * Status 1 low 2 3 high 0 test failed
     */
  /*  public static byte[] SendBloodGlucoseResultsToTheDevice(int status) {
        startBloodsugar = false;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Bloodsugar;
        value[1] = (byte) 0x02;
        value[2] = (byte) status;
        crcValue(value);
        return value;
    }*/


    /**
     * 读取闹钟 99删除闹钟，0读取闹钟
     *
     * @param
     * @return
     */


    public static byte[] setClockData(List<Clock> clockList) {
        int size = clockList.size();
        int length = 39;
        byte[] totalValue = new byte[length * size + 2];
        for (int i = 0; i < clockList.size(); i++) {
            Clock clock = clockList.get(i);
            byte[] value = new byte[length];
            String content = clock.getContent();
            byte[] infoValue = getInfoValue(content, 30);
            value[0] = DeviceConst.CMD_Set_Clock;
            value[1] = (byte) size;
            value[2] = (byte) clock.getNumber();
            value[3] = (byte) (clock.isEnable() ? 1 : 0);
            value[4] = (byte) clock.getType();
            value[5] = ResolveUtil.getTimeValue(clock.getHour());
            value[6] = ResolveUtil.getTimeValue(clock.getMinute());
            value[7] = (byte) clock.getWeek();
            value[8] = (byte) (infoValue.length == 0 ? 1 : infoValue.length);
            System.arraycopy(infoValue, 0, value, 9, infoValue.length);
            System.arraycopy(value, 0, totalValue, i * length, value.length);
        }
        //Log.i(TAG, "setClockData: " + totalValue.length);
        totalValue[totalValue.length - 2] = DeviceConst.CMD_Set_Clock;
        totalValue[totalValue.length - 1] = (byte) 0xff;
        return totalValue;
    }

    public static byte[] deleteAllClock() {
        deleteAlarmClock = true;
        byte[] value = new byte[16];
        value[0] = DeviceConst.deleteAllClock;
        value[1] = (byte) 0x99;
        crcValue(value);
        return value;
    }

    protected static boolean deleteAlarmClock;

    public static byte[] GetAlarmClock() {
        deleteAlarmClock = false;
        byte[] value = new byte[16];
        value[0] = DeviceConst.CMD_Get_Clock;
        crcValue(value);
        return value;
    }


    /**
     * 获取指定格式的日期字符串
     */
    public static synchronized String getFormatTimeString(long time, String formatString) {
        SimpleDateFormat format = new SimpleDateFormat(formatString);
        String data = "";
        try {
            data = format.format(new Date(time));
        } catch (Exception E) {
            E.printStackTrace();
        }
        return data;
    }
}
