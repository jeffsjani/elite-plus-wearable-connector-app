import type { ConnectorRegistrationResponse } from '../../services/base44/base44Types'

export function registrationEvidence(response: ConnectorRegistrationResponse, localOwner: string | null) {
  const raw: Record<string, unknown> = { ...response }
  const owners = ['ownerUserId', 'accountId', 'userId', 'athleteId'].flatMap((key) =>
    typeof raw[key] === 'string' ? [{ scope: `NativeConnector response.${key}`, owner: raw[key] as string, authority: 'SERVER_RETURNED' }] : [])
  return {
    localOwner,
    connectorDeviceId: response.connectorDeviceId,
    installId: response.installId,
    registeredAt: response.registeredAt,
    lastRegistrationCheckIn: response.serverTimestamp,
    serverOwners: owners,
  }
}
