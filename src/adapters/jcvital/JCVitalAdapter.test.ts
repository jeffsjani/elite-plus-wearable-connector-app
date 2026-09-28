import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JCVitalPlugin, JCVitalWorkoutRecord } from './jcvitalBridge'
import { JCVitalAdapter, type JCVitalQueue } from './JCVitalAdapter'
import {
  buildHeartRateSeries,
  chunkHeartRateSeries,
  computeCadenceDiagnostics,
} from './HeartRateSeries'
import {
  DEFAULT_WORKOUT_HR_CAPABILITY,
  MARKETING_STORED_HR_1S_CLAIM,
  resolveWorkoutHrCapabilityState,
} from './JCVitalCapabilities'

const plugin = {
  initialize: vi.fn(), requestPermissions: vi.fn(), scan: vi.fn(), connect: vi.fn(), disconnect: vi.fn(),
  getConnectionStatus: vi.fn(), getDeviceInfo: vi.fn(), getBattery: vi.fn(), getFirmwareVersion: vi.fn(),
  getMonitoringConfiguration: vi.fn(), getDeviceCapabilities: vi.fn(),
  syncHeartRateHistory: vi.fn(), syncHrvHistory: vi.fn(), syncPpiHistory: vi.fn(), syncSpo2History: vi.fn(),
  syncTemperatureHistory: vi.fn(), syncSleepHistory: vi.fn(), syncActivityHistory: vi.fn(), syncWorkoutHistory: vi.fn(),
  startRealtimeData: vi.fn(), stopRealtimeData: vi.fn(), startRealtimeHeartRate: vi.fn(), stopRealtimeHeartRate: vi.fn(),
  startPpgMeasurement: vi.fn(), stopPpgMeasurement: vi.fn(), startEcgOrHrvMeasurement: vi.fn(), stopEcgOrHrvMeasurement: vi.fn(),
  startWorkout: vi.fn(), pauseWorkout: vi.fn(), resumeWorkout: vi.fn(), stopWorkout: vi.fn(),
} as unknown as JCVitalPlugin

let owner: string | null
let queue: JCVitalQueue
let enqueue: ReturnType<typeof vi.fn>
let deliver: ReturnType<typeof vi.fn>

function adapter(user = 'user-a', platform = 'android'): JCVitalAdapter {
  return new JCVitalAdapter(user, plugin, queue, deliver, () => platform)
}

function workoutRecord(overrides: Partial<JCVitalWorkoutRecord> = {}): JCVitalWorkoutRecord {
  return {
    workoutId: 'workout-1', activityModeRaw: 0, activityModeLabel: 'Running',
    startTime: '2026-09-28T09:00:00.000Z', endTime: '2026-09-28T09:05:00.000Z',
    steps: 500, calories: 40, distanceMeters: 800, hrSamples: [],
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  owner = 'user-a'
  const ids = new Set<string>()
  enqueue = vi.fn(async (observations: Array<{ observationId: string }>) => observations.map((observation) => {
    const inserted = !ids.has(observation.observationId)
    ids.add(observation.observationId)
    return { inserted, alreadyQueued: !inserted }
  }))
  queue = { getOwnerUserId: () => owner, enqueueMany: enqueue }
  deliver = vi.fn().mockResolvedValue(null)
  vi.mocked(plugin.initialize).mockResolvedValue({ ready: true })
  vi.mocked(plugin.requestPermissions).mockResolvedValue({ granted: true })
  vi.mocked(plugin.connect).mockResolvedValue({ connected: true })
  vi.mocked(plugin.getDeviceInfo).mockResolvedValue({ deviceId: 'device-1', deviceModel: 'V8', firmwareVersion: '1.0.0', sdkVersion: '0.1.13' })
  vi.mocked(plugin.getDeviceCapabilities).mockResolvedValue({ availableWorkoutHrCommands: ['GetDynamicHR'], supportedRawChannels: ['PPG', 'ECG'] })
  vi.mocked(plugin.syncHeartRateHistory).mockResolvedValue({ readings: [] })
  vi.mocked(plugin.syncSpo2History).mockResolvedValue({ readings: [] })
  vi.mocked(plugin.syncTemperatureHistory).mockResolvedValue({ readings: [] })
  vi.mocked(plugin.syncWorkoutHistory).mockResolvedValue({ workouts: [] })
})

