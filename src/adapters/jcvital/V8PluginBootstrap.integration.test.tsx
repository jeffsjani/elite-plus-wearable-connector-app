// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  authenticated: false,
  initialize: vi.fn(),
  scan: vi.fn(async () => {}),
  logout: vi.fn(async () => {}),
  listeners: vi.fn(async (_event: string, _listener: (device: unknown) => void) => ({ remove: vi.fn(async () => {}) })),
  snapshot: vi.fn(async () => { throw new Error('Snapshot fixture not supplied') }),
}))

vi.mock('./jcvitalV8Bridge', async (importOriginal) => ({
  ...await importOriginal<typeof import('./jcvitalV8Bridge')>(),
  JCVitalV8: {
    initialize: mocks.initialize,
    isAvailable: vi.fn(async () => ({ available: true, enabled: true })),
    addListener: mocks.listeners,
    getConnectionState: vi.fn(async () => ({ state: 'DISCONNECTED', deviceId: null })),
    getPermissionStatus: vi.fn(async () => ({ status: 'AUTHORIZED', bluetoothEnabled: true, permissions: [] })),
    requestPermissions: vi.fn(async () => ({ status: 'AUTHORIZED', bluetoothEnabled: true, permissions: [] })),
    getDiscoveredDevices: vi.fn(async () => ({ devices: [] })),
    configureSourceJournal: vi.fn(async () => ({ enabled: false })),
    startScan: mocks.scan,
    getConnectionDiagnosticSnapshot: mocks.snapshot,
  },
}))
vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => true, isPluginAvailable: () => true, getPlatform: () => 'android' },
  registerPlugin: () => ({}),
}))
vi.mock('@capacitor/app', () => ({ App: { addListener: vi.fn(async () => ({ remove: vi.fn() })) } }))
vi.mock('../../wellness/CompanionWellnessSession', () => ({
  companionWellnessSession: {
    activateAuthenticatedUser: vi.fn(async () => null),
    closeAuthenticatedUser: vi.fn(async () => {}),
  },
}))
vi.mock('../../services/base44/AuthenticationService', () => ({
  authenticationService: {
    isAuthenticated: async () => mocks.authenticated,
    getCurrentUser: async () => ({ id: 'athlete-A', email: 'athlete@example.test' }),
    loginWithEmailPassword: async () => ({ id: 'athlete-A', email: 'athlete@example.test' }),
    logout: mocks.logout,
  },
}))
vi.mock('../../services/base44/ConnectorRegistrationService', () => ({
  connectorRegistrationService: { registerConnector: async () => ({ connectorDeviceId: 'connector-A', sources: [] }) },
}))
vi.mock('../../services/sync/ObservationQueue', () => ({
  observationQueue: {
    getOwnerUserId: () => 'athlete-A', setOwnerUserId: vi.fn(), initialize: vi.fn(async () => {}),
    getQueueStats: vi.fn(async () => ({ pending: 0, retrying: 0, failed: 0, inFlight: 0, warnings: [] })),
  },
}))
vi.mock('../../services/sync/ObservationBatchManager', () => ({
  observationBatchManager: {
    start: vi.fn(async () => {}),
    pause: vi.fn(),
    stop: vi.fn(),
    getDeliveryDiagnostics: vi.fn(() => ({
      queueStats: {
        pending: 0, inFlight: 0, retrying: 0, failed: 0, acknowledged: 0,
        oldestPendingAgeMs: null, oldestInFlightAgeMs: null, lastSuccessfulUploadAt: null,
      },
      senderActive: false, senderGeneration: 0, lastBatch: null, lastSuccessfulDeliveryAt: null, lastDeliveryError: null,
    })),
  },
}))
vi.mock('./WorkoutHrDelivery', () => ({
  WorkoutHrDeliveryService: class {
    start() {}
    dispose() {}
    setContext() {}
  },
}))
vi.mock('../../services/rook/RookConnectionsPanel', () => ({ RookConnectionsPanel: () => null }))
vi.mock('../health-connect/HealthConnectPanel', () => ({ HealthConnectPanel: () => null }))

import App from '../../App'
import { V8BootstrapProvider, useV8PluginStartup } from './V8PluginBootstrap'
import { JCVitalV8Panel } from './ElitePlusV8Panel'
import { ProductionV8Sync } from './ProductionV8Sync'

let root: Root | null = null
afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  vi.unstubAllGlobals()
})

