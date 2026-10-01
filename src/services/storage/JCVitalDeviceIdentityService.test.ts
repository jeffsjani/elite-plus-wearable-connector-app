import { describe, expect, it } from 'vitest'
import { JCVitalDeviceIdentityService, normalizeBluetoothAddress } from './JCVitalDeviceIdentityService'

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

const TEST_MAC = 'E7:1B:D8:36:78:CF'
const OPAQUE = /^jcvital_device_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

describe('JCVital device identity mapping', () => {
  it('creates an opaque random ID for a first-seen MAC', () => {
    const storage = new MemoryStorage()
    const id = new JCVitalDeviceIdentityService(() => storage).resolve(TEST_MAC)
    expect(id).toMatch(OPAQUE)
    expect(id.toUpperCase()).not.toContain('E71BD83678CF')
    expect(id.toUpperCase()).not.toContain(TEST_MAC)
  })

  it('resolves the same MAC, in any notation, to the same ID', () => {
    const service = new JCVitalDeviceIdentityService(() => new MemoryStorage())
    const shared = new MemoryStorage()
    const persistent = new JCVitalDeviceIdentityService(() => shared)
    const id = persistent.resolve(TEST_MAC)
    expect(persistent.resolve('e7:1b:d8:36:78:cf')).toBe(id)
    expect(persistent.resolve('E7-1B-D8-36-78-CF')).toBe(id)
    expect(persistent.find(TEST_MAC)).toBe(id)
    expect(service.find(TEST_MAC)).toBeNull()
  })

  it('creates different IDs for different MACs and is not derived from the MAC', () => {
    const service = new JCVitalDeviceIdentityService(() => new MemoryStorage())
    expect(service.resolve(TEST_MAC)).not.toBe(service.resolve('AA:BB:CC:DD:EE:FF'))
    expect(new JCVitalDeviceIdentityService(() => new MemoryStorage()).resolve(TEST_MAC))
      .not.toBe(new JCVitalDeviceIdentityService(() => new MemoryStorage()).resolve(TEST_MAC))
  })

  it('preserves the mapping across app restarts sharing durable storage', () => {
    const durable = new MemoryStorage()
    const beforeRestart = new JCVitalDeviceIdentityService(() => durable).resolve(TEST_MAC)
    const afterRestart = new JCVitalDeviceIdentityService(() => durable)
    expect(afterRestart.find(TEST_MAC)).toBe(beforeRestart)
    expect(afterRestart.resolve(TEST_MAC)).toBe(beforeRestart)
  })

  it('ignores corrupt or non-opaque stored entries', () => {
    const storage = new MemoryStorage()
    storage.setItem('jcvitalDeviceIdentityMap.v1', JSON.stringify({ [TEST_MAC]: TEST_MAC }))
    const id = new JCVitalDeviceIdentityService(() => storage).resolve(TEST_MAC)
    expect(id).toMatch(OPAQUE)
    storage.setItem('jcvitalDeviceIdentityMap.v1', 'not json')
    expect(new JCVitalDeviceIdentityService(() => storage).resolve(TEST_MAC)).toMatch(OPAQUE)
  })

  it('normalizes MAC notation locally', () => {
    expect(normalizeBluetoothAddress('e7-1b-d8-36-78-cf')).toBe(TEST_MAC)
    expect(normalizeBluetoothAddress('e71bd83678cf')).toBe(TEST_MAC)
  })
})
