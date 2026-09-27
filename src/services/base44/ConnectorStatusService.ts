import { invokeConnectorFunction } from './Base44Client'
import type { ConnectorStatusRequest, ConnectorStatusResponse } from './base44Types'
import { ConnectorServiceError } from './base44Types'

class ConnectorStatusService {
  async getConnectorStatus(request: ConnectorStatusRequest): Promise<ConnectorStatusResponse> {
    const response = await invokeConnectorFunction<ConnectorStatusResponse>(
      'nativeConnectorStatus',
      request,
    )

    if (!response.success || !response.connectorDeviceId) {
      throw new ConnectorServiceError('INVALID_RESPONSE', 'Base44 returned an invalid connector status.')
    }

    return response
  }
}

export const connectorStatusService = new ConnectorStatusService()