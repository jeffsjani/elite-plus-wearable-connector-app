import type { WearableSource } from '../../models/wearableObservation'

export type LiveWorkoutStatus = 'IDLE' | 'STARTING' | 'RUNNING' | 'PAUSED' | 'STOPPING' | 'STOPPED' | 'ERROR' | 'DISCONNECTED'
export type WorkoutHrClassification = 'PENDING' | 'CONFIRMED_1HZ_HR_OBSERVATION' | 'VARIABLE_APPROX_1HZ' | 'SUB_1HZ_HR' | 'FIVE_SECOND_HR' | 'OTHER'

export interface LiveWorkoutSession {
  sessionId: string | null
  deviceId: string | null
  activityType: string | null
  vendorActivityMode: number | null
  startedAt: string | null
  stoppedAt: string | null
  status: LiveWorkoutStatus
  packetCount: number
  firstPacketAt: string | null
  lastPacketAt: string | null
  heartbeatAttemptCount: number
  heartbeatSentCount: number
  heartbeatSkippedCount: number
  heartbeatIntervalMs: number
  source?: WearableSource
  heartbeatInputs?: {
    distanceKm: number
    paceSeconds: number
    rssiStrength: number
    note: string
    inputSource?: string
  }
}

export interface LiveWorkoutPacket {
  sessionId: string
  receivedAt: string
  vendorTimestamp: string | null
  packetSequence: number
  heartRate: number | null
  elapsedSeconds: number | null
  exerciseTimeRaw: string | number | null
  exerciseTimeMetricType?: 'WORKOUT_ELAPSED_SECONDS' | null
  exerciseTimeUnit?: 'second' | null
  exerciseTimeValidationStatus?: 'CONFIRMED_HARDWARE' | null
  steps: number | null
  calories: number | null
  distance: number | null
  pace: number | null
  mets: number | null
  rssi: number | null
  temperature: number | null
  spo2: number | null
  rawVendorPayload: Record<string, unknown>
}

export interface WorkoutCadenceDiagnostics {
  packetCount: number
  hrPacketCount: number
  medianPacketIntervalMs: number | null
  minimumPacketIntervalMs: number | null
  maximumPacketIntervalMs: number | null
  p5PacketIntervalMs: number | null
  p95PacketIntervalMs: number | null
  percentagePacketsBetween750And1250Ms: number | null
  medianHrPacketIntervalMs: number | null
  minimumHrPacketIntervalMs: number | null
  maximumHrPacketIntervalMs: number | null
  p5HrPacketIntervalMs: number | null
  p95HrPacketIntervalMs: number | null
  percentageHrPacketsBetween750And1250Ms: number | null
  medianNonZeroHrIntervalMs: number | null
  p5NonZeroHrIntervalMs: number | null
  p95NonZeroHrIntervalMs: number | null
  percentageNonZeroHrIntervalsBetween750And1250Ms: number | null
  nonZeroHrPacketCount: number
  duplicateHrCount: number
  consecutiveRepeatedHrCount: number
  longestRepeatedHrRun: number
  zeroHrCount: number
  missingHrCount: number
  uniqueHrValueCount: number
  firstNonZeroHrDelayMs: number | null
  sessionDurationSeconds: number
  classification: WorkoutHrClassification
}

export type WorkoutSessionState = Pick<LiveWorkoutSession, 'sessionId' | 'startedAt' | 'stoppedAt' | 'status' | 'packetCount' | 'firstPacketAt' | 'lastPacketAt'>

export function transitionWorkoutSession(
  current: WorkoutSessionState | null,
  action: 'START' | 'ACK_START' | 'PAUSE' | 'RESUME' | 'STOP' | 'FINISH_STOP' | 'FAIL' | 'DISCONNECT',
  now: string,
  sessionId = crypto.randomUUID(),
): WorkoutSessionState {
  if (action === 'START') {
    if (current && !['STOPPED', 'ERROR', 'DISCONNECTED'].includes(current.status)) throw new Error('A workout capture is already active')
    return { sessionId, startedAt: now, stoppedAt: null, status: 'STARTING', packetCount: 0, firstPacketAt: null, lastPacketAt: null }
  }
  if (!current || ['STOPPED', 'ERROR', 'DISCONNECTED', 'IDLE'].includes(current.status)) throw new Error(`Cannot ${action.toLowerCase()} a workout capture that is not active`)
  if (action === 'ACK_START') {
    if (current.status !== 'STARTING') throw new Error('Workout capture is not starting')
    return { ...current, status: 'RUNNING' }
  }
  if (action === 'PAUSE') {
    if (current.status !== 'RUNNING') throw new Error('Workout capture is not running')
    return { ...current, status: 'PAUSED' }
  }
  if (action === 'RESUME') {
    if (current.status !== 'PAUSED') throw new Error('Workout capture is not paused')
    return { ...current, status: 'RUNNING' }
  }
  if (action === 'STOP') {
    if (current.status !== 'RUNNING' && current.status !== 'PAUSED') throw new Error('Workout capture is not stoppable')
    return { ...current, status: 'STOPPING' }
  }
  if (action === 'FINISH_STOP') {
    if (current.status !== 'STOPPING') throw new Error('Workout capture is not stopping')
    return { ...current, status: 'STOPPED', stoppedAt: now }
  }
  if (action === 'FAIL') return { ...current, status: 'ERROR', stoppedAt: now }
  return { ...current, status: 'DISCONNECTED', stoppedAt: now }
}

