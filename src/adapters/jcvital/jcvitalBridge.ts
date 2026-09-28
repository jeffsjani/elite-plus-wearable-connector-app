import { registerPlugin } from '@capacitor/core'

/**
 * TS-side contract for the Elite+ JCVital Capacitor bridge. Method names are Elite+'s own plugin
 * surface (not vendor SDK method names). Build 7A does NOT ship a native Kotlin implementation
 * of this interface: no native Android JCVital SDK (AAR/JAR/Kotlin/Java source) was available to
 * inspect for this build. See src/adapters/jcvital/README.md for the blocker. This interface is
 * kept so the adapter, capability negotiation, and chunking logic can be built and tested now,
 * and so the native implementation can be added later without redesigning the TS layer.
 */

export type JCVitalConnectionState = 'DISCONNECTED' | 'SCANNING' | 'CONNECTING' | 'CONNECTED' | 'SYNCING' | 'ERROR'

export interface JCVitalDeviceInfo {
  deviceId: string
  deviceModel?: string
  firmwareVersion?: string
  sdkVersion?: string
}

export interface JCVitalDeviceCapabilities {
  deviceModel?: string
  firmwareVersion?: string
  sdkVersion?: string
  /** Command identifiers the connected device actually reported support for, when queryable. */
  availableWorkoutHrCommands: string[]
  /** Reported cadence(s) for stored workout HR, when the firmware exposes this at runtime. */
  reportedHistoricalCadencesMs?: number[]
  supportedRawChannels: string[]
}

export interface JCVitalWorkoutHrSample {
  timestamp?: string
  offsetMs?: number
  bpm: number
}

export interface JCVitalWorkoutRecord {
  workoutId: string
  activityModeRaw: number
  activityModeLabel: string
  startTime: string
  endTime?: string
  steps?: number
  calories?: number
  distanceMeters?: number
  pace?: string
  mets?: number
  metsSource?: string
  hrSummaryBpm?: number
  hrSamples: JCVitalWorkoutHrSample[]
  /** Cadence actually reported by the SDK/firmware for hrSamples, in ms. */
  hrSamplingIntervalMs?: number
}

export interface JCVitalScalarReading {
  sourceRecordId: string
  metric: string
  valueNumber: number
  unit: string
  startTime: string
  endTime?: string
  acquisitionMode: string
}

export interface JCVitalPlugin {
  initialize(): Promise<{ ready: boolean }>
  requestPermissions(): Promise<{ granted: boolean }>
  scan(options: { timeoutMs: number }): Promise<{ devices: JCVitalDeviceInfo[] }>
  connect(options: { deviceId: string }): Promise<{ connected: boolean }>
  disconnect(): Promise<void>
  getConnectionStatus(): Promise<{ state: JCVitalConnectionState }>
  getDeviceInfo(): Promise<JCVitalDeviceInfo>
  getBattery(): Promise<{ level: number; charging: boolean }>
  getFirmwareVersion(): Promise<{ firmwareVersion: string }>
  getMonitoringConfiguration(): Promise<{ activeHours?: { startHour: number; endHour: number }; weekdays?: number; intervalSeconds?: number }>
  getDeviceCapabilities(): Promise<JCVitalDeviceCapabilities>

  syncHeartRateHistory(options: { since?: string }): Promise<{ readings: JCVitalScalarReading[] }>
  syncHrvHistory(options: { since?: string }): Promise<{ readings: JCVitalScalarReading[] }>
  syncPpiHistory(options: { since?: string }): Promise<{ readings: JCVitalScalarReading[] }>
  syncSpo2History(options: { since?: string }): Promise<{ readings: JCVitalScalarReading[] }>
  syncTemperatureHistory(options: { since?: string }): Promise<{ readings: JCVitalScalarReading[] }>
  syncSleepHistory(options: { since?: string }): Promise<{ readings: JCVitalScalarReading[] }>
  syncActivityHistory(options: { since?: string }): Promise<{ readings: JCVitalScalarReading[] }>
  syncWorkoutHistory(options: { since?: string }): Promise<{ workouts: JCVitalWorkoutRecord[] }>

  startRealtimeData(): Promise<void>
  stopRealtimeData(): Promise<void>
  startRealtimeHeartRate(): Promise<void>
  stopRealtimeHeartRate(): Promise<void>

  startPpgMeasurement(): Promise<void>
  stopPpgMeasurement(): Promise<void>
  startEcgOrHrvMeasurement(): Promise<void>
  stopEcgOrHrvMeasurement(): Promise<void>

  startWorkout(options: { activityMode: number }): Promise<{ workoutId: string }>
  pauseWorkout(): Promise<void>
  resumeWorkout(): Promise<void>
  stopWorkout(): Promise<{ workoutId: string }>
}

export const JCVital = registerPlugin<JCVitalPlugin>('EliteJCVital')
