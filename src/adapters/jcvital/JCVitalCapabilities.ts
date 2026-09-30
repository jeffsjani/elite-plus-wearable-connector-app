// Build 7A capability model. See src/adapters/jcvital/README.md for the evidence trail
// behind every entry in this file. Nothing here may be upgraded to CONFIRMED_V8 without
// a citation to actual vendor SDK/firmware/OEM/physical-validation evidence.

export type CadenceSource =
  | 'SDK_DOCUMENTATION'
  | 'SDK_RUNTIME'
  | 'FIRMWARE'
  | 'OEM_CONFIRMATION'
  | 'PHYSICAL_VALIDATION'
  | 'MARKETING_CLAIM'
  | 'UNKNOWN'

export type CadenceConfidence = 'CONFIRMED' | 'STRONG_EVIDENCE' | 'UNVERIFIED'

/** Explicit, non-hardcoded workout-HR capability. Do not collapse this into a single `workoutHrInterval`. */
export interface WorkoutHrCapability {
  historicalSupported: boolean
  historicalCadencesMs: number[]
  preferredHistoricalCadenceMs?: number
  realtimeSupported: boolean
  realtimeCadenceMs?: number
  cadenceSource: CadenceSource
  confidence: CadenceConfidence
}

export type WorkoutHrCapabilityState =
  | 'STORED_HR_1S_CONFIRMED'
  | 'STORED_HR_5S_CONFIRMED'
  | 'STORED_HR_MULTI_RATE_CONFIRMED'
  | 'REALTIME_HR_1S_ONLY'
  | 'STORED_HR_CADENCE_UNKNOWN'
  | 'MARKETING_1S_CLAIM_UNVERIFIED'

/**
 * Evidence-backed default for Build 7A: documented/observed stored workout HR is 5-second
 * cadence (JStyle "dynamic HR" 15-sample blocks, see README evidence #2). 1-second stored
 * history is not yet confirmed for V8 firmware, so it is intentionally absent from
 * `historicalCadencesMs` until stronger evidence is found (see resolveWorkoutHrCapabilityState).
 */
export const DEFAULT_WORKOUT_HR_CAPABILITY: WorkoutHrCapability = {
  historicalSupported: true,
  historicalCadencesMs: [5000],
  preferredHistoricalCadenceMs: 5000,
  realtimeSupported: true,
  realtimeCadenceMs: 1000,
  cadenceSource: 'SDK_DOCUMENTATION',
  confidence: 'CONFIRMED',
}

/** Unverified marketing claim tracked separately; never merged into the default capability. */
export const MARKETING_STORED_HR_1S_CLAIM: WorkoutHrCapability = {
  historicalSupported: true,
  historicalCadencesMs: [1000],
  preferredHistoricalCadenceMs: 1000,
  realtimeSupported: true,
  realtimeCadenceMs: 1000,
  cadenceSource: 'MARKETING_CLAIM',
  confidence: 'UNVERIFIED',
}

/**
 * Derive the adaptive workout-HR capability state from a negotiated capability. This is the
 * only place cadence policy is decided; the rest of the adapter/UI must read this state instead
 * of branching on raw millisecond numbers.
 */
export function resolveWorkoutHrCapabilityState(capability: WorkoutHrCapability): WorkoutHrCapabilityState {
  const has1s = capability.historicalCadencesMs.includes(1000)
  const has5s = capability.historicalCadencesMs.includes(5000)
  const otherCadences = capability.historicalCadencesMs.some((ms) => ms !== 1000 && ms !== 5000)

  if (capability.historicalSupported && has1s && capability.cadenceSource === 'MARKETING_CLAIM' && capability.confidence === 'UNVERIFIED') {
    return 'MARKETING_1S_CLAIM_UNVERIFIED'
  }
  if (capability.historicalSupported && has1s && (has5s || otherCadences) && capability.confidence !== 'UNVERIFIED') {
    return 'STORED_HR_MULTI_RATE_CONFIRMED'
  }
  if (capability.historicalSupported && has1s && capability.confidence !== 'UNVERIFIED') {
    return 'STORED_HR_1S_CONFIRMED'
  }
  if (capability.historicalSupported && has5s && capability.confidence !== 'UNVERIFIED') {
    return 'STORED_HR_5S_CONFIRMED'
  }
  if (!capability.historicalSupported && capability.realtimeSupported && capability.realtimeCadenceMs === 1000) {
    return 'REALTIME_HR_1S_ONLY'
  }
  return 'STORED_HR_CADENCE_UNKNOWN'
}

