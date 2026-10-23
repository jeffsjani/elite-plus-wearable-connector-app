import { useEffect, useState, type FormEvent } from 'react'
import './App.css'
import { getPlatform, getRegistrationPlatform } from './services/platform'
import { installationIdentityService } from './services/storage/InstallationIdentityService'
import { authenticationService } from './services/base44/AuthenticationService'
import { connectorIdentityService } from './services/base44/ConnectorIdentityService'
import { activityV2CapabilityStore } from './services/base44/ActivityV2Capability'
import { connectorObservationService } from './services/base44/ConnectorObservationService'
import { connectorRegistrationService } from './services/base44/ConnectorRegistrationService'
import { connectorStatusService } from './services/base44/ConnectorStatusService'
import { getBackendEnvironmentDiagnostics } from './services/base44/base44Environment'
import {
  Base44ContractProbePanel, RookConnectionsPanel, AppleHealthPanel, HealthConnectPanel,
  createSyntheticObservation, createSyntheticObservations,
} from '@engineering-surfaces'
import {
  ConnectorServiceError,
  type ConnectorObservationsResponse,
  type ConnectorRegistrationResponse,
  type ConnectorStatusResponse,
  type LocalUser,
  type NativeObservationInput,
} from './services/base44/base44Types'
import type { ConnectorConnectionState } from './models/connection'
import { observationBatchManager } from './services/sync/ObservationBatchManager'
import { observationQueue } from './services/sync/ObservationQueue'
import type { QueueStats } from './services/storage/ObservationQueueStore'
import { JCVitalV8Panel } from '@jcvital-panel'
import { ConnectionDiagnosticPanel } from '@connection-diagnostic-panel'
import { IS_ACTIVITY_V2_PRODUCTION_VERIFICATION_BUILD, IS_CONNECTION_DIAGNOSTIC_BUILD, IS_ENGINEERING_BUILD } from './buildMode'
import { runNormalProductionSync } from './services/sync/NormalProductionSync'
import { registrationEvidence } from './adapters/jcvital/PipelineRegistrationEvidence'
import { ActivityV2HandshakeDiagnostics } from './adapters/jcvital/ActivityV2HandshakeDiagnostics'
import { connectorOwnerBinding } from './services/storage/ConnectorOwnerBinding'
import { V8BootstrapProvider } from './adapters/jcvital/V8PluginBootstrap'
import { JCVitalV8Panel as CompanionV8Panel, type CompanionV8Status } from './adapters/jcvital/ElitePlusV8Panel'
import { companionWellnessSession } from './wellness/CompanionWellnessSession'
import type { LocalDigitalWellness } from './wellness/health/digitalWellnessLocal'
import { CompanionShell } from './wellness/CompanionShell'
import companionBuild from '../companion-build.json'

const appVersion = companionBuild.versionName
const appVersionCode = companionBuild.versionCode

function maskValue(value: string | null): string {
  if (!value) return 'Not registered'
  return `${value.slice(0, 8)}...${value.slice(-4)}`
}

function describeError(error: unknown, isLogin = false): string {
  if (!(error instanceof ConnectorServiceError)) return 'Something went wrong. Please try again.'
  if (isLogin && error.code === 'AUTH_REQUIRED') return 'Incorrect email or password.'
  if (error.code === 'AUTH_REQUIRED' || error.code === 'UNAUTHORIZED') return 'Your Elite+ session has expired. Please sign in again.'
  if (error.code === 'NETWORK_ERROR') return 'Network error. Check your connection and try again.'
  if (error.code === 'FORBIDDEN') return 'This Elite+ account is not allowed to use this connection.'
  return 'We couldn’t complete that request. Please try again.'
}

function getPlatformLabel(): string {
  const platform = getPlatform()
  return platform === 'ios' ? 'iOS' : platform === 'android' ? 'Android' : 'Web'
}

function BackendEnvironmentPanel() {
  const environment = getBackendEnvironmentDiagnostics()
  return (
    <section className="diagnostics" aria-label="Backend environment diagnostics">
      <h2>Backend environment</h2>
      {!environment.environmentMatch && <p className="error-message" role="alert"><strong>BACKEND ENVIRONMENT MISMATCH</strong></p>}
      <p>Expected host: {environment.expectedHost} · resolved host: {environment.resolvedHost}</p>
      <p>Observations: {environment.resolvedObservationsUrl}</p>
      <p>Registration: {environment.resolvedRegistrationUrl}</p>
      <p>Environment match: {String(environment.environmentMatch)}</p>
    </section>
  )
}

function createBatchId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getProductionSyncOwners(authenticatedOwnerUserId: string) {
  const binding = connectorOwnerBinding.read()
  const currentConnectorDeviceId = connectorIdentityService.getConnectorDeviceId()
  return {
    authenticatedOwnerUserId,
    persistedConnectorOwnerUserId: binding && binding.connectorDeviceId === currentConnectorDeviceId ? binding.ownerUserId : null,
    connectorDeviceId: currentConnectorDeviceId,
  }
}

