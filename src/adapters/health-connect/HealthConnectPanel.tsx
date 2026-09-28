import { useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import type { HealthConnectType } from './healthConnectBridge'
import type { SourceStatus } from '../../models/connector'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { HealthConnectAdapter, healthConnectTypes, type HealthConnectDiagnostics } from './HealthConnectAdapter'

const labels: Record<HealthConnectType, string> = {
  heartRate: 'Heart rate', restingHeartRate: 'Resting heart rate', hrv: 'Heart rate variability (RMSSD)',
  sleep: 'Sleep', steps: 'Steps', activeCalories: 'Active energy', exercise: 'Exercise',
  respiratoryRate: 'Respiratory rate', oxygenSaturation: 'Oxygen saturation',
  weight: 'Body mass', height: 'Height', bodyTemperature: 'Body temperature',
}

export function HealthConnectPanel({ ownerUserId }: { ownerUserId: string }) {
  const [adapter] = useState(() => new HealthConnectAdapter(ownerUserId))
  const [status, setStatus] = useState<SourceStatus>('unavailable')
  const [selected, setSelected] = useState<HealthConnectType[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState<HealthConnectDiagnostics>({})
  const [lastDelivery, setLastDelivery] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void adapter.initialize().then(async () => { if (mounted) setStatus(await adapter.getStatus()) })
    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive && mounted) void adapter.getStatus().then((result) => { if (mounted) setStatus(result) })
    })
    return () => { mounted = false; void adapter.disconnect(); void listener.then((handle) => handle.remove()) }
  }, [adapter])

  function updateSelection(types: HealthConnectType[]): void {
    setSelected(types)
    adapter.setSelectedTypes(types)
    void adapter.getStatus().then(setStatus)
  }

  async function connect(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      const result = await adapter.requestPermissions()
      setStatus(await adapter.getStatus())
      if (!result.granted) setError('Some Health Connect permissions were not granted.')
    } catch {
      setError('Unable to request Health Connect permissions right now.')
    } finally { setBusy(false) }
  }

  async function sync(): Promise<void> {
    setBusy(true)
    setError('')
    try {
      await adapter.sync()
      setDiagnostics({ ...adapter.diagnostics })
      setLastDelivery((await observationQueue.getQueueStats()).lastSuccessfulUploadAt)
      setStatus(await adapter.getStatus())
    } catch {
      setStatus(await adapter.getStatus())
      setError('Unable to read Health Connect right now. Check permissions and try again.')
    } finally { setBusy(false) }
  }

  const missing = status === 'not_installed' || status === 'update_required'
  return (
    <section className="wearables" aria-labelledby="health-connect-title">
      <div className="wearables-heading"><h2 id="health-connect-title">Health Connect</h2><strong>{status === 'connected' ? 'Connected' : missing ? 'Health Connect Required' : status === 'unsupported' ? 'Unavailable on this device' : status === 'syncing' ? 'Syncing' : status === 'error' ? 'Status unavailable' : 'Not Connected'}</strong></div>
      {missing && <button type="button" onClick={() => void adapter.openHealthConnect().catch(() => setError('Unable to open Health Connect.'))}>Open Health Connect</button>}
      {!missing && status !== 'unsupported' && <>
        <div className="health-types" role="group" aria-label="Health Connect data types">
          {healthConnectTypes.map((type) => <label key={type}><input type="checkbox" disabled={busy} checked={selected.includes(type)} onChange={(event) => updateSelection(event.target.checked ? [...selected, type] : selected.filter((item) => item !== type))} />{labels[type]}</label>)}
        </div>
        <div className="wearable-actions">
          <button type="button" disabled={busy || !selected.length} onClick={() => void connect()}>Connect</button>
          <button type="button" className="secondary" disabled={busy || status !== 'connected'} onClick={() => void sync()}>Sync Now</button>
        </div>
      </>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {diagnostics.lastDataAt && <p>Last Data: {new Date(diagnostics.lastDataAt).toLocaleString()}</p>}
      {diagnostics.lastReadAt && <p>Last Health Read: {new Date(diagnostics.lastReadAt).toLocaleString()}</p>}
      {diagnostics.lastResult && <p>Records: {diagnostics.lastResult.recordsRetrieved} · Normalized: {diagnostics.lastResult.normalized} · Newly queued: {diagnostics.lastResult.newlyQueued} · Already queued: {diagnostics.lastResult.alreadyQueued} · Skipped: {diagnostics.lastResult.failedNormalization} · Deleted at source: {diagnostics.lastResult.deletedRecords}</p>}
      {lastDelivery && <p>Last Queue Delivery: {new Date(lastDelivery).toLocaleString()}</p>}
    </section>
  )
}