describe('JCVitalCapabilities', () => {
  it('default evidence policy is 5-second stored workout HR', () => {
    expect(DEFAULT_WORKOUT_HR_CAPABILITY.historicalCadencesMs).toEqual([5000])
    expect(resolveWorkoutHrCapabilityState(DEFAULT_WORKOUT_HR_CAPABILITY)).toBe('STORED_HR_5S_CONFIRMED')
  })

  it('flags the marketing 1-second claim as unverified, never confirmed', () => {
    expect(resolveWorkoutHrCapabilityState(MARKETING_STORED_HR_1S_CLAIM)).toBe('MARKETING_1S_CLAIM_UNVERIFIED')
  })

  it('recognizes a confirmed 1-second stored capability without any schema change', () => {
    const confirmed = { ...DEFAULT_WORKOUT_HR_CAPABILITY, historicalCadencesMs: [1000], preferredHistoricalCadenceMs: 1000, cadenceSource: 'FIRMWARE' as const, confidence: 'CONFIRMED' as const }
    expect(resolveWorkoutHrCapabilityState(confirmed)).toBe('STORED_HR_1S_CONFIRMED')
  })

  it('recognizes multi-rate capability', () => {
    const multi = { ...DEFAULT_WORKOUT_HR_CAPABILITY, historicalCadencesMs: [1000, 5000] }
    expect(resolveWorkoutHrCapabilityState(multi)).toBe('STORED_HR_MULTI_RATE_CONFIRMED')
  })

  it('recognizes realtime-1s-only when no stored history is supported', () => {
    const realtimeOnly = { historicalSupported: false, historicalCadencesMs: [], realtimeSupported: true, realtimeCadenceMs: 1000, cadenceSource: 'SDK_DOCUMENTATION' as const, confidence: 'CONFIRMED' as const }
    expect(resolveWorkoutHrCapabilityState(realtimeOnly)).toBe('REALTIME_HR_1S_ONLY')
  })
})

