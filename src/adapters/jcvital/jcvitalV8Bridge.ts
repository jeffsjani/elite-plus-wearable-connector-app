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

export interface JCVitalV8RawEcgSession {
  sessionId: string | null
  deviceId: string | null
  startedAt: string | null
  stoppedAt: string | null
  status: 'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'ERROR' | 'DISCONNECTED'
  packetCount: number
  sampleCount: number
  missingPacketCount: number
  duplicatePacketCount: number
  outOfOrderPacketCount: number
  parseErrorCount: number
  bytesReceived: number
  chunksEmitted: number
  droppedPacketCount: number
  lastPacketId: number | null
  averageSamplesPerPacket: number | null
  minimumRawSample: number | null
  maximumRawSample: number | null
  maxBufferedEstimateBytes: number
  hardChunkBufferLimitBytes: number
  temporaryStorePath: string | null
  persistedPacketCount: number
  persistedBytes: number
  storageErrorCount: number
  sampleRateHz: null
  sampleIntervalMs: null
  sampleFormat: 'UINT24_LE_VENDOR_RAW'
  unit: 'UNKNOWN_VENDOR_UNIT'
  source?: WearableSource
  diagnosticState?: string
  ecgStartDiagnostics?: JCVitalV8RawEcgStartDiagnostics
  parseErrors: Array<Record<string, unknown>>
}

export interface JCVitalV8RawEcgStartDiagnostics {
  diagnosticState: string
  diagnosticClassification: string
  firstNotificationClassification: 'MEASUREMENT_COMMAND_RESPONSE' | 'REALTIME_FLAG_RESPONSE' | 'RAW_ECG_0X07' | 'VENDOR_STATUS' | 'UNKNOWN_NOTIFICATION' | null
  secondNotificationClassification: 'MEASUREMENT_COMMAND_RESPONSE' | 'REALTIME_FLAG_RESPONSE' | 'RAW_ECG_0X07' | 'VENDOR_STATUS' | 'UNKNOWN_NOTIFICATION' | null
  measurementStartCommand: {
    queuedAt: string | null
    writeAckAt: string | null
  }
  realtimeFlagCommand: {
    queuedAt: string | null
    writeAckAt: string | null
  }
  firstNotificationAfterStartAt: string | null
  vendorDataTypesSeenAfterEcgStart: Array<Record<string, unknown>>
  anyCommand07NotificationCount: number
  ecgWaveformCandidate07Count: number
  firstCommand07NotificationAt: string | null
  lastCommand07NotificationAt: string | null
  command07NotificationSamples: Array<Record<string, unknown>>
  type64CallbackCount: number
  firstType64CallbackAt: string | null
  lastType64CallbackAt: string | null
  ecgPpgStatusRequestSupport: 'NO_REQUEST_METHOD_FOUND' | string
  ecgPpgStatusRequestCount: number
  ecgPpgStatusRequestTimes: string[]
  ecgPpgStatusResponseCount: number
  ecgStatusValuesSeen: number[]
  firstEcgStatusAt: string | null
  firstDataAvailableStatusAt: string | null
  ecgNoDataAfter10s: boolean
  genericNotificationsAfterStart: Array<{
    sequence: number
    receivedAt: string
    length: number
    commandByteUnsigned: number
    secondByteUnsigned: number | null
    first16BytesHex: string
    fullBytesHex?: string
    afterMeasurementCommandAck: boolean
    afterRealtimeFlagCommandAck: boolean
    parserResultCount: number
    sdkParserResult: 'NO_RESULT' | 'RESULT_WITH_DATA_TYPE' | 'RESULT_WITHOUT_DATA_TYPE' | 'MULTIPLE_RESULTS'
    parserResults: Array<{ dataType: string; dataEnd: boolean | null }>
  }>
}

export interface JCVitalV8RawEcgChunk {
  signalType: 'ECG_RAW'
  sessionId: string
  deviceId: string | null
  sequenceNumber: number
  firstPacketId: number
  lastPacketId: number
  packetSequenceStart: number
  packetSequenceEnd: number
  packetIds: number[]
  packetCount: number
  receivedAtStart: string
  receivedAtEnd: string
  sampleRateHz: null
  sampleIntervalMs: null
  sampleFormat: 'UINT24_LE_VENDOR_RAW'
  unit: 'UNKNOWN_VENDOR_UNIT'
  samples: number[]
  rawPacketBytes: number[][]
  sampleCount: number
  estimatedBytes: number
  source: WearableSource
  firmwareVersion: string | null
  sdkVersion: string
}

