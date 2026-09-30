import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeWorkoutCadenceDiagnostics,
  buildWorkoutLiveValidation,
  transitionWorkoutSession,
  type LiveWorkoutPacket,
  type LiveWorkoutSession,
} from './WorkoutTelemetry'

const source = {
  connector: 'JCVITAL_NATIVE' as const,
  provider: 'JCVITAL' as const,
  deviceModel: 'PRO_V8',
  deviceId: 'device-1',
  macAddress: null,
  firmwareVersion: '0.0.8.8',
  sdkVersion: 'v8sdk2.0',
}

function session(status: LiveWorkoutSession['status'] = 'RUNNING'): LiveWorkoutSession {
  return {
    sessionId: 'session-1', deviceId: 'device-1', activityType: 'RUN', vendorActivityMode: 0,
    startedAt: '2026-09-30T10:00:00.000Z', stoppedAt: status === 'STOPPED' ? '2026-09-30T10:00:20.000Z' : null,
    status, packetCount: 0, firstPacketAt: null, lastPacketAt: null, source,
    heartbeatAttemptCount: 0, heartbeatSentCount: 0, heartbeatSkippedCount: 0, heartbeatIntervalMs: 1000,
    heartbeatInputs: { distanceKm: 0, paceSeconds: 0, rssiStrength: 0, note: 'No GPS, pace, or documented dBm-to-vendor-signal mapping supplied.' },
  }
}

function packet(sequence: number, seconds: number, heartRate: number | null): LiveWorkoutPacket {
  return {
    sessionId: 'session-1', receivedAt: new Date(Date.parse('2026-09-30T10:00:00.000Z') + seconds * 1000).toISOString(),
    vendorTimestamp: null, packetSequence: sequence, heartRate, elapsedSeconds: null, exerciseTimeRaw: String(seconds), steps: 10 + seconds,
    calories: 1.2, distance: null, pace: null, mets: null, rssi: null, temperature: null, spo2: null,
    rawVendorPayload: { heartRate, steps: 10 + seconds },
  }
}

function stoppedSession(): LiveWorkoutSession {
  return { ...session('STOPPED'), stoppedAt: '2026-09-30T10:00:20.000Z' }
}

