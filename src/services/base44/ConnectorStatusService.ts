import { invokeConnectorFunction } from './Base44Client'
import type { ConnectorPlatform } from '../../models/connector'
import type { ConnectorStatusRequest, ConnectorStatusResponse } from './base44Types'
import { ConnectorServiceError } from './base44Types'

type StatusDeviceRecord = Record<string, unknown>

interface RawConnectorStatusResponse {
  success?: boolean
  devices?: StatusDeviceRecord[]
  sources?: unknown[]
  server_time?: string
}

function getString(record: StatusDeviceRecord, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value) return value
  }
  return undefined
}

function getPlatform(value: string | undefined): ConnectorPlatform {
  return value === 'ios' || value === 'android' ? value : 'web'
}

class ConnectorStatusService {
  async getConnectorStatus(request: ConnectorStatusRequest): Promise<ConnectorStatusResponse> {
    const response = await invokeConnectorFunction<RawConnectorStatusResponse>(
      'nativeConnectorStatus',
      request,
    )
    const devices = Array.isArray(response.devices) ? response.devices : []
    const device = devices.find((candidate) =>
      getString(candidate, 'installId', 'install_id') === request.installId,
    ) ?? (devices.length === 1 ? devices[0] : undefined)

    if (!device) {
      throw new ConnectorServiceError(
        'INVALID_RESPONSE',
        'The connector service returned no status for this installation.',
      )
    }

    const connectorDeviceId = getString(device, 'connectorDeviceId', 'connector_device_id', 'device_id', 'id')
    if (!response.success && response.success !== undefined || !connectorDeviceId) {
      throw new ConnectorServiceError(
        'INVALID_RESPONSE',
        `The connector service returned an invalid status payload. Device fields: ${Object.keys(device).sort().join(', ') || 'none'}`,
      )
    }

    return {
      success: true,
      connectorDeviceId,
      installId: getString(device, 'installId', 'install_id') ?? request.installId,
      platform: getPlatform(getString(device, 'platform')),
      appVersion: getString(device, 'appVersion', 'app_version', 'connector_app_version') ?? 'unknown',
      lastSeen: getString(device, 'lastSeen', 'last_seen', 'last_seen_at') ?? response.server_time,
      lastSuccessfulSync: getString(device, 'lastSuccessfulSync', 'last_successful_sync', 'last_successful_sync_at'),
      status: getString(device, 'status') ?? 'unknown',
      configuredSourceCount: Array.isArray(response.sources) ? response.sources.length : 0,
    }
  }
}

export const connectorStatusService = new ConnectorStatusService()