import { useEffect, useState } from 'react'
import type { HealthDataType } from './healthKitBridge'
import type { SourceStatus } from '../../models/connector'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { AppleHealthAdapter, appleHealthTypes, type AppleHealthDiagnostics } from './AppleHealthAdapter'

const labels: Record<string, string> = {
  heartRate: 'Heart rate', restingHeartRate: 'Resting heart rate', heartRateVariability: 'Heart rate variability',
  sleep: 'Sleep', steps: 'Steps', calories: 'Active energy', workouts: 'Workouts',
  respiratoryRate: 'Respiratory rate', oxygenSaturation: 'Oxygen saturation', weight: 'Body mass', height: 'Height',
}

export function AppleHealthPanel({ ownerUserId }: { ownerUserId: string }) {
  const [adapter] = useState(() => new AppleHealthAdapter(ownerUserId))
  const [status, setStatus] = useState<SourceStatus>('permission_required')
  const [selected, setSelected] = useState<HealthDataType[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [diagnostics, setDiagnostics] = useState<AppleHealthDiagnostics>({})
  const [lastDelivery, setLastDelivery] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    void adapter.initialize().then(async () => {
      if (mounted) setStatus(await adapter.getStatus())
    }).catch(() => { if (mounted) setStatus('error') })
    return () => { mounted = false; void adapter.disconnect() }
  }, [adapter])

  async function run(connect: boolean): Promise<void> {
    setBusy(true)
    setError('')
    try {
      adapter.setSelectedTypes(selected)
      if (connect) {
        const permission = await adapter.requestPermissions()
        if (permission.denied.length) throw new Error('HealthKit read request incomplete')
      }
      await adapter.sync()
      setStatus(await adapter.getStatus())
      setDiagnostics({ ...adapter.diagnostics })
      setLastDelivery((await observationQueue.getQueueStats()).lastSuccessfulUploadAt)
    } catch {
      setStatus(await adapter.getStatus())
      setError('Unable to read Apple Health right now. Check permissions and try again.')
    } finally {
      setBusy(false)
    }
  }

  const supported = status !== 'unsupported'
  return (
    <section className="wearables" aria-labelledby="apple-health-title">
      <div className="wearables-heading"><h2 id="apple-health-title">Apple Health</h2><strong>{status === 'connected' ? 'Connected' : status === 'syncing' ? 'Syncing' : status === 'unsupported' ? 'Unavailable on this device' : status === 'error' ? 'Read unavailable' : 'Permission Required'}</strong></div>
      {supported && <>
        <div className="health-types" role="group" aria-label="Apple Health data types">
          {appleHealthTypes.map((type) => <label key={type}><input type="checkbox" checked={selected.includes(type)} disabled={busy} onChange={(event) => setSelected((current) => event.target.checked ? [...current, type] : current.filter((item) => item !== type))} />{labels[type]}</label>)}
        </div>
        <div className="wearable-actions">
          <button type="button" disabled={busy || !selected.length} onClick={() => void run(true)}>Connect</button>
          <button type="button" className="secondary" disabled={busy || !selected.length} onClick={() => void run(false)}>Sync Now</button>
        </div>
      </>}
      {error && <p className="error-message" role="alert">{error}</p>}
      {diagnostics.lastDataAt && <p>Last Data: {new Date(diagnostics.lastDataAt).toLocaleString()}</p>}
      {diagnostics.lastReadAt && <p>Last Health Read: {new Date(diagnostics.lastReadAt).toLocaleString()}</p>}
      {diagnostics.lastResult && <p>Samples: {diagnostics.lastResult.samplesRetrieved} · Normalized: {diagnostics.lastResult.normalized} · Newly queued: {diagnostics.lastResult.newlyQueued} · Already queued: {diagnostics.lastResult.alreadyQueued} · Skipped: {diagnostics.lastResult.failedNormalization}</p>}
      {lastDelivery && <p>Last Queue Delivery: {new Date(lastDelivery).toLocaleString()}</p>}
    </section>
  )
}