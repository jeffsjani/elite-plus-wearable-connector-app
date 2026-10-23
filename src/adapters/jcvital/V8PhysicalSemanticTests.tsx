import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { QueueStats } from '../../services/storage/ObservationQueueStore'
import type { DeliveryDiagnostics } from '../../services/sync/ObservationBatchManager'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'
import { observationQueue } from '../../services/sync/ObservationQueue'
import type { JCVitalV8Plugin, SourceJournalScope, PhysicalSemanticNativeEvidence, WorkoutHistoryAcquisition } from './jcvitalV8Bridge'
import { JCVitalV8 } from './jcvitalV8Bridge'
import type { Type42ConnectedContext } from './Type42Certification'
import type { WorkoutHistoryCertificationSnapshot } from './WorkoutHistoryCertification'
import { decodeType29PhysicalPacket, wireSha256, type Type29PhysicalRecord } from './Type29PhysicalWire'
import { beginPhysicalTestIsolation, physicalTestIsolationSnapshot } from '../../services/diagnostics/PhysicalTestIsolation'
import { cleanupSavedPhysicalTest, requestPhysicalTestQuiescence } from '../../services/diagnostics/PhysicalTestQuiescence'
import { serializeCertificationJson } from './CertificationJsonExport'
import { copyPhysicalResultJson, requirePhysicalResultJson, savePhysicalResultJson } from './PhysicalResultExport'
import type { LiveWorkoutPacket } from './WorkoutTelemetry'
import { canSafelyRetryPhysicalAttempt, evidenceKey, failureResultText, isPhysicalResult, latestPhysicalResult, newPhysicalResult, type FailureResult, type PhysicalAttempt } from './PhysicalSemanticEvidence'
import { executePhysicalAttempt } from './PhysicalSemanticController'
import { recoverPhysicalFailure } from './PhysicalSemanticRecovery'
import { physicalFinalizationRead } from './PhysicalFinalizationTimeout'
import { finalizeSavedActivity, savedActivityReadyForExport } from './SavedActivityFinalizer'
import { persistSavedActivityFinalization, readSavedActivityFinalization } from './SavedActivityResultStore'
import {
  applyFinalizerProgress, applyFinalizerWatchdog, elapsedMs, FINALIZER_STILL_WAITING_MS, newActionId, newFinalizerDiagnostic,
  persistFinalizerDiagnostic, readFinalizerDiagnostic, sinceProgressMs, type FinalizerDiagnostic, type FinalizerProgress,
} from './SavedActivityFinalizerDiagnostic'
import { Type25AnchorTest } from './Type25AnchorTest'
import { canonicalizeAcquiredActivity, indexedDbActivityLedgerStore, JCVitalActivityCanonicalization, type ActivityIngestReport } from './ActivityCanonicalization'
import { jcvitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'

const FINALIZER_DIAGNOSTIC_FILENAME = 'ElitePlus V8 Saved Activity Finalizer Diagnostic.json'
const RESULT_VERSION = 1
const WORKOUT_DURATION_MS = 60_000
const ACTIVITY_TEST_FILENAME = 'ElitePlus V8 Activity 24-25 Semantic Test.json'
const WORKOUT_TEST_FILENAME = 'ElitePlus V8 Workout 29-82 Linkage Test.json'
const CONTROLLED_ACTIVITY_MODE = 0

type JsonObject = Record<string, unknown>
type SourceEntry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type ActivityResult = Awaited<ReturnType<JCVitalV8Plugin['syncActivityCertification']>>
type ActivityRecord = {
  envelopeId: string
  vendorDataType: '24' | '25'
  vendorDate: string | null
  localDate: string | null
  fields: Record<string, unknown>
  stepSlots: Array<{ recordIndex: number; slotIndex: number; raw: string; value: number | null }>
}
type StableQueueState = Omit<QueueStats, 'oldestPendingAgeMs' | 'oldestInFlightAgeMs'>
type StableSenderState = Pick<DeliveryDiagnostics,
  'configuredConcurrency' | 'effectiveConcurrency' | 'senderActive' | 'senderGeneration'
  | 'activeWorkerCount' | 'successfulBatches' | 'retryBatches' | 'failedBatches'
  | 'canonicalFailureCount' | 'canonicalRecoveryRequired' | 'lastCanonicalFailureBatchId'
  | 'lastCanonicalFailureAt' | 'retryScheduledAt' | 'startupQueueResumeAttempted' | 'startupQueueResumeStarted'>
  & { activeBatchIds: string[] }

export interface PhysicalTestIsolation {
  queueWrites: number
  base44Requests: number
  base44Writes: number
  digitalWellnessChanged: boolean
  nativeEvidence?: PhysicalSemanticNativeEvidence
  blockedOperations?: string[]
  queueRowsUnchanged?: boolean
  queueBefore: StableQueueState
  queueAfter: StableQueueState
  queueUnchanged: boolean
  acknowledgedBefore: number
  acknowledgedAfter: number
  acknowledgedUnchanged: boolean
  senderBefore: StableSenderState
  senderAfter: StableSenderState
  senderNotInvoked: boolean
  passed: boolean
}

export interface ActivitySemanticTestResult {
  kind: 'ACTIVITY_24_25_SEMANTIC_TEST'
  version: 1
  capturedAt: string
  sourceJournalUsed: boolean
  commands: { type24: boolean; type25: boolean }
  prohibitedCommandTypesIssued: []
  sameLocalDay: string | null
  localTimeZone: string
  type24: null | {
    date: string | null
    steps: number | null
    distanceRaw: unknown
    distanceNormalized: null
    caloriesRaw: unknown
    caloriesNormalized: null
    exerciseMinutes: unknown
    exerciseTime: unknown
    activeTime: unknown
    goal: unknown
    sourceEnvelopeId: string
  }
  type25: {
    date: string | null
    arraySteps: unknown[]
    recordCount: number
    epochCount: number
    stepSlots: ActivityRecord['stepSlots']
    summedEpochSteps: number | null
    distanceRaw: unknown[]
    distanceNormalized: null
    caloriesRaw: unknown[]
    caloriesNormalized: null
    sourceEnvelopeIds: string[]
  }
  reconciliation: {
    stepsDifference: number | null
    stepsPercentageDifference: number | null
    distanceDifference: number | null
    caloriesDifference: number | null
    timeWindowRelationship: string
    coverageWindow: { firstVendorDate: string | null; lastVendorDate: string | null }
    resetBoundary: 'UNKNOWN_NOT_PROVEN'
    duplicateRecordCount: number
    doubleCountAnalysis: string
  }
  classifications: {
    DAILY_STEPS: ActivityDisposition
    DAILY_DISTANCE: ActivityDisposition
    DAILY_CALORIES: ActivityDisposition
    DETAILED_ACTIVITY: ActivityDisposition
    EXERCISE_MINUTES: ActivityDisposition
  }
  isolation: PhysicalTestIsolation
  acquisition: ActivityResult
  sourceEvidence: readonly SourceEntry[]
}

export type ActivityDisposition = 'CANONICAL_CANDIDATE' | 'SOURCE_ONLY_VALIDATED' | 'PHYSICAL_EVIDENCE_INSUFFICIENT'

export interface WorkoutSemanticTestResult {
  kind: 'WORKOUT_29_82_LINKAGE_TEST'
  version: 1
  capturedAt: string
  sourceJournalUsed: boolean
  sessionLocalTimeZone: string
  sessionLocalStart: string | null
  sessionLocalEnd: string | null
  type82: {
    firstReceipt: string | null
    lastReceipt: string | null
    hrSamples: Array<{ receivedAt: string; packetSequence: number; heartRate: number }>
    packetSequence: Array<LiveWorkoutPacket>
    exerciseTimeProgression: Array<{ receivedAt: string; raw: string | number | null; seconds: number | null }>
    stepsProgression: Array<{ receivedAt: string; value: number | null }>
    caloriesProgression: Array<{ receivedAt: string; value: number | null }>
    sourceEnvelopeIds: string[]
    sourceCallbackIds: string[]
  }
  type29: {
    captured: boolean
    timestamp: string | null
    mode: string | null
    heartRate: string | null
    exerciseTime: string | null
    steps: string | null
    sportModelSpeed: string | null
    distance: string | null
    calories: string | null
    physicalRecords: number
    sdkRecordsRetainedNonAuthoritative: number
    sourceEnvelopeIds: string[]
    sourceCallbackIds: string[]
    decoder: 'DIRECT_CERTIFIED_26_BYTE_PHYSICAL_DECODER' | 'NOT_APPLIED_NO_PHYSICAL_RECORD'
    historyError: string | null
    sourceEvidence?: PhysicalWorkoutHistory
  }
  linkageEvidence: {
    temporalOverlap: boolean
    sameLocalDay: boolean
    timestampInsideSession: boolean
    durationDifferenceSeconds: number | null
    durationUnitProven: false
    stepDifference: number | null
    calorieDifference: number | null
    modeConsistency: boolean
    explicitSharedSessionIdentity: boolean
  }
  result: 'LINKAGE_PROVEN' | 'LINKAGE_PROBABLE_NOT_CANONICAL' | 'LINKAGE_NOT_PROVEN'
  canonicalMappingAllowed: false
  isolation: PhysicalTestIsolation
  historyCertification: null | {
    certificationGroupId: string
    state: WorkoutHistoryCertificationSnapshot['state']
    acquisitionSyncId: string | null
    sourceEnvelopeIds: string[]
  }
}

function object(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonObject : {}
}

function unwrap(value: unknown): unknown {
  const item = object(value)
  return typeof item.type === 'string' && Object.hasOwn(item, 'value') ? item.value : value
}

function mapFields(value: unknown): Record<string, unknown> {
  const map = object(value)
  if (map.type !== 'Map' || !Array.isArray(map.entries)) return {}
  const result: Record<string, unknown> = {}
  for (const rawEntry of map.entries) {
    const entry = object(rawEntry)
    const key = unwrap(entry.key)
    if (typeof key === 'string') result[key] = unwrap(entry.value)
  }
  return result
}

function finiteNumber(value: unknown): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  if (typeof value === 'string' && !/^-?\d+(?:\.\d+)?$/.test(value.trim())) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function localDate(value: string | null): string | null {
  if (!value) return null
  const normalized = value.trim().replace(/[/.]/g, '-')
  const match = normalized.match(/^(\d{4}-\d{2}-\d{2})/)
  return match?.[1] ?? null
}

function activityRecord(entry: SourceEntry): ActivityRecord {
  const envelope = JSON.parse(entry.envelopeJson) as JsonObject
  const vendorDataType = String(envelope.vendorDataType)
  if (vendorDataType !== '24' && vendorDataType !== '25') {
    throw new Error(`Unexpected vendor data type in activity test journal: ${vendorDataType}`)
  }
  const fields = mapFields(envelope.sdkSnapshot)
  const date = typeof fields.date === 'string' ? fields.date : null
  const slots = vendorDataType === '25' && typeof fields.arraySteps === 'string'
    ? fields.arraySteps.trim().split(/\s+/).map((raw, slotIndex) => ({
      recordIndex: Number(envelope.recordIndex) || 0,
      slotIndex,
      raw,
      value: /^\d+$/.test(raw) ? Number(raw) : null,
    }))
    : []
  return {
    envelopeId: entry.envelopeId,
    vendorDataType,
    vendorDate: date,
    localDate: localDate(date),
    fields,
    stepSlots: slots,
  }
}

function stableQueue(stats: QueueStats): StableQueueState {
  const { oldestPendingAgeMs: _pendingAge, oldestInFlightAgeMs: _inFlightAge, ...stable } = stats
  return stable
}

function stableSender(diagnostics: DeliveryDiagnostics): StableSenderState {
  return {
    configuredConcurrency: diagnostics.configuredConcurrency,
    effectiveConcurrency: diagnostics.effectiveConcurrency,
    senderActive: diagnostics.senderActive,
    senderGeneration: diagnostics.senderGeneration,
    activeWorkerCount: diagnostics.activeWorkerCount,
    successfulBatches: diagnostics.successfulBatches,
    retryBatches: diagnostics.retryBatches,
    failedBatches: diagnostics.failedBatches,
    canonicalFailureCount: diagnostics.canonicalFailureCount,
    canonicalRecoveryRequired: diagnostics.canonicalRecoveryRequired,
    lastCanonicalFailureBatchId: diagnostics.lastCanonicalFailureBatchId,
    lastCanonicalFailureAt: diagnostics.lastCanonicalFailureAt,
    retryScheduledAt: diagnostics.retryScheduledAt,
    startupQueueResumeAttempted: diagnostics.startupQueueResumeAttempted,
    startupQueueResumeStarted: diagnostics.startupQueueResumeStarted,
    activeBatchIds: diagnostics.activeBatches.map((batch) => batch.batchId).sort(),
  }
}

async function captureIsolation() {
  const [queue, delivery] = await Promise.all([
    physicalFinalizationRead(observationQueue.getQueueStats(), 'Queue isolation totals'),
    Promise.resolve(observationBatchManager.getDeliveryDiagnostics()),
  ])
  return {
    queue: stableQueue(queue), sender: stableSender(delivery),
    owner: observationQueue.getOwnerUserId(),
    effects: physicalTestIsolationSnapshot(),
  }
}

async function finishIsolation(
  before: Awaited<ReturnType<typeof captureIsolation>>,
  nativeEvidence: PhysicalSemanticNativeEvidence,
): Promise<PhysicalTestIsolation> {
  const after = await captureIsolation()
  const queueWrites = after.effects.counts.queue - before.effects.counts.queue
  const queueUnchanged = before.owner === after.owner && queueWrites === 0 && JSON.stringify(before.queue) === JSON.stringify(after.queue)
  const senderUnchanged = JSON.stringify(before.sender) === JSON.stringify(after.sender)
  const acknowledgedUnchanged = before.queue.acknowledged === after.queue.acknowledged
  const senderNotInvoked = senderUnchanged && !before.sender.senderActive && !after.sender.senderActive
    && before.sender.activeWorkerCount === 0 && after.sender.activeWorkerCount === 0
  const base44Requests = after.effects.counts.base44 - before.effects.counts.base44
  const digitalWellnessChanged = !nativeEvidence.digitalWellnessUnchanged
  return {
    queueWrites,
    base44Requests,
    base44Writes: base44Requests,
    digitalWellnessChanged,
    nativeEvidence,
    blockedOperations: after.effects.blocked,
    queueBefore: before.queue,
    queueAfter: after.queue,
    queueUnchanged,
    acknowledgedBefore: before.queue.acknowledged,
    acknowledgedAfter: after.queue.acknowledged,
    acknowledgedUnchanged,
    senderBefore: before.sender,
    senderAfter: after.sender,
    senderNotInvoked,
    passed: queueUnchanged && acknowledgedUnchanged && senderNotInvoked
      && queueWrites === 0 && base44Requests === 0 && !digitalWellnessChanged && nativeEvidence.commandsAllowed
      && !after.effects.blocked.some((operation) => operation !== 'sender'),
  }
}

function requireIdleDelivery(state: Awaited<ReturnType<typeof captureIsolation>>): void {
  if (state.sender.senderActive || state.sender.activeWorkerCount > 0
    || state.queue.inFlight > 0 || state.effects.senderPause !== 'PHYSICAL_TEST_QUIESCED') {
    throw Object.assign(new Error('Queue or sender is active. Wait for delivery to become idle; do not purge or alter the queue.'), {
      code: 'ISOLATION_DELIVERY_NOT_IDLE',
    })
  }
}

function numericTotal(records: readonly ActivityRecord[], field: string): number | null {
  const numbers = records.map((record) => finiteNumber(record.fields[field]))
  return numbers.length && numbers.every((value): value is number => value !== null)
    ? numbers.reduce((sum, value) => sum + value, 0)
    : null
}

export function buildActivitySemanticReport(
  acquisition: ActivityResult,
  sourceEntries: readonly SourceEntry[],
  isolation: PhysicalTestIsolation,
  capturedAt = new Date().toISOString(),
): ActivitySemanticTestResult {
  const results = acquisition.results
  if (results.some((result) => result.vendorDataType !== '24' && result.vendorDataType !== '25')) {
    throw new Error('Activity acquisition returned a prohibited vendor data type.')
  }
  const records = sourceEntries.map(activityRecord)
  const type24Records = records.filter((record) => record.vendorDataType === '24')
  const type25Records = records.filter((record) => record.vendorDataType === '25')
  const overlappingDays = [...new Set(type24Records.map((record) => record.localDate).filter((date): date is string => !!date))]
    .filter((date) => type25Records.some((record) => record.localDate === date))
    .sort()
  const sameDay = overlappingDays.at(-1) ?? null
  const summary = sameDay ? type24Records.find((record) => record.localDate === sameDay) ?? null : null
  const details = sameDay ? type25Records.filter((record) => record.localDate === sameDay) : []
  const slots = details.flatMap((record) => record.stepSlots)
  const summedEpochSteps = slots.length && slots.every((slot) => slot.value !== null)
    ? slots.reduce((sum, slot) => sum + slot.value!, 0)
    : null
  const summarySteps = finiteNumber(summary?.fields.step)
  const summaryDistance = finiteNumber(summary?.fields.distance)
  const summaryCalories = finiteNumber(summary?.fields.calories)
  const epochDistance = numericTotal(details, 'distance')
  const epochCalories = numericTotal(details, 'calories')
  const stepsDifference = summarySteps !== null && summedEpochSteps !== null ? summarySteps - summedEpochSteps : null
  const distanceDifference = summaryDistance !== null && epochDistance !== null ? summaryDistance - epochDistance : null
  const caloriesDifference = summaryCalories !== null && epochCalories !== null ? summaryCalories - epochCalories : null
  const exactDay = !!sameDay && details.length > 0 && !!summary
  const disposition = (condition: boolean, captured: boolean): ActivityDisposition =>
    !captured ? 'PHYSICAL_EVIDENCE_INSUFFICIENT'
      : condition && isolation.passed ? 'SOURCE_ONLY_VALIDATED' : 'PHYSICAL_EVIDENCE_INSUFFICIENT'
  const fingerprints = records.map((record) => JSON.stringify([record.vendorDataType, record.vendorDate, record.fields]))
  const duplicateRecordCount = fingerprints.length - new Set(fingerprints).size
  const commandTypes = new Set(results.filter((result) => result.nativeCommandWritten)
    .map((result) => result.vendorDataType))
  const type24 = summary ? {
    date: summary.vendorDate,
    steps: summarySteps,
    distanceRaw: summary.fields.distance ?? null,
    distanceNormalized: null,
    caloriesRaw: summary.fields.calories ?? null,
    caloriesNormalized: null,
    exerciseMinutes: summary.fields.exerciseMinutes ?? null,
    exerciseTime: summary.fields.ExerciseTime ?? null,
    activeTime: summary.fields.activeTime ?? null,
    goal: summary.fields.goal ?? null,
    sourceEnvelopeId: summary.envelopeId,
  } : null
  return {
    kind: 'ACTIVITY_24_25_SEMANTIC_TEST',
    version: RESULT_VERSION,
    capturedAt,
    sourceJournalUsed: sourceEntries.length > 0,
    commands: { type24: commandTypes.has('24'), type25: commandTypes.has('25') },
    prohibitedCommandTypesIssued: [],
    sameLocalDay: sameDay,
    localTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    type24,
    type25: {
      date: details[0]?.vendorDate ?? null,
      arraySteps: details.map((record) => record.fields.arraySteps ?? null),
      recordCount: details.length,
      epochCount: slots.length,
      stepSlots: slots,
      summedEpochSteps,
      distanceRaw: details.map((record) => record.fields.distance ?? null),
      distanceNormalized: null,
      caloriesRaw: details.map((record) => record.fields.calories ?? null),
      caloriesNormalized: null,
      sourceEnvelopeIds: details.map((record) => record.envelopeId),
    },
    reconciliation: {
      stepsDifference,
      stepsPercentageDifference: summarySteps === null || stepsDifference === null || summarySteps === 0
        ? summarySteps === 0 && stepsDifference === 0 ? 0 : null
        : stepsDifference / summarySteps * 100,
      distanceDifference,
      caloriesDifference,
      timeWindowRelationship: exactDay
        ? 'Same vendor date selected; timestamp cadence/window semantics remain unproven.'
        : 'No same-day Type24/Type25 record pair found.',
      coverageWindow: {
        firstVendorDate: details[0]?.vendorDate ?? null,
        lastVendorDate: details.at(-1)?.vendorDate ?? null,
      },
      resetBoundary: 'UNKNOWN_NOT_PROVEN',
      duplicateRecordCount,
      doubleCountAnalysis: 'Type24 is treated as the daily summary and Type25 as source detail only; values are compared, never added into canonical totals.',
    },
    classifications: {
      DAILY_STEPS: disposition(exactDay && duplicateRecordCount === 0 && stepsDifference === 0, !!summary && slots.length > 0),
      DAILY_DISTANCE: disposition(exactDay && duplicateRecordCount === 0 && distanceDifference === 0, !!summary && epochDistance !== null),
      DAILY_CALORIES: disposition(exactDay && duplicateRecordCount === 0 && caloriesDifference === 0, !!summary && epochCalories !== null),
      DETAILED_ACTIVITY: details.length ? 'SOURCE_ONLY_VALIDATED' : 'PHYSICAL_EVIDENCE_INSUFFICIENT',
      EXERCISE_MINUTES: summary?.fields.exerciseMinutes !== undefined
        ? 'SOURCE_ONLY_VALIDATED' : 'PHYSICAL_EVIDENCE_INSUFFICIENT',
    },
    isolation,
    acquisition,
    sourceEvidence: sourceEntries,
  }
}

type PacketWithScope = LiveWorkoutPacket
type WorkoutSession = Awaited<ReturnType<JCVitalV8Plugin['startWorkoutCapture']>>
export interface PhysicalWorkoutHistory {
  acquisition: WorkoutHistoryAcquisition
  entries: SourceEntry[]
  records: Array<Type29PhysicalRecord & { notificationEnvelopeIds: string[] }>
}

export async function acquirePhysicalWorkoutHistory(
  api: Pick<JCVitalV8Plugin, 'syncWorkoutHistoryCertification' | 'readWorkoutSourceEnvelope' | 'writeWorkoutCertificationSnapshot'>,
  context: Type42ConnectedContext,
  attempt?: PhysicalAttempt,
): Promise<PhysicalWorkoutHistory> {
  const scope = context.scope
  const snapshot: WorkoutHistoryCertificationSnapshot = {
    kind: 'WorkoutHistoryCertification', version: 1, certificationGroupId: crypto.randomUUID(), context,
    capturedAt: new Date().toISOString(), finalizedAt: null, state: 'ACQUIRING', limitation: null, reason: null,
    canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED', deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY',
    acquisition: null, evidence: null, stoppedSourceCapture: null,
  }
  const save = async () => {
    attempt?.before('SOURCE_JOURNAL_PERSISTENCE')
    const saved = await api.writeWorkoutCertificationSnapshot({ ...scope, json: JSON.stringify(snapshot) })
    if (!saved.saved) throw new Error('Physical workout source snapshot persistence not confirmed.')
  }
  await save()
  try {
    attempt?.before('COMMAND_REQUESTED')
    if (attempt) attempt.result.diagnostics.type29HistoryRequested = true
    const acquisition = await api.syncWorkoutHistoryCertification()
    snapshot.acquisition = acquisition
    snapshot.state = 'CAPTURED'
    await save()
    const sourceIds = [...new Set([
      ...acquisition.sourceCommandEnvelopeIds, ...acquisition.sourceCommandAckEnvelopeIds,
      ...acquisition.sourceNotificationEnvelopeIds, ...acquisition.sourceParserOutcomeEnvelopeIds,
      ...(acquisition.sourceCallbackEnvelopeIds ?? []), ...(acquisition.sourceRecordEnvelopeIds ?? []),
    ])]
    const entries = await Promise.all(sourceIds.map((envelopeId) => api.readWorkoutSourceEnvelope({ ...scope, envelopeId })))
    snapshot.stoppedSourceCapture = entries
    await save()
    attempt?.before('RESULT_CONSTRUCTION')
    const decoded = await decodePhysicalWorkoutHistory(acquisition, entries, scope)
    if (attempt) attempt.result.diagnostics.direct26ByteDecoderResult = { records: decoded.records.length, decoder: 'DIRECT_CERTIFIED_26_BYTE_PHYSICAL_DECODER' }
    return decoded
  } catch (error) {
    const failedStage = attempt?.stage
    snapshot.state = 'STOPPED'
    snapshot.reason = error instanceof Error ? error.message : String(error)
    if (attempt && failedStage === 'RESULT_CONSTRUCTION') {
      attempt.result.diagnostics.direct26ByteDecoderResult = { status: 'FAILED', message: snapshot.reason }
    }
    try { await save() }
    catch (cleanupError) {
      if (!attempt) throw new AggregateError([error, cleanupError], 'Workout source failure and failure-snapshot persistence failure')
      attempt.result.cleanup_errors.push(`Workout failure snapshot: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`)
    }
    if (attempt && failedStage) attempt.stage = failedStage
    throw error
  }
}

export async function decodePhysicalWorkoutHistory(
  acquisition: WorkoutHistoryAcquisition,
  entries: SourceEntry[],
  scope: SourceJournalScope,
): Promise<PhysicalWorkoutHistory> {
  if (acquisition.vendorDataType !== '29' || acquisition.sdkCommand !== 'GetActivityModeDataWithMode'
    || !acquisition.nativeCommandWritten || acquisition.partial
    || !['COMPLETE', 'EMPTY_VALID'].includes(acquisition.completionStatus)
    || !acquisition.sourceCommandEnvelopeIds.length
    || acquisition.sourceCommandEnvelopeIds.length !== acquisition.sourceCommandAckEnvelopeIds.length) {
    throw new Error('Physical Type29 acquisition incomplete or command ACK missing.')
  }
  const byId = new Map(entries.map((entry) => [entry.envelopeId, entry]))
  if (byId.size !== entries.length) throw new Error('Duplicate Type29 evidence envelope.')
  const expectedIds = [
    ...acquisition.sourceCommandEnvelopeIds, ...acquisition.sourceCommandAckEnvelopeIds,
    ...acquisition.sourceNotificationEnvelopeIds, ...acquisition.sourceParserOutcomeEnvelopeIds,
  ]
  for (const id of expectedIds) {
    const entry = byId.get(id)
    if (!entry) throw new Error('Type29 source evidence is missing.')
    const envelope = object(JSON.parse(entry.envelopeJson))
    if (envelope.envelopeId !== id || envelope.accountId !== scope.accountId
      || envelope.deviceScopeId !== scope.deviceScopeId || envelope.sessionId !== acquisition.syncId) {
      throw new Error('Type29 journal ancestry invalid.')
    }
    if (entry.rawBytesBase64) {
      const bytes = Uint8Array.from(atob(entry.rawBytesBase64), (character) => character.charCodeAt(0))
      if (bytes.length !== envelope.byteLength || await wireSha256(bytes) !== envelope.sha256) {
        throw new Error('Type29 raw source hash/length invalid.')
      }
    }
  }
  for (const [index, id] of acquisition.sourceCommandEnvelopeIds.entries()) {
    const command = byId.get(id)!
    const ack = byId.get(acquisition.sourceCommandAckEnvelopeIds[index])!
    const commandEnvelope = object(JSON.parse(command.envelopeJson))
    const ackEnvelope = object(JSON.parse(ack.envelopeJson))
    if (commandEnvelope.kind !== 'WORKOUT_COMMAND_REQUEST' || ackEnvelope.kind !== 'WORKOUT_COMMAND_WRITE_ACK'
      || ackEnvelope.parentEnvelopeId !== id || !command.rawBytesBase64
      || command.rawBytesBase64 !== ack.rawBytesBase64 || ack.sequence <= command.sequence) {
      throw new Error('Type29 command/ACK ancestry invalid.')
    }
  }
  const packets: Uint8Array[] = []
  const notificationIds = acquisition.sourceNotificationEnvelopeIds
  if (!notificationIds.length) throw new Error('No journaled Type29 packets.')
  let previousSequence = 0
  for (const envelopeId of notificationIds) {
    const entry = byId.get(envelopeId)
    if (!entry?.rawBytesBase64) throw new Error('Type29 raw notification is missing.')
    const envelope = object(JSON.parse(entry.envelopeJson))
    const bytes = Uint8Array.from(atob(entry.rawBytesBase64), (character) => character.charCodeAt(0))
    if (envelope.accountId !== scope.accountId || envelope.deviceScopeId !== scope.deviceScopeId
      || envelope.kind !== 'BLE_NOTIFICATION' || envelope.sessionId !== acquisition.syncId
      || envelope.envelopeId !== envelopeId || entry.sequence <= previousSequence
      || bytes[0] !== 0x5c || envelope.byteLength !== bytes.length
      || envelope.sha256 !== await wireSha256(bytes)) throw new Error('Type29 journal ancestry/hash/order invalid.')
    previousSequence = entry.sequence
    packets.push(bytes)
  }
  const totalBytes = packets.reduce((sum, packet) => sum + packet.length, 0)
  const combined = new Uint8Array(totalBytes)
  let offset = 0
  for (const packet of packets) {
    combined.set(packet, offset)
    offset += packet.length
  }
  if (combined.at(-2) !== 0x5c || combined.at(-1) !== 0xff) throw new Error('Type29 physical terminal is missing.')
  const records = totalBytes === 2 ? [] : (await decodeType29PhysicalPacket(combined)).records
  return {
    acquisition, entries,
    records: records.map((record) => ({ ...record, notificationEnvelopeIds: [...notificationIds] })),
  }
}

type ActivityTestApi = Pick<JCVitalV8Plugin, 'syncActivityCertification' | 'readSourceEnvelope'>
type WorkoutLiveTestApi = {
  addWorkoutPacketListener(listener: (packet: LiveWorkoutPacket) => void): Promise<{ remove(): Promise<void> }>
  startWorkoutCapture(options: { activityMode: number }): Promise<WorkoutSession>
  stopWorkoutCapture(): Promise<WorkoutSession>
  getWorkoutCaptureStatus(): Promise<WorkoutSession>
}
const workoutLiveTestApi: WorkoutLiveTestApi = {
  addWorkoutPacketListener: (listener) => JCVitalV8.addListener('jcvitalWorkoutPacket', listener),
  startWorkoutCapture: (options) => JCVitalV8.startWorkoutCapture(options),
  stopWorkoutCapture: () => JCVitalV8.stopWorkoutCapture(),
  getWorkoutCaptureStatus: () => JCVitalV8.getWorkoutCaptureStatus(),
}

export async function acquireActivity24And25(api: ActivityTestApi, scope: SourceJournalScope, attempt?: PhysicalAttempt): Promise<{
  acquisition: ActivityResult
  sourceEntries: SourceEntry[]
}> {
  const acquisition = await api.syncActivityCertification()
  if (attempt) {
    attempt.result.diagnostics.activity = acquisition
    attempt.before('SOURCE_JOURNAL_PERSISTENCE')
  }
  if (acquisition.results.some((result) => result.vendorDataType !== '24' && result.vendorDataType !== '25')) {
    throw new Error('Activity 24/25 acquisition returned an unexpected vendor data type.')
  }
  const sourceIds = [...new Set(acquisition.results.flatMap((result) => result.sourceRecordEnvelopeIds ?? []))]
  const sourceEntries = await Promise.all(sourceIds.map((envelopeId) =>
    api.readSourceEnvelope({ ...scope, envelopeId })))
  const incomplete = acquisition.results.find((result) => !['COMPLETE', 'EMPTY_VALID'].includes(result.completionStatus))
  if (incomplete && attempt) {
    attempt.before('CALLBACK_COLLECTION')
    throw Object.assign(new Error(`Activity Type${incomplete.vendorDataType}: ${incomplete.completionStatus}`), {
      code: `ACTIVITY_${incomplete.completionStatus}`,
    })
  }
  return { acquisition, sourceEntries }
}

export async function captureControlledWorkout(
  api: WorkoutLiveTestApi,
  durationMs = WORKOUT_DURATION_MS,
  delay: (milliseconds: number) => Promise<void> = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds)),
  attempt?: PhysicalAttempt,
): Promise<{ started: WorkoutSession; stopped: WorkoutSession; packets: LiveWorkoutPacket[] }> {
  const packets: LiveWorkoutPacket[] = []
  const pendingPackets: LiveWorkoutPacket[] = []
  let acceptingPackets = true
  let captureSessionId: string | null = null
  let listener: { remove(): Promise<void> } | null = null
  let started: WorkoutSession | null = null
  let stopped: WorkoutSession | null = null
  try {
    listener = await api.addWorkoutPacketListener((packet) => {
      if (!acceptingPackets) return
      if (!captureSessionId) pendingPackets.push(packet)
      else if (packet.sessionId === captureSessionId) packets.push(packet)
    })
    started = await api.startWorkoutCapture({ activityMode: CONTROLLED_ACTIVITY_MODE })
    if (attempt) {
      attempt.result.diagnostics.workoutStartAcknowledged = started.status === 'RUNNING'
      attempt.result.diagnostics.workoutSession = started
      attempt.completed('COMMAND_WRITTEN')
      attempt.before('CALLBACK_COLLECTION')
    }
    if (started.status !== 'RUNNING' || !started.sessionId) throw new Error('V8 workout did not enter RUNNING.')
    captureSessionId = started.sessionId
    packets.push(...pendingPackets.filter((packet) => packet.sessionId === captureSessionId))
    pendingPackets.length = 0
    await delay(durationMs)
    if (attempt) {
      attempt.result.diagnostics.type82Packets = packets
      attempt.result.diagnostics.workoutStopRequested = true
      attempt.before('COMMAND_REQUESTED')
    }
    stopped = await api.stopWorkoutCapture()
    if (attempt) {
      attempt.result.diagnostics.workoutStopAcknowledged = stopped.status === 'STOPPED'
      attempt.completed('COMMAND_WRITTEN')
    }
    if (stopped.status !== 'STOPPED') throw new Error(`V8 workout did not stop normally (${stopped.status}).`)
  } catch (error) {
    if (started && !stopped) {
      try {
        const status = await api.getWorkoutCaptureStatus()
        if (status.status === 'RUNNING' || status.status === 'PAUSED') stopped = await api.stopWorkoutCapture()
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'Controlled workout failed and normal-stop cleanup failed; inspect the V8 workout state.')
      }
    }
    throw error
  } finally {
    acceptingPackets = false
    await listener?.remove()
  }
  if (!started || !stopped) throw new Error('Controlled workout did not produce a normal stop.')
  return { started, stopped, packets }
}

