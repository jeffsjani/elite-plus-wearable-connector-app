import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import type { JCVitalV8Plugin, SourceJournalScope } from './jcvitalV8Bridge'

type Transport = Pick<JCVitalV8Plugin, 'startScan' | 'connect' | 'configureSourceJournal' | 'getConnectionState' | 'getDeviceInfo'>

export async function startDiscovery(transport: Transport, accountId: string): Promise<void> {
  if (!accountId.trim()) throw new Error('Authenticated account required for Bluetooth discovery.')
  await transport.startScan({ timeoutMs: 30000 })
}

export async function connectAndBindJournal(
  transport: Transport,
  accountId: string,
  deviceId: string,
  resolveOpaqueId: (address: string) => string,
  isCurrentAccount: () => boolean,
) {
  const checkAccount = () => {
    if (!accountId.trim() || !isCurrentAccount()) throw new Error('Prior account connection context rejected.')
  }
  checkAccount()
  // Retire any prior acquisition before creating a discovery-only transport.
  await transport.configureSourceJournal({ enabled: false })
  checkAccount()
  const identified = await transport.connect({ deviceId })
  checkAccount()
  if (identified.deviceId !== deviceId || identified.state !== 'INITIALIZING') {
    throw new Error('V8 transport identification did not complete.')
  }
  const deviceScopeId = resolveOpaqueId(identified.deviceId)
  if (!isOpaqueJCVitalDeviceId(deviceScopeId)) throw new Error('INVALID_OPAQUE_DEVICE_SCOPE')
  const scope: SourceJournalScope = { accountId, deviceScopeId }
  const diagnostics = await transport.configureSourceJournal({ ...scope, enabled: true })
  checkAccount()
  if (!diagnostics.enabled || diagnostics.failedClosed) throw new Error('SOURCE_JOURNAL_NOT_READY')
  const connection = await transport.getConnectionState()
  checkAccount()
  if (connection.state !== 'READY' || connection.deviceId !== deviceId) throw new Error('SOURCE_JOURNAL_NOT_READY')
  const info = await transport.getDeviceInfo()
  checkAccount()
  return { scope, diagnostics, info }
}
