import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type { NativeObservation } from '../../models/wearableObservation'
import type { NativeObservationInput, ConnectorObservationResult } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent, CertificationFlushOptions, CertificationFlushReport } from '../../services/sync/ObservationBatchManager'
import type { Type42ConnectedContext } from './Type42Certification'
import type { JCVitalV8HistoricalSyncResult, JCVitalV8Plugin } from './jcvitalV8Bridge'
import { Activity24_25Certification, ActivityFinalizationError, ACTIVITY_MAPPING, ACTIVITY_CERTIFICATION_FILENAME, sampleActivityEpochs, activityCertificationStatus, type ActivityDependencies } from './Activity24_25Certification'
import { ActivityCertificationJsonView, ActivityFinalizationReportView, Activity24_25CertificationView } from './Activity24_25CertificationView'
import { activityJsonAction } from './ActivityCertificationJson'
import { findPhysiologyContract, PHYSIOLOGY_CONTRACTS } from './PhysiologyContract'
import { sha256Hex } from './HeartRateSeries'
import { ACTIVITY_RESPONSE_CONTRACT, ACTIVITY_R5_REVISION, ACTIVITY_VC17_SESSION, ACTIVITY_VC17_SUMMARY } from './ActivityResumeContract'
import * as hashes from './HeartRateSeries'
import { ACTIVITY_EXCLUDED_ID, ACTIVITY_RESUME_IDS, ACTIVITY_VC17_GROUP, ACTIVITY_SEMANTIC_CONFLICT } from './ActivityResumeContract'
import { activityTransportClaimable, verifyActivityTransport, type ActivityTransportEvidence } from '../../services/storage/ActivityCertificationTransport'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: vi.fn(() => ({})) }))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///cache/${path}` })) },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn(async () => ({})) } }))

const DEVICE = 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b'
const DATE = '2026.10.04'
const TIME = '2026-10-04T00:00:00.000Z'
type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
const typed = (value: unknown) => value === null ? { type: 'null' } : { type: 'String', value }
const snapshot = (fields: Record<string, unknown>) => ({
  type: 'Map', entries: Object.entries(fields).map(([key, value]) => ({ key: typed(key), value: typed(value) })),
})

async function activityFixture(vc18 = false) {
  const SESSION = vc18 ? ACTIVITY_VC17_SESSION : 'physical-activity-session'
  const summaryId = vc18 ? ACTIVITY_VC17_SUMMARY : 'summary-first'
  const context: Type42ConnectedContext = {
    scope: { accountId: 'user-activity', deviceScopeId: DEVICE }, bleAddress: 'E7:1B:D8:36:78:CF',
    ready: true, native: true, physical: true, firmwareVersion: '1', sdkVersion: 'v8sdk2.0',
  }
  const storageRows = new Map<string, string>()
  const journalRows = new Map<string, Entry>()
  const queueRows = new Map<string, QueueRecord>()
  const storage = { getItem: (key: string) => storageRows.get(key) ?? null, setItem: (key: string, value: string) => { storageRows.set(key, value) } }
  const header = {
    ...context.scope, provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE', acquisitionMode: 'HISTORICAL_SYNC',
    sessionId: SESSION, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion, timezone: 'UTC',
  }
  function write(id: string, value: Record<string, unknown>, rawBytesBase64: string | null = null) {
    journalRows.set(id, { envelopeId: id, sequence: journalRows.size + 1, envelopeJson: JSON.stringify({ ...header, envelopeId: id, ...value }), rawBytesBase64, sourceFile: null })
  }
  async function record(id: string, type: '24' | '25', fields: Record<string, unknown>) {
    if (id === 'summary-first') id = summaryId
    const sdkSnapshot = snapshot(fields)
    const observedAt = new Date(String(fields.date).replaceAll('.', '-').replace(' ', 'T') + (type === '24' ? 'T00:00:00Z' : 'Z')).toISOString()
    const raw = Uint8Array.from([type === '24' ? 0x51 : 0x52, 0, 1, 2])
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))).map((byte) => byte.toString(16).padStart(2, '0')).join('')
    write(`${id}-ble`, { kind: 'BLE_NOTIFICATION', byteLength: raw.length, sha256: sha }, btoa(String.fromCharCode(...raw)))
    write(`${id}-callback`, { kind: 'SDK_CALLBACK', vendorDataType: type, callbackId: `${id}-callback`, notificationEnvelopeId: `${id}-ble`,
      recordEnvelopeIds: [id], sdkSnapshot: snapshot({ dataType: type }) })
    const callback = JSON.parse(journalRows.get(`${id}-callback`)!.envelopeJson)
    callback.sdkSnapshot.entries.push({ key: typed('dicData'), value: { type: 'List', values: [sdkSnapshot] } })
    journalRows.get(`${id}-callback`)!.envelopeJson = JSON.stringify(callback)
    write(id, {
      kind: 'SDK_RECORD', vendorDataType: type, callbackId: `${id}-callback`, notificationEnvelopeId: `${id}-ble`,
      sourceRecordId: id, sourceRecordGroupId: `${id}-callback`, recordIndex: 0, sourceIndex: 0, packetId: null,
      sourceDate: fields.date, observedAt, parsedSourceDateMillis: Date.parse(observedAt), sourceDateParseStatus: 'VALID', sdkSnapshot,
    })
    return ACTIVITY_MAPPING.filter(([vendorType, name]) => type === vendorType && Object.hasOwn(fields, name)).flatMap(([, name, metricType, unit]) => {
      const values = name === 'arraySteps' ? String(fields.arraySteps).split(' ').map(Number) : [Number(fields[name])]
      return values.map((value, index): NativeObservation => ({
        id: `${type}-${metricType}-${fields.date}-${index}`,
        source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: context.bleAddress,
          macAddress: context.bleAddress, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion },
        metricType, observedAt: new Date(Date.parse(observedAt) + (name === 'arraySteps' ? index * 60_000 : 0)).toISOString(),
        observedAtSource: String(fields.date), receivedAt: TIME, timezone: 'UTC', value, values: null, unit,
        acquisitionMode: 'HISTORICAL_SYNC', measurementContext: name === 'arraySteps' ? 'ONE_MINUTE_STEP_EPOCH' : type === '24' ? 'DAILY_ACTIVITY' : 'DETAIL_ACTIVITY_BLOCK',
        sessionId: SESSION, packetId: null, sequenceNumber: name === 'arraySteps' ? index : null,
        samplingIntervalMs: name === 'arraySteps' ? 60_000 : null, sampleRateHz: null, signalQuality: null, completeness: 'COMPLETE',
        vendorDataType: type, vendorField: name, vendorDerived: false, rawPayload: { record: fields as Record<string, string> },
        provenance: { sourceEnvelopeId: id, sourceRecordId: id, provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE' },
      }))
    })
  }
  const summaryFields = { date: DATE, step: vc18 ? '105' : '0090', exerciseMinutes: vc18 ? '2690' : '0',
    distance: vc18 ? '0.06' : '0.00', calories: vc18 ? '2.86' : '0.00', goal: '0', unknown: null }
  const detailFields = { date: `${DATE} 12:00:00`, detailMinterStep: vc18 ? '35' : '30', calories: vc18 ? '1' : '0',
    distance: vc18 ? '0.02' : '0', arraySteps: vc18 ? '0 35 0 0 0 0 0 0 0 0' : '1 2 0 4 5 6 7 8 9 10', unknown: null }
  const summary = await record('summary-first', '24', summaryFields)
  const duplicateSummary = await record('summary-repeat', '24', summaryFields)
  const first = await record('detail-first', '25', detailFields)
  const repeat = await record('detail-repeat', '25', detailFields)
  const last = await record('detail-last', '25', { ...detailFields, date: `${DATE} 12:20:00`,
    ...(vc18 ? { calories: '0.85', distance: '0' } : {}) })
  const result = (type: string, observations: NativeObservation[], ids: string[]): JCVitalV8HistoricalSyncResult => ({
    syncId: SESSION, deviceId: context.bleAddress, provider: 'JCVITAL', sdkCommand: type === '24' ? 'GetTotalActivityDataWithMode' : 'GetDetailActivityDataWithMode',
    vendorDataType: type, startedAt: TIME, completedAt: TIME, recordsReceived: observations.length, recordGroupsReceived: ids.length,
    recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: TIME, latestObservation: TIME,
    partial: false, completionStatus: 'COMPLETE', packetCount: 1, parseErrors: [], observations, sourceRecordEnvelopeIds: ids,
  })
  const acquisition = { acquisitionSessionId: SESSION, results: [
    result('24', [...summary, ...duplicateSummary], [summaryId, 'summary-repeat']),
    result('25', [...first, ...repeat, ...last], ['detail-first', 'detail-repeat', 'detail-last']),
  ] }
  const acquire = vi.fn(async () => structuredClone(acquisition))
  const readSourceEnvelope = vi.fn(async ({ envelopeId }: { envelopeId: string }) => {
    const row = journalRows.get(envelopeId)
    if (!row) throw new Error('MISSING_SOURCE')
    return structuredClone(row)
  })
  const enqueueMany = vi.fn(async (payloads: NativeObservationInput[], refs?: ReadonlyMap<string, string>) => payloads.map((payload) => {
    expect(JSON.parse([...storageRows.values()][0]).state).toBe('CAPTURED')
    const row: QueueRecord = {
      queueId: payload.observationId, observationId: payload.observationId, ownerUserId: context.scope.accountId,
      sourceEnvelopeId: refs?.get(payload.observationId), payload, state: 'PENDING', createdAt: TIME, updatedAt: TIME,
      claimedAt: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null,
      batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
    }
    queueRows.set(payload.observationId, row)
    return { inserted: true, alreadyQueued: false, record: row }
  }))
  let resultFactory = (id: string): ConnectorObservationResult => ({ observationId: id, status: 'accepted', canonicalStatus: 'not_applicable', nativeObservationId: `native-${id}` })
  const flush = vi.fn(async (ids: readonly string[], options: CertificationFlushOptions): Promise<CertificationFlushReport> => {
    await options.prepare?.()
    const results = ids.map(resultFactory)
    const event: BatchDeliveryEvent = {
      batchId: 'activity-batch', attemptedAt: TIME, observationIds: [...ids], acknowledgedIds: [...ids], rejectedIds: [],
      httpStatus: 200, outcome: 'DELIVERED', errorCode: null,
      accepted: results.filter((result) => result.status === 'accepted').length,
      duplicate: results.filter((result) => result.status === 'duplicate').length,
      rejected: results.filter((result) => result.status === 'rejected').length, results,
    }
    const successful = options.validateResults?.(event) ?? ids
    const preAck = options.activityRecovery ? { ...event, acknowledgedIds: [] } : event
    await options.persistEvidence?.(preAck)
    const saved = JSON.parse([...storageRows.values()][0])
    expect(saved.events).toContainEqual(preAck)
    if (saved.resumePolicy) {
      expect(saved.deploymentRevision).toBe(ACTIVITY_R5_REVISION)
      expect(saved.children.filter((child: { observationId: string }) => successful.includes(child.observationId))
        .every((child: { receipts: Array<{ nativeObservationId: string }> }) => child.receipts.some((receipt) => !!receipt.nativeObservationId))).toBe(true)
      expect(ids.every((id) => queueRows.has(id))).toBe(true)
    }
    successful.forEach((id) => queueRows.delete(id))
    if (options.activityRecovery) {
      event.acknowledgedIds = [...successful]
      event.outcome = successful.length === ids.length ? 'DELIVERED' : 'PARTIAL'
      for (const id of ids.filter((item) => !successful.includes(item))) queueRows.get(id)!.state = 'RETRY_WAIT'
      await options.persistEvidence?.(event)
    }
    return { events: [event], reason: null }
  })
  const deps: ActivityDependencies = {
    connectedContext: () => context, acquire, journal: { readSourceEnvelope }, storage: () => storage,
    queue: { getOwnerUserId: () => context.scope.accountId, enqueueMany, getRecord: async (id) => queueRows.get(id) ?? null,
      getPayloadJson: async (id) => {
        const row = queueRows.get(id)
        return row ? JSON.stringify(row.payload) : null
      },
      recoverActivityCertificationTransport: vi.fn(async (evidence) => {
        let found = 0
        let reconstructed = 0
        for (const item of evidence) {
          const payload = await verifyActivityTransport(item)
          const existing = queueRows.get(item.observationId)
          if (existing) {
            if (JSON.stringify(existing.payload) !== item.payloadJson || !activityTransportClaimable(existing)) throw new Error('Blocked recovery row')
            found++
          } else {
            const rows = await enqueueMany([payload], new Map([[item.observationId, item.sourceEnvelopeId]]))
            expect(JSON.stringify(rows[0].record.payload)).toBe(item.payloadJson)
            reconstructed++
          }
        }
        return { found, reconstructed }
      }),
      removePreservedCertificationObservation: vi.fn(async (id, payloadJson) => {
        const row = queueRows.get(id)
        if (row && JSON.stringify(row.payload) !== payloadJson) throw new Error('Queue payload changed')
        queueRows.delete(id)
      }),
      purgeVerifiedDeliveredActivityTransport: vi.fn(async (evidence: readonly ActivityTransportEvidence[]) => {
        const verified = await Promise.all(evidence.map(async (item) => {
          await verifyActivityTransport(item)
          const row = queueRows.get(item.observationId)
          if (row && (row.ownerUserId !== context.scope.accountId || row.sourceEnvelopeId !== item.sourceEnvelopeId
            || JSON.stringify(row.payload) !== item.payloadJson || row.state === 'IN_FLIGHT'
            || row.state === 'CANONICAL_RECOVERY_REQUIRED')) throw new Error('Local queue evidence mismatch')
          return row ? item.observationId : null
        }))
        verified.forEach((id) => { if (id) queueRows.delete(id) })
      }) }, flush,
    deliveryDiagnostics: () => ({ activeBatches: [{ batchId: 'activity-batch',
      responseContractVersion: vc18 ? ACTIVITY_RESPONSE_CONTRACT : 'r4',
      deploymentRevision: vc18 ? ACTIVITY_R5_REVISION : 'unchanged' }], recentResponseShapes: [] }),
  }
  const service = new Activity24_25Certification(deps)
  const editJournal = (id: string, edit: (value: Record<string, unknown>) => void) => {
    const row = journalRows.get(id)!
    const value = JSON.parse(row.envelopeJson)
    edit(value)
    row.envelopeJson = JSON.stringify(value)
  }
  const editSaved = (edit: (group: Awaited<ReturnType<Activity24_25Certification['snapshot']>>) => void) => {
    const key = [...storageRows.keys()][0]
    const group = JSON.parse(storageRows.get(key)!)
    edit(group)
    storageRows.set(key, JSON.stringify(group))
  }
  return { deps, service, context, acquisition, acquire, flush, enqueueMany, storageRows, journalRows, queueRows, editJournal, editSaved,
    setResults: (factory: typeof resultFactory) => { resultFactory = factory } }
}

