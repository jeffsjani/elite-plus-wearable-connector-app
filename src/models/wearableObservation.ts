import type { AcquisitionMode, CompletionStatus, MetricType } from './metricTaxonomy'

export type SourceConnector = 'JCVITAL_NATIVE' | 'HEALTH_CONNECT' | 'ROOK' | 'PHONE_NATIVE' | (string & {})
export type WearableProvider = 'JCVITAL' | (string & {})
export type ObservationValue = string | number | boolean | null
export type SerializableValue = ObservationValue | SerializableValue[] | { [key: string]: SerializableValue }

export interface WearableSource {
  connector: SourceConnector
  provider: WearableProvider
  deviceModel: string | null
  deviceId: string | null
  macAddress: string | null
  firmwareVersion: string | null
  sdkVersion: string | null
}

export interface ObservationProvenance {
  sourceRecordId?: string | null
  sourceConnector: SourceConnector
  provider: WearableProvider
  parserVersion?: string | null
  rawReference?: string | null
}

export interface NativeObservation {
  id: string
  source: WearableSource
  metricType: MetricType
  observedAt: string | null
  observedAtSource: string | null
  receivedAt: string
  timezone: string | null
  value: ObservationValue
  values: SerializableValue[] | null
  unit: string | null
  acquisitionMode: AcquisitionMode
  measurementContext: string | null
  sessionId: string | null
  packetId: string | null
  sequenceNumber: number | null
  samplingIntervalMs: number | null
  sampleRateHz: number | null
  signalQuality: SerializableValue | null
  completeness: CompletionStatus | null
  vendorDataType: string | null
  vendorField: string | null
  vendorDerived: boolean
  rawPayload: SerializableValue
  provenance: ObservationProvenance
}

export interface RawSignalChunk {
  signalType: MetricType
  deviceId: string | null
  sessionId: string
  packetId: string | null
  sequenceNumber: number | null
  startedAt: string | null
  receivedAt: string
  sampleRateHz: number | null
  sampleIntervalMs: number | null
  sampleFormat: string
  unit: string | null
  samples: number[]
  droppedPacketCount: number | null
  signalQuality: SerializableValue | null
  source: WearableSource
  firmwareVersion: string | null
  sdkVersion: string | null
}

export interface WorkoutSession {
  sessionId: string
  vendorActivityMode: number | null
  canonicalActivityType: string
  startedAt: string | null
  endedAt: string | null
  durationSeconds: number | null
  durationRaw: number | null
  heartRateSummary: number | null
  steps: number | null
  distanceMeters: number | null
  distanceRaw: number | null
  caloriesKcal: number | null
  caloriesRaw: number | null
  pace: string | null
  mets: number | null
  metsSupportStatus: 'EMITTED' | 'NOT_EMITTED_ANDROID'
  source: WearableSource
  rawVendorPayload: SerializableValue
}

export interface ActivityEpoch {
  startTime: string | null
  durationSeconds: number | null
  steps: number | null
  activityValue: number | null
  activityIntensity: number | null
  sourceValue: SerializableValue
  source: WearableSource
}

export type SleepStage = 'AWAKE' | 'LIGHT' | 'DEEP' | 'REM' | 'UNKNOWN'

export interface SleepEpoch {
  startTime: string | null
  durationSeconds: number | null
  stage: SleepStage
  movement: number | null
  sourceStageCode: number | string | null
  source: WearableSource
}

export interface SleepEpisode {
  sleepId: string
  startedAt: string | null
  endedAt: string | null
  totalSleepMinutes: number | null
  epochDurationSeconds: number | null
  stageEpochs: SleepEpoch[]
  movementEpochs: SleepEpoch[]
  source: WearableSource
  deviceId: string | null
  firmwareVersion: string | null
  rawVendorPayload: SerializableValue
}

export interface VendorDerivedObservation {
  metricType: MetricType
  value: ObservationValue
  unit: string | null
  vendorAlgorithm: string | null
  vendorScale: string | null
  observedAt: string | null
  receivedAt: string
  source: WearableSource
  confidence: number | null
  rawVendorPayload: SerializableValue
}

export interface SourceQuality {
  sourceConfidence: number | null
  dataCompleteness: number | null
  temporalResolution: number | null
  signalQuality: number | null
  deviceWearState: string | null
  measurementContext: string | null
  freshness: number | null
  directness: number | null
  agreementWithOtherSources: number | null
}

export interface CanonicalCandidate {
  metricType: MetricType
  value: ObservationValue
  unit: string | null
  observedAt: string | null
  sourceConnector: SourceConnector
  provider: WearableProvider
  deviceId: string | null
  sourceResolution: number | null
  samplingInterval: number | null
  confidence: number | null
  measurementContext: string | null
  rawReference: string
  quality: SourceQuality
}

export interface ObservationDeduplicationKey {
  metricType: MetricType
  observedAt: string | null
  sourceConnector: SourceConnector
  provider: WearableProvider
  deviceId: string | null
  sessionId: string | null
  sourceRecordId: string | null
  durationSeconds: number | null
  valueFingerprint: string
}

export interface FeedCompleteness {
  requestedFrom: string | null
  requestedTo: string | null
  earliestReturned: string | null
  latestReturned: string | null
  observationCount: number
  expectedCount: number | null
  duplicateCount: number
  invalidCount: number
  completionStatus: CompletionStatus
}

export interface WearableSyncSession {
  syncId: string
  deviceId: string | null
  provider: WearableProvider
  startedAt: string
  completedAt: string | null
  requestedDataTypes: MetricType[]
  recordsReceived: number
  recordsStored: number
  recordsDeduplicated: number
  recordsRejected: number
  earliestObservation: string | null
  latestObservation: string | null
  partial: boolean
  errors: Array<{ code: string; message: string; vendorDataType?: string | null }>
}