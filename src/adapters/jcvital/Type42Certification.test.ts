import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { WebQueueStore } from '../../services/storage/WebQueueStore'
import { ObservationQueue, observationQueue } from '../../services/sync/ObservationQueue'
import { ObservationBatchManager } from '../../services/sync/ObservationBatchManager'
import { authenticationService } from '../../services/base44/AuthenticationService'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import type { NativeObservation } from '../../models/wearableObservation'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent, CertificationFlushOptions, CertificationFlushReport } from '../../services/sync/ObservationBatchManager'
import type { JCVitalV8HistoricalSyncResult, JCVitalV8Plugin } from './jcvitalV8Bridge'
import { mapPhysiologyObservation } from './PhysiologyContract'
import {
  NO_COMPLETE_TYPE42_CERTIFICATION_GROUP, TYPE42_CERTIFICATION_SUCCESS, Type42Certification,
  type Type42CertificationDependencies, type Type42ConnectedContext,
} from './Type42Certification'

const MAC = 'E7:1B:D8:36:78:CF'
const DEVICE = 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b'
const TIME = '2026-10-04T12:00:00.000Z'
const STRINGS = {
  date: '2026.10.04 12:00:00', hrv: '048', vascularAging: '003',
  heartRate: '060', stress: '07', highBP: '120', lowBP: '080',
}
const TYPES = [
  ['HRV_VENDOR', 'hrv'], ['STRESS_VENDOR', 'stress'],
  ['BP_SYSTOLIC_ESTIMATED', 'highBP'], ['BP_DIASTOLIC_ESTIMATED', 'lowBP'],
] as const
type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
function typed(value: string) { return { type: 'String', value } }
function snapshot(fields: Record<string, string>) {
  return { type: 'Map', entries: Object.entries(fields).map(([key, value]) => ({ key: typed(key), value: typed(value) })) }
}

