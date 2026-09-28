import { Browser } from '@capacitor/browser'
import { Capacitor } from '@capacitor/core'
import { ConnectorServiceError } from '../base44/base44Types'
import { rookCloudService, type RookCloudService } from './RookCloudService'
import { rookProviders, type RookDataSource } from './rookProviderRegistry'
import type { ProviderConnectionState, RookAuthorizationStatus } from './rookCloudTypes'

export interface ProviderView {
  state: ProviderConnectionState
  status?: RookAuthorizationStatus
  checkedAt?: string
  error?: string
  authorizationUrl?: string
}

export type ProviderViews = Record<RookDataSource, ProviderView>

export function connectionError(error: unknown, checking = false): string {
  if (error instanceof ConnectorServiceError) {
    if (error.code === 'AUTH_REQUIRED' || error.code === 'UNAUTHORIZED') return 'Your Elite+ session has expired. Please sign in again.'
    if (error.code === 'NETWORK_ERROR') return 'Unable to check this connection right now.'
    if (error.status === 400 || error.status === 404 || error.message === 'This connection is not currently available.') return 'This connection is not currently available.'
  }
  return checking ? 'Unable to check this connection right now.' : 'Unable to connect right now. Try again.'
}

export async function openAuthorizationUrl(url: string): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:') throw new Error('Invalid authorization URL')
  if (Capacitor.isNativePlatform()) {
    await Browser.open({ url })
  } else {
    const windowReference = window.open(url, '_blank', 'noopener,noreferrer')
    if (!windowReference) throw new Error('Browser blocked authorization window')
  }
}

export class RookConnections {
  views: ProviderViews = Object.fromEntries(rookProviders.map(({ dataSource }) => [dataSource, { state: 'NOT_CONNECTED' }])) as ProviderViews
  awaiting: RookDataSource | null = null
  private generation = 0
  private readonly service: RookCloudService
  private readonly notify: (views: ProviderViews) => void
  private readonly open: (url: string) => Promise<void>

  constructor(service: RookCloudService = rookCloudService, notify: (views: ProviderViews) => void = () => {}, open: (url: string) => Promise<void> = openAuthorizationUrl) {
    this.service = service
    this.notify = notify
    this.open = open
  }

  private update(dataSource: RookDataSource, change: Partial<ProviderView>): void {
    this.views = { ...this.views, [dataSource]: { ...this.views[dataSource], ...change } }
    this.notify(this.views)
  }

  reset(): void {
    this.generation++
    this.awaiting = null
    this.views = Object.fromEntries(rookProviders.map(({ dataSource }) => [dataSource, { state: 'NOT_CONNECTED' }])) as ProviderViews
    this.notify(this.views)
  }

  async refresh(dataSource: RookDataSource): Promise<void> {
    const generation = this.generation
    this.update(dataSource, { state: 'CHECKING', error: undefined })
    try {
      const status = await this.service.getAuthorizationStatus(dataSource)
      if (generation !== this.generation) return
      if (this.awaiting === dataSource && status.authorized) this.awaiting = null
      this.update(dataSource, { status, checkedAt: new Date().toISOString(), authorizationUrl: status.authorized ? undefined : this.views[dataSource].authorizationUrl, state: status.authorized ? 'CONNECTED' : this.awaiting === dataSource ? 'WAITING_FOR_AUTHORIZATION' : 'NOT_CONNECTED' })
    } catch (error) {
      if (generation === this.generation) this.update(dataSource, { state: 'ERROR', error: connectionError(error, true), checkedAt: new Date().toISOString() })
    }
  }

  async refreshAll(): Promise<void> {
    for (let index = 0; index < rookProviders.length; index += 2) {
      await Promise.all(rookProviders.slice(index, index + 2).map(({ dataSource }) => this.refresh(dataSource)))
    }
  }

  async refreshAwaiting(): Promise<void> {
    if (this.awaiting) await this.refresh(this.awaiting)
  }

  async openAwaiting(dataSource: RookDataSource): Promise<void> {
    const url = this.views[dataSource].authorizationUrl
    if (!url || this.awaiting !== dataSource) return
    try {
      await this.open(url)
      this.update(dataSource, { error: undefined })
    } catch {
      this.update(dataSource, { error: 'Could not open the authorization page. Tap Open Authorization to try again.' })
    }
  }

  async connect(dataSource: RookDataSource): Promise<void> {
    if (this.awaiting && this.awaiting !== dataSource) return
    const generation = this.generation
    this.update(dataSource, { state: 'CONNECTING', error: undefined, authorizationUrl: undefined })
    try {
      const result = await this.service.getAuthorization(dataSource)
      if (generation !== this.generation) return
      if (result.authorized) {
        this.awaiting = null
        this.update(dataSource, { state: 'CONNECTED', status: result, authorizationUrl: undefined })
      } else if (result.authorizationUrl) {
        this.awaiting = dataSource
        this.update(dataSource, { state: 'WAITING_FOR_AUTHORIZATION', authorizationUrl: result.authorizationUrl })
        await this.openAwaiting(dataSource)
      } else {
        throw new Error('Missing authorization URL')
      }
    } catch (error) {
      if (generation === this.generation) this.update(dataSource, { state: 'ERROR', error: connectionError(error) })
    }
  }

  async disconnect(dataSource: RookDataSource): Promise<void> {
    const generation = this.generation
    this.update(dataSource, { state: 'DISCONNECTING', error: undefined, authorizationUrl: undefined })
    try {
      await this.service.revokeAuthorization(dataSource)
      if (generation === this.generation) {
        if (this.awaiting === dataSource) this.awaiting = null
        await this.refresh(dataSource)
      }
    } catch (error) {
      if (generation === this.generation) this.update(dataSource, { state: 'ERROR', error: connectionError(error) })
    }
  }
}