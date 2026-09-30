package com.hapi.eliteplus.connector.jcvital

class JCVitalV8WorkoutSession(
    val sessionId: String,
    val deviceId: String?,
    val firmwareVersion: String?,
    val activityMode: Int,
    val activityType: String,
    val startedAtMillis: Long,
) {
    var status: String = STATUS_STARTING
        private set
    var stoppedAtMillis: Long? = null
        private set
    var packetCount: Long = 0
        private set
    var firstPacketAt: String? = null
        private set
    var lastPacketAt: String? = null
        private set
    var heartbeatAttemptCount: Long = 0
        private set
    var heartbeatSentCount: Long = 0
        private set
    var heartbeatSkippedCount: Long = 0
        private set
    var nextPacketSequence: Long = 0
        private set

    fun markRunning() {
        check(status == STATUS_STARTING || status == STATUS_PAUSED) { "Workout is not startable/resumable" }
        status = STATUS_RUNNING
    }

    fun markPaused() {
        check(status == STATUS_RUNNING) { "Workout is not running" }
        status = STATUS_PAUSED
    }

    fun markStopping() {
        check(status == STATUS_RUNNING || status == STATUS_PAUSED) { "Workout is not stoppable" }
        status = STATUS_STOPPING
    }

    fun markError(atMillis: Long) {
        if (status == STATUS_STOPPED || status == STATUS_DISCONNECTED) return
        status = STATUS_ERROR
        stoppedAtMillis = atMillis
    }

    fun recordHeartbeatAttempt(count: Long = 1) {
        heartbeatAttemptCount += count.coerceAtLeast(0)
    }

    fun recordHeartbeatSent() {
        heartbeatSentCount++
    }

    fun recordHeartbeatSkipped(count: Long = 1) {
        heartbeatSkippedCount += count.coerceAtLeast(0)
    }

    fun recordPacket(receivedAt: String): Long {
        check(status == STATUS_RUNNING) { "Workout is not running" }
        val sequence = nextPacketSequence++
        packetCount++
        if (firstPacketAt == null) firstPacketAt = receivedAt
        lastPacketAt = receivedAt
        return sequence
    }

    fun stop(atMillis: Long, finalStatus: String = STATUS_STOPPED) {
        if (status == STATUS_STOPPED || status == STATUS_DISCONNECTED || status == STATUS_ERROR) return
        status = finalStatus
        stoppedAtMillis = atMillis
    }

    fun toMap(): Map<String, Any?> = linkedMapOf(
        "sessionId" to sessionId,
        "deviceId" to deviceId,
        "activityType" to activityType,
        "vendorActivityMode" to activityMode,
        "firmwareVersion" to firmwareVersion,
        "sdkVersion" to JCVitalV8EventNormalizer.SDK_VERSION,
        "startedAt" to JCVitalV8Time.isoUtc(startedAtMillis),
        "stoppedAt" to stoppedAtMillis?.let(JCVitalV8Time::isoUtc),
        "status" to status,
        "packetCount" to packetCount,
        "firstPacketAt" to firstPacketAt,
        "lastPacketAt" to lastPacketAt,
        "heartbeatIntervalMs" to HEARTBEAT_INTERVAL_MS,
        "heartbeatAttemptCount" to heartbeatAttemptCount,
        "heartbeatSentCount" to heartbeatSentCount,
        "heartbeatSkippedCount" to heartbeatSkippedCount,
        "source" to linkedMapOf(
            "connector" to "JCVITAL_NATIVE",
            "provider" to "JCVITAL",
            "deviceModel" to "PRO_V8",
            "deviceId" to deviceId,
            "firmwareVersion" to firmwareVersion,
            "sdkVersion" to JCVitalV8EventNormalizer.SDK_VERSION,
        ),
        "heartbeatInputs" to linkedMapOf(
            "distanceKm" to 0.0,
            "paceSeconds" to 0,
            "rssiStrength" to 0,
            "inputSource" to "APP_SUPPLIED_PLACEHOLDERS",
            "note" to "No phone GPS/pace supplied; Android RSSI is dBm but vendor API documents signal level 0-6 without conversion mapping, so zero is sent rather than a guessed conversion.",
        ),
    )

    companion object {
        const val STATUS_IDLE = "IDLE"
        const val STATUS_STARTING = "STARTING"
        const val STATUS_RUNNING = "RUNNING"
        const val STATUS_PAUSED = "PAUSED"
        const val STATUS_STOPPING = "STOPPING"
        const val STATUS_STOPPED = "STOPPED"
        const val STATUS_ERROR = "ERROR"
        const val STATUS_DISCONNECTED = "DISCONNECTED"
        const val HEARTBEAT_INTERVAL_MS = 1_000L
    }
}

object JCVitalV8WorkoutGuard {
    fun blockedReason(
        workout: JCVitalV8WorkoutSession?,
        realtimeActive: Boolean,
        historicalSyncActive: Boolean,
        monitoringReadActive: Boolean,
    ): String? = when {
        workout != null && workout.status !in setOf(
            JCVitalV8WorkoutSession.STATUS_STOPPED,
            JCVitalV8WorkoutSession.STATUS_ERROR,
            JCVitalV8WorkoutSession.STATUS_DISCONNECTED,
        ) -> "Workout capture already active"
        realtimeActive -> "Manual realtime measurement already active"
        historicalSyncActive -> "Historical sync already active"
        monitoringReadActive -> "Monitoring configuration request already active"
        else -> null
    }
}
