import type { NativeObservationInput } from '../../services/base44/base44Types'
import { getPlatform } from '../../services/platform'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'
import { JCVital, type JCVitalPlugin, type JCVitalWorkoutRecord } from './jcvitalBridge'
import {
  DEFAULT_WORKOUT_HR_CAPABILITY,
  resolveWorkoutHrCapabilityState,
  type CadenceConfidence,
  type CadenceSource,
  type WorkoutHrCapability,
  type WorkoutHrCapabilityState,
} from './JCVitalCapabilities'
import {
  buildHeartRateSeries,
  buildScalarObservationId,
  buildSeriesChunkId,
  buildSeriesId,
  chunkHeartRateSeries,
  computeCadenceDiagnostics,
  type HeartRateSeries,
  type HeartRateSeriesChunk,
} from './HeartRateSeries'

/** Vendor numeric activity mode -> label. Do not reinterpret "Football" until OEM confirms terminology. */
export const JCVITAL_ACTIVITY_MODES: Record<number, string> = {
  0: 'Running', 1: 'Cycling', 2: 'Badminton', 3: 'Football', 4: 'Tennis', 5: 'Yoga',
  6: 'Breathing training', 7: 'Dance', 8: 'Basketball', 9: 'Walking', 10: 'Workout/general',
  11: 'Cricket', 12: 'Hiking', 13: 'Aerobics', 14: 'Ping Pong', 15: 'Rope jump', 16: 'Sit-ups', 17: 'Volleyball',
}

export interface JCVitalQueue {
  getOwnerUserId(): string | null
  enqueueMany(observations: NativeObservationInput[]): Promise<Array<{ inserted: boolean; alreadyQueued: boolean }>>
}

/** A chunk pending Base44 series ingestion. Not submitted in Build 7A — see README "Base44 schema preflight". */
export interface PendingSeriesChunk extends HeartRateSeriesChunk {
  chunkId: string
  seriesReconciliation: { workoutId?: string; deviceModel?: string; firmwareVersion?: string; sdkVersion?: string }
}

export interface JCVitalDiagnostics {
  lastSyncAt?: string
  lastBase44DeliveryAt?: string
  workoutHrCapabilityState?: WorkoutHrCapabilityState
  heartRateObservationCount: number
  workoutHrSampleCount: number
  workoutCount: number
  seriesChunksPending: number
  seriesIngestionBlocked: true
  seriesIngestionBlockedReason: string
}

const SERIES_INGESTION_BLOCKED_REASON =
  'The Base44 NativeObservation schema only carries a single valueNumber scalar per observation. ' +
  'Workout HR series/PPI/PPG/ECG/sleep-epoch/movement-epoch chunks require a schema/endpoint extension ' +
  'before they can be delivered; see Base44 schema preflight in README. Chunks are held locally.'

export class JCVitalAdapter {
  private status: 'unsupported' | 'disconnected' | 'connected' | 'syncing' | 'error' = 'unsupported'
  private generation = 0
  private active = false
  private deviceId: string | null = null
  private deviceModel?: string
  private firmwareVersion?: string
  private sdkVersion?: string
  private capability: WorkoutHrCapability = DEFAULT_WORKOUT_HR_CAPABILITY
  private readonly pendingSeriesChunks: PendingSeriesChunk[] = []
  readonly diagnostics: JCVitalDiagnostics = {
    heartRateObservationCount: 0,
    workoutHrSampleCount: 0,
    workoutCount: 0,
    seriesChunksPending: 0,
    seriesIngestionBlocked: true,
    seriesIngestionBlockedReason: SERIES_INGESTION_BLOCKED_REASON,
  }

  private readonly ownerUserId: string
  private readonly plugin: JCVitalPlugin
  private readonly queue: JCVitalQueue
  private readonly deliver: () => Promise<unknown>
  private readonly platform: () => string

  constructor(
    ownerUserId: string,
    plugin: JCVitalPlugin = JCVital,
    queue: JCVitalQueue = observationQueue,
    deliver: () => Promise<unknown> = () => observationBatchManager.process(),
    platform: () => string = getPlatform,
  ) {
    this.ownerUserId = ownerUserId
    this.plugin = plugin
    this.queue = queue
    this.deliver = deliver
    this.platform = platform
  }

  async initialize(): Promise<void> {
    if (this.platform() !== 'android') { this.status = 'unsupported'; return }
    try {
      const { ready } = await this.plugin.initialize()
      this.status = ready ? 'disconnected' : 'error'
    } catch { this.status = 'error' }
  }

  getStatus(): typeof this.status { return this.status }

  async requestPermissions(): Promise<{ granted: boolean }> {
    if (this.status === 'unsupported') return { granted: false }
    try { return await this.plugin.requestPermissions() } catch { this.status = 'error'; return { granted: false } }
  }

  async scan(timeoutMs = 10_000) {
    return this.plugin.scan({ timeoutMs })
  }