function percentile(sorted: number[], percentileValue: number): number | null {
  if (!sorted.length) return null
  const position = (sorted.length - 1) * percentileValue
  const lower = Math.floor(position)
  const upper = Math.ceil(position)
  if (lower === upper) return sorted[lower]
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower)
}

function intervals(packets: LiveWorkoutPacket[]): number[] {
  const timestamps = packets.map((packet) => Date.parse(packet.receivedAt)).filter(Number.isFinite).sort((a, b) => a - b)
  return timestamps.slice(1).map((time, index) => time - timestamps[index])
}

function summarizeIntervals(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    median: percentile(sorted, 0.5),
    minimum: sorted[0] ?? null,
    maximum: sorted.at(-1) ?? null,
    p5: percentile(sorted, 0.05),
    p95: percentile(sorted, 0.95),
    percentageNear1Hz: sorted.length ? sorted.filter((interval) => interval >= 750 && interval <= 1250).length / sorted.length * 100 : null,
  }
}

function classifyWorkoutHr(
  packetSummary: ReturnType<typeof summarizeIntervals>,
  hrSummary: ReturnType<typeof summarizeIntervals>,
  isStopped: boolean,
): WorkoutHrClassification {
  if (!isStopped) return 'PENDING'
  const packetNear1Hz = (packetSummary.percentageNear1Hz ?? 0) >= 75
  const hrNear1Hz = (hrSummary.percentageNear1Hz ?? 0) >= 90
  if (hrSummary.median !== null && hrSummary.median >= 4_000 && hrSummary.median <= 6_000) return 'FIVE_SECOND_HR'
  if (packetNear1Hz && (
    (hrSummary.median !== null && hrSummary.median > 1_250)
  )) return 'SUB_1HZ_HR'
  if (packetSummary.median !== null && packetSummary.median >= 4_000 && packetSummary.median <= 6_000) return 'FIVE_SECOND_HR'
  if (hrNear1Hz && hrSummary.median !== null && hrSummary.median >= 750 && hrSummary.median <= 1_250) return 'CONFIRMED_1HZ_HR_OBSERVATION'
  if (hrSummary.median !== null && hrSummary.median >= 750 && hrSummary.median <= 1_500) return 'VARIABLE_APPROX_1HZ'
  return 'OTHER'
}

export function computeWorkoutCadenceDiagnostics(
  session: LiveWorkoutSession,
  packets: LiveWorkoutPacket[],
  stopped = session.status === 'STOPPED',
): WorkoutCadenceDiagnostics {
  const packetIntervals = intervals(packets)
  const hrPackets = packets.filter((packet) => packet.heartRate !== null)
  const nonZeroHrPackets = hrPackets.filter((packet) => (packet.heartRate ?? 0) > 0)
  const hrIntervals = intervals(hrPackets)
  const nonZeroHrIntervals = intervals(nonZeroHrPackets)
  let duplicateHrCount = 0
  let longestRepeatedHrRun = 0
  let currentHrRun = 0
  let previousHr: number | null = null
  const uniqueHrValues = new Set<number>()

  for (const packet of nonZeroHrPackets) {
    const hr = packet.heartRate!
    uniqueHrValues.add(hr)
    if (previousHr === hr) {
      duplicateHrCount++
      currentHrRun++
    } else {
      currentHrRun = 1
    }
    longestRepeatedHrRun = Math.max(longestRepeatedHrRun, currentHrRun)
    previousHr = hr
  }

  const packetSummary = summarizeIntervals(packetIntervals)
  const hrSummary = summarizeIntervals(hrIntervals)
  const nonZeroHrSummary = summarizeIntervals(nonZeroHrIntervals)
  const startedAt = session.startedAt ? Date.parse(session.startedAt) : Number.NaN
  const firstNonZero = nonZeroHrPackets.map((packet) => Date.parse(packet.receivedAt)).find(Number.isFinite)
  const endedAt = session.stoppedAt ? Date.parse(session.stoppedAt) : Date.now()
  return {
    packetCount: packets.length,
    hrPacketCount: hrPackets.length,
    medianPacketIntervalMs: packetSummary.median,
    minimumPacketIntervalMs: packetSummary.minimum,
    maximumPacketIntervalMs: packetSummary.maximum,
    p5PacketIntervalMs: packetSummary.p5,
    p95PacketIntervalMs: packetSummary.p95,
    percentagePacketsBetween750And1250Ms: packetSummary.percentageNear1Hz,
    medianHrPacketIntervalMs: hrSummary.median,
    minimumHrPacketIntervalMs: hrSummary.minimum,
    maximumHrPacketIntervalMs: hrSummary.maximum,
    p5HrPacketIntervalMs: hrSummary.p5,
    p95HrPacketIntervalMs: hrSummary.p95,
    percentageHrPacketsBetween750And1250Ms: hrSummary.percentageNear1Hz,
    medianNonZeroHrIntervalMs: nonZeroHrSummary.median,
    p5NonZeroHrIntervalMs: nonZeroHrSummary.p5,
    p95NonZeroHrIntervalMs: nonZeroHrSummary.p95,
    percentageNonZeroHrIntervalsBetween750And1250Ms: nonZeroHrSummary.percentageNear1Hz,
    nonZeroHrPacketCount: nonZeroHrPackets.length,
    duplicateHrCount,
    consecutiveRepeatedHrCount: duplicateHrCount,
    longestRepeatedHrRun,
    zeroHrCount: hrPackets.filter((packet) => packet.heartRate === 0).length,
    missingHrCount: packets.filter((packet) => packet.heartRate === null).length,
    uniqueHrValueCount: uniqueHrValues.size,
    firstNonZeroHrDelayMs: firstNonZero === undefined || !Number.isFinite(startedAt) ? null : firstNonZero - startedAt,
    sessionDurationSeconds: Number.isFinite(startedAt) && Number.isFinite(endedAt) ? Math.max(0, (endedAt - startedAt) / 1000) : 0,
    classification: classifyWorkoutHr(packetSummary, nonZeroHrSummary, stopped),
  }
}