export type CapabilityEvidenceLevel =
  | 'CONFIRMED_V8'
  | 'STRONG_SDK_EVIDENCE'
  | 'UNVERIFIED_V8'
  | 'MARKETING_CLAIM_UNVERIFIED'
  | 'EXPLICITLY_UNSUPPORTED'

export type JCVitalCapabilityKey =
  | 'STORED_HR_5S' | 'STORED_HR_1S' | 'AUTOMATIC_HR' | 'REALTIME_HR' | 'MANUAL_HR'
  | 'HRV_HISTORY' | 'PPI_HISTORY' | 'RAW_PPG' | 'RAW_ECG_WORKFLOW'
  | 'AUTOMATIC_SPO2' | 'MANUAL_SPO2' | 'TEMPERATURE_HISTORY'
  | 'SLEEP_STAGE_ARRAYS' | 'SLEEP_MOVEMENT_ARRAYS' | 'WORKOUT_SESSIONS' | 'METS'
  | 'BATTERY' | 'FIRMWARE_DEVICE_METADATA'
  | 'REALTIME_PPI' | 'REALTIME_RR' | 'ECG_DERIVED_SELECTED_VALUES'
  | 'GPS_ROUTE_HISTORY' | 'FATIGUE' | 'AXILLARY_TEMPERATURE' | 'ECG_INTERPRETATIONS' | 'CALIBRATION_DEPENDENT_BP'
  | 'VASCULAR_AGE' | 'BLOOD_GLUCOSE_PRODUCTION'

export interface CapabilityRecord {
  key: JCVitalCapabilityKey
  evidenceLevel: CapabilityEvidenceLevel
  notes: string
}

export type V8SupportStatus =
  | 'CONFIRMED_HARDWARE'
  | 'CONFIRMED_SDK'
  | 'PROVISIONAL'
  | 'UNDERDOCUMENTED'
  | 'VENDOR_DERIVED'
  | 'NOT_EMITTED_ANDROID'
  | 'UNSUPPORTED'
  | 'ODM_REQUIRED'

export interface V8Capability {
  capability: string
  supportStatus: V8SupportStatus
  acquisitionMode: string
  rawAvailable: boolean
  historicalAvailable: boolean
  realtimeAvailable: boolean
  resolution: string | null
  unit: string | null
  validationStatus: 'PASSED' | 'HARDWARE_REQUIRED' | 'DOCUMENTATION_REQUIRED' | 'NOT_APPLICABLE'
  nativeSdkAvailable: boolean
}

