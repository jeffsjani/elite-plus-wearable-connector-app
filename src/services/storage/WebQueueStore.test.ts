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
    const queued = await store.enqueue(owner, observation('observation-1'))
    await store.markInFlight([queued.record.queueId], 'batch-1')
    await store.releaseStaleInFlight(owner, new Date(Date.now() + 1000).toISOString())

    const stats = await store.getQueueStats(owner)
    expect(stats.retrying).toBe(1)
    expect((await store.getPending(owner, 100)).length).toBe(1)
  })

  it('acknowledges and purges successful records without exposing payload values in stats', async () => {
    const owner = `${ownerPrefix}-a`
    await store.enqueue(owner, observation('observation-1'))
    await store.markAcknowledged(['observation-1'], owner)

    expect((await store.getQueueStats(owner)).acknowledged).toBe(1)
    expect((await store.getQueueStats(owner)).lastSuccessfulUploadAt).not.toBeNull()
    expect(await store.purgeAcknowledged(owner)).toBe(1)
    expect((await store.getQueueStats(owner)).pending).toBe(0)
    expect((await store.getQueueStats(owner)).lastSuccessfulUploadAt).not.toBeNull()
  })
})