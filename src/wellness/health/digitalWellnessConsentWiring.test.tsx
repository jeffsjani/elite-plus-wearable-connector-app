// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LocalDigitalWellness, installForegroundLifecycle } from './digitalWellnessLocal'
import { emptyProductionState, type ProductionState } from './digitalWellnessProduction'
import type { DigitalWellnessNative, DigitalWellnessProductionNative } from './digitalWellnessNative'

vi.mock('@capacitor/core', () => ({
  registerPlugin: vi.fn(() => ({ getPlatformInfo: async () => ({ platform: 'ANDROID', androidVersion: '15' }) })),
}))
import { CompanionShell } from '../CompanionShell'
import { DigitalBalance } from '../DigitalBalance'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const LEGACY_CONSENT_KEY = 'eliteplus.digitalWellness.consent.v1'

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  return { promise: new Promise<T>((ok) => { resolve = ok }), resolve }
}

// Device double mirroring the native contract: one persisted production store (survives "restarts"),
// AppOps access, and the unique periodic worker that WellnessConsent/WellnessWorker schedule and cancel.
function device(options: { granted?: boolean; days?: ProductionState['days'] } = {}) {
  const disk = { state: { ...emptyProductionState('preview-owner'), days: options.days ?? [] } }
  const os = { granted: options.granted ?? false, worker: 'NONE' as 'NONE' | 'ENQUEUED' | 'CANCELLED' }
  const holds = { consent: null as Deferred<void> | null, settings: null as Deferred<void> | null }
  const failures = { consentAfterCommit: false, consentBeforeCommit: false }
  const native = {
    getPlatformInfo: vi.fn(async () => ({ platform: 'ANDROID' as const, androidVersion: '15' })),
    isUsageAccessAvailable: vi.fn(async () => ({ available: true })),
    hasUsageAccess: vi.fn<DigitalWellnessNative['hasUsageAccess']>(async () => ({
      granted: os.granted, diagnostics: { appops_result: os.granted ? 0 : 1 },
    })),
    openUsageAccessSettings: vi.fn(async () => { if (holds.settings) await holds.settings.promise }),
    queryDigitalWellnessEvents: vi.fn(async () => { throw new Error('Raw query must not run in production') }),
  } satisfies DigitalWellnessNative
  const production = {
    getProductionState: vi.fn(async () => structuredClone(disk.state)),
    setProductionConsent: vi.fn<DigitalWellnessProductionNative['setProductionConsent']>(async ({ enabled }) => {
      if (holds.consent) await holds.consent.promise
      if (failures.consentBeforeCommit) throw Object.assign(new Error('busy'), { code: 'WELLNESS_STORE_BUSY' })
      const now = '2026-01-03T12:00:00.000Z'
      disk.state = {
        ...disk.state, consent: enabled, next_eligible_run: null,
        ...(enabled ? { enabled_at: now, access_established_at: null, error: null } : {}),
        ledger: [...disk.state.ledger, { captured_at: now, event: enabled ? 'CONSENT_ENABLED' : 'CONSENT_DISABLED' }],
      }
      if (failures.consentAfterCommit) throw Object.assign(new Error('schedule'), { code: 'WELLNESS_STORAGE_FAILED' })
      os.worker = enabled ? 'ENQUEUED' : 'CANCELLED'
      return structuredClone(disk.state)
    }),
    closeProductionScope: vi.fn(async () => structuredClone(disk.state)),
    refreshProduction: vi.fn(async () => {
      if (!disk.state.consent) return structuredClone(disk.state)
      const now = '2026-01-03T12:05:00.000Z'
      if (!os.granted) {
        os.worker = 'CANCELLED'
        disk.state = { ...disk.state, last_usage_access_check: now, next_eligible_run: null }
      } else {
        os.worker = 'ENQUEUED'
        disk.state = {
          ...disk.state, worker_last_run: now, last_usage_access_check: now,
          access_established_at: disk.state.access_established_at ?? now, next_eligible_run: '2026-01-03T18:05:00.000Z',
        }
      }
      return structuredClone(disk.state)
    }),
  } satisfies DigitalWellnessProductionNative
  const storage = new Map<string, string>()
  const webStorage = {
    getItem: vi.fn((key: string) => storage.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { storage.set(key, value) }),
    removeItem: vi.fn((key: string) => { storage.delete(key) }),
  }
  const launch = () => new LocalDigitalWellness(native, webStorage, true,
    () => Date.parse('2026-01-03T12:00:00Z'), () => 'UTC', production)
  return { disk, os, holds, failures, native, production, storage, webStorage, launch }
}

