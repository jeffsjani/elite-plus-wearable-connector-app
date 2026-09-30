import { useEffect, useState } from 'react'
import {
  JCVitalV8,
  type JCVitalV8Battery,
  type JCVitalV8ConnectionState,
  type JCVitalV8Device,
  type JCVitalV8DeviceInfo,
  type JCVitalV8ErrorEvent,
  type JCVitalV8Observation,
  type JCVitalV8PermissionResult,
} from './jcvitalV8Bridge'

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
      {message && <p className="error-message" role="alert">{message}</p>}
      {lastError && <p>Last native error: {lastError.code} — {lastError.message}</p>}
    </section>
  )
}
