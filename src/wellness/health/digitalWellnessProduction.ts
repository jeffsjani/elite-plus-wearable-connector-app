import { processAndroidDigitalWellness, type AndroidUsageEvent } from './androidDigitalWellness'
import { DIGITAL_WELLNESS_SEMANTIC_VERSION } from './digitalWellness'
import { enqueueQualifiedDay, type DigitalWellnessOutboxEntry } from './digitalWellnessOutbox'

export const QUALIFICATION_POLICY_VERSION = 'android.digital_balance.qualification.v1'
export const DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED = false
export const MINIMUM_BASELINE_DAYS = 7
export const MAX_CHECKPOINT_GAP_MS = 12 * 60 * 60 * 1000
export const MAX_HISTORY_MS = 48 * 60 * 60 * 1000
const GUARD_MS = 6 * 60 * 60 * 1000

export interface DigitalWellnessCheckpoint {
  captured_at: string
  screen_state: 'INTERACTIVE' | 'NON_INTERACTIVE' | 'UNKNOWN'
  keyguard_state: 'LOCKED' | 'UNLOCKED' | 'UNKNOWN'
  usage_access: 'GRANTED' | 'DENIED' | 'UNKNOWN'
  consent: 'ENABLED' | 'DISABLED'
  boot_session_marker: string
  timezone: string
}
export interface ContinuityEntry {
  captured_at: string
  event: 'ACCESS_GRANTED' | 'ACCESS_DENIED' | 'CONSENT_ENABLED' | 'CONSENT_DISABLED'
}
export interface DigitalWellnessDayObservation {
  local_date: string
  timezone: string
  observed_start: string
  observed_end: string
  screen_time_minutes: number | null
  pickups: number | null
  first_pickup: string | null
  screen_sessions: number | null
  late_night_screen_minutes: number | null
  coverage_state: 'UNKNOWN' | 'PARTIAL' | 'QUALIFIED'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  quality_reasons: string[]
  semantic_version: typeof DIGITAL_WELLNESS_SEMANTIC_VERSION
  qualification_policy_version: typeof QUALIFICATION_POLICY_VERSION
  source: 'ANDROID_USAGE_STATS'
  captured_at: string
  updated_at: string
}
export interface ProductionState {
  scope: string
  owner_kind: 'LOCAL_PREVIEW' | 'AUTHENTICATED'
  consent: boolean
  enabled_at: string | null
  access_established_at: string | null
  checkpoints: DigitalWellnessCheckpoint[]
  ledger: ContinuityEntry[]
  days: DigitalWellnessDayObservation[]
  outbox: DigitalWellnessOutboxEntry[]
  worker_last_run: string | null
  next_eligible_run: string | null
  last_usage_access_check: string | null
  last_sender_outcome: string
  error: string | null
}
export interface RefreshInput {
  state: ProductionState
  checkpoint: DigitalWellnessCheckpoint
  events: AndroidUsageEvent[]
  query_start: string
  query_end: string
  query_ok: boolean
  os_version: string
}

export function emptyProductionState(scope: string): ProductionState {
  return {
    scope, owner_kind: 'LOCAL_PREVIEW', consent: false, enabled_at: null, access_established_at: null,
    checkpoints: [], ledger: [], days: [], outbox: [], worker_last_run: null, next_eligible_run: null,
    last_usage_access_check: null, last_sender_outcome: 'CLOUD_DISABLED', error: null,
  }
}
const iso = (time: number) => new Date(time).toISOString()
export function localDate(time: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(time)
  const part = (name: string) => parts.find(({ type }) => type === name)!.value
  return `${part('year')}-${part('month')}-${part('day')}`
}
function followingDate(date: string, delta: number) {
  return iso(Date.parse(`${date}T12:00:00Z`) + delta * 86400000).slice(0, 10)
}
export function dayBounds(date: string, timezone: string): [number, number] {
  // Find the first instant of each local date; calendar days can contain 23 or 25 hours.
  const midnight = (day: string) => {
    const center = Date.parse(`${day}T00:00:00Z`)
    let low = center - 36 * 3600000
    let high = center + 36 * 3600000
    while (low < high) {
      const mid = Math.floor((low + high) / 2)
      if (localDate(mid, timezone) < day) low = mid + 1
      else high = mid
    }
    if (localDate(low, timezone) !== day) throw new Error('LOCAL_DATE_UNAVAILABLE')
    return low
  }
  return [midnight(date), midnight(followingDate(date, 1))]
}
export function firstEligibleDay(enabledAt: string, accessAt: string, timezone: string): string {
  return followingDate(localDate(Math.max(Date.parse(enabledAt), Date.parse(accessAt)), timezone), 1)
}
function boundary(
  time: number, checkpoints: DigitalWellnessCheckpoint[], events: AndroidUsageEvent[],
): { screen: DigitalWellnessCheckpoint['screen_state']; keyguard: DigitalWellnessCheckpoint['keyguard_state'] } {
  const prior = checkpoints.filter((cp) => Date.parse(cp.captured_at) <= time).at(-1)
  let screen = prior?.screen_state ?? 'UNKNOWN'
  let keyguard = prior?.keyguard_state ?? 'UNKNOWN'
  const since = prior ? Date.parse(prior.captured_at) : -Infinity
  for (const event of events.filter((event) => Date.parse(event.timestamp) >= since && Date.parse(event.timestamp) <= time)) {
    if (event.type === 'SCREEN_INTERACTIVE') screen = 'INTERACTIVE'
    if (event.type === 'SCREEN_NON_INTERACTIVE') screen = 'NON_INTERACTIVE'
    if (event.type === 'KEYGUARD_SHOWN') keyguard = 'LOCKED'
    if (event.type === 'KEYGUARD_HIDDEN') keyguard = 'UNLOCKED'
  }
  return { screen, keyguard }
}

