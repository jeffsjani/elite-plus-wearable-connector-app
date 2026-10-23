import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  classifyConnectionSegment, CONNECTION_DIAGNOSTIC_SCHEMA, createDomPanelDriver, mergeEvents, REFERENCE_V8, runConnectionDiagnostic,
  serializeConnectionDiagnostic, type ConnectionDiagnosticBridge, type ConnectionDiagnosticEnvironment, type NativeConnectionDiagnosticSnapshot,
  type NativeScanCandidate, type NativeTraceEvent, type ProductionPanelDriver, type ProductionPanelProbe,
} from './ConnectionDiagnostic'

interface Advert { address: string; name: string | null; rssi?: number; services?: string[]; v8Candidate?: boolean }
interface WorldOptions {
  pluginReachable?: boolean
  bluetoothEnabled?: boolean
  adapterSupported?: boolean
  scanGranted?: boolean
  connectGranted?: boolean
  sdkInt?: number
  fineLocationGranted?: boolean
  productionPanelMounted?: boolean
  productionScanWired?: boolean
  scanStartFails?: boolean
  adverts?: Advert[]
  listenerRegistered?: boolean
  uiUpdates?: boolean
  connectOutcome?: 'READY' | 'CONNECT_FAILED' | 'GATT_FAILED' | 'READY_TIMEOUT'
}

const JCVITAL_SERVICE = '0000fff0-0000-1000-8000-00805f9b34fb'
const V8: Advert = { address: 'E7:1B:D8:36:78:CF', name: 'JCV8B', rssi: -52, v8Candidate: true }
const OTHER: Advert = { address: '11:22:33:44:55:66', name: 'Living Room TV', rssi: -70 }

