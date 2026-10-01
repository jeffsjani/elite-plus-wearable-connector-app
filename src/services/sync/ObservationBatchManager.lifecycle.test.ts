import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { authenticationService } from '../base44/AuthenticationService'
import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import type { InvokeOptions } from '../base44/Base44Client'
import { ConnectorServiceError, type ConnectorObservationsRequest, type ConnectorObservationsResponse } from '../base44/base44Types'
import { ObservationBatchManager, type BatchDeliveryEvent } from './ObservationBatchManager'
import { observationQueue } from './ObservationQueue'
import type { NetworkStatus } from './NetworkStatus'
import { createSyntheticObservation } from '../testing/SyntheticObservationFactory'
import { buildWorkoutHrObservation } from '../../adapters/jcvital/WorkoutHrDelivery'

class TestStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const online: NetworkStatus = { isOnline: () => true, subscribe: () => () => undefined }

/** Idempotent stand-in for nativeConnectorObservations keyed by observationId. */
class FakeBackend {
  readonly stored = new Set<string>()
  calls = 0
  accept(request: ConnectorObservationsRequest): ConnectorObservationsResponse {
    this.calls++
    let accepted = 0
    let duplicate = 0
    for (const observation of request.observations) {
      if (this.stored.has(observation.observationId)) duplicate++
      else { this.stored.add(observation.observationId); accepted++ }
    }
    return { success: true, batchId: request.batchId, accepted, duplicate, rejected: 0, errors: [], serverTimestamp: new Date().toISOString() }
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
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

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

  it('sends JCVital workout HR timestampSource unchanged in the Base44 request body', async () => {
    const observation = (await buildWorkoutHrObservation(owner, { sessionId: 's-1', heartRate: 120, packetSequence: 1, receivedAt: new Date().toISOString(), vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME' }, { deviceId: 'jcvital_device_864cdfe8-8beb-481f-b4d5-5f361d57bfbb', firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }))!
    await observationQueue.enqueue(observation)
    const backend = new FakeBackend()
    const upload = submitSpy().mockImplementation(async (request) => backend.accept(request))

    await new ObservationBatchManager({}, online).process()

    const body = JSON.parse(JSON.stringify(upload.mock.calls[0][0])) as ConnectorObservationsRequest
    expect(body.observations[0]).toMatchObject({ observationId: observation.observationId, timestampSource: 'CONNECTOR_BLE_RECEIPT_TIME', observedAtSource: 'CONNECTOR_BLE_RECEIPT_TIME', vendorDataType: '82' })
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

  it('flags a backend-accepted batch whose local ACK fails and retries it idempotently', async () => {
    await enqueueHundred()
    const backend = new FakeBackend()
    submitSpy().mockImplementation(async (request) => backend.accept(request))
    vi.spyOn(observationQueue, 'markAcknowledged').mockRejectedValueOnce(new Error('disk I/O error'))
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
    const records = await observationQueue.getPending(100)
    await observationQueue.markInFlight(records.map((record) => record.queueId), 'crashed-batch')
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

  it('Retry Stale Sending releases only rows past the threshold without duplicating them', async () => {
    const start = new Date('2026-10-01T11:00:00.000Z')
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(start)
    await enqueueHundred()
    const stale = await observationQueue.getPending(100)
    await observationQueue.markInFlight(stale.map((record) => record.queueId), 'stale-batch')
    vi.setSystemTime(new Date(start.getTime() + 45_000))
    await observationQueue.enqueueMany(Array.from({ length: 20 }, () => createSyntheticObservation()))
    const fresh = await observationQueue.getPending(100)
    await observationQueue.markInFlight(fresh.map((record) => record.queueId), 'fresh-batch')
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
