package com.hapi.eliteplus.connector

import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.activity.result.ActivityResult
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.ActivityCallback
import com.getcapacitor.annotation.CapacitorPlugin
import java.io.IOException

@CapacitorPlugin(name = "ConnectionDiagnosticExport")
class ConnectionDiagnosticExportPlugin : Plugin() {
    private fun payload(call: PluginCall): String? {
        if (!BuildConfig.CONNECTION_DIAGNOSTIC) {
            call.reject("Connection diagnostic build required", "CONNECTION_DIAGNOSTIC_BUILD_REQUIRED")
            return null
        }
        val json = call.getString("json")
        if (json.isNullOrEmpty()) {
            call.reject("Diagnostic JSON is required", "DIAGNOSTIC_JSON_REQUIRED")
            return null
        }
        return json
    }

    @PluginMethod
    fun copyJson(call: PluginCall) {
        val json = payload(call) ?: return
        bridge.executeOnMainThread {
            try {
                copyToClipboard(context, json)
                call.resolve()
            } catch (error: Exception) {
                call.reject("Unable to copy diagnostic JSON: ${error.message}", "DIAGNOSTIC_COPY_FAILED", error)
            }
        }
    }

    @PluginMethod
    fun saveJson(call: PluginCall) {
        payload(call) ?: return
        val filename = call.getString("filename")
        if (filename.isNullOrBlank() || !filename.endsWith(".json") || filename.contains('/') || filename.contains('\\')) {
            call.reject("A .json filename without path separators is required", "DIAGNOSTIC_FILENAME_INVALID")
            return
        }
        try {
            startActivityForResult(call, createDocumentIntent(filename), "documentCreated")
        } catch (error: Exception) {
            call.reject("Unable to open the system file picker: ${error.message}", "DIAGNOSTIC_PICKER_FAILED", error)
        }
    }

    @ActivityCallback
    private fun documentCreated(call: PluginCall, result: ActivityResult) {
        if (result.resultCode != Activity.RESULT_OK) {
            call.reject("Diagnostic save cancelled", "DIAGNOSTIC_SAVE_CANCELLED")
            return
        }
        val uri = result.data?.data
        if (uri == null) {
            call.reject("System file picker returned no document", "DIAGNOSTIC_DOCUMENT_MISSING")
            return
        }
        val json = payload(call) ?: return
        bridge.execute {
            try {
                writeDocument(context.contentResolver, uri, json)
                call.resolve()
            } catch (error: Exception) {
                call.reject("Unable to save diagnostic JSON: ${error.message}", "DIAGNOSTIC_SAVE_FAILED", error)
            }
        }
    }

    companion object {
        internal fun copyToClipboard(context: Context, json: String) {
            val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                ?: throw IllegalStateException("System clipboard unavailable")
            clipboard.setPrimaryClip(ClipData.newPlainText("Elite+ V8 connection diagnostic", json))
        }

        internal fun createDocumentIntent(filename: String) = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
            addCategory(Intent.CATEGORY_OPENABLE)
            type = "application/json"
            putExtra(Intent.EXTRA_TITLE, filename)
        }

        internal fun writeDocument(resolver: ContentResolver, uri: Uri, json: String) {
            val output = resolver.openOutputStream(uri, "wt")
                ?: throw IOException("Document provider returned no writable stream")
            output.use { it.write(json.toByteArray(Charsets.UTF_8)) }
        }
    }
}
