import { registerPlugin } from '@capacitor/core'
import type { AndroidUsageEventType } from './androidDigitalWellness'
import type { ProductionState } from './digitalWellnessProduction'

export interface DigitalWellnessNativeResult {
  diagnostics?: unknown
  events: ReadonlyArray<{ eventType: AndroidUsageEventType; timestamp: number }>
  totalSupportedEvents: number
  deduplicatedCount: number
  eventCounts: Record<AndroidUsageEventType, number>
  queryStart: number
  queryEnd: number
  permissionState: 'AUTHORIZED'
  OSVersion: string
  collectionTimestamp: number
  historyCompleteness: 'UNVERIFIED'
}
export interface DigitalWellnessNative {
  getPlatformInfo(): Promise<{ platform: 'ANDROID'; androidVersion: string }>
  isUsageAccessAvailable(): Promise<{ available: boolean; diagnostics?: unknown }>
  hasUsageAccess(): Promise<{ granted: boolean; diagnostics?: unknown }>
  openUsageAccessSettings(): Promise<void>
  queryDigitalWellnessEvents(options: { start: number; end: number }): Promise<DigitalWellnessNativeResult>
}
export interface DigitalWellnessProductionNative {
  getProductionState(): Promise<ProductionState>
  setProductionConsent(options: { enabled: boolean }): Promise<ProductionState>
  closeProductionScope(): Promise<ProductionState>
  refreshProduction(): Promise<ProductionState>
}
export const digitalWellnessNative = registerPlugin<DigitalWellnessNative & DigitalWellnessProductionNative>('EliteDigitalWellness')
