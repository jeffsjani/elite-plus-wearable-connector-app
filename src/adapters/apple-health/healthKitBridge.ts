import { registerPlugin } from '@capacitor/core'

export type HealthDataType = 'heartRate' | 'restingHeartRate' | 'heartRateVariability' | 'sleep' | 'steps' | 'calories' | 'workouts' | 'respiratoryRate' | 'oxygenSaturation' | 'weight' | 'height'

export interface HealthSample {
  value: number
  unit: string
  startDate: string
  endDate: string
  platformId: string
  sourceName?: string
  sourceId?: string
  sleepState?: string
}

export interface Workout {
  duration: number
  workoutType: string
  startDate: string
  endDate: string
  platformId: string
  sourceName?: string
  sourceId?: string
}

export interface HealthPlugin {
  isAvailable(): Promise<{ available: boolean }>
  requestAuthorization(options: { read: HealthDataType[] }): Promise<{ readAuthorized: HealthDataType[]; readDenied: HealthDataType[] }>
  readSamples(options: { dataType: HealthDataType; startDate: string; endDate: string; limit: number; ascending: boolean }): Promise<{ samples: HealthSample[] }>
  queryWorkouts(options: { startDate: string; endDate: string; limit: number; ascending: boolean }): Promise<{ workouts: Workout[] }>
}

export const Health = registerPlugin<HealthPlugin>('EliteHealthKit')