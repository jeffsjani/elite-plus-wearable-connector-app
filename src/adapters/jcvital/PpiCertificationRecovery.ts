import type { NativeObservation } from '../../models/wearableObservation'
import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import { normalizeBluetoothAddress } from '../../services/storage/JCVitalDeviceIdentityService'
import { serializeCertificationJson } from './CertificationJsonExport'
import { sha256Hex } from './HeartRateSeries'
import type { JCVitalV8Plugin } from './jcvitalV8Bridge'
import { mapPhysiologyObservation } from './PhysiologyContract'
import {
  PPI_CERTIFICATION_SUCCESS, PpiCertification, selectPpiCertificationSlots,
  type PpiCertificationGroup, type PpiCertificationInspection, type PpiOriginalSlot,
} from './PpiCertification'
import type { Type42ConnectedContext } from './Type42Certification'

export const PPI_CERTIFICATION_KEY_PREFIX = 'elitePlus.ppiCertification.'
/** Identical template in the shipped VC9 and VC10 bundles. */
export const PPI_CERTIFICATION_KEY_TEMPLATE = 'elitePlus.ppiCertification.v1.<encodeURIComponent(ownerUserId)>.<encodeURIComponent(deviceScopeId)>'
export const PPI_RECOVERED_CERTIFICATION_FILENAME = 'JCVital PPI recovered certification.json'
const IDENTITY_MAP_KEY = 'jcvitalDeviceIdentityMap.v1'
const JOURNAL_PAGE_LIMIT = 100

export type PpiRecoveryClassification = 'PPI_SNAPSHOT_FOUND_EXACT' | 'PPI_SNAPSHOT_FOUND_LEGACY_KEY'
  | 'PPI_RECONSTRUCTABLE_FROM_JOURNAL' | 'PPI_JOURNAL_FOUND_DELIVERY_EVIDENCE_MISSING' | 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE'
export type PpiRecoverySource = 'EXACT_SAVED_SNAPSHOT' | 'LEGACY_SNAPSHOT_KEY'
  | 'L0_JOURNAL_PLUS_DURABLE_RECEIPTS' | 'L0_JOURNAL_PLUS_BASE44_READ_ONLY_TRACE' | 'L0_JOURNAL_SOURCE_ONLY'

export type PpiSavedKeyCompatibility = 'EXACT_KEY' | 'LEGACY_KEY_COMPATIBLE' | 'OWNER_MISMATCH' | 'DEVICE_MISMATCH'
  | 'NO_CONNECTED_DEVICE' | 'INVALID'

export interface PpiSavedKeyEntry {
  storageKey: string
  keyVersion: string | null
  keyOwnerId: string | null
  keyDeviceScopeId: string | null
  savedOwnerId: string | null
  savedDeviceScopeId: string | null
  certificationGroupId: string | null
  sourceEnvelopeId: string | null
  capturedAt: string | null
  sourceRecordGroupId: string | null
  slotCount: number | null
  selectedChildCount: number | null
  deliveryReceiptCount: number | null
  savedBleAddressMatchesConnected: boolean | null
  compatibility: PpiSavedKeyCompatibility
  invalidReason: string | null
}

export interface PpiSavedKeyReport {
  keyTemplate: string
  currentOwnerId: string | null
  currentDeviceScopeId: string | null
  exactStorageKey: string | null
  exactKeyPresent: boolean
  ppiCertificationKeyCount: number
  entries: PpiSavedKeyEntry[]
  identityMap: {
    entryCount: number
    connectedAddressMapped: boolean
    connectedMappedDeviceScopeId: string | null
    connectedMappingMatchesCurrentScope: boolean | null
    otherDeviceScopeIds: string[]
  }
  connectedContextError: string | null
}

export interface PpiJournalCandidate {
  sourceEnvelopeId: string
  sequence: number
  journalSourceRecordGroupId: string | null
  sourceRecordGroupId: string | null
  observedAt: string | null
  receivedAt: string | null
  vendorDataType: string | null
  slotCount: number | null
  slots: PpiOriginalSlot[] | null
  ancestry: Array<{ envelopeId: string; kind: string | null; sequence: number }>
  rawNotification: { envelopeId: string; sha256: string; byteLength: number } | null
  plausible: boolean
  rejectionReason: string | null
  reconstructedChildIds: string[]
  queueEvidenceCount: number
}

