import type { LocalDigitalWellness, DigitalWellnessState } from './digitalWellnessLocal'
export type Platform = 'ANDROID' | 'IOS' | 'WEB'
export type Source = 'V8' | 'APPLE_HEALTH' | 'HEALTH_CONNECT' | 'SAMSUNG_HEALTH' | 'CONNECTED_DEVICES' | 'DIGITAL_WELLNESS'
export type AdapterState = 'AVAILABLE_FOR_FUTURE_BINDING' | 'BLOCKED_VENDOR_CREDENTIAL_MODEL' | 'CAPABILITY_MODEL_ONLY' | 'NATIVE_USAGE_STATS'
export type LimitationReason = 'PHASE_2_DISABLED' | 'AUTHENTICATION_REQUIRED' | 'OWNER_OVERRIDE_FORBIDDEN'
  | 'UNSUPPORTED_SOURCE' | 'UNSUPPORTED_PLATFORM' | 'CONNECTION_NOT_FOUND' | 'VENDOR_CREDENTIAL_MODEL_UNRESOLVED'
  | 'CERTIFIED_RUNTIME_NOT_BOUND' | 'PERMISSION_NOT_REQUESTED' | 'ENTITLEMENT_AND_ELIGIBILITY_REQUIRED'
  | 'LOCAL_REPORT_NOT_IMPLEMENTED' | 'PLATFORM_SEMANTICS_UNVALIDATED'
  | 'DIGITAL_WELLNESS_DISABLED' | 'CONSENT_REQUIRED' | 'USAGE_ACCESS_REQUIRED' | 'SOURCE_UNAVAILABLE' | 'SOURCE_ERROR' | 'LOCAL_ONLY_VALIDATION'
export type Authorization = 'NOT_REQUESTED' | 'AUTHORIZED' | 'DENIED' | 'REVOKED' | 'UNAVAILABLE'
export type AcquisitionStatus = 'DISABLED' | 'IDLE' | 'ACQUIRING' | 'SAVED' | 'FAILED'
export type DeliveryStatus = 'DISABLED' | 'PENDING' | 'SENDING' | 'DELIVERED' | 'FAILED'
export type ExportCapability = 'LOCAL_REPORT_ONLY' | 'AUTHORIZED_EXPORT' | 'UNAVAILABLE'

export interface Freshness {
  acquiredAt: string | null
  savedAt: string | null
  deliveredAt: string | null
  providerUpdatedAt: string | null
}
export interface Connection {
  id: string
  source: Source
  state: 'DISCONNECTED' | 'CONNECTING' | 'CONNECTED'
}
export interface Capability {
  source: Source
  metric: string
  platform: Platform
  supported: boolean
  enabled: boolean
  exportCapability: ExportCapability
  limitation: LimitationReason
}
export interface SourceStatus {
  digitalWellnessState?: DigitalWellnessState
  deliveryCapability?: 'LOCAL_ONLY'
  source: Source
  adapterState: AdapterState
  connection: Connection | null
  acquisition: AcquisitionStatus
  delivery: DeliveryStatus
  freshness: Freshness
  limitation: LimitationReason
}
export interface Permission {
  source: Source
  authorization: Authorization
  requested: false
}
export type OperationResult = { ok: false; reason: LimitationReason }
export interface ConnectOptions { interactive?: boolean }
export interface DisconnectOptions { revokeAuthorization?: boolean }
export type SourceTarget = { source: Source } | { connectionId: string }
export interface HealthSourcesEvent { type: 'STATUS_SNAPSHOT'; statuses: readonly SourceStatus[] }

export interface HealthSources {
  digitalWellness?: LocalDigitalWellness
  connect(source: Source, options?: ConnectOptions): Promise<OperationResult>
  disconnect(connection: Connection, options?: DisconnectOptions): Promise<OperationResult>
  sync(target: Source | SourceTarget): Promise<OperationResult>
  getStatus(): readonly SourceStatus[]
  getPermissions(): readonly Permission[]
  getLastSync(): ReadonlyArray<{ source: Source; freshness: Freshness }>
  getCapabilities(): readonly Capability[]
  subscribe(listener: (event: HealthSourcesEvent) => void): () => void
}
