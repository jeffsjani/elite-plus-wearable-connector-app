import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticationService } from '../base44/AuthenticationService'
import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import { ConnectorServiceError, type ConnectorObservationsRequest, type ConnectorObservationsResponse } from '../base44/base44Types'
import { ObservationBatchManager, MAX_CONCURRENCY } from './ObservationBatchManager'
import { observationQueue } from './ObservationQueue'
import { WebQueueStore } from '../storage/WebQueueStore'
import type { NetworkStatus } from './NetworkStatus'
import { createSyntheticObservations } from '../testing/SyntheticObservationFactory'
import { JCVitalPhysiologyDelivery } from '../../adapters/jcvital/PhysiologyDelivery'
import type { QueueRecord } from '../storage/ObservationQueueStore'

class TestStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const online: NetworkStatus = { isOnline: () => true, subscribe: () => () => undefined }

/** Idempotent stand-in for nativeConnectorObservations keyed by observationId; also records every batch's
 *  observation ids so tests can assert no two concurrent requests ever shared a claimed row. */
class FakeBackend {
  readonly stored = new Set<string>()
  readonly batches: string[][] = []
  calls = 0
  async accept(request: ConnectorObservationsRequest, delayMs = 0): Promise<ConnectorObservationsResponse> {
    this.calls++
    this.batches.push(request.observations.map((o) => o.observationId))
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs))
    let accepted = 0
    let duplicate = 0
    const results = request.observations.map((observation) => {
      if (this.stored.has(observation.observationId)) { duplicate++; return { observationId: observation.observationId, status: 'duplicate' as const, reason: null, errorCode: null, canonicalStatus: 'not_applicable' as const, nativeObservationId: null } }
      this.stored.add(observation.observationId)
      accepted++
      return { observationId: observation.observationId, status: 'accepted' as const, reason: null, errorCode: null, canonicalStatus: 'canonicalized' as const, nativeObservationId: `n-${observation.observationId.slice(0, 8)}` }
    })
    return { success: true, batchId: request.batchId, accepted, duplicate, rejected: 0, errors: [], serverTimestamp: new Date().toISOString(), results }
  }
}

let owner = ''
let counter = 0

async function enqueue(count: number): Promise<string[]> {
  // Sender tests bulk-seed durable fixtures; enqueue persistence is exercised by ObservationQueue tests.
  return (await seedDurableRows(count)).map((record) => record.observationId)
}

async function seedDurableRows(count: number): Promise<QueueRecord[]> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open('elite-plus-observation-queue')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  const transaction = database.transaction('observation_queue', 'readwrite')
  const queue = transaction.objectStore('observation_queue')
  const now = Date.now()
  const records = createSyntheticObservations(count).map((payload, index): QueueRecord => {
    const timestamp = new Date(now + index).toISOString()
    return {
      queueId: `durable-${owner}-${index}`,
      ownerUserId: owner,
      observationId: payload.observationId,
      payload,
      state: 'PENDING',
      createdAt: timestamp,
      updatedAt: timestamp,
      claimedAt: null,
      attemptCount: 0,
      nextAttemptAt: null,
      lastAttemptAt: null,
      lastErrorCode: null,
      lastErrorMessage: null,
      batchId: null,
      acknowledgedAt: null,
      nativeObservationId: null,
      canonicalFailureAt: null,
    }
  })
  records.forEach((record) => queue.add(record))
  try {
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error)
      transaction.onabort = () => reject(transaction.error)
    })
  } finally {
    database.close()
  }
  return records
}

function submitSpy() { return vi.spyOn(connectorObservationService, 'submitObservations') }

/** Drains the queue by repeatedly invoking process() until nothing is left pending/in-flight/retrying. */
async function drainFully(manager: ObservationBatchManager, maxRounds = 200): Promise<void> {
  for (let round = 0; round < maxRounds; round++) {
    await manager.process()
    const stats = await observationQueue.getQueueStats()
    if (stats.pending === 0 && stats.inFlight === 0 && stats.retrying === 0) return
  }
  throw new Error('drainFully did not converge')
}

