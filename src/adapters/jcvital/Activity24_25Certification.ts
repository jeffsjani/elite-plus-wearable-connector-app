import type { NativeObservation } from '../../models/wearableObservation'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { BatchDeliveryEvent, CertificationFlushOptions } from '../../services/sync/ObservationBatchManager'
import type { JCVitalV8Plugin, SourceJournalScope } from './jcvitalV8Bridge'
import type { Type42CertificationDependencies, Type42ConnectedContext, Type42Receipt } from './Type42Certification'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import { sha256Hex } from './HeartRateSeries'
import { serializeCertificationJson } from './CertificationJsonExport'
import { JCVITAL_NATIVE_SOURCE } from './WorkoutHrDelivery'
import {
  activityTransportClaimable, transportFingerprint, type ActivityTransportEvidence,
} from '../../services/storage/ActivityCertificationTransport'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import {
  ACTIVITY_R5_REVISION, ACTIVITY_RESPONSE_CONTRACT, ACTIVITY_PRODUCTION_BATCH_ID, ACTIVITY_VC17_GROUP, ACTIVITY_VC17_SESSION,
  ACTIVITY_VC17_SUMMARY, ACTIVITY_EXCLUDED_ID, ACTIVITY_RESUME_IDS, ACTIVITY_SEMANTIC_CONFLICT,
} from './ActivityResumeContract'

type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type ObjectValue = Record<string, unknown>
export const ACTIVITY_CERTIFICATION_FILENAME = 'JCVital Activity 24-25 grouped certification.json'
export const ACTIVITY_MAPPING = [
  ['24', 'step', 'DAILY_STEPS', 'count'],
  ['24', 'exerciseMinutes', 'DAILY_EXERCISE_MINUTES', 'minute'],
  ['24', 'distance', 'DAILY_DISTANCE', 'UNKNOWN_VENDOR_UNIT'],
  ['24', 'calories', 'DAILY_CALORIES', 'UNKNOWN_VENDOR_UNIT'],
  ['24', 'goal', 'DAILY_GOAL_COMPLETION', 'UNKNOWN_VENDOR_UNIT'],
  ['24', 'activeMinutes', 'DAILY_ACTIVE_MINUTES', 'minute'],
  ['25', 'arraySteps', 'DETAILED_ACTIVITY_EPOCH', 'count'],
  ['25', 'detailMinterStep', 'DETAILED_ACTIVITY_STEPS_TOTAL', 'count'],
  ['25', 'distance', 'DETAILED_ACTIVITY_DISTANCE', 'UNKNOWN_VENDOR_UNIT'],
  ['25', 'calories', 'DETAILED_ACTIVITY_CALORIES', 'UNKNOWN_VENDOR_UNIT'],
] as const

export interface ActivitySource {
  sourceEnvelopeId: string
  sourceRecordGroupId: string
  sourceFingerprint: string
  entry: Entry
  record: ObjectValue
  fields: ObjectValue
  ancestry: Entry[]
  rawByteLength: number
  rawByteSha256: string
}
export interface ActivityEpoch {
  sourceEnvelopeId: string
  sourceIndex: number
  slotIndex: number
  originalToken: string
  value: number
  vendorTimestamp: string
  productionObservedAt: string
  timestampAuthority: 'ELITE_PLUS_NOMINAL_INFERENCE'
  zeroVendorFields: string[]
}
export interface ActivityChild {
  observationId: string
  sourceEnvelopeId: string
  canonicalTarget: null
  native: NativeObservation
  payload: NativeObservationInput
  payloadJson: string
  payloadFingerprint: string
  receipts: Type42Receipt[]
  queueDisposition: 'NOT_ENQUEUED' | 'QUEUED' | 'MISSING' | 'ACKNOWLEDGED' | 'ACKNOWLEDGED_PURGED' | typeof ACTIVITY_SEMANTIC_CONFLICT
  queueState: string | null
  exerciseMinutesUnitAuthoritative?: false
  exerciseMinutesDeliveryEligible?: false
  deliveryDisposition?: 'NATIVE_ONLY_DELIVERY_CONFIRMED' | 'PRESERVED_FOR_EXPLICIT_RETRY'
  deliveryTimestamp?: string
  nativeObservationId?: string
  productionResult?: ConnectorObservationResult
  localAcknowledgment?: { batchId: string; at: string; disposition: 'ACKNOWLEDGED' }
}
export interface ActivityFinalizationPredicate {
  code: string
  predicate: string
  passed: boolean
  detail?: string
}
export interface ActivityFinalizationDiagnostics {
  status: 'RUNNING' | 'FAILED' | 'COMPLETED'
  code: string | null
  selectionCode: string | null
  firstFailedPredicateCode: string | null
  failedPredicate: string | null
  predicates: ActivityFinalizationPredicate[]
  deliveryEvents: Array<{ historyIndex: number; predicates: ActivityFinalizationPredicate[] }>
  validDeliveredEvents: number
  resultsValidated: number
  nativeObservationIds: number
  canonicalTargetsNull: number
  queueRowsPresent: number
  queueRowsValidated: number
  payloadMatches: number
  rowsPurged: number
}
export class ActivityFinalizationError extends Error {
  readonly diagnostics: ActivityFinalizationDiagnostics
  constructor(diagnostics: ActivityFinalizationDiagnostics) {
    super(`ACTIVITY FINALIZATION FAILED: ${diagnostics.code} · ${diagnostics.failedPredicate}`
      + `${diagnostics.selectionCode ? ` · selectionCode=${diagnostics.selectionCode}` : ''}`
      + ` · ${activityFinalizationCounts(diagnostics)}`)
    this.name = 'ActivityFinalizationError'
    this.diagnostics = structuredClone(diagnostics)
  }
}
export function activityFinalizationCounts(report: ActivityFinalizationDiagnostics): string {
  return `validDeliveredEvents=${report.validDeliveredEvents} · resultsValidated=${report.resultsValidated}/17`
    + ` · nativeObservationIds=${report.nativeObservationIds}/17 · queueRowsValidated=${report.queueRowsValidated}/17`
    + ` · payloadMatches=${report.payloadMatches}/17 · rowsPurged=${report.rowsPurged}`
    + ` · canonicalTargetsNull=${report.canonicalTargetsNull}/17`
}
function finalizationPredicate(code: string, predicate: string, passed: boolean, detail?: string): ActivityFinalizationPredicate {
  return { code, predicate, passed, ...(detail === undefined ? {} : { detail }) }
}
function nativeOnlyResultTarget(result: NonNullable<BatchDeliveryEvent['results']>[number]): boolean {
  return result.canonicalTarget === undefined || result.canonicalTarget === null
}
function nativeOnlyChildTargets(group: Activity24_25CertificationSnapshot): ActivityFinalizationPredicate {
  const children = group.children.filter((child) => ACTIVITY_RESUME_IDS.some((id) => id === child.observationId))
  const nullCount = children.filter((child) => child.canonicalTarget === null).length
  return finalizationPredicate(
    nullCount > 0 && nullCount < children.length ? 'MIXED_CANONICAL_TARGET_STATE' : 'UNEXPECTED_CANONICAL_TARGET',
    'all 17 persisted Activity canonicalTargets = null',
    children.length === 17 && nullCount === 17,
    `${nullCount}/17`,
  )
}
function serverSuccessPredicates(event: BatchDeliveryEvent): ActivityFinalizationPredicate[] {
  const results = Array.isArray(event.results) ? event.results : []
  const exactIds = (ids: readonly string[]) => ids.length === 17 && new Set(ids).size === 17
    && ACTIVITY_RESUME_IDS.every((id) => ids.includes(id))
  return [
    finalizationPredicate('PRODUCTION_BATCH_ID_INVALID', 'production batchId matches', event.batchId === ACTIVITY_PRODUCTION_BATCH_ID),
    finalizationPredicate('OUTCOME_NOT_DELIVERED', 'outcome = DELIVERED', event.outcome === 'DELIVERED'),
    finalizationPredicate('HTTP_STATUS_NOT_200', 'httpStatus = 200', event.httpStatus === 200),
    finalizationPredicate('SERVER_EVENT_ERROR', 'event errorCode = null', event.errorCode === null),
    finalizationPredicate('OBSERVATION_IDS_NOT_EXACT', 'observationId set is exact expected 17', exactIds(event.observationIds)),
    finalizationPredicate('RESULT_COUNT_INVALID', 'result count = 17', results.length === 17, `${results.length}/17`),
    finalizationPredicate('ACCEPTED_COUNT_INVALID', 'accepted = 17', event.accepted === 17),
    finalizationPredicate('DUPLICATE_COUNT_INVALID', 'duplicate = 0', event.duplicate === 0),
    finalizationPredicate('REJECTED_COUNT_INVALID', 'rejected = 0', event.rejected === 0),
    finalizationPredicate('SERVER_ERRORS_NOT_EMPTY', 'errors = []', Array.isArray(event.errors) && event.errors.length === 0),
    finalizationPredicate('REJECTED_IDS_NOT_EMPTY', 'rejectedIds = []', event.rejectedIds.length === 0),
    finalizationPredicate('CANONICAL_FAILED_IDS_NOT_EMPTY', 'canonicalFailedIds empty', !event.canonicalFailedIds?.length),
    finalizationPredicate('RESULT_IDS_NOT_EXACT', 'result IDs are exact expected 17', exactIds(results.map((result) => result.observationId))),
    finalizationPredicate('RESULT_NOT_ACCEPTED', 'every result status = accepted', results.length === 17 && results.every((result) => result.status === 'accepted')),
    finalizationPredicate('RESULT_REASON_NOT_NULL', 'every result reason = null', results.length === 17 && results.every((result) => result.reason === null)),
    finalizationPredicate('RESULT_ERROR_NOT_NULL', 'every result errorCode = null', results.length === 17 && results.every((result) => result.errorCode === null)),
    finalizationPredicate('CANONICAL_STATUS_INVALID', 'every canonicalStatus = not_applicable', results.length === 17 && results.every((result) => result.canonicalStatus === 'not_applicable')),
    finalizationPredicate('NATIVE_OBSERVATION_ID_MISSING', 'every nativeObservationId is non-null and usable', results.length === 17
      && results.every((result) => typeof result.nativeObservationId === 'string' && !!result.nativeObservationId.trim())),
    finalizationPredicate('UNEXPECTED_CANONICAL_TARGET', 'result canonicalTarget, if present, = null',
      results.every(nativeOnlyResultTarget)),
    finalizationPredicate('EVENT_CONTRACT_INVALID', 'event contract, if present, matches', event.responseContractVersion === undefined || event.responseContractVersion === ACTIVITY_RESPONSE_CONTRACT),
    finalizationPredicate('EVENT_REVISION_INVALID', 'event revision, if present, matches', event.deploymentRevision === undefined || event.deploymentRevision === ACTIVITY_R5_REVISION),
  ]
}
export interface ActivityLocalReconciliationEvent {
  eventType: 'LOCAL_CERTIFICATION_RECONCILIATION_COMPLETED'
  batchId: string
  observationIds: string[]
  results: NonNullable<BatchDeliveryEvent['results']>
  payloadFingerprints: Array<{
    observationId: string
    payloadFingerprint: string
    sourceFingerprint: string
    nativeObservationId: string
  }>
  responseContractVersion: string
  deploymentRevision: string
  finalizedAt: string
  finalQueueDisposition: 'ACKNOWLEDGED_PURGED'
  serverSubmission: 'NONE_LOCAL_RECONCILIATION_ONLY'
}
export interface ActivityQueueInspection {
  observationId: string
  exists: boolean
  queueState: QueueRecord['state'] | null
  nextAttemptAt: string | null
  attemptCount: number | null
  claimedAt: string | null
  lastAttemptAt: string | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  batchId: string | null
  queueId: string | null
  payloadJsonPresent: boolean
  payloadFingerprint: string | null
  savedPayloadFingerprint: string
  payloadMatches: boolean
  certificationOnly: boolean
  ordinaryClaimable: boolean
  retryDelayActive: boolean
  certificationAutoDrainSuppressed: boolean
  certificationClaimable: boolean
  blockedReason: string | null
}
export interface ActivityRecoveryDiagnostics {
  stage: string
  code: string | null
  savedEligibleIds: number
  queueRowsFound: number
  queueRowsReconstructed: number
  certificationClaimable: number
  excludedSemanticConflictRows: number
  inspectedAt: string
  rowsBefore: ActivityQueueInspection[]
  rowsAfter: ActivityQueueInspection[]
}
export interface Activity24_25CertificationSnapshot {
  kind: 'Activity24_25Certification'
  version: 1
  certificationGroupId: string
  context: Type42ConnectedContext
  acquisitionSessionId: string | null
  state: 'ACQUIRING' | 'CAPTURED' | 'STOPPED' | 'COMPLETED'
  reason: string | null
  selectedType24SourceEnvelopeId: string | null
  type24: ActivitySource | null
  type25Group: ActivitySource[]
  physicalSources: ActivitySource[]
  summaryEligibility: Array<{ sourceEnvelopeId: string; complete: boolean; reason: string | null }>
  acquisitionResults: Awaited<ReturnType<JCVitalV8Plugin['syncActivityCertification']>> | null
  detailedEpochs: ActivityEpoch[]
  selectedEpochIndexes: Array<{ index: number; categories: string[] }>
  children: ActivityChild[]
  overlapAnalysis: ReturnType<typeof activityOverlapAnalysis>
  events: BatchDeliveryEvent[]
  localReconciliationEvents?: ActivityLocalReconciliationEvent[]
  pendingLocalReconciliation?: ActivityLocalReconciliationEvent
  finalizationDiagnostics?: ActivityFinalizationDiagnostics
  responseContractVersion: string | null
  deploymentRevision: string | null
  resumePolicy?: 'VC18_EXACT_R5' | 'VC19_EXACT_R5_RECOVERY'
  recoveryDiagnostics?: ActivityRecoveryDiagnostics
  certificationMessage?: string
  deliveryPolicy: { concurrency: 1; batchSize: 100; canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' }
}
export interface ActivityInspection {
  status: 'ACTIVITY_CERTIFICATION_SUCCESS' | 'ACTIVITY_CERTIFICATION_INCOMPLETE' | 'ACTIVITY_CERTIFICATION_EVIDENCE_INVALID' | 'NO_SAVED_ACTIVITY_CERTIFICATION'
  delivered: number
  reason: string | null
  group: Activity24_25CertificationSnapshot | null
}
export type ActivityDependencies = Omit<Type42CertificationDependencies, 'acquire' | 'queue'> & {
  queue: Type42CertificationDependencies['queue'] & {
    removePreservedCertificationObservation?(id: string, payloadJson: string): Promise<void>
    getPayloadJson?(id: string): Promise<string | null>
    recoverActivityCertificationTransport?(evidence: readonly ActivityTransportEvidence[]): Promise<{ found: number; reconstructed: number }>
    purgeVerifiedDeliveredActivityTransport?(evidence: readonly ActivityTransportEvidence[]): Promise<void>
  }
  acquire: JCVitalV8Plugin['syncActivityCertification']
  snapshotStore?: Pick<JCVitalV8Plugin, 'readActivityCertificationSnapshot' | 'writeActivityCertificationSnapshot'>
}

function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid activity evidence object.')
  return value as ObjectValue
}
function field(snapshot: unknown, name: string): unknown {
  const map = object(snapshot)
  if (map.type !== 'Map' || !Array.isArray(map.entries)) throw new Error('SDK snapshot is not a typed Map.')
  const matches = map.entries.map(object).filter((entry) => object(entry.key).value === name)
  if (matches.length !== 1) throw new Error(`Missing/duplicate SDK field: ${name}.`)
  return matches[0].value
}
function fields(snapshot: unknown): ObjectValue {
  const map = object(snapshot)
  if (map.type !== 'Map' || !Array.isArray(map.entries)) throw new Error('SDK record is not a typed Map.')
  const result = new Map<string, unknown>()
  for (const entry of map.entries.map(object)) {
    const key = object(entry.key)
    if (key.type !== 'String' || typeof key.value !== 'string' || result.has(key.value)) {
      throw new Error('Invalid/duplicate SDK field name.')
    }
    result.set(key.value, entry.value)
  }
  return Object.fromEntries(result)
}

