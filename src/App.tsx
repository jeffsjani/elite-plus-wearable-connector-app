import { useState } from 'react'
import './App.css'
import { getPlatform } from './services/platform'
import { installationIdentityService } from './services/storage/InstallationIdentityService'

const appVersion = '0.0.0'

function maskInstallId(installId: string): string {
  return `${installId.slice(0, 8)}...${installId.slice(-4)}`
}

function App() {
  const [installId] = useState(() => installationIdentityService.getInstallId())

  return (
    <main className="shell">
      <section className="status-panel" aria-labelledby="app-title">
        <div className="eyebrow">Elite+ / Native foundation</div>
        <h1 id="app-title">Elite+ Connector</h1>
        <p className="lede">A quiet, local-first companion for connected performance data.</p>

        <div className="readiness" role="status">
          <span className="readiness-dot" aria-hidden="true" />
          <div>
            <span className="label">Status</span>
            <strong>Native Connector Foundation Ready</strong>
          </div>
        </div>

        <dl className="details">
          <div>
            <dt>Platform</dt>
            <dd>{getPlatform()}</dd>
          </div>
          <div>
            <dt>App version</dt>
            <dd>{appVersion}</dd>
          </div>
          <div>
            <dt>Install ID</dt>
            <dd>{maskInstallId(installId)}</dd>
          </div>
        </dl>
      </section>
    </main>
  )
}

export default App