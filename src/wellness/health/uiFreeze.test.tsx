// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDigitalWellness, installForegroundLifecycle } from './digitalWellnessLocal'
import { emptyProductionState, type ProductionState } from './digitalWellnessProduction'
import type { DigitalWellnessNative, DigitalWellnessProductionNative } from './digitalWellnessNative'
import { CLIPBOARD_WRITE_TIMEOUT_MS, VALIDATION_SUMMARY_MAX_CHARS, buildValidationSummary, copyText } from './validationSummary'
import { UI_ACTION_TIMEOUT_MS } from './uiActions'

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({ getPlatformInfo: async () => ({ platform: 'ANDROID', androidVersion: '15' }) })),
}))
import { DigitalWellnessValidation } from '../DigitalWellnessValidation'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail })
  return { promise, resolve, reject }
}

function enabledState(): ProductionState {
  const state = emptyProductionState('preview-owner')
  state.consent = true
  state.enabled_at = '2026-01-01T12:00:00.000Z'
  return state
}

// Native bridge with a controllable "worker": refreshProduction/getProductionState can be held to simulate
// a WorkManager refresh owning the store, and every native call is counted for overlap checks.
function fixture(initial = enabledState()) {
  let state = structuredClone(initial)
  let activeNativeRefreshes = 0
  let maxNativeRefreshes = 0
  const holds = { refresh: null as Deferred<void> | null, read: null as Deferred<void> | null, probe: null as Deferred<void> | null }
  const native = {
    getPlatformInfo: vi.fn(async () => ({ platform: 'ANDROID' as const, androidVersion: '15' })),
    isUsageAccessAvailable: vi.fn(async () => ({ available: true })),
    hasUsageAccess: vi.fn<DigitalWellnessNative['hasUsageAccess']>(async () => {
      if (holds.probe) await holds.probe.promise
      return { granted: true, diagnostics: { appops_result: 0 } }
    }),
    openUsageAccessSettings: vi.fn(async () => {}),
    queryDigitalWellnessEvents: vi.fn(async () => { throw new Error('Raw query must not run in production') }),
  } satisfies DigitalWellnessNative
  const production = {
    getProductionState: vi.fn(async () => {
      if (holds.read) await holds.read.promise
      return structuredClone(state)
    }),
    setProductionConsent: vi.fn<DigitalWellnessProductionNative['setProductionConsent']>(async () => structuredClone(state)),
    closeProductionScope: vi.fn(async () => structuredClone(state)),
    refreshProduction: vi.fn(async () => {
      activeNativeRefreshes++
      maxNativeRefreshes = Math.max(maxNativeRefreshes, activeNativeRefreshes)
      try {
        if (holds.refresh) await holds.refresh.promise
        state = { ...state, worker_last_run: '2026-01-03T12:00:00.000Z' }
        return structuredClone(state)
      } finally { activeNativeRefreshes-- }
    }),
  } satisfies DigitalWellnessProductionNative
  const service = new LocalDigitalWellness(native, { getItem: () => null, setItem: () => {} }, true,
    () => Date.parse('2026-01-03T12:00:00Z'), () => 'UTC', production)
  return { service, native, production, holds, maxNativeRefreshes: () => maxNativeRefreshes }
}

async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  return { host, root, rerender: async () => act(async () => { root.render(node) }) }
}
const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)!

afterEach(() => {
  vi.useRealTimers()
  document.body.innerHTML = ''
})

