import type { NativeObservation } from '../../models/wearableObservation'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { EnqueueResult, QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent, CertificationFlushOptions, CertificationFlushReport } from '../../services/sync/ObservationBatchManager'
import { sha256Hex } from './HeartRateSeries'
import type { JCVitalV8HistoricalSyncResult, JCVitalV8Plugin } from './jcvitalV8Bridge'
import { mapPhysiologyObservation, PHYSIOLOGY_CONTRACTS } from './PhysiologyContract'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import type { Type42ConnectedContext } from './Type42Certification'
import { CertificationExportError, exportStage, serializeCertificationJson } from './CertificationJsonExport'
import type { PpiAttemptEvent } from './PpiCertificationAttempt'

export const PPI_CERTIFICATION_SUCCESS = 'PPI_CERTIFICATION_SUCCESS'
export const NO_COMPLETE_PPI_CERTIFICATION_GROUP = 'NO_COMPLETE_PPI_CERTIFICATION_GROUP'
const SUCCESS_MESSAGE = (count: number) => `1 PPI record preserved · ${count}/${count} selected native-only observations delivered`
const PPI_FIELD = 'ppiData'

type JournalEntry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type JsonObject = Record<string, unknown>
type SlotParseStatus = 'VALID_INT32' | 'NULL' | 'INVALID_INT32'

export interface PpiOriginalSlot {
  index: number
  originalValue: unknown
  token: string | null
  value: number | null
  parseStatus: SlotParseStatus
}

export interface PpiCertificationChild {
  observationId: string
  sourceEnvelopeId: string
  slotIndex: number
  value: number
  categories: string[]
  canonicalTarget: null
  payload: NativeObservationInput
  payloadJson: string
  payloadFingerprint: string
  receipts: Array<{
    event: BatchDeliveryEvent
    result: ConnectorObservationResult
    nativeObservationId: string
    payloadFingerprint: string
    sourceFingerprint: string
    responseContractVersion: string | null
    deploymentRevision: string | null
    acknowledged: boolean
  }>
  queueState: QueueRecord['state'] | null
  queueDisposition: 'NOT_ENQUEUED' | 'QUEUED' | 'MISSING' | 'ACKNOWLEDGED_PURGED'
}

export interface PpiCertificationGroup {
  version: 1
  certificationGroupId: string
  ownerUserId: string
  context: Type42ConnectedContext
  capturedAt: string
  syncId: string
  sourceEnvelopeId: string
  sourceRecordGroupId: string
  sourceEnvelopeJson: string
  sourceFingerprint: string
  sourceAncestry: JournalEntry[]
  sourceArrayLength: number
  originalSlots: PpiOriginalSlot[]
  nativeObservation: NativeObservation
  children: PpiCertificationChild[]
  events: BatchDeliveryEvent[]
  eventFingerprints: Array<{ batchId: string; attemptedAt: string; responseContractVersion: string | null; deploymentRevision: string | null }>
  lastFlushReason: string | null
}

export interface PpiCertificationInspection {
  status: typeof PPI_CERTIFICATION_SUCCESS | typeof NO_COMPLETE_PPI_CERTIFICATION_GROUP
    | 'PPI_CERTIFICATION_INCOMPLETE' | 'PPI_CERTIFICATION_EVIDENCE_INVALID'
  delivered: number
  reason: string | null
  group: PpiCertificationGroup | null
  diagnostic?: CertificationExportError
}

class SourceValidationError extends Error {}

function sourceArrayCounts(value: unknown): unknown {
  if (!Array.isArray(value)) return { available: false }
  return value.map((annotation) => {
    if (!annotation || typeof annotation !== 'object') return { malformed: true }
    return { sourceLength: annotation.sourceLength ?? null,
      annotatedSlotCount: Array.isArray(annotation.slots) ? annotation.slots.length : null }
  })
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceValidationError('Invalid PPI source journal object.')
  return value as JsonObject
}

function typedString(value: unknown): string | null {
  const typed = object(value)
  return typed.type === 'String' && typeof typed.value === 'string' ? typed.value : null
}

function typedScalar(value: unknown): string | null {
  const typed = object(value)
  return typeof typed.value === 'string' ? typed.value : null
}

function typedEntries(value: unknown): Array<{ key: unknown; value: unknown }> {
  const typed = object(value)
  if (typed.type !== 'Map' || !Array.isArray(typed.entries)) throw new SourceValidationError('PPI SDK record is not a typed Map.')
  return typed.entries.map((entry) => object(entry) as { key: unknown; value: unknown })
}

function typedField(snapshot: unknown, name: string): unknown {
  const values = typedEntries(snapshot).filter((entry) => typedString(entry.key) === name)
  if (values.length !== 1) throw new SourceValidationError(`PPI SDK field ${name} is missing or duplicated.`)
  return values[0].value
}

/** Exact trimmed-string equality for vendor date text; never parses or reformats it. */
function normalizedSourceText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

/**
 * Canonical-instant equality for timestamps: accepts a string or a Date (never compares Date identity) and
 * returns the shared epoch-millisecond instant as a fixed ISO string, so differing textual formats/precision
 * that represent the same moment still compare equal.
 */
