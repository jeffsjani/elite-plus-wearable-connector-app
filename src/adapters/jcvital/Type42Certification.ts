import type { NativeObservation } from '../../models/wearableObservation'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { EnqueueResult, QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent, CertificationFlushOptions, CertificationFlushReport } from '../../services/sync/ObservationBatchManager'
import { sha256Hex } from './HeartRateSeries'
import type { JCVitalV8HistoricalSyncResult, JCVitalV8Plugin, SourceJournalScope } from './jcvitalV8Bridge'
import { mapPhysiologyObservation, PHYSIOLOGY_CONTRACTS } from './PhysiologyContract'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'

export const TYPE42_CERTIFICATION_SUCCESS = '1 type-42 record preserved · 4/4 native-only observations delivered'
export const NO_COMPLETE_TYPE42_CERTIFICATION_GROUP = 'NO_COMPLETE_TYPE42_CERTIFICATION_GROUP'
const FIELDS = ['date', 'hrv', 'vascularAging', 'heartRate', 'stress', 'highBP', 'lowBP'] as const
const TYPES = ['HRV_VENDOR', 'STRESS_VENDOR', 'BP_SYSTOLIC_ESTIMATED', 'BP_DIASTOLIC_ESTIMATED'] as const
type JournalEntry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type JsonObject = Record<string, unknown>
class SourceValidationError extends Error {}

export interface Type42ConnectedContext {
  scope: SourceJournalScope
  bleAddress: string
  firmwareVersion: string | null
  sdkVersion: string | null
  ready: boolean
  physical: boolean
  native: boolean
}

export interface Type42CertificationDependencies {
  queue: {
    getOwnerUserId(): string | null
    enqueueMany(payloads: NativeObservationInput[], refs?: ReadonlyMap<string, string>): Promise<EnqueueResult[]>
    getRecord(id: string): Promise<QueueRecord | null>
  }
  /** Pass the connected native adapter's syncHistoricalHrv; never a fixture provider. */
  acquire(): Promise<JCVitalV8HistoricalSyncResult>
  journal: Pick<JCVitalV8Plugin, 'readSourceEnvelope'>
  flush(ids: readonly string[], options: CertificationFlushOptions): Promise<CertificationFlushReport>
  deliveryDiagnostics(): {
    activeBatches: Array<{ batchId: string; responseContractVersion: string | null; deploymentRevision: string | null }>
    recentResponseShapes: Array<{ batchId: string; responseContractVersion: string | null; deploymentRevision: string | null }>
  }
  connectedContext(): Type42ConnectedContext
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>
}

export interface Type42Receipt {
  event: BatchDeliveryEvent
  result: ConnectorObservationResult
  nativeObservationId: string
  payloadFingerprint: string
  sourceFingerprint: string
  responseContractVersion: string | null
  deploymentRevision: string | null
  acknowledged: boolean
}

export interface Type42CertificationChild {
  observationId: string
  sourceEnvelopeId: string
  canonicalTarget: null
  payload: NativeObservationInput
  payloadJson: string
  payloadFingerprint: string
  receipts: Type42Receipt[]
  queueState: QueueRecord['state'] | null
  queueDisposition: 'NOT_ENQUEUED' | 'QUEUED' | 'MISSING' | 'ACKNOWLEDGED_PURGED' | 'ACKNOWLEDGED'
}

export interface Type42CertificationGroup {
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
  originalStrings: Record<typeof FIELDS[number], string>
  nativeChildren: NativeObservation[]
  children: Type42CertificationChild[]
  events: BatchDeliveryEvent[]
  eventFingerprints: Array<{ batchId: string; attemptedAt: string; responseContractVersion: string | null; deploymentRevision: string | null }>
  lastFlushReason: string | null
}

export interface Type42CertificationInspection {
  status: typeof TYPE42_CERTIFICATION_SUCCESS | typeof NO_COMPLETE_TYPE42_CERTIFICATION_GROUP | 'TYPE42_CERTIFICATION_INCOMPLETE' | 'TYPE42_CERTIFICATION_EVIDENCE_INVALID'
  delivered: number
  reason: string | null
  group: Type42CertificationGroup | null
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SourceValidationError('Invalid source journal object.')
  return value as JsonObject
}

