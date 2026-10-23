// @vitest-environment jsdom
import { act } from 'react'
import { readFileSync } from 'node:fs'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

/**
 * v47.1 manual-sync invariant: ProductionV8Sync.run() starts only from an explicit click. Mount, connect,
 * READY, reconnect, receipt hydration, foreground, network and background queue delivery start nothing.
 */

const MAC = 'E7:1B:D8:36:78:CF'
const DEVICE = {
  id: MAC, macAddress: MAC, name: 'JCV8B 3678CF', rssi: -45, bonded: false, connectable: true,
  lastSeenAt: '2026-10-15T12:00:00Z', advertisesJcvitalService: false, v8Candidate: true,
}

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

function historical(vendorDataType: string, sdkCommand: string): JCVitalV8HistoricalSyncResult {
  return {
    syncId: crypto.randomUUID(), deviceId: MAC, provider: 'JCVITAL', sdkCommand, vendorDataType,
    startedAt: '2026-10-15T12:00:00.000Z', completedAt: '2026-10-15T12:00:01.000Z',
    recordsReceived: 0, recordGroupsReceived: 0, recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0,
    earliestObservation: null, latestObservation: null, partial: false, completionStatus: 'EMPTY_VALID',
    nativeRequestAccepted: true, nativeCommandQueued: true, nativeCommandWritten: true,
    packetCount: 1, parseErrors: [], observations: [], sourceRecordEnvelopeIds: [],
  }
}

const h = vi.hoisted(() => ({
  native: { state: 'DISCONNECTED' as string, deviceId: null as string | null, journal: null as null | { accountId: string; deviceScopeId: string } },
  listeners: new Map<string, Set<(event: unknown) => void>>(),
  calls: [] as string[],
  spo2: null as null | (() => Promise<unknown>),
  temperature: null as null | (() => Promise<unknown>),
  journalDiagnostics: null as null | (() => Promise<unknown>),
  storedReceipt: null as unknown,
  senderActive: false,
  queueStats: { pending: 0, retrying: 0, failed: 0, inFlight: 0, acknowledged: 0, warnings: [] as string[] },
}))

vi.mock('../../buildMode', () => ({
  IS_ENGINEERING_BUILD: true,
  IS_CONNECTION_DIAGNOSTIC_BUILD: false,
  IS_ACTIVITY_V2_PRODUCTION_VERIFICATION_BUILD: false,
}))
vi.mock('@v8-physical-semantic-tests', async () => import('./V8PhysicalSemanticTests'))
vi.mock('./V8PipelineDiagnosticView', () => ({ V8PipelineDiagnosticView: () => null }))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true, getPlatform: () => 'android' },
  registerPlugin: () => ({ getPlatformInfo: async () => ({ platform: 'ANDROID', androidVersion: '15' }) }),
}))