const mounted: Array<() => Promise<void>> = []
afterEach(async () => {
  while (mounted.length) await mounted.pop()!()
  document.body.innerHTML = ''
})
async function render(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.appendChild(host)
  const root = createRoot(host)
  await act(async () => { root.render(node) })
  mounted.push(async () => act(async () => { root.unmount() }))
  return host
}
const find = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll('button')].find((item) => item.textContent?.trim() === label)
async function click(host: HTMLElement, label: string) {
  const target = find(host, label)
  expect(target, label).toBeDefined()
  await act(async () => { target!.click() })
}
async function settle() { await act(async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }) }

async function launched(d: ReturnType<typeof device>) {
  const wellness = d.launch()
  await installForegroundLifecycle(document.implementation.createHTMLDocument(), wellness)
  return wellness
}

describe('Phase 3B-4 vc8: Set Up Digital Wellness persists production consent', () => {
  it('GRANTED OS access + Set Up → production consent true → collection AVAILABLE → worker scheduled, no Settings detour', async () => {
    const d = device({ granted: true })
    const wellness = await launched(d)
    const host = await render(<DigitalBalance wellness={wellness} />)
    expect(wellness.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', consent: 'DISABLED', collection: 'DISABLED' })
    await click(host, 'Set Up Digital Wellness')
    await click(host, 'Turn On Digital Wellness')
    await settle()
    expect(d.production.setProductionConsent).toHaveBeenCalledExactlyOnceWith({ enabled: true })
    expect(d.disk.state.consent).toBe(true)
    expect(wellness.getSnapshot().production?.consent).toBe(true)
    expect(wellness.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', consent: 'ENABLED', collection: 'AVAILABLE' })
    expect(d.os.worker).toBe('ENQUEUED')
    expect(wellness.getSnapshot().production?.next_eligible_run).not.toBeNull()
    expect(d.native.openUsageAccessSettings).not.toHaveBeenCalled()
    expect(host.textContent).toContain('Digital Wellness is on.')
    expect(host.querySelector('[role="dialog"]')).toBeNull()
  })

  it('GRANTED + Set Up with existing local days → LOCAL_DATA_READY', async () => {
    const d = device({ granted: true, days: [{
      local_date: '2026-01-02', timezone: 'UTC', observed_start: '2026-01-02T00:00:00.000Z', observed_end: '2026-01-03T00:00:00.000Z',
      screen_time_minutes: 10, pickups: 1, first_pickup: null, screen_sessions: 1, late_night_screen_minutes: 0,
      coverage_state: 'QUALIFIED', confidence: 'HIGH', quality_reasons: [], semantic_version: 'android.digital_balance.v1',
      qualification_policy_version: 'android.digital_balance.qualification.v1', source: 'ANDROID_USAGE_STATS',
      captured_at: '2026-01-03T00:00:00.000Z', updated_at: '2026-01-03T00:00:00.000Z',
    }] })
    const wellness = await launched(d)
    wellness.beginSetup()
    await wellness.confirmSetup()
    expect(wellness.getSnapshot().access).toMatchObject({ consent: 'ENABLED', collection: 'LOCAL_DATA_READY' })
  })

  it('DENIED OS access + Set Up → consent true, OS_ACCESS_REQUIRED, Usage Access settings opened', async () => {
    const d = device({ granted: false })
    d.holds.settings = deferred()
    const wellness = await launched(d)
    const host = await render(<DigitalBalance wellness={wellness} />)
    await click(host, 'Set Up Digital Wellness')
    await click(host, 'Turn On Digital Wellness')
    await settle()
    expect(d.disk.state.consent).toBe(true)
    expect(wellness.getSnapshot().access).toMatchObject({ osAccess: 'DENIED', consent: 'ENABLED', collection: 'OS_ACCESS_REQUIRED' })
    expect(d.native.openUsageAccessSettings).toHaveBeenCalledTimes(1)
    expect(host.textContent).toContain('Android Usage Access is still required')
    expect(host.textContent).not.toContain('Digital Wellness is on.')
    // User returns without granting: still separated, nothing claims collection.
    d.holds.settings.resolve()
    await settle()
    expect(wellness.getSnapshot().access).toMatchObject({ osAccess: 'DENIED', consent: 'ENABLED', collection: 'OS_ACCESS_REQUIRED' })
    expect(d.os.worker).toBe('CANCELLED')
  })

  it('return from Settings with newly GRANTED access → direct recheck → collection AVAILABLE → worker scheduled', async () => {
    const d = device({ granted: false })
    d.holds.settings = deferred()
    const wellness = await launched(d)
    wellness.beginSetup()
    const setup = wellness.confirmSetup()
    await settle()
    expect(wellness.getSnapshot().access.collection).toBe('OS_ACCESS_REQUIRED')
    const probesBefore = d.native.hasUsageAccess.mock.calls.length
    d.os.granted = true
    d.holds.settings.resolve()
    await setup
    expect(d.native.hasUsageAccess.mock.calls.length).toBeGreaterThan(probesBefore)
    expect(wellness.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', consent: 'ENABLED', collection: 'AVAILABLE' })
    expect(d.production.refreshProduction).toHaveBeenCalled()
    expect(d.os.worker).toBe('ENQUEUED')
  })

  it('Set Up then app restart → consent persists true from the native store', async () => {
    const d = device({ granted: true })
    const first = await launched(d)
    first.beginSetup()
    await first.confirmSetup()
    const restarted = await launched(d)
    expect(restarted.getSnapshot().production?.consent).toBe(true)
    expect(restarted.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', consent: 'ENABLED', collection: 'AVAILABLE' })
    expect(d.production.setProductionConsent).toHaveBeenCalledTimes(1)
  })

  it('Set Up then foreground resume → consent remains true', async () => {
    const d = device({ granted: true })
    const wellness = d.launch()
    const doc = document.implementation.createHTMLDocument()
    await installForegroundLifecycle(doc, wellness)
    wellness.beginSetup()
    await wellness.confirmSetup()
    Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => 'visible' })
    doc.dispatchEvent(new Event('visibilitychange'))
    await wellness.onForegroundResume()
    expect(d.disk.state.consent).toBe(true)
    expect(wellness.getSnapshot().access).toMatchObject({ consent: 'ENABLED', collection: 'AVAILABLE' })
  })

  it('Disable → setProductionConsent({enabled:false}) → persisted false → DISABLED → worker cancelled, history kept', async () => {
    const d = device({ granted: true })
    const wellness = await launched(d)
    const host = await render(<DigitalBalance wellness={wellness} />)
    await click(host, 'Set Up Digital Wellness')
    await click(host, 'Turn On Digital Wellness')
    await settle()
    d.disk.state = { ...d.disk.state, days: [{ ...structuredClone(d.disk.state.days[0] ?? {}),
      local_date: '2026-01-02', timezone: 'UTC', coverage_state: 'QUALIFIED' } as ProductionState['days'][number]] }
    await click(host, 'Disable Digital Wellness')
    await settle()
    expect(d.production.setProductionConsent).toHaveBeenLastCalledWith({ enabled: false })
    expect(d.disk.state.consent).toBe(false)
    expect(wellness.getSnapshot().production?.consent).toBe(false)
    expect(wellness.getSnapshot().access).toMatchObject({ consent: 'DISABLED', collection: 'DISABLED' })
    expect(d.os.worker).toBe('CANCELLED')
    expect(wellness.getSnapshot().production?.days).toHaveLength(1)
    expect(find(host, 'Set Up Digital Wellness')).toBeDefined()
  })

  it('Disable does not report DISABLED until native persistence confirms it', async () => {
    const d = device({ granted: true })
    const wellness = await launched(d)
    wellness.beginSetup()
    await wellness.confirmSetup()
    d.holds.consent = deferred()
    const pending = wellness.disable()
    await settle()
    expect(wellness.getSnapshot().setup).toBe('DISABLING')
    expect(wellness.getSnapshot().access.consent).toBe('ENABLED')
    d.holds.consent.resolve()
    await pending
    expect(wellness.getSnapshot().access).toMatchObject({ consent: 'DISABLED', collection: 'DISABLED' })
  })

  it('legacy/local consent cannot disagree with production consent', async () => {
    const d = device({ granted: true })
    d.storage.set(LEGACY_CONSENT_KEY, JSON.stringify({
      domain: 'DIGITAL_WELLNESS', state: 'GRANTED', consentReference: 'legacy', policyVersion: 'digitalWellness.3b2.v1',
    }))
    const wellness = await launched(d)
    // Native says off, so the UI says off, regardless of the stale 3B-2 flag, which is retired.
    expect(wellness.getSnapshot().access.consent).toBe('DISABLED')
    expect(d.storage.has(LEGACY_CONSENT_KEY)).toBe(false)
    wellness.beginSetup()
    await wellness.confirmSetup()
    expect(wellness.getSnapshot().consent.state === 'GRANTED').toBe(d.disk.state.consent)
    await wellness.disable()
    expect(wellness.getSnapshot().consent.state === 'GRANTED').toBe(d.disk.state.consent)
    expect(d.webStorage.setItem).not.toHaveBeenCalled()
  })

  it('Setup UI does not claim success until native persistence succeeds; probes/resume cannot dismiss the opt-in', async () => {
    const d = device({ granted: true })
    const wellness = await launched(d)
    const host = await render(<DigitalBalance wellness={wellness} />)
    await click(host, 'Set Up Digital Wellness')
    // vc7 root cause: an access probe or resume used to rewrite state and silently close the opt-in.
    await act(async () => { await wellness.checkUsageAccess() })
    await act(async () => { await wellness.onForegroundResume() })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    // Settings shortcut is not offered without Elite+ consent (it granted OS access while leaving consent off).
    expect(find(host, 'Open Android Usage Access Settings')).toBeUndefined()
    d.holds.consent = deferred()
    await click(host, 'Turn On Digital Wellness')
    expect(find(host, 'Saving your choice…')?.disabled).toBe(true)
    expect(host.textContent).not.toContain('Digital Wellness is on.')
    expect(wellness.getSnapshot().access.consent).toBe('DISABLED')
    await act(async () => { await wellness.checkNativeUsageAccess() })
    expect(host.querySelector('[role="dialog"]')).not.toBeNull()
    d.holds.consent.resolve()
    await settle()
    expect(host.textContent).toContain('Digital Wellness is on.')
    expect(wellness.getSnapshot().access.consent).toBe('ENABLED')
  })

  it('native write failure keeps consent off, keeps the opt-in open, and reports the failure', async () => {
    const d = device({ granted: true })
    d.failures.consentBeforeCommit = true
    const wellness = await launched(d)
    const host = await render(<DigitalBalance wellness={wellness} />)
    await click(host, 'Set Up Digital Wellness')
    await click(host, 'Turn On Digital Wellness')
    await settle()
    expect(d.disk.state.consent).toBe(false)
    expect(wellness.getSnapshot().access.consent).toBe('DISABLED')
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('could not be turned on')
    expect(host.textContent).not.toContain('Digital Wellness is on.')
    expect(find(host, 'Turn On Digital Wellness')).toBeDefined()
  })

  it('bridge rejection after native commit is reconciled from the persisted store, not guessed', async () => {
    const d = device({ granted: true })
    d.failures.consentAfterCommit = true
    const wellness = await launched(d)
    wellness.beginSetup()
    await wellness.confirmSetup()
    expect(d.production.getProductionState).toHaveBeenCalled()
    expect(wellness.getSnapshot().production?.consent).toBe(true)
    // The refresh path re-establishes the worker when consent and access are both present.
    expect(d.os.worker).toBe('ENQUEUED')
    expect(wellness.getSnapshot().access).toMatchObject({ consent: 'ENABLED', collection: 'AVAILABLE' })
  })

  it('Settings → Connections → Digital Wellness uses the same production path without invoking V8', async () => {
    const d = device({ granted: true })
    const wellness = await launched(d)
    const connect = vi.fn()
    const host = await render(<CompanionShell wellness={wellness} v8={<button onClick={connect}>Connect Elite+ V8</button>} />)
    await click(host, 'Settings')
    await click(host, 'Connect')
    expect(find(host, 'Connect Elite+ V8')?.disabled).toBe(false)
    await click(host, 'Set Up Digital Wellness')
    await click(host, 'Turn On Digital Wellness')
    await settle()
    expect(d.production.setProductionConsent).toHaveBeenCalledWith({ enabled: true })
    expect(wellness.getSnapshot().access).toMatchObject({ consent: 'ENABLED', collection: 'AVAILABLE' })
    expect(connect).not.toHaveBeenCalled()
  })
})
