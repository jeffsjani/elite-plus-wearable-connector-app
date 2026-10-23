package com.hapi.eliteplus.connector.wellness;

import android.content.Context;
import androidx.annotation.NonNull;
import androidx.work.ExistingPeriodicWorkPolicy;
import androidx.work.PeriodicWorkRequest;
import androidx.work.WorkManager;
import androidx.work.Worker;
import androidx.work.WorkerParameters;
import java.time.Instant;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class WellnessWorker extends Worker {
    static final String WORK_NAME = "eliteplus.digital-wellness.refresh.v1";
    private static final Object REFRESH_LOCK = new Object();
    interface Runtime { JSONObject evaluate(Context context, JSONObject input) throws Exception; }
    public WellnessWorker(@NonNull Context context, @NonNull WorkerParameters parameters) { super(context, parameters); }
    static void schedule(Context context) {
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(WORK_NAME, ExistingPeriodicWorkPolicy.KEEP,
            new PeriodicWorkRequest.Builder(WellnessWorker.class, 6, TimeUnit.HOURS).build());
    }
    static void cancel(Context context) { WorkManager.getInstance(context).cancelUniqueWork(WORK_NAME); }

    @NonNull @Override public Result doWork() {
        try {
            refresh(getApplicationContext(), new AndroidUsageStatsEventSource(getApplicationContext()), WellnessRuntime::evaluate);
            return Result.success();
        } catch (InterruptedException failure) {
            Thread.currentThread().interrupt();
            return Result.retry();
        } catch (Exception failure) {
            return Result.retry();
        }
    }

    static JSONObject refresh(Context context, DigitalWellnessEventSource source, Runtime runtime) throws Exception {
        return refresh(context, source, runtime, null);
    }
    static JSONObject refresh(Context context, DigitalWellnessEventSource source, Runtime runtime, String expectedScope) throws Exception {
        synchronized (REFRESH_LOCK) {
            JSONObject state;
            WellnessStore.LOCK.lock();
            try { state = new WellnessStore(context).read(); } finally { WellnessStore.LOCK.unlock(); }
            if (expectedScope != null && !expectedScope.equals(state.getString("scope"))) {
                throw new IllegalStateException("OWNER_SCOPE_CLOSED");
            }
            try { return refreshSerial(context, source, runtime, state); }
            catch (Exception failure) {
                WellnessStore.LOCK.lock();
            try {
                    WellnessStore store = new WellnessStore(context);
                    JSONObject current = store.read();
                    if (sameGeneration(current, state)) {
                        if (current.isNull("error")) current.put("error", "BACKGROUND_REFRESH_FAILED");
                        WellnessStore.invalidateToday(current, "BACKGROUND_REFRESH_FAILED");
                        store.save(current);
                    }
                } finally { WellnessStore.LOCK.unlock(); }
                throw failure;
            }
        }
    }
    private static JSONObject refreshSerial(Context context, DigitalWellnessEventSource source, Runtime runtime, JSONObject state) throws Exception {
        if (!state.getBoolean("consent") || !"AUTHENTICATED".equals(state.optString("owner_kind"))) return state;
        boolean available = source.isAvailable();
        boolean granted = available && source.hasAccess();
        JSONObject checkpoint = WellnessCheckpoint.capture(context, true, granted ? "GRANTED" : available ? "DENIED" : "UNKNOWN");
        long now = System.currentTimeMillis();
        long start = Math.max(0, now - DigitalWellnessQuery.MAX_INTERVAL_MS);
        JSONArray events = new JSONArray();
        boolean queryOk = false;
        if (granted) {
            try {
                DigitalWellnessQuery.Result result;
                WellnessStore.LOCK.lock();
            try {
                    if (!sameGeneration(new WellnessStore(context).read(), state)) return new WellnessStore(context).read();
                    result = DigitalWellnessQuery.executeDetailed(source, start, now, now, new QueryDiagnostics(start, now));
                } finally { WellnessStore.LOCK.unlock(); }
                for (var event : result.events) events.put(new JSONObject().put("type", event.eventType())
                    .put("timestamp", Instant.ofEpochMilli(event.timestamp()).toString()));
                queryOk = true;
            } catch (DigitalWellnessQuery.Failure failure) {
                if ("USAGE_ACCESS_DENIED".equals(failure.code) || "SECURITY_EXCEPTION".equals(failure.code)) {
                    granted = false;
                    checkpoint.put("usage_access", "DENIED");
                }
            }
        }
        if (!granted) {
            if (available) cancel(context);
            WellnessStore.LOCK.lock();
            try {
                WellnessStore store = new WellnessStore(context);
                JSONObject current = store.read();
                if (!sameGeneration(current, state)) return current;
                current.getJSONArray("checkpoints").put(checkpoint);
                if (available) current.getJSONArray("ledger").put(new JSONObject()
                    .put("captured_at", checkpoint.getString("captured_at")).put("event", "ACCESS_DENIED"));
                current.put("worker_last_run", checkpoint.getString("captured_at"))
                    .put("last_usage_access_check", checkpoint.getString("captured_at"))
                    .put("next_eligible_run", JSONObject.NULL)
                    .put("error", available ? JSONObject.NULL : "USAGE_STATS_UNAVAILABLE");
                WellnessStore.invalidateToday(current, available ? "USAGE_ACCESS_DENIED" : "SOURCE_UNAVAILABLE");
                store.save(current);
                return current;
            } finally { WellnessStore.LOCK.unlock(); }
        }
        JSONObject input = new JSONObject().put("state", state).put("checkpoint", checkpoint).put("events", events)
            .put("query_start", Instant.ofEpochMilli(start).toString()).put("query_end", Instant.ofEpochMilli(now).toString())
            .put("query_ok", queryOk).put("os_version", android.os.Build.VERSION.RELEASE);
        JSONObject updated;
        try { updated = runtime.evaluate(context, input); }
        catch (InterruptedException failure) { throw failure; }
        catch (Exception failure) {
            WellnessStore.LOCK.lock();
            try {
                WellnessStore store = new WellnessStore(context);
                JSONObject current = store.read();
                if (sameGeneration(current, state)) {
                    current.getJSONArray("checkpoints").put(checkpoint);
                    if (!granted && available) current.getJSONArray("ledger").put(new JSONObject()
                        .put("captured_at", checkpoint.getString("captured_at")).put("event", "ACCESS_DENIED"));
                    current.put("worker_last_run", checkpoint.getString("captured_at"))
                        .put("last_usage_access_check", checkpoint.getString("captured_at"))
                        .put("error", "SEMANTIC_RUNTIME_UNAVAILABLE");
                    WellnessStore.invalidateToday(current, "SEMANTIC_RUNTIME_UNAVAILABLE");
                    store.save(current);
                }
            } finally { WellnessStore.LOCK.unlock(); }
            throw new IllegalStateException("SEMANTIC_RUNTIME_UNAVAILABLE");
        }
        WellnessStore.LOCK.lock();
            try {
            WellnessStore store = new WellnessStore(context);
            JSONObject current = store.read();
            if (!sameGeneration(current, state)) return current;
            if (!source.hasAccess()) {
                JSONObject denied = WellnessCheckpoint.capture(context, true, "DENIED");
                current.getJSONArray("ledger").put(new JSONObject().put("captured_at", denied.getString("captured_at")).put("event", "ACCESS_DENIED"));
                current.getJSONArray("checkpoints").put(denied);
                current.put("next_eligible_run", JSONObject.NULL).put("error", JSONObject.NULL)
                    .put("worker_last_run", denied.getString("captured_at")).put("last_usage_access_check", denied.getString("captured_at"));
                WellnessStore.invalidateToday(current, "USAGE_ACCESS_DENIED");
                store.save(current);
                cancel(context);
                return current;
            }
            store.save(updated);
        } finally { WellnessStore.LOCK.unlock(); }
        return updated;
    }
    private static boolean sameGeneration(JSONObject current, JSONObject original) throws JSONException {
        return current.getString("scope").equals(original.getString("scope"))
            && current.getBoolean("consent") && current.optString("enabled_at").equals(original.optString("enabled_at"))
            && current.getJSONArray("ledger").toString().equals(original.getJSONArray("ledger").toString());
    }
}
