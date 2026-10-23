import type { ReactNode } from 'react'
import type { JCVitalV8Battery, JCVitalV8ConnectionState, JCVitalV8Device, JCVitalV8DeviceInfo, JCVitalV8PermissionResult } from './jcvitalV8Bridge'
import { isElitePlusV8Advertisement } from './jcvitalV8Bridge'
import type { PendingQueueComposition, QueueCompositionGroup, QueueStats } from '../../services/storage/ObservationQueueStore'
import { PRODUCTION_SYNC_STAGE_LABELS, type ProductionSyncMetric, type ProductionSyncMetricState, type ProductionSyncReceipt, type ProductionSyncStage } from './ProductionV8Sync'
import { productionSyncMessage, type ProductionSyncSummary } from './ProductionSyncCopy'
import type { V8PluginStartupState } from './V8PluginBootstrap'
import type { DeliveryDiagnostics } from '../../services/sync/ObservationBatchManager'
import { IS_ENGINEERING_BUILD } from '../../buildMode'

const SYNC_STEPS: ReadonlyArray<{ stage: ProductionSyncStage; label: string; metric?: ProductionSyncMetric }> = [
  { stage: 'READING_HEART_RATE', label: 'Reading Heart Rate from V8', metric: 'heartRate' },
  { stage: 'READING_BLOOD_OXYGEN', label: 'Reading Blood Oxygen from V8', metric: 'oxygenSaturation' },
  { stage: 'READING_TEMPERATURE', label: 'Reading Temperature from V8', metric: 'wearableTemperature' },
  { stage: 'SAVING', label: 'Saved on this device' },
  { stage: 'DELIVERING', label: 'Sending to Elite+' },
]

export type ElitePlusV8DashboardProps = {
  state: JCVitalV8ConnectionState
  pluginAvailable: boolean | null
  pluginStartupState?: V8PluginStartupState
  pluginStartupError?: string | null
  devices: readonly JCVitalV8Device[]
  permission: JCVitalV8PermissionResult | null
  info: JCVitalV8DeviceInfo | null
  battery: JCVitalV8Battery | null
  lastConnectedAt: string | null
  queueStats: QueueStats | null
  busy: boolean
  /** True only while a user-started sync is actually executing; never historical or delivery-queue state. */
  syncBusy: boolean
  /** Source journal bound for the connected device and owner. */
  syncReady?: boolean
  syncError: string
  syncEnabled: boolean
  appVersion: string
  connectionOnly?: boolean
  /** Active production sync stage, or null when idle. */
  syncStage?: ProductionSyncStage | null
  /** Metrics selected for the active production sync. */
  syncMetrics?: readonly ProductionSyncMetric[] | null
  syncSummary?: ProductionSyncSummary | null
  receiptAvailable?: boolean
  receipt?: ProductionSyncReceipt | null
  deliveryDiagnostics?: DeliveryDiagnostics | null
  queueComposition?: PendingQueueComposition | null
  queueCompositionError?: string | null
  receiptViewOpen?: boolean
  engineeringBuild?: boolean
  engineeringContent?: ReactNode
  receiptStatus?: string
  onViewReceipt?: () => void
  onShareReceipt?: () => void
  onTestSpo2Temperature?: () => void
  onRequestPermission: () => void
  onStartScan: () => void
  onConnect: (device: JCVitalV8Device) => void
  onDisconnect: () => void
  onSync: () => void
}

