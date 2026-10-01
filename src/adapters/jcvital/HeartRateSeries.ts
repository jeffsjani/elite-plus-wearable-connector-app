import type { CadenceConfidence, CadenceSource } from './JCVitalCapabilities'

/** Every observation/series acquisition mode Build 7A must be able to label. */
export type AcquisitionMode =
  | 'REALTIME'
  | 'AUTOMATIC'
  | 'MANUAL'
  | 'WORKOUT_HISTORICAL'
  | 'WORKOUT_REALTIME'
  | 'SLEEP'
  | 'HISTORICAL'
  /** Reserved for a future locally-captured 1Hz workout stream; not production-ready in Build 7A. */
  | 'ELITE_LOCAL_LIVE_CAPTURE'

export interface HeartRateSample {
  sequence: number
  /** Present when the SDK supplied a real per-sample timestamp. */
  timestamp?: string
  /** Present when the timestamp was derived from startTime + sequence * cadence. */
  offsetMs?: number
  bpm: number
}

/**
 * Generic heart-rate series. The same shape represents 5-second and 1-second stored history,
 * 1Hz realtime streams, and (later) locally captured live-capture streams. Do not create a
 * parallel `FiveSecondHeartRateSeries` type — cadence is metadata, not a schema fork.
 */
export interface HeartRateSeries {
  source: 'jcvital'
  provider: 'jstyle'
  deviceModel?: string
  firmwareVersion?: string
  sdkVersion?: string

  sessionId: string
  workoutId?: string

  acquisitionMode: AcquisitionMode

  startTime: string
  endTime: string

  /** Positive interval actually reported by SDK/firmware. Never schema-constrained to 5000. */
  nominalSamplingIntervalMs?: number
  cadenceSource: CadenceSource
  cadenceConfidence: CadenceConfidence

  samples: HeartRateSample[]
  sampleCount: number

  sourceRecordId?: string
  packetId?: string

  /** Always true: Build 7A never resamples native cadence. */
  rawCadencePreserved: true
  /** True when timestamps were derived from cadence instead of supplied per-sample. */
  timestampDerived: boolean
}

export interface BuildHeartRateSeriesInput {
  provider?: 'jstyle'
  deviceModel?: string
  firmwareVersion?: string
  sdkVersion?: string
  sessionId: string
  workoutId?: string
  acquisitionMode: AcquisitionMode
  startTime: string
  /** Raw bpm values in native order. */
  bpmValues: number[]
  /** Per-sample timestamps, same length/order as bpmValues, when the SDK supplies them. */
  sampleTimestamps?: string[]
  /** Reported cadence in ms; required when sampleTimestamps is not supplied. */
  nominalSamplingIntervalMs?: number
  cadenceSource: CadenceSource
  cadenceConfidence: CadenceConfidence
  sourceRecordId?: string
  packetId?: string
}

/**
 * Build a HeartRateSeries preserving native resolution. Per-sample timestamps (when supplied)
 * are always preferred over cadence-derived timestamps (Build 7A requirement #9).
 */
export function buildHeartRateSeries(input: BuildHeartRateSeriesInput): HeartRateSeries {
  const hasRealTimestamps = !!input.sampleTimestamps && input.sampleTimestamps.length === input.bpmValues.length
  if (!hasRealTimestamps && !input.nominalSamplingIntervalMs) {
    throw new Error('A HeartRateSeries requires either per-sample timestamps or a nominal sampling interval.')
  }
  const startMs = Date.parse(input.startTime)
  const samples: HeartRateSample[] = input.bpmValues.map((bpm, sequence) => {
    if (hasRealTimestamps) {
      return { sequence, bpm, timestamp: input.sampleTimestamps![sequence] }
    }
    const offsetMs = sequence * input.nominalSamplingIntervalMs!
    return { sequence, bpm, offsetMs, timestamp: new Date(startMs + offsetMs).toISOString() }
  })
  const endTime = samples.length
    ? (samples[samples.length - 1].timestamp ?? input.startTime)
    : input.startTime
  return {
    source: 'jcvital',
    provider: input.provider ?? 'jstyle',
    deviceModel: input.deviceModel,
    firmwareVersion: input.firmwareVersion,
    sdkVersion: input.sdkVersion,
    sessionId: input.sessionId,
    workoutId: input.workoutId,
    acquisitionMode: input.acquisitionMode,
    startTime: input.startTime,
    endTime,
    nominalSamplingIntervalMs: input.nominalSamplingIntervalMs,
    cadenceSource: input.cadenceSource,
    cadenceConfidence: input.cadenceConfidence,
    samples,
    sampleCount: samples.length,
    sourceRecordId: input.sourceRecordId,
    packetId: input.packetId,
    rawCadencePreserved: true,
    timestampDerived: !hasRealTimestamps,
  }
}

