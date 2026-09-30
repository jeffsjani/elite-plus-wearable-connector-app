import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import {
  JCVitalV8,
  type JCVitalV8Battery,
  type JCVitalV8ConnectionState,
  type JCVitalV8Device,
  type JCVitalV8DeviceInfo,
  type JCVitalV8ErrorEvent,
  type JCVitalV8HistoricalSyncResult,
  type JCVitalV8Observation,
  type JCVitalV8PermissionResult,
} from './jcvitalV8Bridge'
import {
  buildHistoricalFeedResult,
  buildMonitoringFeedResult,
  buildPhase3AValidationReport,
  type HistoricalFeedKey,
  type HistoricalFeedRun,
  type MonitoringFeedRun,
} from './Phase3AValidation'
import {
  buildPhase3BFeedResults,
  buildPhase3BExportResults,
  type Phase3BFeedKey,
  type SleepFeedRun,
} from './Phase3BValidation'
import { phase3bDisabledReason } from './Phase3BBridgeStatus'

type ExportStatus = 'EXPORTING' | 'EXPORT SUCCESS' | 'EXPORT FAILED'

function errorText(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  return code ? `${code}: ${message ?? ''}` : message ?? 'Unknown error'
}

/** Diagnostic panel for the JCVital Pro V8 native bridge (Android). Displays data only; nothing is queued for upload. */
export function JCVitalV8Panel() {
  const [permission, setPermission] = useState<JCVitalV8PermissionResult | null>(null)
  const [state, setState] = useState<JCVitalV8ConnectionState>('DISCONNECTED')
  const [devices, setDevices] = useState<JCVitalV8Device[]>([])
  const [info, setInfo] = useState<JCVitalV8DeviceInfo | null>(null)
  const [battery, setBattery] = useState<JCVitalV8Battery | null>(null)
  const [heartRate, setHeartRate] = useState<JCVitalV8Observation | null>(null)
  const [realtime, setRealtime] = useState(false)
  const [lastError, setLastError] = useState<JCVitalV8ErrorEvent | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [pluginAvailable, setPluginAvailable] = useState<boolean | null>(null)
  const [activeSync, setActiveSync] = useState<string | null>(null)
  const [historicalRuns, setHistoricalRuns] = useState<Partial<Record<HistoricalFeedKey, HistoricalFeedRun>>>({})
  const [monitoringRun, setMonitoringRun] = useState<MonitoringFeedRun | undefined>()
  const [phase3bRuns, setPhase3bRuns] = useState<Partial<Record<Exclude<Phase3BFeedKey, 'sleep'>, HistoricalFeedRun>>>({})
  const [sleepRun, setSleepRun] = useState<SleepFeedRun>({})
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null)
  const [exportLocation, setExportLocation] = useState<string | null>(null)

  useEffect(() => {
    const handles = [
      JCVitalV8.addListener('jcvitalScanResult', (device) =>
        setDevices((current) => [device, ...current.filter((item) => item.id !== device.id)].sort((a, b) => Number(b.advertisesJcvitalService) - Number(a.advertisesJcvitalService) || b.rssi - a.rssi))),
      JCVitalV8.addListener('jcvitalConnectionState', (event) => {
        setState(event.state)
        if (event.state !== 'READY') setRealtime(false)
      }),
      JCVitalV8.addListener('jcvitalDeviceInfo', setInfo),
      JCVitalV8.addListener('jcvitalBattery', setBattery),
      JCVitalV8.addListener('jcvitalHeartRate', setHeartRate),
      JCVitalV8.addListener('jcvitalError', setLastError),
    ]
    void JCVitalV8.isAvailable().then((result) => setPluginAvailable(result.available)).catch(() => setPluginAvailable(false))
    void JCVitalV8.getPermissionStatus().then(setPermission).catch((error) => setMessage(errorText(error)))
    void JCVitalV8.getConnectionState().then((result) => setState(result.state)).catch(() => undefined)
    return () => { handles.forEach((handle) => void handle.then((h) => h.remove())) }
  }, [])

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) }
  }

  async function executeHistoricalSync(key: HistoricalFeedKey, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const result = await action()
      setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function runSync(key: HistoricalFeedKey, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    setBusy(true)
    setActiveSync(`phase3a:${key}`)
    setMessage('')
    try { await executeHistoricalSync(key, action) } finally { setActiveSync(null); setBusy(false) }
  }

  async function syncHrvAndPpi(): Promise<void> {
    setBusy(true)
    setActiveSync('phase3a:hrv-ppi')
    setMessage('')
    try {
      await executeHistoricalSync('hrv', () => JCVitalV8.syncHistoricalHrv())
      await executeHistoricalSync('ppi', () => JCVitalV8.syncHistoricalPpi())
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function syncMonitoringConfiguration(): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setBusy(true)
    setActiveSync('monitoring-configuration')
    setMessage('')
    setMonitoringRun({ requestStartedAt, requestCompletedAt: null, result: null, error: null })
    try {
      const result = await JCVitalV8.getMonitoringConfiguration()
      setMonitoringRun({ requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null })
    } catch (error) {
      const text = errorText(error)
      setMonitoringRun({ requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text })
      setMessage(text)
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function executePhase3BSync(
    key: Exclude<Phase3BFeedKey, 'sleep'>,
    action: () => Promise<JCVitalV8HistoricalSyncResult>,
  ): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const result = await action()
      setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function runPhase3BSync(
    key: Exclude<Phase3BFeedKey, 'sleep'>,
    action: () => Promise<JCVitalV8HistoricalSyncResult>,
  ): Promise<void> {
    setBusy(true)
    setActiveSync(`phase3b:${key}`)
    setMessage('')
    try { await executePhase3BSync(key, action) } finally { setActiveSync(null); setBusy(false) }
  }

  async function executeSleepSyncPart(part: keyof SleepFeedRun, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const result = await action()
      setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function syncSleep(): Promise<void> {
    setBusy(true)
    setActiveSync('phase3b:sleep')
    setMessage('')
    try {
      await executeSleepSyncPart('stages', () => JCVitalV8.syncHistoricalSleepStages())
      await executeSleepSyncPart('movement', () => JCVitalV8.syncHistoricalSleepMovement())
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function exportValidationReport(): Promise<void> {
    setExportStatus('EXPORTING')
    setExportLocation(null)
    try {
      let deviceInfo = info
      if (!deviceInfo && ready) {
        deviceInfo = await JCVitalV8.getDeviceInfo()
        setInfo(deviceInfo)
      }
      const phase3bFeedResults = buildPhase3BExportResults({
        activity: phase3bRuns.activity,
        detailedActivity: phase3bRuns.detailedActivity,
        sleep: sleepRun,
        workouts: phase3bRuns.workouts,
      })
      const payload = buildPhase3AValidationReport({
        deviceInfo, historicalRuns, monitoringRun,
        additionalFeedResults: phase3bFeedResults,
      })
      const filename = `jcvital-v8-phase3ab-validation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      const json = JSON.stringify(payload, null, 2)

      if (Capacitor.isNativePlatform()) {
        const saved = await Filesystem.writeFile({ path: filename, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 })
        await Share.share({
          title: 'JCVital V8 Phase 3A/3B Validation',
          text: filename,
          files: [saved.uri],
          dialogTitle: 'Save or share Phase 3A/3B validation JSON',
        })
        setExportLocation(`${filename} · ${saved.uri}`)
      } else {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.click()
        URL.revokeObjectURL(url)
        setExportLocation(filename)
      }
      setExportStatus('EXPORT SUCCESS')
    } catch (error) {
      setExportStatus('EXPORT FAILED')
      setExportLocation(errorText(error))
    }
  }

  const ready = state === 'READY'
  const linked = state === 'CONNECTING' || state === 'CONNECTED' || state === 'INITIALIZING' || ready
  const feedDiagnostics = {
    heartRate: buildHistoricalFeedResult('heartRate', historicalRuns.heartRate),
    spo2: buildHistoricalFeedResult('spo2', historicalRuns.spo2),
    temperature: buildHistoricalFeedResult('temperature', historicalRuns.temperature),
    hrv: buildHistoricalFeedResult('hrv', historicalRuns.hrv),
    ppi: buildHistoricalFeedResult('ppi', historicalRuns.ppi),
    monitoringConfiguration: buildMonitoringFeedResult(monitoringRun),
  }
  const phase3bDiagnostics = buildPhase3BFeedResults({
    activity: phase3bRuns.activity,
    detailedActivity: phase3bRuns.detailedActivity,
    sleep: sleepRun,
    workouts: phase3bRuns.workouts,
  })
  const automaticHrInterval = monitoringRun?.result?.configurations.HEART_RATE.intervalMinutesRaw ?? null
  const historicalHrDiagnostics = feedDiagnostics.heartRate.sampleDiagnostics as { medianIntervalSeconds?: number | null } | null
  const phase3bMethods = {
    activity: typeof JCVitalV8.syncHistoricalActivity === 'function',
    detailedActivity: typeof JCVitalV8.syncDetailedActivity === 'function',
    sleep: typeof JCVitalV8.syncHistoricalSleepStages === 'function' && typeof JCVitalV8.syncHistoricalSleepMovement === 'function',
    workouts: typeof JCVitalV8.syncHistoricalWorkouts === 'function',
  }
  const phase3bDisabledReasons = {
    activity: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.activity, connectionState: state, activeSync }),
    detailedActivity: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.detailedActivity, connectionState: state, activeSync }),
    sleep: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.sleep, connectionState: state, activeSync }),
    workouts: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.workouts, connectionState: state, activeSync }),
  }
  return (
    <section className="wearables" aria-labelledby="jcvital-v8-title">
      <div className="wearables-heading"><h2 id="jcvital-v8-title">JCVital Pro V8</h2><strong>{state}</strong></div>
      <p>Bluetooth: {permission ? `${permission.status}${permission.bluetoothEnabled ? '' : ' (Bluetooth off)'}` : 'Checking…'}</p>
      <div className="wearable-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => setPermission(await JCVitalV8.requestPermissions()))}>Allow Bluetooth</button>
        <button type="button" disabled={busy || linked || state === 'SCANNING'} onClick={() => void run(async () => { setDevices([]); await JCVitalV8.startScan({ timeoutMs: 30000 }) })}>Start Scan</button>
        <button type="button" className="secondary" disabled={state !== 'SCANNING'} onClick={() => void run(() => JCVitalV8.stopScan())}>Stop Scan</button>
      </div>
      {!linked && devices.length > 0 && <ul className="jcvital-devices">
        {devices.map((device) => <li key={device.id}>
          <button type="button" disabled={busy} onClick={() => void run(async () => { setInfo(null); setBattery(null); setHeartRate(null); await JCVitalV8.connect({ deviceId: device.id }); setInfo(await JCVitalV8.getDeviceInfo()) })}>Connect</button>
          {' '}{device.name ?? 'Unnamed'} · {device.macAddress} · {device.rssi} dBm{device.advertisesJcvitalService ? ' · JCVital service' : ''}{device.bonded ? ' · bonded' : ''}
        </li>)}
      </ul>}
      {linked && <div className="wearable-actions">
        <button type="button" disabled={busy || !ready} onClick={() => void run(async () => setInfo(await JCVitalV8.getDeviceInfo()))}>Device Info</button>
        <button type="button" disabled={busy || !ready} onClick={() => void run(async () => setBattery(await JCVitalV8.getBattery()))}>Battery</button>
        <button type="button" disabled={busy || !ready || realtime} onClick={() => void run(async () => { await JCVitalV8.startRealtimeData({ measurementSeconds: 60 }); setRealtime(true) })}>Start Realtime</button>
        <button type="button" disabled={busy || !ready || !realtime} onClick={() => void run(async () => { await JCVitalV8.stopRealtimeData(); setRealtime(false) })}>Stop Realtime</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => JCVitalV8.disconnect())}>Disconnect</button>
      </div>}
      {info && <p>Device: {info.deviceName ?? info.advertisedName ?? '—'} · MAC {info.macAddress ?? info.deviceId} · Firmware {info.firmwareVersion ?? '—'} · ID {info.vendorDeviceId ?? '—'} · SDK {info.sdkVersion}{info.missingFields.length ? ` · missing: ${info.missingFields.join(', ')}` : ''}</p>}
      {battery && <p>Battery: {battery.level ?? '—'}%{battery.charging === null ? '' : battery.charging ? ' (charging)' : ' (not charging)'}</p>}
      {heartRate && <p>Heart rate: <strong>{heartRate.value} {heartRate.unit}</strong> · received {new Date(heartRate.receiptTimestamp).toLocaleTimeString()} · packet type {heartRate.vendorDataType}</p>}
      <h3>Data Sync</h3>
      <div className="wearable-actions">
        <button type="button" disabled={busy || !ready} onClick={() => void runSync('heartRate', () => JCVitalV8.syncHistoricalHeartRate())}>Sync HR</button>
        <button type="button" disabled={busy || !ready} onClick={() => void runSync('spo2', () => JCVitalV8.syncHistoricalSpo2())}>Sync SpO2</button>
        <button type="button" disabled={busy || !ready} onClick={() => void runSync('temperature', () => JCVitalV8.syncHistoricalTemperature())}>Sync Temperature</button>
        <button type="button" disabled={busy || !ready} onClick={() => void syncHrvAndPpi()}>Sync HRV/PPI</button>
        <button type="button" disabled={busy || !ready} onClick={() => void syncMonitoringConfiguration()}>Sync Automatic Monitoring / Configuration</button>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.activity !== null} onClick={() => void runPhase3BSync('activity', () => JCVitalV8.syncHistoricalActivity())}>Sync Activity</button>
          {phase3bDisabledReasons.activity && <small>Disabled: {phase3bDisabledReasons.activity}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.detailedActivity !== null} onClick={() => void runPhase3BSync('detailedActivity', () => JCVitalV8.syncDetailedActivity())}>Sync Detailed Activity</button>
          {phase3bDisabledReasons.detailedActivity && <small>Disabled: {phase3bDisabledReasons.detailedActivity}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.sleep !== null} onClick={() => void syncSleep()}>Sync Sleep</button>
          {phase3bDisabledReasons.sleep && <small>Disabled: {phase3bDisabledReasons.sleep}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.workouts !== null} onClick={() => void runPhase3BSync('workouts', () => JCVitalV8.syncHistoricalWorkouts())}>Sync Workouts</button>
          {phase3bDisabledReasons.workouts && <small>Disabled: {phase3bDisabledReasons.workouts}</small>}
        </div>
        <button type="button" className="secondary" disabled={!Object.keys(historicalRuns).length && !monitoringRun && !Object.keys(phase3bRuns).length && !sleepRun.stages && !sleepRun.movement} onClick={() => void exportValidationReport()}>Export Phase 3A/3B Validation JSON</button>
      </div>
      <div className="phase3b-bridge-status">
        <strong>Phase 3B bridge</strong>
        <span>activity: {phase3bMethods.activity ? 'AVAILABLE' : 'MISSING'}</span>
        <span>detailedActivity: {phase3bMethods.detailedActivity ? 'AVAILABLE' : 'MISSING'}</span>
        <span>sleep: {phase3bMethods.sleep ? 'AVAILABLE' : 'MISSING'}</span>
        <span>workouts: {phase3bMethods.workouts ? 'AVAILABLE' : 'MISSING'}</span>
        <span>connectionState: {state}</span>
        <span>pluginAvailable: {pluginAvailable === null ? 'CHECKING' : pluginAvailable ? 'AVAILABLE' : 'MISSING'}</span>
        <span>activeSync: {activeSync ?? 'NONE'}</span>
      </div>
      <p><strong>Automatic HR monitoring interval:</strong> {automaticHrInterval === null ? '—' : `${automaticHrInterval} minutes (vendor configuration)`}</p>
      <p><strong>Historical HR observed median interval:</strong> {historicalHrDiagnostics?.medianIntervalSeconds == null ? '—' : `${historicalHrDiagnostics.medianIntervalSeconds} seconds (observed data)`}</p>
      {exportStatus && <p role="status"><strong>{exportStatus}</strong>{exportLocation ? ` · ${exportLocation}` : ''}</p>}
      {Object.entries(feedDiagnostics).map(([key, diagnostics]) => {
        const showAllRecords = key === 'spo2' || key === 'hrv' || key === 'ppi' || key === 'monitoringConfiguration'
        return <details key={key} className="jcvital-diagnostics">
          <summary>{key}: {diagnostics.completionStatus} · {diagnostics.recordsAccepted} accepted · {diagnostics.parseErrors.length} parse errors</summary>
          <p>Started: {diagnostics.requestStartedAt ?? '—'} · Completed: {diagnostics.requestCompletedAt ?? '—'}</p>
          <p>Source records received: {diagnostics.sourceRecordsReceived} · Normalized observations produced: {diagnostics.normalizedObservationsProduced}</p>
          <p>Accepted: {diagnostics.recordsAccepted} · Deduplicated: {diagnostics.recordsDeduplicated} · Rejected: {diagnostics.recordsRejected}</p>
          <p>Earliest: {diagnostics.earliestObservation ?? '—'} · Latest: {diagnostics.latestObservation ?? '—'}</p>
          <p>Vendor type: {diagnostics.vendorDataType ?? '—'} · Acquisition: {diagnostics.acquisitionMode ?? '—'}</p>
          <strong>Sample diagnostics</strong><pre>{JSON.stringify(diagnostics.sampleDiagnostics, null, 2)}</pre>
          <strong>Parse errors</strong><pre>{JSON.stringify(diagnostics.parseErrors, null, 2)}</pre>
          <strong>First 5 normalized observations</strong><pre>{JSON.stringify(diagnostics.firstFive, null, 2)}</pre>
          <strong>Last 5 normalized observations</strong><pre>{JSON.stringify(diagnostics.lastFive, null, 2)}</pre>
          {showAllRecords && <><strong>All returned diagnostic records</strong><pre>{JSON.stringify(diagnostics.allRecords, null, 2)}</pre></>}
        </details>
      })}
      <h3>Phase 3B History</h3>
      {Object.entries(phase3bDiagnostics).map(([key, diagnostics]) => <details key={key} className="jcvital-diagnostics">
        <summary>{key}: {diagnostics.completionStatus} · {diagnostics.recordsAccepted} accepted · {diagnostics.parseErrors.length} parse errors</summary>
        <p>Source records received: {diagnostics.sourceRecordsReceived} · Normalized observations produced: {diagnostics.normalizedObservationsProduced}</p>
        <p>Accepted: {diagnostics.recordsAccepted} · Deduplicated: {diagnostics.recordsDeduplicated} · Rejected: {diagnostics.recordsRejected}</p>
        <p>Earliest: {diagnostics.earliestObservation ?? '—'} · Latest: {diagnostics.latestObservation ?? '—'}</p>
        <strong>Diagnostics</strong><pre>{JSON.stringify(diagnostics.sampleDiagnostics, null, 2)}</pre>
        <strong>Parse errors</strong><pre>{JSON.stringify(diagnostics.parseErrors, null, 2)}</pre>
        <strong>First 5</strong><pre>{JSON.stringify(diagnostics.firstFive, null, 2)}</pre>
        <strong>Last 5</strong><pre>{JSON.stringify(diagnostics.lastFive, null, 2)}</pre>
      </details>)}
      <h3>Raw</h3>
      <div className="wearable-actions">
        <button type="button" disabled title="Phase 3D">Start PPG</button>
        <button type="button" disabled title="Phase 3D">Stop PPG</button>
        <button type="button" disabled title="Phase 3D">Start ECG</button>
        <button type="button" disabled title="Phase 3D">Stop ECG</button>
      </div>
      <h3>Workout Test</h3>
      <div className="wearable-actions">
        <button type="button" disabled title="Phase 3C">Start Workout Capture</button>
        <button type="button" disabled title="Phase 3C">Stop Workout Capture</button>
      </div>
      {message && <p className="error-message" role="alert">{message}</p>}
      {lastError && <p>Last native error: {lastError.code} — {lastError.message}</p>}
    </section>
  )
}
