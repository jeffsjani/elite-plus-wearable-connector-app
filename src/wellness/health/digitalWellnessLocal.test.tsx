// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CompanionShell } from '../CompanionShell'
import { LocalDigitalWellness } from './digitalWellnessLocal'
import type { DigitalWellnessNative, DigitalWellnessNativeResult } from './digitalWellnessNative'
import { processAndroidDigitalWellness, type AndroidUsageEventType } from './androidDigitalWellness'
import { QUERY_MESSAGES, queryDiagnostics } from './queryDiagnostics'
import { DigitalWellnessValidation } from '../DigitalWellnessValidation'

const bridge = vi.hoisted(() => ({
  getPlatformInfo: vi.fn(async () => ({ platform: 'ANDROID' as const, androidVersion: '15' })),
  isUsageAccessAvailable: vi.fn<DigitalWellnessNative['isUsageAccessAvailable']>(async () => ({ available: true })),
  hasUsageAccess: vi.fn<DigitalWellnessNative['hasUsageAccess']>(async () => ({ granted: true })),
  openUsageAccessSettings: vi.fn(async () => {}),
  queryDigitalWellnessEvents: vi.fn<(options: { start: number; end: number }) => Promise<DigitalWellnessNativeResult>>(),
}))
vi.mock('@capacitor/core', () => ({ registerPlugin: vi.fn(() => bridge) }))
import { digitalWellnessNative } from './digitalWellnessNative'

