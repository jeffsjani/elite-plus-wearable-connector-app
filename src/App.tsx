import { useEffect, useState, type FormEvent } from 'react'
import './App.css'
import { getPlatform, getRegistrationPlatform } from './services/platform'
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
import { observationBatchManager } from './services/sync/ObservationBatchManager'
import { observationQueue } from './services/sync/ObservationQueue'
import type { QueueStats } from './services/storage/ObservationQueueStore'
import { RookConnectionsPanel } from './services/rook/RookConnectionsPanel'
import { AppleHealthPanel } from './adapters/apple-health/AppleHealthPanel'
import { HealthConnectPanel } from './adapters/health-connect/HealthConnectPanel'
import { JCVitalV8Panel } from './adapters/jcvital/JCVitalV8Panel'

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
  const [queueTestResult, setQueueTestResult] = useState<ConnectorObservationsResponse | null>(null)
  const [lastQueueObservations, setLastQueueObservations] = useState<NativeObservationInput[]>([])
  const [queueDuplicateResult, setQueueDuplicateResult] = useState<ConnectorObservationsResponse | null>(null)
  const [lastTestObservation, setLastTestObservation] = useState<NativeObservationInput | null>(null)
  const [lastTestBatchId, setLastTestBatchId] = useState('')
  const [queueStats, setQueueStats] = useState<QueueStats | null>(null)
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

  async function refreshQueueStats(): Promise<void> {
    if (!observationQueue.getOwnerUserId()) return
    setQueueStats(await observationQueue.getQueueStats())
  }

  async function prepareQueue(currentUser: LocalUser): Promise<void> {
    await observationQueue.initialize()
    observationQueue.setOwnerUserId(currentUser.id)
    observationBatchManager.resume()
    observationBatchManager.start()
    await refreshQueueStats()
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
        await prepareQueue(currentUser)
        const result = await connectorRegistrationService.registerConnector({ installId: installationIdentityService.getInstallId(), platform: getRegistrationPlatform(), appVersion })
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
      const result = await connectorRegistrationService.registerConnector({ installId: installationIdentityService.getInstallId(), platform: getRegistrationPlatform(), appVersion })
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
      await prepareQueue(currentUser)
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
      await observationQueue.enqueue(observation)
      const result = await observationBatchManager.process()
      await refreshQueueStats()
      if (result) setTestResult(result)
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

  async function runQueueBatchTest(): Promise<void> {
    if (!user || !connectorDeviceId) return
    setConnectionState('TESTING')
    setErrorMessage('')
    try {
      const observations = createSyntheticObservations(100, 'connector_batch_test')
      setLastQueueObservations(observations)
      await observationQueue.enqueueMany(observations)
      const result = await observationBatchManager.process()
      if (result) setQueueTestResult(result)
      await refreshQueueStats()
      setConnectionState('CONNECTED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  async function runQueueDuplicateRetryTest(): Promise<void> {
    if (!user || !connectorDeviceId || !lastQueueObservations.length) return
    setConnectionState('TESTING')
    setErrorMessage('')
    try {
      await observationQueue.enqueueMany(lastQueueObservations)
      const result = await observationBatchManager.process()
      if (result) setQueueDuplicateResult(result)
      await refreshQueueStats()
      setConnectionState('CONNECTED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  async function handleLogout(): Promise<void> {
    observationBatchManager.pause()
    observationBatchManager.stop()
    observationQueue.setOwnerUserId(null)
    connectorIdentityService.clearConnectorDeviceId()
    await authenticationService.logout()
    setUser(null)
    setRegistration(null)
    setStatus(null)
    setQueueStats(null)
    setConnectionState('UNAUTHENTICATED')
  }

  async function syncNow(): Promise<void> {
    setErrorMessage('')
    setConnectionState('TESTING')
    try {
      const result = await observationBatchManager.process()
      if (result) setTestResult(result)
      await refreshQueueStats()
      setConnectionState('CONNECTED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  if (!user) {
    return (
      <main className="shell">
        <section className="status-panel auth-panel" aria-labelledby="app-title">
          <div className="eyebrow">Elite+ / Connector connection</div>
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
        <div className="eyebrow">Elite+ / Connector connection</div>
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
        <RookConnectionsPanel key={user.id} />
        {getPlatform() === 'ios' && <AppleHealthPanel key={`apple-${user.id}`} ownerUserId={user.id} />}
        {getPlatform() === 'android' && <HealthConnectPanel key={`health-${user.id}`} ownerUserId={user.id} />}
        {getPlatform() === 'android' && <JCVitalV8Panel key={`jcvital-${user.id}`} />}
        {queueStats && <div className="queue-panel"><h2>Sync Queue</h2><div className="queue-stats"><span>Pending: <strong>{queueStats.pending}</strong></span><span>Retrying: <strong>{queueStats.retrying}</strong></span><span>Failed: <strong>{queueStats.failed}</strong></span></div><p>Oldest pending: {queueStats.oldestPendingAgeMs === null ? 'None' : `${Math.round(queueStats.oldestPendingAgeMs / 60000)} minutes`}</p><p>Last successful sync: {queueStats.lastSuccessfulUploadAt ?? 'Not available'}</p>{queueStats.warnings.length > 0 && <p className="warning-message">Queue diagnostics: {queueStats.warnings.join(', ')}</p>}<button type="button" onClick={() => void syncNow()} disabled={isBusy}>Sync Now</button></div>}
        {testResult && <div className="result-panel"><h2>Connector Connection Test</h2><p>Accepted: {testResult.accepted}</p><p>Duplicate: {testResult.duplicate}</p><p>Rejected: {testResult.rejected}</p><p>Server: Connected</p><p>Timestamp: {testResult.serverTimestamp}</p></div>}
        {import.meta.env.DEV && <aside className="diagnostics"><h2>Development diagnostics</h2><button type="button" onClick={() => void runDuplicateTest()} disabled={isBusy || !lastTestObservation}>Resubmit Last Observation</button><button type="button" onClick={() => void runQueueBatchTest()} disabled={isBusy || !registration}>Run 100 Queue Test</button><button type="button" onClick={() => void runQueueDuplicateRetryTest()} disabled={isBusy || !lastQueueObservations.length}>Retry Last 100 Queue Test</button><button type="button" onClick={() => void runBatchTest()} disabled={isBusy || !registration}>Run 500 Observation Test</button>{queueTestResult && <p>100 queue test: accepted {queueTestResult.accepted}; duplicate {queueTestResult.duplicate}; rejected {queueTestResult.rejected}</p>}{queueDuplicateResult && <p>100 queue retry: accepted {queueDuplicateResult.accepted}; duplicate {queueDuplicateResult.duplicate}; rejected {queueDuplicateResult.rejected}</p>}{batchResult && <p>500 test: first accepted {batchResult.accepted}; repeat duplicates {batchResult.duplicate}; rejected {batchResult.rejected}</p>}</aside>}
      </section>
    </main>
  )
}

export default App