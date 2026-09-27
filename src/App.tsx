import { useEffect, useState, type FormEvent } from 'react'
import './App.css'
import { getPlatform } from './services/platform'
import { installationIdentityService } from './services/storage/InstallationIdentityService'
import { authenticationService } from './services/base44/AuthenticationService'
import { connectorIdentityService } from './services/base44/ConnectorIdentityService'
import { connectorObservationService } from './services/base44/ConnectorObservationService'
import { connectorRegistrationService } from './services/base44/ConnectorRegistrationService'
import { connectorStatusService } from './services/base44/ConnectorStatusService'
import {
  ConnectorServiceError,
  type ConnectorObservationsResponse,
  type ConnectorRegistrationResponse,
  type ConnectorStatusResponse,
  type LocalUser,
  type NativeObservationInput,
} from './services/base44/base44Types'
import { createSyntheticObservation, createSyntheticObservations } from './services/testing/SyntheticObservationFactory'
import type { ConnectorConnectionState } from './models/connection'

const appVersion = '0.0.0'

function maskValue(value: string | null): string {
  if (!value) return 'Not registered'
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function describeError(error: unknown, isLogin = false): string {
  if (!(error instanceof ConnectorServiceError)) return 'Something went wrong. Please try again.'
  if (isLogin && error.code === 'AUTH_REQUIRED') return 'Incorrect email or password.'
  if (error.code === 'AUTH_REQUIRED' || error.code === 'UNAUTHORIZED') return 'Your Elite+ session has expired. Please sign in again.'
  if (error.code === 'NETWORK_ERROR') return 'Network error. Check your connection and try again.'
  if (error.code === 'FORBIDDEN') return 'This Elite+ account is not allowed to use the Connector.'
  return error.message
}

function getPlatformLabel(): string {
  const platform = getPlatform()
  return platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Web'
}

function createBatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function App() {
  const [connectionState, setConnectionState] = useState<ConnectorConnectionState>('UNAUTHENTICATED')
  const [user, setUser] = useState<LocalUser | null>(null)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [registration, setRegistration] = useState<ConnectorRegistrationResponse | null>(null)
  const [status, setStatus] = useState<ConnectorStatusResponse | null>(null)
  const [testResult, setTestResult] = useState<ConnectorObservationsResponse | null>(null)
  const [batchResult, setBatchResult] = useState<ConnectorObservationsResponse | null>(null)
  const [lastTestObservation, setLastTestObservation] = useState<NativeObservationInput | null>(null)
  const [lastTestBatchId, setLastTestBatchId] = useState('')
  const installId = installationIdentityService.getInstallId()
  const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
  const isBusy = ['REGISTERING', 'TESTING'].includes(connectionState)

  function handleServiceError(error: unknown, isLogin = false): void {
    const isExpired = error instanceof ConnectorServiceError &&
      (error.code === 'AUTH_REQUIRED' || error.code === 'UNAUTHORIZED') && !isLogin

    if (isExpired) {
      connectorIdentityService.clearConnectorDeviceId()
      setUser(null)
      setRegistration(null)
      setStatus(null)
      setConnectionState('UNAUTHENTICATED')
    } else {
      setConnectionState('ERROR')
    }

    setErrorMessage(describeError(error, isLogin))
  }

  useEffect(() => {
    let active = true

    async function restoreSession(): Promise<void> {
      if (!(await authenticationService.isAuthenticated())) return

      try {
        const currentUser = await authenticationService.getCurrentUser()
        if (!active || !currentUser) return
        setUser(currentUser)
        setConnectionState('AUTHENTICATED')
        setErrorMessage('')
        const result = await connectorRegistrationService.registerConnector({ installId, platform: getPlatform(), appVersion })
        if (!active) return
        setRegistration(result)
        setConnectionState('REGISTERED')
      } catch (error) {
        if (!active) return
        handleServiceError(error)
      }
    }

    void restoreSession()
    return () => { active = false }
  }, [installId])

  async function registerConnector(): Promise<void> {
    setConnectionState('REGISTERING')
    setErrorMessage('')
    try {
      const result = await connectorRegistrationService.registerConnector({ installId, platform: getPlatform(), appVersion })
      setRegistration(result)
      setStatus(null)
      setConnectionState('REGISTERED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  async function handleSignIn(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    setConnectionState('REGISTERING')
    setErrorMessage('')
    try {
      const currentUser = await authenticationService.loginWithEmailPassword(email, password)
      setPassword('')
      setUser(currentUser)
      connectorIdentityService.clearConnectorDeviceId()
      await registerConnector()
    } catch (error) {
      handleServiceError(error, true)
    }
  }

  async function refreshStatus(): Promise<void> {
    if (!user) return
    if (!connectorDeviceId) {
      setErrorMessage('Register the Connector before refreshing status.')
      setConnectionState('AUTHENTICATED')
      return
    }
    setErrorMessage('')
    try {
      setStatus(await connectorStatusService.getConnectorStatus({ installId }))
      setConnectionState('REGISTERED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  async function runConnectionTest(): Promise<void> {
    if (!user || !connectorDeviceId) {
      setErrorMessage('Register the Connector before running a connection test.')
      return
    }
    const observation = createSyntheticObservation()
    const batchId = createBatchId()
    setConnectionState('TESTING')
    setErrorMessage('')
    setLastTestObservation(observation)
    setLastTestBatchId(batchId)
    try {
      const result = await connectorObservationService.submitObservations({ installId, connectorDeviceId, batchId, observations: [observation] })
      setTestResult(result)
      setConnectionState('CONNECTED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  async function runDuplicateTest(): Promise<void> {
    if (!user || !connectorDeviceId || !lastTestObservation || !lastTestBatchId) return
    setConnectionState('TESTING')
    setErrorMessage('')
    try {
      const result = await connectorObservationService.submitObservations({ installId, connectorDeviceId, batchId: lastTestBatchId, observations: [lastTestObservation] })
      setTestResult(result)
      setConnectionState('CONNECTED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  async function runBatchTest(): Promise<void> {
    if (!user || !connectorDeviceId) return
    const observations = createSyntheticObservations(500)
    const batchId = createBatchId()
    setConnectionState('TESTING')
    setErrorMessage('')
    try {
      const firstResult = await connectorObservationService.submitObservations({ installId, connectorDeviceId, batchId, observations })
      const repeatResult = await connectorObservationService.submitObservations({ installId, connectorDeviceId, batchId, observations })
      setBatchResult({ ...repeatResult, accepted: firstResult.accepted, duplicate: repeatResult.duplicate })
      setConnectionState('CONNECTED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  async function handleLogout(): Promise<void> {
    connectorIdentityService.clearConnectorDeviceId()
    await authenticationService.logout()
    setUser(null)
    setRegistration(null)
    setStatus(null)
    setConnectionState('UNAUTHENTICATED')
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="status-panel auth-panel" aria-labelledby="app-title">
          <div className="eyebrow">Elite+ / Base44 connection</div>
          <h1 id="app-title">Elite+ Connector</h1>
          <p className="lede">Connect your Elite+ account to securely synchronize wearable and phone health data.</p>
          <form className="auth-form" onSubmit={(event) => void handleSignIn(event)}>
            <label htmlFor="email">Email</label>
            <input id="email" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
            <label htmlFor="password">Password</label>
            <input id="password" type="password" autoComplete="current-password" value={password} onChange={(event) => setPassword(event.target.value)} required />
            {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
            <button type="submit" disabled={connectionState === 'REGISTERING'}>{connectionState === 'REGISTERING' ? 'Signing In...' : 'Sign In'}</button>
          </form>
        </section>
      </main>
    )
  }

  return (
    <main className="shell">
      <section className="status-panel" aria-labelledby="app-title">
        <div className="eyebrow">Elite+ / Base44 connection</div>
        <h1 id="app-title">Elite+ Connector</h1>
        <p className="signed-in">Signed in as: <strong>{user.email}</strong></p>
        <div className="readiness" role="status">
          <span className={`readiness-dot ${connectionState === 'ERROR' ? 'is-error' : ''}`} aria-hidden="true" />
          <div><span className="label">Connector</span><strong>{registration ? 'Registered' : 'Not Registered'}</strong><small>{registration?.status ?? connectionState}</small></div>
        </div>
        <dl className="details">
          <div><dt>Platform</dt><dd>{getPlatformLabel()}</dd></div>
          <div><dt>App version</dt><dd>{appVersion}</dd></div>
          <div><dt>Install ID</dt><dd>{maskValue(installId)}</dd></div>
          <div><dt>Connector device</dt><dd>{maskValue(connectorDeviceId)}</dd></div>
          <div><dt>Last seen</dt><dd>{status?.lastSeen ?? 'Not available'}</dd></div>
          <div><dt>Last sync</dt><dd>{status?.lastSuccessfulSync ?? 'Not available'}</dd></div>
          <div><dt>Sources configured</dt><dd>{status?.configuredSourceCount ?? registration?.sources.length ?? 0}</dd></div>
        </dl>
        {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
        <div className="actions">
          <button type="button" onClick={() => void registerConnector()} disabled={isBusy}>Register Connector</button>
          <button type="button" onClick={() => void runConnectionTest()} disabled={isBusy || !registration}>Run Connection Test</button>
          <button type="button" onClick={() => void refreshStatus()} disabled={isBusy}>Refresh Status</button>
          <button type="button" className="secondary" onClick={() => void handleLogout()} disabled={isBusy}>Sign Out</button>
        </div>
        {testResult && <div className="result-panel"><h2>Base44 Connection Test</h2><p>Accepted: {testResult.accepted}</p><p>Duplicate: {testResult.duplicate}</p><p>Rejected: {testResult.rejected}</p><p>Server: Connected</p><p>Timestamp: {testResult.serverTimestamp}</p></div>}
        {import.meta.env.DEV && <aside className="diagnostics"><h2>Development diagnostics</h2><button type="button" onClick={() => void runDuplicateTest()} disabled={isBusy || !lastTestObservation}>Resubmit Last Observation</button><button type="button" onClick={() => void runBatchTest()} disabled={isBusy || !registration}>Run 500 Observation Test</button>{batchResult && <p>500 test: first accepted {batchResult.accepted}; repeat duplicates {batchResult.duplicate}; rejected {batchResult.rejected}</p>}</aside>}
      </section>
    </main>
  )
}

export default App