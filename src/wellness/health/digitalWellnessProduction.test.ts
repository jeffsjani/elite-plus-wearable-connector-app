import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import {
  dayBounds, emptyProductionState, firstEligibleDay, qualifiedBaseline, refreshProduction,
  type DigitalWellnessCheckpoint, type RefreshInput,
} from './digitalWellnessProduction'

const at = (value: string) => Date.parse(value)
function fixture(): RefreshInput {
  const state = emptyProductionState('install-preview-test')
  state.consent = true
  state.enabled_at = '2026-01-01T12:00:00.000Z'
  state.access_established_at = state.enabled_at
  state.ledger = [{ captured_at: state.enabled_at, event: 'CONSENT_ENABLED' }]
  for (let time = at('2026-01-01T18:00Z'); time <= at('2026-01-03T00:00Z'); time += 6 * 3600000) {
    state.checkpoints.push(checkpoint(new Date(time).toISOString()))
  }
  return {
    state, checkpoint: checkpoint('2026-01-03T06:00:00.000Z'), query_ok: true, os_version: '15',
    query_start: '2026-01-01T06:00:00.000Z', query_end: '2026-01-03T06:00:00.000Z',
    events: [
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2026-01-01T06:00:00.000Z' },
      { type: 'KEYGUARD_SHOWN', timestamp: '2026-01-01T06:00:00.000Z' },
      { type: 'SCREEN_INTERACTIVE', timestamp: '2026-01-02T10:00:00.000Z' },
      { type: 'KEYGUARD_SHOWN', timestamp: '2026-01-02T10:00:01.000Z' },
      { type: 'KEYGUARD_HIDDEN', timestamp: '2026-01-02T10:00:02.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2026-01-02T10:30:00.000Z' },
      { type: 'KEYGUARD_SHOWN', timestamp: '2026-01-02T10:30:01.000Z' },
    ],
  }
}
function checkpoint(captured_at: string): DigitalWellnessCheckpoint {
  return { captured_at, screen_state: 'NON_INTERACTIVE', keyguard_state: 'LOCKED',
    usage_access: 'GRANTED', consent: 'ENABLED', boot_session_marker: 'boot:7', timezone: 'UTC' }
}
const candidate = (input: RefreshInput) => refreshProduction(input).days.find((day) => day.local_date === '2026-01-02')!

