import type { NativeObservationInput, TimestampTimezoneSource } from '../../services/base44/base44Types'
import { BLUETOOTH_MAC_PATTERN, isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import type { NativeObservation } from '../../models/wearableObservation'
import { sha256Hex } from './HeartRateSeries'
import { JCVITAL_NATIVE_SOURCE, WORKOUT_HR_TIMESTAMP_POLICY } from './WorkoutHrDelivery'

/** Build 5B-1 diagnostic groups; estimated BP covers both systolic and diastolic observations. */
export type PhysiologyMetricKey = 'heartRateHistory' | 'spo2' | 'wearableTemperature' | 'hrv' | 'stress' | 'estimatedBp' | 'ppi'

export const PHYSIOLOGY_METRIC_KEYS: readonly PhysiologyMetricKey[] = ['heartRateHistory', 'spo2', 'wearableTemperature', 'hrv', 'stress', 'estimatedBp', 'ppi']

export const PHYSIOLOGY_METRIC_LABELS: Record<PhysiologyMetricKey, string> = {
  heartRateHistory: 'Continuous HR history',
  spo2: 'SpO2',
  wearableTemperature: 'Wearable (skin) temperature',
  hrv: 'HRV (vendor)',
  stress: 'Stress (vendor)',
  estimatedBp: 'Estimated BP (vendor)',
  ppi: 'PPI (raw vendor)',
}

export const UNKNOWN_VENDOR_UNIT = 'UNKNOWN_VENDOR_UNIT'

export const HISTORICAL_TIMESTAMP_POLICY = {
  recordTime: { timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampConfidence: 'DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE' },
  continuousHrRecordTime: { timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampConfidence: 'DEVICE_RECORDED' },
  nominalOffset: { timestampSource: 'DEVICE_HISTORY_RECORD_TIME_PLUS_NOMINAL_INTERVAL', timestampConfidence: 'NOMINAL_INTERVAL_DERIVED' },
} as const

/** The V8 history `date` has no offset; the native normalizer parses it in the phone timezone. */
export const HISTORICAL_TIMESTAMP_TIMEZONE_SOURCE: TimestampTimezoneSource = 'PHONE_TIMEZONE'

export type CanonicalPolicy = 'CANONICAL' | 'NATIVE_ONLY'

export interface PhysiologyContract {
  key: PhysiologyMetricKey
  /** metricType emitted by the native JCVitalV8EventNormalizer. */
  nativeMetricType: string
  vendorDataType: string
  vendorField: string
  metric: string
  metricType: string
  unit: string
  measurementContext: string
  vendorDerived: boolean
  measurementMethod: string | null
  /** Target the Elite+ canonical layer should use; null means NativeObservation-only. */
  canonicalTarget: string | null
  canonicalPolicy: CanonicalPolicy
  timestampSourcePolicy: string
  samplingIntervalMs: number | null
  /** Values outside this predicate are "no measurement" placeholders and are not delivered. */
  deliverable: (value: number) => boolean
  extraMetadata: Record<string, string | number | boolean | null>
}

const positive = (value: number) => value > 0
const nonNegative = (value: number) => value >= 0

export const PHYSIOLOGY_CONTRACTS: readonly PhysiologyContract[] = [
  {
    key: 'heartRateHistory', nativeMetricType: 'HEART_RATE_CONTINUOUS', vendorDataType: '27', vendorField: 'arrayDynamicHR',
    metric: 'heartRate', metricType: 'HEART_RATE', unit: 'bpm', measurementContext: 'CONTINUOUS_HR_HISTORY', vendorDerived: false,
    measurementMethod: null, canonicalTarget: 'body.heart_rate', canonicalPolicy: 'CANONICAL',
    timestampSourcePolicy: 'record date for sample 0; record date + index × 5 s nominal offset for later samples',
    samplingIntervalMs: 5_000, deliverable: (value) => Number.isInteger(value) && value > 0 && value <= 250, extraMetadata: {},
  },
  {
    key: 'spo2', nativeMetricType: 'SPO2', vendorDataType: '68', vendorField: 'Blood_oxygen',
    metric: 'oxygenSaturation', metricType: 'SPO2', unit: 'percent', measurementContext: 'AUTOMATIC_SPO2_HISTORY', vendorDerived: false,
    measurementMethod: null, canonicalTarget: 'body.oxygen_saturation', canonicalPolicy: 'CANONICAL',
    timestampSourcePolicy: 'device history record date', samplingIntervalMs: null,
    deliverable: (value) => value > 0 && value <= 100, extraMetadata: { unitScale: 'PERCENT_0_100' },
  },
  {
    key: 'wearableTemperature', nativeMetricType: 'WEARABLE_TEMPERATURE', vendorDataType: '59', vendorField: 'temperature',
    metric: 'wearableTemperature', metricType: 'WEARABLE_TEMPERATURE', unit: 'celsius', measurementContext: 'WEARABLE_SKIN_TEMPERATURE_HISTORY', vendorDerived: false,
    measurementMethod: 'WEARABLE_SKIN_SENSOR', canonicalTarget: 'body.wearable_temperature', canonicalPolicy: 'CANONICAL',
    timestampSourcePolicy: 'device history record date', samplingIntervalMs: null,
    deliverable: positive, extraMetadata: { temperatureSite: 'WEARABLE_SKIN', coreBodyTemperature: false },
  },
  {
    key: 'hrv', nativeMetricType: 'HRV_VENDOR', vendorDataType: '42', vendorField: 'hrv',
    metric: 'hrvVendor', metricType: 'HRV_VENDOR', unit: UNKNOWN_VENDOR_UNIT, measurementContext: 'HRV_HISTORY', vendorDerived: true,
    measurementMethod: 'JCVITAL_VENDOR_ALGORITHM', canonicalTarget: null, canonicalPolicy: 'NATIVE_ONLY',
    timestampSourcePolicy: 'device history record date', samplingIntervalMs: null,
    deliverable: positive, extraMetadata: { vendorAlgorithm: 'JCVITAL_HRV', unitConfirmed: false },
  },
  {
    key: 'stress', nativeMetricType: 'STRESS_VENDOR', vendorDataType: '42', vendorField: 'stress',
    metric: 'stressVendor', metricType: 'STRESS_VENDOR', unit: UNKNOWN_VENDOR_UNIT, measurementContext: 'HRV_HISTORY', vendorDerived: true,
    measurementMethod: 'JCVITAL_VENDOR_ALGORITHM', canonicalTarget: null, canonicalPolicy: 'NATIVE_ONLY',
    timestampSourcePolicy: 'device history record date', samplingIntervalMs: null,
    deliverable: nonNegative, extraMetadata: { vendorAlgorithm: 'JCVITAL_STRESS', eliteStressScore: false, replacesEliteStress: false, scaleConfirmed: false },
  },
  {
    key: 'estimatedBp', nativeMetricType: 'BP_SYSTOLIC_ESTIMATED', vendorDataType: '42', vendorField: 'highBP',
    metric: 'bloodPressureSystolicEstimated', metricType: 'BP_SYSTOLIC_ESTIMATED', unit: UNKNOWN_VENDOR_UNIT, measurementContext: 'HRV_HISTORY', vendorDerived: true,
    measurementMethod: 'ESTIMATED_VENDOR_BP', canonicalTarget: null, canonicalPolicy: 'NATIVE_ONLY',
    timestampSourcePolicy: 'device history record date', samplingIntervalMs: null,
    deliverable: positive, extraMetadata: { bpComponent: 'SYSTOLIC', cuffMeasured: false, unitConfirmed: false },
  },
  {
    key: 'estimatedBp', nativeMetricType: 'BP_DIASTOLIC_ESTIMATED', vendorDataType: '42', vendorField: 'lowBP',
    metric: 'bloodPressureDiastolicEstimated', metricType: 'BP_DIASTOLIC_ESTIMATED', unit: UNKNOWN_VENDOR_UNIT, measurementContext: 'HRV_HISTORY', vendorDerived: true,
    measurementMethod: 'ESTIMATED_VENDOR_BP', canonicalTarget: null, canonicalPolicy: 'NATIVE_ONLY',
    timestampSourcePolicy: 'device history record date', samplingIntervalMs: null,
    deliverable: positive, extraMetadata: { bpComponent: 'DIASTOLIC', cuffMeasured: false, unitConfirmed: false },
  },
  {
    key: 'ppi', nativeMetricType: 'PPI', vendorDataType: '127', vendorField: 'ppiData',
    metric: 'ppiVendorRaw', metricType: 'PPI', unit: UNKNOWN_VENDOR_UNIT, measurementContext: 'PPI_HISTORY', vendorDerived: false,
    measurementMethod: null, canonicalTarget: null, canonicalPolicy: 'NATIVE_ONLY',
    timestampSourcePolicy: 'device history record date (group time; per-slot offsets unknown)', samplingIntervalMs: null,
    deliverable: (value) => Number.isInteger(value) && value >= 0, extraMetadata: { unitConfirmed: false },
  },
]

const contractByNativeType = new Map(PHYSIOLOGY_CONTRACTS.map((contract) => [`${contract.nativeMetricType}:${contract.vendorDataType}`, contract]))

export function findPhysiologyContract(observation: Pick<NativeObservation, 'metricType' | 'vendorDataType' | 'acquisitionMode'>): PhysiologyContract | null {
  if (observation.acquisitionMode !== 'HISTORICAL_SYNC') return null
  return contractByNativeType.get(`${observation.metricType}:${observation.vendorDataType}`) ?? null
}

export interface PhysiologySourceContext {
  /** Opaque jcvital_device_<uuid>; never the BLE MAC. */
  deviceId: string | null
  firmwareVersion: string | null
  sdkVersion: string | null
}

export type PhysiologyMappingOutcome =
  | { status: 'MAPPED'; key: PhysiologyMetricKey; observation: NativeObservationInput }
  | { status: 'NOT_DELIVERABLE' | 'INVALID'; key: PhysiologyMetricKey; reason: string }

function sourcePrefix(deviceId: string): string { return `${JCVITAL_NATIVE_SOURCE.sourceConnector}:${JCVITAL_NATIVE_SOURCE.deviceModel}:${deviceId}` }

export function buildPhysiologySourceRecordGroupId(deviceId: string, vendorDataType: string, vendorDate: string, groupSerial: string | null): string {
  return `${sourcePrefix(deviceId)}:${vendorDataType}:${vendorDate}${groupSerial !== null ? `|${groupSerial}` : ''}`
}

/** Value-free so a re-read of the same vendor slot always yields the same ID; '|' keeps HH:mm:ss from abutting numeric fields. */
export function buildPhysiologySourceRecordId(deviceId: string, metricType: string, vendorDataType: string, vendorDate: string, groupSerial: string | null, index: number): string {
  return `${sourcePrefix(deviceId)}:${metricType}:${vendorDataType}:${vendorDate}|${groupSerial ?? '-'}|${index}`
}

interface Slot { value: number; index: number; observedAt: string; timestamp: typeof HISTORICAL_TIMESTAMP_POLICY[keyof typeof HISTORICAL_TIMESTAMP_POLICY]; metadata: Record<string, string | number | boolean | null> }

function slotsFor(contract: PhysiologyContract, native: NativeObservation, observedAt: string): Slot[] | string {
  if (contract.key === 'ppi') {
    const values = (native.values ?? []).map(Number)
    if (!values.length || values.some((value) => !Number.isFinite(value))) return 'PPI group has no numeric values'
    let lastNonZero = -1
    values.forEach((value, index) => { if (value !== 0) lastNonZero = index })
    const nonZero = values.filter((value) => value !== 0).length
    return values.map((value, index) => ({
      value, index, observedAt, timestamp: HISTORICAL_TIMESTAMP_POLICY.recordTime,
      metadata: { ppiSlotIndex: index, ppiGroupSlotCount: values.length, ppiGroupNonZeroCount: nonZero, ppiZeroValue: value === 0, ppiTrailingZeroPaddingCandidate: value === 0 && index > lastNonZero },
    }))
  }
  const value = typeof native.value === 'number' ? native.value : Number.NaN
  if (!Number.isFinite(value)) return `${contract.vendorField} is missing or not numeric`
  const index = native.sequenceNumber ?? 0
  const timestamp = contract.key !== 'heartRateHistory' ? HISTORICAL_TIMESTAMP_POLICY.recordTime
    : index > 0 ? HISTORICAL_TIMESTAMP_POLICY.nominalOffset : HISTORICAL_TIMESTAMP_POLICY.continuousHrRecordTime
  return [{ value, index, observedAt, timestamp, metadata: {} }]
}

/** Maps one native historical observation to zero or more Base44 NativeObservationInput rows. */
export async function mapPhysiologyObservation(ownerUserId: string, native: NativeObservation, context: PhysiologySourceContext, contract = findPhysiologyContract(native)): Promise<PhysiologyMappingOutcome[]> {
  if (!contract) return []
  const invalid = (reason: string): PhysiologyMappingOutcome[] => [{ status: 'INVALID', key: contract.key, reason }]
  if (!isOpaqueJCVitalDeviceId(context.deviceId)) return invalid('opaque device ID unavailable')
  const vendorDate = native.observedAtSource
  if (!vendorDate || !native.observedAt || Number.isNaN(Date.parse(native.observedAt))) return invalid('historical record has no parseable source timestamp')
  const slots = slotsFor(contract, native, native.observedAt)
  if (typeof slots === 'string') return invalid(slots)
  const deviceId = context.deviceId
  const groupSerial = contract.key === 'ppi' ? native.packetId ?? null : null
  const sourceRecordGroupId = buildPhysiologySourceRecordGroupId(deviceId, contract.vendorDataType, vendorDate, groupSerial)
  const timezone = native.timezone || 'UTC'
  return Promise.all(slots.map(async (slot): Promise<PhysiologyMappingOutcome> => {
    if (!contract.deliverable(slot.value)) return { status: 'NOT_DELIVERABLE', key: contract.key, reason: `${contract.vendorField}=${slot.value} is a no-measurement placeholder` }
    const sourceRecordId = buildPhysiologySourceRecordId(deviceId, contract.metricType, contract.vendorDataType, vendorDate, groupSerial, slot.index)
    const observation: NativeObservationInput = {
      observationId: await sha256Hex(`${ownerUserId}:${sourceRecordId}`),
      source: JCVITAL_NATIVE_SOURCE.source,
      provider: JCVITAL_NATIVE_SOURCE.sourceProvider,
      metric: contract.metric,
      metricType: contract.metricType,
      valueNumber: slot.value,
      unit: contract.unit,
      startTime: slot.observedAt,
      capturedAt: native.receivedAt,
      timezone,
      sourceRecordId,
      sourceRecordGroupId,
      sourceId: deviceId,
      deviceId,
      deviceManufacturer: JCVITAL_NATIVE_SOURCE.deviceManufacturer,
      deviceModel: JCVITAL_NATIVE_SOURCE.deviceModel,
      sourceConnector: JCVITAL_NATIVE_SOURCE.sourceConnector,
      sourceProvider: JCVITAL_NATIVE_SOURCE.sourceProvider,
      sourcePath: JCVITAL_NATIVE_SOURCE.sourcePath,
      acquisitionMode: 'HISTORICAL_SYNC',
      measurementContext: contract.measurementContext,
      observedAt: slot.observedAt,
      observedAtSource: vendorDate,
      timestampSource: slot.timestamp.timestampSource,
      timestampConfidence: slot.timestamp.timestampConfidence,
      timestampTimezoneSource: HISTORICAL_TIMESTAMP_TIMEZONE_SOURCE,
      receivedAt: native.receivedAt,
      firmwareVersion: context.firmwareVersion ?? native.source.firmwareVersion,
      sdkVersion: context.sdkVersion ?? native.source.sdkVersion,
      vendorDataType: contract.vendorDataType,
      vendorField: contract.vendorField,
      vendorDerived: contract.vendorDerived,
      sequenceNumber: slot.index,
      ...(contract.measurementMethod ? { measurementMethod: contract.measurementMethod } : {}),
      ...(contract.samplingIntervalMs !== null ? { samplingIntervalMs: contract.samplingIntervalMs } : {}),
      rawSourceMetadata: {
        vendorDataType: contract.vendorDataType,
        vendorField: contract.vendorField,
        vendorDate,
        vendorGroupSerial: groupSerial,
        vendorDerived: contract.vendorDerived,
        canonicalPolicy: contract.canonicalPolicy,
        ...contract.extraMetadata,
        ...slot.metadata,
      },
    }
    const problems = validatePhysiologyObservation(observation)
    return problems.length ? { status: 'INVALID', key: contract.key, reason: problems.join('; ') } : { status: 'MAPPED', key: contract.key, observation }
  }))
}

/** Client-side preflight shared by every 5B-1 metric. */
export function validatePhysiologyObservation(observation: NativeObservationInput): string[] {
  const problems: string[] = []
  if (!/^[0-9a-f]{64}$/.test(observation.observationId)) problems.push('observationId must be a SHA-256 hex digest')
  if (observation.source !== JCVITAL_NATIVE_SOURCE.source || observation.sourceConnector !== JCVITAL_NATIVE_SOURCE.sourceConnector || observation.sourcePath !== JCVITAL_NATIVE_SOURCE.sourcePath) problems.push('source must be JCVITAL_NATIVE / DIRECT_BLE')
  if (!isOpaqueJCVitalDeviceId(observation.deviceId)) problems.push('deviceId must be an opaque jcvital_device_ ID')
  if (!Number.isFinite(observation.valueNumber)) problems.push('valueNumber must be finite')
  if (!observation.observedAt || Number.isNaN(Date.parse(observation.observedAt))) problems.push('observedAt must be an ISO timestamp')
  if (observation.timestampSource === WORKOUT_HR_TIMESTAMP_POLICY.timestampSource) problems.push('historical feeds must not use Connector receipt time')
  if (!observation.sourceRecordId || !observation.sourceRecordGroupId) problems.push('sourceRecordId and sourceRecordGroupId are required')
  if (BLUETOOTH_MAC_PATTERN.test(JSON.stringify(observation))) problems.push('payload must not contain a Bluetooth MAC address')
  return problems
}