function connectionPresentation(state: JCVitalV8ConnectionState, pluginAvailable: boolean | null, permission: JCVitalV8PermissionResult | null) {
  if (state === 'READY') return { title: 'Connected', message: 'Your Elite+ V8 is ready.', tone: 'success' }
  if (pluginAvailable === null) return { title: 'Checking device connection…', message: 'Your device status will appear here.', tone: 'pending' }
  if (pluginAvailable === false) return { title: 'Device connection unavailable', message: 'Use the Android app to connect your Elite+ V8.', tone: 'error' }
  if (permission?.status === 'BLUETOOTH_UNAVAILABLE') return { title: 'Bluetooth unavailable', message: 'Bluetooth is unavailable on this device.', tone: 'error' }
  if (permission?.status === 'BLUETOOTH_DISABLED' || permission?.bluetoothEnabled === false) {
    return { title: 'Bluetooth is turned off', message: 'Turn on Bluetooth to connect your Elite+ V8.', tone: 'error' }
  }
  if (permission?.status === 'DENIED') return { title: 'Permission required', message: 'Allow Bluetooth access to connect your Elite+ V8.', tone: 'error' }

  switch (state) {
    case 'SCANNING': return { title: 'Looking for your Elite+ V8…', message: 'Keep your device nearby.', tone: 'pending' }
    case 'CONNECTING': return { title: 'Connecting…', message: 'Keep your device nearby while we connect.', tone: 'pending' }
    case 'CONNECTED':
    case 'INITIALIZING': return { title: 'Confirming your device…', message: 'This should only take a moment.', tone: 'pending' }
    case 'ERROR': return { title: 'We couldn’t connect to your Elite+ V8.', message: 'Move closer to your device and try again.', tone: 'error' }
    case 'DISCONNECTED': return { title: 'Disconnected', message: 'Reconnect your Elite+ V8 to sync new data.', tone: 'neutral' }
  }
}

function displayTime(value: string | null | undefined): string {
  if (!value) return 'Not available'
  const timestamp = Date.parse(value)
  return Number.isNaN(timestamp) ? 'Not available' : new Date(timestamp).toLocaleString()
}

function metricLabel(metric: ProductionSyncMetric): string {
  if (metric === 'heartRate') return 'Heart Rate'
  if (metric === 'oxygenSaturation') return 'SpO₂'
  return 'Temperature'
}

function metricStatus(status: ProductionSyncMetricState): string {
  if (status === 'SUCCESS') return 'Synced'
  if (status === 'NO_DATA') return 'No new data'
  if (status === 'FAILED' || status === 'SKIPPED') return 'Could not sync'
  return status.replaceAll('_', ' ').toLowerCase()
}

type PendingMetricCategory = 'Heart Rate' | 'SpO₂' | 'Temperature' | 'Activity' | 'Sleep' | 'Other'

function pendingMetricCategory(metric: string): PendingMetricCategory {
  const normalized = metric.toLowerCase().replaceAll(/[^a-z0-9]/g, '')
  if (normalized.includes('heartrate') || normalized === 'hr' || normalized.startsWith('hr')) return 'Heart Rate'
  if (normalized.includes('spo2') || normalized.includes('oxygensaturation') || normalized.includes('bloodoxygen')) return 'SpO₂'
  if (normalized.includes('temperature') || normalized.includes('temp')) return 'Temperature'
  if (normalized.includes('activity') || normalized.includes('step') || normalized.includes('exercise')) return 'Activity'
  if (normalized.includes('sleep')) return 'Sleep'
  return 'Other'
}

function pendingMetricTotals(groups: readonly QueueCompositionGroup[]): Record<PendingMetricCategory, number> {
  const totals: Record<PendingMetricCategory, number> = {
    'Heart Rate': 0, 'SpO₂': 0, Temperature: 0, Activity: 0, Sleep: 0, Other: 0,
  }
  for (const group of groups) totals[pendingMetricCategory(group.key)] += group.count
  return totals
}

function QueueCompositionGroups({ label, groups }: { label: string; groups: readonly QueueCompositionGroup[] }) {
  return (
    <details>
      <summary>{label} · {groups.length} group(s)</summary>
      <dl>
        {groups.map(({ key, count }) => <div key={key}><dt>{key}</dt><dd>{count.toLocaleString()}</dd></div>)}
      </dl>
    </details>
  )
}