export const V8_CAPABILITY_REGISTRY: Record<string, V8Capability> = {
  LIVE_WORKOUT_HR: {
    capability: 'LIVE_WORKOUT_HR', supportStatus: 'CONFIRMED_HARDWARE', acquisitionMode: 'WORKOUT_REALTIME',
    rawAvailable: true, historicalAvailable: false, realtimeAvailable: true, resolution: 'approximately 1 second HR observations',
    unit: 'bpm', validationStatus: 'PASSED', nativeSdkAvailable: true,
  },
  CONTINUOUS_HR_HISTORY: {
    capability: 'CONTINUOUS_HR_HISTORY', supportStatus: 'CONFIRMED_HARDWARE', acquisitionMode: 'HISTORICAL_SYNC',
    rawAvailable: true, historicalAvailable: true, realtimeAvailable: false, resolution: '5 seconds observed',
    unit: 'bpm', validationStatus: 'PASSED', nativeSdkAvailable: true,
  },
  AUTOMATIC_HR: {
    capability: 'AUTOMATIC_HR', supportStatus: 'CONFIRMED_HARDWARE', acquisitionMode: 'AUTOMATIC',
    rawAvailable: true, historicalAvailable: true, realtimeAvailable: false, resolution: 'configurable schedule; validated at 10 minutes',
    unit: 'bpm', validationStatus: 'PASSED', nativeSdkAvailable: true,
  },
  HISTORICAL_SPO2: {
    capability: 'HISTORICAL_SPO2', supportStatus: 'CONFIRMED_SDK', acquisitionMode: 'HISTORICAL_SYNC',
    rawAvailable: true, historicalAvailable: true, realtimeAvailable: false, resolution: null,
    unit: 'percent', validationStatus: 'HARDWARE_REQUIRED', nativeSdkAvailable: true,
  },
  HISTORICAL_TEMPERATURE: {
    capability: 'HISTORICAL_TEMPERATURE', supportStatus: 'CONFIRMED_SDK', acquisitionMode: 'HISTORICAL_SYNC',
    rawAvailable: true, historicalAvailable: true, realtimeAvailable: false, resolution: null,
    unit: 'celsius', validationStatus: 'HARDWARE_REQUIRED', nativeSdkAvailable: true,
  },
  PPI: {
    capability: 'PPI', supportStatus: 'CONFIRMED_SDK', acquisitionMode: 'HISTORICAL_SYNC',
    rawAvailable: true, historicalAvailable: true, realtimeAvailable: true, resolution: null,
    unit: 'UNKNOWN_VENDOR_UNIT', validationStatus: 'HARDWARE_REQUIRED', nativeSdkAvailable: true,
  },
  RAW_PPG: {
    capability: 'RAW_PPG', supportStatus: 'CONFIRMED_SDK', acquisitionMode: 'PPG_SESSION',
    rawAvailable: true, historicalAvailable: false, realtimeAvailable: true, resolution: null,
    unit: 'UNKNOWN', validationStatus: 'HARDWARE_REQUIRED', nativeSdkAvailable: true,
  },
  RAW_ECG: {
    capability: 'RAW_ECG', supportStatus: 'CONFIRMED_SDK', acquisitionMode: 'ECG_SESSION',
    rawAvailable: true, historicalAvailable: true, realtimeAvailable: true, resolution: 'three-byte vendor samples',
    unit: 'UNKNOWN', validationStatus: 'HARDWARE_REQUIRED', nativeSdkAvailable: true,
  },
  RESPIRATORY_RATE_VENDOR: {
    capability: 'RESPIRATORY_RATE_VENDOR', supportStatus: 'UNDERDOCUMENTED', acquisitionMode: 'ECG_SESSION',
    rawAvailable: true, historicalAvailable: false, realtimeAvailable: true, resolution: null,
    unit: 'UNKNOWN', validationStatus: 'DOCUMENTATION_REQUIRED', nativeSdkAvailable: true,
  },
  MOOD_VENDOR: {
    capability: 'MOOD_VENDOR', supportStatus: 'UNDERDOCUMENTED', acquisitionMode: 'ECG_SESSION',
    rawAvailable: true, historicalAvailable: false, realtimeAvailable: true, resolution: null,
    unit: 'UNKNOWN', validationStatus: 'DOCUMENTATION_REQUIRED', nativeSdkAvailable: true,
  },
  VO2MAX_VENDOR: {
    capability: 'VO2MAX_VENDOR', supportStatus: 'VENDOR_DERIVED', acquisitionMode: 'HISTORICAL_SYNC',
    rawAvailable: false, historicalAvailable: false, realtimeAvailable: false, resolution: null,
    unit: null, validationStatus: 'NOT_APPLICABLE', nativeSdkAvailable: false,
  },
  RAW_ACCELEROMETER: {
    capability: 'RAW_ACCELEROMETER', supportStatus: 'ODM_REQUIRED', acquisitionMode: 'BACKGROUND',
    rawAvailable: false, historicalAvailable: false, realtimeAvailable: false, resolution: null,
    unit: null, validationStatus: 'DOCUMENTATION_REQUIRED', nativeSdkAvailable: false,
  },
  WORKOUT_METS: {
    capability: 'WORKOUT_METS', supportStatus: 'NOT_EMITTED_ANDROID', acquisitionMode: 'HISTORICAL_SYNC',
    rawAvailable: false, historicalAvailable: false, realtimeAvailable: false, resolution: null,
    unit: 'MET', validationStatus: 'NOT_APPLICABLE', nativeSdkAvailable: false,
  },
  WORKOUT_ELAPSED_SECONDS: {
    capability: 'WORKOUT_ELAPSED_SECONDS', supportStatus: 'CONFIRMED_HARDWARE', acquisitionMode: 'WORKOUT_REALTIME',
    rawAvailable: true, historicalAvailable: false, realtimeAvailable: true, resolution: '1 second elapsed-time increment observed',
    unit: 'second', validationStatus: 'PASSED', nativeSdkAvailable: true,
  },
}

