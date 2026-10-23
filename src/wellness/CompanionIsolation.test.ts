// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { CompanionWellnessSession } from './CompanionWellnessSession'
import { emptyProductionState, refreshProduction, type ProductionState } from './health/digitalWellnessProduction'
import type { DigitalWellnessNative } from './health/digitalWellnessNative'
import { ObservationQueue } from '../services/sync/ObservationQueue'
import { WebQueueStore } from '../services/storage/WebQueueStore'
import { createSyntheticObservation } from '../services/testing/SyntheticObservationFactory'
import { ProductionV8Sync, type ProductionSyncBridge } from '../adapters/jcvital/ProductionV8Sync'
import { ProductionSyncLedger } from '../adapters/jcvital/ProductionSyncLedger'
import type { JCVitalV8HistoricalSyncResult } from '../adapters/jcvital/jcvitalV8Bridge'

function fixture() {
  let state: ProductionState | null = null
  let owner: string | null = null
  let granted = true
  const calls: string[] = []
  const native = {
    getPlatformInfo: async () => ({ platform: 'ANDROID' as const, androidVersion: '15' }),
    isUsageAccessAvailable: async () => ({ available: true }),
    hasUsageAccess: async () => ({ granted }),
    openUsageAccessSettings: vi.fn(async () => {}),
    queryDigitalWellnessEvents: vi.fn<DigitalWellnessNative['queryDigitalWellnessEvents']>(),
    bindAuthenticatedOwner: vi.fn(async ({ ownerUserId }: { ownerUserId: string }) => {
      calls.push(`bind:${ownerUserId}`)
      if (owner !== ownerUserId) state = { ...emptyProductionState(crypto.randomUUID()), owner_kind: 'AUTHENTICATED' }
      owner = ownerUserId
      return structuredClone(state!)
    }),
    clearAuthenticatedOwner: vi.fn(async () => { calls.push('close'); state = null; owner = null }),
    getProductionState: vi.fn(async ({ scope }: { scope: string }) => {
      if (state?.scope !== scope) throw new Error('OWNER_SCOPE_CLOSED')
      return structuredClone(state)
    }),
    setProductionConsent: vi.fn(async ({ scope, enabled }: { scope: string; enabled: boolean }) => {
      if (state?.scope !== scope) throw new Error('OWNER_SCOPE_CLOSED')
      state.consent = enabled
      state.enabled_at = enabled ? new Date().toISOString() : state.enabled_at
      return structuredClone(state)
    }),
    closeProductionScope: vi.fn(async () => { state = emptyProductionState('SIGNED_OUT'); return structuredClone(state) }),
    refreshProduction: vi.fn(async ({ scope }: { scope: string }) => {
      if (state?.scope !== scope) throw new Error('OWNER_SCOPE_CLOSED')
      state = refreshProduction({
        state,
        checkpoint: {
          captured_at: new Date().toISOString(), screen_state: 'UNKNOWN', keyguard_state: 'UNKNOWN',
          consent: state.consent ? 'ENABLED' : 'DISABLED', usage_access: granted ? 'GRANTED' : 'DENIED',
          timezone: 'UTC', boot_session_marker: 'boot:1',
        },
        events: [], query_start: new Date(Date.now() - 48 * 3600000).toISOString(),
        query_end: new Date().toISOString(), query_ok: granted, os_version: '15',
      })
      return structuredClone(state)
    }),
  }
  return {
    native, calls, session: new CompanionWellnessSession(native, true, localStorage),
    state: () => structuredClone(state), revoke: () => { granted = false },
  }
}

describe('Companion owner boundary', () => {
  it('restores only the same authenticated owner, and never inherits preview consent', async () => {
    localStorage.setItem('eliteplus.digitalWellness.consent.v1', '{"state":"GRANTED"}')
    const f = fixture()
    const user = { id: 'owner-a', email: 'a@example.test' }
    const wellness = (await f.session.activateAuthenticatedUser(user))!
    expect(wellness.getSnapshot().production).toMatchObject({ owner_kind: 'AUTHENTICATED', consent: false })
    await wellness.confirmSetup()
    const scope = f.state()!.scope
    const restarted = new CompanionWellnessSession(f.native, true, localStorage)
    const restored = (await restarted.activateAuthenticatedUser(user))!
    expect(restored.getSnapshot().production).toMatchObject({ scope, consent: true })
    expect(f.native.clearAuthenticatedOwner).not.toHaveBeenCalled()
    await f.session.closeAuthenticatedUser()
    const next = (await f.session.activateAuthenticatedUser({ id: 'owner-b', email: 'b@example.test' }))!
    expect(next.getSnapshot().production).toMatchObject({ consent: false, checkpoints: [], days: [], outbox: [] })
    expect(f.calls.indexOf('close')).toBeLessThan(f.calls.indexOf('bind:owner-b'))
    await wellness.confirmSetup()
    expect(f.state()!.consent).toBe(false)
  })

  it('blocks another owner and logout completion when native shutdown fails', async () => {
    const f = fixture()
    await f.session.activateAuthenticatedUser({ id: 'owner-a', email: 'a@example.test' })
    f.native.clearAuthenticatedOwner.mockRejectedValue(new Error('WELLNESS_STORE_BUSY'))
    await expect(f.session.closeAuthenticatedUser()).rejects.toThrow('WELLNESS_STORE_BUSY')
    await expect(f.session.activateAuthenticatedUser({ id: 'owner-b', email: 'b@example.test' })).rejects.toThrow()
    expect(f.calls).not.toContain('bind:owner-b')
  })
})

