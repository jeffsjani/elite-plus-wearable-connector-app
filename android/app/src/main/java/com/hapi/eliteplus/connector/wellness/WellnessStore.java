package com.hapi.eliteplus.connector.wellness;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class WellnessStore {
    // Background refresh/worker paths may wait on this lock; bridge-facing paths must use tryLocked() so a
    // worker holding the store can only produce WELLNESS_STORE_BUSY, never a parked Capacitor or UI thread.
    static final ReentrantLock LOCK = new ReentrantLock();
    static final long BRIDGE_LOCK_WAIT_MS = 3_000L;
    static final class Busy extends IllegalStateException { Busy() { super("WELLNESS_STORE_BUSY"); } }
    interface Locked<T> { T run() throws Exception; }
    static <T> T locked(Locked<T> body) throws Exception {
        LOCK.lock();
        try { return body.run(); } finally { LOCK.unlock(); }
    }
    static <T> T tryLocked(long waitMs, Locked<T> body) throws Exception {
        if (!LOCK.tryLock(waitMs, TimeUnit.MILLISECONDS)) throw new Busy();
        try { return body.run(); } finally { LOCK.unlock(); }
    }
    private static final long CONTINUITY_RETENTION_MS = 10L * 86400000;
    private static final long AGGREGATE_RETENTION_MS = 90L * 86400000;
    private final SharedPreferences preferences;
    WellnessStore(Context context) {
        preferences = context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE);
    }
    JSONObject read() throws JSONException {
        pruneExpired();
        String scope = preferences.getString("active_scope", null);
        if (scope == null) scope = "SIGNED_OUT";
        String saved = preferences.getString("scope_" + scope, null);
        if (saved != null) return new JSONObject(saved);
        return new JSONObject().put("scope", scope).put("owner_kind",
                preferences.contains("active_owner") ? "AUTHENTICATED" : "LOCAL_PREVIEW")
            .put("consent", false).put("enabled_at", JSONObject.NULL).put("access_established_at", JSONObject.NULL)
            .put("checkpoints", new JSONArray()).put("ledger", new JSONArray()).put("days", new JSONArray())
            .put("outbox", new JSONArray()).put("worker_last_run", JSONObject.NULL)
            .put("next_eligible_run", JSONObject.NULL).put("last_usage_access_check", JSONObject.NULL)
            .put("last_sender_outcome", "CLOUD_DISABLED").put("error", JSONObject.NULL);
    }
    JSONObject bindOwner(String owner) throws JSONException {
        if (owner == null || owner.isBlank()) throw new IllegalArgumentException("AUTHENTICATED_OWNER_REQUIRED");
        if (owner.equals(preferences.getString("active_owner", null))) return read();
        closeScope();
        commit(preferences.edit().putString("active_owner", owner)
            .putString("active_scope", UUID.randomUUID().toString()));
        JSONObject state = read();
        save(state);
        return state;
    }
    void requireScope(String scope) {
        if (scope == null || !preferences.contains("active_owner")
            || !scope.equals(preferences.getString("active_scope", null))) {
            throw new IllegalStateException("OWNER_SCOPE_CLOSED");
        }
    }
    void save(JSONObject state) throws JSONException {
        if (!state.getString("scope").equals(preferences.getString("active_scope", null))) {
            throw new IllegalStateException("OWNER_SCOPE_CLOSED");
        }
        trim(state, "checkpoints", 256);
        trim(state, "ledger", 512);
        commit(preferences.edit().putString("scope_" + state.getString("scope"), state.toString()));
    }
    void closeScope() throws JSONException {
        if (!preferences.contains("active_scope")) return;
        JSONObject state = read();
        state.put("consent", false).put("next_eligible_run", JSONObject.NULL);
        state.getJSONArray("ledger").put(new JSONObject().put("captured_at", java.time.Instant.now().toString())
            .put("event", "CONSENT_DISABLED"));
        save(state);
        commit(preferences.edit().remove("active_scope").remove("active_owner"));
    }
    static void invalidateToday(JSONObject state, String reason) throws JSONException {
        String today = java.time.LocalDate.now().toString();
        JSONArray days = state.getJSONArray("days");
        for (int index = 0; index < days.length(); index++) {
            JSONObject day = days.getJSONObject(index);
            if (!today.equals(day.getString("local_date"))
                || !java.util.TimeZone.getDefault().getID().equals(day.getString("timezone"))
                || "QUALIFIED".equals(day.getString("coverage_state"))) continue;
            day.put("coverage_state", "UNKNOWN").put("confidence", "UNKNOWN");
            for (String metric : new String[] { "screen_time_minutes", "pickups", "first_pickup", "screen_sessions", "late_night_screen_minutes" }) {
                day.put(metric, JSONObject.NULL);
            }
            JSONArray reasons = day.getJSONArray("quality_reasons");
            boolean found = false;
            for (int item = 0; item < reasons.length(); item++) if (reason.equals(reasons.getString(item))) found = true;
            if (!found) reasons.put(reason);
        }
    }
    private static void trim(JSONObject state, String key, int maximum) throws JSONException {
        JSONArray source = state.getJSONArray(key);
        if (source.length() <= maximum) return;
        JSONArray retained = new JSONArray();
        for (int index = source.length() - maximum; index < source.length(); index++) retained.put(source.get(index));
        state.put(key, retained);
    }
    private void pruneExpired() throws JSONException {
        long now = System.currentTimeMillis();
        SharedPreferences.Editor editor = preferences.edit();
        boolean changed = false;
        String active = preferences.getString("active_scope", null);
        for (var entry : preferences.getAll().entrySet()) {
            if (!entry.getKey().startsWith("scope_")) continue;
            JSONObject state = new JSONObject((String) entry.getValue());
            String before = state.toString();
            retainRecent(state, "days", "updated_at", now - AGGREGATE_RETENTION_MS);
            retainRecent(state, "checkpoints", "captured_at", now - CONTINUITY_RETENTION_MS);
            retainRecent(state, "ledger", "captured_at", now - CONTINUITY_RETENTION_MS);
            JSONArray outbox = state.getJSONArray("outbox");
            JSONArray retained = new JSONArray();
            for (int index = 0; index < outbox.length(); index++) {
                JSONObject item = outbox.getJSONObject(index);
                if (java.time.Instant.parse(item.getJSONObject("observation").getString("client_queued_at")).toEpochMilli()
                    >= now - AGGREGATE_RETENTION_MS) retained.put(item);
            }
            state.put("outbox", retained);
            boolean empty = state.getJSONArray("days").length() == 0 && state.getJSONArray("checkpoints").length() == 0
                && state.getJSONArray("ledger").length() == 0 && retained.length() == 0;
            if (!entry.getKey().equals("scope_" + active) && !state.getBoolean("consent") && empty) {
                editor.remove(entry.getKey());
                changed = true;
            } else if (!before.equals(state.toString())) {
                editor.putString(entry.getKey(), state.toString());
                changed = true;
            }
        }
        if (changed) commit(editor);
    }
    private static void retainRecent(JSONObject state, String key, String timestamp, long cutoff) throws JSONException {
        JSONArray source = state.getJSONArray(key);
        JSONArray retained = new JSONArray();
        for (int index = 0; index < source.length(); index++) {
            JSONObject item = source.getJSONObject(index);
            if (java.time.Instant.parse(item.getString(timestamp)).toEpochMilli() >= cutoff) retained.put(item);
        }
        state.put(key, retained);
    }
    private void commit(SharedPreferences.Editor editor) {
        if (!editor.commit()) throw new IllegalStateException("DIGITAL_WELLNESS_STORAGE_FAILED");
    }
}
