import { describe, expect, it, vi } from 'vitest'
import { JCVitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'
import { connectAndBindJournal, startDiscovery } from './ConnectionLifecycle'
import type {
  JCVitalV8DeviceInfo,
  JCVitalV8StateResult,
  SourceJournalDiagnostics,
} from './jcvitalV8Bridge'

const address = 'AA:BB:CC:DD:EE:FF'
const opaque = 'jcvital_device_11111111-2222-4333-8444-555555555555'
const diagnostics: SourceJournalDiagnostics = {
  modelVersion: 'v1', enabled: true, failedClosed: false, lastOutcome: 'CONFIGURED',
  refusedCount: 0, totalEnvelopeCount: 0, totalStoredBytes: 0, maxBytes: 10000,
  maxEnvelopes: 1000, maxEntryBytes: 1000, retentionPolicy: 'NO_EVICTION', rawStorage: 'LOCAL',
}
const info: JCVitalV8DeviceInfo = { deviceId: address, sdkVersion: '2.0', missingFields: [] }
function fixture() {
  const order: string[] = []
  const transport = {
    startScan: vi.fn(async () => { order.push('scan') }),
    connect: vi.fn(async (): Promise<JCVitalV8StateResult> => {
      order.push('identify')
      return { state: 'INITIALIZING', deviceId: address }
    }),
    configureSourceJournal: vi.fn(async (options: { enabled: boolean }) => {
      order.push(options.enabled ? 'bind' : 'retire')
      return { ...diagnostics, enabled: options.enabled }
    }),
    getConnectionState: vi.fn(async (): Promise<JCVitalV8StateResult> => ({ state: 'READY', deviceId: address })),
    getDeviceInfo: vi.fn(async () => { order.push('info'); return info }),
  }
  const resolve = vi.fn(() => { order.push('opaque'); return opaque })
  const connect = (current = () => true) => connectAndBindJournal(transport, 'account-A', address, resolve, current)
  return { order, transport, resolve, connect }
}

describe('discovery -> identification -> journal -> acquisition lifecycle', () => {
  it('scans without device identity or any journal call', async () => {
    const { transport } = fixture()
    await startDiscovery(transport, 'account-A')
    expect(transport.startScan).toHaveBeenCalledWith({ timeoutMs: 30000 })
    expect(transport.configureSourceJournal).not.toHaveBeenCalled()
    expect(transport.connect).not.toHaveBeenCalled()
  })

  it('rejects unauthenticated scanning explicitly', async () => {
    const { transport } = fixture()
    await expect(startDiscovery(transport, '')).rejects.toThrow('Authenticated account')
    expect(transport.startScan).not.toHaveBeenCalled()
  })

  it('identifies transport before resolving opaque identity and binding', async () => {
    const { order, transport, connect } = fixture()
    const result = await connect()
    expect(order).toEqual(['retire', 'identify', 'opaque', 'bind', 'info'])
    expect(result.scope).toEqual({ accountId: 'account-A', deviceScopeId: opaque })
    expect(transport.configureSourceJournal).toHaveBeenLastCalledWith({
      accountId: 'account-A', deviceScopeId: opaque, enabled: true,
    })
    expect(result.scope.deviceScopeId).not.toBe(address)
  })

  it('uses the existing saved-device opaque ID after restart', async () => {
    const values = new Map<string, string>()
    const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
    const saved = new JCVitalDeviceIdentityService(() => storage).resolve(address)
    const identity = new JCVitalDeviceIdentityService(() => storage)
    const { transport } = fixture()
    const result = await connectAndBindJournal(transport, 'account-A', address, (id) => identity.resolve(id), () => true)
    expect(result.scope.deviceScopeId).toBe(saved)
  })

  it('never substitutes a MAC for opaque scope', async () => {
    const { transport } = fixture()
    await expect(connectAndBindJournal(transport, 'account-A', address, () => address, () => true))
      .rejects.toThrow('INVALID_OPAQUE_DEVICE_SCOPE')
    expect(transport.configureSourceJournal).toHaveBeenCalledTimes(1)
    expect(transport.getDeviceInfo).not.toHaveBeenCalled()
  })

  it('journal bind failure does not gate subsequent discovery', async () => {
    const { transport, connect } = fixture()
    transport.configureSourceJournal.mockImplementation(async (options) => {
      if (options.enabled) throw new Error('STORAGE_PRESSURE')
      return { ...diagnostics, enabled: false }
    })
    await expect(connect()).rejects.toThrow('STORAGE_PRESSURE')
    expect(transport.getDeviceInfo).not.toHaveBeenCalled()
    await startDiscovery(transport, 'account-A')
    expect(transport.startScan).toHaveBeenCalledOnce()
  })

  it.each([
    { enabled: false, failedClosed: false },
    { enabled: true, failedClosed: true },
  ])('refuses acquisition readiness for invalid journal diagnostics %j', async (state) => {
    const { transport, connect } = fixture()
    transport.configureSourceJournal.mockResolvedValue({ ...diagnostics, ...state })
    await expect(connect()).rejects.toThrow('SOURCE_JOURNAL_NOT_READY')
    expect(transport.getDeviceInfo).not.toHaveBeenCalled()
  })

  it('requires READY after journal bind, not just transport connectivity', async () => {
    const { transport, connect } = fixture()
    transport.getConnectionState.mockResolvedValue({ state: 'INITIALIZING', deviceId: address })
    await expect(connect()).rejects.toThrow('SOURCE_JOURNAL_NOT_READY')
    expect(transport.getDeviceInfo).not.toHaveBeenCalled()
  })

  it('rejects a different identified device before bind', async () => {
    const { transport, connect } = fixture()
    transport.connect.mockResolvedValue({ state: 'INITIALIZING', deviceId: '11:22:33:44:55:66' })
    await expect(connect()).rejects.toThrow('identification')
    expect(transport.configureSourceJournal).toHaveBeenCalledTimes(1)
  })

  it('an account switch during identification prevents old-owner journal activation', async () => {
    const { transport, connect } = fixture()
    let current = true
    transport.connect.mockImplementation(async () => {
      current = false
      return { state: 'INITIALIZING', deviceId: address }
    })
    await expect(connect(() => current)).rejects.toThrow('Prior account')
    expect(transport.configureSourceJournal).toHaveBeenCalledTimes(1)
    expect(transport.getDeviceInfo).not.toHaveBeenCalled()
  })

  it('an account switch during bind prevents publishing old scope as ready', async () => {
    const { transport, connect } = fixture()
    let current = true
    transport.configureSourceJournal.mockImplementation(async (options) => {
      if (options.enabled) current = false
      return { ...diagnostics, enabled: options.enabled }
    })
    await expect(connect(() => current)).rejects.toThrow('Prior account')
    expect(transport.getDeviceInfo).not.toHaveBeenCalled()
  })
})
