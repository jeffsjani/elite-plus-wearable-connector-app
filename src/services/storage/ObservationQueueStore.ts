import type { NativeObservationInput } from '../base44/base44Types'

export const MAX_QUEUE_CLAIM = 100

export type QueueState = 'PENDING' | 'IN_FLIGHT' | 'RETRY_WAIT' | 'ACKNOWLEDGED' | 'FAILED_PERMANENT' | 'CANONICAL_RECOVERY_REQUIRED'

export interface QueueRecord {
  queueId: string
  ownerUserId: string
  observationId: string
  payload: NativeObservationInput
  state: QueueState
  createdAt: string
  updatedAt: string
  claimedAt: string | null
  attemptCount: number
  nextAttemptAt: string | null
  lastAttemptAt: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  batchId: string | null
  acknowledgedAt: string | null
  nativeObservationId: string | null
  canonicalFailureAt: string | null
}

export interface CanonicalRecoveryClaim extends QueueClaim {
  nativeObservationId: string | null
  canonicalFailureAt: string
}

export interface CanonicalRecoveryBatch {
  batchId: string
  observationCount: number
  lastFailureAt: string
}

export interface QueueErrorMetadata {
  code: string
  message: string
}

export interface QueueClaim {
  queueId: string
  batchId: string
  attemptCount: number
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
  canonicalRecoveryObservationCount?: number
  canonicalRecoveryBatchCount?: number
  canonicalRecoveryRequired?: boolean
  lastCanonicalFailureBatchId?: string | null
  lastCanonicalFailureAt?: string | null
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
  getNextRetryAt(ownerUserId: string, now?: Date): Promise<string | null>
  /**
   * Atomically selects up to `limit` eligible rows and marks them IN_FLIGHT under `batchId` in one transaction,
   * so two concurrent workers can never claim the same PENDING/RETRY_WAIT rows.
   */
  claimPending(ownerUserId: string, limit: number, batchId: string, now?: Date): Promise<QueueRecord[]>
  acknowledgeClaims(claims: QueueClaim[], ownerUserId: string): Promise<number>
  markCanonicalRecoveryRequired(claims: CanonicalRecoveryClaim[], ownerUserId: string, error: QueueErrorMetadata): Promise<number>
  getCanonicalRecoveryBatches(ownerUserId: string, limit: number): Promise<CanonicalRecoveryBatch[]>
  recordCanonicalRecoveryPause(ownerUserId: string, batchId: string, observationCount: number, at: string): Promise<void>
  retryClaims(claims: QueueClaim[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<number>
  failClaims(claims: QueueClaim[], error: QueueErrorMetadata): Promise<number>
  releaseStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number>
  countStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number>
  getQueueStats(ownerUserId: string, now?: Date): Promise<QueueStats>
  getOldestPendingAge(ownerUserId: string, now?: Date): Promise<number | null>
  purgeAcknowledged(ownerUserId: string): Promise<number>
}