describe('workout capture state and cadence diagnostics', () => {
  beforeEach(() => vi.stubGlobal('crypto', { randomUUID: () => 'session-new' }))

  it('starts a new capture with reset packet metadata and stops it', () => {
    const started = transitionWorkoutSession(null, 'START', '2026-09-30T10:00:00.000Z')
    expect(started).toMatchObject({ sessionId: 'session-new', status: 'STARTING', packetCount: 0, firstPacketAt: null })
    const running = transitionWorkoutSession(started, 'ACK_START', '2026-09-30T10:00:01.000Z')
    const stopping = transitionWorkoutSession(running, 'STOP', '2026-09-30T10:10:00.000Z')
    expect(stopping.status).toBe('STOPPING')
    expect(transitionWorkoutSession(stopping, 'FINISH_STOP', '2026-09-30T10:10:01.000Z')).toMatchObject({ status: 'STOPPED', stoppedAt: '2026-09-30T10:10:01.000Z' })
  })

  it('prevents duplicate starts and stopping an inactive capture', () => {
    const started = transitionWorkoutSession(null, 'START', '2026-09-30T10:00:00.000Z')
    expect(() => transitionWorkoutSession(started, 'START', '2026-09-30T10:00:01.000Z')).toThrow('already active')
    expect(() => transitionWorkoutSession(null, 'STOP', '2026-09-30T10:00:01.000Z')).toThrow('not active')
    expect(() => transitionWorkoutSession(started, 'PAUSE', '2026-09-30T10:00:02.000Z')).toThrow('not running')
  })

  it('supports pause/resume and reset after a completed session', () => {
    const started = transitionWorkoutSession(null, 'START', '2026-09-30T10:00:00.000Z')
    const running = transitionWorkoutSession(started, 'ACK_START', '2026-09-30T10:00:01.000Z')
    const paused = transitionWorkoutSession(running, 'PAUSE', '2026-09-30T10:01:00.000Z')
    expect(paused.status).toBe('PAUSED')
    const resumed = transitionWorkoutSession(paused, 'RESUME', '2026-09-30T10:02:00.000Z')
    expect(resumed.status).toBe('RUNNING')
    expect(transitionWorkoutSession({ ...resumed, status: 'STOPPED' }, 'START', '2026-09-30T10:03:00.000Z')).toMatchObject({ sessionId: 'session-new', status: 'STARTING', packetCount: 0 })
  })

  it('computes a clean one-second stream and confirms only fresh per-packet HR changes', () => {
    const packets = Array.from({ length: 12 }, (_, second) => packet(second, second, 80 + second))
    const diagnostics = computeWorkoutCadenceDiagnostics(stoppedSession(), packets)

    expect(diagnostics).toMatchObject({
      packetCount: 12, hrPacketCount: 12, medianPacketIntervalMs: 1000,
      minimumPacketIntervalMs: 1000, maximumPacketIntervalMs: 1000,
      p5PacketIntervalMs: 1000, p95PacketIntervalMs: 1000,
      percentagePacketsBetween750And1250Ms: 100,
      percentageHrPacketsBetween750And1250Ms: 100,
      duplicateHrCount: 0, zeroHrCount: 0, missingHrCount: 0,
      uniqueHrValueCount: 12, classification: 'CONFIRMED_1HZ_BPM',
    })
  })

  it('classifies one-second packets with slower HR-bearing cadence as sub-1Hz HR', () => {
    const packets = Array.from({ length: 16 }, (_, second) => packet(second, second, second % 2 === 0 ? 80 + second : 80 + second - second % 2))
    const diagnostics = computeWorkoutCadenceDiagnostics(stoppedSession(), packets)
    expect(diagnostics.medianPacketIntervalMs).toBe(1000)
    expect(diagnostics.duplicateHrCount).toBeGreaterThan(0)
    expect(diagnostics.classification).toBe('SUB_1HZ_HR')
  })

  it('classifies a five-second HR refresh carried in one-second workout packets', () => {
    const packets = Array.from({ length: 21 }, (_, second) => packet(second, second, 80 + second - second % 5))
    const diagnostics = computeWorkoutCadenceDiagnostics(stoppedSession(), packets)
    expect(diagnostics.medianPacketIntervalMs).toBe(1000)
    expect(diagnostics.medianHrPacketIntervalMs).toBe(1000)
    expect(diagnostics.medianNonZeroHrIntervalMs).toBe(1000)
    expect(diagnostics.longestRepeatedHrRun).toBe(5)
    expect(diagnostics.classification).toBe('FIVE_SECOND_HR')
  })

  it('allows repeated BPM values when nonzero HR-bearing packets remain stable at 1 Hz', () => {
    const packets = Array.from({ length: 12 }, (_, second) => packet(second, second, 80))
    const diagnostics = computeWorkoutCadenceDiagnostics(stoppedSession(), packets)
    expect(diagnostics).toMatchObject({
      medianPacketIntervalMs: 1000,
      medianHrPacketIntervalMs: 1000,
      medianNonZeroHrIntervalMs: 1000,
      consecutiveRepeatedHrCount: 11,
      longestRepeatedHrRun: 12,
      classification: 'CONFIRMED_1HZ_BPM',
    })
  })

  it('classifies a five-second stream and exposes missing, zero, and duplicate HR counts', () => {
    const packets = [0, 5, 10, 15].map((second, index) => packet(index, second, [0, 80, 80, null][index]))
    const diagnostics = computeWorkoutCadenceDiagnostics(stoppedSession(), packets)
    expect(diagnostics).toMatchObject({
      medianPacketIntervalMs: 5000, medianHrPacketIntervalMs: 5000,
      zeroHrCount: 1, missingHrCount: 1, duplicateHrCount: 1, classification: 'FIVE_SECOND_HR',
    })
  })

  it('reports HR-bearing cadence separately from nonzero HR observation cadence', () => {
    const packets = [
      packet(0, 0, 0),
      packet(1, 1, null),
      packet(2, 2, 80),
      packet(3, 3, null),
      packet(4, 4, 80),
    ]
    const diagnostics = computeWorkoutCadenceDiagnostics(stoppedSession(), packets)
    expect(diagnostics.medianPacketIntervalMs).toBe(1000)
    expect(diagnostics.medianHrPacketIntervalMs).toBe(2000)
    expect(diagnostics.medianNonZeroHrIntervalMs).toBe(2000)
    expect(diagnostics.hrPacketCount).toBe(3)
    expect(diagnostics.nonZeroHrPacketCount).toBe(2)
    expect(diagnostics.classification).toBe('SUB_1HZ_HR')
  })

  it('reports variable packet timing and remains PENDING before stop', () => {
    const packets = [0, 900, 2100, 3000, 4300].map((ms, index) => ({
      ...packet(index, 0, 70 + index), receivedAt: new Date(Date.parse('2026-09-30T10:00:00.000Z') + ms).toISOString(),
    }))
    expect(computeWorkoutCadenceDiagnostics(session(), packets).classification).toBe('PENDING')
    expect(computeWorkoutCadenceDiagnostics(stoppedSession(), packets).classification).toBe('VARIABLE_APPROX_1HZ')
  })

  it('exports only first and last ten packets with distinct cadence summaries', () => {
    const packets = Array.from({ length: 25 }, (_, second) => packet(second, second, 80 + second))
    const report = buildWorkoutLiveValidation(stoppedSession(), packets, [])
    expect(report).toMatchObject({ packetCount: 25, hrPacketCount: 25, classification: 'CONFIRMED_1HZ_BPM' })
    expect(report).toHaveProperty('packetCadenceDiagnostics.medianIntervalMs', 1000)
    expect(report).toHaveProperty('hrBearingCadenceDiagnostics.medianIntervalMs', 1000)
    expect((report.first10Packets as unknown[]).length).toBe(10)
    expect((report.last10Packets as unknown[]).length).toBe(10)
    expect(report).not.toHaveProperty('packets')
  })
})
