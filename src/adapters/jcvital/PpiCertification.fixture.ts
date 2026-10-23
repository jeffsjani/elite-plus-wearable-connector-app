/** Shared in-memory physical PPI fixture for certification and read-only recovery tests. */
import { vi } from 'vitest'
import type { NativeObservation } from '../../models/wearableObservation'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent, CertificationFlushOptions, CertificationFlushReport } from '../../services/sync/ObservationBatchManager'
import type { JCVitalV8HistoricalSyncResult, JCVitalV8Plugin } from './jcvitalV8Bridge'
import { PpiCertification, type PpiOriginalSlot } from './PpiCertification'

export const MAC = 'E7:1B:D8:36:78:CF'
export const DEVICE = 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b'
export const TIME = '2026-10-04T12:00:00.000Z'
export const DATE = '2026.10.04 12:00:00'
type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>

export function typed(type: string, value?: string) {
  return value === undefined ? { type } : { type, value }
}

function key(name: string) { return typed('String', name) }

function mapSnapshot(entries: Array<[string, unknown]>) {
  return { type: 'Map', entries: entries.map(([name, value]) => ({ key: key(name), value })) }
}

export function originalSlot(value: number | null | string, index: number): PpiOriginalSlot {
  if (value === null) return { index, originalValue: typed('null'), token: null, value: null, parseStatus: 'NULL' }
  if (typeof value === 'string') {
    const parsed = /^-?\d+$/.test(value) ? Number(value) : NaN
    const valid = Number.isInteger(parsed) && parsed >= -2147483648 && parsed <= 2147483647
    return { index, originalValue: typed('String', value), token: value, value: valid ? parsed : null, parseStatus: valid ? 'VALID_INT32' : 'INVALID_INT32' }
  }
  return { index, originalValue: typed('Int', String(value)), token: String(value), value, parseStatus: 'VALID_INT32' }
}

function typedSlot(slot: PpiOriginalSlot) { return slot.originalValue }

