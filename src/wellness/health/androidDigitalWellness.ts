export const ANDROID_DIGITAL_BALANCE_SEMANTIC_VERSION = 'android.digital_balance.v1'

export type AndroidUsageEventType =
  | 'SCREEN_INTERACTIVE'
  | 'SCREEN_NON_INTERACTIVE'
  | 'KEYGUARD_SHOWN'
  | 'KEYGUARD_HIDDEN'

export interface AndroidUsageEvent {
  type: AndroidUsageEventType
  timestamp: string
}

export interface AndroidUsageGap {
  start: string
  end: string
  reason: 'REBOOT' | 'HISTORY_GAP' | 'PERMISSION_GAP'
}

export interface AndroidLateNightWindow {
  start: string
  end: string
}

export interface AndroidDigitalWellnessInput {
  events: readonly AndroidUsageEvent[]
  start: string
  end: string
  osVersion: string
  timezone: string
  dayBoundary: string
  lateNightWindow?: AndroidLateNightWindow
  terminalScreenState?: 'INTERACTIVE' | 'NON_INTERACTIVE'
  gaps?: readonly AndroidUsageGap[]
  qualification?: {
    usageAccessContinuous: boolean
    historyCoverage: boolean
    noPermissionGaps: boolean
    noRebootGaps: boolean
  }
}

export interface AndroidScreenSession {
  start: string
  end: string
}

export interface AndroidDigitalWellnessDay {
  date: string
  screen_time_minutes: number | null
  pickups: number | null
  first_pickup: string | null
  screen_sessions: number | null
  late_night_screen_minutes: number | null
  sessions: readonly AndroidScreenSession[] | null
  coverage: { state: 'UNKNOWN' | 'PARTIAL' | 'QUALIFIED'; fraction: number | null }
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  qualityReasons: readonly AndroidWellnessQualityReason[]
}

export type AndroidDigitalWellnessMetric =
  | 'wellness.digital.screen_time_minutes'
  | 'wellness.digital.pickups'
  | 'wellness.digital.first_pickup'
  | 'wellness.digital.screen_sessions'
  | 'wellness.digital.late_night_screen_minutes'

export interface AndroidDigitalWellnessObservation {
  metric: AndroidDigitalWellnessMetric
  sourceMetric: AndroidDigitalWellnessMetric
  value: number | string | null
  unit: 'min' | 'count' | 'timestamp'
  observedInterval: { start: string; end: string }
  semanticVersion: typeof ANDROID_DIGITAL_BALANCE_SEMANTIC_VERSION
  coverage: { state: 'UNKNOWN' | 'PARTIAL' | 'QUALIFIED'; fraction: number | null }
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  qualityReasons: readonly AndroidWellnessQualityReason[]
  platform: 'ANDROID'
  osVersion: string
  timezone: string
  captureMethod: 'ANDROID_USAGE_STATS'
}

export type AndroidWellnessQualityReason =
  | 'NO_USAGE_EVENTS'
  | 'MISSING_INITIAL_STATE'
  | 'MISSING_TERMINAL_STATE'
  | 'REBOOT_GAP'
  | 'HISTORY_GAP'
  | 'PERMISSION_GAP'
  | 'DUPLICATE_EVENTS_REMOVED'
  | 'PARTIAL_COVERAGE'
  | 'QUERY_FAILURE'
  | 'CONSENT_REQUIRED'
  | 'USAGE_ACCESS_REQUIRED'
  | 'PERMISSION_CONTINUITY_UNVERIFIED'
  | 'REBOOT_STATUS_UNVERIFIED'
  | 'HISTORY_COVERAGE_UNVERIFIED'

export interface AndroidDigitalWellnessResult {
  semanticVersion: typeof ANDROID_DIGITAL_BALANCE_SEMANTIC_VERSION
  days: readonly AndroidDigitalWellnessDay[]
  observations: readonly AndroidDigitalWellnessObservation[]
  coverage: { state: 'UNKNOWN' | 'PARTIAL' | 'QUALIFIED'; fraction: number | null }
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  qualityReasons: readonly AndroidWellnessQualityReason[]
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}
interface ScreenInterval {
  start: number
  end: number
  sessionStart: number
  pickupAt: number | null
}
interface DayWindow {
  date: string
  start: number
  end: number
}

