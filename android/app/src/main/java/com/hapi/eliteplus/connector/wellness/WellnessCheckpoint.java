package com.hapi.eliteplus.connector.wellness;

import android.app.KeyguardManager;
import android.content.Context;
import android.os.PowerManager;
import android.os.SystemClock;
import android.provider.Settings;
import java.time.Instant;
import java.util.TimeZone;
import org.json.JSONException;
import org.json.JSONObject;

final class WellnessCheckpoint {
    static JSONObject capture(Context context, boolean consent, String access) throws JSONException {
        PowerManager power = context.getSystemService(PowerManager.class);
        KeyguardManager keyguard = context.getSystemService(KeyguardManager.class);
        // BOOT_COUNT is an OS counter, not a device identifier. Uptime fallback is deliberately conservative.
        int boot = Settings.Global.getInt(context.getContentResolver(), Settings.Global.BOOT_COUNT, -1);
        String marker = boot >= 0 ? "boot:" + boot
            : "unresolved:" + (System.currentTimeMillis() - SystemClock.elapsedRealtime());
        return new JSONObject()
            .put("captured_at", Instant.now().toString())
            .put("screen_state", power == null ? "UNKNOWN" : power.isInteractive() ? "INTERACTIVE" : "NON_INTERACTIVE")
            .put("keyguard_state", keyguard == null ? "UNKNOWN" : keyguard.isKeyguardLocked() ? "LOCKED" : "UNLOCKED")
            .put("usage_access", access).put("consent", consent ? "ENABLED" : "DISABLED")
            .put("boot_session_marker", marker).put("timezone", TimeZone.getDefault().getID());
    }
}
