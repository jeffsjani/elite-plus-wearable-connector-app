// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { ElitePlusV8Dashboard, type ElitePlusV8DashboardProps } from './ElitePlusV8Dashboard'
import { productionSyncMessage } from './ProductionSyncCopy'
import { isElitePlusV8Advertisement, type JCVitalV8Device } from './jcvitalV8Bridge'
import { loadProductionSyncReceipt, ProductionV8Sync, type ProductionSyncReceipt } from './ProductionV8Sync'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import { authenticationService } from '../../services/base44/AuthenticationService'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { observationBatchManager, ObservationBatchManager } from '../../services/sync/ObservationBatchManager'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { getQueueStore } from '../../services/storage/QueueStoreFactory'
import { createSyntheticObservation } from '../../services/testing/SyntheticObservationFactory'

vi.mock('../../buildMode', () => ({
  IS_ENGINEERING_BUILD: true,
  IS_CONNECTION_DIAGNOSTIC_BUILD: false,
}))

const advertisements: Array<{
  address: string; name: string | null; serviceUuids: string[]; connectable: boolean; v8Candidate: boolean
}> = JSON.parse(readFileSync(resolve(process.cwd(), 'android/app/src/test/resources/v8-advertisements.json'), 'utf8'))

const callbacks = {
  onRequestPermission: vi.fn(),
  onStartScan: vi.fn(),
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
  onSync: vi.fn(),
}
let root: Root | null = null

afterEach(async () => {
  if (root) await act(async () => { root?.unmount() })
  root = null
  vi.unstubAllGlobals()
})

const sourceReceipt = (source: 'HEART_RATE' | 'BLOOD_OXYGEN' | 'TEMPERATURE', metric: 'heartRate' | 'oxygenSaturation' | 'wearableTemperature', vendorDataType: string, status: 'SUCCESS' | 'NO_DATA'): ProductionSyncReceipt['sources'][number] => ({
  source, metric, vendorDataType,
  nativeCommand: vendorDataType === '27' ? 'GetDynamicHRWithMode' : vendorDataType === '68' ? 'Oxygen_data' : 'GetTemperature_historyData',
  requested: true,
  status,
  bridgeInvoked: true, nativeRequestAccepted: true, nativeCommandQueued: true, nativeCommandWritten: true,
  callbackReceived: true, acquisitionCompleted: true, sourceRecordCount: 1, observationCount: 1, mappedCount: 1,
  acquisitionId: `acquisition-${vendorDataType}`, acquisitionRequestId: `request-${vendorDataType}`,
  nativeSyncId: `native-${vendorDataType}`, connectionGeneration: 9,
  acquisitionStartedAt: '2026-10-06T12:00:00Z', acquisitionCompletedAt: '2026-10-06T12:01:00Z',
  clientQueuedAt: '2026-10-06T12:00:30Z', observationProvenance: {},
  deduplicatedCount: 0, queuedCount: 1, deliveryPendingCount: 0, deliveredCount: 1,
  ackedCount: 1, duplicateAckedCount: 0, failedCount: 0,
  errorCode: null, errorMessage: null, skipReason: null, startedAt: '2026-10-06T12:00:00Z',
  completedAt: '2026-10-06T12:01:00Z', nativeCompletionStatus: 'COMPLETE', recordGroupsReceived: 1, received: 1,
  new: 1, duplicate: 0, rejected: 0, noMeasurement: 0, parseErrors: 0, earliestDeviceTimestamp: null,
  latestDeviceTimestamp: null, latestObservedAt: null, sourceEnvelopeIds: 0, error: null,
})

