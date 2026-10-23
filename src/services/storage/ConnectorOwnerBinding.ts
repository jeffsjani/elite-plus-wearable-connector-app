type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const STORAGE_KEY = 'elitePlus.connectorOwner.v1'

export interface ConnectorOwnerBinding {
  ownerUserId: string
  connectorDeviceId: string
  boundAt: string
}

/** Persisted Connector owner, written after a verified registration and cleared on sign-out. Never migrated. */
export class ConnectorOwnerBindingStore {
  private readonly storage: () => KeyValueStorage

  constructor(storage: () => KeyValueStorage = () => localStorage) { this.storage = storage }

  read(): ConnectorOwnerBinding | null {
    try {
      const parsed = JSON.parse(this.storage().getItem(STORAGE_KEY) ?? 'null') as Partial<ConnectorOwnerBinding> | null
      if (!parsed || typeof parsed.ownerUserId !== 'string' || !parsed.ownerUserId || typeof parsed.connectorDeviceId !== 'string' || !parsed.connectorDeviceId) return null
      return { ownerUserId: parsed.ownerUserId, connectorDeviceId: parsed.connectorDeviceId, boundAt: typeof parsed.boundAt === 'string' ? parsed.boundAt : '' }
    } catch {
      return null
    }
  }

  bind(ownerUserId: string, connectorDeviceId: string, now = new Date()): ConnectorOwnerBinding {
    const binding = { ownerUserId, connectorDeviceId, boundAt: now.toISOString() }
    this.storage().setItem(STORAGE_KEY, JSON.stringify(binding))
    return binding
  }

  clear(): void { this.storage().removeItem(STORAGE_KEY) }
}

export const connectorOwnerBinding = new ConnectorOwnerBindingStore()
