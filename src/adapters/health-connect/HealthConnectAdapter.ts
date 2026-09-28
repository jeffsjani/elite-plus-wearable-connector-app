import type { ConnectorSource, PermissionResult, SourceStatus, SyncOptions, SyncResult } from '../../models/connector'
import type { NativeObservationInput } from '../../services/base44/base44Types'
import { getPlatform } from '../../services/platform'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'
import { HealthConnect, type HealthConnectPlugin, type HealthConnectType } from './healthConnectBridge'
import { normalizeHealthConnectRecord } from './HealthConnectNormalizer'

export const healthConnectTypes: HealthConnectType[] = [
  'heartRate', 'restingHeartRate', 'hrv', 'sleep', 'steps', 'activeCalories', 'exercise',
  'respiratoryRate', 'oxygenSaturation', 'weight', 'height', 'bodyTemperature',
]

export interface HealthConnectDiagnostics {
  lastReadAt?: string
  lastDataAt?: string
  lastResult?: { recordsRetrieved: number; normalized: number; newlyQueued: number; alreadyQueued: number; failedNormalization: number; deletedRecords: number }
}

export interface HealthConnectQueue {
  getOwnerUserId(): string | null
  enqueueMany(observations: NativeObservationInput[]): Promise<Array<{ inserted: boolean; alreadyQueued: boolean }>>
}

export class HealthConnectAdapter implements ConnectorSource {
  private status: SourceStatus = 'unsupported'
  private selected: HealthConnectType[] = []
  private generation = 0
  private active = false
  readonly diagnostics: HealthConnectDiagnostics = {}
  private readonly ownerUserId: string
  private readonly plugin: HealthConnectPlugin
  private readonly queue: HealthConnectQueue
  private readonly deliver: () => Promise<unknown>
  private readonly platform: () => string
  private readonly checkpoints: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
  private readonly lookbackDays: number

