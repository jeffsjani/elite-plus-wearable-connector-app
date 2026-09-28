import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorServiceError } from '../base44/base44Types'

const invoke = vi.hoisted(() => vi.fn())
vi.mock('../base44/Base44Client', () => ({ invokeConnectorFunction: invoke }))
import { RookCloudService } from './RookCloudService'
import { rookProviders } from './rookProviderRegistry'

const service = new RookCloudService()
beforeEach(() => invoke.mockReset())

describe('cloud provider transport', () => {
  it('registers only the seven supported API identifiers', () => {
    expect(rookProviders.map((provider) => provider.dataSource)).toEqual(['GARMIN', 'OURA', 'POLAR', 'FITBIT', 'WITHINGS', 'WHOOP', 'DEXCOM'])
  })

  it('normalizes disconnected and connected status without inventing timestamps', async () => {
    invoke.mockResolvedValueOnce({ success: true, dataSource: 'GARMIN', authorized: false })
    expect(await service.getAuthorizationStatus('GARMIN')).toEqual({ dataSource: 'GARMIN', authorized: false })
    invoke.mockResolvedValueOnce({ success: true, dataSource: 'GARMIN', authorized: true, status: 'active', lastWebhookAt: '2026-01-01' })
    expect(await service.getAuthorizationStatus('GARMIN')).toEqual({ dataSource: 'GARMIN', authorized: true, status: 'active', lastWebhookAt: '2026-01-01' })
  })

  it('sends only the provider and accepts an authorization URL or existing authorization', async () => {
    invoke.mockResolvedValueOnce({ success: true, dataSource: 'GARMIN', authorized: false, authorizationUrl: 'https://example.com/login' })
    expect((await service.getAuthorization('GARMIN')).authorizationUrl).toBe('https://example.com/login')
    expect(invoke).toHaveBeenCalledWith('rookGetAuthorization', { dataSource: 'GARMIN' })
    invoke.mockResolvedValueOnce({ success: true, dataSource: 'GARMIN', authorized: true })
    expect((await service.getAuthorization('GARMIN')).authorized).toBe(true)
  })

  it('rejects invalid providers before transmitting and rejects invalid responses', async () => {
    await expect(service.getAuthorization('UNKNOWN' as 'GARMIN')).rejects.toThrow(ConnectorServiceError)
    expect(invoke).not.toHaveBeenCalled()
    invoke.mockResolvedValueOnce({ success: true, dataSource: 'GARMIN' })
    await expect(service.getAuthorizationStatus('GARMIN')).rejects.toThrow('Invalid connection response.')
  })

  it('revokes without client identity and accepts already disconnected success', async () => {
    invoke.mockResolvedValue({ success: true, authorized: false })
    await service.revokeAuthorization('GARMIN')
    expect(invoke).toHaveBeenCalledWith('rookRevokeAuthorization', { dataSource: 'GARMIN' })
  })
})