package com.hapi.eliteplus.connector.wellness;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.os.Process;
import android.os.Build;
import android.os.UserManager;
import java.util.ArrayList;
import java.util.List;

public final class AndroidUsageStatsEventSource implements DigitalWellnessEventSource {
    interface Cursor {
        boolean hasNext();
        int type();
        long timestamp();
        void next();
    }
    interface Platform {
        boolean serviceAvailable();
        boolean userUnlocked();
        Integer appOpsMode();
        int apiLevel();
        Cursor query(long start, long end);
    }
    private final Platform platform;
    private Boolean serviceAvailable;
    private Boolean access;
    private Integer appOpsMode;

    public AndroidUsageStatsEventSource(Context context) {
        platform = new Platform() {
            private UsageStatsManager manager;
            public boolean serviceAvailable() {
                if (Build.VERSION.SDK_INT < 29) return false;
                manager = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
                return manager != null;
            }
            public boolean userUnlocked() {
                UserManager users = context.getSystemService(UserManager.class);
                return users != null && users.isUserUnlocked();
            }
            public Integer appOpsMode() {
                if (Build.VERSION.SDK_INT < 29) return null;
                AppOpsManager ops = context.getSystemService(AppOpsManager.class);
                return ops == null ? null : ops.unsafeCheckOpNoThrow(
                    AppOpsManager.OPSTR_GET_USAGE_STATS, Process.myUid(), context.getPackageName());
            }
            public int apiLevel() { return Build.VERSION.SDK_INT; }
            public Cursor query(long start, long end) {
                UsageEvents events = manager.queryEvents(start, end);
                if (events == null) return null;
                return new Cursor() {
                    private final UsageEvents.Event event = new UsageEvents.Event();
                    public boolean hasNext() { return events.hasNextEvent(); }
                    public void next() {
                        if (!events.getNextEvent(event)) throw new IllegalStateException();
                    }
                    public int type() { return event.getEventType(); }
                    public long timestamp() { return event.getTimeStamp(); }
                };
            }
        };
    }

    AndroidUsageStatsEventSource(Platform platform) {
        this.platform = platform;
    }

    @Override public boolean isAvailable() {
        serviceAvailable = platform.serviceAvailable();
        return serviceAvailable && platform.userUnlocked();
    }

    @Override public boolean hasAccess() {
        appOpsMode = platform.appOpsMode();
        access = appOpsMode != null && appOpsMode == AppOpsManager.MODE_ALLOWED;
        return access;
    }

    @Override public void describe(QueryDiagnostics diagnostics) {
        diagnostics.api = platform.apiLevel();
        diagnostics.service = serviceAvailable;
        if (diagnostics.access == null) diagnostics.access = access;
        diagnostics.appOpsMode = appOpsMode;
        diagnostics.appOpsBranch = "API_29_PLUS_UNSAFE_CHECK_OP_NO_THROW";
    }

    @Override public List<Event> query(long start, long end) {
        Cursor events = platform.query(start, end);
        if (events == null) throw new DigitalWellnessQuery.Failure("QUERY_RETURNED_NULL", "QUERY_EVENTS", null);
        List<Event> result = new ArrayList<>();
        try {
            while (events.hasNext()) {
                events.next();
                Event minimized = minimize(events.type(), events.timestamp());
                if (minimized != null) {
                    if (result.size() == DigitalWellnessQuery.MAX_EVENTS) {
                        throw new DigitalWellnessQuery.Failure("EVENT_LIMIT_EXCEEDED", "EVENT_ITERATION", null);
                    }
                    result.add(minimized);
                }
            }
        } catch (DigitalWellnessQuery.Failure failure) {
            throw failure;
        } catch (SecurityException failure) {
            throw new DigitalWellnessQuery.Failure("SECURITY_EXCEPTION", "EVENT_ITERATION", failure);
        } catch (RuntimeException failure) {
            throw new DigitalWellnessQuery.Failure("QUERY_ITERATION_FAILED", "EVENT_ITERATION", failure);
        }
        return result;
    }

    static Event minimize(int eventType, long timestamp) {
        String type = switch (eventType) {
            case UsageEvents.Event.SCREEN_INTERACTIVE -> "SCREEN_INTERACTIVE";
            case UsageEvents.Event.SCREEN_NON_INTERACTIVE -> "SCREEN_NON_INTERACTIVE";
            case UsageEvents.Event.KEYGUARD_SHOWN -> "KEYGUARD_SHOWN";
            case UsageEvents.Event.KEYGUARD_HIDDEN -> "KEYGUARD_HIDDEN";
            default -> null;
        };
        return type == null ? null : new Event(type, timestamp);
    }
}
