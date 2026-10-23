import { describe, expect, it, vi } from 'vitest'
import { LocalDigitalWellness } from './digitalWellnessLocal'
import {
  emptyProductionState, refreshProduction,
  type DigitalWellnessCheckpoint, type ProductionState, type RefreshInput,
} from './digitalWellnessProduction'
import type { DigitalWellnessNative, DigitalWellnessProductionNative } from './digitalWellnessNative'

const cp = (captured_at: string, usage_access: DigitalWellnessCheckpoint['usage_access'] = 'GRANTED'): DigitalWellnessCheckpoint => ({
  captured_at, screen_state: 'NON_INTERACTIVE', keyguard_state: 'LOCKED',
  usage_access, consent: 'ENABLED', boot_session_marker: 'boot:1', timezone: 'UTC',
})

// Enabled production state whose stored history ends in a worker-written DENIED checkpoint.
function historicalGap(): ProductionState {
  const state = emptyProductionState('preview-owner')
  state.consent = true
  state.enabled_at = '2026-01-01T12:00:00.000Z'
  state.access_established_at = '2026-01-01T12:00:00.000Z'
  state.checkpoints = [cp('2026-01-01T12:00:00.000Z'), cp('2026-01-02T11:00:00.000Z', 'DENIED')]
  state.ledger = [
    { captured_at: '2026-01-01T12:00:00.000Z', event: 'CONSENT_ENABLED' },
    { captured_at: '2026-01-01T12:00:00.000Z', event: 'ACCESS_GRANTED' },
    { captured_at: '2026-01-02T11:00:00.000Z', event: 'ACCESS_DENIED' },
  ]
  return state
}

function fixture(initial: ProductionState, granted = true) {
  let state = structuredClone(initial)
  const native = {
    getPlatformInfo: vi.fn(async () => ({ platform: 'ANDROID' as const, androidVersion: '15' })),
    isUsageAccessAvailable: vi.fn(async () => ({ available: true })),
    hasUsageAccess: vi.fn<DigitalWellnessNative['hasUsageAccess']>(async () => ({
      granted, diagnostics: { appops_result: granted ? 0 : 1 },
    })),
    openUsageAccessSettings: vi.fn(async () => {}),
    queryDigitalWellnessEvents: vi.fn(async () => { throw new Error('Raw query must not run in production') }),
  } satisfies DigitalWellnessNative
  const production = {
    getProductionState: vi.fn(async () => structuredClone(state)),
    setProductionConsent: vi.fn<DigitalWellnessProductionNative['setProductionConsent']>(async ({ enabled }) => {
      state = { ...state, consent: enabled, enabled_at: enabled ? '2026-01-03T12:00:00.000Z' : state.enabled_at,
        checkpoints: [...state.checkpoints, { ...cp('2026-01-03T12:00:00.000Z', 'UNKNOWN'), consent: enabled ? 'ENABLED' : 'DISABLED' }] }
      return structuredClone(state)
    }),
    closeProductionScope: vi.fn(async () => structuredClone(state)),
    // Worker/refresh observation that is stale relative to the live probe.
    refreshProduction: vi.fn<DigitalWellnessProductionNative['refreshProduction']>(async () => structuredClone(state)),
  } satisfies DigitalWellnessProductionNative
  const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }
  const service = new LocalDigitalWellness(native, storage, true, () => Date.parse('2026-01-03T12:00:00Z'), () => 'UTC', production)
  return { service, native, production, set: (next: ProductionState) => { state = structuredClone(next) } }
}

