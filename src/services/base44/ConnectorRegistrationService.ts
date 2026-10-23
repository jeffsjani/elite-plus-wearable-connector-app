import { invokeConnectorFunction } from './Base44Client'
import type {
  ConnectorRegistrationRequest,
  ConnectorRegistrationResponse,
} from './base44Types'
import { ConnectorServiceError } from './base44Types'
import { activityV2CapabilityStore } from './ActivityV2Capability'
import { connectorIdentityService } from './ConnectorIdentityService'
import { getBackendEnvironmentDiagnostics } from './base44Environment'
import { extractActivityV2RegistrationEnvelope } from '../../adapters/jcvital/ActivityNativeTransportV2'

interface RegistrationAttempt {
  response: unknown
  error: unknown | null
  attemptedAt: string
  httpStatus: number | null
  responseReceived: boolean
  responseBody: unknown
  resolvedRegistrationUrl: string
  environmentMatch: boolean
}

class ConnectorRegistrationService {
  private async requestRegistration(request: ConnectorRegistrationRequest): Promise<RegistrationAttempt> {
    const environment = getBackendEnvironmentDiagnostics()
    const attempt: RegistrationAttempt = {
      response: undefined, error: null, attemptedAt: new Date().toISOString(), httpStatus: null,
      responseReceived: false, responseBody: undefined, resolvedRegistrationUrl: environment.resolvedRegistrationUrl,
      environmentMatch: environment.environmentMatch,
    }
    try {
      attempt.response = await invokeConnectorFunction<unknown>('nativeConnectorRegister', request, {
        onHttpResponse: (status) => { attempt.httpStatus = status },
        onResponseBody: (body) => { attempt.responseReceived = true; attempt.responseBody = body },
        onRequestMetadata: (metadata) => { attempt.resolvedRegistrationUrl = metadata.resolvedRequestUrl },
      })
      if (!attempt.responseReceived) {
        attempt.responseReceived = true
        attempt.responseBody = attempt.response
      }
    } catch (error) {
      attempt.error = error
      if (error instanceof ConnectorServiceError) attempt.httpStatus ??= error.status ?? null
    }
    try {
      const expectedUrl = new URL(environment.resolvedRegistrationUrl)
      const resolvedUrl = new URL(attempt.resolvedRegistrationUrl)
      attempt.environmentMatch = attempt.environmentMatch
        && resolvedUrl.protocol === 'https:'
        && resolvedUrl.origin === expectedUrl.origin
        && resolvedUrl.pathname === expectedUrl.pathname
    } catch {
      attempt.environmentMatch = false
    }
    return attempt
  }

  private recordHandshake(
    attempt: RegistrationAttempt,
    scope: { ownerUserId: string; installId: string; connectorDeviceId: string },
    response: unknown,
  ): void {
    activityV2CapabilityStore.recordHandshakeDiagnostics(scope, {
      attemptedAt: attempt.attemptedAt, httpStatus: attempt.httpStatus, responseReceived: attempt.responseReceived,
      responseBody: attempt.responseReceived ? attempt.responseBody : undefined,
      resolvedRegistrationUrl: attempt.resolvedRegistrationUrl, environmentMatch: attempt.environmentMatch,
    }, response)
  }