/** Simulates the native trace plus the rendered production panel, driven only through the public diagnostic seams. */
function world(options: WorldOptions = {}) {
  const o = { pluginReachable: true, bluetoothEnabled: true, adapterSupported: true, scanGranted: true, connectGranted: true, sdkInt: 34,
    fineLocationGranted: false, productionPanelMounted: true, productionScanWired: true, scanStartFails: false, adverts: [V8, OTHER],
    listenerRegistered: true, uiUpdates: true, connectOutcome: 'READY' as const, ...options }
  let now = Date.parse('2026-05-01T10:00:00.000Z')
  let sequence = 0
  const events: NativeTraceEvent[] = []
  const candidates = new Map<string, NativeScanCandidate>()
  const calls: string[] = []
  let scanRequestedCount = 0
  let scanSession = 0
  let scanStartedAt: string | null = null
  let scanActive = false
  let advertisementsReceived = 0
  let connectionState = 'DISCONNECTED'
  let domDevices = 0
  const iso = () => new Date(now).toISOString()
  const record = (event: string, detail: Record<string, unknown> = {}) => { now++; events.push({ sequence: ++sequence, at: iso(), event, detail }) }
  record('PLUGIN_INITIALIZED')
  const permitted = (granted: boolean, required: boolean, name: string) => ({ name, requiredOnThisSdk: required, declaredInManifest: true, granted })
  const modern = o.sdkInt >= 31
  const snapshot = (): NativeConnectionDiagnosticSnapshot => ({
    android: {
      sdkInt: o.sdkInt, manufacturer: 'Test', model: 'Phone', bluetoothLeFeature: o.adapterSupported, adapterSupported: o.adapterSupported,
      bluetoothEnabled: o.bluetoothEnabled, adapterState: o.bluetoothEnabled ? 'ON' : 'OFF', leScannerAvailable: o.bluetoothEnabled,
      locationServicesEnabled: true,
      inspectionErrors: [],
      permissions: {
        BLUETOOTH_SCAN: permitted(o.scanGranted, modern, 'android.permission.BLUETOOTH_SCAN'),
        BLUETOOTH_CONNECT: permitted(o.connectGranted, modern, 'android.permission.BLUETOOTH_CONNECT'),
        ACCESS_FINE_LOCATION: permitted(o.fineLocationGranted, !modern, 'android.permission.ACCESS_FINE_LOCATION'),
        BLUETOOTH: permitted(true, !modern, 'android.permission.BLUETOOTH'),
        BLUETOOTH_ADMIN: permitted(true, !modern, 'android.permission.BLUETOOTH_ADMIN'),
      },
    },
    capacitorPermissionAlias: 'bluetoothNearby',
    capacitorAliasState: o.scanGranted && o.connectGranted ? 'granted' : 'denied',
    normalizedPermissionStatus: !o.bluetoothEnabled ? 'BLUETOOTH_DISABLED' : o.scanGranted && o.connectGranted ? 'AUTHORIZED' : 'DENIED',
    connectionState,
    connectedDeviceId: connectionState === 'READY' ? V8.address : null,
    jsListeners: { jcvitalScanResult: o.listenerRegistered, jcvitalConnectionState: o.listenerRegistered, jcvitalError: o.listenerRegistered },
    registryDevices: [...candidates.values()].filter((candidate) => candidate.acceptedByNativeFilter).length,
    trace: {
      enabled: true, pluginLoadedAt: '2026-05-01T09:59:00.000Z', scanRequestedCount, scanSession, scanStartedAt, scanActive, scanCallbackRegistered: scanActive, advertisementsReceived,
      lateAdvertisementsIgnored: 0, droppedEvents: 0, droppedCandidates: 0, candidates: [...candidates.values()].map((candidate) => ({ ...candidate })), events: [...events],
    },
  })
  const nativeStartScan = async () => {
    record('SCAN_REQUESTED', { timeoutMs: 30000 })
    scanRequestedCount++
    if (!o.bluetoothEnabled || !o.scanGranted) throw Object.assign(new Error('Bluetooth unusable'), { code: 'PERMISSION_DENIED' })
    if (o.scanStartFails) { record('SCAN_START_FAILED', { code: 'SCAN_FAILED_2', message: 'registration failed' }); throw new Error('SCAN_FAILED') }
    scanSession++
    scanStartedAt = iso()
    scanActive = true
    record('SCAN_STARTED', { scanSession })
    for (const advert of o.adverts) {
      advertisementsReceived++
      if (advertisementsReceived === 1) record('ADVERTISEMENT_RECEIVED')
      const service = advert.services?.includes(JCVITAL_SERVICE) ?? false
      const v8Candidate = service || advert.v8Candidate === true
      const accepted = v8Candidate
      candidates.set(advert.address, {
        address: advert.address, name: advert.name, rssi: advert.rssi ?? -60, serviceUuids: advert.services ?? [], advertisesJcvitalService: service,
        connectable: true, firstSeenAt: iso(), lastSeenAt: iso(), scanSession, advertisementCount: 1, v8Candidate, acceptedByNativeFilter: accepted,
        rejectionReason: accepted ? null : 'NOT_ELITE_PLUS_V8_ADVERTISEMENT', emittedToJs: accepted ? 1 : 0, emittedWithJsListener: accepted && o.listenerRegistered ? 1 : 0,
      })
      if (v8Candidate) {
        record('V8_CANDIDATE_MATCHED', { address: advert.address })
        if (!accepted) record('V8_FILTERED', { address: advert.address, reason: 'NOT_ELITE_PLUS_V8_ADVERTISEMENT' })
      }
      if (accepted) {
        record('SCAN_RESULT_EMITTED_TO_JS', { address: advert.address, jsListenerRegistered: o.listenerRegistered })
        if (o.uiUpdates && o.listenerRegistered && v8Candidate) domDevices++
      }
    }
  }
  const nativeConnect = () => {
    record('CONNECT_REQUESTED', { deviceId: V8.address })
    scanActive = false
    record('SCAN_STOPPED', { reason: 'CONNECT' })
    if (o.connectOutcome === 'CONNECT_FAILED') { record('CONNECT_FAILED', { code: 'CONNECTION_FAILED', message: 'device not found' }); return }
    record('GATT_CONNECT_REQUESTED')
    if (o.connectOutcome === 'GATT_FAILED') { record('GATT_FAILED', { status: 133 }); record('CONNECTION_FAILURE', { code: 'CONNECTION_FAILED', message: 'GATT 133' }); return }
    record('GATT_CONNECTED'); record('SERVICES_DISCOVERED', { jcvitalServicePresent: true })
    if (o.connectOutcome === 'READY_TIMEOUT') return
    record('NOTIFICATIONS_ENABLED'); record('DEVICE_VERSION_REQUESTED'); record('READY', { firmwareVersion: '0.0.8.8' })
    connectionState = 'READY'
    domDevices = 0
  }
  const bridgeImpl: ConnectionDiagnosticBridge = {
    async getConnectionDiagnosticSnapshot() {
      if (!o.pluginReachable) throw Object.assign(new Error('"JCVitalV8" plugin is not implemented on android'), { code: 'UNIMPLEMENTED' })
      return snapshot()
    },
    async isAvailable() { return { available: o.adapterSupported, enabled: o.bluetoothEnabled } },
    async getPermissionStatus() { return { status: snapshot().normalizedPermissionStatus as 'AUTHORIZED', bluetoothEnabled: o.bluetoothEnabled, permissions: [] } },
    async requestPermissions() { record('PERMISSION_REQUEST_INVOKED'); return this.getPermissionStatus() },
    startScan: nativeStartScan,
    async stopScan() { if (scanActive) { scanActive = false; record('SCAN_STOPPED', { reason: 'STOP_REQUESTED' }) } },
    async getConnectionState() { return { state: connectionState as 'READY', deviceId: null } },
  }
  // Any method outside the diagnostic seam (history, sync, journal, workouts) would be recorded and fail the guard tests.
  const bridge = new Proxy(bridgeImpl, {
    get(target, property: string) {
      const value = target[property as keyof ConnectionDiagnosticBridge]
      if (typeof value !== 'function') { calls.push(`unexpected:${property}`); return value }
      return (...args: unknown[]) => { calls.push(property); return (value as (...a: unknown[]) => unknown).apply(target, args) }
    },
  })
  const probe = (): ProductionPanelProbe => ({
    mounted: o.productionPanelMounted,
    statusTitle: o.productionPanelMounted ? 'Not connected' : null,
    statusMessage: null,
    scanActionLabel: o.productionPanelMounted && connectionState !== 'READY' ? 'Connect your Elite+ V8' : null,
    permissionActionPresent: false,
    deviceListCount: domDevices,
    connectActionCount: domDevices,
    renderedDeviceIds: domDevices > 0 ? [V8.address] : [],
  })
  const panel: ProductionPanelDriver = {
    probe,
    clickScanAction: () => {
      if (!probe().scanActionLabel) return false
      if (o.productionScanWired) void nativeStartScan().catch(() => undefined)
      return true
    },
    clickPermissionAction: () => false,
    clickConnectAction: (deviceId) => { if (!probe().renderedDeviceIds.includes(deviceId)) return false; nativeConnect(); return true },
  }
  const startDiscovery = vi.fn(async () => { calls.push('startDiscovery'); await nativeStartScan() })
  const env: ConnectionDiagnosticEnvironment = {
    bridge, panel, now: () => ++now, sleep: async (ms) => { now += ms }, appLifecycle: () => 'visible', platform: 'android',
    authenticated: true, appVersion: '1.0.0-rc4.1-connection-diagnostic', versionCode: 36, startDiscovery,
  }
  return { env, calls, startDiscovery, events }
}

