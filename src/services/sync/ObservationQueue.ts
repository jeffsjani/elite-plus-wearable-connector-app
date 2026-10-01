import type { NativeObservationInput } from '../base44/base44Types'
import { getQueueStore } from '../storage/QueueStoreFactory'
import {
  QueueStoreError,
  type EnqueueResult,
  type ObservationQueueStore,
  type QueueErrorCode,
  type QueueErrorMetadata,
  type QueueRecord,
  type QueueStats,
  type QueueStoreType,
} from '../storage/ObservationQueueStore'

export const queueLimits = { maxObservations: 100_000, warningAgeMs: 30 * 24 * 60 * 60 * 1000 }

export interface QueueDiagnostics {
  queueStoreType: QueueStoreType
  queueStoreInitialized: boolean
  queueDatabaseName: string
  queueSchemaVersion: number | null
  queueInitializationError: string | null
  queueInitializationAttemptedAt: string | null
  ownerAssigned: boolean
}

export interface QueueSelfTestResult {
  enqueueResult: { inserted: boolean; alreadyQueued: boolean }
  recordId: string | null
  readBack: boolean
  readBackPayloadMatches: boolean
  pendingCount: number
  selfTestStats: QueueStats
  removed: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) ?? 'Unknown queue error'
}

export class ObservationQueue {
  private readonly store: ObservationQueueStore
  private ownerUserId: string | null = null
  private initializationError: string | null = null
  private initializationAttemptedAt: string | null = null
  private initialized = false

  constructor(store: ObservationQueueStore = getQueueStore()) { this.store = store }

  async initialize(): Promise<void> {
    this.initializationAttemptedAt = new Date().toISOString()
    try {
      await this.store.initialize()
      this.initialized = true
      this.initializationError = null
    } catch (error) {
      this.initialized = false
      this.initializationError = errorMessage(error)
      throw new QueueStoreError('QUEUE_INIT_FAILED', this.initializationError)
    }
  }

  setOwnerUserId(ownerUserId: string | null): void { this.ownerUserId = ownerUserId }
  getOwnerUserId(): string | null { return this.ownerUserId }

  getDiagnostics(): QueueDiagnostics {
    return {
      queueStoreType: this.store.storeType,
      queueStoreInitialized: this.initialized,
      queueDatabaseName: this.store.databaseName,
      queueSchemaVersion: this.store.getSchemaVersion(),
      queueInitializationError: this.initializationError,
      queueInitializationAttemptedAt: this.initializationAttemptedAt,
      ownerAssigned: this.ownerUserId !== null,
    }
  }

  private requireOwner(): string {
    if (!this.ownerUserId) throw new QueueStoreError('QUEUE_OWNER_MISSING', 'Queue owner is not authenticated.')
    return this.ownerUserId
  }

  /** Initializes lazily so a failed startup initialization recovers on the next queue use. */
  private async ready(): Promise<string> {
    const owner = this.requireOwner()
    if (!this.initialized) await this.initialize()
    return owner
  }

  private async guard<T>(code: QueueErrorCode, operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error) {
      if (error instanceof QueueStoreError) throw error
      throw new QueueStoreError(code, errorMessage(error))
    }
  }

  async enqueue(observation: NativeObservationInput): Promise<EnqueueResult> {
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', () => this.store.enqueue(owner, observation))
  }
  async enqueueMany(observations: NativeObservationInput[]): Promise<EnqueueResult[]> {
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', () => this.store.enqueueMany(owner, observations))
  }
  async getPending(limit: number): Promise<QueueRecord[]> { const owner = await this.ready(); return this.store.getPending(owner, Math.min(limit, 100)) }
  async markInFlight(queueIds: string[], batchId: string): Promise<void> { await this.store.markInFlight(queueIds, batchId) }
  async markAcknowledged(observationIds: string[]): Promise<void> { await this.store.markAcknowledged(observationIds, this.requireOwner()) }
  async markRetry(queueIds: string[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<void> { await this.store.markRetry(queueIds, error, nextAttemptAt) }
  async markPermanentFailure(queueIds: string[], error: QueueErrorMetadata): Promise<void> { await this.store.markPermanentFailure(queueIds, error) }
  async releaseStaleInFlight(staleBefore: string): Promise<void> { const owner = await this.ready(); await this.store.releaseStaleInFlight(owner, staleBefore) }
  async getQueueStats(): Promise<QueueStats> {
    const owner = await this.ready()
    return this.guard('QUEUE_READ_FAILED', () => this.store.getQueueStats(owner))
  }
  async getOldestPendingAge(): Promise<number | null> { return this.store.getOldestPendingAge(this.requireOwner()) }
  async purgeAcknowledged(): Promise<number> { return this.store.purgeAcknowledged(this.requireOwner()) }

  /** Writes, reads back and removes one observation under an isolated owner so it can never be uploaded. */
  async selfTest(observation: NativeObservationInput): Promise<QueueSelfTestResult> {
    const owner = `__queue_self_test__:${await this.ready()}`
    return this.guard('QUEUE_WRITE_FAILED', async () => {
      const enqueued = await this.store.enqueue(owner, observation)
      const record = await this.store.getRecord(owner, observation.observationId)
      const selfTestStats = await this.store.getQueueStats(owner)
      await this.store.remove(owner, [observation.observationId])
      const removed = (await this.store.getRecord(owner, observation.observationId)) === null
      return {
        enqueueResult: { inserted: enqueued.inserted, alreadyQueued: enqueued.alreadyQueued },
        recordId: record?.queueId ?? null,
        readBack: record !== null,
        readBackPayloadMatches: record !== null && JSON.stringify(record.payload) === JSON.stringify(observation),
        pendingCount: selfTestStats.pending,
        selfTestStats,
        removed,
      }
    })
  }
}

export const observationQueue = new ObservationQueue()