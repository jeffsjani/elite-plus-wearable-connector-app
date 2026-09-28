import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HealthConnectPlugin, HealthConnectRecord } from './healthConnectBridge'
import { HealthConnectAdapter } from './HealthConnectAdapter'
import { normalizeHealthConnectRecord } from './HealthConnectNormalizer'
import type { HealthConnectQueue } from './HealthConnectAdapter'

const record: HealthConnectRecord = {
  recordId: 'record-1', lastModifiedTime: '2026-09-28T10:00:00Z', metric: 'steps', value: 120,
  unit: 'count', startTime: '2026-09-28T09:00:00Z', endTime: '2026-09-28T10:00:00Z',
  originPackage: 'com.watch.vendor', zoneOffset: '+02:00', deviceManufacturer: 'Watch Vendor',
}
const plugin = {
  availability: vi.fn(), grantedPermissions: vi.fn(), requestReadPermissions: vi.fn(), openHealthConnect: vi.fn(),
  getChangesToken: vi.fn(), readHistory: vi.fn(), getChanges: vi.fn(),
} as unknown as HealthConnectPlugin
let owner: string | null
let queue: HealthConnectQueue
let enqueue: ReturnType<typeof vi.fn>
let deliver: ReturnType<typeof vi.fn>
let checkpoints: Map<string, string>
let storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

function adapter(user = 'user-a', platform = 'android'): HealthConnectAdapter {
  return new HealthConnectAdapter(user, plugin, queue, deliver, () => platform, storage)
}

beforeEach(() => {
  vi.clearAllMocks()
  owner = 'user-a'
  const ids = new Set<string>()
  enqueue = vi.fn(async (observations: Array<{ observationId: string }>) => observations.map((observation) => {
    const inserted = !ids.has(observation.observationId)
    ids.add(observation.observationId)
    return { inserted, alreadyQueued: !inserted }
  }))
  queue = { getOwnerUserId: () => owner, enqueueMany: enqueue }
  deliver = vi.fn().mockResolvedValue(null)
  checkpoints = new Map()
  storage = { getItem: (key) => checkpoints.get(key) ?? null, setItem: (key, value) => { checkpoints.set(key, value) }, removeItem: (key) => { checkpoints.delete(key) } }
  vi.mocked(plugin.availability).mockResolvedValue({ status: 'AVAILABLE' })
  vi.mocked(plugin.grantedPermissions).mockResolvedValue({ granted: ['steps'] })
  vi.mocked(plugin.requestReadPermissions).mockResolvedValue({ granted: ['steps'] })
  vi.mocked(plugin.getChangesToken).mockResolvedValue({ token: 'start-token' })
  vi.mocked(plugin.readHistory).mockResolvedValue({ records: [record] })
  vi.mocked(plugin.getChanges).mockResolvedValue({ upsertions: [], deletions: [], nextToken: 'next-token', hasMore: false, expired: false })
})

