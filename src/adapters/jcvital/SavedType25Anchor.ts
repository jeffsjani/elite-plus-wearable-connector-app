import { decodeSavedActivitySnapshot } from './SavedActivityFinalizer'
import {
  CONTROLLED_MINUTE_PATTERN, evaluateType25MinuteAnchor,
  type MinuteTransition, type Type25AnchorRecord,
} from './Type25MinuteAnchor'
import type { FailureResult } from './PhysicalSemanticEvidence'

export const SAVED_TYPE25_ANCHOR_ATTEMPT = '43e5cbf4-bd09-4f47-83dc-4eca7ebb63bd'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved Type25 evidence object.')
  return value as Record<string, unknown>
}

export function type25SnapshotFields(snapshot: unknown): Record<string, unknown> {
  const typed = object(snapshot)
  if (typed.type !== 'Map' || !Array.isArray(typed.entries)) throw new Error('Type25 SDK record must be a typed Map.')
  const names = typed.entries.map((raw) => {
    const key = object(object(raw).key)
    if (key.type !== 'String' || typeof key.value !== 'string') throw new Error('Invalid Type25 SDK field name.')
    return key.value
  })
  if (new Set(names).size !== names.length) throw new Error('Duplicate Type25 SDK field name.')
  return object(decodeSavedActivitySnapshot(snapshot))
}

export function savedType25Transitions(saved: FailureResult): MinuteTransition[] {
  const report = saved.result && typeof saved.result === 'object' ? object(saved.result) : {}
  const raw: unknown = report.transitions ?? saved.diagnostics.controlledTransitions
  if (!Array.isArray(raw) || raw.length !== CONTROLLED_MINUTE_PATTERN.length) {
    throw new Error('Saved attempt must contain all 12 controlled transition timestamps; no new pattern will be started.')
  }
  return raw.map((value, index) => {
    const t = object(value)
    const previousEpoch = index > 0 ? object(raw[index - 1]).epochMs : null
    if (t.minute !== index + 1 || t.instruction !== CONTROLLED_MINUTE_PATTERN[index]
      || typeof t.epochMs !== 'number' || !Number.isFinite(t.epochMs)
      || typeof t.monotonicMs !== 'number' || !Number.isFinite(t.monotonicMs)
      || typeof t.localTimestamp !== 'string' || Date.parse(t.localTimestamp) !== t.epochMs
      || (index > 0 && (typeof previousEpoch !== 'number' || t.epochMs <= previousEpoch))) {
      throw new Error(`Invalid saved controlled transition ${index + 1}.`)
    }
    return {
      minute: index + 1, instruction: CONTROLLED_MINUTE_PATTERN[index], epochMs: t.epochMs,
      monotonicMs: t.monotonicMs, localTimestamp: t.localTimestamp,
    }
  })
}

export function analyzeSavedType25Records(records: readonly Type25AnchorRecord[], transitions: readonly MinuteTransition[]) {
  const analysis = evaluateType25MinuteAnchor(records, transitions)
  const checked = records.map((record) => {
    const tokens = typeof record.arraySteps === 'string' && record.arraySteps.trim()
      ? record.arraySteps.trim().split(/\s+/) : []
    const validSlots = tokens.length === 10 && tokens.every((value) => /^\d+$/.test(value)
      && Number.isSafeInteger(Number(value)) && Number(value) <= 255)
    const declared = typeof record.detailMinterStep === 'number' ? record.detailMinterStep
      : typeof record.detailMinterStep === 'string' && /^\d+$/.test(record.detailMinterStep)
        ? Number(record.detailMinterStep) : null
    const sumArraySteps = validSlots ? tokens.reduce((sum, value) => sum + Number(value), 0) : null
    return {
      sourceEnvelopeId: record.sourceEnvelopeId,
      vendorDate: record.vendorDate,
      parsedDateMs: record.parsedDateMs,
      timezone: record.timezone,
      detailMinterStep: record.detailMinterStep,
      arraySteps: record.arraySteps,
      arrayLength: tokens.length, sumArraySteps,
      sumArrayStepsEqualsDetailMinterStep: validSlots && declared !== null
        && Number.isSafeInteger(declared) && declared >= 0 && sumArraySteps === declared,
    }
  })
  const overlappingRecordIds = analysis.records.filter((record) =>
    record.parsedDateMs !== null && Number.isFinite(record.parsedDateMs)).map((record) => record.sourceEnvelopeId)
  return {
    analyzedAt: new Date().toISOString(),
    transitions: [...transitions],
    controlledWindow: {
      start: transitions[0].localTimestamp,
      lastTransition: transitions[11].localTimestamp,
      endExclusive: new Date(transitions[0].epochMs + 12 * 60_000).toISOString(),
    },
    records: checked,
    allRecordInvariantsPass: checked.length > 0 && checked.every((record) => record.sumArrayStepsEqualsDetailMinterStep),
    overlappingRecordIds,
    overlappingRecordCount: overlappingRecordIds.length,
    overlapDeterminate: checked.every((record) => record.parsedDateMs !== null && Number.isFinite(record.parsedDateMs)),
    usableOverlappingRecordCount: checked.filter((record) => overlappingRecordIds.includes(record.sourceEnvelopeId)
      && record.sumArrayStepsEqualsDetailMinterStep).length,
    fits: analysis.fits,
    selectedModel: analysis.selected?.id ?? null,
    patternPass: analysis.patternPass,
    bleAcquisitions: 0,
    queueWrites: 0, base44Calls: 0, canonicalWrites: 0, readinessWrites: 0,
  }
}

