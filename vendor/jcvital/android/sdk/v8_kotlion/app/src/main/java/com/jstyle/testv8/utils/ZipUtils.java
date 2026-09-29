package com.jstyle.testv8.utils;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentUris;
import android.content.Context;
import android.content.res.AssetManager;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.provider.MediaStore;
import android.provider.OpenableColumns;
import android.text.TextUtils;
import android.util.Log;
import android.webkit.MimeTypeMap;


import androidx.annotation.RequiresApi;
import androidx.fragment.app.FragmentActivity;

import com.jstyle.testv8.base.Myapp;
import com.jstyle.testv8.rxpermissions.RxPermissions;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileDescriptor;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;
import java.util.zip.ZipInputStream;

import io.reactivex.Observable;
import io.reactivex.ObservableEmitter;
import io.reactivex.ObservableOnSubscribe;
import io.reactivex.Observer;
import io.reactivex.android.schedulers.AndroidSchedulers;
import io.reactivex.disposables.Disposable;
import io.reactivex.schedulers.Schedulers;


/**
 * Created by Administrator on 2018/9/15.
 */

public class ZipUtils {

    private static final String baseDir = Environment.getExternalStorageDirectory().getAbsolutePath() + "/" + "com.jstyle.testv8";
    private static final File CacheDir= Myapp.Companion.getInstance().getExternalCacheDir();
    public final static String UPDATEPATH = (Build.VERSION.SDK_INT >= 30 ? CacheDir : baseDir)  + "/updateinfo/";
    private static final String TAG = "ZipUtils";

    /**
     * 含子目录的文件压缩
     *
     * @throws Exception
     */
    // 第一个参数就是需要解压的文件，第二个就是解压的目录
    public static boolean upZipFile(String zipFile, String folderPath) {
        ZipFile zfile = null;
        try {
            // 转码为GBK格式，支持中文
            zfile = new ZipFile(zipFile);
        } catch (IOException e) {
            Log.i(TAG, "upZipFile1 " + e.toString());
            e.printStackTrace();
            return false;
        }
        Enumeration zList = zfile.entries();
        ZipEntry ze = null;
        byte[] buf = new byte[1024];
        File folderFile = new File(folderPath);
        if (!folderFile.exists()) {
            folderFile.mkdirs();
        }
        while (zList.hasMoreElements()) {
            ze = (ZipEntry) zList.nextElement();
            // 列举的压缩文件里面的各个文件，判断是否为目录
            if (ze.isDirectory()) {
                String dirstr = folderPath + ze.getName();
                Log.i(TAG, "upZipFile " + dirstr);
                dirstr.trim();
                File f = new File(dirstr);
                f.mkdir();
                continue;
            }
            OutputStream os = null;
            FileOutputStream fos = null;
            // ze.getName()会返回 script/start.script这样的，是为了返回实体的File
            File realFile = getRealFileName(folderPath, ze.getName());
            try {
                fos = new FileOutputStream(realFile);
            } catch (FileNotFoundException e) {
                Log.e(TAG,"FileNotFoundException:"+ e.getMessage());
                return false;
            }
            os = new BufferedOutputStream(fos);
            InputStream is = null;
            try {
                is = new BufferedInputStream(zfile.getInputStream(ze));
            } catch (IOException e) {
                Log.e(TAG, e.getMessage());
                return false;
            }
            int readLen = 0;
            // 进行一些内容复制操作
            try {
                while ((readLen = is.read(buf, 0, 1024)) != -1) {
                    os.write(buf, 0, readLen);
                }
            } catch (IOException e) {
                Log.e(TAG, e.getMessage());
                return false;
            }
            try {
                is.close();
                os.close();
            } catch (IOException e) {
                Log.e(TAG, e.getMessage());
                return false;
            }
        }
        try {
            zfile.close();
        } catch (IOException e) {
            Log.e(TAG, e.getMessage());
            return false;
        }
        return true;
    }

