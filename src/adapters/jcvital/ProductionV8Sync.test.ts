import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { NativeObservation } from '../../models/wearableObservation'
import { authenticationService } from '../../services/base44/AuthenticationService'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import type { ConnectorObservationResult, ConnectorObservationsRequest, ConnectorObservationsResponse } from '../../services/base44/base44Types'
import { JCVitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'
import { ObservationBatchManager } from '../../services/sync/ObservationBatchManager'
import type { NetworkStatus } from '../../services/sync/NetworkStatus'
import { observationQueue } from '../../services/sync/ObservationQueue'
import type { JCVitalV8HistoricalHrChunk, JCVitalV8HistoricalSyncLifecycleEvent, JCVitalV8HistoricalSyncResult, SourceJournalScope } from './jcvitalV8Bridge'
import { ProductionSyncLedger } from './ProductionSyncLedger'
import {
  PRODUCTION_SYNC_SOURCES,
  PRODUCTION_SYNC_STAGE_LABELS,
  ProductionV8Sync,
  type ProductionSyncOwners,
  type ProductionSyncMetric,
  type ProductionSyncStage,
} from './ProductionV8Sync'

class TestStorage implements Storage {
  private values = new Map<string, string>()
  get length() { return this.values.size }
  clear() { this.values.clear() }
  getItem(key: string) { return this.values.get(key) ?? null }
  key(index: number) { return [...this.values.keys()][index] ?? null }
  removeItem(key: string) { this.values.delete(key) }
  setItem(key: string, value: string) { this.values.set(key, value) }
}

const MAC = 'E7:1B:D8:36:78:CF'
const RECEIPT = '2026-10-02T00:00:00.000Z'
/** Device history is deliberately old: sync must never refresh it to "now". */
const OLD_DAY = '2026-09-01'

function nativeSyncId(vendorDataType: string): string {
  return `00000000-0000-4000-8000-${vendorDataType.padStart(12, '0')}`
}

function native(metricType: string, vendorDataType: string, vendorField: string, value: number, vendorDate: string, observedAt: string, extra: Partial<NativeObservation> = {}): NativeObservation {
  return {
    id: crypto.randomUUID(),
    source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: MAC, macAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
    metricType: metricType as NativeObservation['metricType'], observedAt, observedAtSource: vendorDate, receivedAt: RECEIPT, timezone: 'America/New_York',
    value, values: null, unit: 'x', acquisitionMode: 'HISTORICAL_SYNC', measurementContext: null, sessionId: null, packetId: null,
    sequenceNumber: null, samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: null,
    vendorDataType, vendorField, vendorDerived: false,
    rawPayload: { record: { date: vendorDate } },
    provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', sourceRecordId: `${MAC}|${vendorDataType}|${vendorDate}`, sourceEnvelopeId: `env-${vendorDataType}-${vendorDate}` },
    ...extra,
  }
}

function hrSeries(vendorDate: string, startIso: string, values: number[]): NativeObservation[] {
  return values.map((value, sequence) => native('HEART_RATE_CONTINUOUS', '27', 'arrayDynamicHR', value, vendorDate,
    new Date(Date.parse(startIso) + sequence * 5_000).toISOString(), { sequenceNumber: sequence, samplingIntervalMs: 5_000 }))
}
function spo2(values: number[], hour = 4): NativeObservation[] {
  return values.map((value, index) => native('SPO2', '68', 'Blood_oxygen', value, `2026.09.01 0${index}:30:00`, `${OLD_DAY}T${String(hour + index).padStart(2, '0')}:30:00.000Z`))
}
function temperature(values: number[]): NativeObservation[] {
  return values.map((value, index) => native('WEARABLE_TEMPERATURE', '59', 'temperature', value, `2026.09.01 08:${index}0:00`, `${OLD_DAY}T12:${index}0:00.000Z`))
}

function historical(vendorDataType: string, sdkCommand: string, observations: NativeObservation[], extra: Partial<JCVitalV8HistoricalSyncResult> = {}): JCVitalV8HistoricalSyncResult {
  const times = observations.map((item) => item.observedAt!).sort()
  return {
    syncId: crypto.randomUUID(), deviceId: MAC, provider: 'JCVITAL', sdkCommand, vendorDataType, startedAt: RECEIPT, completedAt: RECEIPT,
    recordsReceived: observations.length, recordGroupsReceived: observations.length ? 1 : 0, recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0,
    earliestObservation: times[0] ?? null, latestObservation: times.at(-1) ?? null, partial: false, completionStatus: observations.length ? 'COMPLETE' : 'EMPTY_VALID',
    nativeRequestAccepted: true, nativeCommandQueued: true, nativeCommandWritten: true,
    packetCount: 1, parseErrors: [], observations, sourceRecordEnvelopeIds: observations.length ? [`env-${vendorDataType}`] : [], ...extra,
  }
}

const ALLOWED_BRIDGE_METHODS = new Set([
  'getConnectionState', 'getSourceJournalDiagnostics', 'syncHistoricalHeartRate', 'ackHistoricalHrChunk',
  'syncHistoricalSpo2', 'syncHistoricalTemperature', 'addListener',
])

/** Fake native bridge that records order, overlap, ACKs and every property touched. */
class FakeV8 {
  readonly calls: string[] = []
  readonly touched = new Set<string>()
  readonly acks: Array<{ syncSessionId: string; chunkIndex: number }> = []
  active: string | null = null
  overlaps = 0
  state: 'READY' | 'DISCONNECTED' = 'READY'
  deviceId: string | null = MAC
  hrChunks: NativeObservation[][] = []
  spo2: NativeObservation[] = []
  temperature: NativeObservation[] = []
  fail: Partial<Record<'hr' | 'spo2' | 'temperature', Error>> = {}
  disconnectAfter: 'hr' | 'spo2' | null = null
  nativeScope: SourceJournalScope | null = null
  journal = { enabled: true, failedClosed: false }
  envelopeCount = 100
  private hrListener: ((chunk: JCVitalV8HistoricalHrChunk) => void) | null = null
  private lifecycleListeners = new Set<(event: JCVitalV8HistoricalSyncLifecycleEvent) => void>()

  proxy(): ConstructorParameters<typeof ProductionV8Sync>[0]['bridge'] {
    return new Proxy(this, {
      get: (target, property, receiver) => {
        if (typeof property === 'string') target.touched.add(property)
        const value = Reflect.get(target, property, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    }) as never
  }

  private async begin(name: string): Promise<void> {
    this.calls.push(name)
    if (this.active) this.overlaps++
    this.active = name
    await new Promise((resolve) => setTimeout(resolve, 1))
  }

  async getConnectionState() { return { state: this.state, deviceId: this.deviceId } }
  async getSourceJournalDiagnostics(scope: SourceJournalScope) {
    if (!this.nativeScope) throw Object.assign(new Error('Source journal scope is not configured.'), { code: 'SCOPE_NOT_CONFIGURED' })
    if (scope.accountId !== this.nativeScope.accountId || scope.deviceScopeId !== this.nativeScope.deviceScopeId) {
      throw Object.assign(new Error('Source journal owner mismatch.'), { code: 'OWNER_MISMATCH' })
    }
    return { modelVersion: 'test', enabled: this.journal.enabled, failedClosed: this.journal.failedClosed, lastOutcome: 'OK', refusedCount: 0,
      totalEnvelopeCount: this.envelopeCount, totalStoredBytes: 0, maxBytes: 0, maxEnvelopes: 0, maxEntryBytes: 0, retentionPolicy: 'test', rawStorage: 'test' }
  }
  async addListener(event: 'jcvitalHistoricalHrChunk', listener: (chunk: JCVitalV8HistoricalHrChunk) => void): Promise<{ remove: () => Promise<void> }>
  async addListener(event: 'jcvitalHistoricalSyncLifecycle', listener: (event: JCVitalV8HistoricalSyncLifecycleEvent) => void): Promise<{ remove: () => Promise<void> }>
  async addListener(
    event: 'jcvitalHistoricalHrChunk' | 'jcvitalHistoricalSyncLifecycle',
    listener: ((chunk: JCVitalV8HistoricalHrChunk) => void) | ((event: JCVitalV8HistoricalSyncLifecycleEvent) => void),
  ) {
    if (event === 'jcvitalHistoricalHrChunk') {
      this.hrListener = listener as (chunk: JCVitalV8HistoricalHrChunk) => void
      return { remove: async () => { this.hrListener = null } }
    }
    const lifecycleListener = listener as (event: JCVitalV8HistoricalSyncLifecycleEvent) => void
    this.lifecycleListeners.add(lifecycleListener)
    return { remove: async () => { this.lifecycleListeners.delete(lifecycleListener) } }
  }
  private emitLifecycle(vendorDataType: string) {
    const syncId = nativeSyncId(vendorDataType)
    for (const stage of ['REQUEST_ACCEPTED', 'NATIVE_COMMAND_QUEUED', 'NATIVE_COMMAND_WRITTEN', 'ACQUIRING'] as const) {
      this.lifecycleListeners.forEach((listener) => listener({
        syncId, vendorDataType, connectionGeneration: 9, stage,
        nativeRequestAccepted: true, nativeCommandQueued: true, nativeCommandWritten: true,
      }))
    }
  }
  async ackHistoricalHrChunk(options: { syncSessionId: string; chunkIndex: number }) { this.acks.push(options) }
  async syncHistoricalHeartRate(): Promise<JCVitalV8HistoricalSyncResult> {
    await this.begin('GetDynamicHRWithMode')
    try {
      if (this.fail.hr) throw this.fail.hr
      this.emitLifecycle('27')
      const total = this.hrChunks.reduce((sum, chunk) => sum + chunk.length, 0)
      this.hrChunks.forEach((observations, chunkIndex) => this.hrListener?.({
        syncSessionId: 'hr-session', chunkIndex, isFinal: chunkIndex === this.hrChunks.length - 1, vendorDataType: '27', safeTestLimit: null,
        sourceRecordCount: 1, plannedSampleCount: total, sampleCount: observations.length, emittedSampleCountTotal: total, estimatedSerializedBytes: 10, observations,
      }))
      const all = this.hrChunks.flat()
      this.envelopeCount += all.length ? 1 : 0
      return { ...historical('27', 'GetDynamicHRWithMode', all, { syncId: nativeSyncId('27') }), observations: [], streamed: true,
        stream: { syncSessionId: 'hr-session', chunkSize: 500, safeTestLimit: null, safeTestLimitReached: false, packetCount: 1,
          vendorRecordCount: 1, bufferedRecordCount: 1, vendorRecordOrder: 'NEWEST_FIRST', vendorAscendingTransitions: 0,
          vendorDescendingTransitions: 0, emittedOrder: 'CHRONOLOGICAL_BY_RECORD_START', outOfOrderEmitted: 0,
          plannedSampleCount: total, expandedSampleCount: total, emittedSampleCount: total, validSampleCount: total,
          skippedNoMeasurementCount: 0, duplicateCount: 0, chunkCount: this.hrChunks.length, largestChunkCount: 0,
          estimatedSerializedChunkBytes: 0, parseErrorCount: 0, finalEmitted: true } }
    } finally {
      this.active = null
      if (this.disconnectAfter === 'hr') this.state = 'DISCONNECTED'
    }
  }
  async syncHistoricalSpo2(): Promise<JCVitalV8HistoricalSyncResult> {
    await this.begin('Oxygen_data')
    try {
      if (this.fail.spo2) throw this.fail.spo2
      this.emitLifecycle('68')
      return historical('68', 'Oxygen_data', this.spo2, { syncId: nativeSyncId('68') })
    } finally {
      this.active = null
      if (this.disconnectAfter === 'spo2') this.state = 'DISCONNECTED'
    }
  }
  async syncHistoricalTemperature(): Promise<JCVitalV8HistoricalSyncResult> {
    await this.begin('GetTemperature_historyData')
    try {
      if (this.fail.temperature) throw this.fail.temperature
      this.emitLifecycle('59')
      return historical('59', 'GetTemperature_historyData', this.temperature, { syncId: nativeSyncId('59') })
    } finally { this.active = null }
  }
  // Present so the proxy can prove they are never touched.
  async syncHistoricalWorkoutHeartRate() { this.calls.push('Type82'); throw new Error('forbidden') }
  async syncHistoricalActivity() { this.calls.push('Activity'); throw new Error('forbidden') }
  async syncHistoricalSleep() { this.calls.push('Sleep'); throw new Error('forbidden') }
  async syncHistoricalHrv() { this.calls.push('Type42'); throw new Error('forbidden') }
  async syncHistoricalPpi() { this.calls.push('PPI'); throw new Error('forbidden') }
  async startRawPpg() { this.calls.push('RawPPG'); throw new Error('forbidden') }
}

class FakeBase44 {
  readonly seen = new Set<string>()
  readonly requests: ConnectorObservationsRequest[] = []
  rejectMetric: string | null = null
  respond(request: ConnectorObservationsRequest): ConnectorObservationsResponse {
    this.requests.push(request)
    const results: ConnectorObservationResult[] = request.observations.map((observation) => {
      const observationId = observation.observationId
      if (observation.metric === this.rejectMetric) return { observationId, status: 'rejected', reason: 'invalid', errorCode: 'VALIDATION_ERROR', canonicalStatus: null, nativeObservationId: null }
      if (this.seen.has(observationId)) return { observationId, status: 'duplicate', reason: null, errorCode: null, canonicalStatus: null, nativeObservationId: null }
      this.seen.add(observationId)
      return { observationId, status: 'accepted', reason: null, errorCode: null, canonicalStatus: 'canonicalized', nativeObservationId: `native-${this.seen.size}` }
    })
    const count = (status: string) => results.filter((result) => result.status === status).length
    return { success: true, batchId: request.batchId, serverTimestamp: new Date().toISOString(), accepted: count('accepted'), duplicate: count('duplicate'),
      rejected: count('rejected'), errors: [], processing: { mode: 'sync' }, results } as ConnectorObservationsResponse
  }
}

let counter = 0

describe('Build 32B production V8 sync', () => {
  let owner: string
  let fake: FakeV8
  let backend: FakeBase44
  let manager: ObservationBatchManager
  let ledgerStorage: TestStorage
  let identity: JCVitalDeviceIdentityService
  let scope: SourceJournalScope
  let online: boolean
  let stages: ProductionSyncStage[]

  function owners(overrides: Partial<ProductionSyncOwners> = {}): ProductionSyncOwners {
    return { authenticatedOwnerUserId: owner, persistedConnectorOwnerUserId: owner, connectorDeviceId: 'connector-1', ...overrides }
  }

  function createSync(ledger = new ProductionSyncLedger(() => ledgerStorage), allowMetricSubset = true) {
    return new ProductionV8Sync({
      bridge: fake.proxy(),
      queue: observationQueue,
      delivery: manager,
      ledger,
      resolveDeviceScopeId: (address) => identity.resolve(address),
      allowMetricSubset,
      finalHrChunkWaitMs: 50,
      deliveryPollMs: 1,
      deliveryDeadlineMs: 10_000,
    })
  }

  function run(sync = createSync(), input: { owners?: ProductionSyncOwners; scope?: SourceJournalScope | null; metrics?: readonly ProductionSyncMetric[] } = {}) {
    stages = []
    return sync.run({
      appVersion: '1.0.0-rc4-sync',
      versionCode: 38,
      owners: input.owners ?? owners(),
      journalScope: input.scope === undefined ? scope : input.scope,
      device: { bleDeviceId: MAC, name: 'PRO V8', firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
      ...(input.metrics ? { metrics: input.metrics } : {}),
      onProgress: (stage) => stages.push(stage),
    })
  }

  function acquisitionCalls(): string[] {
    return fake.calls.filter((call) => call !== 'getConnectionState')
  }

  beforeEach(async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    owner = `prod-sync-${Date.now()}-${counter++}`
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    connectorIdentityService.setConnectorDeviceId('connector-1')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    online = true
    const network: NetworkStatus = { isOnline: () => online, subscribe: () => () => undefined }
    manager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0, requestTimeoutMs: 1000 }, network)
    backend = new FakeBase44()
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.respond(request))
    ledgerStorage = new TestStorage()
    const identityStorage = new TestStorage()
    identity = new JCVitalDeviceIdentityService(() => identityStorage)
    scope = { accountId: owner, deviceScopeId: identity.resolve(MAC) }
    fake = new FakeV8()
    fake.nativeScope = scope
    fake.hrChunks = [
      hrSeries('2026.09.01 08:00:00', `${OLD_DAY}T12:00:00.000Z`, [61, 62, 63]),
      hrSeries('2026.09.01 08:00:00', `${OLD_DAY}T12:00:00.000Z`, [61, 62, 63, 64, 65]).slice(3),
    ]
    fake.spo2 = spo2([97, 98])
    fake.temperature = temperature([33.4])
  })
  afterEach(() => { vi.restoreAllMocks() })

  describe('preflight', () => {
    it('requires READY before any acquisition', async () => {
      fake.state = 'DISCONNECTED'
      const receipt = await run()
      expect(receipt.outcome).toBe('BLOCKED')
      expect(receipt.errors[0].code).toBe('DEVICE_NOT_READY')
      expect(acquisitionCalls()).toEqual([])
    })

    it('accepts a matching authenticated, persisted, journal and queue owner', async () => {
      const receipt = await run()
      expect(receipt.accountScope).toMatchObject({ authenticatedOwnerUserId: owner, persistedConnectorOwnerUserId: owner, queueOwnerUserId: owner, journalScopeAccountId: owner, match: true })
      expect(receipt.deviceScopeId).toBe(scope.deviceScopeId)
      expect(receipt.outcome).toBe('UP_TO_DATE')
    })

    it.each([
      ['persisted Connector owner', () => ({ owners: owners({ persistedConnectorOwnerUserId: 'someone-else' }) })],
      ['missing persisted Connector owner', () => ({ owners: owners({ persistedConnectorOwnerUserId: null }) })],
      ['journal scope owner', () => ({ scope: { ...scope, accountId: 'someone-else' } })],
    ])('blocks sync on a %s mismatch without acquisition or migration', async (_label, input) => {
      const receipt = await run(createSync(), input())
      expect(receipt.outcome).toBe('BLOCKED')
      expect(receipt.errors[0].code).toBe('OWNER_MISMATCH')
      expect(receipt.accountScope.match).toBe(false)
      expect(acquisitionCalls()).toEqual([])
      expect(backend.requests).toHaveLength(0)
    })

    it('blocks when the durable queue owner differs', async () => {
      observationQueue.setOwnerUserId('other-owner')
      const receipt = await run()
      expect(receipt.outcome).toBe('BLOCKED')
      expect(receipt.errors[0].message).toContain('durable queue owner')
      expect(acquisitionCalls()).toEqual([])
    })

    it('blocks when the native active journal scope belongs to another owner', async () => {
      fake.nativeScope = { ...scope, accountId: 'other-owner' }
      const receipt = await run()
      expect(receipt.outcome).toBe('BLOCKED')
      expect(receipt.errors[0].code).toBe('OWNER_MISMATCH')
      expect(acquisitionCalls()).toEqual([])
    })

    it('blocks without a bound journal scope, a closed journal or a foreign device scope', async () => {
      expect((await run(createSync(), { scope: null })).errors[0].code).toBe('SCOPE_NOT_CONFIGURED')
      expect((await run(createSync(), { scope: { ...scope, deviceScopeId: identity.resolve('00:11:22:33:44:55') } })).errors[0].code).toBe('DEVICE_SCOPE_MISMATCH')
      fake.journal.failedClosed = true
      expect((await run()).errors[0].code).toBe('SOURCE_JOURNAL_UNAVAILABLE')
      expect((await run(createSync(), { owners: owners({ authenticatedOwnerUserId: null }) })).errors[0].code).toBe('NOT_AUTHENTICATED')
      expect(acquisitionCalls()).toEqual([])
    })
  })

  describe('acquisition', () => {
    it('reads Type27, then Type68, then Type59 using the existing certified commands, never overlapping', async () => {
      const receipt = await run()
      expect(acquisitionCalls()).toEqual(['GetDynamicHRWithMode', 'Oxygen_data', 'GetTemperature_historyData'])
      expect(fake.overlaps).toBe(0)
      expect(receipt.isolation.nativeCommandsIssued).toEqual(['GetDynamicHRWithMode', 'Oxygen_data', 'GetTemperature_historyData'])
      expect(receipt.requestedMetrics).toEqual(['heartRate', 'oxygenSaturation', 'wearableTemperature'])
      expect(PRODUCTION_SYNC_SOURCES.map((source) => source.vendorDataType)).toEqual(['27', '68', '59'])
      expect(receipt.sources.map((source) => [source.source, source.status])).toEqual([
        ['HEART_RATE', 'SUCCESS'], ['BLOOD_OXYGEN', 'SUCCESS'], ['TEMPERATURE', 'SUCCESS'],
      ])
      expect(receipt.sources.map((source) => [source.bridgeInvoked, source.nativeRequestAccepted, source.nativeCommandQueued, source.nativeCommandWritten, source.callbackReceived, source.acquisitionCompleted]))
        .toEqual(Array.from({ length: 3 }, () => [true, true, true, true, true, true]))
      expect(receipt.sources.map((source) => [source.acquisitionId, source.acquisitionRequestId, source.connectionGeneration]))
        .toEqual(Array.from({ length: 3 }, () => [expect.any(String), expect.any(String), 9]))
      expect(new Set(receipt.sources.map((source) => source.acquisitionId)).size).toBe(3)
      expect(new Set(receipt.sources.map((source) => source.acquisitionRequestId)).size).toBe(3)
    })

    it('runs the engineering subset through the same production path without issuing Type27', async () => {
      const receipt = await run(createSync(), { metrics: ['oxygenSaturation', 'wearableTemperature'] })
      expect(acquisitionCalls()).toEqual(['Oxygen_data', 'GetTemperature_historyData'])
      expect(receipt.isolation.nativeCommandsIssued).toEqual(['Oxygen_data', 'GetTemperature_historyData'])
      expect(receipt.requestedMetrics).toEqual(['oxygenSaturation', 'wearableTemperature'])
      expect(receipt.sources.map((source) => source.status)).toEqual(['NOT_REQUESTED', 'SUCCESS', 'SUCCESS'])
      expect(receipt.sources.map((source) => source.requested)).toEqual([false, true, true])
      expect(receipt.sources[0].bridgeInvoked).toBe(false)
    })

    it('rejects subset selection when the engineering-only gate is disabled', async () => {
      await expect(run(createSync(undefined, false), { metrics: ['oxygenSaturation'] })).rejects.toMatchObject({ code: 'ENGINEERING_SUBSET_DISABLED' })
      expect(acquisitionCalls()).toEqual([])
    })

    it('continues from SpO₂ NO_DATA to temperature', async () => {
      fake.spo2 = []
      const receipt = await run(createSync(), { metrics: ['oxygenSaturation', 'wearableTemperature'] })
      expect(acquisitionCalls()).toEqual(['Oxygen_data', 'GetTemperature_historyData'])
      expect(receipt.sources.map((source) => source.status)).toEqual(['NOT_REQUESTED', 'NO_DATA', 'SUCCESS'])
      expect(receipt.sources[1]).toMatchObject({
        nativeRequestAccepted: true, nativeCommandWritten: true, callbackReceived: true,
        acquisitionCompleted: true, nativeCompletionStatus: 'EMPTY_VALID', sourceRecordCount: 0,
        observationCount: 0,
      })
      expect(receipt.outcome).toBe('UP_TO_DATE')
    })

    it('completes normally for temperature NO_DATA', async () => {
      fake.temperature = []
      const receipt = await run(createSync(), { metrics: ['wearableTemperature'] })
      expect(acquisitionCalls()).toEqual(['GetTemperature_historyData'])
      expect(receipt.sources.map((source) => source.status)).toEqual(['NOT_REQUESTED', 'NOT_REQUESTED', 'NO_DATA'])
      expect(receipt.sources[2]).toMatchObject({
        nativeRequestAccepted: true, nativeCommandWritten: true, callbackReceived: true,
        acquisitionCompleted: true, nativeCompletionStatus: 'EMPTY_VALID', sourceRecordCount: 0,
        observationCount: 0,
      })
      expect(receipt.outcome).toBe('UP_TO_DATE')
    })

    it('never starts Type82, Activity, Sleep, Type42, PPI, Type29 or Raw PPG', async () => {
      await run()
      for (const property of fake.touched) {
        if (['then', 'constructor'].includes(property)) continue
        expect(ALLOWED_BRIDGE_METHODS.has(property), `unexpected bridge access: ${property}`).toBe(true)
      }
      expect(fake.calls).not.toEqual(expect.arrayContaining(['Type82']))
      for (const forbidden of ['Type82', 'Activity', 'Sleep', 'Type42', 'PPI', 'RawPPG']) expect(fake.calls).not.toContain(forbidden)
    })

    it('acknowledges every streamed HR chunk after it is persisted', async () => {
      const enqueue = vi.spyOn(observationQueue, 'enqueueMany')
      await run()
      expect(fake.acks).toEqual([{ syncSessionId: 'hr-session', chunkIndex: 0 }, { syncSessionId: 'hr-session', chunkIndex: 1 }])
      expect(enqueue.mock.calls[0][0].every((row) => row.metric === 'heartRate' || row.vendorDataType === '27')).toBe(true)
    })

    it('reports a consumer stage sequence ending in Up to date', async () => {
      await run()
      expect(stages).toEqual(['CHECKING', 'READING_HEART_RATE', 'READING_BLOOD_OXYGEN', 'READING_TEMPERATURE', 'SAVING', 'DELIVERING', 'UP_TO_DATE'])
      expect(stages.slice(1).map((stage) => PRODUCTION_SYNC_STAGE_LABELS[stage])).toEqual([
        'Reading Heart Rate from V8…', 'Reading Blood Oxygen from V8…', 'Reading Temperature from V8…', 'Saved on this device', 'Sending to Elite+…', 'Synced',
      ])
      for (const label of Object.values(PRODUCTION_SYNC_STAGE_LABELS)) expect(label).not.toMatch(/JCVital|Type|\b(27|68|59|82)\b/)
    })

    it('continues after a partial source failure and reports PARTIAL', async () => {
      fake.fail.spo2 = Object.assign(new Error('Oxygen timeout'), { code: 'HISTORY_TIMEOUT' })
      const receipt = await run()
      expect(acquisitionCalls()).toEqual(['GetDynamicHRWithMode', 'Oxygen_data', 'GetTemperature_historyData'])
      expect(receipt.outcome).toBe('PARTIAL')
      expect(receipt.sources[1]).toMatchObject({ status: 'FAILED', error: { code: 'HISTORY_TIMEOUT', source: 'BLOOD_OXYGEN' } })
      expect(receipt.sources[0].new).toBe(5)
      expect(receipt.sources[2].new).toBe(1)
      expect(receipt.delivery.ackCount).toBe(6)
      expect(receipt.sources[2].status).toBe('SUCCESS')
    })

    it('continues from a failed SpO₂ subset to temperature while the transport remains healthy', async () => {
      fake.fail.spo2 = Object.assign(new Error('Oxygen timeout'), { code: 'HISTORY_TIMEOUT' })
      const receipt = await run(createSync(), { metrics: ['oxygenSaturation', 'wearableTemperature'] })
      expect(acquisitionCalls()).toEqual(['Oxygen_data', 'GetTemperature_historyData'])
      expect(receipt.sources.map((source) => source.status)).toEqual(['NOT_REQUESTED', 'FAILED', 'SUCCESS'])
      expect(receipt.sources[1]).toMatchObject({ errorCode: 'HISTORY_TIMEOUT', nativeCommandWritten: false })
      expect(receipt.sources[2].bridgeInvoked).toBe(true)
      expect(receipt.outcome).toBe('PARTIAL')
    })

    it('skips remaining sources when the V8 disconnects mid-sync', async () => {
      fake.disconnectAfter = 'hr'
      const receipt = await run()
      expect(acquisitionCalls()).toEqual(['GetDynamicHRWithMode'])
      expect(receipt.sources.map((source) => source.status)).toEqual(['SUCCESS', 'SKIPPED', 'SKIPPED'])
      expect(receipt.sources.slice(1).map((source) => source.skipReason)).toEqual([
        'Elite+ V8 is DISCONNECTED; remaining sources were not read.',
        'Elite+ V8 is DISCONNECTED; remaining sources were not read.',
      ])
      expect(receipt.sources[1].skipReason).toContain('DISCONNECTED')
      expect(receipt.sources[2].skipReason).toBe(receipt.sources[1].skipReason)
      expect(receipt.outcome).toBe('PARTIAL')
      expect(receipt.delivery.ackCount).toBe(5)
    })

    it('does not mark an unrequested metric as attempted after another metric fails', async () => {
      fake.fail.spo2 = Object.assign(new Error('Oxygen timeout'), { code: 'HISTORY_TIMEOUT' })
      const receipt = await run(createSync(), { metrics: ['oxygenSaturation'] })
      expect(receipt.sources[1]).toMatchObject({ status: 'FAILED', bridgeInvoked: true, callbackReceived: false })
      expect(receipt.sources[2]).toMatchObject({ status: 'NOT_REQUESTED', bridgeInvoked: false, nativeCommandQueued: false })
    })
  })

  describe('persistence, dedup and delivery', () => {
    it('enqueues new HR, SpO₂ and temperature observations with device timestamps preserved', async () => {
      const enqueue = vi.spyOn(observationQueue, 'enqueueMany')
      const receipt = await run()
      const rows = enqueue.mock.calls.flatMap((call) => call[0])
      expect(rows.map((row) => row.vendorDataType)).toEqual(['27', '27', '27', '27', '27', '68', '68', '59'])
      expect(receipt.sources.map((source) => source.new)).toEqual([5, 2, 1])
      expect(receipt.queue.queued).toBe(8)
      for (const row of rows) {
        expect(row.observedAt?.startsWith(OLD_DAY)).toBe(true)
        expect(row.observedAt).not.toBe(receipt.startedAt)
        expect(row.receivedAt).toBe(RECEIPT)
        expect(Date.parse(row.receivedAt!)).toBeGreaterThan(Date.parse(row.observedAt!))
        expect(row.startTime).toBe(row.observedAt)
      }
      expect(rows.find((row) => row.vendorDataType === '68')?.observedAt).toBe(`${OLD_DAY}T04:30:00.000Z`)
      expect(rows.find((row) => row.vendorDataType === '59')?.observedAt).toBe(`${OLD_DAY}T12:00:00.000Z`)
      expect(receipt.totals.latestDeviceTimestamp).toBe(`${OLD_DAY}T12:00:20.000Z`)
      expect(receipt.isolation.observedAtRewritten).toBe(false)
      expect(Date.parse(receipt.startedAt)).toBeGreaterThan(Date.parse(receipt.totals.latestDeviceTimestamp!))
      expect(receipt.sources.map((source) => source.latestObservedAt)).toEqual(receipt.sources.map((source) => source.latestDeviceTimestamp))
      expect(receipt.queueBefore).toEqual({ pending: 0, retrying: 0, inFlight: 0, failed: 0, acknowledged: 0 })
      expect(receipt.queue.newlyEnqueued).toBe(8)
      expect(receipt.delivery.attempts).toBe(receipt.delivery.rounds)
      expect(enqueue.mock.calls[0][1]?.size).toBeGreaterThan(0)
    })

    it('delivers through the durable sender, matches results, ACKs and purges', async () => {
      const receipt = await run()
      const sentObservations = backend.requests.flatMap((request) => request.observations)
      expect(sentObservations).toHaveLength(8)
      expect(sentObservations.every((observation) => !Object.hasOwn(observation, 'syncId')
        && !Object.hasOwn(observation, 'acquisitionId')
        && !Object.hasOwn(observation, 'acquisitionRequestId')
        && !Object.hasOwn(observation, 'acquisitionProvenance'))).toBe(true)
      expect(receipt.delivery).toMatchObject({ delivered: 8, serverAccepted: 8, serverDuplicate: 0, serverRejected: 0, ackCount: 8, purgeCount: 8, unresolved: 0 })
      expect(receipt.delivery.canonical.canonicalized).toBe(8)
      const stats = await observationQueue.getQueueStats()
      expect(stats.pending + stats.retrying + stats.inFlight + stats.acknowledged).toBe(0)
      for (const id of backend.seen) expect(await observationQueue.getRecord(id)).toBeNull()
    })

    it('does not re-enqueue duplicate source records on the next sync', async () => {
      await run()
      const enqueue = vi.spyOn(observationQueue, 'enqueueMany')
      const second = await run()
      expect(enqueue).not.toHaveBeenCalled()
      expect(second.sources.map((source) => [source.received, source.new, source.duplicate])).toEqual([[5, 0, 5], [2, 0, 2], [1, 0, 1]])
      expect(second.outcome).toBe('UP_TO_DATE')
      expect(second.delivery.delivered).toBe(0)
      expect(backend.requests.flatMap((request) => request.observations)).toHaveLength(8)
    })

    it('deduplicates existing history and enqueues one genuinely new record from each production source', async () => {
      await run()
      fake.hrChunks = [
        ...fake.hrChunks,
        hrSeries('2026.09.02 08:00:00', '2026-09-02T12:00:00.000Z', [72]),
      ]
      fake.spo2 = [
        ...fake.spo2,
        native('SPO2', '68', 'Blood_oxygen', 99, '2026.09.02 00:30:00', '2026-09-02T12:30:00.000Z'),
      ]
      fake.temperature = [
        ...fake.temperature,
        native('WEARABLE_TEMPERATURE', '59', 'temperature', 34.1, '2026.09.02 08:00:00', '2026-09-02T12:00:00.000Z'),
      ]
      const enqueue = vi.spyOn(observationQueue, 'enqueueMany')
      const receipt = await run()
      const rows = enqueue.mock.calls.flatMap((call) => call[0])

      expect(receipt.sources.map(({ received, new: newCount, duplicate }) => [received, newCount, duplicate])).toEqual([
        [6, 1, 5], [3, 1, 2], [2, 1, 1],
      ])
      expect(rows.map((row) => row.vendorDataType)).toEqual(['27', '68', '59'])
      expect(receipt.queue.newlyEnqueued).toBe(3)
      expect(receipt.delivery.serverAccepted).toBe(3)
      expect(receipt.outcome).toBe('UP_TO_DATE')
    })

    it('enqueues only the new records when old history is re-read alongside new data', async () => {
      await run()
      fake.spo2 = [...spo2([97, 98]), ...spo2([0, 0, 95], 10).slice(2)]
      const enqueue = vi.spyOn(observationQueue, 'enqueueMany')
      const second = await run()
      expect(enqueue.mock.calls.flatMap((call) => call[0]).map((row) => row.valueNumber)).toEqual([95])
      expect(second.sources[1]).toMatchObject({ received: 3, new: 1, duplicate: 2 })
      expect(second.delivery.serverAccepted).toBe(1)
    })

    it('treats no new data as an Up to date success', async () => {
      fake.hrChunks = []
      fake.spo2 = []
      fake.temperature = []
      const receipt = await run()
      expect(receipt.outcome).toBe('UP_TO_DATE')
      expect(receipt.errors).toEqual([])
      expect(receipt.totals).toMatchObject({ received: 0, new: 0, latestDeviceTimestamp: null })
      expect(stages.at(-1)).toBe('UP_TO_DATE')
    })

    it('counts no-measurement placeholders without enqueueing them', async () => {
      fake.spo2 = spo2([0, 97])
      const receipt = await run()
      expect(receipt.sources[1]).toMatchObject({ received: 2, new: 1, noMeasurement: 1 })
    })

    it('reports Base44 duplicate and rejected results', async () => {
      const prior = createSync(new ProductionSyncLedger(() => new TestStorage()))
      await run(prior)
      backend.rejectMetric = 'wearableTemperature'
      const temperatureId = [...backend.seen].at(-1)!
      backend.seen.delete(temperatureId)
      // A fresh ledger (e.g. reinstall) re-enqueues history; Base44 dedups by deterministic observationId.
      const receipt = await run(createSync(new ProductionSyncLedger(() => new TestStorage())))
      expect(receipt.delivery.serverDuplicate).toBe(7)
      expect(receipt.delivery.serverRejected).toBe(1)
      expect(receipt.delivery.ackCount).toBe(7)
      expect(receipt.outcome).toBe('PARTIAL')
    })

    it('keeps new rows queued and reports pending delivery when offline', async () => {
      online = false
      const receipt = await run()
      expect(receipt.outcome).toBe('PENDING_DELIVERY')
      expect(receipt.queue.queued).toBe(8)
      expect(receipt.delivery.unresolved).toBe(8)
      expect(backend.requests).toHaveLength(0)
      expect((await observationQueue.getQueueStats()).pending).toBe(8)
      const queuedRows = await observationQueue.listDiagnosticRecords()
      expect(queuedRows).toHaveLength(8)
      expect(queuedRows.every((row) => {
        const provenance = row.acquisitionProvenance
        const source = receipt.sources.find((item) => item.metric === provenance?.requestedMetric)
        return Boolean(provenance)
          && provenance!.syncId === receipt.syncId
          && provenance!.acquisitionCompletedAt === source?.acquisitionCompletedAt
          && provenance!.connectionGeneration === 9
          && !Object.hasOwn(row.payload, 'acquisitionProvenance')
      })).toBe(true)
      expect(receipt.sources.flatMap((source) => Object.values(source.observationProvenance))).toHaveLength(8)
      online = true
      const later = await run()
      expect(later.sources.every((source) => source.new === 0)).toBe(true)
      expect((await observationQueue.getQueueStats()).pending).toBe(0)
    })

    it('persists a complete exportable receipt', async () => {
      const stored: unknown[] = []
      const sync = new ProductionV8Sync({
        bridge: fake.proxy(), queue: observationQueue, delivery: manager, ledger: new ProductionSyncLedger(() => ledgerStorage),
        resolveDeviceScopeId: (address) => identity.resolve(address), finalHrChunkWaitMs: 50, deliveryPollMs: 1,
        storeReceipt: (receipt) => { stored.push(JSON.parse(JSON.stringify(receipt)) as typeof receipt) },
      })
      const receipt = await run(sync)
      expect(stored.at(-1)).toEqual(receipt)
      expect(stored.length).toBeGreaterThan(1)
      expect((stored[0] as typeof receipt).sources.map((source) => source.status)).toEqual(['REQUESTED', 'REQUESTED', 'REQUESTED'])
      expect(receipt).toMatchObject({
        schema: 'elite-plus.v8-production-sync-receipt.v2',
        appVersion: '1.0.0-rc4-sync',
        versionCode: 38,
        physicalDevice: { bleDeviceId: MAC, name: 'PRO V8', firmwareVersion: '0.0.8.8', connectionState: 'READY' },
        sourceJournal: { enabled: true, failedClosed: false },
        isolation: { backgroundScheduler: false },
      })
      expect(receipt.syncId).toMatch(/[0-9a-f-]{36}/)
      expect(receipt.completedAt).not.toBeNull()
      for (const source of receipt.sources) {
        expect(source.acquisitionId).toMatch(/[0-9a-f-]{36}/)
        expect(source.acquisitionRequestId).toMatch(/[0-9a-f-]{36}/)
        expect(source.acquisitionStartedAt).toBe(source.startedAt)
        expect(source.acquisitionCompletedAt).toBe(source.completedAt)
        expect(source.acquisitionRequestId).toBe(source.nativeSyncId)
        expect(source.connectionGeneration).toBe(9)
        expect(Object.values(source.observationProvenance).every((provenance) =>
          provenance.syncId === receipt.syncId
          && provenance.acquisitionId === source.acquisitionId
          && provenance.acquisitionRequestId === source.acquisitionRequestId
          && provenance.requestedMetric === source.metric
          && provenance.acquisitionCompletedAt === source.acquisitionCompletedAt)).toBe(true)
      }
      const persistedRows = await observationQueue.listDiagnosticRecords()
      for (const row of persistedRows) {
        const source = receipt.sources.find((item) => item.metric === row.acquisitionProvenance?.requestedMetric)
        expect(row.acquisitionProvenance?.acquisitionRequestId).toBe(source?.nativeSyncId)
      }
      for (const source of receipt.sources) {
        expect(source.received).toBe(source.new + source.duplicate + source.rejected + source.noMeasurement)
      }
    })

    it('refuses a second concurrent run', async () => {
      const sync = createSync()
      const first = run(sync)
      await expect(sync.run({ appVersion: 'x', versionCode: 38, owners: owners(), journalScope: scope, device: { bleDeviceId: MAC, name: null, firmwareVersion: null, sdkVersion: null } }))
        .rejects.toThrow('already running')
      await first
      expect(fake.overlaps).toBe(0)
    })
  })
})