function numericVendorDate(value: string | null): number | null {
  if (!value) return null
  const parsed = Date.parse(value.replace(/\./g, '-'))
  return Number.isFinite(parsed) ? parsed : null
}

function localTimestamp(iso: string | null): string | null {
  if (!iso) return null
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : null
}

export function buildWorkoutSemanticReport(
  started: WorkoutSession,
  stopped: WorkoutSession,
  packets: readonly PacketWithScope[],
  history: WorkoutHistoryCertificationSnapshot | null,
  historyError: string | null,
  isolation: PhysicalTestIsolation,
  capturedAt = new Date().toISOString(),
  physicalHistory: PhysicalWorkoutHistory | null = null,
): WorkoutSemanticTestResult {
  const physical = physicalHistory?.records ?? history?.evidence?.physicalWire?.records ?? []
  const sdkRecords = history?.evidence?.records ?? []
  const startedAt = started.startedAt ? Date.parse(started.startedAt) : NaN
  const stoppedAt = stopped.stoppedAt ? Date.parse(stopped.stoppedAt) : NaN
  const elapsedSeconds = Number.isFinite(startedAt) && Number.isFinite(stoppedAt)
    ? (stoppedAt - startedAt) / 1000 : null
  const finalSteps = [...packets].reverse().find((packet) => packet.steps !== null)?.steps ?? null
  const finalCalories = [...packets].reverse().find((packet) => packet.calories !== null)?.calories ?? null
  const sessionLocalDate = started.startedAt ? localDate(new Date(started.startedAt).toLocaleString('sv-SE')) : null
  const scored = physical.map((record) => {
    const time = numericVendorDate(record.fields.date)
    const date = localDate(record.fields.date)
    const mode = finiteNumber(record.fields.sportModel)
    const steps = finiteNumber(record.fields.step)
    const stepDifference = steps !== null && finalSteps !== null ? steps - finalSteps : null
    const calorieDifference = finalCalories !== null ? record.exactFloat32.calories - finalCalories : null
    return {
      record,
      time,
      date,
      mode,
      stepDifference,
      calorieDifference,
      timestampInsideSession: time !== null && Number.isFinite(startedAt) && Number.isFinite(stoppedAt)
        && time >= startedAt && time <= stoppedAt,
    }
  })
  const exactCandidate = scored.find((item) => item.timestampInsideSession
    && item.mode === started.vendorActivityMode && item.stepDifference === 0 && item.calorieDifference === 0)
  const sameDayCandidate = scored.find((item) => item.date === sessionLocalDate
    && item.mode === started.vendorActivityMode && item.stepDifference === 0 && item.calorieDifference === 0)
  const chosen = exactCandidate?.record ?? sameDayCandidate?.record ?? physical[0]
  const fields = chosen?.fields
  const chosenEvidence = scored.find((item) => item.record === chosen)
  const timestampInsideSession = chosenEvidence?.timestampInsideSession ?? false
  const sameLocalDay = !!sessionLocalDate && chosenEvidence?.date === sessionLocalDate
  const modeConsistency = chosenEvidence?.mode !== null && chosenEvidence?.mode === started.vendorActivityMode
  const stepDifference = chosenEvidence?.stepDifference ?? null
  const calorieDifference = chosenEvidence?.calorieDifference ?? null
  const durationDifferenceSeconds = finiteNumber(fields?.ExerciseTime ?? null) !== null && elapsedSeconds !== null
    ? finiteNumber(fields?.ExerciseTime ?? null)! - elapsedSeconds : null
  const explicitSharedSessionIdentity = false
  const countersMatch = stepDifference === 0 && calorieDifference === 0
  const probable = timestampInsideSession && sameLocalDay && modeConsistency && countersMatch
    && packets.length > 0 && isolation.passed
  const result: WorkoutSemanticTestResult['result'] = explicitSharedSessionIdentity && probable
    ? 'LINKAGE_PROVEN'
    : probable ? 'LINKAGE_PROBABLE_NOT_CANONICAL' : 'LINKAGE_NOT_PROVEN'
  const sortedPackets = [...packets].sort((left, right) => left.packetSequence - right.packetSequence)
  const heartRates = sortedPackets.filter((packet) => packet.heartRate !== null)
  const dateValues = sortedPackets.map((packet) => Date.parse(packet.receivedAt)).filter(Number.isFinite)
  const historyFailure = historyError ?? history?.reason ?? null
  return {
    kind: 'WORKOUT_29_82_LINKAGE_TEST',
    version: RESULT_VERSION,
    capturedAt,
    sourceJournalUsed: !!physicalHistory || !!history?.acquisition || packets.some((packet) => !!packet.provenance?.sourceEnvelopeId),
    sessionLocalTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    sessionLocalStart: localTimestamp(started.startedAt),
    sessionLocalEnd: localTimestamp(stopped.stoppedAt),
    type82: {
      firstReceipt: dateValues.length ? new Date(Math.min(...dateValues)).toISOString() : null,
      lastReceipt: dateValues.length ? new Date(Math.max(...dateValues)).toISOString() : null,
      hrSamples: heartRates.map((packet) => ({
        receivedAt: packet.receivedAt, packetSequence: packet.packetSequence, heartRate: packet.heartRate!,
      })),
      packetSequence: sortedPackets,
      exerciseTimeProgression: sortedPackets.map((packet) => ({
        receivedAt: packet.receivedAt,
        raw: packet.exerciseTimeRaw,
        seconds: finiteNumber(packet.exerciseTimeRaw),
      })),
      stepsProgression: sortedPackets.map((packet) => ({ receivedAt: packet.receivedAt, value: packet.steps })),
      caloriesProgression: sortedPackets.map((packet) => ({ receivedAt: packet.receivedAt, value: packet.calories })),
      sourceEnvelopeIds: [...new Set(sortedPackets.map((packet) => packet.provenance?.sourceEnvelopeId).filter((id): id is string => !!id))],
      sourceCallbackIds: [...new Set(sortedPackets.map((packet) => packet.provenance?.sourceCallbackId).filter((id): id is string => !!id))],
    },
    type29: {
      captured: !!physicalHistory || !!history?.acquisition,
      timestamp: fields?.date ?? null,
      mode: fields?.sportModel ?? null,
      heartRate: fields?.heartRate ?? null,
      exerciseTime: fields?.ExerciseTime ?? null,
      steps: fields?.step ?? null,
      sportModelSpeed: fields?.sportModelSpeed ?? null,
      distance: fields?.distance ?? null,
      calories: fields?.calories ?? null,
      physicalRecords: physical.length,
      sdkRecordsRetainedNonAuthoritative: sdkRecords.length,
      sourceEnvelopeIds: [...new Set([
        ...physical.flatMap((record) => 'notificationEnvelopeIds' in record
          ? record.notificationEnvelopeIds : [record.notificationEnvelopeId, record.sdkRecordEnvelopeId]),
        ...(physicalHistory?.entries.map((entry) => entry.envelopeId) ?? []),
        ...(history?.acquisition?.sourceCommandEnvelopeIds ?? []),
        ...(history?.acquisition?.sourceCommandAckEnvelopeIds ?? []),
        ...(history?.acquisition?.sourceNotificationEnvelopeIds ?? []),
        ...(history?.acquisition?.sourceParserOutcomeEnvelopeIds ?? []),
        ...(history?.acquisition?.observations.map((item) => item.sourceEnvelopeId) ?? []),
      ])],
      sourceCallbackIds: [...new Set(history?.acquisition?.observations.map((item) => item.sourceCallbackId) ?? [])],
      decoder: physical.length ? 'DIRECT_CERTIFIED_26_BYTE_PHYSICAL_DECODER' : 'NOT_APPLIED_NO_PHYSICAL_RECORD',
      historyError: historyFailure,
      ...(physicalHistory ? { sourceEvidence: physicalHistory } : {}),
    },
    linkageEvidence: {
      temporalOverlap: timestampInsideSession,
      sameLocalDay,
      timestampInsideSession,
      durationDifferenceSeconds,
      durationUnitProven: false,
      stepDifference,
      calorieDifference,
      modeConsistency,
      explicitSharedSessionIdentity,
    },
    result,
    canonicalMappingAllowed: false,
    isolation,
    historyCertification: history ? {
      certificationGroupId: history.certificationGroupId,
      state: history.state,
      acquisitionSyncId: history.acquisition?.syncId ?? null,
      sourceEnvelopeIds: [...new Set([
        ...(history.acquisition?.sourceCommandEnvelopeIds ?? []),
        ...(history.acquisition?.sourceCommandAckEnvelopeIds ?? []),
        ...(history.acquisition?.sourceNotificationEnvelopeIds ?? []),
        ...(history.acquisition?.sourceParserOutcomeEnvelopeIds ?? []),
        ...(history.acquisition?.observations.map((item) => item.sourceEnvelopeId) ?? []),
      ])],
    } : null,
  }
}

