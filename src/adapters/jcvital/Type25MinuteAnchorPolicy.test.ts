import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  buildType25ManualAdjudication,
  expandType25Segment,
  expandType25Segments,
  parseType25VendorDate,
  TYPE25_MINUTE_ANCHOR_POLICY,
  Type25AdjudicationEvidenceError,
  type25PolicyApplies,
  type Type25V64RecoveryExport,
} from './Type25MinuteAnchorPolicy'

const evidencePath = fileURLToPath(new URL('../../../docs/evidence/p1-2b/type25-v64-recovery-export.json', import.meta.url))
const reportPath = fileURLToPath(new URL('../../../docs/evidence/p1-2b/type25-manual-semantic-adjudication.json', import.meta.url))
const evidenceRaw = readFileSync(evidencePath, 'utf8')
const evidence = (): Type25V64RecoveryExport => JSON.parse(evidenceRaw)
const options = {
  adjudicatedAt: '2026-10-20T22:30:00.000Z',
  evidenceSource: 'docs/evidence/p1-2b/type25-v64-recovery-export.json',
  evidenceSha256: createHash('sha256').update(evidenceRaw).digest('hex'),
}
const scope = { deviceModel: 'PRO_V8', sdkVersion: 'v8sdk2.0', firmwareVersion: '0.0.8.8' }
const date = parseType25VendorDate('2026.10.20 10:28:53', '-07:00')!
const segment = { sourceEnvelopeId: '023d885d-bfec-40d2-823c-bb36b8553407', dateEpochMs: date, detailMinterStep: '10', arraySteps: '10 0 0 0 0 0 0 0 0 0' }

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.freeze(value)
    Object.values(value as Record<string, unknown>).forEach(deepFreeze)
  }
  return value
}

