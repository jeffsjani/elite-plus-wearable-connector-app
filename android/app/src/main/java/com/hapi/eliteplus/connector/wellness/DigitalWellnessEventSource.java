package com.hapi.eliteplus.connector.wellness;

import java.util.List;

public interface DigitalWellnessEventSource {
    record Event(String eventType, long timestamp) {}
    boolean isAvailable();
    boolean hasAccess();
    default void describe(QueryDiagnostics diagnostics) {}
    List<Event> query(long start, long end);
}