export async function readActivitySourceEnvelope(
  journal: Pick<JCVitalV8Plugin, 'readSourceEnvelope'>, scope: SourceJournalScope, envelopeId: string, kind: string,
) {
  const entry = await journal.readSourceEnvelope({ ...scope, envelopeId })
  const json = object(JSON.parse(entry.envelopeJson))
  if (entry.envelopeId !== envelopeId || json.envelopeId !== envelopeId || json.kind !== kind
    || json.accountId !== scope.accountId || json.deviceScopeId !== scope.deviceScopeId
    || json.provider !== 'JCVITAL' || json.sourceConnector !== 'JCVITAL_NATIVE') throw new Error('Invalid physical source ancestry.')
  return { entry, json }
}

export async function verifyActivitySourceNotification(
  notification: { entry: Entry; json: ObjectValue }, sessionId: unknown,
) {
  const base64 = notification.entry.rawBytesBase64
  if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw new Error('Missing raw BLE bytes.')
  const raw = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
  const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw))).map((byte) => byte.toString(16).padStart(2, '0')).join('')
  if (!raw.length || raw.length !== notification.json.byteLength || digest !== notification.json.sha256
    || notification.json.sessionId !== sessionId) throw new Error('Raw BLE length/hash/session mismatch.')
  return { rawByteLength: raw.length, rawByteSha256: digest }
}

export async function readActivitySource(
  journal: Pick<JCVitalV8Plugin, 'readSourceEnvelope'>, scope: SourceJournalScope, id: string,
): Promise<ActivitySource> {
  const read = (envelopeId: string, kind: string) => readActivitySourceEnvelope(journal, scope, envelopeId, kind)
  const record = await read(id, 'SDK_RECORD')
  const r = record.json
  if (!['24', '25'].includes(String(r.vendorDataType)) || r.acquisitionMode !== 'HISTORICAL_SYNC'
    || r.sourceRecordId !== id || r.sourceRecordGroupId !== r.callbackId
    || typeof r.callbackId !== 'string' || typeof r.notificationEnvelopeId !== 'string'
    || !Number.isInteger(r.recordIndex) || Number(r.recordIndex) < 0 || r.sourceIndex !== r.recordIndex) {
    throw new Error('Invalid activity SDK_RECORD.')
  }
  const callback = await read(r.callbackId, 'SDK_CALLBACK')
  const c = callback.json
  if (c.vendorDataType !== r.vendorDataType || c.callbackId !== r.callbackId || c.notificationEnvelopeId !== r.notificationEnvelopeId
    || !Array.isArray(c.recordEnvelopeIds) || c.recordEnvelopeIds[Number(r.recordIndex)] !== id
    || c.sessionId !== r.sessionId) throw new Error('Invalid SDK record/callback link.')
  const data = object(field(c.sdkSnapshot, 'dicData'))
  if (data.type !== 'List' || !Array.isArray(data.values)
    || JSON.stringify(data.values[Number(r.recordIndex)]) !== JSON.stringify(r.sdkSnapshot)) throw new Error('SDK callback snapshot differs.')
  const notification = await read(r.notificationEnvelopeId, 'BLE_NOTIFICATION')
  const integrity = await verifyActivitySourceNotification(notification, r.sessionId)
  return {
    sourceEnvelopeId: id, sourceRecordGroupId: String(r.sourceRecordGroupId),
    sourceFingerprint: await sha256Hex(record.entry.envelopeJson), entry: record.entry, record: r, fields: fields(r.sdkSnapshot),
    ancestry: [record.entry, callback.entry, notification.entry], ...integrity,
  }
}
function text(source: ActivitySource, name: string): string {
  const value = object(source.fields[name])
  if (value.type !== 'String' || typeof value.value !== 'string') throw new Error(`Missing vendor String ${name}.`)
  return value.value
}
function number(source: ActivitySource, name: string): number {
  const token = text(source, name)
  if (!/^-?\d+(?:\.\d+)?$/.test(token) || !Number.isFinite(Number(token))) throw new Error(`Invalid vendor number ${name}.`)
  return Number(token)
}
export function detailedActivitySlots(source: ActivitySource): Array<{ token: string; value: number }> {
  const tokens = text(source, 'arraySteps').trim().split(/\s+/)
  if (tokens.length !== 10 || tokens.some((token) => !/^\d+$/.test(token) || Number(token) > 255)) {
    throw new Error('Type25 requires ten original unsigned-byte slots; no compaction or invented slots.')
  }
  return tokens.map((token) => ({ token, value: Number(token) }))
}
export function sampleActivityEpochs(epochs: readonly (Pick<ActivityEpoch, 'value'> & Partial<Pick<ActivityEpoch, 'zeroVendorFields'>>)[]) {
  if (!epochs.length) throw new Error('No detailed activity epochs.')
  const selected = new Map<number, string[]>()
  const add = (index: number, category: string) => {
    if (index >= 0) selected.set(index, [...(selected.get(index) ?? []), category])
  }
  add(0, 'FIRST')
  if (epochs.length > 2) add(1, 'INTERIOR')
  const stepZero = epochs.findIndex((epoch) => epoch.value === 0)
  add(stepZero >= 0 ? stepZero : epochs.findIndex((epoch) => !!epoch.zeroVendorFields?.length), 'ZERO')
  add(Math.floor(epochs.length / 2), 'MIDPOINT')
  add(epochs.length - 1, 'LAST')
  return [...selected].sort(([a], [b]) => a - b).map(([index, categories]) => ({ index, categories }))
}
function activityEpochs(sources: readonly ActivitySource[]): ActivityEpoch[] {
  return sources.flatMap((source, sourceIndex) => detailedActivitySlots(source).map((slot, slotIndex) => ({
    sourceEnvelopeId: source.sourceEnvelopeId, sourceIndex, slotIndex, originalToken: slot.token, value: slot.value,
    vendorTimestamp: text(source, 'date'),
    productionObservedAt: new Date(Date.parse(String(source.record.observedAt)) + slotIndex * 60_000).toISOString(),
    timestampAuthority: 'ELITE_PLUS_NOMINAL_INFERENCE' as const,
    zeroVendorFields: [...(slot.value === 0 ? ['arraySteps'] : []),
      ...['detailMinterStep', 'distance', 'calories'].filter((name) => number(source, name) === 0)],
  })))
}
function completeActivitySource(source: ActivitySource): boolean {
  if (source.record.sourceDateParseStatus !== 'VALID' || typeof source.record.observedAt !== 'string'
    || !Number.isFinite(Date.parse(source.record.observedAt)) || source.record.sourceDate !== text(source, 'date')
    || source.record.parsedSourceDateMillis !== Date.parse(source.record.observedAt)) return false
  const required = source.record.vendorDataType === '24'
    ? ['step', 'exerciseMinutes', 'calories', 'distance', 'goal'] : ['detailMinterStep', 'calories', 'distance']
  required.forEach((name) => number(source, name))
  if (source.record.vendorDataType === '25') detailedActivitySlots(source)
  return true
}
function summaryEligibility(sources: readonly ActivitySource[]) {
  return sources.filter((source) => source.record.vendorDataType === '24').map((source) => {
    try {
      const complete = completeActivitySource(source)
      return { sourceEnvelopeId: source.sourceEnvelopeId, complete, reason: complete ? null : 'Invalid/mismatched vendor source date or parsed timestamp.' }
    } catch (error) {
      return { sourceEnvelopeId: source.sourceEnvelopeId, complete: false, reason: error instanceof Error ? error.message : String(error) }
    }
  })
}
export function activityOverlapAnalysis(summary: ActivitySource | null, details: readonly ActivitySource[]) {
  const overlapFields = [
    ['steps', 'step', 'detailMinterStep'], ['stepsSlots', 'step', 'arraySteps'],
    ['calories', 'calories', 'calories'], ['distance', 'distance', 'distance'],
    ['duration', 'exerciseMinutes', null], ['intensity', null, null],
  ] as const satisfies readonly (readonly [string, string | null, string | null])[]
  return overlapFields.map(([metric, type24Field, type25Field]) => {
    const type24Value = summary && type24Field ? number(summary, type24Field) : null
    const type25Aggregate = !type25Field || !details.length ? null
      : details.reduce((sum, source) => sum + (type25Field === 'arraySteps'
        ? detailedActivitySlots(source).reduce((total, slot) => total + slot.value, 0) : number(source, type25Field)), 0)
    return {
      metric, type24Field, type25Field, relationshipKnown: false,
      relationship: type24Field && type25Field ? 'UNKNOWN_VENDOR_SEMANTICS; numerical comparison only, not proof of decomposition'
        : 'NO_CORRESPONDING_SDK_FIELD',
      type25Aggregate, type24Value, valuesMatch: type24Value === null || type25Aggregate === null ? null : Math.abs(type24Value - type25Aggregate) < 1e-9,
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' as const,
      doubleCountPrevention: 'Certification-only native rows; neither representation is promoted or added to canonical/scoring totals. Repeated records remain included in diagnostic aggregates.',
    }
  })
}