    /**
     * 给定根目录，返回一个相对路径所对应的实际文件名.
     *
     * @param baseDir     指定根目录
     * @param absFileName 相对路径名，来自于ZipEntry中的name
     * @return java.io.File 实际的文件
     */
    public static File getRealFileName(String baseDir, String absFileName) {
        Log.i(TAG, "getRealFileName baseDir=" + baseDir + "------absFileName="
                + absFileName);
        absFileName = absFileName.replace("\\", "/");
        Log.i(TAG, "getRealFileName absFileName=" + absFileName);
        String[] dirs = absFileName.split("/");
        Log.i(TAG, "getRealFileName dirs=" + dirs);
        File ret = new File(baseDir);
        String substr = null;
        if (dirs.length > 1) {
            for (int i = 0; i < dirs.length - 1; i++) {
                substr = dirs[i];
                ret = new File(ret, substr);
            }

            if (!ret.exists())
                ret.mkdirs();
            substr = dirs[dirs.length - 1];
            ret = new File(ret, substr);
            return ret;
        } else {
            ret = new File(ret, absFileName);
        }
        return ret;
    }

    public static byte[] readFile(File file) {
        // 需要读取的文件，参数是文件的路径名加文件名
        if (file.isFile()) {
            // 以字节流方法读取文件
            FileInputStream fis = null;
            try {
                fis = new FileInputStream(file);
                // 设置一个，每次 装载信息的容器
                byte[] buffer = new byte[1024];
                ByteArrayOutputStream outputStream = new ByteArrayOutputStream();
                // 开始读取数据
                int len = 0;// 每次读取到的数据的长度
                while ((len = fis.read(buffer)) != -1) {// len值为-1时，表示没有数据了
                    // append方法往sb对象里面添加数据
                    outputStream.write(buffer, 0, len);
                }
                // 输出字符串
                return outputStream.toByteArray();
            } catch (IOException e) {
                e.printStackTrace();
            }
        } else {
            System.out.println("文件不存在！");
        }
        return null;
    }

    public static String loadFromSDFile(String path) {
        String result = null;
        try {
            File f = new File(path);
            if (!f.exists()) return result;
            int length = (int) f.length();
            byte[] buff = new byte[length];
            FileInputStream fin = new FileInputStream(f);
            fin.read(buff);
            fin.close();
            result = new String(buff, "UTF-8");
        } catch (Exception e) {
            e.printStackTrace();
        }
        return result;
    }

    public static byte[] getMd5Byte(String md5String) {
        int length = md5String.length() / 2;
        byte[] value = new byte[length];
        for (int i = 0; i < length; i++) {
            String s = md5String.substring(i * 2, i * 2 + 2);
            value[i] = getByte(s);
        }
        return value;
    }

    private static byte getByte(String trim) {
        if (TextUtils.isEmpty(trim)) return 0;
        return (byte) Integer.parseInt(trim, 16);
    }


    /**
     * 全平台处理方法
     */
    public static String getPath(final Context context, final Uri uri) {
        final boolean isKitKat = Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT;
        // DocumentProvider
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT) {
            if (isKitKat && DocumentsContract.isDocumentUri(context, uri)) {
                // ExternalStorageProvider
                if (isExternalStorageDocument(uri)) {
                    final String docId = DocumentsContract.getDocumentId(uri);
                    final String[] split = docId.split(":");
                    final String type = split[0];

                    if ("primary".equalsIgnoreCase(type)) {
                        return Environment.getExternalStorageDirectory() + "/" + split[1];
                    }

                }
                // DownloadsProvider
                else if (isDownloadsDocument(uri)) {

                    final String id = DocumentsContract.getDocumentId(uri);
                    Log.i(TAG, "getPath: " + id);
                    final Uri contentUri = ContentUris.withAppendedId(
                            Uri.parse("content://downloads/public_downloads"), Long.valueOf(id));

                    return getDataColumn(context, contentUri, null, null);
                }
                // MediaProvider
                else if (isMediaDocument(uri)) {
                    final String docId = DocumentsContract.getDocumentId(uri);
                    final String[] split = docId.split(":");
                    final String type = split[0];

                    Uri contentUri = null;
                    if ("image".equals(type)) {
                        contentUri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                    } else if ("video".equals(type)) {
                        contentUri = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                    } else if ("audio".equals(type)) {
                        contentUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
                    }

                    final String selection = "_id=?";
                    final String[] selectionArgs = new String[]{
                            split[1]
                    };

                    return getDataColumn(context, contentUri, selection, selectionArgs);
                }
            }
            // MediaStore (and general)
            else if ("content".equalsIgnoreCase(uri.getScheme())) {
                return getDataColumn(context, uri, null, null);
            }
            // File
            else if ("file".equalsIgnoreCase(uri.getScheme())) {
                return uri.getPath();
            }
        }