describe('ProductionSyncLedger', () => {
  const slot = (groupKey: string, index: number, observedAtMs: number) => ({ groupKey, vendorDataType: '68', index, observedAtMs })

  it('is scoped per owner and device scope and compacts slot ranges', () => {
    const storage = new TestStorage()
    const ledger = new ProductionSyncLedger(() => storage)
    ledger.record('a', 's', [slot('g', 0, 1), slot('g', 1, 1), slot('g', 3, 1), slot('g', 2, 1)])
    expect(ledger.has('a', 's', slot('g', 2, 1))).toBe(true)
    expect(ledger.has('a', 's', slot('g', 4, 1))).toBe(false)
    expect(ledger.has('b', 's', slot('g', 2, 1))).toBe(false)
    expect(ledger.has('a', 't', slot('g', 2, 1))).toBe(false)
    expect(storage.getItem('elitePlus.v8ProductionSyncLedger.v1:a:s')).toContain('[[0,3]]')
    expect(new ProductionSyncLedger(() => storage).has('a', 's', slot('g', 1, 1))).toBe(true)
  })

  it('caps stored groups and treats anything at or below the pruned floor as already synced', () => {
    const ledger = new ProductionSyncLedger(() => new TestStorage(), 2)
    ledger.record('a', 's', [slot('g1', 0, 10), slot('g2', 0, 20), slot('g3', 0, 30)])
    expect(ledger.size('a', 's')).toBe(2)
    expect(ledger.has('a', 's', slot('g1', 0, 10))).toBe(true)
    expect(ledger.has('a', 's', slot('old', 0, 5))).toBe(true)
    expect(ledger.has('a', 's', slot('new', 0, 40))).toBe(false)
  })
})

