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
  v8Candidate: boolean
}

/** Native classification is authoritative; JavaScript must not invent a second name/UUID policy. */
export function isElitePlusV8Advertisement(device: Pick<JCVitalV8Device, 'v8Candidate'>): boolean {
  return device.v8Candidate === true
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
  sourceRecordEnvelopeIds?: string[]
  sourceCallbackEnvelopeIds?: string[]
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
  nativeRequestAccepted?: boolean
  nativeCommandQueued?: boolean
  nativeCommandWritten?: boolean
  packetCount: number
  parseErrors: JCVitalV8ParseErrorEvent[]
  observations: NativeObservation[]
  /** Set for streamed HR history: observations arrived as jcvitalHistoricalHrChunk events and are [] here. */
  streamed?: boolean
  stream?: JCVitalV8HistoricalHrStreamStats
}

export interface JCVitalV8SleepCertificationResult {
  acquisitionSessionId: string
  outcome: 'COMPLETE' | 'FAILED'
  acquisitionError: { code: string; message: string } | null
  results: JCVitalV8HistoricalSyncResult[]
}

export interface WorkoutHistoryNativeObservation {
  id: string
  sourceEnvelopeId: string
  sourceCallbackId: string
  sourceIndex: number
  sessionId: string
  vendorDataType: '29'
  metricType: 'WORKOUT_HISTORY_NATIVE_SOURCE'
  vendorTimestamp: string | null
  sdkRecord: string
  semanticClassification: 'RESEARCH_NATIVE_ONLY'
  semanticConfidence: 'UNKNOWN_VENDOR_SEMANTICS'
  canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
}
export interface WorkoutHistoryAcquisition extends Omit<JCVitalV8HistoricalSyncResult, 'observations'> {
  observations: WorkoutHistoryNativeObservation[]
  sourceCommandEnvelopeIds: string[]
  sourceCommandAckEnvelopeIds: string[]
  sourceNotificationEnvelopeIds: string[]
  sourceParserOutcomeEnvelopeIds: string[]
  retryCount: 0
  canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
  deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY'
}

export interface JCVitalV8HistoricalHrStreamStats {
  syncSessionId: string
  chunkSize: number
  safeTestLimit: number | null
  safeTestLimitReached: boolean
  packetCount: number
  vendorRecordCount: number
  bufferedRecordCount: number
  /** Arrival order of vendor source records; the physical V8 sends NEWEST_FIRST. */
  vendorRecordOrder: 'OLDEST_FIRST' | 'NEWEST_FIRST' | 'MIXED' | 'UNKNOWN'
  vendorAscendingTransitions: number
  vendorDescendingTransitions: number
  emittedOrder: 'CHRONOLOGICAL_BY_RECORD_START'
  outOfOrderEmitted: number
  plannedSampleCount: number
  expandedSampleCount: number
  emittedSampleCount: number
  validSampleCount: number
  skippedNoMeasurementCount: number
  duplicateCount: number
  chunkCount: number
  largestChunkCount: number
  estimatedSerializedChunkBytes: number
  parseErrorCount: number
  finalEmitted: boolean
}

/** One bounded native chunk of historical continuous HR (≤ chunkSize observations). */
export interface JCVitalV8HistoricalHrChunk {
  syncSessionId: string
  chunkIndex: number
  isFinal: boolean
  vendorDataType: string
  safeTestLimit: number | null
  /** Cumulative source records read so far. */
  sourceRecordCount: number
  /** Samples the native stream will send in total for this sync. */
  plannedSampleCount: number
  sampleCount: number
  emittedSampleCountTotal: number
  estimatedSerializedBytes: number
  observations: NativeObservation[]
}

export interface JCVitalV8HistoricalSyncLifecycleEvent {
  syncId: string
  vendorDataType: string
  connectionGeneration: number
  stage: 'REQUEST_ACCEPTED' | 'ACQUIRING' | 'NATIVE_COMMAND_QUEUED' | 'NATIVE_COMMAND_WRITTEN' | 'FAILED'
  nativeRequestAccepted: boolean
  nativeCommandQueued: boolean
  nativeCommandWritten: boolean
}

export interface JCVitalV8NativeBreadcrumb {
  at: string
  stage: string
  detail: Record<string, string | number | boolean | null>
}

