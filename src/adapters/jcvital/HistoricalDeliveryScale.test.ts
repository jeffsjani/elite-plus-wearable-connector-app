import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeObservation } from '../../models/wearableObservation'
import { authenticationService } from '../../services/base44/AuthenticationService'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import type { ConnectorObservationResult, ConnectorObservationsRequest, ConnectorObservationsResponse, NativeObservationInput } from '../../services/base44/base44Types'
import { CrashBreadcrumbs, installGlobalCrashHandlers } from '../../services/diagnostics/CrashBreadcrumbs'
import type { BatchDeliveryListener } from '../../services/sync/ObservationBatchManager'
import { ObservationBatchManager } from '../../services/sync/ObservationBatchManager'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { auditHistoricalResult, boundHistoricalResult } from './HistoricalResultBounds'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import { mapPhysiologyObservation } from './PhysiologyContract'
import { JCVitalPhysiologyDelivery, PHYSIOLOGY_DELIVERY_POLICY } from './PhysiologyDelivery'

const MAC = 'E7:1B:D8:36:78:CF'
const SAMPLES_PER_RECORD = 720

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

/** Native type-27 output: hourly records of 5 s samples, each sample carrying the full packet envelope like the Kotlin normalizer. */
function historicalHr(count: number, options: { envelopeBytes?: number; leadingZeros?: number } = {}): JCVitalV8HistoricalSyncResult {
  const envelope = { dataType: '27', data: [{ date: '2026.10.01 00:00:00', arrayDynamicHR: 'x'.repeat(options.envelopeBytes ?? 64) }], mac: MAC }
  const observations: NativeObservation[] = Array.from({ length: count }, (_, index) => {
    const record = Math.floor(index / SAMPLES_PER_RECORD)
    const sequence = index % SAMPLES_PER_RECORD
    const vendorDate = `2026.09.${String(1 + Math.floor(record / 24)).padStart(2, '0')} ${String(record % 24).padStart(2, '0')}:00:00`
    const start = Date.UTC(2026, 8, 1 + Math.floor(record / 24), record % 24)
    return {
      id: `native-${index}`,
      source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: MAC, macAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
      metricType: 'HEART_RATE_CONTINUOUS', observedAt: new Date(start + sequence * 5_000).toISOString(), observedAtSource: vendorDate,
      receivedAt: '2026-10-02T00:00:00.000Z', timezone: 'UTC', value: index < (options.leadingZeros ?? 0) ? 0 : 60 + (index % 40), values: null, unit: 'bpm',
      acquisitionMode: 'HISTORICAL_SYNC', measurementContext: 'CONTINUOUS_HISTORY', sessionId: null, packetId: null, sequenceNumber: sequence,
      samplingIntervalMs: 5_000, sampleRateHz: null, signalQuality: null, completeness: null, vendorDataType: '27', vendorField: 'arrayDynamicHR', vendorDerived: false,
      rawPayload: { vendorEnvelope: envelope, record: envelope.data[0] },
      provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', sourceRecordId: `${MAC}|27|${vendorDate}|${sequence}` },
    }
  })
  return {
    syncId: crypto.randomUUID(), deviceId: MAC, provider: 'JCVITAL', sdkCommand: 'GetDynamicHRWithMode', vendorDataType: '27', startedAt: '', completedAt: '',
    recordsReceived: count, recordGroupsReceived: Math.ceil(count / SAMPLES_PER_RECORD), recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0,
    earliestObservation: null, latestObservation: null, partial: false, completionStatus: 'COMPLETE', packetCount: 1, parseErrors: [], observations,
  }
}

/** In-memory durable queue + idempotent backend + one-batch-per-call sender, recording every chunk the service hands it. */
class Harness {
  owner = 'user-1'
  readonly rows = new Map<string, NativeObservationInput>()
  readonly server = new Map<string, NativeObservationInput>()
  readonly enqueueChunkSizes: number[] = []
  deliverCalls = 0
  private readonly listeners = new Set<BatchDeliveryListener>()
  private readonly identity = new MemoryStorage()

