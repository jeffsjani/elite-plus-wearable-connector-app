package com.hapi.eliteplus.connector.wellness;

import static org.junit.Assert.*;
import android.content.Context;
import androidx.work.testing.WorkManagerTestInitHelper;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.RuntimeEnvironment;
import org.robolectric.annotation.Config;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class WellnessStoreLockTest {
    private Context context;
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    @Before public void setup() throws Exception {
        context = RuntimeEnvironment.getApplication();
        context.getSharedPreferences("digital_wellness_production_v1", Context.MODE_PRIVATE).edit().clear().commit();
        WorkManagerTestInitHelper.initializeTestWorkManager(context);
        WellnessStore store = new WellnessStore(context);
        store.bindOwner("authenticated-test-user");
        store.save(store.read().put("consent", true).put("enabled_at", "2026-01-01T12:00:00Z"));
    }
    @After public void teardown() { worker.shutdownNow(); }

    private Future<?> holdStore(CountDownLatch held, CountDownLatch release) {
        return worker.submit(() -> {
            WellnessStore.LOCK.lock();
            try { held.countDown(); release.await(10, TimeUnit.SECONDS); }
            catch (InterruptedException ignored) { Thread.currentThread().interrupt(); }
            finally { WellnessStore.LOCK.unlock(); }
        });
    }

    @Test public void foregroundReadReturnsBusyWhileWorkerHoldsStore() throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Future<?> holder = holdStore(held, release);
        assertTrue(held.await(5, TimeUnit.SECONDS));
        long started = System.nanoTime();
        assertThrows(WellnessStore.Busy.class, () -> WellnessStore.tryLocked(100, () -> new WellnessStore(context).read()));
        assertTrue(TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started) < 2_000);
        release.countDown();
        holder.get(5, TimeUnit.SECONDS);
        assertTrue(WellnessStore.tryLocked(100, () -> new WellnessStore(context).read()).getBoolean("consent"));
    }

    @Test public void nativeAccessProbeNeverTouchesTheStoreLock() throws Exception {
        CountDownLatch held = new CountDownLatch(1);
        CountDownLatch release = new CountDownLatch(1);
        Future<?> holder = holdStore(held, release);
        assertTrue(held.await(5, TimeUnit.SECONDS));
        var source = new AndroidUsageStatsEventSource(new AndroidUsageStatsEventSource.Platform() {
            public boolean serviceAvailable() { return true; }
            public boolean userUnlocked() { return true; }
            public Integer appOpsMode() { return android.app.AppOpsManager.MODE_ALLOWED; }
            public int apiLevel() { return 35; }
            public AndroidUsageStatsEventSource.Cursor query(long start, long end) { throw new AssertionError("no query"); }
        });
        assertTrue(source.hasAccess());
        release.countDown();
        holder.get(5, TimeUnit.SECONDS);
    }

    @Test public void workerDoesNotHoldStoreDuringSemanticRuntime() throws Exception {
        CountDownLatch inRuntime = new CountDownLatch(1);
        CountDownLatch finish = new CountDownLatch(1);
        Future<JSONObject> refresh = worker.submit(() -> WellnessWorker.refresh(context, new FakeDigitalWellnessEventSource(),
            (ctx, input) -> { inRuntime.countDown(); finish.await(10, TimeUnit.SECONDS); return input.getJSONObject("state"); }));
        assertTrue(inRuntime.await(5, TimeUnit.SECONDS));
        // Foreground production-state read succeeds while the background refresh is mid-evaluation.
        assertTrue(WellnessStore.tryLocked(100, () -> new WellnessStore(context).read()).getBoolean("consent"));
        finish.countDown();
        assertNotNull(refresh.get(5, TimeUnit.SECONDS));
        assertFalse(WellnessStore.LOCK.isLocked());
    }
}