const productionReceipt: ProductionSyncReceipt = {
  schema: 'elite-plus.v8-production-sync-receipt.v2', syncId: 'sync-test', appVersion: 'test', versionCode: 47,
  startedAt: '2026-10-06T12:00:00Z', completedAt: '2026-10-06T12:01:00Z', outcome: 'UP_TO_DATE', overallState: 'UP_TO_DATE',
  requestedMetrics: ['heartRate', 'oxygenSaturation', 'wearableTemperature'],
  accountScope: { authenticatedOwnerUserId: 'owner', persistedConnectorOwnerUserId: 'owner', queueOwnerUserId: 'owner', journalScopeAccountId: 'owner', connectorDeviceId: 'connector', match: true },
  deviceScopeId: 'scope', physicalDevice: { bleDeviceId: 'device', name: 'V8', firmwareVersion: null, sdkVersion: null, connectionState: 'READY' },
  sourceJournal: { enabled: true, failedClosed: false, totalEnvelopeCountBefore: 1, totalEnvelopeCountAfter: 1 },
  sources: [
    sourceReceipt('HEART_RATE', 'heartRate', '27', 'SUCCESS'),
    sourceReceipt('BLOOD_OXYGEN', 'oxygenSaturation', '68', 'NO_DATA'),
    sourceReceipt('TEMPERATURE', 'wearableTemperature', '59', 'NO_DATA'),
  ],
  totals: { received: 1, new: 1, duplicate: 0, rejected: 0, noMeasurement: 0, latestDeviceTimestamp: null },
  queueBefore: { pending: 0, retrying: 0, inFlight: 0, failed: 0, acknowledged: 0 },
  queue: { queued: 1, newlyEnqueued: 1, alreadyQueued: 0, depthAfterSave: 0, depthAfterDelivery: 0 },
  delivery: {
    attempted: true, rounds: 1, attempts: 1, delivered: 1, serverAccepted: 1, serverDuplicate: 0, serverDuplicates: 0,
    serverRejected: 0, canonical: { canonicalized: 1, notApplicable: 0, failed: 0, unreported: 0 }, lastServerResult: 'Accepted 1',
    ackCount: 1, purgeCount: 1, unresolved: 0, pauseReason: null,
  },
  errors: [], isolation: { nativeCommandsIssued: [], backgroundScheduler: false, observedAtRewritten: false },
}

function dashboardElement(state: 'READY' | 'DISCONNECTED' = 'READY', extra: Partial<ElitePlusV8DashboardProps> = {}) {
  return (
    <ElitePlusV8Dashboard
      state={state}
      pluginAvailable={true}
      pluginStartupState="READY"
      devices={[]}
      permission={{ status: 'AUTHORIZED', bluetoothEnabled: true, permissions: [] }}
      info={{ deviceId: 'internal-id', firmwareVersion: '1.2.3', sdkVersion: 'internal-sdk', missingFields: [] }}
      battery={{ deviceId: 'internal-id', level: 78, charging: false, chargingStateRaw: 0, voltageRaw: 0, vendorDataType: 'battery', receiptTimestamp: '2026-10-06T12:00:00Z' }}
      lastConnectedAt="2026-10-06T12:00:00Z"
      queueStats={null}
      busy={false}
      syncBusy={false}
      syncError=""
      syncEnabled={false}
      appVersion="1.0.0-rc4-sync"
      {...callbacks}
      {...extra}
    />
  )
}

function renderDashboard(state: 'READY' | 'DISCONNECTED' = 'READY', extra: Partial<ElitePlusV8DashboardProps> = {}) {
  return renderToStaticMarkup(dashboardElement(state, extra))
}

