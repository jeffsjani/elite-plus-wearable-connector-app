export type V8SdkExposure =
  | 'EXPOSED_BY_CURRENT_SDK'
  | 'NOT_EXPOSED_BY_CURRENT_SDK'
  | 'BLOCKED_VENDOR_DEPENDENCY'

export type V8SourcePreservation =
  | 'LOSSLESS_CERTIFIED'
  | 'LOSSLESS_IMPLEMENTED_NOT_PHYSICALLY_CERTIFIED'
  | 'PARTIAL_SOURCE_PRESERVATION'
  | 'NOT_CAPTURED'

export type V8CoverageDisposition =
  | 'CANONICAL_PRODUCTION'
  | 'SOURCE_ONLY_VALIDATED'
  | 'BLOCKED_VENDOR_DEPENDENCY'
  | 'PENDING_SEMANTIC_VALIDATION'
  | 'PENDING_PHYSICAL_CERTIFICATION'

export interface V8DataCoverageEntry {
  vendorDataType: string | null
  vendorField: string
  elitePlusSourceMetric: string
  acquisitionSupport: string
  sdkExposure: V8SdkExposure
  sourcePreservation: V8SourcePreservation
  sourceCertification: string
  unit: string
  unitConfidence: string
  timestampSemantics: string
  timestampConfidence: string
  semanticClassification: string
  canonicalTarget: string | null
  canonicalEligibility: string
  canonicalAuthority: string
  bodyEligibility: boolean
  sleepEligibility: boolean
  activityEligibility: boolean
  workoutEligibility: boolean
  readinessEligibility: boolean
  scoringEligibility: boolean
  provenanceRequirements: readonly string[]
  knownLimitations: readonly string[]
  evidenceReferences: readonly string[]
  finalDisposition: V8CoverageDisposition
}

type EntryInput = Pick<V8DataCoverageEntry, 'vendorDataType' | 'vendorField' | 'elitePlusSourceMetric'> & {
  sdkExposure?: V8SdkExposure
  sourcePreservation?: V8SourcePreservation
  sourceCertification?: string
  unit?: string
  unitConfidence?: string
  timestampSemantics?: string
  timestampConfidence?: string
  semanticClassification?: string
  canonicalTarget?: string | null
  canonicalEligibility?: string
  canonicalAuthority?: string
  eligibility?: 'body' | 'sleep' | 'activity' | 'workout' | null
  additionalEligibility?: readonly ('body' | 'sleep' | 'activity' | 'workout')[]
  provenanceRequirements?: readonly string[]
  knownLimitations?: readonly string[]
  evidenceReferences?: readonly string[]
  finalDisposition?: V8CoverageDisposition
}

const RAW_EVIDENCE = 'JCVitalV8SourceJournal.appendCallback / JCVitalV8SourceSnapshot'
const NORMALIZER = 'JCVitalV8EventNormalizer'

function sourcePreservationFor(dataType: string | null): V8SourcePreservation {
  if (['24', '25', '26', '29', '42', '119', '121', '127'].includes(dataType ?? '')) return 'LOSSLESS_CERTIFIED'
  return 'LOSSLESS_IMPLEMENTED_NOT_PHYSICALLY_CERTIFIED'
}

function sourceCertificationFor(dataType: string | null): string {
  const certification: Record<string, string> = {
    '24': 'CERTIFIED_E2E_LOSSLESS_SOURCE (VC29 capability registry)',
    '25': 'CERTIFIED_E2E_LOSSLESS_SOURCE (VC29 capability registry)',
    '26': 'CERTIFIED_E2E_LOSSLESS_SOURCE (VC29 capability registry)',
    '29': 'CERTIFIED_E2E_LOSSLESS_SOURCE; retain 26-byte physical decoder (VC29 capability registry)',
    '42': 'CERTIFIED_LOSSLESS_SOURCE (VC29 capability registry)',
    '119': 'CERTIFIED_E2E_LOSSLESS_SOURCE (VC29 capability registry)',
    '121': 'CERTIFIED_E2E_LOSSLESS_SOURCE (VC29 capability registry)',
    '127': 'CERTIFIED_LOSSLESS_SOURCE (VC29 capability registry)',
  }
  if (dataType && certification[dataType]) return certification[dataType]
  if (dataType === '27') return 'CERTIFIED_PHYSICAL_SOURCE; source-envelope losslessness is implemented, physical source-envelope certification pending'
  if (dataType === '82') return 'PHYSICALLY_VALIDATED_APPROX_1_HZ; source-envelope losslessness is implemented, physical source-envelope certification pending'
  if (dataType === '68' || dataType === '59') return 'CERTIFIED_E2E; source-envelope losslessness is implemented, physical source-envelope certification pending'
  return 'IMPLEMENTED; PHYSICAL CERTIFICATION NOT ESTABLISHED BY THIS REPORT'
}