export function ElitePlusV8Dashboard({
  state, pluginAvailable, pluginStartupState = 'UNAVAILABLE', pluginStartupError = null, devices, permission, info, battery, lastConnectedAt, queueStats, busy, syncBusy, syncReady = true, syncError, syncEnabled,
  onRequestPermission, onStartScan, onConnect, onDisconnect, onSync, connectionOnly = false,
  syncStage = null, syncMetrics = null, syncSummary = null, receiptAvailable = false, receipt = null,
  deliveryDiagnostics = null, queueComposition = null, queueCompositionError = null,
  receiptViewOpen = false, engineeringBuild = false,
  engineeringContent = null,
  receiptStatus = '', onViewReceipt, onShareReceipt, onTestSpo2Temperature,
}: ElitePlusV8DashboardProps) {
  const connection = connectionPresentation(state, pluginAvailable, permission)
  const v8Devices = devices.filter(isElitePlusV8Advertisement)
  const startupBlocked = pluginStartupState !== 'READY'
  const bluetoothBlocked = permission?.status === 'BLUETOOTH_UNAVAILABLE'
  const bluetoothOff = permission?.status === 'BLUETOOTH_DISABLED' || permission?.bluetoothEnabled === false
  const permissionRequired = permission?.status === 'DENIED' || permission?.status === 'NOT_REQUESTED'
  const hasQueuedData = (queueStats?.pending ?? 0) + (queueStats?.retrying ?? 0) > 0
  const syncNeedsAttention = (queueStats?.failed ?? 0) > 0 || Boolean(syncError)
  const isSyncRunning = syncBusy || syncStage !== null
  // Background sender draining the durable queue is not a device sync and must not block starting one.
  const isDelivering = (queueStats?.inFlight ?? 0) > 0
  const showEngineering = IS_ENGINEERING_BUILD && engineeringBuild
  const showConnectionStateDetail = IS_ENGINEERING_BUILD && connectionOnly
  const canStartSync = !isSyncRunning && !busy && syncEnabled && syncReady && state === 'READY'
  const connectionActionLabel = lastConnectedAt ? 'Reconnect your Elite+ V8' : 'Connect your Elite+ V8'
  const syncLabel = syncStage ? PRODUCTION_SYNC_STAGE_LABELS[syncStage]
    : isSyncRunning ? 'Syncing your data…'
      : syncSummary ? syncSummary.outcome === 'UP_TO_DATE' && syncSummary.newCount === 0
        ? 'No new data'
        : PRODUCTION_SYNC_STAGE_LABELS[syncSummary.outcome]
        : syncNeedsAttention ? 'Could not sync'
          : isDelivering ? 'Sending saved data…'
            : !syncEnabled || queueStats === null || state !== 'READY' ? 'Connection needed'
              : hasQueuedData ? 'New data available'
                : 'Ready to sync'
  const syncCopy = syncStage ? 'Keep your Elite+ V8 nearby until sync finishes.'
    : syncSummary ? productionSyncMessage(syncSummary)
      : syncNeedsAttention ? 'Your data is saved on this device. We couldn’t sync it just now.'
        : state !== 'READY' ? 'Connect your Elite+ V8 to read new data from your device.'
          : 'Read new data from your V8, save it on this device, then send it to Elite+.'
  const visibleSyncSteps = syncMetrics
    ? SYNC_STEPS.filter((step) => step.metric && syncMetrics.includes(step.metric))
    : SYNC_STEPS.filter((step) => step.metric)
  const activeStepIndex = syncStage ? visibleSyncSteps.findIndex((step) => step.stage === syncStage) : -1
  const showRetry = pluginAvailable === true && (state === 'ERROR' || state === 'DISCONNECTED' || bluetoothOff || bluetoothBlocked || permissionRequired)

  return (
    <div className="elite-v8-dashboard">
      <header className="elite-v8-header">
        <span className="elite-v8-brand" aria-label="Elite Plus">Elite<span>+</span></span>
        <div>
          <p className="elite-v8-eyebrow">Wearable connection</p>
          <h1>Elite+ V8</h1>
        </div>
      </header>

      <section className="elite-v8-card elite-v8-device-card" aria-label="Elite+ V8 connection">
        <div className="elite-v8-device-art" aria-hidden="true"><span /></div>
        <div className="elite-v8-device-content">
          <div role="status" aria-live="polite" className={`elite-v8-connection-copy is-${connection.tone}`}>
            <strong><span className={`elite-v8-status-dot is-${connection.tone}`} aria-hidden="true" />{connection.title}</strong>
            {!connectionOnly && <span>{connection.message}</span>}
            {showConnectionStateDetail && <span>Connection state: {state}</span>}
          </div>
          {(pluginStartupState === 'FAILED' || pluginStartupState === 'UNAVAILABLE') && (
            <p className="elite-v8-error" role="alert">Unable to initialize Elite+ V8 connection</p>
          )}
          {pluginStartupError && <p className="elite-v8-error">{pluginStartupError}</p>}
          {battery?.level != null && <p className="elite-v8-battery">Battery <strong>{battery.level}%</strong></p>}
          {(info?.deviceName || info?.advertisedName) && <p>{info.deviceName || info.advertisedName}</p>}
          <p className="elite-v8-last-connected">Last connected: {lastConnectedAt ? displayTime(lastConnectedAt) : 'Not connected yet'}</p>
          {!permission && <div className="elite-v8-progress" aria-label="Checking device connection"><span /></div>}
          {permissionRequired && (
            <button type="button" className="elite-v8-button" onClick={onRequestPermission} disabled={busy || startupBlocked}>Allow Bluetooth</button>
          )}
          {showRetry && !permissionRequired && !bluetoothBlocked && !bluetoothOff && (
            <button type="button" className="elite-v8-button" onClick={onStartScan} disabled={busy || startupBlocked}>{connectionOnly ? 'Scan for Elite+ V8' : connectionActionLabel}</button>
          )}
          {(bluetoothOff || bluetoothBlocked) && (
            <button type="button" className="elite-v8-button secondary" onClick={onRequestPermission} disabled={busy || startupBlocked}>Try Again</button>
          )}
          {!['READY', 'CONNECTING', 'CONNECTED', 'INITIALIZING'].includes(state) && v8Devices.length > 0 && (
            <ul className="elite-v8-device-list" aria-label="Available Elite+ V8 devices">
              {v8Devices.map((device, index) => (
                <li key={device.id} data-device-id={device.id}>
                  <span>{v8Devices.length === 1 ? 'Elite+ V8 nearby' : `Elite+ V8 nearby · ${index + 1}`}</span>
                  <span>{device.name ?? 'Elite+ V8'}{connectionOnly && ` · ${device.id}`}</span>
                  <button type="button" className="elite-v8-button secondary" onClick={() => onConnect(device)} disabled={busy || startupBlocked}>Connect</button>
                </li>
              ))}
            </ul>
          )}
          {state === 'READY' && (
            <button type="button" className="elite-v8-button secondary" onClick={onDisconnect} disabled={busy}>Disconnect</button>
          )}
        </div>
      </section>

      {!connectionOnly && <>
      <section className="elite-v8-card elite-v8-sync-card" aria-labelledby="elite-v8-sync-title">
        <div>
          <p className="elite-v8-eyebrow">Data sync</p>
          <h2 id="elite-v8-sync-title" aria-live="polite">{syncLabel}</h2>
          <p>{syncCopy}</p>
          {syncStage && visibleSyncSteps.some((step) => step.stage === syncStage) && (
            <ol className="elite-v8-sync-steps" aria-label="Sync progress">
              {visibleSyncSteps.map((step, index) => (
                <li key={step.stage} className={index < activeStepIndex ? 'is-done' : index === activeStepIndex ? 'is-active' : ''} aria-current={index === activeStepIndex ? 'step' : undefined}>{step.label}</li>
              ))}
            </ol>
          )}
          {syncError && <p className="elite-v8-error" role="alert">We couldn’t sync your data. Please try again.</p>}
          {syncSummary?.metrics && (
            <ul className="elite-v8-metric-summary" aria-label="Sync results">
              {syncSummary.metrics.map(({ metric, status }) => (
                <li key={metric}><span>{metric === 'heartRate' ? 'Heart Rate' : metric === 'oxygenSaturation' ? 'Blood Oxygen' : 'Temperature'}</span><strong>{metricStatus(status)}</strong></li>
              ))}
            </ul>
          )}
        </div>
        <button type="button" className="elite-v8-button" onClick={onSync} disabled={!canStartSync}>
          {isSyncRunning ? 'Syncing…' : 'Sync Device Data'}
        </button>
        {showEngineering && (
          <button type="button" className="elite-v8-button secondary" onClick={onTestSpo2Temperature} disabled={!canStartSync}>
            Test SpO₂ + Temperature
          </button>
        )}
      </section>

      {showEngineering && receiptAvailable && receipt && (
        <section className="elite-v8-card elite-v8-receipt-card" aria-labelledby="elite-v8-receipt-title">
          <h2 id="elite-v8-receipt-title">Last Production Sync</h2>
          <p>Overall: {receipt.overallState ?? receipt.outcome ?? 'In progress'}</p>
          <p>Requested metrics: {receipt.requestedMetrics.map(metricLabel).join(', ') || 'None'}</p>
          <p>Started: {displayTime(receipt.startedAt)}</p>
          <p>Completed: {displayTime(receipt.completedAt)}</p>
          <dl>
            {receipt.sources.map((source) => (
              <div key={source.metric}>
                <dt>{metricLabel(source.metric)}</dt>
                <dd>{source.status}; records {source.sourceRecordCount}; observations {source.observationCount}; delivered {source.deliveredCount}</dd>
              </div>
            ))}
          </dl>
          <p>Pending: {receipt.queue.depthAfterDelivery ?? receipt.queue.depthAfterSave ?? 'Not available'}</p>
          <p>Delivered: {receipt.sources.reduce((total, source) => total + source.deliveredCount, 0)}</p>
          <p>ACKed: {receipt.sources.reduce((total, source) => total + source.ackedCount, 0)}</p>
          <p>Failed: {receipt.sources.reduce((total, source) => total + source.failedCount, 0)}</p>
          <p>Last server result/error: {receipt.errors.at(-1)?.message ?? receipt.delivery.lastServerResult ?? 'None'}</p>
          <div className="elite-v8-receipt-actions">
            <button type="button" className="elite-v8-button secondary" onClick={onViewReceipt} aria-expanded={receiptViewOpen}>View Receipt</button>
            <button type="button" className="elite-v8-button secondary" onClick={onShareReceipt} disabled={!onShareReceipt}>Share Receipt</button>
          </div>
          {receiptViewOpen && <pre className="elite-v8-receipt-json" aria-label="Production sync receipt detail">{JSON.stringify(receipt, null, 2)}</pre>}
          {receiptStatus && <p className="elite-v8-receipt-status" role="status">{receiptStatus}</p>}
        </section>
      )}
      {showEngineering && receiptAvailable && receipt && (
        <section className="elite-v8-card elite-v8-receipt-card" aria-labelledby="elite-v8-acquisition-title">
          <h2 id="elite-v8-acquisition-title">Last Acquisition Detail</h2>
          <p>Sync ID: {receipt.syncId}</p>
          {receipt.sources.map((source) => {
            const requested = source.requested || receipt.requestedMetrics.includes(source.metric)
            return (
              <details key={source.metric}>
                <summary>{metricLabel(source.metric)} — {source.status}</summary>
                <dl>
                  <div><dt>Vendor data type</dt><dd>{source.vendorDataType}</dd></div>
                  <div><dt>Requested</dt><dd>{requested ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Bridge invoked</dt><dd>{source.bridgeInvoked ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Native request accepted</dt><dd>{source.nativeRequestAccepted ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Native command queued</dt><dd>{source.nativeCommandQueued ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Native command written</dt><dd>{source.nativeCommandWritten ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Callback received</dt><dd>{source.callbackReceived ? 'Yes' : 'No'}</dd></div>
                  <div><dt>Native completion status</dt><dd>{source.nativeCompletionStatus ?? 'Not available'}</dd></div>
                  <div><dt>Source records</dt><dd>{source.sourceRecordCount}</dd></div>
                  <div><dt>Observations</dt><dd>{source.observationCount}</dd></div>
                  <div><dt>Mapped</dt><dd>{source.mappedCount}</dd></div>
                  <div><dt>Deduplicated</dt><dd>{source.deduplicatedCount}</dd></div>
                  <div><dt>Queued</dt><dd>{source.queuedCount}</dd></div>
                  <div><dt>Delivery pending</dt><dd>{source.deliveryPendingCount ?? 'Not available'}</dd></div>
                  <div><dt>Delivered</dt><dd>{source.deliveredCount}</dd></div>
                  <div><dt>ACKed</dt><dd>{source.ackedCount}</dd></div>
                  <div><dt>Duplicate ACKed</dt><dd>{source.duplicateAckedCount ?? 'Not available'}</dd></div>
                  <div><dt>Failed</dt><dd>{source.failedCount}</dd></div>
                  <div><dt>Error code</dt><dd>{source.errorCode ?? 'None'}</dd></div>
                  <div><dt>Error message</dt><dd>{source.errorMessage ?? 'None'}</dd></div>
                  <div><dt>Started</dt><dd>{displayTime(source.startedAt)}</dd></div>
                  <div><dt>Completed</dt><dd>{displayTime(source.completedAt)}</dd></div>
                </dl>
              </details>
            )
          })}
        </section>
      )}
      {showEngineering && (
        <section className="elite-v8-card elite-v8-receipt-card" aria-labelledby="elite-v8-delivery-title">
          <h2 id="elite-v8-delivery-title">Delivery Diagnostics</h2>
          <dl>
            <div><dt>Pending</dt><dd>{deliveryDiagnostics?.queueStats?.pending ?? 'Not available'}</dd></div>
            <div><dt>Claimed</dt><dd>{deliveryDiagnostics?.queueStats?.inFlight ?? 'Not available'}</dd></div>
            <div><dt>In flight</dt><dd>{deliveryDiagnostics?.queueStats?.inFlight ?? 'Not available'}</dd></div>
            <div><dt>ACKed</dt><dd>{deliveryDiagnostics?.queueStats?.acknowledged ?? 'Not available'}</dd></div>
            <div><dt>Duplicate ACKed in last batch</dt><dd>{deliveryDiagnostics?.lastBatch?.duplicateAcknowledgedCount ?? 'Not available'}</dd></div>
            <div><dt>Retryable failed</dt><dd>{deliveryDiagnostics?.queueStats?.retrying ?? 'Not available'}</dd></div>
            <div><dt>Permanent failed</dt><dd>{deliveryDiagnostics?.queueStats?.failed ?? 'Not available'}</dd></div>
            <div><dt>Oldest pending age (ms)</dt><dd>{deliveryDiagnostics?.queueStats?.oldestPendingAgeMs ?? 'Not available'}</dd></div>
            <div><dt>Oldest in-flight age (ms)</dt><dd>{deliveryDiagnostics?.queueStats?.oldestInFlightAgeMs ?? 'Not available'}</dd></div>
            <div><dt>Sender active</dt><dd>{deliveryDiagnostics ? deliveryDiagnostics.senderActive ? 'Yes' : 'No' : 'Not available'}</dd></div>
            <div><dt>Sender generation</dt><dd>{deliveryDiagnostics?.senderGeneration ?? 'Not available'}</dd></div>
            <div><dt>Last batch ID</dt><dd>{deliveryDiagnostics?.lastBatch?.batchId ?? 'Not available'}</dd></div>
            <div><dt>Last batch started</dt><dd>{displayTime(deliveryDiagnostics?.lastBatch?.startedAt)}</dd></div>
            <div><dt>Last batch completed</dt><dd>{displayTime(deliveryDiagnostics?.lastBatch?.requestCompletedAt)}</dd></div>
            <div><dt>Last accepted count</dt><dd>{deliveryDiagnostics?.lastBatch?.responseAccepted ?? 'Not available'}</dd></div>
            <div><dt>Last duplicate count</dt><dd>{deliveryDiagnostics?.lastBatch?.responseDuplicate ?? 'Not available'}</dd></div>
            <div><dt>Last failed count</dt><dd>{deliveryDiagnostics?.lastBatch?.responseRejected ?? 'Not available'}</dd></div>
            <div><dt>Last successful delivery</dt><dd>{displayTime(deliveryDiagnostics?.queueStats?.lastSuccessfulUploadAt)}</dd></div>
            <div><dt>Last delivery error</dt><dd>{deliveryDiagnostics?.lastBatch?.lastErrorMessage ?? deliveryDiagnostics?.lastBatch?.lastErrorCode ?? 'None'}</dd></div>
            <div><dt>Rolling observations/minute</dt><dd>{deliveryDiagnostics?.observationsPerMinute?.toFixed(2) ?? 'Not available'}</dd></div>
            <div><dt>Rolling batches/minute</dt><dd>{deliveryDiagnostics?.batchesPerMinute?.toFixed(2) ?? 'Not available'}</dd></div>
            <div><dt>Average batch latency (ms)</dt><dd>{deliveryDiagnostics?.averageBatchLatencyMs?.toFixed(0) ?? 'Not available'}</dd></div>
          </dl>
        </section>
      )}
      {showEngineering && (
        <section className="elite-v8-card elite-v8-receipt-card" aria-labelledby="elite-v8-queue-composition-title">
          <h2 id="elite-v8-queue-composition-title">Queue Composition · Read only</h2>
          <p>Local pending-row aggregates only. Opening this section does not enqueue, reorder, claim, deliver, or delete observations.</p>
          {queueCompositionError && <p role="alert">Queue composition unavailable: {queueCompositionError}</p>}
          {queueComposition && (() => {
            const metricTotals = pendingMetricTotals(queueComposition.byMetric)
            const currentMetricTotals = queueComposition.currentV49MetricPending
              ? pendingMetricTotals(queueComposition.currentV49MetricPending)
              : null
            const estimatedDrainMinutes = deliveryDiagnostics && (deliveryDiagnostics.observationsPerMinute ?? 0) > 0
              ? queueComposition.totalPending / deliveryDiagnostics.observationsPerMinute
              : null
            return <>
              <dl>
                <div><dt>Total pending</dt><dd>{queueComposition.totalPending.toLocaleString()}</dd></div>
                <div><dt>HR pending</dt><dd>{metricTotals['Heart Rate'].toLocaleString()}</dd></div>
                <div><dt>SpO₂ pending</dt><dd>{metricTotals['SpO₂'].toLocaleString()}</dd></div>
                <div><dt>Temperature pending</dt><dd>{metricTotals.Temperature.toLocaleString()}</dd></div>
                <div><dt>Other pending</dt><dd>{(metricTotals.Other + metricTotals.Activity + metricTotals.Sleep).toLocaleString()}</dd></div>
                <div><dt>Current v49 scoped sync pending</dt><dd>{queueComposition.currentV49SyncPending?.toLocaleString() ?? 'Not identified'}{queueComposition.currentV49SyncId ? ` · ${queueComposition.currentV49SyncId}` : ''}</dd></div>
                <div><dt>Rows ahead of v49 SpO₂/Temperature</dt><dd>{queueComposition.currentV49RowsAhead?.toLocaleString() ?? 'Not identified'}</dd></div>
                <div><dt>Heart Rate rows ahead</dt><dd>{queueComposition.heartRateRowsAheadCurrentV49?.toLocaleString() ?? 'Not identified'}</dd></div>
                <div><dt>Duplicate durable observation-ID rows</dt><dd>{queueComposition.duplicateObservationIdRows.toLocaleString()}{queueComposition.duplicateObservationIdRows === 0 ? ' · invariant holds' : ' · invariant VIOLATED'}</dd></div>
                <div><dt>Measured delivery rate</dt><dd>{deliveryDiagnostics && deliveryDiagnostics.observationsPerMinute !== undefined
                  ? `${deliveryDiagnostics.observationsPerMinute.toFixed(2)} observations/min · ${deliveryDiagnostics.batchesPerMinute?.toFixed(2) ?? '—'} batches/min · ${deliveryDiagnostics.averageBatchLatencyMs?.toFixed(0) ?? '—'} ms average batch latency`
                  : 'Not available'}</dd></div>
                <div><dt>Estimated drain (minutes)</dt><dd>{estimatedDrainMinutes === null ? 'Not available until rolling throughput is measured' : estimatedDrainMinutes.toFixed(1)}</dd></div>
              </dl>
              <details>
                <summary>Detailed queue composition</summary>
                <dl>
                  <div><dt>Current v49 SpO₂ pending</dt><dd>{currentMetricTotals?.['SpO₂'].toLocaleString() ?? 'Not identified'}</dd></div>
                  <div><dt>Current v49 Temperature pending</dt><dd>{currentMetricTotals?.Temperature.toLocaleString() ?? 'Not identified'}</dd></div>
                  <div><dt>Current v49 first position</dt><dd>{queueComposition.currentV49FirstPosition?.toLocaleString() ?? 'Not identified'}</dd></div>
                  <div><dt>Current v49 last position</dt><dd>{queueComposition.currentV49LastPosition?.toLocaleString() ?? 'Not identified'}</dd></div>
                  <div><dt>Prior sync pending</dt><dd>{queueComposition.priorSyncPending?.toLocaleString() ?? 'Not identified'}</dd></div>
                  <div><dt>Oldest pending</dt><dd>{displayTime(queueComposition.oldestPendingAt)}</dd></div>
                  <div><dt>Newest pending</dt><dd>{displayTime(queueComposition.newestPendingAt)}</dd></div>
                  <div><dt>Oldest observed</dt><dd>{displayTime(queueComposition.oldestObservedAt)}</dd></div>
                  <div><dt>Newest observed</dt><dd>{displayTime(queueComposition.newestObservedAt)}</dd></div>
                  <div><dt>Attempts 0 / 1 / 2 / 3+</dt><dd>{queueComposition.attemptCount.zero.toLocaleString()} / {queueComposition.attemptCount.one.toLocaleString()} / {queueComposition.attemptCount.two.toLocaleString()} / {queueComposition.attemptCount.threePlus.toLocaleString()}</dd></div>
                  <div><dt>Distinct durable observation IDs</dt><dd>{queueComposition.distinctObservationIds.toLocaleString()}</dd></div>
                </dl>
                <QueueCompositionGroups label="By metric" groups={queueComposition.byMetric} />
                <QueueCompositionGroups label="By vendorDataType" groups={queueComposition.byVendorDataType} />
                <QueueCompositionGroups label="By sync_id" groups={queueComposition.bySyncId} />
                <QueueCompositionGroups label="By acquisition_id" groups={queueComposition.byAcquisitionId} />
                <QueueCompositionGroups label="By requested_metric" groups={queueComposition.byRequestedMetric} />
              </details>
            </>
          })()}
        </section>
      )}
      {showEngineering && receiptStatus && !receiptAvailable && (
        <p className="elite-v8-receipt-status" role="status">{receiptStatus}</p>
      )}
      {showEngineering && engineeringContent}

      <section className="elite-v8-section" aria-labelledby="elite-v8-data-title">
        <div className="elite-v8-section-heading">
          <div>
            <h2 id="elite-v8-data-title">Your health data</h2>
          </div>
        </div>
        <ul className="elite-v8-data-grid">
          <li><span className="elite-v8-data-icon" aria-hidden="true" />Heart Rate</li>
          <li><span className="elite-v8-data-icon" aria-hidden="true" />Blood Oxygen</li>
          <li><span className="elite-v8-data-icon" aria-hidden="true" />Temperature</li>
        </ul>
      </section>

      {!connectionOnly && (
        <p className="elite-v8-last-sync">
          Last successful sync: {queueStats?.lastSuccessfulUploadAt ? displayTime(queueStats.lastSuccessfulUploadAt) : 'Not synced yet'}
        </p>
      )}
      </>}
    </div>
  )
}