describe('Type25 manual semantic adjudication', () => {
  it('adjudicates FIRST_MINUTE + OLDEST_TO_NEWEST while preserving the automated FAIL gate', () => {
    const report = buildType25ManualAdjudication(evidence(), options)
    expect(report.adjudicatedResult).toMatchObject({
      TYPE25_SEMANTIC_ADJUDICATION: 'PASS', adjudicatedModel: 'FIRST_MINUTE + OLDEST_TO_NEWEST',
      TYPE25_ANCHOR: 'FIRST_MINUTE', TYPE25_ORDER: 'OLDEST_TO_NEWEST', TYPE25_SLOT_SECONDS: 60, TYPE25_SEGMENT_SLOTS: 10,
      confidence: 'HIGH', evidenceClass: 'MANUAL_ADJUDICATED_PHYSICAL_HIGH_CONFIDENCE',
      ADJUDICATED_READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: 'YES',
    })
    expect(report.automatedResult).toMatchObject({
      automatedPatternGate: 'FAIL', automatedSelectedModel: null, selectedTimestampModel: null,
      controlledPatternMatch: 'FAIL', canonicalMinuteTimestampsDeterministic: 'NO',
      AUTOMATED_READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: 'NO',
    })
    expect(report.automatedResult.verbatim).toEqual(evidence())
    expect(report.modelRanking).toEqual(['A', 'C', 'D', 'B'])
    expect(report.rationale).toEqual(expect.arrayContaining([
      'Model A (FIRST_MINUTE + OLDEST_TO_NEWEST): 7/9 matched, 2 mismatched.',
      'Model B (LAST_MINUTE + OLDEST_TO_NEWEST): 3/7 matched, 4 mismatched.',
      'Model C (FIRST_MINUTE + NEWEST_TO_OLDEST): 5/9 matched, 4 mismatched.',
      'Model D (LAST_MINUTE + NEWEST_TO_OLDEST): 4/7 matched, 3 mismatched.',
      '655/655 valid Type25 arrays pass sum(arraySteps) == detailMinterStep; 0 invalid.',
      'The only Model A mismatches are Minute 2: expected WALK, observed 0 steps; and Minute 10: expected WALK, observed 0 steps.',
    ]))
    expect(report.modelAMismatches.map((match) => [match.minute, match.instruction, match.steps, match.patternMatch]))
      .toEqual([[2, 'WALK', 0, false], [10, 'WALK', 0, false]])
    expect(report.strongestPositivePhysicalEvidence.segmentAlignmentUnderModelA[0])
      .toMatchObject({ controlledMinute: 7, instruction: 'WALK', steps: 10, timingErrorMs: 1442, patternMatch: true })
    expect(report.evidenceConsistency.inconsistencies).toEqual([])
    const counters = Object.values(report.safety).filter((value) => typeof value === 'number')
    expect(counters.length).toBe(12)
    expect(counters.every((value) => value === 0)).toBe(true)
    expect(report.safety).toMatchObject({ workout29_82: 'NOT_RUN', base44Published: 'NO', commitTag: 'NO', sourceEvidenceModified: false })
  })

  it('cannot mutate the automated evidence', () => {
    const frozenInput = deepFreeze(evidence())
    const report = buildType25ManualAdjudication(frozenInput, options)
    expect(frozenInput).toEqual(evidence())
    expect(report.automatedResult.verbatim).not.toBe(frozenInput)
    expect(Object.isFrozen(report.automatedResult.verbatim)).toBe(true)
    expect(() => { (report.automatedResult.verbatim as { controlledPatternMatch: string }).controlledPatternMatch = 'PASS' }).toThrow(TypeError)
    expect(() => { (report.automatedResult as { automatedSelectedModel: string | null }).automatedSelectedModel = 'A' }).toThrow(TypeError)
    expect(readFileSync(evidencePath, 'utf8')).toBe(evidenceRaw)
    expect(evidence().selectedTimestampModel).toBeNull()
    expect(evidence().READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION).toBe('NO')
  })

  it('stops on internally inconsistent evidence instead of correcting it', () => {
    const altered = evidence()
    altered.candidateModels.A.matchedMinutes = 8
    expect(() => buildType25ManualAdjudication(altered, options)).toThrow(Type25AdjudicationEvidenceError)
    const wrongStep = evidence()
    wrongStep.modelA_mismatches[1].steps = 5
    expect(() => buildType25ManualAdjudication(wrongStep, options)).toThrow(/inconsistent/)
  })

  it('matches the persisted adjudication report and evidence hash', () => {
    const persisted = JSON.parse(readFileSync(reportPath, 'utf8'))
    expect(persisted.evidenceSha256).toBe(options.evidenceSha256)
    const rebuilt = buildType25ManualAdjudication(evidence(), { ...options, adjudicatedAt: persisted.adjudicatedAt })
    expect(persisted).toEqual(JSON.parse(JSON.stringify(rebuilt)))
  })
})

