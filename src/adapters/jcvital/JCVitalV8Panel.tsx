import { useEffect, useState } from 'react'
import {
  JCVitalV8,
  type JCVitalV8Battery,
  type JCVitalV8ConnectionState,
  type JCVitalV8Device,
  type JCVitalV8DeviceInfo,
  type JCVitalV8ErrorEvent,
  type JCVitalV8HistoricalSyncResult,
  type JCVitalV8MonitoringConfiguration,
  type JCVitalV8Observation,
  type JCVitalV8PermissionResult,
} from './jcvitalV8Bridge'

type SyncKey = 'HR' | 'SpO2' | 'Temperature' | 'HRV' | 'PPI'

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function syncDiagnostics(result: JCVitalV8HistoricalSyncResult) {
  const observations = result.observations
  const times = observations.map((item) => item.observedAt ? Date.parse(item.observedAt) : Number.NaN).filter(Number.isFinite).sort((a, b) => a - b)
  const intervals = times.slice(1).map((time, index) => time - times[index])
  const nominal = observations.find((item) => item.samplingIntervalMs)?.samplingIntervalMs ?? null
  const ppiValues = observations.flatMap((item) => item.metricType === 'PPI' ? (item.values ?? []).filter((value): value is number => typeof value === 'number') : [])
  return {
    status: result.completionStatus,
    count: observations.length,
    earliestTimestamp: result.earliestObservation,
    latestTimestamp: result.latestObservation,
    intervalMs: intervals.length ? { median: median(intervals), min: Math.min(...intervals), max: Math.max(...intervals) } : null,
    missingIntervalCount: nominal ? intervals.filter((interval) => interval > nominal * 1.5).length : null,
    duplicateCount: result.recordsDeduplicated,
    parseErrors: result.parseErrors,
    ppi: ppiValues.length ? {
      count: ppiValues.length, min: Math.min(...ppiValues), max: Math.max(...ppiValues), median: median(ppiValues),
      zeroCount: ppiValues.filter((value) => value === 0).length,
      invalidCount: result.recordsRejected,
    } : null,
    first5: observations.slice(0, 5),
    last5: observations.slice(-5),
  }
}

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
  const [syncResults, setSyncResults] = useState<Partial<Record<SyncKey, JCVitalV8HistoricalSyncResult>>>({})
  const [monitoring, setMonitoring] = useState<JCVitalV8MonitoringConfiguration | null>(null)

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
    void JCVitalV8.getPermissionStatus().then(setPermission).catch((error) => setMessage(errorText(error)))
    void JCVitalV8.getConnectionState().then((result) => setState(result.state)).catch(() => undefined)
    return () => { handles.forEach((handle) => void handle.then((h) => h.remove())) }
  }, [])

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) }
  }

  async function runSync(key: SyncKey, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    await run(async () => {
      const result = await action()
      setSyncResults((current) => ({ ...current, [key]: result }))
    })
  }

  async function syncHrvAndPpi(): Promise<void> {
    setBusy(true)
    setMessage('')
    try {
      const hrv = await JCVitalV8.syncHistoricalHrv()
      setSyncResults((current) => ({ ...current, HRV: hrv }))
      const ppi = await JCVitalV8.syncHistoricalPpi()
      setSyncResults((current) => ({ ...current, PPI: ppi }))
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  function downloadDiagnostics(): void {
    const payload = Object.fromEntries(Object.entries(syncResults).map(([key, result]) => [key, syncDiagnostics(result)]))
    const url = URL.createObjectURL(new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = `jcvital-v8-phase3a-${new Date().toISOString()}.json`
    anchor.click()
    URL.revokeObjectURL(url)
  }

  const ready = state === 'READY'
  const linked = state === 'CONNECTING' || state === 'CONNECTED' || state === 'INITIALIZING' || ready
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
          <button type="button" disabled={busy} onClick={() => void run(async () => { setInfo(null); setBattery(null); setHeartRate(null); await JCVitalV8.connect({ deviceId: device.id }) })}>Connect</button>
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
        <button type="button" disabled={busy || !ready} onClick={() => void runSync('HR', () => JCVitalV8.syncHistoricalHeartRate())}>Sync HR</button>
        <button type="button" disabled={busy || !ready} onClick={() => void runSync('SpO2', () => JCVitalV8.syncHistoricalSpo2())}>Sync SpO2</button>
        <button type="button" disabled={busy || !ready} onClick={() => void runSync('Temperature', () => JCVitalV8.syncHistoricalTemperature())}>Sync Temperature</button>
        <button type="button" disabled={busy || !ready} onClick={() => void syncHrvAndPpi()}>Sync HRV/PPI</button>
        <button type="button" disabled={busy || !ready} onClick={() => void run(async () => setMonitoring(await JCVitalV8.getMonitoringConfiguration()))}>Monitoring Config</button>
        <button type="button" disabled title="Phase 3B">Sync Activity</button>
        <button type="button" disabled title="Phase 3B">Sync Sleep</button>
        <button type="button" disabled title="Phase 3B">Sync Workouts</button>
        <button type="button" className="secondary" disabled={!Object.keys(syncResults).length} onClick={downloadDiagnostics}>Download Diagnostics</button>
      </div>
      {monitoring && <details className="jcvital-diagnostics"><summary>Monitoring configuration</summary><pre>{JSON.stringify(monitoring, null, 2)}</pre></details>}
      {Object.entries(syncResults).map(([key, result]) => {
        const diagnostics = syncDiagnostics(result)
        return <details key={key} className="jcvital-diagnostics">
          <summary>{key}: {diagnostics.status} · {diagnostics.count} observations · {diagnostics.parseErrors.length} parse errors</summary>
          <p>First: {diagnostics.earliestTimestamp ?? '—'} · Last: {diagnostics.latestTimestamp ?? '—'} · Duplicates: {diagnostics.duplicateCount}</p>
          {diagnostics.intervalMs && <p>Interval ms: median {diagnostics.intervalMs.median} · min {diagnostics.intervalMs.min} · max {diagnostics.intervalMs.max} · missing {diagnostics.missingIntervalCount ?? '—'}</p>}
          {diagnostics.ppi && <p>PPI values: {diagnostics.ppi.count} · min {diagnostics.ppi.min} · max {diagnostics.ppi.max} · median {diagnostics.ppi.median} · zero {diagnostics.ppi.zeroCount} · invalid {diagnostics.ppi.invalidCount}</p>}
          <strong>First 5</strong><pre>{JSON.stringify(diagnostics.first5, null, 2)}</pre>
          <strong>Last 5</strong><pre>{JSON.stringify(diagnostics.last5, null, 2)}</pre>
        </details>
      })}
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