/** Certification transport only: the production activity path is capture-only and remains unchanged. */
export async function mapActivityCertificationObservation(context: Type42ConnectedContext, source: ActivitySource, native: NativeObservation): Promise<NativeObservationInput> {
  const payload = activityCertificationPayload(context, source, native, '')
  payload.observationId = await sha256Hex(`${context.scope.accountId}:${payload.sourceRecordId}`)
  return payload
}
function activityCertificationPayload(context: Type42ConnectedContext, source: ActivitySource, native: NativeObservation, observationId: string): NativeObservationInput {
  const mapping = ACTIVITY_MAPPING.find(([type, vendorField, metricType]) =>
    type === native.vendorDataType && vendorField === native.vendorField && metricType === native.metricType)
  if (!mapping || native.provenance.sourceEnvelopeId !== source.sourceEnvelopeId
    || native.source.connector !== 'JCVITAL_NATIVE' || native.source.provider !== 'JCVITAL'
    || native.source.macAddress !== context.bleAddress || native.acquisitionMode !== 'HISTORICAL_SYNC'
    || native.source.firmwareVersion !== context.firmwareVersion || native.source.sdkVersion !== context.sdkVersion
    || native.sessionId !== source.record.sessionId || native.timezone !== source.record.timezone
    || native.observedAtSource !== text(source, 'date') || native.unit !== mapping[3]) {
    throw new Error('Activity normalized child differs from exact physical source/context.')
  }
  const slot = native.metricType === 'DETAILED_ACTIVITY_EPOCH' ? native.sequenceNumber : null
  if (slot !== null && (!Number.isInteger(slot) || slot < 0 || slot >= 10)) throw new Error('Invalid detailed slot index.')
  if (native.metricType === 'DETAILED_ACTIVITY_EPOCH' && slot === null) throw new Error('Missing detailed slot index.')
  const value = slot === null ? number(source, mapping[1]) : detailedActivitySlots(source)[slot].value
  const expectedTime = slot === null ? source.record.observedAt
    : new Date(Date.parse(String(source.record.observedAt)) + slot * 60_000).toISOString()
  if (native.value !== value || native.observedAt !== expectedTime
    || native.samplingIntervalMs !== (slot === null ? null : 60_000)) throw new Error('Activity value or production timestamp changed.')
  const sourceRecordId = `${context.scope.deviceScopeId}:activity-certification:${source.sourceEnvelopeId}:${mapping[1]}:${slot ?? 'record'}`
  return {
    observationId,
    source: JCVITAL_NATIVE_SOURCE.source, provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE', sourceProvider: 'JCVITAL',
    sourcePath: 'DIRECT_BLE', deviceManufacturer: 'JCVital', deviceModel: 'PRO_V8',
    deviceId: context.scope.deviceScopeId, sourceId: context.scope.deviceScopeId,
    metric: `activityVendor${mapping[2]}`, metricType: mapping[2], valueNumber: value, unit: mapping[3],
    startTime: String(expectedTime), observedAt: String(expectedTime), observedAtSource: text(source, 'date'),
    capturedAt: native.receivedAt, receivedAt: native.receivedAt, timezone: native.timezone!,
    timestampSource: slot === null ? 'DEVICE_HISTORY_RECORD_TIME' : 'DEVICE_HISTORY_RECORD_TIME_PLUS_NOMINAL_INTERVAL',
    timestampConfidence: slot === null ? 'DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE' : 'NOMINAL_INTERVAL_DERIVED',
    timestampTimezoneSource: 'PHONE_TIMEZONE', acquisitionMode: 'HISTORICAL_SYNC',
    measurementContext: native.measurementContext ?? undefined, sessionId: native.sessionId ?? undefined,
    sourceRecordId, sourceRecordGroupId: source.sourceRecordGroupId,
    firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion, vendorDataType: mapping[0],
    vendorField: mapping[1], vendorDerived: native.vendorDerived,
    ...(slot === null ? {} : { sequenceNumber: slot, samplingIntervalMs: 60_000 }),
    rawSourceMetadata: {
      canonicalPolicy: 'NATIVE_ONLY', canonicalTarget: null, semanticConfidence: 'UNKNOWN_VENDOR_SEMANTICS',
      certificationOnly: true, sourceEnvelopeId: source.sourceEnvelopeId, sourceFingerprint: source.sourceFingerprint,
      vendorDate: text(source, 'date'), sourceIndex: Number(source.record.recordIndex),
      vendorSerial: null, slotIndex: slot, timingAuthority: slot === null ? 'VENDOR_RECORD_DATE' : 'ELITE_PLUS_NOMINAL_INFERENCE',
    },
  }
}