function entry(input: EntryInput): V8DataCoverageEntry {
  const canonical = input.canonicalTarget !== undefined && input.canonicalTarget !== null
  const blocked = input.sdkExposure === 'BLOCKED_VENDOR_DEPENDENCY'
  return {
    vendorDataType: input.vendorDataType,
    vendorField: input.vendorField,
    elitePlusSourceMetric: input.elitePlusSourceMetric,
    acquisitionSupport: blocked ? 'NO_ACQUISITION_ALLOWED' : input.sdkExposure === 'NOT_EXPOSED_BY_CURRENT_SDK'
      ? 'NO_CURRENT_SDK_ACQUISITION' : 'CURRENT_SDK_OR_CALLBACK_PATH',
    sdkExposure: input.sdkExposure ?? 'EXPOSED_BY_CURRENT_SDK',
    sourcePreservation: input.sourcePreservation ?? (blocked
      ? 'NOT_CAPTURED'
      : input.sdkExposure === 'NOT_EXPOSED_BY_CURRENT_SDK' ? 'NOT_CAPTURED' : sourcePreservationFor(input.vendorDataType)),
    sourceCertification: input.sourceCertification ?? (blocked ? 'BLOCKED_VENDOR_DEPENDENCY' : sourceCertificationFor(input.vendorDataType)),
    unit: input.unit ?? 'UNKNOWN_VENDOR_UNIT',
    unitConfidence: input.unitConfidence ?? 'UNCONFIRMED',
    timestampSemantics: input.timestampSemantics ?? 'Original SDK callback/record timestamp retained; metric instant not qualified',
    timestampConfidence: input.timestampConfidence ?? 'UNCONFIRMED',
    semanticClassification: input.semanticClassification ?? 'Vendor field preserved; measurement meaning not fully qualified',
    canonicalTarget: input.canonicalTarget ?? null,
    canonicalEligibility: canonical ? 'EXISTING_AUTHORIZED_PATH_UNCHANGED' : input.canonicalEligibility ?? 'NOT_ELIGIBLE',
    canonicalAuthority: canonical ? 'JCVITAL_NATIVE; existing source authority unchanged' : 'NONE',
    bodyEligibility: input.eligibility === 'body' || input.additionalEligibility?.includes('body') === true,
    sleepEligibility: input.eligibility === 'sleep' || input.additionalEligibility?.includes('sleep') === true,
    activityEligibility: input.eligibility === 'activity' || input.additionalEligibility?.includes('activity') === true,
    workoutEligibility: input.eligibility === 'workout' || input.additionalEligibility?.includes('workout') === true,
    readinessEligibility: false,
    scoringEligibility: false,
    provenanceRequirements: input.provenanceRequirements ?? [
      'JCVITAL_NATIVE',
      'vendorDataType',
      'sourceRecordId',
      'sourceRecordGroupId when available',
      'deviceScopeId',
      'firmware and SDK version',
      'parser/decoder version',
      'source and receipt timestamps',
      'timestamp policy',
      'semantic version',
      'acquisition/session ID when available',
    ],
    knownLimitations: input.knownLimitations ?? [],
    evidenceReferences: input.evidenceReferences ?? [
      RAW_EVIDENCE, NORMALIZER, 'SourceCapabilityRegistry current-tree VC29 entry',
    ],
    finalDisposition: input.finalDisposition ?? (blocked
      ? 'BLOCKED_VENDOR_DEPENDENCY'
      : canonical ? 'CANONICAL_PRODUCTION' : 'PENDING_SEMANTIC_VALIDATION'),
  }
}

const type27 = (field: string, metric: string, unit: string, canonicalTarget?: string) => entry({
  vendorDataType: '27', vendorField: field, elitePlusSourceMetric: metric, unit,
  unitConfidence: unit === 'bpm' ? 'VENDOR_FIELD_AND_EXISTING_CONTRACT' : 'UNCONFIRMED',
  timestampSemantics: field === 'date'
    ? 'Device-local history record timestamp'
    : 'Sample 0 uses record date; later samples use nominal 5-second offsets',
  timestampConfidence: field === 'date' ? 'DEVICE_RECORDED_LOCAL_TIME' : 'NOMINAL_INTERVAL_DERIVED',
  semanticClassification: field === 'date' ? 'HISTORY_RECORD_TIMESTAMP' : 'HISTORICAL_CONTINUOUS_HEART_RATE',
  canonicalTarget, eligibility: canonicalTarget ? 'body' : null,
  finalDisposition: canonicalTarget ? 'CANONICAL_PRODUCTION' : 'SOURCE_ONLY_VALIDATED',
  knownLimitations: field === 'arrayDynamicHR'
    ? ['Sample offset is nominal; the source record time has no timezone offset.']
    : [],
})

