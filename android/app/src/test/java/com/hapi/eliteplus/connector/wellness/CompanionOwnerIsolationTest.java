package com.hapi.eliteplus.connector.wellness;

import static org.junit.Assert.*;
import android.content.Context;
import android.database.sqlite.SQLiteDatabase;
import androidx.work.testing.WorkManagerTestInitHelper;
import org.json.JSONObject;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class CompanionOwnerIsolationTest {
    private Context context;
    private WellnessStore store;

    @Before public void setup() {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE).edit().clear().commit();
        WorkManagerTestInitHelper.initializeTestWorkManager(context);
        store = new WellnessStore(context);
    }

    @Test public void signedOutCannotConsentAndPreviewIsNeverAdopted() throws Exception {
        assertThrows(IllegalStateException.class, () -> WellnessConsent.apply(context, true));
        context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE).edit()
            .putString("scope_preview", store.read().put("scope", "preview").put("consent", true).toString()).commit();
        JSONObject state = store.bindOwner("connector-user-a");
        assertEquals("AUTHENTICATED", state.getString("owner_kind"));
        assertFalse(state.getBoolean("consent"));
        assertEquals(0, state.getJSONArray("days").length());
    }

    @Test public void sameOwnerRestartRetainsConsentButTransitionClosesOldGeneration() throws Exception {
        String scope = store.bindOwner("connector-user-a").getString("scope");
        WellnessConsent.apply(context, true);
        JSONObject restarted = new WellnessStore(context).bindOwner("connector-user-a");
        assertTrue(restarted.getBoolean("consent"));
        assertEquals(scope, restarted.getString("scope"));
        JSONObject next = store.bindOwner("connector-user-b");
        assertFalse(next.getBoolean("consent"));
        assertEquals(0, next.getJSONArray("checkpoints").length());
        assertThrows(IllegalStateException.class, () -> store.requireScope(scope));
        String old = context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE)
            .getString("scope_" + scope, null);
        assertNotNull(old);
        assertFalse(new JSONObject(old).getBoolean("consent"));
    }

    @Test public void ownerTransitionDuringRuntimeDiscardsOldDaysAndOutbox() throws Exception {
        String oldScope = store.bindOwner("connector-user-a").getString("scope");
        WellnessConsent.apply(context, true);
        WellnessWorker.refresh(context, new FakeDigitalWellnessEventSource(), (ctx, input) -> {
            store.bindOwner("connector-user-b");
            return input.getJSONObject("state").put("error", "MUST_NOT_CROSS_OWNER");
        }, oldScope);
        assertFalse(store.read().getBoolean("consent"));
        assertTrue(store.read().isNull("error"));
        assertEquals(0, store.read().getJSONArray("days").length());
        assertEquals(0, store.read().getJSONArray("outbox").length());
        assertThrows(IllegalStateException.class, () -> WellnessWorker.refresh(context,
            new FakeDigitalWellnessEventSource(), (ctx, input) -> input, oldScope));
    }

    @Test public void wellnessNeverTouchesExistingQueueOrJournalDatabases() throws Exception {
        String[] databases = { "elite_plus_connectorSQLite.db", "jcvital-source-envelope-v1.db" };
        for (String name : databases) {
            try (SQLiteDatabase db = context.openOrCreateDatabase(name, Context.MODE_PRIVATE, null)) {
                db.execSQL("CREATE TABLE retained_evidence(id INTEGER PRIMARY KEY, payload TEXT NOT NULL)");
                db.execSQL("INSERT INTO retained_evidence VALUES(1, 'physical-evidence-sentinel')");
                db.setVersion(name.startsWith("elite") ? 8 : 1);
            }
        }
        store.bindOwner("connector-user-a");
        WellnessConsent.apply(context, true);
        WellnessWorker.refresh(context, new FakeDigitalWellnessEventSource(),
            (ctx, input) -> input.getJSONObject("state"));
        WellnessConsent.apply(context, false);
        store.closeScope();
        for (String name : databases) {
            try (SQLiteDatabase db = SQLiteDatabase.openDatabase(context.getDatabasePath(name).getPath(), null,
                     SQLiteDatabase.OPEN_READONLY);
                 android.database.Cursor row = db.rawQuery("SELECT payload FROM retained_evidence ORDER BY id", null)) {
                assertEquals(name.startsWith("elite") ? 8 : 1, db.getVersion());
                assertEquals(1, row.getCount());
                assertTrue(row.moveToFirst());
                assertEquals("physical-evidence-sentinel", row.getString(0));
            }
        }
    }

    @Test @Config(sdk = 24) public void olderConnectorAndroidDoesNotLoadUsageOrSandboxApis() {
        AndroidUsageStatsEventSource source = new AndroidUsageStatsEventSource(context);
        assertFalse(source.isAvailable());
        assertFalse(source.hasAccess());
        assertThrows(IllegalStateException.class, () -> WellnessConsent.apply(context, true));
        assertThrows(IllegalStateException.class, () -> WellnessRuntime.evaluate(context, new JSONObject()));
    }
}