  async connect(deviceId: string): Promise<void> {
    const { connected } = await this.plugin.connect({ deviceId })
    if (!connected) { this.status = 'error'; throw new Error('JCVital device connection failed.') }
    this.deviceId = deviceId
    const info = await this.plugin.getDeviceInfo()
    this.deviceModel = info.deviceModel
    this.firmwareVersion = info.firmwareVersion
    this.sdkVersion = info.sdkVersion
    await this.negotiateCapabilities()
    this.status = 'connected'
  }

  /**
   * Negotiate the workout-HR capability for the connected device. Never assumes every V8
   * firmware behaves identically; only upgrades cadence support when the runtime evidence
   * actually reports it.
   */
  async negotiateCapabilities(): Promise<WorkoutHrCapability> {
    try {
      const deviceCapabilities = await this.plugin.getDeviceCapabilities()
      const reported = deviceCapabilities.reportedHistoricalCadencesMs
      if (reported && reported.length) {
        const cadenceSource: CadenceSource = 'SDK_RUNTIME'
        const confidence: CadenceConfidence = 'CONFIRMED'
        this.capability = {
          historicalSupported: true,
          historicalCadencesMs: reported,
          preferredHistoricalCadenceMs: Math.min(...reported),
          realtimeSupported: this.capability.realtimeSupported,
          realtimeCadenceMs: this.capability.realtimeCadenceMs,
          cadenceSource,
          confidence,
        }
      } else {
        this.capability = DEFAULT_WORKOUT_HR_CAPABILITY
      }
    } catch {
      this.capability = DEFAULT_WORKOUT_HR_CAPABILITY
    }
    this.diagnostics.workoutHrCapabilityState = resolveWorkoutHrCapabilityState(this.capability)
    return this.capability
  }

  getWorkoutHrCapability(): WorkoutHrCapability { return this.capability }
  getWorkoutHrCapabilityState(): WorkoutHrCapabilityState { return resolveWorkoutHrCapabilityState(this.capability) }

  private assertOwner(generation: number): void {
    if (!this.active || generation !== this.generation || this.queue.getOwnerUserId() !== this.ownerUserId) {
      throw new Error('JCVital sync stopped because the authenticated account changed.')
    }
  }

  private requireDeviceId(): string {
    if (!this.deviceId) throw new Error('JCVital device is not connected.')
    return this.deviceId
  }

  /** Sync scalar histories (HR, HRV summary, PPI summary, SpO2, temperature, battery, device metadata) to the durable queue. */
  async syncScalars(since?: string): Promise<{ newlyQueued: number; alreadyQueued: number }> {
    if (this.active) throw new Error('JCVital sync is already running.')
    const deviceId = this.requireDeviceId()
    this.active = true
    const generation = this.generation
    this.status = 'syncing'
    let newlyQueued = 0
    let alreadyQueued = 0
    try {
      this.assertOwner(generation)
      const [heartRate, spo2, temperature] = await Promise.all([
        this.plugin.syncHeartRateHistory({ since }),
        this.plugin.syncSpo2History({ since }),
        this.plugin.syncTemperatureHistory({ since }),
      ])
      this.assertOwner(generation)
      const readings = [...heartRate.readings, ...spo2.readings, ...temperature.readings]
      const observations: NativeObservationInput[] = []
      for (const reading of readings) {
        const observationId = await buildScalarObservationId({
          ownerUserId: this.ownerUserId,
          deviceId,
          sourceRecordId: reading.sourceRecordId,
        })
        observations.push({
          observationId,
          source: 'jcvital',
          provider: 'jstyle',
          sourceRecordId: reading.sourceRecordId,
          sourceId: deviceId,
          metric: reading.metric,
          valueNumber: reading.valueNumber,
          unit: reading.unit,
          startTime: reading.startTime,
          endTime: reading.endTime,
          capturedAt: reading.endTime ?? reading.startTime,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          deviceModel: this.deviceModel,
        })
      }
      this.assertOwner(generation)
      if (observations.length) {
        const results = await this.queue.enqueueMany(observations)
        newlyQueued = results.filter((result) => result.inserted).length
        alreadyQueued = results.filter((result) => result.alreadyQueued).length
        this.diagnostics.heartRateObservationCount += heartRate.readings.length
      }
      if (newlyQueued) {
        await this.deliver()
        this.diagnostics.lastBase44DeliveryAt = new Date().toISOString()
      }
      this.status = 'connected'
      this.diagnostics.lastSyncAt = new Date().toISOString()
      return { newlyQueued, alreadyQueued }
    } catch (error) {
      this.status = generation === this.generation ? 'error' : 'disconnected'
      throw error
    } finally { this.active = false }
  }