export interface JCVitalV8NativeBreadcrumbs {
  current: JCVitalV8NativeBreadcrumb[]
  previous: JCVitalV8NativeBreadcrumb[]
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
  sourceEnvelopeId?: string
  provenance?: {
    sourceEnvelopeId?: string | null
    sourceCallbackId?: string | null
    sourceEnvelopeModelVersion?: string
  }
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
  first3Chunks?: JCVitalV8RawPpgChunk[]
  last3Chunks?: JCVitalV8RawPpgChunk[]
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

export interface SourceJournalScope {
  accountId: string
  deviceScopeId: string
}

export interface SourceJournalDiagnostics {
  modelVersion: string
  enabled: boolean
  failedClosed: boolean
  lastOutcome: string
  refusedCount: number
  totalEnvelopeCount: number
  totalStoredBytes: number
  maxBytes: number
  maxEnvelopes: number
  maxEntryBytes: number
  retentionPolicy: string
  rawStorage: string
  recoveryAudit?: Record<string, unknown> | null
  recoveryAuditHistory?: Array<Record<string, unknown>>
  latestRecoveryAudit?: Record<string, unknown> | null
}

export interface SourceEnvelopeEntry {
  sequence: number
  envelopeId: string
  callbackId: string | null
  recordIndex: number | null
  kind: string
  receivedAt: string
  timezone: string
  envelopeJson: string | null
  rawBytesBase64: string | null
}

export interface SourceJournalPage {
  modelVersion: string
  envelopes: SourceEnvelopeEntry[]
  nextSequence: number
  hasMore: boolean
}

export interface SourceJournalOutcome {
  operation: string
  status: string
  receivedAt?: string
}

export interface RawPpgSavedEvidenceCandidate {
  filename: string
  sessionId: string | null
  byteLength: number
  sha256: string
  packetCount: number
  truncated: boolean
  truncationOffset: number | null
  matchesDocumentedShape: boolean
  documentedShape: {
    expectedPacketCount: number
    expectedDataPackets: string
    expectedStatusPackets: string
    expectedSpoolBytes: number
  }
  journalSourceFiles: Array<Record<string, unknown>>
}

/** Offline/historical Raw PPG scope: persisted authenticated account; device optional (never the live capture scope). */
export interface RawPpgSavedEvidenceScope {
  accountId: string | null
  deviceScopeId?: string | null
}

/** VC29 offline counters: inspection/export never issue BLE, network or acquisition. */
export interface RawPpgOfflineCounters {
  bleCommands: 0
  networkRequests: 0
  acquisitions: 0
}

/** VC29 one-shot physical certification attempt guard (restart-persistent, per account/device). */
export interface RawPpgPhysicalCertificationStatus {
  attempted: boolean
  state: string | null
  claim: Record<string, unknown> | null
  captureAllowed: boolean
  blockedReason: string | null
}

/** Live/terminal status event for the VC29 one-shot capture. Never contains glucose semantics. */
export interface RawPpgPhysicalCertificationEvent {
  certificationGroupId?: string | null
  sessionId?: string | null
  state: string
  sourceStatus?: string | null
  packetCount?: number | null
  spoolBytes?: number | null
  failedChecks?: string[] | null
  failures?: string[] | null
  terminal?: boolean
  finalSnapshotPersisted?: boolean | null
  [key: string]: unknown
}

export interface RawPpgPhysicalCertificationInspection extends Partial<RawPpgOfflineCounters> {
  found: boolean
  attempted: boolean
  claim?: Record<string, unknown> | null
  state?: string
  sourceStatus?: string
  certificationGroupId?: string
  sessionId?: string
  semanticClassification?: 'RESEARCH_NATIVE_ONLY'
  canonicalAuthority?: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
  deliveryDisposition?: 'LOCAL_SOURCE_EVIDENCE_ONLY'
  unit?: 'UNKNOWN_VENDOR_UNIT'
  sampleRateHz?: null
  samplingIntervalMs?: null
  packetCount?: number
  spoolFileName?: string
  spoolByteLength?: number | null
  spoolSha256?: string | null
  failedChecks?: string | null
  onDiskVerification?: 'VERIFIED' | 'MISMATCH'
  verificationErrors?: string[]
}

export interface RawPpgPhysicalCertificationSpool extends RawPpgOfflineCounters {
  fileName: string
  byteLength: number
  sha256: string
  base64: string
  byteEncoding: string
}

export const RAW_PPG_SAVED_EVIDENCE_FAILURE_CODES = [
  'PPG_SPOOL_DIRECTORY_NOT_FOUND',
  'PPG_SAVED_EVIDENCE_NOT_FOUND',
  'PPG_SPOOL_FOUND_METADATA_MISSING',
  'PPG_SPOOL_FOUND_JOURNAL_MISSING',
  'PPG_JOURNAL_FOUND_SPOOL_MISSING',
  'PPG_SCOPE_NOT_RESOLVED',
  'PPG_MULTIPLE_CANDIDATES_AMBIGUOUS',
  'PPG_SPOOL_TRUNCATED',
  'PPG_SPOOL_SHAPE_MISMATCH',
  'PPG_SOURCE_CHAIN_INCOMPLETE',
  'PPG_INSPECTION_INTERNAL_ERROR',
] as const
export type RawPpgSavedEvidenceFailureCode = typeof RAW_PPG_SAVED_EVIDENCE_FAILURE_CODES[number]
export const RAW_PPG_SAVED_EVIDENCE_OK_CODE = 'PPG_SAVED_EVIDENCE_FOUND_DIAGNOSTIC_ONLY'

/** VC28 persisted saved-evidence diagnostic snapshot (written natively on every inspection, success or failure). */
export interface RawPpgSavedEvidenceDiagnostic {
  kind: 'RawPpgSavedEvidenceDiagnostic' | 'RawPpgSavedEvidenceBridgeFailure'
  generatedAt: string
  status: 'OK' | 'FAILED'
  errorCode: RawPpgSavedEvidenceFailureCode | typeof RAW_PPG_SAVED_EVIDENCE_OK_CODE | string | null
  errorMessage: string | null
  failureStage: string | null
  exceptionClass?: string | null
  findings?: string[]
  scopeResolved?: boolean
  accountIdResolved?: boolean
  deviceScopeIdResolved?: boolean
  appFilesDirAccessible?: boolean
  spoolDirectoryExists?: boolean
  spoolDirectoryPath?: string | null
  candidateSpoolCount?: number
  candidateFilenames?: string[]
  candidateByteSizes?: number[]
  candidateSha256?: Array<string | null>
  selectedSessionId?: string | null
  rawPpgPacketStoreMetadataExists?: boolean
  historicalRawPpgSessionExists?: boolean
  journalRowsAssociatedWithPpgExist?: boolean
  matchingBleNotificationCount?: number
  matchingSdkCallbackCount?: number
  matchingCommandRequestCount?: number
  completeSourceChainConstructible?: boolean
  sourceChainMissing?: string[]
  certificationTransition?: 'NONE_DIAGNOSTIC_ONLY'
  canonicalAuthority?: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
  [key: string]: unknown
}

export interface RawPpgSavedEvidenceInspection extends RawPpgSavedEvidenceDiagnostic {
  operation: 'INSPECT_EXISTING_RAW_PPG_EVIDENCE'
  bleCommandsIssued: 0
  deviceConnectionsOpened: 0
  acquisitionsStarted: 0
  candidateCount: number
  candidates: RawPpgSavedEvidenceCandidate[]
  exactDocumentedShapeMatchCount: number
  recommendedSessionId: string | null
  found: boolean
  diagnosticPersistenceError?: string | null
}

export interface RawPpgSavedEvidencePacket {
  index: number
  byteLength: number
  sha256: string
  opcode: string
  dataTypeClassification: 'DATA_PACKET' | 'STATUS_PACKET' | 'UNKNOWN_OPCODE'
  spoolRange: { lengthPrefixOffset: number; payloadOffset: number; payloadEndOffsetExclusive: number }
  trailerByte: { offsetWithinPayload: number; checksumAlgorithm: 'CHECKSUM_ALGORITHM_NOT_PROVEN' }
  sampleMeaning: 'NOT_INFERRED_FROM_BYTE_POSITION'
  base64: string
  sourceEnvelopeAncestry: Record<string, unknown>
}

export interface RawPpgSavedEvidenceCertification {
  kind: 'RawPpgSavedCertification'
  context: { scope: SourceJournalScope }
  certificationGroupId: string
  sessionId: string | null
  deviceIdentity: { deviceModel: unknown; characteristicUuid: unknown }
  firmwareVersion: unknown
  sdkVersion: unknown
  sourceSpool: {
    filename: string; path: string; byteLength: number; sha256: string; byteEncoding: string
    truncated: boolean; truncationOffset: number | null
  }
  packetCount: number
  packetOrdering: string
  packets: RawPpgSavedEvidencePacket[]
  structuralConfirmation: {
    expectedShapeConfirmed: boolean
    expectedPacketCount: number
    expectedDataPackets: string
    expectedStatusPackets: string
    expectedSpoolBytes: number
    actualDataPacketCount: number
    actualStatusPacketCount: number
  }
  sdkInterpretedSampleArray: { emitted: boolean; channel: string; note: string }
  sampling: { sampleRateHz: null; samplingIntervalMs: null }
  unit: 'UNKNOWN_VENDOR_UNIT'
  glucoseIsolation: {
    RAW_PPG_NOT_GLUCOSE: true
    NO_GLUCOSE_CANONICAL_MAPPING: true
    NO_GLUCOSE_INFERENCE: true
    NO_CGM_SUBSTITUTION: true
    vendorLabelDisclaimer: string
  }
  sourceEnvelopeJournal: {
    sourceFiles: Array<Record<string, unknown>>
    notificationEnvelopeCount: number
    notificationEnvelopes: Array<Record<string, unknown>>
  }
  commandAncestry: {
    statusOpcodeHex: string
    dataOpcodeHex: string
    vendorConstantNames: { statusOpcode: string; dataOpcode: string }
  }
  noTruncationRewriteOrNormalization: true
  state: 'CERTIFIED' | 'NOT_CERTIFIED'
  missingEvidence: string[]
  sourceStatus: 'CERTIFIED_E2E_LOSSLESS_SOURCE' | null
  semanticClassification: 'RESEARCH_NATIVE_ONLY' | null
  canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
  deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY'
  base44DeliveryRequired: false
  generatedAt: string
}

export interface PhysicalSemanticNativeEvidence {
  kind: 'activity' | 'activity_type25_anchor' | 'workout'
  commands: Array<{ name: string; opcode: number; rawBytesBase64: string; allowed: boolean; writeAcknowledged: boolean }>
  commandsAllowed: boolean
  digitalWellnessBeforeSha256: string | null
  digitalWellnessAfterSha256: string | null
  digitalWellnessUnchanged: boolean | null
  attemptId?: string | null
  lastCompletedStage?: import('./PhysicalSemanticEvidence').TestStage
  failureStage?: import('./PhysicalSemanticEvidence').FailureStage | null
  errorCode?: string | null
  errorMessage?: string | null
  commandsIssued?: number
  acquisitionStarted?: boolean
  sessionClosed?: boolean
  commandTypes?: string[]
  callbacksReceived?: number
  sourceEnvelopeIds?: string[]
  diagnostics?: Record<string, unknown>
}

export interface JCVitalV8Plugin {
  beginPhysicalSemanticTest(options: { kind: 'activity' | 'activity_type25_anchor' | 'workout'; attemptId?: string }): Promise<PhysicalSemanticNativeEvidence>
  endPhysicalSemanticTest(): Promise<PhysicalSemanticNativeEvidence>
  readPhysicalSemanticTestEvidence(options: SourceJournalScope & { kind: 'activity' | 'activity_type25_anchor' | 'workout' }): Promise<{ json: string | null }>
  getPipelineDiagnosticSnapshot(): Promise<import('./V8PipelineDiagnostic').NativePipelineSnapshot>
  /** Build 32B.1-D connection-diagnostic APK only; rejects with CONNECTION_DIAGNOSTIC_BUILD_REQUIRED otherwise. */
  getConnectionDiagnosticSnapshot(): Promise<import('./ConnectionDiagnostic').NativeConnectionDiagnosticSnapshot>
  readActivityCertificationSnapshot(options: SourceJournalScope): Promise<{ json: string | null }>
  writeActivityCertificationSnapshot(options: SourceJournalScope & { json: string }): Promise<{ saved: boolean }>
  readSleepCertificationSnapshot(options: SourceJournalScope): Promise<{ json: string | null }>
  writeSleepCertificationSnapshot(options: SourceJournalScope & { json: string }): Promise<{ saved: boolean }>
  readWorkoutCertificationSnapshot(options: SourceJournalScope): Promise<{ json: string | null }>
  readWorkoutSourceEnvelope(options: SourceJournalScope & { envelopeId: string }): ReturnType<JCVitalV8Plugin['readSourceEnvelope']>
  writeWorkoutCertificationSnapshot(options: SourceJournalScope & { json: string }): Promise<{ saved: boolean }>
  syncWorkoutHistoryCertification(): Promise<WorkoutHistoryAcquisition>
  /** Binding an identified transport enables notifications and resolves after the journaled SDK handshake. */
  configureSourceJournal(options: {
    accountId?: string | null; deviceScopeId?: string | null; enabled: boolean
    maxBytes?: number; maxEnvelopes?: number; maxEntryBytes?: number
  }): Promise<SourceJournalDiagnostics>
  getSourceJournalDiagnostics(options: SourceJournalScope): Promise<SourceJournalDiagnostics>
  /** Read-only global inventory; rejects unless storage is already open. Does not bind scope or recover. */
  getJournalCapacityAnalysis(): Promise<import('./ConnectionDiagnostic').JournalCapacityAnalysis>
  /** Build 32B.8: independent SELECT-only inspection of the retained database; no Bluetooth, scope or normal open. */
  analyzeExistingJournalOffline(): Promise<import('./ConnectionDiagnostic').OfflineJournalInspection>
  listSourceEnvelopes(options: SourceJournalScope & { afterSequence?: number; limit?: number }): Promise<SourceJournalPage>
  exportSourceJournal(options: SourceJournalScope & { afterSequence?: number; limit?: number }): Promise<SourceJournalPage>
  readSourceEnvelope(options: SourceJournalScope & { envelopeId: string }): Promise<{
    envelopeId: string; sequence: number; envelopeJson: string; rawBytesBase64: string | null
    sourceFile: {
      fileId: string; path: string; sessionId: string; format: string
      reservedBytes: number; actualBytes: number
      available: boolean
      integrityStatus: 'MISSING' | 'RESERVED_LENGTH_MISMATCH' | 'RESERVED_LENGTH_MATCH'
    } | null
  }>
  initialize(): Promise<{ initialized: boolean; pluginName: string }>
  isAvailable(): Promise<{ available: boolean; enabled: boolean }>
  getPermissionStatus(): Promise<JCVitalV8PermissionResult>
  requestPermissions(): Promise<JCVitalV8PermissionResult>
  startScan(options?: { timeoutMs?: number }): Promise<void>
  stopScan(): Promise<void>
  getDiscoveredDevices(): Promise<{ devices: JCVitalV8Device[] }>
  /** Resolves after GATT service identification, before notifications; bind the journal to reach READY. */
  connect(options: { deviceId: string }): Promise<JCVitalV8StateResult>
  disconnect(): Promise<JCVitalV8StateResult>
  getConnectionState(): Promise<JCVitalV8StateResult>
  getDeviceInfo(): Promise<JCVitalV8DeviceInfo>
  getBattery(): Promise<JCVitalV8Battery>
  /** measurementSeconds: V8 heart-rate measurement window, 31–65535 s (default 60). */
  startRealtimeData(options?: { measurementSeconds?: number }): Promise<{ sessionId: string; measurementSeconds: number }>
  stopRealtimeData(): Promise<{ sessionId: string | null }>
  /**
   * Streams history as jcvitalHistoricalHrChunk events and resolves with a summary (observations: []).
   * maxValidSamples bounds the Safe Test natively: no more valid samples are expanded or bridged.
   */
  syncHistoricalHeartRate(options?: { maxValidSamples?: number }): Promise<JCVitalV8HistoricalSyncResult>
  /** Releases the next native HR chunk; native holds at most two unacknowledged chunks. */
  ackHistoricalHrChunk(options: { syncSessionId: string; chunkIndex: number }): Promise<void>
  getNativeBreadcrumbs(): Promise<JCVitalV8NativeBreadcrumbs>
  syncHistoricalSpo2(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalTemperature(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalHrv(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalPpi(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalActivity(): Promise<JCVitalV8HistoricalSyncResult>
  syncDetailedActivity(): Promise<JCVitalV8HistoricalSyncResult>
  syncActivityCertification(): Promise<{ acquisitionSessionId: string; results: JCVitalV8HistoricalSyncResult[] }>
  syncHistoricalSleepStages(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalSleepMovement(): Promise<JCVitalV8HistoricalSyncResult>
  syncSleepCertification(): Promise<JCVitalV8SleepCertificationResult>
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
  /** Offline, read-only against app-private storage. 0 BLE commands, 0 device connection, 0 acquisition. */
  inspectSavedRawPpgEvidence(options: RawPpgSavedEvidenceScope & { sessionId?: string }): Promise<RawPpgSavedEvidenceInspection>
  /** Offline: last persisted saved-evidence diagnostic; requires no scope, READY state, BLE or network. */
  readSavedRawPpgDiagnostic(): Promise<{ json: string | null }>
  /** Offline, read-only. sessionId is required when multiple saved candidates exist. */
  exportSavedRawPpgEvidence(options: RawPpgSavedEvidenceScope & { sessionId?: string }): Promise<RawPpgSavedEvidenceCertification>
  /** Persists the CERTIFIED evidence so it survives app restart; 0 Base44, 0 enqueue, 0 delivery. */
  finalizeSavedRawPpgCertification(options: RawPpgSavedEvidenceScope & { sessionId?: string }): Promise<RawPpgSavedEvidenceCertification>
  readSavedRawPpgCertification(options: RawPpgSavedEvidenceScope): Promise<{ json: string | null }>
  /**
   * VC29: the ONE physical Raw PPG certification session (READY + authenticated scope only). Native journals
   * session/spool/attempt/command request before the BLE write; rejects forever after one saved attempt.
   */
  captureRawPpgCertification(): Promise<RawPpgPhysicalCertificationEvent>
  /** Offline: one-shot guard status for the persisted owner. 0 BLE, 0 network, 0 acquisition. */
  getRawPpgCertificationStatus(options: RawPpgSavedEvidenceScope): Promise<RawPpgPhysicalCertificationStatus>
  /** Offline: re-verifies the saved spool against the saved JSON and the journal raw bytes. */
  inspectSavedRawPpgPhysicalCertification(options: RawPpgSavedEvidenceScope): Promise<RawPpgPhysicalCertificationInspection>
  /** Offline: full saved certification JSON (never truncated). */
  readSavedRawPpgPhysicalCertification(options: RawPpgSavedEvidenceScope): Promise<{ json: string | null; claim: Record<string, unknown> | null; deviceScopeId: string | null }>
  /** Offline: the complete raw spool bytes (base64), its SHA-256 and byte length. */
  exportRawPpgCertificationSpool(options: RawPpgSavedEvidenceScope): Promise<RawPpgPhysicalCertificationSpool>

  addListener(event: 'jcvitalScanResult', listener: (device: JCVitalV8Device) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalConnectionState', listener: (event: JCVitalV8ConnectionStateEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalDeviceInfo', listener: (info: JCVitalV8DeviceInfo) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalBattery', listener: (battery: JCVitalV8Battery) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalHeartRate', listener: (observation: JCVitalV8Observation) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalObservation', listener: (observation: NativeObservation) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalHistoricalHrChunk', listener: (chunk: JCVitalV8HistoricalHrChunk) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalHistoricalSyncLifecycle', listener: (event: JCVitalV8HistoricalSyncLifecycleEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalParseError', listener: (error: JCVitalV8ParseErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawVendorData', listener: (event: JCVitalV8RawVendorDataEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalError', listener: (error: JCVitalV8ErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'sourceJournalOutcome', listener: (outcome: SourceJournalOutcome) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutState', listener: (session: JCVitalV8LiveWorkoutSession) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutPacket', listener: (packet: LiveWorkoutPacket) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutHeartRate', listener: (event: JCVitalV8WorkoutHeartRateEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutError', listener: (event: JCVitalV8WorkoutErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalWorkoutParseError', listener: (event: SerializableValue) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawEcgStatus', listener: (session: JCVitalV8RawEcgSession) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawEcgChunk', listener: (chunk: JCVitalV8RawEcgChunk) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawEcgError', listener: (error: JCVitalV8RawEcgErrorEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawPpgStatus', listener: (session: JCVitalV8RawPpgSession) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawPpgCertificationStatus', listener: (event: RawPpgPhysicalCertificationEvent) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawPpgChunk', listener: (chunk: JCVitalV8RawPpgChunk) => void): Promise<PluginListenerHandle>
  addListener(event: 'jcvitalRawPpgError', listener: (error: JCVitalV8RawPpgErrorEvent) => void): Promise<PluginListenerHandle>
  removeAllListeners(): Promise<void>
}

export const JCVitalV8 = registerPlugin<JCVitalV8Plugin>('JCVitalV8')