describe('Copy Validation Summary', () => {
  it('copy success uses the async clipboard', async () => {
    const writeText = vi.fn(async () => {})
    expect(await copyText('summary', { clipboard: { writeText }, document })).toBe('COPIED')
    expect(writeText).toHaveBeenCalledWith('summary')
  })
  it('copy failure: clipboard rejects and the legacy command fails → FAILED', async () => {
    const doc = document.implementation.createHTMLDocument()
    doc.execCommand = () => false
    expect(await copyText('s', { clipboard: { writeText: async () => { throw new Error('NotAllowed') } }, document: doc }))
      .toBe('FAILED')
  })
  it('clipboard unavailable: falls back to the copy command, else FAILED', async () => {
    const doc = document.implementation.createHTMLDocument()
    doc.execCommand = vi.fn(() => true)
    expect(await copyText('s', { clipboard: null, document: doc })).toBe('COPIED')
    expect(await copyText('s', { clipboard: null, document: null })).toBe('FAILED')
  })
  it('hanging WebView clipboard is bounded and falls back', async () => {
    vi.useFakeTimers()
    const doc = document.implementation.createHTMLDocument()
    doc.execCommand = () => false
    const result = copyText('s', { clipboard: { writeText: () => new Promise<void>(() => {}) }, document: doc })
    await vi.advanceTimersByTimeAsync(CLIPBOARD_WRITE_TIMEOUT_MS)
    expect(await result).toBe('FAILED')
  })
  it('button is enabled without a legacy receipt and reports Copied', async () => {
    const { service } = fixture()
    await service.initializeProduction()
    const writeText = vi.fn(async () => {})
    const { host } = await render(<DigitalWellnessValidation wellness={service} clipboard={{ clipboard: { writeText }, document }} />)
    const copy = button(host, 'Copy Validation Summary')
    expect(copy.disabled).toBe(false)
    await act(async () => { copy.click() })
    expect(host.textContent).toContain('Copied')
    const copied = JSON.parse((writeText.mock.calls[0] as unknown as [string])[0])
    expect(copied.access.osAccess).toBe('GRANTED')
    expect(service.getSnapshot().diagnostics.last_ui_action).toBe('COPY_VALIDATION_SUMMARY')
  })
  it('failure is visible and renders a selectable read-only summary', async () => {
    const { service } = fixture()
    await service.initializeProduction()
    const { host } = await render(<DigitalWellnessValidation wellness={service} clipboard={{ clipboard: null, document: null }} />)
    await act(async () => { button(host, 'Copy Validation Summary').click() })
    expect(host.textContent).toContain('Copy failed — select manually')
    const area = host.querySelector('textarea')!
    expect(area.readOnly).toBe(true)
    expect(JSON.parse(area.value).schema).toBe('eliteplus.digital_wellness.validation_summary.v1')
    expect(service.getSnapshot().diagnostics.last_ui_error_code).toBe('COPY_FAILED')
  })
  it('validation-summary serialization is bounded and privacy-safe', () => {
    const { service } = fixture()
    const state = enabledState()
    const at = (index: number) => new Date(Date.parse('2026-01-01T00:00:00Z') + index * 60000).toISOString()
    state.checkpoints = Array.from({ length: 256 }, (_, index) => ({
      captured_at: at(index), screen_state: 'NON_INTERACTIVE', keyguard_state: 'LOCKED', usage_access: 'GRANTED',
      consent: 'ENABLED', boot_session_marker: 'boot:1', timezone: 'UTC',
    }))
    state.ledger = Array.from({ length: 512 }, (_, index) => ({ captured_at: at(index), event: 'ACCESS_GRANTED' }))
    state.days = Array.from({ length: 90 }, (_, index) => ({
      local_date: `2025-10-${index}`, timezone: 'UTC', observed_start: at(index), observed_end: at(index),
      screen_time_minutes: 1, pickups: 1, first_pickup: null, screen_sessions: 1, late_night_screen_minutes: 0,
      coverage_state: 'PARTIAL', confidence: 'LOW', quality_reasons: Array.from({ length: 50 }, () => 'HISTORY_GAP'),
      semantic_version: 'android.digital_balance.v1', qualification_policy_version: 'android.digital_balance.qualification.v1',
      source: 'ANDROID_USAGE_STATS', captured_at: at(index), updated_at: at(index),
    }))
    state.outbox = Array.from({ length: 300 }, () => ({ marker: 'x'.repeat(500) })) as unknown as ProductionState['outbox']
    ;(service as unknown as { applyProduction(s: ProductionState): void }).applyProduction(state)
    const started = performance.now()
    const text = buildValidationSummary(service.getSnapshot(), {
      platform: 'ANDROID', androidVersion: '15', timezone: 'UTC', generatedAt: at(0),
    })
    expect(performance.now() - started).toBeLessThan(100)
    expect(text.length).toBeLessThanOrEqual(VALIDATION_SUMMARY_MAX_CHARS)
    const parsed = JSON.parse(text)
    expect(parsed.production.checkpoint_count).toBe(256)
    expect(parsed.production.recent_days.length).toBeLessThanOrEqual(3)
    expect(text).not.toMatch(/"checkpoints"|"ledger"|"outbox"|"events"|eventSequence|package|className|stack|xxxxx/i)
  })
})