export interface JCVitalV8RawEcgErrorEvent {
  sessionId: string
  message: string
  receivedAt: string
  byteCount?: number
  rawPacketBytes?: number[]
}

export interface JCVitalV8RawPpgSession {
  sessionId: string | null
  deviceId: string | null
  startedAt: string | null
  stoppedAt: string | null
  status: 'IDLE' | 'STARTING' | 'RUNNING' | 'STOPPING' | 'STOPPED' | 'ERROR' | 'DISCONNECTED'
  signalType: 'PPG_WORKFLOW_RAW_VENDOR'
  packetCount: number
  chunkCount: number
  bytesReceived: number
  bufferHighWaterMark: number
  parseErrorCount: number
  notificationLengthCounts: Record<'153' | '203' | 'other', number>
  notificationLengthsExactCounts: Record<string, number>
  vendorDataType119Count: number
  firstPacketAt: string | null
  lastPacketAt: string | null
  decodedSampleCount: number
  minimumRawDecodedValue: number | null
  maximumRawDecodedValue: number | null
  sampleRateHz: null
  sampleIntervalMs: null
  unit: 'UNKNOWN_VENDOR_UNIT'
  sampleFormat: 'UNKNOWN_VENDOR_LAYOUT'
  rawSampleDiagnostics: Record<string, {
    packetCount: number
    decodedSampleCount: number
    minimumRawDecodedValue: number | null
    maximumRawDecodedValue: number | null
  }>
  decodedFieldNames: string[]
  vendorDerivedFields: Array<Record<string, unknown>>
  temporaryStorePath: string | null
  persistedPacketCount: number
  persistedBytes: number
  storageErrorCount: number
  ppgNativePacketCount?: number
  ppgNativeChunkCount?: number
  ppgChunkEventsSentToJs?: number
  ppgUiSummaryEventDropped?: number
  ppgLastEventPayloadBytes?: number
  ppgMaxEventPayloadBytes?: number
  first3Chunks?: JCVitalV8RawPpgChunkSample[]
  last3Chunks?: JCVitalV8RawPpgChunkSample[]
  source?: WearableSource
  parseErrors: Array<Record<string, unknown>>
}

export interface JCVitalV8RawPpgChunk {
  sessionId: string
  sequenceStart: number
  sequenceEnd: number
  packetCount: number
  chunkCount?: number
  wireBytes: number
  firstReceivedAt: string
  lastReceivedAt: string
  notificationLengthCounts: Record<'153' | '203' | 'other', number>
  vendorType119Count: number
  decoded153Summary?: JCVitalV8RawPpgLayoutSummary | null
  decoded203Summary?: JCVitalV8RawPpgLayoutSummary | null
  parseErrorCount: number
}

export interface JCVitalV8RawPpgLayoutSummary {
  packetCount: number
  decodedSampleCount: number
  minimumRawDecodedValue: number | null
  maximumRawDecodedValue: number | null
}

export interface JCVitalV8RawPpgChunkSample extends JCVitalV8RawPpgChunk {
  packets: Array<{
    sessionId: string
    sequenceNumber: number
    receivedAt: string
    notificationLength: number
    vendorCommandByte: number
    originalBytes: number[]
    vendorDataType119: boolean
    vendorParserOutput: Array<Record<string, unknown>>
    decodedSampleCount: number
  }>
}

export interface JCVitalV8RawPpgErrorEvent {
  sessionId: string
  message: string
  receivedAt: string
  parseErrorCount: number
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
  startRawEcg(): Promise<JCVitalV8RawEcgSession>
  stopRawEcg(): Promise<JCVitalV8RawEcgSession>
  getRawEcgStatus(): Promise<JCVitalV8RawEcgSession>
  startRawPpg(): Promise<JCVitalV8RawPpgSession>
  stopRawPpg(): Promise<JCVitalV8RawPpgSession>
  getRawPpgStatus(): Promise<JCVitalV8RawPpgSession>

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
  addListener(event: 'jcvitalRawEcgStatus', listener: (session: JCVitalV8RawEcgSession) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawEcgChunk', listener: (chunk: JCVitalV8RawEcgChunk) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawEcgError', listener: (error: JCVitalV8RawEcgErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawPpgStatus', listener: (session: JCVitalV8RawPpgSession) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawPpgChunk', listener: (chunk: JCVitalV8RawPpgChunk) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawPpgError', listener: (error: JCVitalV8RawPpgErrorEvent) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

export const JCVitalV8 = registerPlugin<JCVitalV8Plugin>('JCVitalV8')