describe('jcvital.type25.minute_anchor.v1 policy', () => {
  it('is persisted with the adjudicated semantics and is immutable', () => {
    expect(TYPE25_MINUTE_ANCHOR_POLICY).toEqual({
      policyId: 'jcvital.type25.minute_anchor.v1', deviceModel: 'PRO_V8', sdkVersion: 'v8sdk2.0', firmwareVersion: '0.0.8.8',
      dataType: 25, dateMeaning: 'FIRST_MINUTE', arrayOrdering: 'OLDEST_TO_NEWEST', slotDurationSeconds: 60, segmentSlots: 10,
      confidence: 'HIGH', evidenceClass: 'MANUAL_ADJUDICATED_PHYSICAL_HIGH_CONFIDENCE',
      originalAttemptId: '43e5cbf4-bd09-4f47-83dc-4eca7ebb63bd', refreshAttemptId: '148f4e10-ed42-4448-8c13-4b1806a2f8f1',
    })
    expect(Object.isFrozen(TYPE25_MINUTE_ANCHOR_POLICY)).toBe(true)
  })

  it('is scoped to PRO_V8 + v8sdk2.0 + FW 0.0.8.8', () => {
    expect(type25PolicyApplies(scope)).toBe(true)
    for (const other of [
      { ...scope, deviceModel: 'PRO_V9' }, { ...scope, sdkVersion: 'v8sdk2.1' }, { ...scope, firmwareVersion: '0.0.8.9' },
    ]) {
      expect(type25PolicyApplies(other)).toBe(false)
      expect(expandType25Segment(segment, other)).toMatchObject({ status: 'INTEGRITY_WITHHELD', reason: 'POLICY_SCOPE_MISMATCH', minutes: [] })
    }
  })

  it('generates deterministic minute timestamps: i=0 is Type25.date, i=9 is date + 9 minutes', () => {
    const first = expandType25Segment(segment, scope)
    expect(expandType25Segment(segment, scope)).toEqual(first)
    expect(first.status).toBe('EXPANDED')
    expect(first.minutes).toHaveLength(10)
    expect(first.minutes[0]).toMatchObject({ slotIndex: 0, epochMs: date, minuteTimestamp: '2026-10-20T17:28:53.000Z', steps: 10 })
    expect(first.minutes[9]).toMatchObject({ slotIndex: 9, epochMs: date + 9 * 60_000, minuteTimestamp: '2026-10-20T17:37:53.000Z' })
    first.minutes.forEach((minute, index) => expect(minute.epochMs).toBe(date + index * 60_000))
  })

  it('preserves oldest-to-newest ordering of arraySteps', () => {
    const result = expandType25Segment({ ...segment, detailMinterStep: 45, arraySteps: '0 1 2 3 4 5 6 7 8 9' }, scope)
    expect(result.minutes.map((minute) => minute.steps)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    expect(result.minutes.map((minute) => minute.epochMs)).toEqual([...result.minutes.map((minute) => minute.epochMs)].sort((a, b) => a - b))
  })

  it('withholds canonical expansion when arrayLength is not 10', () => {
    for (const arraySteps of ['10 0 0 0 0 0 0 0 0', '10 0 0 0 0 0 0 0 0 0 0']) {
      const source = { ...segment, arraySteps }
      const result = expandType25Segment(source, scope)
      expect(result).toMatchObject({ status: 'INTEGRITY_WITHHELD', reason: 'ARRAY_LENGTH_NOT_10', minutes: [] })
      expect(source.arraySteps).toBe(arraySteps)
    }
  })

  it('withholds canonical expansion when sum(arraySteps) != detailMinterStep', () => {
    const result = expandType25Segment({ ...segment, detailMinterStep: '11' }, scope)
    expect(result).toMatchObject({ status: 'INTEGRITY_WITHHELD', reason: 'SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP', minutes: [] })
    if (result.status === 'INTEGRITY_WITHHELD') expect(result.detail).toBe('sum(arraySteps) = 10; detailMinterStep = 11.')
  })

  it('does not zero-fill missing Type25 segments between returned records', () => {
    const earlier = {
      sourceEnvelopeId: '91dde3ab-8828-45bb-b205-c159e4f8e282',
      dateEpochMs: parseType25VendorDate('2026.10.20 10:16:06', '-07:00'),
      detailMinterStep: '123', arraySteps: '77 0 0 46 0 0 0 0 0 0',
    }
    const invalid = { ...segment, sourceEnvelopeId: 'bad', dateEpochMs: date + 20 * 60_000, detailMinterStep: '1' }
    const { expansions, minutes } = expandType25Segments([segment, invalid, earlier], scope)
    expect(expansions.map((expansion) => expansion.status)).toEqual(['EXPANDED', 'INTEGRITY_WITHHELD', 'EXPANDED'])
    expect(minutes).toHaveLength(20)
    expect(minutes[9].minuteTimestamp).toBe('2026-10-20T17:25:06.000Z')
    expect(minutes[10].minuteTimestamp).toBe('2026-10-20T17:28:53.000Z')
    expect(minutes.some((minute) => minute.epochMs > minutes[9].epochMs && minute.epochMs < minutes[10].epochMs)).toBe(false)
    expect(minutes.some((minute) => minute.sourceEnvelopeId === 'bad')).toBe(false)
  })

  it('parses vendor dates with an explicit offset and rejects malformed dates', () => {
    expect(new Date(date).toISOString()).toBe('2026-10-20T17:28:53.000Z')
    expect(parseType25VendorDate('2026.13.20 10:28:53', '-07:00')).toBeNull()
    expect(parseType25VendorDate('2026-10-20 10:28:53', '-07:00')).toBeNull()
    expect(expandType25Segment({ ...segment, dateEpochMs: null }, scope)).toMatchObject({ reason: 'MISSING_OR_INVALID_DATE', minutes: [] })
  })
})
