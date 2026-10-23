import {
  CONTROLLED_MINUTE_PATTERN,
  evaluateType25MinuteAnchor,
  TYPE25_ANCHOR_MODELS,
  type MinuteTransition,
  type Type25AnchorRecord,
} from './Type25MinuteAnchor'

/*
 * P1-2B Type25 manual semantic adjudication and the resulting minute-anchor policy.
 *
 * The automated v64 recovery gate (selectedTimestampModel = null, controlledPatternMatch = FAIL)
 * is preserved verbatim as the conservative machine gate. The adjudication below is a separate,
 * explicitly labelled determination and never rewrites that automated evidence.
 *
 * This module is evidence/policy only: it performs no BLE, queue, Base44, canonical, or readiness writes.
 */

export const TYPE25_MINUTE_ANCHOR_POLICY_ID = 'jcvital.type25.minute_anchor.v1'
export const TYPE25_ADJUDICATION_SCHEMA = 'eliteplus.p1-2b.type25-manual-semantic-adjudication.v1'
export const TYPE25_SLOT_DURATION_MS = 60_000
export const TYPE25_SEGMENT_SLOTS = 10

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child)
  }
  return value
}

export const TYPE25_MINUTE_ANCHOR_POLICY = deepFreeze({
  policyId: TYPE25_MINUTE_ANCHOR_POLICY_ID,
  deviceModel: 'PRO_V8',
  sdkVersion: 'v8sdk2.0',
  firmwareVersion: '0.0.8.8',
  dataType: 25,
  dateMeaning: 'FIRST_MINUTE',
  arrayOrdering: 'OLDEST_TO_NEWEST',
  slotDurationSeconds: 60,
  segmentSlots: 10,
  confidence: 'HIGH',
  evidenceClass: 'MANUAL_ADJUDICATED_PHYSICAL_HIGH_CONFIDENCE',
  originalAttemptId: '43e5cbf4-bd09-4f47-83dc-4eca7ebb63bd',
  refreshAttemptId: '148f4e10-ed42-4448-8c13-4b1806a2f8f1',
} as const)

export type Type25MinuteAnchorPolicy = typeof TYPE25_MINUTE_ANCHOR_POLICY

export type Type25DeviceScope = {
  deviceModel: string
  sdkVersion: string
  firmwareVersion: string
}

export function type25PolicyApplies(scope: Type25DeviceScope): boolean {
  return scope.deviceModel === TYPE25_MINUTE_ANCHOR_POLICY.deviceModel
    && scope.sdkVersion === TYPE25_MINUTE_ANCHOR_POLICY.sdkVersion
    && scope.firmwareVersion === TYPE25_MINUTE_ANCHOR_POLICY.firmwareVersion
}

/** Parses the vendor `yyyy.MM.dd HH:mm:ss` local date with an explicit UTC offset (e.g. `-07:00`). */
export function parseType25VendorDate(vendorDate: string, utcOffset: string): number | null {
  const date = /^(\d{4})\.(\d{2})\.(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(vendorDate)
  const offset = /^([+-])(\d{2}):(\d{2})$/.exec(utcOffset)
  if (!date || !offset) return null
  const [, y, mo, d, h, mi, s] = date.map(Number)
  const localAsUtc = Date.UTC(y, mo - 1, d, h, mi, s)
  const check = new Date(localAsUtc)
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d
    || h > 23 || mi > 59 || s > 59) return null
  const offsetMs = (offset[1] === '-' ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) * 60_000
  return localAsUtc - offsetMs
}

export type Type25SegmentInput = {
  sourceEnvelopeId: string
  /** Type25 `date` as epoch ms (already resolved against the device timezone). */
  dateEpochMs: number | null
  detailMinterStep: unknown
  arraySteps: unknown
}

export type Type25CanonicalMinute = {
  sourceEnvelopeId: string
  slotIndex: number
  epochMs: number
  minuteTimestamp: string
  steps: number
}

export type Type25IntegrityWithheldReason =
  | 'POLICY_SCOPE_MISMATCH'
  | 'MISSING_OR_INVALID_DATE'
  | 'UNPARSEABLE_ARRAY_STEPS'
  | 'ARRAY_LENGTH_NOT_10'
  | 'UNPARSEABLE_DETAIL_MINTER_STEP'
  | 'SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP'