const end = Date.parse('2025-03-11T00:00:00Z')
const event = (eventType: AndroidUsageEventType, timestamp: string) => ({ eventType, timestamp: Date.parse(timestamp) })
const normal = [
  event('SCREEN_NON_INTERACTIVE', '2025-03-10T00:00:00Z'),
  event('SCREEN_INTERACTIVE', '2025-03-10T10:00:00Z'),
  event('SCREEN_NON_INTERACTIVE', '2025-03-10T10:30:00Z'),
]
function setup(events = normal, now = end, zone = 'UTC') {
  const data = new Map<string, string>()
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
  bridge.isUsageAccessAvailable.mockResolvedValue({ available: true })
  bridge.getPlatformInfo.mockResolvedValue({ platform: 'ANDROID', androidVersion: '15' })
  bridge.hasUsageAccess.mockResolvedValue({ granted: true })
  bridge.openUsageAccessSettings.mockResolvedValue()
  const uniqueEvents = [...new Map(events.map((item) => [`${item.eventType}-${item.timestamp}`, item])).values()]
  const eventCounts = Object.fromEntries(
    (['SCREEN_INTERACTIVE', 'SCREEN_NON_INTERACTIVE', 'KEYGUARD_SHOWN', 'KEYGUARD_HIDDEN'] as const)
      .map((type) => [type, uniqueEvents.filter((item) => item.eventType === type).length]),
  ) as DigitalWellnessNativeResult['eventCounts']
  bridge.queryDigitalWellnessEvents.mockImplementation(async ({ start, end }) => ({
    events: uniqueEvents, eventCounts, totalSupportedEvents: events.length, deduplicatedCount: events.length - uniqueEvents.length,
    queryStart: start, queryEnd: end, permissionState: 'AUTHORIZED', OSVersion: '15',
    collectionTimestamp: now, historyCompleteness: 'UNVERIFIED',
  }))
  const local = new LocalDigitalWellness(digitalWellnessNative, storage, true, () => now, () => zone)
  return { local, storage, data }
}
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe('local-only Digital Wellness lifecycle', () => {
  it.each([
    ['USAGE_ACCESS_DENIED', 'ACCESS_CHECK'],
    ['USAGE_STATS_UNAVAILABLE', 'SERVICE_LOOKUP'],
    ['SECURITY_EXCEPTION', 'QUERY_EVENTS'],
    ['INVALID_QUERY', 'QUERY_EVENTS'],
    ['QUERY_RETURNED_NULL', 'QUERY_EVENTS'],
    ['QUERY_ITERATION_FAILED', 'EVENT_ITERATION'],
    ['BRIDGE_FAILURE', 'BRIDGE_SERIALIZATION'],
  ] as const)('persists sanitized %s diagnostics, never metrics or identities', async (code, stage) => {
    const { local, storage, data } = setup()
    await local.confirmSetup()
    const privateText = 'com.private.app PrivateActivity https://private.example user content\n at raw.stack.Trace'
    bridge.queryDigitalWellnessEvents.mockRejectedValue({
      code, message: privateText, stack: privateText,
      data: {
        error_code: code, error_stage: stage, native_exception_class: 'java.lang.SecurityException',
        sanitized_error_message: privateText, usage_access_at_query: 'GRANTED',
        usage_stats_service_available: true, query_start: 0, query_end: 1,
        android_api_level: 36, appops_result: 0, appops_api_branch: 'API_29_PLUS_UNSAFE_CHECK_OP_NO_THROW',
        packageName: privateText, activity: privateText,
      },
    })
    await local.refresh({ validation: true })
    const receipt = local.getSnapshot().validationReceipts.at(-1)!
    expect(receipt.query_diagnostics).toEqual({
      error_code: code, error_stage: stage, native_exception_class: 'java.lang.SecurityException',
      sanitized_error_message: QUERY_MESSAGES[code], usage_access_at_query: 'GRANTED',
      usage_stats_service_available: true, query_start: end - 86400000, query_end: end,
      android_api_level: 36, appops_result: 0, appops_api_branch: 'API_29_PLUS_UNSAFE_CHECK_OP_NO_THROW',
    })
    expect(Object.values(receipt.resulting_metrics).every((value) => value === null)).toBe(true)
    expect(Object.values(receipt.event_counts).every((value) => value === null)).toBe(true)
    expect(local.getSnapshot().records).toEqual([])
    const restarted = new LocalDigitalWellness(digitalWellnessNative, storage, true)
    expect(restarted.getSnapshot().validationReceipts.at(-1)?.query_diagnostics).toEqual(receipt.query_diagnostics)
    expect([...data.values()].join(' ')).not.toMatch(/private|raw\.stack|https:|packageName|activity/)
  })

  it('persists and renders sanitized native validation-rule diagnostics', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const { local, storage } = setup()
    await local.confirmSetup()
    bridge.queryDigitalWellnessEvents.mockRejectedValue({
      code: 'INVALID_QUERY', data: {
        error_code: 'INVALID_QUERY', error_stage: 'QUERY_EVENTS', native_exception_class: 'NONE',
        validation_rule_failed: 'END_IN_FUTURE', native_now: end - 6000, requested_start: end - 86400000,
        requested_end: end, effective_end: end, duration_ms: 86400000, lookback_ms: 86394000,
        clock_skew_ms: 6000, packageName: 'com.private.app',
      },
    })
    await local.refresh({ validation: true })
    const expected = {
      validation_rule_failed: 'END_IN_FUTURE', native_now: end - 6000, requested_start: end - 86400000,
      requested_end: end, effective_end: end, duration_ms: 86400000, lookback_ms: 86394000, clock_skew_ms: 6000,
    }
    const receipt = local.getSnapshot().validationReceipts.at(-1)!
    expect(receipt.query_diagnostics?.native_validation).toEqual(expected)
    const restarted = new LocalDigitalWellness(digitalWellnessNative, storage, true)
    expect(restarted.getSnapshot().validationReceipts.at(-1)?.query_diagnostics?.native_validation).toEqual(expected)
    expect(queryDiagnostics({ validation_rule_failed: 'com.private.app', native_now: 1.5 }, 0, 1)
      .native_validation).toMatchObject({ validation_rule_failed: null, native_now: null })
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => { root.render(<DigitalWellnessValidation wellness={local} />) })
      for (const label of ['Validation rule failed:', 'END_IN_FUTURE', 'Native now:', 'Requested end:',
        'Effective end:', 'Duration ms:', 'Lookback ms:', 'Clock skew ms:']) expect(host.textContent).toContain(label)
      expect(host.textContent).not.toContain('com.private.app')
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it('captures denied preflight without querying and renders Engineering failure fields', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const { local } = setup()
    await local.confirmSetup()
    bridge.hasUsageAccess.mockResolvedValue({ granted: false })
    await local.refresh({ validation: true })
    expect(local.getSnapshot().validationReceipts.at(-1)?.query_diagnostics).toMatchObject({
      error_code: 'USAGE_ACCESS_DENIED', error_stage: 'ACCESS_CHECK',
      usage_access_at_query: 'DENIED',
    })
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => { root.render(<DigitalWellnessValidation wellness={local} />) })
      for (const label of ['Query failed', 'Stage:', 'Error code:', 'Usage Access:', 'Android API:',
        'Service available:', 'Sanitized message:']) expect(host.textContent).toContain(label)
    } finally {
      await act(async () => { root.unmount() })
    }
  })

  it.each([null, 3])('retains unknown/default AppOps result %s without querying', async (mode) => {
    const { local } = setup()
    await local.confirmSetup()
    bridge.hasUsageAccess.mockResolvedValue({
      granted: false, diagnostics: {
        appops_result: mode, android_api_level: 36,
        appops_api_branch: 'API_29_PLUS_UNSAFE_CHECK_OP_NO_THROW',
      },
    })
    await local.refresh({ validation: true })
    expect(local.getSnapshot().validationReceipts.at(-1)?.query_diagnostics).toMatchObject({
      error_code: 'USAGE_ACCESS_DENIED', error_stage: 'ACCESS_CHECK', appops_result: mode,
      usage_access_at_query: 'DENIED', android_api_level: 36,
    })
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
  })

  it('persists service-null preflight without querying or inventing access status', async () => {
    const { local } = setup()
    await local.confirmSetup()
    bridge.isUsageAccessAvailable.mockResolvedValue({
      available: false, diagnostics: { usage_stats_service_available: false, android_api_level: 29 },
    })
    await local.refresh({ validation: true })
    expect(local.getSnapshot().validationReceipts.at(-1)?.query_diagnostics).toMatchObject({
      error_code: 'USAGE_STATS_UNAVAILABLE', error_stage: 'SERVICE_LOOKUP',
      usage_stats_service_available: false, usage_access_at_query: 'UNKNOWN', android_api_level: 29,
    })
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
  })

  it('does not accept arbitrary exception classes, messages, stages or fields', () => {
    const diagnostic = queryDiagnostics({
      error_code: 'https://private', error_stage: 'private', native_exception_class: 'com.private.Activity',
      sanitized_error_message: 'private', stack: 'private',
    }, 1, 2)
    expect(diagnostic).toMatchObject({
      error_code: 'QUERY_FAILED', error_stage: 'UNKNOWN', native_exception_class: 'NONE',
      sanitized_error_message: QUERY_MESSAGES.QUERY_FAILED,
    })
    expect(JSON.stringify(diagnostic)).not.toContain('private')
  })

  it('preserves revoked consumer state for a SecurityException while retaining its distinct diagnostic', async () => {
    const { local } = setup()
    await local.confirmSetup()
    bridge.queryDigitalWellnessEvents.mockRejectedValue({ code: 'SECURITY_EXCEPTION' })
    await local.refresh({ validation: true })
    expect(local.getSnapshot()).toMatchObject({ state: 'PERMISSION_REVOKED', permission: 'REVOKED', records: [] })
    expect(local.getSnapshot().validationReceipts.at(-1)?.query_diagnostics?.error_code).toBe('SECURITY_EXCEPTION')
  })

  it.each([{ events: [] }, { events: normal }])('successful empty/populated refresh has no failure diagnostics', async ({ events }) => {
    const { local } = setup(events)
    await local.confirmSetup()
    await local.refresh({ validation: true })
    expect(local.getSnapshot().state).toBe('LOCAL_DATA_READY')
    expect(local.getSnapshot().validationReceipts.at(-1)?.query_diagnostics).toBeUndefined()
  })

  it('defaults OFF, independently of all other consent; construction and navigation never query', async () => {
    const { local } = setup()
    expect(local.getSnapshot()).toMatchObject({ state: 'DISABLED', consent: { domain: 'DIGITAL_WELLNESS', state: 'NOT_REQUESTED' } })
    await local.refresh()
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    expect(bridge.hasUsageAccess).not.toHaveBeenCalled()
    local.beginSetup()
    expect(local.getSnapshot().state).toBe('CONSENT_REQUIRED')
    expect(bridge.openUsageAccessSettings).not.toHaveBeenCalled()
    local.cancelSetup()
    expect(local.getSnapshot().state).toBe('DISABLED')
  })

  it('persists explicit consent, opens real special-access settings, rechecks without collecting', async () => {
    const { local, storage } = setup()
    bridge.hasUsageAccess.mockResolvedValue({ granted: false })
    await local.confirmSetup()
    expect(bridge.openUsageAccessSettings).toHaveBeenCalledTimes(1)
    expect(local.getSnapshot()).toMatchObject({ state: 'OS_ACCESS_REQUIRED', permission: 'DENIED' })
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    const restarted = new LocalDigitalWellness(digitalWellnessNative, storage, true)
    expect(restarted.getSnapshot().state).toBe('OS_ACCESS_REQUIRED')
    bridge.hasUsageAccess.mockResolvedValue({ granted: true })
    await restarted.recheckAccess()
    expect(restarted.getSnapshot().state).toBe('AVAILABLE')
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
  })

  it('records denied validation without querying or fabricating event counts', async () => {
    const { local } = setup()
    await local.refresh({ validation: true })
    expect(local.getSnapshot().state).toBe('CONSENT_REQUIRED')
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    expect(local.getSnapshot().validationReceipts.at(-1)).toMatchObject({
      permission_state: 'NOT_CHECKED',
      event_counts: { SCREEN_INTERACTIVE: null, SCREEN_NON_INTERACTIVE: null, KEYGUARD_SHOWN: null, KEYGUARD_HIDDEN: null },
      total_supported_events: null, deduplicated_count: null, coverage: 'UNKNOWN',
      resulting_metrics: {
        screen_time_minutes: null, pickups: null, first_pickup: null, screen_sessions: null,
        late_night_screen_minutes: null,
      },
      quality_reasons: ['CONSENT_REQUIRED'],
    })
  })

  it('revocation blocks queries, retains aggregates, and permission gaps lower confidence', async () => {
    const { local, storage } = setup()
    await local.confirmSetup()
    await local.refresh()
    const records = local.getSnapshot().records
    expect(records).toHaveLength(1)
    bridge.hasUsageAccess.mockResolvedValue({ granted: false })
    await local.refresh()
    expect(local.getSnapshot()).toMatchObject({ state: 'PERMISSION_REVOKED', permission: 'REVOKED', records })
    expect(bridge.queryDigitalWellnessEvents).toHaveBeenCalledTimes(1)
    bridge.hasUsageAccess.mockResolvedValue({ granted: true })
    await local.refresh()
    expect(local.getSnapshot().records.at(-1)?.result.qualityReasons).toContain('PERMISSION_GAP')
    local.disable()
    await local.refresh()
    expect(bridge.queryDigitalWellnessEvents).toHaveBeenCalledTimes(2)
    const restarted = new LocalDigitalWellness(digitalWellnessNative, storage, true)
    expect(restarted.getSnapshot().state).toBe('DISABLED')
    expect(restarted.getSnapshot().records).toHaveLength(2)
  })

  it('discards in-flight results after consent revocation', async () => {
    const { local } = setup()
    await local.confirmSetup()
    let finish!: (value: DigitalWellnessNativeResult) => void
    bridge.queryDigitalWellnessEvents.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const refresh = local.refresh()
    await vi.waitFor(() => expect(bridge.queryDigitalWellnessEvents).toHaveBeenCalledTimes(1))
    expect(local.getSnapshot().state).toBe('COLLECTING')
    local.disable()
    finish({ events: normal, eventCounts: { SCREEN_INTERACTIVE: 1, SCREEN_NON_INTERACTIVE: 2, KEYGUARD_SHOWN: 0, KEYGUARD_HIDDEN: 0 },
      totalSupportedEvents: 3, deduplicatedCount: 0, queryStart: end - 86400000, queryEnd: end, permissionState: 'AUTHORIZED', OSVersion: '15',
      collectionTimestamp: end, historyCompleteness: 'UNVERIFIED' })
    await refresh
    expect(local.getSnapshot()).toMatchObject({ state: 'DISABLED', records: [] })
  })

  it('rejects a result if Android permission is revoked during the query', async () => {
    const { local } = setup()
    await local.confirmSetup()
    bridge.hasUsageAccess.mockResolvedValueOnce({ granted: true }).mockResolvedValueOnce({ granted: false })
    await local.refresh()
    expect(local.getSnapshot()).toMatchObject({ state: 'PERMISSION_REVOKED', records: [] })
  })

  it.each(['UNAVAILABLE', 'API_FAILURE', 'USAGE_ACCESS_REQUIRED'])('surfaces native %s without zero observations', async (code) => {
    const { local } = setup()
    await local.confirmSetup()
    bridge.queryDigitalWellnessEvents.mockRejectedValue({ code, message: 'sensitive failure detail' })
    await local.refresh()
    expect(local.getSnapshot().state).toBe(code === 'USAGE_ACCESS_REQUIRED' ? 'PERMISSION_REVOKED' : 'ERROR')
    expect(local.getSnapshot().records).toHaveLength(0)
    expect(JSON.stringify(local.getSnapshot())).not.toContain('sensitive failure detail')
  })

  it('treats unavailable platform and storage failures explicitly, without querying', async () => {
    const { local } = setup()
    await local.confirmSetup()
    bridge.isUsageAccessAvailable.mockResolvedValue({ available: false })
    await local.refresh()
    expect(local.getSnapshot().state).toBe('UNAVAILABLE')
    expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    const broken = new LocalDigitalWellness(digitalWellnessNative, {
      getItem() { throw new Error('blocked') }, setItem() { throw new Error('blocked') },
    }, true)
    expect(broken.getSnapshot().state).toBe('ERROR')
    await broken.confirmSetup()
    expect(broken.getSnapshot().consent.state).not.toBe('GRANTED')
  })

  it('stores timezone, interval, semantic version, and conservative coverage without raw events', async () => {
    let zone = 'UTC'
    const { storage, data } = setup()
    const local = new LocalDigitalWellness(digitalWellnessNative, storage, true, () => end, () => zone)
    await local.confirmSetup()
    await local.refresh()
    zone = 'America/New_York'
    await local.refresh()
    const records = local.getSnapshot().records
    expect(records.map(({ result }) => result.observations[0].timezone)).toEqual(['UTC', 'America/New_York'])
    expect(records[0].result.observations[0]).toMatchObject({
      semanticVersion: 'android.digital_balance.v1',
      observedInterval: { start: '2025-03-10T00:00:00.000Z', end: '2025-03-11T00:00:00.000Z' },
      confidence: 'UNKNOWN', coverage: { state: 'UNKNOWN', fraction: null },
    })
    const persisted = [...data.values()].join('')
    expect(persisted).not.toMatch(/eventType|"events"|packageName|className|appName/)
    expect(records.every((record) => record.deliveryCapability === 'LOCAL_ONLY')).toBe(true)
    expect(records.every((record) => record.result.days.every((day) => day.sessions === null))).toBe(true)
  })

  it('persists privacy-safe validation receipts and an access/consent-only continuity ledger', async () => {
    const { local, data } = setup([], end, 'UTC')
    await local.confirmSetup()
    await local.refresh({ hours: 1, validation: true })
    const receipt = local.getSnapshot().validationReceipts.at(-1)
    expect(receipt).toMatchObject({
      query_window: { start: new Date(end - 3600000).toISOString(), end: new Date(end).toISOString(), duration_hours: 1 },
      permission_state: 'GRANTED',
      event_counts: { SCREEN_INTERACTIVE: 0, SCREEN_NON_INTERACTIVE: 0, KEYGUARD_SHOWN: 0, KEYGUARD_HIDDEN: 0 },
      total_supported_events: 0, deduplicated_count: 0, semantic_version: 'android.digital_balance.v1',
      coverage: 'UNKNOWN', confidence: 'UNKNOWN',
      resulting_metrics: {
        screen_time_minutes: null, pickups: null, first_pickup: null, screen_sessions: null,
        late_night_screen_minutes: null,
      },
    })
    expect(local.getSnapshot().continuityLedger).toContainEqual(expect.objectContaining({
      usageAccess: 'GRANTED', consent: 'ENABLED', reason: 'ACCESS_CHECK',
    }))
    expect(local.getSnapshot().continuityLedger.every((entry) =>
      Object.keys(entry).sort().join(',') === 'consent,reason,timestamp,usageAccess')).toBe(true)
    expect(bridge.queryDigitalWellnessEvents).toHaveBeenCalledTimes(1)
    const persisted = [...data.values()].join('\n')
    expect(persisted).not.toMatch(/packageName|appName|activityName|className|notification|url|browsing|UsageEvents/)
    expect([...data.keys()]).toContain('eliteplus.digitalWellness.validationReceipts.v1')
    expect([...data.keys()].sort()).toEqual([
      'eliteplus.digitalWellness.aggregates.v1',
      'eliteplus.digitalWellness.continuity.v1',
      'eliteplus.digitalWellness.validationReceipts.v1',
    ])
  })

  it('keeps exact supported event timestamps in memory only', async () => {
    const { local, data } = setup()
    await local.confirmSetup()
    await local.refresh({ validation: true })
    expect(local.getSnapshot().eventSequence).toHaveLength(3)
    expect(local.getSnapshot().eventSequence[1]).toEqual({
      eventType: 'SCREEN_INTERACTIVE', timestamp: '2025-03-10T10:00:00.000Z',
    })
    expect([...data.values()].join('\n')).not.toContain('2025-03-10T10:00:00.000Z')
  })

  it('defensively strips unexpected identity properties before processing or storage', async () => {
    const { local, data } = setup()
    bridge.queryDigitalWellnessEvents.mockImplementation(async ({ start, end }) => ({
      events: normal.map((event) => ({ ...event, packageName: 'private.identity', appName: 'Private identity' })),
      eventCounts: { SCREEN_INTERACTIVE: 1, SCREEN_NON_INTERACTIVE: 2, KEYGUARD_SHOWN: 0, KEYGUARD_HIDDEN: 0 },
      totalSupportedEvents: 3, deduplicatedCount: 0,
      queryStart: start, queryEnd: end, permissionState: 'AUTHORIZED', OSVersion: '15',
      collectionTimestamp: end, historyCompleteness: 'UNVERIFIED',
    }))
    await local.confirmSetup()
    await local.refresh()
    expect(local.getSnapshot().state).toBe('LOCAL_DATA_READY')
    expect([...data.values()].join('')).not.toMatch(/private\.identity|Private identity|packageName|appName/)
  })

  it('rejects malformed native intervals without storing observations', async () => {
    const { local } = setup()
    bridge.queryDigitalWellnessEvents.mockImplementation(async ({ start, end }) => ({
      events: normal, queryStart: start - 1, queryEnd: end, permissionState: 'AUTHORIZED', OSVersion: '15',
      eventCounts: { SCREEN_INTERACTIVE: 1, SCREEN_NON_INTERACTIVE: 2, KEYGUARD_SHOWN: 0, KEYGUARD_HIDDEN: 0 },
      totalSupportedEvents: 3, deduplicatedCount: 0,
      collectionTimestamp: end, historyCompleteness: 'UNVERIFIED',
    }))
    await local.confirmSetup()
    await local.refresh()
    expect(local.getSnapshot()).toMatchObject({ state: 'ERROR', records: [] })
  })

  it('does not claim saved data when aggregate storage fails', async () => {
    const { local, storage } = setup()
    await local.confirmSetup()
    const save = storage.setItem
    vi.spyOn(storage, 'setItem').mockImplementation((key, value) => {
      if (key === 'eliteplus.digitalWellness.aggregates.v1') throw new Error('Full storage')
      save(key, value)
    })
    await local.refresh()
    expect(local.getSnapshot()).toMatchObject({ state: 'ERROR', records: [] })
    expect(local.getSnapshot().error).toContain('No new observations were saved')
  })

  it('does not issue overlapping queries from repeated Refresh clicks', async () => {
    const { local } = setup()
    await local.confirmSetup()
    await Promise.all([local.refresh(), local.refresh(), local.refresh()])
    expect(bridge.queryDigitalWellnessEvents).toHaveBeenCalledTimes(1)
    expect(local.getSnapshot().records).toHaveLength(1)
  })
})