  async registerConnector(
    request: ConnectorRegistrationRequest,
    ownerUserId: string,
  ): Promise<ConnectorRegistrationResponse> {
    activityV2CapabilityStore.recordPending(
      ownerUserId, request.installId, connectorIdentityService.getConnectorDeviceId(),
    )
    const scope = {
      ownerUserId, installId: request.installId,
      connectorDeviceId: connectorIdentityService.getConnectorDeviceId() ?? '',
    }
    const attempt = await this.requestRegistration(request)
    if (attempt.error) {
      activityV2CapabilityStore.recordFailure(
        ownerUserId, request.installId, connectorIdentityService.getConnectorDeviceId(), 'REGISTRATION_REQUEST_FAILED',
      )
      this.recordHandshake(attempt, scope, attempt.responseBody)
      throw attempt.error
    }
    const rawResponse = attempt.response
    const registrationEnvelope = extractActivityV2RegistrationEnvelope(rawResponse)

    if (!registrationEnvelope) {
      activityV2CapabilityStore.recordFailure(
        ownerUserId, request.installId, connectorIdentityService.getConnectorDeviceId(), 'INVALID_REGISTRATION_RESPONSE',
      )
      this.recordHandshake(attempt, scope, rawResponse)
      throw new ConnectorServiceError('INVALID_RESPONSE', 'The connector service returned an invalid registration.')
    }
    const response = registrationEnvelope as unknown as ConnectorRegistrationResponse
    if (!response.success || typeof response.connectorDeviceId !== 'string' || !response.connectorDeviceId) {
      activityV2CapabilityStore.recordFailure(
        ownerUserId, request.installId,
        typeof response.connectorDeviceId === 'string' ? response.connectorDeviceId : connectorIdentityService.getConnectorDeviceId(),
        'INVALID_REGISTRATION_RESPONSE',
      )
      this.recordHandshake(attempt, scope, rawResponse)
      throw new ConnectorServiceError('INVALID_RESPONSE', 'The connector service returned an invalid registration.')
    }

    connectorIdentityService.setConnectorDeviceId(response.connectorDeviceId)
    const capability = activityV2CapabilityStore.recordRegistrationResponse(rawResponse, {
      ownerUserId, installId: request.installId, connectorDeviceId: response.connectorDeviceId,
    }, attempt.environmentMatch)
    this.recordHandshake(attempt, {
      ownerUserId, installId: request.installId, connectorDeviceId: response.connectorDeviceId,
    }, rawResponse)
    console.info('Activity v2 capability decision', {
      enabled: capability.productionDeliveryEnabled,
      reason: capability.reason,
      responseContractVersion: capability.responseContractVersion,
      deploymentRevision: capability.deploymentRevision,
    })
    return response
  }

  async refreshBase44Capabilities(
    request: ConnectorRegistrationRequest,
    scope: { ownerUserId: string; installId: string; connectorDeviceId: string },
  ) {
    if (!scope.ownerUserId || !scope.installId || !scope.connectorDeviceId || scope.installId !== request.installId) {
      throw new ConnectorServiceError('INVALID_RESPONSE', 'A matching registered account, install, and device are required to refresh capabilities.')
    }
    activityV2CapabilityStore.recordPending(scope.ownerUserId, scope.installId, scope.connectorDeviceId)
    const attempt = await this.requestRegistration(request)
    if (attempt.error) {
      activityV2CapabilityStore.recordFailure(scope.ownerUserId, scope.installId, scope.connectorDeviceId, 'REGISTRATION_REQUEST_FAILED')
      this.recordHandshake(attempt, scope, attempt.responseBody)
      throw attempt.error
    }
    const rawResponse = attempt.response
    const response = extractActivityV2RegistrationEnvelope(rawResponse)
    if (!response) {
      activityV2CapabilityStore.recordFailure(scope.ownerUserId, scope.installId, scope.connectorDeviceId, 'INVALID_REGISTRATION_RESPONSE')
      this.recordHandshake(attempt, scope, response)
      throw new ConnectorServiceError('INVALID_RESPONSE', 'The connector service returned an invalid registration.')
    }
    const candidate = response as unknown as ConnectorRegistrationResponse
    if (!candidate.success || candidate.installId !== scope.installId || candidate.connectorDeviceId !== scope.connectorDeviceId) {
      activityV2CapabilityStore.recordFailure(scope.ownerUserId, scope.installId, scope.connectorDeviceId, 'REGISTRATION_SCOPE_MISMATCH')
      this.recordHandshake(attempt, scope, response)
      throw new ConnectorServiceError('INVALID_RESPONSE', 'The registration response did not match the current account, install, and device.')
    }
    const decision = activityV2CapabilityStore.recordRegistrationResponse(rawResponse, scope, attempt.environmentMatch)
    this.recordHandshake(attempt, scope, rawResponse)
    return decision
  }
}

export const connectorRegistrationService = new ConnectorRegistrationService()