import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'
import type { CompletionStatus } from '../../models/metricTaxonomy'
import type { NativeObservation, SerializableValue, WearableSource } from '../../models/wearableObservation'
import type { LiveWorkoutPacket, LiveWorkoutStatus } from './WorkoutTelemetry'

/** Native implementation: android/app/src/main/java/com/hapi/eliteplus/connector/jcvital/JCVitalV8Plugin.kt */

export type JCVitalV8PermissionStatus = 'AUTHORIZED' | 'DENIED' | 'NOT_REQUESTED' | 'BLUETOOTH_DISABLED' | 'BLUETOOTH_UNAVAILABLE'

export type JCVitalV8ConnectionState = 'DISCONNECTED' | 'SCANNING' | 'CONNECTING' | 'CONNECTED' | 'INITIALIZING' | 'READY' | 'ERROR'

export type JCVitalV8ErrorCode =
  | 'BLUETOOTH_UNAVAILABLE' | 'BLUETOOTH_DISABLED' | 'PERMISSION_DENIED' | 'SCAN_FAILED' | 'DEVICE_NOT_FOUND'
  | 'CONNECTION_FAILED' | 'CONNECTION_LOST' | 'SERVICE_DISCOVERY_FAILED' | 'NOTIFICATION_SETUP_FAILED'
  | 'SDK_INITIALIZATION_FAILED' | 'COMMAND_FAILED' | 'RESPONSE_PARSE_FAILED' | 'UNSUPPORTED_OPERATION'

export interface JCVitalV8Device {
  id: string
  name: string | null
  macAddress: string
  rssi: number
  bonded: boolean
  connectable: boolean
  lastSeenAt: string
  advertisesJcvitalService: boolean
}

export interface JCVitalV8DeviceInfo {
  deviceId: string
  advertisedName?: string
  deviceName?: string
  macAddress?: string
  firmwareVersion?: string
  vendorDeviceId?: string
  batteryLevel?: number | null
  charging?: boolean | null
  sdkVersion: string
  missingFields: string[]
}

export interface JCVitalV8Battery {
  deviceId: string | null
  level: number | null
  charging: boolean | null
  chargingStateRaw: number | null
  voltageRaw: number | null
  vendorDataType: string
  receiptTimestamp: string
}

export interface JCVitalV8Observation {
  source: 'JCVITAL_V8'
  type: 'HEART_RATE'
  value: number
  unit: 'bpm'
  acquisitionMode: 'REALTIME'
  deviceId: string | null
  firmwareVersion: string | null
  sdkVersion: string
  vendorDataType: string
  /** Device measurement time. Null: the V8 realtime packets carry no timestamp. */
  timestamp: string | null
  receiptTimestamp: string
  timezone: string
  sessionId: string | null
  packetId: string | null
  rawVendorPayload: Record<string, unknown>
}

export interface JCVitalV8ConnectionStateEvent {
  state: JCVitalV8ConnectionState
  previousState: JCVitalV8ConnectionState
  reason: string | null
  deviceId: string | null
  timestamp: string
}

export interface JCVitalV8ErrorEvent {
  code: JCVitalV8ErrorCode
  message: string
  state: JCVitalV8ConnectionState
  deviceId: string | null
  timestamp: string
}

export interface JCVitalV8RawVendorDataEvent {
  source: 'JCVITAL_V8'
  vendorDataType: string
  dataEnd: boolean | null
  data: unknown
  deviceId: string | null
  receiptTimestamp: string
}

export interface JCVitalV8ParseErrorEvent {
  vendorDataType: string
  message: string
  rawRecord: SerializableValue
  receivedAt: string
}

export interface JCVitalV8HistoricalSyncResult {
  syncId: string
  deviceId: string | null
  provider: 'JCVITAL'
  sdkCommand: string
  vendorDataType: string
  startedAt: string
  completedAt: string
  recordsReceived: number
  recordGroupsReceived: number
  recordsStored: 0
  recordsDeduplicated: number
  recordsRejected: number
  earliestObservation: string | null
  latestObservation: string | null
  partial: boolean
  completionStatus: CompletionStatus
  packetCount: number
  parseErrors: JCVitalV8ParseErrorEvent[]
  observations: NativeObservation[]
}

export interface JCVitalV8MonitoringConfiguration {
  deviceId: string | null
  provider: 'JCVITAL'
  acquisitionMode: 'DEVICE_CONFIGURATION'
  receivedAt: string
  configurations: Record<'HEART_RATE' | 'SPO2' | 'TEMPERATURE' | 'HRV', {
    enabledModeRaw: string | null
    intervalMinutesRaw: string | null
    startHourRaw: string | null
    startMinuteRaw: string | null
    endHourRaw: string | null
    endMinuteRaw: string | null
    weekdaysRaw: string | null
    vendorDataType: string
    rawPayload: SerializableValue
  }>
}

export interface JCVitalV8LiveWorkoutSession {
  sessionId: string | null
  deviceId: string | null
  activityType: string | null
  vendorActivityMode: number | null
  startedAt: string | null
  stoppedAt: string | null
  status: LiveWorkoutStatus
  packetCount: number
  firstPacketAt: string | null
  lastPacketAt: string | null
  heartbeatAttemptCount: number
  heartbeatSentCount: number
  heartbeatSkippedCount: number
  heartbeatIntervalMs: number
  firmwareVersion: string | null
  sdkVersion: string
  source?: WearableSource
  heartbeatInputs?: {
    distanceKm: number
    paceSeconds: number
    rssiStrength: number
    inputSource: string
    note: string
  }
  parseErrors: Array<{ message: string; vendorDataType: string; receivedAt: string }>
}

