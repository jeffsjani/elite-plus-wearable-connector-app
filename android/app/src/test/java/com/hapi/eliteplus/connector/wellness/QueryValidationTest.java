package com.hapi.eliteplus.connector.wellness;

import org.junit.Test;
import static org.junit.Assert.*;

public class QueryValidationTest {
    private static final long HOUR = 60L * 60 * 1000;
    private static final long DAY = 24 * HOUR;
    // vc3 physical evidence: 24h query that native rejected as INVALID_QUERY.
    private static final long PHYSICAL_START = 1_792_164_044_638L;
    private static final long PHYSICAL_END = 1_792_250_444_638L;
    private static final long NOW = PHYSICAL_END;

    private static void accept(long start, long end, long now, long expectedEffectiveEnd) {
        var result = QueryValidation.validate(start, end, now);
        assertNull(result.ruleFailed);
        assertEquals(start, result.requestedStart);
        assertEquals(end, result.requestedEnd);
        assertEquals(expectedEffectiveEnd, result.effectiveEnd);
        var source = new FakeDigitalWellnessEventSource();
        DigitalWellnessQuery.execute(source, start, end, now);
        assertEquals(1, source.queries);
        assertEquals(start, source.lastStart);
        assertEquals(expectedEffectiveEnd, source.lastEnd);
    }

    private static void reject(long start, long end, long now, String rule) {
        assertEquals(rule, QueryValidation.validate(start, end, now).ruleFailed);
        var source = new FakeDigitalWellnessEventSource();
        var failure = assertThrows(DigitalWellnessQuery.Failure.class,
            () -> DigitalWellnessQuery.execute(source, start, end, now));
        assertEquals("INVALID_QUERY", failure.code);
        assertEquals("QUERY_EVENTS", failure.stage);
        assertEquals(0, source.queries);
    }

    @Test public void physicalVc3TwentyFourHourQueryReachesQueryEvents() {
        assertEquals(DAY, PHYSICAL_END - PHYSICAL_START);
        accept(PHYSICAL_START, PHYSICAL_END, NOW, PHYSICAL_END);
        accept(PHYSICAL_START, PHYSICAL_END, NOW + 250, PHYSICAL_END);
    }

    @Test public void physicalVc3BridgeLongValuesConvertUnchanged() {
        // org.json parses 13-digit JSON integers as Long; Capacitor getDouble() returned null for these.
        var start = QueryValidation.millis(Long.valueOf(PHYSICAL_START), true);
        var end = QueryValidation.millis(Long.valueOf(PHYSICAL_END), false);
        assertNull(start.rule);
        assertNull(end.rule);
        assertEquals(PHYSICAL_START, (long) start.value);
        assertEquals(PHYSICAL_END, (long) end.value);
    }

    @Test public void durationBounds() {
        accept(NOW - HOUR, NOW, NOW, NOW);
        accept(NOW - DAY, NOW, NOW, NOW);
        accept(NOW - DigitalWellnessQuery.MAX_INTERVAL_MS, NOW, NOW, NOW);
        reject(NOW - DigitalWellnessQuery.MAX_INTERVAL_MS - 1, NOW, NOW, QueryValidation.DURATION_EXCEEDS_MAX);
    }

    @Test public void durationBoundUsesRequestedEndEvenWhenClamped() {
        reject(NOW + 1 - DigitalWellnessQuery.MAX_INTERVAL_MS - 1, NOW + 1, NOW, QueryValidation.DURATION_EXCEEDS_MAX);
        accept(NOW + 1 - DigitalWellnessQuery.MAX_INTERVAL_MS, NOW + 1, NOW, NOW);
    }

    @Test public void clockSkewBoundary() {
        accept(NOW - DAY, NOW, NOW, NOW);
        accept(NOW - DAY, NOW + 1, NOW, NOW);
        accept(NOW - DAY, NOW + 1_000, NOW, NOW);
        accept(NOW - DAY, NOW + 5_000, NOW, NOW);
        reject(NOW - DAY, NOW + 5_001, NOW, QueryValidation.END_IN_FUTURE);
        reject(NOW - DAY, NOW + DAY, NOW, QueryValidation.END_IN_FUTURE);
        assertEquals(5_000L, QueryValidation.MAX_CLOCK_SKEW_MS);
    }

    @Test public void clockSkewDiagnostics() {
        var clamped = QueryValidation.validate(NOW - DAY, NOW + 1_000, NOW);
        assertEquals(NOW, clamped.nativeNow);
        assertEquals(NOW + 1_000, clamped.requestedEnd);
        assertEquals(NOW, clamped.effectiveEnd);
        assertEquals(DAY + 1_000, clamped.durationMs);
        assertEquals(DAY, clamped.lookbackMs);
        assertEquals(1_000, clamped.clockSkewMs);
        var behind = QueryValidation.validate(NOW - DAY, NOW - 30, NOW);
        assertEquals(-30, behind.clockSkewMs);
        assertEquals(NOW - 30, behind.effectiveEnd);
    }

    @Test public void historicalLookbackBoundary() {
        long sevenDaysAgo = NOW - DigitalWellnessQuery.MAX_HISTORY_MS;
        accept(sevenDaysAgo, sevenDaysAgo + HOUR, NOW, sevenDaysAgo + HOUR);
        reject(sevenDaysAgo - 1, sevenDaysAgo + HOUR, NOW, QueryValidation.LOOKBACK_EXCEEDS_MAX);
    }

    @Test public void orderingAndSign() {
        reject(NOW, NOW, NOW, QueryValidation.START_NOT_BEFORE_END);
        reject(NOW, NOW - 1, NOW, QueryValidation.START_NOT_BEFORE_END);
        reject(NOW + 2, NOW + 3, NOW, QueryValidation.START_NOT_BEFORE_END);
        reject(-1, NOW, NOW, QueryValidation.START_NEGATIVE);
        reject(0, -1, NOW, QueryValidation.END_NEGATIVE);
    }

    @Test public void numericConversion() {
        assertEquals(QueryValidation.START_NOT_FINITE, QueryValidation.millis(Double.NaN, true).rule);
        assertEquals(QueryValidation.END_NOT_FINITE, QueryValidation.millis(Double.NaN, false).rule);
        assertEquals(QueryValidation.START_NOT_FINITE, QueryValidation.millis(Double.POSITIVE_INFINITY, true).rule);
        assertEquals(QueryValidation.END_NOT_FINITE, QueryValidation.millis(Double.NEGATIVE_INFINITY, false).rule);
        assertEquals(QueryValidation.START_NOT_FINITE, QueryValidation.millis(Float.NaN, true).rule);
        assertEquals(QueryValidation.START_MISSING, QueryValidation.millis(null, true).rule);
        assertEquals(QueryValidation.END_MISSING, QueryValidation.millis(null, false).rule);
        assertEquals(QueryValidation.START_NOT_NUMERIC, QueryValidation.millis("1792164044638", true).rule);
        assertEquals(QueryValidation.END_NOT_INTEGER_MS, QueryValidation.millis(1.5d, false).rule);
        assertEquals(QueryValidation.END_OUT_OF_RANGE, QueryValidation.millis(9_007_199_254_740_992L, false).rule);
        assertEquals(QueryValidation.START_OUT_OF_RANGE, QueryValidation.millis(1e300, true).rule);
        assertEquals(PHYSICAL_END, (long) QueryValidation.millis((double) PHYSICAL_END, false).value);
        assertEquals(1_000L, (long) QueryValidation.millis(1_000, true).value);
        assertEquals(9_007_199_254_740_991L, (long) QueryValidation.millis(9_007_199_254_740_991L, true).value);
    }
}