const type42 = (field: string, metric: string, unit = 'UNKNOWN_VENDOR_UNIT', overrides: Partial<EntryInput> = {}) =>
  entry({
    vendorDataType: '42', vendorField: field, elitePlusSourceMetric: metric, unit,
    timestampSemantics: field === 'date' ? 'Device-local Type 42 record time' : 'Type 42 record time; no per-field timestamp',
    timestampConfidence: field === 'date' ? 'DEVICE_RECORDED_LOCAL_TIME' : 'INHERITED_FROM_RECORD',
    semanticClassification: field === 'heartRate' ? 'EMBEDDED_HEART_RATE; duplicate/source policy unapproved'
      : field === 'hrv' ? 'VENDOR_HRV; computation definition and unit unproven'
        : field === 'stress' ? 'DEVICE_DERIVED_STRESS; scale and meaning unproven'
          : field === 'highBP' || field === 'lowBP' ? 'ESTIMATED_VENDOR_BLOOD_PRESSURE; not clinically measured'
            : field === 'vascularAging' ? 'VENDOR_VASCULAR_AGING; not chronological age'
              : field === 'fatigueDegree' ? 'VENDOR_FATIGUE; scale and meaning unproven'
                : field === 'date' ? 'SOURCE_RECORD_TIMESTAMP' : 'OPAQUE_VENDOR_FIELD',
    canonicalEligibility: field === 'hrv' || field === 'heartRate' ? 'PENDING_SEMANTIC_VALIDATION' : 'NOT_ELIGIBLE',
    finalDisposition: 'SOURCE_ONLY_VALIDATED',
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'Type42Certification.FIELDS'],
    knownLimitations: field === 'highBP' || field === 'lowBP'
      ? ['Estimated values must never be represented as clinically measured blood pressure.']
      : field === 'vascularAging' ? ['Must not be presented as chronological age.']
        : field === 'hrv' ? ['No verified unit, algorithm definition, cadence, or Elite+ HRV compatibility.']
          : field === 'heartRate' ? ['Not canonical-eligible until duplicate/source-policy validation against Type 27/82.']
            : [],
    ...overrides,
  })

const activity = (type: '24' | '25', field: string, metric: string, unit = 'UNKNOWN_VENDOR_UNIT') => entry({
  vendorDataType: type, vendorField: field, elitePlusSourceMetric: metric, unit,
  unitConfidence: unit === 'count' || unit === 'minute' ? 'FIELD_AND_SDK_SAMPLE_LABEL' : 'UNCONFIRMED',
  timestampSemantics: field === 'date'
    ? 'Device-local activity record date; day boundary/reset policy unproven'
    : type === '25' && field === 'arraySteps'
      ? 'Record start plus nominal one-minute index; timezone interpreted by phone'
      : 'Summary or detail-block record timestamp; interval policy unproven',
  timestampConfidence: field === 'date' ? 'DEVICE_RECORDED_LOCAL_TIME' : 'UNCONFIRMED',
  semanticClassification: field === 'ExerciseMinutes'
    ? 'EXERCISE_MINUTES; exact vendor semantics not established'
    : field === 'arraySteps' ? 'DETAILED_ACTIVITY_STEP_EPOCHS'
      : field === 'step' || field === 'detailMinterStep' ? 'STEP_COUNT; summary reconciliation pending'
        : 'ACTIVITY_SOURCE_FIELD; summary/epoch reconciliation pending',
  eligibility: 'activity',
  canonicalEligibility: ['step', 'detailMinterStep', 'distance', 'calories'].includes(field)
    ? 'PENDING_SEMANTIC_VALIDATION' : 'NOT_ELIGIBLE',
  finalDisposition: 'PENDING_SEMANTIC_VALIDATION',
  knownLimitations: [
    'Type 24/25 overlap and daily-window/reset boundary are not yet qualified.',
    'Do not double count daily summary and detailed epochs.',
    'No canonical target is declared until Type 25 epoch sums reconcile with Type 24 totals.',
  ],
  evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'Activity24_25Certification'],
})

const sleep = (type: '26' | '121', field: string, metric: string, unit = 'UNKNOWN_VENDOR_UNIT') => entry({
  vendorDataType: type, vendorField: field, elitePlusSourceMetric: metric, unit,
  timestampSemantics: field === 'date'
    ? 'Device-local sleep record timestamp; episode boundary semantics pending'
    : 'Source array/length retained in original record order; interval/alignment semantics pending',
  timestampConfidence: field === 'date' ? 'DEVICE_RECORDED_LOCAL_TIME' : 'UNCONFIRMED',
  semanticClassification: field === 'arraySleepQuality' || field === 'Sleep_level'
    ? 'RAW_SLEEP_STAGE_CODES; vendor code meanings not approved'
    : field === 'ActivityData' ? 'RAW_SLEEP_MOVEMENT_OR_ACTIVITY_CODES; meaning/alignment unproven'
      : field === 'sleepUnitLength' ? 'VENDOR_SLEEP_UNIT_LENGTH; interpretation pending'
        : field === 'sleepLength' ? 'VENDOR_SLEEP_LENGTH; unit and episode semantics pending'
          : 'SLEEP_SOURCE_RECORD_TIMESTAMP',
  eligibility: 'sleep',
  canonicalEligibility: field === 'sleepLength' || field === 'sleepUnitLength'
    ? 'PENDING_SEMANTIC_VALIDATION' : 'NOT_ELIGIBLE',
  finalDisposition: field === 'arraySleepQuality' || field === 'Sleep_level' || field === 'ActivityData'
    ? 'SOURCE_ONLY_VALIDATED' : 'PENDING_SEMANTIC_VALIDATION',
  knownLimitations: field === 'arraySleepQuality' || field === 'Sleep_level'
    ? ['Numeric stage codes must not map to Elite+ stages without approved vendor semantics.']
    : ['Start/end, total duration, awake/light/deep/REM and movement semantics remain independently unqualified.'],
  evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'SleepCertification'],
})