function stringFields(snapshot: unknown): Record<typeof FIELDS[number], string> {
  const map = object(snapshot)
  if (map.type !== 'Map' || !Array.isArray(map.entries)) throw new SourceValidationError('Type-42 SDK record is not a typed Map.')
  const fields = new Map<string, unknown>()
  for (const entry of map.entries) {
    const { key, value } = object(entry)
    const typedKey = object(key)
    if (typedKey.type === 'String' && typeof typedKey.value === 'string') {
      if (fields.has(typedKey.value)) throw new SourceValidationError('Duplicate SDK field.')
      fields.set(typedKey.value, value)
    }
  }
  return Object.fromEntries(FIELDS.map((field) => {
    const value = object(fields.get(field))
    if (value.type !== 'String' || typeof value.value !== 'string' || !value.value.trim()) {
      throw new SourceValidationError(`Missing original SDK String ${field}.`)
    }
    return [field, value.value]
  })) as Record<typeof FIELDS[number], string>
}

/** One physical SDK record, four existing native-only scalar contracts, and durable delivery proof. */
export class Type42Certification {
  private readonly deps: Type42CertificationDependencies
  private captureInProgress: Promise<Type42CertificationInspection> | null = null
  private flushInProgress: Promise<Type42CertificationInspection> | null = null
  constructor(deps: Type42CertificationDependencies) { this.deps = deps }