afterEach(() => vi.restoreAllMocks())

async function capturedVc17() {
  const original = hashes.sha256Hex
  const mapped = new Map<string, string>()
  let next = 0
  vi.spyOn(hashes, 'sha256Hex').mockImplementation(async (text) => {
    if (!text.startsWith('user-activity:') || !text.includes(':activity-certification:')) return original(text)
    let id = mapped.get(text)
    if (!id) {
      if (!text.includes(':exerciseMinutes:') && next >= ACTIVITY_RESUME_IDS.length) return original(text)
      id = text.includes(':exerciseMinutes:') ? ACTIVITY_EXCLUDED_ID : ACTIVITY_RESUME_IDS[next++]
      mapped.set(text, id)
    }
    return id
  })
  const f = await activityFixture(true)
  f.flush.mockImplementationOnce(async (_ids, options) => {
    await options.prepare?.()
    return { events: [], reason: 'ACK_PROCESSING_FAILED' }
  })
  await f.service.captureAndDeliver()
  f.editSaved((group) => { group!.certificationGroupId = ACTIVITY_VC17_GROUP })
  f.setResults((observationId) => ({ observationId, status: 'accepted', nativeObservationId: `native-${observationId}`,
    canonicalStatus: 'not_applicable', canonicalTarget: null }))
  f.acquire.mockClear(); f.flush.mockClear(); f.enqueueMany.mockClear()
  const before = (await f.service.snapshot())!
  return { ...f, before, mapped }
}