const workout = (field: string, metric: string, unit = 'UNKNOWN_VENDOR_UNIT') => entry({
  vendorDataType: '29', vendorField: field, elitePlusSourceMetric: metric, unit,
  unitConfidence: unit === 'bpm' || unit === 'count' ? 'FIELD_AND_SDK_SAMPLE_LABEL' : 'UNCONFIRMED',
  timestampSemantics: field === 'date' ? 'Device-local workout history record timestamp' : 'Inherited Type 29 record timestamp',
  timestampConfidence: field === 'date' ? 'DEVICE_RECORDED_LOCAL_TIME' : 'INHERITED_FROM_RECORD_UNQUALIFIED',
  semanticClassification: field === 'sportModel' ? 'VENDOR_WORKOUT_MODE; mapping not approved'
    : field === 'ExerciseTime' ? 'WORKOUT_DURATION_FIELD; unit not qualified'
      : field === 'heartRate' ? 'WORKOUT_HISTORY_HEART_RATE'
        : field === 'date' ? 'WORKOUT_HISTORY_RECORD_TIMESTAMP' : 'WORKOUT_HISTORY_SOURCE_FIELD',
  eligibility: 'workout',
  canonicalEligibility: ['ExerciseTime', 'heartRate', 'step', 'sportModelSpeed', 'distance', 'calories'].includes(field)
    ? 'PENDING_SEMANTIC_VALIDATION' : 'NOT_ELIGIBLE',
  finalDisposition: 'PENDING_SEMANTIC_VALIDATION',
  knownLimitations: [
    'Type 29 26-byte physical decoder remains authoritative; do not use the SDK multi-record parser with its documented stride defect.',
    'Type 29 ↔ Type 82 session linkage, workout identity, mode, units, and interval semantics are not established.',
    'METS must not be fabricated.',
  ],
  evidenceReferences: [RAW_EVIDENCE, 'JCVitalV8WorkoutHistorySource', 'JCVitalV8WorkoutNormalizer', 'WorkoutHistoryCertification'],
})

const realtime = (type: '23' | '74', field: string, metric: string, unit = 'UNKNOWN_VENDOR_UNIT') => entry({
  vendorDataType: type, vendorField: field, elitePlusSourceMetric: metric, unit,
  unitConfidence: unit === 'bpm' || unit === 'count' ? 'SDK_FIELD_LABEL; PHYSICAL_SEMANTICS_PENDING' : 'UNCONFIRMED',
  timestampSemantics: 'Phone BLE receipt time; no device measurement timestamp established',
  timestampConfidence: 'PHONE_RECEIPT_TIME',
  semanticClassification: field === 'heartRate' ? 'REALTIME_HEART_RATE_CALLBACK'
    : field === 'TempData' ? 'REALTIME_WEARABLE_TEMPERATURE_FIELD'
      : 'REALTIME_ACTIVITY_CALLBACK_FIELD',
  finalDisposition: 'PENDING_SEMANTIC_VALIDATION',
  knownLimitations: ['Preserved as complete callback source; no new canonical mapping or scoring authority is granted.'],
  evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'Shipped android/app/libs/v8sdk2.0.jar'],
})