export interface CadenceDiagnostics {
  medianIntervalMs: number
  minIntervalMs: number
  maxIntervalMs: number
  gapCount: number
  sampleCount: number
  durationMs: number
}

/**
 * Observed-cadence diagnostics, computed only from real per-sample timestamps. These are
 * data-quality signals only — never use them to silently relabel a nominal cadence.
 */
export function computeCadenceDiagnostics(series: HeartRateSeries): CadenceDiagnostics | null {
  if (series.timestampDerived || series.samples.length < 2) return null
  const timesMs = series.samples.map((sample) => Date.parse(sample.timestamp!))
  const intervals: number[] = []
  for (let i = 1; i < timesMs.length; i++) intervals.push(timesMs[i] - timesMs[i - 1])
  const sorted = [...intervals].sort((a, b) => a - b)
  const median = sorted.length % 2 === 0
    ? (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
    : sorted[(sorted.length - 1) / 2]
  const nominal = series.nominalSamplingIntervalMs
  const gapCount = nominal ? intervals.filter((interval) => interval > nominal * 1.5).length : 0
  return {
    medianIntervalMs: median,
    minIntervalMs: sorted[0],
    maxIntervalMs: sorted[sorted.length - 1],
    gapCount,
    sampleCount: series.samples.length,
    durationMs: timesMs[timesMs.length - 1] - timesMs[0],
  }
}

export type SeriesStreamType = 'HEART_RATE_WORKOUT' | 'PPI' | 'RR' | 'PPG' | 'ECG' | 'SLEEP_EPOCH' | 'MOVEMENT_EPOCH'

/** A size-bounded, reassemblable slice of a HeartRateSeries. Chunking is by payload size, not sample count. */
export interface HeartRateSeriesChunk {
  seriesId: string
  sessionId: string
  workoutId?: string
  streamType: 'HEART_RATE_WORKOUT'
  chunkIndex: number
  chunkCount: number
  sampleStart: number
  sampleEnd: number
  sampleCount: number
  firstSequence: number
  lastSequence: number
  startTime: string
  endTime: string
  nominalSamplingIntervalMs?: number
  cadenceSource: CadenceSource
  cadenceConfidence: CadenceConfidence
  timestampDerived: boolean
  samples: HeartRateSample[]
}

/** Conservative default chosen to stay well under typical JSON body limits on the existing Base44 request path. */
export const DEFAULT_MAX_CHUNK_BYTES = 48 * 1024

/**
 * Chunk a series by serialized payload size so a 1-hour 1-second workout (~3,600 samples) and a
 * 1-hour 5-second workout (~720 samples) are both handled without an architecture change.
 */
export function chunkHeartRateSeries(series: HeartRateSeries, seriesId: string, maxBytes = DEFAULT_MAX_CHUNK_BYTES): HeartRateSeriesChunk[] {
  if (series.samples.length === 0) return []
  const groups: HeartRateSample[][] = []
  let current: HeartRateSample[] = []
  let currentBytes = 2 // account for surrounding []
  for (const sample of series.samples) {
    const sampleBytes = JSON.stringify(sample).length + 1
    if (current.length > 0 && currentBytes + sampleBytes > maxBytes) {
      groups.push(current)
      current = []
      currentBytes = 2
    }
    current.push(sample)
    currentBytes += sampleBytes
  }
  if (current.length) groups.push(current)

  return groups.map((samples, chunkIndex) => ({
    seriesId,
    sessionId: series.sessionId,
    workoutId: series.workoutId,
    streamType: 'HEART_RATE_WORKOUT',
    chunkIndex,
    chunkCount: groups.length,
    sampleStart: samples[0].sequence,
    sampleEnd: samples[samples.length - 1].sequence,
    sampleCount: samples.length,
    firstSequence: samples[0].sequence,
    lastSequence: samples[samples.length - 1].sequence,
    startTime: samples[0].timestamp ?? series.startTime,
    endTime: samples[samples.length - 1].timestamp ?? series.endTime,
    nominalSamplingIntervalMs: series.nominalSamplingIntervalMs,
    cadenceSource: series.cadenceSource,
    cadenceConfidence: series.cadenceConfidence,
    timestampDerived: series.timestampDerived,
    samples,
  }))
}

/** Reconciliation metadata for a workout with more than one HR series. No merge logic in Build 7A. */
export interface WorkoutHrReconciliation {
  sessionId: string
  workoutId?: string
  sourceStreamType: AcquisitionMode
  samplingIntervalMs?: number
  startTime: string
  endTime: string
  sampleCount: number
  coveragePercent?: number
  gapCount?: number
  sourcePriority: null
}

export function buildWorkoutHrReconciliation(series: HeartRateSeries): WorkoutHrReconciliation {
  const diagnostics = computeCadenceDiagnostics(series)
  let coveragePercent: number | undefined
  if (series.nominalSamplingIntervalMs) {
    const durationMs = Date.parse(series.endTime) - Date.parse(series.startTime)
    const expected = durationMs > 0 ? Math.round(durationMs / series.nominalSamplingIntervalMs) + 1 : series.sampleCount
    coveragePercent = expected > 0 ? Math.min(100, Math.round((series.sampleCount / expected) * 100)) : undefined
  }
  return {
    sessionId: series.sessionId,
    workoutId: series.workoutId,
    sourceStreamType: series.acquisitionMode,
    samplingIntervalMs: series.nominalSamplingIntervalMs,
    startTime: series.startTime,
    endTime: series.endTime,
    sampleCount: series.sampleCount,
    coveragePercent,
    gapCount: diagnostics?.gapCount,
    sourcePriority: null,
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

/** Deterministic scalar-record ID: owner + source + device + native record ID, with a metric/timestamp fallback. */
export async function buildScalarObservationId(params: {
  ownerUserId: string
  deviceId: string
  sourceRecordId?: string
  metric?: string
  timestamp?: string
  acquisitionMode?: AcquisitionMode
  sequence?: number
}): Promise<string> {
  const key = params.sourceRecordId
    ? `${params.ownerUserId}:jcvital:${params.deviceId}:${params.sourceRecordId}`
    : `${params.ownerUserId}:jcvital:${params.deviceId}:${params.metric}:${params.timestamp}:${params.acquisitionMode}:${params.sequence ?? 0}`
  return sha256Hex(key)
}

/** Deterministic series/chunk ID: owner + device + session + stream type + chunk sequence. Repeat sync must not duplicate. */
export async function buildSeriesChunkId(params: {
  ownerUserId: string
  deviceId: string
  sessionId: string
  streamType: SeriesStreamType
  chunkIndex: number
}): Promise<string> {
  return sha256Hex(`${params.ownerUserId}:jcvital:${params.deviceId}:${params.sessionId}:${params.streamType}:${params.chunkIndex}`)
}

/** Deterministic series ID (used to correlate chunks belonging to the same series for reassembly). */
export async function buildSeriesId(params: {
  ownerUserId: string
  deviceId: string
  sessionId: string
  streamType: SeriesStreamType
}): Promise<string> {
  return sha256Hex(`${params.ownerUserId}:jcvital:${params.deviceId}:${params.sessionId}:${params.streamType}:series`)
}