describe('native access probe stays lightweight and independent', () => {
  it('completes during a held production refresh without touching store, worker, or refresh', async () => {
    const { service, native, production, holds } = fixture()
    await service.initializeProduction()
    holds.refresh = deferred()
    const refreshing = service.refresh()
    await Promise.resolve()
    const reads = production.getProductionState.mock.calls.length
    const probe = await service.checkNativeUsageAccess()
    expect(probe.osAccess).toBe('GRANTED')
    expect(production.getProductionState.mock.calls.length).toBe(reads)
    expect(production.refreshProduction).toHaveBeenCalledTimes(1)
    expect(production.setProductionConsent).not.toHaveBeenCalled()
    expect(native.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    holds.refresh.resolve()
    await refreshing
  })
  it('worker busy + native access check: probe resolves while store read and refresh are held', async () => {
    const { service, holds } = fixture()
    await service.initializeProduction()
    holds.read = deferred()
    holds.refresh = deferred()
    void service.refresh()
    void service.initializeProduction()
    expect((await service.checkNativeUsageAccess()).osAccess).toBe('GRANTED')
    holds.read.resolve()
    holds.refresh.resolve()
  })
  it('worker busy + foreground read: BUSY is reported, not ERROR and not a hang', async () => {
    vi.useFakeTimers()
    const { service, production, holds } = fixture()
    await service.initializeProduction()
    production.getProductionState.mockRejectedValueOnce(Object.assign(new Error('busy'), { code: 'WELLNESS_STORE_BUSY' }))
    await service.initializeProduction()
    expect(service.getSnapshot().diagnostics.last_ui_error_code).toBe('STORE_BUSY')
    expect(service.getSnapshot().state).not.toBe('ERROR')
    holds.read = deferred()
    const read = service.initializeProduction()
    await vi.advanceTimersByTimeAsync(UI_ACTION_TIMEOUT_MS)
    await read
    expect(service.getSnapshot().diagnostics.last_ui_error_code).toBe('STORE_BUSY')
    expect(service.getSnapshot().state).not.toBe('ERROR')
  })
})

describe('single-flight foreground production refresh', () => {
  it('concurrent refresh, Check Usage Access, and resume share one native refresh', async () => {
    const { service, production, holds, maxNativeRefreshes } = fixture()
    await service.initializeProduction()
    holds.refresh = deferred()
    const calls = [service.refresh(), service.refresh(), service.checkUsageAccess(), service.onForegroundResume(), service.refresh()]
    await Promise.resolve()
    expect(production.refreshProduction).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().diagnostics.refresh_in_progress).toBe(true)
    holds.refresh.resolve()
    await Promise.all(calls)
    expect(maxNativeRefreshes()).toBe(1)
    expect(service.getSnapshot().diagnostics).toMatchObject({ active_refresh_count: 0, refresh_in_progress: false, max_active_refresh_count: 1 })
  })
  it('repeated manual refresh does not overlap', async () => {
    const { service, production, holds, maxNativeRefreshes } = fixture()
    await service.initializeProduction()
    holds.refresh = deferred()
    const actions = Array.from({ length: 10 }, () => service.runUiAction('REFRESH', () => service.refresh()))
    await Promise.resolve()
    expect(production.refreshProduction).toHaveBeenCalledTimes(1)
    holds.refresh.resolve()
    expect(await Promise.all(actions)).toEqual(Array(10).fill('COMPLETED'))
    expect(maxNativeRefreshes()).toBe(1)
    await service.runUiAction('REFRESH', () => service.refresh())
    expect(production.refreshProduction).toHaveBeenCalledTimes(2)
  })
})