function storageKey(kind: 'activity' | 'workout', scope: SourceJournalScope): string {
  return `v8PhysicalSemanticTest.v1:${kind}:${scope.accountId}:${scope.deviceScopeId}`
}

function attemptKey(kind: 'activity' | 'workout', scope: SourceJournalScope): string {
  return `${storageKey(kind, scope)}:attempted`
}

export function hasPhysicalTestAttempt(
  kind: 'activity' | 'workout',
  scope: SourceJournalScope,
  storage: Pick<Storage, 'getItem'> = localStorage,
): boolean {
  return storage.getItem(attemptKey(kind, scope)) === '1'
}

export function markPhysicalTestAttempt(
  kind: 'activity' | 'workout',
  scope: SourceJournalScope,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  storage.setItem(attemptKey(kind, scope), '1')
}

export function readSavedPhysicalTestResult<T>(
  kind: 'activity' | 'workout',
  scope: SourceJournalScope,
  storage: Pick<Storage, 'getItem'> = localStorage,
): T | null {
  const value = storage.getItem(storageKey(kind, scope))
  const saved: unknown = value ? JSON.parse(value) : null
  const progress = storage.getItem(evidenceKey(kind, scope))
  const checkpoint: unknown = progress ? JSON.parse(progress) : null
  return latestPhysicalResult(saved, checkpoint) as T | null
}

