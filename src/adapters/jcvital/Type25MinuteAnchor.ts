export const CONTROLLED_MINUTE_PATTERN = [
  'STILL', 'WALK', 'STILL', 'WALK', 'WALK', 'STILL',
  'WALK', 'STILL', 'STILL', 'WALK', 'STILL', 'STILL',
] as const

export const TYPE25_ANCHOR_MODELS = [
  { id: 'A', anchor: 'FIRST_MINUTE', ordering: 'OLDEST_TO_NEWEST' },
  { id: 'B', anchor: 'LAST_MINUTE', ordering: 'OLDEST_TO_NEWEST' },
  { id: 'C', anchor: 'FIRST_MINUTE', ordering: 'NEWEST_TO_OLDEST' },
  { id: 'D', anchor: 'LAST_MINUTE', ordering: 'NEWEST_TO_OLDEST' },
] as const

export type Type25AnchorModel = typeof TYPE25_ANCHOR_MODELS[number]

export type MinuteTransition = {
  minute: number
  instruction: typeof CONTROLLED_MINUTE_PATTERN[number]
  localTimestamp: string
  epochMs: number
  monotonicMs: number
}

export type Type25AnchorRecord = {
  sourceEnvelopeId: string
  sourceEnvelope: string
  vendorDate: string | null
  parsedDateMs: number | null
  timezone: string | null
  callbackTimestamp: string | null
  receiptTimestamp: string | null
  payloadFingerprint?: string
  detailMinterStep: unknown
  arraySteps: unknown
}

export type Type25MinuteMatch = {
  sourceEnvelopeId: string
  sourceSlotIndex: number
  minute: number
  instruction: typeof CONTROLLED_MINUTE_PATTERN[number]
  slotTimestamp: string
  transitionTimestamp: string
  timingErrorMs: number
  steps: number
  patternMatch: boolean
}

export type Type25ModelFit = Type25AnchorModel & {
  comparedMinutes: number
  matchedMinutes: number
  mismatchedMinutes: number
  maximumTimingErrorMs: number | null
  totalTimingErrorMs: number
  overlappingRecords: string[]
  conflicts: Array<{ minute: string; sourceEnvelopeIds: string[]; values: number[] }>
  matches: Type25MinuteMatch[]
}

function timestamp(epochMs: number): string {
  return new Date(epochMs).toISOString()
}

function steps(record: Type25AnchorRecord): number[] | null {
  if (typeof record.arraySteps !== 'string') return null
  const values = record.arraySteps.trim().split(/\s+/)
  if (values.length !== 10 || values.some((value) => !/^\d+$/.test(value))) return null
  const parsed = values.map(Number)
  return parsed.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 255) ? parsed : null
}