async function savedDeliveredVc19() {
  const f = await capturedVc17()
  for (const id of ACTIVITY_RESUME_IDS) f.queueRows.get(id)!.state = 'FAILED_PERMANENT'
  f.queueRows.delete(ACTIVITY_EXCLUDED_ID)
  const productionEvent: BatchDeliveryEvent = {
    batchId: 'b31f2a65-0592-43b7-9260-a7af6d111ad4',
    attemptedAt: TIME,
    completedAt: TIME,
    responseContractVersion: ACTIVITY_RESPONSE_CONTRACT,
    deploymentRevision: ACTIVITY_R5_REVISION,
    outcome: 'DELIVERED',
    observationIds: [...ACTIVITY_RESUME_IDS],
    acknowledgedIds: [],
    rejectedIds: [],
    canonicalFailedIds: [],
    httpStatus: 200,
    errorCode: null,
    accepted: 17,
    duplicate: 0,
    rejected: 0,
    errors: [],
    results: ACTIVITY_RESUME_IDS.map((observationId, index) => ({
      observationId, status: 'accepted', nativeObservationId: `native-observation-${index}`,
      canonicalStatus: 'not_applicable', canonicalTarget: null, reason: null, errorCode: null,
    })),
  }
  const historicalEvents: BatchDeliveryEvent[] = [
    {
      batchId: 'pre-r5-rejected-batch', attemptedAt: TIME, outcome: 'FAILED', observationIds: [...ACTIVITY_RESUME_IDS],
      acknowledgedIds: [], rejectedIds: [...ACTIVITY_RESUME_IDS], httpStatus: 400, errorCode: 'OLD_CONTRACT',
      accepted: 0, duplicate: 0, rejected: 17, errors: [],
    },
    {
      batchId: productionEvent.batchId, attemptedAt: '2026-10-05T00:00:00.000Z', outcome: 'PARTIAL', observationIds: [...ACTIVITY_RESUME_IDS],
      acknowledgedIds: [], rejectedIds: [], httpStatus: 200, errorCode: 'ACK_PROCESSING_FAILED',
      accepted: 17, duplicate: 0, rejected: 0, errors: [],
    },
  ]
  f.editSaved((group) => {
    group!.state = 'CAPTURED'
    group!.reason = 'UNRESOLVED_OBSERVATION_RESULTS'
    group!.resumePolicy = 'VC19_EXACT_R5_RECOVERY'
    group!.responseContractVersion = ACTIVITY_RESPONSE_CONTRACT
    group!.deploymentRevision = ACTIVITY_R5_REVISION
    group!.events.push(historicalEvents[0], productionEvent, historicalEvents[1])
    const excluded = group!.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)!
    excluded.exerciseMinutesUnitAuthoritative = false
    excluded.exerciseMinutesDeliveryEligible = false
    excluded.queueDisposition = ACTIVITY_SEMANTIC_CONFLICT
    excluded.queueState = null
  })
  return { ...f, productionEvent, historicalEvents }
}

