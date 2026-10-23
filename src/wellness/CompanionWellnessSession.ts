import { registerPlugin } from '@capacitor/core'
import type { LocalUser } from '../services/base44/base44Types'
import { getPlatform } from '../services/platform'
import { LocalDigitalWellness } from './health/digitalWellnessLocal'
import type { DigitalWellnessNative, DigitalWellnessProductionNative } from './health/digitalWellnessNative'
import type { ProductionState } from './health/digitalWellnessProduction'
import { PRODUCTION_STATE_READ_TIMEOUT_MS, withTimeout } from './health/uiActions'

interface OwnerBridge {
  bindAuthenticatedOwner(options: { ownerUserId: string }): Promise<ProductionState>
  clearAuthenticatedOwner(): Promise<void>
  getProductionState(options: { scope: string }): Promise<ProductionState>
  setProductionConsent(options: { scope: string; enabled: boolean }): Promise<ProductionState>
  closeProductionScope(options: { scope: string }): Promise<ProductionState>
  refreshProduction(options: { scope: string }): Promise<ProductionState>
}

const bridge = registerPlugin<DigitalWellnessNative & OwnerBridge>('EliteDigitalWellness')

export class CompanionWellnessSession {
  private active: { owner: string; wellness: LocalDigitalWellness } | null = null
  private transition: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly native = bridge,
    private readonly android = getPlatform() === 'android',
    private readonly storage: Storage = localStorage,
  ) {}

  private serialize<T>(action: () => Promise<T>): Promise<T> {
    const result = this.transition.then(action, action)
    this.transition = result
    return result
  }

  // Accepts only the user returned by Connector authentication, never a screen-supplied owner ID.
  activateAuthenticatedUser(user: LocalUser): Promise<LocalDigitalWellness | null> {
    return this.serialize(async () => {
      if (!this.android) return null
      if (this.active?.owner === user.id) return this.active.wellness
      if (this.active) await this.clearOwner()
      const state = await withTimeout(this.native.bindAuthenticatedOwner({ ownerUserId: user.id }), PRODUCTION_STATE_READ_TIMEOUT_MS)
      if (state.owner_kind !== 'AUTHENTICATED' || !state.scope || state.scope === 'SIGNED_OUT') {
        throw new Error('Digital Wellness authenticated owner could not be verified.')
      }
      const scope = state.scope
      const production: DigitalWellnessProductionNative = {
        getProductionState: () => this.native.getProductionState({ scope }),
        setProductionConsent: ({ enabled }) => this.native.setProductionConsent({ scope, enabled }),
        closeProductionScope: () => this.native.closeProductionScope({ scope }),
        refreshProduction: () => this.native.refreshProduction({ scope }),
      }
      const prefix = `companion.digitalWellness.${encodeURIComponent(user.id)}.`
      const wellness = new LocalDigitalWellness(this.native, {
        getItem: (key) => this.storage.getItem(prefix + key),
        setItem: (key, value) => this.storage.setItem(prefix + key, value),
        removeItem: (key) => this.storage.removeItem(prefix + key),
      }, true, undefined, undefined, production)
      this.active = { owner: user.id, wellness }
      await wellness.initializeProduction()
      return wellness
    })
  }

  private async clearOwner(): Promise<void> {
    await withTimeout(this.native.clearAuthenticatedOwner(), PRODUCTION_STATE_READ_TIMEOUT_MS)
    this.active = null
  }

  closeAuthenticatedUser(): Promise<void> {
    return this.serialize(async () => {
      if (this.android) await this.clearOwner()
    })
  }
}

export const companionWellnessSession = new CompanionWellnessSession()