describe('HeartRateSeries', () => {
  it('A. preserves a 5-second historical series with samplingIntervalMs = 5000', () => {
    const series = buildHeartRateSeries({
      sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z',
      bpmValues: [100, 101, 102], nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED',
    })
    expect(series.nominalSamplingIntervalMs).toBe(5000)
    expect(series.samples).toHaveLength(3)
  })

  it('B. preserves a 1-second historical series with samplingIntervalMs = 1000', () => {
    const series = buildHeartRateSeries({
      sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z',
      bpmValues: [100, 101, 102], nominalSamplingIntervalMs: 1000, cadenceSource: 'FIRMWARE', cadenceConfidence: 'CONFIRMED',
    })
    expect(series.nominalSamplingIntervalMs).toBe(1000)
  })

  it('C. the same HeartRateSeries type handles both cadences', () => {
    const five = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90], nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED' })
    const one = buildHeartRateSeries({ sessionId: 'w2', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90], nominalSamplingIntervalMs: 1000, cadenceSource: 'FIRMWARE', cadenceConfidence: 'CONFIRMED' })
    expect(five.source).toBe(one.source)
    expect(Object.keys(five).sort()).toEqual(Object.keys(one).sort())
  })

  it('D. a 1-second input is not downsampled', () => {
    const bpmValues = Array.from({ length: 60 }, (_, i) => 90 + i)
    const series = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues, nominalSamplingIntervalMs: 1000, cadenceSource: 'FIRMWARE', cadenceConfidence: 'CONFIRMED' })
    expect(series.sampleCount).toBe(60)
  })

  it('E. a 5-second input is not upsampled', () => {
    const bpmValues = Array.from({ length: 12 }, (_, i) => 90 + i)
    const series = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues, nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED' })
    expect(series.sampleCount).toBe(12)
    expect(series.nominalSamplingIntervalMs).toBe(5000)
  })

  it('F/G. a 1Hz realtime stream remains distinct from 5s and 1s stored history', () => {
    const realtime = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_REALTIME', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90, 91], nominalSamplingIntervalMs: 1000, cadenceSource: 'SDK_RUNTIME', cadenceConfidence: 'STRONG_EVIDENCE' })
    const stored5s = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90, 91], nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED' })
    const stored1s = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90, 91], nominalSamplingIntervalMs: 1000, cadenceSource: 'FIRMWARE', cadenceConfidence: 'CONFIRMED' })
    expect(realtime.acquisitionMode).not.toBe(stored5s.acquisitionMode)
    expect(realtime.acquisitionMode).not.toBe(stored1s.acquisitionMode)
  })

  it('H. per-sample timestamps override interval-derived timestamps', () => {
    const series = buildHeartRateSeries({
      sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z',
      bpmValues: [90, 95], sampleTimestamps: ['2026-09-28T09:00:00.000Z', '2026-09-28T09:00:07.000Z'],
      nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED',
    })
    expect(series.samples[1].timestamp).toBe('2026-09-28T09:00:07.000Z')
    expect(series.timestampDerived).toBe(false)
  })

  it('I. derived timestamps are marked derived', () => {
    const series = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90, 95], nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED' })
    expect(series.timestampDerived).toBe(true)
    expect(series.samples[1].timestamp).toBe('2026-09-28T09:00:05.000Z')
  })

  it('J. variable/gapped timestamps preserve gaps and are reflected in cadence diagnostics', () => {
    const series = buildHeartRateSeries({
      sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z',
      bpmValues: [90, 91, 92], sampleTimestamps: ['2026-09-28T09:00:00.000Z', '2026-09-28T09:00:05.000Z', '2026-09-28T09:00:30.000Z'],
      nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED',
    })
    const diagnostics = computeCadenceDiagnostics(series)
    expect(diagnostics?.gapCount).toBe(1)
    expect(diagnostics?.maxIntervalMs).toBe(25000)
  })

  it('K. capability change from 5s to 1s firmware requires no schema migration (same builder/type)', () => {
    const firmwareA = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90], nominalSamplingIntervalMs: 5000, cadenceSource: 'SDK_DOCUMENTATION', cadenceConfidence: 'CONFIRMED' })
    const firmwareB = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90], nominalSamplingIntervalMs: 1000, cadenceSource: 'FIRMWARE', cadenceConfidence: 'CONFIRMED' })
    expect(typeof firmwareA).toBe(typeof firmwareB)
    expect(firmwareA.rawCadencePreserved).toBe(true)
    expect(firmwareB.rawCadencePreserved).toBe(true)
  })

  it('L. a large 1-second workout is chunked safely and reassemblably', () => {
    const bpmValues = Array.from({ length: 3600 }, (_, i) => 90 + (i % 40))
    const series = buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues, nominalSamplingIntervalMs: 1000, cadenceSource: 'FIRMWARE', cadenceConfidence: 'CONFIRMED' })
    const chunks = chunkHeartRateSeries(series, 'series-1', 4096)
    expect(chunks.length).toBeGreaterThan(1)
    const reassembled = chunks.flatMap((chunk) => chunk.samples)
    expect(reassembled).toHaveLength(3600)
    expect(reassembled[0].sequence).toBe(0)
    expect(reassembled[reassembled.length - 1].sequence).toBe(3599)
    chunks.forEach((chunk, index) => { expect(chunk.chunkIndex).toBe(index); expect(chunk.chunkCount).toBe(chunks.length) })
  })

  it('throws when neither timestamps nor a nominal cadence are supplied', () => {
    expect(() => buildHeartRateSeries({ sessionId: 'w1', acquisitionMode: 'WORKOUT_HISTORICAL', startTime: '2026-09-28T09:00:00.000Z', bpmValues: [90], cadenceSource: 'UNKNOWN', cadenceConfidence: 'UNVERIFIED' })).toThrow()
  })
})