function parseTimestamp(value: string, label: string): number {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) throw new RangeError(`${label} must be a valid timestamp`)
  return timestamp
}

function parseClock(value: string, label: string): { hour: number; minute: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(value)
  if (!match) throw new RangeError(`${label} must use HH:mm`)
  return { hour: Number(match[1]), minute: Number(match[2]) }
}

function formatter(timezone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
    })
  } catch {
    throw new RangeError(`Invalid timezone: ${timezone}`)
  }
}

function partsAt(timestamp: number, format: Intl.DateTimeFormat): LocalParts {
  const parts = Object.fromEntries(format.formatToParts(timestamp).map(({ type, value }) => [type, value]))
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second),
  }
}

function localWallTime(parts: LocalParts): number {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
}

function zonedLocalTime(parts: LocalParts, format: Intl.DateTimeFormat): number {
  const desiredWallTime = localWallTime(parts)
  const offsets = new Set<number>()
  for (let hours = -36; hours <= 36; hours += 6) {
    const sample = desiredWallTime + hours * 60 * 60 * 1000
    offsets.add(localWallTime(partsAt(sample, format)) - sample)
  }
  const possibilities = [...offsets].map((offset) => {
    const timestamp = desiredWallTime - offset
    return { timestamp, wallTime: localWallTime(partsAt(timestamp, format)) }
  })
  const exact = possibilities.filter(({ wallTime }) => wallTime === desiredWallTime)
  if (exact.length) return Math.min(...exact.map(({ timestamp }) => timestamp))
  const afterGap = possibilities.filter(({ wallTime }) => wallTime > desiredWallTime)
    .sort((a, b) => a.wallTime - b.wallTime || a.timestamp - b.timestamp)[0]
  if (!afterGap) throw new RangeError('Could not resolve local day boundary in timezone')
  return afterGap.timestamp
}

function dateText(parts: LocalParts): string {
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function dateParts(date: string, clock: { hour: number; minute: number }): LocalParts {
  const [year, month, day] = date.split('-').map(Number)
  return { year, month, day, hour: clock.hour, minute: clock.minute, second: 0 }
}

function nextDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number)
  const next = new Date(Date.UTC(year, month - 1, day + 1))
  return `${String(next.getUTCFullYear()).padStart(4, '0')}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`
}

function buildDayWindows(
  start: number, end: number, format: Intl.DateTimeFormat, boundary: { hour: number; minute: number },
): DayWindow[] {
  const localStart = partsAt(start, format)
  let date = dateText(localStart)
  let windowStart = zonedLocalTime(dateParts(date, boundary), format)
  if (windowStart > start) {
    const [year, month, day] = date.split('-').map(Number)
    const previous = new Date(Date.UTC(year, month - 1, day - 1))
    date = `${String(previous.getUTCFullYear()).padStart(4, '0')}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}-${String(previous.getUTCDate()).padStart(2, '0')}`
    windowStart = zonedLocalTime(dateParts(date, boundary), format)
  }
  const windows: DayWindow[] = []
  while (windowStart < end) {
    const followingDate = nextDate(date)
    const windowEnd = zonedLocalTime(dateParts(followingDate, boundary), format)
    if (windowEnd <= windowStart) throw new RangeError('Day boundary did not advance')
    windows.push({ date, start: windowStart, end: windowEnd })
    date = followingDate
    windowStart = windowEnd
  }
  return windows.filter((window) => window.end > start && window.start < end)
}

function intersectDuration(start: number, end: number, otherStart: number, otherEnd: number): number {
  return Math.max(0, Math.min(end, otherEnd) - Math.max(start, otherStart))
}