describe('VC19 saved Activity exact-ID recovery', () => {
  it('finalizes native-only Activity when all canonicalTargets are null', async () => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      const delivered = group!.events.find((event) => event.outcome === 'DELIVERED')!
      for (const result of delivered.results!) delete result.canonicalTarget
    })
    const before = (await f.service.snapshot())!
    const delivered = before.events.find((event) => event.outcome === 'DELIVERED')!
    expect(delivered.acknowledgedIds).toEqual([])
    expect(delivered.results!.every((result) => !Object.hasOwn(result, 'canonicalTarget'))).toBe(true)
    expect(before.children.every((child) => child.canonicalTarget === null)).toBe(true)
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'))
    const ids = vi.spyOn(crypto, 'randomUUID')
    const purge = vi.mocked(f.deps.queue.purgeVerifiedDeliveredActivityTransport!)
    const originalPurge = purge.getMockImplementation()!
    purge.mockImplementationOnce(async (evidence) => {
      const pending = (await f.service.snapshot())!
      expect(pending.finalizationDiagnostics).toMatchObject({
        selectionCode: 'VALID_DELIVERED_BATCH_SELECTED', validDeliveredEvents: 1,
        resultsValidated: 17, nativeObservationIds: 17, queueRowsValidated: 17,
        payloadMatches: 17, canonicalTargetsNull: 17, rowsPurged: 0,
      })
      expect(f.queueRows.size).toBe(17)
      await originalPurge(evidence)
    })
    const finalized = await f.service.finalizeDeliveredCertification()
    expect(finalized).toMatchObject({ status: 'ACTIVITY_CERTIFICATION_SUCCESS', delivered: 17, group: { state: 'COMPLETED' } })
    expect(finalized.group!.events).toEqual(before.events)
    expect(finalized.group!.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID)
      .every((child) => child.queueDisposition === 'ACKNOWLEDGED_PURGED'
        && child.nativeObservationId === delivered.results!.find((result) => result.observationId === child.observationId)!.nativeObservationId)).toBe(true)
    expect(finalized.group!.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)).toMatchObject({
      queueDisposition: ACTIVITY_SEMANTIC_CONFLICT, exerciseMinutesUnitAuthoritative: false, exerciseMinutesDeliveryEligible: false,
    })
    expect(f.queueRows.size).toBe(0)
    const restarted = new Activity24_25Certification(f.deps)
    expect((await restarted.inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(JSON.parse(await restarted.exportSaved())).toMatchObject({
      state: 'COMPLETED', events: before.events,
      deliveryPolicy: { canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' },
      localReconciliationEvents: [{ eventType: 'LOCAL_CERTIFICATION_RECONCILIATION_COMPLETED' }],
    })
    expect(network).not.toHaveBeenCalled()
    expect(ids).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it.each([
    [1, 'MIXED_CANONICAL_TARGET_STATE'],
    [8, 'MIXED_CANONICAL_TARGET_STATE'],
    [17, 'UNEXPECTED_CANONICAL_TARGET'],
  ] as const)('rejects %i non-null persisted Activity targets before mutation', async (count, code) => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      const children = group!.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID)
      for (const child of children.slice(0, count)) Object.assign(child, { canonicalTarget: 'Activity' })
    })
    const saved = [...f.storageRows.entries()]
    await expect(f.service.finalizeDeliveredCertification()).rejects.toThrow(code)
    expect([...f.storageRows.entries()]).toEqual(saved)
    expect(f.queueRows.size).toBe(17)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it.each([1, 17])('rejects %i explicit non-null transport result targets even with null metadata', async (count) => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      const results = group!.events.find((event) => event.outcome === 'DELIVERED')!.results!
      for (const result of results.slice(0, count)) result.canonicalTarget = 'Activity'
    })
    const saved = [...f.storageRows.entries()]
    await expect(f.service.finalizeDeliveredCertification()).rejects.toThrow('UNEXPECTED_CANONICAL_TARGET')
    expect([...f.storageRows.entries()]).toEqual(saved)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).not.toHaveBeenCalled()
  })
  it('finalizes real VC19 delivered event when acknowledgedIds is empty', async () => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      const delivered = group!.events.find((event) => event.outcome === 'DELIVERED')!
      delete delivered.responseContractVersion
      delete delivered.deploymentRevision
    })
    const before = (await f.service.snapshot())!
    expect(before.state).toBe('CAPTURED')
    const delivered = before.events.find((event) => event.outcome === 'DELIVERED')!
    expect(delivered).toMatchObject({
      batchId: 'b31f2a65-0592-43b7-9260-a7af6d111ad4', outcome: 'DELIVERED',
      observationIds: ACTIVITY_RESUME_IDS, acknowledgedIds: [], rejectedIds: [], canonicalFailedIds: [],
      httpStatus: 200, errorCode: null, accepted: 17, duplicate: 0, rejected: 0, errors: [],
    })
    expect(before.events.at(-1)).toMatchObject({ batchId: delivered.batchId, outcome: 'PARTIAL' })
    expect(ACTIVITY_RESUME_IDS.every((id) => f.queueRows.get(id)!.state === 'FAILED_PERMANENT')).toBe(true)
    f.deps.deliveryDiagnostics = vi.fn(() => { throw new Error('Sender diagnostics prohibited') })
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'))
    const ids = vi.spyOn(crypto, 'randomUUID')
    const purge = vi.mocked(f.deps.queue.purgeVerifiedDeliveredActivityTransport!)
    const originalPurge = purge.getMockImplementation()!
    purge.mockImplementationOnce(async (evidence) => {
      const persisted = (await f.service.snapshot())!
      expect(persisted.state).toBe('CAPTURED')
      expect(persisted.localReconciliationEvents).toBeUndefined()
      expect(persisted.pendingLocalReconciliation?.results).toEqual(delivered.results)
      for (const child of persisted.children.filter((item) => item.observationId !== ACTIVITY_EXCLUDED_ID)) {
        expect(child).toMatchObject({
          nativeObservationId: delivered.results!.find((item) => item.observationId === child.observationId)!.nativeObservationId,
          localAcknowledgment: { batchId: delivered.batchId, disposition: 'ACKNOWLEDGED' },
          queueDisposition: 'ACKNOWLEDGED',
        })
        expect(f.queueRows.has(child.observationId)).toBe(true)
      }
      await originalPurge(evidence)
    })
    const result = await new Activity24_25Certification(f.deps).finalizeDeliveredCertification()
    expect(result).toMatchObject({ status: 'ACTIVITY_CERTIFICATION_SUCCESS', delivered: 17, group: { state: 'COMPLETED' } })
    expect(result.group!.events).toEqual(before.events)
    expect(result.group!.pendingLocalReconciliation).toBeUndefined()
    expect(result.group!.localReconciliationEvents).toHaveLength(1)
    expect(result.group!.finalizationDiagnostics).toMatchObject({
      status: 'COMPLETED', code: null, firstFailedPredicateCode: null,
      validDeliveredEvents: 1, resultsValidated: 17, nativeObservationIds: 17,
      queueRowsPresent: 17, queueRowsValidated: 17, payloadMatches: 17, rowsPurged: 17,
    })
    expect(result.group!.finalizationDiagnostics!.predicates.every((predicate) => predicate.passed)).toBe(true)
    expect(result.group!.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID).every((child) =>
      child.queueDisposition === 'ACKNOWLEDGED_PURGED' && child.queueState === null
        && child.productionResult?.nativeObservationId === child.nativeObservationId)).toBe(true)
    expect(f.queueRows.size).toBe(0)
    const json = await new Activity24_25Certification(f.deps).exportSaved()
    expect(JSON.parse(json)).toMatchObject({ state: 'COMPLETED', deliveryPolicy: { canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' } })
    expect(json).toContain(ACTIVITY_EXCLUDED_ID)
    expect(network).not.toHaveBeenCalled()
    expect(ids).not.toHaveBeenCalled()
    expect(f.deps.deliveryDiagnostics).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it('repairs historical receipt ACK disagreement without requiring it as server-success evidence', async () => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      const delivered = group!.events.find((event) => event.outcome === 'DELIVERED')!
      for (const child of group!.children.filter((item) => item.observationId !== ACTIVITY_EXCLUDED_ID)) {
        const result = delivered.results!.find((item) => item.observationId === child.observationId)!
        child.receipts.push({
          event: structuredClone(delivered), result: structuredClone(result), acknowledged: true,
          nativeObservationId: result.nativeObservationId!, payloadFingerprint: child.payloadFingerprint,
          sourceFingerprint: child.payload.rawSourceMetadata!.sourceFingerprint as string,
          responseContractVersion: ACTIVITY_RESPONSE_CONTRACT, deploymentRevision: ACTIVITY_R5_REVISION,
        })
      }
    })
    expect((await f.service.inspectSaved()).reason).toBe('Invalid exact activity receipt.')
    const before = (await f.service.snapshot())!
    const finalized = await f.service.finalizeDeliveredCertification()
    expect(finalized.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(finalized.group!.children.map((child) => child.receipts)).toEqual(before.children.map((child) => child.receipts))
    expect((await new Activity24_25Certification(f.deps).inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
  })
  it('reports the exact first failed server predicate and all independent counts before any mutation', async () => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => { group!.events.find((event) => event.outcome === 'DELIVERED')!.results![0].nativeObservationId = null })
    const saved = [...f.storageRows.entries()]
    let failure: ActivityFinalizationError | undefined
    try { await f.service.finalizeDeliveredCertification() } catch (error) {
      expect(error).toBeInstanceOf(ActivityFinalizationError)
      if (error instanceof ActivityFinalizationError) failure = error
    }
    expect(failure!.diagnostics).toMatchObject({
      status: 'FAILED', code: 'NATIVE_OBSERVATION_ID_MISSING', selectionCode: 'VALID_DELIVERED_BATCH_NOT_FOUND',
      firstFailedPredicateCode: 'NATIVE_OBSERVATION_ID_MISSING',
      failedPredicate: 'every nativeObservationId is non-null and usable',
      validDeliveredEvents: 0, resultsValidated: 16, nativeObservationIds: 16,
      queueRowsValidated: 17, payloadMatches: 17, rowsPurged: 0,
    })
    expect(failure!.message).toContain('ACTIVITY FINALIZATION FAILED:')
    expect(failure!.message).toContain('NATIVE_OBSERVATION_ID_MISSING')
    const displayed = renderToStaticMarkup(createElement(ActivityFinalizationReportView, { report: failure!.diagnostics }))
    expect(displayed).toContain('NATIVE_OBSERVATION_ID_MISSING')
    expect(displayed).toContain('queueRowsValidated')
    expect(displayed).toContain('rowsPurged')
    expect(failure!.diagnostics.predicates.find((predicate) => predicate.code === 'ACCEPTED_COUNT_INVALID')!.passed).toBe(true)
    expect([...f.storageRows.entries()]).toEqual(saved)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).not.toHaveBeenCalled()
  })
  it('persists IDs before purge failure and resumes that local ACK after restart without redelivery', async () => {
    const f = await savedDeliveredVc19()
    const purge = vi.mocked(f.deps.queue.purgeVerifiedDeliveredActivityTransport!)
    purge.mockRejectedValueOnce(new Error('Durable queue unavailable'))
    await expect(f.service.finalizeDeliveredCertification()).rejects.toThrow('LOCAL_QUEUE_PURGE_FAILED')
    const pending = (await f.service.snapshot())!
    expect(pending.state).toBe('CAPTURED')
    expect(pending.localReconciliationEvents).toBeUndefined()
    expect(pending.pendingLocalReconciliation).toBeDefined()
    expect(pending.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID)
      .every((child) => !!child.nativeObservationId && child.localAcknowledgment?.disposition === 'ACKNOWLEDGED')).toBe(true)
    expect((await new Activity24_25Certification(f.deps).finalizeDeliveredCertification()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(f.queueRows.size).toBe(0)
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it('never returns a concurrent incomplete capture inspection as a successful finalization attempt', async () => {
    const f = await savedDeliveredVc19()
    const inspectionInProgress = f.service.captureAndDeliver()
    await expect(f.service.finalizeDeliveredCertification()).rejects.toThrow(
      'ACTIVITY FINALIZATION FAILED: ACTIVITY_OPERATION_IN_PROGRESS',
    )
    await inspectionInProgress
    expect((await f.service.snapshot())!.state).toBe('CAPTURED')
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it('finalizes the exact saved production 17/17 response locally and persists across restart', async () => {
    const f = await savedDeliveredVc19()
    const oldEvents = (await f.service.snapshot())!.events
    const diagnostics = vi.spyOn(f.deps, 'deliveryDiagnostics')
    f.acquire.mockClear()
    f.flush.mockClear()
    f.enqueueMany.mockClear()
    const result = await f.service.finalizeDeliveredCertification()
    expect(result.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(result.delivered).toBe(17)
    expect(result.group).toMatchObject({
      state: 'COMPLETED',
      certificationGroupId: ACTIVITY_VC17_GROUP,
      acquisitionSessionId: ACTIVITY_VC17_SESSION,
      responseContractVersion: ACTIVITY_RESPONSE_CONTRACT,
      deploymentRevision: ACTIVITY_R5_REVISION,
      reason: null,
      deliveryPolicy: { canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' },
    })
    expect(result.group!.events).toEqual(oldEvents)
    expect(result.group!.localReconciliationEvents).toHaveLength(1)
    expect(result.group!.localReconciliationEvents![0]).toMatchObject({
      eventType: 'LOCAL_CERTIFICATION_RECONCILIATION_COMPLETED',
      batchId: 'b31f2a65-0592-43b7-9260-a7af6d111ad4',
      observationIds: ACTIVITY_RESUME_IDS,
      responseContractVersion: ACTIVITY_RESPONSE_CONTRACT,
      deploymentRevision: ACTIVITY_R5_REVISION,
      finalQueueDisposition: 'ACKNOWLEDGED_PURGED',
      serverSubmission: 'NONE_LOCAL_RECONCILIATION_ONLY',
    })
    expect(result.group!.localReconciliationEvents![0].results.map((item) => item.nativeObservationId))
      .toEqual(f.productionEvent.results!.map((item) => item.nativeObservationId))
    expect(result.group!.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID))
      .toHaveLength(17)
    expect(result.group!.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID).every((child) =>
      child.queueDisposition === 'ACKNOWLEDGED_PURGED' && child.queueState === null
        && child.deliveryDisposition === 'NATIVE_ONLY_DELIVERY_CONFIRMED')).toBe(true)
    expect(result.group!.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID)
      .map((child) => child.observationId)).toEqual(ACTIVITY_RESUME_IDS)
    const excluded = result.group!.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)!
    expect(excluded).toMatchObject({
      exerciseMinutesUnitAuthoritative: false,
      exerciseMinutesDeliveryEligible: false,
      queueDisposition: ACTIVITY_SEMANTIC_CONFLICT,
      queueState: null,
    })
    expect(f.queueRows.size).toBe(0)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining(ACTIVITY_RESUME_IDS.map((observationId) => expect.objectContaining({ observationId }))),
    )
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(diagnostics).not.toHaveBeenCalled()
    expect(activityCertificationStatus(result)).toBe(
      'Activity 24/25 certification complete · 17/17 native-only observations delivered · source evidence preserved · exerciseMinutes preserved pending vendor semantics',
    )
    const savedJson = await f.service.exportSaved()
    expect(savedJson).toContain(ACTIVITY_EXCLUDED_ID)
    expect(savedJson).toContain('LOCAL_CERTIFICATION_RECONCILIATION_COMPLETED')
    const restarted = new Activity24_25Certification(f.deps)
    f.context.ready = false
    expect((await restarted.inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(await restarted.exportSaved()).toBe(savedJson)
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it('VC21 selects DELIVERED before a later same-batch PARTIAL using only persisted evidence after restart', async () => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      const event = group!.events.find((item) => item.outcome === 'DELIVERED')!
      delete event.responseContractVersion
      delete event.deploymentRevision
    })
    const before = (await f.service.snapshot())!
    expect(before.events.slice(-2).map((event) => [event.batchId, event.outcome])).toEqual([
      [f.productionEvent.batchId, 'DELIVERED'], [f.productionEvent.batchId, 'PARTIAL'],
    ])
    f.deps.deliveryDiagnostics = vi.fn(() => { throw new Error('Transient sender state must not be consulted') })
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => { throw new Error('Network prohibited') })
    const idSpy = vi.spyOn(crypto, 'randomUUID')
    const identityCalls = vi.mocked(hashes.sha256Hex).mock.calls.filter(([text]) => text.startsWith('user-activity:')).length
    f.context.ready = false
    const restarted = new Activity24_25Certification(f.deps)
    const result = await restarted.finalizeDeliveredCertification()
    expect(result).toMatchObject({ status: 'ACTIVITY_CERTIFICATION_SUCCESS', delivered: 17, group: { state: 'COMPLETED' } })
    expect(result.group!.events).toEqual(before.events)
    expect(result.group!.localReconciliationEvents![0].results).toEqual(f.productionEvent.results)
    expect(f.queueRows.size).toBe(0)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).toHaveBeenCalledExactlyOnceWith(
      before.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID).map((child) => ({
        observationId: child.observationId, payloadJson: child.payloadJson,
        payloadFingerprint: child.payloadFingerprint, sourceEnvelopeId: child.sourceEnvelopeId,
      })),
    )
    const exact = await restarted.exportSaved()
    expect(JSON.parse(await new Activity24_25Certification(f.deps).exportSaved())).toMatchObject({ state: 'COMPLETED' })
    expect(await new Activity24_25Certification(f.deps).exportSaved()).toBe(exact)
    expect(f.deps.deliveryDiagnostics).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(idSpy).not.toHaveBeenCalled()
    expect(vi.mocked(hashes.sha256Hex).mock.calls.filter(([text]) => text.startsWith('user-activity:'))).toHaveLength(identityCalls)
  })
  it.each(['partial-only', 'conflicting-delivered'] as const)('VC21 fails closed for %s history without any mutation', async (kind) => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      if (kind === 'partial-only') group!.events = group!.events.filter((event) => event.outcome !== 'DELIVERED')
      else {
        const conflicting = structuredClone(f.productionEvent)
        conflicting.results![0].nativeObservationId = 'different-native-observation-id'
        group!.events.push(conflicting)
      }
    })
    const before = [...f.storageRows.entries()]
    await expect(f.service.finalizeDeliveredCertification()).rejects.toThrow(
      kind === 'partial-only' ? 'VALID_DELIVERED_BATCH_NOT_FOUND' : 'AMBIGUOUS_VALID_DELIVERED_BATCH',
    )
    expect([...f.storageRows.entries()]).toEqual(before)
    expect(f.queueRows.size).toBe(17)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it('VC21 deduplicates byte-identical successful events without deleting history', async () => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => { group!.events.push(structuredClone(f.productionEvent)) })
    const before = (await f.service.snapshot())!.events
    const result = await f.service.finalizeDeliveredCertification()
    expect(result.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(result.group!.events).toEqual(before)
    expect(result.group!.localReconciliationEvents).toHaveLength(1)
    expect((await new Activity24_25Certification(f.deps).inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
  })
  it.each([
    'missing-result', 'rejected', 'native-id', 'contract', 'revision', 'wrong-id', 'fingerprint',
    'saved-fingerprint', 'source', 'errors', 'reason', 'result-error', 'persisted-contract', 'persisted-revision',
  ] as const)('fails closed before local mutation when saved %s evidence is invalid', async (failure) => {
    const f = await savedDeliveredVc19()
    f.editSaved((group) => {
      const event = group!.events.find((item) => item.outcome === 'DELIVERED')!
      if (failure === 'missing-result') event.results!.pop()
      if (failure === 'rejected') event.results![0].status = 'rejected'
      if (failure === 'native-id') event.results![0].nativeObservationId = null
      if (failure === 'contract') event.responseContractVersion = 'wrong-contract'
      if (failure === 'revision') event.deploymentRevision = 'wrong-revision'
      if (failure === 'wrong-id') event.observationIds[0] = ACTIVITY_EXCLUDED_ID
      if (failure === 'saved-fingerprint') group!.children.find((child) => child.observationId === ACTIVITY_RESUME_IDS[0])!.payloadFingerprint = 'changed'
      if (failure === 'errors') event.errors = [{ observationId: ACTIVITY_RESUME_IDS[0], code: 'ERROR', message: 'failed' }]
      if (failure === 'reason') event.results![0].reason = 'not delivered'
      if (failure === 'result-error') event.results![0].errorCode = 'ERROR'
      if (failure === 'persisted-contract') group!.responseContractVersion = 'wrong-contract'
      if (failure === 'persisted-revision') group!.deploymentRevision = 'wrong-revision'
    })
    if (failure === 'fingerprint') f.queueRows.get(ACTIVITY_RESUME_IDS[0])!.payload.valueNumber = 999
    if (failure === 'source') f.queueRows.get(ACTIVITY_RESUME_IDS[0])!.sourceEnvelopeId = 'changed-source'
    const saved = await f.service.snapshot()
    const priorReconciliations = saved!.localReconciliationEvents
    await expect(f.service.finalizeDeliveredCertification()).rejects.toThrow()
    expect((await f.service.snapshot())!.localReconciliationEvents).toEqual(priorReconciliations)
    expect(f.queueRows.size).toBe(17)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it('is idempotent and does not redeliver after a local reconciliation', async () => {
    const f = await savedDeliveredVc19()
    const once = await f.service.finalizeDeliveredCertification()
    const eventCount = once.group!.localReconciliationEvents!.length
    const twice = await new Activity24_25Certification(f.deps).finalizeDeliveredCertification()
    expect(twice.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(twice.group!.localReconciliationEvents).toHaveLength(eventCount)
    expect(f.deps.queue.purgeVerifiedDeliveredActivityTransport).toHaveBeenCalledTimes(2)
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it.each(['RETRY_WAIT', 'FAILED_PERMANENT', 'ACKNOWLEDGED'] as const)(
    'recovers existing %s transport without replacing identity, bytes or attempt history', async (state) => {
      const f = await capturedVc17()
      for (const id of ACTIVITY_RESUME_IDS) {
        const row = f.queueRows.get(id)!
        row.state = state
        row.nextAttemptAt = '2099-01-01T00:00:00Z'
        row.attemptCount = 2
      }
      const beforeCalls = vi.mocked(hashes.sha256Hex).mock.calls.filter(([text]) => text.startsWith('user-activity:')).length
      const inspected = await f.service.resumeDelivery()
      expect(inspected.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
      const diagnostics = inspected.group!.recoveryDiagnostics!
      expect(diagnostics).toMatchObject({ savedEligibleIds: 17, queueRowsFound: 17, queueRowsReconstructed: 0,
        certificationClaimable: 17, excludedSemanticConflictRows: 1, stage: 'COMPLETED' })
      expect(diagnostics.rowsBefore).toHaveLength(18)
      expect(diagnostics.rowsBefore.filter((row) => row.observationId !== ACTIVITY_EXCLUDED_ID)
        .every((row) => row.queueState === state && row.nextAttemptAt === '2099-01-01T00:00:00Z'
          && row.attemptCount === 2 && row.payloadMatches && row.payloadFingerprint === row.savedPayloadFingerprint
          && row.certificationClaimable && !row.ordinaryClaimable)).toBe(true)
      expect(vi.mocked(hashes.sha256Hex).mock.calls.filter(([text]) => text.startsWith('user-activity:'))).toHaveLength(beforeCalls)
      expect(f.enqueueMany).not.toHaveBeenCalled()
      expect(f.acquire).not.toHaveBeenCalled()
    })
  it.each([1, 8, 17])('reconstructs %s missing transport rows only from persisted JSON with identical hashes and metadata', async (count) => {
    const f = await capturedVc17()
    ACTIVITY_RESUME_IDS.slice(0, count).forEach((id) => f.queueRows.delete(id))
    const beforeCalls = vi.mocked(hashes.sha256Hex).mock.calls.filter(([text]) => text.startsWith('user-activity:')).length
    const inspected = await f.service.resumeDelivery()
    expect(inspected.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(inspected.group!.recoveryDiagnostics).toMatchObject({ queueRowsFound: 17 - count,
      queueRowsReconstructed: count, certificationClaimable: 17, excludedSemanticConflictRows: 1 })
    expect(f.enqueueMany).toHaveBeenCalledTimes(count)
    for (const [payloads, refs] of f.enqueueMany.mock.calls) {
      const payload = payloads[0]
      const child = f.before.children.find((item) => item.observationId === payload.observationId)!
      expect(JSON.stringify(payload)).toBe(child.payloadJson)
      expect(await sha256Hex(JSON.stringify(payload))).toBe(child.payloadFingerprint)
      expect(refs!.get(payload.observationId)).toBe(child.sourceEnvelopeId)
      expect(payload).toEqual(child.payload)
    }
    expect(inspected.group!.physicalSources).toEqual(f.before.physicalSources)
    expect(inspected.group!.acquisitionResults).toEqual(f.before.acquisitionResults)
    expect(inspected.group!.overlapAnalysis).toEqual(f.before.overlapAnalysis)
    expect(vi.mocked(hashes.sha256Hex).mock.calls.filter(([text]) => text.startsWith('user-activity:'))).toHaveLength(beforeCalls)
    expect(f.acquire).not.toHaveBeenCalled()
  })
  it.each(['IN_FLIGHT', 'CANONICAL_RECOVERY_REQUIRED'] as const)('reports blocked %s with counts and does not recover or submit', async (state) => {
    const f = await capturedVc17()
    f.queueRows.get(ACTIVITY_RESUME_IDS[0])!.state = state
    await expect(f.service.resumeDelivery()).rejects.toThrow(`QUEUE_STATE_${state}`)
    const saved = (await f.service.snapshot())!
    expect(saved.recoveryDiagnostics).toMatchObject({ stage: 'QUEUE_INSPECTION', code: 'QUEUE_INSPECTION_FAILED',
      savedEligibleIds: 17, queueRowsFound: 17, queueRowsReconstructed: 0, certificationClaimable: 16 })
    const status = activityCertificationStatus(await f.service.inspectSaved())
    expect(status).toContain('saved eligible IDs = 17/17')
    expect(status).toContain('claimable by certification resume = 16/17')
    expect(f.deps.queue.recoverActivityCertificationTransport).not.toHaveBeenCalled()
    expect(f.queueRows.size).toBe(18)
    expect(f.acquire).not.toHaveBeenCalled()
  })
  it('ACKs only verified partial successes and explicitly retries just unresolved IDs on the next resume', async () => {
    const f = await capturedVc17()
    f.setResults((observationId) => ({ observationId, status: observationId === ACTIVITY_RESUME_IDS[0] ? 'rejected' : 'accepted',
      nativeObservationId: observationId === ACTIVITY_RESUME_IDS[1] ? null : `native-${observationId}`,
      canonicalStatus: 'not_applicable', canonicalTarget: null }))
    const partial = await f.service.resumeDelivery()
    expect(partial.status).toBe('ACTIVITY_CERTIFICATION_INCOMPLETE')
    expect(partial.delivered).toBe(15)
    expect(f.queueRows.size).toBe(2)
    expect(ACTIVITY_RESUME_IDS.slice(0, 2).every((id) => f.queueRows.get(id)?.state === 'RETRY_WAIT')).toBe(true)
    expect(partial.group!.children.filter((child) => ACTIVITY_RESUME_IDS.slice(2).some((id) => id === child.observationId))
      .every((child) => child.deliveryDisposition === 'NATIVE_ONLY_DELIVERY_CONFIRMED' && !!child.deliveryTimestamp
        && child.queueDisposition === 'ACKNOWLEDGED_PURGED')).toBe(true)
    expect(partial.group!.children.find((child) => child.observationId === ACTIVITY_RESUME_IDS[0])!.deliveryDisposition).toBe('PRESERVED_FOR_EXPLICIT_RETRY')
    f.setResults((observationId) => ({ observationId, status: 'accepted', nativeObservationId: `native-${observationId}`,
      canonicalStatus: 'not_applicable', canonicalTarget: null }))
    expect((await f.service.resumeDelivery()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(f.flush.mock.calls[1][0]).toEqual(ACTIVITY_RESUME_IDS.slice(0, 2))
    expect(f.queueRows.size).toBe(0)
    expect(f.acquire).not.toHaveBeenCalled()
  })
  it('reuses exact saved source identities and 17 IDs, preserves semantics and writes receipts before purge', async () => {
    const f = await capturedVc17()
    const identityCount = f.mapped.size
    const inspected = await f.service.resumeDelivery()
    expect(inspected.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(inspected.delivered).toBe(17)
    const group = inspected.group!
    expect(group.state).toBe('COMPLETED')
    expect(group.certificationGroupId).toBe(ACTIVITY_VC17_GROUP)
    expect(group.acquisitionSessionId).toBe(ACTIVITY_VC17_SESSION)
    expect(group.selectedType24SourceEnvelopeId).toBe(ACTIVITY_VC17_SUMMARY)
    expect(group.physicalSources).toEqual(f.before.physicalSources)
    expect(group.type24).toEqual(f.before.type24)
    expect(group.type25Group).toEqual(f.before.type25Group)
    expect(group.overlapAnalysis).toEqual(f.before.overlapAnalysis)
    expect(group.detailedEpochs).toEqual(f.before.detailedEpochs)
    expect(group.detailedEpochs.every((epoch) => epoch.timestampAuthority === 'ELITE_PLUS_NOMINAL_INFERENCE')).toBe(true)
    expect(group.children.map((child) => child.observationId)).toEqual(f.before.children.map((child) => child.observationId))
    expect(f.mapped.size).toBe(identityCount)
    expect(f.flush).toHaveBeenCalledExactlyOnceWith(ACTIVITY_RESUME_IDS, expect.any(Object))
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    const excluded = group.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)!
    expect(excluded).toMatchObject({ queueDisposition: ACTIVITY_SEMANTIC_CONFLICT, queueState: null,
      exerciseMinutesUnitAuthoritative: false, exerciseMinutesDeliveryEligible: false, receipts: [] })
    expect(excluded.payloadJson).toBe(f.before.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)!.payloadJson)
    expect(excluded.native.value).toBe(2690)
    expect(group.children.filter((child) => child !== excluded).every((child) =>
      child.receipts[0].nativeObservationId === `native-${child.observationId}`
      && child.receipts[0].deploymentRevision === ACTIVITY_R5_REVISION
      && child.queueDisposition === 'ACKNOWLEDGED_PURGED'
      && child.canonicalTarget === null && child.payload.rawSourceMetadata?.canonicalPolicy === 'NATIVE_ONLY')).toBe(true)
    expect(f.queueRows.size).toBe(0)
    expect(activityCertificationStatus(inspected)).toBe('Activity 24/25 certification saved · source evidence preserved · 17/17 native-only observations delivered · exerciseMinutes preserved pending vendor semantics')
    const json = await f.service.exportSaved()
    expect(json).toContain(ACTIVITY_EXCLUDED_ID)
    f.flush.mockClear()
    const restarted = new Activity24_25Certification(f.deps)
    expect((await restarted.inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(await restarted.exportSaved()).toBe(json)
    await restarted.resumeDelivery()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it.each(['group', 'session', 'summary', 'source', 'rawLength', 'rawSha', 'ancestry', 'overlap', 'timing', 'id', 'queue'] as const)(
    'fails closed before any network when saved %s differs, without physical fallback', async (kind) => {
      const f = await capturedVc17()
      f.editSaved((group) => {
        if (kind === 'group') group!.certificationGroupId = 'different'
        if (kind === 'session') group!.acquisitionSessionId = 'different'
        if (kind === 'summary') group!.selectedType24SourceEnvelopeId = 'different'
        if (kind === 'source') group!.physicalSources[0].sourceFingerprint = 'different'
        if (kind === 'rawLength') group!.physicalSources[0].rawByteLength++
        if (kind === 'rawSha') group!.physicalSources[0].rawByteSha256 = 'different'
        if (kind === 'ancestry') group!.type25Group.pop()
        if (kind === 'overlap') group!.overlapAnalysis[0].type24Value = 999
        if (kind === 'timing') group!.detailedEpochs[0].productionObservedAt = 'different'
        if (kind === 'id') group!.children[0].observationId = 'different'
      })
      if (kind === 'queue') f.queueRows.get(ACTIVITY_RESUME_IDS[0])!.sourceEnvelopeId = 'different'
      await expect(f.service.resumeDelivery()).rejects.toThrow()
      expect(f.queueRows.size).toBe(18)
      expect(f.acquire).not.toHaveBeenCalled()
      expect(f.enqueueMany).not.toHaveBeenCalled()
    })
  it.each(['revision', 'contract', 'nativeId', 'canonicalStatus', 'canonicalTarget', 'duplicate', 'reject'] as const)(
    'blocks ACK/purge on invalid %s', async (kind) => {
      const f = await capturedVc17()
      if (kind === 'revision' || kind === 'contract') {
        f.deps.deliveryDiagnostics = () => ({ activeBatches: [{
          batchId: 'activity-batch', deploymentRevision: kind === 'revision' ? 'r4' : ACTIVITY_R5_REVISION,
          responseContractVersion: kind === 'contract' ? 'r4' : ACTIVITY_RESPONSE_CONTRACT,
        }], recentResponseShapes: [] })
      } else {
        f.setResults((observationId) => ({ observationId, status: kind === 'duplicate' ? 'duplicate' : kind === 'reject' ? 'rejected' : 'accepted',
          nativeObservationId: kind === 'nativeId' ? null : `native-${observationId}`,
          canonicalStatus: kind === 'canonicalStatus' ? 'canonicalized' : 'not_applicable',
          canonicalTarget: kind === 'canonicalTarget' ? 'Activity' : null }))
      }
      if (kind === 'revision' || kind === 'contract') {
        await expect(f.service.resumeDelivery()).rejects.toThrow('ACK/purge blocked')
      } else {
        expect((await f.service.resumeDelivery()).status).toBe('ACTIVITY_CERTIFICATION_INCOMPLETE')
      }
      expect(f.queueRows.size).toBe(17)
      const saved = (await f.service.snapshot())!
      expect(saved.children.every((child) => child.receipts.length === 0)).toBe(true)
      expect(saved.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)!.queueDisposition).toBe(ACTIVITY_SEMANTIC_CONFLICT)
      expect(f.acquire).not.toHaveBeenCalled()
    })
  it('never falls back to physical acquisition when durable evidence is absent', async () => {
    const f = await activityFixture()
    await expect(f.service.resumeDelivery()).rejects.toThrow('No saved VC17')
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
  })
  it('accepts idempotent duplicates only after matching native IDs and full provenance were durably saved before ACK', async () => {
    const f = await capturedVc17()
    f.flush.mockImplementationOnce(async (ids, options) => {
      await options.prepare?.()
      await options.persistEvidence?.({
        batchId: 'activity-batch', attemptedAt: TIME, observationIds: [...ids], acknowledgedIds: [], rejectedIds: [],
        httpStatus: 200, outcome: 'DELIVERED', errorCode: null, accepted: 17, duplicate: 0, rejected: 0,
        results: ids.map((observationId) => ({ observationId, status: 'accepted', nativeObservationId: `native-${observationId}`,
          canonicalStatus: 'not_applicable', canonicalTarget: null })),
      })
      throw new Error('Interrupted after receipt persistence, before ACK')
    })
    await expect(f.service.resumeDelivery()).rejects.toThrow('Interrupted')
    expect(f.queueRows.size).toBe(17)
    expect((await f.service.snapshot())!.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID)
      .every((child) => child.receipts.length === 1 && !child.receipts[0].acknowledged)).toBe(true)
    f.setResults((observationId) => ({ observationId, status: 'duplicate', nativeObservationId: `native-${observationId}`,
      canonicalStatus: 'not_applicable', canonicalTarget: null }))
    expect((await new Activity24_25Certification(f.deps).resumeDelivery()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.queueRows.size).toBe(0)
  })
})

describe('VC17 physical Activity24/25 certification', () => {
  it.each(['ready', 'native', 'physical'] as const)('gates physical %s before acquisition', async (flag) => {
    const f = await activityFixture()
    f.context[flag] = false
    await expect(f.service.captureAndDeliver()).rejects.toThrow('READY physical native')
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })
  it('one operator action acquires once, preserves all L0 records/duplicates/nulls/zeros, samples deterministically and targets exact IDs', async () => {
    const f = await activityFixture()
    const first = f.service.captureAndDeliver()
    expect(f.service.captureAndDeliver()).toBe(first)
    const inspection = await first
    expect(inspection.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    const group = inspection.group!
    expect(group.physicalSources).toHaveLength(5)
    expect(group.type25Group).toHaveLength(3)
    expect(group.selectedType24SourceEnvelopeId).toBe('summary-first')
    expect(group.type24!.fields.step).toEqual(typed('0090'))
    expect(group.type24!.fields.unknown).toEqual({ type: 'null' })
    expect(group.detailedEpochs).toHaveLength(30)
    expect(group.detailedEpochs[2].value).toBe(0)
    expect(group.detailedEpochs[12].vendorTimestamp).toBe(group.detailedEpochs[2].vendorTimestamp)
    expect(group.type25Group[0].sourceFingerprint).not.toBe(group.type25Group[1].sourceFingerprint)
    expect(group.selectedEpochIndexes.map((selected) => selected.index)).toEqual([0, 1, 2, 15, 29])
    expect(group.children).toHaveLength(19)
    expect(group.children.every((child) => child.receipts.length === 1 && child.canonicalTarget === null
      && child.queueDisposition === 'ACKNOWLEDGED_PURGED')).toBe(true)
    expect(f.flush.mock.calls[0][0]).toEqual(group.children.map((child) => child.observationId))
    expect(group.events[0].observationIds).toHaveLength(19)
    expect(group.deliveryPolicy).toEqual({ concurrency: 1, batchSize: 100, canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' })
    expect(group.responseContractVersion).toBe('r4')
    expect(group.deploymentRevision).toBe('unchanged')
    expect(activityCertificationStatus(inspection)).toContain('1 summary record + 30 detailed epochs preserved · 19/19')
    await f.service.captureAndDeliver()
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.flush).toHaveBeenCalledTimes(1)
  })
  it.each(['24', '25'])('requires exact type%s detection and never retries acquisition on failure', async (type) => {
    const f = await activityFixture()
    f.acquisition.results[Number(type) - 24].vendorDataType = '42'
    await expect(f.service.captureAndDeliver()).rejects.toThrow('Incomplete physical')
    expect((await f.service.captureAndDeliver()).status).toBe('ACTIVITY_CERTIFICATION_INCOMPLETE')
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.flush).not.toHaveBeenCalled()
  })
  it.each([
    ['summary-first-ble', (r: Record<string, unknown>) => { r.sha256 = 'bad' }],
    ['detail-first-ble', (r: Record<string, unknown>) => { r.byteLength = 999 }],
    ['detail-repeat-callback', (r: Record<string, unknown>) => { r.recordEnvelopeIds = ['wrong'] }],
    ['summary-first', (r: Record<string, unknown>) => { r.notificationEnvelopeId = 'missing' }],
  ] as const)('rejects broken raw ancestry at %s', async (id, edit) => {
    const f = await activityFixture()
    f.editJournal(id, edit)
    await expect(f.service.captureAndDeliver()).rejects.toThrow()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })
  it('preserves unknown fields and invalid records and deterministically chooses next complete summary', async () => {
    const f = await activityFixture()
    f.editJournal('summary-first', (r) => { r.sourceDateParseStatus = 'INVALID' })
    const inspection = await f.service.captureAndDeliver()
    expect(inspection.status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(inspection.group!.selectedType24SourceEnvelopeId).toBe('summary-repeat')
    expect(inspection.group!.physicalSources).toHaveLength(5)
  })
  it.each(['slot', 'timestamp', 'missing', 'duplicate'])('rejects %s compaction/inference/change even on unselected epochs', async (caseName) => {
    const f = await activityFixture()
    const observations = f.acquisition.results[1].observations
    if (caseName === 'slot') observations[7].sequenceNumber = 6
    if (caseName === 'timestamp') observations[7].observedAt = TIME
    if (caseName === 'missing') observations.splice(7, 1)
    if (caseName === 'duplicate') observations.push(structuredClone(observations[7]))
    await expect(f.service.captureAndDeliver()).rejects.toThrow()
    expect(f.flush).not.toHaveBeenCalled()
  })
  it('marks every existing production minute offset as inference, not explicit vendor time', async () => {
    const f = await activityFixture()
    const group = (await f.service.captureAndDeliver()).group!
    expect(group.detailedEpochs.every((epoch) => epoch.timestampAuthority === 'ELITE_PLUS_NOMINAL_INFERENCE')).toBe(true)
    expect(group.detailedEpochs[1].vendorTimestamp).toBe(group.detailedEpochs[0].vendorTimestamp)
    expect(group.detailedEpochs[1].productionObservedAt).toBe('2026-10-04T12:01:00.000Z')
    const epoch = group.children.find((child) => child.native.sequenceNumber === 1)!
    expect(epoch.payload.timestampConfidence).toBe('NOMINAL_INTERVAL_DERIVED')
  })
  it.each([null, '', '   '])('accepted requires a non-null usable NativeObservation ID (%s)', async (nativeObservationId) => {
    const f = await activityFixture()
    f.setResults((observationId) => ({ observationId, status: 'accepted', canonicalStatus: 'not_applicable', nativeObservationId }))
    await expect(f.service.captureAndDeliver()).rejects.toThrow('non-null NativeObservation ID')
    const inspection = await f.service.inspectSaved()
    expect(inspection.status).toBe('ACTIVITY_CERTIFICATION_INCOMPLETE')
    expect(inspection.delivered).toBe(0)
    expect(inspection.group!.events[0].results).toHaveLength(19)
    expect(f.queueRows.size).toBe(19)
  })
  it.each(['canonicalized', 'failed', null] as const)('native-only results require not_applicable, not %s', async (canonicalStatus) => {
    const f = await activityFixture()
    f.setResults((observationId) => ({ observationId, status: 'accepted', canonicalStatus, nativeObservationId: `native-${observationId}` }))
    await expect(f.service.captureAndDeliver()).rejects.toThrow('native-only result')
    expect((await f.service.inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_INCOMPLETE')
  })
  it('reports overlap without decomposition, deduplication or double-counting promotion', async () => {
    const f = await activityFixture()
    const group = (await f.service.captureAndDeliver()).group!
    expect(group.overlapAnalysis.find((row) => row.metric === 'steps')).toMatchObject({
      type24Field: 'step', type25Field: 'detailMinterStep', type24Value: 90, type25Aggregate: 90, valuesMatch: true,
      relationshipKnown: false, canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
    })
    expect(group.overlapAnalysis.find((row) => row.metric === 'stepsSlots')!.type25Aggregate).toBe(156)
    expect(group.overlapAnalysis.filter((row) => ['duration', 'intensity'].includes(row.metric)).every((row) => row.type25Field === null)).toBe(true)
    expect(group.children.every((child) => child.payload.rawSourceMetadata!.canonicalPolicy === 'NATIVE_ONLY')).toBe(true)
    expect(findPhysiologyContract(group.children[0].native)).toBeNull()
    expect(PHYSIOLOGY_CONTRACTS.some((contract) => ['24', '25'].includes(contract.vendorDataType))).toBe(false)
  })
  it('snapshot survives ACK/purge and restart inspection/export has zero acquire/enqueue/network/storage writes', async () => {
    const f = await activityFixture()
    await f.service.captureAndDeliver()
    const original = await f.service.exportSaved()
    const hash = await sha256Hex(original)
    const rows = [...f.storageRows.entries()]
    f.acquire.mockClear(); f.enqueueMany.mockClear(); f.flush.mockClear()
    f.context.ready = false
    const restarted = new Activity24_25Certification(f.deps)
    expect((await restarted.inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_SUCCESS')
    expect(await restarted.exportSaved()).toBe(original)
    expect(await sha256Hex(await restarted.exportSaved())).toBe(hash)
    expect([...f.storageRows.entries()]).toEqual(rows)
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.queueRows.size).toBe(0)
  })
  it.each(['fingerprint', 'selection', 'epochs', 'overlap', 'receipts'] as const)('detects saved %s tampering', async (caseName) => {
    const f = await activityFixture()
    await f.service.captureAndDeliver()
    f.editSaved((group) => {
      if (caseName === 'fingerprint') group!.physicalSources[0].sourceFingerprint = 'bad'
      if (caseName === 'selection') group!.children.pop()
      if (caseName === 'epochs') group!.detailedEpochs.splice(2, 1)
      if (caseName === 'overlap') group!.overlapAnalysis[0].type24Value = 1
      if (caseName === 'receipts') group!.children[0].receipts[0].nativeObservationId = 'wrong'
    })
    expect((await f.service.inspectSaved()).status).toBe('ACTIVITY_CERTIFICATION_EVIDENCE_INVALID')
    await expect(f.service.exportSaved()).rejects.toThrow()
  })
  it('an acquisition exception persists a stopped attempt and blocks a second acquisition', async () => {
    const f = await activityFixture()
    f.acquire.mockRejectedValue(new Error('link lost'))
    await expect(f.service.captureAndDeliver()).rejects.toThrow('link lost')
    expect((await new Activity24_25Certification(f.deps).captureAndDeliver()).status).toBe('ACTIVITY_CERTIFICATION_INCOMPLETE')
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })
  it('deduplicates sampling categories, not vendor records or slots', () => {
    expect(sampleActivityEpochs([{ value: 0 }])).toEqual([{ index: 0, categories: ['FIRST', 'ZERO', 'MIDPOINT', 'LAST'] }])
    expect(sampleActivityEpochs([{ value: 1 }, { value: 2 }]).map((slot) => slot.index)).toEqual([0, 1])
    expect(sampleActivityEpochs(Array.from({ length: 10 }, () => ({ value: 1 }))).map((slot) => slot.index)).toEqual([0, 1, 5, 9])
    expect(sampleActivityEpochs([{ value: 1 }, { value: 2, zeroVendorFields: ['calories'] }, { value: 3 }])
      .find((slot) => slot.categories.includes('ZERO'))!.index).toBe(1)
  })
  it('Show/Copy/Share preserve exact saved UTF-8 JSON bytes and hash with zero acquisition or network activity', async () => {
    const f = await activityFixture()
    await f.service.captureAndDeliver()
    const json = await new Activity24_25Certification(f.deps).exportSaved()
    const before = [...f.storageRows.entries()]
    f.acquire.mockClear(); f.enqueueMany.mockClear(); f.flush.mockClear()
    const displayed = renderToStaticMarkup(createElement(ActivityCertificationJsonView, { json }))
    const escaped = renderToStaticMarkup(createElement('pre', {}, json)).slice(5, -6)
    expect(displayed).toContain(`>${escaped}</textarea>`)
    const clipboard = { writeText: vi.fn(async (_value: string) => {}) }
    await activityJsonAction(json, 'copy', clipboard)
    await activityJsonAction(json, 'share', clipboard)
    const file = vi.mocked(Filesystem.writeFile).mock.calls.at(-1)![0]
    expect(file).toEqual({ path: ACTIVITY_CERTIFICATION_FILENAME, data: json, directory: 'CACHE', encoding: 'utf8' })
    expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(json)
    expect(await sha256Hex(String(file.data))).toBe(await sha256Hex(clipboard.writeText.mock.calls[0][0]))
    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
      files: ['file:///cache/JCVital%20Activity%2024-25%20grouped%20certification.json'],
    }))
    expect([...f.storageRows.entries()]).toEqual(before)
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
  })
  it('renders the resume control and disables physical capture without disabling scoped saved inspection', async () => {
    const f = await activityFixture()
    const html = renderToStaticMarkup(createElement(Activity24_25CertificationView, {
      service: f.service, busy: false, captureDisabled: true,
      onSendSavedActivityV2Verification: async () => 'queued',
      setBusy: vi.fn(), setActiveSync: vi.fn(), scopeKey: DEVICE,
    }))
    expect(html).toContain('disabled="">Capture + Queue + Targeted Deliver Activity 24/25')
    expect(html).toContain('type="button">Resume Activity 24/25 Certification Delivery')
    expect(html).toContain('Send Saved Activity V2 Verification')
    expect(html).toContain('type="button">Inspect Saved Activity 24/25 Certification')
    expect(html).toContain('Show Activity 24/25 Certification JSON')
    expect(html).toContain('Copy Activity 24/25 Certification JSON')
    expect(html).toContain('Share / Save Activity 24/25 Certification JSON')
    expect(f.acquire).not.toHaveBeenCalled()
  })
  it('reports clipboard and share errors explicitly without changing the saved JSON', async () => {
    const json = '{"exact":"Activity"}'
    await expect(activityJsonAction(json, 'copy', null)).rejects.toThrow('Clipboard unavailable')
    vi.mocked(Share.share).mockRejectedValueOnce(new Error('chooser unavailable'))
    await expect(activityJsonAction(json, 'share', null)).rejects.toThrow('SHARE: chooser unavailable')
    expect(vi.mocked(Filesystem.writeFile).mock.calls.at(-1)![0].data).toBe(json)
  })
  it('uses the native durable snapshot API when no test storage override is provided', async () => {
    const f = await activityFixture()
    let savedJson: string | null = null
    const nativeStorage = {
      readActivityCertificationSnapshot: vi.fn(async () => ({ json: savedJson })),
      writeActivityCertificationSnapshot: vi.fn(async ({ json }: { json: string }) => { savedJson = json; return { saved: true } }),
    }
    f.enqueueMany.mockImplementation(async (payloads, refs) => {
      expect(JSON.parse(savedJson!).state).toBe('CAPTURED')
      return payloads.map((payload) => ({
        inserted: true, alreadyQueued: false, record: {
          queueId: payload.observationId, observationId: payload.observationId, sourceEnvelopeId: refs?.get(payload.observationId),
          ownerUserId: f.context.scope.accountId, payload, state: 'PENDING', createdAt: TIME, updatedAt: TIME,
          claimedAt: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null,
          batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
        },
      }))
    })
    f.flush.mockImplementation(async (ids, options) => {
      await options.prepare?.()
      return { events: [], reason: `No network in fixture; ${ids.length} selected rows queued.` }
    })
    const service = new Activity24_25Certification({ ...f.deps, storage: undefined, snapshotStore: nativeStorage })
    await service.captureAndDeliver()
    const exact = await service.exportSaved()
    const writes = nativeStorage.writeActivityCertificationSnapshot.mock.calls.length
    expect(await new Activity24_25Certification({ ...f.deps, storage: undefined, snapshotStore: nativeStorage }).exportSaved()).toBe(exact)
    expect(nativeStorage.writeActivityCertificationSnapshot).toHaveBeenCalledTimes(writes)
    expect(f.storageRows.size).toBe(0)
  })
})
