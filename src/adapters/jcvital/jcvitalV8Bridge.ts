import { registerPlugin, type PluginListenerHandle } from '@capacitor/core'

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

  addListener(event: 'jcvitalScanResult', listener: (device: JCVitalV8Device) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalConnectionState', listener: (event: JCVitalV8ConnectionStateEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalDeviceInfo', listener: (info: JCVitalV8DeviceInfo) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalBattery', listener: (battery: JCVitalV8Battery) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalHeartRate', listener: (observation: JCVitalV8Observation) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawVendorData', listener: (event: JCVitalV8RawVendorDataEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalError', listener: (error: JCVitalV8ErrorEvent) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

export const JCVitalV8 = registerPlugin<JCVitalV8Plugin>('JCVitalV8')
