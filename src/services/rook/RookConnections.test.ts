import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConnectorServiceError } from '../base44/base44Types'

const browserOpen = vi.hoisted(() => vi.fn())
const isNativePlatform = vi.hoisted(() => vi.fn())
vi.mock('@capacitor/browser', () => ({ Browser: { open: browserOpen } }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform } }))
import { connectionError, openAuthorizationUrl, RookConnections } from './RookConnections'
import type { RookCloudService } from './RookCloudService'

const status = { dataSource: 'GARMIN' as const, authorized: false }
const service = {
  getAuthorization: vi.fn(),
  getAuthorizationStatus: vi.fn(),
  revokeAuthorization: vi.fn(),
} as unknown as RookCloudService

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(service.getAuthorizationStatus).mockResolvedValue(status)
  vi.mocked(service.revokeAuthorization).mockResolvedValue(undefined)
})

describe('provider connection flow', () => {
  it('waits for an authorization URL and checks only the awaiting source on foreground', async () => {
    vi.mocked(service.getAuthorization).mockResolvedValue({ ...status, authorizationUrl: 'https://example.com/auth' })
    const open = vi.fn().mockResolvedValue(undefined)
    const connections = new RookConnections(service, undefined, open)
    await connections.connect('GARMIN')
    expect(connections.views.GARMIN.state).toBe('WAITING_FOR_AUTHORIZATION')
    expect(open).toHaveBeenCalledWith('https://example.com/auth')
    expect(service.getAuthorizationStatus).not.toHaveBeenCalled()
    vi.mocked(service.getAuthorizationStatus).mockResolvedValueOnce({ ...status, authorized: true })
    await connections.refreshAwaiting()
    expect(service.getAuthorizationStatus).toHaveBeenCalledTimes(1)
    expect(connections.views.GARMIN.state).toBe('CONNECTED')
    expect(connections.awaiting).toBeNull()
  })

  it('supports manual checks and keeps waiting if the server has not authorized', async () => {
    vi.mocked(service.getAuthorization).mockResolvedValue({ ...status, authorizationUrl: 'https://example.com/auth' })
    const connections = new RookConnections(service, undefined, vi.fn().mockResolvedValue(undefined))
    await connections.connect('GARMIN')
    await connections.refresh('GARMIN')
    expect(connections.views.GARMIN.state).toBe('WAITING_FOR_AUTHORIZATION')
    expect(connections.views.GARMIN.checkedAt).toBeDefined()
  })

  it('handles already authorized and idempotent revoke followed by authoritative status', async () => {
    vi.mocked(service.getAuthorization).mockResolvedValue({ ...status, authorized: true })
    const open = vi.fn()
    const connections = new RookConnections(service, undefined, open)
    await connections.connect('GARMIN')
    expect(connections.views.GARMIN.state).toBe('CONNECTED')
    expect(open).not.toHaveBeenCalled()
    await connections.disconnect('GARMIN')
    expect(service.revokeAuthorization).toHaveBeenCalledWith('GARMIN')
    expect(connections.views.GARMIN.state).toBe('NOT_CONNECTED')
  })

  it('maps 401, network and invalid provider without exposing backend details', async () => {
    expect(connectionError(new ConnectorServiceError('AUTH_REQUIRED', 'secret', 401))).toBe('Your Elite+ session has expired. Please sign in again.')
    expect(connectionError(new ConnectorServiceError('NETWORK_ERROR', 'secret'), true)).toBe('Unable to check this connection right now.')
    expect(connectionError(new ConnectorServiceError('INVALID_RESPONSE', 'secret', 400))).toBe('This connection is not currently available.')
    vi.mocked(service.getAuthorization).mockRejectedValueOnce(new ConnectorServiceError('SERVER_ERROR', 'secret'))
    const connections = new RookConnections(service)
    await connections.connect('GARMIN')
    expect(connections.views.GARMIN.error).toBe('Unable to connect right now. Try again.')
  })

  it('launches the native browser and rejects unsafe URLs', async () => {
    isNativePlatform.mockReturnValue(true)
    await openAuthorizationUrl('https://example.com/auth')
    expect(browserOpen).toHaveBeenCalledWith({ url: 'https://example.com/auth' })
    await expect(openAuthorizationUrl('javascript:alert(1)')).rejects.toThrow('Invalid authorization URL')
  })

  it('opens a new web tab in browser preview', async () => {
    isNativePlatform.mockReturnValue(false)
    const open = vi.fn().mockReturnValue({})
    vi.stubGlobal('window', { open })
    await openAuthorizationUrl('https://example.com/auth')
    expect(open).toHaveBeenCalledWith('https://example.com/auth', '_blank', 'noopener,noreferrer')
    vi.unstubAllGlobals()
  })
})