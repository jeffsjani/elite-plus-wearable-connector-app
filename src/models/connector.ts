export type ConnectorPlatform = 'web' | 'ios' | 'android'

export type SourceStatus = 'unavailable' | 'disconnected' | 'ready' | 'syncing' | 'error' | 'connected' | 'permission_required' | 'unsupported' | 'not_installed' | 'update_required'

export interface PermissionResult {
  granted: boolean
  permissions: string[]
  denied: string[]
}

export interface SyncOptions {
  since?: string
  until?: string
}

export interface SyncResult {
  observations: NativeObservation[]
  startedAt: string
  completedAt: string
  nextCursor?: string
  samplesRetrieved?: number
  newlyQueued?: number
  alreadyQueued?: number
  failedNormalization?: number
}

export type NativeObservation = import('../services/base44/base44Types').NativeObservationInput

export interface ConnectorDiagnostics {
  source: string
  platform: ConnectorPlatform
  status: SourceStatus
  lastSyncAt?: string
  message?: string
}

export interface ConnectorSource {
  initialize(): Promise<void>
  getStatus(): Promise<SourceStatus>
  requestPermissions(): Promise<PermissionResult>
  sync(options?: SyncOptions): Promise<SyncResult>
  disconnect(): Promise<void>
}