import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { HealthPlugin, HealthSample, Workout } from './healthKitBridge'
import { AppleHealthAdapter, normalizeHealthRecord } from './AppleHealthAdapter'
import type { AppleHealthQueue } from './AppleHealthAdapter'

const sample: HealthSample = {
  value: 72, unit: 'bpm', startDate: new Date(Date.now() - 3600000).toISOString(),
  endDate: new Date(Date.now() - 3590000).toISOString(), platformId: 'hk-uuid-1',
  sourceName: 'Apple Watch', sourceId: 'com.apple.watch',
}
const plugin = {
  isAvailable: vi.fn(), requestAuthorization: vi.fn(), readSamples: vi.fn(), queryWorkouts: vi.fn(),
} as unknown as HealthPlugin
let owner: string | null
let ids: Set<string>
let enqueue: ReturnType<typeof vi.fn>
let queue: AppleHealthQueue
let checkpoint: Map<string, string>
let storage: Pick<Storage, 'getItem' | 'setItem'>
let deliver: ReturnType<typeof vi.fn>

function adapter(user = 'user-a', platform = 'ios', lookback = 7): AppleHealthAdapter {
  return new AppleHealthAdapter(user, plugin, queue, deliver, () => platform, storage, lookback)
}

beforeEach(() => {
  vi.clearAllMocks()
  owner = 'user-a'
  ids = new Set()
  checkpoint = new Map()
  storage = { getItem: (key) => checkpoint.get(key) ?? null, setItem: (key, value) => { checkpoint.set(key, value) } }
  enqueue = vi.fn(async (records: Array<{ observationId: string }>) => records.map((record) => {
    const inserted = !ids.has(record.observationId)
    ids.add(record.observationId)
    return { inserted, alreadyQueued: !inserted }
  }))
  queue = { getOwnerUserId: () => owner, enqueueMany: enqueue }
  deliver = vi.fn().mockResolvedValue(null)
  vi.mocked(plugin.isAvailable).mockResolvedValue({ available: true })
  vi.mocked(plugin.requestAuthorization).mockResolvedValue({ readAuthorized: ['heartRate'], readDenied: [] })
  vi.mocked(plugin.readSamples).mockImplementation(async ({ startDate, endDate }) => ({
    samples: sample.startDate >= startDate! && sample.startDate < endDate! ? [sample] : [],
  }))
  vi.mocked(plugin.queryWorkouts).mockResolvedValue({ workouts: [] })
})

describe('direct Apple Health adapter', () => {
  it('initializes on iOS and reports unsupported on other platforms', async () => {
    const supported = adapter()
    await supported.initialize()
    expect(await supported.getStatus()).toBe('permission_required')
    const unsupported = adapter('user-a', 'android')
    await unsupported.initialize()
    expect(await unsupported.getStatus()).toBe('unsupported')
    expect(plugin.isAvailable).toHaveBeenCalledTimes(1)
  })

  it('requests only selected read types without claiming iOS read grant', async () => {
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['heartRate'])
    expect(await health.requestPermissions()).toEqual({ granted: false, permissions: ['heartRate'], denied: [] })
    expect(plugin.requestAuthorization).toHaveBeenCalledWith({ read: ['heartRate'] })
    vi.mocked(plugin.requestAuthorization).mockResolvedValueOnce({ readAuthorized: [], readDenied: ['heartRate'] })
    expect((await health.requestPermissions()).denied).toEqual(['heartRate'])
  })

  it('normalizes identifiers, origin, end time, and missing values safely', async () => {
    const normalized = await normalizeHealthRecord('user-a', 'heartRate', sample)
    expect(normalized).toMatchObject({ source: 'apple_health', metric: 'heartRate', valueNumber: 72, unit: 'bpm', provider: 'Apple Watch', sourceRecordId: 'hk-uuid-1', sourceId: 'com.apple.watch', endTime: sample.endDate })
    expect((await normalizeHealthRecord('user-a', 'heartRate', sample)).observationId).toBe(normalized.observationId)
    expect((await normalizeHealthRecord('user-b', 'heartRate', sample)).observationId).not.toBe(normalized.observationId)
    await expect(normalizeHealthRecord('user-a', 'heartRate', { ...sample, value: null } as unknown as HealthSample)).rejects.toThrow()
    await expect(normalizeHealthRecord('user-a', 'heartRate', { ...sample, platformId: undefined } as unknown as HealthSample)).rejects.toThrow()
    const workout: Workout = { platformId: 'workout-1', workoutType: 'running', duration: 1800, startDate: sample.startDate, endDate: sample.endDate, sourceName: 'Watch' }
    expect(await normalizeHealthRecord('user-a', 'workouts', workout)).toMatchObject({ metric: 'workout_running', unit: 'second', valueNumber: 1800 })
  })

  it('reads seven days, queues once, checkpoints, and avoids historical duplicates', async () => {
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['heartRate'])
    const first = await health.sync()
    expect(first).toMatchObject({ samplesRetrieved: 1, newlyQueued: 1, alreadyQueued: 0, failedNormalization: 0 })
    expect(await health.getStatus()).toBe('connected')
    expect(enqueue).toHaveBeenCalledTimes(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect(checkpoint.size).toBe(1)
    await health.sync({ since: new Date(Date.now() - 2 * 3600000).toISOString() })
    expect(health.diagnostics.lastResult?.alreadyQueued).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    const resumed = adapter()
    await resumed.initialize()
    resumed.setSelectedTypes(['heartRate'])
    await resumed.sync()
    expect(enqueue).toHaveBeenCalledTimes(3)
  })

  it('does not treat empty data as proof of permission and skips invalid records', async () => {
    vi.mocked(plugin.readSamples).mockResolvedValueOnce({ samples: [{ ...sample, value: null } as unknown as HealthSample] })
    const health = adapter('user-a', 'ios', 0.01)
    await health.initialize()
    health.setSelectedTypes(['heartRate'])
    const result = await health.sync()
    expect(result.failedNormalization).toBe(1)
    expect(result.newlyQueued).toBe(0)
    expect(await health.getStatus()).toBe('permission_required')
    expect(enqueue).not.toHaveBeenCalled()
  })

  it('stops on logout/account change without enqueuing or direct server calls', async () => {
    vi.mocked(plugin.readSamples).mockImplementationOnce(async () => {
      owner = 'user-b'
      return { samples: [sample] }
    })
    const health = adapter()
    await health.initialize()
    health.setSelectedTypes(['heartRate'])
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    await expect(health.sync({ since: new Date(Date.now() - 2 * 3600000).toISOString() })).rejects.toThrow('account changed')
    expect(enqueue).not.toHaveBeenCalled()
    expect(deliver).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
    await health.disconnect()
    expect(await health.getStatus()).toBe('permission_required')
  })

  it('does not advance checkpoint when a sample query is saturated', async () => {
    vi.mocked(plugin.readSamples).mockResolvedValueOnce({ samples: Array(5000).fill(sample) })
    const health = adapter('user-a', 'ios', 0.01)
    await health.initialize()
    health.setSelectedTypes(['heartRate'])
    await expect(health.sync()).rejects.toThrow('query limit')
    expect(checkpoint.size).toBe(0)
  })
})