function total(record: Type25AnchorRecord): number | null {
  const value = typeof record.detailMinterStep === 'number' ? record.detailMinterStep
    : typeof record.detailMinterStep === 'string' && /^\d+$/.test(record.detailMinterStep) ? Number(record.detailMinterStep)
      : null
  return value !== null && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function slotTimestamp(recordDateMs: number, slotIndex: number, model: Type25AnchorModel): number {
  const chronologicalIndex = model.ordering === 'OLDEST_TO_NEWEST' ? slotIndex : 9 - slotIndex
  return model.anchor === 'FIRST_MINUTE'
    ? recordDateMs + chronologicalIndex * 60_000
    : recordDateMs - (9 - chronologicalIndex) * 60_000
}

function compareFit(a: Type25ModelFit, b: Type25ModelFit): number {
  return b.matchedMinutes - a.matchedMinutes
    || a.mismatchedMinutes - b.mismatchedMinutes
    || a.totalTimingErrorMs - b.totalTimingErrorMs
}

export function evaluateType25MinuteAnchor(
  records: readonly Type25AnchorRecord[],
  transitions: readonly MinuteTransition[],
): {
  records: Type25AnchorRecord[]
  invariantPass: boolean
  fits: Type25ModelFit[]
  selected: Type25ModelFit | null
  uniqueBest: boolean
  patternPass: boolean
  conflictingRecords: boolean
} {
  if (transitions.length !== CONTROLLED_MINUTE_PATTERN.length
    || transitions.some((transition, index) => transition.minute !== index + 1
      || transition.instruction !== CONTROLLED_MINUTE_PATTERN[index])) {
    throw new Error('The complete controlled 12-minute transition sequence is required.')
  }
  const start = transitions[0].epochMs
  const end = start + CONTROLLED_MINUTE_PATTERN.length * 60_000
  const controlledLocalDate = transitions[0].localTimestamp.slice(0, 10)
  const candidates = records.filter((record) => {
    if (record.parsedDateMs === null || !Number.isFinite(record.parsedDateMs)) {
      return record.vendorDate?.slice(0, 10) === controlledLocalDate
    }
    return TYPE25_ANCHOR_MODELS.some((model) =>
      Array.from({ length: 10 }, (_, index) => index).some((index) => {
        const at = slotTimestamp(record.parsedDateMs!, index, model)
        return at >= start && at < end
      }))
  })
  const invariantPass = candidates.length > 0 && candidates.every((record) => {
    const values = steps(record)
    const declared = total(record)
    return record.parsedDateMs !== null && Number.isFinite(record.parsedDateMs)
      && values !== null && declared !== null && values.reduce((sum, value) => sum + value, 0) === declared
  })
  const fits: Type25ModelFit[] = TYPE25_ANCHOR_MODELS.map((model) => {
    const slots: Array<{
      record: Type25AnchorRecord
      index: number
      value: number
      at: number
      minuteIndex: number
    }> = []
    for (const record of candidates) {
      if (record.parsedDateMs === null || !Number.isFinite(record.parsedDateMs)) continue
      const values = steps(record)
      if (!values) continue
      const mapped = values.map((value, index) => ({ value, index, at: slotTimestamp(record.parsedDateMs!, index, model) }))
      const overlaps = mapped.filter(({ at }) => at >= start && at < end)
      for (const slot of overlaps) {
        slots.push({ record, index: slot.index, value: slot.value, at: slot.at, minuteIndex: Math.floor((slot.at - start) / 60_000) })
      }
    }
    const uniqueSlots = new Map<string, typeof slots[number]>()
    const conflictingSlots = new Map<string, typeof slots>()
    for (const slot of slots) {
      const key = String(slot.at)
      const current = uniqueSlots.get(key)
      if (current && current.value !== slot.value) {
        conflictingSlots.set(key, [...(conflictingSlots.get(key) ?? [current]), slot])
      } else if (!current) uniqueSlots.set(key, slot)
    }
    const matches: Type25MinuteMatch[] = [...uniqueSlots.values()].sort((a, b) => a.at - b.at).map((slot) => {
      const instruction = CONTROLLED_MINUTE_PATTERN[slot.minuteIndex]
      const transition = transitions[slot.minuteIndex]
      const walkingSignal = slot.value > 0
      return {
        sourceEnvelopeId: slot.record.sourceEnvelopeId,
        sourceSlotIndex: slot.index,
        minute: slot.minuteIndex + 1,
        instruction,
        slotTimestamp: timestamp(slot.at),
        transitionTimestamp: transition.localTimestamp,
        timingErrorMs: Math.abs(slot.at - transition.epochMs),
        steps: slot.value,
        patternMatch: instruction === 'WALK' ? walkingSignal : !walkingSignal,
      }
    })
    const conflicts = [...conflictingSlots.entries()].map(([at, values]) => ({
      minute: timestamp(Number(at)),
      sourceEnvelopeIds: [...new Set(values.map((slot) => slot.record.sourceEnvelopeId))],
      values: [...new Set(values.map((slot) => slot.value))],
    }))
    const maxError = matches.length ? Math.max(...matches.map((match) => match.timingErrorMs)) : null
    return {
      ...model,
      comparedMinutes: matches.length,
      matchedMinutes: matches.filter((match) => match.patternMatch).length,
      mismatchedMinutes: matches.filter((match) => !match.patternMatch).length,
      maximumTimingErrorMs: maxError,
      totalTimingErrorMs: matches.reduce((sum, match) => sum + match.timingErrorMs, 0),
      overlappingRecords: [...new Set(matches.map((match) => match.sourceEnvelopeId))],
      conflicts,
      matches,
    }
  })
  const ranked = [...fits].sort(compareFit)
  const best = ranked[0] ?? null
  const uniqueBest = Boolean(best && (!ranked[1] || compareFit(best, ranked[1]) < 0))
  const timestampConflicts: Type25ModelFit['conflicts'] = []
  for (let left = 0; left < candidates.length; left++) {
    for (let right = left + 1; right < candidates.length; right++) {
      const first = candidates[left]
      const second = candidates[right]
      const sameTimestamp = first.vendorDate !== null && first.vendorDate === second.vendorDate
      const differentPayload = first.payloadFingerprint !== undefined && second.payloadFingerprint !== undefined
        ? first.payloadFingerprint !== second.payloadFingerprint
        : first.arraySteps !== second.arraySteps || first.detailMinterStep !== second.detailMinterStep
      if (sameTimestamp && differentPayload) {
        timestampConflicts.push({
          minute: first.vendorDate!,
          sourceEnvelopeIds: [first.sourceEnvelopeId, second.sourceEnvelopeId],
          values: [total(first) ?? -1, total(second) ?? -1],
        })
      }
    }
  }
  if (timestampConflicts.length) {
    for (const fit of fits) fit.conflicts.push(...timestampConflicts)
  }
  const conflictingRecords = fits.some((fit) => fit.conflicts.length > 0)
  const supportedFits = fits.filter((fit) => fit.comparedMinutes >= 8 && fit.matchedMinutes >= 8
    && fit.matchedMinutes / fit.comparedMinutes >= 0.8)
  const patternPass = Boolean(invariantPass && best && uniqueBest && !conflictingRecords
    && supportedFits.length === 1
    && best.comparedMinutes >= 8 && best.matchedMinutes >= 8
    && best.matchedMinutes / best.comparedMinutes >= 0.8)
  return { records: candidates, invariantPass, fits, selected: patternPass ? best : null, uniqueBest, patternPass, conflictingRecords }
}

export function localTimestamp(date: Date): string {
  const offsetMinutes = -date.getTimezoneOffset()
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const offset = Math.abs(offsetMinutes)
  const two = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`
    + `T${two(date.getHours())}:${two(date.getMinutes())}:${two(date.getSeconds())}.${String(date.getMilliseconds()).padStart(3, '0')}`
    + `${sign}${two(Math.floor(offset / 60))}:${two(offset % 60)}`
}
