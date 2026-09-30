package com.hapi.eliteplus.connector.jcvital

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Test

class JCVitalV8WorkoutSessionTest {
    private fun create() = JCVitalV8WorkoutSession(
        sessionId = "session-1",
        deviceId = "D6:AE:FB:AE:33:CC",
        firmwareVersion = "0.0.8.8",
        activityMode = 0,
        activityType = "RUN",
        startedAtMillis = 1_000L,
    )

    @Test
    fun startPauseResumeStopAndRestartResetPacketState() {
        val session = create()
        assertEquals("STARTING", session.status)
        session.markRunning()
        assertEquals(0L, session.recordPacket("1970-01-01T00:00:02.000Z"))
        session.markPaused()
        assertThrows(IllegalStateException::class.java) { session.recordPacket("paused") }
        session.markRunning()
        assertEquals(1L, session.recordPacket("1970-01-01T00:00:03.000Z"))
        session.markStopping()
        assertEquals("STOPPING", session.status)
        session.stop(4_000L)
        assertEquals("STOPPED", session.status)
        assertEquals(2L, session.packetCount)
        assertNotNull(session.firstPacketAt)
        assertEquals("1970-01-01T00:00:03.000Z", session.lastPacketAt)

        val restarted = create()
        restarted.markRunning()
        assertEquals(0L, restarted.packetCount)
        assertEquals(0L, restarted.recordPacket("new-session"))
    }

    @Test
    fun duplicateActiveSessionAndConflictingMeasurementAreRejectedByGuard() {
        val active = create().apply { markRunning() }
        assertEquals("Workout capture already active", JCVitalV8WorkoutGuard.blockedReason(active, false, false, false))
        assertEquals("Manual realtime measurement already active", JCVitalV8WorkoutGuard.blockedReason(null, true, false, false))
        assertEquals("Historical sync already active", JCVitalV8WorkoutGuard.blockedReason(null, false, true, false))
        assertEquals("Monitoring configuration request already active", JCVitalV8WorkoutGuard.blockedReason(null, false, false, true))
        assertNull(JCVitalV8WorkoutGuard.blockedReason(null, false, false, false))
    }

    @Test
    fun terminalSessionDoesNotBlockRestart() {
        val stopped = create().apply { stop(2_000L) }
        assertNull(JCVitalV8WorkoutGuard.blockedReason(stopped, false, false, false))
        val errored = create().apply { markError(2_000L) }
        assertNull(JCVitalV8WorkoutGuard.blockedReason(errored, false, false, false))
        val disconnected = create().apply { stop(2_000L, JCVitalV8WorkoutSession.STATUS_DISCONNECTED) }
        assertNull(JCVitalV8WorkoutGuard.blockedReason(disconnected, false, false, false))
    }

    @Test
    fun requiredLifecycleStatesAndHeartbeatCountersAreRepresented() {
        assertEquals("IDLE", JCVitalV8WorkoutSession.STATUS_IDLE)
        val session = create()
        session.recordHeartbeatAttempt()
        session.recordHeartbeatSent()
        session.recordHeartbeatAttempt(2)
        session.recordHeartbeatSkipped(2)
        assertEquals(3L, session.heartbeatAttemptCount)
        assertEquals(1L, session.heartbeatSentCount)
        assertEquals(2L, session.heartbeatSkippedCount)
        session.markError(2_000L)
        assertEquals("ERROR", session.status)
        assertEquals("RUNNING", JCVitalV8WorkoutSession.STATUS_RUNNING)
        assertEquals("PAUSED", JCVitalV8WorkoutSession.STATUS_PAUSED)
        assertEquals("STOPPING", JCVitalV8WorkoutSession.STATUS_STOPPING)
        assertEquals("STOPPED", JCVitalV8WorkoutSession.STATUS_STOPPED)
    }

    @Test
    fun stopWhileStartingIsRejectedBySessionTransition() {
        val session = create()
        assertThrows(IllegalStateException::class.java) { session.markStopping() }
    }
}
