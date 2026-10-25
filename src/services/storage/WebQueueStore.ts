import type { NativeObservationInput } from '../base44/base44Types'
import { activityTransportClaimable, assertActivityRecoveryIds } from './ActivityCertificationTransport'
import { MAX_QUEUE_CLAIM, SCOPED_ACTIVITY_E2E_CLAIM_COUNT } from './ObservationQueueStore'
import type {
  CanonicalRecoveryBatch,
  CanonicalRecoveryClaim,
  EnqueueResult,
  ObservationQueueStore,
  QueueClaim,
  QueueErrorMetadata,
  QueueRecord,
  QueueStats,
  PendingQueueComposition,
  QueueCompositionGroup,
  PersistedProductionSyncReceipt,
  AcquisitionQueueProvenance,
} from './ObservationQueueStore'

const databaseName = 'elite-plus-observation-queue'
const storeName = 'observation_queue'
const metadataStoreName = 'queue_metadata'
const productionSyncReceiptStoreName = 'production_sync_receipts'
const schemaVersion = 8
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

  async saveProductionSyncReceipt(receipt: PersistedProductionSyncReceipt): Promise<void> {
    await this.initialize()
    const transaction = this.database!.transaction(productionSyncReceiptStoreName, 'readwrite')
    transaction.objectStore(productionSyncReceiptStoreName).put(receipt)
    await transactionDone(transaction)
  }

  async loadLatestProductionSyncReceipt(ownerUserId: string): Promise<string | null> {
    await this.initialize()
    const transaction = this.database!.transaction(productionSyncReceiptStoreName, 'readonly')
    const value = await requestResult(transaction.objectStore(productionSyncReceiptStoreName).get(ownerUserId)) as PersistedProductionSyncReceipt | undefined
    await transactionDone(transaction)
    return value?.receiptJson ?? null
  }

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
  async getPayloadJson(ownerUserId: string, observationId: string): Promise<string | null> {
    const row = await this.getRecord(ownerUserId, observationId)
    return row ? JSON.stringify(row.payload) : null
  }
  async updateAcquisitionProvenance(
    ownerUserId: string,
    provenanceByObservationId: ReadonlyMap<string, AcquisitionQueueProvenance>,
  ): Promise<number> {
    if (!provenanceByObservationId.size) return 0
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const index = store.index('ownerObservation')
    let updated = 0
    for (const [observationId, provenance] of provenanceByObservationId) {
      const request = index.get([ownerUserId, observationId])
      request.onsuccess = () => {
        const record = request.result as QueueRecord | undefined
        if (!record) return
        record.acquisitionProvenance = provenance
        store.put(record)
        updated++
      }
    }
    await transactionDone(transaction)
    return updated
  }
  async claimActivityCertification(ownerUserId: string, observationIds: readonly string[], batchId: string): Promise<QueueRecord[]> {
    assertActivityRecoveryIds(observationIds)
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const claimed: QueueRecord[] = []
    const timestamp = nowIso()
    for (const id of observationIds) {
      const request = store.index('ownerObservation').get([ownerUserId, id])
      request.onsuccess = () => {
        const row = request.result as QueueRecord | undefined
        if (!row || !activityTransportClaimable(row)) return
        row.state = 'IN_FLIGHT'
        row.batchId = batchId
        row.updatedAt = timestamp
        row.claimedAt = timestamp
        row.lastAttemptAt = timestamp
        row.attemptCount++
        store.put(row)
        claimed.push(row)
      }
    }
    await transactionDone(transaction)
    return claimed
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
        if (!database.objectStoreNames.contains(productionSyncReceiptStoreName)) {
          database.createObjectStore(productionSyncReceiptStoreName, { keyPath: 'ownerUserId' })
        }
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

  async listDiagnosticRecords(ownerUserId: string): Promise<QueueRecord[]> {
    return this.all(ownerUserId)
  }

  async getPendingComposition(ownerUserId: string, currentV49SyncId: string | null): Promise<PendingQueueComposition> {
    const allRows = await this.all(ownerUserId)
    const records = allRows.filter((record) => record.state === 'PENDING')
    const groupBy = (keyFor: (record: QueueRecord) => string | null | undefined): QueueCompositionGroup[] => {
      const counts = new Map<string, number>()
      for (const record of records) {
        const key = keyFor(record) || '(missing)'
        counts.set(key, (counts.get(key) ?? 0) + 1)
      }
      return [...counts].map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    }
    const pendingOrder = [...records].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.queueId.localeCompare(right.queueId))
    const matchingSync = (record: QueueRecord) => record.acquisitionProvenance?.syncId === currentV49SyncId
    const currentSyncRows = currentV49SyncId === null ? [] : pendingOrder.filter(matchingSync)
    const currentMetricRows = currentSyncRows.filter((record) => {
      const metric = `${record.payload.metric} ${record.payload.metricType ?? ''} ${record.payload.vendorDataType ?? ''}`.toLowerCase()
      return metric.includes('oxygen') || metric.includes('spo2') || metric.includes('temp') ||
        record.payload.vendorDataType === '59' || record.payload.vendorDataType === '68'
    })
    const firstCurrentMetricIndex = currentMetricRows.length
      ? pendingOrder.indexOf(currentMetricRows[0])
      : -1
    const heartRateRowsAhead = firstCurrentMetricIndex < 0 ? null : pendingOrder
      .slice(0, firstCurrentMetricIndex)
      .filter((record) => {
        const metric = `${record.payload.metric} ${record.payload.metricType ?? ''} ${record.payload.vendorDataType ?? ''}`.toLowerCase()
        return metric.includes('heart') || record.payload.vendorDataType === '27' || record.payload.vendorDataType === '82'
      }).length
    const allIds = new Set(allRows.map((record) => record.observationId))
    const attemptCount = { zero: 0, one: 0, two: 0, threePlus: 0 }
    for (const record of records) {
      if (record.attemptCount === 0) attemptCount.zero++
      else if (record.attemptCount === 1) attemptCount.one++
      else if (record.attemptCount === 2) attemptCount.two++
      else attemptCount.threePlus++
    }
    const observed = records.map((record) => record.payload.observedAt ?? record.payload.startTime).filter(Boolean).sort()
    const currentMetricCounts = new Map<string, number>()
    for (const record of currentMetricRows) {
      const key = record.payload.metric || record.payload.metricType || '(missing)'
      currentMetricCounts.set(key, (currentMetricCounts.get(key) ?? 0) + 1)
    }
    return {
      totalPending: records.length,
      byMetric: groupBy((record) => record.payload.metric || record.payload.metricType),
      byVendorDataType: groupBy((record) => record.payload.vendorDataType),
      bySyncId: groupBy((record) => record.acquisitionProvenance?.syncId),
      byAcquisitionId: groupBy((record) => record.acquisitionProvenance?.acquisitionId),
      byRequestedMetric: groupBy((record) => record.acquisitionProvenance?.requestedMetric),
      oldestPendingAt: pendingOrder[0]?.createdAt ?? null,
      newestPendingAt: pendingOrder.at(-1)?.createdAt ?? null,
      oldestObservedAt: observed[0] ?? null,
      newestObservedAt: observed.at(-1) ?? null,
      attemptCount,
      distinctObservationIds: allIds.size,
      duplicateObservationIdRows: allRows.length - allIds.size,
      currentV49SyncId,
      currentV49SyncPending: currentV49SyncId === null ? null : currentSyncRows.length,
      currentV49MetricPending: currentV49SyncId === null ? null : [...currentMetricCounts]
        .map(([key, count]) => ({ key, count }))
        .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key)),
      currentV49FirstPosition: firstCurrentMetricIndex < 0 ? null : firstCurrentMetricIndex + 1,
      currentV49LastPosition: currentMetricRows.length
        ? pendingOrder.indexOf(currentMetricRows[currentMetricRows.length - 1]) + 1
        : null,
      currentV49RowsAhead: firstCurrentMetricIndex < 0 ? null : firstCurrentMetricIndex,
      heartRateRowsAheadCurrentV49: heartRateRowsAhead,
      priorSyncPending: currentV49SyncId === null ? null : records.length - currentSyncRows.length,
    }
  }

  async enqueue(ownerUserId: string, observation: NativeObservationInput, sourceEnvelopeId?: string, provenance?: AcquisitionQueueProvenance): Promise<EnqueueResult> {
    return (await this.enqueueMany(
      ownerUserId,
      [observation],
      sourceEnvelopeId === undefined ? undefined : new Map([[observation.observationId, sourceEnvelopeId]]),
      provenance === undefined ? undefined : new Map([[observation.observationId, provenance]]),
    ))[0]
  }

  async enqueueMany(
    ownerUserId: string,
    observations: NativeObservationInput[],
    sourceEnvelopeIds?: ReadonlyMap<string, string>,
    provenanceByObservationId?: ReadonlyMap<string, AcquisitionQueueProvenance>,
  ): Promise<EnqueueResult[]> {
    if (!observations.length) return []
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const queue = transaction.objectStore(storeName)
    const index = queue.index('ownerObservation')
    const results: EnqueueResult[] = []
    const seen = new Map<string, QueueRecord>()
    for (const observation of observations) {
      const sourceEnvelopeId = sourceEnvelopeIds?.get(observation.observationId)
      const acquisitionProvenance = provenanceByObservationId?.get(observation.observationId)
      const existing = seen.get(observation.observationId) ?? (await requestResult(index.get([ownerUserId, observation.observationId])) as QueueRecord | undefined)
      if (existing) {
        if (existing.sourceEnvelopeId === undefined && sourceEnvelopeId !== undefined) {
          existing.sourceEnvelopeId = sourceEnvelopeId
          queue.put(existing)
        }
        seen.set(observation.observationId, existing)
        results.push({ inserted: false, alreadyQueued: true, record: existing })
        continue
      }
      // Strictly increasing so the createdAt index preserves FIFO order for same-millisecond inserts.
      this.lastCreatedMs = Math.max(Date.now(), this.lastCreatedMs + 1)
      const timestamp = new Date(this.lastCreatedMs).toISOString()
      const record: QueueRecord = {
        queueId: createId(), ownerUserId, observationId: observation.observationId,
        ...(sourceEnvelopeId === undefined ? {} : { sourceEnvelopeId }),
        ...(acquisitionProvenance === undefined ? {} : { acquisitionProvenance }),
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
  async claimPending(ownerUserId: string, limit: number, batchId: string, now = new Date(), observationIds?: readonly string[], ignoreRetryBackoff = false): Promise<QueueRecord[]> {
    await this.initialize()
    if (observationIds?.length === 0) return []
    const selected = observationIds ? new Set(observationIds) : null
    const claimLimit = Math.max(0, Math.min(MAX_QUEUE_CLAIM, Math.floor(limit)))
    if (claimLimit === 0) return []
    const nowIsoValue = now.toISOString()
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const index = store.index('ownerCreated')
    const claimed: QueueRecord[] = []
    if (selected) {
      for (const id of selected) {
        const request = store.index('ownerObservation').get([ownerUserId, id])
        request.onsuccess = () => {
          const record = request.result as QueueRecord | undefined
          if (!record || claimed.length >= claimLimit || (record.state !== 'PENDING' && record.state !== 'RETRY_WAIT')
            || (!ignoreRetryBackoff && record.nextAttemptAt && record.nextAttemptAt > nowIsoValue)) return
          record.state = 'IN_FLIGHT'
          record.batchId = batchId
          record.updatedAt = nowIsoValue
          record.claimedAt = nowIsoValue
          record.lastAttemptAt = nowIsoValue
          record.attemptCount++
          store.put(record)
          claimed.push({ ...record })
        }
      }
      await transactionDone(transaction)
      return claimed
    }
    const request = index.openCursor(IDBKeyRange.bound([ownerUserId, ''], [ownerUserId, '\uffff']))
    request.onsuccess = () => {
      const cursor = request.result
      if (!cursor || claimed.length >= claimLimit) return
      const record = cursor.value as QueueRecord
      if ((record.state === 'PENDING' || record.state === 'RETRY_WAIT') && (!record.nextAttemptAt || record.nextAttemptAt <= nowIsoValue)
        && !(record.payload.rawSourceMetadata?.certificationOnly === true && ['24', '25'].includes(record.payload.vendorDataType ?? ''))) {
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

  async claimPendingByObservationIds(
    ownerUserId: string,
    observationIds: readonly string[],
    batchId: string,
    now = new Date(),
  ): Promise<QueueRecord[]> {
    if (observationIds.length !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT
      || new Set(observationIds).size !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT) {
      throw new Error(`SCOPED_ACTIVITY_E2E_IDS_INVALID: exactly ${SCOPED_ACTIVITY_E2E_CLAIM_COUNT} unique IDs are required.`)
    }
    await this.initialize()
    const transaction = this.database!.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const index = store.index('ownerObservation')
    const timestamp = now.toISOString()
    const rows: Array<QueueRecord | undefined> = Array(observationIds.length)
    let validationError: Error | null = null
    let completed = 0
    observationIds.forEach((id, position) => {
      const request = index.get([ownerUserId, id])
      request.onsuccess = () => {
        rows[position] = request.result as QueueRecord | undefined
        completed++
        if (completed !== observationIds.length) return
        if (rows.some((row) => !row || row.ownerUserId !== ownerUserId || row.state !== 'PENDING')) {
          validationError = new Error('SCOPED_ACTIVITY_E2E_CLAIM_FAILED: every requested row must exist for this owner and be PENDING.')
          transaction.abort()
          return
        }
        for (const row of rows as QueueRecord[]) {
          row.state = 'IN_FLIGHT'
          row.batchId = batchId
          row.updatedAt = timestamp
          row.claimedAt = timestamp
          row.lastAttemptAt = timestamp
          row.attemptCount++
          store.put(row)
        }
      }
    })
    try {
      await transactionDone(transaction)
    } catch (error) {
      if (validationError) throw validationError
      throw error
    }
    const claimed = rows as QueueRecord[]
    const requested = new Set(observationIds)
    if (claimed.length !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT
      || claimed.some((record) => record.ownerUserId !== ownerUserId || record.state !== 'IN_FLIGHT'
        || record.batchId !== batchId || !requested.has(record.observationId))
      || new Set(claimed.map((record) => record.observationId)).size !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT) {
      throw new Error('SCOPED_ACTIVITY_E2E_CLAIM_READBACK_FAILED: claim did not match the exact requested set.')
    }
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
    const inFlight = records.filter((record) => record.state === 'IN_FLIGHT' && record.claimedAt)
    const oldestInFlightAgeMs = inFlight.length
      ? now.getTime() - inFlight.reduce((oldest, record) => Math.min(oldest, Date.parse(record.claimedAt!)), Number.POSITIVE_INFINITY)
      : null
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
    return { pending: pending.length, retrying: records.filter((record) => record.state === 'RETRY_WAIT').length, failed: records.filter((record) => record.state === 'FAILED_PERMANENT').length, inFlight: inFlight.length, acknowledged: records.filter((record) => record.state === 'ACKNOWLEDGED').length, oldestPendingAgeMs, oldestInFlightAgeMs, lastAttemptAt: records.map((record) => record.lastAttemptAt).filter(Boolean).sort().at(-1) ?? null, lastSuccessfulUploadAt: metadata?.lastSuccessfulUploadAt ?? records.map((record) => record.acknowledgedAt).filter(Boolean).sort().at(-1) ?? null, warnings, canonicalRecoveryRequired: canonicalRecovery.length > 0 || metadataRecovery, canonicalRecoveryObservationCount: Math.max(canonicalRecovery.length, metadata?.canonicalRecoveryObservationCount ?? 0), canonicalRecoveryBatchCount: recoveryBatchIds.size, lastCanonicalFailureBatchId: recoveryBatches[0]?.batchId ?? null, lastCanonicalFailureAt: recoveryBatches[0]?.lastFailureAt ?? metadata?.canonicalRecoveryAt ?? null }
  }

  async getOldestPendingAge(ownerUserId: string, now = new Date()): Promise<number | null> { return (await this.getQueueStats(ownerUserId, now)).oldestPendingAgeMs }

  async purgeAcknowledged(ownerUserId: string, observationIds?: readonly string[]): Promise<number> {
    const selected = observationIds ? new Set(observationIds) : null
    const records = (await this.all(ownerUserId)).filter((record) => record.state === 'ACKNOWLEDGED' && (!selected || selected.has(record.observationId)))
    const transaction = this.database!.transaction(storeName, 'readwrite'); const queue = transaction.objectStore(storeName)
    records.forEach((record) => queue.delete(record.queueId)); await transactionDone(transaction); return records.length
  }
}