describe('Build 32B wiring contract', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('routes only the production Sync Device Data action through ProductionV8Sync', () => {
    const app = read('../../App.tsx')
    const production = app.slice(app.indexOf('if (!IS_ENGINEERING_BUILD || companionView) {'), app.indexOf('<main className="shell engineering-shell">'))
    const engineering = app.slice(app.indexOf('<main className="shell engineering-shell">'))
    expect(production).toContain('getSyncOwners=')
    expect(engineering).toContain('getSyncOwners=')
    const panel = read('./ElitePlusV8Panel.tsx')
    expect(panel).toContain('onSync={getSyncOwners ? () => void runProductionSync() : onSync}')
    expect(panel).toContain("onTestSpo2Temperature={() => void runProductionSync(['oxygenSaturation', 'wearableTemperature'])}")
    expect(read('./PipelineDiagnosticV8Panel.tsx')).not.toContain('connectionOnly')
  })

  it('adds no background scheduler and no Base44 or canonical changes in the sync path', () => {
    const files = ['./ProductionV8Sync.ts', './ProductionSyncLedger.ts', '../../services/storage/ConnectorOwnerBinding.ts', './ElitePlusV8Panel.tsx']
    for (const file of files) {
      const source = read(file)
      expect(source).not.toMatch(/WorkManager|ForegroundService|BackgroundTask|registerPeriodic/)
      if (!file.endsWith('Panel.tsx')) expect(source).not.toContain('setInterval')
      expect(source).not.toMatch(/invokeConnectorFunction|nativeConnectorObservations/)
    }
    const sync = read('./ProductionV8Sync.ts')
    const calledMethods = [...sync.matchAll(/bridge\.(\w+)\(/g)].map((match) => match[1])
    const acquisition = [...new Set(calledMethods.filter((name) => /^(sync|start|read)/.test(name)))].sort()
    expect(new Set(calledMethods)).toEqual(new Set(['ackHistoricalHrChunk', 'addListener', 'getConnectionState', 'getSourceJournalDiagnostics', 'syncHistoricalHeartRate', 'syncHistoricalSpo2', 'syncHistoricalTemperature']))
    expect(acquisition).toEqual(['syncHistoricalHeartRate', 'syncHistoricalSpo2', 'syncHistoricalTemperature'])
  })
})