describe('visibility/resume loop guard', () => {
  function visibleDocument() {
    const doc = document.implementation.createHTMLDocument()
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' })
    return doc
  }
  it('10 visibility events during one resume do not create 10 refresh chains', async () => {
    const { service, native, production, holds } = fixture()
    const doc = visibleDocument()
    const add = vi.spyOn(doc, 'addEventListener')
    await installForegroundLifecycle(doc, service)
    await installForegroundLifecycle(doc, service)
    expect(add.mock.calls.filter(([type]) => type === 'visibilitychange')).toHaveLength(1)
    const baseRefreshes = production.refreshProduction.mock.calls.length
    const baseProbes = native.hasUsageAccess.mock.calls.length
    holds.refresh = deferred()
    for (let index = 0; index < 10; index++) doc.dispatchEvent(new Event('visibilitychange'))
    await Promise.resolve()
    expect(production.refreshProduction.mock.calls.length - baseRefreshes).toBe(1)
    holds.refresh.resolve()
    await vi.waitFor(() => expect(service.getSnapshot().diagnostics.refresh_in_progress).toBe(false))
    expect(native.hasUsageAccess.mock.calls.length - baseProbes).toBeLessThanOrEqual(1)
    // 2 initial resumes from the two install calls + 10 dispatched events → only 1 extra chain for the 10 events.
    expect(service.getSnapshot().diagnostics.visibility_event_count).toBe(12)
    expect(service.getSnapshot().diagnostics.visibility_refresh_count).toBe(3)
  })
  it('10 state updates/subscription notifications never synthesize a resume or refresh', async () => {
    const { service, production } = fixture()
    await service.initializeProduction()
    const doc = visibleDocument()
    await installForegroundLifecycle(doc, service)
    const refreshes = production.refreshProduction.mock.calls.length
    const resumes = service.getSnapshot().diagnostics.visibility_refresh_count
    let notifications = 0
    const unsubscribe = service.subscribe(() => { notifications++; service.getSnapshot() })
    for (let index = 0; index < 10; index++) await service.checkNativeUsageAccess()
    unsubscribe()
    expect(production.refreshProduction.mock.calls.length).toBe(refreshes)
    expect(service.getSnapshot().diagnostics.visibility_refresh_count).toBe(resumes)
    // Each probe: start marker, result, completion marker, state re-derivation — bounded, no feedback loop.
    expect(notifications).toBeLessThanOrEqual(10 * 4)
  })
})

describe('UI action timeouts', () => {
  it('a hung refresh times out with ACTION_TIMEOUT and the controls recover', async () => {
    vi.useFakeTimers()
    const { service, production, holds } = fixture()
    await service.initializeProduction()
    holds.refresh = deferred()
    const action = service.runUiAction('REFRESH', () => service.refresh())
    await vi.advanceTimersByTimeAsync(1)
    expect(service.getSnapshot().state).toBe('COLLECTING')
    await vi.advanceTimersByTimeAsync(UI_ACTION_TIMEOUT_MS)
    expect(await action).toBe('ACTION_TIMEOUT')
    expect(service.getSnapshot().state).not.toBe('COLLECTING')
    expect(service.getSnapshot().diagnostics).toMatchObject({ ui_actions_in_flight: 0, last_ui_error_code: 'ACTION_TIMEOUT', refresh_in_progress: true })
    // Retrying joins the in-flight native refresh rather than starting another.
    const retry = service.runUiAction('REFRESH', () => service.refresh())
    holds.refresh.resolve()
    expect(await retry).toBe('COMPLETED')
    expect(production.refreshProduction).toHaveBeenCalledTimes(1)
    expect(service.getSnapshot().diagnostics.refresh_in_progress).toBe(false)
    expect(service.getSnapshot().production?.worker_last_run).toBe('2026-01-03T12:00:00.000Z')
  })
  it('a failed/hung native check leaves the panel interactive', async () => {
    vi.useFakeTimers()
    const { service, holds } = fixture()
    await service.initializeProduction()
    holds.probe = deferred()
    const writeText = vi.fn(async () => {})
    const { host } = await render(<DigitalWellnessValidation wellness={service} clipboard={{ clipboard: { writeText }, document }} />)
    await act(async () => { button(host, 'Check Native Usage Access').click() })
    await act(async () => { await vi.advanceTimersByTimeAsync(UI_ACTION_TIMEOUT_MS) })
    expect(service.getSnapshot().diagnostics.ui_actions_in_flight).toBe(0)
    expect(service.getSnapshot().nativeProbe?.error).toBe('NATIVE_CHECK_TIMEOUT')
    expect(service.getSnapshot().osAccess).toBe('GRANTED')
    expect(button(host, 'Refresh / Test Result').disabled).toBe(false)
    await act(async () => { button(host, 'Copy Validation Summary').click() })
    expect(host.textContent).toContain('Copied')
    holds.probe.resolve()
  })
})

