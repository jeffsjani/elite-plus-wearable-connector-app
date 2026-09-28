import type { RookDataSource } from './rookProviderRegistry'

export type ProviderConnectionState =
  | 'NOT_CONNECTED' | 'CHECKING' | 'CONNECTING' | 'WAITING_FOR_AUTHORIZATION'
  | 'CONNECTED' | 'DISCONNECTING' | 'ERROR'

export interface RookAuthorizationStatus {
  dataSource: RookDataSource
  authorized: boolean
  status?: string
  lastDataTimestamp?: string
  lastWebhookAt?: string
  lastError?: string
}

export interface RookAuthorization extends RookAuthorizationStatus {
  authorizationUrl?: string
}