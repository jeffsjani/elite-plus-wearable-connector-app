import { describe, expect, it, vi } from 'vitest'
import { LocalDigitalWellness } from './digitalWellnessLocal'
import { emptyProductionState } from './digitalWellnessProduction'
import type { DigitalWellnessNative, DigitalWellnessProductionNative } from './digitalWellnessNative'

function fixture() {
  let state = emptyProductionState('preview-owner-a')
  const native: DigitalWellnessNative = {
    getPlatformInfo: vi.fn<DigitalWellnessNative['getPlatformInfo']>(async () => ({ platform: 'ANDROID', androidVersion: '15' })),
    isUsageAccessAvailable: vi.fn(async () => ({ available: true })),
    hasUsageAccess: vi.fn(async () => ({ granted: true })),
    openUsageAccessSettings: vi.fn(async () => {}),
    queryDigitalWellnessEvents: vi.fn(async () => { throw new Error('Raw query must not run in production') }),
  }
  const production = {
    getProductionState: vi.fn(async () => structuredClone(state)),
    setProductionConsent: vi.fn<DigitalWellnessProductionNative['setProductionConsent']>(async ({ enabled }) => {
      state = { ...state, consent: enabled, enabled_at: enabled ? '2026-01-01T12:00:00Z' : state.enabled_at }
      return structuredClone(state)
    }),
    closeProductionScope: vi.fn(async () => { state = emptyProductionState('preview-owner-b'); return structuredClone(state) }),
    refreshProduction: vi.fn(async () => {
      state = { ...state, checkpoints: [{
        captured_at: '2026-01-01T12:00:00Z', screen_state: 'NON_INTERACTIVE', keyguard_state: 'LOCKED',
        consent: 'ENABLED', usage_access: 'GRANTED', boot_session_marker: 'boot:1', timezone: 'UTC',
      }] }
      return structuredClone(state)
    }),
  } satisfies DigitalWellnessProductionNative
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }
  const service = new LocalDigitalWellness(native, storage, true, undefined, undefined, production)
  return { service, production, storage, native }
}
describe('production Digital Wellness lifecycle', () => {
  it('does not inherit legacy install-global consent or query while disabled', async () => {
    const { service, production, storage, native } = fixture()
    await service.initializeProduction()
    await service.foregroundRefresh()
    expect(storage.getItem).not.toHaveBeenCalled()
    expect(production.refreshProduction).not.toHaveBeenCalled()
    expect(native.queryDigitalWellnessEvents).not.toHaveBeenCalled()
  })
  it('setup and foreground refresh use the same native shared-engine path, not the legacy calculator flow', async () => {
    const { service, production, native, storage } = fixture()
    await service.confirmSetup()
    await service.foregroundRefresh()
    await service.refresh({ validation: true, hours: 1 })
    expect(production.refreshProduction).toHaveBeenCalledTimes(3)
    expect(native.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(service.getSnapshot().permission).toBe('AUTHORIZED')
  })
  it('disable and account closure preserve native owner isolation and block future refresh', async () => {
    const { service, production } = fixture()
    await service.confirmSetup()
    service.disable()
    await Promise.resolve()
    await service.foregroundRefresh()
    expect(production.refreshProduction).toHaveBeenCalledTimes(1)
    await service.closeOwnerScope()
    expect(service.getSnapshot().production?.scope).toBe('preview-owner-b')
    expect(service.getSnapshot().consent.state).toBe('REVOKED')
    await service.foregroundRefresh()
    expect(production.refreshProduction).toHaveBeenCalledTimes(1)
  })
  it('discards in-flight worker results and stale initialization after owner change', async () => {
    const { service, production } = fixture()
    await service.confirmSetup()
    const old = structuredClone(service.getSnapshot().production!)
    let complete!: (state: typeof old) => void
    production.refreshProduction.mockImplementation(() => new Promise((resolve) => { complete = resolve }))
    const pending = service.foregroundRefresh()
    await service.closeOwnerScope()
    complete(old)
    await pending
    expect(service.getSnapshot().production?.scope).toBe('preview-owner-b')
    expect(service.getSnapshot().consent.state).toBe('REVOKED')
  })
  it('surfaces native storage/runtime failure, never a success-shaped result', async () => {
    const { service, production } = fixture()
    await service.confirmSetup()
    production.refreshProduction.mockRejectedValue(new Error('private native details'))
    await service.foregroundRefresh()
    expect(service.getSnapshot().state).toBe('ERROR')
    expect(service.getSnapshot().error).not.toContain('private native details')
    expect(service.getSnapshot().error).toContain('No new qualified observation')
  })
})