function normalizedInstant(value: unknown): string | null {
  const ms = value instanceof Date ? value.getTime()
    : typeof value === 'string' && value.trim() ? Date.parse(value.trim())
      : typeof value === 'number' ? value : NaN
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/** Null-safe serial normalization: string/number vendor serials compare by value; unrelated types are rejected. */
function normalizedSerial(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value.trim() : null
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

function int32(value: unknown): number | null {
  if (typeof value !== 'string' || !/^-?\d+$/.test(value)) return null
  const number = Number(value)
  return Number.isInteger(number) && number >= -2147483648 && number <= 2147483647 ? number : null
}

function slotsFromTypedValue(raw: unknown): PpiOriginalSlot[] {
  const typed = object(raw)
  if (typed.type === 'List' || (typeof typed.type === 'string' && typed.type.endsWith('[]'))) {
    if (!Array.isArray(typed.values)) throw new SourceValidationError('PPI array snapshot has no ordered values.')
    return typed.values.map((item, index) => {
      const element = object(item)
      if (element.type === 'null') return { index, originalValue: item, token: null, value: null, parseStatus: 'NULL' }
      const token = typeof element.value === 'string' ? element.value : null
      const value = int32(token)
      return { index, originalValue: item, token, value, parseStatus: value === null ? 'INVALID_INT32' : 'VALID_INT32' }
    })
  }
  if (typed.type === 'String' && typeof typed.value === 'string') {
    return typed.value.split(/[, \t\r\n\x5b\x5d]+/).filter((token) => token.length > 0).map((token, index) => {
      const value = int32(token)
      return { index, originalValue: token, token, value, parseStatus: value === null ? 'INVALID_INT32' : 'VALID_INT32' }
    })
  }
  if (typed.type === 'null') return [{ index: 0, originalValue: raw, token: null, value: null, parseStatus: 'NULL' }]
  throw new SourceValidationError('PPI source field is not an ordered array representation.')
}

function parseSourceSlots(record: JsonObject): PpiOriginalSlot[] {
  const raw = typedField(record.sdkSnapshot, PPI_FIELD)
  const typed = object(raw)
  const slots = slotsFromTypedValue(raw)
  const annotations = record.sourceArrays
  if (typed.type === 'List' || (typeof typed.type === 'string' && typed.type.endsWith('[]'))) {
    if (!Array.isArray(annotations)) throw new SourceValidationError('PPI source array annotations are missing.')
    const matches = annotations.map(object).filter((item) => {
      try {
        return typedString(object(item.fieldKeySnapshot)) === PPI_FIELD
      } catch {
        return false
      }
    })
    if (matches.length !== 1) throw new SourceValidationError('PPI source array annotation is missing or ambiguous.')
    const annotation = matches[0]
    if (annotation.sourceLength !== slots.length || !Array.isArray(annotation.slots)
      || annotation.slots.length !== slots.length
      || annotation.slots.some((slot, index) => {
        const item = object(slot)
        const annotationValue = item.originalValue
        const expectedOriginal = slots[index].parseStatus === 'NULL' ? null : slots[index].originalValue
        return item.sourceIndex !== index || item.parseStatus !== slots[index].parseStatus
          || JSON.stringify(annotationValue) !== JSON.stringify(expectedOriginal)
      })) throw new SourceValidationError('PPI source array annotation differs from the original ordered slots.')
  }
  return slots
}

/** Stable category order and index deduplication make the selected sample reproducible. */
export function selectPpiCertificationSlots(slots: readonly PpiOriginalSlot[]): Array<{ slot: PpiOriginalSlot; categories: string[] }> {
  if (slots.some((slot, index) => slot.index !== index)) throw new Error('PPI source slots are not in original index order.')
  const selections = new Map<number, { slot: PpiOriginalSlot; categories: string[] }>()
  const add = (index: number, category: string) => {
    const slot = slots[index]
    if (!slot || slot.parseStatus !== 'VALID_INT32' || slot.value === null) return
    const selected = selections.get(index)
    if (selected) selected.categories.push(category)
    else selections.set(index, { slot, categories: [category] })
  }
  const last = slots.length - 1
  if (last >= 0) {
    add(0, 'first')
    add(last, 'last')
  }
  if (slots.length > 2) {
    const firstInteriorNonZero = slots.find((slot) => slot.index > 0 && slot.index < last && slot.parseStatus === 'VALID_INT32' && slot.value !== 0)
    const firstInteriorZero = slots.find((slot) => slot.index > 0 && slot.index < last && slot.parseStatus === 'VALID_INT32' && slot.value === 0)
    if (firstInteriorNonZero) add(firstInteriorNonZero.index, 'firstInteriorNonZero')
    if (firstInteriorZero) add(firstInteriorZero.index, 'firstInteriorZero')
    add(Math.floor(slots.length / 2), 'midpointInterior')
  }
  return [...selections.values()].sort((a, b) => a.slot.index - b.slot.index)
}

export interface PpiCertificationDependencies {
  queue: {
    getOwnerUserId(): string | null
    enqueueMany(payloads: NativeObservationInput[], refs?: ReadonlyMap<string, string>): Promise<EnqueueResult[]>
    getRecord(id: string): Promise<QueueRecord | null>
  }
  acquire(): Promise<JCVitalV8HistoricalSyncResult>
  journal: Pick<JCVitalV8Plugin, 'readSourceEnvelope'>
  flush(ids: readonly string[], options: CertificationFlushOptions): Promise<CertificationFlushReport>
  deliveryDiagnostics(): {
    activeBatches: Array<{ batchId: string; responseContractVersion: string | null; deploymentRevision: string | null }>
    recentResponseShapes: Array<{ batchId: string; responseContractVersion: string | null; deploymentRevision: string | null }>
  }
  connectedContext(): Type42ConnectedContext
  storage?: () => Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'key' | 'length'>>
  attemptEvent?: (stage: string, status: PpiAttemptEvent['status'], details?: unknown, error?: unknown) => void
  attemptJournal?: Pick<JCVitalV8Plugin, 'listSourceEnvelopes'>
}

/** Grouped type-127 certification; it reuses the shared PPI mapper and exact-ID sender. */
export class PpiCertification {
  private readonly deps: PpiCertificationDependencies
  private captureInProgress: Promise<PpiCertificationInspection> | null = null
  private flushInProgress: Promise<PpiCertificationInspection> | null = null

  constructor(deps: PpiCertificationDependencies) { this.deps = deps }

  private trace(stage: string, status: PpiAttemptEvent['status'], details: unknown = null, error?: unknown): void {
    this.deps.attemptEvent?.(stage, status, details, error)
  }

  private async traced<T>(stage: string, action: () => T | Promise<T>, details: unknown = null): Promise<T> {
    this.trace(stage, 'STARTED', details)
    try {
      const result = await action()
      this.trace(stage, 'PASSED', details)
      return result
    } catch (error) {
      this.trace(stage, 'FAILED', details, error)
      throw error
    }
  }

  private owner(): string {
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) throw new Error('PPI certification requires an authenticated queue owner.')
    return owner
  }

  private key(owner: string, device: string): string {
    return `elitePlus.ppiCertification.v1.${encodeURIComponent(owner)}.${encodeURIComponent(device)}`
  }

  private storage() { return (this.deps.storage ?? (() => localStorage))() }

  hasSavedEvidence(): boolean {
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) return false
    const storage = this.storage()
    const prefix = `elitePlus.ppiCertification.v1.${encodeURIComponent(owner)}.`
    for (let index = 0; index < (storage.length ?? 0); index++) {
      if (storage.key?.(index)?.startsWith(prefix)) return true
    }
    return false
  }

  private assertScope(context: Type42ConnectedContext): void {
    const current = this.deps.connectedContext()
    if (this.owner() !== context.scope.accountId || current.scope.accountId !== context.scope.accountId
      || current.scope.deviceScopeId !== context.scope.deviceScopeId) throw new Error('Account or device changed during PPI certification.')
  }

  snapshot(): PpiCertificationGroup | null {
    const owner = this.owner()
    const context = this.deps.connectedContext()
    if (context.scope.accountId !== owner) return null
    const text = this.storage().getItem(this.key(owner, context.scope.deviceScopeId))
    if (!text) return null
    return PpiCertification.validateGroupShape(JSON.parse(text), owner, context.scope.deviceScopeId)
  }

  /** Structural check shared by exact-key reads and read-only legacy-key recovery. */
  static validateGroupShape(group: PpiCertificationGroup, owner: string, deviceScopeId: string): PpiCertificationGroup {
    if (group.version !== 1 || group.ownerUserId !== owner || group.context.scope.accountId !== owner
      || group.context.scope.deviceScopeId !== deviceScopeId
      || !group.sourceEnvelopeId || !/^[0-9a-f]{64}$/.test(group.sourceFingerprint)
      || !Array.isArray(group.originalSlots) || group.originalSlots.length !== group.sourceArrayLength
      || !Array.isArray(group.children) || group.children.length < 1
      || new Set(group.children.map((child) => child.observationId)).size !== group.children.length
      || group.children.some((child) => !/^[0-9a-f]{64}$/.test(child.observationId))) {
      throw new Error('Stored PPI certification evidence is invalid.')
    }
    return group
  }

  private save(group: PpiCertificationGroup): void {
    this.assertScope(group.context)
    const key = this.key(group.ownerUserId, group.context.scope.deviceScopeId)
    let json: string
    try {
      json = JSON.stringify(group)
      this.trace('SNAPSHOT_SERIALIZATION', 'PASSED', { key, characterCount: json.length, certificationGroupId: group.certificationGroupId })
    } catch (error) {
      this.trace('SNAPSHOT_SERIALIZATION', 'FAILED', { key }, error)
      throw error
    }
    try {
      this.storage().setItem(key, json)
      this.trace('LOCAL_STORAGE_SAVE', 'PASSED', { key })
    } catch (error) {
      this.trace('LOCAL_STORAGE_SAVE', 'FAILED', { key }, error)
      throw error
    }
    if (!this.deps.attemptEvent) return
    // Observational read-back: a diagnostic failure does not change the existing save semantics.
    try {
      const saved = this.storage().getItem(key)
      this.trace('POST_SAVE_READ_BACK', saved === json ? 'PASSED' : 'FAILED',
        { key, expectedCharacters: json.length, actualCharacters: saved?.length ?? null },
        saved === json ? undefined : new Error('SNAPSHOT_POST_SAVE_LOOKUP_OR_KEY_MISMATCH'))
    } catch (error) {
      this.trace('POST_SAVE_READ_BACK', 'FAILED', { key }, error)
    }
  }

  verifySnapshotPersisted(group: PpiCertificationGroup): string {
    this.assertScope(group.context)
    const key = this.key(group.ownerUserId, group.context.scope.deviceScopeId)
    if (this.storage().getItem(key) !== JSON.stringify(group)) {
      const error = new CertificationExportError('SNAPSHOT_READ', new Error('PPI certification snapshot persistence verification failed.'))
      this.trace('SNAPSHOT_PERSISTENCE_CONFIRMATION', 'FAILED', { key, certificationGroupId: group.certificationGroupId }, error)
      throw error
    }
    this.trace('SNAPSHOT_PERSISTENCE_CONFIRMATION', 'PASSED', { key, certificationGroupId: group.certificationGroupId })
    return key
  }

  private async read(context: Type42ConnectedContext, id: string, kind: string) {
    const entry = await this.deps.journal.readSourceEnvelope({ ...context.scope, envelopeId: id })
    this.assertScope(context)
    return this.checkEnvelope(context, id, kind, entry)
  }

  private checkEnvelope(context: Type42ConnectedContext, id: string, kind: string, entry: JournalEntry) {
    const json = object(JSON.parse(entry.envelopeJson))
    if (entry.envelopeId !== id || json.envelopeId !== id || json.kind !== kind
      || json.provider !== 'JCVITAL' || json.sourceConnector !== 'JCVITAL_NATIVE'
      || json.accountId !== context.scope.accountId || json.deviceScopeId !== context.scope.deviceScopeId
      || json.firmwareVersion !== context.firmwareVersion || json.sdkVersion !== context.sdkVersion) {
      throw new SourceValidationError('Durable source envelope does not match the connected physical JCVITAL scope.')
    }
    return { entry, json }
  }

  /** Read-only: validates one type-127 SDK_RECORD and its callback/BLE ancestry in the connected journal scope. */
  readSourceEvidence(context: Type42ConnectedContext, id: string) {
    return this.source(context, id)
  }

  private async source(context: Type42ConnectedContext, id: string,
    read: (context: Type42ConnectedContext, id: string, kind: string) => Promise<{ entry: JournalEntry; json: JsonObject }>
    = (scope, envelopeId, kind) => this.read(scope, envelopeId, kind)) {
    const record = await this.traced('SDK_RECORD_READ', () => read(context, id, 'SDK_RECORD'), { sourceEnvelopeId: id })
    const r = record.json
    if (r.vendorDataType !== '127' || r.acquisitionMode !== 'HISTORICAL_SYNC'
      || typeof r.callbackId !== 'string' || typeof r.notificationEnvelopeId !== 'string'
      || !Number.isInteger(r.recordIndex) || Number(r.recordIndex) < 0
      || r.sourceRecordId !== id || r.sourceRecordGroupId !== r.callbackId
      || r.sourceDateParseStatus !== 'VALID' || typeof r.observedAt !== 'string') {
      throw new SourceValidationError('Missing complete type-127 SDK_RECORD provenance.')
    }
    const slots = await this.traced('SOURCE_ARRAYS', () => parseSourceSlots(r), {
      sourceEnvelopeId: id, sourceArrays: sourceArrayCounts(r.sourceArrays) })
    this.trace('SOURCE_SLOT_COUNTS', 'INFO', { sourceEnvelopeId: id, sourceArraysSlotCount: slots.length,
      invalidSlots: slots.filter((slot) => slot.parseStatus !== 'VALID_INT32')
        .map((slot) => ({ index: slot.index, token: slot.token, parseStatus: slot.parseStatus })) })
    if (typedString(typedField(r.sdkSnapshot, 'date')) !== r.sourceDate) {
      throw new SourceValidationError('PPI SDK date does not match source-record metadata.')
    }
    const serialNumber = typedScalar(typedField(r.sdkSnapshot, 'serial_number'))
    if (slots.length === 0) throw new SourceValidationError('PPI source record has no slots.')
    const callback = await this.traced('CALLBACK_ANCESTRY', () => read(context, String(r.callbackId), 'SDK_CALLBACK'), { sourceEnvelopeId: id, callbackId: r.callbackId })
    const c = callback.json
    if (c.vendorDataType !== '127' || c.callbackId !== r.callbackId
      || c.notificationEnvelopeId !== r.notificationEnvelopeId || !Array.isArray(c.recordEnvelopeIds)
      || c.recordEnvelopeIds[Number(r.recordIndex)] !== id) {
      throw new SourceValidationError('PPI SDK record has no durable callback link.')
    }
    const callbackMap = object(c.sdkSnapshot)
    if (callbackMap.type !== 'Map' || !Array.isArray(callbackMap.entries)) throw new SourceValidationError('Invalid PPI SDK callback snapshot.')
    const dataEntry = callbackMap.entries.map(object).find((entry) => typedString(object(entry.key)) === 'dicData')
    if (!dataEntry) throw new SourceValidationError('PPI callback does not contain the SDK record list.')
    const data = object(dataEntry.value)
    const callbackRecord = data.type === 'List' && Array.isArray(data.values)
      ? data.values[Number(r.recordIndex)] : Number(r.recordIndex) === 0 ? data : null
    if (JSON.stringify(callbackRecord) !== JSON.stringify(r.sdkSnapshot)) throw new SourceValidationError('PPI callback record snapshot differs.')
    const notification = await this.traced('NOTIFICATION_ANCESTRY', () => read(context, String(r.notificationEnvelopeId), 'BLE_NOTIFICATION'),
      { sourceEnvelopeId: id, notificationEnvelopeId: r.notificationEnvelopeId })
    const bytes = notification.entry.rawBytesBase64
    if (!bytes || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)) {
      const error = new SourceValidationError('Missing durable original PPI BLE source bytes.')
      this.trace('RAW_NOTIFICATION_INTEGRITY', 'FAILED', { sourceEnvelopeId: id }, error)
      throw error
    }
    const raw = Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0))
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
      .map((value) => value.toString(16).padStart(2, '0')).join('')
    if (!raw.length || notification.json.byteLength !== raw.length || notification.json.sha256 !== digest) {
      const error = new SourceValidationError('Original PPI BLE source bytes fail integrity verification.')
      this.trace('RAW_NOTIFICATION_INTEGRITY', 'FAILED', { sourceEnvelopeId: id, actualLength: raw.length,
        expectedLength: notification.json.byteLength, actualSha256: digest, expectedSha256: notification.json.sha256 }, error)
      throw error
    }
    this.trace('RAW_NOTIFICATION_INTEGRITY', 'PASSED', { sourceEnvelopeId: id, byteLength: raw.length, sha256: digest })
    return { record, callback, notification, slots, serialNumber, ancestry: [record.entry, callback.entry, notification.entry] }
  }

  capture(): Promise<PpiCertificationInspection> {
    if (this.captureInProgress) return this.captureInProgress
    this.captureInProgress = this.captureOnce().finally(() => { this.captureInProgress = null })
    return this.captureInProgress
  }

  private async captureOnce(): Promise<PpiCertificationInspection> {
    if (await this.traced('EXISTING_SNAPSHOT_LOOKUP', () => this.snapshot())) {
      this.trace('ACQUISITION_SKIPPED', 'INFO', { reason: 'Existing snapshot; unchanged no-reacquisition guard.' })
      return this.inspectSaved()
    }
    const context = await this.traced('PHYSICAL_CONTEXT', () => structuredClone(this.deps.connectedContext()))
    this.trace('PHYSICAL_READY', 'INFO', { ready: context.ready, physical: context.physical, native: context.native,
      accountId: context.scope.accountId, deviceScopeId: context.scope.deviceScopeId })
    this.assertScope(context)
    if (!context.ready || !context.physical || !context.native || !context.bleAddress
      || !isOpaqueJCVitalDeviceId(context.scope.deviceScopeId)) {
      const error = new Error('PPI capture requires a ready physical native JCVITAL device.')
      this.trace('PHYSICAL_READY', 'FAILED', { ready: context.ready }, error)
      throw error
    }
    const startedAt = new Date().toISOString()
    let sync: JCVitalV8HistoricalSyncResult
    try {
      sync = await this.traced('SYNC_HISTORICAL_PPI', () => this.deps.acquire())
    } catch (error) {
      await this.auditAttemptJournal(context, { startedAt, completedAt: new Date().toISOString() })
      throw error
    }
    this.trace('HISTORY_REQUEST_COMPLETED', 'INFO', { syncId: sync.syncId, startedAt: sync.startedAt,
      completedAt: sync.completedAt, completionStatus: sync.completionStatus, partial: sync.partial,
      recordsReceived: sync.recordsReceived, recordGroupsReceived: sync.recordGroupsReceived,
      packetCount: sync.packetCount, parseErrors: sync.parseErrors, normalizedObservationCount: sync.observations.length })
    this.assertScope(context)
    const current = this.deps.connectedContext()
    if (!current.ready || !current.physical || !current.native || current.bleAddress !== context.bleAddress
      || current.firmwareVersion !== context.firmwareVersion || current.sdkVersion !== context.sdkVersion) {
      const error = new Error('Physical connected context changed during PPI acquisition.')
      this.trace('POST_ACQUISITION_CONTEXT', 'FAILED', { current, expected: context }, error)
      throw error
    }
    if (sync.provider !== 'JCVITAL' || sync.vendorDataType !== '127' || sync.deviceId !== context.bleAddress) {
      this.trace('HISTORY_SOURCE', 'FAILED', { provider: sync.provider, vendorDataType: sync.vendorDataType },
        new Error('Acquisition is not the connected type-127 source.'))
      return { status: NO_COMPLETE_PPI_CERTIFICATION_GROUP, delivered: 0, reason: 'Acquisition is not the connected type-127 source.', group: null }
    }
    const candidates = sync.observations.filter((native) => native.vendorDataType === '127'
      && native.metricType === 'PPI' && native.acquisitionMode === 'HISTORICAL_SYNC'
      && native.source.connector === 'JCVITAL_NATIVE' && native.source.provider === 'JCVITAL'
      && native.source.macAddress === context.bleAddress
      && native.provenance.sourceConnector === 'JCVITAL_NATIVE' && native.provenance.provider === 'JCVITAL'
      && !!native.provenance.sourceEnvelopeId)
    this.trace('CANDIDATE_GROUPS', candidates.length ? 'INFO' : 'FAILED', {
      count: candidates.length, multipleCandidateGroups: candidates.length > 1,
      candidates: candidates.map((native) => ({ sourceEnvelopeId: native.provenance.sourceEnvelopeId,
        normalizedValuesSlotCount: native.values?.length ?? null })),
      returnedObservations: sync.observations.map((native) => ({ vendorDataType: native.vendorDataType,
        metricType: native.metricType, sourceEnvelopeId: native.provenance.sourceEnvelopeId ?? null })),
    }, candidates.length ? undefined : new Error('NO_TYPE_127_CERTIFICATION_CANDIDATES'))
    await this.auditAttemptJournal(context, sync)
    let reason = 'No complete physical type-127 source group with lossless numeric slots was found.'
    for (const native of candidates) {
      const id = native.provenance.sourceEnvelopeId!
      try {
        const source = await this.traced('ANCESTRY_VERIFICATION', () => this.source(context, id), { sourceEnvelopeId: id })
        // VC15: the prior predicate also compared source.record.json.receivedAt !== native.receivedAt. That field is
        // independently re-stamped with System.currentTimeMillis() on the native side once when the SDK_RECORD is
        // journaled and again later when the normalized NativeObservation is emitted, so it is almost never
        // byte-identical even for a perfectly intact record - it is not vendor-provided source metadata and was never
        // part of the required alignment contract (source date text, observed instant, group serial). Comparing it
        // made every real physical candidate fail even when the fields that matter were equal and unlogged, so it is
        // a "comparing the wrong field" false negative. It is kept below purely as non-gating diagnostic context.
        const sourceDateMatches = normalizedSourceText(source.record.json.sourceDate) !== null
          && normalizedSourceText(source.record.json.sourceDate) === normalizedSourceText(native.observedAtSource)
        const observedAtMatches = normalizedInstant(source.record.json.observedAt) !== null
          && normalizedInstant(source.record.json.observedAt) === normalizedInstant(native.observedAt)
        const serialMatches = normalizedSerial(source.serialNumber) !== null
          && normalizedSerial(source.serialNumber) === normalizedSerial(native.packetId)
        const receivedAtMatches = normalizedInstant(source.record.json.receivedAt) !== null
          && normalizedInstant(source.record.json.receivedAt) === normalizedInstant(native.receivedAt)
        const metadataAlignmentPass = sourceDateMatches && observedAtMatches && serialMatches
        if (!metadataAlignmentPass) {
          const error = new SourceValidationError('PPI NativeObservation timestamp or group serial differs from the original SDK record.')
          this.trace('SOURCE_METADATA_ALIGNMENT', 'FAILED', { sourceEnvelopeId: id, sourceDate: source.record.json.sourceDate,
            observedAtSource: native.observedAtSource, sourceObservedAt: source.record.json.observedAt,
            normalizedObservedAt: native.observedAt, sourceSerial: source.serialNumber, normalizedPacketId: native.packetId,
            sourceDateMatches, observedAtMatches, serialMatches, receivedAtMatches, metadataAlignmentPass }, error)
          throw error
        }
        this.trace('SOURCE_METADATA_ALIGNMENT', 'PASSED', { sourceEnvelopeId: id, sourceDateMatches, observedAtMatches,
          serialMatches, receivedAtMatches, metadataAlignmentPass })
        const mapped = await this.traced('MAPPING', () => mapPhysiologyObservation(this.owner(), native, {
          deviceId: context.scope.deviceScopeId, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion,
        }), { sourceEnvelopeId: id })
        this.trace('MAPPING_RESULT', 'INFO', { sourceEnvelopeId: id, mappedCount: mapped.length,
          successfulCount: mapped.filter((item) => item.status === 'MAPPED').length,
          failures: mapped.filter((item) => item.status !== 'MAPPED') })
        if (source.slots.some((slot) => slot.parseStatus !== 'VALID_INT32' || slot.value === null)
          || !Array.isArray(native.values) || native.values.length !== source.slots.length
          || native.values.some((value, index) => value !== source.slots[index].value)
          || mapped.length !== source.slots.length || mapped.some((item) => item.status !== 'MAPPED')) {
          const error = new SourceValidationError('PPI normalized values do not preserve every original source slot without compaction.')
          this.trace('SLOT_ALIGNMENT', 'FAILED', { sourceEnvelopeId: id, sourceSlotCount: source.slots.length,
            normalizedValuesSlotCount: native.values?.length ?? null, mappedCount: mapped.length,
            mismatchedSlots: source.slots.filter((slot, index) => slot.parseStatus !== 'VALID_INT32'
              || slot.value !== native.values?.[index]).map((slot) => ({ index: slot.index,
              sourceValue: slot.value, normalizedValue: native.values?.[slot.index] ?? null,
              parseStatus: slot.parseStatus })) }, error)
          throw error
        }
        this.trace('SLOT_ALIGNMENT', 'PASSED', { sourceEnvelopeId: id, sourceSlotCount: source.slots.length,
          normalizedValuesSlotCount: native.values.length, mappedCount: mapped.length })
        const mappedSlots = mapped.map((item) => {
          if (item.status !== 'MAPPED' || item.sourceEnvelopeId !== id) {
            const error = new SourceValidationError('PPI mapping child does not match its source envelope.')
            this.trace('MAPPING_SOURCE_ALIGNMENT', 'FAILED', { sourceEnvelopeId: id, result: item }, error)
            throw error
          }
          return item.observation
        })
        const selected = await this.traced('DETERMINISTIC_SELECTION', () => {
          const result = selectPpiCertificationSlots(source.slots)
          if (!result.length) throw new SourceValidationError('PPI source array has no deliverable certification slots.')
          return result
        }, { sourceEnvelopeId: id })
        this.trace('SELECTED_INDEXES', 'INFO', { sourceEnvelopeId: id, indexes: selected.map(({ slot }) => slot.index) })
        const contract = PHYSIOLOGY_CONTRACTS.find((item) => item.key === 'ppi' && item.vendorDataType === '127')
        if (!contract || contract.unit !== 'UNKNOWN_VENDOR_UNIT' || contract.canonicalTarget !== null || contract.canonicalPolicy !== 'NATIVE_ONLY') {
          const error = new SourceValidationError('Existing PPI semantic contract changed.')
          this.trace('SEMANTIC_CONTRACT', 'FAILED', { sourceEnvelopeId: id, contract }, error)
          throw error
        }
        const sourceFingerprint = await sha256Hex(source.record.entry.envelopeJson)
        const group: PpiCertificationGroup = {
          version: 1, certificationGroupId: crypto.randomUUID(), ownerUserId: context.scope.accountId, context,
          capturedAt: new Date().toISOString(), syncId: sync.syncId, sourceEnvelopeId: id,
          sourceRecordGroupId: mappedSlots[0].sourceRecordGroupId!,
          sourceEnvelopeJson: source.record.entry.envelopeJson, sourceFingerprint,
          sourceAncestry: source.ancestry, sourceArrayLength: source.slots.length,
          originalSlots: structuredClone(source.slots), nativeObservation: structuredClone(native),
          children: await Promise.all(selected.map(async ({ slot, categories }) => {
            const payload = mappedSlots[slot.index]
            if (payload.sequenceNumber !== slot.index || payload.startTime !== native.observedAt
              || payload.observedAt !== native.observedAt || payload.unit !== 'UNKNOWN_VENDOR_UNIT'
              || payload.rawSourceMetadata?.canonicalPolicy !== 'NATIVE_ONLY') {
              const error = new SourceValidationError('Mapped PPI child violates slot identity, group timestamp, or native-only contract.')
              this.trace('CHILD_CONTRACT', 'FAILED', { sourceEnvelopeId: id, slotIndex: slot.index,
                observationId: payload.observationId, payload }, error)
              throw error
            }
            const payloadJson = JSON.stringify(payload)
            return {
              observationId: payload.observationId, sourceEnvelopeId: id, slotIndex: slot.index, value: slot.value!,
              categories, canonicalTarget: null, payload, payloadJson,
              payloadFingerprint: await sha256Hex(payloadJson), receipts: [],
              queueState: null, queueDisposition: 'NOT_ENQUEUED' as const,
            }
          })),
          events: [], eventFingerprints: [], lastFlushReason: null,
        }
        this.trace('SELECTED_SOURCE_GROUP', 'INFO', { sourceEnvelopeId: id,
          certificationGroupId: group.certificationGroupId, observationIds: group.children.map((child) => child.observationId) })
        this.save(group)
        return this.inspectSaved()
      } catch (error) {
        this.trace('CANDIDATE_REJECTED', 'FAILED', { sourceEnvelopeId: id }, error)
        if (!(error instanceof SourceValidationError) || this.snapshot()) throw error
        this.assertScope(context)
        reason = error instanceof Error ? error.message : String(error)
      }
    }
    return { status: NO_COMPLETE_PPI_CERTIFICATION_GROUP, delivered: 0, reason, group: null }
  }

  private async auditAttemptJournal(context: Type42ConnectedContext,
    sync: Pick<JCVitalV8HistoricalSyncResult, 'startedAt' | 'completedAt'>): Promise<void> {
    if (!this.deps.attemptEvent) return
    try {
      if (!this.deps.attemptJournal) throw new Error('ATTEMPT_JOURNAL_READER_UNAVAILABLE')
      let afterSequence = 0
      const callbacks: string[] = []
      const records: Array<{ sourceEnvelopeId: string; sourceArraysSlotCounts: unknown }> = []
      for (;;) {
        const page = await this.deps.attemptJournal.listSourceEnvelopes({ ...context.scope, afterSequence, limit: 100 })
        this.assertScope(context)
        for (const entry of page.envelopes) {
          if (entry.receivedAt < sync.startedAt || entry.receivedAt > sync.completedAt) continue
          const envelope = entry.envelopeJson ? JSON.parse(entry.envelopeJson)
            : JSON.parse((await this.deps.journal.readSourceEnvelope({ ...context.scope, envelopeId: entry.envelopeId })).envelopeJson)
          if (envelope.vendorDataType !== '127') continue
          if (entry.kind === 'SDK_CALLBACK') callbacks.push(entry.envelopeId)
          if (entry.kind === 'SDK_RECORD') records.push({ sourceEnvelopeId: entry.envelopeId,
            sourceArraysSlotCounts: sourceArrayCounts(envelope.sourceArrays) })
        }
        if (!page.hasMore) break
        // VC15: trust the highest envelope.sequence actually returned on this page, not only page.nextSequence, so a
        // page whose reported cursor fails to advance (while still returning genuinely new, higher-sequence rows)
        // does not falsely trip the non-advancing guard and undercount callbacks/SDK records.
        const observedMaxSequence = page.envelopes.reduce((max, entry) => Math.max(max, entry.sequence), afterSequence)
        const nextAfterSequence = Math.max(page.nextSequence, observedMaxSequence)
        if (nextAfterSequence <= afterSequence) throw new Error('ATTEMPT_JOURNAL_CURSOR_NOT_ADVANCING')
        afterSequence = nextAfterSequence
      }
      this.trace('TYPE_127_JOURNAL_COUNTS', 'PASSED', { startedAt: sync.startedAt, completedAt: sync.completedAt,
        attribution: 'Connected owner/device journal within history request time window; not inferred from normalized observations.',
        callbackCount: callbacks.length, sdkRecordCount: records.length, callbackIds: callbacks, records })
    } catch (error) {
      this.trace('TYPE_127_JOURNAL_COUNTS', 'FAILED', { callbackCount: null, sdkRecordCount: null }, error)
    }
  }

  private async enqueue(group: PpiCertificationGroup): Promise<void> {
    const results = await this.traced('ENQUEUE', () => this.deps.queue.enqueueMany(group.children.map((child) => structuredClone(child.payload)),
      new Map(group.children.map((child) => [child.observationId, child.sourceEnvelopeId]))),
    { observationIds: group.children.map((child) => child.observationId) })
    this.trace('ENQUEUE_RESULT', 'INFO', results.map((result) => ({ inserted: result.inserted,
      alreadyQueued: result.alreadyQueued, observationId: result.record.observationId, state: result.record.state })))
    this.assertScope(group.context)
    for (const child of group.children) {
      const row = results.find((result) => result.record.observationId === child.observationId)?.record
      if (!row) {
        const error = new Error('PPI certification enqueue omitted a selected child.')
        this.trace('ENQUEUE_VALIDATION', 'FAILED', { observationId: child.observationId }, error)
        throw error
      }
      this.queueEvidence(group, child, row)
    }
    this.save(group)
  }

  private queueEvidence(group: PpiCertificationGroup, child: PpiCertificationChild, row: QueueRecord | null): void {
    if (row && (row.ownerUserId !== group.ownerUserId || row.observationId !== child.observationId
      || row.sourceEnvelopeId !== child.sourceEnvelopeId || JSON.stringify(row.payload) !== child.payloadJson)) {
      const error = new Error('Queued PPI payload or local source reference differs from saved evidence.')
      this.trace('QUEUE_EVIDENCE_VALIDATION', 'FAILED', { observationId: child.observationId,
        sourceEnvelopeId: child.sourceEnvelopeId, queuedOwner: row.ownerUserId, queuedSourceEnvelopeId: row.sourceEnvelopeId }, error)
      throw error
    }
    child.queueState = row?.state ?? null
    child.queueDisposition = row?.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED_PURGED'
      : row ? 'QUEUED' : child.receipts.some((receipt) => receipt.acknowledged) ? 'ACKNOWLEDGED_PURGED' : 'MISSING'
  }

  private record(group: PpiCertificationGroup, event: BatchDeliveryEvent): void {
    this.assertScope(group.context)
    this.trace('BASE44_RESULTS', 'INFO', event)
    for (const result of event.results ?? []) {
      const failure = result.status === 'rejected' ? 'BASE44_REJECTION'
        : result.canonicalStatus === 'canonicalized' ? 'CANONICALIZED_RESPONSE'
        : result.canonicalStatus !== 'not_applicable' ? 'CANONICAL_POLICY_RESPONSE'
        : result.status === 'accepted' && !result.nativeObservationId?.trim() ? 'ACCEPTED_WITHOUT_NATIVE_OBSERVATION_ID' : null
      if (failure) this.trace(failure, 'FAILED', result,
        { code: result.errorCode ?? event.errorCode ?? null, message: result.reason ?? failure })
    }
    const exact = structuredClone(event)
    if (!group.events.some((item) => JSON.stringify(item) === JSON.stringify(exact))) group.events.push(exact)
    const diagnostics = this.deps.deliveryDiagnostics()
    const fingerprint = diagnostics.activeBatches.find((batch) => batch.batchId === event.batchId)
      ?? diagnostics.recentResponseShapes.find((batch) => batch.batchId === event.batchId)
    if (!group.eventFingerprints.some((item) => item.batchId === event.batchId && item.attemptedAt === event.attemptedAt)) {
      group.eventFingerprints.push({
        batchId: event.batchId, attemptedAt: event.attemptedAt,
        responseContractVersion: fingerprint?.responseContractVersion ?? null,
        deploymentRevision: fingerprint?.deploymentRevision ?? null,
      })
    }
    for (const child of group.children) {
      const results = event.results?.filter((item) => item.observationId === child.observationId) ?? []
      const result = results.length === 1 ? results[0] : null
      if (!result || !event.observationIds.includes(child.observationId)
        || event.rejectedIds.includes(child.observationId) || event.canonicalFailedIds?.includes(child.observationId)
        || !event.httpStatus || event.httpStatus < 200 || event.httpStatus >= 300
        || result.canonicalStatus !== 'not_applicable' || !['accepted', 'duplicate'].includes(result.status)) continue
      const earlierAccepted = child.receipts.find((receipt) => receipt.result.status === 'accepted')
      const nativeId = result.nativeObservationId?.trim() ? result.nativeObservationId
        : result.status === 'duplicate' ? earlierAccepted?.nativeObservationId : null
      if (!nativeId) continue
      if (!child.receipts.some((receipt) => JSON.stringify(receipt.event) === JSON.stringify(exact))) {
        child.receipts.push({
          event: exact, result: structuredClone(result), nativeObservationId: nativeId,
          payloadFingerprint: child.payloadFingerprint, sourceFingerprint: group.sourceFingerprint,
          responseContractVersion: fingerprint?.responseContractVersion ?? null,
          deploymentRevision: fingerprint?.deploymentRevision ?? null,
          acknowledged: event.acknowledgedIds.includes(child.observationId),
        })
      }
      if (event.acknowledgedIds.includes(child.observationId)) {
        child.queueState = null
        child.queueDisposition = 'ACKNOWLEDGED_PURGED'
      }
    }
    this.save(group)
  }

  flushSaved(onStage?: CertificationFlushOptions['onStage']): Promise<PpiCertificationInspection> {
    if (this.flushInProgress) return this.flushInProgress
    this.flushInProgress = this.flushOnce(onStage).finally(() => { this.flushInProgress = null })
    return this.flushInProgress
  }

  private async flushOnce(onStage?: CertificationFlushOptions['onStage']): Promise<PpiCertificationInspection> {
    if (this.captureInProgress) await this.captureInProgress
    const inspected = await this.inspectSaved()
    if (!inspected.group || inspected.status === 'PPI_CERTIFICATION_EVIDENCE_INVALID') return inspected
    const group = inspected.group
    const report = await this.traced('TARGETED_FLUSH', () => this.deps.flush(group.children.map((child) => child.observationId), {
      prepare: async () => {
        for (const child of group.children) {
          this.queueEvidence(group, child, await this.deps.queue.getRecord(child.observationId))
          this.assertScope(group.context)
        }
        this.save(group)
        if (group.children.some((child) => !child.receipts.some((receipt) => receipt.acknowledged)
          && child.queueDisposition === 'MISSING')) await this.enqueue(group)
      },
      onStage: (stage) => { this.trace('TARGETED_FLUSH_STAGE', 'INFO', { stage }); onStage?.(stage) },
      persistEvidence: (event) => this.record(group, event),
    }), { observationIds: group.children.map((child) => child.observationId) })
    this.trace('TARGETED_FLUSH_RESULT', report.reason ? 'FAILED' : 'INFO', report)
    this.assertScope(group.context)
    group.lastFlushReason = report.reason
    this.save(group)
    for (const event of report.events) this.record(group, event)
    for (const child of group.children) {
      this.queueEvidence(group, child, await this.deps.queue.getRecord(child.observationId))
      this.assertScope(group.context)
    }
    this.save(group)
    return this.inspectSaved()
  }

  async inspectSaved(): Promise<PpiCertificationInspection> {
    let group: PpiCertificationGroup | null = null
    try {
      group = await exportStage('SNAPSHOT_READ', () => this.snapshot())
    } catch (error) {
      const diagnostic = error instanceof CertificationExportError ? error : new CertificationExportError('EVIDENCE_VALIDATION', error)
      this.trace('SAVED_SNAPSHOT_LOOKUP', 'FAILED', null, error)
      return { status: 'PPI_CERTIFICATION_EVIDENCE_INVALID', delivered: 0, reason: diagnostic.message, diagnostic, group }
    }
    if (!group) return { status: NO_COMPLETE_PPI_CERTIFICATION_GROUP, delivered: 0, reason: 'No saved PPI group for this owner/device.', group: null }
    return this.inspectGroup(group, 'JOURNAL')
  }

  /**
   * Read-only verification of a saved group. JOURNAL re-reads the connected journal; SAVED_ANCESTRY verifies the
   * group's own persisted SDK_RECORD/callback/BLE ancestry when its journal scope is no longer the connected one.
   */
  async inspectGroup(group: PpiCertificationGroup, sourceCheck: 'JOURNAL' | 'SAVED_ANCESTRY'): Promise<PpiCertificationInspection> {
    try {
      const savedGroup = group
      const savedRead = async (context: Type42ConnectedContext, id: string, kind: string) => {
        const entries = savedGroup.sourceAncestry.filter((entry) => entry.envelopeId === id)
        if (entries.length !== 1) throw new SourceValidationError(`Saved PPI ancestry is missing envelope ${kind}.`)
        return this.checkEnvelope(context, id, kind, entries[0])
      }
      const source = await exportStage('JOURNAL_READ', () => sourceCheck === 'JOURNAL'
        ? this.source(savedGroup.context, savedGroup.sourceEnvelopeId)
        : this.source(savedGroup.context, savedGroup.sourceEnvelopeId, savedRead))
      if (source.record.entry.envelopeJson !== group.sourceEnvelopeJson
        || await sha256Hex(group.sourceEnvelopeJson) !== group.sourceFingerprint
        || JSON.stringify(source.ancestry) !== JSON.stringify(group.sourceAncestry)
        || JSON.stringify(source.slots) !== JSON.stringify(group.originalSlots)
        || source.slots.length !== group.sourceArrayLength) throw new Error('Saved PPI source envelope, ancestry, or complete slot array changed.')
      const native = group.nativeObservation
      const mapped = await mapPhysiologyObservation(group.ownerUserId, native, {
        deviceId: group.context.scope.deviceScopeId, firmwareVersion: group.context.firmwareVersion, sdkVersion: group.context.sdkVersion,
      })
      if (native.provenance.sourceEnvelopeId !== group.sourceEnvelopeId || native.vendorDataType !== '127'
        || native.metricType !== 'PPI' || !Array.isArray(native.values) || native.values.length !== group.sourceArrayLength
        || native.values.some((value, index) => value !== source.slots[index].value)
        || mapped.length !== group.sourceArrayLength || mapped.some((item) => item.status !== 'MAPPED')) {
        throw new Error('Saved PPI normalized group no longer matches the complete original source array.')
      }
      const expectedSelection = selectPpiCertificationSlots(group.originalSlots)
      if (expectedSelection.length !== group.children.length) throw new Error('Saved PPI child sample is incomplete.')
      let delivered = 0
      for (let index = 0; index < group.children.length; index++) {
        const child = group.children[index]
        const selected = expectedSelection[index]
        const mappedSlot = mapped[selected.slot.index]
        if (mappedSlot.status !== 'MAPPED') throw new Error('Saved PPI selected slot is no longer mappable.')
        const payload = mappedSlot.observation
        if (child.canonicalTarget !== null || child.sourceEnvelopeId !== group.sourceEnvelopeId
          || child.slotIndex !== selected.slot.index || child.value !== selected.slot.value
          || JSON.stringify(child.categories) !== JSON.stringify(selected.categories)
          || child.observationId !== payload.observationId || child.payloadJson !== JSON.stringify(child.payload)
          || await sha256Hex(child.payloadJson) !== child.payloadFingerprint
          || JSON.stringify(payload) !== child.payloadJson
          || payload.sourceRecordGroupId !== group.sourceRecordGroupId
              || payload.sequenceNumber !== selected.slot.index || payload.observedAt !== native.observedAt
          || payload.startTime !== native.observedAt || payload.unit !== 'UNKNOWN_VENDOR_UNIT'
          || payload.rawSourceMetadata?.canonicalPolicy !== 'NATIVE_ONLY') {
          throw new Error('Saved PPI child contract, payload, timestamp, or deterministic sample changed.')
        }
        let proven = false
        let acceptedNativeId: string | null = null
        for (const receipt of child.receipts) {
          const result = receipt.result
          const event = receipt.event
          if (!group.events.some((item) => JSON.stringify(item) === JSON.stringify(event))
            || receipt.payloadFingerprint !== child.payloadFingerprint || receipt.sourceFingerprint !== group.sourceFingerprint
            || !event.observationIds.includes(child.observationId)
            || receipt.acknowledged !== event.acknowledgedIds.includes(child.observationId)
            || event.rejectedIds.includes(child.observationId) || event.canonicalFailedIds?.includes(child.observationId)
            || !event.httpStatus || event.httpStatus < 200 || event.httpStatus >= 300
            || result.observationId !== child.observationId || result.canonicalStatus !== 'not_applicable'
            || event.results?.filter((item) => item.observationId === child.observationId).length !== 1
            || !event.results?.some((item) => JSON.stringify(item) === JSON.stringify(result))
            || !receipt.nativeObservationId.trim()) throw new Error('Invalid durable PPI native-only acknowledgement.')
          if (result.status === 'accepted' && result.nativeObservationId === receipt.nativeObservationId) {
            acceptedNativeId = receipt.nativeObservationId
            proven ||= receipt.acknowledged
          } else if (result.status === 'duplicate'
            && (result.nativeObservationId === receipt.nativeObservationId || acceptedNativeId === receipt.nativeObservationId)) {
            proven ||= receipt.acknowledged
          } else throw new Error('PPI duplicate/accepted result has no durable linked NativeObservation ID.')
        }
        const latest = [...group.events].reverse().find((event) => event.observationIds.includes(child.observationId)
          && (Array.isArray(event.results) || event.rejectedIds.includes(child.observationId)
            || event.canonicalFailedIds?.includes(child.observationId)))
        const latestResults = latest?.results?.filter((result) => result.observationId === child.observationId) ?? []
        const latestResult = latestResults.length === 1 ? latestResults[0] : null
        const contradicted = !!latest && (latest.rejectedIds.includes(child.observationId)
          || latest.canonicalFailedIds?.includes(child.observationId) || latest.outcome === 'CANONICAL_FAILED'
          || !latestResult || latestResult.canonicalStatus !== 'not_applicable'
          || !['accepted', 'duplicate'].includes(latestResult.status)
          || (latestResult.status === 'accepted' && !latestResult.nativeObservationId?.trim())
          || (latestResult.status === 'duplicate' && !latestResult.nativeObservationId?.trim() && !acceptedNativeId))
        if (proven && !contradicted && child.queueState !== 'CANONICAL_RECOVERY_REQUIRED'
          && child.queueState !== 'FAILED_PERMANENT') delivered++
      }
      return {
        status: delivered === group.children.length ? PPI_CERTIFICATION_SUCCESS : 'PPI_CERTIFICATION_INCOMPLETE',
        delivered, reason: delivered === group.children.length ? SUCCESS_MESSAGE(delivered)
          : group.lastFlushReason ?? `One complete PPI source record preserved; ${delivered}/${group.children.length} selected native-only acknowledgements proven.`,
        group,
      }
    } catch (error) {
      const diagnostic = error instanceof CertificationExportError ? error : new CertificationExportError('EVIDENCE_VALIDATION', error)
      this.trace('SAVED_GROUP_VALIDATION', 'FAILED', { sourceEnvelopeId: group.sourceEnvelopeId }, error)
      return { status: 'PPI_CERTIFICATION_EVIDENCE_INVALID', delivered: 0, reason: diagnostic.message, diagnostic, group }
    }
  }

  async exportSaved(): Promise<string> {
    return serializeCertificationJson(this.exportBody(await this.inspectSaved()))
  }

  /** Builds the certification export body from an already-performed read-only inspection. */
  exportBody(inspection: PpiCertificationInspection): Record<string, unknown> {
    if (!inspection.group || inspection.status === 'PPI_CERTIFICATION_EVIDENCE_INVALID') {
      throw inspection.diagnostic ?? new CertificationExportError('SNAPSHOT_READ', new Error(inspection.reason ?? 'No valid saved PPI evidence.'))
    }
    const group = inspection.group
    const sourceRecord = object(JSON.parse(group.sourceEnvelopeJson))
    return {
      inspection: { status: inspection.status, delivered: inspection.delivered, reason: inspection.reason },
      certificationGroupId: group.certificationGroupId,
      sourceRecord: {
        vendorDataType: '127', sourceEnvelopeId: group.sourceEnvelopeId,
        sourceRecordGroupId: group.sourceRecordGroupId, observedAt: sourceRecord.observedAt,
        receivedAt: sourceRecord.receivedAt, deviceModel: sourceRecord.deviceModel,
        device: sourceRecord.deviceScopeId,
        firmwareVersion: sourceRecord.firmwareVersion, sdkVersion: sourceRecord.sdkVersion,
        parserVersion: sourceRecord.parserVersion, normalizerVersion: sourceRecord.normalizerVersion,
        fullAncestry: group.sourceAncestry, originalArray: group.originalSlots,
        sourceArrayLength: group.sourceArrayLength,
        sourceEnvelopeJson: group.sourceEnvelopeJson, sourceFingerprint: group.sourceFingerprint,
      },
      slotEvidence: group.originalSlots,
      selectedDeliveryChildren: group.children.map((child) => {
        const latest = [...group.events].reverse().find((event) => event.observationIds.includes(child.observationId))
        const result = latest?.results?.filter((item) => item.observationId === child.observationId) ?? []
        const exact = result.length === 1 ? result[0] : null
        const fingerprint = group.eventFingerprints.find((item) => item.batchId === latest?.batchId)
        const linkedDuplicate = exact?.status === 'duplicate'
          ? [...child.receipts].reverse().find((receipt) => receipt.event.batchId === latest?.batchId)?.nativeObservationId : null
        return {
          observationId: child.observationId, slotIndex: child.slotIndex, value: child.value,
          unit: child.payload.unit, sourceEnvelopeId: child.sourceEnvelopeId,
          sourceRecordId: child.payload.sourceRecordId, sourceRecordGroupId: child.payload.sourceRecordGroupId,
          timestamp: child.payload.observedAt, deliveryPolicy: 'NATIVE_ONLY', canonicalTarget: null,
          status: exact?.status ?? null, canonicalStatus: exact?.canonicalStatus ?? null,
          nativeObservationId: exact?.nativeObservationId ?? linkedDuplicate ?? null,
          payloadFingerprint: child.payloadFingerprint, responseContractVersion: fingerprint?.responseContractVersion ?? null,
          deploymentRevision: fingerprint?.deploymentRevision ?? null, receipts: child.receipts,
          queueState: child.queueState, queueDisposition: child.queueDisposition,
        }
      }),
      deliveryTotals: {
        selected: group.children.length,
        accepted: group.events.flatMap((event) => event.results ?? []).filter((result) => result.status === 'accepted').length,
        duplicates: group.events.flatMap((event) => event.results ?? []).filter((result) => result.status === 'duplicate').length,
        rejected: group.events.flatMap((event) => event.results ?? []).filter((result) => result.status === 'rejected').length,
        canonicalRows: group.events.flatMap((event) => event.results ?? []).filter((result) => result.canonicalStatus === 'canonicalized').length,
        canonicalFailures: group.events.flatMap((event) => event.results ?? []).filter((result) => result.canonicalStatus === 'failed').length,
      },
      assertions: {
        originalOrderingPreserved: true, zeroValuesPreserved: true,
        duplicateValuesPreserved: true, noSlotCompaction: true, noPerSlotTimingInferred: true,
        unit: 'UNKNOWN_VENDOR_UNIT', nativeOnly: true, noCanonicalPromotion: true,
      },
    }
  }
}