export function refreshProduction(input: RefreshInput): ProductionState {
  const { checkpoint: cp } = input
  const now = Date.parse(cp.captured_at)
  const state: ProductionState = JSON.parse(JSON.stringify(input.state))
  const previous = state.checkpoints.at(-1)
  state.checkpoints = [...state.checkpoints, cp].sort((a, b) => Date.parse(a.captured_at) - Date.parse(b.captured_at)).slice(-256)
  state.last_usage_access_check = cp.captured_at
  state.worker_last_run = cp.captured_at
  state.next_eligible_run = state.consent && cp.usage_access === 'GRANTED' ? iso(now + 6 * 3600000) : null
  state.error = input.query_ok ? null : 'NATIVE_QUERY_OR_RUNTIME_UNAVAILABLE'
  if (previous?.usage_access !== cp.usage_access && cp.usage_access !== 'UNKNOWN') {
    state.ledger.push({ captured_at: cp.captured_at, event: cp.usage_access === 'GRANTED' ? 'ACCESS_GRANTED' : 'ACCESS_DENIED' })
  }
  if (cp.usage_access === 'GRANTED' && !state.access_established_at) state.access_established_at = cp.captured_at
  const events = input.events.filter((event) =>
    Date.parse(event.timestamp) >= Date.parse(input.query_start) && Date.parse(event.timestamp) < Date.parse(input.query_end))
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))
  const today = localDate(now, cp.timezone)
  for (const date of [followingDate(today, -2), followingDate(today, -1), today]) {
    const [start, end] = dayBounds(date, cp.timezone)
    if (state.enabled_at && end <= Date.parse(state.enabled_at)) continue
    const old = state.days.find((day) => day.local_date === date && day.timezone === cp.timezone)
    if (old?.coverage_state === 'QUALIFIED') continue
    const reasons = new Set<string>()
    const closed = end <= now
    const observedEnd = Math.min(end, now)
    if (observedEnd <= start) continue
    const calculationStart = Math.max(start, Date.parse(input.query_start), state.enabled_at ? Date.parse(state.enabled_at) : start)
    const checkpoints = state.checkpoints.filter((item) => item.timezone === cp.timezone)
    const before = checkpoints.filter((item) => Date.parse(item.captured_at) <= start).at(-1)
    const through = checkpoints.find((item) => Date.parse(item.captured_at) >= observedEnd)
    const evidence = checkpoints.filter((item) =>
      Date.parse(item.captured_at) >= (before ? Date.parse(before.captured_at) : start)
      && Date.parse(item.captured_at) <= (through ? Date.parse(through.captured_at) : now))
    if (!closed) reasons.add('DAY_IN_PROGRESS')
    if (!state.enabled_at || !state.access_established_at
      || date < firstEligibleDay(state.enabled_at, state.access_established_at, cp.timezone)) reasons.add('SETUP_DAY')
    if (!state.consent || cp.consent !== 'ENABLED') reasons.add('CONSENT_DISABLED')
    if (cp.usage_access !== 'GRANTED') reasons.add('USAGE_ACCESS_DENIED')
    if (!input.query_ok) reasons.add('QUERY_FAILURE')
    if (Date.parse(input.query_start) > start - GUARD_MS || Date.parse(input.query_end) < observedEnd) {
      reasons.add('MATERIAL_HISTORY_GAP')
    }
    if (!before || !through || evidence.some((item) => item.consent !== 'ENABLED' || item.usage_access !== 'GRANTED')
      || evidence.some((item, index) => index > 0
        && Date.parse(item.captured_at) - Date.parse(evidence[index - 1].captured_at) > MAX_CHECKPOINT_GAP_MS)) {
      reasons.add('CHECKPOINT_CONTINUITY_GAP')
    }
    if (state.ledger.some((item) => Date.parse(item.captured_at) >= start && Date.parse(item.captured_at) < end
      && (item.event === 'CONSENT_DISABLED' || item.event === 'ACCESS_DENIED'))) reasons.add('PERMISSION_OR_CONSENT_INTERRUPTION')
    if (state.checkpoints.some((item) => Date.parse(item.captured_at) >= (before ? Date.parse(before.captured_at) : start)
      && Date.parse(item.captured_at) <= (through ? Date.parse(through.captured_at) : now) && item.timezone !== cp.timezone)) {
      reasons.add('TIMEZONE_CHANGED')
    }
    // v1 never infers continuity through a reboot from ordinary screen events.
    if (evidence.some((item, index) => index > 0 && item.boot_session_marker !== evidence[index - 1].boot_session_marker)) {
      reasons.add('REBOOT_CONTINUITY_GAP')
    }
    const initial = boundary(calculationStart, checkpoints, events)
    const terminal = boundary(observedEnd, checkpoints, events)
    if (initial.screen === 'UNKNOWN' || initial.keyguard === 'UNKNOWN') reasons.add('MISSING_INITIAL_STATE')
    if (terminal.screen === 'UNKNOWN' || terminal.keyguard === 'UNKNOWN') reasons.add('MISSING_TERMINAL_STATE')
    if (initial.screen === 'INTERACTIVE') reasons.add('CROSS_BOUNDARY_SESSION_UNRESOLVED')
    const engineEvents = events.filter((event) => Date.parse(event.timestamp) <= observedEnd)
    const seed = checkpoints.filter((item) => Date.parse(item.captured_at) <= calculationStart).at(-1)
    // A trusted checkpoint supplies an actual measured state, not an inferred transition.
    if (seed && Date.parse(seed.captured_at) >= Date.parse(input.query_start)) {
      if (seed.screen_state === 'NON_INTERACTIVE') engineEvents.push({
        type: 'SCREEN_NON_INTERACTIVE',
        timestamp: seed.captured_at,
      })
      if (seed.keyguard_state !== 'UNKNOWN') engineEvents.push({
        type: seed.keyguard_state === 'LOCKED' ? 'KEYGUARD_SHOWN' : 'KEYGUARD_HIDDEN',
        timestamp: seed.captured_at,
      })
    }
    const result = calculationStart < observedEnd ? processAndroidDigitalWellness({
      events: engineEvents, start: iso(calculationStart), end: iso(observedEnd),
      osVersion: input.os_version, timezone: cp.timezone, dayBoundary: '00:00',
      ...(terminal.screen !== 'UNKNOWN' && terminal.keyguard !== 'UNKNOWN' ? { terminalScreenState: terminal.screen } : {}),
      lateNightWindow: { start: '22:00', end: '06:00' },
      qualification: { usageAccessContinuous: true, historyCoverage: true, noPermissionGaps: true, noRebootGaps: true },
    }) : null
    const metrics = result?.days.find((day) => day.date === date)
    metrics?.qualityReasons.forEach((reason) => { if (reason !== 'DUPLICATE_EVENTS_REMOVED') reasons.add(reason) })
    const unknown = !state.consent || cp.usage_access !== 'GRANTED' || !input.query_ok || initial.screen === 'INTERACTIVE'
      || !metrics || metrics.coverage.state === 'UNKNOWN'
    const coverage = unknown ? 'UNKNOWN' : closed && reasons.size === 0 && metrics?.coverage.state === 'QUALIFIED'
      ? 'QUALIFIED' : 'PARTIAL'
    const day: DigitalWellnessDayObservation = {
      local_date: date, timezone: cp.timezone, observed_start: iso(Math.min(calculationStart, observedEnd)), observed_end: iso(observedEnd),
      screen_time_minutes: unknown ? null : metrics!.screen_time_minutes,
      pickups: unknown ? null : metrics!.pickups, first_pickup: unknown ? null : metrics!.first_pickup,
      screen_sessions: unknown ? null : metrics!.screen_sessions,
      late_night_screen_minutes: unknown ? null : metrics!.late_night_screen_minutes,
      coverage_state: coverage, confidence: unknown ? 'UNKNOWN' : coverage === 'QUALIFIED' ? 'HIGH' : 'LOW',
      quality_reasons: [...reasons], semantic_version: DIGITAL_WELLNESS_SEMANTIC_VERSION,
      qualification_policy_version: QUALIFICATION_POLICY_VERSION, source: 'ANDROID_USAGE_STATS',
      captured_at: coverage === 'QUALIFIED' ? cp.captured_at : old?.captured_at ?? cp.captured_at, updated_at: cp.captured_at,
    }
    state.days = [...state.days.filter((item) => item !== old), day]
    if (state.owner_kind === 'AUTHENTICATED' && state.consent) state.outbox = enqueueQualifiedDay(state.outbox, day, state.scope, now)
  }
  state.days = state.days.filter((day) => Date.parse(day.updated_at) >= now - 90 * 86400000).slice(-270)
  state.outbox = state.outbox.filter((entry) => Date.parse(entry.observation.client_queued_at) >= now - 90 * 86400000)
  state.ledger = state.ledger.filter((item) => Date.parse(item.captured_at) >= now - 10 * 86400000).slice(-512)
  return state
}

export function qualifiedBaseline(days: DigitalWellnessDayObservation[], timezone: string) {
  const compatible = days.filter((day) => day.coverage_state === 'QUALIFIED' && day.timezone === timezone
    && day.semantic_version === DIGITAL_WELLNESS_SEMANTIC_VERSION
    && day.qualification_policy_version === QUALIFICATION_POLICY_VERSION && day.source === 'ANDROID_USAGE_STATS')
  return compatible.length >= MINIMUM_BASELINE_DAYS ? compatible : []
}