describe('JCVitalAdapter', () => {
  it('negotiates capabilities defaulting to 5s stored HR when the device reports nothing new', async () => {
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    expect(jcvital.getWorkoutHrCapability().historicalCadencesMs).toEqual([5000])
    expect(jcvital.getWorkoutHrCapabilityState()).toBe('STORED_HR_5S_CONFIRMED')
  })

  it('activates 1-second capability seamlessly when runtime negotiation reports it', async () => {
    vi.mocked(plugin.getDeviceCapabilities).mockResolvedValue({ availableWorkoutHrCommands: ['GetDynamicHR'], reportedHistoricalCadencesMs: [1000], supportedRawChannels: [] })
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    expect(jcvital.getWorkoutHrCapability().historicalCadencesMs).toEqual([1000])
    expect(jcvital.getWorkoutHrCapabilityState()).toBe('STORED_HR_1S_CONFIRMED')
  })

  it('syncs scalar heart-rate readings to the durable queue and delivers once', async () => {
    vi.mocked(plugin.syncHeartRateHistory).mockResolvedValue({ readings: [{ sourceRecordId: 'hr-1', metric: 'heart_rate', valueNumber: 72, unit: 'bpm', startTime: '2026-09-28T09:00:00.000Z', acquisitionMode: 'AUTOMATIC' }] })
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    const result = await jcvital.syncScalars()
    expect(result.newlyQueued).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('is idempotent: repeat scalar sync does not create duplicate queue entries', async () => {
    vi.mocked(plugin.syncHeartRateHistory).mockResolvedValue({ readings: [{ sourceRecordId: 'hr-1', metric: 'heart_rate', valueNumber: 72, unit: 'bpm', startTime: '2026-09-28T09:00:00.000Z', acquisitionMode: 'AUTOMATIC' }] })
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    const first = await jcvital.syncScalars()
    const second = await jcvital.syncScalars()
    expect(first.newlyQueued).toBe(1)
    expect(second.newlyQueued).toBe(0)
    expect(second.alreadyQueued).toBe(1)
  })

  it('holds workout HR series/chunks locally instead of encoding them as scalar workarounds', async () => {
    vi.mocked(plugin.syncWorkoutHistory).mockResolvedValue({
      workouts: [workoutRecord({ hrSamples: Array.from({ length: 20 }, (_, i) => ({ bpm: 90 + i })) })],
    })
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    const result = await jcvital.syncWorkoutHistory()
    expect(result.series).toHaveLength(1)
    expect(result.series[0].nominalSamplingIntervalMs).toBe(5000)
    expect(jcvital.getPendingSeriesChunks().length).toBeGreaterThan(0)
    // scalar-only fields (calories) go to the queue; the series never appears in an enqueued observation
    for (const call of enqueue.mock.calls) {
      for (const observation of call[0]) expect(observation.metric).not.toBe('workout_hr_series')
    }
  })

  it('repeat workout sync does not duplicate pending chunks', async () => {
    vi.mocked(plugin.syncWorkoutHistory).mockResolvedValue({ workouts: [workoutRecord({ hrSamples: [{ bpm: 90 }, { bpm: 91 }] })] })
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    await jcvital.syncWorkoutHistory()
    await jcvital.syncWorkoutHistory()
    expect(jcvital.getPendingSeriesChunks().length).toBe(1)
  })

  it('logout clears buffered series chunks and negotiated capability for account isolation', async () => {
    vi.mocked(plugin.syncWorkoutHistory).mockResolvedValue({ workouts: [workoutRecord({ hrSamples: [{ bpm: 90 }, { bpm: 91 }] })] })
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    await jcvital.syncWorkoutHistory()
    expect(jcvital.getPendingSeriesChunks().length).toBe(1)
    jcvital.logout()
    expect(jcvital.getPendingSeriesChunks().length).toBe(0)
    expect(jcvital.getWorkoutHrCapability()).toEqual(DEFAULT_WORKOUT_HR_CAPABILITY)
  })

  it('stops syncing when the authenticated owner changes mid-flight', async () => {
    vi.mocked(plugin.syncHeartRateHistory).mockImplementation(async () => {
      owner = 'user-b'
      return { readings: [{ sourceRecordId: 'hr-1', metric: 'heart_rate', valueNumber: 72, unit: 'bpm', startTime: '2026-09-28T09:00:00.000Z', acquisitionMode: 'AUTOMATIC' }] }
    })
    const jcvital = adapter()
    await jcvital.initialize()
    await jcvital.connect('device-1')
    await expect(jcvital.syncScalars()).rejects.toThrow('authenticated account changed')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('is unsupported on non-android platforms', async () => {
    const jcvital = adapter('user-a', 'ios')
    await jcvital.initialize()
    expect(jcvital.getStatus()).toBe('unsupported')
  })
})
