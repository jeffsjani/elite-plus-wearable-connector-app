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
  endTime?: string
  timezone: string
  capturedAt: string
  provider: string
  sourceRecordId?: string
  sourceId?: string
  originPackage?: string
  deviceManufacturer?: string
  deviceModel?: string
  // Optional direct-wearable provenance (Build 5A); backend persistence of these fields must be confirmed server-side.
  metricType?: string
  sourceConnector?: string
  sourceProvider?: string
  sourcePath?: string
  acquisitionMode?: string
  measurementContext?: string
  sessionId?: string
  packetSequence?: number
  observedAt?: string
  observedAtSource?: string
  timestampSource?: string
  timestampConfidence?: string
  receivedAt?: string
  deviceId?: string
  firmwareVersion?: string | null
  sdkVersion?: string | null
  vendorDataType?: string
  rawSourceMetadata?: Record<string, string | number | boolean | null>
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
  | 'TIMEOUT'

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