export const V8DataCoverageRegistry: readonly V8DataCoverageEntry[] = [
  type27('date', 'HEART_RATE_HISTORY_TIMESTAMP', 'vendor_local_timestamp'),
  type27('arrayDynamicHR', 'HEART_RATE_CONTINUOUS', 'bpm', 'body.heart_rate'),
  realtime('23', 'step', 'REALTIME_STEPS', 'count'),
  realtime('23', 'calories', 'REALTIME_CALORIES'),
  realtime('23', 'distance', 'REALTIME_DISTANCE'),
  realtime('23', 'exerciseMinutes', 'REALTIME_EXERCISE_MINUTES', 'minute'),
  realtime('23', 'ExerciseTime', 'REALTIME_ACTIVE_TIME', 'vendor_minute_or_second'),
  realtime('23', 'heartRate', 'REALTIME_HEART_RATE', 'bpm'),
  realtime('23', 'TempData', 'REALTIME_TEMPERATURE'),
  realtime('74', 'heartRate', 'MEASUREMENT_HEART_RATE', 'bpm'),
  entry({
    vendorDataType: '82', vendorField: 'heartRate', elitePlusSourceMetric: 'HEART_RATE_WORKOUT',
    unit: 'bpm', unitConfidence: 'EXISTING_LIVE_HR_CONTRACT', timestampSemantics: 'Phone BLE receipt time; no device timestamp',
    timestampConfidence: 'PHYSICALLY_VALIDATED_RECEIPT_TIME', semanticClassification: 'LIVE_WORKOUT_HEART_RATE',
    canonicalTarget: 'body.heart_rate', eligibility: 'body', additionalEligibility: ['workout'],
    finalDisposition: 'CANONICAL_PRODUCTION',
    sourceCertification: 'Existing live Type 82 HR path; no behavior change in P1-2A',
    evidenceReferences: [RAW_EVIDENCE, 'JCVitalV8WorkoutSession', 'WorkoutHrDelivery'],
    knownLimitations: ['Do not claim Type 82 belongs to a Type 29 session without demonstrated linkage.'],
  }),
  entry({
    vendorDataType: '82', vendorField: 'ExerciseTime', elitePlusSourceMetric: 'WORKOUT_ELAPSED_SECONDS',
    unit: 'second', unitConfidence: 'CURRENT_NORMALIZER_ASSERTION; PHYSICAL CERTIFICATION PENDING',
    timestampSemantics: 'Monotonic live workout elapsed counter at BLE receipt',
    timestampConfidence: 'RECEIPT_TIME_AND_SESSION_COUNTER',
    semanticClassification: 'LIVE_WORKOUT_ELAPSED_TIME', eligibility: 'workout',
    finalDisposition: 'PENDING_PHYSICAL_CERTIFICATION',
    knownLimitations: ['Validate reset, pause/resume and interval semantics before promotion.'],
    evidenceReferences: [RAW_EVIDENCE, 'JCVitalV8WorkoutNormalizer'],
  }),
  entry({
    vendorDataType: '82', vendorField: 'step', elitePlusSourceMetric: 'WORKOUT_LIVE_STEPS',
    unit: 'count', unitConfidence: 'SDK_FIELD_LABEL; PHYSICAL SEMANTICS PENDING',
    timestampSemantics: 'Live Type 82 callback receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'LIVE_WORKOUT_STEP_COUNTER', eligibility: 'workout',
    canonicalEligibility: 'PENDING_SEMANTIC_VALIDATION', finalDisposition: 'PENDING_SEMANTIC_VALIDATION',
    knownLimitations: ['Workout identity, reset/pause semantics and relation to Type 29 are unproven.'],
    evidenceReferences: [RAW_EVIDENCE, 'JCVitalV8WorkoutNormalizer'],
  }),
  entry({
    vendorDataType: '82', vendorField: 'calories', elitePlusSourceMetric: 'WORKOUT_LIVE_CALORIES',
    unit: 'UNKNOWN_VENDOR_UNIT', unitConfidence: 'UNCONFIRMED',
    timestampSemantics: 'Live Type 82 callback receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'LIVE_WORKOUT_CALORIES', eligibility: 'workout',
    canonicalEligibility: 'PENDING_SEMANTIC_VALIDATION', finalDisposition: 'PENDING_SEMANTIC_VALIDATION',
    knownLimitations: ['Calorie unit/meaning, reset semantics and relation to Type 29 are unproven.'],
    evidenceReferences: [RAW_EVIDENCE, 'JCVitalV8WorkoutNormalizer'],
  }),
  entry({
    vendorDataType: '68', vendorField: 'Blood_oxygen', elitePlusSourceMetric: 'SPO2',
    unit: 'percent', unitConfidence: 'EXISTING_CANONICAL_CONTRACT; 0-100',
    timestampSemantics: 'Device-local automatic SpO2 history record time',
    timestampConfidence: 'DEVICE_RECORDED_LOCAL_TIME',
    semanticClassification: 'OXYGEN_SATURATION', canonicalTarget: 'body.oxygen_saturation',
    eligibility: 'body', finalDisposition: 'CANONICAL_PRODUCTION',
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'PhysiologyContract.spo2'],
  }),
  entry({
    vendorDataType: '59', vendorField: 'temperature', elitePlusSourceMetric: 'WEARABLE_TEMPERATURE',
    unit: 'celsius', unitConfidence: 'EXISTING_CANONICAL_CONTRACT',
    timestampSemantics: 'Device-local wearable temperature history record time',
    timestampConfidence: 'DEVICE_RECORDED_LOCAL_TIME',
    semanticClassification: 'WEARABLE_SKIN_TEMPERATURE', canonicalTarget: 'body.wearable_temperature',
    canonicalAuthority: 'JCVITAL_NATIVE; skin-sensor only',
    eligibility: 'body', finalDisposition: 'CANONICAL_PRODUCTION',
    knownLimitations: ['Not core, clinical, or fever body temperature.'],
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'PhysiologyContract.wearableTemperature'],
  }),
  type42('date', 'TYPE42_RECORD_TIMESTAMP', 'vendor_local_timestamp'),
  type42('hrv', 'HRV_VENDOR'),
  type42('heartRate', 'HEART_RATE_AUTOMATIC', 'bpm'),
  type42('stress', 'STRESS_VENDOR'),
  type42('highBP', 'BP_SYSTOLIC_ESTIMATED'),
  type42('lowBP', 'BP_DIASTOLIC_ESTIMATED'),
  type42('fatigueDegree', 'FATIGUE_VENDOR'),
  type42('vascularAging', 'VASCULAR_AGING_VENDOR'),
  entry({
    vendorDataType: '42', vendorField: 'respiratoryRate', elitePlusSourceMetric: 'RESPIRATORY_RATE_VENDOR',
    sdkExposure: 'NOT_EXPOSED_BY_CURRENT_SDK', sourcePreservation: 'NOT_CAPTURED',
    sourceCertification: 'No matching Type 42 field is exposed by the shipped parser',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY',
    knownLimitations: ['Current shipped SDK callback has no verified respiratory-rate field.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', NORMALIZER],
  }),
  entry({
    vendorDataType: '42', vendorField: 'mood', elitePlusSourceMetric: 'MOOD_VENDOR',
    sdkExposure: 'NOT_EXPOSED_BY_CURRENT_SDK', sourcePreservation: 'NOT_CAPTURED',
    sourceCertification: 'No Type 42 mood field is exposed by the current parser',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY',
    knownLimitations: ['ECGMoodValue is an ECG-related key, not an established Type 42 mood signal.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', NORMALIZER],
  }),
  entry({
    vendorDataType: 'ECG', vendorField: 'ECGMoodValue', elitePlusSourceMetric: 'ECG_MOOD_VENDOR',
    sdkExposure: 'BLOCKED_VENDOR_DEPENDENCY', sourcePreservation: 'NOT_CAPTURED',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY', unit: 'vendor_score',
    timestampSemantics: 'Unavailable; no permitted ECG acquisition',
    semanticClassification: 'ECG_DERIVED_VENDOR_MOOD',
    knownLimitations: ['No physical ECG build or additional acquisition attempts in P1-2A.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', 'ECG vendor dependency blocker'],
  }),
  entry({
    vendorDataType: 'ECG', vendorField: 'ECGBreathValue', elitePlusSourceMetric: 'ECG_BREATHING_RATE_VENDOR',
    sdkExposure: 'BLOCKED_VENDOR_DEPENDENCY', sourcePreservation: 'NOT_CAPTURED',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY', unit: 'vendor_score',
    timestampSemantics: 'Unavailable; no permitted ECG acquisition',
    semanticClassification: 'ECG_DERIVED_VENDOR_BREATHING_SIGNAL',
    knownLimitations: ['Not an independently validated respiratory-rate measurement.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', 'ECG vendor dependency blocker'],
  }),
  entry({
    vendorDataType: '127', vendorField: 'ppiData', elitePlusSourceMetric: 'PPI',
    unit: 'UNKNOWN_VENDOR_UNIT', unitConfidence: 'UNCONFIRMED',
    timestampSemantics: 'Type 127 group timestamp; per-slot timestamps/offsets unknown',
    timestampConfidence: 'GROUP_TIMESTAMP_ONLY',
    semanticClassification: 'PULSE_TO_PULSE_INTERVAL_ARRAY',
    finalDisposition: 'SOURCE_ONLY_VALIDATED',
    knownLimitations: ['Retain every slot, order, grouping and zero; never infer HRV from PPI.'],
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'PpiCertification'],
  }),
  entry({
    vendorDataType: '127', vendorField: 'serial_number', elitePlusSourceMetric: 'PPI_PACKET_ID',
    unit: 'opaque_identifier', timestampSemantics: 'Packet/group identifier; not a timestamp',
    timestampConfidence: 'SOURCE_FIELD', semanticClassification: 'PPI_SOURCE_GROUP_ID',
    finalDisposition: 'SOURCE_ONLY_VALIDATED',
    knownLimitations: ['Group identity must not be treated as per-slot identity.'],
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'PpiCertification'],
  }),
  activity('24', 'date', 'ACTIVITY_DAILY_WINDOW', 'vendor_local_date'),
  activity('24', 'step', 'DAILY_STEPS', 'count'),
  activity('24', 'distance', 'DAILY_DISTANCE'),
  activity('24', 'calories', 'DAILY_CALORIES'),
  activity('24', 'exerciseMinutes', 'DAILY_EXERCISE_MINUTES', 'minute'),
  activity('24', 'ExerciseTime', 'DAILY_ACTIVE_MINUTES', 'vendor_minute_or_second'),
  activity('24', 'goal', 'DAILY_GOAL_COMPLETION'),
  activity('25', 'date', 'ACTIVITY_DETAIL_BLOCK_START', 'vendor_local_timestamp'),
  activity('25', 'arraySteps', 'DETAILED_ACTIVITY_EPOCH_STEPS', 'count'),
  activity('25', 'detailMinterStep', 'DETAILED_ACTIVITY_STEPS_TOTAL', 'count'),
  activity('25', 'distance', 'DETAILED_ACTIVITY_DISTANCE'),
  activity('25', 'calories', 'DETAILED_ACTIVITY_CALORIES'),
  sleep('26', 'date', 'SLEEP_RECORD_START', 'vendor_local_timestamp'),
  sleep('26', 'arraySleepQuality', 'SLEEP_STAGE_CODES', 'source_stage_code'),
  sleep('26', 'sleepUnitLength', 'SLEEP_STAGE_UNIT_LENGTH', 'vendor_unit'),
  sleep('121', 'date', 'SLEEP_DETAIL_RECORD_TIME', 'vendor_local_timestamp'),
  sleep('121', 'sleepLength', 'SLEEP_DURATION_SOURCE', 'vendor_unit'),
  sleep('121', 'Sleep_level', 'SLEEP_DETAIL_STAGE_CODES', 'source_stage_code'),
  sleep('121', 'ActivityData', 'SLEEP_MOVEMENT_CODES'),
  workout('date', 'WORKOUT_HISTORY_START', 'vendor_local_timestamp'),
  workout('sportModel', 'WORKOUT_MODE', 'vendor_mode'),
  workout('heartRate', 'WORKOUT_HR', 'bpm'),
  workout('ExerciseTime', 'WORKOUT_DURATION', 'vendor_seconds_unconfirmed'),
  workout('step', 'WORKOUT_STEPS', 'count'),
  workout('sportModelSpeed', 'WORKOUT_PACE'),
  workout('distance', 'WORKOUT_DISTANCE'),
  workout('calories', 'WORKOUT_CALORIES'),
  entry({
    vendorDataType: '119', vendorField: 'rawNotificationBytes', elitePlusSourceMetric: 'PPG_RAW_BYTES',
    unit: 'UNKNOWN_VENDOR_UNIT', unitConfidence: 'UNKNOWN',
    timestampSemantics: 'BLE notification receipt timestamp; vendor sample timing unknown',
    timestampConfidence: 'PHONE_RECEIPT_TIME_ONLY',
    semanticClassification: 'RAW_PPG_WAVEFORM_BYTES',
    finalDisposition: 'SOURCE_ONLY_VALIDATED',
    knownLimitations: [
      'Preserve bytes and packet boundaries; sample rate and unit remain unknown.',
      'RAW_PPG_NOT_GLUCOSE; NO_GLUCOSE_CANONICAL_MAPPING; NO_GLUCOSE_INFERENCE; NO_CGM_SUBSTITUTION.',
    ],
    evidenceReferences: [RAW_EVIDENCE, 'JCVitalV8RawPpgSession', 'RawPpgSavedEvidenceInspector'],
  }),
  entry({
    vendorDataType: '119', vendorField: 'PPG', elitePlusSourceMetric: 'PPG_RAW_VENDOR_FIELD',
    unit: 'UNKNOWN_VENDOR_UNIT', unitConfidence: 'UNKNOWN',
    timestampSemantics: 'Vendor callback time; sample timing unknown',
    timestampConfidence: 'UNCONFIRMED',
    semanticClassification: 'RAW_PPG_VENDOR_FIELD',
    finalDisposition: 'SOURCE_ONLY_VALIDATED',
    knownLimitations: ['Never map to glucose or substitute for CGM.'],
    evidenceReferences: [RAW_EVIDENCE, 'RawPpgSavedEvidenceInspector'],
  }),
  entry({
    vendorDataType: '9', vendorField: 'batteryLevel', elitePlusSourceMetric: 'BATTERY_PERCENT',
    unit: 'percent', unitConfidence: 'SDK_FIELD_NAME; range not independently certified',
    timestampSemantics: 'Phone receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'DEVICE_BATTERY_LEVEL', finalDisposition: 'SOURCE_ONLY_VALIDATED',
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'Shipped android/app/libs/v8sdk2.0.jar'],
  }),
  entry({
    vendorDataType: '9', vendorField: 'Chargingstate', elitePlusSourceMetric: 'CHARGING_STATE',
    unit: 'vendor_code', unitConfidence: 'UNCONFIRMED',
    timestampSemantics: 'Phone receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'DEVICE_CHARGING_STATE_CODE', finalDisposition: 'SOURCE_ONLY_VALIDATED',
    knownLimitations: ['Normalized boolean is not the original state code; raw envelope remains authoritative.'],
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'Shipped android/app/libs/v8sdk2.0.jar'],
  }),
  entry({
    vendorDataType: '9', vendorField: 'VoltageValue', elitePlusSourceMetric: 'BATTERY_VOLTAGE',
    unit: 'UNKNOWN_VENDOR_UNIT', unitConfidence: 'UNCONFIRMED',
    timestampSemantics: 'Phone receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'DEVICE_BATTERY_VOLTAGE_RAW', finalDisposition: 'SOURCE_ONLY_VALIDATED',
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER, 'Shipped android/app/libs/v8sdk2.0.jar'],
  }),
  entry({
    vendorDataType: '11', vendorField: 'deviceVersion', elitePlusSourceMetric: 'FIRMWARE_VERSION',
    unit: 'string', unitConfidence: 'DIRECT_SOURCE_STRING',
    timestampSemantics: 'Phone receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'DEVICE_FIRMWARE_CONTEXT', finalDisposition: 'SOURCE_ONLY_VALIDATED',
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER],
  }),
  entry({
    vendorDataType: '117', vendorField: 'deviceName', elitePlusSourceMetric: 'DEVICE_NAME',
    unit: 'string', unitConfidence: 'DIRECT_SOURCE_STRING',
    timestampSemantics: 'Phone receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'DEVICE_PROFILE_CONTEXT', finalDisposition: 'SOURCE_ONLY_VALIDATED',
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER],
  }),
  entry({
    vendorDataType: '10', vendorField: 'macAddress', elitePlusSourceMetric: 'DEVICE_MAC_ADDRESS',
    unit: 'identifier', unitConfidence: 'DIRECT_SOURCE_STRING',
    timestampSemantics: 'Phone receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'DEVICE_PROFILE_CONTEXT',
    finalDisposition: 'SOURCE_ONLY_VALIDATED',
    knownLimitations: ['BLE address must not replace opaque Elite+ deviceScopeId.'],
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER],
  }),
  entry({
    vendorDataType: '2', vendorField: 'deviceId', elitePlusSourceMetric: 'VENDOR_DEVICE_PROFILE_ID',
    unit: 'identifier', unitConfidence: 'DIRECT_SOURCE_FIELD',
    timestampSemantics: 'Phone receipt time', timestampConfidence: 'PHONE_RECEIPT_TIME',
    semanticClassification: 'DEVICE_PROFILE_CONTEXT', finalDisposition: 'SOURCE_ONLY_VALIDATED',
    evidenceReferences: [RAW_EVIDENCE, NORMALIZER],
  }),
  ...[
    ['workModel', 'MONITORING_ENABLED_MODE'],
    ['intervalTime', 'MONITORING_INTERVAL'],
    ['heartStartHour', 'MONITORING_START_HOUR'],
    ['heartStartMinter', 'MONITORING_START_MINUTE'],
    ['heartEndHour', 'MONITORING_END_HOUR'],
    ['heartEndMinter', 'MONITORING_END_MINUTE'],
    ['weekValue', 'MONITORING_WEEKDAYS'],
  ].map(([field, metric]) => entry({
    vendorDataType: '16', vendorField: field, elitePlusSourceMetric: metric,
    unit: 'vendor_configuration_value', unitConfidence: 'RAW_CONFIGURATION_PRESERVED',
    timestampSemantics: 'Not a measurement timestamp; monitoring configuration response',
    timestampConfidence: 'NOT_APPLICABLE',
    semanticClassification: 'DEVICE_MONITORING_CONFIGURATION',
    finalDisposition: 'SOURCE_ONLY_VALIDATED',
    knownLimitations: ['Configuration values are not measurements or readiness inputs.'],
    evidenceReferences: [RAW_EVIDENCE, 'JCVitalV8Manager.handleMonitoringResponse', 'jcvitalV8Bridge.getMonitoringConfiguration'],
  })),
  entry({
    vendorDataType: null, vendorField: 'respiratoryRate', elitePlusSourceMetric: 'RESPIRATORY_RATE_VENDOR',
    sdkExposure: 'NOT_EXPOSED_BY_CURRENT_SDK', sourcePreservation: 'NOT_CAPTURED',
    sourceCertification: 'No current first-party callback/API field is exposed for respiratory rate',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY',
    knownLimitations: ['No respiratory-rate field is inferred from ECG breath or another signal.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', NORMALIZER],
  }),
  entry({
    vendorDataType: null, vendorField: 'bloodPressureMeasured', elitePlusSourceMetric: 'BLOOD_PRESSURE_MEASURED',
    sdkExposure: 'NOT_EXPOSED_BY_CURRENT_SDK', sourcePreservation: 'NOT_CAPTURED',
    sourceCertification: 'No clinically measured BP field is exposed by the current V8 SDK contract',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY',
    knownLimitations: ['Type 42 highBP/lowBP are estimated vendor values and cannot be treated as measured BP.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', NORMALIZER],
  }),
  entry({
    vendorDataType: null, vendorField: 'vascularAgeChronological', elitePlusSourceMetric: 'CHRONOLOGICAL_AGE',
    sdkExposure: 'NOT_EXPOSED_BY_CURRENT_SDK', sourcePreservation: 'NOT_CAPTURED',
    sourceCertification: 'No chronological-age field is exposed by the current V8 source contract',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY',
    knownLimitations: ['Vendor vascularAging is not chronological age.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', NORMALIZER],
  }),
  entry({
    vendorDataType: null, vendorField: 'mood', elitePlusSourceMetric: 'MOOD_VENDOR',
    sdkExposure: 'NOT_EXPOSED_BY_CURRENT_SDK', sourcePreservation: 'NOT_CAPTURED',
    sourceCertification: 'No general mood field is exposed by the current first-party V8 contract',
    finalDisposition: 'BLOCKED_VENDOR_DEPENDENCY',
    knownLimitations: ['ECGMoodValue is ECG-derived and must not be treated as general mood data.'],
    evidenceReferences: ['Shipped android/app/libs/v8sdk2.0.jar', NORMALIZER],
  }),
] as const

