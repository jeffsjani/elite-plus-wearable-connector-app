import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticationService } from '../base44/AuthenticationService'
import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import type { InvokeOptions } from '../base44/Base44Client'
import { ConnectorServiceError, type ConnectorObservationsRequest, type ConnectorObservationsResponse } from '../base44/base44Types'
import { ObservationBatchManager, type BatchDeliveryEvent } from './ObservationBatchManager'
import type { NetworkStatus } from './NetworkStatus'
import { createSyntheticObservation } from '../testing/SyntheticObservationFactory'
import { buildWorkoutHrObservation } from '../../adapters/jcvital/WorkoutHrDelivery'
import { loadProductionSyncReceipt, ProductionV8Sync } from '../../adapters/jcvital/ProductionV8Sync'
import { getQueueStore } from '../storage/QueueStoreFactory'
import { WebQueueStore } from '../storage/WebQueueStore'
import { ObservationQueue, observationQueue } from './ObservationQueue'
import { requestPhysicalTestQuiescence } from '../diagnostics/PhysicalTestQuiescence'
import { beginPhysicalTestIsolation, physicalTestIsolationSnapshot } from '../diagnostics/PhysicalTestIsolation'
import { executePhysicalAttempt } from '../../adapters/jcvital/PhysicalSemanticController'
import { newPhysicalResult } from '../../adapters/jcvital/PhysicalSemanticEvidence'
import type { PhysicalSemanticNativeEvidence } from '../../adapters/jcvital/jcvitalV8Bridge'

vi.mock('../../buildMode', () => ({ IS_ENGINEERING_BUILD: true }))

class TestStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const online: NetworkStatus = { isOnline: () => true, subscribe: () => () => undefined }

class MutableNetwork implements NetworkStatus {
  private online = true
  private readonly listeners = new Set<(online: boolean) => void>()

