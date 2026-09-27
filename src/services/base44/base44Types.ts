import type { ConnectorPlatform } from '../../models/connector'

export interface LocalUser {
  id: string
  email: string
  name?: string
}

export interface ConnectorRegistrationRequest {
  installId: string
  platform: ConnectorPlatform
  appVersion: string
  deviceModel?: string
  osVersion?: string
}

export interface ConnectorRegistrationResponse {
  success: boolean
  connectorDeviceId: string
  installId: string
  status: string
  registeredAt: string
  serverTimestamp: string
  sources: string[]
}

export interface ConnectorStatusRequest {
  installId: string
}

export interface ConnectorStatusResponse {
  success: boolean
  connectorDeviceId: string
  installId: string
  platform: ConnectorPlatform
  appVersion: string
  lastSeen?: string
  lastSuccessfulSync?: string
  status: string
  configuredSourceCount: number
}

export interface NativeObservationInput {
  observationId: string
  source: string
  metric: string
  valueNumber: number
  unit: string
  startTime: string
  timezone: string
  capturedAt: string
  provider: string
}

export interface ConnectorObservationsRequest {
  installId: string
  connectorDeviceId: string
  batchId: string
  observations: NativeObservationInput[]
}

export interface ConnectorObservationsResponse {
  success: boolean
  batchId: string
  accepted: number
  duplicate: number
  rejected: number
  errors: Array<{ observationId?: string; code?: string; message?: string }>
  serverTimestamp: string
}

export type ConnectorErrorCode =
  | 'AUTH_REQUIRED'
  | 'REGISTRATION_REQUIRED'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NETWORK_ERROR'
  | 'INVALID_RESPONSE'
  | 'BATCH_REJECTED'
  | 'SERVER_ERROR'

export class ConnectorServiceError extends Error {
  readonly code: ConnectorErrorCode
  readonly status?: number

  constructor(code: ConnectorErrorCode, message: string, status?: number) {
    super(message)
    this.name = 'ConnectorServiceError'
    this.code = code
    this.status = status
  }
}