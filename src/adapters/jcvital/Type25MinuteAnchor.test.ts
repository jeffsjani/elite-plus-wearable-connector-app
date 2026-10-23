import { describe, expect, it } from 'vitest'
import {
  CONTROLLED_MINUTE_PATTERN, evaluateType25MinuteAnchor, type MinuteTransition, type Type25AnchorRecord,
} from './Type25MinuteAnchor'

const start = Date.parse('2026-10-20T12:00:00.000Z')
const transitions: MinuteTransition[] = CONTROLLED_MINUTE_PATTERN.map((instruction, index) => {
  const epochMs = start + index * 60_000
  return {
    minute: index + 1, instruction, epochMs, monotonicMs: index * 60_000,
    localTimestamp: new Date(epochMs).toISOString(),
  }
})

function record(changes: Partial<Type25AnchorRecord> = {}): Type25AnchorRecord {
  const values: number[] = CONTROLLED_MINUTE_PATTERN.slice(0, 10).map((instruction) => instruction === 'WALK' ? 20 : 0)
  return {
    sourceEnvelopeId: 'record-1',
    sourceEnvelope: '{"vendorDataType":"25"}',
    vendorDate: '2026-10-20 12:00:00',
    parsedDateMs: start,
    timezone: 'UTC',
    callbackTimestamp: '2026-10-20T12:10:00.000Z',
    receiptTimestamp: '2026-10-20T12:10:00.000Z',
    detailMinterStep: String(values.reduce((sum, value) => sum + value, 0)),
    arraySteps: values.join(' '),
    ...changes,
  }
}

describe('Type25 minute timestamp anchor', () => {
  it('uses the exact requested 12-minute STILL/WALK pattern', () => {
    expect(CONTROLLED_MINUTE_PATTERN).toEqual([
      'STILL', 'WALK', 'STILL', 'WALK', 'WALK', 'STILL',
      'WALK', 'STILL', 'STILL', 'WALK', 'STILL', 'STILL',
    ])
  })

  it('uniquely identifies first-minute and oldest-to-newest for the controlled pattern', () => {
    const result = evaluateType25MinuteAnchor([record()], transitions)
    expect(result.records).toHaveLength(1)
    expect(result.invariantPass).toBe(true)
    expect(result.uniqueBest).toBe(true)
    expect(result.fits.map((fit) => fit.id)).toEqual(['A', 'B', 'C', 'D'])
    expect(result.selected).toMatchObject({ id: 'A', anchor: 'FIRST_MINUTE', ordering: 'OLDEST_TO_NEWEST' })
    expect(result.patternPass).toBe(true)
    expect(result.selected?.maximumTimingErrorMs).toBe(0)
  })

  it('rejects invalid ten-slot shape and total-step invariant', () => {
    const malformed = record({ arraySteps: '0 1 0 1 1 0 1 0 0' })
    const incorrectTotal = record({ detailMinterStep: '999' })
    expect(evaluateType25MinuteAnchor([malformed], transitions).invariantPass).toBe(false)
    expect(evaluateType25MinuteAnchor([incorrectTotal], transitions).invariantPass).toBe(false)
  })

  it.each([
    ['A', false, false], ['B', true, false], ['C', false, true], ['D', true, true],
  ] as const)('selects model %s only when supported by the saved WALK/STILL pattern', (id, last, reversed) => {
    const values = CONTROLLED_MINUTE_PATTERN.slice(0, 10).map((instruction) => instruction === 'WALK' ? 20 : 0)
    if (reversed) values.reverse()
    const result = evaluateType25MinuteAnchor([record({
      parsedDateMs: start + (last ? 9 : 0) * 60_000,
      arraySteps: values.join(' '),
    })], transitions)
    expect(result.selected?.id).toBe(id)
    expect(result.invariantPass).toBe(true)
    expect(result.patternPass).toBe(true)
  })

  it('does not select a model from an uninformative STILL-only signal', () => {
    const result = evaluateType25MinuteAnchor([record({
      arraySteps: '0 0 0 0 0 0 0 0 0 0', detailMinterStep: '0',
    })], transitions)
    expect(result.invariantPass).toBe(true)
    expect(result.selected).toBeNull()
    expect(result.patternPass).toBe(false)
  })

  it('marks overlapping source records with conflicting values', () => {
    const original = record()
    const conflictValues: number[] = CONTROLLED_MINUTE_PATTERN.slice(0, 10).map((instruction) => instruction === 'WALK' ? 20 : 0)
    conflictValues[1] = 0
    const conflict = record({
      sourceEnvelopeId: 'record-2',
      arraySteps: conflictValues.join(' '),
      detailMinterStep: String(conflictValues.reduce((sum, value) => sum + value, 0)),
    })
    const result = evaluateType25MinuteAnchor([original, conflict], transitions)
    expect(result.conflictingRecords).toBe(true)
    expect(result.selected).toBeNull()
    expect(result.patternPass).toBe(false)
  })

  it('treats exact same-timestamp source replay as a duplicate, not a conflict', () => {
    const result = evaluateType25MinuteAnchor([
      record({ sourceEnvelopeId: 'record-1', payloadFingerprint: '{"arraySteps":"0"}' }),
      record({ sourceEnvelopeId: 'record-2', payloadFingerprint: '{"arraySteps":"0"}' }),
    ], transitions)
    expect(result.conflictingRecords).toBe(false)
    expect(result.patternPass).toBe(true)
  })

  it('fails closed when a same-local-day record has no parsed timestamp', () => {
    const result = evaluateType25MinuteAnchor([record({ parsedDateMs: null })], transitions)
    expect(result.records).toHaveLength(1)
    expect(result.invariantPass).toBe(false)
    expect(result.selected).toBeNull()
    expect(result.patternPass).toBe(false)
  })
})