describe('bidirectional V8 / Digital Wellness isolation', () => {
  it('DW opt-in/refresh/revoke causes zero V8 queue, journal, acquisition, connection or delivery writes', async () => {
    const queue = new ObservationQueue(new WebQueueStore())
    queue.setOwnerUserId('owner-a')
    await queue.initialize()
    const observation = createSyntheticObservation()
    await queue.enqueue(observation)
    const before = await queue.getRecord(observation.observationId)
    const enqueue = vi.spyOn(queue, 'enqueue')
    const enqueueMany = vi.spyOn(queue, 'enqueueMany')
    const f = fixture()
    const wellness = (await f.session.activateAuthenticatedUser({ id: 'owner-a', email: 'a@example.test' }))!
    await wellness.confirmSetup()
    await wellness.onForegroundResume()
    f.revoke()
    await wellness.refresh()
    await wellness.disable()
    expect(await queue.getRecord(observation.observationId)).toEqual(before)
    expect(enqueue).not.toHaveBeenCalled()
    expect(enqueueMany).not.toHaveBeenCalled()
    expect(f.native.queryDigitalWellnessEvents).not.toHaveBeenCalled()
    expect(wellness.getSnapshot().production?.last_sender_outcome).toBe('CLOUD_DISABLED')

    // Verify the complete production module graph, not just a mock that was never connected.
    const root = resolve('src/wellness')
    const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? files(join(dir, entry.name)) : [join(dir, entry.name)])
    const source = files(root).filter((path) => !path.includes('.test.') && !path.endsWith('.css'))
      .map((path) => readFileSync(path, 'utf8').replace(/^import type .*$/gm, '')).join('\n')
    expect(source).not.toMatch(/from ['"][^'"]*(?:jcvital|sync\/|storage\/|Base44Client|ConnectorObservationService)/)
    expect(source).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|WebSocket/)
    const native = files(resolve('android/app/src/main/java/com/hapi/eliteplus/connector/wellness'))
      .map((path) => readFileSync(path, 'utf8')).join('\n')
    expect(native).not.toMatch(/JCVital|SourceJournal|observation_queue|elite_plus_connector|java\.net|HttpClient/)
    expect(native.replaceAll('context.getPackageName()', '')).not.toMatch(/getPackageName|getClassName|getInstalledPackages/)
    expect(native).not.toMatch(/setForeground|ForegroundInfo|AccessibilityService|NotificationListener/)
  })

  it('runs the existing manual V8 production acquisition flow without touching DW consent, checkpoints or qualification', async () => {
    const f = fixture()
    const wellness = (await f.session.activateAuthenticatedUser({ id: 'owner-a', email: 'a@example.test' }))!
    await wellness.confirmSetup()
    const before = f.state()
    const nativeCalls = [f.native.setProductionConsent.mock.calls.length, f.native.refreshProduction.mock.calls.length]
    const queue = new ObservationQueue(new WebQueueStore())
    queue.setOwnerUserId('owner-a')
    await queue.initialize()
    const empty = (type: string): JCVitalV8HistoricalSyncResult => ({
      syncId: crypto.randomUUID(), deviceId: 'v8-device', provider: 'JCVITAL', sdkCommand: 'existing',
      vendorDataType: type, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(),
      recordsReceived: 0, recordGroupsReceived: 0, packetCount: 0, parseErrors: [],
      recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0,
      earliestObservation: null, latestObservation: null, partial: false, completionStatus: 'EMPTY_VALID',
      observations: [], nativeRequestAccepted: true, nativeCommandQueued: true, nativeCommandWritten: true,
    })
    const bridge: ProductionSyncBridge = {
      getConnectionState: async () => ({ state: 'READY', deviceId: 'v8-device' }),
      getSourceJournalDiagnostics: async () => ({
        modelVersion: 'test', enabled: true, failedClosed: false, lastOutcome: 'OK', refusedCount: 0,
        totalEnvelopeCount: 0, totalStoredBytes: 0, maxBytes: 0, maxEnvelopes: 0, maxEntryBytes: 0,
        retentionPolicy: 'test', rawStorage: 'test',
      }),
      syncHistoricalHeartRate: vi.fn(async () => empty('27')),
      syncHistoricalSpo2: vi.fn(async () => empty('68')),
      syncHistoricalTemperature: vi.fn(async () => empty('59')),
      ackHistoricalHrChunk: async () => {},
      addListener: async () => ({ remove: async () => {} }),
    }
    const sync = new ProductionV8Sync({
      bridge, queue, ledger: new ProductionSyncLedger(() => localStorage), resolveDeviceScopeId: () => 'v8-scope',
      delivery: { process: async () => null, subscribe: () => () => {}, getDeliveryDiagnostics: () => ({ activeWorkerCount: 0 }) },
      finalHrChunkWaitMs: 0,
    })
    const receipt = await sync.run({
      appVersion: 'test', versionCode: 51,
      owners: { authenticatedOwnerUserId: 'owner-a', persistedConnectorOwnerUserId: 'owner-a', connectorDeviceId: 'connector' },
      journalScope: { accountId: 'owner-a', deviceScopeId: 'v8-scope' },
      device: { bleDeviceId: 'v8-device', name: 'Elite+ V8', firmwareVersion: null, sdkVersion: null },
    })
    expect(receipt.outcome).toBe('UP_TO_DATE')
    expect(bridge.syncHistoricalHeartRate).toHaveBeenCalledOnce()
    expect(bridge.syncHistoricalSpo2).toHaveBeenCalledOnce()
    expect(bridge.syncHistoricalTemperature).toHaveBeenCalledOnce()
    expect(f.state()).toEqual(before)
    expect([f.native.setProductionConsent.mock.calls.length, f.native.refreshProduction.mock.calls.length]).toEqual(nativeCalls)
  })
})
