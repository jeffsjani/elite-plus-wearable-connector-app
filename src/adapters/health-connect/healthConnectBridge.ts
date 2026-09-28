import { registerPlugin } from '@capacitor/core'

export type HealthConnectType = 'heartRate' | 'restingHeartRate' | 'hrv' | 'sleep' | 'steps' | 'activeCalories' | 'exercise' | 'respiratoryRate' | 'oxygenSaturation' | 'weight' | 'height' | 'bodyTemperature'
export type Availability = 'AVAILABLE' | 'NOT_INSTALLED' | 'UPDATE_REQUIRED' | 'UNSUPPORTED'

export interface HealthConnectRecord {
  recordId: string
  lastModifiedTime: string
  metric: string
  value: number | null
  unit: string
  startTime: string
  endTime: string
  originPackage: string
  zoneOffset?: string
  deviceManufacturer?: string
  deviceModel?: string
}

export interface HealthConnectPlugin {
  availability(): Promise<{ status: Availability }>
  grantedPermissions(options: { types: HealthConnectType[] }): Promise<{ granted: HealthConnectType[] }>
  requestReadPermissions(options: { types: HealthConnectType[] }): Promise<{ granted: HealthConnectType[] }>
  openHealthConnect(): Promise<void>
  getChangesToken(options: { types: HealthConnectType[] }): Promise<{ token: string }>
  readHistory(options: { type: HealthConnectType; startTime: string; endTime: string }): Promise<{ records: HealthConnectRecord[] }>
  getChanges(options: { token: string }): Promise<{ upsertions: HealthConnectRecord[]; deletions: string[]; nextToken: string; hasMore: boolean; expired: boolean }>
}

export const HealthConnect = registerPlugin<HealthConnectPlugin>('EliteHealthConnect')