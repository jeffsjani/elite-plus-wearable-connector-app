export type ConnectorPlatform = 'web' | 'ios' | 'android'

export type SourceStatus = 'unavailable' | 'disconnected' | 'ready' | 'syncing' | 'error'

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
}

export interface NativeObservation {
  source: string
  type: string
  observedAt: string
  value: number | string | boolean
  unit?: string
  metadata?: Record<string, string | number | boolean>
}

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