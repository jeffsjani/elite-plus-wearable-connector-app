import { App as CapacitorApp } from '@capacitor/app'
import { useEffect, useRef, useState } from 'react'
import { ConnectionDiagnosticSummary, JournalStoragePressure, JournalCapacitySummary, exportJournalCapacityAnalysis, exportConnectionDiagnostic, type DiagnosticExportMethod } from './ConnectionDiagnosticExport'
import { startDiscovery } from './ConnectionLifecycle'
import {
  createDomPanelDriver, REFERENCE_V8, runConnectionDiagnostic,
  type ConnectionDiagnosticReport, type DiagnosticEvent, type NativeConnectionDiagnosticSnapshot, type JournalCapacityAnalysis, type OfflineJournalInspection,
} from './ConnectionDiagnostic'
import { isElitePlusV8Advertisement, JCVitalV8 } from './jcvitalV8Bridge'
import { useV8PluginStartup } from './V8PluginBootstrap'

export interface ConnectionDiagnosticPanelProps {
  ownerUserId: string
  appVersion: string
  versionCode: number
  platform: string
}

const yesNo = (value: boolean | null | undefined) => value == null ? 'Unknown' : value ? 'Yes' : 'No'

function permissionText(snapshot: NativeConnectionDiagnosticSnapshot | null, key: keyof NativeConnectionDiagnosticSnapshot['android']['permissions']) {
  const permission = snapshot?.android.permissions[key]
  if (!permission) return 'Unknown'
  if (!permission.requiredOnThisSdk) return `Not required on SDK ${snapshot.android.sdkInt}`
  return `${permission.granted ? 'Granted' : 'NOT granted'} · manifest ${permission.declaredInManifest == null ? 'unknown' : permission.declaredInManifest ? 'declared' : 'MISSING'}`
}

const hasEvent = (snapshot: NativeConnectionDiagnosticSnapshot | null, name: string) =>
  Boolean(snapshot?.trace.events.some((event) => event.event === name))