describe('physical-simulation stress', () => {
  it('25× each action with repeated visibility changes and a slow worker/store: no deadlock, ≤1 refresh, idle', async () => {
    vi.useFakeTimers()
    const { service, native, production, holds, maxNativeRefreshes } = fixture()
    const doc = document.implementation.createHTMLDocument()
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' })
    await installForegroundLifecycle(doc, service)
    // Slow worker/store: each native refresh and store read takes 15s/4s.
    production.refreshProduction.mockImplementation(() => new Promise((ok) => {
      setTimeout(() => ok(enabledState()), 15_000)
    }))
    let active = 0
    let maxActive = 0
    const original = production.refreshProduction.getMockImplementation()!
    production.refreshProduction.mockImplementation(async () => {
      active++
      maxActive = Math.max(maxActive, active)
      try { return await original() } finally { active-- }
    })
    production.getProductionState.mockImplementation(() => new Promise((ok) => { setTimeout(() => ok(enabledState()), 4_000) }))
    const writeText = vi.fn(() => new Promise<void>((ok) => { setTimeout(ok, 50) }))
    const settled: Array<Promise<unknown>> = []
    for (let index = 0; index < 25; index++) {
      settled.push(service.runUiAction('CHECK_NATIVE_USAGE_ACCESS', () => service.checkNativeUsageAccess()))
      settled.push(service.runUiAction('CHECK_USAGE_ACCESS', () => service.checkUsageAccess()))
      settled.push(service.runUiAction('REFRESH', () => service.refresh({ validation: true, hours: 24 })))
      settled.push(service.runUiAction('COPY_VALIDATION_SUMMARY', async () => {
        const text = buildValidationSummary(service.getSnapshot(), { platform: 'ANDROID', androidVersion: '15', timezone: 'UTC', generatedAt: 'now' })
        if (await copyText(text, { clipboard: { writeText }, document: null }) !== 'COPIED') throw new Error('copy')
      }))
      doc.dispatchEvent(new Event('visibilitychange'))
      settled.push(service.onForegroundResume())
      await vi.advanceTimersByTimeAsync(700)
    }
    let unresolved = settled.length
    settled.forEach((promise) => { void promise.finally(() => { unresolved-- }) })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(unresolved).toBe(0)
    expect(maxActive).toBeLessThanOrEqual(1)
    expect(maxNativeRefreshes()).toBeLessThanOrEqual(1)
    expect(service.getSnapshot().diagnostics.max_active_refresh_count).toBeLessThanOrEqual(1)
    expect(service.getSnapshot().diagnostics).toMatchObject({ ui_actions_in_flight: 0, active_refresh_count: 0, refresh_in_progress: false })
    expect(service.getSnapshot().state).not.toBe('COLLECTING')
    expect(writeText).toHaveBeenCalledTimes(25)
    expect(native.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    expect(holds.refresh).toBeNull()
    console.info(`stress: actions=${settled.length} unresolved=${unresolved} maxNativeRefreshes=${maxActive} refreshCalls=${
      production.refreshProduction.mock.calls.length} probes=${native.hasUsageAccess.mock.calls.length}`)
  })
})
