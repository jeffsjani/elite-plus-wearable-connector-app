package com.hapi.eliteplus.connector

import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.ByteArrayOutputStream
import java.io.IOException

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 31], manifest = Config.NONE)
class ConnectionDiagnosticExportPluginTest {
    private val json = "{\"text\":\"" + "\u00e9".repeat(200000) + "\"}"

    @Test fun copiesTheFullPayloadToSystemClipboard() {
        val context = RuntimeEnvironment.getApplication()
        ConnectionDiagnosticExportPlugin.copyToClipboard(context, json)
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
        assertEquals(json, clipboard.primaryClip!!.getItemAt(0).text.toString())
    }

    @Test fun createsAnOpenableJsonDocumentWithSuggestedFilename() {
        val filename = "ElitePlus-V8-Connection-Diagnostic-2026-10-11T21-00-00Z.json"
        val intent = ConnectionDiagnosticExportPlugin.createDocumentIntent(filename)
        assertEquals(Intent.ACTION_CREATE_DOCUMENT, intent.action)
        assertEquals("application/json", intent.type)
        assertTrue(intent.categories.contains(Intent.CATEGORY_OPENABLE))
        assertEquals(filename, intent.getStringExtra(Intent.EXTRA_TITLE))
    }

    @Test fun writesExactUtf8BytesToTheSelectedDocumentAndClosesIt() {
        val resolver = RuntimeEnvironment.getApplication().contentResolver
        val uri = Uri.parse("content://test/documents/diagnostic")
        var closed = false
        val output = object : ByteArrayOutputStream() {
            override fun close() { closed = true; super.close() }
        }
        shadowOf(resolver).registerOutputStream(uri, output)
        ConnectionDiagnosticExportPlugin.writeDocument(resolver, uri, json)
        assertArrayEquals(json.toByteArray(Charsets.UTF_8), output.toByteArray())
        assertTrue(closed)
    }

    @Test fun surfacesDocumentWriteFailuresAndClosesTheStream() {
        val resolver = RuntimeEnvironment.getApplication().contentResolver
        val uri = Uri.parse("content://test/documents/failure")
        var closed = false
        val output = object : java.io.OutputStream() {
            override fun write(value: Int) { throw IOException("Provider write failed") }
            override fun close() { closed = true }
        }
        shadowOf(resolver).registerOutputStream(uri, output)
        assertThrows(IOException::class.java) { ConnectionDiagnosticExportPlugin.writeDocument(resolver, uri, json) }
        assertTrue(closed)
    }
}
