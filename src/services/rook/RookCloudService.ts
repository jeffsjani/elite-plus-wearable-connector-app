import { invokeConnectorFunction } from '../base44/Base44Client'
import { ConnectorServiceError } from '../base44/base44Types'
import { isRookDataSource, type RookDataSource } from './rookProviderRegistry'
import type { RookAuthorization, RookAuthorizationStatus } from './rookCloudTypes'

function normalize(response: unknown, dataSource: RookDataSource): RookAuthorization {
  if (!response || typeof response !== 'object') throw new ConnectorServiceError('INVALID_RESPONSE', 'Invalid connection response.')
  const result = response as Record<string, unknown>
  if (result.success !== true || result.dataSource !== dataSource || typeof result.authorized !== 'boolean') {
    throw new ConnectorServiceError('INVALID_RESPONSE', 'Invalid connection response.')
  }
  const normalized: RookAuthorization = { dataSource, authorized: result.authorized }
  if (typeof result.status === 'string') normalized.status = result.status
  if (typeof result.lastDataTimestamp === 'string') normalized.lastDataTimestamp = result.lastDataTimestamp
  if (typeof result.lastWebhookAt === 'string') normalized.lastWebhookAt = result.lastWebhookAt
  if (typeof result.lastError === 'string') normalized.lastError = result.lastError
  if (typeof result.authorizationUrl === 'string') normalized.authorizationUrl = result.authorizationUrl
  return normalized
}

function assertProvider(dataSource: string): asserts dataSource is RookDataSource {
  if (!isRookDataSource(dataSource)) throw new ConnectorServiceError('INVALID_RESPONSE', 'This connection is not currently available.')
}

export class RookCloudService {
  async getAuthorization(dataSource: RookDataSource, redirectUrl?: string): Promise<RookAuthorization> {
    assertProvider(dataSource)
    return normalize(await invokeConnectorFunction('rookGetAuthorization', {
      dataSource, ...(redirectUrl ? { redirectUrl } : {}),
    }), dataSource)
  }

  async getAuthorizationStatus(dataSource: RookDataSource): Promise<RookAuthorizationStatus> {
    assertProvider(dataSource)
    return normalize(await invokeConnectorFunction('rookAuthorizationStatus', { dataSource }), dataSource)
  }

  async revokeAuthorization(dataSource: RookDataSource): Promise<void> {
    assertProvider(dataSource)
    const response = await invokeConnectorFunction<Record<string, unknown>>('rookRevokeAuthorization', { dataSource })
    if (response?.success !== true) throw new ConnectorServiceError('INVALID_RESPONSE', 'Invalid disconnect response.')
  }
}

export const rookCloudService = new RookCloudService()