function unionDuration(ranges: readonly (readonly [number, number])[], start: number, end: number): number {
  const clipped = ranges.map(([rangeStart, rangeEnd]) =>
    [Math.max(start, rangeStart), Math.min(end, rangeEnd)] as const)
    .filter(([rangeStart, rangeEnd]) => rangeEnd > rangeStart)
    .sort(([a], [b]) => a - b)
  let total = 0
  let mergedStart = -1
  let mergedEnd = -1
  for (const [rangeStart, rangeEnd] of clipped) {
    if (rangeStart > mergedEnd) {
      if (mergedEnd > mergedStart) total += mergedEnd - mergedStart
      mergedStart = rangeStart
      mergedEnd = rangeEnd
    } else {
      mergedEnd = Math.max(mergedEnd, rangeEnd)
    }
  }
  if (mergedEnd > mergedStart) total += mergedEnd - mergedStart
  return total
}

function coverageFor(
  hasEvidence: boolean,
  uncertainRanges: readonly (readonly [number, number])[],
  start: number,
  end: number,
  unknownState: boolean,
  canQualify: boolean,
): AndroidDigitalWellnessResult['coverage'] & { confidence: AndroidDigitalWellnessResult['confidence'] } {
  if (!hasEvidence) return { state: 'UNKNOWN', fraction: null, confidence: 'UNKNOWN' }
  if (unknownState) return { state: 'UNKNOWN', fraction: null, confidence: 'UNKNOWN' }
  const fraction = Math.max(0, Math.min(1, 1 - unionDuration(uncertainRanges, start, end) / (end - start)))
  const qualified = canQualify && fraction === 1
  return {
    state: qualified ? 'QUALIFIED' : 'PARTIAL',
    fraction,
    confidence: qualified ? 'HIGH' : fraction >= 0.7 ? 'MEDIUM' : 'LOW',
  }
}

function minutes(milliseconds: number): number {
  return Math.round(milliseconds / 60_000 * 10) / 10
}

function lateNightIntervals(
  day: DayWindow, window: AndroidLateNightWindow, format: Intl.DateTimeFormat,
): readonly [number, number][] {
  const startClock = parseClock(window.start, 'lateNightWindow.start')
  const endClock = parseClock(window.end, 'lateNightWindow.end')
  if (window.end > window.start) {
    return [[
      zonedLocalTime(dateParts(day.date, startClock), format),
      zonedLocalTime(dateParts(day.date, endClock), format),
    ]]
  }
  const previousDate = (() => {
    const [year, month, date] = day.date.split('-').map(Number)
    const previous = new Date(Date.UTC(year, month - 1, date - 1))
    return `${String(previous.getUTCFullYear()).padStart(4, '0')}-${String(previous.getUTCMonth() + 1).padStart(2, '0')}-${String(previous.getUTCDate()).padStart(2, '0')}`
  })()
  const followingDate = nextDate(day.date)
  return [
    [zonedLocalTime(dateParts(previousDate, startClock), format), zonedLocalTime(dateParts(day.date, endClock), format)],
    [zonedLocalTime(dateParts(day.date, startClock), format), zonedLocalTime(dateParts(followingDate, endClock), format)],
  ]
}