export function buildWorkoutLiveValidation(
  session: LiveWorkoutSession | null,
  packets: LiveWorkoutPacket[],
  parseErrors: Array<Record<string, unknown>>,
): Record<string, unknown> {
  if (!session) {
    return {
      status: 'IDLE',
      session: null,
      packetCount: 0,
      hrPacketCount: 0,
      cadenceDiagnostics: null,
      classification: 'PENDING',
      first10Packets: [],
      last10Packets: [],
      parseErrors,
    }
  }
  const isStopped = ['STOPPED', 'ERROR', 'DISCONNECTED'].includes(session.status)
  const diagnostics = computeWorkoutCadenceDiagnostics(session, packets, isStopped)
  return {
    status: session.status,
    device: {
      model: session.source?.deviceModel ?? 'PRO_V8',
      deviceId: session.deviceId,
      firmwareVersion: session.source?.firmwareVersion ?? null,
      sdkVersion: session.source?.sdkVersion ?? 'v8sdk2.0',
    },
    session: {
      sessionId: session.sessionId,
      activityType: session.activityType,
      vendorActivityMode: session.vendorActivityMode,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      status: session.status,
      heartbeatInputs: session.heartbeatInputs,
    },
    heartbeatAttemptCount: session.heartbeatAttemptCount,
    heartbeatSentCount: session.heartbeatSentCount,
    heartbeatSkippedCount: session.heartbeatSkippedCount,
    packetCount: diagnostics.packetCount,
    hrPacketCount: diagnostics.hrPacketCount,
    packetCadenceDiagnostics: {
      medianIntervalMs: diagnostics.medianPacketIntervalMs,
      p5IntervalMs: diagnostics.p5PacketIntervalMs,
      p95IntervalMs: diagnostics.p95PacketIntervalMs,
      percentageBetween750And1250Ms: diagnostics.percentagePacketsBetween750And1250Ms,
    },
    hrBearingCadenceDiagnostics: {
      medianIntervalMs: diagnostics.medianHrPacketIntervalMs,
      p5IntervalMs: diagnostics.p5HrPacketIntervalMs,
      p95IntervalMs: diagnostics.p95HrPacketIntervalMs,
      percentageBetween750And1250Ms: diagnostics.percentageHrPacketsBetween750And1250Ms,
    },
    nonZeroHrObservationCadenceDiagnostics: {
      observationCount: diagnostics.nonZeroHrPacketCount,
      medianIntervalMs: diagnostics.medianNonZeroHrIntervalMs,
      p5IntervalMs: diagnostics.p5NonZeroHrIntervalMs,
      p95IntervalMs: diagnostics.p95NonZeroHrIntervalMs,
      percentageBetween750And1250Ms: diagnostics.percentageNonZeroHrIntervalsBetween750And1250Ms,
    },
    zeroHrCount: diagnostics.zeroHrCount,
    missingHrCount: diagnostics.missingHrCount,
    consecutiveRepeatedHrCount: diagnostics.consecutiveRepeatedHrCount,
    longestRepeatedHrRun: diagnostics.longestRepeatedHrRun,
    uniqueHrValueCount: diagnostics.uniqueHrValueCount,
    firstNonZeroHrDelayMs: diagnostics.firstNonZeroHrDelayMs,
    sessionDurationSeconds: diagnostics.sessionDurationSeconds,
    classification: diagnostics.classification,
    first10Packets: packets.slice(0, 10),
    last10Packets: packets.slice(-10),
    parseErrors,
  }
}
