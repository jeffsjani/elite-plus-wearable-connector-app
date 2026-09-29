package com.jstyle.test2025.Util;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.Context;
import android.content.DialogInterface;
import android.content.Intent;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.support.annotation.RequiresApi;
import android.support.v4.app.FragmentActivity;
import android.support.v7.app.AlertDialog;
import android.support.v7.app.AppCompatActivity;
import android.util.Log;

import com.jstyle.test2025.R;
import com.tbruyelle.rxpermissions2.Permission;
import com.tbruyelle.rxpermissions2.RxPermissions;

import io.reactivex.functions.Consumer;

/**
 * Created by Administrator on 2018/9/5.
 */

public class PermissionsUtil {
    private static final String TAG = "PermissionsUtil";

    public static void requestPermissions(final AppCompatActivity activity, final PermissionListener  permissionListener, final String... permissions) {
        if(activity.isFinishing())return;
        RxPermissions rxPermission = new RxPermissions(activity);
        rxPermission.requestEach(permissions)
                .subscribe(new Consumer<Permission>() {
                    @Override
                    public void accept(Permission permission) throws Exception {
                        if (permission.granted) {
                            // 用户已经同意该权限
                            if(permissionListener!=null)
                            permissionListener.granted(permission.name);
                            Log.d(TAG, permission.name + " is granted.");
                        } else if (permission.shouldShowRequestPermissionRationale) {
                            // 用户拒绝了该权限，没有选中『不再询问』（Never ask again）,那么下次再次启动时，还会提示请求权限的对话框
                            showNeedPermission(activity,permissionListener,permission.name);
                            Log.d(TAG, permission.name + " is denied. More info should be provided.");
                        } else {
                            // 用户拒绝了该权限，并且选中『不再询问』
                            showToEnable(activity);
                        }
                    }
                });

    }

    public static void showNeedPermission(final AppCompatActivity activity, final PermissionListener  permissionListener, final String permissionName) {
        if(activity.isFinishing())return;
        AlertDialog alertDialog = new AlertDialog.Builder(activity)
                .setCancelable(false)
                .setTitle(R.string.permission_requierd)
                .setMessage(String.format(activity.getString(R.string.permisson_neverask),permissionName))
                .setPositiveButton(activity.getString(R.string.require_now), new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        requestPermissions(activity,permissionListener,permissionName);
                    }
                }).setNegativeButton(activity.getString(R.string.require_cancel), new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        if(permissionListener!=null) permissionListener.disallow(permissionName);
                    }
                }).create();
        alertDialog.show();
    }

    public static void showToEnable(final AppCompatActivity context) {
        if(context.isFinishing())return;
        AlertDialog alertDialog = new AlertDialog.Builder(context)
                .setCancelable(false)
                .setTitle(context.getString(R.string.Enable_Access_title))
                .setMessage(context.getString(R.string.access_content))
                .setPositiveButton(context.getString(R.string.access_now), new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {
                        Intent intent = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                        Uri uri = Uri.fromParts("package", context.getApplicationContext().getPackageName(), null);
                        intent.setData(uri);
                        context.startActivity(intent);
                    }
                }).setNegativeButton(context.getString(R.string.cancel), new DialogInterface.OnClickListener() {
                    @Override
                    public void onClick(DialogInterface dialog, int which) {

                    }
                }).create();
        alertDialog.show();
    }
    public interface PermissionListener{
        public void granted(String name);
        public void NeverAskAgain();
        public void disallow(String name);
    }

    public static boolean isLocServiceEnable(Context context) {
        LocationManager locationManager = (LocationManager) context.getSystemService(Context.LOCATION_SERVICE);
        boolean gps = locationManager.isProviderEnabled(LocationManager.GPS_PROVIDER);
        boolean network = locationManager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        if (gps || network) {
            return true;
        }
        return false;
    }


    //私有属性
    public interface PermissionsUtilsListener {
        void onSuccess();
        void onFail();
    }

    /**
     * 蓝牙扫描权限等
     */
    @SuppressLint("CheckResult")
    public static void Permission_Scan(FragmentActivity activity, final PermissionsUtilsListener permissionsUtilsListener) {
        if(!activity.isDestroyed()){
            RxPermissions rxPermissions=new RxPermissions(activity);
            rxPermissions.request(
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.BLUETOOTH,
                    Manifest.permission.BLUETOOTH_ADMIN).subscribe(new Consumer<Boolean>() {
                @Override
                public void accept(Boolean aBoolean) throws Exception {
                    if (aBoolean){
                        permissionsUtilsListener.onSuccess();
                    }else{
                        //只要有一个权限被拒绝，就会执行
                        permissionsUtilsListener.onFail();
                    }
                }
            });}
    }
    /**
     * 蓝牙扫描权限等
     */
    @RequiresApi(api = 31)
    @SuppressLint("CheckResult")
    public static void Permission_ScanNew(FragmentActivity activity, final PermissionsUtilsListener permissionsUtilsListener) {
        if(!activity.isDestroyed()){
            RxPermissions rxPermissions=new RxPermissions(activity);
            rxPermissions.request(
                    Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN).subscribe(new Consumer<Boolean>() {
                @Override
                public void accept(Boolean aBoolean) throws Exception {
                    if (aBoolean){
                        permissionsUtilsListener.onSuccess();
                    }else{
                        //只要有一个权限被拒绝，就会执行
                        permissionsUtilsListener.onFail();
                    }
                }
            });}
    }


    /**
     * 读写
     *
     */
    @SuppressLint("CheckResult")
    public static void Reading_and_writing(FragmentActivity activity, final PermissionsUtilsListener permissionsUtilsListener) {
        if (!activity.isDestroyed()) {
            if (Build.VERSION.SDK_INT < 23 || Build.VERSION.SDK_INT >= 29) {
                permissionsUtilsListener.onSuccess();
            } else {
                RxPermissions rxPermissions = new RxPermissions(activity);
                rxPermissions.request(
                        Manifest.permission.READ_EXTERNAL_STORAGE,
                        Manifest.permission.WRITE_EXTERNAL_STORAGE
                ).subscribe(new Consumer<Boolean>() {
                    @Override
                    public void accept(Boolean aBoolean) throws Exception {
                        if (aBoolean) {
                            permissionsUtilsListener.onSuccess();
                        } else {
                            //只要有一个权限被拒绝，就会执行
                            permissionsUtilsListener.onFail();
                        }
                    }
                });
            }
        }


    }


    /**
     * 定位蓝牙权限等
     */
    @SuppressLint("CheckResult")
    public static void getPermission_Location(FragmentActivity activity, final PermissionsUtilsListener permissionsUtilsListener) {
        if(!activity.isDestroyed()){
            RxPermissions rxPermissions=new RxPermissions(activity);
            rxPermissions.request(Manifest.permission.ACCESS_COARSE_LOCATION,
                    Manifest.permission.ACCESS_FINE_LOCATION
            ).subscribe(new Consumer<Boolean>() {
                @Override
                public void accept(Boolean aBoolean) throws Exception {
                    if (aBoolean) {
                        permissionsUtilsListener.onSuccess();
                    } else {
                        //只要有一个权限被拒绝，就会执行
                        permissionsUtilsListener.onFail();
                    }
                }
            });
        }

    }

}