export function processAndroidDigitalWellness(
  input: AndroidDigitalWellnessInput,
): AndroidDigitalWellnessResult {
  const start = parseTimestamp(input.start, 'start')
  const end = parseTimestamp(input.end, 'end')
  if (end <= start) throw new RangeError('end must be later than start')
  if (!input.osVersion.trim()) throw new RangeError('osVersion must not be empty')
  const format = formatter(input.timezone)
  const boundary = parseClock(input.dayBoundary, 'dayBoundary')
  const sortedEvents = input.events.map((event) => ({
    ...event, at: parseTimestamp(event.timestamp, 'event timestamp'),
  })).sort((a, b) => a.at - b.at)
  const uniqueEvents = sortedEvents.filter((event, index) =>
    index === 0 || event.at !== sortedEvents[index - 1].at || event.type !== sortedEvents[index - 1].type)
  const reasons = new Set<AndroidWellnessQualityReason>()
  if (input.qualification && input.qualification.historyCoverage !== true) reasons.add('HISTORY_COVERAGE_UNVERIFIED')
  if (input.qualification && (input.qualification.usageAccessContinuous !== true
    || input.qualification.noPermissionGaps !== true)) reasons.add('PERMISSION_CONTINUITY_UNVERIFIED')
  if (input.qualification && input.qualification.noRebootGaps !== true) reasons.add('REBOOT_STATUS_UNVERIFIED')
  if (uniqueEvents.length !== sortedEvents.length) reasons.add('DUPLICATE_EVENTS_REMOVED')
  const screenEvents = uniqueEvents.filter(({ type }) =>
    type === 'SCREEN_INTERACTIVE' || type === 'SCREEN_NON_INTERACTIVE')
  const relevantScreenEvents = screenEvents.filter(({ at }) => at <= end)
  if (!relevantScreenEvents.length) reasons.add('NO_USAGE_EVENTS')

  const prior = uniqueEvents.filter(({ at }) => at <= start)
  let interactive: boolean | null = null
  let lastInteractiveAt: number | null = null
  let locked = false
  for (const event of prior) {
    if (event.type === 'SCREEN_INTERACTIVE') {
      interactive = true
      lastInteractiveAt = event.at
    } else if (event.type === 'SCREEN_NON_INTERACTIVE') {
      interactive = false
      lastInteractiveAt = null
    } else if (event.type === 'KEYGUARD_SHOWN') locked = true
    else if (event.type === 'KEYGUARD_HIDDEN') locked = false
  }
  if (interactive === null) reasons.add('MISSING_INITIAL_STATE')

  const intervals: ScreenInterval[] = []
  let intervalStart = interactive === true ? start : null
  let sessionStart = interactive === true ? (lastInteractiveAt ?? start) : start
  let keyguardShownInSession = false
  let pickupAt: number | null = null
  if (interactive === true && locked) keyguardShownInSession = true

  for (const event of uniqueEvents.filter(({ at }) => at > start && at < end)) {
    if (event.type === 'SCREEN_INTERACTIVE' && interactive !== true) {
      interactive = true
      intervalStart = event.at
      sessionStart = event.at
      keyguardShownInSession = locked
      pickupAt = null
    } else if (event.type === 'SCREEN_NON_INTERACTIVE' && interactive === true) {
      if (intervalStart !== null) intervals.push({ start: intervalStart, end: event.at, sessionStart, pickupAt })
      interactive = false
      intervalStart = null
      keyguardShownInSession = false
      pickupAt = null
    } else if (event.type === 'KEYGUARD_SHOWN') {
      locked = true
      if (interactive === true) keyguardShownInSession = true
    } else if (event.type === 'KEYGUARD_HIDDEN') {
      locked = false
      if (interactive === true && keyguardShownInSession && pickupAt === null) pickupAt = event.at
    }
  }
  for (const event of uniqueEvents.filter(({ at, type }) =>
    at === end && (type === 'SCREEN_INTERACTIVE' || type === 'SCREEN_NON_INTERACTIVE'))) {
    if (event.type === 'SCREEN_NON_INTERACTIVE' && interactive === true && intervalStart !== null) {
      intervals.push({ start: intervalStart, end, sessionStart, pickupAt })
      interactive = false
      intervalStart = null
    } else if (event.type === 'SCREEN_INTERACTIVE' && interactive !== true) {
      interactive = true
      intervalStart = end
      sessionStart = end
      pickupAt = null
    }
  }
  if (interactive === true && intervalStart !== null) {
    intervals.push({ start: intervalStart, end, sessionStart, pickupAt })
    if (input.terminalScreenState !== 'INTERACTIVE') reasons.add('MISSING_TERMINAL_STATE')
  } else if (interactive !== false) {
    reasons.add('MISSING_TERMINAL_STATE')
  }
  if (input.terminalScreenState === 'INTERACTIVE' && interactive !== true
    || input.terminalScreenState === 'NON_INTERACTIVE' && interactive !== false) reasons.add('MISSING_TERMINAL_STATE')
  for (const interval of intervals) {
    const sessionHasKeyguard = uniqueEvents.some(({ type, at }) => at >= interval.start && at < interval.end && type === 'KEYGUARD_SHOWN')
    if (!sessionHasKeyguard && interval.start >= start) {
      interval.pickupAt = interval.sessionStart
    }
  }

  const gaps = (input.gaps ?? []).map((gap) => {
    const gapStart = parseTimestamp(gap.start, 'gap start')
    const gapEnd = parseTimestamp(gap.end, 'gap end')
    if (gapEnd <= gapStart) throw new RangeError('gap end must be later than gap start')
    const reason: AndroidWellnessQualityReason = gap.reason === 'REBOOT'
      ? 'REBOOT_GAP' : gap.reason === 'HISTORY_GAP' ? 'HISTORY_GAP' : 'PERMISSION_GAP'
    if (gapEnd > start && gapStart < end) reasons.add(reason)
    return { start: gapStart, end: gapEnd }
  })

  const hasScreenEvidence = relevantScreenEvents.length > 0
  const uncertainRanges: (readonly [number, number])[] = gaps
    .map((gap) => [Math.max(start, gap.start), Math.min(end, gap.end)] as const)
    .filter(([gapStart, gapEnd]) => gapEnd > gapStart)
  if (reasons.has('MISSING_INITIAL_STATE')) {
    const firstStateEvent = relevantScreenEvents.find(({ at }) => at >= start)
    uncertainRanges.push([start, firstStateEvent ? Math.min(end, firstStateEvent.at) : end])
  }
  if (reasons.has('MISSING_TERMINAL_STATE')) {
    const lastStateEvent = [...relevantScreenEvents].reverse().find(({ at }) => at <= end)
    uncertainRanges.push([lastStateEvent ? Math.max(start, lastStateEvent.at) : start, end])
  }
  const hasUnknownBoundary = reasons.has('MISSING_INITIAL_STATE') || reasons.has('MISSING_TERMINAL_STATE')
  const hasKnownGap = gaps.some((gap) => gap.end > start && gap.start < end)
  const qualificationUnverified = input.qualification !== undefined && (
    input.qualification.usageAccessContinuous !== true
    || input.qualification.historyCoverage !== true
    || input.qualification.noPermissionGaps !== true
    || input.qualification.noRebootGaps !== true
  )
  const windows = buildDayWindows(start, end, format, boundary)
  const allLocalDaysFullyObserved = windows.every((day) => day.start >= start && day.end <= end)
  const canQualify = input.qualification?.usageAccessContinuous === true
    && input.qualification.historyCoverage === true
    && input.qualification.noPermissionGaps === true
    && input.qualification.noRebootGaps === true
    && !hasUnknownBoundary && !hasKnownGap && allLocalDaysFullyObserved
  const coverage = coverageFor(hasScreenEvidence, uncertainRanges, start, end,
    hasUnknownBoundary || hasKnownGap || qualificationUnverified, canQualify)
  if (coverage.fraction !== null && coverage.fraction < 1) reasons.add('PARTIAL_COVERAGE')

  const days = windows.map((day): AndroidDigitalWellnessDay => {
    const dayStart = Math.max(start, day.start)
    const dayEnd = Math.min(end, day.end)
    const dayHasGap = gaps.some((gap) => gap.end > dayStart && gap.start < dayEnd)
    const dayHasBoundaryUnknown = hasUnknownBoundary
    const fullLocalDayObserved = day.start >= start && day.end <= end
    const measuredDayCoverage = coverageFor(hasScreenEvidence, uncertainRanges, dayStart, dayEnd,
      dayHasGap || dayHasBoundaryUnknown || qualificationUnverified,
      canQualify && fullLocalDayObserved)
    const dayFraction = measuredDayCoverage.fraction === null ? null
      : measuredDayCoverage.fraction * ((dayEnd - dayStart) / (day.end - day.start))
    const dayCoverage = measuredDayCoverage.state === 'UNKNOWN' || measuredDayCoverage.state === 'QUALIFIED'
      ? measuredDayCoverage
      : {
        ...measuredDayCoverage,
        fraction: dayFraction,
        confidence: dayFraction !== null && dayFraction >= 0.7 ? 'MEDIUM' as const : 'LOW' as const,
      }
    const dayReasons = new Set(reasons)
    if (dayCoverage.fraction !== null && dayCoverage.fraction < 1) dayReasons.add('PARTIAL_COVERAGE')
    const clippedIntervals = intervals.map((interval) => ({
      interval, clippedStart: Math.max(start, day.start, interval.start), clippedEnd: Math.min(end, day.end, interval.end),
    })).filter(({ clippedStart, clippedEnd }) => clippedEnd > clippedStart)
    const screenDuration = clippedIntervals.reduce((total, { clippedStart, clippedEnd }) => total + clippedEnd - clippedStart, 0)
    const countedSessions = intervals.filter((interval) =>
      (interval.sessionStart >= day.start && interval.sessionStart < day.end)
      || (interval.sessionStart < start && day.start <= start && interval.end > day.start))
    const dayPickups = intervals.flatMap((interval) => interval.pickupAt === null ? [] : [interval.pickupAt])
      .filter((timestamp) => timestamp >= day.start && timestamp < day.end)
    let lateDuration = screenDuration
    if (input.lateNightWindow) {
      const lateWindows = lateNightIntervals(day, input.lateNightWindow, format)
      lateDuration = clippedIntervals.reduce((total, { clippedStart, clippedEnd }) => total
        + lateWindows.reduce((lateTotal, [lateStart, lateEnd]) =>
          lateTotal + intersectDuration(clippedStart, clippedEnd, lateStart, lateEnd), 0), 0)
    }
    const metricsKnown = dayCoverage.state !== 'UNKNOWN'
    return {
      date: day.date,
      screen_time_minutes: metricsKnown ? minutes(screenDuration) : null,
      pickups: metricsKnown ? dayPickups.length : null,
      first_pickup: dayCoverage.state === 'QUALIFIED' && dayPickups.length
        ? new Date(Math.min(...dayPickups)).toISOString() : null,
      screen_sessions: metricsKnown ? countedSessions.length : null,
      late_night_screen_minutes: metricsKnown ? minutes(lateDuration) : null,
      sessions: metricsKnown ? clippedIntervals.map(({ clippedStart, clippedEnd }) => ({
        start: new Date(clippedStart).toISOString(), end: new Date(clippedEnd).toISOString(),
      })) : null,
      coverage: { state: dayCoverage.state, fraction: dayCoverage.fraction },
      confidence: dayCoverage.confidence,
      qualityReasons: [...dayReasons],
    }
  })

  const observations = days.flatMap((day, index) => {
    const window = windows[index]
    const observedInterval = {
      start: new Date(Math.max(start, window.start)).toISOString(),
      end: new Date(Math.min(end, window.end)).toISOString(),
    }
    const common: Omit<AndroidDigitalWellnessObservation, 'metric' | 'sourceMetric' | 'value' | 'unit'> = {
      observedInterval,
      semanticVersion: ANDROID_DIGITAL_BALANCE_SEMANTIC_VERSION,
      coverage: day.coverage,
      confidence: day.confidence,
      qualityReasons: day.qualityReasons,
      platform: 'ANDROID' as const,
      osVersion: input.osVersion,
      timezone: input.timezone,
      captureMethod: 'ANDROID_USAGE_STATS' as const,
    }
    const metrics: {
      metric: AndroidDigitalWellnessMetric
      value: number | string | null
      unit: AndroidDigitalWellnessObservation['unit']
    }[] = [
      { metric: 'wellness.digital.screen_time_minutes', value: day.screen_time_minutes, unit: 'min' },
      { metric: 'wellness.digital.pickups', value: day.pickups, unit: 'count' },
      { metric: 'wellness.digital.first_pickup', value: day.first_pickup, unit: 'timestamp' },
      { metric: 'wellness.digital.screen_sessions', value: day.screen_sessions, unit: 'count' },
      { metric: 'wellness.digital.late_night_screen_minutes', value: day.late_night_screen_minutes, unit: 'min' },
    ]
    return metrics.map((item): AndroidDigitalWellnessObservation => ({
      ...common, ...item, sourceMetric: item.metric,
    }))
  })
  return {
    semanticVersion: ANDROID_DIGITAL_BALANCE_SEMANTIC_VERSION,
    days, observations,
    coverage: { state: coverage.state, fraction: coverage.fraction },
    confidence: coverage.confidence, qualityReasons: [...reasons],
  }
}
