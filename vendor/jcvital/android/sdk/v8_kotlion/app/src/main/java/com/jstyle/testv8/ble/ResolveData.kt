package com.jstyle.testv8.ble

import android.Manifest
import android.bluetooth.BluetoothDevice
import android.content.ContentResolver
import android.content.ContentUris
import android.content.Context
import android.database.Cursor
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.DocumentsContract
import android.provider.MediaStore
import android.text.TextUtils
import android.util.Log
import androidx.annotation.RequiresPermission
import java.io.UnsupportedEncodingException

/**
 * Created by Administrator on 2017/4/6.
 */
object ResolveData {
    private const val TAG = "ResolveData"
    private const val SHORTENED_LOCAL_NAME = 0x08
    private const val COMPLETE_LOCAL_NAME = 0x09
    private val oneMinMillis = 60 * 1000L

    var startString: String = " 12:00:00"
    fun getBcd(value: String): Int {
        val m = value.toInt(16)
        return m
    }

    fun decodeDeviceName(data: ByteArray): String? {
        var name: String? = null
        var fieldLength: Int
        var fieldName: Int
        val packetLength = data.size
        var index = 0
        while (index < packetLength) {
            fieldLength = data[index].toInt()
            if (fieldLength <= 0) break
            fieldName = data[++index].toInt()

            if (fieldName == COMPLETE_LOCAL_NAME
                || fieldName == SHORTENED_LOCAL_NAME
            ) {
                name = decodeLocalName(data, index + 1, fieldLength - 1)
                break
            }
            index += fieldLength - 1
            index++
        }
        return name
    }

    @RequiresPermission(Manifest.permission.BLUETOOTH_CONNECT)
    fun decodeDeviceName(bluetoothDevice: BluetoothDevice, data: ByteArray): String? {
        var name = bluetoothDevice.getName()
        if (!TextUtils.isEmpty(name)) return name
        var fieldLength: Int
        var fieldName: Int
        val packetLength = data.size
        var index = 0
        while (index < packetLength) {
            fieldLength = data[index].toInt()
            if (fieldLength <= 0) break
            fieldName = data[++index].toInt()
            if (fieldName == COMPLETE_LOCAL_NAME
                || fieldName == SHORTENED_LOCAL_NAME
            ) {
                name = decodeLocalName(data, index + 1, fieldLength - 1)
                break
            }
            index += fieldLength - 1
            index++
        }
        return name
    }


    /**
     * Decodes the local name
     */
    fun decodeLocalName(
        data: ByteArray?, start: Int,
        length: Int
    ): String? {
        try {
            return kotlin.text.String(data!!, start, length, charset("UTF-8"))
        } catch (e: UnsupportedEncodingException) {
            Log.e(
                "scan", "Unable to convert the complete local name to UTF-8",
                e
            )
            return null
        } catch (e: IndexOutOfBoundsException) {
            Log.e("scan", "Error when reading complete local name", e)
            return null
        }
    }

    /**
     * 转十六进制字符串
     *
     * @param data
     * @return
     */
    fun byte2Hex(data: ByteArray?): String {
        if (data != null && data.size > 0) {
            val sb = StringBuilder(data.size)
            for (tmp in data) {
                sb.append(String.format("%02X ", tmp))
            }
            return sb.toString()
        }
        return "no data"
    }

    fun getRealFilePath(context: Context, uri: Uri?): String? {
        if (null == uri) return null
        val scheme = uri.getScheme()
        var data: String? = null
        if (scheme == null) data = uri.getPath()
        else if (ContentResolver.SCHEME_FILE == scheme) {
            data = uri.getPath()
        } else if (ContentResolver.SCHEME_CONTENT == scheme) {
            val cursor = context.getContentResolver()
                .query(uri, arrayOf<String>(MediaStore.Images.ImageColumns.DATA), null, null, null)
            if (null != cursor) {
                if (cursor.moveToFirst()) {
                    val index = cursor.getColumnIndex(MediaStore.Images.ImageColumns.DATA)
                    if (index > -1) {
                        data = cursor.getString(index)
                    }
                }
                cursor.close()
            }
        }
        return data
    }

