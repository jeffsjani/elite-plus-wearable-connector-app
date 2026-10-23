import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Capacitor } from '@capacitor/core'
import {
  JCVitalV8,
  isElitePlusV8Advertisement,
  type JCVitalV8Battery,
  type JCVitalV8ConnectionState,
  type JCVitalV8Device,
  type JCVitalV8DeviceInfo,
  type JCVitalV8HistoricalSyncResult,
  type JCVitalV8PermissionResult,
} from './jcvitalV8Bridge'
import { connectAndBindJournal, startDiscovery } from './ConnectionLifecycle'
import { ElitePlusV8Dashboard } from './ElitePlusV8Dashboard'
import type { ProductionSyncSummary } from './ProductionSyncCopy'
import {
  loadProductionSyncReceipt,
  ProductionV8Sync,
  storeProductionSyncReceipt,
  type ProductionSyncOwners,
  type ProductionSyncMetric,
  type ProductionSyncReceipt,
  type ProductionSyncStage,
} from './ProductionV8Sync'
import { productionSyncLedger } from './ProductionSyncLedger'
import { exportProductionSyncReceipt } from './ProductionSyncReceiptExport'
import { WorkoutHrDeliveryService } from './WorkoutHrDelivery'
import { V8PhysicalSemanticTests } from '@v8-physical-semantic-tests'
import type { Type42ConnectedContext } from './Type42Certification'
import type { LiveWorkoutStatus } from './WorkoutTelemetry'
import { observationBatchManager, type DeliveryDiagnostics } from '../../services/sync/ObservationBatchManager'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { jcvitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'
import type { PendingQueueComposition, QueueStats } from '../../services/storage/ObservationQueueStore'
import { crashBreadcrumbs } from '../../services/diagnostics/CrashBreadcrumbs'
import { useV8JournalBinding, useV8PluginStartup } from './V8PluginBootstrap'
import { IS_ACTIVITY_V2_PRODUCTION_VERIFICATION_BUILD, IS_ENGINEERING_BUILD } from '../../buildMode'
import { ActivityV2ProductionVerification } from './ActivityV2ProductionVerification'
import { SettingsDiagnosticsContext } from '../../wellness/SettingsDiagnosticsContext'
import { JCVitalActivityCanonicalization, canonicalizeAcquiredActivity, indexedDbActivityLedgerStore } from './ActivityCanonicalization'
import { activityV2SourcesFromNative, enqueueActivityNativeTransportV2 } from './ActivityNativeTransportV2Delivery'
import type { ActivityDeviceContext } from './ActivityProductionCanonical'
import { activityV2CapabilityStore } from '../../services/base44/ActivityV2Capability'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { installationIdentityService } from '../../services/storage/InstallationIdentityService'

type Props = {
  onCompanionStatus?: (status: CompanionV8Status) => void
  ownerUserId: string
  onSync: () => void
  syncBusy: boolean
  syncError: string
  syncEnabled: boolean
  appVersion: string
  appVersionCode: number
  connectionOnly?: boolean
  /** Build 32B: when provided, Sync Device Data runs the production acquire → enqueue → deliver flow. */
  getSyncOwners?: () => ProductionSyncOwners
  onSyncFinished?: (receipt: ProductionSyncReceipt) => void
}
export type CompanionV8Status = {
  connected: boolean
  lastSync: string | null
  syncing: boolean
  needsAttention: boolean
}

function summarize(receipt: ProductionSyncReceipt): ProductionSyncSummary | null {
  if (!receipt.outcome) return null
  return {
    outcome: receipt.outcome,
    newCount: receipt.totals.new,
    errorCode: receipt.errors[0]?.code ?? null,
    completedAt: receipt.completedAt,
    metrics: receipt.sources.filter((source) => receipt.requestedMetrics.includes(source.metric))
      .map(({ metric, status }) => ({ metric, status })),
  }
}

export function JCVitalV8Panel({
  ownerUserId, onSync, syncBusy, syncError, syncEnabled, appVersion, appVersionCode, connectionOnly = false, getSyncOwners, onSyncFinished, onCompanionStatus,
}: Props) {
  const settingsDiagnosticsHost = useContext(SettingsDiagnosticsContext)
  const ownerRef = useRef(ownerUserId)
  const connectionContext = useMemo(() => ({ accountId: ownerUserId, generation: 0 }), [ownerUserId])
  const startup = useV8PluginStartup()
  const { authenticatedOwner, binding, setBinding } = useV8JournalBinding()
  const pluginAvailable = startup.state === 'READY' ? startup.adapterAvailable : null
  const [connectionUiReady, setConnectionUiReady] = useState(false)
  const [state, setState] = useState<JCVitalV8ConnectionState>('DISCONNECTED')
  const [permission, setPermission] = useState<JCVitalV8PermissionResult | null>(null)
  const [devices, setDevices] = useState<JCVitalV8Device[]>([])
  const [info, setInfo] = useState<JCVitalV8DeviceInfo | null>(() => binding?.scope.accountId === ownerUserId ? binding.info : null)
  const [battery, setBattery] = useState<JCVitalV8Battery | null>(null)
  const [lastConnectedAt, setLastConnectedAt] = useState<string | null>(null)
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null)
  const [deliveryDiagnostics, setDeliveryDiagnostics] = useState<DeliveryDiagnostics>(() => observationBatchManager.getDeliveryDiagnostics())
  const [queueComposition, setQueueComposition] = useState<PendingQueueComposition | null>(null)
  const [queueCompositionError, setQueueCompositionError] = useState<string | null>(null)
  const [queueReadFailed, setQueueReadFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [activitySyncStatus, setActivitySyncStatus] = useState('')
  const activitySyncRunningRef = useRef(false)
  const deliveryRef = useRef<WorkoutHrDeliveryService | null>(null)
  const journalScope = binding?.scope ?? null
  const clearJournalBinding = useCallback(() => setBinding(null), [setBinding])
  const connectedDeviceRef = useRef<JCVitalV8Device | null>(binding?.device ?? null)
  const [physicalSemanticTestActive, setPhysicalSemanticTestActive] = useState(false)
  const physicalSemanticTestActiveRef = useRef(false)
  const [workoutStatus, setWorkoutStatus] = useState<LiveWorkoutStatus>('IDLE')
  const physicalTestContext: Type42ConnectedContext | null = journalScope && info ? {
    scope: journalScope,
    bleAddress: info.macAddress ?? info.deviceId,
    firmwareVersion: info.firmwareVersion ?? null,
    sdkVersion: info.sdkVersion,
    ready: state === 'READY',
    physical: Capacitor.isNativePlatform(),
    native: Capacitor.isNativePlatform(),
  } : null
  const [syncStage, setSyncStage] = useState<ProductionSyncStage | null>(null)
  const [syncMetrics, setSyncMetrics] = useState<readonly ProductionSyncMetric[] | null>(null)
  // Mirrors ProductionV8Sync.run() executing for this panel; never derived from receipts, queue or delivery state.
  const [productionSyncActive, setProductionSyncActive] = useState(false)
  const journalReady = Boolean(journalScope && journalScope.accountId === ownerUserId && ownerUserId === authenticatedOwner)
  const [lastReceipt, setLastReceipt] = useState<ProductionSyncReceipt | null>(null)
  const [receiptViewOpen, setReceiptViewOpen] = useState(false)
  const [receiptStatus, setReceiptStatus] = useState('')
  const [syncSummary, setSyncSummary] = useState<ProductionSyncSummary | null>(null)
  useEffect(() => {
    onCompanionStatus?.({
      connected: state === 'READY',
      lastSync: queueStats?.lastSuccessfulUploadAt ?? (lastReceipt?.outcome === 'UP_TO_DATE' ? lastReceipt.completedAt : null),
      syncing: productionSyncActive || deliveryDiagnostics.senderActive,
      needsAttention: queueReadFailed || Boolean(syncError) || state === 'ERROR'
        || Boolean(queueStats?.canonicalRecoveryRequired)
        || (queueStats ? queueStats.pending + queueStats.retrying + queueStats.failed > 0 : false),
    })
  }, [state, queueStats, lastReceipt, productionSyncActive, deliveryDiagnostics, queueReadFailed, syncError, onCompanionStatus])
  const productionSync = useMemo(() => new ProductionV8Sync({
    bridge: JCVitalV8,
    queue: observationQueue,
    delivery: observationBatchManager,
    ledger: productionSyncLedger,
    resolveDeviceScopeId: (bleAddress) => jcvitalDeviceIdentityService.resolve(bleAddress),
    allowMetricSubset: IS_ENGINEERING_BUILD,
    storeReceipt: storeProductionSyncReceipt,
  }), [])
  const activityCanonical = useMemo(() => new JCVitalActivityCanonicalization({
    owner: () => observationQueue.getOwnerUserId(),
    resolveDeviceId: (bleAddress) => jcvitalDeviceIdentityService.resolve(bleAddress),
    store: indexedDbActivityLedgerStore,
  }), [])

  useEffect(() => {
    ownerRef.current = ownerUserId
  }, [ownerUserId])

  useEffect(() => {
    if (!IS_ENGINEERING_BUILD) return
    let active = true
    let failureRecorded = false
    const currentV49SyncId = lastReceipt?.versionCode === 49 ? lastReceipt.syncId : null
    const refreshComposition = () => {
      void observationQueue.getPendingComposition(currentV49SyncId).then((composition) => {
        if (!active) return
        setQueueComposition(composition)
        setQueueCompositionError(null)
        failureRecorded = false
      }).catch((error: unknown) => {
        if (!active) return
        setQueueComposition(null)
        setQueueCompositionError(error instanceof Error ? error.message : String(error))
        if (!failureRecorded) {
          failureRecorded = true
          crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Reading read-only queue composition')
        }
      })
    }
    refreshComposition()
    const timer = window.setInterval(refreshComposition, 30_000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [ownerUserId, lastReceipt?.syncId, lastReceipt?.versionCode])

  useEffect(() => {
    let active = true
    setLastReceipt(null)
    setReceiptViewOpen(false)
    void loadProductionSyncReceipt(ownerUserId).then((receipt) => {
      if (active) setLastReceipt(receipt)
    }).catch((error: unknown) => {
      if (!active) return
      setReceiptStatus('Saved production sync receipt couldn’t be loaded.')
      crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Loading saved production sync receipt')
    })
    return () => { active = false }
  }, [ownerUserId])

  useEffect(() => {
    if (startup.state !== 'READY') return
    let active = true
    const listeners = [
      JCVitalV8.addListener('jcvitalScanResult', (device) => {
        if (!isElitePlusV8Advertisement(device)) return
        setDevices((current) => [device, ...current.filter((item) => item.id !== device.id)]
          .sort((a, b) => Number(b.advertisesJcvitalService) - Number(a.advertisesJcvitalService) || b.rssi - a.rssi))
      }),
      JCVitalV8.addListener('jcvitalConnectionState', (event) => {
        setState(event.state)
        if (event.state === 'READY') setLastConnectedAt(event.timestamp)
        if (event.state === 'DISCONNECTED' || event.state === 'ERROR') clearJournalBinding()
      }),
      JCVitalV8.addListener('jcvitalDeviceInfo', setInfo),
      JCVitalV8.addListener('jcvitalBattery', setBattery),
      JCVitalV8.addListener('jcvitalError', (event) => {
        if (event.state === 'ERROR') setState('ERROR')
      }),
    ]
    void Promise.all(listeners).then(async () => {
      const [connection, permissions, discovered] = await Promise.all([
        JCVitalV8.getConnectionState(), JCVitalV8.getPermissionStatus(), JCVitalV8.getDiscoveredDevices(),
      ])
      if (active) {
        setState(connection.state)
        setPermission(permissions)
        setDevices(discovered.devices.filter(isElitePlusV8Advertisement))
        setConnectionUiReady(true)
      }
    }).catch((error) => {
      if (active) crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'V8 connection state restore')
    })
    return () => {
      active = false
      listeners.forEach((listener) => {
        void listener.then((handle) => handle.remove()).catch((error: unknown) => {
          crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Removing Elite+ V8 listener')
        })
      })
    }
  }, [startup.state, clearJournalBinding])

  useEffect(() => {
    return () => {
      connectionContext.generation++
    }
  }, [connectionContext])

  useEffect(() => {
    let active = true
    let failureRecorded = false
    const refresh = () => {
      void observationQueue.getQueueStats().then((stats) => {
        if (!active) return
        failureRecorded = false
        setQueueStats(stats)
        setDeliveryDiagnostics(observationBatchManager.getDeliveryDiagnostics())
        setQueueReadFailed(false)
      }).catch((error: unknown) => {
        if (!active) return
        setQueueStats(null)
        setQueueReadFailed(true)
        if (!failureRecorded) {
          failureRecorded = true
          crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Reading saved sync status')
        }
      })
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => {
      active = false
      window.clearInterval(timer)
    }
  }, [ownerUserId])

  useEffect(() => {
    if (startup.state !== 'READY') return
    const delivery = new WorkoutHrDeliveryService({
      queue: observationQueue,
      deliver: () => observationBatchManager.process(),
      subscribe: (listener) => observationBatchManager.subscribe(listener),
      resolveDeviceId: (bleAddress) => jcvitalDeviceIdentityService.resolve(bleAddress),
    })
    deliveryRef.current = delivery
    delivery.start()
    const listeners = [
      JCVitalV8.addListener('jcvitalWorkoutState', (session) => {
        setWorkoutStatus(session.status)
        delivery.setContext({
          bleAddress: session.deviceId,
          firmwareVersion: session.firmwareVersion,
          sdkVersion: session.sdkVersion,
          vendorActivityMode: session.vendorActivityMode,
        })
        if (!physicalSemanticTestActiveRef.current
          && ['IDLE', 'STOPPED', 'ERROR', 'DISCONNECTED'].includes(session.status) && session.status !== 'IDLE') {
          void delivery.handleWorkoutEnded(session.sessionId)
        }
      }),
      JCVitalV8.addListener('jcvitalWorkoutHeartRate', (event) => {
        if (!physicalSemanticTestActiveRef.current) delivery.handleHeartRate(event)
      }),
    ]
    return () => {
      listeners.forEach((listener) => {
        void listener.then((handle) => handle.remove()).catch((error: unknown) => {
          crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Removing workout HR listener')
        })
      })
      delivery.dispose()
      deliveryRef.current = null
    }
  }, [startup.state])

  useEffect(() => {
    if (info) {
      deliveryRef.current?.setContext({
        bleAddress: info.macAddress ?? info.deviceId,
        firmwareVersion: info.firmwareVersion ?? null,
        sdkVersion: info.sdkVersion,
      })
    }
  }, [info])

  async function runConnectionAction(action: () => Promise<void>): Promise<void> {
    setBusy(true)
    try {
      if (startup.state !== 'READY' || !connectionUiReady) throw new Error('V8 native plugin is not ready.')
      await action()
    } catch (error) {
      setState('ERROR')
      crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Elite+ V8 connection action')
    } finally {
      setBusy(false)
    }
  }

  async function startScanWithPermission(): Promise<void> {
    const result = await JCVitalV8.requestPermissions()
    setPermission(result)
    if (result.status === 'AUTHORIZED' && result.bluetoothEnabled) {
      setDevices([])
      await startDiscovery(JCVitalV8, ownerUserId)
    }
  }

  async function connectDevice(device: JCVitalV8Device): Promise<void> {
    if (!authenticatedOwner || ownerUserId !== authenticatedOwner) throw new Error('OWNER_SCOPE_MISMATCH')
    setInfo(null)
    setBattery(null)
    const generation = connectionContext.generation
    const connected = await connectAndBindJournal(
      JCVitalV8,
      ownerUserId,
      device.id,
      (address) => jcvitalDeviceIdentityService.resolve(address),
      () => ownerRef.current === ownerUserId && connectionContext.generation === generation,
    )
    setBinding({ scope: connected.scope, info: connected.info, device })
    connectedDeviceRef.current = device
    setInfo(connected.info)
  }

  /** Sole entry point to ProductionV8Sync.run(); invoked only from explicit button clicks. */
  async function runProductionSync(metrics?: readonly ('heartRate' | 'oxygenSaturation' | 'wearableTemperature')[]): Promise<void> {
    if (!getSyncOwners || productionSync.isRunning()) return
    setReceiptStatus('')
    setProductionSyncActive(true)
    setSyncMetrics(metrics ?? ['heartRate', 'oxygenSaturation', 'wearableTemperature'])
    setSyncStage('CHECKING')
    try {
      const device = connectedDeviceRef.current
      const receipt = await productionSync.run({
        appVersion,
        versionCode: appVersionCode,
        owners: getSyncOwners(),
        journalScope,
        device: {
          bleDeviceId: device?.id ?? null,
          name: device?.name ?? null,
          firmwareVersion: info?.firmwareVersion ?? null,
          sdkVersion: info?.sdkVersion ?? null,
        },
        ...(metrics ? { metrics } : {}),
        onProgress: (stage) => {
          if (['UP_TO_DATE', 'PARTIAL', 'PENDING_DELIVERY', 'BLOCKED', 'FAILED'].includes(stage)) return
          setSyncStage(stage)
        },
      })
      setLastReceipt(receipt)
      setSyncSummary(summarize(receipt))
      onSyncFinished?.(receipt)
    } catch (error) {
      crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Elite+ V8 production sync')
    } finally {
      setSyncStage(null)
      setSyncMetrics(null)
      setProductionSyncActive(false)
    }
  }

  async function runActivityProductionSync(): Promise<void> {
    if (!getSyncOwners || activitySyncRunningRef.current || productionSync.isRunning() || !journalScope || !info) return
    activitySyncRunningRef.current = true
    setBusy(true)
    setActivitySyncStatus('')
    try {
      const owners = getSyncOwners()
      if (!journalReady || owners.authenticatedOwnerUserId !== ownerUserId
        || owners.persistedConnectorOwnerUserId !== ownerUserId
        || observationQueue.getOwnerUserId() !== ownerUserId) {
        throw new Error('Activity sync requires matching authenticated, connector, journal, and queue owners.')
      }
      if (state !== 'READY' || !Capacitor.isNativePlatform()) {
        throw new Error('Activity sync requires a connected physical Android V8.')
      }
      const acquired = await JCVitalV8.syncActivityCertification()
      if (!acquired.acquisitionSessionId || acquired.results.length !== 2
        || acquired.results.some((result, index) => result.vendorDataType !== String(24 + index)
          || !['COMPLETE', 'EMPTY_VALID'].includes(result.completionStatus))) {
        throw new Error('Activity history did not return a complete Type24 then Type25 acquisition.')
      }
      const connected = {
        scope: journalScope,
        bleAddress: info.macAddress ?? info.deviceId,
        firmwareVersion: info.firmwareVersion ?? null,
        sdkVersion: info.sdkVersion,
        ready: true,
        physical: true,
        native: true,
      }
      const ingests = await canonicalizeAcquiredActivity(activityCanonical, journalScope, connected, acquired.results)
      if (ingests.some((ingest) => ingest.status === 'FAILED' || ingest.status === 'SKIPPED')) {
        throw new Error(`Activity source was not fully retained in the local canonical ledger: ${ingests.map((ingest) => ingest.reason).filter(Boolean).join('; ')}`)
      }

      const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
      const capabilityScope = {
        ownerUserId,
        installId: installationIdentityService.getInstallId(),
        connectorDeviceId: connectorDeviceId ?? '',
      }
      if (!connectorDeviceId || !activityV2CapabilityStore.isEnabled(capabilityScope)) {
        const decision = activityV2CapabilityStore.getDecision(capabilityScope)
        setActivitySyncStatus(`Activity source records saved locally with legacy NATIVE_ONLY behavior; v2 delivery is disabled (${decision.reason}).`)
        return
      }

      const native = acquired.results.flatMap((result: JCVitalV8HistoricalSyncResult) => result.observations)
      const nativeModel = native.find((observation) => observation.source.deviceModel)?.source.deviceModel
      const context: ActivityDeviceContext = {
        ownerUserId,
        deviceId: journalScope.deviceScopeId,
        deviceModel: nativeModel ?? null,
        firmwareVersion: connected.firmwareVersion,
        sdkVersion: connected.sdkVersion,
      }
      const projected = await enqueueActivityNativeTransportV2(
        activityV2SourcesFromNative(native), context, observationQueue,
        activityV2CapabilityStore.isEnabled(capabilityScope),
      )
      if (observationQueue.getOwnerUserId() !== ownerUserId) {
        throw new Error('Authenticated queue owner changed during Activity v2 delivery.')
      }
      await observationBatchManager.process()
      setActivitySyncStatus(`Activity v2: ${projected.sourceRecordCount} saved source records projected; ${projected.insertedCount} queued; ${projected.duplicateCount} already queued through the existing sender.`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setActivitySyncStatus(`Activity sync failed: ${message}`)
      crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Elite+ V8 production Activity sync')
    } finally {
      activitySyncRunningRef.current = false
      setBusy(false)
    }
  }

  async function exportReceipt(): Promise<void> {
    if (!lastReceipt) return
    try {
      const summary = await exportProductionSyncReceipt(lastReceipt)
      setReceiptStatus(summary)
    } catch (error) {
      setReceiptStatus('Sync receipt couldn’t be shared. Please try again.')
      crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Exporting sync receipt')
    }
  }

  function setPhysicalTestActive(active: boolean): void {
    physicalSemanticTestActiveRef.current = active
    setPhysicalSemanticTestActive(active)
  }

  const workoutActive = ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'].includes(workoutStatus)
  const physicalTestOwners = getSyncOwners?.()
  const activityV2Verification = IS_ACTIVITY_V2_PRODUCTION_VERIFICATION_BUILD
    && journalReady && journalScope && info && state === 'READY'
    ? <ActivityV2ProductionVerification
      ownerUserId={ownerUserId}
      scope={journalScope}
      onBusyChange={setBusy}
      device={{
        deviceId: journalScope.deviceScopeId,
        deviceModel: 'PRO_V8',
        firmwareVersion: info.firmwareVersion ?? null,
        sdkVersion: info.sdkVersion,
      }}
    />
    : null

  return <>
    <ElitePlusV8Dashboard
      state={state}
      pluginAvailable={pluginAvailable}
      pluginStartupState={startup.state}
      pluginStartupError={IS_ENGINEERING_BUILD ? startup.error : null}
      devices={devices}
      permission={permission}
      info={info}
      battery={battery}
      lastConnectedAt={lastConnectedAt}
      queueStats={queueStats}
      busy={busy || startup.state !== 'READY' || !connectionUiReady}
      syncBusy={getSyncOwners ? productionSyncActive : syncBusy}
      syncReady={getSyncOwners ? journalReady : true}
      syncError={syncError || (queueReadFailed ? 'saved sync status unavailable' : '')}
      syncEnabled={syncEnabled}
      appVersion={appVersion}
      connectionOnly={connectionOnly}
      onRequestPermission={() => void runConnectionAction(startScanWithPermission)}
      onStartScan={() => void runConnectionAction(startScanWithPermission)}
      onConnect={(device) => void runConnectionAction(() => connectDevice(device))}
      onDisconnect={() => void runConnectionAction(async () => { clearJournalBinding(); await JCVitalV8.disconnect() })}
      onSync={getSyncOwners ? () => void runProductionSync() : onSync}
      syncStage={syncStage}
      syncMetrics={syncMetrics}
      syncSummary={syncSummary}
      receiptAvailable={Boolean(lastReceipt)}
      receipt={lastReceipt}
      deliveryDiagnostics={deliveryDiagnostics}
      queueComposition={queueComposition}
      queueCompositionError={queueCompositionError}
      receiptViewOpen={receiptViewOpen}
      engineeringBuild={IS_ENGINEERING_BUILD}
      engineeringContent={IS_ENGINEERING_BUILD ? <V8PhysicalSemanticTests
        context={physicalTestContext}
        ownerUserId={ownerUserId}
        eligibility={{
          ready: state === 'READY',
          authenticatedOwner,
          connectorOwner: physicalTestOwners?.persistedConnectorOwnerUserId ?? null,
          journalScope,
          sourceJournalBound: Boolean(binding),
          connectionBusy: busy,
          productionSyncActive,
          physicalTestActive: physicalSemanticTestActive,
          workoutControlAvailable: typeof JCVitalV8.startWorkoutCapture === 'function' && typeof JCVitalV8.stopWorkoutCapture === 'function',
        }}
        setBusy={setBusy}
        workoutActive={workoutActive}
        onTestActiveChange={setPhysicalTestActive}
      /> : null}
      receiptStatus={receiptStatus}
      onViewReceipt={() => setReceiptViewOpen((open) => !open)}
      onShareReceipt={() => void exportReceipt()}
      onTestSpo2Temperature={() => void runProductionSync(['oxygenSaturation', 'wearableTemperature'])}
    />
    {getSyncOwners && journalReady && state === 'READY' && !connectionOnly && <section className="elite-v8-card" aria-label="Activity sync">
      <h2>Activity</h2>
      <p>Sync daily and detailed activity from your connected Elite+ V8.</p>
      <button type="button" className="elite-v8-button" disabled={busy || productionSyncActive} onClick={() => void runActivityProductionSync()}>
        {busy ? 'Syncing Activity…' : 'Sync Activity'}
      </button>
      {activitySyncStatus && <p role="status">{activitySyncStatus}</p>}
    </section>}
    {settingsDiagnosticsHost && activityV2Verification
      ? createPortal(activityV2Verification, settingsDiagnosticsHost) : null}
  </>
}

export default JCVitalV8Panel