  constructor(
    ownerUserId: string,
    plugin: HealthConnectPlugin = HealthConnect,
    queue: HealthConnectQueue = observationQueue,
    deliver: () => Promise<unknown> = () => observationBatchManager.process(),
    platform: () => string = getPlatform,
    checkpoints: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> = localStorage,
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

  setSelectedTypes(types: HealthConnectType[]): void {
    this.selected = healthConnectTypes.filter((type) => types.includes(type))
  }

  async initialize(): Promise<void> {
    if (this.platform() !== 'android') { this.status = 'unsupported'; return }
    try {
      const { status } = await this.plugin.availability()
      this.status = status === 'AVAILABLE' ? 'permission_required'
        : status === 'NOT_INSTALLED' ? 'not_installed'
        : status === 'UPDATE_REQUIRED' ? 'update_required' : 'unsupported'
    } catch { this.status = 'error' }
  }

  async getStatus(): Promise<SourceStatus> {
    if (this.status === 'permission_required' || this.status === 'connected' || this.status === 'error') {
      if (this.selected.length) {
        try {
          const { granted } = await this.plugin.grantedPermissions({ types: this.selected })
          this.status = this.selected.every((type) => granted.includes(type)) ? 'connected' : 'permission_required'
        } catch { this.status = 'error' }
      }
    }
    return this.status
  }

  async requestPermissions(): Promise<PermissionResult> {
    if (!this.selected.length || ['unsupported', 'not_installed', 'update_required'].includes(this.status)) {
      return { granted: false, permissions: [], denied: [...this.selected] }
    }
    try {
      const { granted } = await this.plugin.requestReadPermissions({ types: this.selected })
      const permissions = this.selected.filter((type) => granted.includes(type))
      const denied = this.selected.filter((type) => !permissions.includes(type))
      this.status = denied.length ? 'permission_required' : 'connected'
      return { granted: denied.length === 0, permissions, denied }
    } catch {
      this.status = 'error'
      return { granted: false, permissions: [], denied: [...this.selected] }
    }
  }

  async openHealthConnect(): Promise<void> { await this.plugin.openHealthConnect() }

  private checkpointKey(): string {
    return `health-connect:changes:${this.ownerUserId}:${this.selected.join(',')}`
  }

  private assertOwner(generation: number): void {
    if (!this.active || generation !== this.generation || this.queue.getOwnerUserId() !== this.ownerUserId) {
      throw new Error('Health Connect sync stopped because the authenticated account changed.')
    }
  }

  async sync(options: SyncOptions = {}): Promise<SyncResult> {
    if (this.active) throw new Error('Health Connect sync is already running.')
    if (!this.selected.length || await this.getStatus() !== 'connected') throw new Error('Health Connect permission is required.')
    this.active = true
    const generation = this.generation
    const startedAt = new Date().toISOString()
    const observations: NativeObservationInput[] = []
    let recordsRetrieved = 0
    let newlyQueued = 0
    let alreadyQueued = 0
    let failedNormalization = 0
    let deletedRecords = 0
    this.status = 'syncing'
    try {
      this.assertOwner(generation)
      const key = this.checkpointKey()
      let token = this.checkpoints.getItem(key)
      if (!token) {
        token = (await this.plugin.getChangesToken({ types: this.selected })).token
        const endTime = options.until || new Date().toISOString()
        const startTime = options.since || new Date(Date.parse(endTime) - this.lookbackDays * 86400000).toISOString()
        for (const type of this.selected) {
          this.assertOwner(generation)
          const { records } = await this.plugin.readHistory({ type, startTime, endTime })
          this.assertOwner(generation)
          recordsRetrieved += records.length
          const batch: NativeObservationInput[] = []
          for (const record of records) {
            try { batch.push(await normalizeHealthConnectRecord(this.ownerUserId, record)) }
            catch { failedNormalization++ }
          }
          this.assertOwner(generation)
          if (batch.length) {
            const results = await this.queue.enqueueMany(batch)
            newlyQueued += results.filter((result) => result.inserted).length
            alreadyQueued += results.filter((result) => result.alreadyQueued).length
            observations.push(...batch)
          }
        }
        this.assertOwner(generation)
        if (failedNormalization) throw new Error('Health Connect records could not be normalized; initial sync will retry.')
        this.checkpoints.setItem(key, token)
      }
      let hasMore = true
      while (hasMore) {
        this.assertOwner(generation)
        const changes = await this.plugin.getChanges({ token })
        this.assertOwner(generation)
        if (changes.expired) {
          this.checkpoints.removeItem(key)
          throw new Error('Health Connect changes expired; retry a bounded history read.')
        }
        recordsRetrieved += changes.upsertions.length
        const batch: NativeObservationInput[] = []
        for (const record of changes.upsertions) {
          try { batch.push(await normalizeHealthConnectRecord(this.ownerUserId, record)) }
          catch { failedNormalization++ }
        }
        this.assertOwner(generation)
        if (batch.length) {
          const results = await this.queue.enqueueMany(batch)
          newlyQueued += results.filter((result) => result.inserted).length
          alreadyQueued += results.filter((result) => result.alreadyQueued).length
          observations.push(...batch)
        }
        if (failedNormalization) throw new Error('Health Connect changes could not be normalized; token was not advanced.')
        deletedRecords += changes.deletions.length
        this.assertOwner(generation)
        token = changes.nextToken
        this.checkpoints.setItem(key, token)
        hasMore = changes.hasMore
      }
      this.status = 'connected'
      this.diagnostics.lastReadAt = new Date().toISOString()
      const lastData = observations.map((item) => item.endTime ?? item.startTime).sort().at(-1)
      if (lastData && (!this.diagnostics.lastDataAt || lastData > this.diagnostics.lastDataAt)) this.diagnostics.lastDataAt = lastData
      this.diagnostics.lastResult = { recordsRetrieved, normalized: observations.length, newlyQueued, alreadyQueued, failedNormalization, deletedRecords }
      if (newlyQueued) await this.deliver()
      return { observations, startedAt, completedAt: new Date().toISOString(), samplesRetrieved: recordsRetrieved, newlyQueued, alreadyQueued, failedNormalization }
    } catch (error) {
      this.status = generation === this.generation ? 'error' : 'permission_required'
      throw error
    } finally { this.active = false }
  }

  async disconnect(): Promise<void> {
    this.generation++
    this.selected = []
    this.status = 'permission_required'
  }
}