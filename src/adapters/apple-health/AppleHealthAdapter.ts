import { Health, type HealthDataType, type HealthPlugin, type HealthSample, type Workout } from './healthKitBridge'
import type { ConnectorSource, PermissionResult, SourceStatus, SyncOptions, SyncResult } from '../../models/connector'
import type { NativeObservationInput } from '../../services/base44/base44Types'
import { getPlatform } from '../../services/platform'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'
import { observationQueue } from '../../services/sync/ObservationQueue'

export const appleHealthTypes: HealthDataType[] = [
  'heartRate', 'restingHeartRate', 'heartRateVariability', 'sleep', 'steps',
  'calories', 'workouts', 'respiratoryRate', 'oxygenSaturation', 'weight', 'height',
]

const dayMs = 24 * 60 * 60 * 1000
const sampleLimit = 5000

export interface AppleHealthQueue {
  getOwnerUserId(): string | null
  enqueueMany(observations: NativeObservationInput[]): Promise<Array<{ inserted: boolean; alreadyQueued: boolean }>>
}

export interface AppleHealthDiagnostics {
  lastReadAt?: string
  lastDataAt?: string
  lastResult?: { samplesRetrieved: number; normalized: number; newlyQueued: number; alreadyQueued: number; failedNormalization: number }
}

export class AppleHealthAdapter implements ConnectorSource {
  private status: SourceStatus = 'permission_required'
  private selected: HealthDataType[] = []
  private generation = 0
  private active = false
  private verifiedRead = false
  readonly diagnostics: AppleHealthDiagnostics = {}
  private readonly ownerUserId: string
  private readonly plugin: HealthPlugin
  private readonly queue: AppleHealthQueue
  private readonly deliver: () => Promise<unknown>
  private readonly platform: () => string
  private readonly checkpoints: Pick<Storage, 'getItem' | 'setItem'>
  private readonly lookbackDays: number

  constructor(
    ownerUserId: string,
    plugin: HealthPlugin = Health,
    queue: AppleHealthQueue = observationQueue,
    deliver: () => Promise<unknown> = () => observationBatchManager.process(),
    platform: () => string = getPlatform,
    checkpoints: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
    lookbackDays = 7,
  ) {
    this.ownerUserId = ownerUserId
    this.plugin = plugin
    this.queue = queue
    this.deliver = deliver
    this.platform = platform
    this.checkpoints = checkpoints
    this.lookbackDays = lookbackDays
  }

  setSelectedTypes(types: HealthDataType[]): void {
    this.selected = appleHealthTypes.filter((type) => types.includes(type))
  }

  async initialize(): Promise<void> {
    if (this.platform() !== 'ios' || !(await this.plugin.isAvailable()).available) {
      this.status = 'unsupported'
      return
    }
    this.status = 'permission_required'
  }

  async getStatus(): Promise<SourceStatus> { return this.status }

  async requestPermissions(): Promise<PermissionResult> {
    if (this.status === 'unsupported') return { granted: false, permissions: [], denied: [...this.selected] }
    if (!this.selected.length) return { granted: false, permissions: [], denied: [] }
    try {
      const result = await this.plugin.requestAuthorization({ read: this.selected })
      // iOS does not disclose read denial; "readAuthorized" only means the prompt is settled.
      const requested = this.selected.filter((type) => result.readAuthorized.includes(type))
      return { granted: false, permissions: requested, denied: this.selected.filter((type) => !requested.includes(type)) }
    } catch {
      this.status = 'error'
      return { granted: false, permissions: [], denied: [...this.selected] }
    }
  }

  private checkpointKey(type: HealthDataType): string {
    return `apple-health:checkpoint:${this.ownerUserId}:${type}`
  }