export const TYPE25_RECOVERY_SCHEMA = 'eliteplus.p1-2b.type25-anchor-recovery.v2'
export const TYPE25_RECOVERY_BUILD = 'v64'

type RecoveryContext = {
  originalAttemptId: string
  originalRecords: readonly Type25AnchorRecord[]
  refreshedRecords: readonly Type25AnchorRecord[]
  transitions: readonly MinuteTransition[]
  refreshReason: string
  bleAcquisitions: number
  refreshAttemptId?: string | null
  protectedWrites: { queueWrites: number; base44Calls: number; canonicalWrites: number; readinessWrites: number }
  refreshIsolationPassed?: boolean
}

function latestVendorDate(records: readonly Type25AnchorRecord[]): string | null {
  let latest: Type25AnchorRecord | null = null
  for (const record of records) {
    if (record.parsedDateMs === null || !Number.isFinite(record.parsedDateMs)) continue
    if (!latest || record.parsedDateMs > latest.parsedDateMs!) latest = record
  }
  return latest?.vendorDate ?? null
}

/**
 * Combines original saved and newly refreshed Type25 records. A refreshed record with the same
 * vendor date supersedes the original one (the device may have completed an in-progress segment);
 * conflicts within a single acquisition remain conflicts.
 */
export function combineType25Records(original: readonly Type25AnchorRecord[], refreshed: readonly Type25AnchorRecord[]) {
  const refreshedDates = new Set(refreshed.map((record) => record.vendorDate).filter((date): date is string => date !== null))
  const superseded = original.filter((record) => record.vendorDate !== null && refreshedDates.has(record.vendorDate))
  return {
    records: [...original.filter((record) => !superseded.includes(record)), ...refreshed],
    supersededOriginalRecordIds: superseded.map((record) => record.sourceEnvelopeId),
  }
}

export function buildType25RecoveryAnalysis(context: RecoveryContext) {
  const combined = combineType25Records(context.originalRecords, context.refreshedRecords)
  const {
    queueWrites: _q, base44Calls: _b, canonicalWrites: _c, readinessWrites: _r, bleAcquisitions: _ble, ...base
  } = analyzeSavedType25Records(combined.records, context.transitions)
  const selected = base.patternPass ? base.fits.find((fit) => fit.id === base.selectedModel) ?? null : null
  const resolved = Boolean(selected) && base.patternPass
  const writes = context.protectedWrites
  const zeroWrites = writes.queueWrites === 0 && writes.base44Calls === 0
    && writes.canonicalWrites === 0 && writes.readinessWrites === 0
  const ready = resolved && base.allRecordInvariantsPass && zeroWrites && context.refreshIsolationPassed !== false
  return {
    recovery_schema: TYPE25_RECOVERY_SCHEMA,
    recovery_build: TYPE25_RECOVERY_BUILD,
    original_attempt_id: context.originalAttemptId,
    refresh_attempt_id: context.refreshAttemptId ?? null,
    analysis_run_at: new Date().toISOString(),
    original_record_count: context.originalRecords.length,
    refreshed_record_count: context.refreshedRecords.length,
    superseded_original_record_ids: combined.supersededOriginalRecordIds,
    latest_vendor_date_before: latestVendorDate(context.originalRecords),
    latest_vendor_date_after: latestVendorDate(combined.records),
    valid_array_count: base.records.filter((record) => record.arrayLength === 10 && record.sumArraySteps !== null).length,
    invalid_array_count: base.records.filter((record) => record.arrayLength !== 10 || record.sumArraySteps === null).length,
    sum_invariant_pass_count: base.records.filter((record) => record.sumArrayStepsEqualsDetailMinterStep).length,
    candidateModels: Object.fromEntries(base.fits.map((fit) => [fit.id, {
      anchor: fit.anchor, ordering: fit.ordering,
      comparedMinutes: fit.comparedMinutes, matchedMinutes: fit.matchedMinutes,
      mismatchedMinutes: fit.mismatchedMinutes, maximumTimingErrorMs: fit.maximumTimingErrorMs,
      overlappingRecords: fit.overlappingRecords, conflictCount: fit.conflicts.length,
      supported: fit.comparedMinutes >= 8 && fit.matchedMinutes >= 8 && fit.matchedMinutes / fit.comparedMinutes >= 0.8,
    }])) as Record<'A' | 'B' | 'C' | 'D', unknown>,
    selectedTimestampModel: selected ? `${selected.anchor} + ${selected.ordering}` : null,
    arrayOrdering: selected?.ordering ?? null,
    controlledPatternMatch: base.patternPass ? 'PASS' as const : 'FAIL' as const,
    canonicalMinuteTimestampsDeterministic: resolved ? 'YES' as const : 'NO' as const,
    refreshReason: context.refreshReason,
    ...writes,
    READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: ready ? 'YES' as const : 'NO' as const,
    ...base,
    bleAcquisitions: context.bleAcquisitions,
    parentAttemptId: context.originalAttemptId,
  }
}

