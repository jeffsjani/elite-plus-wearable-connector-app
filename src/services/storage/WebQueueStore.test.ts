import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
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