  private owner(): string {
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) throw new Error('Type-42 certification requires an authenticated queue owner.')
    return owner
  }

  private key(owner: string, device: string): string {
    return `elitePlus.type42Certification.v1.${encodeURIComponent(owner)}.${encodeURIComponent(device)}`
  }

  private storage() { return (this.deps.storage ?? (() => localStorage))() }

  private assertScope(context: Type42ConnectedContext): void {
    const current = this.deps.connectedContext()
    if (this.owner() !== context.scope.accountId || current.scope.accountId !== context.scope.accountId
      || current.scope.deviceScopeId !== context.scope.deviceScopeId) throw new Error('Account or device changed during type-42 certification.')
  }

  snapshot(): Type42CertificationGroup | null {
    const owner = this.owner()
    const context = this.deps.connectedContext()
    if (context.scope.accountId !== owner) return null
    const json = this.storage().getItem(this.key(owner, context.scope.deviceScopeId))
    if (!json) return null
    const group: Type42CertificationGroup = JSON.parse(json)
    if (group.version !== 1 || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(group.certificationGroupId)
      || group.ownerUserId !== owner || group.context.scope.accountId !== owner
      || group.context.scope.deviceScopeId !== context.scope.deviceScopeId
      || group.children.length !== 4 || new Set(group.children.map((child) => child.observationId)).size !== 4
      || group.children.some((child) => !/^[0-9a-f]{64}$/.test(child.observationId))) {
      throw new Error('Stored type-42 certification evidence is invalid.')
    }
    return group
  }

  private save(group: Type42CertificationGroup): void {
    this.assertScope(group.context)
    this.storage().setItem(this.key(group.ownerUserId, group.context.scope.deviceScopeId), JSON.stringify(group))
  }

  private async read(context: Type42ConnectedContext, id: string, kind: string): Promise<{ entry: JournalEntry; json: JsonObject }> {
    const entry = await this.deps.journal.readSourceEnvelope({ ...context.scope, envelopeId: id })
    this.assertScope(context)
    const json = object(JSON.parse(entry.envelopeJson))
    if (entry.envelopeId !== id || json.envelopeId !== id || json.kind !== kind
      || json.provider !== 'JCVITAL' || json.sourceConnector !== 'JCVITAL_NATIVE'
      || json.accountId !== context.scope.accountId || json.deviceScopeId !== context.scope.deviceScopeId
      || json.firmwareVersion !== context.firmwareVersion || json.sdkVersion !== context.sdkVersion) {
      throw new SourceValidationError('Durable source envelope does not match the connected native JCVITAL scope.')
    }
    return { entry, json }
  }

  private async source(context: Type42ConnectedContext, id: string) {
    const record = await this.read(context, id, 'SDK_RECORD')
    const r = record.json
    if (r.vendorDataType !== '42' || r.acquisitionMode !== 'HISTORICAL_SYNC'
      || typeof r.callbackId !== 'string' || typeof r.notificationEnvelopeId !== 'string'
      || !Number.isInteger(r.recordIndex) || Number(r.recordIndex) < 0
      || r.sourceRecordId !== id || r.sourceRecordGroupId !== r.callbackId
      || r.sourceDateParseStatus !== 'VALID' || typeof r.observedAt !== 'string') {
      throw new SourceValidationError('Missing complete type-42 SDK_RECORD provenance.')
    }
    const strings = stringFields(r.sdkSnapshot)
    if (r.sourceDate !== strings.date) throw new SourceValidationError('SDK date does not match the source record.')
    const callback = await this.read(context, r.callbackId, 'SDK_CALLBACK')
    const c = callback.json
    if (c.vendorDataType !== '42' || c.callbackId !== r.callbackId
      || c.notificationEnvelopeId !== r.notificationEnvelopeId
      || !Array.isArray(c.recordEnvelopeIds) || c.recordEnvelopeIds[Number(r.recordIndex)] !== id) {
      throw new SourceValidationError('SDK record has no durable callback link.')
    }
    // The callback snapshot must contain this exact typed record, not merely list its ID.
    const callbackMap = object(c.sdkSnapshot)
    const entries = callbackMap.entries
    if (callbackMap.type !== 'Map' || !Array.isArray(entries)) throw new SourceValidationError('Invalid SDK callback snapshot.')
    const data = entries.find((entry) => {
      const key = object(object(entry).key)
      return key.type === 'String' && key.value === 'dicData'
    })
    const typedData = object(object(data).value)
    const callbackRecord = typedData.type === 'List' && Array.isArray(typedData.values)
      ? typedData.values[Number(r.recordIndex)] : Number(r.recordIndex) === 0 ? typedData : null
    if (JSON.stringify(callbackRecord) !== JSON.stringify(r.sdkSnapshot)) throw new SourceValidationError('SDK callback record snapshot differs.')
    const notification = await this.read(context, r.notificationEnvelopeId, 'BLE_NOTIFICATION')
    const bytes = notification.entry.rawBytesBase64
    if (!bytes || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(bytes)) {
      throw new SourceValidationError('Missing durable original BLE source bytes.')
    }
    const raw = Uint8Array.from(atob(bytes), (character) => character.charCodeAt(0))
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
      .map((value) => value.toString(16).padStart(2, '0')).join('')
    if (!raw.length || notification.json.byteLength !== raw.length || notification.json.sha256 !== digest) {
      throw new SourceValidationError('Original BLE source bytes fail integrity verification.')
    }
    return { record, strings, ancestry: [record.entry, callback.entry, notification.entry] }
  }

  capture(): Promise<Type42CertificationInspection> {
    if (this.captureInProgress) return this.captureInProgress
    this.captureInProgress = this.captureOnce().finally(() => { this.captureInProgress = null })
    return this.captureInProgress
  }

  private async captureOnce(): Promise<Type42CertificationInspection> {
    if (this.snapshot()) return this.inspectSaved()
    const context = structuredClone(this.deps.connectedContext())
    this.assertScope(context)
    if (!context.ready || !context.physical || !context.native || !context.bleAddress
      || !isOpaqueJCVitalDeviceId(context.scope.deviceScopeId)) {
      throw new Error('Type-42 capture requires a ready physical native JCVITAL device.')
    }
    const sync = await this.deps.acquire()
    this.assertScope(context)
    const current = this.deps.connectedContext()
    if (!current.ready || !current.physical || !current.native || current.bleAddress !== context.bleAddress
      || current.firmwareVersion !== context.firmwareVersion || current.sdkVersion !== context.sdkVersion) {
      throw new Error('Physical connected context changed during type-42 acquisition.')
    }
    if (sync.provider !== 'JCVITAL' || sync.vendorDataType !== '42' || sync.deviceId !== context.bleAddress) {
      return { status: NO_COMPLETE_TYPE42_CERTIFICATION_GROUP, delivered: 0, reason: 'Acquisition is not the connected type-42 source.', group: null }
    }
    const candidates = new Map<string, NativeObservation[]>()
    for (const native of sync.observations) {
      const id = native.provenance.sourceEnvelopeId
      if (!id || native.vendorDataType !== '42' || native.acquisitionMode !== 'HISTORICAL_SYNC'
        || native.source.connector !== 'JCVITAL_NATIVE' || native.source.provider !== 'JCVITAL'
        || native.source.macAddress !== context.bleAddress
        || native.provenance.sourceConnector !== 'JCVITAL_NATIVE' || native.provenance.provider !== 'JCVITAL') continue
      candidates.set(id, [...(candidates.get(id) ?? []), native])
    }
    let reason = 'No single physical type-42 SDK record has all seven strings and four deliverable children.'
    for (const [id, natives] of candidates) {
      try {
        const selected = TYPES.map((type) => natives.filter((native) => native.metricType === type))
        if (selected.some((children) => children.length !== 1)) continue
        const source = await this.source(context, id)
        const nativeChildren = selected.flat()
        const payloads: NativeObservationInput[] = []
        for (const native of nativeChildren) {
          const contract = PHYSIOLOGY_CONTRACTS.find((item) => item.nativeMetricType === native.metricType && item.vendorDataType === '42')!
          if (native.vendorField !== contract.vendorField || native.observedAtSource !== source.strings.date
            || native.observedAt !== source.record.json.observedAt
            || native.value !== Number(source.strings[contract.vendorField as keyof typeof source.strings])
            || native.source.firmwareVersion !== context.firmwareVersion || native.source.sdkVersion !== context.sdkVersion) {
            throw new SourceValidationError('Type-42 child does not match the original SDK record.')
          }
          const mapped = await mapPhysiologyObservation(this.owner(), native, {
            deviceId: context.scope.deviceScopeId, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion,
          })
          if (mapped.length !== 1 || mapped[0].status !== 'MAPPED') throw new SourceValidationError('Type-42 child is not deliverable.')
          payloads.push(mapped[0].observation)
        }
        const sourceFingerprint = await sha256Hex(source.record.entry.envelopeJson)
        const group: Type42CertificationGroup = {
          version: 1, certificationGroupId: crypto.randomUUID(), ownerUserId: context.scope.accountId, context, capturedAt: new Date().toISOString(), syncId: sync.syncId,
          sourceEnvelopeId: id, sourceRecordGroupId: payloads[0].sourceRecordGroupId!,
          sourceEnvelopeJson: source.record.entry.envelopeJson, sourceFingerprint, sourceAncestry: source.ancestry,
          originalStrings: source.strings, nativeChildren: structuredClone(nativeChildren), events: [], eventFingerprints: [],
          lastFlushReason: null,
          children: await Promise.all(payloads.map(async (payload) => ({
            observationId: payload.observationId, sourceEnvelopeId: id, canonicalTarget: null,
            payload, payloadJson: JSON.stringify(payload), payloadFingerprint: await sha256Hex(JSON.stringify(payload)),
            receipts: [], queueState: null, queueDisposition: 'NOT_ENQUEUED' as const,
          }))),
        }
        // Never acquire again after this durable boundary, including a subsequent enqueue failure.
        this.save(group)
        return this.inspectSaved()
      } catch (error) {
        if (!(error instanceof SourceValidationError) || this.snapshot()) throw error
        this.assertScope(context)
        reason = error instanceof Error ? error.message : String(error)
      }
    }
    return { status: NO_COMPLETE_TYPE42_CERTIFICATION_GROUP, delivered: 0, reason, group: null }
  }

  private async enqueue(group: Type42CertificationGroup): Promise<void> {
    const results = await this.deps.queue.enqueueMany(group.children.map((child) => structuredClone(child.payload)),
      new Map(group.children.map((child) => [child.observationId, child.sourceEnvelopeId])))
    this.assertScope(group.context)
    for (const child of group.children) {
      const row = results.find((result) => result.record.observationId === child.observationId)?.record
      if (!row) throw new Error('Type-42 enqueue omitted a child.')
      this.queueEvidence(group, child, row)
    }
    this.save(group)
  }

  private queueEvidence(group: Type42CertificationGroup, child: Type42CertificationChild, row: QueueRecord | null): void {
    if (row && (row.ownerUserId !== group.ownerUserId || row.observationId !== child.observationId
      || row.sourceEnvelopeId !== child.sourceEnvelopeId || JSON.stringify(row.payload) !== child.payloadJson)) {
      throw new Error('Queued type-42 payload or local source reference differs from saved evidence.')
    }
    child.queueState = row?.state ?? null
    child.queueDisposition = row?.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED'
      : row ? 'QUEUED' : child.receipts.some((receipt) => receipt.acknowledged) ? 'ACKNOWLEDGED_PURGED' : 'MISSING'
  }

  private record(group: Type42CertificationGroup, event: BatchDeliveryEvent): void {
    this.assertScope(group.context)
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
    // The shared manager calls this synchronously before acknowledgement/purge.
    this.save(group)
  }

  flushSaved(onStage?: CertificationFlushOptions['onStage']): Promise<Type42CertificationInspection> {
    if (this.flushInProgress) return this.flushInProgress
    this.flushInProgress = this.flushOnce(onStage).finally(() => { this.flushInProgress = null })
    return this.flushInProgress
  }

  private async flushOnce(onStage?: CertificationFlushOptions['onStage']): Promise<Type42CertificationInspection> {
    if (this.captureInProgress) await this.captureInProgress
    const inspected = await this.inspectSaved()
    if (!inspected.group || inspected.status === 'TYPE42_CERTIFICATION_EVIDENCE_INVALID') return inspected
    const group = inspected.group
    const report = await this.deps.flush(group.children.map((child) => child.observationId), {
      prepare: async () => {
        for (const child of group.children) {
          this.queueEvidence(group, child, await this.deps.queue.getRecord(child.observationId))
          this.assertScope(group.context)
        }
        this.save(group)
        if (group.children.some((child) => !child.receipts.some((receipt) => receipt.acknowledged)
          && child.queueDisposition === 'MISSING')) await this.enqueue(group)
      },
      onStage, persistEvidence: (event) => this.record(group, event),
    })
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

  async inspectSaved(): Promise<Type42CertificationInspection> {
    let group: Type42CertificationGroup | null = null
    try {
      group = this.snapshot()
      if (!group) return { status: NO_COMPLETE_TYPE42_CERTIFICATION_GROUP, delivered: 0, reason: 'No saved group for this owner/device.', group: null }
      const source = await this.source(group.context, group.sourceEnvelopeId)
      if (source.record.entry.envelopeJson !== group.sourceEnvelopeJson
        || await sha256Hex(group.sourceEnvelopeJson) !== group.sourceFingerprint
        || JSON.stringify(source.ancestry) !== JSON.stringify(group.sourceAncestry)
        || JSON.stringify(source.strings) !== JSON.stringify(group.originalStrings)) throw new Error('Saved source envelope or ancestry changed.')
      if (group.nativeChildren.length !== 4) throw new Error('Saved group has incomplete original children.')
      let delivered = 0
      for (let index = 0; index < group.children.length; index++) {
        const child = group.children[index]
        const native = group.nativeChildren[index]
        const mapped = await mapPhysiologyObservation(group.ownerUserId, native, {
          deviceId: group.context.scope.deviceScopeId, firmwareVersion: group.context.firmwareVersion, sdkVersion: group.context.sdkVersion,
        })
        const contract = PHYSIOLOGY_CONTRACTS.find((item) => item.nativeMetricType === TYPES[index])!
        if (child.canonicalTarget !== null || child.sourceEnvelopeId !== group.sourceEnvelopeId
          || native.provenance.sourceEnvelopeId !== group.sourceEnvelopeId || native.metricType !== TYPES[index]
          || native.observedAtSource !== source.strings.date || native.observedAt !== source.record.json.observedAt
          || native.value !== Number(source.strings[contract.vendorField as keyof typeof source.strings])
          || child.payload.metricType !== TYPES[index] || child.payload.rawSourceMetadata?.canonicalPolicy !== 'NATIVE_ONLY'
          || child.observationId !== child.payload.observationId || child.payload.sourceRecordGroupId !== group.sourceRecordGroupId
          || JSON.stringify(child.payload) !== child.payloadJson || await sha256Hex(child.payloadJson) !== child.payloadFingerprint
          || mapped.length !== 1 || mapped[0].status !== 'MAPPED' || JSON.stringify(mapped[0].observation) !== child.payloadJson) {
          throw new Error('Saved native-only child contract or payload changed.')
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
            || !receipt.nativeObservationId.trim()) throw new Error('Invalid durable native-only acknowledgement.')
          if (result.status === 'accepted' && result.nativeObservationId === receipt.nativeObservationId) {
            acceptedNativeId = receipt.nativeObservationId
            proven ||= receipt.acknowledged
          } else if (result.status === 'duplicate'
            && (result.nativeObservationId === receipt.nativeObservationId || acceptedNativeId === receipt.nativeObservationId)) {
            proven ||= receipt.acknowledged
          } else throw new Error('Duplicate/accepted result has no durable linked native ID.')
        }
        const latest = [...group.events].reverse().find((event) => event.observationIds.includes(child.observationId)
          && (Array.isArray(event.results)
            || event.rejectedIds.includes(child.observationId) || event.canonicalFailedIds?.includes(child.observationId)))
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
        status: delivered === 4 ? TYPE42_CERTIFICATION_SUCCESS : 'TYPE42_CERTIFICATION_INCOMPLETE',
        delivered, reason: delivered === 4 ? null
          : group.lastFlushReason ?? `One source record preserved; ${delivered}/4 native-only acknowledgements proven.`, group,
      }
    } catch (error) {
      return { status: 'TYPE42_CERTIFICATION_EVIDENCE_INVALID', delivered: 0, reason: error instanceof Error ? error.message : String(error), group }
    }
  }

  async exportSaved(): Promise<string> {
    const inspection = await this.inspectSaved()
    if (!inspection.group || inspection.status === 'TYPE42_CERTIFICATION_EVIDENCE_INVALID') {
      throw new Error(inspection.reason ?? 'No valid saved type-42 evidence.')
    }
    const group = inspection.group
    const sourceRecord = object(JSON.parse(group.sourceEnvelopeJson))
    const fields = object(sourceRecord.sdkSnapshot).entries as Array<{ key: unknown; value: unknown }>
    const fatigue = fields.filter((entry) => {
      const key = object(entry.key).value
      return typeof key === 'string' && /fatigue/i.test(key)
    })
    return JSON.stringify({
      inspection: { status: inspection.status, delivered: inspection.delivered }, group,
      sourceRecord,
      provenance: {
        certificationGroupId: group.certificationGroupId, sourceEnvelopeId: group.sourceEnvelopeId,
        sourceRecordId: sourceRecord.sourceRecordId, sourceRecordGroupId: sourceRecord.sourceRecordGroupId,
        callbackId: sourceRecord.callbackId, notificationEnvelopeId: sourceRecord.notificationEnvelopeId,
        scope: group.context.scope, syncId: group.syncId,
      },
      normalizedChildren: group.children.map((child) => {
        const events = group.events.filter((event) => event.observationIds.includes(child.observationId))
        const latest = events.at(-1)
        const results = latest?.results?.filter((result) => result.observationId === child.observationId) ?? []
        const result = results.length === 1 ? results[0] : null
        const fingerprint = group.eventFingerprints.find((item) => item.batchId === latest?.batchId)
        const linkedDuplicate = result?.status === 'duplicate'
          ? [...child.receipts].reverse().find((receipt) => receipt.event.batchId === latest?.batchId)?.nativeObservationId : null
        return {
          metric: child.payload.metric, value: child.payload.valueNumber, unit: child.payload.unit,
          vendorDerived: child.payload.vendorDerived, observationId: child.observationId,
          sourceEnvelopeId: child.sourceEnvelopeId, sourceRecordId: child.payload.sourceRecordId,
          deliveryPolicy: 'NATIVE_ONLY', canonicalTarget: null,
          delivery: {
            batchId: latest?.batchId ?? null, status: result?.status ?? null,
            reason: result?.reason ?? null, errorCode: result?.errorCode ?? latest?.errorCode ?? null,
            canonicalStatus: result?.canonicalStatus ?? null,
            nativeObservationId: result?.nativeObservationId ?? linkedDuplicate ?? null,
            responseContractVersion: fingerprint?.responseContractVersion ?? null,
            deploymentRevision: fingerprint?.deploymentRevision ?? null,
            receipts: child.receipts, events,
            queueState: child.queueState, queueDisposition: child.queueDisposition,
          },
        }
      }),
      losslessEvidence: {
        vascularAging: { originalString: group.originalStrings.vascularAging, preserved: true, notPromoted: true },
        embeddedHR: { originalString: group.originalStrings.heartRate, preserved: true, notPromoted: true },
        fatigueDegree: { present: fatigue.length > 0, absent: fatigue.length === 0, notExpected: true, notPromoted: true, fields: fatigue },
      },
    }, null, 2)
  }
}