describe('ObservationBatchManager throughput and concurrency (Build 5B-1 section 4-10)', () => {
  beforeEach(async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    owner = `throughput-${Date.now()}-${counter++}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('elite-plus-observation-queue')
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    try {
      const stores = [...database.objectStoreNames]
      const transaction = database.transaction(stores, 'readwrite')
      for (const store of stores) transaction.objectStore(store).clear()
      await new Promise<void>((resolve, reject) => {
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error)
        transaction.onabort = () => reject(transaction.error)
      })
    } finally {
      database.close()
    }
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  for (const batchSize of [100]) {
    it(`batch ${batchSize} / concurrency 1 claims exactly one batch and matches results[] + acknowledgements exactly`, async () => {
      const ids = await enqueue(batchSize)
      const backend = new FakeBackend()
      submitSpy().mockImplementation(async (request) => backend.accept(request))
      const manager = new ObservationBatchManager({ batchSize, concurrency: 1 }, online)

      const response = await manager.process()

      expect(response?.accepted).toBe(batchSize)
      expect(response?.results).toHaveLength(batchSize)
      expect(backend.batches).toHaveLength(1)
      expect(backend.batches[0].sort()).toEqual([...ids].sort())
      expect(manager.getDeliveryDiagnostics().batchesPerMinute).toBeGreaterThan(0)
      expect(manager.getDeliveryDiagnostics().averageBatchLatencyMs).not.toBeNull()
      const stats = await observationQueue.getQueueStats()
      expect([stats.pending, stats.inFlight, stats.retrying, stats.failed]).toEqual([0, 0, 0, 0])
    }, 15_000)
  }

  it('batch 100 / requested concurrency 2 drains without overlapping claims', async () => {
    const ids = await enqueue(300)
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request, 5))
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 2 }, online)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })

    await Promise.all([manager.process(), manager.process()])
    await drainFully(manager)

    expect(backend.batches.length).toBeGreaterThanOrEqual(3)
    const seen = new Set<string>()
    for (const batch of backend.batches) {
      for (const id of batch) { expect(seen.has(id)).toBe(false); seen.add(id) }
    }
    expect([...seen].sort()).toEqual([...ids].sort())
    const stats = await observationQueue.getQueueStats()
    expect([stats.pending, stats.inFlight, stats.retrying, stats.failed]).toEqual([0, 0, 0, 0])
  })

  it('requested concurrency 2 remains single-worker and honors the production 100-row batch limit', async () => {
    const ids = await enqueue(750)
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request, 5))
    const manager = new ObservationBatchManager({ batchSize: 500, concurrency: 2 }, online)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })

    await Promise.all([manager.process(), manager.process(), manager.process()])
    await drainFully(manager)

    const seen = new Set<string>()
    for (const batch of backend.batches) for (const id of batch) { expect(seen.has(id)).toBe(false); seen.add(id) }
    expect([...seen].sort()).toEqual([...ids].sort())
    expect(backend.batches.every((batch) => batch.length <= 100)).toBe(true)
  }, 15_000)

  it('requested concurrency 3 remains single-worker and claims no overlapping rows', async () => {
    const ids = await enqueue(1000)
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request, 5))
    const manager = new ObservationBatchManager({ batchSize: 250, concurrency: 3 }, online)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })
    expect(MAX_CONCURRENCY).toBe(1)

    await Promise.all([manager.process(), manager.process(), manager.process(), manager.process()])
    await drainFully(manager)

    const seen = new Set<string>()
    for (const batch of backend.batches) for (const id of batch) { expect(seen.has(id)).toBe(false); seen.add(id) }
    expect([...seen].sort()).toEqual([...ids].sort())
    expect(backend.batches.every((batch) => batch.length <= 100)).toBe(true)
  }, 30_000)

  it.each([1, 2, 3, 4, 5, 10])('ten simultaneous process calls at requested concurrency %i never create worker two', async (concurrency) => {
    const ids = await enqueue(300)
    const backend = new FakeBackend()
    let active = 0
    let peakActive = 0
    let markRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
    let releaseRequest!: () => void
    const requestReleased = new Promise<void>((resolve) => { releaseRequest = resolve })
    submitSpy().mockImplementation(async (request) => {
      active++
      peakActive = Math.max(peakActive, active)
      markRequestStarted()
      await requestReleased
      const response = await backend.accept(request)
      active--
      return response
    })
    const manager = new ObservationBatchManager({ concurrency }, online)

    const primary = manager.process()
    await requestStarted
    await Promise.all(Array.from({ length: 10 }, () => manager.process()))
    expect(peakActive).toBe(1)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1, activeWorkerCount: 1 })
    expect(manager.getDeliveryDiagnostics().activeBatches).toHaveLength(1)
    expect(backend.batches).toHaveLength(0)
    releaseRequest()
    await primary
    expect(backend.batches).toHaveLength(1)
    expect(backend.batches[0].every((id) => ids.includes(id))).toBe(true)
  }, 20_000)

  it('defaults to one worker and clamps requested concurrency 1 through 4 to one', async () => {
    expect(new ObservationBatchManager({}, online).getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })
    for (const concurrency of [1, 2, 3, 4, 5, 10]) {
      expect(new ObservationBatchManager({ concurrency }, online).getDeliveryDiagnostics()).toMatchObject({
        configuredConcurrency: 1,
        effectiveConcurrency: 1,
      })
    }
    expect(MAX_CONCURRENCY).toBe(1)
  })

  it.each([5, 6, 10, 99])('clamps requested concurrency %i to one and reports a warning', async (concurrency) => {
    expect(new ObservationBatchManager({ concurrency }, online).getDeliveryDiagnostics()).toMatchObject({
      configuredConcurrency: 1,
      effectiveConcurrency: 1,
      configWarning: expect.stringContaining(`Requested concurrency ${concurrency} was clamped to the release maximum of 1`),
    })
  })

  it('mixed accepted/duplicate results under concurrency are applied to the correct rows', async () => {
    const ids = await enqueue(200)
    const backend = new FakeBackend()
    // Pre-seed half the ids as already delivered server-side to force DELIVERED_DUPLICATE outcomes.
    ids.slice(0, 100).forEach((id) => backend.stored.add(id))
    submitSpy().mockImplementation(async (request) => backend.accept(request))
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 2 }, online)

    await Promise.all([manager.process(), manager.process()])
    await drainFully(manager)

    const totalAccepted = backend.batches.flat().filter((id) => !ids.slice(0, 100).includes(id)).length
    expect(totalAccepted).toBe(100)
    const stats = await observationQueue.getQueueStats()
    expect([stats.pending, stats.inFlight, stats.retrying, stats.failed]).toEqual([0, 0, 0, 0])
  })

  it('retry safety under concurrency: a failed batch is released back to RETRY_WAIT and later delivered exactly once', async () => {
    const ids = await enqueue(200)
    const backend = new FakeBackend()
    let call = 0
    submitSpy().mockImplementation(async (request) => {
      call++
      if (call === 1) throw new Error('simulated transient network failure')
      return backend.accept(request)
    })
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 2, retryBaseMs: 0, retryMaxMs: 0 }, online)

    await Promise.all([manager.process(), manager.process()])
    await drainFully(manager)

    const seen = new Set<string>()
    for (const batch of backend.batches) for (const id of batch) seen.add(id)
    expect([...seen].sort()).toEqual([...ids].sort())
    // No observation was ever sent twice to a *successful* backend call (idempotency-safe retry).
    const successfulBatches = backend.batches.slice(-Math.ceil(backend.batches.length))
    const flatSuccessIds = successfulBatches.flat()
    expect(new Set(flatSuccessIds).size).toBe(flatSuccessIds.length)
  })

  it('stale-SENDING recovery works when multiple workers are configured (concurrency 2)', async () => {
    await enqueue(100)
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 2, staleInFlightMs: -1_000 }, online)
    submitSpy().mockImplementation(() => new Promise(() => { /* never resolves: simulates a stuck request */ }))

    void manager.process()
    await vi.waitFor(async () => expect((await observationQueue.getQueueStats()).inFlight).toBe(100))

    const recovered = await manager.recoverStaleSending('MANUAL')
    expect(recovered).toBe(100)
    const stats = await observationQueue.getQueueStats()
    expect(stats.retrying).toBe(100)
    expect(stats.inFlight).toBe(0)
  })

  it('a timed-out request retries serially without starting another worker', async () => {
    const ids = await enqueue(100)
    const backend = new FakeBackend()
    let calls = 0
    submitSpy().mockImplementation(async (request) => {
      calls++
      if (calls === 1) throw new ConnectorServiceError('TIMEOUT', 'simulated request timeout')
      return backend.accept(request)
    })
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 3, retryBaseMs: 0, retryMaxMs: 0 }, online)

    await manager.process()
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ effectiveConcurrency: 1, retryBatches: 1 })
    await manager.process()

    const stats = await observationQueue.getQueueStats()
    expect([stats.pending, stats.inFlight, stats.retrying, stats.failed]).toEqual([0, 0, 0, 0])
    expect(backend.batches).toHaveLength(1)
    expect(backend.batches[0].sort()).toEqual([...ids].sort())
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1, successfulBatches: 1, retryBatches: 1 })
  })

  it('a 5xx response retries at concurrency one', async () => {
    const ids = await enqueue(100)
    const backend = new FakeBackend()
    let calls = 0
    submitSpy().mockImplementation(async (request) => {
      calls++
      if (calls === 1) throw new ConnectorServiceError('SERVER_ERROR', 'temporary failure', 503)
      return backend.accept(request)
    })
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 3, retryBaseMs: 0, retryMaxMs: 0 }, online)

    await manager.process()
    await manager.process()

    const stats = await observationQueue.getQueueStats()
    expect([stats.pending, stats.inFlight, stats.retrying, stats.failed]).toEqual([0, 0, 0, 0])
    expect(backend.batches).toHaveLength(1)
    expect(backend.batches[0].sort()).toEqual([...ids].sort())
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1, successfulBatches: 1, retryBatches: 1 })
  })

  it('transient failures and healthy recovery never raise concurrency above one', async () => {
    await enqueue(100)
    let calls = 0
    submitSpy().mockImplementation(async (request) => {
      calls++
      if (calls <= 2) throw new ConnectorServiceError('SERVER_ERROR', 'temporary failure', 503)
      return { success: true, batchId: request.batchId, accepted: 0, duplicate: 100, rejected: 0, errors: [], serverTimestamp: new Date().toISOString(), results: request.observations.map((o) => ({ observationId: o.observationId, status: 'duplicate' as const, reason: null, errorCode: null, canonicalStatus: 'not_applicable' as const, nativeObservationId: null })) }
    })
    const manager = new ObservationBatchManager({ concurrency: 4, retryBaseMs: 0, retryMaxMs: 0 }, online)

    for (let attempt = 0; attempt < 4; attempt++) {
      await manager.process()
      expect(manager.getDeliveryDiagnostics().effectiveConcurrency).toBe(1)
    }

    expect(calls).toBe(3)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1, successfulBatches: 1, retryBatches: 2 })
  }, 15_000)

  it('accepted + canonicalized rows are acknowledged as healthy', async () => {
    const ids = await enqueue(100)
    submitSpy().mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, accepted: 100, duplicate: 0, rejected: 0, errors: [],
      serverTimestamp: new Date().toISOString(), canonical: { created: 100, failed: 0 },
      results: request.observations.map((observation) => ({
        observationId: observation.observationId, status: 'accepted' as const, reason: null, errorCode: null,
        canonicalStatus: 'canonicalized' as const, nativeObservationId: `n-${observation.observationId}`,
      })),
    }))
    const manager = new ObservationBatchManager({ concurrency: 4 }, online)

    await manager.process()

    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1, successfulBatches: 1, queuePausedForCanonicalFailure: false })
    expect((await observationQueue.getQueueStats())).toMatchObject({ pending: 0, inFlight: 0, canonicalRecoveryObservationCount: 0 })
    expect(await Promise.all(ids.map((id) => observationQueue.getRecord(id)))).toEqual(Array(100).fill(null))
  }, 15_000)

  it('requires canonicalization for all known canonical-routed metrics before counting healthy success', async () => {
    const [observation] = createSyntheticObservations(1).map((item) => ({ ...item, metric: 'oxygenSaturation' }))
    await observationQueue.enqueue(observation)
    submitSpy().mockImplementation(async (request) => ({
      success: true,
      batchId: request.batchId,
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      errors: [],
      serverTimestamp: new Date().toISOString(),
      results: [{
        observationId: observation.observationId,
        status: 'accepted',
        reason: null,
        errorCode: null,
        canonicalStatus: 'not_applicable',
        nativeObservationId: null,
      }],
    }))
    const manager = new ObservationBatchManager({ concurrency: 2 }, online)

    await manager.process()

    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      successfulBatches: 0,
      effectiveConcurrency: 1,
      lastBatch: { healthyBatch: false },
    })
  })

  it('a non-zero canonical.failed count stores recovery context, pauses claims, and does not count as healthy success', async () => {
    const ids = await enqueue(200)
    const upload = submitSpy().mockImplementation(async (request) => ({
      success: true,
      batchId: request.batchId,
      accepted: 100,
      duplicate: 0,
      rejected: 0,
      errors: [],
      serverTimestamp: new Date().toISOString(),
      canonical: { created: 0, failed: 100 },
      results: request.observations.map((o) => ({ observationId: o.observationId, status: 'accepted' as const, reason: null, errorCode: null, canonicalStatus: 'failed' as const, nativeObservationId: `n-${o.observationId}` })),
    }))
    const manager = new ObservationBatchManager({ concurrency: 4 }, online)

    await manager.process()
    await manager.process()

    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      effectiveConcurrency: 1,
      canonicalFailureCount: 100,
      successfulBatches: 0,
      canonicalRecoveryRequired: true,
      canonicalRecoveryObservationCount: 100,
      canonicalRecoveryBatchCount: 1,
      lastCanonicalFailureBatchId: expect.any(String),
      queuePausedForCanonicalFailure: true,
      pauseReason: 'CANONICAL_RECOVERY_REQUIRED',
      previousEffectiveConcurrency: 1,
      newEffectiveConcurrency: 1,
      canonicalFailureAlert: expect.stringContaining('held at 1'),
    })
    expect(upload).toHaveBeenCalledTimes(1)
    const recoveryRows = await Promise.all(ids.slice(0, 100).map((id) => observationQueue.getRecord(id)))
    expect(recoveryRows).toEqual(expect.arrayContaining([expect.objectContaining({
      state: 'CANONICAL_RECOVERY_REQUIRED',
      nativeObservationId: expect.stringMatching(/^n-/),
      batchId: expect.any(String),
      canonicalFailureAt: expect.any(String),
    })]))
    expect((await observationQueue.getQueueStats())).toMatchObject({ pending: 100, canonicalRecoveryObservationCount: 100, failed: 0, retrying: 0 })
    const restarted = new ObservationBatchManager({ concurrency: 4 }, online)
    await restarted.start({ restoredBackendDeviceId: true, persistedDeliveryEnablement: false })
    expect(restarted.getDeliveryDiagnostics()).toMatchObject({
      canonicalRecoveryRequired: true,
      canonicalRecoveryObservationCount: 100,
      canonicalRecoveryBatchCount: 1,
      queuePausedForCanonicalFailure: true,
      startupQueueResumeStarted: false,
      startupQueueResumeBlockedReason: 'CANONICAL_RECOVERY_REQUIRED',
    })
    await restarted.resume()
    expect(upload).toHaveBeenCalledTimes(1)
    restarted.stop()
  }, 15_000)

  it('attributes aggregate canonical failures without overwriting explicit successes or store-only rows', async () => {
    const observations = createSyntheticObservations(3).map((observation, index) => ({
      ...observation,
      metric: index === 2 ? 'storeOnlyMetric' : 'heartRate',
    }))
    await observationQueue.enqueueMany(observations)
    submitSpy().mockImplementation(async (request) => ({
      success: true,
      batchId: request.batchId,
      accepted: 3,
      duplicate: 0,
      rejected: 0,
      errors: [],
      serverTimestamp: new Date().toISOString(),
      canonical: { created: 1, failed: 1 },
      results: request.observations.map((observation, index) => ({
        observationId: observation.observationId,
        status: 'accepted' as const,
        reason: null,
        errorCode: null,
        canonicalStatus: index === 0 ? 'failed' as const : index === 1 ? 'canonicalized' as const : 'not_applicable' as const,
        nativeObservationId: `native-${index}`,
      })),
    }))
    const manager = new ObservationBatchManager({}, online)

    await manager.process()

    expect(await observationQueue.getRecord(observations[0].observationId)).toMatchObject({
      state: 'CANONICAL_RECOVERY_REQUIRED',
      nativeObservationId: 'native-0',
    })
    expect(await observationQueue.getRecord(observations[1].observationId)).toBeNull()
    expect(await observationQueue.getRecord(observations[2].observationId)).toBeNull()
    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      lastBatch: { acknowledgedCount: 2, phase: 'CANONICAL_RECOVERY_REQUIRED' },
      successfulBatches: 0,
      canonicalRecoveryObservationCount: 1,
    })
  })

  it('holds concurrency at one and reports no false reduction on canonical failure', async () => {
    await enqueue(1)
    submitSpy().mockImplementation(async (request) => ({
      success: true,
      batchId: request.batchId,
      accepted: 1,
      duplicate: 0,
      rejected: 0,
      errors: [],
      serverTimestamp: new Date().toISOString(),
      canonical: { created: 0, failed: 1 },
      results: request.observations.map((observation) => ({
        observationId: observation.observationId,
        status: 'accepted' as const,
        reason: null,
        errorCode: null,
        canonicalStatus: 'failed' as const,
        nativeObservationId: 'native-failed',
      })),
    }))
    const manager = new ObservationBatchManager({ concurrency: 1 }, online)

    await manager.process()

    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      previousEffectiveConcurrency: 1,
      newEffectiveConcurrency: 1,
      effectiveConcurrency: 1,
      canonicalFailureAlert: expect.stringContaining('held at 1'),
    })
    expect(manager.getDeliveryDiagnostics().canonicalFailureAlert).not.toContain('reduced')
  })

  it('persists and honors an aggregate canonical failure even when no individual row can be attributed', async () => {
    const ids = await enqueue(100)
    const upload = submitSpy().mockImplementation(async (request) => ({
      success: true,
      batchId: request.batchId,
      accepted: 0,
      duplicate: 100,
      rejected: 0,
      errors: [],
      serverTimestamp: new Date().toISOString(),
      canonical: { created: 0, failed: 2 },
      results: request.observations.map((observation) => ({
        observationId: observation.observationId,
        status: 'duplicate' as const,
        reason: null,
        errorCode: null,
        canonicalStatus: null,
        nativeObservationId: null,
      })),
    }))
    const manager = new ObservationBatchManager({}, online)

    await manager.process()

    expect(upload).toHaveBeenCalledTimes(1)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      canonicalRecoveryRequired: true,
      canonicalRecoveryObservationCount: 2,
      canonicalRecoveryBatchCount: 1,
      queuePausedForCanonicalFailure: true,
      successfulBatches: 0,
    })
    expect((await Promise.all(ids.map((id) => observationQueue.getRecord(id)))).every((record) => record === null)).toBe(true)

    const restarted = new ObservationBatchManager({}, online)
    await restarted.start({ restoredBackendDeviceId: true, persistedDeliveryEnablement: false })
    expect(restarted.getDeliveryDiagnostics()).toMatchObject({
      startupQueueResumeStarted: false,
      startupQueueResumeBlockedReason: 'CANONICAL_RECOVERY_REQUIRED',
      canonicalRecoveryRequired: true,
      canonicalRecoveryObservationCount: 2,
    })
    expect(upload).toHaveBeenCalledTimes(1)
    restarted.stop()
  }, 15_000)

  it('a normal duplicate result after canonical failure cannot re-claim or falsely repair the row', async () => {
    const [observationId] = await enqueue(1)
    const upload = submitSpy().mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, accepted: 1, duplicate: 0, rejected: 0, errors: [],
      serverTimestamp: new Date().toISOString(), canonical: { created: 0, failed: 1 },
      results: request.observations.map((observation) => ({
        observationId: observation.observationId, status: 'accepted' as const, reason: null, errorCode: null,
        canonicalStatus: 'failed' as const, nativeObservationId: 'native-unrepaired',
      })),
    }))
    const manager = new ObservationBatchManager({}, online)
    await manager.process()
    upload.mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, accepted: 0, duplicate: 1, rejected: 0, errors: [],
      serverTimestamp: new Date().toISOString(),
      results: request.observations.map((observation) => ({
        observationId: observation.observationId, status: 'duplicate' as const, reason: null, errorCode: null,
        canonicalStatus: null, nativeObservationId: null,
      })),
    }))
    await manager.resume()

    expect(upload).toHaveBeenCalledTimes(1)
    expect(await observationQueue.getRecord(observationId)).toMatchObject({
      state: 'CANONICAL_RECOVERY_REQUIRED',
      nativeObservationId: 'native-unrepaired',
    })
  }, 15_000)

  it('store-only metrics remain ACK-eligible and do not trigger canonical recovery', async () => {
    await observationQueue.enqueueMany(createSyntheticObservations(1).map((observation) => ({ ...observation, metric: 'storeOnlyMetric' })))
    submitSpy().mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, accepted: 1, duplicate: 0, rejected: 0, errors: [],
      serverTimestamp: new Date().toISOString(), canonical: { created: 0, failed: 0 },
      results: request.observations.map((observation) => ({
        observationId: observation.observationId, status: 'accepted' as const, reason: null, errorCode: null,
        canonicalStatus: 'not_applicable' as const, nativeObservationId: null,
      })),
    }))
    const manager = new ObservationBatchManager({}, online)

    await manager.process()

    expect(manager.getDeliveryDiagnostics()).toMatchObject({ successfulBatches: 1, canonicalRecoveryRequired: false })
    expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 0, canonicalRecoveryObservationCount: 0 })
  })

  it('a late response from an old claim cannot acknowledge rows reclaimed under a newer batchId', async () => {
    const store = new WebQueueStore()
    const isolatedOwner = `${owner}-late-claim`
    await store.initialize()
    await store.enqueueMany(isolatedOwner, createSyntheticObservations(100))
    const oldClaim = await store.claimPending(isolatedOwner, 100, 'old-claim')
    expect(oldClaim).toHaveLength(100)
    expect(oldClaim.every((row) => row.claimedAt !== null && row.attemptCount === 1)).toBe(true)

    expect(await store.releaseStaleInFlight(isolatedOwner, new Date(Date.now() + 1_000).toISOString())).toBe(100)
    const newClaim = await store.claimPending(isolatedOwner, 100, 'new-claim')
    expect(newClaim).toHaveLength(100)
    expect(newClaim.every((row) => row.batchId === 'new-claim' && row.attemptCount === 2)).toBe(true)

    expect(await store.acknowledgeClaims(oldClaim.map(({ queueId, batchId, attemptCount }) => ({ queueId, batchId: batchId!, attemptCount })), isolatedOwner)).toBe(0)
    expect(await store.acknowledgeClaims(newClaim.map(({ queueId, batchId, attemptCount }) => ({ queueId, batchId: batchId!, attemptCount })), isolatedOwner)).toBe(100)
    expect((await store.getQueueStats(isolatedOwner)).acknowledged).toBe(100)
  })

  it('app restart with a large existing queue resumes delivery without re-running acquisition (durable queue preserved)', async () => {
    // Note: fake-indexeddb (not a real browser) is the limiting factor for per-row put() cost at scale, so this
    // uses a representative large-but-bounded queue rather than the full 37k physical scale; the claiming logic
    // under test is identical regardless of queue size.
    const ids = await enqueue(600)
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request))
    const firstManager = new ObservationBatchManager({ batchSize: 200, concurrency: 2 }, online)
    await firstManager.process()
    const statsAfterPartialDrain = await observationQueue.getQueueStats()
    expect(statsAfterPartialDrain.pending).toBeGreaterThan(0)

    // Simulate an app/process restart: a brand-new manager instance over the same durable queue.
    const restarted = new ObservationBatchManager({ batchSize: 200, concurrency: 2 }, online)
    restarted.start()
    expect(restarted.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })
    try {
      await vi.waitFor(async () => {
        const stats = await observationQueue.getQueueStats()
        expect([stats.pending, stats.inFlight, stats.retrying]).toEqual([0, 0, 0])
      }, { timeout: 60_000 })
    } finally {
      restarted.stop()
    }

    const seen = new Set<string>()
    for (const batch of backend.batches) for (const id of batch) { expect(seen.has(id)).toBe(false); seen.add(id) }
    expect([...seen].sort()).toEqual([...ids].sort())
    const finalStats = await observationQueue.getQueueStats()
    expect([finalStats.pending, finalStats.inFlight, finalStats.retrying, finalStats.failed]).toEqual([0, 0, 0, 0])
  }, 90_000)

  it('startup resumes a 32k durable queue after restoring identity while acquisition is disabled and V8 is absent', async () => {
    const now = new Date().toISOString()
    const payloads = createSyntheticObservations(500)
    const rows: QueueRecord[] = payloads.map((payload, index) => ({
      queueId: `resume-${index}`,
      ownerUserId: owner,
      observationId: payload.observationId,
      payload,
      state: index < 400 ? 'PENDING' : 'RETRY_WAIT',
      createdAt: now,
      updatedAt: now,
      claimedAt: null,
      attemptCount: index < 400 ? 0 : 1,
      nextAttemptAt: index < 400 ? null : new Date(Date.now() + 60_000).toISOString(),
      lastAttemptAt: index < 400 ? null : now,
      lastErrorCode: index < 400 ? null : 'TIMEOUT',
      lastErrorMessage: index < 400 ? null : 'prior runtime stopped',
      batchId: index < 400 ? null : 'prior-runtime-batch',
      acknowledgedAt: null,
      nativeObservationId: null,
      canonicalFailureAt: null,
    }))
    const retryRowsBefore = rows.slice(400).map(({ observationId, payload, batchId, attemptCount, nextAttemptAt }) => ({
      observationId, payload, batchId, attemptCount, nextAttemptAt,
    }))
    let claimedOffset = 0
    const claimedIds: string[][] = []
    vi.spyOn(observationQueue, 'getQueueStats').mockResolvedValue({
      pending: 32_450, retrying: 100, failed: 0, inFlight: 0, acknowledged: 0,
      oldestPendingAgeMs: 0, lastAttemptAt: now, lastSuccessfulUploadAt: null, warnings: [],
    })
    vi.spyOn(observationQueue, 'getPending').mockResolvedValue([rows[0]])
    vi.spyOn(observationQueue, 'releaseStaleInFlight').mockResolvedValue(0)
    vi.spyOn(observationQueue, 'claimPending').mockImplementation(async (_limit, batchId) => {
      const claimed = rows.slice(claimedOffset, claimedOffset + 100).map((row) => ({
        ...row, state: 'IN_FLIGHT' as const, batchId, attemptCount: 1, claimedAt: now,
      }))
      claimedOffset += claimed.length
      claimedIds.push(claimed.map((row) => row.observationId))
      return claimed
    })
    vi.spyOn(observationQueue, 'acknowledgeClaims').mockImplementation(async (claims) => claims.length)
    vi.spyOn(observationQueue, 'purgeAcknowledged').mockResolvedValue(0)

    const acquisition = new JCVitalPhysiologyDelivery({
      queue: { getOwnerUserId: () => observationQueue.getOwnerUserId(), enqueueMany: (observations) => observationQueue.enqueueMany(observations) },
      deliver: () => Promise.resolve(null),
      subscribe: () => () => undefined,
      resolveDeviceId: () => 'device-test',
    })
    expect(acquisition.isEnabled()).toBe(false)

    const backend = new FakeBackend()
    let releaseRequests!: () => void
    const requestsReleased = new Promise<void>((resolve) => { releaseRequests = resolve })
    let markRequestStarted!: () => void
    const requestStarted = new Promise<void>((resolve) => { markRequestStarted = resolve })
    let calls = 0
    submitSpy().mockImplementation(async (request) => {
      calls++
      if (calls === 1) markRequestStarted()
      await requestsReleased
      return backend.accept(request)
    })
    connectorIdentityService.setConnectorDeviceId('restored-device-test')
    const restarted = new ObservationBatchManager({ concurrency: 4 }, online)
    await restarted.start({ restoredBackendDeviceId: true, persistedDeliveryEnablement: false })
    await requestStarted
    restarted.pause()
    try {
      expect(restarted.getDeliveryDiagnostics()).toMatchObject({
        startupQueueResumeAttempted: true,
        startupQueueResumeStarted: true,
        startupQueueResumeBlockedReason: null,
        restoredBackendDeviceId: true,
        persistedDeliveryEnablement: false,
        configuredConcurrency: 1,
        effectiveConcurrency: 1,
        activeWorkerCount: 1,
      })
      const active = restarted.getDeliveryDiagnostics().activeBatches
      expect(active).toHaveLength(1)
      expect(active.every((batch) => batch.observationCount === 100)).toBe(true)
      expect(claimedIds).toHaveLength(1)
      expect(new Set(claimedIds.flat()).size).toBe(100)
      expect(claimedIds.flat().every((id) => rows.some((row) => row.observationId === id))).toBe(true)
      expect(rows.slice(400).map(({ observationId, payload, batchId, attemptCount, nextAttemptAt }) => ({
        observationId, payload, batchId, attemptCount, nextAttemptAt,
      }))).toEqual(retryRowsBefore)
    } finally {
      restarted.stop()
      releaseRequests()
      acquisition.dispose()
    }
    await vi.waitFor(async () => expect((await observationQueue.getQueueStats()).inFlight).toBe(0))
  }, 15_000)

  it('records a missing restored Connector identity and resumes after identity restoration', async () => {
    await enqueue(1)
    connectorIdentityService.clearConnectorDeviceId()
    const backend = new FakeBackend()
    const upload = submitSpy().mockImplementation(async (request) => backend.accept(request))
    const manager = new ObservationBatchManager({}, online)

    await manager.start({ restoredBackendDeviceId: false, persistedDeliveryEnablement: false })
    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      startupQueueResumeAttempted: true,
      startupQueueResumeStarted: false,
      startupQueueResumeBlockedReason: 'BACKEND_DEVICE_ID_UNAVAILABLE',
    })

    connectorIdentityService.setConnectorDeviceId('resolved-device-test')
    await manager.start({ restoredBackendDeviceId: true, persistedDeliveryEnablement: false })
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ startupQueueResumeStarted: true, startupQueueResumeBlockedReason: null, configuredConcurrency: 1, effectiveConcurrency: 1 })
    await vi.waitFor(async () => expect((await observationQueue.getQueueStats()).pending).toBe(0))
    expect(upload).toHaveBeenCalledTimes(1)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      startupQueueResumeStarted: true,
      startupQueueResumeBlockedReason: null,
      restoredBackendDeviceId: true,
    })
    manager.stop()
  })

  it('observation ordering within a claimed batch is unaffected by concurrency (createdAt/FIFO order preserved per worker)', async () => {
    const ids = await enqueue(200)
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request))
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 1 }, online)

    await manager.process()
    await manager.process()

    expect(backend.batches[0]).toEqual(ids.slice(0, 100))
    expect(backend.batches[1]).toEqual(ids.slice(100, 200))
  }, 15_000)

  it('5B-1 response contract is unchanged: results[], accepted/duplicate/rejected and serverTimestamp survive concurrency changes', async () => {
    const ids = await enqueue(100)
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request))
    const manager = new ObservationBatchManager({ batchSize: 100, concurrency: 2 }, online)

    const response = await manager.process()

    expect(response).toMatchObject({ success: true, accepted: 100, duplicate: 0, rejected: 0, errors: [] })
    expect(response?.results).toHaveLength(100)
    expect(response?.results?.map((r) => r.observationId).sort()).toEqual([...ids].sort())
    expect(typeof response?.serverTimestamp).toBe('string')
    await vi.waitFor(() => expect(manager.getDeliveryDiagnostics().queueStats).toMatchObject({ pending: 0, inFlight: 0, retrying: 0, failed: 0 }))
    expect(manager.getDeliveryDiagnostics()).toMatchObject({
      configuredConcurrency: 1,
      effectiveConcurrency: 1,
      activeWorkerCount: 0,
      successfulBatches: 1,
      retryBatches: 0,
      failedBatches: 0,
    })
    expect(manager.getDeliveryDiagnostics().observationsPerMinute).toBeGreaterThan(0)
    expect(manager.getDeliveryDiagnostics().medianBatchDurationMs).not.toBeNull()
    expect(manager.getDeliveryDiagnostics().p95BatchDurationMs).not.toBeNull()
    expect(manager.getDeliveryDiagnostics().estimatedMinutesRemaining).toBe(0)
  }, 15_000)

  it('a 30k durable backlog remains intact and paused across manager restart', async () => {
    const rows = await seedDurableRows(30_001)
    const [claim] = await observationQueue.claimPending(1, 'physical-canonical-failure')
    expect(claim.observationId).toBe(rows[0].observationId)
    expect(await observationQueue.markCanonicalRecoveryRequired([{
      queueId: claim.queueId,
      batchId: claim.batchId!,
      attemptCount: claim.attemptCount,
      nativeObservationId: 'native-physical-row',
      canonicalFailureAt: new Date().toISOString(),
    }], { code: 'CANONICAL_FAILURE', message: 'recovery required' })).toBe(1)

    const restarted = new ObservationBatchManager({ concurrency: 4 }, online)
    await restarted.start({ restoredBackendDeviceId: true, persistedDeliveryEnablement: false })
    const diagnostics = restarted.getDeliveryDiagnostics()
    const queueStats = await observationQueue.getQueueStats()
    expect(diagnostics).toMatchObject({
      canonicalRecoveryRequired: true,
      canonicalRecoveryObservationCount: 1,
      queuePausedForCanonicalFailure: true,
      startupQueueResumeBlockedReason: 'CANONICAL_RECOVERY_REQUIRED',
      activeWorkerCount: 0,
    })
    expect(queueStats).toMatchObject({ pending: 30_000, inFlight: 0, retrying: 0, failed: 0, canonicalRecoveryObservationCount: 1 })
    expect(await observationQueue.getRecord(rows[0].observationId)).toMatchObject({
      observationId: rows[0].observationId,
      payload: rows[0].payload,
      state: 'CANONICAL_RECOVERY_REQUIRED',
      nativeObservationId: 'native-physical-row',
      batchId: 'physical-canonical-failure',
    })
    restarted.stop()
  }, 60_000)
})