/**
 * Capability registry. `evidenceLevel` reflects what has actually been inspected for Build 7A
 * (protocol-level secondary evidence from the vendor's published @moshenguo/ms-data-sdk 0.1.13
 * cross-platform wrapper, which lists "V8" as a supported DeviceType). No physical V8 device or
 * native Android AAR/source was available to inspect for this build; see README for the full
 * evidence trail and blockers.
 */
export const JCVitalCapabilityRegistry: Record<JCVitalCapabilityKey, CapabilityRecord> = {
  STORED_HR_5S: { key: 'STORED_HR_5S', evidenceLevel: 'CONFIRMED_V8', notes: 'GetDynamicHR / ArrayDynamicHR blocks: one BCD timestamp per 24-byte record containing 15 HR samples, consistent with 5s cadence (15 x 5s = 75s per block).' },
  STORED_HR_1S: { key: 'STORED_HR_1S', evidenceLevel: 'MARKETING_CLAIM_UNVERIFIED', notes: 'No SDK command, firmware field, or OEM confirmation found for 1-second stored workout HR. Tracked separately until evidence is found.' },
  AUTOMATIC_HR: { key: 'AUTOMATIC_HR', evidenceLevel: 'CONFIRMED_V8', notes: 'SetAutomaticHRMonitoring / GetAutomaticHRMonitoring commands present with schedule/type fields.' },
  REALTIME_HR: { key: 'REALTIME_HR', evidenceLevel: 'CONFIRMED_V8', notes: 'MeasurementHeartCallback / getOnceHeartData (GetStaticHR) present.' },
  MANUAL_HR: { key: 'MANUAL_HR', evidenceLevel: 'CONFIRMED_V8', notes: 'GetStaticHR / getOnceHeartData command present.' },
  HRV_HISTORY: { key: 'HRV_HISTORY', evidenceLevel: 'CONFIRMED_V8', notes: 'getHRVDataWithMode / GetHRVData command present.' },
  PPI_HISTORY: { key: 'PPI_HISTORY', evidenceLevel: 'CONFIRMED_V8', notes: 'getPPIDDataWithMode / GetPPIData command present.' },
  RAW_PPG: { key: 'RAW_PPG', evidenceLevel: 'CONFIRMED_V8', notes: 'CMD_Get_PPG_Waveform / getPPGWaveformData parser present.' },
  RAW_ECG_WORKFLOW: { key: 'RAW_ECG_WORKFLOW', evidenceLevel: 'CONFIRMED_V8', notes: 'ENTERECG / getEcgHistory / ecgResult commands present.' },
  AUTOMATIC_SPO2: { key: 'AUTOMATIC_SPO2', evidenceLevel: 'CONFIRMED_V8', notes: 'CMD_Get_Auto_Blood_oxygen / getAutoBloodOxygen present.' },
  MANUAL_SPO2: { key: 'MANUAL_SPO2', evidenceLevel: 'CONFIRMED_V8', notes: 'CMD_Get_Blood_oxygen / getBloodOxygen present.' },
  TEMPERATURE_HISTORY: { key: 'TEMPERATURE_HISTORY', evidenceLevel: 'CONFIRMED_V8', notes: 'Temperature_history / getTemperature_historyDataWithMode present.' },
  SLEEP_STAGE_ARRAYS: { key: 'SLEEP_STAGE_ARRAYS', evidenceLevel: 'CONFIRMED_V8', notes: 'CMD_Get_SleepData / getDetailSleepDataWithMode present.' },
  SLEEP_MOVEMENT_ARRAYS: { key: 'SLEEP_MOVEMENT_ARRAYS', evidenceLevel: 'CONFIRMED_V8', notes: 'CMD_Get_SleepActivityData / getSleepActivityLevelsData present.' },
  WORKOUT_SESSIONS: { key: 'WORKOUT_SESSIONS', evidenceLevel: 'CONFIRMED_V8', notes: 'EnterActivityMode / getActivityExerciseData present; measurementWithTypeV8 shows dedicated V8 handling.' },
  METS: { key: 'METS', evidenceLevel: 'EXPLICITLY_UNSUPPORTED', notes: 'The authoritative Android V8 getExerciseData parser does not emit METS. Phase 3B status: NOT_EMITTED_ANDROID; no replacement is calculated.' },
  BATTERY: { key: 'BATTERY', evidenceLevel: 'CONFIRMED_V8', notes: 'CMD_Get_BatteryLevel / getDeviceBatteryLevel present.' },
  FIRMWARE_DEVICE_METADATA: { key: 'FIRMWARE_DEVICE_METADATA', evidenceLevel: 'CONFIRMED_V8', notes: 'CMD_Get_Version / getDeviceVersion, CMD_Get_NewDeviceInfo present.' },
  REALTIME_PPI: { key: 'REALTIME_PPI', evidenceLevel: 'STRONG_SDK_EVIDENCE', notes: 'PPI history command confirmed; a dedicated realtime PPI callback was not directly isolated in the wrapper docs.' },
  REALTIME_RR: { key: 'REALTIME_RR', evidenceLevel: 'STRONG_SDK_EVIDENCE', notes: 'RR is derivable from PPI; no standalone realtime RR callback isolated in secondary evidence.' },
  ECG_DERIVED_SELECTED_VALUES: { key: 'ECG_DERIVED_SELECTED_VALUES', evidenceLevel: 'STRONG_SDK_EVIDENCE', notes: 'ECGHrvValue/ECGHrValue/ECGStreesValue/ECGBreathValue keys present in device key table.' },
  GPS_ROUTE_HISTORY: { key: 'GPS_ROUTE_HISTORY', evidenceLevel: 'UNVERIFIED_V8', notes: 'GPSControlCommand / getHistoryGpsData present in generic constants; not confirmed as a V8 capability specifically.' },
  FATIGUE: { key: 'FATIGUE', evidenceLevel: 'UNVERIFIED_V8', notes: 'No fatigue-specific command found in inspected evidence.' },
  AXILLARY_TEMPERATURE: { key: 'AXILLARY_TEMPERATURE', evidenceLevel: 'UNVERIFIED_V8', notes: 'GetAxillaryTemperatureDataWithMode present generically; not confirmed for V8.' },
  ECG_INTERPRETATIONS: { key: 'ECG_INTERPRETATIONS', evidenceLevel: 'UNVERIFIED_V8', notes: 'Raw ECG workflow confirmed; clinical-grade interpretation claims are not confirmed.' },
  CALIBRATION_DEPENDENT_BP: { key: 'CALIBRATION_DEPENDENT_BP', evidenceLevel: 'UNVERIFIED_V8', notes: 'highBP/lowBP keys exist inside HRV-derived data; calibration workflow not confirmed for V8.' },
  VASCULAR_AGE: { key: 'VASCULAR_AGE', evidenceLevel: 'EXPLICITLY_UNSUPPORTED', notes: 'VascularAging key exists in generic constants but is held per Build 7A policy pending OEM confirmation.' },
  BLOOD_GLUCOSE_PRODUCTION: { key: 'BLOOD_GLUCOSE_PRODUCTION', evidenceLevel: 'EXPLICITLY_UNSUPPORTED', notes: 'BloodsugarWithMode command exists but blood glucose is held as production data pending written OEM confirmation.' },
}
