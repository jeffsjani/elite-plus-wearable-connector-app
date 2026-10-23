import { describe, expect, it } from 'vitest'
import {
  ANDROID_DIGITAL_BALANCE_SEMANTIC_VERSION,
  processAndroidDigitalWellness,
  type AndroidDigitalWellnessInput,
  type AndroidUsageEvent,
} from './androidDigitalWellness'

// @ts-expect-error Foreground app changes are intentionally not usage events.
const appSwitchEvent: AndroidUsageEvent = { type: 'FOREGROUND_APP_CHANGED', timestamp: '2025-03-10T00:00:00.000Z' }
void appSwitchEvent

const start = '2025-03-10T00:00:00.000Z'
const end = '2025-03-11T00:00:00.000Z'
const baseEvents: AndroidUsageEvent[] = [
  { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-09T23:59:00.000Z' },
]
function process(
  events: readonly AndroidUsageEvent[],
  extra: Partial<AndroidDigitalWellnessInput> = {},
) {
  return processAndroidDigitalWellness({
    events, start, end, osVersion: '15', timezone: 'UTC', dayBoundary: '00:00',
    lateNightWindow: { start: '22:00', end: '06:00' },
    qualification: { usageAccessContinuous: true, historyCoverage: true, noPermissionGaps: true, noRebootGaps: true },
    ...extra,
  })
}

describe('android.digital_balance.v1 event processing', () => {
  it('trusted terminal context changes coverage only, preserving clipped v1 metric definitions', () => {
    const open: AndroidUsageEvent[] = [...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T23:30:00.000Z' }]
    expect(process(open).coverage.state).toBe('UNKNOWN')
    const bounded = process(open, { terminalScreenState: 'INTERACTIVE' })
    const closed = process([...open, { type: 'SCREEN_NON_INTERACTIVE', timestamp: end }])
    expect(bounded.days).toEqual(closed.days)
    expect(bounded.days[0]).toMatchObject({ screen_time_minutes: 30, pickups: 1, screen_sessions: 1, late_night_screen_minutes: 30 })
    expect(process(open, { terminalScreenState: 'NON_INTERACTIVE' }).coverage.state).toBe('UNKNOWN')
    expect(process(open.slice(1), { terminalScreenState: 'INTERACTIVE' }).coverage.state).toBe('UNKNOWN')
    expect(bounded.semanticVersion).toBe('android.digital_balance.v1')
  })
  it('measures an ordinary day and gives each observation explicit coverage', () => {
    const result = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T10:00:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T10:30:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T23:59:00.000Z' },
    ])
    expect(result.semanticVersion).toBe(ANDROID_DIGITAL_BALANCE_SEMANTIC_VERSION)
    expect(result.days[0]).toMatchObject({
      screen_time_minutes: 30, pickups: 1, first_pickup: '2025-03-10T10:00:00.000Z',
      screen_sessions: 1, late_night_screen_minutes: 0,
    })
    expect(result.observations).toHaveLength(5)
    expect(result.observations.every((observation) => observation.sourceMetric === observation.metric
      && observation.semanticVersion === 'android.digital_balance.v1'
      && observation.platform === 'ANDROID' && observation.osVersion === '15'
      && observation.timezone === 'UTC' && observation.captureMethod === 'ANDROID_USAGE_STATS'
      && observation.coverage.state === 'QUALIFIED' && observation.confidence === 'HIGH')).toBe(true)
    expect(result.coverage).toEqual({ state: 'QUALIFIED', fraction: 1 })
    expect(result.confidence).toBe('HIGH')
  })

  it('deduplicates repeated events without inventing a second pickup or session', () => {
    const wake = { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T10:00:00.000Z' } as const
    const result = process([
      ...baseEvents, wake, wake,
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T10:15:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T23:59:00.000Z' },
    ])
    expect(result.days[0]).toMatchObject({ screen_time_minutes: 15, pickups: 1, screen_sessions: 1 })
    expect(result.qualityReasons).toContain('DUPLICATE_EVENTS_REMOVED')
  })

  it('does not count a locked screen wake as a pickup but counts the subsequent unlock', () => {
    const lockedWake = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T08:00:00.000Z' },
      { type: 'KEYGUARD_SHOWN', timestamp: '2025-03-10T08:00:01.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T08:05:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T23:59:00.000Z' },
    ])
    expect(lockedWake.days[0].pickups).toBe(0)

    const unlocked = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T08:00:00.000Z' },
      { type: 'KEYGUARD_SHOWN', timestamp: '2025-03-10T08:00:01.000Z' },
      { type: 'KEYGUARD_HIDDEN', timestamp: '2025-03-10T08:00:10.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T08:05:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T23:59:00.000Z' },
    ])
    expect(unlocked.days[0]).toMatchObject({ pickups: 1, first_pickup: '2025-03-10T08:00:10.000Z' })
  })

  it('splits an overnight session duration at midnight without duplicating its pickup', () => {
    const result = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T23:30:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-11T00:30:00.000Z' },
    ], { end: '2025-03-12T00:00:00.000Z' })
    expect(result.days.map(({ screen_time_minutes, pickups, screen_sessions, late_night_screen_minutes }) =>
      ({ screen_time_minutes, pickups, screen_sessions, late_night_screen_minutes }))).toEqual([
      { screen_time_minutes: 30, pickups: 1, screen_sessions: 1, late_night_screen_minutes: 30 },
      { screen_time_minutes: 30, pickups: 0, screen_sessions: 0, late_night_screen_minutes: 30 },
    ])
  })

  it('uses timezone-local day boundaries across a DST transition', () => {
    const result = processAndroidDigitalWellness({
      osVersion: '15', timezone: 'America/New_York', dayBoundary: '00:00',
      start: '2025-03-09T05:00:00.000Z', end: '2025-03-10T04:00:00.000Z',
      events: [
        { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-09T04:59:00.000Z' },
        { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-09T06:30:00.000Z' },
        { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-09T07:30:00.000Z' },
      ],
      qualification: { usageAccessContinuous: true, historyCoverage: true, noPermissionGaps: true, noRebootGaps: true },
    })
    expect(result.days).toHaveLength(1)
    expect(result.days[0]).toMatchObject({ date: '2025-03-09', screen_time_minutes: 60, pickups: 1 })
    expect(result.coverage).toEqual({ state: 'QUALIFIED', fraction: 1 })
  })

  it('reports unknown rather than zero when usage history is absent', () => {
    const result = process([])
    expect(result.coverage).toEqual({ state: 'UNKNOWN', fraction: null })
    expect(result.confidence).toBe('UNKNOWN')
    expect(result.days[0]).toMatchObject({
      screen_time_minutes: null, pickups: null, first_pickup: null,
      screen_sessions: null, late_night_screen_minutes: null, sessions: null,
    })
  })

  it('retains partial measurements without claiming true first pickup or qualified coverage', () => {
    const result = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T10:00:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T10:30:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T23:59:00.000Z' },
    ], { qualification: undefined })
    expect(result.days[0]).toMatchObject({
      coverage: { state: 'PARTIAL' }, screen_time_minutes: 30, pickups: 1, first_pickup: null,
    })
  })

  it('uses a terminal screen-off event at the interval end as observed coverage', () => {
    const result = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T10:00:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: end },
    ])
    expect(result.coverage).toEqual({ state: 'QUALIFIED', fraction: 1 })
    expect(result.qualityReasons).not.toContain('MISSING_TERMINAL_STATE')
    expect(result.days[0].screen_time_minutes).toBe(840)
  })

  it('reduces coverage for missing initial/terminal state and reboot, history, or permission gaps', () => {
    const missingBoth = process([
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T12:00:00.000Z' },
    ])
    expect(missingBoth.qualityReasons).toEqual(expect.arrayContaining([
      'MISSING_INITIAL_STATE', 'MISSING_TERMINAL_STATE',
    ]))
    expect(missingBoth.coverage).toEqual({ state: 'UNKNOWN', fraction: null })
    const missingOnlyInitial = process([
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T12:00:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T12:30:00.000Z' },
    ])
    expect(missingOnlyInitial.qualityReasons).toContain('MISSING_INITIAL_STATE')
    expect(missingOnlyInitial.qualityReasons).not.toContain('MISSING_TERMINAL_STATE')
    const missingOnlyTerminal = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T12:00:00.000Z' },
    ])
    expect(missingOnlyTerminal.qualityReasons).toContain('MISSING_TERMINAL_STATE')
    expect(missingOnlyTerminal.qualityReasons).not.toContain('MISSING_INITIAL_STATE')

    for (const [reason, qualityReason] of [
      ['REBOOT', 'REBOOT_GAP'], ['HISTORY_GAP', 'HISTORY_GAP'], ['PERMISSION_GAP', 'PERMISSION_GAP'],
    ] as const) {
      const result = process([
        ...baseEvents,
        { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-10T23:59:00.000Z' },
      ], { gaps: [{ start: '2025-03-10T12:00:00.000Z', end: '2025-03-10T13:00:00.000Z', reason }] })
      expect(result.qualityReasons).toContain(qualityReason)
      expect(result.coverage).toEqual({ state: 'UNKNOWN', fraction: null })
    }
  })

  it('attributes the first pickup and late-night intersection to the local day', () => {
    const result = process([
      ...baseEvents,
      { type: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T23:00:00.000Z' },
      { type: 'SCREEN_NON_INTERACTIVE', timestamp: '2025-03-11T01:00:00.000Z' },
    ], { end: '2025-03-12T00:00:00.000Z', timezone: 'UTC' })
    expect(result.days[0].first_pickup).toBe('2025-03-10T23:00:00.000Z')
    expect(result.days[0].late_night_screen_minutes).toBe(60)
    expect(result.days[1].late_night_screen_minutes).toBe(60)
  })

  it('rejects invalid periods, timezone, and time boundaries', () => {
    expect(() => process([], { end: start })).toThrow(/later than start/)
    expect(() => process([], { timezone: 'Mars/Olympus' })).toThrow(/Invalid timezone/)
    expect(() => process([], { dayBoundary: '24:00' })).toThrow(/HH:mm/)
  })
})