export interface PpiJournalScanReport {
  scope: { accountId: string; deviceScopeId: string } | null
  currentScopeEnvelopeCount: number
  globalEnvelopeCount: number | null
  envelopesOutsideCurrentScope: number | null
  sdkRecordCount: number
  type127RecordCount: number
  candidates: PpiJournalCandidate[]
  selectionCriteria: string[]
  selectedSourceEnvelopeId: string | null
  selectionMode: 'SINGLE_PLAUSIBLE_CANDIDATE' | 'OPERATOR_SPECIFIED' | 'NONE'
  error: string | null
}

export interface PpiBase44ReadOnlyTraceRow {
  observationId: string
  nativeObservationId: string | null
  sourceRecordId?: string | null
  sourceRecordGroupId?: string | null
}

export interface PpiRecoveredChild {
  observationId: string
  slotIndex: number
  value: number
  categories: string[]
  sourceEnvelopeId: string
  sourceRecordId: string
  sourceRecordGroupId: string
  payload: NativeObservationInput
  delivery: {
    queueState: QueueRecord['state'] | null
    queueAcknowledgedAt: string | null
    queueNativeObservationId: string | null
    queuePayloadMatchesReconstruction: boolean | null
    base44Trace: PpiBase44ReadOnlyTraceRow | null
    deliveryEvidence: 'QUEUE_ACKNOWLEDGED' | 'BASE44_READ_ONLY_TRACE' | 'QUEUED_NOT_DELIVERED' | 'NONE'
    nativeObservationIdProven: boolean
  }
}

export interface PpiRecoveryResult {
  classification: PpiRecoveryClassification
  recoverySource: PpiRecoverySource | null
  certificationSuccess: boolean
  reason: string
  keyReport: PpiSavedKeyReport
  snapshotInspection: { status: PpiCertificationInspection['status']; delivered: number; reason: string | null } | null
  journalCrossCheck: 'VERIFIED_AGAINST_CONNECTED_JOURNAL' | 'VERIFIED_AGAINST_SAVED_ANCESTRY_ONLY' | 'NOT_APPLICABLE' | 'FAILED'
  adoptedStorageKey: string | null
  journal: PpiJournalScanReport | null
  reconstructed: {
    sourceEnvelopeId: string
    sourceRecordGroupId: string
    sourceFingerprint: string
    sourceEnvelopeJson: string
    sourceAncestry: unknown[]
    originalSlots: PpiOriginalSlot[]
    children: PpiRecoveredChild[]
    deliveryGate: 'PASSED_NATIVE_IDS_PROVEN' | 'ACKNOWLEDGED_WITHOUT_NATIVE_IDS' | 'MISSING'
    base44ReadOnlyLookup: 'AVAILABLE' | 'UNAVAILABLE_NO_READ_ONLY_PATH'
  } | null
  group: PpiCertificationGroup | null
  operationCounts: PpiRecoveryOperationCounts
}

export interface PpiRecoveryOperationCounts {
  ppiAcquisitionCalls: number
  enqueueCalls: number
  base44Writes: number
  storageWrites: number
}

type ReadOnlyStorage = Pick<Storage, 'getItem'> & Partial<Pick<Storage, 'key' | 'length'>>

export interface PpiCertificationRecoveryDependencies {
  queue: { getOwnerUserId(): string | null; getRecord(id: string): Promise<QueueRecord | null> }
  journal: Pick<JCVitalV8Plugin, 'readSourceEnvelope' | 'exportSourceJournal' | 'getSourceJournalDiagnostics'>
  connectedContext(): Type42ConnectedContext
  storage?: () => ReadOnlyStorage
  /** Optional read-only Base44 NativeObservation lookup; no such path exists in the connector today. */
  base44ReadOnlyTrace?: (query: { observationIds: string[]; sourceRecordIds: string[]; sourceRecordGroupId: string }) => Promise<PpiBase44ReadOnlyTraceRow[]>
}

