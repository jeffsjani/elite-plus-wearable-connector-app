import 'fake-indexeddb/auto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { authenticationService } from '../base44/AuthenticationService'
import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import { ConnectorServiceError } from '../base44/base44Types'
import { ObservationBatchManager } from './ObservationBatchManager'
import { observationQueue } from './ObservationQueue'
import type { NetworkStatus } from './NetworkStatus'
import { createSyntheticObservation } from '../testing/SyntheticObservationFactory'

class TestStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

class TestNetwork implements NetworkStatus {
  private readonly online: boolean
  constructor(online: boolean) { this.online = online }
  isOnline(): boolean { return this.online }
  subscribe(): () => void { return () => undefined }
}

describe('ObservationBatchManager', () => {
  afterEach(() => vi.restoreAllMocks())

  it('does not upload while offline and preserves queued observations', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `offline-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    await observationQueue.enqueue(createSyntheticObservation())
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
    const manager = new ObservationBatchManager({}, new TestNetwork(false))

    await manager.process()

    expect(upload).not.toHaveBeenCalled()
    expect((await observationQueue.getQueueStats()).pending).toBe(1)
  })

  it('schedules network failures for retry without losing rows', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `retry-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    await observationQueue.enqueue(createSyntheticObservation())
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    vi.spyOn(connectorObservationService, 'submitObservations').mockRejectedValue(new ConnectorServiceError('NETWORK_ERROR', 'offline'))
    const manager = new ObservationBatchManager({}, new TestNetwork(true))

    await manager.process()

    expect((await observationQueue.getQueueStats()).retrying).toBe(1)
  })

  it('serializes concurrent processing requests', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `lock-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    await observationQueue.enqueue(createSyntheticObservation())
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockResolvedValue({ success: true, batchId: 'batch', accepted: 1, duplicate: 0, rejected: 0, errors: [], serverTimestamp: new Date().toISOString() })
    const manager = new ObservationBatchManager({}, new TestNetwork(true))

    await Promise.all([manager.process(), manager.process()])

    expect(upload).toHaveBeenCalledTimes(1)
    expect((await observationQueue.getQueueStats()).pending).toBe(0)
  })

  it('clears valid rows and isolates a rejected row', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `partial-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    const observations = Array.from({ length: 10 }, () => createSyntheticObservation())
    await observationQueue.enqueueMany(observations)
    const rejectedObservationId = observations[9].observationId
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    vi.spyOn(connectorObservationService, 'submitObservations').mockResolvedValue({ success: true, batchId: 'batch', accepted: 9, duplicate: 0, rejected: 1, errors: [{ observationId: rejectedObservationId, code: 'VALIDATION_ERROR', message: 'invalid test observation' }], serverTimestamp: new Date().toISOString() })

    await new ObservationBatchManager({}, new TestNetwork(true)).process()

    const stats = await observationQueue.getQueueStats()
    expect(stats.pending).toBe(0)
    expect(stats.failed).toBe(1)
  })

  it('pauses on authentication failure and retries transient HTTP failures', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `retry-classification-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    await observationQueue.enqueue(createSyntheticObservation())
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockRejectedValue(new ConnectorServiceError('AUTH_REQUIRED', 'expired', 401))
    const manager = new ObservationBatchManager({}, new TestNetwork(true))

    await manager.process()
    await manager.process()

    expect(upload).toHaveBeenCalledTimes(1)
    expect((await observationQueue.getQueueStats()).retrying).toBe(1)
  })

  it.each([408, 429, 500])('schedules retry for HTTP %s', async (status) => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `http-${status}-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    await observationQueue.enqueue(createSyntheticObservation())
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    vi.spyOn(connectorObservationService, 'submitObservations').mockRejectedValue(new ConnectorServiceError('SERVER_ERROR', 'transient', status))

    await new ObservationBatchManager({}, new TestNetwork(true)).process()

    expect((await observationQueue.getQueueStats()).retrying).toBe(1)
  })

  it('does not retry ownership failures', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `forbidden-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    await observationQueue.enqueue(createSyntheticObservation())
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    vi.spyOn(connectorObservationService, 'submitObservations').mockRejectedValue(new ConnectorServiceError('FORBIDDEN', 'ownership', 403))

    await new ObservationBatchManager({}, new TestNetwork(true)).process()

    expect((await observationQueue.getQueueStats()).failed).toBe(1)
  })

  it('reports delivered and retrying batch outcomes to subscribers', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `listener-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    const queued = await observationQueue.enqueue(createSyntheticObservation())
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockRejectedValueOnce(new ConnectorServiceError('SERVER_ERROR', 'down', 503))
    const manager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0 }, new TestNetwork(true))
    const events: Array<{ outcome: string; httpStatus: number | null; acknowledgedIds: string[] }> = []
    manager.subscribe((event) => events.push(event))

    await manager.process()
    upload.mockResolvedValueOnce({ success: true, batchId: 'batch', accepted: 1, duplicate: 0, rejected: 0, errors: [], serverTimestamp: new Date().toISOString() })
    await manager.process()

    expect(events.map((event) => [event.outcome, event.httpStatus])).toEqual([['RETRYING', 503], ['DELIVERED', 200]])
    expect(events[1].acknowledgedIds).toEqual([queued.record.observationId])
  })

  it('recovers an ACK-loss in-flight row and clears a duplicate response', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `ack-loss-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    const queued = await observationQueue.enqueue(createSyntheticObservation())
    await observationQueue.markInFlight([queued.record.queueId], 'lost-ack-batch')
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockResolvedValue({ success: true, batchId: 'retry-batch', accepted: 0, duplicate: 1, rejected: 0, errors: [], serverTimestamp: new Date().toISOString() })

    // Negative staleness avoids a same-millisecond updatedAt/staleBefore race.
    await new ObservationBatchManager({ staleInFlightMs: -1_000 }, new TestNetwork(true)).process()

    expect(upload).toHaveBeenCalledTimes(1)
    const stats = await observationQueue.getQueueStats()
    expect(stats.pending).toBe(0)
    expect(stats.retrying).toBe(0)
    expect(stats.failed).toBe(0)
  })
})