describe('qualification policy v1', () => {
  it('qualifies only the first complete local day after successful setup', () => {
    const input = fixture()
    expect(firstEligibleDay(input.state.enabled_at!, input.state.access_established_at!, 'UTC')).toBe('2026-01-02')
    const output = refreshProduction(input)
    expect(output.days.find((day) => day.local_date === '2026-01-01')?.coverage_state).toBe('PARTIAL')
    expect(candidate(input)).toMatchObject({ coverage_state: 'QUALIFIED', screen_time_minutes: 30, pickups: 1, screen_sessions: 1 })
    expect(output.days.find((day) => day.local_date === '2026-01-03')?.coverage_state).toBe('PARTIAL')
    expect(output.outbox).toEqual([])
  })
  it('midday enable makes that calendar day partial despite complete historical events', () => {
    const input = fixture()
    input.state.enabled_at = '2026-01-02T12:00:00.000Z'
    expect(candidate(input).coverage_state).toBe('PARTIAL')
    expect(candidate(input).quality_reasons).toContain('SETUP_DAY')
  })
  it('trusted interactive terminal state makes today-so-far locally bounded without inventing a screen-off event', () => {
    const input = fixture()
    input.checkpoint = { ...checkpoint('2026-01-02T10:30:00.000Z'), screen_state: 'INTERACTIVE', keyguard_state: 'UNLOCKED' }
    input.query_end = input.checkpoint.captured_at
    input.state.checkpoints = input.state.checkpoints.filter((cp) => Date.parse(cp.captured_at) < Date.parse(input.query_end))
    input.events = input.events.filter((event) => Date.parse(event.timestamp) < Date.parse(input.query_end))
    expect(candidate(input)).toMatchObject({ coverage_state: 'PARTIAL', screen_time_minutes: 30, pickups: 1, screen_sessions: 1 })
    expect(candidate(input).quality_reasons).not.toContain('MISSING_TERMINAL_STATE')
  })
  it.each(['ACCESS_DENIED', 'CONSENT_DISABLED'] as const)('%s and re-enable/regrant cannot qualify the day', (event) => {
    const input = fixture()
    input.state.ledger.push({ captured_at: '2026-01-02T11:00:00.000Z', event },
      { captured_at: '2026-01-02T11:30:00.000Z', event: event === 'ACCESS_DENIED' ? 'ACCESS_GRANTED' : 'CONSENT_ENABLED' })
    expect(candidate(input).coverage_state).toBe('PARTIAL')
    expect(candidate(input).quality_reasons).toContain('PERMISSION_OR_CONSENT_INTERRUPTION')
  })
  it('denied permission, disabled consent, or native failure produces null metrics', () => {
    for (const condition of ['permission', 'consent', 'query']) {
      const input = fixture()
      if (condition === 'permission') input.checkpoint.usage_access = 'DENIED'
      if (condition === 'consent') { input.state.consent = false; input.checkpoint.consent = 'DISABLED' }
      if (condition === 'query') input.query_ok = false
      expect(candidate(input)).toMatchObject({
        coverage_state: 'UNKNOWN', screen_time_minutes: null, pickups: null, first_pickup: null,
        screen_sessions: null, late_night_screen_minutes: null,
      })
    }
  })
  it.each([false, true])('reboot remains partial under v1 even with reconstructed ordinary screen history (%s)', (history) => {
    const input = fixture()
    input.state.checkpoints[3].boot_session_marker = 'boot:8'
    if (!history) input.events = input.events.filter((event) => event.type !== 'KEYGUARD_HIDDEN')
    expect(candidate(input).coverage_state).toBe('PARTIAL')
    expect(candidate(input).quality_reasons).toContain('REBOOT_CONTINUITY_GAP')
  })
  it('bounded overlap and repeated foreground/worker refresh replace, never add aggregates', () => {
    const input = fixture()
    const first = refreshProduction(input)
    input.state = first
    input.events = [...input.events, ...input.events]
    const second = refreshProduction(input)
    expect(second.days.filter((day) => day.local_date === '2026-01-02')).toHaveLength(1)
    expect(second.days.find((day) => day.local_date === '2026-01-02')).toEqual(first.days.find((day) => day.local_date === '2026-01-02'))
    expect(candidate({ ...fixture(), checkpoint: checkpoint('2026-01-03T08:00:00.000Z'),
      query_end: '2026-01-03T08:00:00.000Z' }).pickups).toBe(1)
  })
  it('a measured interactive checkpoint is never invented as a new session at a day boundary', () => {
    const input = fixture()
    input.state.checkpoints[1].screen_state = 'INTERACTIVE'
    input.events = input.events.filter((event) => Date.parse(event.timestamp) >= Date.parse('2026-01-02T10:00:00Z'))
    expect(candidate(input).coverage_state).toBe('UNKNOWN')
    expect(candidate(input).screen_sessions).toBeNull()
    expect(candidate(input).quality_reasons).toContain('CROSS_BOUNDARY_SESSION_UNRESOLVED')
  })
  it('partial records upgrade atomically with qualified capture time and dedicated outbox identities', () => {
    const input = fixture()
    input.state.owner_kind = 'AUTHENTICATED'
    const first = candidate({ ...input, checkpoint: checkpoint('2026-01-02T18:00:00Z'),
      query_end: '2026-01-02T18:00:00Z' })
    expect(first.coverage_state).toBe('PARTIAL')
    input.state.days = [first]
    const qualified = refreshProduction(input)
    expect(qualified.days.find((day) => day.local_date === '2026-01-02')?.captured_at).toBe(input.checkpoint.captured_at)
    expect(qualified.outbox).toHaveLength(5)
    expect(refreshProduction({ ...input, state: qualified }).outbox).toEqual(qualified.outbox)
  })
  it('orders native ISO timestamps by instant, including mixed fractional precision', () => {
    const input = fixture()
    input.events.push(
      { type: 'SCREEN_INTERACTIVE', timestamp: '2026-01-02T10:30:02Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2026-01-02T10:30:02.001Z' },
    )
    expect(candidate(input).screen_sessions).toBe(2)
  })
  it('a missed checkpoint or unrecoverable query bound blocks qualification', () => {
    const input = fixture()
    input.state.checkpoints = input.state.checkpoints.filter((cp) => cp.captured_at < '2026-01-02T00:00:00.000Z')
    expect(candidate(input).quality_reasons).toContain('CHECKPOINT_CONTINUITY_GAP')
    input.query_start = '2026-01-02T12:00:00.000Z'
    expect(candidate(input).coverage_state).not.toBe('QUALIFIED')
    expect(candidate(input).quality_reasons).toContain('MATERIAL_HISTORY_GAP')
  })
  it('timezone changes block the affected day', () => {
    const input = fixture()
    input.state.checkpoints[3].timezone = 'Europe/London'
    expect(candidate(input).coverage_state).toBe('PARTIAL')
    expect(candidate(input).quality_reasons).toContain('TIMEZONE_CHANGED')
  })
  it.each([['2026-03-08', 23], ['2026-11-01', 25]] as const)('handles DST day %s (%sh)', (date, hours) => {
    const [start, end] = dayBounds(date, 'America/New_York')
    expect(end - start).toBe(hours * 3600000)
    const input = fixture()
    input.state.enabled_at = new Date(start - 2 * 86400000).toISOString()
    input.state.access_established_at = input.state.enabled_at
    input.state.checkpoints = []
    for (let time = start - 6 * 3600000; time < end + 3600000; time += 6 * 3600000) {
      input.state.checkpoints.push({ ...checkpoint(new Date(time).toISOString()), timezone: 'America/New_York' })
    }
    input.checkpoint = { ...checkpoint(new Date(end + 3600000).toISOString()), timezone: 'America/New_York' }
    input.query_end = input.checkpoint.captured_at
    input.query_start = new Date(end + 3600000 - 48 * 3600000).toISOString()
    input.events = [{ type: 'SCREEN_NON_INTERACTIVE', timestamp: input.query_start },
      { type: 'KEYGUARD_SHOWN', timestamp: input.query_start }]
    expect(refreshProduction(input).days.find((day) => day.local_date === date)?.coverage_state).toBe('QUALIFIED')
  })
  it('missing initial or terminal state never qualifies and never fabricates an unlock', () => {
    const input = fixture()
    input.state.checkpoints = input.state.checkpoints.map((cp) => ({ ...cp, keyguard_state: 'UNKNOWN' }))
    input.checkpoint.keyguard_state = 'UNKNOWN'
    input.events = input.events.filter((event) => !event.type.startsWith('KEYGUARD'))
    expect(candidate(input).quality_reasons).toContain('MISSING_INITIAL_STATE')
    expect(candidate(input).quality_reasons).toContain('MISSING_TERMINAL_STATE')
    expect(candidate(input).coverage_state).not.toBe('QUALIFIED')
    input.events = [{ type: 'SCREEN_INTERACTIVE', timestamp: '2026-01-02T23:00:00.000Z' }]
    expect(candidate(input).coverage_state).not.toBe('QUALIFIED')
  })
  it('requires seven compatible qualified days for historical display', () => {
    const qualified = candidate(fixture())
    const days = Array.from({ length: 7 }, (_, index) => ({ ...qualified, local_date: `2026-01-${String(index + 2).padStart(2, '0')}` }))
    expect(qualifiedBaseline(days.slice(0, 6), 'UTC')).toEqual([])
    expect(qualifiedBaseline(days, 'UTC')).toHaveLength(7)
    expect(qualifiedBaseline([...days.slice(0, 6), { ...qualified, coverage_state: 'PARTIAL' }], 'UTC')).toEqual([])
    expect(qualifiedBaseline(days, 'Europe/London')).toEqual([])
  })
  it('persists only aggregate and checkpoint allowlists, never raw events or identities', () => {
    const input = fixture()
    const events = input.events.map((event) => ({ ...event,
      packageName: 'com.private.application', applicationName: 'PrivateApp', activityName: 'PrivateActivity',
      url: 'https://private.example', notification: 'PrivateNotification', message: 'PrivateMessage', screenContents: 'PrivateScreen' }))
    const output = refreshProduction({ ...input, events })
    const serialized = JSON.stringify(output)
    expect(serialized).not.toMatch(/packageName|applicationName|activityName|https:|Private|SCREEN_INTERACTIVE|events|sessions":\[/)
    expect(Object.keys(output.days[0]).sort()).toEqual([
      'local_date', 'timezone', 'observed_start', 'observed_end', 'screen_time_minutes', 'pickups',
      'first_pickup', 'screen_sessions', 'late_night_screen_minutes', 'coverage_state', 'confidence',
      'quality_reasons', 'semantic_version', 'qualification_policy_version', 'source', 'captured_at', 'updated_at',
    ].sort())
    expect(Object.keys(output.checkpoints[0]).sort()).toEqual([
      'captured_at', 'screen_state', 'keyguard_state', 'usage_access', 'consent', 'boot_session_marker', 'timezone',
    ].sort())
  })
  it('bundled background runtime produces the identical result with no host/network APIs', () => {
    const bundle = readFileSync(new URL('../../../android/app/src/main/assets/digital-wellness.js', import.meta.url), 'utf8')
    const input = fixture()
    const result = runInNewContext(`${bundle}; JSON.stringify(EliteWellnessRuntime.refreshProduction(${JSON.stringify(input)}))`, {}, { timeout: 5000 })
    expect(JSON.parse(result)).toEqual(refreshProduction(input))
  })
  it('enforces a transitive import boundary excluding WellnessContextObservation from readiness/scoring', () => {
    const root = new URL('./', import.meta.url)
    const visit = (directory: string): string[] => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
      const path = join(directory, entry.name)
      return entry.isDirectory() ? visit(path) : path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : []
    })
    const files = visit(new URL('..', root).pathname).filter((path) => !path.includes('.test.'))
    const dependencies = (path: string, seen = new Set<string>()): string => {
      if (seen.has(path)) return ''
      seen.add(path)
      const text = readFileSync(path, 'utf8')
      let all = text
      for (const match of text.matchAll(/(?:from|import)\s*['"](\.[^'"]+)['"]/g)) {
        const target = new URL(match[1], `file://${path}`).pathname
        const resolved = files.find((file) => file === `${target}.ts` || file === `${target}.tsx` || file === `${target}/index.ts`)
        if (resolved) all += dependencies(resolved, seen)
      }
      return all
    }
    for (const path of files.filter((path) => /(?:readiness|scoring)/i.test(path))) {
      expect(dependencies(path)).not.toMatch(/WellnessContextObservation|digitalWellnessProduction|digitalWellnessOutbox/)
    }
  })
})

export { fixture, candidate }
