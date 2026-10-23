package com.hapi.eliteplus.connector.wellness;

import com.getcapacitor.JSObject;
import org.json.JSONObject;

final class QueryDiagnostics {
    String stage = "UNKNOWN";
    Boolean access;
    Boolean service;
    Integer appOpsMode;
    String appOpsBranch = "UNKNOWN";
    Integer api;
    final Long start;
    final Long end;
    QueryValidation.Result validation;
    String inputRuleFailed;

    QueryDiagnostics(Long start, Long end) {
        this.start = start;
        this.end = end;
    }

    static String exceptionClass(RuntimeException failure) {
        if (failure == null) return "NONE";
        if (failure instanceof SecurityException) return "java.lang.SecurityException";
        if (failure instanceof IllegalArgumentException) return "java.lang.IllegalArgumentException";
        if (failure instanceof IllegalStateException) return "java.lang.IllegalStateException";
        if (failure instanceof NullPointerException) return "java.lang.NullPointerException";
        return "java.lang.RuntimeException";
    }

    static String message(String code) {
        return switch (code) {
            case "USAGE_ACCESS_DENIED" -> "Usage Access was not allowed by AppOps.";
            case "USAGE_STATS_UNAVAILABLE" -> "Usage Stats service or unlocked user is unavailable.";
            case "SECURITY_EXCEPTION" -> "Android rejected the operation for security reasons.";
            case "INVALID_QUERY" -> "Query interval is invalid or outside the allowed bounds.";
            case "QUERY_RETURNED_NULL" -> "Android returned no UsageEvents object.";
            case "QUERY_ITERATION_FAILED" -> "UsageEvents iteration failed.";
            case "BRIDGE_FAILURE" -> "Native bridge serialization or response validation failed.";
            case "EVENT_LIMIT_EXCEEDED" -> "Supported event limit exceeded.";
            case "SEMANTIC_PROCESSING_FAILED" -> "Digital Wellness result processing failed.";
            default -> "Digital Wellness query failed.";
        };
    }

    JSObject json(DigitalWellnessQuery.Failure failure) {
        return metadata()
            .put("error_code", failure.code).put("error_stage", failure.stage)
            .put("native_exception_class", failure.exceptionClass)
            .put("sanitized_error_message", message(failure.code));
    }

    JSObject metadata() {
        JSObject result = baseMetadata();
        if (validation != null) {
            result.put("validation_rule_failed", validation.ruleFailed == null ? JSONObject.NULL : validation.ruleFailed)
                .put("native_now", validation.nativeNow)
                .put("requested_start", validation.requestedStart)
                .put("requested_end", validation.requestedEnd)
                .put("effective_end", validation.effectiveEnd)
                .put("duration_ms", validation.durationMs)
                .put("lookback_ms", validation.lookbackMs)
                .put("clock_skew_ms", validation.clockSkewMs);
        } else if (inputRuleFailed != null) {
            result.put("validation_rule_failed", inputRuleFailed);
        }
        return result;
    }

    private JSObject baseMetadata() {
        return new JSObject()
            .put("usage_access_at_query", access == null ? "UNKNOWN" : access ? "GRANTED" : "DENIED")
            .put("usage_stats_service_available", service == null ? JSONObject.NULL : service)
            .put("query_start", start == null ? JSONObject.NULL : start)
            .put("query_end", end == null ? JSONObject.NULL : end)
            .put("android_api_level", api == null ? JSONObject.NULL : api)
            .put("appops_result", appOpsMode == null ? JSONObject.NULL : appOpsMode)
            .put("appops_api_branch", appOpsBranch);
    }
}
