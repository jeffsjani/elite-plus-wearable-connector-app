package com.hapi.eliteplus.connector.wellness;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.work.WorkInfo;
import androidx.work.WorkManager;
import androidx.work.testing.WorkManagerTestInitHelper;
import java.util.List;
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
public class WellnessConsentTest {
    private Context context;

    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE).edit().clear().commit();
        WorkManagerTestInitHelper.initializeTestWorkManager(context);
        new WellnessStore(context).bindOwner("authenticated-test-user");
    }

    private WorkInfo.State workState() throws Exception {
        List<WorkInfo> infos = WorkManager.getInstance(context).getWorkInfosForUniqueWork(WellnessWorker.WORK_NAME).get();
        return infos.isEmpty() ? null : infos.get(0).getState();
    }

    @Test public void enableReturnsPersistedConsentAndSchedulesWorker() throws Exception {
        JSONObject returned = WellnessConsent.apply(context, true);
        assertTrue(returned.getBoolean("consent"));
        assertTrue(new WellnessStore(context).read().getBoolean("consent"));
        assertEquals(WorkInfo.State.ENQUEUED, workState());
        JSONArray ledger = returned.getJSONArray("ledger");
        assertEquals("CONSENT_ENABLED", ledger.getJSONObject(ledger.length() - 1).getString("event"));
    }

    @Test public void consentSurvivesProcessRestart() throws Exception {
        WellnessConsent.apply(context, true);
        // A fresh store instance reads only SharedPreferences, as after a process restart.
        assertTrue(new WellnessStore(context).read().getBoolean("consent"));
    }

    @Test public void enableClearsStaleRefreshErrorFromEarlierGeneration() throws Exception {
        WellnessStore store = new WellnessStore(context);
        store.save(store.read().put("error", "STALE_PRIOR_GENERATION_ERROR"));
        // The test WorkManager may run the scheduled worker immediately; only the stale error must be gone.
        assertNotEquals("STALE_PRIOR_GENERATION_ERROR", WellnessConsent.apply(context, true).optString("error"));
    }

    @Test public void disableCancelsWorkerAndRetainsHistoricalAggregates() throws Exception {
        WellnessConsent.apply(context, true);
        WellnessStore store = new WellnessStore(context);
        JSONObject state = store.read();
        state.getJSONArray("days").put(new JSONObject().put("local_date", "2000-01-01").put("timezone", "UTC")
            .put("coverage_state", "QUALIFIED").put("updated_at", java.time.Instant.now().toString())
            .put("quality_reasons", new JSONArray()));
        store.save(state);
        JSONObject returned = WellnessConsent.apply(context, false);
        assertFalse(returned.getBoolean("consent"));
        assertFalse(new WellnessStore(context).read().getBoolean("consent"));
        assertEquals(WorkInfo.State.CANCELLED, workState());
        assertEquals(1, returned.getJSONArray("days").length());
        assertEquals("QUALIFIED", returned.getJSONArray("days").getJSONObject(0).getString("coverage_state"));
    }
}