export function ConnectionDiagnosticPanel({ ownerUserId, appVersion, versionCode, platform }: ConnectionDiagnosticPanelProps) {
  const startup = useV8PluginStartup()
  const [snapshot, setSnapshot] = useState<NativeConnectionDiagnosticSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState('')
  const [lifecycle, setLifecycle] = useState(() => typeof document === 'undefined' ? 'unknown' : document.visibilityState)
  const [connect, setConnect] = useState(true)
  const [busy, setBusy] = useState(false)
  const [report, setReport] = useState<ConnectionDiagnosticReport | null>(null)
  const [exportStatus, setExportStatus] = useState('')
  const [exportBusy, setExportBusy] = useState(false)
  const [capacity, setCapacity] = useState<JournalCapacityAnalysis | null>(null)
  const [capacityBusy, setCapacityBusy] = useState(false)
  const [capacityStatus, setCapacityStatus] = useState('')
  const [offline, setOffline] = useState<OfflineJournalInspection | null>(null)
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [offlineStatus, setOfflineStatus] = useState('')
  const lifecycleRef = useRef(lifecycle)
  const priorEvents = useRef<DiagnosticEvent[]>([])
  const productionMounted = useRef<boolean | null>(null)
  const record = (event: string, detail: Record<string, unknown> = {}) => {
    priorEvents.current = [...priorEvents.current.slice(-199), { at: new Date().toISOString(), source: 'js', event, detail }]
  }

  useEffect(() => {
    if (startup.state !== 'READY') return
    record('APP_AUTHENTICATED')
    record('CONNECTION_DIAGNOSTIC_PANEL_MOUNTED')
    let active = true
    const visibility = () => {
      lifecycleRef.current = document.visibilityState
      setLifecycle(document.visibilityState)
      record('APP_LIFECYCLE', { state: document.visibilityState })
    }
    document.addEventListener('visibilitychange', visibility)
    const appState = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      const state = isActive ? 'active' : 'background'
      lifecycleRef.current = state
      if (active) setLifecycle(state)
      record('APP_LIFECYCLE', { state })
    }).catch((error: unknown) => {
      record('APP_LIFECYCLE_LISTENER_FAILED', { message: error instanceof Error ? error.message : String(error) })
      return null
    })
    const driver = createDomPanelDriver()
    const poll = async () => {
      const mounted = driver.probe().mounted
      if (productionMounted.current !== mounted) {
        productionMounted.current = mounted
        record(mounted ? 'CONNECTION_PANEL_MOUNTED' : 'CONNECTION_PANEL_UNMOUNTED')
      }
      try {
        const next = await JCVitalV8.getConnectionDiagnosticSnapshot()
        if (active) { setSnapshot(next); setSnapshotError('') }
      } catch (error) {
        if (active) setSnapshotError(error instanceof Error ? error.message : String(error))
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 2000)
    return () => {
      active = false
      window.clearInterval(timer)
      document.removeEventListener('visibilitychange', visibility)
      record('CONNECTION_DIAGNOSTIC_PANEL_UNMOUNTED')
      if (productionMounted.current) record('CONNECTION_PANEL_UNMOUNTED')
      void appState.then((handle) => handle?.remove())
    }
  }, [startup.state])

  async function run(): Promise<void> {
    setBusy(true)
    setExportStatus('')
    try {
      if (startup.state !== 'READY') throw new Error('V8 native plugin is not ready.')
      const next = await runConnectionDiagnostic({
        bridge: JCVitalV8,
        panel: createDomPanelDriver(),
        now: () => Date.now(),
        sleep: (ms) => new Promise((resolve) => window.setTimeout(resolve, ms)),
        appLifecycle: () => lifecycleRef.current,
        platform,
        authenticated: Boolean(ownerUserId),
        appVersion,
        versionCode,
        startDiscovery: () => startDiscovery(JCVitalV8, ownerUserId),
        priorEvents: priorEvents.current,
      }, { connect })
      setReport(next)
      try {
        setSnapshot(await JCVitalV8.getConnectionDiagnosticSnapshot())
      } catch (error) {
        setSnapshotError(error instanceof Error ? error.message : String(error))
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      record('DIAGNOSTIC_RUN_FAILED', { message })
      setExportStatus(`Diagnostic failed: ${message}`)
    } finally {
      setBusy(false)
    }
  }

  async function exportJson(method: DiagnosticExportMethod): Promise<void> {
    if (!report) return
    setExportBusy(true)
    setExportStatus('')
    try {
      setExportStatus(await exportConnectionDiagnostic(report, method))
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? `${String(error.code)}: ` : ''
      setExportStatus(`${method} failed: ${code}${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setExportBusy(false)
    }
  }

  async function analyzeCapacity(): Promise<void> {
    setCapacityBusy(true)
    setCapacity(null)
    setCapacityStatus('')
    try {
      setCapacity(await JCVitalV8.getJournalCapacityAnalysis())
    } catch (error) {
      setCapacityStatus(`Capacity analysis failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCapacityBusy(false)
    }
  }

  async function analyzeOffline(): Promise<void> {
    setOfflineBusy(true)
    setOffline(null)
    setOfflineStatus('')
    try {
      setOffline(await JCVitalV8.analyzeExistingJournalOffline())
    } catch (error) {
      setOfflineStatus(`Offline inspection failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setOfflineBusy(false)
    }
  }

  async function exportCapacity(method: 'copy' | 'save'): Promise<void> {
    if (!capacity) return
    setCapacityBusy(true)
    setCapacityStatus('')
    try {
      setCapacityStatus(await exportJournalCapacityAnalysis(capacity, method))
    } catch (error) {
      setCapacityStatus(`Capacity ${method} failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setCapacityBusy(false)
    }
  }

  const trace = snapshot?.trace
  const journal = snapshot?.journalHandshake
  const pressure = journal?.journalPressure
  const recoveredAt = (journal?.latestRecoveryAudit ?? journal?.recoveryAudit)?.recoveredAt
  const v8 = trace?.candidates.filter(isElitePlusV8Advertisement) ?? []
  const gatt = hasEvent(snapshot, 'GATT_CONNECTED') ? 'Connected' : hasEvent(snapshot, 'GATT_FAILED') ? 'Failed'
    : hasEvent(snapshot, 'GATT_CONNECT_REQUESTED') ? 'Requested' : 'Not requested'
  const lastFailure = trace?.events.filter((event) => ['SCAN_START_FAILED', 'CONNECT_FAILED', 'CONNECTION_FAILURE', 'GATT_FAILED'].includes(event.event)).at(-1)
  const rows: Array<[string, string]> = [
    ['Authenticated user', ownerUserId ? 'Yes' : 'No'],
    ['App lifecycle', lifecycle],
    ['Native plugin initialized', startup.state === 'READY' ? 'Yes (initialization ACK received)' : `${startup.state} (${startup.error ?? 'waiting'})`],
    ['Native diagnostic snapshot', snapshotError || (snapshot ? 'Available' : 'Waiting')],
    ['Bluetooth adapter supported', yesNo(snapshot?.android.adapterSupported)],
    ['Bluetooth enabled', snapshot ? `${yesNo(snapshot.android.bluetoothEnabled)} (${snapshot.android.adapterState})` : 'Unknown'],
    ['Android SDK', snapshot ? String(snapshot.android.sdkInt) : 'Unknown'],
    ['Nearby Devices / BLUETOOTH_SCAN', permissionText(snapshot, 'BLUETOOTH_SCAN')],
    ['BLUETOOTH_CONNECT', permissionText(snapshot, 'BLUETOOTH_CONNECT')],
    ['ACCESS_FINE_LOCATION (legacy)', permissionText(snapshot, 'ACCESS_FINE_LOCATION')],
    ['Plugin permission status', snapshot ? `${snapshot.normalizedPermissionStatus} (alias ${snapshot.capacitorPermissionAlias}: ${snapshot.capacitorAliasState ?? 'unknown'})` : 'Unknown'],
    ['Scan requested', trace ? `${trace.scanRequestedCount} time(s)` : 'Unknown'],
    ['Scan start timestamp', trace?.scanStartedAt ?? 'Never'],
    ['Scan active', yesNo(trace?.scanActive)],
    ['Scan callback registered (JS)', yesNo(snapshot?.jsListeners.jcvitalScanResult)],
    ['Scan callback registered (Android)', yesNo(trace?.scanCallbackRegistered)],
    ['Advertisements received', String(trace?.advertisementsReceived ?? 0)],
    ['Devices discovered', String(trace?.candidates.length ?? 0)],
    ['V8 candidates detected', String(v8.length)],
    ['Candidates filtered', String(trace?.candidates.filter((candidate) => !candidate.acceptedByNativeFilter).length ?? 0)],
    ['Device selected', report?.connection.deviceSelected ?? snapshot?.connectedDeviceId ?? 'None'],
    ['Connect requested', yesNo(hasEvent(snapshot, 'CONNECT_REQUESTED'))],
    ['GATT connection state', gatt],
    ['Service discovery', yesNo(hasEvent(snapshot, 'SERVICES_DISCOVERED'))],
    ['journalState', journal?.journalState ?? 'Unknown'],
    ['journalAccountId', journal?.journalAccountId ?? 'Unknown'],
    ['journalDeviceScopeId', journal?.journalDeviceScopeId ?? 'Unknown'],
    ['journalOpenAttempted', yesNo(journal?.journalOpenAttempted)],
    ['journalOpenSucceeded', yesNo(journal?.journalOpenSucceeded)],
    ['journalFailureCode', journal?.journalFailureCode ?? 'None reported'],
    ['journalFailureMessage', journal?.journalFailureMessage ?? 'None reported'],
    ['failedClosed', yesNo(journal?.failedClosed)],
    ['priorFailureCode', journal?.priorFailureCode ?? 'None reported'],
    ['recoveryAudit', journal?.recoveryAudit == null ? 'None reported' : JSON.stringify(journal.recoveryAudit)],
    ['recoveryAuditHistory', journal?.recoveryAuditHistory == null ? 'None reported' : JSON.stringify(journal.recoveryAuditHistory)],
    ['latestRecoveryAudit', journal?.latestRecoveryAudit == null ? 'None reported' : JSON.stringify(journal.latestRecoveryAudit)],
    ['Type27 ingress suppression', journal?.type27Ingress == null ? 'None reported' : JSON.stringify(journal.type27Ingress)],
    ['recoveredAt', typeof recoveredAt === 'string' ? recoveredAt : 'None reported'],
    ['journalFailedClosedAtStartup', yesNo(journal?.journalFailedClosedAtStartup)],
    ['journalEnvelopeCount', journal?.journalEnvelopeCount == null ? 'Unknown' : String(journal.journalEnvelopeCount)],
    ['journalInspectionFailure', journal?.journalInspectionFailureMessage ?? journal?.journalInspectionFailureCode ?? 'None reported'],
    ['transportInitializationStarted', yesNo(journal?.transportInitializationStarted)],
    ['getDeviceVersionBlockedReason', journal?.getDeviceVersionBlockedReason ?? 'None reported'],
    ['globalJournalEnvelopeCount', pressure?.globalEnvelopeCount == null ? 'Unknown' : String(pressure.globalEnvelopeCount)],
    ['globalJournalAccountedBytes', pressure?.globalAccountedBytes == null ? 'Unknown' : String(pressure.globalAccountedBytes)],
    ['journalMaxEnvelopes', pressure ? String(pressure.maxEnvelopes) : 'Unknown'],
    ['journalMaxBytes', pressure ? String(pressure.maxBytes) : 'Unknown'],
    ['journalEnvelopeHeadroom', pressure?.envelopeHeadroom == null ? 'Unknown' : String(pressure.envelopeHeadroom)],
    ['journalByteHeadroom', pressure?.byteHeadroom == null ? 'Unknown' : String(pressure.byteHeadroom)],
    ['journalBudgetAtOrOverLimit', yesNo(pressure?.budgetAtOrOverLimit)],
    ['journalPressureScope', pressure?.limitsScope ?? 'Unknown'],
    ['journalPressureTrigger', pressure?.triggerRule ?? 'Unknown'],
    ['journalPressureInspectionError', pressure?.inspectionErrorMessage ?? pressure?.inspectionErrorCode ?? 'None reported'],
    ['Notification setup', yesNo(hasEvent(snapshot, 'NOTIFICATIONS_ENABLED'))],
    ['GetDeviceVersion', yesNo(hasEvent(snapshot, 'DEVICE_VERSION_REQUESTED'))],
    ['READY reached', yesNo(snapshot?.connectionState === 'READY' || hasEvent(snapshot, 'READY'))],
    ['Connection state', snapshot?.connectionState ?? 'Unknown'],
    ['Last error', lastFailure ? `${lastFailure.event} ${String(lastFailure.detail.code ?? '')} ${String(lastFailure.detail.message ?? '')}`.trim() : report?.errors.at(-1) ?? 'None'],
  ]

  return <details className="elite-v8-card connection-diagnostic">
    <summary id="connection-diagnostic-title">Connection Diagnostic</summary>
    <p>Bluetooth discovery/connection only. No history acquisition, sync, queue or Base44 activity.</p>
    <table className="engineering-evidence-table" aria-label="Connection diagnostic state">
      <tbody>{rows.map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td data-label={label}>{value}</td></tr>)}</tbody>
    </table>
    <JournalStoragePressure journal={journal} />
    <button type="button" className="elite-v8-button secondary" onClick={() => void analyzeCapacity()}
      disabled={capacityBusy || busy || startup.state !== 'READY'}>
      {capacityBusy ? 'Inspecting journal capacity...' : 'Analyze Journal Capacity (read-only)'}
    </button>
    {capacity && <>
      <JournalCapacitySummary analysis={capacity} />
      <button type="button" className="elite-v8-button secondary" onClick={() => void exportCapacity('copy')} disabled={capacityBusy}>Copy Capacity JSON</button>
      <button type="button" className="elite-v8-button secondary" onClick={() => void exportCapacity('save')} disabled={capacityBusy}>Save Capacity JSON</button>
    </>}
    {capacityStatus && <p role="status">{capacityStatus}</p>}
    <section aria-labelledby="offline-journal-title" className="offline-journal-inspector">
      <h3 id="offline-journal-title">Offline Journal Capacity Inspector</h3>
      <button type="button" className="elite-v8-button secondary" onClick={() => void analyzeOffline()} disabled={offlineBusy}>
        {offlineBusy ? 'Inspecting journal offline...' : 'Analyze Existing Journal Offline (read-only)'}
      </button>
      {offlineStatus && <p role="status">{offlineStatus}</p>}
      {offline && <>
        <table className="engineering-evidence-table" aria-label="Offline journal inspection state">
          <tbody>{([
            ['status', offline.status],
            ['databaseExists', String(offline.databaseExists)],
            ['openedReadOnly', String(offline.openedReadOnly)],
            ['normalJournalState', offline.normalJournalState],
            ['failedClosedAtStartup', String(offline.failedClosedAtStartup)],
            ['mutationDetected', String(offline.mutationDetected)],
            ['mutatedFields', offline.mutatedFields?.join(', ') || 'None'],
            ['analysisMaxBytes', offline.analysisMaxBytesAssumption],
            ['errorCode', offline.errorCode ?? 'None'],
            ['errorMessage', offline.errorMessage ?? 'None'],
          ] as Array<[string, string]>).map(([label, value]) => <tr key={label}><th scope="row">{label}</th><td data-label={label}>{value}</td></tr>)}</tbody>
        </table>
        {offline.before && offline.after && <table className="engineering-evidence-table" aria-label="Offline journal non-mutation proof">
          <thead><tr><th>Invariant</th><th>BEFORE</th><th>AFTER</th><th>Equal</th></tr></thead>
          <tbody>{Object.keys(offline.before).map((key) => <tr key={key}>
            <th scope="row">{key}</th><td>{String(offline.before?.[key])}</td><td>{String(offline.after?.[key])}</td>
            <td>{offline.before?.[key] === offline.after?.[key] ? 'Yes' : 'NO'}</td></tr>)}</tbody>
        </table>}
        {offline.hashNote && <p>{offline.hashNote} -shm size: {offline.shmFileSizeBytesInformational ?? 'n/a'}</p>}
        {offline.analysis && <JournalCapacitySummary analysis={offline.analysis} />}
      </>}
    </section>
    <label className="connection-diagnostic-option">
      <input type="checkbox" checked={connect} onChange={(event) => setConnect(event.target.checked)} disabled={busy} />
      Connect to the strongest Elite+ V8 after discovery
    </label>
    <button type="button" className="elite-v8-button" onClick={() => void run()} disabled={busy || exportBusy || startup.state !== 'READY'}>
      {busy ? 'Running Connection Diagnostic…' : 'Run Connection Diagnostic'}
    </button>
    {report && <div role="status" className="connection-diagnostic-result">
      <strong>{report.classification.primary ?? (report.connection.readyReached ? 'READY' : 'V8 discovered')}</strong>
      <span>{report.classification.summary}</span>
      <span>First failed stage: {report.firstFailedStage ?? 'None'}</span>
      {report.fallbackClassification && <span>Direct-scan fallback: {report.fallbackClassification.primary ?? 'No failure observed'} — {report.fallbackClassification.summary}</span>}
      <span>Before run: {report.preRunClassification.primary ?? 'No failure observed'}</span>
      <span>Reference V8 ({REFERENCE_V8.macAddress}) observed: {report.referenceDevice.observed ? 'Yes' : 'No'}</span>
    </div>}
    {report && <ConnectionDiagnosticSummary report={report} />}
    {trace && trace.candidates.length > 0 && <details>
      <summary>Discovered BLE devices ({trace.candidates.length})</summary>
      <ul className="connection-diagnostic-candidates">
        {trace.candidates.map((candidate) => <li key={`${candidate.scanSession}:${candidate.address}`}>
          {candidate.name ?? '(unnamed)'} · {candidate.address} · RSSI {candidate.rssi}
          {' · '}{isElitePlusV8Advertisement(candidate) ? 'V8 candidate' : 'not V8'}
          {' · '}{candidate.acceptedByNativeFilter ? 'listed' : `rejected: ${candidate.rejectionReason ?? 'unknown'}`}
          {candidate.serviceUuids.length > 0 && ` · ${candidate.serviceUuids.join(', ')}`}
          {candidate.address === REFERENCE_V8.macAddress && ' · reference V8'}
        </li>)}
      </ul>
    </details>}
    <button type="button" className="elite-v8-button secondary" onClick={() => void exportJson('copy')} disabled={!report || busy || exportBusy}>Copy Diagnostic JSON</button>
    <button type="button" className="elite-v8-button secondary" onClick={() => void exportJson('save')} disabled={!report || busy || exportBusy}>Save Diagnostic JSON</button>
    <button type="button" className="elite-v8-button secondary" onClick={() => void exportJson('share')} disabled={!report || busy || exportBusy}>Share Connection Diagnostic JSON</button>
    {exportStatus && <p role="status">{exportStatus}</p>}
  </details>
}
