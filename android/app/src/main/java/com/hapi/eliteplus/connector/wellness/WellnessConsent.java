package com.hapi.eliteplus.connector.wellness;

import android.content.Context;
import java.time.Instant;
import org.json.JSONObject;

// The single authoritative Digital Wellness production consent write. The consumer UI and the worker both use
// the production store; the bridge resolves only the state read back after the commit.
final class WellnessConsent {
    private WellnessConsent() {}

    static JSONObject apply(Context context, boolean enabled) throws Exception {
        if (android.os.Build.VERSION.SDK_INT < 29) throw new IllegalStateException("DIGITAL_WELLNESS_REQUIRES_ANDROID_10");
        WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> {
            WellnessStore store = new WellnessStore(context);
            JSONObject state = store.read();
            if (enabled) store.requireScope(state.getString("scope"));
            String now = Instant.now().toString();
            state.put("consent", enabled).put("next_eligible_run", JSONObject.NULL);
            // A new opt-in starts a new generation; a refresh error from an earlier generation must not mask it.
            if (enabled) state.put("enabled_at", now).put("access_established_at", JSONObject.NULL).put("error", JSONObject.NULL);
            state.getJSONArray("ledger").put(new JSONObject().put("captured_at", now)
                .put("event", enabled ? "CONSENT_ENABLED" : "CONSENT_DISABLED"));
            state.getJSONArray("checkpoints").put(WellnessCheckpoint.capture(context, enabled, "UNKNOWN"));
            if (!enabled) WellnessStore.invalidateToday(state, "CONSENT_DISABLED");
            store.save(state);
            return null;
        });
        if (enabled) WellnessWorker.schedule(context); else WellnessWorker.cancel(context);
        return WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> new WellnessStore(context).read());
    }
}
