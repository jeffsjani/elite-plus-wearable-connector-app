import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeObservationInput } from '../base44/base44Types'
import { WebQueueStore } from './WebQueueStore'

function observation(observationId: string): NativeObservationInput {
  return { observationId, source: 'connector_test', metric: 'queue_test', valueNumber: 1, unit: 'count', startTime: new Date().toISOString(), timezone: 'UTC', capturedAt: new Date().toISOString(), provider: 'elite_connector' }
}

describe('WebQueueStore', () => {
  let store: WebQueueStore
  let ownerPrefix: string

  beforeEach(async () => {
    ownerPrefix = `user-${Date.now()}-${Math.random()}`
    store = new WebQueueStore()
    await store.initialize()
  })

  it('persists records and makes duplicate enqueue idempotent', async () => {
    const first = await store.enqueue(`${ownerPrefix}-a`, observation('observation-1'))
    const second = await store.enqueue(`${ownerPrefix}-a`, observation('observation-1'))

    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.alreadyQueued).toBe(true)
    expect((await store.getPending(`${ownerPrefix}-a`, 100)).length).toBe(1)
  })

  it('persists local-only first associations across restart and isolates the same ID by owner', async () => {
    const owner = `${ownerPrefix}-a`
    const payload = observation('linked')
    const first = await store.enqueue(owner, payload, 'envelope-first')
    expect(await store.enqueue(owner, { ...payload, valueNumber: 999 }, 'envelope-later')).toEqual({
      inserted: false, alreadyQueued: true, record: first.record,
    })
    await store.enqueue(`${ownerPrefix}-b`, payload, 'envelope-other-owner')
    const unlinked = await store.enqueue(owner, observation('legacy'))
    const [associated] = await store.enqueueMany(owner, [observation('legacy')], new Map([['legacy', 'envelope-backfill']]))
    expect(associated.record).toEqual({ ...unlinked.record, sourceEnvelopeId: 'envelope-backfill' })
    const [bulk] = await store.enqueueMany(owner, [observation('bulk')], new Map([['bulk', 'envelope-bulk']]))
    expect(bulk.record.sourceEnvelopeId).toBe('envelope-bulk')
    expect((await store.enqueue(owner, observation('legacy'), 'envelope-ignored')).record).toEqual(associated.record)

    const reopened = new WebQueueStore()
    expect(reopened.getSchemaVersion()).toBeNull()
    expect(await reopened.getRecord(owner, payload.observationId)).toEqual(first.record)
    expect(reopened.getSchemaVersion()).toBe(8)
    expect((await reopened.getRecord(`${ownerPrefix}-b`, payload.observationId))?.sourceEnvelopeId).toBe('envelope-other-owner')
    const [claim] = await reopened.claimPending(owner, 1, 'linked-batch')
    expect(claim.sourceEnvelopeId).toBe('envelope-first')
    expect(claim.payload).toEqual(payload)
    expect(claim.payload).not.toHaveProperty('sourceEnvelopeId')
    await reopened.acknowledgeClaims([{ queueId: claim.queueId, batchId: claim.batchId!, attemptCount: claim.attemptCount }], owner)
    await reopened.purgeAcknowledged(owner)
    expect(await reopened.getRecord(owner, payload.observationId)).toBeNull()
    expect((await reopened.getRecord(`${ownerPrefix}-b`, payload.observationId))?.sourceEnvelopeId).toBe('envelope-other-owner')
  })

  it('persists acquisition lineage across claim, retry, and store reopen without adding it to the payload', async () => {
    const owner = `${ownerPrefix}-provenance`
    const payload = observation('provenance-row')
    const provenance = {
      syncId: 'sync-1', acquisitionId: 'acq-1', acquisitionRequestId: 'request-1',
      requestedMetric: 'oxygenSaturation', connectionGeneration: 9,
      acquisitionStartedAt: '2026-10-15T12:00:00.000Z', acquisitionCompletedAt: null,
      clientQueuedAt: '2026-10-15T12:01:00.000Z',
    }
    const inserted = await store.enqueue(owner, payload, undefined, provenance)
    const [claimed] = await store.claimPending(owner, 1, 'batch-1')
    expect(claimed.acquisitionProvenance).toEqual(provenance)
    expect(claimed.payload).not.toHaveProperty('acquisitionProvenance')
    await store.retryClaims([{ queueId: claimed.queueId, batchId: 'batch-1', attemptCount: claimed.attemptCount }],
      { code: 'NETWORK_ERROR', message: 'offline' }, new Date(Date.now() + 1_000).toISOString())

    const reopened = new WebQueueStore()
    expect(await reopened.getRecord(owner, payload.observationId)).toMatchObject({
      queueId: inserted.record.queueId, state: 'RETRY_WAIT', acquisitionProvenance: provenance, payload,
    })
  })

  it('persists the complete production receipt exactly across store reopen', async () => {
    const owner = `${ownerPrefix}-receipt-restart`
    const receipt = {
      schema: 'elite-plus.v8-production-sync-receipt.v2',
      syncId: 'sync-restart-1',
      requestedMetrics: ['oxygenSaturation', 'wearableTemperature'],
      sources: [{
        metric: 'oxygenSaturation',
        vendorDataType: '68',
        requested: true,
        status: 'NO_DATA',
        bridgeInvoked: true,
        nativeRequestAccepted: true,
        nativeCommandQueued: true,
        nativeCommandWritten: true,
        callbackReceived: true,
        nativeCompletionStatus: 'EMPTY_VALID',
        sourceRecordCount: 0,
        observationCount: 0,
        mappedCount: 0,
        deduplicatedCount: 0,
        queuedCount: 0,
        deliveryPendingCount: 0,
        deliveredCount: 0,
        ackedCount: 0,
        duplicateAckedCount: 0,
        failedCount: 0,
        syncId: 'sync-restart-1',
        acquisitionId: 'acq-spo2-1',
        acquisitionRequestId: 'native-request-spo2-1',
        connectionGeneration: 17,
        acquisitionStartedAt: '2026-10-15T12:00:00.000Z',
        acquisitionCompletedAt: '2026-10-15T12:00:03.000Z',
        clientQueuedAt: null,
        errorCode: null,
        errorMessage: null,
        startedAt: '2026-10-15T12:00:00.000Z',
        completedAt: '2026-10-15T12:00:03.000Z',
      }],
    }
    const receiptJson = JSON.stringify(receipt)
    await store.saveProductionSyncReceipt({
      ownerUserId: owner,
      syncId: receipt.syncId,
      startedAt: '2026-10-15T12:00:00.000Z',
      completedAt: '2026-10-15T12:00:03.000Z',
      overallState: 'UP_TO_DATE',
      requestedMetricsJson: JSON.stringify(receipt.requestedMetrics),
      receiptJson,
    })

    const reopened = new WebQueueStore()
    await reopened.initialize()
    expect(await reopened.loadLatestProductionSyncReceipt(owner)).toBe(receiptJson)
    expect(JSON.parse((await reopened.loadLatestProductionSyncReceipt(owner))!)).toEqual(receipt)
  })

  it('upgrades v5 without rewriting 10,000 existing IDs, payloads, or delivery states', async () => {
    const factory = new IDBFactory()
    const priorDatabase = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(store.databaseName, 5)
      request.onupgradeneeded = () => {
        const queue = request.result.createObjectStore('observation_queue', { keyPath: 'queueId' })
        queue.createIndex('ownerObservation', ['ownerUserId', 'observationId'], { unique: true })
        queue.createIndex('ownerCreated', ['ownerUserId', 'createdAt'])
      }
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    const template = (await store.enqueue(`${ownerPrefix}-template`, observation('template'))).record
    const rows = Array.from({ length: 10_000 }, (_, index) => ({
      ...template, queueId: `legacy-queue-${index}`, observationId: `legacy-observation-${index}`,
      payload: observation(`legacy-observation-${index}`),
      state: (['PENDING', 'IN_FLIGHT', 'RETRY_WAIT', 'ACKNOWLEDGED', 'FAILED_PERMANENT'] as const)[index % 5],
    }))
    const write = priorDatabase.transaction('observation_queue', 'readwrite')
    rows.forEach((row) => write.objectStore('observation_queue').add(row))
    await new Promise<void>((resolve, reject) => { write.oncomplete = () => resolve(); write.onerror = () => reject(write.error) })
    priorDatabase.close()
    vi.stubGlobal('indexedDB', factory)
    try {
      const upgraded = new WebQueueStore()
      await upgraded.initialize()
      expect(upgraded.getSchemaVersion()).toBe(8)
      const database = await new Promise<IDBDatabase>((resolve) => {
        const request = factory.open(store.databaseName, 8)
        request.onsuccess = () => resolve(request.result)
      })
      const read = database.transaction('observation_queue', 'readonly').objectStore('observation_queue').getAll()
      const persisted = await new Promise<typeof rows>((resolve, reject) => {
        read.onsuccess = () => resolve(read.result)
        read.onerror = () => reject(read.error)
      })
      expect(persisted).toEqual([...rows].sort((a, b) => a.queueId.localeCompare(b.queueId)))
      expect((await upgraded.getRecord(template.ownerUserId, rows[0].observationId))?.sourceEnvelopeId).toBeUndefined()
      database.close()
    } finally {
      vi.unstubAllGlobals()
    }
  }, 15_000)

  it('claims only supplied exact IDs atomically and purges only their acknowledged rows', async () => {
    const owner = `${ownerPrefix}-targeted`
    await store.enqueueMany(owner, Array.from({ length: 100 }, (_, index) => observation(`hr-${index}`)))
    await store.enqueueMany(owner, [observation('spo2-1'), observation('spo2-2')])
    const before = await Promise.all(Array.from({ length: 100 }, (_, index) => store.getRecord(owner, `hr-${index}`)))
    const first = await store.claimPending(owner, 100, 'cert-1', new Date(), ['spo2-1', 'spo2-2'])
    const second = await store.claimPending(owner, 100, 'cert-2', new Date(), ['spo2-1', 'spo2-2'])
    expect(first.map((row) => row.observationId)).toEqual(['spo2-1', 'spo2-2'])
    expect(second).toEqual([])
    await store.acknowledgeClaims(first.map((row) => ({ queueId: row.queueId, batchId: row.batchId!, attemptCount: row.attemptCount })), owner)
    await store.purgeAcknowledged(owner, ['spo2-1'])
    expect(await store.getRecord(owner, 'spo2-1')).toBeNull()
    expect((await store.getRecord(owner, 'spo2-2'))?.state).toBe('ACKNOWLEDGED')
    expect(await Promise.all(Array.from({ length: 100 }, (_, index) => store.getRecord(owner, `hr-${index}`)))).toEqual(before)
    expect(await store.claimPending(owner, 100, 'empty', new Date(), [])).toEqual([])
  })

  it('explicit exact-ID retry bypasses backoff without releasing other rows or in-flight claims', async () => {
    const owner = `${ownerPrefix}-resume`
    await store.enqueueMany(owner, [observation('selected'), observation('other')])
    const first = await store.claimPending(owner, 100, 'first')
    await store.retryClaims(first.map((row) => ({ queueId: row.queueId, batchId: 'first', attemptCount: row.attemptCount })),
      { code: 'ACK_PROCESSING_FAILED', message: 'retry' }, new Date(Date.now() + 60_000).toISOString())
    expect(await store.claimPending(owner, 100, 'automatic')).toEqual([])
    const selected = await store.claimPending(owner, 100, 'manual', new Date(), ['selected'], true)
    expect(selected.map((row) => row.observationId)).toEqual(['selected'])
    expect((await store.getRecord(owner, 'other'))?.state).toBe('RETRY_WAIT')
    expect(await store.claimPending(owner, 100, 'concurrent', new Date(), ['selected'])).toEqual([])
  })

  it('ordinary web claims skip Activity certification but still claim unrelated observations', async () => {
    const owner = `${ownerPrefix}-activity`
    const activity = { ...observation('saved-activity'), vendorDataType: '25', rawSourceMetadata: { certificationOnly: true } }
    await store.enqueueMany(owner, [activity, observation('ordinary')])
    expect((await store.claimPending(owner, 100, 'ordinary-batch')).map((row) => row.observationId)).toEqual(['ordinary'])
    expect((await store.getRecord(owner, activity.observationId))?.state).toBe('PENDING')
    expect((await store.claimPending(owner, 100, 'resume', new Date(), [activity.observationId])).map((row) => row.observationId)).toEqual([activity.observationId])
  })

  it('isolates owners and preserves restart-readable rows', async () => {
    await store.enqueueMany(`${ownerPrefix}-a`, [observation('a-1'), observation('a-2')])
    await store.enqueue(`${ownerPrefix}-b`, observation('b-1'))

    const reopened = new WebQueueStore()
    expect((await reopened.getPending(`${ownerPrefix}-a`, 100)).map((record) => record.observationId)).toEqual(['a-1', 'a-2'])
    expect((await reopened.getPending(`${ownerPrefix}-b`, 100)).map((record) => record.observationId)).toEqual(['b-1'])
  })

  it('recovers stale in-flight rows and tracks queue metadata', async () => {
    const owner = `${ownerPrefix}-a`
    await store.enqueue(owner, observation('observation-1'))
    const claims = await store.claimPending(owner, 100, 'batch-1')
    expect(claims).toHaveLength(1)
    await store.releaseStaleInFlight(owner, new Date(Date.now() + 1000).toISOString())

    const stats = await store.getQueueStats(owner)
    expect(stats.retrying).toBe(1)
    expect((await store.getPending(owner, 100)).length).toBe(1)
  })

  it('finds the next persisted retry without loading acknowledged or pending payloads', async () => {
    const owner = `${ownerPrefix}-a`
    await store.enqueue(owner, observation('observation-1'))
    const [claim] = await store.claimPending(owner, 100, 'batch-1')
    const nextAttemptAt = new Date(Date.now() + 60_000).toISOString()
    await store.retryClaims([{ queueId: claim.queueId, batchId: 'batch-1', attemptCount: claim.attemptCount }], { code: 'TIMEOUT', message: 't' }, nextAttemptAt)

    expect(await store.getNextRetryAt(owner)).toBe(nextAttemptAt)
    expect(await store.getNextRetryAt(owner, new Date(Date.now() + 120_000))).toBeNull()
  })

  it('persists canonical recovery separately from ordinary retry and protects it from stale acknowledgements', async () => {
    const owner = `${ownerPrefix}-a`
    const inserted = await store.enqueue(owner, observation('observation-canonical-failed'))
    const [claim] = await store.claimPending(owner, 100, 'canonical-batch')
    const canonicalFailureAt = new Date().toISOString()
    expect(await store.markCanonicalRecoveryRequired([{
      queueId: claim.queueId,
      batchId: claim.batchId!,
      attemptCount: claim.attemptCount,
      nativeObservationId: 'native-row-id',
      canonicalFailureAt,
    }], owner, { code: 'CANONICAL_FAILURE', message: 'server recovery required' })).toBe(1)
    expect(await store.acknowledgeClaims([{ queueId: claim.queueId, batchId: claim.batchId!, attemptCount: claim.attemptCount }], owner)).toBe(0)

    const reopened = new WebQueueStore()
    const record = await reopened.getRecord(owner, inserted.record.observationId)
    expect(record).toMatchObject({
      observationId: inserted.record.observationId,
      payload: inserted.record.payload,
      state: 'CANONICAL_RECOVERY_REQUIRED',
      batchId: 'canonical-batch',
      nativeObservationId: 'native-row-id',
      canonicalFailureAt,
    })
    expect(await reopened.getQueueStats(owner)).toMatchObject({
      pending: 0, retrying: 0, failed: 0, inFlight: 0,
      canonicalRecoveryObservationCount: 1,
      canonicalRecoveryBatchCount: 1,
      lastCanonicalFailureBatchId: 'canonical-batch',
      lastCanonicalFailureAt: canonicalFailureAt,
    })
    expect(await reopened.getCanonicalRecoveryBatches(owner, 10)).toEqual([
      { batchId: 'canonical-batch', observationCount: 1, lastFailureAt: canonicalFailureAt },
    ])
  })

  it('persists a queue-level canonical pause when a response failure has no identifiable row', async () => {
    const owner = `${ownerPrefix}-metadata-only`
    const failureAt = new Date().toISOString()
    await store.recordCanonicalRecoveryPause(owner, 'unattributed-canonical-batch', 3, failureAt)

    const reopened = new WebQueueStore()
    expect(await reopened.getQueueStats(owner)).toMatchObject({
      canonicalRecoveryRequired: true,
      canonicalRecoveryObservationCount: 3,
      canonicalRecoveryBatchCount: 1,
      lastCanonicalFailureBatchId: 'unattributed-canonical-batch',
      lastCanonicalFailureAt: failureAt,
    })
    expect(await reopened.getCanonicalRecoveryBatches(owner, 10)).toEqual([
      { batchId: 'unattributed-canonical-batch', observationCount: 3, lastFailureAt: failureAt },
    ])
  })

  it('acknowledges and purges successful records without exposing payload values in stats', async () => {
    const owner = `${ownerPrefix}-a`
    await store.enqueue(owner, observation('observation-1'))
    const [claim] = await store.claimPending(owner, 100, 'batch-1')
    expect(await store.acknowledgeClaims([{ queueId: claim.queueId, batchId: 'batch-1', attemptCount: claim.attemptCount }], owner)).toBe(1)

    expect((await store.getQueueStats(owner)).acknowledged).toBe(1)
    expect((await store.getQueueStats(owner)).lastSuccessfulUploadAt).not.toBeNull()
    expect(await store.purgeAcknowledged(owner)).toBe(1)
    expect((await store.getQueueStats(owner)).pending).toBe(0)
    expect((await store.getQueueStats(owner)).lastSuccessfulUploadAt).not.toBeNull()
  })
})