export async function fixture(values: Array<number | null | string> = [11, 0, 22, 0, 22, 0, 33]) {
  let owner = 'user-1'
  const context = {
    scope: { accountId: owner, deviceScopeId: DEVICE }, bleAddress: MAC,
    firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0', ready: true, physical: true, native: true,
  }
  const storageRows = new Map<string, string>()
  const storage = {
    getItem: (keyName: string) => storageRows.get(keyName) ?? null,
    setItem: (keyName: string, value: string) => { storageRows.set(keyName, value) },
    key: (index: number) => [...storageRows.keys()][index] ?? null,
    get length() { return storageRows.size },
  }
  const journalRows = new Map<string, Entry>()
  const queueRows = new Map<string, QueueRecord>()
  const header = {
    ...context.scope, provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE',
    firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion, acquisitionMode: 'HISTORICAL_SYNC',
  }
  const bytes = Uint8Array.from([127, 1, 2, 3])
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')

  function addGroup(id: string, rawValues: Array<number | null | string> = values) {
    const slots = rawValues.map(originalSlot)
    const callbackId = `${id}-callback`
    const notificationId = `${id}-ble`
    const recordSnapshot = mapSnapshot([
      ['date', typed('String', DATE)],
      ['serial_number', typed('String', 'serial-7')],
      ['ppiData', { type: 'List', values: slots.map(typedSlot) }],
    ])
    const recordEnvelope = {
      ...header, envelopeId: id, kind: 'SDK_RECORD', vendorDataType: '127',
      acquisitionMode: 'HISTORICAL_SYNC', callbackId, notificationEnvelopeId: notificationId,
      recordIndex: 0, sourceRecordId: id, sourceRecordGroupId: callbackId, packetId: 'serial-7',
      sdkSnapshot: recordSnapshot, sourceDate: DATE, sourceDateParseStatus: 'VALID', observedAt: TIME,
      receivedAt: TIME,
      sourceArrays: [{
        fieldKeySnapshot: key('ppiData'), sourceLength: slots.length,
        slots: slots.map((slot) => ({
          sourceIndex: slot.index, originalValue: slot.parseStatus === 'NULL' ? null : slot.originalValue,
          parseStatus: slot.parseStatus,
        })),
      }],
    }
    const callbackSnapshot = mapSnapshot([
      ['dataType', typed('String', '127')],
      ['dicData', { type: 'List', values: [recordSnapshot] }],
    ])
    function write(envelopeId: string, json: Record<string, unknown>, rawBytesBase64: string | null = null) {
      journalRows.set(envelopeId, {
        envelopeId, sequence: journalRows.size + 1, sourceFile: null, rawBytesBase64,
        envelopeJson: JSON.stringify({ ...header, envelopeId, ...json }),
      })
    }
    write(id, recordEnvelope)
    write(callbackId, {
      kind: 'SDK_CALLBACK', vendorDataType: '127', callbackId, notificationEnvelopeId: notificationId,
      recordEnvelopeIds: [id], sdkSnapshot: callbackSnapshot,
    })
    write(notificationId, { kind: 'BLE_NOTIFICATION', byteLength: bytes.length, sha256: hash }, 'fwECAw==')
    return {
      id, slots,
      native: {
        id: `${id}-native`, source: {
          connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8',
          deviceId: MAC, macAddress: MAC, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion,
        },
        metricType: 'PPI', observedAt: TIME, observedAtSource: DATE, receivedAt: TIME, timezone: 'UTC',
        value: null, values: rawValues.filter((value): value is number => typeof value === 'number'),
        unit: 'UNKNOWN_VENDOR_UNIT', acquisitionMode: 'HISTORICAL_SYNC', measurementContext: 'PPI_HISTORY',
        sessionId: 'physical-sync', packetId: 'serial-7', sequenceNumber: null, samplingIntervalMs: null,
        sampleRateHz: null, signalQuality: null, completeness: 'COMPLETE', vendorDataType: '127',
        vendorField: 'ppiData', vendorDerived: false, rawPayload: { record: { date: DATE, serial_number: 'serial-7', ppiData: rawValues } },
        provenance: { sourceEnvelopeId: id, sourceRecordId: id, sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
      } satisfies NativeObservation,
    }
  }
  const sourceGroups = [addGroup('record-1')]
  const sync: JCVitalV8HistoricalSyncResult = {
    syncId: 'physical-sync', deviceId: MAC, provider: 'JCVITAL', sdkCommand: 'syncHistoricalPpi', vendorDataType: '127',
    startedAt: TIME, completedAt: TIME, recordsReceived: 1, recordGroupsReceived: 1, recordsStored: 0,
    recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: TIME, latestObservation: TIME,
    partial: false, completionStatus: 'COMPLETE', packetCount: 1, parseErrors: [],
    observations: sourceGroups.map((group) => group.native),
  }
  const acquire = vi.fn(async () => structuredClone(sync))
  const readSourceEnvelope = vi.fn(async (options: { accountId: string; deviceScopeId: string; envelopeId: string }) => {
    if (options.accountId !== owner || options.deviceScopeId !== context.scope.deviceScopeId) throw new Error('OWNER_MISMATCH')
    const entry = journalRows.get(options.envelopeId)
    if (!entry) throw new Error('MISSING')
    return structuredClone(entry)
  })
  const getRecord = vi.fn(async (id: string) => structuredClone(queueRows.get(id) ?? null))
  const enqueueMany = vi.fn(async (payloads: NativeObservationInput[], refs?: ReadonlyMap<string, string>) => payloads.map((payload) => {
    const row: QueueRecord = {
      queueId: payload.observationId, ownerUserId: owner, observationId: payload.observationId,
      sourceEnvelopeId: refs?.get(payload.observationId), payload: structuredClone(payload), state: 'PENDING',
      createdAt: TIME, updatedAt: TIME, claimedAt: null, attemptCount: 0, nextAttemptAt: null,
      lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null, batchId: null,
      acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
    }
    queueRows.set(payload.observationId, row)
    return { inserted: true, alreadyQueued: false, record: structuredClone(row) }
  }))
  let resultFactory: (ids: readonly string[]) => ConnectorObservationResult[] = (ids) => ids.map((observationId) => ({
    observationId, status: 'accepted', canonicalStatus: 'not_applicable', nativeObservationId: `native-${observationId}`,
  }))
  let ack = true
  const flush = vi.fn(async (ids: readonly string[], options: CertificationFlushOptions): Promise<CertificationFlushReport> => {
    await options.prepare?.()
    const event: BatchDeliveryEvent = {
      batchId: 'ppi-batch', attemptedAt: TIME, outcome: 'DELIVERED',
      observationIds: [...ids], acknowledgedIds: ack ? [...ids] : [], rejectedIds: [],
      httpStatus: 200, errorCode: null, accepted: ids.length, duplicate: 0, rejected: 0,
      results: resultFactory(ids),
    }
    options.persistEvidence?.(event)
    if (ack) for (const id of ids) queueRows.delete(id)
    return { events: [event], reason: null }
  })
  const deps = {
    queue: { getOwnerUserId: () => owner, enqueueMany, getRecord }, acquire, journal: { readSourceEnvelope },
    flush, deliveryDiagnostics: () => ({
      activeBatches: [{ batchId: 'ppi-batch', responseContractVersion: 'native-only-v1', deploymentRevision: 'vc9-deploy' }],
      recentResponseShapes: [],
    }), connectedContext: () => structuredClone(context), storage: () => storage,
  }
  const service = new PpiCertification(deps)
  return {
    service, deps, sync, context, acquire, readSourceEnvelope, enqueueMany, flush, storageRows, journalRows, queueRows, sourceGroups,
    addGroup,
    setResults(value: (ids: readonly string[]) => ConnectorObservationResult[]) { resultFactory = value },
    setAck(value: boolean) { ack = value },
    setOwner(value: string) { owner = value; context.scope.accountId = value },
  }
}

export function slots(values: number[]): PpiOriginalSlot[] { return values.map(originalSlot) }
