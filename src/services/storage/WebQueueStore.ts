import type { NativeObservationInput } from '../base44/base44Types'
import { MAX_QUEUE_CLAIM } from './ObservationQueueStore'
import type {
  CanonicalRecoveryBatch,
  CanonicalRecoveryClaim,
  EnqueueResult,
  ObservationQueueStore,
  QueueClaim,
  QueueErrorMetadata,
  QueueRecord,
  QueueStats,
} from './ObservationQueueStore'

const databaseName = 'elite-plus-observation-queue'
const storeName = 'observation_queue'
const metadataStoreName = 'queue_metadata'
const schemaVersion = 5
const maxObservations = 100_000
const warningAgeMs = 30 * 24 * 60 * 60 * 1000

function createId(): string {
  return typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function nowIso(): string { return new Date().toISOString() }

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
    transaction.onabort = () => reject(transaction.error)
  })
}

function toRecord(value: QueueRecord | undefined): QueueRecord | undefined {
  return value ? { ...value, claimedAt: value.claimedAt ?? null, nativeObservationId: value.nativeObservationId ?? null, canonicalFailureAt: value.canonicalFailureAt ?? null } : undefined
}

export class WebQueueStore implements ObservationQueueStore {
  readonly storeType = 'INDEXEDDB' as const
  readonly databaseName = databaseName
  private database: IDBDatabase | null = null
  private lastCreatedMs = 0

  getSchemaVersion(): number | null { return this.database ? schemaVersion : null }

  async getRecord(ownerUserId: string, observationId: string): Promise<QueueRecord | null> {
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readonly')
    const value = await requestResult(transaction.objectStore(storeName).index('ownerObservation').get([ownerUserId, observationId]))
    await transactionDone(transaction)
    return toRecord(value as QueueRecord | undefined) ?? null
  }

  async remove(ownerUserId: string, observationIds: string[]): Promise<void> {
    const ids = new Set(observationIds)
    const records = (await this.all(ownerUserId)).filter((record) => ids.has(record.observationId))
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const queue = transaction.objectStore(storeName)
    records.forEach((record) => queue.delete(record.queueId))
    await transactionDone(transaction)
  }

  async initialize(): Promise<void> {
    if (this.database) return
    this.database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, schemaVersion)
      request.onupgradeneeded = () => {
        const database = request.result
        const queue = database.objectStoreNames.contains(storeName)
          ? request.transaction!.objectStore(storeName)
          : database.createObjectStore(storeName, { keyPath: 'queueId' })
        if (!queue.indexNames.contains('ownerObservation')) queue.createIndex('ownerObservation', ['ownerUserId', 'observationId'], { unique: true })
        if (!queue.indexNames.contains('ownerState')) queue.createIndex('ownerState', ['ownerUserId', 'state'])
        if (!queue.indexNames.contains('ownerCreated')) queue.createIndex('ownerCreated', ['ownerUserId', 'createdAt'])
        if (!queue.indexNames.contains('state')) queue.createIndex('state', 'state')
        if (!database.objectStoreNames.contains(metadataStoreName)) database.createObjectStore(metadataStoreName, { keyPath: 'ownerUserId' })
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
  }

  private async all(ownerUserId: string): Promise<QueueRecord[]> {
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readonly')
    const values = await requestResult(transaction.objectStore(storeName).index('ownerCreated').getAll(IDBKeyRange.bound([ownerUserId, ''], [ownerUserId, '\uffff'])))
    await transactionDone(transaction)
    return values.map(toRecord).filter((value): value is QueueRecord => Boolean(value))
  }

