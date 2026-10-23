package com.hapi.eliteplus.connector.wellness;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.os.Build;
import android.provider.Settings;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.ActivityCallback;
import androidx.activity.result.ActivityResult;

@CapacitorPlugin(name = "EliteDigitalWellness")
public class EliteDigitalWellnessPlugin extends Plugin {
    // Refresh can wait on the worker lock and the JS sandbox; keep it off the shared Capacitor plugin thread
    // so direct AppOps probes (hasUsageAccess) are never queued behind it.
    private static final java.util.concurrent.ExecutorService REFRESH_EXECUTOR =
        java.util.concurrent.Executors.newSingleThreadExecutor();
    // Store reads/writes also leave the shared plugin thread and only try the store lock for a bounded time:
    // while a worker holds the store, callers get WELLNESS_STORE_BUSY instead of parking every plugin call.
    private static final java.util.concurrent.ExecutorService STORE_EXECUTOR =
        java.util.concurrent.Executors.newSingleThreadExecutor();

    private void rejectStore(PluginCall call, Exception failure, String message) {
        if (failure instanceof WellnessStore.Busy) call.reject("Digital Wellness storage is busy", "WELLNESS_STORE_BUSY");
        else call.reject(message, "WELLNESS_STORAGE_FAILED");
    }

    private void resolveState(PluginCall call) throws Exception {
        String state = WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS,
            () -> {
                WellnessStore store = new WellnessStore(getContext());
                store.requireScope(call.getString("scope"));
                var current = store.read();
                if (current.getBoolean("consent")) WellnessWorker.schedule(getContext());
                return current.toString();
            });
        call.resolve(new JSObject(state));
    }

    // Only the authenticated Connector session boundary calls this; consumer screens receive no owner setter.
    @PluginMethod public void bindAuthenticatedOwner(PluginCall call) {
        String owner = call.getString("ownerUserId");
        if (owner == null || owner.isBlank()) { call.reject("Sign in is required", "AUTH_REQUIRED"); return; }
        STORE_EXECUTOR.execute(() -> {
            try {
                String state = WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> {
                    WellnessStore store = new WellnessStore(getContext());
                    String previousScope = store.read().getString("scope");
                    var next = store.bindOwner(owner);
                    if (!previousScope.equals(next.getString("scope"))) WellnessWorker.cancel(getContext());
                    return next.toString();
                });
                call.resolve(new JSObject(state));
            } catch (Exception failure) {
                rejectStore(call, failure, "Digital Wellness owner could not be established");
            }
        });
    }

    @PluginMethod public void clearAuthenticatedOwner(PluginCall call) {
        STORE_EXECUTOR.execute(() -> {
            try {
                WellnessWorker.cancel(getContext());
                WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> {
                    new WellnessStore(getContext()).closeScope();
                    return null;
                });
                call.resolve();
            } catch (Exception failure) {
                rejectStore(call, failure, "Digital Wellness owner could not be cleared");
            }
        });
    }

    @PluginMethod public void getProductionState(PluginCall call) {
        STORE_EXECUTOR.execute(() -> {
            try {
                resolveState(call);
            }
            catch (Exception failure) { rejectStore(call, failure, "Digital Wellness storage could not be read"); }
        });
    }

    @PluginMethod public void setProductionConsent(PluginCall call) {
        Boolean enabled = call.getBoolean("enabled");
        if (enabled == null) { call.reject("Consent is required", "INVALID_CONSENT"); return; }
        STORE_EXECUTOR.execute(() -> {
            try {
                String state = WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> {
                    new WellnessStore(getContext()).requireScope(call.getString("scope"));
                    return WellnessConsent.apply(getContext(), enabled).toString();
                });
                call.resolve(new JSObject(state));
            } catch (Exception failure) {
                rejectStore(call, failure, "Digital Wellness consent could not be saved");
            }
        });
    }

    @PluginMethod public void closeProductionScope(PluginCall call) {
        STORE_EXECUTOR.execute(() -> {
            try {
                WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> {
                    WellnessStore store = new WellnessStore(getContext());
                    store.requireScope(call.getString("scope"));
                    WellnessWorker.cancel(getContext());
                    store.closeScope();
                    return null;
                });
                call.resolve(new JSObject(new WellnessStore(getContext()).read().toString()));
            } catch (Exception failure) {
                rejectStore(call, failure, "Digital Wellness scope could not be closed");
            }
        });
    }

    @PluginMethod public void refreshProduction(PluginCall call) {
        REFRESH_EXECUTOR.execute(() -> {
            try {
                WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> {
                    new WellnessStore(getContext()).requireScope(call.getString("scope"));
                    return null;
                });
                var state = WellnessWorker.refresh(getContext(), source(), WellnessRuntime::evaluate, call.getString("scope"));
                WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS, () -> {
                    new WellnessStore(getContext()).requireScope(call.getString("scope"));
                    if (!call.getString("scope").equals(state.getString("scope"))) throw new IllegalStateException("OWNER_SCOPE_CLOSED");
                    if (state.getBoolean("consent") && source().hasAccess()) WellnessWorker.schedule(getContext());
                    call.resolve(new JSObject(state.toString()));
                    return null;
                });
            } catch (Exception failure) {
                call.reject("Digital Wellness background runtime or query failed", "WELLNESS_REFRESH_FAILED");
            }
        });
    }

    // Unannotated overrides keep Capacitor's inherited permission/listener APIs off this bridge.
    @Override public void requestPermissions(PluginCall call) { call.reject("Unsupported operation", "UNSUPPORTED_OPERATION"); }
    @Override public void checkPermissions(PluginCall call) { call.reject("Unsupported operation", "UNSUPPORTED_OPERATION"); }
    @Override public void addListener(PluginCall call) { call.reject("Unsupported operation", "UNSUPPORTED_OPERATION"); }
    @Override public void removeListener(PluginCall call) { call.reject("Unsupported operation", "UNSUPPORTED_OPERATION"); }
    @Override public void removeAllListeners(PluginCall call) { call.reject("Unsupported operation", "UNSUPPORTED_OPERATION"); }

    private DigitalWellnessEventSource source() {
        return new AndroidUsageStatsEventSource(getContext());
    }

    @PluginMethod public void getPlatformInfo(PluginCall call) {
        call.resolve(new JSObject().put("platform", "ANDROID").put("androidVersion", Build.VERSION.RELEASE));
    }

    @PluginMethod public void isUsageAccessAvailable(PluginCall call) {
        checkAccess(call, false);
    }

    @PluginMethod public void hasUsageAccess(PluginCall call) {
        checkAccess(call, true);
    }

    private void checkAccess(PluginCall call, boolean access) {
        var source = source();
        var diagnostics = new QueryDiagnostics(null, null);
        diagnostics.stage = access ? "ACCESS_CHECK" : "SERVICE_LOOKUP";
        try {
            boolean value = access ? source.hasAccess() : source.isAvailable();
            source.describe(diagnostics);
            var status = new DigitalWellnessQuery.Failure(
                access ? "USAGE_ACCESS_DENIED" : "USAGE_STATS_UNAVAILABLE", diagnostics.stage, null);
            call.resolve(new JSObject().put(access ? "granted" : "available", value)
                .put("diagnostics", value ? diagnostics.metadata() : diagnostics.json(status)));
        } catch (RuntimeException failure) {
            source.describe(diagnostics);
            reject(call, diagnostics, new DigitalWellnessQuery.Failure(
                failure instanceof SecurityException ? "SECURITY_EXCEPTION" : "QUERY_FAILED",
                diagnostics.stage, failure));
        }
    }

    private void reject(PluginCall call, QueryDiagnostics diagnostics, DigitalWellnessQuery.Failure failure) {
        call.reject(QueryDiagnostics.message(failure.code), failure.code, diagnostics.json(failure));
    }

    @PluginMethod public void openUsageAccessSettings(PluginCall call) {
        try {
            startActivityForResult(call, new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS), "usageSettingsReturned");
        } catch (ActivityNotFoundException failure) {
            call.reject("Usage Access settings are unavailable", "UNAVAILABLE");
        }
    }

    @ActivityCallback
    private void usageSettingsReturned(PluginCall call, ActivityResult result) {
        if (call != null) call.resolve();
    }

    private static Object bridgeValue(PluginCall call, String name) {
        var data = call.getData();
        return data.isNull(name) ? null : data.opt(name);
    }

    @PluginMethod public void queryDigitalWellnessEvents(PluginCall call) {
        try {
            boolean consent = WellnessStore.tryLocked(WellnessStore.BRIDGE_LOCK_WAIT_MS,
                () -> {
                    WellnessStore store = new WellnessStore(getContext());
                    store.requireScope(call.getString("scope"));
                    return store.read().getBoolean("consent");
                });
            if (!consent) {
                call.reject("Digital Wellness consent is disabled", "CONSENT_REQUIRED");
                return;
            }
        } catch (Exception failure) {
            rejectStore(call, failure, "Digital Wellness consent could not be read");
            return;
        }
        var startMs = QueryValidation.millis(bridgeValue(call, "start"), true);
        var endMs = QueryValidation.millis(bridgeValue(call, "end"), false);
        var diagnostics = new QueryDiagnostics(startMs.value, endMs.value);
        diagnostics.api = Build.VERSION.SDK_INT;
        if (startMs.value == null || endMs.value == null) {
            diagnostics.inputRuleFailed = startMs.rule != null ? startMs.rule : endMs.rule;
            reject(call, diagnostics, new DigitalWellnessQuery.Failure("INVALID_QUERY", "QUERY_EVENTS", null));
            return;
        }
        long start = startMs.value;
        long end = endMs.value;
        try {
            var result = DigitalWellnessQuery.executeDetailed(source(), start,
                    end, System.currentTimeMillis(), diagnostics);
            diagnostics.stage = "BRIDGE_SERIALIZATION";
            JSArray events = new JSArray();
            for (var event : result.events) {
                events.put(new JSObject().put("eventType", event.eventType())
                    .put("timestamp", event.timestamp()));
            }
            JSObject eventCounts = new JSObject();
            result.eventCounts.forEach(eventCounts::put);
            call.resolve(new JSObject().put("events", events)
                .put("totalSupportedEvents", result.totalSupportedEvents)
                .put("deduplicatedCount", result.deduplicatedCount)
                .put("eventCounts", eventCounts)
                .put("queryStart", start).put("queryEnd", end)
                .put("permissionState", "AUTHORIZED").put("OSVersion", Build.VERSION.RELEASE)
                .put("collectionTimestamp", System.currentTimeMillis())
                .put("diagnostics", diagnostics.metadata())
                .put("historyCompleteness", "UNVERIFIED"));
        } catch (DigitalWellnessQuery.Failure failure) {
            reject(call, diagnostics, failure);
        } catch (RuntimeException failure) {
            reject(call, diagnostics, new DigitalWellnessQuery.Failure(
                failure instanceof SecurityException ? "SECURITY_EXCEPTION" : "BRIDGE_FAILURE",
                diagnostics.stage, failure));
        }
    }
}
