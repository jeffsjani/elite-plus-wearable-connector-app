package com.hapi.eliteplus.connector.wellness;

import java.util.List;

final class FakeDigitalWellnessEventSource implements DigitalWellnessEventSource {
    boolean available = true;
    boolean access = true;
    boolean revokeDuringQuery;
    RuntimeException failure;
    List<Event> events = List.of();
    int queries;
    long lastStart = -1;
    long lastEnd = -1;
    @Override public boolean isAvailable() { return available; }
    @Override public boolean hasAccess() { return access; }
    @Override public List<Event> query(long start, long end) {
        queries++;
        lastStart = start;
        lastEnd = end;
        if (failure != null) throw failure;
        if (revokeDuringQuery) access = false;
        return events;
    }
}