class RecoveryReadOnlyViolation extends Error {}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseKey(storageKey: string): { version: string | null; owner: string | null; device: string | null } {
  const parts = storageKey.slice(PPI_CERTIFICATION_KEY_PREFIX.length).split('.')
  if (parts.length < 3) return { version: parts[0] ?? null, owner: null, device: null }
  const decode = (value: string) => {
    try { return decodeURIComponent(value) } catch { return value }
  }
  return { version: parts[0], owner: decode(parts.slice(1, -1).join('.')), device: decode(parts[parts.length - 1]) }
}

/**
 * Read-only recovery of already-captured physical PPI certification evidence. It cannot acquire, enqueue,
 * deliver, or write storage: those dependencies are not accepted, and the internal verifier's are guarded.
 */
export class PpiCertificationRecovery {
  private readonly deps: PpiCertificationRecoveryDependencies
  private readonly counts: PpiRecoveryOperationCounts = { ppiAcquisitionCalls: 0, enqueueCalls: 0, base44Writes: 0, storageWrites: 0 }
  private readonly verifier: PpiCertification

  constructor(deps: PpiCertificationRecoveryDependencies) {
    this.deps = deps
    const violation = (name: keyof PpiRecoveryOperationCounts) => {
      this.counts[name]++
      throw new RecoveryReadOnlyViolation(`PPI recovery is read-only (${name}).`)
    }
    this.verifier = new PpiCertification({
      queue: {
        getOwnerUserId: () => deps.queue.getOwnerUserId(),
        getRecord: (id) => deps.queue.getRecord(id),
        enqueueMany: async () => violation('enqueueCalls'),
      },
      acquire: async () => violation('ppiAcquisitionCalls'),
      journal: { readSourceEnvelope: (options) => deps.journal.readSourceEnvelope(options) },
      flush: async () => violation('base44Writes'),
      deliveryDiagnostics: () => ({ activeBatches: [], recentResponseShapes: [] }),
      connectedContext: () => deps.connectedContext(),
      storage: () => {
        const storage = this.storage()
        return {
          getItem: (key: string) => storage.getItem(key),
          setItem: () => violation('storageWrites'),
          key: (index: number) => storage.key?.(index) ?? null,
          get length() { return storage.length ?? 0 },
        }
      },
    })
  }

  operationCounts(): PpiRecoveryOperationCounts { return { ...this.counts } }

  private storage(): ReadOnlyStorage { return (this.deps.storage ?? (() => localStorage))() }

  private currentContext(): { context: Type42ConnectedContext | null; error: string | null } {
    try {
      return { context: structuredClone(this.deps.connectedContext()), error: null }
    } catch (error) {
      return { context: null, error: errorText(error) }
    }
  }

