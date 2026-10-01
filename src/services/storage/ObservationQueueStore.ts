import type { NativeObservationInput } from '../base44/base44Types'

export type QueueState = 'PENDING' | 'IN_FLIGHT' | 'RETRY_WAIT' | 'ACKNOWLEDGED' | 'FAILED_PERMANENT'

export interface QueueRecord {
  queueId: string
  ownerUserId: string
  observationId: string
  payload: NativeObservationInput
  state: QueueState
  createdAt: string
  updatedAt: string
  attemptCount: number
  nextAttemptAt: string | null
  lastAttemptAt: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  batchId: string | null
  acknowledgedAt: string | null
}

export interface QueueErrorMetadata {
  code: string
  message: string
}

export interface QueueStats {
  pending: number
  retrying: number
  failed: number
  inFlight: number
  acknowledged: number
  oldestPendingAgeMs: number | null
  lastAttemptAt: string | null
  lastSuccessfulUploadAt: string | null
  warnings: string[]
}

export interface EnqueueResult {
  inserted: boolean
  alreadyQueued: boolean
  record: QueueRecord
}

export type QueueStoreType = 'SQLITE' | 'INDEXEDDB'

export type QueueErrorCode = 'QUEUE_OWNER_MISSING' | 'QUEUE_INIT_FAILED' | 'QUEUE_WRITE_FAILED' | 'QUEUE_READ_FAILED'

export class QueueStoreError extends Error {
  readonly code: QueueErrorCode

  constructor(code: QueueErrorCode, message: string) {
    super(message)
    this.name = 'QueueStoreError'
    this.code = code
  }
}

export interface ObservationQueueStore {
  readonly storeType: QueueStoreType
  readonly databaseName: string
  getSchemaVersion(): number | null
  getRecord(ownerUserId: string, observationId: string): Promise<QueueRecord | null>
  remove(ownerUserId: string, observationIds: string[]): Promise<void>
  initialize(): Promise<void>
  enqueue(ownerUserId: string, observation: NativeObservationInput): Promise<EnqueueResult>
  enqueueMany(ownerUserId: string, observations: NativeObservationInput[]): Promise<EnqueueResult[]>
  getPending(ownerUserId: string, limit: number, now?: Date): Promise<QueueRecord[]>
  markInFlight(queueIds: string[], batchId: string): Promise<void>
  markAcknowledged(observationIds: string[], ownerUserId: string): Promise<void>
  markRetry(queueIds: string[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<void>
  markPermanentFailure(queueIds: string[], error: QueueErrorMetadata): Promise<void>
  releaseStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number>
  countStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number>
  getQueueStats(ownerUserId: string, now?: Date): Promise<QueueStats>
  getOldestPendingAge(ownerUserId: string, now?: Date): Promise<number | null>
  purgeAcknowledged(ownerUserId: string): Promise<number>
}