  private assertOwner(generation: number): void {
    if (!this.active || generation !== this.generation || this.queue.getOwnerUserId() !== this.ownerUserId) {
      throw new Error('Health sync stopped because the authenticated account changed.')
    }
  }

  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    if (this.status === 'unsupported' || !this.selected.length) throw new Error('Apple Health is unavailable or no data types were selected.')
    if (this.active) throw new Error('Apple Health sync is already running.')
    this.active = true
    const generation = this.generation
    const startedAt = new Date().toISOString()
    const until = options.until ? new Date(options.until).getTime() : Date.now()
    const lookback = until - this.lookbackDays * dayMs
    const observations: NativeObservationInput[] = []
    let samplesRetrieved = 0
    let newlyQueued = 0
    let alreadyQueued = 0
    let failedNormalization = 0
    this.status = 'syncing'
    try {
      this.assertOwner(generation)
      for (const type of this.selected) {
        const saved = this.checkpoints.getItem(this.checkpointKey(type))
        const since = options.since ? new Date(options.since).getTime() : saved ? new Date(saved).getTime() - dayMs : lookback
        let cursor = Math.max(0, since)
        while (cursor < until) {
          this.assertOwner(generation)
          const end = Math.min(cursor + dayMs, until)
          const range = { startDate: new Date(cursor).toISOString(), endDate: new Date(end).toISOString(), limit: sampleLimit, ascending: true }
          const records: Array<HealthSample | Workout> = type === 'workouts'
            ? (await this.plugin.queryWorkouts(range)).workouts
            : (await this.plugin.readSamples({ ...range, dataType: type })).samples
          this.assertOwner(generation)
          if (records.length >= sampleLimit) throw new Error('Health query limit reached; checkpoint was not advanced.')
          samplesRetrieved += records.length
          const batch: NativeObservationInput[] = []
          let invalidInRange = false
          for (const record of records) {
            try {
              batch.push(await normalizeHealthRecord(this.ownerUserId, type, record))
            } catch {
              failedNormalization++
              invalidInRange = true
            }
          }
          this.assertOwner(generation)
          if (batch.length) {
            const results = await this.queue.enqueueMany(batch)
            newlyQueued += results.filter((result) => result.inserted).length
            alreadyQueued += results.filter((result) => result.alreadyQueued).length
            observations.push(...batch)
            const latest = batch.map((item) => item.endTime ?? item.startTime).sort().at(-1)
            if (latest && (!this.diagnostics.lastDataAt || latest > this.diagnostics.lastDataAt)) this.diagnostics.lastDataAt = latest
          }
          this.assertOwner(generation)
          if (invalidInRange) break
          this.checkpoints.setItem(this.checkpointKey(type), new Date(end).toISOString())
          cursor = end
        }
      }
      this.diagnostics.lastReadAt = new Date().toISOString()
      this.diagnostics.lastResult = { samplesRetrieved, normalized: observations.length, newlyQueued, alreadyQueued, failedNormalization }
      if (observations.length > 0) this.verifiedRead = true
      this.status = this.verifiedRead ? 'connected' : 'permission_required'
      if (newlyQueued) await this.deliver()
      return { observations, startedAt, completedAt: new Date().toISOString(), samplesRetrieved, newlyQueued, alreadyQueued, failedNormalization }
    } catch (error) {
      this.status = this.generation === generation ? 'error' : 'permission_required'
      throw error
    } finally {
      this.active = false
    }
  }

  async disconnect(): Promise<void> {
    this.generation++
    this.status = 'permission_required'
    this.selected = []
  }
}

export async function normalizeHealthRecord(ownerUserId: string, type: HealthDataType, record: HealthSample | Workout): Promise<NativeObservationInput> {
  if (!record.platformId || !record.startDate || !record.endDate) throw new Error('Missing HealthKit sample identity or date.')
  const workout = type === 'workouts' ? record as Workout : null
  const sample = workout ? null : record as HealthSample
  const value = workout ? workout.duration : sample?.value
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('Invalid HealthKit measurement.')
  if (!Number.isFinite(Date.parse(record.startDate)) || !Number.isFinite(Date.parse(record.endDate))) throw new Error('Invalid HealthKit date.')
  const metric = workout ? `workout_${workout.workoutType}` : type === 'sleep' && sample?.sleepState ? `sleep_${sample.sleepState}` : type === 'calories' ? 'active_energy' : type
  const input = new TextEncoder().encode(`${ownerUserId}:apple_health:${record.platformId}`)
  const digest = await crypto.subtle.digest('SHA-256', input)
  const observationId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    observationId, source: 'apple_health', metric, valueNumber: value,
    unit: workout ? 'second' : sample!.unit, startTime: record.startDate, endTime: record.endDate,
    capturedAt: record.endDate, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    provider: record.sourceName || record.sourceId || 'Unknown HealthKit source',
    sourceRecordId: record.platformId, ...(record.sourceId ? { sourceId: record.sourceId } : {}),
  }
}