  /** Enumerates only PPI certification keys; never returns unrelated storage content. */
  findSavedCertifications(): PpiSavedKeyReport {
    const owner = this.deps.queue.getOwnerUserId()
    const { context, error } = this.currentContext()
    const device = context && context.scope.accountId === owner ? context.scope.deviceScopeId : null
    const exactStorageKey = owner && device
      ? `${PPI_CERTIFICATION_KEY_PREFIX}v1.${encodeURIComponent(owner)}.${encodeURIComponent(device)}` : null
    const storage = this.storage()
    const keys: string[] = []
    for (let index = 0; index < (storage.length ?? 0); index++) {
      const key = storage.key?.(index)
      if (key?.startsWith(PPI_CERTIFICATION_KEY_PREFIX)) keys.push(key)
    }
    keys.sort()
    const entries = keys.map((storageKey): PpiSavedKeyEntry => {
      const parsedKey = parseKey(storageKey)
      const entry: PpiSavedKeyEntry = {
        storageKey, keyVersion: parsedKey.version, keyOwnerId: parsedKey.owner, keyDeviceScopeId: parsedKey.device,
        savedOwnerId: null, savedDeviceScopeId: null, certificationGroupId: null, sourceEnvelopeId: null,
        capturedAt: null, sourceRecordGroupId: null, slotCount: null, selectedChildCount: null,
        deliveryReceiptCount: null, savedBleAddressMatchesConnected: null, compatibility: 'INVALID', invalidReason: null,
      }
      try {
        const group = JSON.parse(storage.getItem(storageKey) ?? 'null') as PpiCertificationGroup | null
        if (!group || typeof group !== 'object') throw new Error('Saved value is not a PPI certification object.')
        entry.savedOwnerId = typeof group.ownerUserId === 'string' ? group.ownerUserId : null
        entry.savedDeviceScopeId = group.context?.scope?.deviceScopeId ?? null
        entry.certificationGroupId = group.certificationGroupId ?? null
        entry.sourceEnvelopeId = group.sourceEnvelopeId ?? null
        entry.capturedAt = group.capturedAt ?? null
        entry.sourceRecordGroupId = group.sourceRecordGroupId ?? null
        entry.slotCount = Array.isArray(group.originalSlots) ? group.originalSlots.length : null
        entry.selectedChildCount = Array.isArray(group.children) ? group.children.length : null
        entry.deliveryReceiptCount = Array.isArray(group.children)
          ? group.children.reduce((total, child) => total + (Array.isArray(child.receipts) ? child.receipts.length : 0), 0) : null
        entry.savedBleAddressMatchesConnected = context && typeof group.context?.bleAddress === 'string'
          ? normalizeBluetoothAddress(group.context.bleAddress) === normalizeBluetoothAddress(context.bleAddress) : null
        PpiCertification.validateGroupShape(group, entry.savedOwnerId ?? '', entry.savedDeviceScopeId ?? '')
        if (!owner || entry.savedOwnerId !== owner || entry.keyOwnerId !== owner) entry.compatibility = 'OWNER_MISMATCH'
        else if (!context || !device) entry.compatibility = 'NO_CONNECTED_DEVICE'
        else if (storageKey === exactStorageKey && entry.savedDeviceScopeId === device) entry.compatibility = 'EXACT_KEY'
        else if (entry.savedBleAddressMatchesConnected) entry.compatibility = 'LEGACY_KEY_COMPATIBLE'
        else entry.compatibility = 'DEVICE_MISMATCH'
      } catch (cause) {
        entry.compatibility = 'INVALID'
        entry.invalidReason = errorText(cause)
      }
      return entry
    })
    let identity: Record<string, string> = {}
    try {
      const parsed = JSON.parse(storage.getItem(IDENTITY_MAP_KEY) ?? '{}') as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) identity = parsed as Record<string, string>
    } catch {
      identity = {}
    }
    const mapped = context ? identity[normalizeBluetoothAddress(context.bleAddress)] ?? null : null
    return {
      keyTemplate: PPI_CERTIFICATION_KEY_TEMPLATE, currentOwnerId: owner, currentDeviceScopeId: device,
      exactStorageKey, exactKeyPresent: !!exactStorageKey && keys.includes(exactStorageKey),
      ppiCertificationKeyCount: keys.length, entries,
      identityMap: {
        entryCount: Object.keys(identity).length, connectedAddressMapped: mapped !== null,
        connectedMappedDeviceScopeId: mapped,
        connectedMappingMatchesCurrentScope: context ? mapped === context.scope.deviceScopeId : null,
        otherDeviceScopeIds: Object.values(identity).filter((value) => value !== mapped).sort(),
      },
      connectedContextError: error,
    }
  }

  private result(keyReport: PpiSavedKeyReport, partial: Partial<PpiRecoveryResult> & Pick<PpiRecoveryResult, 'classification' | 'reason'>): PpiRecoveryResult {
    return {
      recoverySource: null, certificationSuccess: false, snapshotInspection: null, journalCrossCheck: 'NOT_APPLICABLE',
      adoptedStorageKey: null, journal: null, reconstructed: null, group: null, keyReport, ...partial,
      operationCounts: this.operationCounts(),
    }
  }

  private async fromSnapshot(keyReport: PpiSavedKeyReport, entry: PpiSavedKeyEntry, exact: boolean): Promise<PpiRecoveryResult> {
    const group = JSON.parse(this.storage().getItem(entry.storageKey)!) as PpiCertificationGroup
    const connected = keyReport.currentDeviceScopeId === group.context.scope.deviceScopeId
    const inspection = await this.verifier.inspectGroup(group, connected ? 'JOURNAL' : 'SAVED_ANCESTRY')
    const valid = inspection.status !== 'PPI_CERTIFICATION_EVIDENCE_INVALID'
    return this.result(keyReport, {
      classification: exact ? 'PPI_SNAPSHOT_FOUND_EXACT' : 'PPI_SNAPSHOT_FOUND_LEGACY_KEY',
      recoverySource: exact ? 'EXACT_SAVED_SNAPSHOT' : 'LEGACY_SNAPSHOT_KEY',
      certificationSuccess: inspection.status === PPI_CERTIFICATION_SUCCESS,
      reason: inspection.reason ?? inspection.status,
      snapshotInspection: { status: inspection.status, delivered: inspection.delivered, reason: inspection.reason },
      journalCrossCheck: !valid ? 'FAILED' : connected ? 'VERIFIED_AGAINST_CONNECTED_JOURNAL' : 'VERIFIED_AGAINST_SAVED_ANCESTRY_ONLY',
      adoptedStorageKey: entry.storageKey, group,
    })
  }

  /** Read-only recovery. `sourceEnvelopeId` is an explicit operator choice among reported journal candidates. */
  async recover(options: { sourceEnvelopeId?: string } = {}): Promise<PpiRecoveryResult> {
    const keyReport = this.findSavedCertifications()
    const exact = keyReport.entries.find((entry) => entry.compatibility === 'EXACT_KEY')
    if (exact) return this.fromSnapshot(keyReport, exact, true)
    const legacy = keyReport.entries.filter((entry) => entry.compatibility === 'LEGACY_KEY_COMPATIBLE')
    if (legacy.length === 1) return this.fromSnapshot(keyReport, legacy[0], false)
    if (legacy.length > 1) {
      return this.result(keyReport, {
        classification: 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE',
        reason: `${legacy.length} compatible legacy PPI snapshots exist; refusing to choose one (fail closed).`,
      })
    }
    const { context } = this.currentContext()
    if (!context || !keyReport.currentDeviceScopeId) {
      return this.result(keyReport, {
        classification: 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE',
        reason: 'No saved PPI snapshot, and journal reconstruction requires the authenticated owner with the physical V8 connected.',
      })
    }
    const journal = await this.scanJournal(context, options.sourceEnvelopeId)
    if (journal.error) {
      return this.result(keyReport, { classification: 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE', reason: `Journal scan failed: ${journal.error}`, journal })
    }
    if (!journal.selectedSourceEnvelopeId) {
      const plausible = journal.candidates.filter((candidate) => candidate.plausible).length
      return this.result(keyReport, {
        classification: 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE', journal,
        reason: options.sourceEnvelopeId
          ? `Requested sourceEnvelopeId is not a plausible type-127 journal candidate (${plausible} plausible).`
          : plausible > 1 ? `${plausible} plausible type-127 journal candidates; none selected automatically. Specify one sourceEnvelopeId.`
            : journal.type127RecordCount ? 'No type-127 journal record passes complete source validation.'
              : 'No PPI snapshot and no type-127 record in the connected owner/device journal.',
      })
    }
    const reconstructed = await this.reconstruct(context, journal.selectedSourceEnvelopeId)
    const proven = reconstructed.children.every((child) => child.delivery.nativeObservationIdProven)
    const evidenced = reconstructed.children.every((child) => child.delivery.deliveryEvidence === 'QUEUE_ACKNOWLEDGED'
      || child.delivery.deliveryEvidence === 'BASE44_READ_ONLY_TRACE')
    reconstructed.deliveryGate = proven ? 'PASSED_NATIVE_IDS_PROVEN' : evidenced ? 'ACKNOWLEDGED_WITHOUT_NATIVE_IDS' : 'MISSING'
    const missing = reconstructed.children.filter((child) => child.delivery.deliveryEvidence === 'NONE'
      || child.delivery.deliveryEvidence === 'QUEUED_NOT_DELIVERED').length
    const viaBase44 = reconstructed.children.some((child) => child.delivery.deliveryEvidence === 'BASE44_READ_ONLY_TRACE')
    return this.result(keyReport, {
      classification: evidenced ? 'PPI_RECONSTRUCTABLE_FROM_JOURNAL' : 'PPI_JOURNAL_FOUND_DELIVERY_EVIDENCE_MISSING',
      recoverySource: !evidenced ? 'L0_JOURNAL_SOURCE_ONLY' : viaBase44 ? 'L0_JOURNAL_PLUS_BASE44_READ_ONLY_TRACE' : 'L0_JOURNAL_PLUS_DURABLE_RECEIPTS',
      certificationSuccess: proven,
      reason: proven ? `Source reconstructed from L0 journal; ${reconstructed.children.length}/${reconstructed.children.length} native IDs proven by read-only trace.`
        : evidenced ? 'Source reconstructed from L0 journal; delivery acknowledged durably but NativeObservation IDs are not provable. Not certified.'
          : `Source reconstructed from L0 journal; delivery evidence missing for ${missing}/${reconstructed.children.length} selected children. Not certified.`,
      journalCrossCheck: 'VERIFIED_AGAINST_CONNECTED_JOURNAL', journal, reconstructed,
    })
  }

  private async scanJournal(context: Type42ConnectedContext, requested?: string): Promise<PpiJournalScanReport> {
    const scope = { accountId: context.scope.accountId, deviceScopeId: context.scope.deviceScopeId }
    const report: PpiJournalScanReport = {
      scope, currentScopeEnvelopeCount: 0, globalEnvelopeCount: null, envelopesOutsideCurrentScope: null,
      sdkRecordCount: 0, type127RecordCount: 0, candidates: [],
      selectionCriteria: [
        'kind = SDK_RECORD and vendorDataType = "127" in the signed-in owner + connected deviceScopeId journal',
        'acquisitionMode = HISTORICAL_SYNC with complete SDK_CALLBACK and BLE_NOTIFICATION ancestry',
        'callback record snapshot, slot annotations, and original BLE byte SHA-256/length all verify',
        'every original slot parses as VALID_INT32 (VC9 capture requirement)',
        'select only when exactly one candidate is plausible, or when the operator names one sourceEnvelopeId',
      ],
      selectedSourceEnvelopeId: null, selectionMode: 'NONE', error: null,
    }
    try {
      try {
        report.globalEnvelopeCount = (await this.deps.journal.getSourceJournalDiagnostics(scope)).totalEnvelopeCount
      } catch {
        report.globalEnvelopeCount = null
      }
      const records: Array<{ id: string; sequence: number; json: Record<string, unknown> }> = []
      let after = 0
      for (;;) {
        const page = await this.deps.journal.exportSourceJournal({ ...scope, afterSequence: after, limit: JOURNAL_PAGE_LIMIT })
        report.currentScopeEnvelopeCount += page.envelopes.length
        for (const envelope of page.envelopes) {
          if (envelope.kind !== 'SDK_RECORD') continue
          report.sdkRecordCount++
          const json = JSON.parse(envelope.envelopeJson ?? 'null') as Record<string, unknown> | null
          if (json?.vendorDataType === '127') records.push({ id: envelope.envelopeId, sequence: envelope.sequence, json })
        }
        if (!page.hasMore) break
        if (page.nextSequence <= after) throw new Error('Journal export cursor did not advance.')
        after = page.nextSequence
      }
      report.type127RecordCount = records.length
      if (report.globalEnvelopeCount !== null) report.envelopesOutsideCurrentScope = report.globalEnvelopeCount - report.currentScopeEnvelopeCount
      for (const record of records) report.candidates.push(await this.candidate(context, record))
    } catch (error) {
      report.error = errorText(error)
      return report
    }
    const plausible = report.candidates.filter((candidate) => candidate.plausible)
    if (requested) {
      if (plausible.some((candidate) => candidate.sourceEnvelopeId === requested)) {
        report.selectedSourceEnvelopeId = requested
        report.selectionMode = 'OPERATOR_SPECIFIED'
      }
    } else if (plausible.length === 1) {
      report.selectedSourceEnvelopeId = plausible[0].sourceEnvelopeId
      report.selectionMode = 'SINGLE_PLAUSIBLE_CANDIDATE'
    }
    return report
  }

  private async candidate(context: Type42ConnectedContext, record: { id: string; sequence: number; json: Record<string, unknown> }): Promise<PpiJournalCandidate> {
    const r = record.json
    const candidate: PpiJournalCandidate = {
      sourceEnvelopeId: record.id, sequence: record.sequence,
      journalSourceRecordGroupId: typeof r.sourceRecordGroupId === 'string' ? r.sourceRecordGroupId : null,
      sourceRecordGroupId: null,
      observedAt: typeof r.observedAt === 'string' ? r.observedAt : null,
      receivedAt: typeof r.receivedAt === 'string' ? r.receivedAt : null,
      vendorDataType: typeof r.vendorDataType === 'string' ? r.vendorDataType : null,
      slotCount: null, slots: null, ancestry: [], rawNotification: null,
      plausible: false, rejectionReason: null, reconstructedChildIds: [], queueEvidenceCount: 0,
    }
    try {
      const rebuilt = await this.rebuild(context, record.id)
      candidate.slots = rebuilt.source.slots
      candidate.slotCount = rebuilt.source.slots.length
      candidate.ancestry = rebuilt.source.ancestry.map((entry) => ({
        envelopeId: entry.envelopeId, sequence: entry.sequence,
        kind: (JSON.parse(entry.envelopeJson) as { kind?: string }).kind ?? null,
      }))
      candidate.rawNotification = rebuilt.rawNotification
      candidate.sourceRecordGroupId = rebuilt.sourceRecordGroupId
      candidate.reconstructedChildIds = rebuilt.children.map((child) => child.payload.observationId)
      for (const id of candidate.reconstructedChildIds) if (await this.deps.queue.getRecord(id)) candidate.queueEvidenceCount++
      candidate.plausible = true
    } catch (error) {
      candidate.rejectionReason = errorText(error)
    }
    return candidate
  }

  /** Recomputes VC9's deterministic sample and observation IDs from L0 source with the unchanged mapper. */
  private async rebuild(context: Type42ConnectedContext, id: string) {
    const source = await this.verifier.readSourceEvidence(context, id)
    const r = source.record.json
    if (source.slots.some((slot) => slot.parseStatus !== 'VALID_INT32' || slot.value === null)) {
      throw new Error('PPI source has a non-numeric slot; VC9 would not have certified it.')
    }
    const notification = source.notification.entry
    const raw = Uint8Array.from(atob(notification.rawBytesBase64 ?? ''), (character) => character.charCodeAt(0))
    const rawSha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
      .map((value) => value.toString(16).padStart(2, '0')).join('')
    const native: NativeObservation = {
      id: `recovered-${id}`,
      source: {
        connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: context.bleAddress,
        macAddress: context.bleAddress, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion,
      },
      metricType: 'PPI', observedAt: r.observedAt as string, observedAtSource: r.sourceDate as string,
      receivedAt: r.receivedAt as string, timezone: typeof r.timezone === 'string' ? r.timezone : null,
      value: null, values: source.slots.map((slot) => slot.value!), unit: 'UNKNOWN_VENDOR_UNIT',
      acquisitionMode: 'HISTORICAL_SYNC', measurementContext: 'PPI_HISTORY',
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : null, packetId: source.serialNumber,
      sequenceNumber: null, samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: 'COMPLETE',
      vendorDataType: '127', vendorField: 'ppiData', vendorDerived: false, rawPayload: null,
      provenance: { sourceEnvelopeId: id, sourceRecordId: id, sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
    }
    const mapped = await mapPhysiologyObservation(context.scope.accountId, native, {
      deviceId: context.scope.deviceScopeId, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion,
    })
    if (mapped.length !== source.slots.length || mapped.some((item) => item.status !== 'MAPPED')) {
      throw new Error('PPI source does not map every original slot with the unchanged mapper.')
    }
    const payloads = mapped.map((item) => item.status === 'MAPPED' ? item.observation : null!)
    const children = selectPpiCertificationSlots(source.slots).map(({ slot, categories }) => ({ slot, categories, payload: payloads[slot.index] }))
    return {
      source, children, sourceRecordGroupId: payloads[0].sourceRecordGroupId!,
      sourceFingerprint: await sha256Hex(source.record.entry.envelopeJson),
      rawNotification: { envelopeId: notification.envelopeId, sha256: rawSha, byteLength: raw.length },
    }
  }

  private async reconstruct(context: Type42ConnectedContext, id: string): Promise<NonNullable<PpiRecoveryResult['reconstructed']>> {
    const rebuilt = await this.rebuild(context, id)
    let trace: PpiBase44ReadOnlyTraceRow[] = []
    if (this.deps.base44ReadOnlyTrace) {
      trace = await this.deps.base44ReadOnlyTrace({
        observationIds: rebuilt.children.map((child) => child.payload.observationId),
        sourceRecordIds: rebuilt.children.map((child) => child.payload.sourceRecordId!),
        sourceRecordGroupId: rebuilt.sourceRecordGroupId,
      })
    }
    const children: PpiRecoveredChild[] = []
    for (const { slot, categories, payload } of rebuilt.children) {
      const row = await this.deps.queue.getRecord(payload.observationId)
      const owned = row && row.ownerUserId === context.scope.accountId && row.observationId === payload.observationId ? row : null
      const traced = trace.filter((item) => item.observationId === payload.observationId)
      const base44Trace = traced.length === 1 ? traced[0] : null
      const traceNativeId = base44Trace?.nativeObservationId?.trim() ? base44Trace.nativeObservationId : null
      children.push({
        observationId: payload.observationId, slotIndex: slot.index, value: slot.value!, categories,
        sourceEnvelopeId: id, sourceRecordId: payload.sourceRecordId!, sourceRecordGroupId: payload.sourceRecordGroupId!, payload,
        delivery: {
          queueState: owned?.state ?? null, queueAcknowledgedAt: owned?.acknowledgedAt ?? null,
          queueNativeObservationId: owned?.nativeObservationId ?? null,
          queuePayloadMatchesReconstruction: owned ? JSON.stringify(owned.payload) === JSON.stringify(payload) : null,
          base44Trace,
          deliveryEvidence: traceNativeId ? 'BASE44_READ_ONLY_TRACE' : owned?.state === 'ACKNOWLEDGED' ? 'QUEUE_ACKNOWLEDGED'
            : owned ? 'QUEUED_NOT_DELIVERED' : 'NONE',
          nativeObservationIdProven: !!traceNativeId,
        },
      })
    }
    return {
      sourceEnvelopeId: id, sourceRecordGroupId: rebuilt.sourceRecordGroupId, sourceFingerprint: rebuilt.sourceFingerprint,
      sourceEnvelopeJson: rebuilt.source.record.entry.envelopeJson, sourceAncestry: rebuilt.source.ancestry,
      originalSlots: rebuilt.source.slots, children, deliveryGate: 'MISSING',
      base44ReadOnlyLookup: this.deps.base44ReadOnlyTrace ? 'AVAILABLE' : 'UNAVAILABLE_NO_READ_ONLY_PATH',
    }
  }

  /** Exports existing physical evidence only; it never creates or overwrites a certification snapshot. */
  async exportRecovered(options: { sourceEnvelopeId?: string } = {}): Promise<string> {
    const recovered = await this.recover(options)
    if (recovered.classification === 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE') {
      throw new Error(`${recovered.classification}: ${recovered.reason}`)
    }
    let certification: Record<string, unknown> | null = null
    if (recovered.group && recovered.snapshotInspection) {
      const inspection: PpiCertificationInspection = { ...recovered.snapshotInspection, group: recovered.group }
      certification = recovered.snapshotInspection.status === 'PPI_CERTIFICATION_EVIDENCE_INVALID' ? null : this.verifier.exportBody(inspection)
    }
    return serializeCertificationJson({
      recoveryVersion: 'vc11-ppi-recovery-1',
      recoverySource: recovered.recoverySource,
      classification: recovered.classification,
      certificationSuccess: recovered.certificationSuccess,
      reason: recovered.reason,
      journalCrossCheck: recovered.journalCrossCheck,
      adoptedStorageKey: recovered.adoptedStorageKey,
      originalSnapshotModified: false,
      keyReport: recovered.keyReport,
      snapshotInspection: recovered.snapshotInspection,
      certification,
      journal: recovered.journal,
      reconstructed: recovered.reconstructed,
      assertions: {
        originalOrderingPreserved: true, zeroValuesPreserved: true, duplicateValuesPreserved: true,
        noSlotCompaction: true, noPerSlotTimingInferred: true, unit: 'UNKNOWN_VENDOR_UNIT',
        nativeOnly: true, noCanonicalPromotion: true,
      },
      operationCounts: this.operationCounts(),
    })
  }
}