export function archivePhysicalTestResult(
  kind: 'activity' | 'workout', scope: SourceJournalScope, value: FailureResult,
  storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage,
) {
  if (!value.attempt_id) throw new Error('Cannot retain a physical retry without the original attempt ID.')
  const key = `${storageKey(kind, scope)}:attempt:${value.attempt_id}`
  if (storage.getItem(key) === null) storage.setItem(key, serializeCertificationJson(value))
}

export function persistPhysicalTestResult(
  kind: 'activity' | 'workout',
  scope: SourceJournalScope,
  value: unknown,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  if (isPhysicalResult(value) && value.attempt_id) {
    storage.setItem(`${storageKey(kind, scope)}:attempt:${value.attempt_id}`, serializeCertificationJson(value))
  }
  storage.setItem(storageKey(kind, scope), serializeCertificationJson(value))
}

export function physicalResultText(result: ActivitySemanticTestResult | WorkoutSemanticTestResult): string {
  const value = (item: unknown) => item === null || item === undefined ? 'UNPROVEN / NOT AVAILABLE'
    : typeof item === 'object' ? JSON.stringify(item) : String(item)
  const field = (name: string, item: unknown) => `  ${name}: ${value(item)}`
  const isolation = [
    `Queue writes: ${result.isolation.queueWrites}`, `Base44 writes: ${result.isolation.base44Writes}`,
    `Isolation: ${result.isolation.passed ? 'PASS' : 'FAIL'}`,
  ]
  if (result.kind === 'ACTIVITY_24_25_SEMANTIC_TEST') {
    return [
      'ACTIVITY 24/25 SEMANTIC TEST', '',
      `Type24 command: ${result.commands.type24 ? 'YES' : 'NO'}`,
      `Type25 command: ${result.commands.type25 ? 'YES' : 'NO'}`,
      `Same local day found: ${value(result.sameLocalDay)}`, '', 'Type24',
      ...Object.entries({
        date: result.type24?.date, steps: result.type24?.steps,
        'distance raw': result.type24?.distanceRaw, 'distance normalized': result.type24?.distanceNormalized,
        'calories raw': result.type24?.caloriesRaw, 'calories normalized': result.type24?.caloriesNormalized,
        exerciseMinutes: result.type24?.exerciseMinutes, ExerciseTime: result.type24?.exerciseTime, goal: result.type24?.goal,
      }).map(([name, item]) => field(name, item)),
      '', 'Type25',
      ...Object.entries({
        date: result.type25.date, 'epoch count': result.type25.epochCount, arraySteps: result.type25.arraySteps,
        'summed epoch steps': result.type25.summedEpochSteps, 'distance raw': result.type25.distanceRaw,
        'distance normalized': result.type25.distanceNormalized, 'calories raw': result.type25.caloriesRaw,
        'calories normalized': result.type25.caloriesNormalized,
      }).map(([name, item]) => field(name, item)),
      '', 'Reconciliation',
      ...Object.entries({
        'steps difference': result.reconciliation.stepsDifference,
        'steps percentage difference': result.reconciliation.stepsPercentageDifference,
        'distance difference': result.reconciliation.distanceDifference, 'calories difference': result.reconciliation.caloriesDifference,
        'time-window relationship': result.reconciliation.timeWindowRelationship, 'day/reset boundary': result.reconciliation.resetBoundary,
      }).map(([name, item]) => field(name, item)),
      'Normalized units, detailed cadence, and day/reset semantics are not established by matching raw totals.',
      '', ...Object.entries(result.classifications).map(([name, item]) => field(name, item)), '', ...isolation,
    ].join('\n')
  }
  return [
    'WORKOUT 29/82 LINKAGE TEST', '',
    `session local start: ${value(result.sessionLocalStart)}`, `session local end: ${value(result.sessionLocalEnd)}`,
    '', 'Type82',
    ...Object.entries({
      'first receipt': result.type82.firstReceipt, 'last receipt': result.type82.lastReceipt, 'HR samples': result.type82.hrSamples,
      'exerciseTime progression': result.type82.exerciseTimeProgression, 'steps progression': result.type82.stepsProgression,
      'calories progression': result.type82.caloriesProgression,
    }).map(([name, item]) => field(name, item)),
    '', 'Type29',
    ...Object.entries({
      timestamp: result.type29.timestamp, mode: result.type29.mode, HR: result.type29.heartRate,
      ExerciseTime: result.type29.exerciseTime, steps: result.type29.steps, sportModelSpeed: result.type29.sportModelSpeed,
      distance: result.type29.distance, calories: result.type29.calories,
    }).map(([name, item]) => field(name, item)),
    '', 'linkage evidence',
    ...Object.entries({
      'temporal overlap': result.linkageEvidence.temporalOverlap, 'duration difference': result.linkageEvidence.durationDifferenceSeconds,
      'step difference': result.linkageEvidence.stepDifference, 'calorie difference': result.linkageEvidence.calorieDifference,
      'mode consistency': result.linkageEvidence.modeConsistency,
    }).map(([name, item]) => field(name, item)),
    'Duration difference is a tentative seconds comparison; vendor duration units remain unproven.',
    '', `result: ${result.result}`, '', ...isolation,
  ].join('\n')
}