export type Type25SegmentExpansion =
  | {
    status: 'EXPANDED'
    sourceEnvelopeId: string
    policyId: typeof TYPE25_MINUTE_ANCHOR_POLICY_ID
    minutes: Type25CanonicalMinute[]
  }
  | {
    status: 'INTEGRITY_WITHHELD'
    sourceEnvelopeId: string
    policyId: typeof TYPE25_MINUTE_ANCHOR_POLICY_ID
    reason: Type25IntegrityWithheldReason
    detail: string
    minutes: []
  }

function parseArraySteps(value: unknown): number[] | null {
  const tokens: unknown[] = typeof value === 'string'
    ? (value.trim() === '' ? [] : value.trim().split(/\s+/))
    : Array.isArray(value) ? value : []
  if (typeof value !== 'string' && !Array.isArray(value)) return null
  const parsed = tokens.map((token) => typeof token === 'number' ? token
    : typeof token === 'string' && /^\d+$/.test(token) ? Number(token) : Number.NaN)
  return parsed.every((step) => Number.isSafeInteger(step) && step >= 0) ? parsed : null
}

function parseDetailMinterStep(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Expands one Type25 segment into canonical minute epochs under jcvital.type25.minute_anchor.v1:
 *   minuteTimestamp[i] = Type25.date + i × 60 s, i = 0..9, arraySteps[i] oldest → newest.
 * Requires arrayLength == 10 and sum(arraySteps) == detailMinterStep; otherwise emits no minutes
 * and an explicit integrity-withheld reason. Source evidence is never modified.
 */
export function expandType25Segment(input: Type25SegmentInput, scope: Type25DeviceScope): Type25SegmentExpansion {
  const withheld = (reason: Type25IntegrityWithheldReason, detail: string): Type25SegmentExpansion => ({
    status: 'INTEGRITY_WITHHELD', sourceEnvelopeId: input.sourceEnvelopeId,
    policyId: TYPE25_MINUTE_ANCHOR_POLICY_ID, reason, detail, minutes: [],
  })
  if (!type25PolicyApplies(scope)) {
    return withheld('POLICY_SCOPE_MISMATCH',
      `Policy applies only to ${TYPE25_MINUTE_ANCHOR_POLICY.deviceModel} + ${TYPE25_MINUTE_ANCHOR_POLICY.sdkVersion} + FW ${TYPE25_MINUTE_ANCHOR_POLICY.firmwareVersion}; got ${scope.deviceModel} + ${scope.sdkVersion} + FW ${scope.firmwareVersion}.`)
  }
  if (input.dateEpochMs === null || !Number.isSafeInteger(input.dateEpochMs)) {
    return withheld('MISSING_OR_INVALID_DATE', 'Type25 date is missing or not a valid epoch.')
  }
  const steps = parseArraySteps(input.arraySteps)
  if (!steps) return withheld('UNPARSEABLE_ARRAY_STEPS', 'arraySteps is not a list of non-negative integers.')
  if (steps.length !== TYPE25_SEGMENT_SLOTS) {
    return withheld('ARRAY_LENGTH_NOT_10', `arrayLength = ${steps.length}; required ${TYPE25_SEGMENT_SLOTS}.`)
  }
  const declared = parseDetailMinterStep(input.detailMinterStep)
  if (declared === null) return withheld('UNPARSEABLE_DETAIL_MINTER_STEP', 'detailMinterStep is not a non-negative integer.')
  const sum = steps.reduce((total, step) => total + step, 0)
  if (sum !== declared) {
    return withheld('SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP', `sum(arraySteps) = ${sum}; detailMinterStep = ${declared}.`)
  }
  const dateEpochMs = input.dateEpochMs
  return {
    status: 'EXPANDED', sourceEnvelopeId: input.sourceEnvelopeId, policyId: TYPE25_MINUTE_ANCHOR_POLICY_ID,
    minutes: steps.map((value, slotIndex) => {
      const epochMs = dateEpochMs + slotIndex * TYPE25_SLOT_DURATION_MS
      return { sourceEnvelopeId: input.sourceEnvelopeId, slotIndex, epochMs, minuteTimestamp: new Date(epochMs).toISOString(), steps: value }
    }),
  }
}

/**
 * Expands each returned segment independently. Gaps between returned Type25 records are left as gaps:
 * no minutes or segments are synthesized or zero-filled.
 */
export function expandType25Segments(inputs: readonly Type25SegmentInput[], scope: Type25DeviceScope): {
  expansions: Type25SegmentExpansion[]
  minutes: Type25CanonicalMinute[]
} {
  const expansions = inputs.map((input) => expandType25Segment(input, scope))
  const minutes = expansions.flatMap((expansion) => expansion.minutes)
    .sort((a, b) => a.epochMs - b.epochMs || a.sourceEnvelopeId.localeCompare(b.sourceEnvelopeId))
  return { expansions, minutes }
}

// ---------------------------------------------------------------------------------------------
// Manual semantic adjudication of the saved v64 recovery evidence.
// ---------------------------------------------------------------------------------------------

type ModelId = 'A' | 'B' | 'C' | 'D'

export type Type25V64CandidateModel = {
  anchor: 'FIRST_MINUTE' | 'LAST_MINUTE'
  ordering: 'OLDEST_TO_NEWEST' | 'NEWEST_TO_OLDEST'
  comparedMinutes: number
  matchedMinutes: number
  mismatchedMinutes: number
  maximumTimingErrorMs: number | null
  overlappingRecords: string[]
  conflictCount: number
  supported: boolean
}

export type Type25V64MinuteMatch = {
  sourceEnvelopeId: string
  sourceSlotIndex: number
  minute: number
  instruction: 'STILL' | 'WALK'
  slotTimestamp: string
  transitionTimestamp: string
  timingErrorMs: number
  steps: number
  patternMatch: boolean
}

export type Type25V64RecoveryExport = {
  recovery_schema: string
  recovery_build: string
  original_attempt_id: string
  refresh_attempt_id: string
  analysis_run_at: string
  original_record_count: number
  refreshed_record_count: number
  latest_vendor_date_before: string
  latest_vendor_date_after: string
  valid_array_count: number
  invalid_array_count: number
  sum_invariant_pass_count: number
  candidateModels: Record<ModelId, Type25V64CandidateModel>
  selectedTimestampModel: string | null
  arrayOrdering: string | null
  controlledPatternMatch: 'PASS' | 'FAIL'
  canonicalMinuteTimestampsDeterministic: 'YES' | 'NO'
  queueWrites: number
  base44Calls: number
  canonicalWrites: number
  readinessWrites: number
  READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: 'YES' | 'NO'
  controlledPattern: Array<{ minute: number; instruction: 'STILL' | 'WALK'; localTimestamp: string }>
  criticalSourceRecords: Array<{
    sourceEnvelopeId: string
    vendorDate: string
    detailMinterStep: string
    arraySteps: string
    arrayLength: number
    sumArraySteps: number
    sumArrayStepsEqualsDetailMinterStep: boolean
  }>
  modelA_mismatches: Type25V64MinuteMatch[]
  strongest_positive_modelA_evidence: Omit<Type25V64MinuteMatch, 'minute'> & { vendorDate: string; controlledMinute: number }
}

export class Type25AdjudicationEvidenceError extends Error {
  readonly inconsistencies: string[]
  constructor(inconsistencies: string[]) {
    super(`Type25 adjudication evidence is internally inconsistent:\n- ${inconsistencies.join('\n- ')}`)
    this.name = 'Type25AdjudicationEvidenceError'
    this.inconsistencies = inconsistencies
  }
}

const MODEL_IDS: readonly ModelId[] = ['A', 'B', 'C', 'D']

function transitionsFrom(evidence: Type25V64RecoveryExport): MinuteTransition[] {
  return evidence.controlledPattern.map((entry) => ({
    minute: entry.minute,
    instruction: entry.instruction,
    localTimestamp: entry.localTimestamp,
    epochMs: Date.parse(entry.localTimestamp),
    monotonicMs: 0,
  }))
}

function controlledOffset(evidence: Type25V64RecoveryExport): string {
  return evidence.controlledPattern[0]?.localTimestamp.slice(-6) ?? ''
}

function modelASlotMs(evidence: Type25V64RecoveryExport, sourceEnvelopeId: string, slotIndex: number): number | null {
  const record = evidence.criticalSourceRecords.find((entry) => entry.sourceEnvelopeId === sourceEnvelopeId)
  const date = record ? parseType25VendorDate(record.vendorDate, controlledOffset(evidence)) : null
  return date === null ? null : date + slotIndex * TYPE25_SLOT_DURATION_MS
}

/**
 * Checks every supplied value against the others and against an independent recomputation with the
 * production evaluator over the critical source records. Returns all inconsistencies (empty = consistent).
 */
export function verifyType25RecoveryEvidence(evidence: Type25V64RecoveryExport): {
  inconsistencies: string[]
  checks: string[]
} {
  const issues: string[] = []
  const checks: string[] = []
  const expect = (ok: boolean, check: string, failure: string) => {
    if (ok) checks.push(check)
    else issues.push(failure)
  }
  expect(evidence.recovery_build === 'v64', 'recovery_build = v64', `recovery_build is ${evidence.recovery_build}, expected v64`)
  expect(evidence.original_attempt_id === TYPE25_MINUTE_ANCHOR_POLICY.originalAttemptId
    && evidence.refresh_attempt_id === TYPE25_MINUTE_ANCHOR_POLICY.refreshAttemptId,
  'attempt ids match policy scope', 'attempt ids do not match the policy original/refresh attempt ids')
  expect(evidence.sum_invariant_pass_count === evidence.valid_array_count && evidence.invalid_array_count === 0,
    `${evidence.sum_invariant_pass_count}/${evidence.valid_array_count} valid arrays pass sum(arraySteps) == detailMinterStep; 0 invalid`,
    `sum_invariant_pass_count ${evidence.sum_invariant_pass_count} != valid_array_count ${evidence.valid_array_count} or invalid_array_count ${evidence.invalid_array_count} != 0`)
  expect(evidence.selectedTimestampModel === null && evidence.arrayOrdering === null
    && evidence.controlledPatternMatch === 'FAIL' && evidence.canonicalMinuteTimestampsDeterministic === 'NO'
    && evidence.READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION === 'NO',
  'automated gate is FAIL / null / NO', 'automated gate fields are not the expected FAIL / null / NO values')
  expect(evidence.queueWrites === 0 && evidence.base44Calls === 0 && evidence.canonicalWrites === 0 && evidence.readinessWrites === 0,
    'automated protected writes all 0', 'automated protected-write counters are not all zero')

  for (const id of MODEL_IDS) {
    const model = evidence.candidateModels[id]
    const reference = TYPE25_ANCHOR_MODELS.find((entry) => entry.id === id)!
    expect(Boolean(model) && model.anchor === reference.anchor && model.ordering === reference.ordering,
      `model ${id} = ${reference.anchor} + ${reference.ordering}`, `model ${id} anchor/ordering does not match ${reference.anchor} + ${reference.ordering}`)
    if (!model) continue
    expect(model.matchedMinutes + model.mismatchedMinutes === model.comparedMinutes,
      `model ${id} matched + mismatched = compared (${model.comparedMinutes})`,
      `model ${id}: matched ${model.matchedMinutes} + mismatched ${model.mismatchedMinutes} != compared ${model.comparedMinutes}`)
    expect(model.conflictCount === 0, `model ${id} conflictCount = 0`, `model ${id} conflictCount = ${model.conflictCount}`)
  }

  expect(evidence.controlledPattern.length === CONTROLLED_MINUTE_PATTERN.length
    && evidence.controlledPattern.every((entry, index) => entry.minute === index + 1
      && entry.instruction === CONTROLLED_MINUTE_PATTERN[index] && Number.isFinite(Date.parse(entry.localTimestamp))),
  'controlled 12-minute STILL/WALK pattern intact', 'controlled pattern does not match the 12-minute STILL/WALK sequence')

  for (const record of evidence.criticalSourceRecords) {
    const steps = parseArraySteps(record.arraySteps)
    const declared = parseDetailMinterStep(record.detailMinterStep)
    const sum = steps?.reduce((total, step) => total + step, 0) ?? null
    expect(steps !== null && steps.length === record.arrayLength && record.arrayLength === 10
      && sum === record.sumArraySteps && sum === declared && record.sumArrayStepsEqualsDetailMinterStep,
    `${record.sourceEnvelopeId} (${record.vendorDate}) length 10 and sum ${sum} == detailMinterStep ${declared}`,
    `${record.sourceEnvelopeId}: arrayLength/sum/detailMinterStep values are inconsistent`)
  }

  const matchConsistent = (match: Omit<Type25V64MinuteMatch, 'minute'>, minute: number, label: string) => {
    const record = evidence.criticalSourceRecords.find((entry) => entry.sourceEnvelopeId === match.sourceEnvelopeId)
    const slotMs = modelASlotMs(evidence, match.sourceEnvelopeId, match.sourceSlotIndex)
    const transition = evidence.controlledPattern[minute - 1]
    const slotValue = record ? parseArraySteps(record.arraySteps)?.[match.sourceSlotIndex] : undefined
    const expectedMatch = transition ? (transition.instruction === 'WALK') === (match.steps > 0) : false
    expect(slotMs !== null && Date.parse(match.slotTimestamp) === slotMs
      && transition !== undefined && transition.instruction === match.instruction
      && transition.localTimestamp === match.transitionTimestamp
      && Math.abs(slotMs - Date.parse(transition.localTimestamp)) === match.timingErrorMs
      && slotValue === match.steps && expectedMatch === match.patternMatch,
    `${label}: slot ${match.sourceSlotIndex} of ${match.sourceEnvelopeId} → Minute ${minute} ${match.instruction}, ${match.steps} steps, ${match.timingErrorMs} ms`,
    `${label}: slot timestamp, transition, timing error, step value or match flag is inconsistent`)
  }
  expect(evidence.modelA_mismatches.length === evidence.candidateModels.A.mismatchedMinutes
    && evidence.modelA_mismatches.every((match) => !match.patternMatch),
  `model A mismatch list has ${evidence.modelA_mismatches.length} entries = mismatchedMinutes`,
  `model A mismatch list length ${evidence.modelA_mismatches.length} != mismatchedMinutes ${evidence.candidateModels.A.mismatchedMinutes}`)
  for (const mismatch of evidence.modelA_mismatches) matchConsistent(mismatch, mismatch.minute, 'model A mismatch')
  const strongest = evidence.strongest_positive_modelA_evidence
  const strongestRecord = evidence.criticalSourceRecords.find((entry) => entry.sourceEnvelopeId === strongest.sourceEnvelopeId)
  expect(strongestRecord?.vendorDate === strongest.vendorDate && strongest.patternMatch,
    'strongest positive evidence references its critical record', 'strongest positive evidence vendorDate/record reference is inconsistent')
  matchConsistent(strongest, strongest.controlledMinute, 'strongest positive evidence')

  // Independent recomputation of all four fits from the critical records with the production evaluator.
  const offset = controlledOffset(evidence)
  const records: Type25AnchorRecord[] = evidence.criticalSourceRecords.map((record) => ({
    sourceEnvelopeId: record.sourceEnvelopeId, sourceEnvelope: '', vendorDate: record.vendorDate,
    parsedDateMs: parseType25VendorDate(record.vendorDate, offset), timezone: offset,
    callbackTimestamp: null, receiptTimestamp: null,
    detailMinterStep: record.detailMinterStep, arraySteps: record.arraySteps,
  }))
  let recomputed: ReturnType<typeof evaluateType25MinuteAnchor> | null = null
  try {
    recomputed = evaluateType25MinuteAnchor(records, transitionsFrom(evidence))
  } catch (error) {
    issues.push(`independent recomputation failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (recomputed) {
    for (const fit of recomputed.fits) {
      const exported = evidence.candidateModels[fit.id]
      if (!exported) continue
      expect(fit.comparedMinutes === exported.comparedMinutes && fit.matchedMinutes === exported.matchedMinutes
        && fit.mismatchedMinutes === exported.mismatchedMinutes && fit.maximumTimingErrorMs === exported.maximumTimingErrorMs
        && fit.conflicts.length === exported.conflictCount
        && [...fit.overlappingRecords].sort().join() === [...exported.overlappingRecords].sort().join(),
      `model ${fit.id} recomputed ${fit.matchedMinutes}/${fit.comparedMinutes}, max ${fit.maximumTimingErrorMs} ms matches export`,
      `model ${fit.id} recomputed ${fit.matchedMinutes}/${fit.comparedMinutes} (${fit.mismatchedMinutes} mismatched, max ${fit.maximumTimingErrorMs} ms) differs from export ${exported.matchedMinutes}/${exported.comparedMinutes}`)
    }
    const fitA = recomputed.fits.find((fit) => fit.id === 'A')!
    const recomputedMismatches = fitA.matches.filter((match) => !match.patternMatch)
    expect(recomputedMismatches.length === evidence.modelA_mismatches.length
      && recomputedMismatches.every((match, index) => {
        const exported = evidence.modelA_mismatches[index]
        return exported && match.sourceEnvelopeId === exported.sourceEnvelopeId && match.sourceSlotIndex === exported.sourceSlotIndex
          && match.minute === exported.minute && match.steps === exported.steps && match.timingErrorMs === exported.timingErrorMs
      }),
    'recomputed model A mismatches equal exported mismatches', 'recomputed model A mismatches differ from exported mismatches')
    expect(recomputed.selected === null && !recomputed.patternPass,
      'production strict gate still rejects all models (automated FAIL reproduced)', 'production strict gate unexpectedly selects a model')
  }
  return { inconsistencies: issues, checks }
}

function ranking(evidence: Type25V64RecoveryExport): ModelId[] {
  return [...MODEL_IDS].sort((a, b) => {
    const left = evidence.candidateModels[a]
    const right = evidence.candidateModels[b]
    return right.matchedMinutes - left.matchedMinutes || left.mismatchedMinutes - right.mismatchedMinutes
  })
}

function uniquelyBest(evidence: Type25V64RecoveryExport, id: ModelId): boolean {
  const best = evidence.candidateModels[id]
  return MODEL_IDS.filter((other) => other !== id).every((other) => {
    const model = evidence.candidateModels[other]
    return best.matchedMinutes > model.matchedMinutes
      || (best.matchedMinutes === model.matchedMinutes && best.mismatchedMinutes < model.mismatchedMinutes)
  })
}

export function buildType25ManualAdjudication(
  evidence: Type25V64RecoveryExport,
  options: { adjudicatedAt: string; evidenceSource: string; evidenceSha256: string },
) {
  const source: Type25V64RecoveryExport = structuredClone(evidence)
  const verification = verifyType25RecoveryEvidence(source)
  if (verification.inconsistencies.length) throw new Type25AdjudicationEvidenceError(verification.inconsistencies)
  if (!uniquelyBest(source, 'A')) throw new Type25AdjudicationEvidenceError(['Model A is not uniquely the best physical fit.'])

  const models = source.candidateModels
  const strongest = source.strongest_positive_modelA_evidence
  const strongestRecord = source.criticalSourceRecords.find((record) => record.sourceEnvelopeId === strongest.sourceEnvelopeId)!
  const strongestDateMs = parseType25VendorDate(strongestRecord.vendorDate, controlledOffset(source))!
  const strongestSteps = parseArraySteps(strongestRecord.arraySteps)!
  const transitions = transitionsFrom(source)
  const controlledEnd = transitions[transitions.length - 1].epochMs + TYPE25_SLOT_DURATION_MS
  const strongestSegmentAlignment = strongestSteps.map((steps, slotIndex) => {
    const at = strongestDateMs + slotIndex * TYPE25_SLOT_DURATION_MS
    const minuteIndex = Math.floor((at - transitions[0].epochMs) / TYPE25_SLOT_DURATION_MS)
    const transition = at >= transitions[0].epochMs && at < controlledEnd ? transitions[minuteIndex] : null
    return {
      sourceSlotIndex: slotIndex,
      slotTimestamp: new Date(at).toISOString(),
      steps,
      controlledMinute: transition?.minute ?? null,
      instruction: transition?.instruction ?? 'OUTSIDE_CONTROLLED_WINDOW',
      timingErrorMs: transition ? Math.abs(at - transition.epochMs) : null,
      patternMatch: transition ? (transition.instruction === 'WALK') === (steps > 0) : null,
    }
  })
  const fraction = (id: ModelId) => `${models[id].matchedMinutes}/${models[id].comparedMinutes} matched, ${models[id].mismatchedMinutes} mismatched`
  const [m1, m2] = source.modelA_mismatches

  return deepFreeze({
    schema: TYPE25_ADJUDICATION_SCHEMA,
    adjudicationKind: 'MANUAL_SEMANTIC_ADJUDICATION',
    adjudicatedAt: options.adjudicatedAt,
    originalAttemptId: source.original_attempt_id,
    refreshAttemptId: source.refresh_attempt_id,
    recoveryBuild: source.recovery_build,
    recoverySchema: source.recovery_schema,
    recoveryAnalysisRunAt: source.analysis_run_at,
    evidenceSource: options.evidenceSource,
    evidenceSha256: options.evidenceSha256,
    deviceScope: {
      deviceModel: TYPE25_MINUTE_ANCHOR_POLICY.deviceModel,
      sdkVersion: TYPE25_MINUTE_ANCHOR_POLICY.sdkVersion,
      firmwareVersion: TYPE25_MINUTE_ANCHOR_POLICY.firmwareVersion,
      dataType: TYPE25_MINUTE_ANCHOR_POLICY.dataType,
    },
    recordCounts: {
      originalRecordCount: source.original_record_count,
      refreshedRecordCount: source.refreshed_record_count,
      validArrayCount: source.valid_array_count,
      invalidArrayCount: source.invalid_array_count,
      sumInvariantPassCount: source.sum_invariant_pass_count,
      latestVendorDateBefore: source.latest_vendor_date_before,
      latestVendorDateAfter: source.latest_vendor_date_after,
    },
    candidateModels: source.candidateModels,
    modelRanking: ranking(source),
    modelAUniquelyBest: true,
    conflictingRecordsAllModels: 0,
    modelAMismatches: source.modelA_mismatches,
    strongestPositivePhysicalEvidence: {
      ...strongest,
      arraySteps: strongestRecord.arraySteps,
      detailMinterStep: strongestRecord.detailMinterStep,
      segmentAlignmentUnderModelA: strongestSegmentAlignment,
    },
    operatorExecutionNote: {
      reportedBeforeRecoveryReview: true,
      note: 'The operator independently reported, before the recovery analysis was reviewed, that the 12-minute test was imperfectly executed on approximately two one-minute intervals.',
      treatment: 'Contextual evidence only. The two Model A mismatches are recorded exactly as observed mismatches; no physical evidence is altered.',
    },
    automatedResult: {
      automatedPatternGate: source.controlledPatternMatch,
      automatedSelectedModel: source.selectedTimestampModel,
      selectedTimestampModel: source.selectedTimestampModel,
      arrayOrdering: source.arrayOrdering,
      controlledPatternMatch: source.controlledPatternMatch,
      canonicalMinuteTimestampsDeterministic: source.canonicalMinuteTimestampsDeterministic,
      AUTOMATED_READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: source.READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION,
      verbatim: source,
    },
    adjudicatedResult: {
      TYPE25_SEMANTIC_ADJUDICATION: 'PASS',
      adjudicatedModel: 'FIRST_MINUTE + OLDEST_TO_NEWEST',
      adjudicatedModelId: 'A',
      TYPE25_ANCHOR: TYPE25_MINUTE_ANCHOR_POLICY.dateMeaning,
      TYPE25_ORDER: TYPE25_MINUTE_ANCHOR_POLICY.arrayOrdering,
      TYPE25_SLOT_SECONDS: TYPE25_MINUTE_ANCHOR_POLICY.slotDurationSeconds,
      TYPE25_SEGMENT_SLOTS: TYPE25_MINUTE_ANCHOR_POLICY.segmentSlots,
      confidence: TYPE25_MINUTE_ANCHOR_POLICY.confidence,
      evidenceClass: TYPE25_MINUTE_ANCHOR_POLICY.evidenceClass,
      ADJUDICATED_READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: 'YES',
    },
    readiness: {
      AUTOMATED_READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: source.READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION,
      ADJUDICATED_READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: 'YES',
      note: 'Deliberately separate states. The automated v64 gate is unchanged; the adjudicated state does not write readiness.',
    },
    rationale: [
      'Type25 vendor documentation establishes ten one-minute arraySteps slots per record.',
      `${source.sum_invariant_pass_count}/${source.valid_array_count} valid Type25 arrays pass sum(arraySteps) == detailMinterStep; ${source.invalid_array_count} invalid.`,
      `Model A (FIRST_MINUTE + OLDEST_TO_NEWEST): ${fraction('A')}.`,
      `Model B (LAST_MINUTE + OLDEST_TO_NEWEST): ${fraction('B')}.`,
      `Model C (FIRST_MINUTE + NEWEST_TO_OLDEST): ${fraction('C')}.`,
      `Model D (LAST_MINUTE + NEWEST_TO_OLDEST): ${fraction('D')}.`,
      'Model A is uniquely the best physical fit.',
      'Zero conflicting records in all four models.',
      `The only Model A mismatches are Minute ${m1.minute}: expected ${m1.instruction}, observed ${m1.steps} steps; and Minute ${m2.minute}: expected ${m2.instruction}, observed ${m2.steps} steps.`,
      'The operator independently reported imperfect execution of approximately two one-minute intervals before this recovery analysis was reviewed.',
      `Strongest positive physical evidence: Type25 date ${strongestRecord.vendorDate}, arraySteps ${strongestRecord.arraySteps}. Under FIRST_MINUTE + OLDEST_TO_NEWEST, slot ${strongest.sourceSlotIndex} aligns to controlled Minute ${strongest.controlledMinute} ${strongest.instruction} at ${strongest.transitionTimestamp} with ${strongest.timingErrorMs} ms timing error and ${strongest.steps} steps; the subsequent STILL slots (Minutes 8, 9, 11, 12) align with 0 steps.`,
      'The automated v64 gate (FAIL, selectedTimestampModel = null) is preserved unchanged because its strict acceptance rule requires ≥8 matched minutes; it is not rewritten to PASS.',
    ],
    semanticPolicy: TYPE25_MINUTE_ANCHOR_POLICY,
    canonicalMinuteRule: {
      formula: 'minuteTimestamp[i] = Type25.date + (i × 60 seconds), i = 0..9',
      arrayOrdering: 'arraySteps[0] is the oldest minute; arraySteps[9] is the newest minute',
      requiredInvariants: ['arrayLength == 10', 'sum(arraySteps) == detailMinterStep'],
      onInvariantFailure: 'Preserve source evidence; emit no canonical minute epochs; attach an explicit integrity-withheld reason.',
      gapPolicy: 'Do not synthesize or zero-fill missing minutes or segments between returned Type25 records.',
    },
    evidenceConsistency: {
      result: 'CONSISTENT',
      inconsistencies: [],
      checks: verification.checks,
    },
    safety: {
      bleAcquisitions: 0,
      newType24Acquisitions: 0,
      newType25Acquisitions: 0,
      queueWrites: 0,
      base44Calls: 0,
      canonicalProductionWrites: 0,
      readinessWrites: 0,
      scoringChanges: 0,
      digitalWellnessChanges: 0,
      senderConcurrencyChanges: 0,
      ackBehaviorChanges: 0,
      queueSchemaOrOrderChanges: 0,
      sourceEvidenceModified: false,
      onDeviceV64ResultModified: false,
      workout29_82: 'NOT_RUN',
      base44Published: 'NO',
      commitTag: 'NO',
      p1_2cProductionFinalization: 'NOT_STARTED',
    },
  })
}

export type Type25ManualAdjudicationReport = ReturnType<typeof buildType25ManualAdjudication>