describe(`mounted authenticated bootstrap (${import.meta.env.MODE})`, () => {
  it('initializes through actual App login, survives logout/login and remount, and scans with no diagnostic panel', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const productionSyncRun = vi.spyOn(ProductionV8Sync.prototype, 'run')
    expect(import.meta.env.VITE_ENGINEERING_DIAGNOSTICS).toBe('false')
    const container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    let acknowledge!: (result: { initialized: boolean; pluginName: string }) => void
    mocks.initialize.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve }))

    await act(async () => { root!.render(<App />) })
    expect(mocks.initialize).not.toHaveBeenCalled()
    expect(container.querySelector('form')).not.toBeNull()

    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(mocks.initialize).toHaveBeenCalledOnce()
    expect(mocks.scan).not.toHaveBeenCalled()
    expect(mocks.snapshot).not.toHaveBeenCalled()
    expect(mocks.listeners).not.toHaveBeenCalled()
    const diagnosticButton = () => Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Run Connection Diagnostic')
    expect(diagnosticButton()).toBeUndefined()

    await act(async () => { acknowledge({ initialized: true, pluginName: 'JCVitalV8' }) })
    expect(diagnosticButton()).toBeUndefined()
    expect(container.textContent).not.toContain('initialization ACK received')
    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('nav button')).find((button) => button.textContent === 'Connect')!.click()
    })
    const scanButton = () => Array.from(container.querySelectorAll<HTMLButtonElement>('.elite-v8-device-card button')).find((button) => button.textContent === 'Connect your Elite+ V8')!
    expect(scanButton().disabled).toBe(false)
    await act(async () => { scanButton().click() })
    expect(mocks.scan).toHaveBeenCalledWith({ timeoutMs: 30000 })

    await act(async () => {
      Array.from(container.querySelectorAll<HTMLButtonElement>('nav button')).find((button) => button.textContent === 'Settings')!.click()
    })
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Sign Out')!.click()
    })
    expect(mocks.logout).toHaveBeenCalledOnce()
    expect(container.querySelector('.elite-v8-dashboard')).toBeNull()
    await act(async () => { container.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) })
    expect(mocks.initialize).toHaveBeenCalledOnce()
    expect(scanButton().disabled).toBe(false)

    await act(async () => { root!.unmount() })
    root = createRoot(container)
    mocks.authenticated = true
    await act(async () => { root!.render(<App />) })
    expect(mocks.initialize).toHaveBeenCalledOnce()
    expect(scanButton().disabled).toBe(false)

    function StateProbe() {
      return <output>{useV8PluginStartup().state}</output>
    }
    await act(async () => {
      root!.render(
        <V8BootstrapProvider authenticated ownerUserId="athlete-A">
          <StateProbe />
          <JCVitalV8Panel ownerUserId="athlete-A" onSync={() => {}} syncBusy={false} syncError="" syncEnabled={false} appVersion="production" appVersionCode={39} />
        </V8BootstrapProvider>,
      )
    })
    expect(container.querySelector('output')?.textContent).toBe('READY')
    expect(container.querySelector('.connection-diagnostic')).toBeNull()
    const previousScans = mocks.scan.mock.calls.length
    await act(async () => { scanButton().click() })
    expect(mocks.scan).toHaveBeenCalledTimes(previousScans + 1)
    expect(mocks.initialize).toHaveBeenCalledOnce()
    const scanListener = mocks.listeners.mock.calls.filter(([event]) => event === 'jcvitalScanResult').at(-1)![1]
    const physical = {
      id: 'E7:1B:D8:36:78:CF', macAddress: 'E7:1B:D8:36:78:CF',
      name: 'JCV8B 3678CF', rssi: -45, bonded: false, connectable: true,
      lastSeenAt: '2026-10-11T12:00:00Z', advertisesJcvitalService: false, v8Candidate: true,
    }
    await act(async () => {
      scanListener({ ...physical, id: '11:22:33:44:55:66', name: 'WHOOP 1234', v8Candidate: false })
      scanListener(physical)
      scanListener({ ...physical, id: 'A1:B2:C3:D4:E5:F6', name: 'JCV8B AC349E' })
    })
    expect(container.querySelectorAll('.elite-v8-device-list li')).toHaveLength(2)
    expect(container.textContent).toContain('JCV8B 3678CF')
    expect(container.textContent).toContain('JCV8B AC349E')
    expect(container.textContent).not.toContain('WHOOP 1234')
    const physicalRow = container.querySelector('[data-device-id="E7:1B:D8:36:78:CF"]')!
    expect(physicalRow.querySelector('button')?.textContent).toBe('Connect')
    expect(physicalRow.querySelector('button')?.disabled).toBe(false)
    // v47.1: login, logout/login, remount and panel mount never start a production sync.
    expect(productionSyncRun).not.toHaveBeenCalled()
    productionSyncRun.mockRestore()
    container.remove()
  })
})
