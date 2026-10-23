import { useCallback, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { DigitalBalance } from './DigitalBalance'
import type { LocalDigitalWellness } from './health/digitalWellnessLocal'
import type { CompanionV8Status } from '../adapters/jcvital/ElitePlusV8Panel'
import './companion.css'
import { SettingsDiagnosticsContext } from './SettingsDiagnosticsContext'

const initialStatus: CompanionV8Status = { connected: false, lastSync: null, syncing: false, needsAttention: false }
const time = (value: string | null | undefined) => value ? new Date(value).toLocaleString() : 'Not yet'

function WellnessSummary({ wellness }: { wellness: LocalDigitalWellness }) {
  const snapshot = useSyncExternalStore(wellness.subscribe, wellness.getSnapshot)
  return <section className="elite-v8-card"><h2>Digital Wellness</h2>
    <p>{snapshot.access.consent === 'ENABLED' ? 'On' : 'Off'}</p>
    <p>Last Update: {time(snapshot.production?.worker_last_run)}</p>
  </section>
}

export function CompanionShell({ wellness, v8, status = initialStatus, onSignOut, error, onEngineering }: {
  wellness: LocalDigitalWellness | null
  v8: ReactNode
  status?: CompanionV8Status
  onSignOut?: () => void
  error?: string
  onEngineering?: () => void
}) {
  const [page, setPage] = useState('Home')
  const [diagnosticsHost, setDiagnosticsHost] = useState<HTMLElement | null>(null)
  const diagnosticsHostRef = useCallback((element: HTMLElement | null) => {
    setDiagnosticsHost((current) => current === element ? current : element)
  }, [])
  useEffect(() => {
    if (!wellness) return
    let active = true
    const resume = () => { if (active) void wellness.onForegroundResume() }
    const visible = () => { if (document.visibilityState === 'visible') resume() }
    document.addEventListener('visibilitychange', visible)
    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => { if (isActive) resume() })
    void wellness.onForegroundResume()
    return () => {
      active = false
      document.removeEventListener('visibilitychange', visible)
      void listener.then((handle) => handle.remove()).catch((failure: unknown) => {
        console.error('Digital Wellness lifecycle cleanup failed', failure)
      })
    }
  }, [wellness])

  return <SettingsDiagnosticsContext.Provider value={diagnosticsHost}><main className="shell elite-app companion">
    <div className="elite-content">
      <header><h1>Elite+ Companion</h1><p>Keep your Elite+ health data connected and up to date.</p></header>
      <nav aria-label="Primary navigation">{['Home', 'Connections', 'Sync', 'Settings'].map((name) =>
        <button key={name} aria-current={page === name ? 'page' : undefined} onClick={() => setPage(name)}>{name === 'Connections' ? 'Connect' : name}</button>)}</nav>
      {error && <p role="alert">{error}</p>}
      {page === 'Home' && <section aria-label="Home">
        <section className="elite-v8-card"><h2>Elite+ V8</h2><p>{status.connected ? 'Connected' : 'Disconnected'}</p>
          <p>Last Sync: {time(status.lastSync)}</p></section>
        {wellness ? <WellnessSummary wellness={wellness} /> : <section className="elite-v8-card"><h2>Digital Wellness</h2><p>Off</p></section>}
        <section className="elite-v8-card"><h2>Sync Status</h2>
          <p>{status.syncing ? 'Syncing' : status.needsAttention ? 'Needs Attention' : 'Up to date'}</p></section>
      </section>}
      {/* Keep the certified V8 panel mounted: navigation must not reset its journal binding or listeners. */}
      <div hidden={page !== 'Connections' && page !== 'Sync'}>{v8}</div>
      {page === 'Connections' && (wellness ? <DigitalBalance wellness={wellness} />
        : <section className="elite-v8-card"><h2>Digital Wellness</h2><p>Digital Wellness requires the Android Companion and an active sign-in.</p></section>)}
      {page === 'Settings' && <section className="elite-v8-card"><h2>Settings</h2>
        <button onClick={() => setPage('Connections')}>Connections</button>
        <details><summary>Diagnostics</summary><div ref={diagnosticsHostRef} /></details>
        {onSignOut && <button onClick={onSignOut}>Sign Out</button>}
        {onEngineering && <button onClick={onEngineering}>Engineering diagnostics</button>}
      </section>}
    </div>
  </main></SettingsDiagnosticsContext.Provider>
}
