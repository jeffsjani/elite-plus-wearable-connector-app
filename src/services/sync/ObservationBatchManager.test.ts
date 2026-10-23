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
import { addAcquisitionProvenance } from './ObservationProvenancePayload'

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

  it('sends byte-identical legacy observations and retains provenance across retry, local duplicate, and server duplicate', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    observationQueue.setOwnerUserId(`legacy-provenance-${Date.now()}`)
    await observationQueue.initialize()
    const observation = createSyntheticObservation()
    const bytes = JSON.stringify(observation)
    const provenance = {
      syncId: 'sync-original', acquisitionId: 'acquisition-original', acquisitionRequestId: 'request-original',
      requestedMetric: 'heartRate', connectionGeneration: 3, acquisitionStartedAt: '2026-10-16T12:00:00Z',
      acquisitionCompletedAt: '2026-10-16T12:00:30Z', clientQueuedAt: '2026-10-16T12:00:31Z',
    }
    await observationQueue.enqueue(observation, undefined, provenance)
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
      .mockRejectedValueOnce(new ConnectorServiceError('NETWORK_ERROR', 'offline'))
      .mockResolvedValueOnce({
        success: true, batchId: 'duplicate', accepted: 0, duplicate: 1, rejected: 0, errors: [],
        serverTimestamp: '2026-10-16T12:02:00Z',
        results: [{ observationId: observation.observationId, status: 'duplicate', canonicalStatus: 'canonicalized' }],
      })
    const manager = new ObservationBatchManager({ retryBaseMs: 1, retryMaxMs: 1 }, new TestNetwork(true))
    await manager.process()
    const retry = await observationQueue.getRecord(observation.observationId)
    if (!retry) throw new Error('Retry row disappeared before provenance verification')
    expect(retry?.state).toBe('RETRY_WAIT')
    expect(retry?.acquisitionProvenance).toEqual(provenance)
    const duplicate = await observationQueue.enqueue(observation, undefined, { ...provenance, syncId: 'later-sync' })
    expect(duplicate.alreadyQueued).toBe(true)
    expect((await observationQueue.getRecord(observation.observationId))?.acquisitionProvenance).toEqual(provenance)
    expect(addAcquisitionProvenance(retry.payload, retry.acquisitionProvenance, true))
      .toEqual(addAcquisitionProvenance(observation, provenance, true))
    const acknowledge = vi.spyOn(observationQueue, 'acknowledgeClaims')
    const purge = vi.spyOn(observationQueue, 'purgeAcknowledged').mockResolvedValue(0)
    await vi.waitFor(async () => {
      await manager.process()
      expect(upload).toHaveBeenCalledTimes(2)
    })
    expect(acknowledge).toHaveBeenCalledOnce()
    expect((await observationQueue.getRecord(observation.observationId))?.acquisitionProvenance).toEqual(provenance)
    for (const [request] of upload.mock.calls) {
      expect(request.observations).toHaveLength(1)
      expect(JSON.stringify(request.observations[0])).toBe(bytes)
    }
    expect(purge).toHaveBeenCalledOnce()
  })

  it('automatic draining never submits Activity certification rows, including exerciseMinutes', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    observationQueue.setOwnerUserId(`vc18-hold-${Date.now()}`)
    await observationQueue.initialize()
    const eligible = { ...createSyntheticObservation(), metricType: 'DAILY_STEPS', vendorDataType: '24',
      rawSourceMetadata: { certificationOnly: true, canonicalTarget: null } }
    const excluded = { ...createSyntheticObservation(), metricType: 'DAILY_EXERCISE_MINUTES', vendorDataType: '24',
      rawSourceMetadata: { certificationOnly: true, canonicalTarget: null } }
    await observationQueue.enqueueMany([eligible, excluded])
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
    const manager = new ObservationBatchManager({}, new TestNetwork(true))
    await manager.process()
    expect(upload).not.toHaveBeenCalled()
    expect((await observationQueue.getRecord(eligible.observationId))?.state).toBe('PENDING')
    expect((await observationQueue.getRecord(excluded.observationId))?.state).toBe('PENDING')
  })

  it('a failed certification evidence gate blocks real queue ACK/purge, including r5 revision mismatch', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    observationQueue.setOwnerUserId(`vc18-ack-gate-${Date.now()}`)
    await observationQueue.initialize()
    const observation = { ...createSyntheticObservation(), observationId: 'a'.repeat(64) }
    await observationQueue.enqueue(observation)
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockResolvedValue({
      success: true, batchId: 'batch', accepted: 1, duplicate: 0, rejected: 0, errors: [], serverTimestamp: new Date().toISOString(),
      results: [{ observationId: observation.observationId, status: 'accepted', nativeObservationId: 'stored-native',
        canonicalStatus: 'not_applicable', canonicalTarget: null }],
    })
    const ack = vi.spyOn(observationQueue, 'acknowledgeClaims')
    const purge = vi.spyOn(observationQueue, 'purgeAcknowledged')
    const manager = new ObservationBatchManager({}, new TestNetwork(true))
    const report = await manager.flushCertificationObservationIds([observation.observationId], {
      persistEvidence: async () => { throw new Error('r5 deployment revision mismatch') },
    })
    expect(upload).toHaveBeenCalledOnce()
    expect(ack).not.toHaveBeenCalled()
    expect(purge).not.toHaveBeenCalled()
    expect(report.events[0].errorCode).toBe('ACK_PROCESSING_FAILED')
    expect((await observationQueue.getRecord(observation.observationId))?.state).toBe('RETRY_WAIT')
  })

  it('does not upload while offline and preserves queued observations', async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    const owner = `offline-${Date.now()}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    const observation = createSyntheticObservation()
    await observationQueue.enqueue(observation)
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
    const observation = createSyntheticObservation()
    await observationQueue.enqueue(observation)
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
    const observation = createSyntheticObservation()
    await observationQueue.enqueue(observation)
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockResolvedValue({
      success: true, batchId: 'batch', accepted: 1, duplicate: 0, rejected: 0, errors: [], serverTimestamp: new Date().toISOString(),
      results: [{ observationId: observation.observationId, status: 'accepted', canonicalStatus: 'canonicalized' }],
    })
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
    vi.spyOn(connectorObservationService, 'submitObservations').mockResolvedValue({
      success: true, batchId: 'batch', accepted: 9, duplicate: 0, rejected: 1,
      errors: [{ observationId: rejectedObservationId, code: 'VALIDATION_ERROR', message: 'invalid test observation' }],
      serverTimestamp: new Date().toISOString(),
      results: observations.map((item) => ({
        observationId: item.observationId,
        status: item.observationId === rejectedObservationId ? 'rejected' as const : 'accepted' as const,
        canonicalStatus: item.observationId === rejectedObservationId ? null : 'canonicalized' as const,
      })),
    })

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
    upload.mockResolvedValueOnce({
      success: true, batchId: 'batch', accepted: 1, duplicate: 0, rejected: 0, errors: [],
      serverTimestamp: new Date().toISOString(),
      results: [{ observationId: queued.record.observationId, status: 'accepted', canonicalStatus: 'canonicalized' }],
    })
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
    await observationQueue.claimPending(100, 'lost-ack-batch')
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const row = await observationQueue.getRecord(queued.record.observationId)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockResolvedValue({
      success: true, batchId: 'retry-batch', accepted: 0, duplicate: 1, rejected: 0, errors: [],
      serverTimestamp: new Date().toISOString(),
      results: [{ observationId: row!.observationId, status: 'duplicate', canonicalStatus: null }],
    })

    // Negative staleness avoids a same-millisecond updatedAt/staleBefore race.
    await new ObservationBatchManager({ staleInFlightMs: -1_000 }, new TestNetwork(true)).process()

    expect(upload).toHaveBeenCalledTimes(1)
    const stats = await observationQueue.getQueueStats()
    expect(stats.pending).toBe(0)
    expect(stats.retrying).toBe(0)
    expect(stats.failed).toBe(0)
  })
})