const cases = [
  { name: 'normal day', events: normal, minutes: 30, pickups: 1, sessions: 1 },
  { name: 'screen wake while locked', events: [
    normal[0], normal[1], event('KEYGUARD_SHOWN', '2025-03-10T10:00:01Z'), normal[2],
  ], minutes: 30, pickups: 0, sessions: 1 },
  { name: 'unlock after lockscreen', events: [
    normal[0], normal[1], event('KEYGUARD_SHOWN', '2025-03-10T10:00:01Z'),
    event('KEYGUARD_HIDDEN', '2025-03-10T10:01:00Z'), normal[2],
  ], minutes: 30, pickups: 1, sessions: 1 },
  { name: 'repeated events and several sessions', events: [
    ...normal, normal[1], event('SCREEN_INTERACTIVE', '2025-03-10T11:00:00Z'),
    event('SCREEN_NON_INTERACTIVE', '2025-03-10T11:15:00Z'),
  ], minutes: 45, pickups: 2, sessions: 2 },
  { name: 'midnight', events: [
    event('SCREEN_NON_INTERACTIVE', '2025-03-10T12:00:00Z'),
    event('SCREEN_INTERACTIVE', '2025-03-10T23:30:00Z'),
    event('SCREEN_NON_INTERACTIVE', '2025-03-11T00:30:00Z'),
  ], now: Date.parse('2025-03-11T12:00:00Z'), minutes: 30, pickups: 0, sessions: 0 },
  { name: 'DST spring-forward', events: [
    event('SCREEN_NON_INTERACTIVE', '2025-03-09T04:00:00Z'),
    event('SCREEN_INTERACTIVE', '2025-03-09T06:30:00Z'),
    event('SCREEN_NON_INTERACTIVE', '2025-03-09T07:30:00Z'),
  ], now: Date.parse('2025-03-10T04:00:00Z'), zone: 'America/New_York', minutes: 60, pickups: 1, sessions: 1 },
  { name: 'DST fall-back', events: [
    event('SCREEN_NON_INTERACTIVE', '2025-11-02T05:00:00Z'),
    event('SCREEN_INTERACTIVE', '2025-11-02T05:30:00Z'),
    event('SCREEN_NON_INTERACTIVE', '2025-11-02T06:30:00Z'),
  ], now: Date.parse('2025-11-03T05:00:00Z'), zone: 'America/New_York', minutes: 60, pickups: 1, sessions: 1 },
  { name: 'incomplete data', events: [normal[1]], minutes: null, pickups: null, sessions: null },
  { name: 'empty history', events: [], minutes: null, pickups: null, sessions: null },
]