        return null;
    }

    /**
     * 获取此Uri的数据列的值。这对于MediaStore uri和其他基于文件的内容提供程序非常有用。
     */
    public static String getDataColumn(Context context, Uri uri, String selection,
                                       String[] selectionArgs) {

        Cursor cursor = null;
        final String column = "_data";
        final String[] projection = {
                column
        };

        try {
            cursor = context.getContentResolver().query(uri, projection, selection, selectionArgs,
                    null);
            if (cursor != null && cursor.moveToFirst()) {
                final int column_index = cursor.getColumnIndexOrThrow(column);
                return cursor.getString(column_index);
            }
        } catch (IllegalArgumentException e) {
            //do nothing
        } finally {
            if (cursor != null)
                cursor.close();
        }
        return null;
    }

    public static boolean isExternalStorageDocument(Uri uri) {
        return "com.android.externalstorage.documents".equals(uri.getAuthority());
    }

    public static boolean isDownloadsDocument(Uri uri) {
        return "com.android.providers.downloads.documents".equals(uri.getAuthority());
    }

    public static boolean isMediaDocument(Uri uri) {
        return "com.android.providers.media.documents".equals(uri.getAuthority());
    }


    /**
     * 2020.9.23
     * 最老的版本为hex文件;
     * 新版本只有固件不带资源文件的压缩包会带有个.json文件，但是名字不固定（周工的是application.json
     * ,王兵的是固件版本号.json）;
     * 资源文件会有个color565.bin文件
     *
     * @param file
     * @return
     * @throws Exception
     */
    public static FileType needUnZip(String file) throws Exception {
        InputStream in = new BufferedInputStream(new FileInputStream(file));
        ZipInputStream zin = new ZipInputStream(in);
        ZipEntry ze;
        FileType fileType = FileType.none;
        boolean hasFirmware = false;
        boolean hasRes = false;
        while ((ze = zin.getNextEntry()) != null) {
            if (ze.isDirectory()) {
                Log.i(TAG, "needUnZip: " + ze.getName());
                continue;
            } else {
                String name = ze.getName();
                if (name.contains("app_MP_sdk") || name.contains(".zip")) {
                    hasFirmware = true;
                }
                //只有固件包的会带有个.json文件，但是名字不固定
                if (name.endsWith("json")) {
                    fileType = FileType.onlyFirmware;
                    return fileType;
                }
                if (name.contains("color565.bin")) {
                    hasRes = true;
                }

            }
        }
        if (hasFirmware && hasRes) {
            fileType = FileType.resWithFirmware;
        } else if (hasFirmware) {
            fileType = FileType.onlyFirmware;
        } else if (hasRes) {
            fileType = FileType.onlyRes;
        }
        zin.closeEntry();
        return fileType;
    }

    public static FileType needUnZiper(String path) throws Exception {
        File file=new File(path);
        File[] files=file.listFiles();
        if (files == null){Log.e("error","空目录");return null;}
        String s ="";
        FileType fileType = FileType.none;
        boolean hasFirmware = false;
        boolean hasRes = false;
        for(int i =0;i<files.length;i++){
            String name = files[i].getName();
            if (name.contains("app_MP_sdk") || name.contains(".zip")) {
                hasFirmware = true;
            }
            //只有固件包的会带有个.json文件，但是名字不固定
            if (name.endsWith("json")) {
                fileType = FileType.onlyFirmware;
                return fileType;
            }
            if (name.contains("color565.bin")) {
                hasRes = true;
            }
        }

        if (hasFirmware && hasRes) {
            fileType = FileType.resWithFirmware;
        } else if (hasFirmware) {
            fileType = FileType.onlyFirmware;
        } else if (hasRes) {
            fileType = FileType.onlyRes;
        }
        return fileType;
    }


    public static String getFirmwareName(String file) throws Exception {
        InputStream in = new BufferedInputStream(new FileInputStream(file));
        ZipInputStream zin = new ZipInputStream(in);
        ZipEntry ze;
        String path = "";
        while ((ze = zin.getNextEntry()) != null) {
            if (ze.isDirectory()) {
                Log.i(TAG, "needUnZip: " + ze.getName());
                continue;
            } else {
                String name = ze.getName();
                if (name.contains("app_MP_sdk")) {
                    path = name;
                }
            }
        }

        zin.closeEntry();
        return path;
    }

    public enum FileType {
        none,
        onlyRes,//只有资源文件
        onlyFirmware,//只有固件
        resWithFirmware//固件带资源文件一起
    }

    public static String copyFileFromUri(Context context, Uri uri) {
        String path = null;
        String[] fileNames = uri.toString().split(File.separator);
        int length = fileNames.length;
        String fileName = fileNames[length - 1];
        ParcelFileDescriptor parcelFileDescriptor = null;
        try {
            parcelFileDescriptor = context.getContentResolver().openFileDescriptor(uri, "r");
        } catch (FileNotFoundException e) {
            e.printStackTrace();
        }

        FileDescriptor fileDescriptor = parcelFileDescriptor.getFileDescriptor();
        Log.i(TAG, "copyFileFromUri: " + parcelFileDescriptor.getStatSize());
        InputStream fileInputStream = new FileInputStream(fileDescriptor);
        File file = new File(context.getFilesDir().getAbsolutePath());
        try {
            if (!file.exists()) {
                file.mkdirs();
            }
            File fileOTA = new File(file, "ota");
            if (!fileOTA.exists()) {
                fileOTA.mkdir();
            }
            File fileMusic = new File(fileOTA, fileName);
            if (fileMusic.exists()) {
                fileMusic.delete();
            }
            fileMusic.createNewFile();
            OutputStream outputStream = new FileOutputStream(fileMusic);
            byte[] buffer = new byte[1024];
            if (fileName.endsWith("zip")) {
                while (fileInputStream.read(buffer) > 0) {
                    outputStream.write(buffer);
                }
            } else {
                int byteRead;
                while ((byteRead = fileInputStream.read(buffer)) != -1) {
                    outputStream.write(buffer, 0, byteRead);
                }
            }


            outputStream.flush();
            fileInputStream.close();
            outputStream.close();
            path = fileMusic.getAbsolutePath();
            Log.i(TAG, "copyFileFromUri: " + path + " " + fileMusic.length());
        } catch (IOException e) {
            // TODO Auto-generated catch block
            e.printStackTrace();
        }
        return path;
    }

    public static void saveBTLog(Context context, String fileName, String content) {
        String rootPath = context.getExternalFilesDir("").getAbsolutePath();
        if (content == null || fileName == null)
            return;

        // 不存在则创建目录
        File dir = new File(rootPath, "log");
        if (!dir.exists()) {
            dir.mkdirs();
        }

        File file = new File(dir, fileName + ".txt");
        if (!file.exists()) {
            try {
                file.createNewFile();
            } catch (IOException e) {
                e.printStackTrace();
            }
        }
        OutputStreamWriter os = null;
        try {
            os = new OutputStreamWriter(new FileOutputStream(file, true));
            os.write("\r\n" + content);
            os.flush();
            os.close();
        } catch (FileNotFoundException e) {
            e.printStackTrace();
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    public static String uriToPath(final Context context, final Uri uri) {
        int sdkInt = Build.VERSION.SDK_INT;
        // DocumentProvider
        if (sdkInt >= Build.VERSION_CODES.KITKAT && sdkInt < 30 && DocumentsContract.isDocumentUri(context, uri)) {

            // ExternalStorageProvider
            if (isExternalStorageDocument(uri)) {
                final String docId = DocumentsContract.getDocumentId(uri);
                final String[] split = docId.split(":");
                final String type = split[0];

                if ("primary".equalsIgnoreCase(type)) {
                    return Environment.getExternalStorageDirectory() + "/" + split[1];
                }
            } else if (isDownloadsDocument(uri)) {// DownloadsProvider
                final String id = DocumentsContract.getDocumentId(uri);
                final Uri contentUri = ContentUris.withAppendedId(
                        Uri.parse("content://downloads/public_downloads"), Long.valueOf(id));

                return getDataColumn(context, contentUri, null, null);
            } else if (isMediaDocument(uri)) {// MediaProvider
                final String docId = DocumentsContract.getDocumentId(uri);
                final String[] split = docId.split(":");
                final String type = split[0];

                Uri contentUri = null;
                if ("image".equals(type)) {
                    contentUri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI;
                } else if ("video".equals(type)) {
                    contentUri = MediaStore.Video.Media.EXTERNAL_CONTENT_URI;
                } else if ("audio".equals(type)) {
                    contentUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI;
                }

                final String selection = "_id=?";
                final String[] selectionArgs = new String[]{
                        split[1]
                };
                return getDataColumn(context, contentUri, selection, selectionArgs);
            }
        }
        if (sdkInt >= 30) {
            return uriToPathApiQ(context, uri);
        } else if ("content".equalsIgnoreCase(uri.getScheme())) {// MediaStore (and general)
            return getDataColumn(context, uri, null, null);
        }
        // File
        else if ("file".equalsIgnoreCase(uri.getScheme())) {
            return uri.getPath();
        }

        return null;
    }

    private static String uriToPathApiQ(Context context, Uri uri) {
        String path = null;
        String scheme = uri.getScheme();
        if (scheme.equals(ContentResolver.SCHEME_FILE)) {
            path = uri.getPath();
        } else if (scheme.equals(ContentResolver.SCHEME_CONTENT)) {
            ContentResolver contentResolver = context.getContentResolver();
            Cursor
                    cursor = contentResolver.query(uri, null, null, null, null);
            String fileName="";
            if (cursor.moveToFirst()) {
                fileName = cursor.getString(cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME));
                Log.i(TAG, "getFileUri: " + fileName);
            }
            if(TextUtils.isEmpty(fileName)){
                String type= MimeTypeMap.getSingleton().getExtensionFromMimeType(contentResolver.getType(uri));
                fileName=System.currentTimeMillis()+"."+type;
            }
            try {
                path=copyFile(context,contentResolver.openInputStream(uri),fileName);
            } catch (FileNotFoundException e) {
                e.printStackTrace();
            }
        }
        return path;
    }

    public static String copyFile(Context context, InputStream fileInputStream,String fileName) {
        String path=null;
        File file = new File(context.getFilesDir().getAbsolutePath());
        try {
            if (!file.exists()) {
                file.mkdirs();
            }
            File fileOTA = new File(file, "ota");
            if (!fileOTA.exists()) {
                fileOTA.mkdir();
            }
            File fileMusic = new File(fileOTA, fileName);
            if (fileMusic.exists()) {
                fileMusic.delete();
            }
            fileMusic.createNewFile();
            OutputStream outputStream = new FileOutputStream(fileMusic);
            byte[] buffer = new byte[1024];
            if (fileName.endsWith("zip")) {
                while (fileInputStream.read(buffer) > 0) {
                    outputStream.write(buffer);
                }
            } else {
                int byteRead;
                while ((byteRead = fileInputStream.read(buffer)) != -1) {
                    outputStream.write(buffer, 0, byteRead);
                }
            }


            outputStream.flush();
            fileInputStream.close();
            outputStream.close();
            path = fileMusic.getAbsolutePath();
            Log.i(TAG, "copyFileFromUri: " + path + " " + fileMusic.length());
        } catch (IOException e) {
            // TODO Auto-generated catch block
            e.printStackTrace();
        }
        return path;
    }


    public static void createFile( String path) {
        File ecgFile = new File(path);
        if (!ecgFile.exists()) {
            ecgFile.mkdirs();
        } else {
            deleteDirectory(ecgFile);
            ecgFile.mkdirs();
        }
    }

    // 删除文件夹
    private static void deleteDirectory(File file) {
        if (file.isFile()) {// 表示该文件不是文件夹
            file.delete();
        } else {
            // 首先得到当前的路径
            String[] childFilePaths = file.list();
            for (String childFilePath : childFilePaths) {
                File childFile = new File(file.getAbsolutePath() + "/" + childFilePath);
                deleteDirectory(childFile);
            }
            file.delete();
        }
    }


    public static String getPath(Context context, Uri srcUri,String path) {
        File file=new File(path);
        try {
            InputStream inputStream = context.getContentResolver().openInputStream(srcUri);//context的方法获取URI文件输入流
            if (inputStream == null) {
                Log.e("msmsmsm","null");
                return "null";
            }
            OutputStream outputStream = new FileOutputStream(file);
            copyStream(inputStream, outputStream);//调用下面的方法存储
            inputStream.close();
            outputStream.close();
            return path;//成功返回路径
        } catch (Exception e) {
            Log.e("msmsmsm",e.toString());
            e.printStackTrace();
            return "null";//失败返回路径null
        }
    }

    private static void copyStream(InputStream input, OutputStream output){//文件存储
        final int BUFFER_SIZE = 1024 * 2;
        byte[] buffer = new byte[BUFFER_SIZE];
        BufferedInputStream in = new BufferedInputStream(input, BUFFER_SIZE);
        BufferedOutputStream out = new BufferedOutputStream(output, BUFFER_SIZE);
        int count = 0, n = 0;
        try {
            while ((n = in.read(buffer, 0, BUFFER_SIZE)) != -1) {
                out.write(buffer, 0, n);
                count += n;
            }
            out.flush();
            out.close();
            in.close();
        } catch (IOException e) {
            e.printStackTrace();
        }
    }

    /**
     * 用文件名后缀，读取文件详细名字
     * @param
     * @param likefilename
     * @return
     */
    public static String getFilesAllName(String likefilename) {
        File file=new File(UPDATEPATH );
        File[] files=file.listFiles();
        if (files == null){Log.e("error","空目录");return null;}
        String s ="";
        for(int i =0;i<files.length;i++){
            Log.e("mssmsms",files[i].getName().toLowerCase()+"**"+likefilename);
            if(files[i].getName().toLowerCase().contains(likefilename.toLowerCase())){
                s = files[i].getName();
                break;
            }
        }
        return s;
    }


    public static List<String> ReadAssets(Activity activity, String name){
        List<String> fileNamesB=new ArrayList<>();
        try {
            String[] fileNames = activity.getAssets().list("");
            for (String f:fileNames){
                if(f.contains(name)){
                    fileNamesB.add(f);
                }
            }
        } catch (IOException e) {
            e.printStackTrace();
        }
        return  fileNamesB;
    }

    public interface copyFileListener {
        void onSuccess();
        void onfail();
    }
    public static void copyFileToDisk(final Context context,String assetsPath,boolean needzipFile,copyFileListener c) {
        Observable.create(new ObservableOnSubscribe<Object>() {
                              @Override
                              public void subscribe(ObservableEmitter<Object> e) throws Exception {
                                  copyFileFromAssets(context,assetsPath);
                                  e.onComplete();
                              }
                          }
        ).subscribeOn(Schedulers.io()).observeOn(AndroidSchedulers.mainThread()).subscribe(new Observer<Object>() {
            @Override
            public void onSubscribe(Disposable d) {

            }

            @Override
            public void onNext(Object value) {
                Log.i(TAG, "onNext: ");
            }

            @Override
            public void onError(Throwable e) {
                if(null!=c){c.onfail();}
            }

            @Override
            public void onComplete() {
                //需要解压zip文件的话
                if(needzipFile){
                    upZipFile(UPDATEPATH+assetsPath,UPDATEPATH) ;
                }
                if(null!=c){c.onSuccess();}
                Log.i(TAG, "onComplete: ");
            }
        });
    }
    private static void copyFileFromAssets(Context context,String assetsPath) {
        File file = new File(UPDATEPATH);
        try {
            if(file.exists()){
                deleteDirectory(file) ;
            }
            file.mkdirs();
            File fileMusic = new File(file ,assetsPath);
            fileMusic.createNewFile();
            AssetManager assetManager = context.getAssets();
            InputStream inputStream = assetManager.open(assetsPath);
            OutputStream outputStream = new FileOutputStream(fileMusic);
            byte[] buffer = new byte[1024];
            while (inputStream.read(buffer) > 0) {
                outputStream.write(buffer);
            }
            outputStream.flush();
            inputStream.close();
            outputStream.close();


        } catch (IOException e) {
         Log.e("smmsmsms",e.toString());
            e.printStackTrace();
        }
    }


    /**
     * 用文件名后缀，读取文件详细名字
     * @param path
     * @param likefilename
     * @return
     */
    public static String getFilesAllName(String path,String likefilename) {
        File file=new File(path);
        File[] files=file.listFiles();
        if (files == null){Log.e("error","空目录");return null;}
        String s ="";
        for(int i =0;i<files.length;i++){
            if(files[i].getName().toLowerCase().endsWith(likefilename)){
                s = files[i].getName();
                break;
            }
        }
        return s;
    }



    //私有属性
    public interface PermissionsUtilsListener {
        void onSuccess();
        void onfail();
    }
    /**
     * 蓝牙扫描权限等
     */
    @SuppressLint("CheckResult")
    public static void Permission_Scan(FragmentActivity activity, PermissionsUtilsListener permissionsUtilsListener) {
        if(!activity.isDestroyed()){
            RxPermissions rxPermissions=new RxPermissions(activity);
            rxPermissions.request(
                    Manifest.permission.BLUETOOTH,
                    Manifest.permission.BLUETOOTH_ADMIN).subscribe(aBoolean -> {
                if (aBoolean){
                    permissionsUtilsListener.onSuccess();
                }else{
                    //只要有一个权限被拒绝，就会执行
                    permissionsUtilsListener.onfail();
                }
            });}
    }
    /**
     * 蓝牙扫描权限等
     */
    @RequiresApi(api = 31)
    @SuppressLint("CheckResult")
    public static void Permission_ScanNew(FragmentActivity activity, PermissionsUtilsListener permissionsUtilsListener) {
        if(!activity.isDestroyed()){
           RxPermissions rxPermissions=new RxPermissions(activity);
            rxPermissions.request(
                    Manifest.permission.BLUETOOTH_CONNECT,
                    Manifest.permission.BLUETOOTH_SCAN).subscribe(aBoolean -> {
                if (aBoolean){
                    permissionsUtilsListener.onSuccess();
                }else{
                    //只要有一个权限被拒绝，就会执行
                    permissionsUtilsListener.onfail();
                }
            });
        }
    }

    @SuppressLint("CheckResult")
    public static void WRITE_READ(FragmentActivity activity, PermissionsUtilsListener permissionsUtilsListener) {
        if(!activity.isDestroyed()){
            //如果是6.0以下的系统，或者是android Q到之后的系统版本不需要申请读写权限
            if(Build.VERSION.SDK_INT <23||Build.VERSION.SDK_INT >= 29){
                permissionsUtilsListener.onSuccess();
            }else{
                RxPermissions rxPermissions=new RxPermissions(activity);
                rxPermissions.request(
                        Manifest.permission.WRITE_EXTERNAL_STORAGE,
                        Manifest.permission.READ_EXTERNAL_STORAGE).subscribe(aBoolean -> {
                    if (aBoolean){
                        permissionsUtilsListener.onSuccess();
                    }else{
                        //只要有一个权限被拒绝，就会执行
                        permissionsUtilsListener.onfail();
                    }
                });
            }
           }
    }


}
