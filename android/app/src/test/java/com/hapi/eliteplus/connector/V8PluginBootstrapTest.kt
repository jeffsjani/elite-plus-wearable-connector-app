package com.hapi.eliteplus.connector

import android.content.pm.PackageInfo
import com.getcapacitor.JSObject
import com.getcapacitor.CapConfig
import com.getcapacitor.PluginCall
import com.hapi.eliteplus.connector.jcvital.JCVitalV8Plugin
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.shadows.ShadowWebView

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [31])
class V8PluginBootstrapTest {
    class TestActivity : MainActivity() {
        override fun load() {
            // Robolectric has no system WebView service-worker provider.
            config = CapConfig.Builder(this).setResolveServiceWorkerRequests(false).create()
            super.load()
        }
    }

    private class CapturedCall(method: String) : PluginCall(null, "JCVitalV8", "test", method, JSObject()) {
        var result: JSObject? = null
        var errorCode: String? = null
        override fun resolve(data: JSObject) { result = data }
        override fun reject(message: String, code: String) { errorCode = code }
    }

    @Test fun productionBridgeRegistersLoadsAndAcknowledgesThePluginWithoutEngineeringFlags() {
        assertFalse(BuildConfig.CONNECTION_DIAGNOSTIC)
        assertFalse(BuildConfig.PIPELINE_DIAGNOSTIC)
        ShadowWebView.setCurrentWebViewPackage(PackageInfo().apply {
            packageName = "com.google.android.webview"
            versionName = "130.0.0.0"
        })
        val application = RuntimeEnvironment.getApplication()
        shadowOf(application).grantPermissions("${application.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        shadowOf(application).declareActionUnbindable("android.support.customtabs.action.CustomTabsService")
        val controller = Robolectric.buildActivity(TestActivity::class.java).setup()
        try {
            val bridge = controller.get().bridge
            assertNotNull(bridge.getPlugin("JCVitalV8"))
            val plugin = bridge.getPlugin("JCVitalV8").instance as JCVitalV8Plugin
            assertNotNull(bridge.getPlugin("ConnectionDiagnosticExport"))
            repeat(2) {
                val call = CapturedCall("initialize")
                plugin.initialize(call)
                assertNull(call.errorCode)
                assertEquals(true, call.result!!.getBoolean("initialized"))
                assertEquals("JCVitalV8", call.result!!.getString("pluginName"))
            }
            val snapshot = CapturedCall("getConnectionDiagnosticSnapshot")
            plugin.getConnectionDiagnosticSnapshot(snapshot)
            assertNull(snapshot.errorCode)
            assertTrue(snapshot.result!!.getJSONObject("trace").getBoolean("enabled"))
            assertFalse(snapshot.result!!.getJSONObject("trace").isNull("pluginLoadedAt"))
        } finally {
            controller.pause().stop().destroy()
        }
    }

    @Test fun initializationWithoutNativeLoadRejectsInsteadOfAcknowledgingSuccess() {
        val call = CapturedCall("initialize")
        JCVitalV8Plugin().initialize(call)
        assertNull(call.result)
        assertEquals("SDK_INITIALIZATION_FAILED", call.errorCode)
    }
}