async function fixture() {
  let owner = 'user-1'
  const context: Type42ConnectedContext = {
    scope: { accountId: owner, deviceScopeId: DEVICE }, bleAddress: MAC,
    firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0', ready: true, physical: true, native: true,
  }
  const storageRows = new Map<string, string>()
  const storage = { getItem: (key: string) => storageRows.get(key) ?? null, setItem: (key: string, value: string) => { storageRows.set(key, value) } }
  const journalRows = new Map<string, Entry>()
  const queueRows = new Map<string, QueueRecord>()
  const header = {
    ...context.scope, provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE',
    firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion, acquisitionMode: 'HISTORICAL_SYNC',
  }
  const bytes = Uint8Array.from([42, 1, 2, 3])
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((value) => value.toString(16).padStart(2, '0')).join('')

  function addGroup(id: string, fields = STRINGS): NativeObservation[] {
    const callbackId = `${id}-callback`
    const notificationId = `${id}-ble`
    const sdkSnapshot = snapshot(fields)
    function write(envelopeId: string, json: Record<string, unknown>, rawBytesBase64: string | null = null) {
      journalRows.set(envelopeId, {
        envelopeId, sequence: journalRows.size + 1, sourceFile: null, rawBytesBase64,
        envelopeJson: JSON.stringify({ ...header, envelopeId, ...json }, null, 1),
      })
    }
    write(id, {
      kind: 'SDK_RECORD', vendorDataType: '42', callbackId, notificationEnvelopeId: notificationId,
      recordIndex: 0, sourceRecordId: id, sourceRecordGroupId: callbackId, sdkSnapshot,
      sourceDate: fields.date, sourceDateParseStatus: 'VALID', observedAt: TIME,
    })
    write(callbackId, {
      kind: 'SDK_CALLBACK', vendorDataType: '42', callbackId, notificationEnvelopeId: notificationId,
      recordEnvelopeIds: [id],
      sdkSnapshot: { type: 'Map', entries: [
        { key: typed('dataType'), value: typed('42') },
        { key: typed('dicData'), value: { type: 'List', values: [sdkSnapshot] } },
      ] },
    })
    write(notificationId, { kind: 'BLE_NOTIFICATION', byteLength: bytes.length, sha256: hash }, 'KgECAw==')
    return TYPES.map(([metricType, vendorField]): NativeObservation => ({
      id: `${id}-${metricType}`,
      source: {
        connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: MAC, macAddress: MAC,
        firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion,
      },
      metricType, observedAt: TIME, observedAtSource: fields.date, receivedAt: TIME, timezone: 'UTC',
      value: Number(fields[vendorField]), values: null, unit: 'UNKNOWN_VENDOR_UNIT', acquisitionMode: 'HISTORICAL_SYNC',
      measurementContext: 'HRV_HISTORY', sessionId: null, packetId: null, sequenceNumber: null,
      samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: 'COMPLETE',
      vendorDataType: '42', vendorField, vendorDerived: true, rawPayload: { record: fields },
      provenance: { sourceEnvelopeId: id, sourceRecordId: id, sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
    }))
  }

  const sync: JCVitalV8HistoricalSyncResult = {
    syncId: 'physical-sync', deviceId: MAC, provider: 'JCVITAL', sdkCommand: 'syncHistoricalHrv', vendorDataType: '42',
    startedAt: TIME, completedAt: TIME, recordsReceived: 1, recordGroupsReceived: 1, recordsStored: 0,
    recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: TIME, latestObservation: TIME,
    partial: false, completionStatus: 'COMPLETE', packetCount: 1, parseErrors: [], observations: addGroup('record-1'),
  }
  const acquire = vi.fn(async () => structuredClone(sync))
  const readSourceEnvelope = vi.fn(async (options: { accountId: string; deviceScopeId: string; envelopeId: string }) => {
    if (options.accountId !== owner || options.deviceScopeId !== context.scope.deviceScopeId) throw new Error('OWNER_MISMATCH')
    const entry = journalRows.get(options.envelopeId)
    if (!entry) throw new Error('MISSING')
    return structuredClone(entry)
  })
  const getRecord = vi.fn(async (id: string) => structuredClone(queueRows.get(id) ?? null))
  const enqueueMany = vi.fn(async (payloads: NativeObservationInput[], refs?: ReadonlyMap<string, string>) => {
    expect(storageRows.size).toBeGreaterThan(0)
    return payloads.map((payload) => {
      const record: QueueRecord = {
        queueId: payload.observationId, ownerUserId: owner, observationId: payload.observationId,
        sourceEnvelopeId: refs?.get(payload.observationId), payload: structuredClone(payload), state: 'PENDING',
        createdAt: TIME, updatedAt: TIME, claimedAt: null, attemptCount: 0, nextAttemptAt: null,
        lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null, batchId: null,
        acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
      }
      queueRows.set(payload.observationId, record)
      return { inserted: true, alreadyQueued: false, record: structuredClone(record) }
    })
  })
  let results: ((ids: readonly string[]) => ConnectorObservationResult[]) = (ids) => ids.map((observationId) => ({
    observationId, status: 'accepted', canonicalStatus: 'not_applicable', nativeObservationId: `native-${observationId}`,
  }))
  let acknowledged = true
  let lastEvent: BatchDeliveryEvent | null = null
  let beforePurge: (() => void) | null = null
  const flush = vi.fn(async (ids: readonly string[], options: CertificationFlushOptions): Promise<CertificationFlushReport> => {
    await options.prepare?.()
    const event: BatchDeliveryEvent = {
      batchId: `batch-${flush.mock.calls.length}`, attemptedAt: TIME, outcome: 'DELIVERED',
      observationIds: [...ids], acknowledgedIds: acknowledged ? [...ids] : [], rejectedIds: [],
      httpStatus: 200, errorCode: null, accepted: 4, duplicate: 0, rejected: 0, results: results(ids),
    }
    lastEvent = structuredClone(event)
    options.persistEvidence?.(event)
    beforePurge?.()
    if (acknowledged) for (const id of ids) queueRows.delete(id)
    return { events: [event], reason: null }
  })
  const deps: Type42CertificationDependencies = {
    queue: { getOwnerUserId: () => owner, enqueueMany, getRecord }, acquire, journal: { readSourceEnvelope },
    flush, deliveryDiagnostics: () => ({
      activeBatches: [{ batchId: `batch-${flush.mock.calls.length}`, responseContractVersion: 'native-only-v1', deploymentRevision: 'vc7-deploy' }],
      recentResponseShapes: [],
    }), connectedContext: () => structuredClone(context), storage: () => storage,
  }
  const service = new Type42Certification(deps)
  function mutateEnvelope(id: string, change: (json: Record<string, unknown>) => void) {
    const entry = journalRows.get(id)!
    const json = JSON.parse(entry.envelopeJson)
    change(json)
    entry.envelopeJson = JSON.stringify(json)
  }
  return {
    deps, service, sync, context, acquire, readSourceEnvelope, getRecord, enqueueMany, flush,
    storageRows, storage, journalRows, queueRows, addGroup, mutateEnvelope,
    setOwner(value: string) { owner = value; context.scope.accountId = value },
    setResults(value: typeof results) { results = value },
    setAcknowledged(value: boolean) { acknowledged = value },
    beforePurge(value: () => void) { beforePurge = value },
    lastEvent: () => lastEvent,
  }
}

describe('VC7 grouped type-42 certification', () => {
  it('captures once, preserves exact seven-string source and four unchanged existing scalar IDs/payloads across restart', async () => {
    const f = await fixture()
    const expected = (await Promise.all(f.sync.observations.map((native) => mapPhysiologyObservation('user-1', native, {
      deviceId: DEVICE, firmwareVersion: f.context.firmwareVersion, sdkVersion: f.context.sdkVersion,
    })))).flat().flatMap((mapped) => mapped.status === 'MAPPED' ? [mapped.observation] : [])
    const original = f.journalRows.get('record-1')!.envelopeJson
    await Promise.all([f.service.capture(), f.service.capture()])
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.enqueueMany).not.toHaveBeenCalled()
    const payloads = f.service.snapshot()!.children.map((child) => child.payload)
    expect(payloads).toEqual(expected)
    expect(JSON.stringify(payloads)).not.toMatch(/sourceEnvelopeId|E7:1B|vascularAging|fatigue|heartRate/)
    expect(payloads.map((payload) => payload.metricType)).toEqual(TYPES.map(([type]) => type))
    expect(payloads.every((payload) => payload.rawSourceMetadata?.canonicalPolicy === 'NATIVE_ONLY')).toBe(true)
    const restarted = new Type42Certification(f.deps)
    expect(restarted.snapshot()?.sourceEnvelopeJson).toBe(original)
    expect(restarted.snapshot()?.certificationGroupId).toBe(f.service.snapshot()?.certificationGroupId)
    expect(restarted.snapshot()?.originalStrings).toEqual(STRINGS)
    expect(restarted.snapshot()?.children.every((child) => child.canonicalTarget === null)).toBe(true)
    await restarted.capture()
    expect(f.acquire).toHaveBeenCalledTimes(1)
    const capture = restarted.snapshot()
    f.beforePurge(() => {
      const saved = restarted.snapshot()!
      expect(saved.events).toEqual([f.lastEvent()])
      expect(saved.children.every((child) => child.receipts.length === 1)).toBe(true)
      expect(saved.children.every((child) => child.queueState === null && child.queueDisposition === 'ACKNOWLEDGED_PURGED')).toBe(true)
      expect(f.queueRows.size).toBe(4)
    })
    expect((await restarted.flushSaved()).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
    expect(f.enqueueMany).toHaveBeenCalledTimes(1)
    const [queuedPayloads, refs] = f.enqueueMany.mock.calls[0]
    expect(queuedPayloads).toEqual(expected)
    expect(refs).toBeInstanceOf(Map)
    expect([...refs!]).toEqual(expected.map((payload) => [payload.observationId, 'record-1']))
    expect(f.flush.mock.calls[0][0]).toEqual(capture!.children.map((child) => child.observationId))
    expect(f.flush.mock.calls[0][0]).toHaveLength(4)
    expect(f.queueRows.size).toBe(0)
    const saved = new Type42Certification(f.deps)
    f.acquire.mockClear(); f.flush.mockClear(); f.getRecord.mockClear(); f.enqueueMany.mockClear()
    f.context.ready = false
    expect((await saved.inspectSaved()).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
    const exported = JSON.parse(await saved.exportSaved())
    expect(exported.group.sourceEnvelopeJson).toBe(original)
    expect(exported.group.sourceAncestry).toEqual(saved.snapshot()?.sourceAncestry)
    expect(exported.group.children.map((child: { payload: NativeObservationInput }) => child.payload)).toEqual(expected)
    expect(exported.group.events).toEqual([f.lastEvent()])
    expect(exported.provenance.certificationGroupId).toBe(capture?.certificationGroupId)
    expect(exported.normalizedChildren).toHaveLength(4)
    expect(exported.normalizedChildren[0]).toMatchObject({
      deliveryPolicy: 'NATIVE_ONLY', canonicalTarget: null, sourceEnvelopeId: 'record-1',
      delivery: {
        status: 'accepted', canonicalStatus: 'not_applicable', reason: null, errorCode: null,
        queueDisposition: 'ACKNOWLEDGED_PURGED', queueState: null,
        responseContractVersion: 'native-only-v1', deploymentRevision: 'vc7-deploy',
      },
    })
    expect(exported.normalizedChildren[0].delivery.batchId).toBe(f.lastEvent()?.batchId)
    expect(exported.normalizedChildren[0].delivery.nativeObservationId).toBeTruthy()
    expect(exported.losslessEvidence).toMatchObject({
      vascularAging: { originalString: '003', preserved: true, notPromoted: true },
      embeddedHR: { originalString: '060', preserved: true, notPromoted: true },
      fatigueDegree: { absent: true, notExpected: true },
    })
    expect(exported.group.children[0].receipts[0]).toMatchObject({
      responseContractVersion: 'native-only-v1', deploymentRevision: 'vc7-deploy',
    })
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.getRecord).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })

  it('never mixes children from different source envelopes even with identical date/group scalar IDs', async () => {
    const f = await fixture()
    const other = f.addGroup('record-2')
    f.sync.observations = [...f.sync.observations.slice(0, 2), ...other.slice(2)]
    expect((await f.service.capture()).status).toBe(NO_COMPLETE_TYPE42_CERTIFICATION_GROUP)
    expect(f.service.snapshot()).toBeNull()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
  })

  it('selects one complete real record without uploading unused vascular age, automatic HR or fatigue children', async () => {
    const f = await fixture()
    const incomplete = f.sync.observations.slice(0, 2)
    const complete = f.addGroup('record-2', { ...STRINGS, date: '2026.10.04 12:01:00' })
    const unused: NativeObservation[] = ['HEART_RATE_AUTOMATIC', 'FATIGUE_VENDOR', 'VASCULAR_AGING_VENDOR'].map((type) => ({
      ...complete[0], metricType: type as NativeObservation['metricType'],
    }))
    f.sync.observations = [...incomplete, ...complete, ...unused]
    const inspection = await f.service.capture()
    expect(inspection.group?.sourceEnvelopeId).toBe('record-2')
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(inspection.group?.children).toHaveLength(4)
    expect(inspection.group?.children.map((child) => child.payload.metricType)).toEqual(TYPES.map(([type]) => type))
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })

  it.each(Object.keys(STRINGS))('requires original SDK String %s, not reconstructed scalar values', async (field) => {
    const f = await fixture()
    f.mutateEnvelope('record-1', (json) => {
      const sdk = json.sdkSnapshot as ReturnType<typeof snapshot>
      sdk.entries = sdk.entries.filter((entry) => entry.key.value !== field)
    })
    expect((await f.service.capture()).status).toBe(NO_COMPLETE_TYPE42_CERTIFICATION_GROUP)
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })

  it.each(['numeric SDK type', 'callback missing', 'callback link', 'callback snapshot', 'BLE missing', 'BLE bytes', 'BLE hash', 'provider', 'scope'])(
    'refuses unproven durable ancestry: %s', async (failure) => {
      const f = await fixture()
      if (failure === 'numeric SDK type') f.mutateEnvelope('record-1', (json) => {
        const sdk = json.sdkSnapshot as ReturnType<typeof snapshot>
        sdk.entries.find((entry) => entry.key.value === 'hrv')!.value.type = 'Integer'
      })
      if (failure === 'callback missing') f.journalRows.delete('record-1-callback')
      if (failure === 'callback link') f.mutateEnvelope('record-1-callback', (json) => { json.recordEnvelopeIds = ['different-record'] })
      if (failure === 'callback snapshot') f.mutateEnvelope('record-1-callback', (json) => { json.sdkSnapshot = snapshot({ dicData: 'not-record' }) })
      if (failure === 'BLE missing') f.journalRows.delete('record-1-ble')
      if (failure === 'BLE bytes') f.journalRows.get('record-1-ble')!.rawBytesBase64 = null
      if (failure === 'BLE hash') f.mutateEnvelope('record-1-ble', (json) => { json.sha256 = '0'.repeat(64) })
      if (failure === 'provider') f.mutateEnvelope('record-1', (json) => { json.provider = 'OTHER' })
      if (failure === 'scope') f.mutateEnvelope('record-1', (json) => { json.deviceScopeId = 'other-device' })
      if (failure === 'callback missing' || failure === 'BLE missing') await expect(f.service.capture()).rejects.toThrow('MISSING')
      else expect((await f.service.capture()).status).toBe(NO_COMPLETE_TYPE42_CERTIFICATION_GROUP)
      expect(f.enqueueMany).not.toHaveBeenCalled()
    },
  )

  it.each(['canonicalized', 'no native ID', 'missing result', 'rejected', 'null canonical', 'not acknowledged', 'duplicate no proof'])(
    'cannot claim native-only delivery from %s', async (failure) => {
      const f = await fixture()
      await f.service.capture()
      if (failure === 'not acknowledged') f.setAcknowledged(false)
      f.setResults((ids) => ids.flatMap((observationId, index): ConnectorObservationResult[] => {
        if (index === 0 && failure === 'missing result') return []
        const result: ConnectorObservationResult = {
          observationId, status: 'accepted', canonicalStatus: 'not_applicable', nativeObservationId: `native-${observationId}`,
        }
        if (index === 0) {
          if (failure === 'canonicalized') result.canonicalStatus = 'canonicalized'
          if (failure === 'null canonical') result.canonicalStatus = null
          if (failure === 'no native ID') delete result.nativeObservationId
          if (failure === 'rejected') result.status = 'rejected'
          if (failure === 'duplicate no proof') { result.status = 'duplicate'; delete result.nativeObservationId }
        }
        return [result]
      }))
      const outcome = await f.service.flushSaved()
      expect(outcome.status).toBe('TYPE42_CERTIFICATION_INCOMPLETE')
      expect(outcome.delivered).toBe(failure === 'not acknowledged' ? 0 : 3)
      expect(f.service.snapshot()?.events).toHaveLength(1)
      expect((await f.service.inspectSaved()).status).not.toBe(TYPE42_CERTIFICATION_SUCCESS)
    },
  )

  it('accepts acknowledged native-ID duplicate receipts and rejects unacknowledged duplicates', async () => {
    const f = await fixture()
    await f.service.capture()
    f.setResults((ids) => ids.map((observationId) => ({
      observationId, status: 'duplicate', canonicalStatus: 'not_applicable', nativeObservationId: `native-${observationId}`,
    })))
    f.setAcknowledged(false)
    expect((await f.service.flushSaved()).delivered).toBe(0)
    f.setAcknowledged(true)
    expect((await f.service.flushSaved()).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
  })

  it('links ID-less duplicates only to durable earlier accepted receipts, preserving valid prior proof on bad retries', async () => {
    const f = await fixture()
    await f.service.capture()
    await f.service.flushSaved()
    f.beforePurge(() => undefined)
    f.setResults((ids) => ids.map((observationId) => ({ observationId, status: 'duplicate', canonicalStatus: 'not_applicable' })))
    expect((await new Type42Certification(f.deps).flushSaved()).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
    expect(f.service.snapshot()?.children.every((child) => child.receipts.length === 2)).toBe(true)
    f.setResults((ids) => ids.map((observationId) => ({ observationId, status: 'accepted', canonicalStatus: 'canonicalized' })))
    expect((await f.service.flushSaved()).status).toBe('TYPE42_CERTIFICATION_INCOMPLETE')
    expect(f.service.snapshot()?.children.every((child) => child.receipts.length === 2)).toBe(true)
    expect(f.service.snapshot()?.events).toHaveLength(3)
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.enqueueMany).toHaveBeenCalledTimes(1)
  })

  it('retains PRE-ACK backend accepted proof across restart for acknowledged ID-less duplicates', async () => {
    const f = await fixture()
    await f.service.capture()
    f.setAcknowledged(false)
    expect((await f.service.flushSaved()).delivered).toBe(0)
    expect(f.service.snapshot()?.children.every((child) => child.receipts[0].acknowledged === false)).toBe(true)
    f.setAcknowledged(true)
    f.setResults((ids) => ids.map((observationId) => ({ observationId, status: 'duplicate', canonicalStatus: 'not_applicable' })))
    expect((await new Type42Certification(f.deps).flushSaved()).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
    expect(f.service.snapshot()?.children.every((child) => child.receipts[1].acknowledged)).toBe(true)
  })

  it.each(['canonicalized', 'rejected', 'recovery'])('latest %s blocks earlier successful receipts without destroying them', async (failure) => {
    const f = await fixture()
    await f.service.capture()
    await f.service.flushSaved()
    f.setResults((ids) => ids.map((observationId) => ({
      observationId, status: failure === 'rejected' ? 'rejected' : 'accepted',
      canonicalStatus: failure === 'canonicalized' ? 'canonicalized' : failure === 'recovery' ? 'failed' : 'not_applicable',
      nativeObservationId: `native-${observationId}`,
    })))
    expect((await f.service.flushSaved()).delivered).toBe(0)
    expect(f.service.snapshot()?.children.every((child) => child.receipts.length === 1)).toBe(true)
  })

  it('surfaces journal reads and corrupt JSON, rather than reporting an incomplete record', async () => {
    const f = await fixture()
    f.readSourceEnvelope.mockRejectedValueOnce(new Error('Journal disk failure'))
    await expect(f.service.capture()).rejects.toThrow('Journal disk failure')
    f.journalRows.get('record-1')!.envelopeJson = '{corrupt'
    await expect(f.service.capture()).rejects.toThrow()
  })

  it('surfaces certification storage failure without enqueueing or fabricating incomplete capture', async () => {
    const f = await fixture()
    const service = new Type42Certification({
      ...f.deps, storage: () => ({ getItem: () => null, setItem: () => { throw new Error('Certification storage full') } }),
    })
    await expect(service.capture()).rejects.toThrow('Certification storage full')
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })

  it.each(['NETWORK_OFFLINE', 'DELIVERY_PAUSED', 'ACTIVE_BATCH_DEADLINE'])(
    'retains targeted flush reason %s across restart and export', async (reason) => {
      const f = await fixture()
      await f.service.capture()
      f.flush.mockResolvedValueOnce({ events: [], reason })
      const inspection = await f.service.flushSaved()
      expect(inspection.reason).toBe(reason)
      expect(inspection.group?.lastFlushReason).toBe(reason)
      const restarted = new Type42Certification(f.deps)
      expect((await restarted.inspectSaved()).reason).toBe(reason)
      expect(JSON.parse(await restarted.exportSaved()).group.lastFlushReason).toBe(reason)
    },
  )

  it('exports unexpected fatigue fields truthfully while retaining their exact source snapshots', async () => {
    const f = await fixture()
    f.mutateEnvelope('record-1', (json) => {
      const sdk = json.sdkSnapshot as ReturnType<typeof snapshot>
      sdk.entries.push({ key: typed('fatigueDegree'), value: typed('005') })
    })
    f.mutateEnvelope('record-1-callback', (json) => {
      const sdk = json.sdkSnapshot as { entries: Array<{ key: { value: string }; value: { values: unknown[] } }> }
      sdk.entries.find((entry) => entry.key.value === 'dicData')!.value.values[0]
        = JSON.parse(f.journalRows.get('record-1')!.envelopeJson).sdkSnapshot
    })
    await f.service.capture()
    const exported = JSON.parse(await f.service.exportSaved())
    expect(exported.losslessEvidence.fatigueDegree).toMatchObject({
      present: true, absent: false, notExpected: true, notPromoted: true,
      fields: [{ key: typed('fatigueDegree'), value: typed('005') }],
    })
    expect(exported.group.sourceEnvelopeJson).toBe(f.journalRows.get('record-1')!.envelopeJson)
  })

  it('validates persisted UUID and blocks latest missing results without deleting successful proof', async () => {
    const f = await fixture()
    await f.service.capture()
    await f.service.flushSaved()
    f.setResults(() => [])
    expect((await f.service.flushSaved()).delivered).toBe(0)
    expect(f.service.snapshot()?.children.every((child) => child.receipts.length === 1)).toBe(true)
    const [key, text] = [...f.storageRows][0]
    const group = JSON.parse(text)
    group.certificationGroupId = 'not-a-uuid'
    f.storageRows.set(key, JSON.stringify(group))
    expect((await f.service.inspectSaved()).status).toBe('TYPE42_CERTIFICATION_EVIDENCE_INVALID')
  })

  it('retries a saved group after enqueue failure without reacquisition', async () => {
    const f = await fixture()
    f.enqueueMany.mockRejectedValueOnce(new Error('queue disk failed'))
    await f.service.capture()
    await expect(f.service.flushSaved()).rejects.toThrow('queue disk failed')
    expect(f.service.snapshot()?.children).toHaveLength(4)
    const restarted = new Type42Certification(f.deps)
    await restarted.capture()
    expect((await restarted.flushSaved()).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })

  it.each(['envelope whitespace', 'raw bytes', 'payload', 'receipt', 'original strings'])(
    'inspect/export detect saved evidence changes without queue or network: %s', async (change) => {
      const f = await fixture()
      await f.service.capture()
      await f.service.flushSaved()
      if (change === 'envelope whitespace') f.journalRows.get('record-1')!.envelopeJson += '\n'
      if (change === 'raw bytes') f.journalRows.get('record-1-ble')!.rawBytesBase64 = 'AAECAw=='
      if (['payload', 'receipt', 'original strings'].includes(change)) {
        const [key, text] = [...f.storageRows][0]
        const group = JSON.parse(text)
        if (change === 'payload') group.children[0].payload.valueNumber = 999
        if (change === 'receipt') group.children[0].receipts[0].nativeObservationId = 'not-linked'
        if (change === 'original strings') group.originalStrings.vascularAging = '3'
        f.storageRows.set(key, JSON.stringify(group))
      }
      f.acquire.mockClear(); f.getRecord.mockClear(); f.flush.mockClear(); f.enqueueMany.mockClear()
      expect((await new Type42Certification(f.deps).inspectSaved()).status).toBe('TYPE42_CERTIFICATION_EVIDENCE_INVALID')
      await expect(f.service.exportSaved()).rejects.toThrow()
      expect(f.acquire).not.toHaveBeenCalled()
      expect(f.getRecord).not.toHaveBeenCalled()
      expect(f.flush).not.toHaveBeenCalled()
      expect(f.enqueueMany).not.toHaveBeenCalled()
    },
  )

  it('isolates owners and device scopes and refuses cross-owner enqueue/flush', async () => {
    const f = await fixture()
    await f.service.capture()
    f.setOwner('user-2')
    expect(f.service.snapshot()).toBeNull()
    expect((await f.service.inspectSaved()).status).toBe(NO_COMPLETE_TYPE42_CERTIFICATION_GROUP)
    expect((await f.service.flushSaved()).status).toBe(NO_COMPLETE_TYPE42_CERTIFICATION_GROUP)
    expect(f.flush).not.toHaveBeenCalled()
    f.setOwner('user-1')
    const originalScope = f.context.scope.deviceScopeId
    f.context.scope.deviceScopeId = 'jcvital_device_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    expect(f.service.snapshot()).toBeNull()
    f.context.scope.deviceScopeId = originalScope
    f.acquire.mockImplementationOnce(async () => { f.setOwner('user-3'); return structuredClone(f.sync) })
    // Saved evidence stops capture before invoking a new acquisition.
    await f.service.capture()
    expect(f.acquire).toHaveBeenCalledTimes(1)
    f.setOwner('user-2')
    await expect(f.service.capture()).rejects.toThrow('Account or device changed')
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })

  it('rejects queue payload/reference contamination before the exact targeted flush', async () => {
    const f = await fixture()
    await f.service.capture()
    f.setAcknowledged(false)
    await f.service.flushSaved()
    const child = f.service.snapshot()!.children[0]
    f.queueRows.get(child.observationId)!.sourceEnvelopeId = 'different-record'
    await expect(f.service.flushSaved()).rejects.toThrow('local source reference differs')
    expect(f.flush).toHaveBeenCalledTimes(2)
    expect(f.service.snapshot()?.events).toHaveLength(1)
  })

  it.each(['prior source reference', 'prior payload', 'prior owner', 'prior type'])(
    'fails immutable alreadyQueued collisions without overwriting or sending: %s', async (collision) => {
      const f = await fixture()
      await f.service.capture()
      const group = f.service.snapshot()!
      const originalEnqueue = f.enqueueMany.getMockImplementation()!
      let conflictingRow: QueueRecord | null = null
      f.enqueueMany.mockImplementationOnce(async (payloads, refs) => {
        const results = await originalEnqueue(payloads, refs)
        const result = results[0]
        result.inserted = false
        result.alreadyQueued = true
        if (collision === 'prior source reference') result.record.sourceEnvelopeId = 'earlier-physical-occurrence'
        if (collision === 'prior payload') result.record.payload.valueNumber = 999
        if (collision === 'prior owner') result.record.ownerUserId = 'earlier-owner'
        if (collision === 'prior type') result.record.payload.metricType = 'HEART_RATE'
        conflictingRow = structuredClone(result.record)
        f.queueRows.set(result.record.observationId, structuredClone(result.record))
        return results
      })
      await expect(f.service.flushSaved()).rejects.toThrow('Queued type-42 payload or local source reference differs')
      expect(f.lastEvent()).toBeNull()
      expect(f.queueRows.get(group.children[0].observationId)).toEqual(conflictingRow)
      expect(f.service.snapshot()?.sourceEnvelopeId).toBe(group.sourceEnvelopeId)
      expect(f.service.snapshot()?.children.every((child) => child.receipts.length === 0)).toBe(true)
      expect(f.acquire).toHaveBeenCalledTimes(1)
    },
  )

  it.each(['ready', 'physical', 'native'] as const)('requires connected %s proof before acquisition', async (flag) => {
    const f = await fixture()
    f.context[flag] = false
    await expect(f.service.capture()).rejects.toThrow('ready physical native')
    expect(f.acquire).not.toHaveBeenCalled()
  })
    it('real manager leaves 10k backlog byte-exact, waits for active HR, targets four IDs, and resumes ordinary claims', async () => {
      const f = await fixture()
      vi.stubGlobal('localStorage', {
        ...f.storage, removeItem: (key: string) => { f.storageRows.delete(key) },
      })
      const queue = new ObservationQueue(new WebQueueStore())
      queue.setOwnerUserId('user-1')
      await queue.initialize()
      vi.spyOn(observationQueue, 'getOwnerUserId').mockImplementation(() => queue.getOwnerUserId())
      vi.spyOn(observationQueue, 'getRecord').mockImplementation((id) => queue.getRecord(id))
      vi.spyOn(observationQueue, 'getDiagnostics').mockImplementation(() => queue.getDiagnostics())
      vi.spyOn(observationQueue, 'getQueueStats').mockImplementation(() => queue.getQueueStats())
      vi.spyOn(observationQueue, 'getCanonicalRecoveryBatches').mockImplementation((limit) => queue.getCanonicalRecoveryBatches(limit))
      vi.spyOn(observationQueue, 'releaseStaleInFlight').mockImplementation((time) => queue.releaseStaleInFlight(time))
      vi.spyOn(observationQueue, 'getPending').mockImplementation((limit) => queue.getPending(limit))
      vi.spyOn(observationQueue, 'getNextRetryAt').mockImplementation(() => queue.getNextRetryAt())
      vi.spyOn(observationQueue, 'claimPending').mockImplementation((limit, batch) => queue.claimPending(limit, batch))
      vi.spyOn(observationQueue, 'claimCertificationObservationIds').mockImplementation((ids, batch) => queue.claimCertificationObservationIds(ids, batch))
      vi.spyOn(observationQueue, 'acknowledgeClaims').mockImplementation((claims) => queue.acknowledgeClaims(claims))
      vi.spyOn(observationQueue, 'purgeAcknowledged').mockImplementation((ids) => queue.purgeAcknowledged(ids))
      vi.spyOn(observationQueue, 'markCanonicalRecoveryRequired').mockImplementation((claims, error) => queue.markCanonicalRecoveryRequired(claims, error))
      vi.spyOn(observationQueue, 'recordCanonicalRecoveryPause').mockImplementation((batch, count, at) => queue.recordCanonicalRecoveryPause(batch, count, at))
      vi.spyOn(observationQueue, 'failClaims').mockImplementation((claims, error) => queue.failClaims(claims, error))
      vi.spyOn(observationQueue, 'retryClaims').mockImplementation((claims, error, at) => queue.retryClaims(claims, error, at))
      vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
      connectorIdentityService.setConnectorDeviceId('type42-integration-connector')
      const manager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0 }, { isOnline: () => true, subscribe: () => () => undefined })
      const service = new Type42Certification({
        ...f.deps, queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options),
        deliveryDiagnostics: () => manager.getDeliveryDiagnostics(),
      })
      let releaseHr!: () => void
      let held = false
      let idlessDuplicate = false
      const holding = new Promise<void>((resolve) => { releaseHr = resolve })
      const send = vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request, options) => {
        if (held && request.observations[0].vendorDataType === '27') await holding
        const response = {
          success: true, batchId: request.batchId, serverTimestamp: TIME,
          accepted: request.observations.length, duplicate: 0, rejected: 0, errors: [],
          results: request.observations.map((payload) => ({
            observationId: payload.observationId, status: idlessDuplicate && payload.vendorDataType === '42' ? 'duplicate' as const : 'accepted' as const,
            canonicalStatus: payload.vendorDataType === '42' ? 'not_applicable' as const : 'canonicalized' as const,
            ...(idlessDuplicate && payload.vendorDataType === '42' ? {} : { nativeObservationId: `native-${payload.observationId}` }),
          })),
        }
        options?.onHttpResponse?.(200)
        options?.onResponseBody?.({ ...response, responseContractVersion: 'real-vc7', deploymentRevision: 'real-revision' })
        return response
      })
      async function backlogSnapshot(ids: string[]) {
        const database = await new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(queue.getDiagnostics().queueDatabaseName)
          request.onsuccess = () => resolve(request.result)
          request.onerror = () => reject(request.error)
        })
        try {
          const rows = await new Promise<QueueRecord[]>((resolve, reject) => {
            const request = database.transaction('observation_queue', 'readonly').objectStore('observation_queue').getAll()
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error)
          })
          const byId = new Map(rows.filter((row) => row.ownerUserId === 'user-1').map((row) => [row.observationId, row]))
          return ids.map((id) => byId.get(id) ?? null)
        } finally { database.close() }
      }
      try {
        await service.capture()
        const base = service.snapshot()!.children[0].payload
        const backlog = Array.from({ length: 10_000 }, (_, index) => ({
          ...base, observationId: index.toString(16).padStart(64, '0'),
          metric: 'heartRate', metricType: 'HEART_RATE', vendorDataType: '27', vendorField: 'arrayDynamicHR',
        }))
        await queue.enqueueMany(backlog)
        const ids = backlog.map((payload) => payload.observationId)
        const before = await backlogSnapshot(ids)
        let releasePreparation!: () => void
        const preparationHeld = new Promise<void>((resolve) => { releasePreparation = resolve })
        const originalEnqueue = queue.enqueueMany.bind(queue)
        const enqueue = vi.spyOn(queue, 'enqueueMany').mockImplementationOnce(async (payloads, refs) => {
          await preparationHeld
          return originalEnqueue(payloads, refs)
        })
        const preparedFlush = service.flushSaved()
        try {
          await vi.waitFor(() => expect(enqueue).toHaveBeenCalledTimes(1), { timeout: 15_000 })
          expect(await manager.process()).toBeNull()
          expect(send).not.toHaveBeenCalled()
          expect(await backlogSnapshot(ids)).toEqual(before)
          expect(service.snapshot()!.children.every((child) => child.queueDisposition === 'MISSING')).toBe(true)
        } finally { releasePreparation() }
        expect((await preparedFlush).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
        expect(enqueue.mock.calls[0][0].map((payload) => payload.observationId))
          .toEqual(service.snapshot()!.children.map((child) => child.observationId))
        expect(send).toHaveBeenCalledTimes(1)
        expect(send.mock.calls[0][0].observations.map((payload) => payload.observationId))
          .toEqual(service.snapshot()!.children.map((child) => child.observationId))
        expect(await backlogSnapshot(ids)).toEqual(before)
        expect(service.snapshot()!.children[0].receipts[0]).toMatchObject({
          responseContractVersion: 'real-vc7', deploymentRevision: 'real-revision',
        })
        await queue.enqueueMany(service.snapshot()!.children.map((child) => child.payload),
          new Map(service.snapshot()!.children.map((child) => [child.observationId, child.sourceEnvelopeId])))
        held = true
        const ordinary = manager.process()
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2), { timeout: 15_000 })
        const stages: string[] = []
        const targeted = service.flushSaved((stage) => { stages.push(stage) })
        await vi.waitFor(() => expect(stages).toContain('Waiting for active batch'))
        expect(await manager.process()).toBeNull()
        expect(send).toHaveBeenCalledTimes(2)
        releaseHr()
        await ordinary
        expect((await targeted).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
        expect(send.mock.calls.map(([request]) => request.observations.length)).toEqual([4, 100, 4])
        const activeIds = new Set(send.mock.calls[1][0].observations.map((payload) => payload.observationId))
        const untouchedIds = ids.filter((id) => !activeIds.has(id))
        expect(await backlogSnapshot(untouchedIds)).toEqual(before.filter((row) => row && !activeIds.has(row.observationId)))
        await manager.process()
        expect(send.mock.calls[3][0].observations.every((payload) => payload.vendorDataType === '27')).toBe(true)
        expect(f.acquire).toHaveBeenCalledTimes(1)
        // A fresh durable certification must survive the real sender's local ACK failure.
        const retryFixture = await fixture()
        const retryDeps: Type42CertificationDependencies = {
          ...retryFixture.deps, queue,
          flush: (selectedIds, options) => manager.flushCertificationObservationIds(selectedIds, options),
          deliveryDiagnostics: () => manager.getDeliveryDiagnostics(),
        }
        const retryService = new Type42Certification(retryDeps)
        await retryService.capture()
        vi.mocked(observationQueue.acknowledgeClaims).mockRejectedValueOnce(new Error('Local ACK disk failure'))
        expect((await retryService.flushSaved()).delivered).toBe(0)
        expect(retryService.snapshot()!.children.every((child) => child.receipts.length > 0
          && child.receipts.every((receipt) => !receipt.acknowledged))).toBe(true)
        idlessDuplicate = true
        expect((await new Type42Certification(retryDeps).flushSaved()).status).toBe(TYPE42_CERTIFICATION_SUCCESS)
        expect(retryService.snapshot()!.children.every((child) => child.receipts.some((receipt) =>
          receipt.result.status === 'duplicate' && !receipt.result.nativeObservationId && receipt.acknowledged))).toBe(true)
      } finally {
        releaseHr()
        manager.stop()
        vi.restoreAllMocks()
        vi.unstubAllGlobals()
      }
    }, 120_000)
})