describe('ElitePlusV8Dashboard', () => {
  it('shows athlete-friendly connection and device details without engineering metadata', () => {
    const html = renderDashboard()

    expect(html).toContain('Elite+ V8')
    expect(html).toContain('Your Elite+ V8 is ready.')
    expect(html).toContain('Heart Rate')
    expect(html).toContain('Blood Oxygen')
    expect(html).toContain('Temperature')
    expect(html).toContain('Last successful sync: Not synced yet')
    expect(html).not.toContain('Activity')
    expect(html).not.toContain('Device Details')
    expect(html).toContain('78%')
    expect(html).toContain('Last connected')
    expect(html).not.toContain('<table')
    expect(html).not.toContain('internal-id')
    expect(html).not.toContain('internal-sdk')
    expect(html).not.toContain('JCVital')
    expect(html).not.toContain('RAW_PPG')
    expect(html).not.toContain('127')
    expect(html).not.toContain('JSON')
  })

  it('uses a clear reconnect state and disables sync without queued data', () => {
    const html = renderDashboard('DISCONNECTED')

    expect(html).toContain('Reconnect your Elite+ V8 to sync new data.')
    expect(html).toContain('Sync Device Data')
    expect(html).toContain('Connection needed')
    expect(html).toContain('disabled=""')
  })

  it('shows actionable permission and Bluetooth-off states', () => {
    const denied = renderDashboard('DISCONNECTED', {
      permission: { status: 'DENIED', bluetoothEnabled: true, permissions: [] },
    })
    expect(denied).toContain('Allow Bluetooth access to connect your Elite+ V8')
    expect(denied).toContain('Allow Bluetooth')

    const bluetoothOff = renderDashboard('DISCONNECTED', {
      permission: { status: 'BLUETOOTH_DISABLED', bluetoothEnabled: false, permissions: [] },
    })
    expect(bluetoothOff).toContain('Turn on Bluetooth to connect your Elite+ V8')
  })

  it('renders discovered V8 devices with a Connect action', () => {
    const html = renderDashboard('DISCONNECTED', {
      devices: [{
        id: 'AA:BB:CC:DD:EE:FF',
        name: 'PRO_V8',
        macAddress: 'AA:BB:CC:DD:EE:FF',
        rssi: -45,
        bonded: false,
        connectable: true,
        lastSeenAt: '2026-10-11T12:00:00.000Z',
        advertisesJcvitalService: true,
        v8Candidate: true,
      }],
    })
    expect(html).toContain('Elite+ V8 nearby')
    expect(html).toContain('>Connect</button>')
  })

  it.each(['UNAVAILABLE', 'REGISTERING', 'INITIALIZING', 'FAILED'] as const)(
    'disables scan and connect before native startup READY (%s)',
    (pluginStartupState) => {
      const html = renderDashboard('DISCONNECTED', {
        pluginStartupState,
        devices: [{
          id: 'AA:BB:CC:DD:EE:FF', name: 'PRO_V8', macAddress: 'AA:BB:CC:DD:EE:FF',
          rssi: -45, bonded: false, connectable: true, lastSeenAt: '2026-10-11T12:00:00Z',
          advertisesJcvitalService: true, v8Candidate: true,
        }],
      })
      expect(html.match(/<button[^>]*>Reconnect your Elite\+ V8<\/button>/)?.[0]).toContain('disabled=""')
      expect(html.match(/<button[^>]*>Connect<\/button>/)?.[0]).toContain('disabled=""')
      if (pluginStartupState === 'UNAVAILABLE' || pluginStartupState === 'FAILED') {
        expect(html).toContain('Unable to initialize Elite+ V8 connection')
      }
    },
  )

  it.each(advertisements)('renders only native V8 candidates: $name ($address)', (advertisement) => {
    const device: JCVitalV8Device = {
      ...advertisement, id: advertisement.address, macAddress: advertisement.address,
      rssi: -45, bonded: false, lastSeenAt: '2026-10-11T12:00:00Z',
      advertisesJcvitalService: advertisement.serviceUuids.length > 0,
    }
    const html = renderDashboard('DISCONNECTED', { devices: [device] })
    expect(isElitePlusV8Advertisement(device)).toBe(advertisement.v8Candidate)
    expect(html.includes(`data-device-id="${advertisement.address}"`)).toBe(advertisement.v8Candidate)
    expect(html.includes('>Connect</button>')).toBe(advertisement.v8Candidate)
    if (advertisement.name === 'JCV8B 3678CF' || advertisement.name === 'JCV8B AC349E') {
      expect(html).toContain(advertisement.name)
      expect(html.match(/<button[^>]*>Connect<\/button>/)?.[0]).not.toContain('disabled')
    }
  })

  describe('Build 32B production sync UI', () => {
    const syncButton = (html: string) => html.match(/<button[^>]*>(?:Syncing…|Sync Device Data)<\/button>/)?.[0] ?? ''
    const emptyQueue = { pending: 0, retrying: 0, failed: 0, inFlight: 0, acknowledged: 0, oldestPendingAgeMs: null, lastAttemptAt: null, lastSuccessfulUploadAt: null, warnings: [] }

    it('enables Sync Device Data when READY even with an empty queue, because sync now reads the device', () => {
      const html = renderDashboard('READY', { syncEnabled: true, queueStats: emptyQueue })
      expect(syncButton(html)).not.toContain('disabled')
      expect(html).toContain('Ready to sync')
    })

    it('requires READY before sync can start', () => {
      const html = renderDashboard('DISCONNECTED', { syncEnabled: true, queueStats: emptyQueue })
      expect(syncButton(html)).toContain('disabled')
    })

    it('keeps new device sync available while saved observations are delivered in the background', () => {
      const html = renderDashboard('READY', {
        syncEnabled: true,
        queueStats: { ...emptyQueue, inFlight: 1 },
      })
      expect(html).toContain('Sending saved data…')
      expect(syncButton(html)).not.toContain('disabled')
    })

    it.each([
      ['READING_HEART_RATE', 'Reading Heart Rate from V8…'],
      ['READING_BLOOD_OXYGEN', 'Reading Blood Oxygen from V8…'],
      ['READING_TEMPERATURE', 'Reading Temperature from V8…'],
      ['SAVING', 'Saved on this device'],
      ['DELIVERING', 'Sending to Elite+…'],
    ] as const)('shows consumer progress for %s', (stage, label) => {
      const html = renderDashboard('READY', { syncEnabled: true, queueStats: emptyQueue, syncStage: stage })
      expect(html).toContain(label)
      if (stage.startsWith('READING_')) expect(html).toContain('aria-current="step"')
      else expect(html).not.toContain('aria-label="Sync progress"')
      expect(syncButton(html)).toContain('disabled')
      expect(syncButton(html)).toContain('Syncing…')
      expect(html).not.toMatch(/JCVital|Type ?\d|Oxygen_data|GetTemperature|GetDynamicHR/)
    })

    it('omits unrequested Heart Rate from a scoped SpO2 and temperature progress strip', () => {
      const html = renderDashboard('READY', {
        syncEnabled: true, queueStats: emptyQueue, syncStage: 'READING_BLOOD_OXYGEN',
        syncMetrics: ['oxygenSaturation', 'wearableTemperature'],
      })

      expect(html).toContain('Blood Oxygen')
      expect(html).toContain('Temperature')
      expect(html).not.toContain('<li class="">Heart Rate</li>')
      expect(html).not.toContain('aria-current="step">Heart Rate')
    })

    it('shows No new data for an empty result rather than an error', () => {
      const html = renderDashboard('READY', { syncEnabled: true, queueStats: emptyQueue, syncSummary: { outcome: 'UP_TO_DATE', newCount: 0, errorCode: null, completedAt: null } })
      expect(html).toContain('No new data')
      expect(html).toContain('No new readings since your last sync.')
      expect(html).not.toContain('role="alert"')
    })

    it('uses only the requested metric outcomes and the three allowed athlete result states', () => {
      const html = renderDashboard('READY', {
        syncEnabled: true,
        queueStats: emptyQueue,
        syncSummary: {
          outcome: 'PARTIAL',
          newCount: 1,
          errorCode: null,
          completedAt: null,
          metrics: [
            { metric: 'heartRate', status: 'SUCCESS' },
            { metric: 'oxygenSaturation', status: 'NO_DATA' },
            { metric: 'wearableTemperature', status: 'FAILED' },
          ],
        },
      })
      expect(html).toContain('Could not sync')
      expect(html).toContain('Heart Rate</span><strong>Synced')
      expect(html).toContain('Blood Oxygen</span><strong>No new data')
      expect(html).toContain('Temperature</span><strong>Could not sync')
    })

    it('uses consumer copy for every outcome', () => {
      expect(productionSyncMessage({ outcome: 'UP_TO_DATE', newCount: 3, errorCode: null, completedAt: null })).toBe('3 new readings synced to Elite+.')
      expect(productionSyncMessage({ outcome: 'PENDING_DELIVERY', newCount: 3, errorCode: null, completedAt: null })).toContain('saved on this phone')
      expect(productionSyncMessage({ outcome: 'BLOCKED', newCount: 0, errorCode: 'OWNER_MISMATCH', completedAt: null })).toContain('Sign out')
      expect(productionSyncMessage({ outcome: 'BLOCKED', newCount: 0, errorCode: 'DEVICE_NOT_READY', completedAt: null })).toContain('Reconnect')
      for (const outcome of ['UP_TO_DATE', 'PARTIAL', 'PENDING_DELIVERY', 'BLOCKED', 'FAILED'] as const) {
        expect(productionSyncMessage({ outcome, newCount: 1, errorCode: 'OWNER_MISMATCH', completedAt: null })).not.toMatch(/JCVital|Type|OWNER_MISMATCH/)
      }
    })

    it('keeps production receipt details and the subset button engineering-only', () => {
      const athleteHtml = renderDashboard('READY', {
        syncEnabled: true, queueStats: emptyQueue, receiptAvailable: true, receipt: productionReceipt,
        engineeringBuild: false, onTestSpo2Temperature: vi.fn(),
      })
      expect(athleteHtml).not.toContain('Last Production Sync')
      expect(athleteHtml).not.toContain('Test SpO₂ + Temperature')
      expect(athleteHtml).not.toContain('View Receipt')
      const share = vi.fn()
      const view = vi.fn()
      const html = renderDashboard('READY', {
        syncEnabled: true, queueStats: emptyQueue, receiptAvailable: true, receipt: productionReceipt,
        engineeringBuild: true, receiptViewOpen: true, onShareReceipt: share, onViewReceipt: view,
      })
      expect(html).toContain('Last Production Sync')
      expect(html).toContain('View Receipt')
      expect(html).toContain('Share Receipt')
      expect(html).toContain('Production sync receipt detail')
      expect(html).toContain('Oxygen_data')
      expect(html).not.toContain('Copy Sync Receipt JSON')
      expect(html).not.toContain('Save Sync Receipt JSON')
      expect(share).not.toHaveBeenCalled()
      expect(view).not.toHaveBeenCalled()
    })

    it('renders the expanded persisted receipt without invoking sync or connection actions', () => {
      const actions = [
        vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(),
      ]
      const html = renderDashboard('READY', {
        syncEnabled: true, queueStats: { ...emptyQueue, pending: 7 }, receiptAvailable: true, receipt: productionReceipt,
        engineeringBuild: true, receiptViewOpen: true,
        onSync: actions[0],
        onConnect: actions[1],
        onDisconnect: actions[2],
        onStartScan: actions[3],
        onRequestPermission: actions[4],
      })
      expect(html).toContain('Production sync receipt detail')
      expect(html).toContain('Pending: 0')
      expect(html).toContain('Last server result/error: Accepted 1')
      actions.forEach((action) => expect(action).not.toHaveBeenCalled())
    })

    it('opens the receipt and acquisition detail without invoking operational actions', async () => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      const productionSync = vi.spyOn(ProductionV8Sync.prototype, 'run')
      const queueCalls = [
        vi.spyOn(observationQueue, 'enqueue'),
        vi.spyOn(observationQueue, 'enqueueMany'),
        vi.spyOn(observationQueue, 'claimPending'),
        vi.spyOn(observationQueue, 'acknowledgeClaims'),
        vi.spyOn(observationQueue, 'purgeAcknowledged'),
      ]
      const sender = vi.spyOn(observationBatchManager, 'process')
      const base44 = vi.spyOn(connectorObservationService, 'submitObservations')
      const fetch = vi.fn()
      vi.stubGlobal('fetch', fetch)
      const actions = [vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn(), vi.fn()]
      function ReceiptHarness() {
        const [receiptViewOpen, setReceiptViewOpen] = useState(false)
        return dashboardElement('READY', {
          syncEnabled: true,
          queueStats: emptyQueue,
          receiptAvailable: true,
          receipt: productionReceipt,
          engineeringBuild: true,
          receiptViewOpen,
          onViewReceipt: () => setReceiptViewOpen((open) => !open),
          onShareReceipt: actions[0],
          onSync: actions[1],
          onConnect: actions[2],
          onDisconnect: actions[3],
          onStartScan: actions[4],
          onRequestPermission: actions[5],
          onTestSpo2Temperature: actions[6],
        })
      }

      const container = document.createElement('div')
      document.body.append(container)
      root = createRoot(container)
      await act(async () => { root!.render(<ReceiptHarness />) })
      expect(container.textContent).toContain('Last Production Sync')
      expect(container.textContent).toContain('Last Acquisition Detail')

      await act(async () => {
        Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'View Receipt')!.click()
      })
      expect(container.querySelector('.elite-v8-receipt-json')).not.toBeNull()

      const heartRateDetail = Array.from(container.querySelectorAll('details')).find((detail) => detail.textContent?.includes('Heart Rate'))
      expect(heartRateDetail).toBeDefined()
      await act(async () => {
        heartRateDetail!.querySelector('summary')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(heartRateDetail!.open).toBe(true)
      actions.forEach((action) => expect(action).not.toHaveBeenCalled())
      expect(productionSync).not.toHaveBeenCalled()
      queueCalls.forEach((call) => expect(call).not.toHaveBeenCalled())
      expect(sender).not.toHaveBeenCalled()
      expect(base44).not.toHaveBeenCalled()
      expect(fetch).not.toHaveBeenCalled()
    })

    it('opens hydrated acquisition details and receipt during active delivery without triggering queue work', async () => {
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
      const owner = `receipt-active-delivery-${Date.now()}`
      observationQueue.setOwnerUserId(owner)
      await observationQueue.initialize()
      connectorIdentityService.setConnectorDeviceId('receipt-active-device')
      vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)

      const receiptStore = getQueueStore()
      await receiptStore.saveProductionSyncReceipt({
        ownerUserId: owner,
        syncId: productionReceipt.syncId,
        startedAt: productionReceipt.startedAt,
        completedAt: productionReceipt.completedAt,
        overallState: 'UP_TO_DATE',
        requestedMetricsJson: JSON.stringify(productionReceipt.requestedMetrics),
        receiptJson: JSON.stringify(productionReceipt),
      })
      const observation = createSyntheticObservation()
      await observationQueue.enqueue(observation)

      let finishRequest!: () => void
      let requestStarted!: () => void
      const started = new Promise<void>((resolveStarted) => { requestStarted = resolveStarted })
      const held = new Promise<void>((resolveHeld) => { finishRequest = resolveHeld })
      const submit = vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => {
        requestStarted()
        await held
        return {
          success: true,
          batchId: request.batchId,
          accepted: request.observations.length,
          duplicate: 0,
          rejected: 0,
          errors: [],
          serverTimestamp: new Date().toISOString(),
          results: request.observations.map((item) => ({
            observationId: item.observationId,
            status: 'accepted' as const,
            canonicalStatus: 'canonicalized' as const,
          })),
        }
      })
      const productionSync = vi.spyOn(ProductionV8Sync.prototype, 'run')
      const queueWrites = [
        vi.spyOn(observationQueue, 'enqueue'),
        vi.spyOn(observationQueue, 'enqueueMany'),
      ]
      const claim = vi.spyOn(observationQueue, 'claimPending')
      const acknowledge = vi.spyOn(observationQueue, 'acknowledgeClaims')
      const purge = vi.spyOn(observationQueue, 'purgeAcknowledged')
      const manager = new ObservationBatchManager({}, { isOnline: () => true, subscribe: () => () => undefined })
      const sender = vi.spyOn(manager, 'process')
      const activeDelivery = manager.process()

      try {
        await started
        const loaded = await loadProductionSyncReceipt(owner)
        expect(loaded?.syncId).toBe(productionReceipt.syncId)
        const generationDuringRequest = manager.getDeliveryDiagnostics().senderGeneration
        const claimsDuringRequest = claim.mock.calls.length
        const submitCallsDuringRequest = submit.mock.calls.length
        const senderCallsDuringRequest = sender.mock.calls.length
        const operationalActions = Array.from({ length: 7 }, () => vi.fn())

        function HydratedReceiptHarness() {
          const [receiptViewOpen, setReceiptViewOpen] = useState(false)
          return dashboardElement('READY', {
            syncEnabled: true,
            queueStats: emptyQueue,
            receiptAvailable: true,
            receipt: loaded,
            engineeringBuild: true,
            deliveryDiagnostics: manager.getDeliveryDiagnostics(),
            receiptViewOpen,
            onViewReceipt: () => setReceiptViewOpen((open) => !open),
            onShareReceipt: operationalActions[0],
            onSync: operationalActions[1],
            onConnect: operationalActions[2],
            onDisconnect: operationalActions[3],
            onStartScan: operationalActions[4],
            onRequestPermission: operationalActions[5],
            onTestSpo2Temperature: operationalActions[6],
          })
        }

        const container = document.createElement('div')
        document.body.append(container)
        root = createRoot(container)
        await act(async () => { root!.render(<HydratedReceiptHarness />) })
        expect(container.textContent).toContain('Last Production Sync')
        expect(container.textContent).toContain('Last Acquisition Detail')
        await act(async () => {
          Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'View Receipt')!.click()
        })
        expect(container.querySelector('.elite-v8-receipt-json')).not.toBeNull()

        expect(manager.getDeliveryDiagnostics()).toMatchObject({ activeWorkerCount: 1, senderGeneration: generationDuringRequest })
        expect(claim).toHaveBeenCalledTimes(claimsDuringRequest)
        expect(submit).toHaveBeenCalledTimes(submitCallsDuringRequest)
        expect(sender).toHaveBeenCalledTimes(senderCallsDuringRequest)
        expect(acknowledge).not.toHaveBeenCalled()
        expect(purge).not.toHaveBeenCalled()
        expect(queueWrites.every((spy) => spy.mock.calls.length === 0)).toBe(true)
        expect(productionSync).not.toHaveBeenCalled()
        operationalActions.forEach((action) => expect(action).not.toHaveBeenCalled())
      } finally {
        finishRequest()
        await activeDelivery
        manager.stop()
      }
    })

    it('shows unrequested metrics as NOT_REQUESTED in read-only Last Acquisition Detail', () => {
      const scopedReceipt: ProductionSyncReceipt = {
        ...productionReceipt,
        requestedMetrics: ['oxygenSaturation', 'wearableTemperature'],
        sources: productionReceipt.sources.map((source, index) => index === 0 ? {
          ...source,
          requested: false,
          status: 'NOT_REQUESTED',
          bridgeInvoked: false,
          nativeRequestAccepted: false,
          nativeCommandQueued: false,
          nativeCommandWritten: false,
          callbackReceived: false,
          acquisitionCompleted: false,
          sourceRecordCount: 0,
          observationCount: 0,
          mappedCount: 0,
          queuedCount: 0,
          deliveryPendingCount: 0,
          deliveredCount: 0,
          ackedCount: 0,
          duplicateAckedCount: 0,
          failedCount: 0,
          startedAt: null,
          completedAt: null,
        } : source),
      }
      const html = renderDashboard('READY', {
        syncEnabled: true, queueStats: emptyQueue, receiptAvailable: true, receipt: scopedReceipt,
        engineeringBuild: true,
      })

      expect(html).toContain('Last Acquisition Detail')
      expect(html).toContain('Heart Rate — NOT_REQUESTED')
      expect(html).toContain('Requested</dt><dd>No</dd>')
      expect(html).toContain('Bridge invoked</dt><dd>No</dd>')
      expect(html).toContain('Native command queued</dt><dd>No</dd>')
      expect(html).toContain('Native command written</dt><dd>No</dd>')
    })

    it('renders queue and sender diagnostics only for Engineering builds', () => {
      const deliveryDiagnostics = new ObservationBatchManager().getDeliveryDiagnostics()
      const engineeringHtml = renderDashboard('READY', { engineeringBuild: true, deliveryDiagnostics })
      const athleteHtml = renderDashboard('READY', { engineeringBuild: false, deliveryDiagnostics })

      expect(engineeringHtml).toContain('Delivery Diagnostics')
      expect(engineeringHtml).toContain('Sender active</dt><dd>No</dd>')
      expect(engineeringHtml).toContain('Sender generation</dt><dd>0</dd>')
      expect(athleteHtml).not.toContain('Delivery Diagnostics')
      expect(athleteHtml).not.toContain('Sender generation')
    })

    it('shows the concise consumer metric summary without engineering terms', () => {
      const html = renderDashboard('READY', {
        syncEnabled: true, queueStats: emptyQueue,
        syncSummary: {
          outcome: 'UP_TO_DATE', newCount: 1, errorCode: null, completedAt: null,
          metrics: [
            { metric: 'heartRate', status: 'SUCCESS' },
            { metric: 'oxygenSaturation', status: 'NO_DATA' },
            { metric: 'wearableTemperature', status: 'NO_DATA' },
          ],
        },
      })
      expect(html).toContain('Heart Rate')
      expect(html).toContain('Blood Oxygen')
      expect(html).toContain('No new data')
      expect(html).not.toMatch(/Type27|Type68|Type59|JCVITAL_NATIVE|journal|Base44/)
    })

    it('uses the consumer result label for unsuccessful metric acquisition', () => {
      const html = renderDashboard('READY', {
        syncEnabled: true, queueStats: emptyQueue,
        syncSummary: {
          outcome: 'PARTIAL', newCount: 0, errorCode: 'SOURCE_FAILED', completedAt: null,
          metrics: [{ metric: 'oxygenSaturation', status: 'FAILED' }],
        },
      })
      expect(html).toContain('Could not sync')
      expect(html).not.toContain('Needs attention')
    })

    it('keeps the progress list and receipt action inside the mobile layout contract', () => {
      const css = readFileSync(resolve(process.cwd(), 'src/App.css'), 'utf8')
      const steps = css.match(/\.elite-v8-sync-steps\s*\{([^}]*)\}/)?.[1] ?? ''
      expect(steps).toContain('flex-wrap: wrap')
      expect(steps).toContain('min-width: 0')
      expect(steps).not.toMatch(/(?:^|[^-])width:\s*\d+px|min-width:\s*[1-9]\d*px|nowrap/)
      expect(css).toMatch(/\.elite-v8-receipt-card\s*\{[^}]*min-width: 0/)
      expect(css).toMatch(/\.elite-v8-receipt-actions\s*\{[^}]*grid-template-columns: repeat\(auto-fit, minmax\(min\(100%, 180px\), 1fr\)\)/)
    })
  })
})