vi.mock('./jcvitalV8Bridge', async (importOriginal) => {
  const record = (name: string) => { h.calls.push(name) }
  const journalDiagnostics = () => ({
    modelVersion: 'test', enabled: true, failedClosed: false, lastOutcome: 'OK', refusedCount: 0,
    totalEnvelopeCount: 0, totalStoredBytes: 0, maxBytes: 268_435_456, maxEnvelopes: 0, maxEntryBytes: 0, retentionPolicy: 'test', rawStorage: 'test',
  })
  return {
    ...await importOriginal<typeof import('./jcvitalV8Bridge')>(),
    JCVitalV8: {
      initialize: vi.fn(async () => ({ initialized: true, pluginName: 'JCVitalV8' })),
      isAvailable: vi.fn(async () => ({ available: true, enabled: true })),
      addListener: vi.fn(async (event: string, listener: (event: unknown) => void) => {
        const set = h.listeners.get(event) ?? new Set()
        set.add(listener)
        h.listeners.set(event, set)
        return { remove: async () => { set.delete(listener) } }
      }),
      getConnectionState: vi.fn(async () => ({ state: h.native.state, deviceId: h.native.deviceId })),
      getPermissionStatus: vi.fn(async () => ({ status: 'AUTHORIZED', bluetoothEnabled: true, permissions: [] })),
      requestPermissions: vi.fn(async () => ({ status: 'AUTHORIZED', bluetoothEnabled: true, permissions: [] })),
      getDiscoveredDevices: vi.fn(async () => ({ devices: [DEVICE] })),
      startScan: vi.fn(async () => { record('startScan') }),
      configureSourceJournal: vi.fn(async (options: { enabled: boolean; accountId?: string; deviceScopeId?: string }) => {
        h.native.journal = options.enabled && options.accountId && options.deviceScopeId ? { accountId: options.accountId, deviceScopeId: options.deviceScopeId } : null
        return { ...journalDiagnostics(), enabled: options.enabled }
      }),
      connect: vi.fn(async ({ deviceId }: { deviceId: string }) => {
        record('connect')
        h.native.state = 'READY'
        h.native.deviceId = deviceId
        return { deviceId, state: 'INITIALIZING' }
      }),
      getDeviceInfo: vi.fn(async () => ({ deviceId: MAC, macAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' })),
      disconnect: vi.fn(async () => { record('disconnect'); h.native.state = 'DISCONNECTED' }),
      getSourceJournalDiagnostics: vi.fn(async () => {
        if (h.journalDiagnostics) return h.journalDiagnostics()
        if (!h.native.journal) throw Object.assign(new Error('Source journal scope is not configured.'), { code: 'SCOPE_NOT_CONFIGURED' })
        return journalDiagnostics()
      }),
      startWorkoutCapture: vi.fn(),
      stopWorkoutCapture: vi.fn(),
      beginPhysicalSemanticTest: vi.fn(),
      readPhysicalSemanticTestEvidence: vi.fn(async () => ({ json: null })),
      syncActivityCertification: vi.fn(),
      syncWorkoutHistoryCertification: vi.fn(),
      // Type27 historical heart-rate acquisition: must never run without an explicit default-sync click.
      syncHistoricalHeartRate: vi.fn(async () => { record('Type27:syncHistoricalHeartRate'); return historical('27', 'arrayDynamicHR') }),
      ackHistoricalHrChunk: vi.fn(async () => {}),
      syncHistoricalSpo2: vi.fn(async () => { record('Type68:syncHistoricalSpo2'); return h.spo2 ? h.spo2() : historical('68', 'Oxygen_data') }),
      syncHistoricalTemperature: vi.fn(async () => {
        record('Type59:syncHistoricalTemperature')
        return h.temperature ? h.temperature() : historical('59', 'GetTemperature_historyData')
      }),
    },
  }
})

vi.mock('./ProductionV8Sync', async (importOriginal) => ({
  ...await importOriginal<typeof import('./ProductionV8Sync')>(),
  loadProductionSyncReceipt: vi.fn(async () => h.storedReceipt),
  storeProductionSyncReceipt: vi.fn(async () => {}),
}))
vi.mock('../../services/sync/ObservationQueue', () => ({
  observationQueue: {
    getOwnerUserId: () => 'athlete-A',
    getQueueStats: vi.fn(async () => ({ ...h.queueStats })),
    getPendingComposition: vi.fn(async () => ({
      totalPending: h.queueStats.pending, byMetric: [], byVendorDataType: [], bySyncId: [], byAcquisitionId: [], byRequestedMetric: [],
      oldestPendingAt: null, newestPendingAt: null, oldestObservedAt: null, newestObservedAt: null,
      attemptCount: { zero: 0, one: 0, two: 0, threePlus: 0 }, distinctObservationIds: h.queueStats.pending,
      duplicateObservationIdRows: 0, currentV49SyncId: null, currentV49SyncPending: null, currentV49MetricPending: null,
      currentV49FirstPosition: null, currentV49LastPosition: null, currentV49RowsAhead: null,
      heartRateRowsAheadCurrentV49: null, priorSyncPending: null,
    })),
    enqueueMany: vi.fn(async () => []),
    getRecord: vi.fn(async () => null),
    listDiagnosticRecords: vi.fn(async () => []),
  },
}))
vi.mock('../../services/sync/ObservationBatchManager', () => ({
  observationBatchManager: {
    process: vi.fn(async () => null),
    resumeAfterPhysicalTest: vi.fn(),
    getPhysicalTestSenderState: () => ({
      activeRequest: h.senderActive, claimOwner: h.senderActive ? 'sender' : null,
      activeWorkers: h.senderActive ? 1 : 0, startupOperations: 0,
      lastBatchId: null, lastSenderError: null, lastInflightCompletedAt: null,
    }),
    subscribe: vi.fn(() => () => {}),
    getDeliveryDiagnostics: vi.fn(() => ({ senderActive: h.senderActive, activeWorkerCount: h.senderActive ? 1 : 0, pauseReason: null, activeBatches: [], senderGeneration: 0 })),
  },
}))
vi.mock('./WorkoutHrDelivery', () => ({
  WorkoutHrDeliveryService: class { start() {} dispose() {} setContext() {} handleHeartRate() {} async handleWorkoutEnded() {} },
}))

import { JCVitalV8, type JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import { JCVitalV8Panel } from './ElitePlusV8Panel'
import { JCVitalV8Panel as EngineeringV8Panel } from './PipelineDiagnosticV8Panel'
import { ProductionV8Sync, type ProductionSyncInput } from './ProductionV8Sync'
import { V8BootstrapProvider } from './V8PluginBootstrap'
import { LocalDigitalWellness } from '../../wellness/health/digitalWellnessLocal'
import { emptyProductionState } from '../../wellness/health/digitalWellnessProduction'
import { DigitalBalance } from '../../wellness/DigitalBalance'
import * as activityCanonicalization from './ActivityCanonicalization'
import * as activityDelivery from './ActivityNativeTransportV2Delivery'
import { activityV2FixtureSource } from './ActivityNativeTransportV2Fixtures'
import { activityV2CapabilityStore } from '../../services/base44/ActivityV2Capability'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { installationIdentityService } from '../../services/storage/InstallationIdentityService'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'

let root: Root | null = null
let container: HTMLDivElement
let runSpy: MockInstance<ProductionV8Sync['run']>
const onSync = vi.fn()

const owners = () => ({ authenticatedOwnerUserId: 'athlete-A', persistedConnectorOwnerUserId: 'athlete-A', connectorDeviceId: 'connector-A' })
const settle = async (rounds = 5) => { for (let i = 0; i < rounds; i++) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) }) }
const button = (label: string) => Array.from(container.querySelectorAll<HTMLButtonElement>('button')).find((item) => item.textContent === label)
const syncButton = () => container.querySelector<HTMLButtonElement>('.elite-v8-sync-card button.elite-v8-button:not(.secondary)')!
const subsetButton = () => button('Test SpO₂ + Temperature')!
const syncLabel = () => container.querySelector('#elite-v8-sync-title')?.textContent
const type27Commands = () => h.calls.filter((call) => call.startsWith('Type27')).length
const acquisitionCommands = () => h.calls.filter((call) => /^Type\d+:/.test(call))
const runInputs = () => runSpy.mock.calls.map(([input]) => input as ProductionSyncInput)
const emit = (event: string, payload: unknown) => { for (const listener of h.listeners.get(event) ?? []) listener(payload) }

async function mount(screen = 'Companion', owner = 'athlete-A', connectorOwner: string | null = owner, wellness?: LocalDigitalWellness, panelOwner = owner): Promise<void> {
  const Panel = screen === 'Engineering' ? EngineeringV8Panel : JCVitalV8Panel
  await act(async () => {
    root!.render(
      <V8BootstrapProvider authenticated ownerUserId={owner}>
        {wellness && <DigitalBalance wellness={wellness} />}
        <Panel key={screen} ownerUserId={panelOwner} onSync={onSync} syncBusy={false} syncError="" syncEnabled
          appVersion="1.0.0-rc6.1-manual-sync" appVersionCode={48}
          getSyncOwners={() => ({ ...owners(), authenticatedOwnerUserId: owner, persistedConnectorOwnerUserId: connectorOwner })} />
      </V8BootstrapProvider>,
    )
  })
  await settle()
}

async function connect(): Promise<void> {
  const connectButton = container.querySelector<HTMLButtonElement>(`[data-device-id="${MAC}"] button`)
  expect(connectButton?.disabled).toBe(false)
  await act(async () => { connectButton!.click() })
  await act(async () => { emit('jcvitalConnectionState', { state: 'READY', deviceId: MAC, timestamp: '2026-10-15T12:00:00.000Z' }) })
  await settle()
}

async function expectNoAutomaticSync(): Promise<void> {
  await settle(10)
  expect(runSpy).toHaveBeenCalledTimes(0)
  expect(JCVitalV8.syncHistoricalHeartRate).toHaveBeenCalledTimes(0)
  expect(type27Commands()).toBe(0)
  expect(acquisitionCommands()).toEqual([])
  expect(onSync).not.toHaveBeenCalled()
}

function expectIdleEnabled(): void {
  expect(syncButton().textContent).toBe('Sync Device Data')
  expect(syncButton().disabled).toBe(false)
  expect(subsetButton().disabled).toBe(false)
}

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  h.native.state = 'DISCONNECTED'
  h.native.deviceId = null
  h.native.journal = null
  h.listeners.clear()
  h.calls.length = 0
  h.spo2 = null
  h.temperature = null
  h.journalDiagnostics = null
  h.storedReceipt = null
  h.senderActive = false
  h.queueStats = { pending: 0, retrying: 0, failed: 0, inFlight: 0, acknowledged: 0, warnings: [] }
  vi.mocked(JCVitalV8.syncHistoricalHeartRate).mockClear()
  vi.mocked(JCVitalV8.syncHistoricalSpo2).mockClear()
  vi.mocked(JCVitalV8.syncHistoricalTemperature).mockClear()
  onSync.mockClear()
  runSpy = vi.spyOn(ProductionV8Sync.prototype, 'run')
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  container.remove()
  runSpy.mockRestore()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('v47.1 manual-only production sync', () => {
  it.each([false, true])('routes explicit Activity sync through the existing queue only with capability = %s', async (supported) => {
    const sources = [activityV2FixtureSource('24'), activityV2FixtureSource('25')]
    const canonicalize = vi.spyOn(activityCanonicalization, 'canonicalizeAcquiredActivity').mockResolvedValue([])
    vi.spyOn(activityDelivery, 'activityV2SourcesFromNative').mockReturnValue(sources)
    const enqueue = vi.spyOn(activityDelivery, 'enqueueActivityNativeTransportV2').mockResolvedValue({
      sourceRecordCount: 2, payloadCount: 14, insertedCount: 14, duplicateCount: 0, payloads: [], results: [],
    })
    vi.mocked(JCVitalV8.syncActivityCertification).mockResolvedValue({
      acquisitionSessionId: 'activity-session',
      results: [historical('24', 'GetTotalActivityDataWithMode'), historical('25', 'GetDetailActivityDataWithMode')],
    })
    vi.mocked(observationBatchManager.process).mockClear()
    connectorIdentityService.setConnectorDeviceId('connector-A')
    const scope = {
      ownerUserId: 'athlete-A', installId: installationIdentityService.getInstallId(), connectorDeviceId: 'connector-A',
    }
    activityV2CapabilityStore.recordRegistrationResponse({
      success: true, installId: scope.installId, connectorDeviceId: scope.connectorDeviceId,
      status: 'active',
      registeredAt: '2026-10-21T00:00:00.000Z',
      serverTimestamp: '2026-10-21T00:00:00.000Z',
      sources: [],
      responseContractVersion: 'native-observations-results-v1',
      capabilities: supported ? { JCVITAL_ACTIVITY_TRANSPORT_V2: 'jcvital.native.activity.transport.v2' } : {},
    }, scope, true)
    await mount()
    await connect()
    await act(async () => { button('Sync Activity')!.click() })
    await settle()
    expect(canonicalize).toHaveBeenCalledTimes(1)
    if (supported) {
      expect(enqueue).toHaveBeenCalledWith(sources, expect.objectContaining({
        ownerUserId: 'athlete-A', deviceId: h.native.journal!.deviceScopeId,
      }), observationQueue, true)
      expect(observationBatchManager.process).toHaveBeenCalledTimes(1)
    } else {
      expect(enqueue).not.toHaveBeenCalled()
      expect(observationBatchManager.process).not.toHaveBeenCalled()
      expect(container.textContent).toContain('legacy NATIVE_ONLY')
    }
    expect(JCVitalV8.startWorkoutCapture).not.toHaveBeenCalled()
    expect(JCVitalV8.syncWorkoutHistoryCertification).not.toHaveBeenCalled()
  })

  const physicalRun = (title: string) => container.querySelector<HTMLButtonElement>(`section[aria-label="${title}"] button`)!
  const expectActivityEnabledAndWorkoutAwaitingExport = async () => {
    const eligibility = container.querySelector('[aria-label="Physical Semantic Test Eligibility"]')!
    expect(eligibility).not.toBeNull()
    expect(physicalRun('Test Activity 24 + 25').disabled).toBe(false)
    expect(physicalRun('Test Workout 29 + 82').disabled).toBe(true)
    expect(Array.from(eligibility.querySelectorAll('[role="status"]')).map((status) => status.textContent)).toEqual([
      'Activity test: ENABLED',
      'Workout test: BLOCKED — SAVED_ACTIVITY_FINALIZATION_AND_EXPORT_REQUIRED',
    ])
    const beginCalls = vi.mocked(JCVitalV8.beginPhysicalSemanticTest).mock.calls.length
    const startCalls = vi.mocked(JCVitalV8.startWorkoutCapture).mock.calls.length
    const historyCalls = vi.mocked(JCVitalV8.syncWorkoutHistoryCertification).mock.calls.length
    await act(async () => {
      const workout = physicalRun('Test Workout 29 + 82')
      workout.click()
      workout.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(JCVitalV8.beginPhysicalSemanticTest).toHaveBeenCalledTimes(beginCalls)
    expect(JCVitalV8.startWorkoutCapture).toHaveBeenCalledTimes(startCalls)
    expect(JCVitalV8.syncWorkoutHistoryCertification).toHaveBeenCalledTimes(historyCalls)
  }

  it('mounts the actual Engineering panel and keeps the normal connection journal when switching screens', async () => {
    await mount()
    await connect()
    const boundScope = h.native.journal
    await expectActivityEnabledAndWorkoutAwaitingExport()
    const calls = vi.mocked(JCVitalV8.configureSourceJournal).mock.calls.length
    await mount('Engineering')
    await expectActivityEnabledAndWorkoutAwaitingExport()
    expect(h.native.journal).toBe(boundScope)
    expect(vi.mocked(JCVitalV8.configureSourceJournal).mock.calls.length).toBe(calls)
    await mount('Companion')
    await expectActivityEnabledAndWorkoutAwaitingExport()
    expect(h.native.journal).toBe(boundScope)
    expect(JCVitalV8.beginPhysicalSemanticTest).not.toHaveBeenCalled()
    expect(JCVitalV8.syncActivityCertification).not.toHaveBeenCalled()
    expect(JCVitalV8.syncWorkoutHistoryCertification).not.toHaveBeenCalled()
    expect(JCVitalV8.startWorkoutCapture).not.toHaveBeenCalled()
    await expectNoAutomaticSync()
  })

  it('retains an exportable failed attempt across actual Companion → Engineering remount without another invocation', async () => {
    const begin = vi.mocked(JCVitalV8.beginPhysicalSemanticTest)
    begin.mockRejectedValueOnce(Object.assign(new Error('Native physical session rejected'), { code: 'COMMAND_FAILED' }))
    await mount()
    await connect()
    const run = physicalRun('Test Activity 24 + 25')
    await act(async () => run.click())
    await settle()
    const expectFailedControls = () => {
      const section = container.querySelector('[aria-label="Test Activity 24 + 25"]')!
      const controls = Array.from(section.querySelectorAll('button'))
      expect(controls[0].disabled).toBe(true)
      expect(controls.slice(1).every((button) => !button.disabled)).toBe(true)
      expect(section.textContent).toContain('FAILED')
      expect(section.textContent).toContain('Native physical session rejected')
    }
    expectFailedControls()
    const invocations = begin.mock.calls.length
    await mount('Engineering')
    expectFailedControls()
    expect(begin.mock.calls.length).toBe(invocations)
    expect(JCVitalV8.syncActivityCertification).not.toHaveBeenCalled()
    await expectNoAutomaticSync()
    begin.mockReset()
  })

  it('keeps Activity available but retains the Workout finalization/export gate while background queue sending', async () => {
    h.senderActive = true
    h.queueStats = { pending: 3_000, retrying: 100, failed: 0, inFlight: 100, acknowledged: 0, warnings: [] }
    await mount()
    await connect()
    await expectActivityEnabledAndWorkoutAwaitingExport()
    await expectNoAutomaticSync()
  })

  it('keeps Activity available but retains the Workout finalization/export gate while Digital Wellness is COLLECTING', async () => {
    const state = { ...emptyProductionState('athlete-A'), consent: true, enabled_at: '2026-10-19T10:00:00Z' }
    const pending = deferred<typeof state>()
    const wellness = new LocalDigitalWellness({
      getPlatformInfo: async () => ({ platform: 'ANDROID', androidVersion: '15' }),
      isUsageAccessAvailable: async () => ({ available: true }),
      hasUsageAccess: async () => ({ granted: true, diagnostics: { appops_result: 0 } }),
      openUsageAccessSettings: async () => {},
      queryDigitalWellnessEvents: async () => { throw new Error('Unexpected raw query') },
    }, { getItem: () => null, setItem: () => {} }, true, undefined, undefined, {
      getProductionState: async () => state,
      setProductionConsent: async () => state,
      closeProductionScope: async () => state,
      refreshProduction: async () => pending.promise,
    })
    await wellness.initializeProduction()
    await mount('Engineering', 'athlete-A', 'athlete-A', wellness)
    await connect()
    let refresh!: ReturnType<LocalDigitalWellness['refresh']>
    await act(async () => { refresh = wellness.refresh() })
    try {
      expect(wellness.getSnapshot().state).toBe('COLLECTING')
      const wellnessPanel = container.querySelector('[aria-label="Digital Wellness"]')!
      expect(Array.from(wellnessPanel.querySelectorAll('button')).find((item) => item.textContent?.includes('Refresh'))?.disabled).toBe(true)
      await expectActivityEnabledAndWorkoutAwaitingExport()
      await expectNoAutomaticSync()
    } finally {
      await act(async () => { pending.resolve(state); await refresh })
    }
  })

  it('shows SOURCE_JOURNAL_NOT_BOUND at READY without a bound journal', async () => {
    h.native.state = 'READY'
    h.native.deviceId = MAC
    await mount('Engineering')
    expect(physicalRun('Test Activity 24 + 25').disabled).toBe(true)
    expect(container.textContent).toContain('SOURCE_JOURNAL_NOT_BOUND')
  })

  it('fails closed for a real connector-owner mismatch and retires binding on authenticated owner change', async () => {
    await mount()
    await connect()
    await mount('Engineering', 'athlete-A', 'athlete-B')
    expect(physicalRun('Test Activity 24 + 25').disabled).toBe(true)
    expect(container.textContent).toContain('BLOCKED — OWNER_SCOPE_MISMATCH')
    await mount('Engineering', 'athlete-B')
    expect(h.native.journal).toBeNull()
    expect(physicalRun('Test Activity 24 + 25').disabled).toBe(true)
    expect(container.textContent).toContain('SOURCE_JOURNAL_NOT_BOUND')
  })

  it('rejects an arbitrary screen-supplied owner at the authenticated connection boundary', async () => {
    await mount('Engineering', 'athlete-A', 'athlete-A', undefined, 'screen-supplied-owner')
    const connectButton = container.querySelector<HTMLButtonElement>(`[data-device-id="${MAC}"] button`)!
    await act(async () => connectButton.click())
    await settle()
    expect(h.calls).not.toContain('connect')
    expect(h.native.journal).toBeNull()
    expect(physicalRun('Test Activity 24 + 25').disabled).toBe(true)
    expect(container.textContent).toContain('OWNER_SCOPE_MISMATCH')
  })
  it('mount → connect → READY → wait starts zero ProductionV8Sync runs and zero Type27 commands', async () => {
    await mount()
    await expectNoAutomaticSync()
    await connect()
    expect(h.calls).toEqual(['connect'])
    await expectNoAutomaticSync()
    expectIdleEnabled()
  })

  it('READY transitions, reconnect, foreground and network events never start a sync', async () => {
    await mount()
    await connect()
    for (const state of ['READY', 'INITIALIZING', 'READY']) {
      await act(async () => { emit('jcvitalConnectionState', { state, deviceId: MAC, timestamp: '2026-10-15T12:01:00.000Z' }) })
    }
    await act(async () => { emit('jcvitalConnectionState', { state: 'DISCONNECTED', deviceId: MAC, timestamp: '2026-10-15T12:02:00.000Z' }) })
    h.native.state = 'DISCONNECTED'
    await settle()
    expect(syncButton().disabled).toBe(true)
    await connect()
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
      document.dispatchEvent(new Event('visibilitychange'))
      window.dispatchEvent(new Event('focus'))
      window.dispatchEvent(new Event('online'))
      window.dispatchEvent(new Event('pageshow'))
    })
    await expectNoAutomaticSync()
    expectIdleEnabled()
  })

  it('a hydrated IN_PROGRESS receipt neither starts a sync nor disables the controls', async () => {
    const source = (metric: string) => ({ metric, status: 'BRIDGE_INVOKED', sourceRecordCount: 0, observationCount: 0, deliveredCount: 0, ackedCount: 0, failedCount: 0 })
    // A prior run interrupted by an app kill: persisted mid-flight, never completed.
    h.storedReceipt = {
      schema: 'elitePlus.v8ProductionSyncReceipt.v1', syncId: 'stale', outcome: null, overallState: null,
      requestedMetrics: ['oxygenSaturation', 'wearableTemperature'], startedAt: '2026-10-15T11:00:00.000Z', completedAt: null,
      sources: [source('oxygenSaturation'), source('wearableTemperature')], errors: [],
      queue: { depthAfterSave: null, depthAfterDelivery: null }, delivery: { lastServerResult: null },
      totals: { new: 0 },
    }
    await mount()
    await connect()
    expect(container.textContent).toContain('Overall: In progress')
    await expectNoAutomaticSync()
    expectIdleEnabled()
  })

  it('background queue delivery (rows IN_FLIGHT) is not a sync: no run starts and both controls stay enabled', async () => {
    h.queueStats = { pending: 3_000, retrying: 0, failed: 0, inFlight: 100, acknowledged: 0, warnings: [] }
    await mount()
    await connect()
    await expectNoAutomaticSync()
    expect(syncLabel()).toBe('Sending saved data…')
    expectIdleEnabled()
  })

  it('stays disabled at native READY until this session binds the source journal', async () => {
    h.native.state = 'READY'
    h.native.deviceId = MAC
    await mount()
    expect(syncButton().disabled).toBe(true)
    expect(subsetButton().disabled).toBe(true)
    await act(async () => { button('Disconnect')!.click() })
    await act(async () => { emit('jcvitalConnectionState', { state: 'DISCONNECTED', deviceId: MAC, timestamp: '2026-10-15T12:02:00.000Z' }) })
    await settle()
    await connect()
    await expectNoAutomaticSync()
    expectIdleEnabled()
  })

  it('only the Sync Device Data click starts the default HR + SpO₂ + Temperature sync', async () => {
    await mount()
    await connect()
    await expectNoAutomaticSync()
    await act(async () => { syncButton().click() })
    await settle(10)
    expect(runSpy).toHaveBeenCalledTimes(1)
    expect(runInputs()[0].metrics).toBeUndefined()
    expect(acquisitionCommands()).toEqual(['Type27:syncHistoricalHeartRate', 'Type68:syncHistoricalSpo2', 'Type59:syncHistoricalTemperature'])
    expect(onSync).not.toHaveBeenCalled()
    expectIdleEnabled()
  })

  it('only the engineering click starts the SpO₂ + Temperature subset, exactly once, with zero Type27', async () => {
    await mount()
    await connect()
    await expectNoAutomaticSync()
    const spo2 = deferred<unknown>()
    h.spo2 = () => spo2.promise
    await act(async () => { subsetButton().click() })
    await settle()
    expect(runSpy).toHaveBeenCalledTimes(1)
    expect(runInputs()[0].metrics).toEqual(['oxygenSaturation', 'wearableTemperature'])
    expect(syncButton().textContent).toBe('Syncing…')
    expect(syncButton().disabled).toBe(true)
    expect(subsetButton().disabled).toBe(true)

    // Concurrent attempts while the run executes are refused at the UI and the ProductionV8Sync mutex.
    await act(async () => { subsetButton().click(); syncButton().click() })
    await act(async () => { subsetButton().dispatchEvent(new MouseEvent('click', { bubbles: true })) })
    expect(runSpy).toHaveBeenCalledTimes(1)

    await act(async () => { spo2.resolve(historical('68', 'Oxygen_data')) })
    await settle(10)
    const receipt = await runSpy.mock.results[0].value
    expect(receipt.requestedMetrics).toEqual(['oxygenSaturation', 'wearableTemperature'])
    expect(receipt.isolation.nativeCommandsIssued).toEqual(['Oxygen_data', 'GetTemperature_historyData'])
    expect(receipt.sources.map((source: { status: string }) => source.status)).toEqual(['NOT_REQUESTED', 'NO_DATA', 'NO_DATA'])
    expect(type27Commands()).toBe(0)
    expect(JCVitalV8.syncHistoricalHeartRate).toHaveBeenCalledTimes(0)
    expect(acquisitionCommands()).toEqual(['Type68:syncHistoricalSpo2', 'Type59:syncHistoricalTemperature'])
    expect(runSpy).toHaveBeenCalledTimes(1)
    expectIdleEnabled()
  })

  it.each([
    ['NO_DATA', () => {}, 'UP_TO_DATE'],
    ['metric failure', () => { h.spo2 = async () => { throw Object.assign(new Error('SpO2 read failed'), { code: 'SPO2_FAILED' }) } }, 'PARTIAL'],
    ['all metrics failed', () => {
      h.spo2 = async () => { throw new Error('SpO2 read failed') }
      h.temperature = async () => { throw new Error('Temperature read failed') }
    }, 'FAILED'],
    ['hard failure (journal closed)', () => { h.journalDiagnostics = async () => { throw Object.assign(new Error('JOURNAL_FAILED_CLOSED'), { code: 'JOURNAL_FAILED_CLOSED' }) } }, 'BLOCKED'],
    ['disconnect mid-sync', () => { h.spo2 = async () => { h.native.state = 'DISCONNECTED'; return historical('68', 'Oxygen_data') } }, 'PARTIAL'],
  ])('clears the active-sync flag after %s', async (_name, arrange, outcome) => {
    await mount()
    await connect()
    arrange()
    await act(async () => { subsetButton().click() })
    await settle(10)
    expect(runSpy).toHaveBeenCalledTimes(1)
    expect((await runSpy.mock.results[0].value).outcome).toBe(outcome)
    expect(type27Commands()).toBe(0)
    expect(syncButton().textContent).toBe('Sync Device Data')
    if (h.native.state === 'READY') {
      expectIdleEnabled()
      await act(async () => { subsetButton().click() })
      await settle(10)
      expect(runSpy).toHaveBeenCalledTimes(2)
    }
  })

  it('clears the active-sync flag when run() rejects (cancellation / unexpected error)', async () => {
    await mount()
    await connect()
    runSpy.mockRejectedValueOnce(new Error('cancelled'))
    await act(async () => { syncButton().click() })
    await settle()
    expect(runSpy).toHaveBeenCalledTimes(1)
    expectIdleEnabled()
    expect(type27Commands()).toBe(0)
  })
})

describe('v47.1 static wiring guard', () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

  it('reaches ProductionV8Sync.run only through click-bound handler references', () => {
    const panel = read('./ElitePlusV8Panel.tsx')
    expect(panel.match(/productionSync\.run\(/g)).toHaveLength(1)
    expect([...panel.matchAll(/runProductionSync\(/g)]).toHaveLength(3)
    expect(panel).toContain('async function runProductionSync(')
    expect(panel).toContain('onSync={getSyncOwners ? () => void runProductionSync() : onSync}')
    expect(panel).toContain("onTestSpo2Temperature={() => void runProductionSync(['oxygenSaturation', 'wearableTemperature'])}")
    for (const effect of panel.split('useEffect(').slice(1)) {
      const end = effect.indexOf('\n  }, [')
      expect(end).toBeGreaterThan(0)
      const body = effect.slice(0, end)
      expect(body).not.toMatch(/\brunProductionSync\b|\bproductionSync\.run\b|\bonSync\b|\bonTestSpo2Temperature\b/)
    }
    const dashboard = read('./ElitePlusV8Dashboard.tsx')
    expect(dashboard).not.toMatch(/useEffect|useLayoutEffect/)
    expect(dashboard.match(/onSync\b/g)?.length).toBe(3)
    expect(dashboard).toContain('onClick={onSync} disabled={!canStartSync}')
    expect(dashboard).toContain('onClick={onTestSpo2Temperature} disabled={!canStartSync}')
    expect(dashboard).not.toMatch(/onSync\(\)|onTestSpo2Temperature\(\)|onSync=\{[^}]*\(\)\}/)
    const app = read('../../App.tsx')
    expect(app).not.toMatch(/onSync=\{syncNow\(\)\}|onSync=\{runProductionSync\(\)\}/)
  })
})
