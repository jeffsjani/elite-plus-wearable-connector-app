package com.hapi.eliteplus.connector.jcvital

import android.net.Uri
import android.content.Context
import android.content.Intent
import android.webkit.MimeTypeMap
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.FileProvider
import com.capacitorjs.plugins.share.SharePlugin
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import com.getcapacitor.PluginCall
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import java.io.File

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28])
class CertificationJsonFileTest {
    @Before fun clearCachedProviderRoots() {
        // Robolectric changes dataDir between tests; FileProvider's static authority cache does not.
        val cache = FileProvider::class.java.getDeclaredField("sCache").apply { isAccessible = true }
            .get(null) as MutableMap<*, *>
        cache.clear()
    }

    @Test fun standardCapacitorShareCreatesJsonChooserWithReadableAttachmentForDriveAndOtherTargets() {
        val context = RuntimeEnvironment.getApplication()
        shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("json", "application/json")
        val controller = Robolectric.buildActivity(AppCompatActivity::class.java)
        controller.get().setTheme(androidx.appcompat.R.style.Theme_AppCompat)
        val activity = controller.create().get()
        try {
            for (filename in listOf("JCVital PPI grouped certification.json",
                "JCVital PPI certification attempt.json", "jcvital-v8-phase3abc-validation.json",
                "JCVital Activity 24-25 grouped certification.json")) {
                val file = File(context.cacheDir, filename)
                val json = "{\n  \"exact\": \"PPI evidence\"\n}\n"
                try {
                    file.writeText(json, Charsets.UTF_8)
                    var chooser: Intent? = null
                    val plugin = object : SharePlugin() {
                        override fun getContext(): Context = context
                        override fun getActivity(): AppCompatActivity = activity
                        override fun startActivityForResult(call: PluginCall, intent: Intent, callbackName: String) {
                            chooser = intent
                        }
                    }
                    val data = JSObject().put("title", "PPI JSON").put("text", filename)
                        .put("files", JSArray().put(Uri.fromFile(file).toString())).put("dialogTitle", "Share / Save")
                    plugin.share(object : PluginCall(null, "Share", "-1", "share", data) {
                        override fun reject(message: String) { throw IllegalStateException(message) }
                    })
                    assertNotNull(chooser)
                    assertEquals(Intent.ACTION_CHOOSER, chooser!!.action)
                    val send = chooser!!.getParcelableExtra<Intent>(Intent.EXTRA_INTENT)!!
                    assertEquals(Intent.ACTION_SEND, send.action)
                    assertEquals("application/json", send.type)
                    assertNull(send.`package`)
                    assertNull(send.component)
                    assertTrue(send.flags and Intent.FLAG_GRANT_READ_URI_PERMISSION != 0)
                    val attachment = send.getParcelableExtra<Uri>(Intent.EXTRA_STREAM)!!
                    assertEquals("content", attachment.scheme)
                    assertEquals(filename, attachment.lastPathSegment)
                    assertEquals("application/json", context.contentResolver.getType(attachment))
                    assertEquals(json, context.contentResolver.openInputStream(attachment)!!
                        .bufferedReader(Charsets.UTF_8).use { it.readText() })
                } finally {
                    assertTrue(file.delete())
                }
            }
        } finally {
            controller.destroy()
        }
    }

    @Test fun cacheJsonWithSpacesHasJsonMimeAndShareableContentUri() {
        val context = RuntimeEnvironment.getApplication()
        val file = File(context.cacheDir, "JCVital PPI grouped certification.json")
        try {
            // Robolectric's MIME registry is empty, unlike Android's platform registry.
            shadowOf(MimeTypeMap.getSingleton()).addExtensionMimeTypeMapping("json", "application/json")
            file.writeText("""{"certificationGroupId":"saved-vc9"}""", Charsets.UTF_8)
            val fileUri = Uri.fromFile(file).toString()
            val extension = MimeTypeMap.getFileExtensionFromUrl(fileUri)
            assertEquals("json", extension)
            assertEquals("application/json", MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension))
            val contentUri = FileProvider.getUriForFile(context, "${context.packageName}.fileprovider", file)
            assertEquals("content", contentUri.scheme)
            assertEquals("application/json", context.contentResolver.getType(contentUri))
            assertEquals(file.readText(), context.contentResolver.openInputStream(contentUri)!!.bufferedReader().use { it.readText() })
        } finally {
            assertTrue(file.delete())
        }
    }
}