export class Activity24_25Certification {
  private operation: Promise<ActivityInspection> | null = null
  private finalizationOperation: Promise<ActivityInspection> | null = null
  private readonly deps: ActivityDependencies
  constructor(deps: ActivityDependencies) { this.deps = deps }
  private context() {
    const context = this.deps.connectedContext()
    if (!this.deps.queue.getOwnerUserId() || context.scope.accountId !== this.deps.queue.getOwnerUserId()
      || !isOpaqueJCVitalDeviceId(context.scope.deviceScopeId)) throw new Error('Authenticated opaque activity scope required.')
    return context
  }
  private assertScope(expected: Type42ConnectedContext) {
    const current = this.context()
    if (current.scope.accountId !== expected.scope.accountId || current.scope.deviceScopeId !== expected.scope.deviceScopeId) {
      throw new Error('Activity account/device scope changed.')
    }
  }
  private key(context: Type42ConnectedContext) {
    return `elitePlus.activity24_25Certification.v1.${encodeURIComponent(context.scope.accountId)}.${encodeURIComponent(context.scope.deviceScopeId)}`
  }
  async snapshot(): Promise<Activity24_25CertificationSnapshot | null> {
    const context = this.context()
    if (!this.deps.storage && !this.deps.snapshotStore) throw new Error('Durable native activity snapshot store unavailable.')
    const json = this.deps.storage ? this.deps.storage().getItem(this.key(context))
      : (await this.deps.snapshotStore!.readActivityCertificationSnapshot(context.scope)).json
    this.assertScope(context)
    if (!json) return null
    const group: Activity24_25CertificationSnapshot = JSON.parse(json)
    if (group.kind !== 'Activity24_25Certification' || group.version !== 1 || !group.certificationGroupId
      || group.context.scope.accountId !== context.scope.accountId || group.context.scope.deviceScopeId !== context.scope.deviceScopeId) {
      throw new Error('Invalid saved activity certification scope/schema.')
    }
    return group
  }
  private async save(group: Activity24_25CertificationSnapshot) {
    this.assertScope(group.context)
    const json = JSON.stringify(group)
    if (this.deps.storage) this.deps.storage().setItem(this.key(group.context), json)
    else {
      if (!this.deps.snapshotStore) throw new Error('Durable native activity snapshot store unavailable.')
      const result = await this.deps.snapshotStore.writeActivityCertificationSnapshot({ ...group.context.scope, json })
      if (!result.saved) throw new Error('Activity snapshot persistence was not confirmed.')
    }
    this.assertScope(group.context)
  }
  private async source(context: Type42ConnectedContext, id: string): Promise<ActivitySource> {
    const source = await readActivitySource(this.deps.journal, context.scope, id)
    this.assertScope(context)
    if (source.record.firmwareVersion !== context.firmwareVersion || source.record.sdkVersion !== context.sdkVersion) {
      throw new Error('Invalid activity SDK_RECORD.')
    }
    return source
  }
  captureAndDeliver(onStage?: CertificationFlushOptions['onStage']): Promise<ActivityInspection> {
    if (this.finalizationOperation) return this.finalizationOperation
    if (this.operation) return this.operation
    this.operation = this.captureOnce(onStage).finally(() => { this.operation = null })
    return this.operation
  }
  resumeDelivery(onStage?: CertificationFlushOptions['onStage']): Promise<ActivityInspection> {
    if (this.finalizationOperation) return this.finalizationOperation
    if (this.operation) return this.operation
    this.operation = this.resumeOnce(onStage).finally(() => { this.operation = null })
    return this.operation
  }
  finalizeDeliveredCertification(): Promise<ActivityInspection> {
    if (this.finalizationOperation) return this.finalizationOperation
    this.finalizationOperation = this.finalizeDeliveredOnce().finally(() => { this.finalizationOperation = null })
    return this.finalizationOperation
  }
  private async selectDeliveredProductionEvent(
    group: Activity24_25CertificationSnapshot, report?: ActivityFinalizationDiagnostics,
  ): Promise<BatchDeliveryEvent> {
    if (!report && (group.responseContractVersion !== ACTIVITY_RESPONSE_CONTRACT || group.deploymentRevision !== ACTIVITY_R5_REVISION)) {
      throw new Error('LOCAL_ACTIVITY_FINALIZATION_RESPONSE_INVALID: persisted response contract or deployment revision differs.')
    }
    const validEvents = new Map<string, BatchDeliveryEvent>()
    for (const [historyIndex, event] of group.events.entries()) {
      if (event.batchId !== ACTIVITY_PRODUCTION_BATCH_ID) continue
      const predicates = [...serverSuccessPredicates(event), nativeOnlyChildTargets(group)]
      report?.deliveryEvents.push({ historyIndex, predicates })
      if (report && event.outcome === 'DELIVERED') {
        const results = event.results ?? []
        report.resultsValidated = Math.max(report.resultsValidated, results.filter((result) =>
          ACTIVITY_RESUME_IDS.some((id) => id === result.observationId) && result.status === 'accepted'
          && result.reason === null && result.errorCode === null && result.canonicalStatus === 'not_applicable'
          && nativeOnlyResultTarget(result) && typeof result.nativeObservationId === 'string' && !!result.nativeObservationId.trim()).length)
        report.nativeObservationIds = Math.max(report.nativeObservationIds, results.filter((result) =>
          typeof result.nativeObservationId === 'string' && !!result.nativeObservationId.trim()).length)
      }
      if (predicates.some((predicate) => !predicate.passed)) continue
      const fingerprint = await transportFingerprint(JSON.stringify(event))
      validEvents.set(fingerprint, event)
    }
    if (report) report.validDeliveredEvents = validEvents.size
    if (validEvents.size === 0) throw new Error('VALID_DELIVERED_BATCH_NOT_FOUND')
    if (validEvents.size > 1) throw new Error('AMBIGUOUS_VALID_DELIVERED_BATCH')
    if (report) report.selectionCode = 'VALID_DELIVERED_BATCH_SELECTED'
    return [...validEvents.values()][0]
  }
  private async finalizeDeliveredOnce(): Promise<ActivityInspection> {
    const report: ActivityFinalizationDiagnostics = {
      status: 'RUNNING', code: null, selectionCode: null, firstFailedPredicateCode: null, failedPredicate: null,
      predicates: [], deliveryEvents: [], validDeliveredEvents: 0, resultsValidated: 0,
      nativeObservationIds: 0, canonicalTargetsNull: 0, queueRowsPresent: 0, queueRowsValidated: 0, payloadMatches: 0, rowsPurged: 0,
    }
    let stage = 'SNAPSHOT_READ_FAILED'
    const assertPredicates = () => {
      const failed = report.predicates.find((predicate) => !predicate.passed)
      if (failed) {
        report.firstFailedPredicateCode = failed.code
        report.failedPredicate = `${failed.predicate}${failed.detail ? ` (${failed.detail})` : ''}`
        throw new Error(failed.code)
      }
    }
    try {
      report.predicates.push(finalizationPredicate('ACTIVITY_OPERATION_IN_PROGRESS', 'no acquisition/delivery operation in progress', this.operation === null))
      assertPredicates()
      const group = await this.snapshot()
      report.predicates.push(finalizationPredicate('SNAPSHOT_MISSING', 'snapshot present', group !== null))
      assertPredicates()
      if (!group) throw new Error('SNAPSHOT_MISSING')
      report.canonicalTargetsNull = group.children.filter((child) =>
        ACTIVITY_RESUME_IDS.some((id) => id === child.observationId) && child.canonicalTarget === null).length
      report.predicates.push(
        finalizationPredicate('CERTIFICATION_GROUP_ID_INVALID', 'certificationGroupId valid', group.certificationGroupId === ACTIVITY_VC17_GROUP),
        finalizationPredicate('ACQUISITION_SESSION_ID_INVALID', 'acquisitionSessionId valid', group.acquisitionSessionId === ACTIVITY_VC17_SESSION),
        finalizationPredicate('PRODUCTION_BATCH_NOT_LOCATED', 'production batch located in persisted events', group.events.some((event) => event.batchId === ACTIVITY_PRODUCTION_BATCH_ID)),
        finalizationPredicate('RESPONSE_CONTRACT_INVALID', 'persisted responseContractVersion valid', group.responseContractVersion === ACTIVITY_RESPONSE_CONTRACT),
        finalizationPredicate('DEPLOYMENT_REVISION_INVALID', 'persisted deploymentRevision valid', group.deploymentRevision === ACTIVITY_R5_REVISION),
        finalizationPredicate('VC19_POLICY_INVALID', 'VC19 saved-evidence policy valid', group.resumePolicy === 'VC19_EXACT_R5_RECOVERY'),
        finalizationPredicate('CERTIFICATION_CHILD_IDS_NOT_EXACT', 'eligible certification children are exact expected 17',
          group.children.length === 18 && ACTIVITY_RESUME_IDS.every((id) => group.children.filter((child) => child.observationId === id).length === 1)),
        finalizationPredicate('CANONICAL_AUTHORITY_CHANGED', 'canonicalAuthority remains NONE_UNTIL_SEMANTICS_CONFIRMED',
          group.deliveryPolicy.canonicalAuthority === 'NONE_UNTIL_SEMANTICS_CONFIRMED'),
        nativeOnlyChildTargets(group),
      )
      let event: BatchDeliveryEvent | null = null
      let selectionError: string | null = null
      stage = 'SERVER_SUCCESS_SELECTION_FAILED'
      try {
        event = await this.selectDeliveredProductionEvent(group, report)
      } catch (error) {
        selectionError = error instanceof Error ? error.message : String(error)
        report.selectionCode = selectionError
      }
      report.predicates.push(finalizationPredicate(selectionError ?? 'VALID_DELIVERED_BATCH_NOT_FOUND',
        'one valid DELIVERED production event selected', event !== null, selectionError ?? undefined))
      if (event) report.predicates.push(...serverSuccessPredicates(event))
      else {
        const candidate = report.deliveryEvents.find((item) =>
          group.events[item.historyIndex].outcome === 'DELIVERED') ?? report.deliveryEvents[0]
        if (candidate) report.predicates.push(...candidate.predicates)
      }
      stage = 'SAVED_SOURCE_EVIDENCE_INVALID'
      // Local ACK receipts are historical bookkeeping, not prerequisites for this repair.
      try {
        await this.validate(group, false)
        this.assertResumeManifest(group)
        report.predicates.push(finalizationPredicate(stage, 'saved physical source/mapping/semantics valid independently of ACK', true))
      } catch (error) {
        report.predicates.push(finalizationPredicate(stage, 'saved physical source/mapping/semantics valid independently of ACK', false,
          error instanceof Error ? error.message : String(error)))
      }
      const results = event?.results ?? []
      report.predicates.push(finalizationPredicate('ACTIVITY_LOCAL_FINALIZATION_QUEUE_API_UNAVAILABLE', 'local queue APIs available',
        !!this.deps.queue.getPayloadJson && !!this.deps.queue.purgeVerifiedDeliveredActivityTransport))
      if (!this.deps.queue.getPayloadJson || !this.deps.queue.purgeVerifiedDeliveredActivityTransport) assertPredicates()
      stage = 'QUEUE_EVIDENCE_READ_FAILED'
      const children = ACTIVITY_RESUME_IDS.map((id) => {
        const matches = group.children.filter((child) => child.observationId === id)
        if (matches.length !== 1) throw new Error(`LOCAL_ACTIVITY_FINALIZATION_CHILD_MISSING_OR_AMBIGUOUS: ${id}`)
        return matches[0]
      })
      const transportEvidence: ActivityTransportEvidence[] = []
      for (const child of children) {
        const source = group.physicalSources.find((item) => item.sourceEnvelopeId === child.sourceEnvelopeId)
        report.predicates.push(finalizationPredicate('LOCAL_ACTIVITY_FINALIZATION_SAVED_EVIDENCE_MISMATCH',
          'saved payload fingerprint/source match', !!source && child.payload.observationId === child.observationId
          && child.payloadFingerprint === await transportFingerprint(child.payloadJson)
          && child.payload.rawSourceMetadata?.sourceFingerprint === source.sourceFingerprint
        && child.payload.rawSourceMetadata?.sourceEnvelopeId === child.sourceEnvelopeId, child.observationId))
        const row = await this.deps.queue.getRecord(child.observationId)
        const payloadJson = await this.deps.queue.getPayloadJson!(child.observationId)
        if (row) report.queueRowsPresent++
        const payloadMatches = !row ? payloadJson === null : payloadJson === child.payloadJson
          && JSON.stringify(row.payload) === child.payloadJson
          && await transportFingerprint(payloadJson ?? '') === child.payloadFingerprint
        const sourceMatches = !row || row.ownerUserId === group.context.scope.accountId
          && row.observationId === child.observationId && row.sourceEnvelopeId === child.sourceEnvelopeId
        const stateAllowed = !row || row.state !== 'IN_FLIGHT' && row.state !== 'CANONICAL_RECOVERY_REQUIRED'
        const certificationOnly = child.payload.rawSourceMetadata?.certificationOnly === true
          && (!row || row.payload.rawSourceMetadata?.certificationOnly === true)
        report.predicates.push(
          finalizationPredicate('QUEUE_PAYLOAD_FINGERPRINT_MISMATCH', 'queue payload fingerprint matches saved certification', payloadMatches, child.observationId),
          finalizationPredicate('QUEUE_SOURCE_MISMATCH', 'queue observation ID, owner and source match', sourceMatches, child.observationId),
          finalizationPredicate('QUEUE_STATE_BLOCKED', 'queue state permits local repair without previous ACK', stateAllowed, `${child.observationId}: ${row?.state ?? 'ABSENT'}`),
          finalizationPredicate('CERTIFICATION_ONLY_REQUIRED', 'certificationOnly = true', certificationOnly, child.observationId),
        )
        if (payloadMatches) report.payloadMatches++
        if (payloadMatches && sourceMatches && stateAllowed && certificationOnly) report.queueRowsValidated++
        transportEvidence.push({
          observationId: child.observationId, payloadJson: child.payloadJson,
          payloadFingerprint: child.payloadFingerprint, sourceEnvelopeId: child.sourceEnvelopeId,
        })
      }
      const excluded = group.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)
      report.predicates.push(
        finalizationPredicate('QUEUE_ROWS_INSPECTION_FAILED', 'all 17 eligible queue IDs inspected; absent rows are not re-enqueued', report.queueRowsValidated === 17, `${report.queueRowsPresent} rows present`),
        finalizationPredicate('LOCAL_ACTIVITY_FINALIZATION_EXCLUDED_CHILD_CHANGED', 'exerciseMinutes preserved and ineligible',
          !!excluded && excluded.exerciseMinutesUnitAuthoritative === false && excluded.exerciseMinutesDeliveryEligible === false
          && excluded.queueDisposition === ACTIVITY_SEMANTIC_CONFLICT && excluded.queueState === null),
        finalizationPredicate('LOCAL_ACTIVITY_FINALIZATION_EXCLUDED_QUEUE_ROW_PRESENT', 'exerciseMinutes excluded from queue',
          await this.deps.queue.getRecord(ACTIVITY_EXCLUDED_ID) === null),
      )
      const failedSelection = report.predicates.find((predicate) => !predicate.passed)
      if (failedSelection?.predicate === 'one valid DELIVERED production event selected') {
        const failedEvent = report.predicates.find((predicate) => !predicate.passed && predicate !== failedSelection)
        report.firstFailedPredicateCode = failedEvent?.code ?? failedSelection.code
        report.failedPredicate = failedEvent?.predicate ?? failedSelection.predicate
        throw new Error(selectionError ?? failedSelection.code)
      }
      assertPredicates()
      if (!event) throw new Error('VALID_DELIVERED_BATCH_NOT_FOUND')
      const finalizedAt = new Date().toISOString()
      const reconciliation: ActivityLocalReconciliationEvent = {
        eventType: 'LOCAL_CERTIFICATION_RECONCILIATION_COMPLETED',
        batchId: event.batchId,
        observationIds: [...ACTIVITY_RESUME_IDS],
        results: structuredClone(results),
        payloadFingerprints: children.map((child) => ({
          observationId: child.observationId, payloadFingerprint: child.payloadFingerprint,
          sourceFingerprint: child.payload.rawSourceMetadata!.sourceFingerprint as string,
          nativeObservationId: results.find((result) => result.observationId === child.observationId)!.nativeObservationId!,
        })),
        responseContractVersion: ACTIVITY_RESPONSE_CONTRACT,
        deploymentRevision: ACTIVITY_R5_REVISION,
        finalizedAt,
        finalQueueDisposition: 'ACKNOWLEDGED_PURGED',
        serverSubmission: 'NONE_LOCAL_RECONCILIATION_ONLY',
      }
      const existing = group.localReconciliationEvents?.find((item) => item.batchId === event.batchId)
        ?? group.pendingLocalReconciliation
      if (existing && JSON.stringify({ ...existing, finalizedAt: null }) !== JSON.stringify({ ...reconciliation, finalizedAt: null })) {
        throw new Error('LOCAL_ACTIVITY_FINALIZATION_EXISTING_EVENT_MISMATCH')
      }
      const acknowledgment = existing ?? reconciliation
      group.pendingLocalReconciliation = acknowledgment
      group.responseContractVersion = ACTIVITY_RESPONSE_CONTRACT
      group.deploymentRevision = ACTIVITY_R5_REVISION
      group.reason = null
      for (const child of children) {
        const result = results.find((item) => item.observationId === child.observationId)!
        child.nativeObservationId = result.nativeObservationId!
        child.productionResult = structuredClone(result)
        child.localAcknowledgment = { batchId: event.batchId, at: acknowledgment.finalizedAt, disposition: 'ACKNOWLEDGED' }
        if (!group.localReconciliationEvents?.length) child.queueDisposition = 'ACKNOWLEDGED'
        child.deliveryDisposition = 'NATIVE_ONLY_DELIVERY_CONFIRMED'
        child.deliveryTimestamp = acknowledgment.finalizedAt
      }
      stage = 'LOCAL_ACK_PERSISTENCE_FAILED'
      group.finalizationDiagnostics = structuredClone(report)
      await this.save(group)
      stage = 'LOCAL_QUEUE_PURGE_FAILED'
      await this.deps.queue.purgeVerifiedDeliveredActivityTransport!(transportEvidence)
      stage = 'LOCAL_QUEUE_PURGE_READBACK_FAILED'
      for (const child of children) {
        if (await this.deps.queue.getRecord(child.observationId)) {
          throw new Error(`LOCAL_ACTIVITY_FINALIZATION_QUEUE_ROW_REMAINS: ${child.observationId}`)
        }
        child.queueState = null
        child.queueDisposition = 'ACKNOWLEDGED_PURGED'
      }
      report.rowsPurged = report.queueRowsPresent
      report.predicates.push(finalizationPredicate('ELIGIBLE_QUEUE_ROWS_REMAIN', 'all 17 eligible transport rows absent after purge', true))
      group.localReconciliationEvents ??= []
      if (!group.localReconciliationEvents.length) group.localReconciliationEvents.push(acknowledgment)
      delete group.pendingLocalReconciliation
      group.state = 'COMPLETED'
      group.reason = null
      group.certificationMessage = 'Activity 24/25 certification complete · 17/17 native-only observations delivered · source evidence preserved · exerciseMinutes preserved pending vendor semantics'
      stage = 'FINAL_CERTIFICATION_VALIDATION_FAILED'
      await this.validate(group)
      report.status = 'COMPLETED'
      group.finalizationDiagnostics = structuredClone(report)
      stage = 'FINAL_CERTIFICATION_PERSISTENCE_FAILED'
      await this.save(group)
      return { status: 'ACTIVITY_CERTIFICATION_SUCCESS', delivered: 17, reason: null, group }
    } catch (error) {
      report.status = 'FAILED'
      const message = error instanceof Error ? error.message : String(error)
      report.code = report.firstFailedPredicateCode ?? stage
      report.firstFailedPredicateCode ??= stage
      report.failedPredicate ??= message
      throw new ActivityFinalizationError(report)
    }
  }
  private assertResumeManifest(group: Activity24_25CertificationSnapshot) {
    const eligible = group.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID)
    const excluded = group.children.filter((child) => child.observationId === ACTIVITY_EXCLUDED_ID)
    if (group.certificationGroupId !== ACTIVITY_VC17_GROUP || group.acquisitionSessionId !== ACTIVITY_VC17_SESSION
      || group.selectedType24SourceEnvelopeId !== ACTIVITY_VC17_SUMMARY
      || !['CAPTURED', 'COMPLETED'].includes(group.state) || eligible.length !== 17 || excluded.length !== 1
      || ACTIVITY_RESUME_IDS.some((id) => eligible.filter((child) => child.observationId === id).length !== 1)
      || excluded[0].native.metricType !== 'DAILY_EXERCISE_MINUTES' || excluded[0].native.vendorField !== 'exerciseMinutes'
      || eligible.some((child) => !['DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES', 'DAILY_GOAL_COMPLETION',
        'DETAILED_ACTIVITY_EPOCH', 'DETAILED_ACTIVITY_STEPS_TOTAL', 'DETAILED_ACTIVITY_DISTANCE', 'DETAILED_ACTIVITY_CALORIES'].includes(child.payload.metricType ?? ''))) {
      throw new Error('Activity recovery requires the exact saved VC17 certification and 17 existing eligible observation IDs; no physical fallback.')
    }
    for (const [metric, summary, detail] of [['steps', 105, 105], ['stepsSlots', 105, 105],
      ['calories', 2.86, 2.85], ['distance', 0.06, 0.04]] as const) {
      const row = group.overlapAnalysis.find((item) => item.metric === metric)
      if (!row || row.type24Value !== summary || row.type25Aggregate === null
        || Math.abs(row.type25Aggregate - detail) > 1e-9 || row.canonicalAuthority !== 'NONE_UNTIL_SEMANTICS_CONFIRMED') {
        throw new Error('VC17 overlap findings changed; delivery blocked.')
      }
    }
  }
  private async verifyQueueChild(group: Activity24_25CertificationSnapshot, child: ActivityChild) {
    const row = await this.deps.queue.getRecord(child.observationId)
    this.assertScope(group.context)
    if (row && (row.ownerUserId !== group.context.scope.accountId || row.sourceEnvelopeId !== child.sourceEnvelopeId
      || JSON.stringify(row.payload) !== child.payloadJson)) throw new Error('Activity queued payload/source evidence changed.')
    return row
  }
  private async inspectQueueChildren(group: Activity24_25CertificationSnapshot): Promise<ActivityQueueInspection[]> {
    const rows: ActivityQueueInspection[] = []
    for (const child of group.children) {
      const row = await this.deps.queue.getRecord(child.observationId)
      const json = await this.deps.queue.getPayloadJson!(child.observationId)
      this.assertScope(group.context)
      const payloadMatches = !!row && row.ownerUserId === group.context.scope.accountId
        && row.sourceEnvelopeId === child.sourceEnvelopeId && json === child.payloadJson
        && JSON.stringify(row.payload) === child.payloadJson
      const eligible = child.observationId !== ACTIVITY_EXCLUDED_ID
      const suppressed = row?.payload.rawSourceMetadata?.certificationOnly === true
        && ['24', '25'].includes(row.payload.vendorDataType ?? '')
      const delayed = !!row?.nextAttemptAt && row.nextAttemptAt > new Date().toISOString()
      rows.push({
        observationId: child.observationId, exists: !!row, queueState: row?.state ?? null,
        nextAttemptAt: row?.nextAttemptAt ?? null, attemptCount: row?.attemptCount ?? null,
        claimedAt: row?.claimedAt ?? null, lastAttemptAt: row?.lastAttemptAt ?? null,
        lastErrorCode: row?.lastErrorCode ?? null, lastErrorMessage: row?.lastErrorMessage ?? null,
        batchId: row?.batchId ?? null, queueId: row?.queueId ?? null,
        payloadJsonPresent: json !== null, payloadFingerprint: json === null ? null : await transportFingerprint(json),
        savedPayloadFingerprint: child.payloadFingerprint, payloadMatches,
        certificationOnly: row?.payload.rawSourceMetadata?.certificationOnly === true,
        ordinaryClaimable: !!row && ['PENDING', 'RETRY_WAIT'].includes(row.state) && !delayed && !suppressed,
        retryDelayActive: delayed, certificationAutoDrainSuppressed: suppressed,
        certificationClaimable: eligible && payloadMatches && !!row && activityTransportClaimable(row),
        blockedReason: !eligible ? ACTIVITY_SEMANTIC_CONFLICT : !row ? 'QUEUE_ROW_MISSING'
          : !payloadMatches ? 'QUEUE_PAYLOAD_OR_SOURCE_CHANGED'
            : !activityTransportClaimable(row) ? `QUEUE_STATE_${row.state}` : null,
      })
    }
    return rows
  }
  private async resumeOnce(onStage?: CertificationFlushOptions['onStage']): Promise<ActivityInspection> {
    let group: Activity24_25CertificationSnapshot | null = null
    let verified = false
    const diagnostics: ActivityRecoveryDiagnostics = {
      stage: 'SAVED_EVIDENCE_VERIFICATION', code: null, savedEligibleIds: 0, queueRowsFound: 0,
      queueRowsReconstructed: 0, certificationClaimable: 0, excludedSemanticConflictRows: 0,
      inspectedAt: new Date().toISOString(), rowsBefore: [], rowsAfter: [],
    }
    try {
      group = await this.snapshot()
      if (!group) throw new Error('No saved VC17 Activity certification; resume never acquires.')
      diagnostics.savedEligibleIds = ACTIVITY_RESUME_IDS.filter((id) => group!.children.some((child) => child.observationId === id)).length
      await this.validate(group)
      this.assertResumeManifest(group)
      verified = true
      diagnostics.excludedSemanticConflictRows = 1
      if (group.state === 'COMPLETED') return this.inspectSaved()
      if (!this.deps.queue.removePreservedCertificationObservation || !this.deps.queue.getPayloadJson
        || !this.deps.queue.recoverActivityCertificationTransport) throw new Error('ACTIVITY_RECOVERY_API_UNAVAILABLE')
      const saved = group
      const before = JSON.stringify(saved)
      const pendingIds = ACTIVITY_RESUME_IDS.filter((id) => !saved.children.find((child) => child.observationId === id)!
        .receipts.some((receipt) => receipt.acknowledged && receipt.deploymentRevision === ACTIVITY_R5_REVISION))
      const report = pendingIds.length ? await this.deps.flush(pendingIds, {
        onStage, activityRecovery: true,
        prepare: async () => {
          diagnostics.stage = 'SAVED_EVIDENCE_REVERIFICATION'
          const current = await this.snapshot()
          if (!current || JSON.stringify(current) !== before) throw new Error('Saved certification changed before resume delivery.')
          await this.validate(saved)
          this.assertResumeManifest(saved)
          diagnostics.stage = 'QUEUE_INSPECTION'
          diagnostics.rowsBefore = await this.inspectQueueChildren(saved)
          diagnostics.queueRowsFound = diagnostics.rowsBefore.filter((row) => row.exists && row.observationId !== ACTIVITY_EXCLUDED_ID).length
          diagnostics.certificationClaimable = diagnostics.rowsBefore.filter((row) => row.certificationClaimable).length
          saved.recoveryDiagnostics = diagnostics
          await this.save(saved)
          const invalid = diagnostics.rowsBefore.find((row) => row.exists
            && (!row.payloadMatches || (pendingIds.some((id) => id === row.observationId) && !row.certificationClaimable)
              || row.observationId === ACTIVITY_EXCLUDED_ID && row.queueState === 'IN_FLIGHT'))
          if (invalid) throw new Error(`${invalid.blockedReason ?? 'QUEUE_LIVE_CLAIM'}: ${invalid.observationId}`)
          const excluded = saved.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)!
          excluded.exerciseMinutesUnitAuthoritative = false
          excluded.exerciseMinutesDeliveryEligible = false
          excluded.queueDisposition = ACTIVITY_SEMANTIC_CONFLICT
          excluded.queueState = null
          saved.resumePolicy = 'VC19_EXACT_R5_RECOVERY'
          saved.reason = null
          await this.save(saved)
          diagnostics.stage = 'TRANSPORT_RECOVERY'
          const recovery = await this.deps.queue.recoverActivityCertificationTransport!(pendingIds.map((id) => {
            const child = saved.children.find((item) => item.observationId === id)!
            return { observationId: id, payloadJson: child.payloadJson, payloadFingerprint: child.payloadFingerprint,
              sourceEnvelopeId: child.sourceEnvelopeId }
          }))
          diagnostics.queueRowsReconstructed = recovery.reconstructed
          await this.deps.queue.removePreservedCertificationObservation!(excluded.observationId, excluded.payloadJson)
          diagnostics.rowsAfter = await this.inspectQueueChildren(saved)
          diagnostics.certificationClaimable = diagnostics.rowsAfter.filter((row) => row.certificationClaimable).length
          if (pendingIds.some((id) => !diagnostics.rowsAfter.some((row) => row.observationId === id && row.certificationClaimable))) {
            throw new Error('ACTIVITY_EXACT_CLAIM_UNAVAILABLE')
          }
          for (const id of pendingIds) {
            const child = saved.children.find((item) => item.observationId === id)!
            child.queueState = diagnostics.rowsAfter.find((row) => row.observationId === id)!.queueState
            child.queueDisposition = 'QUEUED'
            child.deliveryDisposition = 'PRESERVED_FOR_EXPLICIT_RETRY'
          }
          diagnostics.stage = 'EXACT_ID_DELIVERY'
          await this.save(saved)
        },
        validateResults: (event) => this.recoveryResultIds(saved, event),
        persistEvidence: (event) => this.record(saved, event),
      }) : { events: [], reason: null }
      for (const event of report.events) await this.record(saved, event)
      saved.reason = report.reason ?? report.events.find((event) => event.errorCode)?.errorCode ?? null
      for (const child of saved.children.filter((item) => item.observationId !== ACTIVITY_EXCLUDED_ID)) {
        const row = await this.verifyQueueChild(saved, child)
        child.queueState = row?.state ?? null
        child.queueDisposition = row?.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : row ? 'QUEUED'
          : child.receipts.some((receipt) => receipt.acknowledged) ? 'ACKNOWLEDGED_PURGED' : 'MISSING'
      }
      const delivered = saved.children.filter((child) => child.observationId !== ACTIVITY_EXCLUDED_ID
        && child.receipts.some((receipt) => receipt.acknowledged && receipt.deploymentRevision === ACTIVITY_R5_REVISION)).length
      if (delivered === 17 && !saved.reason) saved.state = 'COMPLETED'
      diagnostics.stage = saved.state === 'COMPLETED' ? 'COMPLETED' : 'DELIVERY_INCOMPLETE'
      diagnostics.code = saved.state === 'COMPLETED' ? null
        : saved.reason?.startsWith('ACTIVITY_') || saved.reason === 'ACK_PROCESSING_FAILED' || saved.reason === 'CANONICAL_RECOVERY_REQUIRED'
          ? saved.reason : saved.reason ? 'SENDER_BLOCKED_OR_FAILED' : 'UNRESOLVED_OBSERVATION_RESULTS'
      if (saved.state !== 'COMPLETED' && !saved.reason) saved.reason = 'Some Activity observations remain preserved for explicit retry.'
      saved.recoveryDiagnostics = diagnostics
      await this.save(saved)
      return this.inspectSaved()
    } catch (error) {
      diagnostics.code = `${diagnostics.stage}_FAILED`
      const message = error instanceof Error ? error.message : String(error)
      if (verified && group) {
        group.reason = `${diagnostics.code}: ${message}`
        group.recoveryDiagnostics = diagnostics
        await this.save(group)
      }
      throw new Error(`${activityRecoveryStatus(diagnostics)} · ${message}`)
    }
  }
  private async captureOnce(onStage?: CertificationFlushOptions['onStage']): Promise<ActivityInspection> {
    if (await this.snapshot()) return this.inspectSaved()
    const context = structuredClone(this.context())
    if (!context.ready || !context.physical || !context.native || !context.bleAddress) throw new Error('Activity capture requires a READY physical native V8.')
    const group: Activity24_25CertificationSnapshot = {
      kind: 'Activity24_25Certification', version: 1, certificationGroupId: crypto.randomUUID(), context,
      acquisitionSessionId: null, state: 'ACQUIRING', reason: null, selectedType24SourceEnvelopeId: null,
      type24: null, type25Group: [], physicalSources: [], summaryEligibility: [], acquisitionResults: null, detailedEpochs: [], selectedEpochIndexes: [],
      children: [], overlapAnalysis: [], events: [], responseContractVersion: null, deploymentRevision: null,
      deliveryPolicy: { concurrency: 1, batchSize: 100, canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' },
    }
    // A durable attempt boundary blocks reacquisition even if the process dies or certification fails.
    await this.save(group)
    try {
      const acquired = await this.deps.acquire()
      this.assertScope(context)
      group.acquisitionResults = structuredClone(acquired)
      group.acquisitionSessionId = acquired.acquisitionSessionId
      await this.save(group)
      const current = this.context()
      if (!current.ready || !current.physical || !current.native || current.bleAddress !== context.bleAddress
        || current.firmwareVersion !== context.firmwareVersion || current.sdkVersion !== context.sdkVersion) throw new Error('Activity physical context changed.')
      for (const id of [...new Set(acquired.results.flatMap((result) => result.sourceRecordEnvelopeIds ?? []))]) {
        const source = await this.source(context, id)
        if (source.record.sessionId !== acquired.acquisitionSessionId) throw new Error('Activity source belongs to another acquisition.')
        group.physicalSources.push(source)
      }
      group.physicalSources.sort((a, b) => a.entry.sequence - b.entry.sequence)
      await this.save(group)
      if (acquired.results.length !== 2 || !acquired.acquisitionSessionId || acquired.results.some((result, index) =>
        result.provider !== 'JCVITAL' || result.deviceId !== context.bleAddress || result.syncId !== acquired.acquisitionSessionId
        || result.vendorDataType !== String(24 + index) || !['COMPLETE', 'EMPTY_VALID'].includes(result.completionStatus))) {
        throw new Error('Incomplete physical Activity 24/25 acquisition sequence.')
      }
      group.summaryEligibility = summaryEligibility(group.physicalSources)
      const selectedId = group.summaryEligibility.find((candidate) => candidate.complete)?.sourceEnvelopeId
      group.type24 = group.physicalSources.find((source) => source.sourceEnvelopeId === selectedId) ?? null
      if (!group.type24) throw new Error(`No complete physical type24 record. ${JSON.stringify(group.summaryEligibility)}`)
      group.selectedType24SourceEnvelopeId = group.type24.sourceEnvelopeId
      const day = text(group.type24, 'date')
      group.type25Group = group.physicalSources.filter((source) =>
        source.record.vendorDataType === '25' && text(source, 'date').split(' ')[0] === day)
      await this.save(group)
      if (!group.type25Group.length || group.type25Group.length > 512 || group.type25Group.some((source) => !completeActivitySource(source))) {
        throw new Error('Missing, malformed or unbounded type25 source day (maximum 512 physical blocks).')
      }
      group.detailedEpochs = activityEpochs(group.type25Group)
      group.selectedEpochIndexes = sampleActivityEpochs(group.detailedEpochs)
      group.overlapAnalysis = activityOverlapAnalysis(group.type24, group.type25Group)
      const natives = acquired.results.flatMap((result) => result.observations)
      const select = async (source: ActivitySource, vendorField: string, slot: number | null = null) => {
        const matches = natives.filter((native) => native.provenance.sourceEnvelopeId === source.sourceEnvelopeId
          && native.vendorField === vendorField && native.sequenceNumber === slot)
        if (matches.length !== 1) throw new Error('Missing/duplicate exact normalized activity child.')
        const native = structuredClone(matches[0])
        const payload = await mapActivityCertificationObservation(context, source, native)
        const payloadJson = JSON.stringify(payload)
        group.children.push({
          observationId: payload.observationId, sourceEnvelopeId: source.sourceEnvelopeId, canonicalTarget: null,
          native, payload, payloadJson, payloadFingerprint: await sha256Hex(payloadJson), receipts: [],
          queueState: null, queueDisposition: 'NOT_ENQUEUED',
        })
      }
      for (const [type, vendorField] of ACTIVITY_MAPPING) {
        if (type === '24' && Object.hasOwn(group.type24.fields, vendorField)) await select(group.type24, vendorField)
      }
      for (const selected of group.selectedEpochIndexes) {
        const epoch = group.detailedEpochs[selected.index]
        await select(group.type25Group[epoch.sourceIndex], 'arraySteps', epoch.slotIndex)
      }
      const blockIds = new Set(group.children.filter((child) => child.native.vendorDataType === '25').map((child) => child.sourceEnvelopeId))
      for (const source of group.type25Group.filter((item) => blockIds.has(item.sourceEnvelopeId))) {
        for (const vendorField of ['detailMinterStep', 'distance', 'calories']) await select(source, vendorField)
      }
      if (!group.children.length || group.children.length > 100 || new Set(group.children.map((child) => child.observationId)).size !== group.children.length) {
        throw new Error('Invalid deterministic certification delivery selection.')
      }
      group.state = 'CAPTURED'
      await this.save(group)
      await this.validate(group)
      const report = await this.deps.flush(group.children.map((child) => child.observationId), {
        onStage,
        prepare: async () => {
          const rows = await this.deps.queue.enqueueMany(group.children.map((child) => child.payload),
            new Map(group.children.map((child) => [child.observationId, child.sourceEnvelopeId])))
          this.assertScope(context)
          for (const child of group.children) {
            const row = rows.find((item) => item.record.observationId === child.observationId)?.record
            if (!row || row.ownerUserId !== context.scope.accountId || row.sourceEnvelopeId !== child.sourceEnvelopeId
              || JSON.stringify(row.payload) !== child.payloadJson) throw new Error('Activity queue evidence mismatch.')
            child.queueState = row.state
            child.queueDisposition = 'QUEUED'
          }
          await this.save(group)
        },
        persistEvidence: (event) => this.record(group, event),
      })
      for (const event of report.events) await this.record(group, event)
      group.reason = report.reason ?? report.events.find((event) => event.errorCode)?.errorCode ?? null
      for (const child of group.children) {
        const row = await this.deps.queue.getRecord(child.observationId)
        if (row && (row.ownerUserId !== context.scope.accountId || row.sourceEnvelopeId !== child.sourceEnvelopeId
          || JSON.stringify(row.payload) !== child.payloadJson)) throw new Error('Activity queued payload changed.')
        child.queueState = row?.state ?? null
        child.queueDisposition = row?.state === 'ACKNOWLEDGED' ? 'ACKNOWLEDGED' : row ? 'QUEUED'
          : child.receipts.some((receipt) => receipt.acknowledged) ? 'ACKNOWLEDGED_PURGED' : 'MISSING'
      }
      await this.save(group)
    } catch (error) {
      group.state = 'STOPPED'
      group.reason = error instanceof Error ? error.message : String(error)
      await this.save(group)
      throw error
    }
    return this.inspectSaved()
  }
  private async record(group: Activity24_25CertificationSnapshot, event: BatchDeliveryEvent) {
    this.assertScope(group.context)
    const ids = new Set(group.children.map((child) => child.observationId))
    if (event.observationIds.some((id) => !ids.has(id))) throw new Error('Non-targeted row in activity delivery.')
    const diagnostics = this.deps.deliveryDiagnostics()
    const fingerprint = diagnostics.activeBatches.find((batch) => batch.batchId === event.batchId)
      ?? diagnostics.recentResponseShapes.find((batch) => batch.batchId === event.batchId)
    event.responseContractVersion ??= fingerprint?.responseContractVersion ?? null
    event.deploymentRevision ??= fingerprint?.deploymentRevision ?? null
    if (group.events.some((saved) => JSON.stringify(saved) === JSON.stringify(event))) return
    group.events.push(structuredClone(event))
    group.responseContractVersion = event.responseContractVersion ?? null
    group.deploymentRevision = event.deploymentRevision ?? null
    if (group.resumePolicy === 'VC19_EXACT_R5_RECOVERY') {
      let successful: readonly string[] = []
      try {
        if (event.errorCode === null && event.httpStatus && event.httpStatus >= 200 && event.httpStatus < 300) {
          successful = this.recoveryResultIds(group, event)
        }
      } catch (error) {
        group.reason = 'VC19_R5_RESPONSE_GATE_FAILED'
        await this.save(group)
        throw error
      }
      if (event.acknowledgedIds.some((id) => !successful.includes(id))) {
        throw new Error('ACTIVITY_INVALID_ACK_RESULT: non-successful result cannot be acknowledged.')
      }
      for (const child of group.children.filter((item) => event.observationIds.includes(item.observationId))) {
        if (!successful.includes(child.observationId)) {
          child.deliveryDisposition = 'PRESERVED_FOR_EXPLICIT_RETRY'
          continue
        }
        const result = event.results!.find((item) => item.observationId === child.observationId)!
        child.deliveryDisposition = 'NATIVE_ONLY_DELIVERY_CONFIRMED'
        child.deliveryTimestamp = event.completedAt ?? event.attemptedAt
        child.receipts.push({
          event: structuredClone(event), result: structuredClone(result), nativeObservationId: result.nativeObservationId!,
          sourceFingerprint: child.payload.rawSourceMetadata!.sourceFingerprint as string,
          payloadFingerprint: child.payloadFingerprint, responseContractVersion: group.responseContractVersion,
          deploymentRevision: group.deploymentRevision, acknowledged: event.acknowledgedIds.includes(child.observationId),
        })
      }
      await this.save(group)
      return
    }
    if (group.resumePolicy && event.httpStatus && event.httpStatus >= 200 && event.httpStatus < 300 && event.errorCode === null) {
      const results = event.results ?? []
      const valid = group.deploymentRevision === ACTIVITY_R5_REVISION && group.responseContractVersion === ACTIVITY_RESPONSE_CONTRACT
        && event.observationIds.length === 17 && ACTIVITY_RESUME_IDS.every((id) => event.observationIds.includes(id))
        && event.rejected === 0 && event.rejectedIds.length === 0 && !event.canonicalFailedIds?.length
        && (event.accepted ?? 0) + (event.duplicate ?? 0) === 17
        && event.accepted === results.filter((result) => result.status === 'accepted').length
        && event.duplicate === results.filter((result) => result.status === 'duplicate').length
        && results.length === 17 && ACTIVITY_RESUME_IDS.every((id) => results.filter((result) => result.observationId === id).length === 1)
        && results.every((result) => {
          const child = group.children.find((item) => item.observationId === result.observationId)
          return child && ['accepted', 'duplicate'].includes(result.status) && !!result.nativeObservationId?.trim()
            && result.canonicalStatus === 'not_applicable' && nativeOnlyResultTarget(result)
            && (result.status !== 'duplicate' || child.receipts.some((receipt) =>
              receipt.nativeObservationId === result.nativeObservationId && receipt.deploymentRevision === ACTIVITY_R5_REVISION
              && receipt.sourceFingerprint === child.payload.rawSourceMetadata?.sourceFingerprint
              && receipt.payloadFingerprint === child.payloadFingerprint))
        })
      if (!valid) {
        group.reason = 'VC18_R5_NATIVE_ONLY_RESPONSE_INVALID'
        await this.save(group)
        throw new Error('VC18 exact r5 revision/contract/native-only results or duplicate provenance mismatch; ACK/purge blocked.')
      }
    }
    for (const child of group.children) {
      const matches = event.results?.filter((result) => result.observationId === child.observationId) ?? []
      const result = matches.length === 1 ? matches[0] : null
      if (group.resumePolicy && (event.errorCode !== null || group.deploymentRevision !== ACTIVITY_R5_REVISION
        || group.responseContractVersion !== ACTIVITY_RESPONSE_CONTRACT || !result || !nativeOnlyResultTarget(result))) continue
      if (!result || !event.observationIds.includes(child.observationId) || !event.httpStatus
        || event.httpStatus < 200 || event.httpStatus >= 300 || event.rejectedIds.includes(child.observationId)
        || event.canonicalFailedIds?.includes(child.observationId) || !['accepted', 'duplicate'].includes(result.status)
        || result.canonicalStatus !== 'not_applicable' || !result.nativeObservationId?.trim()) continue
      child.receipts.push({
        event: structuredClone(event), result: structuredClone(result), nativeObservationId: result.nativeObservationId,
        sourceFingerprint: child.payload.rawSourceMetadata!.sourceFingerprint as string,
        payloadFingerprint: child.payloadFingerprint, responseContractVersion: group.responseContractVersion,
        deploymentRevision: group.deploymentRevision, acknowledged: event.acknowledgedIds.includes(child.observationId),
      })
    }
    await this.save(group)
    if (event.httpStatus && event.httpStatus >= 200 && event.httpStatus < 300 && event.errorCode === null) {
      const results = event.results ?? []
      const exact = results.length === event.observationIds.length
        && event.observationIds.every((id) => results.filter((result) => result.observationId === id).length === 1)
        && results.every((result) => event.observationIds.includes(result.observationId)
          && ['accepted', 'duplicate'].includes(result.status) && result.nativeObservationId?.trim()
          && result.canonicalStatus === 'not_applicable')
      if (!exact) throw new Error('Activity delivery requires one exact native-only result and a non-null NativeObservation ID per observation; ACK/purge blocked.')
    }
  }
  private recoveryResultIds(group: Activity24_25CertificationSnapshot, event: BatchDeliveryEvent): readonly string[] {
    const diagnostics = this.deps.deliveryDiagnostics()
    const fingerprint = diagnostics.activeBatches.find((batch) => batch.batchId === event.batchId)
      ?? diagnostics.recentResponseShapes.find((batch) => batch.batchId === event.batchId)
    if (fingerprint?.deploymentRevision !== ACTIVITY_R5_REVISION || fingerprint.responseContractVersion !== ACTIVITY_RESPONSE_CONTRACT
      || !event.httpStatus || event.httpStatus < 200 || event.httpStatus >= 300 || event.errorCode !== null
      || !event.observationIds.length || new Set(event.observationIds).size !== event.observationIds.length
      || event.observationIds.some((id) => !ACTIVITY_RESUME_IDS.some((approved) => approved === id))
      || event.results?.some((result) => !event.observationIds.includes(result.observationId))) {
      throw new Error('VC19 exact r5 revision/contract/batch mismatch; ACK/purge blocked.')
    }
    return event.observationIds.filter((id) => {
      const matches = event.results?.filter((result) => result.observationId === id) ?? []
      const result = matches.length === 1 ? matches[0] : null
      const child = group.children.find((item) => item.observationId === id)
      return child && result && ['accepted', 'duplicate'].includes(result.status) && !!result.nativeObservationId?.trim()
        && result.canonicalStatus === 'not_applicable' && nativeOnlyResultTarget(result)
        && !event.rejectedIds.includes(id) && !event.canonicalFailedIds?.includes(id)
        && !event.errors?.some((error) => error.observationId === id)
        && (result.status !== 'duplicate' || child.receipts.some((receipt) =>
          receipt.nativeObservationId === result.nativeObservationId && receipt.deploymentRevision === ACTIVITY_R5_REVISION
          && receipt.responseContractVersion === ACTIVITY_RESPONSE_CONTRACT
          && receipt.sourceFingerprint === child.payload.rawSourceMetadata?.sourceFingerprint
          && receipt.payloadFingerprint === child.payloadFingerprint))
    })
  }
  private async validate(group: Activity24_25CertificationSnapshot, validateLocalReceipts = true) {
    this.assertScope(group.context)
    for (const saved of group.physicalSources) {
      const current = await this.source(group.context, saved.sourceEnvelopeId)
      if (JSON.stringify(current) !== JSON.stringify(saved) || saved.record.sessionId !== group.acquisitionSessionId) throw new Error('Saved source/ancestry/fingerprint changed.')
    }
    if (!group.type24 || !group.type25Group.length) {
      if (group.children.length) throw new Error('Saved activity source group incomplete.')
      return
    }
    if (group.resumePolicy) {
      this.assertResumeManifest(group)
      const excluded = group.children.find((child) => child.observationId === ACTIVITY_EXCLUDED_ID)!
      if (!['VC18_EXACT_R5', 'VC19_EXACT_R5_RECOVERY'].includes(group.resumePolicy) || excluded.exerciseMinutesUnitAuthoritative !== false
        || excluded.exerciseMinutesDeliveryEligible !== false || excluded.queueDisposition !== ACTIVITY_SEMANTIC_CONFLICT
        || excluded.queueState !== null || excluded.receipts.length) throw new Error('Invalid exerciseMinutes semantic-conflict evidence.')
    }
    const acquired = group.acquisitionResults
    if (!acquired || acquired.acquisitionSessionId !== group.acquisitionSessionId || acquired.results.length !== 2
      || acquired.results.some((result, index) => result.syncId !== group.acquisitionSessionId
        || result.vendorDataType !== String(24 + index) || result.provider !== 'JCVITAL'
        || result.deviceId !== group.context.bleAddress || !['COMPLETE', 'EMPTY_VALID'].includes(result.completionStatus))
      || JSON.stringify([...new Set(acquired.results.flatMap((result) => result.sourceRecordEnvelopeIds ?? []))].sort())
        !== JSON.stringify(group.physicalSources.map((source) => source.sourceEnvelopeId).sort())
      || group.physicalSources.some((source, index) => index > 0 && source.entry.sequence <= group.physicalSources[index - 1].entry.sequence)
      || JSON.stringify(group.deliveryPolicy) !== JSON.stringify({ concurrency: 1, batchSize: 100, canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' })) {
      throw new Error('Saved acquisition/source order/delivery policy changed.')
    }
    const dayGroup = group.physicalSources.filter((source) =>
      source.record.vendorDataType === '25' && text(source, 'date').split(' ')[0] === text(group.type24!, 'date'))
    const eligibility = summaryEligibility(group.physicalSources)
    if (group.selectedType24SourceEnvelopeId !== group.type24.sourceEnvelopeId
      || eligibility.find((candidate) => candidate.complete)?.sourceEnvelopeId !== group.type24.sourceEnvelopeId
      || JSON.stringify(eligibility) !== JSON.stringify(group.summaryEligibility) || !completeActivitySource(group.type24)
      || group.type25Group.length > 512 || group.type25Group.some((source) => !completeActivitySource(source))
      || !group.physicalSources.some((source) => JSON.stringify(source) === JSON.stringify(group.type24))
      || JSON.stringify(dayGroup) !== JSON.stringify(group.type25Group)
      || JSON.stringify(activityEpochs(group.type25Group)) !== JSON.stringify(group.detailedEpochs)
      || JSON.stringify(activityOverlapAnalysis(group.type24, group.type25Group)) !== JSON.stringify(group.overlapAnalysis)
      || JSON.stringify(sampleActivityEpochs(group.detailedEpochs)) !== JSON.stringify(group.selectedEpochIndexes)) throw new Error('Saved activity selection/overlap changed.')
    const expected: Array<{ source: ActivitySource; field: string; slot: number | null }> = ACTIVITY_MAPPING
      .filter(([type, name]) => type === '24' && Object.hasOwn(group.type24!.fields, name))
      .map(([, name]) => ({ source: group.type24!, field: name, slot: null }))
    const selectedBlocks = new Set<string>()
    for (const selected of group.selectedEpochIndexes) {
      const epoch = group.detailedEpochs[selected.index]
      const source = group.type25Group[epoch.sourceIndex]
      expected.push({ source, field: 'arraySteps', slot: epoch.slotIndex })
      selectedBlocks.add(source.sourceEnvelopeId)
    }
    for (const source of group.type25Group.filter((item) => selectedBlocks.has(item.sourceEnvelopeId))) {
      for (const name of ['detailMinterStep', 'distance', 'calories']) expected.push({ source, field: name, slot: null })
    }
    if (expected.length !== group.children.length || expected.some((item, index) =>
      group.children[index].sourceEnvelopeId !== item.source.sourceEnvelopeId
      || group.children[index].native.vendorField !== item.field || group.children[index].native.sequenceNumber !== item.slot)) {
      throw new Error('Saved deterministic delivery selection changed.')
    }
    // Validate every underlying normalized slot, including epochs not selected for delivery.
    for (const source of [group.type24, ...group.type25Group]) {
      const natives = acquired.results.flatMap((result) => result.observations).filter((native) => native.provenance.sourceEnvelopeId === source.sourceEnvelopeId)
      const expectedCount = source.record.vendorDataType === '25' ? 13
        : ACTIVITY_MAPPING.filter(([type, name]) => type === '24' && Object.hasOwn(source.fields, name)).length
      if (natives.length !== expectedCount || new Set(natives.map((native) => `${native.vendorField}:${native.sequenceNumber}`)).size !== expectedCount) {
        throw new Error('Underlying normalized activity record compacted or duplicated.')
      }
      for (const native of natives) activityCertificationPayload(group.context, source, native, '')
    }
    if (!group.children.length || group.children.length > 100 || new Set(group.children.map((child) => child.observationId)).size !== group.children.length) throw new Error('Invalid saved children.')
    for (const child of group.children) {
      const source = group.physicalSources.find((item) => item.sourceEnvelopeId === child.sourceEnvelopeId)
      if (!source || child.canonicalTarget !== null || child.observationId !== child.payload.observationId
        || JSON.stringify(activityCertificationPayload(group.context, source, child.native, child.observationId)) !== child.payloadJson
        || JSON.stringify(child.payload) !== child.payloadJson || await sha256Hex(child.payloadJson) !== child.payloadFingerprint) throw new Error('Saved activity mapping changed.')
      for (const receipt of validateLocalReceipts && !group.localReconciliationEvents?.length
        && !group.pendingLocalReconciliation ? child.receipts : []) {
        const event = receipt.event
        if (!group.events.some((saved) => JSON.stringify(saved) === JSON.stringify(event))
          || receipt.payloadFingerprint !== child.payloadFingerprint || receipt.sourceFingerprint !== source.sourceFingerprint
          || !event.observationIds.includes(child.observationId) || event.rejectedIds.includes(child.observationId)
          || event.canonicalFailedIds?.includes(child.observationId) || !event.httpStatus || event.httpStatus < 200 || event.httpStatus >= 300
          || receipt.acknowledged !== event.acknowledgedIds.includes(child.observationId)
          || event.results?.filter((result) => result.observationId === child.observationId).length !== 1
          || !event.results?.some((result) => JSON.stringify(result) === JSON.stringify(receipt.result))
          || !['accepted', 'duplicate'].includes(receipt.result.status) || receipt.result.canonicalStatus !== 'not_applicable'
          || receipt.nativeObservationId !== receipt.result.nativeObservationId || !receipt.nativeObservationId.trim()) throw new Error('Invalid exact activity receipt.')
        if (group.resumePolicy && (receipt.deploymentRevision !== ACTIVITY_R5_REVISION
          || receipt.responseContractVersion !== ACTIVITY_RESPONSE_CONTRACT || !nativeOnlyResultTarget(receipt.result))) {
          throw new Error('Saved VC18 receipt revision/canonical policy changed.')
        }
      }
    }
    const localEvents = validateLocalReceipts ? group.localReconciliationEvents ?? [] : []
    if (localEvents.length > 1) throw new Error('Invalid/duplicate local Activity reconciliation events.')
    for (const localEvent of localEvents) {
      const deliveryEvent = await this.selectDeliveredProductionEvent(group)
      if (localEvent.eventType !== 'LOCAL_CERTIFICATION_RECONCILIATION_COMPLETED'
        || localEvent.batchId !== ACTIVITY_PRODUCTION_BATCH_ID
        || localEvent.responseContractVersion !== ACTIVITY_RESPONSE_CONTRACT
        || localEvent.deploymentRevision !== ACTIVITY_R5_REVISION
        || localEvent.finalQueueDisposition !== 'ACKNOWLEDGED_PURGED'
        || localEvent.serverSubmission !== 'NONE_LOCAL_RECONCILIATION_ONLY'
        || !Number.isFinite(Date.parse(localEvent.finalizedAt))
        || JSON.stringify(localEvent.observationIds) !== JSON.stringify(ACTIVITY_RESUME_IDS)
        || localEvent.results.length !== 17 || localEvent.payloadFingerprints.length !== 17
        || !deliveryEvent || deliveryEvent.httpStatus !== 200 || deliveryEvent.accepted !== 17
        || deliveryEvent.duplicate !== 0 || deliveryEvent.rejected !== 0 || deliveryEvent.errors?.length !== 0
        || JSON.stringify(localEvent.results) !== JSON.stringify(deliveryEvent.results)) {
        throw new Error('Invalid local Activity reconciliation event.')
      }
      for (const id of ACTIVITY_RESUME_IDS) {
        const child = group.children.find((item) => item.observationId === id)
        const result = localEvent.results.filter((item) => item.observationId === id)
        const fingerprint = localEvent.payloadFingerprints.filter((item) => item.observationId === id)
        if (!child || result.length !== 1 || fingerprint.length !== 1
          || result[0].status !== 'accepted' || !result[0].nativeObservationId?.trim()
          || result[0].canonicalStatus !== 'not_applicable' || !nativeOnlyResultTarget(result[0]) || child.canonicalTarget !== null
          || fingerprint[0].payloadFingerprint !== child.payloadFingerprint
          || fingerprint[0].sourceFingerprint !== child.payload.rawSourceMetadata?.sourceFingerprint
          || fingerprint[0].nativeObservationId !== result[0].nativeObservationId
          || child.queueDisposition !== 'ACKNOWLEDGED_PURGED' || child.queueState !== null) {
          throw new Error(`Invalid local Activity reconciliation result: ${id}`)
        }
        if (child.nativeObservationId !== undefined && (child.nativeObservationId !== result[0].nativeObservationId
          || JSON.stringify(child.productionResult) !== JSON.stringify(result[0])
          || child.localAcknowledgment?.batchId !== localEvent.batchId
          || child.localAcknowledgment.disposition !== 'ACKNOWLEDGED')) {
          throw new Error(`Invalid persisted local Activity acknowledgment: ${id}`)
        }
      }
    }
    this.assertScope(group.context)
  }
  async inspectSaved(): Promise<ActivityInspection> {
    let group: Activity24_25CertificationSnapshot | null = null
    try {
      group = await this.snapshot()
      if (!group) return { status: 'NO_SAVED_ACTIVITY_CERTIFICATION', delivered: 0, reason: null, group: null }
      await this.validate(group)
      const saved = group
      const reconciledIds = new Set((saved.localReconciliationEvents ?? []).flatMap((event) => event.observationIds))
      const delivered = saved.children.filter((child) => {
        if (reconciledIds.has(child.observationId)) return true
        const latest = saved.events.filter((event) => event.observationIds.includes(child.observationId)).at(-1)
        return latest && child.receipts.some((receipt) => receipt.acknowledged && JSON.stringify(receipt.event) === JSON.stringify(latest))
      }).length
      const eligibleCount = group.children.filter((child) => child.queueDisposition !== ACTIVITY_SEMANTIC_CONFLICT).length
      const success = ['CAPTURED', 'COMPLETED'].includes(group.state) && eligibleCount > 0 && delivered === eligibleCount
        && (!group.resumePolicy || group.state === 'COMPLETED')
      if (group.state === 'COMPLETED' && (!success || group.deploymentRevision !== ACTIVITY_R5_REVISION
        || group.responseContractVersion !== ACTIVITY_RESPONSE_CONTRACT)) throw new Error('Invalid completed VC18 delivery evidence.')
      return { status: success ? 'ACTIVITY_CERTIFICATION_SUCCESS' : 'ACTIVITY_CERTIFICATION_INCOMPLETE', delivered, reason: group.reason, group }
    } catch (error) {
      return { status: 'ACTIVITY_CERTIFICATION_EVIDENCE_INVALID', delivered: 0, reason: error instanceof Error ? error.message : String(error), group }
    }
  }
  async exportSaved(): Promise<string> {
    const inspected = await this.inspectSaved()
    if (!inspected.group || inspected.status === 'ACTIVITY_CERTIFICATION_EVIDENCE_INVALID') throw new Error(inspected.reason ?? inspected.status)
    return serializeCertificationJson(inspected.group)
  }
}

export function activityCertificationStatus(inspection: ActivityInspection) {
  const group = inspection.group
  return inspection.status === 'ACTIVITY_CERTIFICATION_SUCCESS' && group
    ? group.certificationMessage ?? (group.resumePolicy
      ? 'Activity 24/25 certification saved · source evidence preserved · 17/17 native-only observations delivered · exerciseMinutes preserved pending vendor semantics'
      : `Activity 24/25 certification saved · 1 summary record + ${group.detailedEpochs.length} detailed epochs preserved · ${inspection.delivered}/${group.children.length} selected observations delivered`)
    : `${inspection.status}${inspection.reason ? `: ${inspection.reason}` : ''}${group?.recoveryDiagnostics ? ` · ${activityRecoveryStatus(group.recoveryDiagnostics)}` : ''}`
}

export function activityRecoveryStatus(diagnostics: ActivityRecoveryDiagnostics): string {
  return `stage=${diagnostics.stage} code=${diagnostics.code ?? 'NONE'} · saved eligible IDs = ${diagnostics.savedEligibleIds}/17`
    + ` · queue rows found = ${diagnostics.queueRowsFound}/17 · queue rows reconstructed = ${diagnostics.queueRowsReconstructed}/17`
    + ` · claimable by certification resume = ${diagnostics.certificationClaimable}/17`
    + ` · excluded semantic-conflict rows = ${diagnostics.excludedSemanticConflictRows}`
}
