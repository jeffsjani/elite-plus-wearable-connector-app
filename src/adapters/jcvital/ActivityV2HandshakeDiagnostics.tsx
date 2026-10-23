import { useState } from 'react'
import { activityV2CapabilityStore } from '../../services/base44/ActivityV2Capability'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { connectorRegistrationService } from '../../services/base44/ConnectorRegistrationService'
import { getBackendEnvironmentDiagnostics } from '../../services/base44/base44Environment'
import { getRegistrationPlatform } from '../../services/platform'
import { installationIdentityService } from '../../services/storage/InstallationIdentityService'

export function ActivityV2HandshakeDiagnostics({
  ownerUserId, appVersion, disabled = false, onCapabilitiesRefreshed,
}: {
  ownerUserId: string
  appVersion: string
  disabled?: boolean
  onCapabilitiesRefreshed?(): void
}) {
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [refreshError, setRefreshError] = useState('')
  const installId = installationIdentityService.getInstallId()
  const connectorDeviceId = connectorIdentityService.getConnectorDeviceId() ?? ''
  const scope = { ownerUserId, installId, connectorDeviceId }
  const handshake = activityV2CapabilityStore.getHandshakeDiagnostics(scope)
  const environment = getBackendEnvironmentDiagnostics()
  void revision

  async function refreshCapabilities() {
    if (busy || disabled || !connectorDeviceId) return
    setBusy(true)
    setRefreshError('')
    try {
      await connectorRegistrationService.refreshBase44Capabilities(
        { installId, platform: getRegistrationPlatform(), appVersion },
        scope,
      )
    } catch {
      setRefreshError('Capability refresh failed. Review the latest handshake status and response below.')
    } finally {
      setBusy(false)
      setRevision((value) => value + 1)
      onCapabilitiesRefreshed?.()
    }
  }

  return <section className="diagnostics" aria-label="Base44 registration handshake diagnostics">
    <h3>Most recent Base44 registration handshake</h3>
    <p>Attempted at: {handshake?.attemptedAt ?? 'Not available'}</p>
    <p>HTTP status: {handshake?.httpStatus ?? 'Not available'}</p>
    <p>Response received: {String(handshake?.responseReceived ?? false)}</p>
    <p>Register URL: {handshake?.resolvedRegistrationUrl ?? environment.resolvedRegistrationUrl}</p>
    <p>Production environment match: {String(handshake?.environmentMatch ?? environment.environmentMatch)}</p>
    <p>serverCapabilities raw: {handshake?.rawServerCapabilities ?? 'Not available'}</p>
    <p>Parsed capabilities: {handshake?.parsedCapabilities.join(', ') || 'None'}</p>
    <p>JCVITAL_ACTIVITY_TRANSPORT_V2 raw present: {String(handshake?.capabilityRawPresent ?? false)}</p>
    <p>JCVITAL_ACTIVITY_TRANSPORT_V2 recognized: {String(handshake?.capabilityRecognized ?? false)}</p>
    {refreshError && <p role="status">{refreshError}</p>}
    {handshake?.responseJson && <details>
      <summary>Registration response JSON (credentials redacted)</summary>
      <pre>{handshake.responseJson}</pre>
    </details>}
    <button type="button" onClick={() => void refreshCapabilities()}
      disabled={busy || disabled || !connectorDeviceId}>
      {busy ? 'Refreshing Base44 Capabilities...' : 'Refresh Base44 Capabilities'}
    </button>
  </section>
}