export const V8DataCoverageRollup = {
  totalSdkFieldsDiscovered: V8DataCoverageRegistry.filter((field) => field.sdkExposure === 'EXPOSED_BY_CURRENT_SDK').length,
  totalCoverageEntries: V8DataCoverageRegistry.length,
  classifiedFields: V8DataCoverageRegistry.filter((field) => field.semanticClassification.length > 0).length,
  unclassifiedFields: V8DataCoverageRegistry.filter((field) => !field.semanticClassification.length).length,
  losslessCertified: V8DataCoverageRegistry.filter((field) => field.sourcePreservation === 'LOSSLESS_CERTIFIED').length,
  losslessImplementedPendingPhysical: V8DataCoverageRegistry.filter(
    (field) => field.sourcePreservation === 'LOSSLESS_IMPLEMENTED_NOT_PHYSICALLY_CERTIFIED',
  ).length,
  partialSourcePreservation: V8DataCoverageRegistry.filter((field) => field.sourcePreservation === 'PARTIAL_SOURCE_PRESERVATION').length,
  blocked: V8DataCoverageRegistry.filter((field) => field.finalDisposition === 'BLOCKED_VENDOR_DEPENDENCY').length,
  canonicalProduction: V8DataCoverageRegistry.filter((field) => field.finalDisposition === 'CANONICAL_PRODUCTION').length,
  canonicalCandidates: V8DataCoverageRegistry.filter((field) => field.canonicalEligibility === 'PENDING_SEMANTIC_VALIDATION').length,
  sourceOnlyValidated: V8DataCoverageRegistry.filter((field) => field.finalDisposition === 'SOURCE_ONLY_VALIDATED').length,
}