export type PhysicalSemanticEligibility = {
  ready: boolean
  authenticatedOwner: string | null
  connectorOwner: string | null
  journalScope: SourceJournalScope | null
  sourceJournalBound: boolean
  connectionBusy: boolean
  productionSyncActive: boolean
  physicalTestActive: boolean
  workoutControlAvailable: boolean
}

export function V8PhysicalSemanticTests({
  context, ownerUserId, eligibility, setBusy, workoutActive, onTestActiveChange,
}: {
  context: Type42ConnectedContext | null
  ownerUserId: string
  eligibility: PhysicalSemanticEligibility
  setBusy(value: boolean): void
  workoutActive: boolean
  onTestActiveChange(active: boolean): void
}) {
  const [activityResult, setActivityResult] = useState<ActivitySemanticTestResult | FailureResult | null>(null)
  const [activityCanonicalReports, setActivityCanonicalReports] = useState<ActivityIngestReport[] | null>(null)
  const activityCanonical = useMemo(() => new JCVitalActivityCanonicalization({
    owner: () => observationQueue.getOwnerUserId(),
    resolveDeviceId: (bleAddress) => jcvitalDeviceIdentityService.resolve(bleAddress),
    store: indexedDbActivityLedgerStore,
  }), [])
  const [activityAttempted, setActivityAttempted] = useState<boolean | null>(null)
  const [workoutResult, setWorkoutResult] = useState<WorkoutSemanticTestResult | FailureResult | null>(null)
  const [shown, setShown] = useState<'activity' | 'workout' | null>(null)
  const [status, setStatus] = useState('')
  const [copyFallback, setCopyFallback] = useState<{ kind: 'activity' | 'workout'; json: string } | null>(null)
  const [createdActivityAttempt, setCreatedActivityAttempt] = useState<string | null>(null)
  const [activityExecuting, setActivityExecuting] = useState<'first' | 'retry' | null>(null)
  const [nativeNotReady, setNativeNotReady] = useState(false)
  const [activityFinalizing, setActivityFinalizing] = useState(false)
  const [activityExportedJson, setActivityExportedJson] = useState<string | null>(null)
  const [finalizerDiagnostic, setFinalizerDiagnostic] = useState<FinalizerDiagnostic | null>(null)
  const [finalizerNow, setFinalizerNow] = useState(() => Date.now())
  const [finalizerShown, setFinalizerShown] = useState(false)
  const [finalizerExportStatus, setFinalizerExportStatus] = useState('')
  const [finalizerCopyFallback, setFinalizerCopyFallback] = useState<string | null>(null)
  const finalizerRef = useRef<FinalizerDiagnostic | null>(null)
  const finalizerActionInProcess = useRef<string | null>(null)
  const [workoutAttempted, setWorkoutAttempted] = useState<boolean | null>(null)
  const running = useRef(false)
  const [savedScope, setSavedScope] = useState<SourceJournalScope | null>(null)
  const accountId = context?.scope.accountId
  const deviceScopeId = context?.scope.deviceScopeId
  const liveScope = useMemo(() => accountId && deviceScopeId ? { accountId, deviceScopeId } : null, [accountId, deviceScopeId])
  const ownerAuthorized = Boolean(eligibility.authenticatedOwner?.trim() && ownerUserId === eligibility.authenticatedOwner)
  const scope = !ownerAuthorized ? null : liveScope?.accountId === ownerUserId ? liveScope
    : savedScope?.accountId === ownerUserId ? savedScope : null
  const activityJson = useMemo(() => activityResult ? serializeCertificationJson(activityResult) : null, [activityResult])
  const workoutJson = useMemo(() => workoutResult ? serializeCertificationJson(workoutResult) : null, [workoutResult])
  const clickState = useRef({ eligibility, context, scope, workoutActive, blockers: [] as string[] })

  useEffect(() => { setNativeNotReady(false) }, [eligibility.ready, context?.ready, accountId, deviceScopeId])

  useEffect(() => {
    if (finalizerActionInProcess.current) return
    const saved = readFinalizerDiagnostic(ownerUserId)
    finalizerRef.current = saved
    setFinalizerDiagnostic(saved)
  }, [ownerUserId])

  const finalizerRunning = finalizerDiagnostic?.outcome === 'RUNNING'
    && finalizerActionInProcess.current === finalizerDiagnostic.action_id
  useEffect(() => {
    if (!finalizerRunning) return
    const timer = setInterval(() => {
      const now = new Date()
      setFinalizerNow(now.getTime())
      const current = finalizerRef.current
      if (current && finalizerActionInProcess.current === current.action_id) {
        const next = applyFinalizerWatchdog(current, now)
        if (next !== current) commitFinalizer(next)
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [finalizerRunning])

  useEffect(() => {
    setCopyFallback(null)
    setCreatedActivityAttempt(null)
    setShown(null)
    if (!ownerAuthorized) {
      setSavedScope(null)
      return
    }
    try {
      const key = `v8PhysicalSemanticTest.scope.v1:${ownerUserId}`
      if (liveScope?.accountId === ownerUserId) {
        localStorage.setItem(key, JSON.stringify(liveScope))
        setSavedScope(liveScope)
      } else {
        const saved = localStorage.getItem(key)
        const parsed: SourceJournalScope | null = saved ? JSON.parse(saved) : null
        if (parsed && (parsed.accountId !== ownerUserId || typeof parsed.deviceScopeId !== 'string')) {
          throw new Error('Saved physical test scope is invalid.')
        }
        setSavedScope(parsed)
      }
    } catch (error) {
      setSavedScope(null)
      setStatus(`Physical test scope could not be restored: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [ownerAuthorized, ownerUserId, liveScope])

  useEffect(() => {
    if (!scope) {
      setActivityResult(null)
      setWorkoutResult(null)
      setActivityAttempted(null)
      setWorkoutAttempted(null)
      return
    }
    try {
      const savedActivity = readSavedPhysicalTestResult<ActivitySemanticTestResult | FailureResult>('activity', scope)
        ?? readBackup('activity', scope)
      setActivityResult(savedActivity)
      setActivityAttempted(hasPhysicalTestAttempt('activity', scope) || savedActivity !== null)
      const savedWorkout = readSavedPhysicalTestResult<WorkoutSemanticTestResult | FailureResult>('workout', scope)
        ?? readBackup('workout', scope)
      setWorkoutResult(savedWorkout)
      setWorkoutAttempted(hasPhysicalTestAttempt('workout', scope) || savedWorkout !== null)
    } catch (error) {
      setActivityResult(null)
      setWorkoutResult(null)
      setActivityAttempted(null)
      setWorkoutAttempted(null)
      setStatus(`Saved physical test result could not be read: ${error instanceof Error ? error.message : String(error)}`)
    }
  }, [scope])

  useEffect(() => {
    if (!scope) return
    let cancelled = false
    void readSavedActivityFinalization(scope).then((saved) => {
      if (!cancelled && saved) {
        setActivityResult((current) => !isPhysicalResult(current) || current.attempt_id === saved.attempt_id ? saved : current)
        setActivityAttempted(true)
      }
    }).catch((error: unknown) => {
      if (!cancelled) setStatus(`Saved Activity finalization restore failed: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { cancelled = true }
  }, [scope])

  async function runActivity(attempt: PhysicalAttempt, finish: () => Promise<PhysicalTestIsolation>) {
    if (!scope || !context) throw new Error('Authenticated connected V8 source-journal scope is required.')
    if (activityAttempted && !attempt.result.retry_of_attempt_id) throw new Error('The Type24/25 test is one-shot for this journal scope; inspect saved result/source evidence.')
    setStatus('Requesting only Type24 and Type25…')
    attempt.before('COMMAND_REQUESTED')
    const { acquisition, sourceEntries } = await acquireActivity24And25(JCVitalV8, scope, attempt)
    attempt.result.diagnostics.activity = acquisition
    // P1-2C: local canonicalization of the already-acquired Type24/25 results; the test result is unchanged.
    setActivityCanonicalReports(await canonicalizeAcquiredActivity(activityCanonical, scope, context, acquisition.results))
    attempt.result.source_journal_refs = sourceEntries.map((entry) => entry.envelopeId)
    attempt.completed('SOURCE_JOURNALED')
    attempt.before('ISOLATION_FINALIZATION')
    const isolation = await finish()
    attempt.before('RESULT_CONSTRUCTION')
    const result = buildActivitySemanticReport(acquisition, sourceEntries, isolation)
    retainIsolationFailure(attempt, result, isolation)
    return result
  }

  async function runWorkout(attempt: PhysicalAttempt, finish: () => Promise<PhysicalTestIsolation>) {
    if (!scope || !context) throw new Error('Authenticated connected V8 source-journal scope is required.')
    if (workoutAttempted && !attempt.result.retry_of_attempt_id) throw new Error('A Type29 history attempt is already saved; inspect existing source evidence instead.')
    setStatus('Starting a 60-second controlled V8 workout…')
    const previous = await JCVitalV8.readWorkoutCertificationSnapshot(scope)
    if (previous.json) throw new Error('A previous Type29 certification exists; inspect saved evidence instead of reacquiring.')
    let physicalHistory: PhysicalWorkoutHistory | null = null
    let historyError: string | null = null
    attempt.before('COMMAND_REQUESTED')
    attempt.result.diagnostics.workoutStartRequested = true
    const { started, stopped, packets } = await captureControlledWorkout(workoutLiveTestApi, undefined, undefined, attempt)
    attempt.result.diagnostics.workout = { started, stopped, packets }
    setStatus('Workout stopped; requesting Type29 history through the certified direct-wire path…')
    attempt.before('COMMAND_REQUESTED')
    try {
      physicalHistory = await acquirePhysicalWorkoutHistory(JCVitalV8, context, attempt)
    } catch (error) {
      historyError = error instanceof Error ? error.message : String(error)
      attempt.result.diagnostics.historyError = historyError
      throw error
    }
    attempt.before('ISOLATION_FINALIZATION')
    const isolation = await finish()
    attempt.before('RESULT_CONSTRUCTION')
    const result = buildWorkoutSemanticReport(started, stopped, packets, null, historyError, isolation,
      new Date().toISOString(), physicalHistory)
    retainIsolationFailure(attempt, result, isolation)
    return result
  }

  // `activityRetryOf` is the displayed result exactly when activitySafeRetryAvailable is true; ordinary runs pass null.
  async function run(kind: 'activity' | 'workout', activityRetryOf: FailureResult | null = null) {
    if (running.current) return
    const reasons = kind === 'activity' ? activityBlockers : workoutBlockers
    if (reasons.length) {
      setStatus(`BLOCKED — ${reasons.join(', ')}`)
      return
    }
    if (eligibility.productionSyncActive || workoutActive) {
      setStatus(`BLOCKED — ${eligibility.productionSyncActive ? 'PRODUCTION_SYNC_ACTIVE' : 'V8_WORKOUT_ACTIVE'}`)
      return
    }
    if (!context || !scope) {
      setStatus('BLOCKED — PHYSICAL_CONTEXT_NOT_RESOLVED')
      return
    }
    let previous: FailureResult | null = null
    try {
      const persisted = readSavedPhysicalTestResult<unknown>(kind, scope) ?? readBackup(kind, scope)
      if (kind === 'activity' && activityRetryOf) {
        // The retry link is the displayed qualifying failure; persisted storage must still hold that same attempt.
        if (!isPhysicalResult(persisted) || persisted.attempt_id !== activityRetryOf.attempt_id
          || !canSafelyRetryPhysicalAttempt(persisted) || persisted.test_type !== 'activity') {
          setStatus('BLOCKED — ACTIVITY_RETRY_EVIDENCE_CHANGED')
          return
        }
        previous = persisted
        archivePhysicalTestResult(kind, scope, previous)
      } else if (hasPhysicalTestAttempt(kind, scope) || persisted !== null) {
        if (kind === 'activity' || !canSafelyRetryPhysicalAttempt(persisted) || persisted.test_type !== kind) {
          setStatus(`BLOCKED — ${kind.toUpperCase()}_SCOPE_ALREADY_ATTEMPTED`)
          return
        }
        previous = persisted
        archivePhysicalTestResult(kind, scope, previous)
      }
    } catch (error) {
      setStatus(`Physical retry evidence could not be verified or retained: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    running.current = true
    if (kind === 'activity') setActivityExecuting(previous ? 'retry' : 'first')
    let active = false
    let effectBefore: ReturnType<typeof physicalTestIsolationSnapshot> | null = null
    let before: Awaited<ReturnType<typeof captureIsolation>> | null = null
    try {
      if (kind === 'activity' && previous) {
        const connection = await JCVitalV8.getConnectionState()
        const current = clickState.current
        if (connection.state !== 'READY') {
          setNativeNotReady(true)
          setStatus('BLOCKED — V8_NOT_READY')
          return
        }
        if (current.blockers.length || current.scope?.accountId !== scope.accountId
          || current.scope?.deviceScopeId !== scope.deviceScopeId
          || current.eligibility.productionSyncActive || current.workoutActive) {
          setStatus(`BLOCKED — ${current.blockers.join(', ') || 'OWNER_OR_DEVICE_STATE_CHANGED'}`)
          return
        }
      }
      setBusy(true)
      onTestActiveChange(true)
      active = true
      const initial = newPhysicalResult(kind, {
        v8_state: eligibility.ready ? 'READY' : 'UNKNOWN',
        authenticated_owner_resolved: authenticatedOwnerValid,
        owner_scope_resolved: ownerScopeResolved && !ownerScopeMismatch,
        journal_bound: sourceJournalBound, device_scope_resolved: deviceScopeResolved,
      })
      initial.retry_of_attempt_id = previous ? previous.attempt_id : null
      if (initial.retry_of_attempt_id) initial.diagnostics.retryOfAttempt = previous
      if (kind === 'activity') {
        initial.status = 'STARTING'
        initial.build = 'v60'
        initial.diagnostics.progress = 'Preparing isolated Activity test…'
      }
      const checkpoint = (value: FailureResult) => {
        localStorage.setItem(evidenceKey(kind, scope), serializeCertificationJson(value))
        if (kind === 'activity') setActivityResult(structuredClone(value))
      }
      const result = await executePhysicalAttempt(initial, {
        checkpoint,
        markAttempt: () => {
          checkpoint(initial)
          markPhysicalTestAttempt(kind, scope)
          if (kind === 'activity') {
            setActivityAttempted(true)
            setCreatedActivityAttempt(initial.attempt_id)
            setCopyFallback(null)
            setShown('activity')
          }
          else setWorkoutAttempted(true)
        },
        quiesce: (attempt) => {
          if (kind === 'activity') attempt.result.diagnostics.progress = 'Sender quiescence requested'
          setStatus(kind === 'activity' ? 'Preparing isolated Activity test…\nSender quiescence requested'
            : 'Preparing isolated test…\nWaiting for current saved-data upload to finish.')
          const coordinator = requestPhysicalTestQuiescence(observationBatchManager, observationQueue, scope.accountId,
            (inFlight) => {
              if (kind === 'activity') {
                attempt.result.diagnostics.progress = 'Waiting for active upload to finish…'
                checkpoint(attempt.result)
                setStatus(`Preparing isolated Activity test…\nSender quiescence requested\nCurrent in-flight rows: ${inFlight}\nWaiting for active upload to finish…`)
              } else setStatus(`Preparing isolated test…\nWaiting for current saved-data upload to finish.\nIn-flight batch: ${inFlight}`)
            })
          attempt.result.diagnostics.senderQuiescence = coordinator.evidence
          return {
            wait: async () => {
              await coordinator.wait()
              if (kind === 'activity') {
                attempt.result.diagnostics.progress = 'Sender quiesced'
                checkpoint(attempt.result)
              }
              setStatus(kind === 'activity' ? 'Sender quiesced' : 'Isolated test ready')
            },
            resume: () => {
              try { coordinator.resume() }
              finally {
                attempt.result.isolation_released_at = coordinator.evidence.isolation_released_at
                attempt.result.sender_resumed_at = coordinator.evidence.sender_resumed_at
              }
            },
          }
        },
        lock: () => {
          const release = beginPhysicalTestIsolation()
          if (kind === 'activity') setStatus('Sender quiesced\nIsolation acquired')
          return release
        },
        begin: (attemptId) => {
          if (kind === 'activity') {
            initial.status = 'RUNNING'
            initial.diagnostics.progress = 'Starting V8 Activity acquisition…'
            checkpoint(initial)
            setStatus('Sender quiesced\nIsolation acquired\nStarting V8 Activity acquisition…')
          }
          return JCVitalV8.beginPhysicalSemanticTest({ kind, attemptId })
        },
        end: () => JCVitalV8.endPhysicalSemanticTest(),
        readNative: async () => {
          const saved = await JCVitalV8.readPhysicalSemanticTestEvidence({ ...scope, kind })
          return saved.json ? JSON.parse(saved.json) as PhysicalSemanticNativeEvidence : null
        },
        preflight: async (attempt) => {
          effectBefore = physicalTestIsolationSnapshot()
          before = await captureIsolation()
          attempt.result.queue_before = { ...before.queue }
          requireIdleDelivery(before)
        },
        run: async (attempt, end) => {
          const finish = async () => {
            const native = await end()
            if (!before) throw new Error('Isolation baseline missing')
            return finishIsolation(before, native)
          }
          return kind === 'activity' ? runActivity(attempt, finish) : runWorkout(attempt, finish)
        },
        finalize: async (result) => {
          const effects = physicalTestIsolationSnapshot()
          result.base44_calls = effectBefore ? effects.counts.base44 - effectBefore.counts.base44 : null
          result.queue_delta = effectBefore ? effects.counts.queue - effectBefore.counts.queue : null
          const after = await observationQueue.getQueueStats()
          result.queue_after = { ...stableQueue(after) }
          result.ack_mutations = before ? after.acknowledged - before.queue.acknowledged : null
          const sender = observationBatchManager.getDeliveryDiagnostics()
          result.sender_calls = null
          result.diagnostics.senderGenerationDelta = before ? sender.senderGeneration - before.sender.senderGeneration : null
          result.diagnostics.deferredSenderLaunches = effects.blocked.filter((operation) => operation === 'sender').length
        },
        persist: (value) => persistPhysicalTestResult(kind, scope, value),
        backup: (value) => sessionStorage.setItem(evidenceKey(kind, scope), serializeCertificationJson(value)),
      })
      if (kind === 'activity') setActivityResult(result)
      else setWorkoutResult(result)
      setShown(kind)
      setStatus(result.status === 'FAILED' ? failureResultText(result) : `${kind} test complete; inspect the saved isolation evidence.`)
    } catch (error) {
      setStatus(`Physical test stopped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
        if (active) {
          onTestActiveChange(false)
          setBusy(false)
        }
        running.current = false
        if (kind === 'activity') setActivityExecuting(null)
    }
  }

  async function recover() {
    if (!scope || !ownerAuthorized || running.current) {
      setStatus('BLOCKED — AUTHENTICATED_OWNER_AND_SAVED_DEVICE_SCOPE_REQUIRED')
      return
    }
    running.current = true
    try {
      for (const kind of ['activity', 'workout'] as const) {
        if (kind === 'activity' && isPhysicalResult(activityResult) && activityResult.diagnostics.savedFinalization) {
          setShown('activity')
          continue
        }
        const recovered = await recoverPhysicalFailure(kind, scope, JCVitalV8)
        if (!recovered.result) {
          setStatus((previous) => `${previous}\n${kind}: NO_DURABLE_FAILURE_EVIDENCE\nInspected: ${recovered.inspected.join(', ')}\n${recovered.errors.join('\n')}`)
          continue
        }

        try { persistPhysicalTestResult(kind, scope, recovered.result) }
        catch (error) { recovered.result.persistence_errors.push(error instanceof Error ? error.message : String(error)) }
        if (kind === 'activity') { setActivityResult(recovered.result); setActivityAttempted(true) }
        else { setWorkoutResult(recovered.result); setWorkoutAttempted(true) }
        setShown(kind)
      }
    } catch (error) {
      setStatus(`Physical evidence recovery failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { running.current = false }
  }

  function commitFinalizer(next: FinalizerDiagnostic, sync = false) {
    finalizerRef.current = next
    const storageError = persistFinalizerDiagnostic(next)
    const shown = storageError && !next.last_error ? { ...next, last_error: `Diagnostic persistence failed: ${storageError}` } : next
    if (sync) flushSync(() => setFinalizerDiagnostic(shown))
    else setFinalizerDiagnostic(shown)
  }

  function updateFinalizer(actionId: string, update: (current: FinalizerDiagnostic) => FinalizerDiagnostic) {
    const current = finalizerRef.current
    if (current?.action_id === actionId) commitFinalizer(update(current))
  }

  function finalizerBlockers(): string[] {
    const blockers: string[] = []
    if (running.current) blockers.push('ANOTHER_PHYSICAL_TEST_ACTION_RUNNING')
    if (!ownerAuthorized) blockers.push('OWNER_NOT_AUTHORIZED')
    if (!scope) blockers.push('OWNER_DEVICE_SCOPE_UNAVAILABLE')
    if (!isPhysicalResult(activityResult)) blockers.push('SAVED_ACTIVITY_ATTEMPT_NOT_LOADED')
    else if (activityResult.test_type !== 'activity' || !activityResult.attempt_id) blockers.push('SAVED_ACTIVITY_ATTEMPT_ID_MISSING')
    if (eligibility.physicalTestActive) blockers.push('PHYSICAL_TEST_ACTIVE')
    if (eligibility.productionSyncActive) blockers.push('PRODUCTION_SYNC_ACTIVE')
    if (workoutActive) blockers.push('WORKOUT_ACTIVE')
    return blockers
  }

  /** Synchronous click receipt: persisted and rendered before any Source Journal or native read. */
  function requestActivityFinalizer() {
    const now = new Date()
    const active = finalizerActionInProcess.current
    if (active) {
      updateFinalizer(active, (current) => ({
        ...current, updated_at: now.toISOString(),
        ignored_clicks: [...current.ignored_clicks, { at: now.toISOString(), reason: 'FINALIZER_ALREADY_RUNNING' }],
      }))
      return
    }
    const saved = isPhysicalResult(activityResult) ? activityResult : null
    const receipt = newFinalizerDiagnostic({
      actionId: newActionId(), clickedAt: now, ownerUserId,
      attemptId: saved?.attempt_id ?? null, retryOfAttemptId: saved?.retry_of_attempt_id ?? null, scope,
    })
    const blockers = finalizerBlockers()
    setFinalizerNow(now.getTime())
    setFinalizerExportStatus('')
    if (blockers.length) {
      commitFinalizer({ ...receipt, outcome: 'BLOCKED', blockers, last_error: `BLOCKED — ${blockers.join(', ')}` }, true)
      setStatus('BLOCKED — SAVED_ACTIVITY_SCOPE_OR_EXCLUSIVE_CONTROL_REQUIRED')
      return
    }
    finalizerActionInProcess.current = receipt.action_id
    commitFinalizer(receipt, true)
    void finalizeActivity(receipt.action_id)
  }

  async function finalizeActivity(actionId: string) {
    if (running.current || !scope || !ownerAuthorized || !isPhysicalResult(activityResult)
      || eligibility.physicalTestActive || eligibility.productionSyncActive || workoutActive) {
      finalizerActionInProcess.current = null
      updateFinalizer(actionId, (current) => ({ ...current, outcome: 'BLOCKED', last_error: 'BLOCKED — guard changed before start' }))
      setStatus('BLOCKED — SAVED_ACTIVITY_SCOPE_OR_EXCLUSIVE_CONTROL_REQUIRED')
      return
    }
    running.current = true
    setBusy(true)
    onTestActiveChange(true)
    setActivityFinalizing(true)
    setActivityExportedJson(null)
    const original = activityResult
    const finish = (outcome: 'COMPLETE' | 'FAILED', lastError: string | null) => updateFinalizer(actionId, (current) => ({
      ...current, outcome, last_error: lastError ?? current.last_error, pending_read_operation: null,
      elapsed_ms: elapsedMs(current, new Date()), updated_at: new Date().toISOString(),
    }))
    try {
      const result = await finalizeSavedActivity(original, scope, {
        api: JCVitalV8,
        assertScope: () => {
          const current = clickState.current
          if (current.scope?.accountId !== scope.accountId || current.scope.deviceScopeId !== scope.deviceScopeId
            || current.eligibility.authenticatedOwner !== scope.accountId) throw new Error('Saved Activity owner/device scope changed.')
        },
        persist: (value) => persistSavedActivityFinalization(scope, original, value),
        cleanup: () => cleanupSavedPhysicalTest(observationBatchManager),
        onProgress: (progress: FinalizerProgress) => updateFinalizer(actionId,
          (current) => applyFinalizerProgress(current, progress, new Date())),
      })
      finish(result.status === 'COMPLETE' ? 'COMPLETE' : 'FAILED',
        result.status === 'COMPLETE' ? null : `${result.error_code ?? 'FAILED'}: ${result.error_message ?? result.failure_stage ?? 'unknown'}`)
      if (clickState.current.scope?.accountId !== scope.accountId
        || clickState.current.scope.deviceScopeId !== scope.deviceScopeId) return
      setActivityResult(result)
      setShown('activity')
      setStatus(result.status === 'COMPLETE' ? 'Saved Activity finalized. Export the source reconciliation before Workout.'
        : `Saved Activity finalization failed: ${failureResultText(result)}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      finish('FAILED', message)
      setStatus(`Saved Activity finalization failed: ${message}`)
    } finally {
      finalizerActionInProcess.current = null
      running.current = false
      setActivityFinalizing(false)
      onTestActiveChange(false)
      setBusy(false)
    }
  }

  function finalizerDiagnosticJson(): string {
    const current = finalizerRef.current
    if (!current) return ''
    const live = current.outcome === 'RUNNING' && finalizerActionInProcess.current === current.action_id
    return JSON.stringify(live ? { ...current, elapsed_ms: elapsedMs(current, new Date()) } : current, null, 2)
  }

  async function copyFinalizerDiagnostic() {
    const payload = finalizerDiagnosticJson()
    try {
      const verification = await copyPhysicalResultJson(payload)
      setFinalizerCopyFallback(null)
      setFinalizerExportStatus(`Finalizer diagnostic JSON copied. ${verification}`)
    } catch (error) {
      setFinalizerCopyFallback(payload || null)
      setFinalizerExportStatus(`Copy failed — select diagnostic JSON manually: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function saveFinalizerDiagnostic() {
    try {
      const location = await savePhysicalResultJson(FINALIZER_DIAGNOSTIC_FILENAME, finalizerDiagnosticJson(),
        'saved Activity finalizer diagnostic')
      setFinalizerExportStatus(`Saved finalizer diagnostic ${location}`)
    } catch (error) {
      setFinalizerExportStatus(`Diagnostic save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function shareJson(kind: 'activity' | 'workout') {
    const payload = kind === 'activity' ? activityJson : workoutJson
    try {
      const location = await savePhysicalResultJson(kind === 'activity' ? ACTIVITY_TEST_FILENAME : WORKOUT_TEST_FILENAME,
        payload ?? '', kind)
      setStatus(`Saved ${location}`)
      if (kind === 'activity' && isPhysicalResult(activityResult) && savedActivityReadyForExport(activityResult)) {
        setActivityExportedJson(payload)
      }
    } catch (error) {
      setStatus(`JSON save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async function copy(kind: 'activity' | 'workout') {
    const payload = kind === 'activity' ? activityJson : workoutJson
    try {
      const verification = await copyPhysicalResultJson(payload ?? '')
      setCopyFallback(null)
      setStatus(`${kind === 'activity' ? 'Activity' : 'Workout'} result JSON copied. ${verification}`)
    } catch (error) {
      setStatus(`Copy failed — select JSON manually\n${error instanceof Error ? error.message : String(error)}`)
      if (payload) {
        setShown(kind)
        setCopyFallback({ kind, json: payload })
      }
    }
  }

  const authenticatedOwnerValid = Boolean(eligibility.authenticatedOwner?.trim())
  const ownerScopeResolved = Boolean(eligibility.connectorOwner?.trim() && eligibility.journalScope?.accountId)
  const ownerScopeMismatch = authenticatedOwnerValid && (
    ownerUserId !== eligibility.authenticatedOwner
    || (eligibility.connectorOwner !== null && eligibility.connectorOwner !== eligibility.authenticatedOwner)
    || (eligibility.journalScope !== null && eligibility.journalScope.accountId !== eligibility.authenticatedOwner)
    || (context !== null && context.scope.accountId !== eligibility.authenticatedOwner)
  )
  const deviceScopeResolved = Boolean(eligibility.journalScope?.deviceScopeId)
  const sourceJournalBound = eligibility.sourceJournalBound && eligibility.journalScope !== null
  const commonBlockers = [
    ...(!eligibility.ready ? ['V8_NOT_READY'] : []),
    ...(!authenticatedOwnerValid ? ['AUTHENTICATED_OWNER_REQUIRED'] : []),
    ...(!ownerScopeResolved ? ['OWNER_SCOPE_NOT_RESOLVED'] : []),
    ...(ownerScopeMismatch ? ['OWNER_SCOPE_MISMATCH'] : []),
    ...(!sourceJournalBound ? ['SOURCE_JOURNAL_NOT_BOUND'] : []),
    ...(!deviceScopeResolved ? ['DEVICE_SCOPE_NOT_RESOLVED'] : []),
    ...(eligibility.connectionBusy ? ['CONNECTION_BUSY'] : []),
    ...(eligibility.physicalTestActive ? ['PHYSICAL_TEST_ACTIVE'] : []),
    ...(!context ? ['PHYSICAL_CONTEXT_NOT_RESOLVED'] : []),
    ...(context && !context.ready && eligibility.ready ? ['V8_CONTEXT_NOT_READY'] : []),
    ...(context && (!context.native || !context.physical) ? ['PHYSICAL_NATIVE_DEVICE_REQUIRED'] : []),
    ...(context && eligibility.journalScope && context.scope.deviceScopeId !== eligibility.journalScope.deviceScopeId
      ? ['DEVICE_SCOPE_MISMATCH'] : []),
  ]
  const activitySafeRetryAvailable = canSafelyRetryPhysicalAttempt(activityResult)
  const activityRetryMismatch = !activitySafeRetryAvailable && isPhysicalResult(activityResult)
    && activityResult.status === 'FAILED' && activityResult.retry_disposition === 'SAFE_TO_RETRY_NO_DEVICE_COMMAND'
    ? safeRetryEvidenceGaps(activityResult) : []
  const activityBlockers = [...commonBlockers,
    ...(nativeNotReady && eligibility.ready ? ['V8_NOT_READY'] : []),
    ...(activityAttempted === null ? ['ACTIVITY_ATTEMPT_STATE_NOT_RESOLVED']
      : activityAttempted && !activitySafeRetryAvailable ? ['ACTIVITY_SCOPE_ALREADY_ATTEMPTED'] : [])]
  const workoutBlockers = [...commonBlockers,
    ...(!eligibility.workoutControlAvailable ? ['WORKOUT_CONTROL_UNAVAILABLE'] : []),
    ...(workoutAttempted === null ? ['WORKOUT_ATTEMPT_STATE_NOT_RESOLVED']
      : workoutAttempted && !canSafelyRetryPhysicalAttempt(workoutResult) ? ['WORKOUT_SCOPE_ALREADY_ATTEMPTED'] : []),
    ...(!(isPhysicalResult(activityResult) && savedActivityReadyForExport(activityResult)
      && activityJson === activityExportedJson) ? ['SAVED_ACTIVITY_FINALIZATION_AND_EXPORT_REQUIRED'] : [])]
  const eligibilityText = (reasons: string[]) => reasons.length ? `BLOCKED — ${reasons.join(', ')}` : 'ENABLED'
  useLayoutEffect(() => {
    clickState.current = { eligibility, context, scope, workoutActive, blockers: activityBlockers }
  })
  const abbreviated = (value: string | null | undefined) => !value ? 'absent'
    : value.length < 9 ? '[redacted]' : `${value.slice(0, 3)}...${value.slice(-3)}`
  return <section aria-label="V8 Physical Semantic Tests">
    <h3>V8 Targeted Physical Semantic Tests</h3>
    <p>Engineering-only, source-journaled tests. No observations are enqueued or delivered, and no canonical or readiness behavior is changed.</p>
    <button type="button" disabled={!scope || !ownerAuthorized || eligibility.physicalTestActive} onClick={() => void recover()}>Recover Last Physical Test Failure</button>
    <section aria-label="Physical Semantic Test Eligibility">
      <h4>Physical Semantic Test Eligibility</h4>
      <dl>{Object.entries({
        'V8 READY': eligibility.ready,
        'authenticated owner': authenticatedOwnerValid,
        'owner scope resolved': ownerScopeResolved && !ownerScopeMismatch,
        'Source Journal bound': sourceJournalBound,
        'device scope resolved': deviceScopeResolved,
        'connect/disconnect busy': eligibility.connectionBusy,
        'production sync active': eligibility.productionSyncActive,
        'physical test active': eligibility.physicalTestActive,
        'workout control capability available': eligibility.workoutControlAvailable,
      }).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value ? 'YES' : 'NO'}</dd></div>)}</dl>
      {ownerScopeMismatch && <p>OWNER_SCOPE_MISMATCH: authenticated={abbreviated(eligibility.authenticatedOwner)}; connector={abbreviated(eligibility.connectorOwner)}; journal={abbreviated(eligibility.journalScope?.accountId)}; test={abbreviated(ownerUserId)}; context={abbreviated(context?.scope.accountId)}</p>}
      <p role="status">Activity test: {eligibilityText(activityBlockers)}</p>
      <p role="status">Workout test: {eligibilityText(workoutBlockers)}</p>
    </section>
    <section aria-label="Test Activity 24 + 25">
      <h4>Test Activity 24 + 25</h4>
      <p>Requests only Type24 daily activity and Type25 detailed activity. It does not request HR, SpO2, temperature, physiology, sleep, workout, PPI, PPG, or ECG.</p>
      <div className="wearable-actions">
        <button type="button" disabled={activityBlockers.length > 0 || activityExecuting !== null}
          onClick={() => void run('activity', activitySafeRetryAvailable ? activityResult : null)}>
          {activityExecuting === 'retry' ? 'Preparing Retry…' : activityExecuting === 'first' ? 'Preparing Activity Test…'
            : activitySafeRetryAvailable ? 'Retry Activity Test' : 'Run'}
        </button>
        <button type="button" disabled={!activityResult} onClick={() => setShown('activity')}>Show Result</button>
        <button type="button" disabled={!activityResult} onClick={() => void copy('activity')}>Copy Result JSON</button>
        <button type="button" disabled={!activityResult} onClick={() => void shareJson('activity')}>Save Result JSON</button>
      </div>
      {activitySafeRetryAvailable && <p>Prior failed attempt will be preserved.<br />This creates a new linked attempt.<br />Retry of: {activityResult.attempt_id}</p>}
      {activityResult && <ResultAttemptHeader result={activityResult} />}
      {activityCanonicalReports && <ul aria-label="Activity canonicalization">{activityCanonicalReports.map((report) =>
        <li key={`${report.syncId}:${report.vendorDataType}`}>Activity canonical Type{report.vendorDataType}: {report.status}{report.reason ? ` — ${report.reason}` : ''}; {report.observations} observations; withheld {JSON.stringify(report.withheld)}; Base44 delivery OFF (publish gate)</li>)}</ul>}
      {isPhysicalResult(activityResult) && activityResult.retry_of_attempt_id && <>
        <p>Retry attempt: {activityResult.attempt_id}</p>
        <p>Previous attempt: {activityResult.retry_of_attempt_id}</p>
      </>}
      {activityResult && !createdActivityAttempt && !(isPhysicalResult(activityResult) && activityResult.retry_of_attempt_id)
        && <p>No new retry attempt recorded.<br />Showing previous saved result.</p>}
      {isPhysicalResult(activityResult) && activityResult.status === 'STARTING' && <p>Preparing isolated Activity test…</p>}
      {isPhysicalResult(activityResult) && <ol aria-label="Activity attempt progress">{activityResult.stages.map(({ stage, at }, index) =>
        <li key={`${stage}:${index}`}>{activityStageText(stage)} — {at}</li>)}</ol>}
      {activityAttempted && <p>{activitySafeRetryAvailable
        ? 'Safe retry available: saved evidence proves no native invocation, acquisition, commands, callbacks, or source writes. The failed attempt will be retained and linked.'
        : 'Type24/25 acquisition is one-shot for this journal scope; inspect saved evidence instead of reacquiring.'}</p>}
      {activityRetryMismatch.length > 0 && <p role="note">Retry not available: saved retry disposition is SAFE_TO_RETRY_NO_DEVICE_COMMAND, but approved zero-invocation evidence is not satisfied ({activityRetryMismatch.join(', ')}).</p>}
      {isPhysicalResult(activityResult) && activityResult.status === 'FAILED' && <pre aria-label="Activity failure evidence">{failureResultText(activityResult)}</pre>}
    </section>
    <Type25AnchorTest
      key={`${ownerUserId}:${eligibility.journalScope?.deviceScopeId ?? ''}`}
      context={context}
      ownerUserId={ownerUserId}
      eligibility={eligibility}
      setBusy={setBusy}
      workoutActive={workoutActive}
      onTestActiveChange={onTestActiveChange}
    />
    <section aria-label="Saved Activity Finalization">
      <button type="button" aria-busy={activityFinalizing} onClick={requestActivityFinalizer}>
        {activityFinalizing ? 'Finalizing Saved Activity…' : 'Finalize Saved Activity 24 + 25 Test'}
      </button>
      <p>Saved records only: no BLE commands, acquisition, Source Journal writes, enqueue, Base44 test calls, or canonical writes.</p>
      {finalizerDiagnostic && <FinalizerStatus diagnostic={finalizerDiagnostic} now={finalizerNow}
        live={finalizerRunning} />}
      <div className="wearable-actions">
        <button type="button" disabled={!finalizerDiagnostic} onClick={() => setFinalizerShown((open) => !open)}>Show Finalizer Diagnostic</button>
        <button type="button" disabled={!finalizerDiagnostic} onClick={() => void copyFinalizerDiagnostic()}>Copy Finalizer Diagnostic JSON</button>
        <button type="button" disabled={!finalizerDiagnostic} onClick={() => void saveFinalizerDiagnostic()}>Save Finalizer Diagnostic JSON</button>
      </div>
      {finalizerExportStatus && <p aria-label="Finalizer diagnostic export status">{finalizerExportStatus}</p>}
      {finalizerShown && finalizerDiagnostic && <pre aria-label="Finalizer diagnostic JSON">{JSON.stringify(finalizerDiagnostic, null, 2)}</pre>}
      {finalizerCopyFallback && <textarea aria-label="Manual finalizer diagnostic JSON" readOnly rows={16} value={finalizerCopyFallback}
        onFocus={(event) => event.currentTarget.select()} />}
    </section>
    <section aria-label="Test Workout 29 + 82">
      <h4>Test Workout 29 + 82</h4>
      <p>Runs a 60-second controlled V8 session, captures Type82 packets, stops normally, then requests Type29 history once. The Type29 vendor multi-record stride is not authoritative.</p>
      <div className="wearable-actions">
        <button type="button" disabled={workoutBlockers.length > 0} onClick={() => void run('workout')}>Run</button>
        <button type="button" disabled={!workoutResult} onClick={() => setShown('workout')}>Show Result</button>
        <button type="button" disabled={!workoutResult} onClick={() => void copy('workout')}>Copy Result JSON</button>
        <button type="button" disabled={!workoutResult} onClick={() => void shareJson('workout')}>Save Result JSON</button>
      </div>
      {workoutResult && <ResultAttemptHeader result={workoutResult} />}
      {workoutAttempted && <p>{canSafelyRetryPhysicalAttempt(workoutResult)
        ? 'Safe retry available only from proven zero-invocation evidence; the failed attempt will be retained and linked.'
        : 'Type29 physical history is one-shot for this journal scope; an existing attempt prevents reacquisition.'}</p>}
      {isPhysicalResult(workoutResult) && workoutResult.status === 'FAILED' && <pre aria-label="Workout failure evidence">{failureResultText(workoutResult)}</pre>}
    </section>
    {status && <p role="status">{status}</p>}
    {shown === 'activity' && activityResult && <><ResultAttemptHeader result={activityResult} /><pre aria-label="Activity semantic test result">{isPhysicalResult(activityResult) ? failureResultText(activityResult) : physicalResultText(activityResult)}</pre><PhysicalResultJsonView json={activityJson ?? ''} /></>}
    {shown === 'workout' && workoutResult && <><ResultAttemptHeader result={workoutResult} /><pre aria-label="Workout semantic test result">{isPhysicalResult(workoutResult) ? failureResultText(workoutResult) : physicalResultText(workoutResult)}</pre><PhysicalResultJsonView json={workoutJson ?? ''} /></>}
    {copyFallback && <label>Copy failed — select JSON manually
      <textarea aria-label="Manual full result JSON" readOnly rows={24} value={copyFallback.json}
        onFocus={(event) => event.currentTarget.select()} />
    </label>}
  </section>
}

function readBackup(kind: 'activity' | 'workout', scope: SourceJournalScope): FailureResult | null {
  const saved = sessionStorage.getItem(evidenceKey(kind, scope)) ?? localStorage.getItem(evidenceKey(kind, scope))
  const parsed: unknown = saved ? JSON.parse(saved) : null
  return isPhysicalResult(parsed) && parsed.status !== 'RUNNING' && parsed.status !== 'STARTING' ? parsed : null
}

function activityStageText(stage: string): string {
  const labels: Record<string, string> = {
    SENDER_QUIESCE_REQUESTED: 'Sender quiescence requested',
    SENDER_QUIESCED: 'Sender quiesced',
    ISOLATION_LOCK_ACQUIRED: 'Isolation acquired',
    NATIVE_BRIDGE_ENTERED: 'Starting V8 Activity acquisition…',
  }
  return labels[stage] ?? stage
}

function FinalizerStatus({ diagnostic, now, live }: { diagnostic: FinalizerDiagnostic; now: number; live: boolean }) {
  const current = new Date(Math.max(now, Date.parse(diagnostic.updated_at)))
  const elapsed = live ? elapsedMs(diagnostic, current) : diagnostic.elapsed_ms
  const stalled = live ? sinceProgressMs(diagnostic, current) : 0
  const loaded = (value: number, expected: number | null) => `${value}${expected === null ? '' : ` / ${expected}`}`
  return <div aria-label="Saved Activity Finalizer status" aria-live="polite">
    <p>Finalizer action received</p>
    <p>attempt: {diagnostic.attempt_id ?? 'NO SAVED ATTEMPT LOADED'}</p>
    <p>action: {diagnostic.action_id} · clicked {diagnostic.clicked_at}</p>
    <p>stage: {diagnostic.stage}</p>
    <p>outcome: {diagnostic.outcome}{!live && diagnostic.outcome === 'RUNNING' ? ' (not running in this app session — interrupted)' : ''}</p>
    <p>elapsed: {Math.floor(elapsed / 1000)} s</p>
    <p>Type24 records loaded: {loaded(diagnostic.type24_loaded, diagnostic.type24_expected)}</p>
    <p>Type25 records loaded: {loaded(diagnostic.type25_loaded, diagnostic.type25_expected)}</p>
    <p>pending read: {diagnostic.pending_read_operation ?? 'none'}</p>
    <p>last error: {diagnostic.last_error ?? 'none'}</p>
    {diagnostic.blockers.length > 0 && <p role="alert">Finalizer blocked: {diagnostic.blockers.join(', ')}</p>}
    {live && stalled >= FINALIZER_STILL_WAITING_MS && <p role="alert">
      Finalizer still waiting<br />last completed stage: {diagnostic.last_completed_stage}<br />elapsed: {Math.floor(elapsed / 1000)} s
    </p>}
    {diagnostic.watchdog.timeout && <p role="alert">FINALIZER_ACTION_TIMEOUT recorded at {diagnostic.watchdog.timeout.recorded_at}
      {' '}(last completed stage {diagnostic.watchdog.timeout.last_completed_stage}; not cancelled, not retried)</p>}
    {diagnostic.ignored_clicks.length > 0 && <p>Ignored repeat clicks while running: {diagnostic.ignored_clicks.length}</p>}
    <ol aria-label="Finalizer stages">{diagnostic.stages.map(({ stage, at }, index) => <li key={`${stage}:${index}`}>{stage} — {at}</li>)}</ol>
  </div>
}

function ResultAttemptHeader({ result }: { result: unknown }) {
  return <div aria-label="Result attempt identity">
    <p>Result attempt: {isPhysicalResult(result) ? result.attempt_id ?? 'UNKNOWN' : 'UNKNOWN — legacy saved result'}</p>
    <p>Retry of: {isPhysicalResult(result) ? result.retry_of_attempt_id ?? 'NONE' : 'NONE'}</p>
    <p>Build: v60</p>
  </div>
}

function safeRetryEvidenceGaps(result: FailureResult) {
  const shown = (value: unknown) => value === null || value === undefined ? 'UNKNOWN' : String(value)
  return ([
    ['attempt_id', typeof result.attempt_id === 'string' && result.attempt_id.length > 0],
    ['acquisition_started', result.acquisition_started === false],
    ['native_invocation_started', result.native_invocation_started === false],
    ['ble_commands_issued', result.ble_commands_issued === 0],
    ['callbacks_received', result.callbacks_received === 0],
    ['source_envelopes_written', result.source_envelopes_written === 0],
    ['partial_evidence_present', result.partial_evidence_present === false],
  ] as const).filter(([, ok]) => !ok).map(([field]) => `${field}=${shown(result[field])}`)
}

function PhysicalResultJsonView({ json }: { json: string }) {
  const [digest, setDigest] = useState<{ json: string; hash: string } | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setError('')
    async function hash() {
      try {
        requirePhysicalResultJson(json)
        const value = await wireSha256(new TextEncoder().encode(json))
        if (active) setDigest({ json, hash: value })
      } catch (failure) {
        if (active) setError(failure instanceof Error ? failure.message : String(failure))
      }
    }
    void hash()
    return () => { active = false }
  }, [json])
  return <section aria-label="Complete result JSON">
    <p>JSON characters: {json.length}</p>
    <p>JSON SHA-256: {digest?.json === json ? digest.hash : error ? `Unavailable — ${error}` : 'Calculating…'}</p>
    {error && <p role="alert">{error}</p>}
    <textarea aria-label="Complete result JSON" readOnly rows={24} value={json} onFocus={(event) => event.currentTarget.select()} />
  </section>
}

function retainIsolationFailure(attempt: PhysicalAttempt, result: unknown, isolation: PhysicalTestIsolation) {
  if (isolation.passed) return
  attempt.result.result = result
  attempt.before('ISOLATION_FINALIZATION')
  throw Object.assign(new Error('Physical evidence retained, but queue/sender/ACK/native/Wellness isolation assertions did not pass.'), {
    code: 'PHYSICAL_TEST_ISOLATION_FAILED',
  })
}