  isOnline(): boolean { return this.online }
  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  setOnline(online: boolean): void {
    this.online = online
    for (const listener of this.listeners) listener(online)
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

/** Idempotent stand-in for nativeConnectorObservations keyed by observationId. */
class FakeBackend {
  readonly stored = new Set<string>()
  calls = 0
  accept(request: ConnectorObservationsRequest): ConnectorObservationsResponse {
    this.calls++
    let accepted = 0
    let duplicate = 0
    const results: NonNullable<ConnectorObservationsResponse['results']> = []
    for (const observation of request.observations) {
      if (this.stored.has(observation.observationId)) {
        duplicate++
        results.push({ observationId: observation.observationId, status: 'duplicate', canonicalStatus: null })
      } else {
        this.stored.add(observation.observationId)
        accepted++
        results.push({ observationId: observation.observationId, status: 'accepted', canonicalStatus: 'canonicalized' })
      }
    }
    return {
      success: true, batchId: request.batchId, accepted, duplicate, rejected: 0, errors: [],
      serverTimestamp: new Date().toISOString(), results,
    }
  }
}

let owner = ''
let counter = 0

async function enqueueHundred(): Promise<string[]> {
  const observations = Array.from({ length: 100 }, () => createSyntheticObservation())
  await observationQueue.enqueueMany(observations)
  return observations.map((observation) => observation.observationId)
}

function submitSpy() { return vi.spyOn(connectorObservationService, 'submitObservations') }

describe('ObservationBatchManager 100-observation lifecycle', () => {
  beforeEach(async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    owner = `lifecycle-${Date.now()}-${counter++}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
  })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

  it.each(['foreground', 'online', 'retry-timer'] as const)('quiesces an in-flight 100-row batch with backlog, blocks %s claims, preserves FIFO rows and resumes normally', async (trigger) => {
    const network = new MutableNetwork()
    const manager = new ObservationBatchManager({ retryBaseMs: 100, retryMaxMs: 100 }, network)
    const foregroundListeners = new Set<() => void>()
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: (_event: string, listener: () => void) => { foregroundListeners.add(listener) },
      removeEventListener: (_event: string, listener: () => void) => { foregroundListeners.delete(listener) },
    })
    await manager.start()
    const firstIds = await enqueueHundred()
    const pendingIds = await enqueueHundred()
    const firstStarted = deferred()
    const finishFirst = deferred()
    const secondStarted = deferred()
    const finishSecond = deferred()
    const backend = new FakeBackend()
    let activeRequests = 0
    let maxActiveRequests = 0
    const upload = submitSpy().mockImplementation(async (request) => {
      activeRequests++
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      try {
        if (upload.mock.calls.length === 1) {
          firstStarted.resolve()
          await finishFirst.promise
          if (trigger === 'retry-timer') throw new ConnectorServiceError('NETWORK_ERROR', 'normal upload failure')
        } else {
          secondStarted.resolve()
          await finishSecond.promise
        }
        return backend.accept(request)
      } finally { activeRequests-- }
    })
    const claim = vi.spyOn(observationQueue, 'claimPending')
    const acknowledge = vi.spyOn(observationQueue, 'acknowledgeClaims')
    const purge = vi.spyOn(observationQueue, 'purgeAcknowledged')
    const current = manager.process()
    await firstStarted.promise
    const pendingRows = (await observationQueue.listDiagnosticRecords()).filter((row) => pendingIds.includes(row.observationId))
    const schema = observationQueue.getDiagnostics().queueSchemaVersion
    const coordinator = requestPhysicalTestQuiescence(manager, observationQueue, owner, () => {})
    let release: (() => void) | undefined
    try {
      const waiting = coordinator.wait()
      await vi.waitFor(() => expect(coordinator.evidence.current_inFlight).toBe(100))
      expect(coordinator.evidence.inFlight_before).toBe(100)
      expect(upload).toHaveBeenCalledTimes(1)
      await manager.process()
      expect(claim).toHaveBeenCalledTimes(1)
      expect(acknowledge).not.toHaveBeenCalled()
      finishFirst.resolve()
      await current
      await waiting
      expect(coordinator.evidence.senderQuiesced).toBe(true)
      expect(coordinator.evidence.current_inFlight).toBe(0)
      expect(coordinator.evidence.last_inflight_completed_at).not.toBeNull()
      expect(manager.getPhysicalTestSenderState()).toMatchObject({ activeRequest: false, claimOwner: null, activeWorkers: 0 })
      const rows = await observationQueue.listDiagnosticRecords()
      expect(rows.filter((row) => pendingIds.includes(row.observationId))).toEqual(pendingRows)
      expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 100, inFlight: 0 })
      expect(observationQueue.getDiagnostics().queueSchemaVersion).toBe(schema)
      const ackCount = acknowledge.mock.calls.length
      const purgeCount = purge.mock.calls.length
      const retryScheduledAt = manager.getDeliveryDiagnostics().retryScheduledAt
      release = beginPhysicalTestIsolation()
      if (trigger === 'foreground') for (const listener of foregroundListeners) listener()
      else if (trigger === 'online') { network.setOnline(false); network.setOnline(true) }
      else await new Promise((resolve) => setTimeout(resolve, 160))
      await manager.process()
      expect(claim).toHaveBeenCalledTimes(1)
      expect(upload).toHaveBeenCalledTimes(1)
      expect(acknowledge).toHaveBeenCalledTimes(ackCount)
      expect(purge).toHaveBeenCalledTimes(purgeCount)
      expect(manager.getDeliveryDiagnostics().retryScheduledAt).toBe(retryScheduledAt)
      expect(await observationQueue.listDiagnosticRecords()).toEqual(rows)
      expect(maxActiveRequests).toBe(1)
      release(); release = undefined
      coordinator.resume()
      await secondStarted.promise
      expect(coordinator.evidence.sender_resumed_at).not.toBeNull()
      expect(upload).toHaveBeenCalledTimes(2)
      expect(upload.mock.calls[0][0].observations.map((row) => row.observationId)).toEqual(firstIds)
      manager.stop()
      finishSecond.resolve()
      await vi.waitFor(() => expect(manager.getDeliveryDiagnostics().activeWorkerCount).toBe(0))
    } finally {
      manager.stop()
      release?.()
      coordinator.resume()
      finishFirst.resolve(); finishSecond.resolve()
    }
  })

  it.each([false, true])('starts an isolated test with pending backlog and no inFlight, and resumes after failure=%s', async (fail) => {
    const manager = new ObservationBatchManager({}, online)
    await manager.start()
    await enqueueHundred()
    const backend = new FakeBackend()
    const upload = submitSpy().mockImplementation(async (request) => backend.accept(request))
    const rows = await observationQueue.listDiagnosticRecords()
    const claim = vi.spyOn(observationQueue, 'claimPending')
    const native: PhysicalSemanticNativeEvidence = {
      kind: 'activity', commands: [], commandsAllowed: true, digitalWellnessUnchanged: true,
      digitalWellnessBeforeSha256: 'same', digitalWellnessAfterSha256: 'same',
    }
    const initial = newPhysicalResult('activity', {
      v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true, journal_bound: true, device_scope_resolved: true,
    })
    try {
      const result = await executePhysicalAttempt(initial, {
        markAttempt: () => {}, checkpoint: () => {}, persist: () => {}, backup: () => {},
        quiesce: (attempt) => {
          const coordinator = requestPhysicalTestQuiescence(manager, observationQueue, owner, () => {})
          attempt.result.diagnostics.senderQuiescence = coordinator.evidence
          return coordinator
        },
        lock: beginPhysicalTestIsolation, begin: async () => native, end: async () => native, readNative: async () => null,
        preflight: async () => {
          expect(claim).not.toHaveBeenCalled()
          expect(await observationQueue.listDiagnosticRecords()).toEqual(rows)
          expect(physicalTestIsolationSnapshot()).toMatchObject({ active: true, senderPause: 'PHYSICAL_TEST_QUIESCED' })
        },
        run: async () => { if (fail) throw new Error('injected test failure'); return { passed: true } },
        finalize: async () => { expect(upload).not.toHaveBeenCalled() },
      })
      expect(result.status).toBe(fail ? 'FAILED' : 'COMPLETE')
      expect(result.stages.map(({ stage }) => stage).slice(0, 6)).toEqual([
        'ELIGIBILITY_CONFIRMED', 'OWNER_SCOPE_CONFIRMED', 'SENDER_QUIESCE_REQUESTED',
        'SENDER_QUIESCED', 'ISOLATION_LOCK_ACQUIRED', 'NATIVE_BRIDGE_ENTERED',
      ])
      await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1))
      await vi.waitFor(() => expect(manager.getDeliveryDiagnostics().activeWorkerCount).toBe(0))
      expect(physicalTestIsolationSnapshot()).toMatchObject({ active: false, senderPause: null })
    } finally { manager.stop() }
  })

  it('times out without cancelling a live request, releasing rows, acknowledging or acquiring', async () => {
    const manager = new ObservationBatchManager({}, online)
    await enqueueHundred()
    const started = deferred()
    const finish = deferred()
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request, options) => {
      started.resolve()
      await finish.promise
      expect(options?.signal?.aborted).toBe(false)
      return backend.accept(request)
    })
    const current = manager.process()
    await started.promise
    const rows = await observationQueue.listDiagnosticRecords()
    const acknowledge = vi.spyOn(observationQueue, 'acknowledgeClaims')
    const coordinator = requestPhysicalTestQuiescence(manager, observationQueue, owner, () => {}, 20)
    try {
      await expect(coordinator.wait()).rejects.toMatchObject({ code: 'SENDER_QUIESCE_TIMEOUT' })
      expect(coordinator.evidence).toMatchObject({
        senderQuiesced: false, current_inFlight: 100, last_batch_id: expect.any(String), last_sender_error: null,
      })
      expect(await observationQueue.listDiagnosticRecords()).toEqual(rows)
      expect(acknowledge).not.toHaveBeenCalled()
      expect(manager.getDeliveryDiagnostics().activeWorkerCount).toBe(1)
    } finally { coordinator.resume(); finish.resolve(); await current; manager.stop() }
  })

  it('blocks a worker that was awaiting authentication before quiescence from making its first claim', async () => {
    const manager = new ObservationBatchManager({}, online)
    await enqueueHundred()
    const authenticating = deferred()
    const finishAuth = deferred()
    vi.mocked(authenticationService.isAuthenticated).mockImplementation(async () => {
      authenticating.resolve(); await finishAuth.promise; return true
    })
    const claim = vi.spyOn(observationQueue, 'claimPending')
    const current = manager.process()
    await authenticating.promise
    const coordinator = requestPhysicalTestQuiescence(manager, observationQueue, owner, () => {})
    try {
      const waiting = coordinator.wait()
      finishAuth.resolve()
      await current
      await waiting
      expect(claim).not.toHaveBeenCalled()
      expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 100, inFlight: 0 })
    } finally { coordinator.resume(); manager.stop() }
  })

  it('waits for startup already in progress and prevents its eventual sender claim', async () => {
    const manager = new ObservationBatchManager({}, online)
    await enqueueHundred()
    const authenticating = deferred()
    const finishAuth = deferred()
    vi.mocked(authenticationService.isAuthenticated).mockImplementation(async () => {
      authenticating.resolve(); await finishAuth.promise; return true
    })
    const claim = vi.spyOn(observationQueue, 'claimPending')
    const startup = manager.start()
    await authenticating.promise
    const coordinator = requestPhysicalTestQuiescence(manager, observationQueue, owner, () => {})
    try {
      const waiting = coordinator.wait()
      expect(manager.getPhysicalTestSenderState().startupOperations).toBe(1)
      finishAuth.resolve()
      await startup
      await waiting
      expect(manager.getPhysicalTestSenderState().startupOperations).toBe(0)
      expect(claim).not.toHaveBeenCalled()
      expect(coordinator.evidence.senderQuiesced).toBe(true)
    } finally { manager.stop(); coordinator.resume() }
  })

  it.each(['paused', 'stopped'] as const)('does not override an independently %s sender when releasing quiescence', async (state) => {
    const manager = new ObservationBatchManager({}, online)
    await manager.start()
    await enqueueHundred()
    const coordinator = requestPhysicalTestQuiescence(manager, observationQueue, owner, () => {})
    const claim = vi.spyOn(observationQueue, 'claimPending')
    try {
      await coordinator.wait()
      if (state === 'paused') manager.pause()
      else manager.stop()
      coordinator.resume()
      expect(claim).not.toHaveBeenCalled()
      expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 100, inFlight: 0 })
    } finally { manager.stop(); coordinator.resume() }
  })

  async function assertActiveSenderSerializes(trigger: 'foreground' | 'online' | 'retry-timer'): Promise<void> {
    const network = new MutableNetwork()
    const manager = new ObservationBatchManager({ requestTimeoutMs: 10_000, retryBaseMs: 0, retryMaxMs: 0 }, network)
    const foregroundListeners = new Set<() => void>()
    if (trigger === 'foreground') {
      vi.stubGlobal('document', {
        visibilityState: 'hidden',
        addEventListener: (_event: string, listener: () => void) => { foregroundListeners.add(listener) },
        removeEventListener: (_event: string, listener: () => void) => { foregroundListeners.delete(listener) },
      })
    }
    await manager.start()

    const observations = [createSyntheticObservation(), createSyntheticObservation()]
    await observationQueue.enqueue(observations[0])
    const firstRequestStarted = deferred()
    const releaseFirstRequest = deferred()
    const twoBatchesDelivered = deferred()
    const backend = new FakeBackend()
    let activeRequests = 0
    let maxActiveRequests = 0
    let deliveredBatches = 0
    const upload = submitSpy().mockImplementation(async (request) => {
      activeRequests++
      maxActiveRequests = Math.max(maxActiveRequests, activeRequests)
      try {
        if (upload.mock.calls.length === 1) {
          firstRequestStarted.resolve()
          await releaseFirstRequest.promise
        }
        return backend.accept(request)
      } finally {
        activeRequests--
      }
    })
    manager.subscribe((event) => {
      if (event.outcome === 'DELIVERED' && ++deliveredBatches === 2) twoBatchesDelivered.resolve()
    })
    const claim = vi.spyOn(observationQueue, 'claimPending')
    const firstProcess = manager.process()
    await firstRequestStarted.promise

    await observationQueue.enqueue(observations[1])
    const claimsBeforeTrigger = claim.mock.calls.length
    const generationBeforeTrigger = manager.getDeliveryDiagnostics().senderGeneration
    if (trigger === 'foreground') {
      vi.stubGlobal('document', {
        visibilityState: 'visible',
        addEventListener: (_event: string, listener: () => void) => { foregroundListeners.add(listener) },
        removeEventListener: (_event: string, listener: () => void) => { foregroundListeners.delete(listener) },
      })
      for (const listener of foregroundListeners) listener()
    } else if (trigger === 'online') {
      network.setOnline(false)
      network.setOnline(true)
    } else {
      const scheduleRetry = (manager as unknown as { scheduleRetry: (at: string) => void }).scheduleRetry.bind(manager)
      scheduleRetry(new Date(Date.now() + 10).toISOString())
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(manager.getDeliveryDiagnostics()).toMatchObject({ activeWorkerCount: 1, senderGeneration: generationBeforeTrigger })
    expect(claim).toHaveBeenCalledTimes(claimsBeforeTrigger)
    expect(upload).toHaveBeenCalledTimes(1)

    releaseFirstRequest.resolve()
    await firstProcess
    await vi.waitFor(() => expect(deliveredBatches).toBe(2))
    manager.stop()

    const sentIds = upload.mock.calls.flatMap(([request]) => request.observations.map(({ observationId }) => observationId))
    expect(maxActiveRequests).toBe(1)
    expect([2, 3]).toContain(claim.mock.calls.length)
    expect(sentIds).toHaveLength(2)
    expect(new Set(sentIds).size).toBe(2)
    expect(sentIds.sort()).toEqual(observations.map(({ observationId }) => observationId).sort())
    expect(backend.stored).toEqual(new Set(observations.map(({ observationId }) => observationId)))
    expect(await observationQueue.listDiagnosticRecords()).toEqual([])
  }

  it('moves exactly 100 observations SENDING -> DELIVERED on backend success', async () => {
    const ids = await enqueueHundred()
    const backend = new FakeBackend()
    let inFlightDuringRequest = -1
    submitSpy().mockImplementation(async (request, options?: InvokeOptions) => {
      inFlightDuringRequest = (await observationQueue.getQueueStats()).inFlight
      options?.onHttpResponse?.(200)
      return backend.accept(request)
    })

    const manager = new ObservationBatchManager({}, online)
    const events: BatchDeliveryEvent[] = []
    manager.subscribe((event) => events.push(event))

    const response = await manager.process()

    expect(inFlightDuringRequest).toBe(100)
    expect(response?.accepted).toBe(100)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ outcome: 'DELIVERED', httpStatus: 200, accepted: 100, duplicate: 0, rejected: 0 })
    expect(events[0].acknowledgedIds.sort()).toEqual([...ids].sort())
    const stats = await observationQueue.getQueueStats()
    expect([stats.pending, stats.inFlight, stats.retrying, stats.failed]).toEqual([0, 0, 0, 0])
    const diagnostics = manager.getDeliveryDiagnostics()
    expect(diagnostics.activeBatch).toBeNull()
    expect(diagnostics.lastBatch).toMatchObject({ observationCount: 100, attemptNumber: 1, phase: 'DELIVERED', httpStatus: 200, backendResponseReceived: true, responseAccepted: 100, responseDuplicate: 0, responseRejected: 0, timedOut: false })
    expect(diagnostics.lastBatch?.requestDurationMs).toBeGreaterThanOrEqual(0)
  })

  it('keeps observations retryable when a successful response omits per-observation results', async () => {
    const ids = await enqueueHundred()
    submitSpy().mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, accepted: 100, duplicate: 0, rejected: 0,
      errors: [], serverTimestamp: new Date().toISOString(),
    }))
    const manager = new ObservationBatchManager({}, online)
    const events: BatchDeliveryEvent[] = []
    manager.subscribe((event) => events.push(event))

    await manager.process()

    const stats = await observationQueue.getQueueStats()
    expect([stats.pending, stats.inFlight, stats.retrying, stats.failed, stats.acknowledged]).toEqual([0, 0, 100, 0, 0])
    expect(events[0]).toMatchObject({ outcome: 'PARTIAL', errorCode: 'AMBIGUOUS_SERVER_RESULT', acknowledgedIds: [] })
    expect(events[0].observationIds).toHaveLength(ids.length)
    expect((await observationQueue.listDiagnosticRecords()).every((record) =>
      record.state === 'RETRY_WAIT' && record.lastErrorCode === 'AMBIGUOUS_SERVER_RESULT')).toBe(true)
  })

  it('does not ACK or purge from aggregate duplicate totals without per-observation results', async () => {
    const observation = createSyntheticObservation()
    await observationQueue.enqueue(observation)
    submitSpy().mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, accepted: 0, duplicate: 1, rejected: 0,
      errors: [], serverTimestamp: new Date().toISOString(),
    }))
    const queueId = (await observationQueue.getRecord(observation.observationId))!.queueId
    const acknowledge = vi.spyOn(observationQueue, 'acknowledgeClaims')
    const purge = vi.spyOn(observationQueue, 'purgeAcknowledged')

    await new ObservationBatchManager({}, online).process()

    expect(acknowledge.mock.calls.flatMap(([claims]) => claims).map(({ queueId: acknowledgedQueueId }) => acknowledgedQueueId))
      .not.toContain(queueId)
    expect(purge.mock.calls.flatMap(([ids]) => ids ?? [])).not.toContain(observation.observationId)
    expect(await observationQueue.getRecord(observation.observationId)).toMatchObject({
      state: 'RETRY_WAIT',
      lastErrorCode: 'AMBIGUOUS_SERVER_RESULT',
    })
  })

  it('ACKs explicit ACCEPTED and DUPLICATE results while preserving missing results for retry', async () => {
    const observations = Array.from({ length: 3 }, () => createSyntheticObservation())
    await observationQueue.enqueueMany(observations)
    const [accepted, duplicate, ambiguous] = observations.map((item) => item.observationId)
    submitSpy().mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, accepted: 1, duplicate: 1, rejected: 0,
      errors: [
        { observationId: accepted, code: 'STALE_ERROR', message: 'must not override row result' },
        { observationId: duplicate, code: 'STALE_ERROR', message: 'must not override row result' },
        ...Array.from({ length: 49 }, (_, index) => ({ observationId: `unrelated-${index}`, code: 'STALE_ERROR', message: 'capped diagnostic' })),
        { observationId: ambiguous, code: 'TEMPORARY_FAILURE', message: 'retry this result' },
      ],
      serverTimestamp: new Date().toISOString(),
      results: [
        { observationId: accepted, status: 'accepted' as const, canonicalStatus: 'canonicalized' as const },
        { observationId: duplicate, status: 'duplicate' as const, canonicalStatus: null },
      ],
    }))
    const manager = new ObservationBatchManager({}, online)
    const events: BatchDeliveryEvent[] = []
    manager.subscribe((event) => events.push(event))

    await manager.process()

    expect(events[0]).toMatchObject({ outcome: 'PARTIAL', acknowledgedIds: [accepted, duplicate] })
    expect(await observationQueue.getRecord(accepted)).toBeNull()
    expect(await observationQueue.getRecord(duplicate)).toBeNull()
    expect(await observationQueue.getRecord(ambiguous)).toMatchObject({ state: 'RETRY_WAIT', lastErrorCode: 'AMBIGUOUS_SERVER_RESULT' })
  })

  it('sends JCVital workout HR timestampSource unchanged in the Base44 request body', async () => {
    const observation = (await buildWorkoutHrObservation(owner, { sessionId: 's-1', heartRate: 120, packetSequence: 1, receivedAt: new Date().toISOString(), vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME' }, { deviceId: 'jcvital_device_864cdfe8-8beb-481f-b4d5-5f361d57bfbb', firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }))!
    await observationQueue.enqueue(observation)
    const backend = new FakeBackend()
    const upload = submitSpy().mockImplementation(async (request) => backend.accept(request))

    await new ObservationBatchManager({}, online).process()

    const body = JSON.parse(JSON.stringify(upload.mock.calls[0][0])) as ConnectorObservationsRequest
    expect(body.observations[0]).toMatchObject({ observationId: observation.observationId, timestampSource: 'CONNECTOR_BLE_RECEIPT_TIME', observedAtSource: 'CONNECTOR_BLE_RECEIPT_TIME', vendorDataType: '82' })
  })

  it('rejects every results[] rejection even when errors[] is capped at 50, and forwards results to listeners', async () => {
    const ids = await enqueueHundred()
    const rejected = new Set(ids.slice(0, 60))
    submitSpy().mockImplementation(async (request) => {
      const results = request.observations.map((o) => rejected.has(o.observationId)
        ? { observationId: o.observationId, status: 'rejected' as const, reason: 'invalid', errorCode: 'VALIDATION_ERROR', canonicalStatus: null, nativeObservationId: null }
        : { observationId: o.observationId, status: 'accepted' as const, reason: null, errorCode: null, canonicalStatus: 'canonicalized' as const, nativeObservationId: `n-${o.observationId.slice(0, 6)}` })
      const errors = [...rejected].slice(0, 50).map((observationId) => ({ observationId, reason: 'invalid' }))
      return { success: true, batchId: request.batchId, serverTimestamp: new Date().toISOString(), accepted: 40, duplicate: 0, rejected: 60, errors: [...errors, { reason: 'no usable id' }], results }
    })
    const manager = new ObservationBatchManager({}, online)
    const events: BatchDeliveryEvent[] = []
    manager.subscribe((event) => events.push(event))

    await manager.process()

    const stats = await observationQueue.getQueueStats()
    expect([stats.failed, stats.pending, stats.inFlight, stats.retrying]).toEqual([60, 0, 0, 0])
    expect(events[0]).toMatchObject({ outcome: 'PARTIAL' })
    expect(new Set(events[0].rejectedIds)).toEqual(rejected)
    expect(events[0].acknowledgedIds).toHaveLength(40)
    expect(events[0].results).toHaveLength(100)
    expect(events[0].errors).toHaveLength(51)
  })

  it('exposes the active batch while the request is outstanding', async () => {
    await enqueueHundred()
    let release!: () => void
    const backend = new FakeBackend()
    submitSpy().mockImplementation((request) => new Promise((resolve) => { release = () => resolve(backend.accept(request)) }))
    const manager = new ObservationBatchManager({}, online)

    const pending = manager.process()
    await vi.waitFor(() => expect(manager.getDeliveryDiagnostics().activeBatch?.requestStartedAt).toEqual(expect.any(String)))
    expect(manager.getDeliveryDiagnostics().activeBatch).toMatchObject({ observationCount: 100, phase: 'SENDING', requestCompletedAt: null })
    release()
    await pending

    expect(manager.getDeliveryDiagnostics().activeBatch).toBeNull()
  })

  it('times out a hung request, aborts it, and schedules RETRYING with the same IDs', async () => {
    const ids = await enqueueHundred()
    let signal: AbortSignal | undefined
    submitSpy().mockImplementation((_request, options?: InvokeOptions) => new Promise((_, reject) => {
      signal = options?.signal
      signal?.addEventListener('abort', () => reject(new ConnectorServiceError('TIMEOUT', 'aborted')))
    }))
    const manager = new ObservationBatchManager({ requestTimeoutMs: 50 }, online)
    const events: BatchDeliveryEvent[] = []
    manager.subscribe((event) => events.push(event))

    await manager.process()

    expect(signal?.aborted).toBe(true)
    expect(events[0]).toMatchObject({ outcome: 'RETRYING', errorCode: 'TIMEOUT', acknowledgedIds: [] })
    expect(events[0].observationIds.sort()).toEqual([...ids].sort())
    const stats = await observationQueue.getQueueStats()
    expect([stats.inFlight, stats.retrying, stats.pending]).toEqual([0, 100, 0])
    expect(manager.getDeliveryDiagnostics().lastBatch).toMatchObject({ phase: 'RETRYING', timedOut: true, lastErrorCode: 'TIMEOUT', backendResponseReceived: false })
    expect(manager.getDeliveryDiagnostics().lastBatch?.nextAttemptAt).not.toBeNull()
  })

  it('settles even when the platform ignores the abort signal', async () => {
    await enqueueHundred()
    submitSpy().mockImplementation(() => new Promise(() => undefined))
    const manager = new ObservationBatchManager({ requestTimeoutMs: 30 }, online)

    await manager.process()

    const stats = await observationQueue.getQueueStats()
    expect([stats.inFlight, stats.retrying]).toEqual([0, 100])
  })

  it('reports a body that never arrives after HTTP headers', async () => {
    await enqueueHundred()
    submitSpy().mockImplementation((_request, options?: InvokeOptions) => { options?.onHttpResponse?.(200); return new Promise(() => undefined) })
    const manager = new ObservationBatchManager({ requestTimeoutMs: 30 }, online)

    await manager.process()

    const last = manager.getDeliveryDiagnostics().lastBatch
    expect(last).toMatchObject({ httpStatus: 200, backendResponseReceived: false, timedOut: true, phase: 'RETRYING' })
    expect(last?.lastErrorMessage).toMatch(/HTTP 200 headers received/)
  })

  it('retries after a timeout and delivers without new observation IDs', async () => {
    const ids = await enqueueHundred()
    const backend = new FakeBackend()
    const sent: string[][] = []
    submitSpy()
      .mockImplementationOnce((request) => { sent.push(request.observations.map((o) => o.observationId)); return new Promise(() => undefined) })
      .mockImplementation(async (request) => { sent.push(request.observations.map((o) => o.observationId)); return backend.accept(request) })
    const manager = new ObservationBatchManager({ requestTimeoutMs: 30, retryBaseMs: 0, retryMaxMs: 0 }, online)

    await manager.process()
    await manager.process()

    expect(sent).toHaveLength(2)
    expect(sent[1].sort()).toEqual(sent[0].sort())
    expect(sent[0].sort()).toEqual([...ids].sort())
    expect(manager.getDeliveryDiagnostics().lastBatch).toMatchObject({ phase: 'DELIVERED', attemptNumber: 2, responseAccepted: 100 })
    expect((await observationQueue.getQueueStats()).retrying).toBe(0)
  })

  it('records the raw response shape: results[] present vs absent, first 3 results, canonical totals', async () => {
    await enqueueHundred()
    submitSpy().mockImplementation(async (request, options?: InvokeOptions) => {
      const results = request.observations.map((o, index) => ({ observationId: o.observationId, status: 'accepted' as const, canonicalStatus: 'canonicalized' as const, nativeObservationId: index === 1 ? null : `n-${index}`, reason: null, errorCode: null }))
      const body = { success: true, batchId: request.batchId, accepted: 100, duplicate: 0, rejected: 0, errors: [], serverTimestamp: '', canonical: { created: 100, failed: 0 }, results }
      options?.onResponseBody?.({ ...body, responseContractVersion: 'native-observations-results-v1', deploymentRevision: 'nc-observations-5b1-results-2026-10-03-r4', authorization: 'Bearer must-not-be-exported' })
      return body
    })
    const manager = new ObservationBatchManager({}, online)
    await manager.process()
    const shape = manager.getDeliveryDiagnostics().lastBatch?.responseShape
    expect(shape).toMatchObject({
      transportHasResults: true, transportResultCount: 100, responseHasResults: true, responseResultCount: 100,
      accepted: 100, canonicalCreated: 100, canonicalFailed: 0,
      responseContractVersion: 'native-observations-results-v1',
      deploymentRevision: 'nc-observations-5b1-results-2026-10-03-r4',
    })
    expect(manager.getDeliveryDiagnostics().lastBatch).toMatchObject({
      responseContractVersion: 'native-observations-results-v1',
      deploymentRevision: 'nc-observations-5b1-results-2026-10-03-r4',
    })
    expect(JSON.stringify(manager.getDeliveryDiagnostics())).not.toContain('must-not-be-exported')
    expect(shape?.transportTopLevelKeys).toContain('results')
    expect(shape?.firstResults).toHaveLength(3)
    expect(shape?.firstResults.map((result) => result.hasNativeObservationId)).toEqual([true, false, true])
    expect(shape?.firstResults[0]).toMatchObject({ status: 'accepted', canonicalStatus: 'canonicalized' })
    expect(shape?.firstResults[0].observationIdPrefix).toHaveLength(16)
    expect(manager.getDeliveryDiagnostics().recentResponseShapes).toHaveLength(1)

    await enqueueHundred()
    submitSpy().mockImplementation(async (request, options?: InvokeOptions) => {
      const body = { success: true, batchId: request.batchId, accepted: 100, duplicate: 0, rejected: 0, errors: [], serverTimestamp: '' }
      options?.onResponseBody?.(body)
      return body
    })
    await manager.process()
    const last = manager.getDeliveryDiagnostics().lastBatch
    expect(last?.responseShape).toMatchObject({ transportHasResults: false, transportResultCount: null, responseHasResults: false, canonicalCreated: null, responseContractVersion: null, deploymentRevision: null, firstResults: [] })
    expect(last?.requestDurationMonotonicMs).toBeGreaterThanOrEqual(0)
    expect(last?.maxEventLoopLagMs).toBeGreaterThanOrEqual(0)
  })

  it('replays a batch the backend accepted but whose response was lost, receiving duplicates only', async () => {
    await enqueueHundred()
    const backend = new FakeBackend()
    submitSpy()
      .mockImplementationOnce(async (request) => { backend.accept(request); throw new ConnectorServiceError('NETWORK_ERROR', 'connection reset after server commit') })
      .mockImplementation(async (request) => backend.accept(request))
    const manager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0 }, online)
    const events: BatchDeliveryEvent[] = []
    manager.subscribe((event) => events.push(event))

    await manager.process()
    expect(backend.stored.size).toBe(100)
    expect((await observationQueue.getQueueStats()).retrying).toBe(100)
    await manager.process()

    expect(backend.stored.size).toBe(100)
    expect(events.map((event) => event.outcome)).toEqual(['RETRYING', 'DELIVERED'])
    expect(events[1]).toMatchObject({ accepted: 0, duplicate: 100 })
    expect((await observationQueue.getQueueStats()).pending + (await observationQueue.getQueueStats()).retrying).toBe(0)
  })

  it.each(['foreground', 'online', 'retry-timer'] as const)(
    'does not create a second queue owner when a %s trigger fires during active delivery',
    async (trigger) => assertActiveSenderSerializes(trigger),
  )

  it('preserves pending observation provenance across logout, queue reopen, login, retry and purge', async () => {
    const observation = createSyntheticObservation()
    const provenance = {
      syncId: 'sync-logout-login',
      acquisitionId: 'acq-logout-login',
      acquisitionRequestId: 'request-logout-login',
      requestedMetric: 'oxygenSaturation',
      connectionGeneration: 12,
      acquisitionStartedAt: '2026-10-15T12:00:00.000Z',
      acquisitionCompletedAt: '2026-10-15T12:01:00.000Z',
      clientQueuedAt: '2026-10-15T12:01:01.000Z',
    }
    const enqueued = await observationQueue.enqueue(observation, undefined, provenance)
    expect(enqueued.inserted).toBe(true)
    expect(enqueued.record).toMatchObject({
      observationId: observation.observationId,
      acquisitionProvenance: provenance,
    })
    const [initialClaim] = await observationQueue.claimPending(1, 'logout-retry')
    expect(initialClaim).toMatchObject({
      observationId: observation.observationId,
      state: 'IN_FLIGHT',
      acquisitionProvenance: provenance,
    })
    await observationQueue.retryClaims([{
      queueId: initialClaim.queueId, batchId: initialClaim.batchId!, attemptCount: initialClaim.attemptCount,
    }], { code: 'NETWORK_ERROR', message: 'offline before logout' }, new Date(Date.now() - 1).toISOString())
    expect(await observationQueue.getRecord(observation.observationId)).toMatchObject({
      state: 'RETRY_WAIT',
      acquisitionProvenance: provenance,
    })

    observationQueue.setOwnerUserId(null)
    const reopenedQueue = new ObservationQueue(new WebQueueStore())
    reopenedQueue.setOwnerUserId(`different-${owner}`)
    await reopenedQueue.initialize()
    expect(await reopenedQueue.getRecord(observation.observationId)).toBeNull()
    expect(await reopenedQueue.listDiagnosticRecords()).toEqual([])
    expect(await reopenedQueue.claimPending(1, 'different-owner')).toEqual([])

    reopenedQueue.setOwnerUserId(owner)
    const persisted = await reopenedQueue.listDiagnosticRecords()
    expect(persisted).toHaveLength(1)
    expect(persisted[0]).toMatchObject({
      observationId: observation.observationId,
      state: 'RETRY_WAIT',
      acquisitionProvenance: provenance,
    })
    expect((await reopenedQueue.enqueue(observation, undefined, provenance)).inserted).toBe(false)
    expect(await reopenedQueue.listDiagnosticRecords()).toHaveLength(1)

    observationQueue.setOwnerUserId(owner)
    const backend = new FakeBackend()
    const inFlightObservationIds: string[] = []
    const originalClaim = observationQueue.claimPending.bind(observationQueue)
    const claim = vi.spyOn(observationQueue, 'claimPending')
    claim.mockImplementation(async (...args) => {
      const rows = await originalClaim(...args)
      inFlightObservationIds.push(...rows.map((row) => row.observationId))
      expect(rows.map((row) => row.acquisitionProvenance)).toEqual([provenance])
      return rows
    })
    const requestStarted = deferred()
    const releaseResponse = deferred()
    const upload = submitSpy().mockImplementation(async (request) => {
      const row = await observationQueue.getRecord(observation.observationId)
      expect(row).toMatchObject({
        observationId: observation.observationId,
        state: 'IN_FLIGHT',
        acquisitionProvenance: provenance,
      })
      expect(request.observations.map(({ observationId }) => observationId)).toEqual([observation.observationId])
      expect(request.observations[0]).not.toHaveProperty('acquisitionProvenance')
      requestStarted.resolve()
      await releaseResponse.promise
      return backend.accept(request)
    })
    const restartedManager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0 }, online)
    const sender = vi.spyOn(restartedManager, 'process')
    const reopenedClaims = claim.mock.calls.length
    const delivery = restartedManager.process()
    await requestStarted.promise
    const generationDuringDelivery = restartedManager.getDeliveryDiagnostics().senderGeneration
    const claimsDuringDelivery = claim.mock.calls.length
    await Promise.all([restartedManager.process(), restartedManager.process()])
    expect(restartedManager.getDeliveryDiagnostics()).toMatchObject({
      activeWorkerCount: 1,
      senderGeneration: generationDuringDelivery,
    })
    expect(claim.mock.calls.length).toBe(claimsDuringDelivery)
    expect(sender).toHaveBeenCalledTimes(3)
    expect(upload).toHaveBeenCalledTimes(1)
    expect(claimsDuringDelivery).toBe(reopenedClaims + 1)
    releaseResponse.resolve()
    await delivery

    expect(upload).toHaveBeenCalledTimes(1)
    expect(inFlightObservationIds).toEqual([observation.observationId])
    expect(upload.mock.calls[0][0].observations.map(({ observationId }) => observationId)).toEqual([observation.observationId])
    expect(backend.stored).toEqual(new Set([observation.observationId]))
    expect(await observationQueue.getRecord(observation.observationId)).toBeNull()
  })

  it('hydrates the latest receipt during delivery without changing sender or queue ownership', async () => {
    const store = getQueueStore()
    await store.initialize()
    const receipt = {
      schema: 'elite-plus.v8-production-sync-receipt.v2',
      syncId: 'sync-hydrate-during-delivery',
      requestedMetrics: ['oxygenSaturation'],
      sources: [{ metric: 'oxygenSaturation', status: 'NO_DATA' }],
    }
    await store.saveProductionSyncReceipt({
      ownerUserId: owner,
      syncId: receipt.syncId,
      startedAt: '2026-10-15T12:00:00.000Z',
      completedAt: '2026-10-15T12:01:00.000Z',
      overallState: 'UP_TO_DATE',
      requestedMetricsJson: JSON.stringify(receipt.requestedMetrics),
      receiptJson: JSON.stringify(receipt),
    })

    const observation = createSyntheticObservation()
    await observationQueue.enqueue(observation)
    const requestStarted = deferred()
    const releaseRequest = deferred()
    const backend = new FakeBackend()
    const upload = submitSpy().mockImplementation(async (request) => {
      requestStarted.resolve()
      await releaseRequest.promise
      return backend.accept(request)
    })
    const acquisition = vi.spyOn(ProductionV8Sync.prototype, 'run')
    const enqueue = vi.spyOn(observationQueue, 'enqueue')
    const enqueueMany = vi.spyOn(observationQueue, 'enqueueMany')
    const claim = vi.spyOn(observationQueue, 'claimPending')
    const ack = vi.spyOn(observationQueue, 'acknowledgeClaims')
    const purge = vi.spyOn(observationQueue, 'purgeAcknowledged')
    const manager = new ObservationBatchManager({}, online)
    const sender = vi.spyOn(manager, 'process')
    const process = manager.process()
    await requestStarted.promise
    const beforeRead = await observationQueue.getRecord(observation.observationId)
    const claimsBeforeRead = claim.mock.calls.length
    const postsBeforeRead = upload.mock.calls.length
    const senderInvocationsBeforeRead = sender.mock.calls.length

    const hydrated = await loadProductionSyncReceipt(owner)

    expect(hydrated).toMatchObject({ syncId: receipt.syncId, requestedMetrics: ['oxygenSaturation'] })
    expect(await observationQueue.getRecord(observation.observationId)).toEqual(beforeRead)
    expect(acquisition).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    expect(enqueueMany).not.toHaveBeenCalled()
    expect(claim).toHaveBeenCalledTimes(claimsBeforeRead)
    expect(upload).toHaveBeenCalledTimes(postsBeforeRead)
    expect(sender).toHaveBeenCalledTimes(senderInvocationsBeforeRead)
    expect(ack).not.toHaveBeenCalled()
    expect(purge).not.toHaveBeenCalled()
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ activeWorkerCount: 1, senderGeneration: 1 })

    releaseRequest.resolve()
    await process
    expect(await observationQueue.getRecord(observation.observationId)).toBeNull()
  })

  it('flags a backend-accepted batch whose local ACK fails and retries it idempotently', async () => {
    await enqueueHundred()
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request))
    vi.spyOn(observationQueue, 'acknowledgeClaims').mockRejectedValueOnce(new Error('disk I/O error'))
    const manager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0 }, online)

    await manager.process()
    const last = manager.getDeliveryDiagnostics().lastBatch
    expect(last).toMatchObject({ backendResponseReceived: true, responseAccepted: 100, lastErrorCode: 'ACK_PROCESSING_FAILED', phase: 'RETRYING' })
    expect((await observationQueue.getQueueStats()).retrying).toBe(100)

    await manager.process()
    expect(backend.stored.size).toBe(100)
    expect(manager.getDeliveryDiagnostics().lastBatch).toMatchObject({ phase: 'DELIVERED', responseDuplicate: 100 })
  })

  it('recovers 100 SENDING rows left by an app restart once they exceed the stale threshold', async () => {
    const start = new Date('2026-10-01T10:00:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    const ids = await enqueueHundred()
    await observationQueue.claimPending(100, 'crashed-batch')
    const backend = new FakeBackend()
    const upload = submitSpy().mockImplementation(async (request) => backend.accept(request))

    // Fresh process after "restart", still inside the 60 s threshold: rows must not be touched.
    vi.setSystemTime(new Date(start.getTime() + 30_000))
    const restarted = new ObservationBatchManager({}, online)
    expect(await restarted.recoverStaleSending('STARTUP')).toBe(0)
    expect(await restarted.getStaleSendingCount()).toBe(0)
    await restarted.process()
    expect(upload).not.toHaveBeenCalled()
    expect((await observationQueue.getQueueStats()).inFlight).toBe(100)

    vi.setSystemTime(new Date(start.getTime() + 61_000))
    expect(await restarted.getStaleSendingCount()).toBe(100)
    expect(await restarted.recoverStaleSending('STARTUP')).toBe(100)
    expect(restarted.getDeliveryDiagnostics().lastStaleRecovery).toMatchObject({ trigger: 'STARTUP', released: 100 })
    await restarted.process()

    expect(upload).toHaveBeenCalledTimes(1)
    expect(upload.mock.calls[0][0].observations.map((o) => o.observationId).sort()).toEqual([...ids].sort())
    const stats = await observationQueue.getQueueStats()
    expect([stats.inFlight, stats.retrying, stats.pending]).toEqual([0, 0, 0])
  })

  it('purges only durably ACKed rows after restart before checking for new work', async () => {
    const observation = createSyntheticObservation()
    await observationQueue.enqueue(observation)
    const [claim] = await observationQueue.claimPending(1, 'acked-before-purge')
    await observationQueue.acknowledgeClaims([{
      queueId: claim.queueId, batchId: claim.batchId!, attemptCount: claim.attemptCount,
    }])
    const upload = submitSpy()
    const manager = new ObservationBatchManager({}, online)

    await manager.start({ restoredBackendDeviceId: true, persistedDeliveryEnablement: true })

    expect(await observationQueue.getRecord(observation.observationId)).toBeNull()
    expect(upload).not.toHaveBeenCalled()
    expect((await observationQueue.getQueueStats()).pending).toBe(0)
    manager.stop()
  })

  it('Retry Stale Sending releases only rows past the threshold without duplicating them', async () => {
    const start = new Date('2026-10-01T11:00:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    await enqueueHundred()
    await observationQueue.claimPending(100, 'stale-batch')
    vi.setSystemTime(new Date(start.getTime() + 45_000))
    await observationQueue.enqueueMany(Array.from({ length: 20 }, () => createSyntheticObservation()))
    await observationQueue.claimPending(100, 'fresh-batch')
    vi.setSystemTime(new Date(start.getTime() + 70_000))
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(false)
    const manager = new ObservationBatchManager({}, online)

    expect(await manager.retryStaleSending()).toBe(100)

    const stats = await observationQueue.getQueueStats()
    expect([stats.inFlight, stats.retrying, stats.pending]).toEqual([20, 100, 0])
    expect(stats.pending + stats.retrying + stats.inFlight).toBe(120)
    expect(manager.getDeliveryDiagnostics().lastStaleRecovery).toMatchObject({ trigger: 'MANUAL', released: 100 })
  })
})