export interface JCVitalV8WorkoutHeartRateEvent {
  sessionId: string
  heartRate: number
  receivedAt: string
  packetSequence: number
  vendorDataType: string
  acquisitionMode: 'WORKOUT_REALTIME'
}

export interface JCVitalV8WorkoutErrorEvent {
  sessionId: string
  message: string
  receivedAt: string
}

export interface JCVitalV8LiveWorkoutSession {
  sessionId: string | null
  deviceId: string | null
  activityType: string | null
  vendorActivityMode: number | null
  startedAt: string | null
  stoppedAt: string | null
  status: LiveWorkoutStatus
  packetCount: number
  firstPacketAt: string | null
  lastPacketAt: string | null
  heartbeatAttemptCount: number
  heartbeatSentCount: number
  heartbeatSkippedCount: number
  heartbeatIntervalMs: number
  firmwareVersion: string | null
  sdkVersion: string
  heartbeatInputs?: {
    distanceKm: number
    paceSeconds: number
    rssiStrength: number
    inputSource: string
    note: string
  }
  parseErrors: Array<{ message: string; vendorDataType: string; receivedAt: string }>
}

export interface JCVitalV8WorkoutHeartRateEvent {
  sessionId: string
  heartRate: number
  receivedAt: string
  packetSequence: number
  vendorDataType: string
  acquisitionMode: 'WORKOUT_REALTIME'
}

export interface JCVitalV8WorkoutErrorEvent {
  sessionId: string
  message: string
  receivedAt: string
}

export interface JCVitalV8PermissionResult {
  status: JCVitalV8PermissionStatus
  bluetoothEnabled: boolean
  permissions: string[]
}

export interface JCVitalV8StateResult {
  state: JCVitalV8ConnectionState
  deviceId: string | null
}

export interface JCVitalV8Plugin {
  isAvailable(): Promise<{ available: boolean; enabled: boolean }>
  getPermissionStatus(): Promise<JCVitalV8PermissionResult>
  requestPermissions(): Promise<JCVitalV8PermissionResult>
  startScan(options?: { timeoutMs?: number }): Promise<void>
  stopScan(): Promise<void>
  getDiscoveredDevices(): Promise<{ devices: JCVitalV8Device[] }>
  /** Resolves once the V8 is READY (GATT + notifications + first SDK round-trip). */
  connect(options: { deviceId: string }): Promise<JCVitalV8StateResult>
  disconnect(): Promise<JCVitalV8StateResult>
  getConnectionState(): Promise<JCVitalV8StateResult>
  getDeviceInfo(): Promise<JCVitalV8DeviceInfo>
  getBattery(): Promise<JCVitalV8Battery>
  /** measurementSeconds: V8 heart-rate measurement window, 31–65535 s (default 60). */
  startRealtimeData(options?: { measurementSeconds?: number }): Promise<{ sessionId: string; measurementSeconds: number }>
  stopRealtimeData(): Promise<{ sessionId: string | null }>
  syncHistoricalHeartRate(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalSpo2(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalTemperature(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalHrv(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalPpi(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalActivity(): Promise<JCVitalV8HistoricalSyncResult>
  syncDetailedActivity(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalSleepStages(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalSleepMovement(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalWorkouts(): Promise<JCVitalV8HistoricalSyncResult>
  getMonitoringConfiguration(): Promise<JCVitalV8MonitoringConfiguration>
  startWorkoutCapture(options?: { activityMode?: number }): Promise<JCVitalV8LiveWorkoutSession>
  stopWorkoutCapture(): Promise<JCVitalV8LiveWorkoutSession>
  pauseWorkoutCapture(): Promise<JCVitalV8LiveWorkoutSession>
  resumeWorkoutCapture(): Promise<JCVitalV8LiveWorkoutSession>
  getWorkoutCaptureStatus(): Promise<JCVitalV8LiveWorkoutSession>

  addListener(event: 'jcvitalScanResult', listener: (device: JCVitalV8Device) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalConnectionState', listener: (event: JCVitalV8ConnectionStateEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalDeviceInfo', listener: (info: JCVitalV8DeviceInfo) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalBattery', listener: (battery: JCVitalV8Battery) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalHeartRate', listener: (observation: JCVitalV8Observation) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalObservation', listener: (observation: NativeObservation) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalParseError', listener: (error: JCVitalV8ParseErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawVendorData', listener: (event: JCVitalV8RawVendorDataEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalError', listener: (error: JCVitalV8ErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutState', listener: (session: JCVitalV8LiveWorkoutSession) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutPacket', listener: (packet: LiveWorkoutPacket) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutHeartRate', listener: (event: JCVitalV8WorkoutHeartRateEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutError', listener: (event: JCVitalV8WorkoutErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutParseError', listener: (event: SerializableValue) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

export const JCVitalV8 = registerPlugin<JCVitalV8Plugin>('JCVitalV8')