  readonly deps = {
    queue: {
      getOwnerUserId: () => this.owner,
      enqueueMany: vi.fn(async (observations: NativeObservationInput[]) => {
        this.enqueueChunkSizes.push(observations.length)
        return observations.map((observation) => {
          if (this.rows.has(observation.observationId)) return { inserted: false, alreadyQueued: true }
          this.rows.set(observation.observationId, observation)
          return { inserted: true, alreadyQueued: false }
        })
      }),
    },
    deliver: vi.fn(async () => {
      this.deliverCalls++
      const batch = [...this.rows.values()].slice(0, 100)
      if (!batch.length) return null
      const results: ConnectorObservationResult[] = batch.map((observation) => {
        this.rows.delete(observation.observationId)
        if (this.server.has(observation.observationId)) return { observationId: observation.observationId, status: 'duplicate', canonicalStatus: null, nativeObservationId: null }
        this.server.set(observation.observationId, observation)
        return { observationId: observation.observationId, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: `n-${this.server.size}` }
      })
      const ids = batch.map((observation) => observation.observationId)
      const accepted = results.filter((result) => result.status === 'accepted').length
      this.listeners.forEach((listener) => listener({ batchId: `b${this.deliverCalls}`, attemptedAt: '', outcome: 'DELIVERED', observationIds: ids, acknowledgedIds: ids, rejectedIds: [], httpStatus: 200, errorCode: null, accepted, duplicate: batch.length - accepted, rejected: 0, results, errors: [] }))
      return { success: true }
    }),
    subscribe: (listener: BatchDeliveryListener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
    resolveDeviceId: (address: string) => new (class { resolve = (a: string) => `jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-${a.replace(/[^0-9a-f]/gi, '').slice(0, 12).toLowerCase().padEnd(12, '0')}` })().resolve(address),
    breadcrumbs: new CrashBreadcrumbs(() => this.identity),
  }

  service(enabled = true): JCVitalPhysiologyDelivery {
    const delivery = new JCVitalPhysiologyDelivery(this.deps)
    delivery.setContext({ bleAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' })
    delivery.setEnabled(enabled)
    delivery.start()
    return delivery
  }
}

describe('Historical delivery at scale (bounded pipeline)', () => {
  it.each([300, 1_300, 17_280])('processes %i HR observations in ≤250-observation chunks with exact IDs and bounded UI state', async (count) => {
    const harness = new Harness()
    const delivery = harness.service()
    let emits = 0
    delivery.onChange(() => { emits++ })
    const sync = historicalHr(count)
    const expectedIds = (await Promise.all(sync.observations.slice(0, 3).map((native) => mapPhysiologyObservation('user-1', native, { deviceId: delivery.getSnapshot().backendDeviceId, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' }))))
      .flat().map((outcome) => outcome.status === 'MAPPED' ? outcome.observation.observationId : null)

    await delivery.deliverSyncResult(sync)

    expect(Math.max(...harness.enqueueChunkSizes)).toBeLessThanOrEqual(PHYSIOLOGY_DELIVERY_POLICY.processingChunkSize)
    expect(harness.enqueueChunkSizes.reduce((sum, size) => sum + size, 0)).toBe(count)
    expect(harness.enqueueChunkSizes).toHaveLength(Math.ceil(count / PHYSIOLOGY_DELIVERY_POLICY.processingChunkSize))
    expect(harness.server.size).toBe(count)
    expect([...harness.server.keys()].slice(0, 3)).toEqual(expectedIds)
    expect(harness.deliverCalls).toBe(Math.ceil(count / 100))
    const snapshot = delivery.getSnapshot()
    expect(snapshot.metrics.heartRateHistory).toMatchObject({ captured: count, queued: count, uniqueObservationsDelivered: count, serverAccepted: count, canonicalized: count, failed: 0 })
    expect(snapshot.progress).toMatchObject({ stage: 'COMPLETE', normalized: count, mapped: count, queued: count, currentChunk: harness.enqueueChunkSizes.length, largestChunk: Math.min(count, 250) })
    expect(new TextEncoder().encode(JSON.stringify(snapshot)).length).toBeLessThan(10_000)
    expect(emits).toBeLessThan(harness.enqueueChunkSizes.length + 5)
    delivery.dispose()
  }, 60_000)

  it('repeats an identical 17,280-observation sync as duplicates only', async () => {
    const harness = new Harness()
    const delivery = harness.service()
    const sync = historicalHr(17_280)
    await delivery.deliverSyncResult(sync)
    const ids = [...harness.server.keys()]
    delivery.resetDiagnostics()

    await delivery.deliverSyncResult(historicalHr(17_280))

    expect([...harness.server.keys()]).toEqual(ids)
    expect(delivery.getSnapshot().metrics.heartRateHistory).toMatchObject({ serverAccepted: 0, serverDuplicate: 17_280, uniqueObservationsDelivered: 17_280, failed: 0 })
    delivery.dispose()
  }, 60_000)

  it('strips an intentionally large rawVendorPayload to bounded delivery metadata', async () => {
    const harness = new Harness()
    const delivery = harness.service()
    const sync = historicalHr(260, { envelopeBytes: 200_000 })
    expect(auditHistoricalResult(sync)).toMatchObject({ rawPayloadEnvelopeDuplicated: true })

    await delivery.deliverSyncResult(sync)

    for (const observation of harness.server.values()) {
      const json = JSON.stringify(observation)
      expect(new TextEncoder().encode(json).length).toBeLessThan(3_000)
      expect(json).not.toMatch(/vendorEnvelope|arrayDynamicHR":"x|E7:1B/)
    }
    delivery.dispose()
  })
})

describe('Historical HR Safe Test', () => {
  it('delivers only the first 300 valid observations even while delivery is toggled off', async () => {
    const harness = new Harness()
    const delivery = harness.service(false)
    const sync = historicalHr(1_300, { leadingZeros: 7 })

    const report = await delivery.deliverSyncResult(sync, { maxObservations: PHYSIOLOGY_DELIVERY_POLICY.safeTestMaxObservations })

    expect(report).toMatchObject({ delivered: true, mapped: 300, queued: 300 })
    expect(harness.server.size).toBe(300)
    const snapshot = delivery.getSnapshot()
    expect(snapshot.metrics.heartRateHistory).toMatchObject({ notDeliverable: 7, queued: 300, uniqueObservationsDelivered: 300 })
    expect(snapshot.progress).toMatchObject({ safeTest: true, normalized: 1_300, selectedForTest: 300, mapped: 300, stage: 'COMPLETE' })
    expect([...harness.server.values()].every((observation) => observation.valueNumber > 0)).toBe(true)
    delivery.dispose()
  })

  it('records persistent breadcrumbs for each delivery stage without storing observations', async () => {
    const harness = new Harness()
    const delivery = harness.service(false)
    await delivery.deliverSyncResult(historicalHr(600), { maxObservations: 300 })

    const persisted = new CrashBreadcrumbs(() => harness.deps.breadcrumbs['storage']()).getState().previous!
    const stages = persisted.trail.map((crumb) => crumb.stage)
    expect(stages).toEqual(expect.arrayContaining(['HR_DELIVERY_MAPPING_STARTED', 'HR_ENQUEUE_STARTED', 'HR_ENQUEUE_CHUNK_INDEX', 'HR_MAPPED_COUNT', 'HR_ENQUEUED_COUNT', 'HR_BATCH_SEND_STARTED']))
    expect(persisted.lastSuccessStage).toBe('HR_BATCH_SEND_DRAINED')
    expect(JSON.stringify(persisted).length).toBeLessThan(10_000)
    expect(JSON.stringify(persisted)).not.toMatch(/observationId|valueNumber/)
    delivery.dispose()
  })
})

describe('Delivery OFF regression', () => {
  it('does no mapping, hashing, queue or network work and leaves the sync result untouched', async () => {
    const harness = new Harness()
    const delivery = harness.service(false)
    const digest = vi.spyOn(crypto.subtle, 'digest')
    const sync = historicalHr(1_300)
    const before = JSON.stringify(sync)

    const report = await delivery.deliverSyncResult(sync)

    expect(report).toMatchObject({ delivered: false, reason: 'physiology delivery disabled' })
    expect(digest).not.toHaveBeenCalled()
    expect(harness.deps.queue.enqueueMany).not.toHaveBeenCalled()
    expect(harness.deps.deliver).not.toHaveBeenCalled()
    expect(JSON.stringify(sync)).toBe(before)
    expect(delivery.getSnapshot().progress).toBeNull()
    digest.mockRestore()
    delivery.dispose()
  })
})

describe('Historical result bounding and memory audit', () => {
  it('keeps raw vendor payloads only on the first/last 5 observations and leaves normalized fields intact', () => {
    const sync = historicalHr(1_300, { envelopeBytes: 5_000 })
    const bounded = boundHistoricalResult(sync)
    expect(bounded.observations).toHaveLength(1_300)
    expect(bounded.observations.filter((observation) => observation.rawPayload !== null)).toHaveLength(10)
    expect(bounded.observations[4].rawPayload).toBe(sync.observations[4].rawPayload)
    expect(bounded.observations[1_295].rawPayload).toBe(sync.observations[1_295].rawPayload)
    expect(bounded.observations.map(({ rawPayload: _raw, ...rest }) => rest)).toEqual(sync.observations.map(({ rawPayload: _raw, ...rest }) => rest))
    expect(JSON.stringify(bounded).length).toBeLessThan(JSON.stringify(sync).length / 5)
  })

  it('reports envelope duplication and amplification from a bounded sample', () => {
    const audit = auditHistoricalResult(historicalHr(1_300, { envelopeBytes: 5_000 }))
    expect(audit).toMatchObject({ normalizedObservations: 1_300, sourceRecordGroups: 2, rawPayloadEnvelopeDuplicated: true })
    expect(audit.sampleVendorEnvelopeBytes).toBeGreaterThan(5_000)
    expect(audit.estimatedDuplicatedEnvelopeBytes).toBeGreaterThan(1_299 * 5_000)
    expect(audit.estimatedBoundedResultBytes).toBeLessThan(audit.estimatedNativeResultBytes / 5)
  })
})

describe('CrashBreadcrumbs', () => {
  it('persists the trail across a restart and bounds it', () => {
    const storage = new MemoryStorage()
    const first = new CrashBreadcrumbs(() => storage)
    first.startSession()
    for (let index = 0; index < 100; index++) first.record('HR_ENQUEUE_CHUNK_INDEX', { chunk: index })
    first.recordError('lastHistoricalDeliveryError', new Error('boom'), 'HR chunk 3')

    const restarted = new CrashBreadcrumbs(() => storage)
    restarted.startSession()
    const previous = restarted.getState().previous!
    expect(previous.trail).toHaveLength(40)
    expect(previous.lastSuccessStage).toBe('HR_ENQUEUE_CHUNK_INDEX')
    expect(previous.lastHistoricalDeliveryError).toMatchObject({ message: 'Error: boom', context: 'HR chunk 3' })
    expect(restarted.getState().current.trail).toHaveLength(0)
  })

  it('captures unhandled errors and promise rejections', () => {
    const storage = new MemoryStorage()
    const breadcrumbs = new CrashBreadcrumbs(() => storage)
    const handlers = new Map<string, (event: unknown) => void>()
    installGlobalCrashHandlers({ addEventListener: (type: string, handler: (event: unknown) => void) => { handlers.set(type, handler) } } as unknown as Window, breadcrumbs)
    handlers.get('error')!({ error: new TypeError('x is undefined'), message: 'x', filename: 'index.js' })
    handlers.get('unhandledrejection')!({ reason: 'enqueue failed' })
    expect(breadcrumbs.getState().current).toMatchObject({ lastUnhandledJsError: { message: 'TypeError: x is undefined' }, lastUnhandledPromiseRejection: { message: 'enqueue failed' } })
  })
})

describe('Historical delivery through the real IndexedDB queue and batch sender', () => {
  const online = { isOnline: () => true, subscribe: () => () => undefined }
  let server: Map<string, NativeObservationInput>
  let requests: ConnectorObservationsRequest[]

  beforeEach(async () => {
    Object.assign(globalThis, { localStorage: new MemoryStorage() })
    observationQueue.setOwnerUserId(`scale-${Date.now()}-${Math.random()}`)
    await observationQueue.initialize()
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    server = new Map()
    requests = []
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request): Promise<ConnectorObservationsResponse> => {
      requests.push(request)
      const results: ConnectorObservationResult[] = request.observations.map((observation) => {
        if (server.has(observation.observationId)) return { observationId: observation.observationId, status: 'duplicate', canonicalStatus: null }
        server.set(observation.observationId, observation)
        return { observationId: observation.observationId, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: 'n' }
      })
      const accepted = results.filter((result) => result.status === 'accepted').length
      return { success: true, batchId: request.batchId, serverTimestamp: '', accepted, duplicate: results.length - accepted, rejected: 0, errors: [], results }
    })
  })
  afterEach(() => vi.restoreAllMocks())

  it.each([300, 1_300])('queues and delivers %i observations with ≤100 per request, then duplicates only on repeat', async (count) => {
    const manager = new ObservationBatchManager({}, online)
    const delivery = new JCVitalPhysiologyDelivery({ queue: observationQueue, deliver: () => manager.process(), subscribe: (listener) => manager.subscribe(listener), resolveDeviceId: () => 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b', breadcrumbs: new CrashBreadcrumbs(() => new MemoryStorage()) })
    delivery.setContext({ bleAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' })
    delivery.setEnabled(true)
    delivery.start()

    await delivery.deliverSyncResult(historicalHr(count))
    expect(server.size).toBe(count)
    expect(requests.every((request) => request.observations.length <= 100)).toBe(true)
    expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 0, inFlight: 0, retrying: 0, failed: 0 })

    delivery.resetDiagnostics()
    await delivery.deliverSyncResult(historicalHr(count))
    expect(server.size).toBe(count)
    expect(delivery.getSnapshot().metrics.heartRateHistory).toMatchObject({ serverAccepted: 0, serverDuplicate: count, failed: 0 })
    delivery.dispose()
  }, 60_000)
})
