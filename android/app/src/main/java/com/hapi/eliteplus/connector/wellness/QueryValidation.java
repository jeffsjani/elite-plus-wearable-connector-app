package com.hapi.eliteplus.connector.wellness;

public final class QueryValidation {
    public static final long MAX_CLOCK_SKEW_MS = 5_000L;
    static final double MAX_SAFE_INTEGER = 9_007_199_254_740_991d;

    public static final String START_MISSING = "START_MISSING";
    public static final String END_MISSING = "END_MISSING";
    public static final String START_NOT_NUMERIC = "START_NOT_NUMERIC";
    public static final String END_NOT_NUMERIC = "END_NOT_NUMERIC";
    public static final String START_NOT_FINITE = "START_NOT_FINITE";
    public static final String END_NOT_FINITE = "END_NOT_FINITE";
    public static final String START_NOT_INTEGER_MS = "START_NOT_INTEGER_MS";
    public static final String END_NOT_INTEGER_MS = "END_NOT_INTEGER_MS";
    public static final String START_OUT_OF_RANGE = "START_OUT_OF_RANGE";
    public static final String END_OUT_OF_RANGE = "END_OUT_OF_RANGE";
    public static final String START_NEGATIVE = "START_NEGATIVE";
    public static final String END_NEGATIVE = "END_NEGATIVE";
    public static final String START_NOT_BEFORE_END = "START_NOT_BEFORE_END";
    public static final String END_IN_FUTURE = "END_IN_FUTURE";
    public static final String DURATION_EXCEEDS_MAX = "DURATION_EXCEEDS_MAX";
    public static final String LOOKBACK_EXCEEDS_MAX = "LOOKBACK_EXCEEDS_MAX";

    public static final class Millis {
        public final Long value;
        public final String rule;
        private Millis(Long value, String rule) { this.value = value; this.rule = rule; }
    }

    /** Converts a bridge value to epoch milliseconds; org.json yields Long for 13-digit integers. */
    public static Millis millis(Object raw, boolean start) {
        if (raw == null) return new Millis(null, start ? START_MISSING : END_MISSING);
        if (raw instanceof Integer || raw instanceof Long || raw instanceof Short || raw instanceof Byte) {
            long value = ((Number) raw).longValue();
            if (Math.abs((double) value) > MAX_SAFE_INTEGER) return new Millis(null, start ? START_OUT_OF_RANGE : END_OUT_OF_RANGE);
            return new Millis(value, null);
        }
        if (!(raw instanceof Double || raw instanceof Float)) {
            return new Millis(null, start ? START_NOT_NUMERIC : END_NOT_NUMERIC);
        }
        double value = ((Number) raw).doubleValue();
        if (!Double.isFinite(value)) return new Millis(null, start ? START_NOT_FINITE : END_NOT_FINITE);
        if (value != Math.floor(value)) return new Millis(null, start ? START_NOT_INTEGER_MS : END_NOT_INTEGER_MS);
        if (Math.abs(value) > MAX_SAFE_INTEGER) return new Millis(null, start ? START_OUT_OF_RANGE : END_OUT_OF_RANGE);
        return new Millis((long) value, null);
    }

    public static final class Result {
        public final String ruleFailed;
        public final long nativeNow;
        public final long requestedStart;
        public final long requestedEnd;
        public final long effectiveEnd;
        public final long durationMs;
        public final long lookbackMs;
        public final long clockSkewMs;

        Result(String ruleFailed, long nativeNow, long start, long end, long effectiveEnd) {
            this.ruleFailed = ruleFailed;
            this.nativeNow = nativeNow;
            this.requestedStart = start;
            this.requestedEnd = end;
            this.effectiveEnd = effectiveEnd;
            this.durationMs = end - start;
            this.lookbackMs = nativeNow - start;
            this.clockSkewMs = end - nativeNow;
        }

        public boolean accepted() { return ruleFailed == null; }
    }

    /**
     * An end up to MAX_CLOCK_SKEW_MS after native now is a legitimate "through now" request whose
     * WebView clock read slightly ahead; it is clamped to native now. Bounds use the requested interval.
     */
    public static Result validate(long start, long end, long nativeNow) {
        long effectiveEnd = end > nativeNow && end - nativeNow <= MAX_CLOCK_SKEW_MS ? nativeNow : end;
        return new Result(rule(start, end, effectiveEnd, nativeNow), nativeNow, start, end, effectiveEnd);
    }

    private static String rule(long start, long end, long effectiveEnd, long nativeNow) {
        if (start < 0) return START_NEGATIVE;
        if (end < 0) return END_NEGATIVE;
        if (start >= end || start >= effectiveEnd) return START_NOT_BEFORE_END;
        if (effectiveEnd > nativeNow) return END_IN_FUTURE;
        if (end - start > DigitalWellnessQuery.MAX_INTERVAL_MS) return DURATION_EXCEEDS_MAX;
        if (start < nativeNow - DigitalWellnessQuery.MAX_HISTORY_MS) return LOOKBACK_EXCEEDS_MAX;
        return null;
    }

    private QueryValidation() {}
}
