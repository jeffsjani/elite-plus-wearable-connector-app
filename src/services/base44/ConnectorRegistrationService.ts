import { connectorIdentityService } from './ConnectorIdentityService'
import { invokeConnectorFunction } from './Base44Client'
import type {
  ConnectorRegistrationRequest,
  ConnectorRegistrationResponse,
} from './base44Types'
import { ConnectorServiceError } from './base44Types'

class ConnectorRegistrationService {
  async registerConnector(
    request: ConnectorRegistrationRequest,
  ): Promise<ConnectorRegistrationResponse> {
    const response = await invokeConnectorFunction<ConnectorRegistrationResponse>(
      'nativeConnectorRegister',
      request,
    )

    if (!response.success || !response.connectorDeviceId) {
      throw new ConnectorServiceError('INVALID_RESPONSE', 'Base44 returned an invalid connector registration.')
    }

    connectorIdentityService.setConnectorDeviceId(response.connectorDeviceId)
    return response
  }
}

export const connectorRegistrationService = new ConnectorRegistrationService()