function App() {
  const [wellness, setWellness] = useState<LocalDigitalWellness | null>(null)
  const [companionView, setCompanionView] = useState(true)
  const [v8Status, setV8Status] = useState<CompanionV8Status>()
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
  const [capabilityStoreRevision, setCapabilityStoreRevision] = useState(0)
  const installId = installationIdentityService.getInstallId()
  const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
  const capabilityScope = {
    ownerUserId: user?.id ?? '',
    installId,
    connectorDeviceId: connectorDeviceId ?? '',
  }
  const activityV2Decision = activityV2CapabilityStore.getDecision({
    ...capabilityScope,
  })
  void capabilityStoreRevision
  const isBusy = ['REGISTERING', 'TESTING'].includes(connectionState)

  useEffect(() => {
    if (!import.meta.env.DEV || IS_ENGINEERING_BUILD) return

    const assertViewportFits = () => {
      const documentWidth = document.documentElement.scrollWidth
      const viewportWidth = document.documentElement.clientWidth
      if (documentWidth > viewportWidth) {
        console.error(`[responsive-layout] document width ${documentWidth}px exceeds viewport ${viewportWidth}px`)
      }
    }
    window.addEventListener('resize', assertViewportFits)
    assertViewportFits()
    return () => window.removeEventListener('resize', assertViewportFits)
  }, [])

  function handleServiceError(error: unknown, isLogin = false): void {
    const isExpired = error instanceof ConnectorServiceError &&
      (error.code === 'AUTH_REQUIRED' || error.code === 'UNAUTHORIZED') && !isLogin

    if (isExpired) {
      setWellness(null)
      void companionWellnessSession.closeAuthenticatedUser().catch((failure: unknown) => {
        console.error('Digital Wellness sign-out failed', failure)
        setErrorMessage('Digital Wellness could not be stopped. Please retry signing out.')
      })
      connectorIdentityService.clearConnectorDeviceId()
      connectorOwnerBinding.clear()
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
    observationQueue.setOwnerUserId(currentUser.id)
    try {
      await observationQueue.initialize()
    } catch (error) {
      // Queue diagnostics retain the cause; queue use retries initialization, so sign-in continues.
      if (IS_ENGINEERING_BUILD) console.error('Observation queue initialization failed', error)
    }
    await refreshQueueStats().catch(() => undefined)
  }

  async function startDurableQueueResume(): Promise<void> {
    await observationBatchManager.start({
      restoredBackendDeviceId: connectorIdentityService.getConnectorDeviceId() !== null,
      persistedDeliveryEnablement: false,
    })
    await refreshQueueStats().catch(() => undefined)
  }

  useEffect(() => {
    let active = true

    async function restoreSession(): Promise<void> {
      try {
        if (!(await authenticationService.isAuthenticated())) {
          await companionWellnessSession.closeAuthenticatedUser()
          return
        }
        const currentUser = await authenticationService.getCurrentUser()
        if (!active) return
        if (!currentUser) {
          await companionWellnessSession.closeAuthenticatedUser()
          return
        }
        const currentWellness = await companionWellnessSession.activateAuthenticatedUser(currentUser)
        if (!active) return
        setWellness(currentWellness)
        setUser(currentUser)
        setConnectionState('AUTHENTICATED')
        setErrorMessage('')
        await prepareQueue(currentUser)
        await registerConnector(currentUser.id)
        if (!active) return
        await startDurableQueueResume()
      } catch (error) {
        if (!active) return
        handleServiceError(error)
      }
    }

    void restoreSession()
    return () => { active = false }
  }, [installId])

  async function registerConnector(ownerUserId: string): Promise<void> {
    setConnectionState('REGISTERING')
    setErrorMessage('')
    try {
      const result = await connectorRegistrationService.registerConnector(
        { installId: installationIdentityService.getInstallId(), platform: getRegistrationPlatform(), appVersion },
        ownerUserId,
      )
      setRegistration(result)
      if (result.connectorDeviceId) connectorOwnerBinding.bind(ownerUserId, result.connectorDeviceId)
      if (IS_ENGINEERING_BUILD) {
        try {
          localStorage.setItem('v8.pipeline.registration.32A', JSON.stringify(registrationEvidence(result, observationQueue.getOwnerUserId())))
        } catch (error) {
          console.error('Pipeline registration evidence persistence failed', error)
          setErrorMessage('Pipeline registration evidence could not be saved. Export will mark persisted owner as unknown.')
        }
      }
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
      const currentWellness = await companionWellnessSession.activateAuthenticatedUser(currentUser)
      setWellness(currentWellness)
      setPassword('')
      setUser(currentUser)
      await prepareQueue(currentUser)
      await registerConnector(currentUser.id)
      await startDurableQueueResume()
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
    try {
      await companionWellnessSession.closeAuthenticatedUser()
    } catch (failure) {
      console.error('Digital Wellness sign-out failed', failure)
      setErrorMessage('Digital Wellness could not be stopped. Please retry signing out.')
      return
    }
    setWellness(null)
    observationBatchManager.pause()
    observationBatchManager.stop()
    observationQueue.setOwnerUserId(null)
    connectorIdentityService.clearConnectorDeviceId()
    connectorOwnerBinding.clear()
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
      const result = await runNormalProductionSync()
      if (result) setTestResult(result)
      await refreshQueueStats()
      setConnectionState('CONNECTED')
    } catch (error) {
      handleServiceError(error)
    }
  }

  if (!user) {
    return (
      <main className={IS_ENGINEERING_BUILD ? 'shell engineering-shell' : 'shell'}>
        <section className={`status-panel auth-panel${IS_ENGINEERING_BUILD ? ' engineering-content' : ''}`} aria-labelledby="app-title">
          <div className="elite-v8-brand" aria-label="Elite Plus">Elite<span>+</span></div>
          <p className="eyebrow">{IS_ENGINEERING_BUILD ? 'Engineering access' : 'Your wearable connection'}</p>
          <h1 id="app-title">Elite+ Companion</h1>
          {IS_ENGINEERING_BUILD && <BackendEnvironmentPanel />}
          <p className="lede">{IS_ENGINEERING_BUILD
            ? 'Connect your Elite+ account to inspect and validate wearable data.'
            : 'Connect your Elite+ account to pair your Elite+ V8 and sync device data.'}</p>
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

  if (!IS_ENGINEERING_BUILD || companionView) {
    return (
      <V8BootstrapProvider authenticated={Boolean(user) && getPlatform() === 'android'} ownerUserId={user.id}>
      <CompanionShell
        wellness={wellness}
        status={v8Status}
        error={errorMessage}
        onSignOut={() => void handleLogout()}
        onEngineering={IS_ENGINEERING_BUILD ? () => setCompanionView(false) : undefined}
        v8={<>
          {!registration && !isBusy && <button className="elite-v8-button app-retry" type="button" onClick={() => void registerConnector(user.id)}>Try Again</button>}
          {getPlatform() === 'android'
            ? <CompanionV8Panel
              key={`jcvital-${user.id}`}
              ownerUserId={user.id}
              onSync={() => void syncNow()}
              syncBusy={connectionState === 'TESTING'}
              syncError={connectionState === 'ERROR' ? errorMessage : ''}
              syncEnabled={Boolean(registration && connectorDeviceId)}
              appVersion={appVersion}
              appVersionCode={appVersionCode}
              getSyncOwners={() => getProductionSyncOwners(user.id)}
              onSyncFinished={() => void refreshQueueStats().catch(() => undefined)}
              onCompanionStatus={setV8Status}
            />
            : <section className="elite-v8-card elite-v8-platform-message" role="status">
              <h1>Elite+ V8</h1>
              <p>Connect your Elite+ V8 using the Android app.</p>
            </section>}
          {getPlatform() === 'android' && (IS_CONNECTION_DIAGNOSTIC_BUILD || IS_ENGINEERING_BUILD) && (
            <ConnectionDiagnosticPanel
              key={`connection-diagnostic-${user.id}`}
              ownerUserId={user.id}
              appVersion={appVersion}
              versionCode={appVersionCode}
              platform={getPlatform()}
            />
          )}
          {IS_ACTIVITY_V2_PRODUCTION_VERIFICATION_BUILD && <ActivityV2HandshakeDiagnostics
            ownerUserId={user.id} appVersion={appVersion} disabled={isBusy}
            onCapabilitiesRefreshed={() => setCapabilityStoreRevision((revision) => revision + 1)} />}
        </>}
      />
      </V8BootstrapProvider>
    )
  }

  return (
    <V8BootstrapProvider authenticated={Boolean(user) && getPlatform() === 'android'} ownerUserId={user.id}>
    <main className="shell engineering-shell">
      <section className="status-panel engineering-content" aria-labelledby="app-title">
        <div className="eyebrow">Elite+ / Connector connection</div>
        <h1 id="app-title">Elite+ Connector</h1>
        <button onClick={() => setCompanionView(true)}>Back to Companion</button>
        {getPlatform() === 'android' && <JCVitalV8Panel
          key={`jcvital-${user.id}`}
          ownerUserId={user.id}
          onSync={() => void syncNow()}
          syncBusy={connectionState === 'TESTING'}
          syncError={connectionState === 'ERROR' ? errorMessage : ''}
          syncEnabled={Boolean(registration && connectorDeviceId)}
          appVersion={appVersion}
          appVersionCode={appVersionCode}
          getSyncOwners={() => getProductionSyncOwners(user.id)}
          onSyncFinished={() => void refreshQueueStats().catch(() => undefined)}
        />}
        <BackendEnvironmentPanel />
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
        {IS_ENGINEERING_BUILD && <section className="diagnostics" aria-label="Activity v2 capability diagnostics">
          <h2>Activity v2 capability gate</h2>
          <p>Enabled: {String(activityV2Decision.productionDeliveryEnabled)}</p>
          <p>Capability received: {String(activityV2Decision.capabilityReceived)}</p>
          <p>Decision: {activityV2Decision.reason}</p>
          <p>Server contract: {activityV2Decision.responseContractVersion ?? 'Not advertised'}</p>
          <p>Server revision: {activityV2Decision.deploymentRevision ?? 'Not advertised'}</p>
          <p>Registration received: {activityV2Decision.receivedAt || 'Not available'}</p>
          <p>Evaluation time: {activityV2Decision.evaluatedAt || 'Not available'}</p>
          <ActivityV2HandshakeDiagnostics ownerUserId={user.id} appVersion={appVersion} disabled={isBusy} />
        </section>}
        <details><summary>Backend contract diagnostics</summary>
          <Base44ContractProbePanel installId={installId} connectorDeviceId={connectorDeviceId} />
        </details>
        {errorMessage && <p className="error-message" role="alert">{errorMessage}</p>}
        <div className="actions">
          <button type="button" onClick={() => void registerConnector(user.id)} disabled={isBusy}>Register Connector</button>
          <button type="button" onClick={() => void runConnectionTest()} disabled={isBusy || !registration}>Run Connection Test</button>
          <button type="button" onClick={() => void refreshStatus()} disabled={isBusy}>Refresh Status</button>
          <button type="button" className="secondary" onClick={() => void handleLogout()} disabled={isBusy}>Sign Out</button>
        </div>
        <RookConnectionsPanel key={user.id} />
        {getPlatform() === 'ios' && <AppleHealthPanel key={`apple-${user.id}`} ownerUserId={user.id} />}
        {getPlatform() === 'android' && <HealthConnectPanel key={`health-${user.id}`} ownerUserId={user.id} />}
        {queueStats && <div className="queue-panel"><h2>Sync Queue</h2><div className="queue-stats"><span>Pending: <strong>{queueStats.pending}</strong></span><span>Retrying: <strong>{queueStats.retrying}</strong></span><span>Failed: <strong>{queueStats.failed}</strong></span></div><p>Oldest pending: {queueStats.oldestPendingAgeMs === null ? 'None' : `${Math.round(queueStats.oldestPendingAgeMs / 60000)} minutes`}</p><p>Last successful sync: {queueStats.lastSuccessfulUploadAt ?? 'Not available'}</p>{queueStats.warnings.length > 0 && <p className="warning-message">Queue diagnostics: {queueStats.warnings.join(', ')}</p>}<button type="button" onClick={() => void syncNow()} disabled={isBusy}>Sync Now</button></div>}
        {testResult && <div className="result-panel"><h2>Connector Connection Test</h2><p>Accepted: {testResult.accepted}</p><p>Duplicate: {testResult.duplicate}</p><p>Rejected: {testResult.rejected}</p><p>Server: Connected</p><p>Timestamp: {testResult.serverTimestamp}</p></div>}
        {import.meta.env.DEV && <aside className="diagnostics"><h2>Development diagnostics</h2><button type="button" onClick={() => void runDuplicateTest()} disabled={isBusy || !lastTestObservation}>Resubmit Last Observation</button><button type="button" onClick={() => void runQueueBatchTest()} disabled={isBusy || !registration}>Run 100 Queue Test</button><button type="button" onClick={() => void runQueueDuplicateRetryTest()} disabled={isBusy || !lastQueueObservations.length}>Retry Last 100 Queue Test</button><button type="button" onClick={() => void runBatchTest()} disabled={isBusy || !registration}>Run 500 Observation Test</button>{queueTestResult && <p>100 queue test: accepted {queueTestResult.accepted}; duplicate {queueTestResult.duplicate}; rejected {queueTestResult.rejected}</p>}{queueDuplicateResult && <p>100 queue retry: accepted {queueDuplicateResult.accepted}; duplicate {queueDuplicateResult.duplicate}; rejected {queueDuplicateResult.rejected}</p>}{batchResult && <p>500 test: first accepted {batchResult.accepted}; repeat duplicates {batchResult.duplicate}; rejected {batchResult.rejected}</p>}</aside>}
      </section>
    </main>
    </V8BootstrapProvider>
  )
}

export default App