    /**
     * 专为Android4.4设计的从Uri获取文件绝对路径
     */
    fun getPath(context: Context, uri: Uri): String? {
        // DocumentProvider


        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.KITKAT && DocumentsContract.isDocumentUri(
                context,
                uri
            )
        ) {
            // ExternalStorageProvider
            if (isExternalStorageDocument(uri)) {
                val docId = DocumentsContract.getDocumentId(uri)
                val split: Array<String?> =
                    docId.split(":".toRegex()).dropLastWhile { it.isEmpty() }.toTypedArray()
                val type = split[0]

                if ("primary".equals(type, ignoreCase = true)) {
                    return Environment.getExternalStorageDirectory().toString() + "/" + split[1]
                }

                // TODO handle non-primary volumes
            } else if (isDownloadsDocument(uri)) {
                val id = DocumentsContract.getDocumentId(uri)
                val contentUri = ContentUris.withAppendedId(
                    Uri.parse("content://downloads/public_downloads"), id.toLong()
                )

                return getDataColumn(context, contentUri, null, null)
            } else if (isMediaDocument(uri)) {
                val docId = DocumentsContract.getDocumentId(uri)
                val split: Array<String?> =
                    docId.split(":".toRegex()).dropLastWhile { it.isEmpty() }.toTypedArray()
                val type = split[0]

                var contentUri: Uri? = null
                if ("image" == type) {
                    contentUri = MediaStore.Images.Media.EXTERNAL_CONTENT_URI
                } else if ("video" == type) {
                    contentUri = MediaStore.Video.Media.EXTERNAL_CONTENT_URI
                } else if ("audio" == type) {
                    contentUri = MediaStore.Audio.Media.EXTERNAL_CONTENT_URI
                }

                val selection = "_id=?"
                val selectionArgs = arrayOf<String?>(split[1])

                return ResolveData.getDataColumn(context, contentUri!!, selection, selectionArgs)
            }
        } else if ("content".equals(uri.getScheme(), ignoreCase = true)) {
            return getDataColumn(context, uri, null, null)
        } else if ("file".equals(uri.getScheme(), ignoreCase = true)) {
            return uri.getPath()
        }

        return null
    }

    /**
     * Get the value of the data column for this Uri. This is useful for
     * MediaStore Uris, and other file-based ContentProviders.
     *
     * @param context
     * The context.
     * @param uri
     * The Uri to query.
     * @param selection
     * (Optional) Filter used in the query.
     * @param selectionArgs
     * (Optional) Selection arguments used in the query.
     * @return The value of the _data column, which is typically a file path.
     */
    fun getDataColumn(
        context: Context, uri: Uri, selection: String?,
        selectionArgs: Array<String?>?
    ): String? {
        var cursor: Cursor? = null
        val column = "_data"
        val projection = arrayOf<String?>(column)

        try {
            cursor = context.getContentResolver().query(
                uri, projection, selection, selectionArgs,
                null
            )
            if (cursor != null && cursor.moveToFirst()) {
                val column_index = cursor.getColumnIndexOrThrow(column)
                return cursor.getString(column_index)
            }
        } finally {
            if (cursor != null) cursor.close()
        }
        return null
    }

    /**
     * @param uri
     * The Uri to check.
     * @return Whether the Uri authority is ExternalStorageProvider.
     */
    fun isExternalStorageDocument(uri: Uri): Boolean {
        return "com.android.externalstorage.documents" == uri.getAuthority()
    }

    /**
     * @param uri
     * The Uri to check.
     * @return Whether the Uri authority is DownloadsProvider.
     */
    fun isDownloadsDocument(uri: Uri): Boolean {
        return "com.android.providers.downloads.documents" == uri.getAuthority()
    }

    /**
     * @param uri
     * The Uri to check.
     * @return Whether the Uri authority is MediaProvider.
     */
    fun isMediaDocument(uri: Uri): Boolean {
        return "com.android.providers.media.documents" == uri.getAuthority()
    }
}