describe('vc5 regression: current OS access is the direct native probe, not stored history', () => {
  it('native GRANTED + historical permission gap → OS access GRANTED, day remains unqualified', async () => {
    const { service } = fixture(historicalGap())
    await service.initializeProduction()
    const snapshot = service.getSnapshot()
    expect(snapshot.access).toEqual({ osAccess: 'GRANTED', consent: 'ENABLED', collection: 'AVAILABLE', continuity: 'GAP_DETECTED' })
    expect(snapshot.permission).toBe('AUTHORIZED')
    expect(snapshot.state).not.toBe('PERMISSION_REVOKED')

    // Qualification still sees the gap: unchanged policy keeps the interrupted day out of baselines.
    const input: RefreshInput = {
      state: historicalGap(), checkpoint: cp('2026-01-03T06:00:00.000Z'), query_ok: true, os_version: '15',
      query_start: '2026-01-01T06:00:00.000Z', query_end: '2026-01-03T06:00:00.000Z',
      events: [{ type: 'SCREEN_NON_INTERACTIVE', timestamp: '2026-01-01T06:00:00.000Z' },
        { type: 'KEYGUARD_SHOWN', timestamp: '2026-01-01T06:00:00.000Z' }],
    }
    const day = refreshProduction(input).days.find((item) => item.local_date === '2026-01-02')!
    expect(day.coverage_state).not.toBe('QUALIFIED')
    expect(day.quality_reasons).toContain('PERMISSION_OR_CONSENT_INTERRUPTION')
  })

  it('native GRANTED + consent enabled → AVAILABLE', async () => {
    const state = emptyProductionState('preview-owner')
    state.consent = true
    state.enabled_at = '2026-01-03T00:00:00.000Z'
    const { service } = fixture(state)
    await service.initializeProduction()
    expect(service.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', consent: 'ENABLED', collection: 'AVAILABLE' })
  })

  it('native GRANTED + consent disabled → OS access GRANTED, collection DISABLED, no collection', async () => {
    const { service, production, native } = fixture(emptyProductionState('preview-owner'))
    await service.initializeProduction()
    await service.foregroundRefresh()
    await service.checkUsageAccess()
    expect(service.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', consent: 'DISABLED', collection: 'DISABLED' })
    expect(service.getSnapshot().permission).toBe('AUTHORIZED')
    expect(production.refreshProduction).not.toHaveBeenCalled()
    expect(native.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    expect(service.getSnapshot().state).toBe('DISABLED')
  })

  it('native DENIED → OS_ACCESS_REQUIRED', async () => {
    const state = emptyProductionState('preview-owner')
    state.consent = true
    state.enabled_at = '2026-01-03T00:00:00.000Z'
    const { service } = fixture(state, false)
    await service.initializeProduction()
    expect(service.getSnapshot().access).toMatchObject({ osAccess: 'DENIED', collection: 'OS_ACCESS_REQUIRED' })
    expect(service.getSnapshot().nativeProbe).toMatchObject({ osAccess: 'DENIED', appOpsResult: 1 })
  })

  it('revoke then regrant → direct native probe immediately reports GRANTED', async () => {
    const { service, native, production } = fixture(historicalGap())
    await service.initializeProduction()
    native.hasUsageAccess.mockResolvedValue({ granted: false, diagnostics: { appops_result: 1 } })
    await service.checkNativeUsageAccess()
    expect(service.getSnapshot().access).toMatchObject({ osAccess: 'DENIED', collection: 'OS_ACCESS_REQUIRED' })
    expect(service.getSnapshot().state).toBe('PERMISSION_REVOKED')
    native.hasUsageAccess.mockResolvedValue({ granted: true, diagnostics: { appops_result: 0 } })
    const probe = await service.checkNativeUsageAccess()
    expect(probe).toMatchObject({ osAccess: 'GRANTED', appOpsResult: 0, error: null })
    expect(service.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', collection: 'AVAILABLE' })
    expect(production.refreshProduction).not.toHaveBeenCalled()
  })

  it('prior DENIED ledger row and UNKNOWN consent checkpoint do not override a new GRANTED probe', async () => {
    const { service } = fixture(historicalGap())
    await service.initializeProduction()
    await service.disable()
    await service.confirmSetup()
    const production = service.getSnapshot().production!
    expect(production.checkpoints.at(-1)?.usage_access).toBe('UNKNOWN')
    expect(production.ledger.some((item) => item.event === 'ACCESS_DENIED')).toBe(true)
    expect(service.getSnapshot().access.osAccess).toBe('GRANTED')
    expect(service.getSnapshot().permission).toBe('AUTHORIZED')
  })

  it('worker reports old DENIED → foreground native GRANTED wins current state', async () => {
    const state = emptyProductionState('preview-owner')
    state.consent = true
    state.enabled_at = '2026-01-01T12:00:00.000Z'
    state.access_established_at = '2026-01-01T12:00:00.000Z'
    const { service, production, set } = fixture(state)
    await service.initializeProduction()
    const workerDenied = { ...historicalGap(), last_usage_access_check: '2026-01-02T11:00:00.000Z' }
    set(workerDenied)
    production.refreshProduction.mockResolvedValue(structuredClone(workerDenied))
    await service.foregroundRefresh()
    expect(service.getSnapshot().production?.checkpoints.at(-1)?.usage_access).toBe('DENIED')
    expect(service.getSnapshot().access).toMatchObject({ osAccess: 'GRANTED', collection: 'AVAILABLE', continuity: 'GAP_DETECTED' })
    // Check Usage Access probes AppOps directly even while a refresh is in flight.
    let finish!: (value: ProductionState) => void
    production.refreshProduction.mockImplementation(() => new Promise((resolve) => { finish = resolve }))
    const pending = service.foregroundRefresh()
    await service.checkNativeUsageAccess()
    expect(service.getSnapshot().nativeProbe?.osAccess).toBe('GRANTED')
    finish(structuredClone(workerDenied))
    await pending
    expect(service.getSnapshot().access.osAccess).toBe('GRANTED')
  })

  it('native probe failure is UNKNOWN, never DENIED', async () => {
    const { service, native } = fixture(emptyProductionState('preview-owner'))
    native.hasUsageAccess.mockRejectedValue(new Error('bridge'))
    await service.initializeProduction()
    expect(service.getSnapshot().access.osAccess).toBe('UNKNOWN')
    expect(service.getSnapshot().nativeProbe?.error).toBe('NATIVE_CHECK_FAILED')
  })
})