  async enqueue(ownerUserId: string, observation: NativeObservationInput): Promise<EnqueueResult> {
    await this.initialize()
    const existing = await this.getRecord(ownerUserId, observation.observationId)
    if (existing) return { inserted: false, alreadyQueued: true, record: existing }
    // Strictly increasing so the createdAt index preserves FIFO order for same-millisecond inserts.
    this.lastCreatedMs = Math.max(Date.now(), this.lastCreatedMs + 1)
    const timestamp = new Date(this.lastCreatedMs).toISOString()
    const record: QueueRecord = {
      queueId: createId(), ownerUserId, observationId: observation.observationId,
      payload: observation, state: 'PENDING', createdAt: timestamp, updatedAt: timestamp,
      claimedAt: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null,
      lastErrorMessage: null, batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
    }
    const transaction = this.database!.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).add(record)
    await transactionDone(transaction)
    return { inserted: true, alreadyQueued: false, record }
  }

  async enqueueMany(ownerUserId: string, observations: NativeObservationInput[]): Promise<EnqueueResult[]> {
    if (!observations.length) return []
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const queue = transaction.objectStore(storeName)
    const index = queue.index('ownerObservation')
    const results: EnqueueResult[] = []
    const seen = new Map<string, QueueRecord>()
    for (const observation of observations) {
      const existing = seen.get(observation.observationId) ?? (await requestResult(index.get([ownerUserId, observation.observationId])) as QueueRecord | undefined)
      if (existing) { results.push({ inserted: false, alreadyQueued: true, record: existing }); continue }
      this.lastCreatedMs = Math.max(Date.now(), this.lastCreatedMs + 1)
      const timestamp = new Date(this.lastCreatedMs).toISOString()
      const record: QueueRecord = {
        queueId: createId(), ownerUserId, observationId: observation.observationId,
        payload: observation, state: 'PENDING', createdAt: timestamp, updatedAt: timestamp,
        claimedAt: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null,
        lastErrorMessage: null, batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
      }
      queue.add(record)
      seen.set(observation.observationId, record)
      results.push({ inserted: true, alreadyQueued: false, record })
    }
    await transactionDone(transaction)
    return results
  }

  /**
   * Atomic claim: a single IndexedDB readwrite transaction walks only the PENDING and RETRY_WAIT rows (via the
   * ownerState index, so acknowledged/failed/in-flight rows are never scanned as the queue drains), merges them
   * in createdAt order, and marks up to `limit` eligible rows IN_FLIGHT. Because the browser serializes
   * readwrite transactions against the same store, no other concurrent claimPending call can observe or mutate
   * these rows until this transaction commits, so two workers can never claim the same rows.
   */
  async claimPending(ownerUserId: string, limit: number, batchId: string, now = new Date()): Promise<QueueRecord[]> {
    await this.initialize()
    const claimLimit = Math.max(0, Math.min(MAX_QUEUE_CLAIM, Math.floor(limit)))
    if (claimLimit === 0) return []
    const nowIsoValue = now.toISOString()
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const index = store.index('ownerCreated')
    const claimed: QueueRecord[] = []
    const request = index.openCursor(IDBKeyRange.bound([ownerUserId, ''], [ownerUserId, '\uffff']))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || claimed.length >= claimLimit) return
      const record = cursor.value as QueueRecord
      if ((record.state === 'PENDING' || record.state === 'RETRY_WAIT') && (!record.nextAttemptAt || record.nextAttemptAt <= nowIsoValue)) {
        record.state = 'IN_FLIGHT'
        record.batchId = batchId
        record.updatedAt = nowIsoValue
        record.claimedAt = nowIsoValue
        record.lastAttemptAt = nowIsoValue
        record.attemptCount += 1
        cursor.update(record)
        claimed.push({ ...record })
      }
      cursor.continue()
    }
    await transactionDone(transaction)
    return claimed
  }

  async acknowledgeClaims(claims: QueueClaim[], ownerUserId: string): Promise<number> {
    if (!claims.length) return 0
    const timestamp = nowIso()
    const changed = await this.updateClaims(claims, (record) => record.ownerUserId === ownerUserId, (record) => { record.state = 'ACKNOWLEDGED'; record.acknowledgedAt = timestamp; record.updatedAt = timestamp })
    if (changed > 0) {
      const transaction = this.database!.transaction(metadataStoreName, 'readwrite')
      const metadataStore = transaction.objectStore(metadataStoreName)
      const current = await requestResult(metadataStore.get(ownerUserId)) as Record<string, unknown> | undefined
      metadataStore.put({ ...current, ownerUserId, lastSuccessfulUploadAt: timestamp })
      await transactionDone(transaction)
    }
    return changed
  }

  async markCanonicalRecoveryRequired(claims: CanonicalRecoveryClaim[], ownerUserId: string, error: QueueErrorMetadata): Promise<number> {
    if (!claims.length) return 0
    return this.updateClaims(claims, (record) => record.ownerUserId === ownerUserId, (record, claim) => {
      record.state = 'CANONICAL_RECOVERY_REQUIRED'
      record.nativeObservationId = claim.nativeObservationId
      record.canonicalFailureAt = claim.canonicalFailureAt
      record.lastErrorCode = error.code
      record.lastErrorMessage = error.message
      record.updatedAt = claim.canonicalFailureAt
    })
  }

  async getCanonicalRecoveryBatches(ownerUserId: string, limit: number): Promise<CanonicalRecoveryBatch[]> {
    const groups = new Map<string, CanonicalRecoveryBatch>()
    for (const record of await this.all(ownerUserId)) {
      if (record.state !== 'CANONICAL_RECOVERY_REQUIRED' || !record.batchId) continue
      const failureAt = record.canonicalFailureAt ?? record.updatedAt
      const existing = groups.get(record.batchId)
      if (existing) {
        existing.observationCount++
        if (failureAt > existing.lastFailureAt) existing.lastFailureAt = failureAt
      } else groups.set(record.batchId, { batchId: record.batchId, observationCount: 1, lastFailureAt: failureAt })
    }
    const metadataTransaction = this.database!.transaction(metadataStoreName, 'readonly')
    const metadata = await requestResult(metadataTransaction.objectStore(metadataStoreName).get(ownerUserId)) as {
      canonicalRecoveryRequired?: boolean
      canonicalRecoveryBatchId?: string
      canonicalRecoveryObservationCount?: number
      canonicalRecoveryAt?: string
    } | undefined
    await transactionDone(metadataTransaction)
    if (metadata?.canonicalRecoveryRequired && metadata.canonicalRecoveryBatchId) {
      const existing = groups.get(metadata.canonicalRecoveryBatchId)
      if (existing) {
        existing.observationCount = Math.max(existing.observationCount, metadata.canonicalRecoveryObservationCount ?? 0)
        existing.lastFailureAt = metadata.canonicalRecoveryAt ?? existing.lastFailureAt
      } else groups.set(metadata.canonicalRecoveryBatchId, {
        batchId: metadata.canonicalRecoveryBatchId,
        observationCount: metadata.canonicalRecoveryObservationCount ?? 0,
        lastFailureAt: metadata.canonicalRecoveryAt ?? '',
      })
    }
    return [...groups.values()].sort((left, right) => right.lastFailureAt.localeCompare(left.lastFailureAt)).slice(0, Math.max(0, Math.floor(limit)))
  }

  async recordCanonicalRecoveryPause(ownerUserId: string, batchId: string, observationCount: number, at: string): Promise<void> {
    const transaction = this.database!.transaction(metadataStoreName, 'readwrite')
    const metadataStore = transaction.objectStore(metadataStoreName)
    const current = await requestResult(metadataStore.get(ownerUserId)) as Record<string, unknown> | undefined
    metadataStore.put({
      ...current,
      ownerUserId,
      canonicalRecoveryRequired: true,
      canonicalRecoveryBatchId: batchId,
      canonicalRecoveryObservationCount: Number(current?.canonicalRecoveryObservationCount ?? 0) + Math.max(0, Math.floor(observationCount)),
      canonicalRecoveryAt: at,
    })
    await transactionDone(transaction)
  }

  async retryClaims(claims: QueueClaim[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<number> {
    if (!claims.length) return 0
    const timestamp = nowIso()
    return this.updateClaims(claims, () => true, (record) => { record.state = 'RETRY_WAIT'; record.nextAttemptAt = nextAttemptAt; record.lastErrorCode = error.code; record.lastErrorMessage = error.message; record.updatedAt = timestamp })
  }

  async failClaims(claims: QueueClaim[], error: QueueErrorMetadata): Promise<number> {
    if (!claims.length) return 0
    const timestamp = nowIso()
    return this.updateClaims(claims, () => true, (record) => { record.state = 'FAILED_PERMANENT'; record.lastErrorCode = error.code; record.lastErrorMessage = error.message; record.updatedAt = timestamp })
  }

  async getPending(ownerUserId: string, limit: number, now = new Date()): Promise<QueueRecord[]> {
    return (await this.all(ownerUserId))
      .filter((record) => (record.state === 'PENDING' || record.state === 'RETRY_WAIT') && (!record.nextAttemptAt || record.nextAttemptAt <= now.toISOString()))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, limit)
  }

  async getNextRetryAt(ownerUserId: string, now = new Date()): Promise<string | null> {
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readonly')
    const request = transaction.objectStore(storeName).index('ownerState').openCursor([ownerUserId, 'RETRY_WAIT'])
    const nowIsoValue = now.toISOString()
    let nextRetryAt: string | null = null
    await new Promise<void>((resolve, reject) => {
      request.onerror = () => reject(request.error)
      request.onsuccess = () => {
        const cursor = request.result
        if (!cursor) { resolve(); return }
        const record = cursor.value as QueueRecord
        if (record.nextAttemptAt && record.nextAttemptAt > nowIsoValue && (!nextRetryAt || record.nextAttemptAt < nextRetryAt)) {
          nextRetryAt = record.nextAttemptAt
        }
        cursor.continue()
      }
    })
    await transactionDone(transaction)
    return nextRetryAt
  }

  private async updateWhere(predicate: (record: QueueRecord) => boolean, update: (record: QueueRecord) => void): Promise<number> {
    await this.initialize()
    let changed = 0
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const queue = transaction.objectStore(storeName)
    const request = queue.openCursor()
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor) return
      const record = cursor.value as QueueRecord
      if (predicate(record)) { update(record); cursor.update(record); changed++ }
      cursor.continue()
    }
    await transactionDone(transaction)
    return changed
  }

  private async updateClaims<T extends QueueClaim>(claims: T[], ownerPredicate: (record: QueueRecord) => boolean, update: (record: QueueRecord, claim: T) => void): Promise<number> {
    await this.initialize()
    let changed = 0
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const queue = transaction.objectStore(storeName)
    for (const claim of claims) {
      const request = queue.get(claim.queueId)
      request.onsuccess = () => {
        const value = request.result as QueueRecord | undefined
        if (!value || value.state !== 'IN_FLIGHT' || value.batchId !== claim.batchId || value.attemptCount !== claim.attemptCount || !ownerPredicate(value)) return
        update(value, claim)
        queue.put(value)
        changed++
      }
    }
    await transactionDone(transaction)
    return changed
  }

  async releaseStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number> {
    const timestamp = nowIso()
    return this.updateWhere((record) => record.ownerUserId === ownerUserId && record.state === 'IN_FLIGHT' && record.updatedAt < staleBefore, (record) => { record.state = 'RETRY_WAIT'; record.nextAttemptAt = timestamp; record.updatedAt = timestamp; record.lastErrorCode = 'STALE_IN_FLIGHT'; record.lastErrorMessage = 'Recovered after an interrupted upload.' })
  }

  async countStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number> {
    return (await this.all(ownerUserId)).filter((record) => record.state === 'IN_FLIGHT' && record.updatedAt < staleBefore).length
  }

  async getQueueStats(ownerUserId: string, now = new Date()): Promise<QueueStats> {
    const records = await this.all(ownerUserId)
    const pending = records.filter((record) => record.state === 'PENDING')
    const oldestPendingAgeMs = pending.length ? now.getTime() - Date.parse(pending[0].createdAt) : null
    const warnings: string[] = []
    if (records.length >= maxObservations) warnings.push('QUEUE_CAPACITY_NEAR_LIMIT')
    if (oldestPendingAgeMs !== null && oldestPendingAgeMs >= warningAgeMs) warnings.push('QUEUE_AGE_OVER_30_DAYS')
    const metadataTransaction = this.database!.transaction(metadataStoreName, 'readonly')
    const metadata = await requestResult(metadataTransaction.objectStore(metadataStoreName).get(ownerUserId)) as {
      lastSuccessfulUploadAt?: string
      canonicalRecoveryRequired?: boolean
      canonicalRecoveryObservationCount?: number
      canonicalRecoveryBatchId?: string
      canonicalRecoveryAt?: string
    } | undefined
    await transactionDone(metadataTransaction)
    const canonicalRecovery = records.filter((record) => record.state === 'CANONICAL_RECOVERY_REQUIRED')
    const recoveryBatches = await this.getCanonicalRecoveryBatches(ownerUserId, 1)
    const metadataRecovery = metadata?.canonicalRecoveryRequired === true
    const recoveryBatchIds = new Set(canonicalRecovery.map((record) => record.batchId))
    if (metadataRecovery && metadata.canonicalRecoveryBatchId) recoveryBatchIds.add(metadata.canonicalRecoveryBatchId)
    return { pending: pending.length, retrying: records.filter((record) => record.state === 'RETRY_WAIT').length, failed: records.filter((record) => record.state === 'FAILED_PERMANENT').length, inFlight: records.filter((record) => record.state === 'IN_FLIGHT').length, acknowledged: records.filter((record) => record.state === 'ACKNOWLEDGED').length, oldestPendingAgeMs, lastAttemptAt: records.map((record) => record.lastAttemptAt).filter(Boolean).sort().at(-1) ?? null, lastSuccessfulUploadAt: metadata?.lastSuccessfulUploadAt ?? records.map((record) => record.acknowledgedAt).filter(Boolean).sort().at(-1) ?? null, warnings, canonicalRecoveryRequired: canonicalRecovery.length > 0 || metadataRecovery, canonicalRecoveryObservationCount: Math.max(canonicalRecovery.length, metadata?.canonicalRecoveryObservationCount ?? 0), canonicalRecoveryBatchCount: recoveryBatchIds.size, lastCanonicalFailureBatchId: recoveryBatches[0]?.batchId ?? null, lastCanonicalFailureAt: recoveryBatches[0]?.lastFailureAt ?? metadata?.canonicalRecoveryAt ?? null }
  }

  async getOldestPendingAge(ownerUserId: string, now = new Date()): Promise<number | null> { return (await this.getQueueStats(ownerUserId, now)).oldestPendingAgeMs }

  async purgeAcknowledged(ownerUserId: string): Promise<number> {
    const records = (await this.all(ownerUserId)).filter((record) => record.state === 'ACKNOWLEDGED')
    const transaction = this.database!.transaction(storeName, 'readwrite'); const queue = transaction.objectStore(storeName)
    records.forEach((record) => queue.delete(record.queueId)); await transactionDone(transaction); return records.length
  }
}