export type SavedType25Analysis = ReturnType<typeof buildType25RecoveryAnalysis>

type ResolutionFields = {
  selectedTimestampModel?: unknown
  controlledPatternMatch?: unknown
  canonicalMinuteTimestampsDeterministic?: unknown
}

export function type25SemanticResolutionAchieved(value: ResolutionFields | null | undefined): boolean {
  return Boolean(value && typeof value.selectedTimestampModel === 'string' && value.selectedTimestampModel
    && value.controlledPatternMatch === 'PASS' && value.canonicalMinuteTimestampsDeterministic === 'YES')
}

export type Type25RefreshEligibility = {
  enabled: boolean
  reasons: string[]
  refreshReason: string | null
}

/**
 * Refresh is enabled whenever a complete saved attempt has not uniquely resolved the anchor.
 * Possible (ambiguous) overlap of saved records with the controlled window never disables it.
 */
export function type25RefreshEligibility(
  saved: FailureResult | null,
  analyses: ReadonlyArray<ResolutionFields & { original_attempt_id?: unknown } | null | undefined>,
): Type25RefreshEligibility {
  const reasons: string[] = []
  if (!saved || typeof saved !== 'object') return { enabled: false, reasons: ['NO_SAVED_ATTEMPT'], refreshReason: null }
  try {
    if (typeof saved.attempt_id !== 'string' || !saved.attempt_id) reasons.push('SAVED_ATTEMPT_ID_MISSING')
    if (saved.status !== 'COMPLETE') reasons.push(`SAVED_ATTEMPT_STATUS_${String(saved.status ?? 'MISSING')}`)
    try { savedType25Transitions(saved) } catch { reasons.push('CONTROLLED_TRANSITIONS_INCOMPLETE') }
    const report = saved.result && typeof saved.result === 'object' ? saved.result as Record<string, unknown> & ResolutionFields : null
    const journal = report?.sourceJournalEvidence && typeof report.sourceJournalEvidence === 'object'
      ? report.sourceJournalEvidence as Record<string, unknown> : null
    const persisted = saved.diagnostics?.sourceEvidencePersistedBeforeAnalysis
    const persistedFlag = (persisted && typeof persisted === 'object' && (persisted as Record<string, unknown>).persistedBeforeAnalysis === true)
      || journal?.persistedBeforeAnalysis === true
    if (!Array.isArray(saved.source_journal_refs) || saved.source_journal_refs.length === 0 || !persistedFlag) {
      reasons.push('SOURCE_EVIDENCE_NOT_PERSISTED')
    }
    if (reasons.length) return { enabled: false, reasons, refreshReason: null }
    const matching = analyses.filter((analysis) => analysis && analysis.original_attempt_id === saved.attempt_id)
    if (type25SemanticResolutionAchieved(report) || matching.some(type25SemanticResolutionAchieved)) {
      return { enabled: false, reasons: ['UNIQUE_SEMANTIC_RESOLUTION_ACHIEVED'], refreshReason: null }
    }
  } catch {
    return { enabled: false, reasons: ['SAVED_ATTEMPT_CORRUPT'], refreshReason: null }
  }
  return {
    enabled: true, reasons: [],
    refreshReason: 'SAVED_ANALYSIS_UNRESOLVED: no unique selectedTimestampModel with controlledPatternMatch=PASS and '
      + 'canonicalMinuteTimestampsDeterministic=YES; ambiguous possible overlap does not block refresh.',
  }
}
