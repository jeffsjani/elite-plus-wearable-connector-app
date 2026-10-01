import { invokeConnectorFunction, type InvokeOptions } from './Base44Client'
import type {
  ConnectorObservationsRequest,
  ConnectorObservationsResponse,
} from './base44Types'
import { ConnectorServiceError } from './base44Types'

class ConnectorObservationService {
  async submitObservations(
    request: ConnectorObservationsRequest,
    options: InvokeOptions = {},
  ): Promise<ConnectorObservationsResponse> {
    const response = await invokeConnectorFunction<ConnectorObservationsResponse>(
      'nativeConnectorObservations',
      request,
      options,
    )

    if (!response.success) {
      throw new ConnectorServiceError('BATCH_REJECTED', 'The connector service rejected the observation batch.')
    }

    return response
  }
}

export const connectorObservationService = new ConnectorObservationService()