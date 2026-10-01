import type { NativeObservationInput } from '../base44/base44Types'
import type {
  EnqueueResult,
  ObservationQueueStore,
  QueueErrorMetadata,
  QueueRecord,
  QueueStats,
} from './ObservationQueueStore'

const databaseName = 'elite-plus-observation-queue'
const storeName = 'observation_queue'
const metadataStoreName = 'queue_metadata'
const schemaVersion = 2
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
  return value
}

export class WebQueueStore implements ObservationQueueStore {
  readonly storeType = 'INDEXEDDB' as const
  readonly databaseName = databaseName
  private database: IDBDatabase | null = null

  getSchemaVersion(): number | null { return this.database ? schemaVersion : null }

  async getRecord(ownerUserId: string, observationId: string): Promise<QueueRecord | null> {
    return (await this.all(ownerUserId)).find((record) => record.observationId === observationId) ?? null
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
    const existing = (await this.all(ownerUserId)).find((record) => record.observationId === observation.observationId)
    if (existing) return { inserted: false, alreadyQueued: true, record: existing }
    const timestamp = nowIso()
    const record: QueueRecord = {
      queueId: createId(), ownerUserId, observationId: observation.observationId,
      payload: observation, state: 'PENDING', createdAt: timestamp, updatedAt: timestamp,
      attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null,
      lastErrorMessage: null, batchId: null, acknowledgedAt: null,
    }
    const transaction = this.database!.transaction(storeName, 'readwrite')
    transaction.objectStore(storeName).add(record)
    await transactionDone(transaction)
    return { inserted: true, alreadyQueued: false, record }
  }

  async enqueueMany(ownerUserId: string, observations: NativeObservationInput[]): Promise<EnqueueResult[]> {
    const results: EnqueueResult[] = []
    for (const observation of observations) results.push(await this.enqueue(ownerUserId, observation))
    return results
  }

  async getPending(ownerUserId: string, limit: number, now = new Date()): Promise<QueueRecord[]> {
    return (await this.all(ownerUserId))
      .filter((record) => (record.state === 'PENDING' || record.state === 'RETRY_WAIT') && (!record.nextAttemptAt || record.nextAttemptAt <= now.toISOString()))
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt)).slice(0, limit)
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

  async markInFlight(queueIds: string[], batchId: string): Promise<void> {
    const set = new Set(queueIds); const timestamp = nowIso()
    await this.updateWhere((record) => set.has(record.queueId), (record) => { record.state = 'IN_FLIGHT'; record.batchId = batchId; record.updatedAt = timestamp; record.lastAttemptAt = timestamp; record.attemptCount += 1 })
  }

  async markAcknowledged(observationIds: string[], ownerUserId: string): Promise<void> {
    const set = new Set(observationIds); const timestamp = nowIso()
    await this.updateWhere((record) => record.ownerUserId === ownerUserId && set.has(record.observationId), (record) => { record.state = 'ACKNOWLEDGED'; record.acknowledgedAt = timestamp; record.updatedAt = timestamp })
    const transaction = this.database!.transaction(metadataStoreName, 'readwrite')
    transaction.objectStore(metadataStoreName).put({ ownerUserId, lastSuccessfulUploadAt: timestamp })
    await transactionDone(transaction)
  }

  async markRetry(queueIds: string[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<void> {
    const set = new Set(queueIds); const timestamp = nowIso()
    await this.updateWhere((record) => set.has(record.queueId), (record) => { record.state = 'RETRY_WAIT'; record.nextAttemptAt = nextAttemptAt; record.lastErrorCode = error.code; record.lastErrorMessage = error.message; record.updatedAt = timestamp })
  }

  async markPermanentFailure(queueIds: string[], error: QueueErrorMetadata): Promise<void> {
    const set = new Set(queueIds); const timestamp = nowIso()
    await this.updateWhere((record) => set.has(record.queueId), (record) => { record.state = 'FAILED_PERMANENT'; record.lastErrorCode = error.code; record.lastErrorMessage = error.message; record.updatedAt = timestamp })
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
    const metadata = await requestResult(metadataTransaction.objectStore(metadataStoreName).get(ownerUserId)) as { lastSuccessfulUploadAt?: string } | undefined
    await transactionDone(metadataTransaction)
    return { pending: pending.length, retrying: records.filter((record) => record.state === 'RETRY_WAIT').length, failed: records.filter((record) => record.state === 'FAILED_PERMANENT').length, inFlight: records.filter((record) => record.state === 'IN_FLIGHT').length, acknowledged: records.filter((record) => record.state === 'ACKNOWLEDGED').length, oldestPendingAgeMs, lastAttemptAt: records.map((record) => record.lastAttemptAt).filter(Boolean).sort().at(-1) ?? null, lastSuccessfulUploadAt: metadata?.lastSuccessfulUploadAt ?? records.map((record) => record.acknowledgedAt).filter(Boolean).sort().at(-1) ?? null, warnings }
  }

  async getOldestPendingAge(ownerUserId: string, now = new Date()): Promise<number | null> { return (await this.getQueueStats(ownerUserId, now)).oldestPendingAgeMs }

  async purgeAcknowledged(ownerUserId: string): Promise<number> {
    const records = (await this.all(ownerUserId)).filter((record) => record.state === 'ACKNOWLEDGED')
    const transaction = this.database!.transaction(storeName, 'readwrite'); const queue = transaction.objectStore(storeName)
    records.forEach((record) => queue.delete(record.queueId)); await transactionDone(transaction); return records.length
  }
}