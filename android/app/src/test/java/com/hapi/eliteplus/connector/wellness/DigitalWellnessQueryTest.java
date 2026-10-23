package com.hapi.eliteplus.connector.wellness;

import org.junit.Test;
import java.util.List;
import java.util.Arrays;
import static org.junit.Assert.*;

public class DigitalWellnessQueryTest {
    private static final long NOW = 1_780_000_000_000L;
    private final FakeDigitalWellnessEventSource source = new FakeDigitalWellnessEventSource();
    private List<DigitalWellnessEventSource.Event> query() {
        return DigitalWellnessQuery.execute(source, NOW - 1000, NOW, NOW);
    }
    private void fails(String code, Runnable action) {
        assertEquals(code, assertThrows(DigitalWellnessQuery.Failure.class, action::run).code);
    }
    @Test public void noUsageAccess() {
        source.access = false;
        fails("USAGE_ACCESS_DENIED", this::query);
        assertEquals(0, source.queries);
    }
    @Test public void unavailable() {
        source.available = false;
        fails("USAGE_STATS_UNAVAILABLE", this::query);
    }
    @Test public void emptyAuthorizedResult() {
        assertTrue(query().isEmpty());
        assertEquals(1, source.queries);
    }
    @Test public void invalidIntervals() {
        fails("INVALID_QUERY", () -> DigitalWellnessQuery.execute(source, NOW, NOW, NOW));
        fails("INVALID_QUERY", () -> DigitalWellnessQuery.execute(source, NOW, NOW - 1, NOW));
        fails("INVALID_QUERY", () -> DigitalWellnessQuery.execute(source, -1, NOW, NOW));
        fails("INVALID_QUERY", () -> DigitalWellnessQuery.execute(source, NOW - 1000,
            NOW + QueryValidation.MAX_CLOCK_SKEW_MS + 1, NOW));
        assertEquals(0, source.queries);
    }
    @Test public void boundedHistoryAndDuration() {
        fails("INVALID_QUERY", () -> DigitalWellnessQuery.execute(source,
            NOW - DigitalWellnessQuery.MAX_INTERVAL_MS - 1, NOW, NOW));
        fails("INVALID_QUERY", () -> DigitalWellnessQuery.execute(source,
            NOW - DigitalWellnessQuery.MAX_HISTORY_MS - 1, NOW - DigitalWellnessQuery.MAX_HISTORY_MS, NOW));
        assertTrue(DigitalWellnessQuery.execute(source, NOW - DigitalWellnessQuery.MAX_INTERVAL_MS, NOW, NOW).isEmpty());
    }
    @Test public void supportedFilteringOrderingAndDeduplication() {
        var first = new DigitalWellnessEventSource.Event("KEYGUARD_SHOWN", NOW - 900);
        var second = new DigitalWellnessEventSource.Event("SCREEN_INTERACTIVE", NOW - 800);
        var third = new DigitalWellnessEventSource.Event("KEYGUARD_HIDDEN", NOW - 700);
        var fourth = new DigitalWellnessEventSource.Event("SCREEN_NON_INTERACTIVE", NOW - 600);
        source.events = List.of(fourth, second, first, third, second,
            new DigitalWellnessEventSource.Event("ACTIVITY_RESUMED", NOW - 500),
            new DigitalWellnessEventSource.Event("SCREEN_INTERACTIVE", NOW));
        assertEquals(List.of(first, second, third, fourth), query());
    }
    @Test public void detailedResultReportsOnlySupportedEventCountsAndDeduplication() {
        var event = new DigitalWellnessEventSource.Event("SCREEN_INTERACTIVE", NOW - 800);
        source.events = List.of(event, event,
            new DigitalWellnessEventSource.Event("KEYGUARD_HIDDEN", NOW - 700),
            new DigitalWellnessEventSource.Event("ACTIVITY_RESUMED", NOW - 600));
        var result = DigitalWellnessQuery.executeDetailed(source, NOW - 1000, NOW, NOW);
        assertEquals(3, result.totalSupportedEvents);
        assertEquals(1, result.deduplicatedCount);
        assertEquals(2, result.events.size());
        assertEquals(1, (int) result.eventCounts.get("SCREEN_INTERACTIVE"));
        assertEquals(1, (int) result.eventCounts.get("KEYGUARD_HIDDEN"));
    }
    @Test public void outputCannotContainIdentity() {
        assertEquals(List.of("eventType", "timestamp"), Arrays.stream(
            DigitalWellnessEventSource.Event.class.getRecordComponents()).map(c -> c.getName()).toList());
    }
    @Test public void bridgeExportsOnlyAllowlistedMethodsIncludingInheritedSurface() {
        assertEquals(List.of("bindAuthenticatedOwner", "clearAuthenticatedOwner", "closeProductionScope", "getPlatformInfo", "getProductionState",
            "hasUsageAccess", "isUsageAccessAvailable", "openUsageAccessSettings",
            "queryDigitalWellnessEvents", "refreshProduction", "setProductionConsent"), Arrays.stream(EliteDigitalWellnessPlugin.class.getMethods())
            .filter(method -> method.isAnnotationPresent(com.getcapacitor.PluginMethod.class))
            .map(method -> method.getName()).sorted().toList());
    }
    @Test public void androidEventClassFilter() {
        assertEquals("SCREEN_INTERACTIVE", AndroidUsageStatsEventSource.minimize(15, NOW).eventType());
        assertEquals("SCREEN_NON_INTERACTIVE", AndroidUsageStatsEventSource.minimize(16, NOW).eventType());
        assertEquals("KEYGUARD_SHOWN", AndroidUsageStatsEventSource.minimize(17, NOW).eventType());
        assertEquals("KEYGUARD_HIDDEN", AndroidUsageStatsEventSource.minimize(18, NOW).eventType());
        for (int eventType : new int[] { 0, 1, 2, 5, 7, 10, 19, 23, 26, 27, 28, 31 }) {
            assertNull(AndroidUsageStatsEventSource.minimize(eventType, NOW));
        }
    }
    @Test public void eventLimit() {
        source.events = java.util.Collections.nCopies(DigitalWellnessQuery.MAX_EVENTS + 1,
            new DigitalWellnessEventSource.Event("SCREEN_INTERACTIVE", NOW - 1));
        fails("EVENT_LIMIT_EXCEEDED", this::query);
    }
    @Test public void apiFailure() {
        source.failure = new IllegalStateException("private vendor detail");
        fails("QUERY_FAILED", this::query);
    }
    @Test public void securityFailure() {
        source.failure = new SecurityException();
        fails("SECURITY_EXCEPTION", this::query);
    }
    @Test public void revokedDuringQuery() {
        source.revokeDuringQuery = true;
        fails("USAGE_ACCESS_DENIED", this::query);
    }
}
