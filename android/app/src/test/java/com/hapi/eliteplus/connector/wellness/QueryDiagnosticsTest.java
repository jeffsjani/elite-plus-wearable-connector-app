package com.hapi.eliteplus.connector.wellness;

import org.junit.Test;
import static org.junit.Assert.*;

public class QueryDiagnosticsTest {
    private static final long END = 1_780_000_000_000L;
    private static final String PRIVATE = "com.private.app Activity https://private.example user content\n at raw.stack.Trace";

    private static final class Platform implements AndroidUsageStatsEventSource.Platform {
        Integer mode = 0;
        boolean service = true;
        boolean populated;
        boolean nullResult;
        RuntimeException queryFailure;
        RuntimeException iterationFailure;
        long start;
        long end;
        int api = 36;
        public boolean serviceAvailable() { return service; }
        public boolean userUnlocked() { return true; }
        public Integer appOpsMode() { return mode; }
        public int apiLevel() { return api; }
        public AndroidUsageStatsEventSource.Cursor query(long start, long end) {
            this.start = start;
            this.end = end;
            if (queryFailure != null) throw queryFailure;
            if (nullResult) return null;
            return new AndroidUsageStatsEventSource.Cursor() {
                boolean consumed;
                public boolean hasNext() {
                    if (iterationFailure != null) throw iterationFailure;
                    return populated && !consumed;
                }
                public void next() { consumed = true; }
                public int type() { return 15; }
                public long timestamp() { return END - 1; }
            };
        }
    }

    private DigitalWellnessQuery.Failure failure(Platform platform, String code, String stage) {
        var diagnostics = new QueryDiagnostics(END - 1000, END);
        var failure = assertThrows(DigitalWellnessQuery.Failure.class, () ->
            DigitalWellnessQuery.executeDetailed(new AndroidUsageStatsEventSource(platform),
                END - 1000, END, END, diagnostics));
        assertEquals(code, failure.code);
        assertEquals(stage, failure.stage);
        assertFalse(QueryDiagnostics.message(failure.code).contains(PRIVATE));
        assertFalse(failure.exceptionClass.contains("private"));
        assertNull(failure.getCause());
        assertEquals(Integer.valueOf(platform.api), diagnostics.api);
        return failure;
    }

    @Test public void deniedUnknownAndDefaultFailClosedAcrossSupportedApis() {
        for (int api = 29; api <= 36; api++) {
            for (Integer mode : new Integer[] { null, 1, 2, 3, 4 }) {
                var platform = new Platform();
                platform.api = api;
                platform.mode = mode;
                failure(platform, "USAGE_ACCESS_DENIED", "ACCESS_CHECK");
                assertEquals(0, platform.start);
            }
        }
    }
    @Test public void nullService() {
        var platform = new Platform();
        platform.service = false;
        failure(platform, "USAGE_STATS_UNAVAILABLE", "SERVICE_LOOKUP");
    }
    @Test public void securityExceptionIsNotGeneric() {
        var platform = new Platform();
        platform.queryFailure = new SecurityException(PRIVATE);
        assertEquals("java.lang.SecurityException",
            failure(platform, "SECURITY_EXCEPTION", "QUERY_EVENTS").exceptionClass);
    }
    @Test public void queryNull() {
        var platform = new Platform();
        platform.nullResult = true;
        failure(platform, "QUERY_RETURNED_NULL", "QUERY_EVENTS");
    }
    @Test public void nativeInvalidQueryIsDistinct() {
        var platform = new Platform();
        platform.queryFailure = new IllegalArgumentException(PRIVATE);
        assertEquals("java.lang.IllegalArgumentException",
            failure(platform, "INVALID_QUERY", "QUERY_EVENTS").exceptionClass);
    }
    @Test public void iteratorFailureIsSanitized() {
        var platform = new Platform();
        platform.iterationFailure = new IllegalStateException(PRIVATE);
        assertEquals("java.lang.IllegalStateException",
            failure(platform, "QUERY_ITERATION_FAILED", "EVENT_ITERATION").exceptionClass);
    }
    @Test public void iteratorSecurityExceptionIsNotGeneric() {
        var platform = new Platform();
        platform.iterationFailure = new SecurityException(PRIVATE);
        failure(platform, "SECURITY_EXCEPTION", "EVENT_ITERATION");
    }
    @Test public void emptyAndPopulatedUseUnchangedEpochMilliseconds() {
        for (boolean populated : new boolean[] { false, true }) {
            var platform = new Platform();
            platform.populated = populated;
            var result = DigitalWellnessQuery.executeDetailed(new AndroidUsageStatsEventSource(platform),
                END - 1000, END, END);
            assertEquals(populated ? 1 : 0, result.events.size());
            assertEquals(END - 1000, platform.start);
            assertEquals(END, platform.end);
            if (populated) assertEquals(END - 1, result.events.get(0).timestamp());
        }
    }
    @Test public void vendorExceptionClassIsNeverExposed() {
        class PrivateVendorException extends RuntimeException {}
        assertEquals("java.lang.RuntimeException", QueryDiagnostics.exceptionClass(new PrivateVendorException()));
    }
}