describe('direct Health Connect adapter', () => {
  it('distinguishes unsupported, missing, outdated, and available devices', async () => {
    const ios = adapter('user-a', 'ios')
    await ios.initialize()
    expect(await ios.getStatus()).toBe('unsupported')
    expect(plugin.availability).not.toHaveBeenCalled()
    for (const [availability, expected] of [['NOT_INSTALLED', 'not_installed'], ['UPDATE_REQUIRED', 'update_required'], ['UNSUPPORTED', 'unsupported'], ['AVAILABLE', 'permission_required']] as const) {
      vi.mocked(plugin.availability).mockResolvedValueOnce({ status: availability })
      const health = adapter()
      await health.initialize()
      expect(await health.getStatus()).toBe(expected)
    }
  })

  it('requires verified native grants and notices revocation', async () => {
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['steps'])
    vi.mocked(plugin.requestReadPermissions).mockResolvedValueOnce({ granted: [] })
    expect((await health.requestPermissions()).granted).toBe(false)
    expect(await health.getStatus()).toBe('connected')
    vi.mocked(plugin.grantedPermissions).mockResolvedValue({ granted: [] })
    expect(await health.getStatus()).toBe('permission_required')
    vi.mocked(plugin.grantedPermissions).mockResolvedValue({ granted: ['steps'] })
    expect((await health.requestPermissions()).granted).toBe(true)
    expect(plugin.requestReadPermissions).toHaveBeenCalledWith({ types: ['steps'] })
  })

  it('rejects missing/null values and preserves identity and origin', async () => {
    const normalized = await normalizeHealthConnectRecord('user-a', record)
    expect(normalized).toMatchObject({ source: 'health_connect', provider: 'com.watch.vendor', originPackage: 'com.watch.vendor', sourceRecordId: 'record-1', timezone: '+02:00', deviceManufacturer: 'Watch Vendor', valueNumber: 120 })
    expect((await normalizeHealthConnectRecord('user-a', record)).observationId).toBe(normalized.observationId)
    expect((await normalizeHealthConnectRecord('user-b', record)).observationId).not.toBe(normalized.observationId)
    expect((await normalizeHealthConnectRecord('user-a', { ...record, lastModifiedTime: '2026-09-28T11:00:00Z' })).observationId).not.toBe(normalized.observationId)
    await expect(normalizeHealthConnectRecord('user-a', { ...record, value: null })).rejects.toThrow()
    await expect(normalizeHealthConnectRecord('user-a', { ...record, recordId: '' })).rejects.toThrow()
  })

  it('captures a prehistory token, reads seven days and sends observations only to the queue', async () => {
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['steps'])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const result = await health.sync()
    const read = vi.mocked(plugin.readHistory).mock.calls[0][0]
    expect(Date.parse(read.endTime) - Date.parse(read.startTime)).toBe(7 * 86400000)
    expect(plugin.getChangesToken).toHaveBeenCalledBefore(plugin.readHistory as ReturnType<typeof vi.fn>)
    expect(result).toMatchObject({ samplesRetrieved: 1, newlyQueued: 1, alreadyQueued: 0 })
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    expect(checkpoints.get('health-connect:changes:user-a:steps')).toBe('next-token')
  })

  it('paginates changes, deduplicates repeats, versions updates, and counts deletions', async () => {
    checkpoints.set('health-connect:changes:user-a:steps', 'saved-token')
    vi.mocked(plugin.getChanges).mockResolvedValueOnce({ upsertions: [record], deletions: [], nextToken: 'page-2', hasMore: true, expired: false })
      .mockResolvedValueOnce({ upsertions: [record, { ...record, lastModifiedTime: '2026-09-28T11:00:00Z' }], deletions: ['deleted-id'], nextToken: 'complete', hasMore: false, expired: false })
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['steps'])
    const result = await health.sync()
    expect(plugin.readHistory).not.toHaveBeenCalled()
    expect(result).toMatchObject({ newlyQueued: 2, alreadyQueued: 1 })
    expect(health.diagnostics.lastResult?.deletedRecords).toBe(1)
    expect(checkpoints.get('health-connect:changes:user-a:steps')).toBe('complete')
  })

  it('discards expired token and does not advance a page with invalid data', async () => {
    checkpoints.set('health-connect:changes:user-a:steps', 'expired-token')
    vi.mocked(plugin.getChanges).mockResolvedValueOnce({ upsertions: [], deletions: [], nextToken: '', hasMore: false, expired: true })
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['steps'])
    await expect(health.sync()).rejects.toThrow('expired')
    expect(checkpoints.size).toBe(0)
    vi.mocked(plugin.getChanges).mockResolvedValueOnce({ upsertions: [{ ...record, value: null }], deletions: [], nextToken: 'unsafe', hasMore: false, expired: false })
    await expect(health.sync()).rejects.toThrow('not advanced')
    expect(checkpoints.get('health-connect:changes:user-a:steps')).toBe('start-token')
  })

  it('stops ingestion across logout and account changes', async () => {
    vi.mocked(plugin.readHistory).mockImplementationOnce(async () => { owner = 'user-b'; return { records: [record] } })
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['steps'])
    await expect(health.sync()).rejects.toThrow('account changed')
    expect(enqueue).not.toHaveBeenCalled()
    expect(checkpoints.size).toBe(0)
    await health.disconnect()
    expect(await health.getStatus()).toBe('permission_required')
  })
})