package com.hapi.eliteplus.connector.wellness;

import android.content.Context;
import androidx.javascriptengine.JavaScriptSandbox;
import androidx.javascriptengine.JavaScriptIsolate;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;

final class WellnessRuntime {
    static JSONObject evaluate(Context context, JSONObject input) throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 29) throw new IllegalStateException("DIGITAL_WELLNESS_REQUIRES_ANDROID_10");
        if (!JavaScriptSandbox.isSupported()) throw new IllegalStateException("JAVASCRIPT_SANDBOX_UNAVAILABLE");
        try (JavaScriptSandbox sandbox = JavaScriptSandbox.createConnectedInstanceAsync(context).get(20, TimeUnit.SECONDS);
             JavaScriptIsolate isolate = sandbox.createIsolate();
             InputStream source = context.getAssets().open("digital-wellness.js")) {
            if (!sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_EVALUATE_WITHOUT_TRANSACTION_LIMIT)
                || !sandbox.isFeatureSupported(JavaScriptSandbox.JS_FEATURE_ISOLATE_TERMINATION)) {
                throw new IllegalStateException("REQUIRED_SANDBOX_FEATURE_UNAVAILABLE");
            }
            String engine = new String(source.readAllBytes(), StandardCharsets.UTF_8);
            String script = engine + "\n"
                + "if(typeof Intl==='undefined'||new Intl.DateTimeFormat('en-CA',{timeZone:'America/New_York'}).resolvedOptions().timeZone!=='America/New_York')"
                + "throw new Error('REQUIRED_INTL_UNAVAILABLE');\n"
                + "JSON.stringify(EliteWellnessRuntime.refreshProduction(" + input.toString() + "));";
            return new JSONObject(isolate.evaluateJavaScriptAsync(script).get(45, TimeUnit.SECONDS));
        }
    }
}