  /**
   * Sync workout history. HR series are built at native resolution (never up/downsampled),
   * chunked for size-bounded reassembly, and held pending a Base44 series-ingestion schema
   * extension (see diagnostics.seriesIngestionBlockedReason). Workout scalar summaries (steps,
   * calories, distance, METS) ARE enqueued since they fit the existing scalar schema.
   */
  async syncWorkoutHistory(since?: string): Promise<{ workouts: JCVitalWorkoutRecord[]; series: HeartRateSeries[]; newlyQueued: number; alreadyQueued: number }> {
    if (this.active) throw new Error('JCVital sync is already running.')
    const deviceId = this.requireDeviceId()
    this.active = true
    const generation = this.generation
    this.status = 'syncing'
    try {
      this.assertOwner(generation)
      const { workouts } = await this.plugin.syncWorkoutHistory({ since })
      this.assertOwner(generation)
      const series: HeartRateSeries[] = []
      const summaryObservations: NativeObservationInput[] = []
      for (const workout of workouts) {
        if (workout.hrSamples.length) {
          const hrSeries = buildHeartRateSeries({
            sessionId: workout.workoutId,
            workoutId: workout.workoutId,
            acquisitionMode: 'WORKOUT_HISTORICAL',
            startTime: workout.startTime,
            bpmValues: workout.hrSamples.map((sample) => sample.bpm),
            sampleTimestamps: workout.hrSamples.every((sample) => sample.timestamp)
              ? workout.hrSamples.map((sample) => sample.timestamp!)
              : undefined,
            nominalSamplingIntervalMs: workout.hrSamplingIntervalMs ?? this.capability.preferredHistoricalCadenceMs,
            cadenceSource: workout.hrSamplingIntervalMs ? 'SDK_RUNTIME' : this.capability.cadenceSource,
            cadenceConfidence: this.capability.confidence,
            deviceModel: this.deviceModel,
            firmwareVersion: this.firmwareVersion,
            sdkVersion: this.sdkVersion,
            sourceRecordId: workout.workoutId,
          })
          series.push(hrSeries)
          computeCadenceDiagnostics(hrSeries) // data-quality diagnostic only; never relabels cadence
          const seriesId = await buildSeriesId({ ownerUserId: this.ownerUserId, deviceId, sessionId: workout.workoutId, streamType: 'HEART_RATE_WORKOUT' })
          const chunks = chunkHeartRateSeries(hrSeries, seriesId)
          for (const chunk of chunks) {
            const chunkId = await buildSeriesChunkId({ ownerUserId: this.ownerUserId, deviceId, sessionId: workout.workoutId, streamType: 'HEART_RATE_WORKOUT', chunkIndex: chunk.chunkIndex })
            if (!this.pendingSeriesChunks.some((existing) => existing.chunkId === chunkId)) {
              this.pendingSeriesChunks.push({ ...chunk, chunkId, seriesReconciliation: { workoutId: workout.workoutId, deviceModel: this.deviceModel, firmwareVersion: this.firmwareVersion, sdkVersion: this.sdkVersion } })
            }
          }
          this.diagnostics.workoutHrSampleCount += hrSeries.sampleCount
        }
        if (typeof workout.calories === 'number') {
          const observationId = await buildScalarObservationId({ ownerUserId: this.ownerUserId, deviceId, sourceRecordId: `${workout.workoutId}:calories` })
          summaryObservations.push({
            observationId, source: 'jcvital', provider: 'jstyle', sourceRecordId: `${workout.workoutId}:calories`, sourceId: deviceId,
            metric: 'workout_calories', valueNumber: workout.calories, unit: 'kcal',
            startTime: workout.startTime, endTime: workout.endTime, capturedAt: workout.endTime ?? workout.startTime,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone, deviceModel: this.deviceModel,
          })
        }
        this.diagnostics.workoutCount++
      }
      this.assertOwner(generation)
      let newlyQueued = 0
      let alreadyQueued = 0
      if (summaryObservations.length) {
        const results = await this.queue.enqueueMany(summaryObservations)
        newlyQueued = results.filter((result) => result.inserted).length
        alreadyQueued = results.filter((result) => result.alreadyQueued).length
      }
      if (newlyQueued) {
        await this.deliver()
        this.diagnostics.lastBase44DeliveryAt = new Date().toISOString()
      }
      this.diagnostics.seriesChunksPending = this.pendingSeriesChunks.length
      this.status = 'connected'
      this.diagnostics.lastSyncAt = new Date().toISOString()
      return { workouts, series, newlyQueued, alreadyQueued }
    } catch (error) {
      this.status = generation === this.generation ? 'error' : 'disconnected'
      throw error
    } finally { this.active = false }
  }

  /** Chunks awaiting a Base44 series-ingestion schema extension. Never auto-submitted. */
  getPendingSeriesChunks(): readonly PendingSeriesChunk[] { return this.pendingSeriesChunks }

  async disconnect(): Promise<void> {
    this.generation++
    this.active = false
    this.deviceId = null
    this.status = 'disconnected'
    try { await this.plugin.disconnect() } catch { /* best-effort */ }
  }

  /** Logout isolation: clears all buffered/negotiated state so a new owner never sees stale data. */
  logout(): void {
    this.generation++
    this.active = false
    this.deviceId = null
    this.pendingSeriesChunks.length = 0
    this.capability = DEFAULT_WORKOUT_HR_CAPABILITY
    this.status = 'unsupported'
  }
}

export function activityModeLabel(activityModeRaw: number): string {
  return JCVITAL_ACTIVITY_MODES[activityModeRaw] ?? 'Unknown'
}
