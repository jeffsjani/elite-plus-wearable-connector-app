package com.jstyle.test2025.ble;

import android.annotation.SuppressLint;
import android.bluetooth.BluetoothDevice;
import android.bluetooth.le.BluetoothLeScanner;
import android.bluetooth.le.ScanCallback;
import android.bluetooth.le.ScanFilter;
import android.bluetooth.le.ScanResult;
import android.bluetooth.le.ScanSettings;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.os.Build;
import android.text.TextUtils;
import android.util.Log;


import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.TimeUnit;

import io.reactivex.Observable;
import io.reactivex.Observer;
import io.reactivex.disposables.Disposable;

@SuppressLint("MissingPermission")
public class BleConnectAndroid15 {
    private Context mycontext;
    private BluetoothDevice mac = null;
    private BluetoothDevice macdat = null;
    OnScanResults rr = null;
    public static Disposable reConnect_dis = null;
    private boolean isScanning = false;
    private BluetoothLeScanner bluetoothLeScanner;
    List<ScanFilter> filters = new ArrayList<>();
    ScanSettings settingsback,settings;

    public interface OnScanResults {
        void Success(BluetoothDevice date);

        void Fail();//只代表超时
    }

    boolean registerReceiver = false;

    public BleConnectAndroid15(Context context) {
        super();
        this.mycontext = context;

        // 注册广播接收器
        if (registerReceiver) {
            return;
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            this.bluetoothLeScanner = BleManager.getInstance().bluetoothAdapter.getBluetoothLeScanner();
            settingsback = new ScanSettings.Builder()
                    .setScanMode(ScanSettings.SCAN_MODE_LOW_POWER) //改为低功耗
                    .setReportDelay(0) // 可以设置报告延迟，单位为毫秒
                    .build();
        } else {
            // 注册广播接收器
            IntentFilter filter = new IntentFilter(BluetoothDevice.ACTION_FOUND);
            mycontext.registerReceiver(bluetoothReceiver, filter);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                mycontext.registerReceiver(bluetoothReceiver, filter, Context.RECEIVER_EXPORTED);
            } else {
                mycontext.registerReceiver(bluetoothReceiver, filter);
            }
        }


        registerReceiver = true;
    }

    public void SetResultsClear() {
        stopScan();
        this.rr = null;
        this.macdat = null;
    }

    public void SetBluetoothDevice(BluetoothDevice MAC, OnScanResults onScanResults) {
        this.mac = MAC;
        this.rr = onScanResults;
        this.macdat = null;
        Log.e("BleService", "SetBluetoothDevice");
        if (reConnect_dis != null && !reConnect_dis.isDisposed()) {
            reConnect_dis.dispose();
            reConnect_dis = null;
        }
            Observable.timer(20000, TimeUnit.MILLISECONDS)
                    .subscribe(new Observer<Long>() {
                        @Override
                        public void onSubscribe(Disposable d) {
                            reConnect_dis = d;
                        }

                        @Override
                        public void onNext(Long aLong) {
                        }

                        @Override
                        public void onError(Throwable e) {
                        }

                        @Override
                        public void onComplete() {
                            Log.e("BleService", "10 Time out");
                            if (reConnect_dis != null && !reConnect_dis.isDisposed()) {
                                reConnect_dis.dispose();
                                reConnect_dis = null;
                            }
                            if (null == macdat) {
                                if (null != rr && BleManager.getInstance().isBleEnable()) {
                                    rr.Fail();
                                    /* stopScan();*/
                                }
                            }
                        }
                    });

        startScan();

    }

    public void unregisterReceiver() {
        if (registerReceiver) {
            stopScan();
            registerReceiver = false;
        }

    }

    public void startScan() {
        if (isScanning) return;

        isScanning = true;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            // 开始扫描
            if (null != bluetoothLeScanner) {

                if (null != mac) {
                    filters.clear();
                    ScanFilter filter = new ScanFilter.Builder().setDeviceAddress(mac.getAddress())
                            .build();
                    filters.add(filter);
                }
                bluetoothLeScanner.startScan(null != mac ? filters : null, settingsback, scanCallback);
            }
        } else {
            if(!BleManager.getInstance().bluetoothAdapter.isDiscovering()){
                BleManager.getInstance().bluetoothAdapter.startDiscovery();
            }

        }

    }

    public void stopScan() {
        if (!isScanning) return;

        isScanning = false;
        // 停止扫描
      try {
          if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
              if (null != bluetoothLeScanner) {
                  bluetoothLeScanner.stopScan(scanCallback);
              }
          } else {
              if(BleManager.getInstance().bluetoothAdapter.isDiscovering()){
                  BleManager.getInstance().bluetoothAdapter.cancelDiscovery();
              }
          }
      }catch (Exception E){}


    }

    private ScanCallback scanCallback = new ScanCallback() {
        @Override
        public void onScanResult(int callbackType, ScanResult result) {
            super.onScanResult(callbackType, result);
            //Log.i(TAG, "onScanResult: " + callbackType + " ScanResult:" + result);
            if (result.getScanRecord() != null && null != result.getDevice()) {
                if (null != result.getDevice() && null != mac && mac.getAddress().equals(result.getDevice().getAddress()) && null == macdat) {
                    synchronized (this) {
                        macdat = result.getDevice();
                        if (null != rr) {
                            rr.Success(result.getDevice());
                        }
                        SetResultsClear();
                    }

                    // Log.d("BleService", "发现设备: " + deviceName + " 地址: " + deviceAddress);
                } else {
                    if (null != result.getDevice() && !TextUtils.isEmpty(result.getDevice().getName())) {
                        Log.d("BleService", "发现设备2: " + result.getDevice().getName() + "**" + result.getDevice().getAddress());
                    }

                }
            }

        }

    };


    private BroadcastReceiver bluetoothReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (BluetoothDevice.ACTION_FOUND.equals(action)) {
                BluetoothDevice device = intent.getParcelableExtra(BluetoothDevice.EXTRA_DEVICE);
                /*String deviceName = device.getName();
                String deviceAddress = device.getAddress();*/
                if (null != mac && mac.getAddress().equals(device.getAddress()) && null == macdat) {
                    synchronized (this) {
                        macdat = device;
                        if (null != rr) {
                            rr.Success(device);
                        }
                        SetResultsClear();
                    }

                    // Log.d("BleService", "发现设备: " + deviceName + " 地址: " + deviceAddress);
                } else {
                    Log.d("BleService", "发现设备2: ");
                }

            }
        }
    };
}



