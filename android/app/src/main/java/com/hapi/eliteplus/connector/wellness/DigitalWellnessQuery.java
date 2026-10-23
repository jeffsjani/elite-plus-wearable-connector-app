package com.hapi.eliteplus.connector.wellness;

import java.util.Comparator;
import java.util.List;
import java.util.Set;
import java.util.HashSet;
import java.util.Arrays;
import java.util.stream.Collectors;

public final class DigitalWellnessQuery {
    public static final long MAX_INTERVAL_MS = 48L * 60 * 60 * 1000;
    public static final long MAX_HISTORY_MS = 7L * 24 * 60 * 60 * 1000;
    public static final int MAX_EVENTS = 50_000;
    private static final Set<String> SUPPORTED = new HashSet<>(Arrays.asList(
        "SCREEN_INTERACTIVE", "SCREEN_NON_INTERACTIVE", "KEYGUARD_SHOWN", "KEYGUARD_HIDDEN"));

    public static final class Failure extends RuntimeException {
        public final String code;
        public final String stage;
        public final String exceptionClass;
        Failure(String code) { this(code, "UNKNOWN", null); }
        Failure(String code, String stage, RuntimeException cause) {
            super(code);
            this.code = code;
            this.stage = stage;
            this.exceptionClass = QueryDiagnostics.exceptionClass(cause);
        }
    }

    public static List<DigitalWellnessEventSource.Event> execute(
            DigitalWellnessEventSource source, long start, long end, long now) {
        return executeDetailed(source, start, end, now).events;
    }

    public static final class Result {
        public final List<DigitalWellnessEventSource.Event> events;
        public final int totalSupportedEvents;
        public final int deduplicatedCount;
        public final java.util.Map<String, Integer> eventCounts;

        Result(List<DigitalWellnessEventSource.Event> events, int totalSupportedEvents,
                int deduplicatedCount, java.util.Map<String, Integer> eventCounts) {
            this.events = events;
            this.totalSupportedEvents = totalSupportedEvents;
            this.deduplicatedCount = deduplicatedCount;
            this.eventCounts = eventCounts;
        }
    }

    public static Result executeDetailed(
            DigitalWellnessEventSource source, long start, long end, long now) {
        return executeDetailed(source, start, end, now, new QueryDiagnostics(start, end));
    }

    static Result executeDetailed(DigitalWellnessEventSource source, long start, long end,
            long now, QueryDiagnostics diagnostics) {
        try {
            return run(source, start, end, now, diagnostics);
        } catch (Failure failure) {
            throw failure;
        } catch (SecurityException failure) {
            throw new Failure("SECURITY_EXCEPTION", diagnostics.stage, failure);
        } catch (RuntimeException failure) {
            throw new Failure("SEMANTIC_PROCESSING".equals(diagnostics.stage)
                ? "SEMANTIC_PROCESSING_FAILED" : "QUERY_FAILED", diagnostics.stage, failure);
        } finally {
            source.describe(diagnostics);
        }
    }

    private static Result run(DigitalWellnessEventSource source, long start, long requestedEnd,
            long now, QueryDiagnostics diagnostics) {
        diagnostics.stage = "QUERY_EVENTS";
        QueryValidation.Result validation = QueryValidation.validate(start, requestedEnd, now);
        diagnostics.validation = validation;
        if (!validation.accepted()) throw new Failure("INVALID_QUERY", diagnostics.stage, null);
        final long end = validation.effectiveEnd;
        diagnostics.stage = "SERVICE_LOOKUP";
        if (!source.isAvailable()) throw new Failure("USAGE_STATS_UNAVAILABLE", diagnostics.stage, null);
        diagnostics.stage = "ACCESS_CHECK";
        diagnostics.access = source.hasAccess();
        if (!diagnostics.access) throw new Failure("USAGE_ACCESS_DENIED", diagnostics.stage, null);
        diagnostics.stage = "QUERY_EVENTS";
        final List<DigitalWellnessEventSource.Event> events;
        try {
            events = source.query(start, end);
        } catch (Failure failure) {
            throw failure;
        } catch (SecurityException failure) {
            throw new Failure("SECURITY_EXCEPTION", diagnostics.stage, failure);
        } catch (IllegalArgumentException failure) {
            throw new Failure("INVALID_QUERY", diagnostics.stage, failure);
        } catch (RuntimeException failure) {
            throw new Failure("QUERY_FAILED", diagnostics.stage, failure);
        }
        diagnostics.stage = "ACCESS_CHECK";
        if (!source.hasAccess()) throw new Failure("USAGE_ACCESS_DENIED", diagnostics.stage, null);
        diagnostics.stage = "QUERY_EVENTS";
        if (events == null) throw new Failure("QUERY_RETURNED_NULL", diagnostics.stage, null);
        diagnostics.stage = "SEMANTIC_PROCESSING";
        if (events.size() > MAX_EVENTS) throw new Failure("EVENT_LIMIT_EXCEEDED", diagnostics.stage, null);
        List<DigitalWellnessEventSource.Event> supported = events.stream()
            .filter(event -> SUPPORTED.contains(event.eventType()))
            .filter(event -> event.timestamp() >= start && event.timestamp() < end)
            .collect(Collectors.toList());
        List<DigitalWellnessEventSource.Event> unique = supported.stream()
            .distinct()
            .sorted(Comparator.comparingLong(DigitalWellnessEventSource.Event::timestamp))
            .collect(Collectors.toList());
        java.util.Map<String, Integer> counts = new java.util.LinkedHashMap<>();
        for (String type : SUPPORTED) {
            counts.put(type, (int) unique.stream().filter(event -> type.equals(event.eventType())).count());
        }
        return new Result(unique, supported.size(), supported.size() - unique.size(), counts);
    }

    private DigitalWellnessQuery() {}
}
