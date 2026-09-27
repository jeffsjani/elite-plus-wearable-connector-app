import { invokeConnectorFunction } from './Base44Client'
import type {
  ConnectorObservationsRequest,
  ConnectorObservationsResponse,
} from './base44Types'
import { ConnectorServiceError } from './base44Types'

class ConnectorObservationService {
  async submitObservations(
    request: ConnectorObservationsRequest,
  ): Promise<ConnectorObservationsResponse> {
    const response = await invokeConnectorFunction<ConnectorObservationsResponse>(
      'nativeConnectorObservations',
      request,
    )

    if (!response.success) {
      throw new ConnectorServiceError('BATCH_REJECTED', 'Base44 rejected the observation batch.')
    }

    return response
  }
}

export const connectorObservationService = new ConnectorObservationService()