const fast = { scanWindowMs: 3000, readyTimeoutMs: 3000, pollMs: 500, productionActionGraceMs: 1000 }
const allowed = new Set(['getConnectionDiagnosticSnapshot', 'isAvailable', 'getPermissionStatus', 'requestPermissions', 'startScan', 'stopScan', 'getConnectionState', 'startDiscovery'])

afterEach(() => vi.restoreAllMocks())

describe('Build 32B.1-D connection diagnostic classifier', () => {
  it('classifies Bluetooth off as A and records BLUETOOTH_DISABLED', async () => {
    const { env } = world({ bluetoothEnabled: false })
    const report = await runConnectionDiagnostic(env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('A_BLUETOOTH_DISABLED')
    expect(report.firstFailedStage).toBe('BLUETOOTH_ADAPTER')
    expect(report.events.map((event) => event.event)).toContain('BLUETOOTH_DISABLED')
  })

  it('reports Bluetooth on and reaches READY through the production panel', async () => {
    const { env, startDiscovery } = world()
    const report = await runConnectionDiagnostic(env, { connect: true, ...fast })
    expect(report.events.map((event) => event.event)).toContain('BLUETOOTH_ADAPTER_ENABLED')
    expect(report.classification.primary).toBeNull()
    expect(report.firstFailedStage).toBeNull()
    expect(report.scan.path).toBe('PRODUCTION_UI')
    expect(report.connection.path).toBe('PRODUCTION_UI')
    expect(startDiscovery).not.toHaveBeenCalled()
    expect(report.connection).toMatchObject({ readyReached: true, servicesDiscovered: true, notificationsEnabled: true, deviceVersionRequested: true, gattState: 'CONNECTED' })
    expect(report.referenceDevice).toMatchObject({ observed: true, observedName: 'JCV8B', acceptedByNativeFilter: true, renderedInProductionList: true })
  })

  it('exports the real journal failure, scope and readiness gate without interpreting them as recovery', async () => {
    const { env } = world({ connectOutcome: 'READY_TIMEOUT' })
    const readSnapshot = env.bridge.getConnectionDiagnosticSnapshot.bind(env.bridge)
    const journal = {
      journalState: 'JOURNAL_FAILED_CLOSED', journalAccountId: 'account-A',
      journalDeviceScopeId: 'jcvital_device_11111111-2222-4333-8444-555555555555',
      journalOpenAttempted: true, journalOpenSucceeded: true, journalFailureCode: 'STORAGE_PRESSURE',
      journalFailureMessage: 'Failure: STORAGE_PRESSURE', journalFailedClosedAtStartup: true,
      failedClosed: true, priorFailureCode: null, priorFailureMessage: null, priorFailureTimestamp: null, recoveryAudit: null,
      journalLastOutcome: 'STORAGE_PRESSURE', journalRefusedCount: 1, journalEnvelopeCount: 123,
      journalInspectionFailureCode: null, journalInspectionFailureMessage: null,
      transportInitializationStarted: false, getDeviceVersionBlockedReason: 'JOURNAL_FAILED_CLOSED',
    }
    env.bridge.getConnectionDiagnosticSnapshot = async () => ({ ...await readSnapshot(), journalHandshake: journal })
    const report = await runConnectionDiagnostic(env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('L_READY_HANDSHAKE_FAILED')
    expect(report.journalHandshake).toEqual(journal)
    expect(JSON.parse(serializeConnectionDiagnostic(report)).journalHandshake).toEqual(journal)
  })

  it('classifies missing BLUETOOTH_SCAN as B', async () => {
    const report = await runConnectionDiagnostic(world({ scanGranted: false }).env, { connect: false, ...fast })
    expect(report.classification.primary).toBe('B_SCAN_PERMISSION_MISSING')
    expect(report.events.map((event) => event.event)).toContain('SCAN_PERMISSION_DENIED')
  })

  it('classifies missing legacy fine location below Android 12 as B', async () => {
    const report = await runConnectionDiagnostic(world({ sdkInt: 30, fineLocationGranted: false }).env, { connect: false, ...fast })
    expect(report.classification.primary).toBe('B_SCAN_PERMISSION_MISSING')
  })

  it('classifies missing BLUETOOTH_CONNECT separately as C', async () => {
    const report = await runConnectionDiagnostic(world({ connectGranted: false }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('C_CONNECT_PERMISSION_MISSING')
    expect(report.permissions.android?.BLUETOOTH_SCAN.granted).toBe(true)
    expect(report.permissions.android?.BLUETOOTH_CONNECT.granted).toBe(false)
  })

  it('does not report Bluetooth off when reading the adapter is denied by CONNECT permission', async () => {
    const { env } = world({ connectGranted: false })
    const snapshot = env.bridge.getConnectionDiagnosticSnapshot.bind(env.bridge)
    env.bridge.getConnectionDiagnosticSnapshot = async () => {
      const state = await snapshot()
      state.android.bluetoothEnabled = null
      state.android.adapterState = 'UNAVAILABLE'
      state.android.inspectionErrors = [{ field: 'bluetoothEnabled', code: 'SecurityException', message: 'CONNECT permission required' }]
      return state
    }
    const report = await runConnectionDiagnostic(env, { connect: false, ...fast })
    expect(report.classification.primary).toBe('C_CONNECT_PERMISSION_MISSING')
    expect(report.events.map((event) => event.event)).not.toContain('BLUETOOTH_DISABLED')
    expect(report.errors).toContain('Android bluetoothEnabled: SecurityException: CONNECT permission required')
  })

  it('does not scan when the plugin is reachable but not initialized', async () => {
    const { env, events, startDiscovery } = world()
    const snapshot = env.bridge.getConnectionDiagnosticSnapshot.bind(env.bridge)
    env.bridge.getConnectionDiagnosticSnapshot = async () => {
      const state = await snapshot()
      state.trace.pluginLoadedAt = null
      return state
    }
    const report = await runConnectionDiagnostic(env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('D_NATIVE_PLUGIN_NOT_INITIALIZED')
    expect(startDiscovery).not.toHaveBeenCalled()
    expect(events.map((event) => event.event)).not.toContain('SCAN_REQUESTED')
  })

  it('observes an already running scan rather than falsely classifying scan not invoked', async () => {
    const { env } = world()
    await env.bridge.startScan()
    const report = await runConnectionDiagnostic(env, { connect: false, ...fast })
    expect(report.classification.primary).toBeNull()
    expect(report.events.map((event) => event.event)).toContain('SCAN_ALREADY_ACTIVE')
    expect(report.scan.advertisementsReceived).toBe(2)
  })

  it('reports an already READY connection without requiring another scan', async () => {
    const { env } = world()
    await runConnectionDiagnostic(env, { connect: true, ...fast })
    const report = await runConnectionDiagnostic(env, { connect: true, ...fast })
    expect(report.classification.primary).toBeNull()
    expect(report.connection.readyReached).toBe(true)
  })

  it('does not mistake an unrelated rendered BLE device for the discovered V8', async () => {
    const { env } = world({ uiUpdates: false })
    const probe = env.panel.probe
    env.panel.probe = () => ({ ...probe(), deviceListCount: 1, renderedDeviceIds: [OTHER.address] })
    const report = await runConnectionDiagnostic(env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('I_V8_FOUND_UI_NOT_UPDATED')
    expect(report.connection.connectRequested).toBe(false)
  })

  it('connects to the selected V8 ID, not an unrelated device at UI index zero', async () => {
    const { env } = world()
    const connect = vi.spyOn(env.panel, 'clickConnectAction')
    const probe = env.panel.probe
    env.panel.probe = () => ({ ...probe(), renderedDeviceIds: [OTHER.address, ...probe().renderedDeviceIds] })
    const report = await runConnectionDiagnostic(env, { connect: true, ...fast })
    expect(connect).toHaveBeenCalledWith(V8.address)
    expect(report.connection.deviceSelected).toBe(V8.address)
    expect(report.connection.readyReached).toBe(true)
  })

  it('classifies an unreachable native plugin as D', async () => {
    const report = await runConnectionDiagnostic(world({ pluginReachable: false }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('D_NATIVE_PLUGIN_NOT_INITIALIZED')
    expect(report.plugin.reachable).toBe(false)
    expect(report.plugin.error).toContain('UNIMPLEMENTED')
  })

  it('classifies a production scan action that never reaches native startScan as E, with a direct-scan fallback result', async () => {
    const { env, startDiscovery } = world({ productionScanWired: false })
    const report = await runConnectionDiagnostic(env, { connect: false, ...fast })
    expect(report.classification.primary).toBe('E_SCAN_NOT_INVOKED')
    expect(report.firstFailedStage).toBe('SCAN_INVOCATION')
    expect(startDiscovery).toHaveBeenCalledTimes(1)
    expect(report.scan.path).toBe('DIRECT_FALLBACK')
    expect(report.fallbackClassification?.primary).toBeNull()
    expect(report.fallbackClassification?.summary).toContain('discovered and rendered')
  })

  it('classifies an absent production panel as E', async () => {
    const report = await runConnectionDiagnostic(world({ productionPanelMounted: false }).env, { connect: false, ...fast })
    expect(report.classification.primary).toBe('E_SCAN_NOT_INVOKED')
    expect(report.events.map((event) => event.event)).toEqual(expect.arrayContaining(['CONNECTION_PANEL_NOT_MOUNTED', 'PRODUCTION_SCAN_ACTION_ABSENT']))
  })

  it('records that scan was called', async () => {
    const report = await runConnectionDiagnostic(world().env, { connect: false, ...fast })
    expect(report.scan.requested).toBe(true)
    expect(report.scan.startedAt).not.toBeNull()
    expect(report.events.map((event) => event.event)).toEqual(expect.arrayContaining(['PRODUCTION_SCAN_ACTION_CLICKED', 'SCAN_REQUESTED', 'SCAN_STARTED']))
  })

  it('classifies scan start failure as F', async () => {
    const report = await runConnectionDiagnostic(world({ scanStartFails: true }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('F_SCAN_START_FAILED')
    expect(report.scan.lastScanError).toContain('SCAN_FAILED_2')
  })

  it('classifies a running scan with no advertisements as G', async () => {
    const report = await runConnectionDiagnostic(world({ adverts: [] }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('G_SCAN_RUNNING_NO_ADVERTISEMENTS')
    expect(report.events.map((event) => event.event)).toContain('NO_ADVERTISEMENTS')
  })

  it('classifies advertisements without any V8 as H', async () => {
    const report = await runConnectionDiagnostic(world({ adverts: [OTHER] }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('H_ADVERTISEMENTS_RECEIVED_V8_NOT_MATCHED')
    expect(report.events.map((event) => event.event)).toContain('ADVERTISEMENTS_RECEIVED_NO_V8_MATCH')
    expect(report.referenceDevice.observed).toBe(false)
  })

  it('annotates the reference address without matching an unnamed non-service advertisement', async () => {
    const filtered = { address: 'E7:1B:D8:36:78:CF', name: null, services: [] }
    const report = await runConnectionDiagnostic(world({ adverts: [{ ...filtered }, OTHER] }).env, { connect: false, ...fast })
    expect(report.classification.primary).toBe('H_ADVERTISEMENTS_RECEIVED_V8_NOT_MATCHED')
    expect(report.discoveredDevices.find((device) => device.address === filtered.address)).toMatchObject({ v8Candidate: false, acceptedByNativeFilter: false, rejectionReason: 'NOT_ELITE_PLUS_V8_ADVERTISEMENT', referenceDeviceObserved: true })
  })

  it.each([
    { ...V8, name: 'JCV8B 3678CF' },
    { ...V8, name: 'JCV8B AC349E', address: 'A1:B2:C3:D4:E5:F6' },
  ])('classifies name-only physical V8 candidates independently of the MAC: $name', async (advert) => {
    const { env } = world({ adverts: [advert], uiUpdates: false })
    const probe = env.panel.probe
    env.panel.probe = () => ({ ...probe(), deviceListCount: 1, renderedDeviceIds: [advert.address] })
    const report = await runConnectionDiagnostic(env, { connect: false, ...fast })
    expect(report.classification.primary).toBeNull()
    expect(report.scan.v8CandidatesDetected).toBe(1)
    expect(report.discoveredDevices[0]).toMatchObject({
      name: advert.name, serviceUuids: [], advertisesJcvitalService: false, v8Candidate: true,
    })
  })

  it('reports a matched V8 with every scan-candidate field', async () => {
    const report = await runConnectionDiagnostic(world({ adverts: [{ ...V8, services: [JCVITAL_SERVICE] }] }).env, { connect: false, ...fast })
    expect(report.classification.primary).toBeNull()
    expect(report.discoveredDevices[0]).toMatchObject({ name: 'JCV8B', address: V8.address, rssi: -52, serviceUuids: [JCVITAL_SERVICE], v8Candidate: true, acceptedByNativeFilter: true, rejectionReason: null })
    expect(report.scan).toMatchObject({ v8CandidatesDetected: 1, devicesDiscovered: 1, candidatesFiltered: 0, callbackRegistered: true })
    expect(report.events.map((event) => event.event)).toContain('V8_RENDERED_IN_PRODUCTION_LIST')
  })

  it('classifies a V8 discovered while the production list stays empty as I', async () => {
    const report = await runConnectionDiagnostic(world({ uiUpdates: false }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('I_V8_FOUND_UI_NOT_UPDATED')
    expect(report.events.map((event) => event.event)).toContain('V8_DISCOVERED_UI_NOT_UPDATED')
    expect(report.connection.connectRequested).toBe(false)
  })

  it('classifies a V8 emitted with no JS scan listener as I', async () => {
    const report = await runConnectionDiagnostic(world({ listenerRegistered: false }).env, { connect: false, ...fast })
    expect(report.classification.primary).toBe('I_V8_FOUND_UI_NOT_UPDATED')
    expect(report.classification.summary).toContain('no jcvitalScanResult listener')
  })

  it('classifies a native connect failure as J', async () => {
    const report = await runConnectionDiagnostic(world({ connectOutcome: 'CONNECT_FAILED' }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('J_CONNECT_REQUEST_FAILED')
    expect(report.connection.lastError).toContain('CONNECTION_FAILED')
  })

  it('classifies a GATT failure as K', async () => {
    const report = await runConnectionDiagnostic(world({ connectOutcome: 'GATT_FAILED' }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('K_GATT_CONNECTION_FAILED')
    expect(report.connection.gattState).toBe('FAILED')
  })

  it('classifies a missing READY after service discovery as L with READY_TIMEOUT', async () => {
    const report = await runConnectionDiagnostic(world({ connectOutcome: 'READY_TIMEOUT' }).env, { connect: true, ...fast })
    expect(report.classification.primary).toBe('L_READY_HANDSHAKE_FAILED')
    expect(report.events.map((event) => event.event)).toContain('READY_TIMEOUT')
  })

  it('falls back to M when connect was requested without native evidence or an error', async () => {
    const { env } = world()
    const base = await runConnectionDiagnostic(env, { connect: false, ...fast })
    const pre = await env.bridge.getConnectionDiagnosticSnapshot()
    const classification = classifyConnectionSegment({
      pluginReachable: true, pluginError: null, traceEnabled: true, pluginLoaded: true, android: pre.android,
      events: base.events.filter((event) => event.source === 'native'), candidates: pre.trace.candidates,
      advertisementsReceived: pre.trace.advertisementsReceived, maxDomDeviceCount: 1, scanResultListenerRegistered: true,
      connectRequested: true, connectError: null, readyReached: false,
    })
    expect(classification.primary).toBe('M_INSUFFICIENT_EVIDENCE')
    expect(classification.firstFailedStage).toBeNull()
  })

  it('orders native and JS events chronologically from authentication to READY', async () => {
    const report = await runConnectionDiagnostic(world().env, { connect: true, ...fast })
    const order = report.events.map((event) => event.event)
    const sequence = ['APP_AUTHENTICATED', 'CONNECTION_PANEL_MOUNTED', 'RUN_STARTED', 'BLUETOOTH_ADAPTER_ENABLED', 'SCAN_PERMISSION_GRANTED', 'CONNECT_PERMISSION_GRANTED',
      'SCAN_REQUESTED', 'SCAN_STARTED', 'ADVERTISEMENT_RECEIVED', 'V8_CANDIDATE_MATCHED', 'CONNECT_REQUESTED', 'GATT_CONNECTED', 'SERVICES_DISCOVERED',
      'NOTIFICATIONS_ENABLED', 'DEVICE_VERSION_REQUESTED', 'READY']
    const indexes = sequence.map((name) => order.indexOf(name))
    expect(indexes.every((index) => index >= 0)).toBe(true)
    expect(indexes).toEqual([...indexes].sort((left, right) => left - right))
    const times = report.events.map((event) => event.at)
    expect(times).toEqual([...times].sort())
    expect(mergeEvents([{ at: 'b', source: 'native', event: 'X', detail: {} }], [{ at: 'a', source: 'js', event: 'Y', detail: {} }]).map((event) => event.event)).toEqual(['Y', 'X'])
  })

  it('exports JSON with every required section and no credentials', async () => {
    const report = await runConnectionDiagnostic(world().env, { connect: true, ...fast })
    const tainted = { ...report, errors: [], session: { ...report.session, authToken: 'secret-token', email: 'a@b.c' } } as typeof report
    const json = serializeConnectionDiagnostic(tainted)
    const parsed = JSON.parse(json)
    expect(parsed.schema).toBe(CONNECTION_DIAGNOSTIC_SCHEMA)
    for (const key of ['build', 'session', 'permissions', 'bluetoothAdapter', 'plugin', 'productionPanel', 'scan', 'discoveredDevices', 'connection', 'events', 'errors', 'classification', 'preRunClassification', 'firstFailedStage', 'referenceDevice']) {
      expect(parsed).toHaveProperty(key)
    }
    expect(parsed.build).toEqual({ appVersion: '1.0.0-rc4.1-connection-diagnostic', versionCode: 36, variant: 'connection-diagnostic' })
    expect(parsed.session.authenticated).toBe(true)
    expect(json).not.toMatch(/secret-token|a@b\.c|authToken|"email"/)
    expect(parsed.referenceDevice.usage).toBe('ANNOTATION_ONLY_NOT_USED_FOR_MATCHING')
  })

  it('never acquires history, mutates the queue, calls Base44 or uses methods outside the connection seam', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const { observationQueue } = await import('../../services/sync/ObservationQueue')
    const { observationBatchManager } = await import('../../services/sync/ObservationBatchManager')
    const enqueue = vi.spyOn(observationQueue, 'enqueue')
    const enqueueMany = vi.spyOn(observationQueue, 'enqueueMany')
    const deliver = vi.spyOn(observationBatchManager, 'process')
    for (const options of [{}, { uiUpdates: false }, { productionScanWired: false }, { connectOutcome: 'GATT_FAILED' as const }]) {
      const { env, calls } = world(options)
      await runConnectionDiagnostic(env, { connect: true, ...fast })
      expect(calls.filter((call) => !allowed.has(call))).toEqual([])
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(enqueue).not.toHaveBeenCalled()
    expect(enqueueMany).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    for (const file of ['./ConnectionDiagnostic.ts', './ConnectionDiagnosticPanel.tsx']) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf8')
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1])
      expect(imports.every((module) => ['react', '@capacitor/app', './jcvitalV8Bridge', './CertificationJsonExport', './ConnectionDiagnosticExport', './ConnectionLifecycle', './ConnectionDiagnostic', './V8PluginBootstrap'].includes(module))).toBe(true)
      expect(source).not.toMatch(/import \{[^}]*connectAndBindJournal/)
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').replace(/'[^'\n]*'|`[^`\n]*`/g, "''").replace(/>[^<>{}]*</g, '><')
        .replace(/\b(coldCertificationBytes|certificationEvidenceBytes|certificationEvidenceScope|certificationSnapshotBytes|certificationSnapshotScope|markerBasedCertificationBytes|potentialArchivableCertificationBytes|certificationSnapshotsOutsideBudget)\b/g, 'capacityMetadata')
        .replace(/\b(recoveryAuditHistory|unsolicitedType27Count)\b/g, 'isolationMetadata')
      expect(code).not.toMatch(/ProductionV8Sync|ProductionSyncLedger|observationQueue|ObservationBatchManager|[Bb]ase44|fetch\(|History|Type27|Type68|Type59|Workout|configureSourceJournal|Certification(?!JsonExport)/)
    }
  })

  it('does not hard-code the reference MAC into matching', () => {
    const source = readFileSync(new URL('./ConnectionDiagnostic.ts', import.meta.url), 'utf8')
    expect(source.match(/E7:1B:D8:36:78:CF/g)).toHaveLength(1)
    expect(REFERENCE_V8.usage).toBe('ANNOTATION_ONLY_NOT_USED_FOR_MATCHING')
    const native = readFileSync(new URL('../../../android/app/src/main/java/com/hapi/eliteplus/connector/jcvital/JCVitalV8Manager.kt', import.meta.url), 'utf8')
    expect(native).not.toContain('E7:1B:D8:36:78:CF')
  })
})

describe('Build 32B.1-D DOM driver of the unchanged production panel', () => {
  type FakeElement = { textContent: string; disabled: boolean; click: () => void; getAttribute: (name: string) => string | null; querySelector: (selector: string) => FakeElement | null; querySelectorAll: (selector: string) => FakeElement[] }
  const element = (textContent: string, children: Record<string, FakeElement | FakeElement[]> = {}, click = () => undefined): FakeElement => ({
    textContent, disabled: false, click,
    getAttribute: (name) => name === 'data-device-id' ? V8.address : null,
    querySelector: (selector) => { const found = children[selector]; return Array.isArray(found) ? found[0] ?? null : found ?? null },
    querySelectorAll: (selector) => { const found = children[selector]; return Array.isArray(found) ? found : found ? [found] : [] },
  })
  const LIST_ITEMS = 'ul[aria-label="Available Elite+ V8 devices"] > li'

  it('reads the production status, scan action and device list and clicks only rendered, enabled buttons', () => {
    const scan = vi.fn()
    const connect = vi.fn()
    const scanButton = element('Connect your Elite+ V8', {}, scan)
    const connectButton = element('Connect', {}, connect)
    const status = element('', { strong: element('Not connected'), span: element('Connect your Elite+ V8 to begin.') })
    const card = element('', { button: [scanButton, connectButton], '[role="status"]': status })
    const root = element('', {
      '.elite-v8-dashboard': element(''), '.elite-v8-dashboard .elite-v8-device-card': card,
      [LIST_ITEMS]: [element('Elite+ V8 nearby', { button: connectButton })], [`${LIST_ITEMS} button`]: [connectButton],
    })
    const driver = createDomPanelDriver(root as unknown as ParentNode)
    expect(driver.probe()).toEqual({ mounted: true, statusTitle: 'Not connected', statusMessage: 'Connect your Elite+ V8 to begin.', scanActionLabel: 'Connect your Elite+ V8', permissionActionPresent: false, deviceListCount: 1, connectActionCount: 1, renderedDeviceIds: [V8.address] })
    expect(driver.clickScanAction()).toBe(true)
    expect(driver.clickConnectAction(V8.address)).toBe(true)
    expect(driver.clickConnectAction(OTHER.address)).toBe(false)
    expect(driver.clickPermissionAction()).toBe(false)
    scanButton.disabled = true
    expect(driver.clickScanAction()).toBe(false)
    expect(scan).toHaveBeenCalledTimes(1)
    expect(connect).toHaveBeenCalledTimes(1)
  })

  it('recognises the permission action and reports an unmounted production panel', () => {
    const allow = element('Allow Bluetooth')
    const root = element('', { '.elite-v8-dashboard': element(''), '.elite-v8-dashboard .elite-v8-device-card': element('', { button: [allow] }) })
    expect(createDomPanelDriver(root as unknown as ParentNode).probe()).toMatchObject({ permissionActionPresent: true, scanActionLabel: null })
    expect(createDomPanelDriver(element('') as unknown as ParentNode).probe()).toMatchObject({ mounted: false, scanActionLabel: null, deviceListCount: 0 })
  })
})

describe('Build 32B.1-D bundle isolation', () => {
  const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')
  const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
  const pkg = readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')
  const stub = readFileSync(new URL('./ConnectionDiagnosticPanelStub.tsx', import.meta.url), 'utf8')

  it('keeps connection diagnostics out of production while including them in Engineering and explicit diagnostic builds', () => {
    expect(vite).toContain("engineering || connectionDiagnostic ? 'ConnectionDiagnosticPanel.tsx' : 'ConnectionDiagnosticPanelStub.tsx'")
    expect(vite).toContain("engineering ? 'PipelineDiagnosticV8Panel.tsx' : 'ElitePlusV8Panel.tsx'")
    expect(stub).toContain('return null')
    expect(stub).not.toContain('LiveConnectionDiagnosticPanel')
    expect(stub).not.toContain("props.appVersion ===")
    expect(pkg).toContain('vite build --mode connection-diagnostic')
  })

  it('mounts the diagnostic after the V8 panel only in gated Engineering/diagnostic builds', () => {
    const diagnostic = app.indexOf('<ConnectionDiagnosticPanel')
    const production = app.indexOf('? <CompanionV8Panel')
    expect(diagnostic).toBeGreaterThan(0)
    expect(diagnostic).toBeGreaterThan(production)
    expect(app).toContain('versionCode={appVersionCode}')
    expect(app).toContain('const appVersion = companionBuild.versionName')
  })
})
