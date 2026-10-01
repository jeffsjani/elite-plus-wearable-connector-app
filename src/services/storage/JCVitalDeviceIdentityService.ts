const storageKey = 'jcvitalDeviceIdentityMap.v1'
const opaqueIdPrefix = 'jcvital_device_'
const opaqueIdPattern = /^jcvital_device_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

export const BLUETOOTH_MAC_PATTERN = /[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}/

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>

export function normalizeBluetoothAddress(address: string): string {
  const hex = address.replace(/[^0-9a-f]/gi, '').toUpperCase()
  return hex.length === 12 ? hex.match(/.{2}/g)!.join(':') : address.trim().toUpperCase()
}

export function isOpaqueJCVitalDeviceId(value: string | null | undefined): value is string {
  return typeof value === 'string' && opaqueIdPattern.test(value)
}

/** Maps a local-only BLE address to a random, persistent backend-facing JCVital device ID. */
export class JCVitalDeviceIdentityService {
  private readonly storage: () => KeyValueStorage

  constructor(storage: () => KeyValueStorage = () => localStorage) { this.storage = storage }

  private read(): Record<string, string> {
    try {
      const parsed = JSON.parse(this.storage().getItem(storageKey) ?? '{}') as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => isOpaqueJCVitalDeviceId(entry[1] as string)))
    } catch {
      return {}
    }
  }

  find(bleAddress: string): string | null {
    return this.read()[normalizeBluetoothAddress(bleAddress)] ?? null
  }

  resolve(bleAddress: string): string {
    const key = normalizeBluetoothAddress(bleAddress)
    const mapping = this.read()
    const existing = mapping[key]
    if (existing) return existing
    const created = `${opaqueIdPrefix}${crypto.randomUUID()}`
    this.storage().setItem(storageKey, JSON.stringify({ ...mapping, [key]: created }))
    return created
  }
}

export const jcvitalDeviceIdentityService = new JCVitalDeviceIdentityService()