describe('native-shaped bridge → certified engine → observations → Digital Balance UI', () => {
  it.each(cases)('$name stays local with zero Base44/ROOK/V8/analytics requests', async (fixture) => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
    const { local } = setup(fixture.events, fixture.now ?? end, fixture.zone ?? 'UTC')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network forbidden'))
    const xhr = vi.spyOn(XMLHttpRequest.prototype, 'open')
    const socket = vi.spyOn(globalThis, 'WebSocket')
    const sync = vi.fn()
    const connect = vi.fn()
    const host = document.createElement('div')
    const root = createRoot(host)
    const click = async (text: string) => {
      const button = [...host.querySelectorAll('button')].find((item) => item.textContent === text)
      expect(button, text).toBeDefined()
      await act(async () => { button?.click() })
    }
    try {
      await act(async () => { root.render(<CompanionShell wellness={local} v8={<button onClick={connect}>Connect V8</button>} />) })
      await click('Connect')
      expect(host.textContent?.includes('Digital Wellness Validation')).toBe(__ENGINEERING_VALIDATION__)
      if (__ENGINEERING_VALIDATION__) {
        await click('Start Controlled Validation')
        expect(host.textContent).toContain('No background collection started')
        expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
      }
      expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
      await click('Set Up Digital Wellness')
      expect(host.textContent).toContain('does not collect the names of apps')
      expect(bridge.openUsageAccessSettings).not.toHaveBeenCalled()
      await click('Turn On Digital Wellness')
      expect(bridge.queryDigitalWellnessEvents).not.toHaveBeenCalled()
      await click('Refresh Digital Wellness')
      const result = local.getSnapshot().records[0].result
      const control = processAndroidDigitalWellness({
        events: fixture.events.map(({ eventType, timestamp }) => ({ type: eventType, timestamp: new Date(timestamp).toISOString() })),
        start: new Date((fixture.now ?? end) - 86400000).toISOString(), end: new Date(fixture.now ?? end).toISOString(),
        osVersion: '15', timezone: fixture.zone ?? 'UTC', dayBoundary: '00:00',
        lateNightWindow: { start: '22:00', end: '06:00' },
      })
      expect(control.days.at(-1)).toMatchObject({
        screen_time_minutes: fixture.minutes, pickups: fixture.pickups, screen_sessions: fixture.sessions,
      })
      expect(result.days.at(-1)).toMatchObject({
        screen_time_minutes: null, pickups: null, first_pickup: null, screen_sessions: null, late_night_screen_minutes: null,
      })
      expect(result.qualityReasons).toContain('HISTORY_GAP')
      expect(result.observations.length).toBeGreaterThanOrEqual(5)
      expect(result.coverage.state).not.toBe('QUALIFIED')
      expect(host.textContent).toContain('Unknown')
      expect(host.textContent).toContain('Last updated')
      expect(host.textContent).toContain('Android history completeness is unverified')
      expect(local.getSnapshot()).toMatchObject({ state: 'LOCAL_DATA_READY', deliveryCapability: 'LOCAL_ONLY' })
      await click('Settings')
      await click('Connect')
      expect(host.textContent).toContain('Last updated')
      bridge.hasUsageAccess.mockResolvedValue({ granted: false })
      await click('Refresh Digital Wellness')
      expect(local.getSnapshot().state).toBe('PERMISSION_REVOKED')
      expect(bridge.queryDigitalWellnessEvents).toHaveBeenCalledTimes(1)
      await click('Disable Digital Wellness')
      expect(host.textContent).toContain('collection disabled')
      expect(fetch).toHaveBeenCalledTimes(0)
      expect(xhr).toHaveBeenCalledTimes(0)
      expect(socket).toHaveBeenCalledTimes(0)
      expect(sync).toHaveBeenCalledTimes(0)
      expect(connect).toHaveBeenCalledTimes(0)
    } finally {
      await act(async () => { root.unmount() })
    }
  })
})
