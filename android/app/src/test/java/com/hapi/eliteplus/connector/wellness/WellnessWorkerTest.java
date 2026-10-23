package com.hapi.eliteplus.connector.wellness;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import androidx.work.testing.WorkManagerTestInitHelper;
import androidx.work.testing.TestDriver;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class WellnessWorkerTest {
    private Context context;
    private WellnessStore store;
    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE).edit().clear().commit();
        store = new WellnessStore(context);
        store.bindOwner("authenticated-test-user");
        WorkManagerTestInitHelper.initializeTestWorkManager(context);
    }
    private void enable() throws Exception {
        JSONObject state = store.read().put("consent", true).put("enabled_at", "2026-01-01T12:00:00Z");
        store.save(state);
    }
    @Test public void disabledMeansNoQueryAndNoRuntime() throws Exception {
        var source = new FakeDigitalWellnessEventSource();
        AtomicInteger calls = new AtomicInteger();
        WellnessWorker.refresh(context, source, (ctx, input) -> { calls.incrementAndGet(); return input.getJSONObject("state"); });
        assertEquals(0, source.queries);
        assertEquals(0, calls.get());
    }
    @Test public void denialPersistsCheckpointAndContinuityWithoutRuntimeOrQuery() throws Exception {
        enable();
        var source = new FakeDigitalWellnessEventSource();
        source.access = false;
        WellnessWorker.refresh(context, source, (ctx, input) -> { fail("Runtime should not run"); return null; });
        assertEquals(0, source.queries);
        JSONObject restarted = new WellnessStore(context).read();
        assertEquals("ACCESS_DENIED", restarted.getJSONArray("ledger").getJSONObject(0).getString("event"));
        assertEquals("DENIED", restarted.getJSONArray("checkpoints").getJSONObject(0).getString("usage_access"));
    }
    @Test public void workerUses48HourBoundAndOnlyMinimizedTransientEvents() throws Exception {
        enable();
        var source = new FakeDigitalWellnessEventSource();
        WellnessWorker.refresh(context, source, (ctx, input) -> {
            assertEquals(48L * 3600000, source.lastEnd - source.lastStart);
            assertTrue(input.has("events"));
            return input.getJSONObject("state");
        });
        assertEquals(1, source.queries);
        assertFalse(store.read().has("events"));
    }
    @Test public void revocationDuringCalculationDiscardsLateResult() throws Exception {
        enable();
        var source = new FakeDigitalWellnessEventSource();
        WellnessWorker.refresh(context, source, (ctx, input) -> {
            store.save(store.read().put("consent", false));
            return input.getJSONObject("state").put("days", new JSONArray().put("must-not-save"));
        });
        assertFalse(store.read().getBoolean("consent"));
        assertEquals(0, store.read().getJSONArray("days").length());
    }
    @Test public void ownerChangeClosesOldStoreWithoutReassigningItsDataOrConsent() throws Exception {
        enable();
        String oldScope = store.read().getString("scope");
        store.closeScope();
        JSONObject fresh = new WellnessStore(context).read();
        assertNotEquals(oldScope, fresh.getString("scope"));
        assertFalse(fresh.getBoolean("consent"));
        assertEquals(0, fresh.getJSONArray("days").length());
        assertTrue(context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE)
            .contains("scope_" + oldScope));
    }
    @Test public void unavailableSourceRecordsQualityAndDoesNotQuery() throws Exception {
        enable();
        var source = new FakeDigitalWellnessEventSource();
        source.available = false;
        WellnessWorker.refresh(context, source, (ctx, input) -> { fail("No runtime"); return null; });
        assertEquals(0, source.queries);
        assertEquals("USAGE_STATS_UNAVAILABLE", store.read().getString("error"));
    }
    @Test public void runtimeFailureIsExplicitAndDoesNotPersistRawEvents() throws Exception {
        enable();
        var source = new FakeDigitalWellnessEventSource();
        try {
            WellnessWorker.refresh(context, source, (ctx, input) -> { throw new IllegalStateException("private runtime detail"); });
            fail("Must fail explicitly");
        } catch (IllegalStateException expected) {
            assertEquals("SEMANTIC_RUNTIME_UNAVAILABLE", expected.getMessage());
        }
        String saved = store.read().toString();
        assertTrue(saved.contains("SEMANTIC_RUNTIME_UNAVAILABLE"));
        assertFalse(saved.contains("private runtime detail"));
        assertFalse(saved.contains("\"events\""));
    }
    @Test public void workManagerUsesUniqueBestEffortPeriodicWorkAndCancels() throws Exception {
        WellnessWorker.schedule(context);
        WellnessWorker.schedule(context);
        WorkManager manager = WorkManager.getInstance(context);
        var scheduled = manager.getWorkInfosForUniqueWork(WellnessWorker.WORK_NAME).get(5, TimeUnit.SECONDS);
        assertEquals(1, scheduled.size());
        assertEquals(WorkInfo.State.ENQUEUED, scheduled.get(0).getState());
        assertNotNull(scheduled.get(0).getPeriodicityInfo());
        assertEquals(6L * 3600000, scheduled.get(0).getPeriodicityInfo().getRepeatIntervalMillis());
        TestDriver driver = WorkManagerTestInitHelper.getTestDriver(context);
        assertNotNull(driver);
        WellnessWorker.cancel(context);
        assertEquals(WorkInfo.State.CANCELLED, manager.getWorkInfosForUniqueWork(WellnessWorker.WORK_NAME)
            .get(5, TimeUnit.SECONDS).get(0).getState());
    }
    @Test public void checkpointContainsOnlyPrivacyAllowlistAndNoDeviceIdentifier() throws Exception {
        JSONObject cp = WellnessCheckpoint.capture(context, true, "GRANTED");
        assertEquals(7, cp.length());
        for (String key : new String[] { "captured_at", "screen_state", "keyguard_state", "usage_access", "consent", "boot_session_marker", "timezone" }) {
            assertTrue(cp.has(key));
        }
        assertFalse(cp.toString().matches(".*(packageName|activityName|android_id|serial|imei).*"));
    }
    @Test public void bootCounterDetectsPriorBootWithoutDeviceIdentity() throws Exception {
        android.provider.Settings.Global.putInt(context.getContentResolver(), android.provider.Settings.Global.BOOT_COUNT, 7);
        JSONObject first = WellnessCheckpoint.capture(context, true, "GRANTED");
        android.provider.Settings.Global.putInt(context.getContentResolver(), android.provider.Settings.Global.BOOT_COUNT, 8);
        JSONObject second = WellnessCheckpoint.capture(context, true, "GRANTED");
        assertEquals("boot:7", first.getString("boot_session_marker"));
        assertEquals("boot:8", second.getString("boot_session_marker"));
    }
    @Test public void lateAccessRevocationDiscardsCalculationAndCancelsWithoutDeletingPriorAggregates() throws Exception {
        enable();
        var source = new FakeDigitalWellnessEventSource();
        WellnessWorker.refresh(context, source, (ctx, input) -> {
            source.access = false;
            return input.getJSONObject("state").put("days", new JSONArray().put("must-not-save"));
        });
        JSONObject restarted = store.read();
        assertEquals(0, restarted.getJSONArray("days").length());
        assertEquals("ACCESS_DENIED", restarted.getJSONArray("ledger").getJSONObject(0).getString("event"));
    }
    @Test public void ownerChangeDuringRuntimeFailureCannotWriteErrorIntoNewOwner() throws Exception {
        enable();
        var source = new FakeDigitalWellnessEventSource();
        try {
            WellnessWorker.refresh(context, source, (ctx, input) -> {
                store.closeScope();
                throw new IllegalStateException("old owner failure");
            });
            fail("Expected failure");
        } catch (IllegalStateException expected) {
            assertTrue(store.read().isNull("error"));
            assertFalse(store.read().getBoolean("consent"));
        }
    }
    @Test public void outboxAndExplicitAckSurviveNativeStoreRestart() throws Exception {
        JSONObject state = store.read();
        String now = java.time.Instant.now().toString();
        state.getJSONArray("outbox").put(new JSONObject().put("scope", state.getString("scope"))
            .put("observation", new JSONObject().put("client_observation_id", "stable-id").put("client_queued_at", now))
            .put("ack", JSONObject.NULL).put("attempts", 1));
        store.save(state);
        JSONObject reopened = new WellnessStore(context).read();
        assertEquals("stable-id", reopened.getJSONArray("outbox").getJSONObject(0).getJSONObject("observation")
            .getString("client_observation_id"));
        reopened.getJSONArray("outbox").getJSONObject(0).put("ack", "DUPLICATE");
        store.save(reopened);
        assertEquals("DUPLICATE", new WellnessStore(context).read().getJSONArray("outbox").getJSONObject(0).getString("ack"));
    }
    @Test public void retentionPrunesExpiredClosedScopeDataIndependentlyOfRevocation() throws Exception {
        JSONObject state = store.read();
        String old = java.time.Instant.ofEpochMilli(System.currentTimeMillis() - 91L * 86400000).toString();
        state.getJSONArray("days").put(new JSONObject().put("local_date", "old").put("updated_at", old));
        state.getJSONArray("outbox").put(new JSONObject().put("observation", new JSONObject().put("client_queued_at", old)));
        store.save(state);
        assertEquals(0, new WellnessStore(context).read().getJSONArray("days").length());
        assertEquals(0, new WellnessStore(context).read().getJSONArray("outbox").length());
    }
    @Test public void revocationCannotOverwriteQualifiedOrDifferentTimezoneHistory() throws Exception {
        JSONObject state = store.read();
        String today = java.time.LocalDate.now().toString();
        JSONObject qualified = new JSONObject().put("local_date", today)
            .put("timezone", java.util.TimeZone.getDefault().getID()).put("coverage_state", "QUALIFIED")
            .put("screen_time_minutes", 30);
        JSONObject otherZone = new JSONObject().put("local_date", today).put("timezone", "Other/Zone")
            .put("coverage_state", "PARTIAL").put("screen_time_minutes", 15);
        state.getJSONArray("days").put(qualified).put(otherZone);
        WellnessStore.invalidateToday(state, "CONSENT_DISABLED");
        assertEquals(30, qualified.getInt("screen_time_minutes"));
        assertEquals("QUALIFIED", qualified.getString("coverage_state"));
        assertEquals(15, otherZone.getInt("screen_time_minutes"));
    }
}
