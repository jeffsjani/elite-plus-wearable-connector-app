import type { NativeObservationInput, TimestampTimezoneSource } from '../../services/base44/base44Types'
import type { NativeObservation } from '../../models/wearableObservation'
import { MetricType } from '../../models/metricTaxonomy'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import { sha256Hex } from './HeartRateSeries'
import { HISTORICAL_TIMESTAMP_TIMEZONE_SOURCE, validatePhysiologyObservation } from './PhysiologyContract'
import { JCVITAL_NATIVE_SOURCE } from './WorkoutHrDelivery'
import {
  expandType25Segment,
  TYPE25_MINUTE_ANCHOR_POLICY,
  TYPE25_MINUTE_ANCHOR_POLICY_ID,
  type25PolicyApplies,
  type Type25DeviceScope,
} from './Type25MinuteAnchorPolicy'

/*
 * P1-2C — JCVital V8 Activity production canonicalization.
 *
 * Type24 is the daily authority (steps, distance, activity energy, exercise duration).
 * Type25 is the intraday authority (minute steps under jcvital.type25.minute_anchor.v1).
 * Daily values are never derived from Type25.
 *
 * Pure mapping, identity and ledger logic only: no BLE, queue, sender, ACK, Base44, readiness or scoring
 * side effects. Base44 activity canonical publication is gated separately (ACTIVITY_BASE44_CANONICAL_PREP).
 */

export const ACTIVITY_NORMALIZER_VERSION = 'jcvital.activity.production.v1'
export const TYPE24_DAILY_POLICY_ID = 'jcvital.type24.daily_activity.v1'
export const ACTIVITY_TIMEZONE_SOURCE: TimestampTimezoneSource = HISTORICAL_TIMESTAMP_TIMEZONE_SOURCE

export type ActivityCanonicalMetric =
  | typeof MetricType.DAILY_STEPS
  | typeof MetricType.DAILY_DISTANCE
  | typeof MetricType.DAILY_CALORIES
  | typeof MetricType.EXERCISE_DURATION
  | typeof MetricType.DETAILED_ACTIVITY_MINUTE_STEPS

export type ActivitySemanticConfidence = 'HIGH' | 'VENDOR_DERIVED'

export interface ActivityMetricContract {
  metric: ActivityCanonicalMetric
  vendorDataType: '24' | '25'
  vendorField: string
  unit: 'count' | 'km' | 'kcal' | 'second'
  canonicalTarget: string
  consumerLabel: string
  semanticLabel: string
  vendorDerived: boolean
  measured: boolean
  semanticConfidence: ActivitySemanticConfidence
  semanticPolicyId: string
  authority: 'DAILY' | 'INTRADAY'
}

/**
 * Single canonical concept per measurement. Canonical targets follow the existing `body.*` naming style.
 * No activity canonical target existed in the client repository before P1-2C.
 */
export const ACTIVITY_METRIC_CONTRACTS: Readonly<Record<ActivityCanonicalMetric, ActivityMetricContract>> = Object.freeze({
  DAILY_STEPS: {
    metric: 'DAILY_STEPS', vendorDataType: '24', vendorField: 'step', unit: 'count',
    canonicalTarget: 'activity.daily_steps', consumerLabel: 'Steps', semanticLabel: 'Daily Steps',
    vendorDerived: false, measured: true, semanticConfidence: 'HIGH', semanticPolicyId: TYPE24_DAILY_POLICY_ID, authority: 'DAILY',
  },
  DAILY_DISTANCE: {
    metric: 'DAILY_DISTANCE', vendorDataType: '24', vendorField: 'distance', unit: 'km',
    canonicalTarget: 'activity.daily_distance', consumerLabel: 'Distance', semanticLabel: 'Daily Distance',
    vendorDerived: true, measured: false, semanticConfidence: 'VENDOR_DERIVED', semanticPolicyId: TYPE24_DAILY_POLICY_ID, authority: 'DAILY',
  },
  DAILY_CALORIES: {
    metric: 'DAILY_CALORIES', vendorDataType: '24', vendorField: 'calories', unit: 'kcal',
    canonicalTarget: 'activity.daily_activity_energy', consumerLabel: 'Activity Calories', semanticLabel: 'Activity Calories / Activity Energy',
    vendorDerived: true, measured: false, semanticConfidence: 'VENDOR_DERIVED', semanticPolicyId: TYPE24_DAILY_POLICY_ID, authority: 'DAILY',
  },
  EXERCISE_DURATION: {
    metric: 'EXERCISE_DURATION', vendorDataType: '24', vendorField: 'exerciseMinutes', unit: 'second',
    canonicalTarget: 'activity.exercise_duration', consumerLabel: 'V8 Exercise Duration', semanticLabel: 'V8 Exercise Duration',
    vendorDerived: true, measured: false, semanticConfidence: 'VENDOR_DERIVED', semanticPolicyId: TYPE24_DAILY_POLICY_ID, authority: 'DAILY',
  },
  DETAILED_ACTIVITY_MINUTE_STEPS: {
    metric: 'DETAILED_ACTIVITY_MINUTE_STEPS', vendorDataType: '25', vendorField: 'arraySteps', unit: 'count',
    canonicalTarget: 'activity.minute_steps', consumerLabel: 'Steps per minute', semanticLabel: 'Detailed Activity Minute Steps',
    vendorDerived: false, measured: true, semanticConfidence: 'HIGH', semanticPolicyId: TYPE25_MINUTE_ANCHOR_POLICY_ID, authority: 'INTRADAY',
  },
})

export const ACTIVITY_DAILY_METRICS: readonly ActivityCanonicalMetric[] = ['DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES', 'EXERCISE_DURATION']

/** Source fields that are deliberately never canonicalized in P1-2C. */
export const ACTIVITY_NON_MAPPED_FIELDS = Object.freeze([
  { vendorDataType: '24', vendorField: 'goal', reason: 'Source-only until independently qualified.' },
  { vendorDataType: '24', vendorField: 'ExerciseTime', reason: 'Not exposed in the validated Android physical source.' },
  { vendorDataType: '24', vendorField: 'activeMinutes', reason: 'iOS-only field; never synthesized for Android.' },
  { vendorDataType: '25', vendorField: 'detailMinterStep', reason: 'Supporting integrity field only (sum invariant).' },
  { vendorDataType: '25', vendorField: 'distance', reason: 'Supporting source field; never summed into daily distance.' },
  { vendorDataType: '25', vendorField: 'calories', reason: 'Supporting source field; never summed into daily calories.' },
] as const)

/** Forbidden labels for Type24.exerciseMinutes: the vendor qualification algorithm is undocumented. */
export const EXERCISE_DURATION_FORBIDDEN_LABELS = Object.freeze(['MVPA', 'moderate activity', 'vigorous activity', 'active minutes', 'training load'])

/** Type25 minute-anchor semantics were qualified on this exact scope; any other SDK/firmware requires regression qualification. Type24 is not scope-withheld. */
export const ACTIVITY_POLICY_SCOPE: Readonly<Type25DeviceScope> = Object.freeze({
  deviceModel: TYPE25_MINUTE_ANCHOR_POLICY.deviceModel,
  sdkVersion: TYPE25_MINUTE_ANCHOR_POLICY.sdkVersion,
  firmwareVersion: TYPE25_MINUTE_ANCHOR_POLICY.firmwareVersion,
})

export const ACTIVITY_BASE44_CANONICAL_PREP = Object.freeze({
  schema: 'eliteplus.base44.activity-canonical-prep.v1',
  preparedLocally: true,
  published: false,
  existingProductionActivityRevisionUnchanged: true,
  targets: Object.values(ACTIVITY_METRIC_CONTRACTS).map(({ metric, canonicalTarget, unit, authority }) => ({ metric, canonicalTarget, unit, authority })),
  upsertKey: 'rawSourceMetadata.canonicalIdentityKey',
  serverNameConfirmationRequiredAtPublishGate: true,
})

// ---------------------------------------------------------------------------------------------
// Time helpers — device-local dates are never derived by converting the device date through UTC.
// ---------------------------------------------------------------------------------------------

type LocalParts = { year: number; month: number; day: number; hour: number; minute: number; second: number }

function zoneParts(epochMs: number, timeZone: string): LocalParts {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(epochMs))
  const get = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value)
  return { year: get('year'), month: get('month'), day: get('day'), hour: get('hour'), minute: get('minute'), second: get('second') }
}

function sameParts(a: LocalParts, b: LocalParts): boolean {
  return a.year === b.year && a.month === b.month && a.day === b.day && a.hour === b.hour && a.minute === b.minute && a.second === b.second
}

/** Resolves a wall-clock time in an IANA zone to epoch ms; null for invalid zones/dates or DST-gap times. */
export function zonedLocalToEpochMs(local: LocalParts, timeZone: string): number | null {
  try {
    const asUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    const offset = (at: number) => {
      const parts = zoneParts(at, timeZone)
      return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - Math.floor(at / 1000) * 1000
    }
    let guess = asUtc - offset(asUtc)
    guess = asUtc - offset(guess)
    return sameParts(zoneParts(guess, timeZone), local) ? guess : null
  } catch {
    return null
  }
}

/** Current device-local calendar date (YYYY-MM-DD) in the given zone. */
export function deviceLocalDate(nowMs: number, timeZone: string): string | null {
  try {
    const parts = zoneParts(nowMs, timeZone)
    const two = (value: number) => String(value).padStart(2, '0')
    return `${parts.year}-${two(parts.month)}-${two(parts.day)}`
  } catch {
    return null
  }
}

function parseVendorLocal(value: unknown, withTime: boolean): LocalParts | null {
  if (typeof value !== 'string') return null
  const match = withTime
    ? /^(\d{4})[.-](\d{2})[.-](\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value)
    : /^(\d{4})[.-](\d{2})[.-](\d{2})$/.exec(value)
  if (!match) return null
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number)
  const check = new Date(Date.UTC(year, month - 1, day))
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day
    || hour > 23 || minute > 59 || second > 59) return null
  return { year, month, day, hour, minute, second }
}

function localDateString(parts: LocalParts): string {
  return `${parts.year}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`
}

function localTimeString(parts: LocalParts): string {
  return `${localDateString(parts)}T${[parts.hour, parts.minute, parts.second].map((value) => String(value).padStart(2, '0')).join(':')}`
}

function nextLocalDay(parts: LocalParts): LocalParts {
  const next = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1))
  return { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate(), hour: 0, minute: 0, second: 0 }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    const object = value as Record<string, unknown>
    return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

// ---------------------------------------------------------------------------------------------
// Source records
// ---------------------------------------------------------------------------------------------

export interface ActivitySourceRecord {
  vendorDataType: '24' | '25'
  /** SDK-decoded record exactly as journaled (runtime String fields). */
  record: Record<string, unknown>
  sourceEnvelopeId: string | null
  acquisitionSessionId: string | null
  nativeObservationIds: string[]
  nativeSourceRecordIds: string[]
  parserVersion: string | null
  receivedAt: string
  timezone: string | null
}

export interface ActivityDeviceContext {
  ownerUserId: string
  /** Opaque jcvital_device_<uuid>; never the BLE MAC. */
  deviceId: string | null
  deviceModel: string | null
  firmwareVersion: string | null
  sdkVersion: string | null
}

/** Groups native normalizer output back into one source record per (envelope, byte-equivalent record). */
export function activitySourceRecordsFromNative(observations: readonly NativeObservation[]): ActivitySourceRecord[] {
  const grouped = new Map<string, ActivitySourceRecord>()
  for (const native of observations) {
    if (native.acquisitionMode !== 'HISTORICAL_SYNC' || (native.vendorDataType !== '24' && native.vendorDataType !== '25')) continue
    const raw = native.rawPayload
    const record = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).record : null
    if (!record || typeof record !== 'object' || Array.isArray(record)) continue
    const envelopeId = native.provenance.sourceEnvelopeId ?? null
    const key = `${native.vendorDataType}|${envelopeId ?? '-'}|${stableJson(record)}`
    const existing = grouped.get(key)
    if (existing) {
      if (!existing.nativeObservationIds.includes(native.id)) existing.nativeObservationIds.push(native.id)
      const nativeRecordId = native.provenance.sourceRecordId
      if (nativeRecordId && !existing.nativeSourceRecordIds.includes(nativeRecordId)) existing.nativeSourceRecordIds.push(nativeRecordId)
      continue
    }
    grouped.set(key, {
      vendorDataType: native.vendorDataType,
      record: { ...(record as Record<string, unknown>) },
      sourceEnvelopeId: envelopeId,
      acquisitionSessionId: native.sessionId,
      nativeObservationIds: [native.id],
      nativeSourceRecordIds: native.provenance.sourceRecordId ? [native.provenance.sourceRecordId] : [],
      parserVersion: native.provenance.parserVersion ?? null,
      receivedAt: native.receivedAt,
      timezone: native.timezone,
    })
  }
  return [...grouped.values()]
}

// ---------------------------------------------------------------------------------------------
// Canonical observations
// ---------------------------------------------------------------------------------------------

export type ActivityWithheldReason =
  | 'POLICY_SCOPE_MISMATCH'
  | 'OPAQUE_DEVICE_ID_UNAVAILABLE'
  | 'TIMEZONE_UNAVAILABLE'
  | 'MISSING_OR_INVALID_DATE'
  | 'FIELD_ABSENT'
  | 'INVALID_SOURCE_VALUE'
  | 'UNPARSEABLE_ARRAY_STEPS'
  | 'ARRAY_LENGTH_NOT_10'
  | 'UNPARSEABLE_DETAIL_MINTER_STEP'
  | 'SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP'

export interface ActivityWithheld {
  vendorDataType: '24' | '25'
  metric: ActivityCanonicalMetric
  sourceEnvelopeId: string | null
  vendorDate: string | null
  reason: ActivityWithheldReason
  detail: string
}

export interface ActivityProvenance {
  provider: string
  connector: string
  sourceConnector: string
  deviceScopeId: string
  deviceModel: string
  firmwareVersion: string
  sdkVersion: string
  sourceDataType: '24' | '25'
  sourceField: string
  sourceEnvelopeId: string | null
  sourceRecordId: string
  sourcePayloadFingerprint: string
  nativeObservationIds: string[]
  nativeSourceRecordIds: string[]
  acquisitionSessionId: string | null
  parserVersion: string | null
  receivedAt: string
  observedLocalDate: string
  observedLocalTime: string
  timezone: string
  timezoneSource: TimestampTimezoneSource
  normalizerVersion: string
  semanticPolicyId: string
  semanticConfidence: ActivitySemanticConfidence
  vendorDerived: boolean
  measured: boolean
  /** Type25 only. */
  sourceType25VendorDate?: string
  sourceArraySlotIndex?: number
  resolvedMinuteTimestamp?: string
}

export type ActivityProviderAuthority = 'JCVITAL_NATIVE' | 'ROOK'

export interface ActivityCanonicalObservation {
  /** Deterministic canonical identity (owner + device + provider + local date or minute/slot + metric). */
  canonicalIdentityKey: string
  /** Provider-independent identity of the underlying physical measurement (for JCVITAL_NATIVE > ROOK). */
  measurementKey: string
  providerAuthority: ActivityProviderAuthority
  metric: ActivityCanonicalMetric
  canonicalTarget: string
  consumerLabel: string
  value: number
  unit: ActivityMetricContract['unit']
  observedAt: string
  endAt: string
  sourceLocalDate: string
  /** Daily metrics only. */
  dailyState?: 'IN_PROGRESS' | 'FINAL'
  vendorRawValue: string
  /** EXERCISE_DURATION only. */
  vendor_exercise_duration_seconds?: number
  vendor_exercise_duration_minutes?: number
  provenance: ActivityProvenance
}

export interface ActivityMappingResult {
  observations: ActivityCanonicalObservation[]
  withheld: ActivityWithheld[]
}

function sourceRecordIdFor(deviceId: string, vendorDataType: string, vendorDate: string): string {
  return `${JCVITAL_NATIVE_SOURCE.sourceConnector}:${JCVITAL_NATIVE_SOURCE.deviceModel}:${deviceId}:${vendorDataType}:${vendorDate}`
}

function dailyIdentity(provider: string, owner: string, device: string, localDate: string, metric: string): string {
  return `activity|${owner}|${device}|${provider}|${localDate}|${metric}`
}

function dailyMeasurement(owner: string, physicalDevice: string, localDate: string, metric: string): string {
  return `activity-measurement|${owner}|${physicalDevice}|${localDate}|${metric}`
}

function minuteIdentity(provider: string, owner: string, device: string, sourceRecordId: string, slot: number, minuteIso: string, metric: string): string {
  return `activity|${owner}|${device}|${provider}|${sourceRecordId}|${slot}|${minuteIso}|${metric}`
}

function minuteMeasurement(owner: string, physicalDevice: string, minuteIso: string, metric: string): string {
  return `activity-measurement|${owner}|${physicalDevice}|${minuteIso}|${metric}`
}

function parseCount(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : Number.NaN
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null
}

function parseDecimal(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' && /^\d+(\.\d+)?$/.test(value) ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null
}

interface Preflight {
  deviceId: string
  scope: Type25DeviceScope
  timezone: string
  fingerprint: string
}

async function preflight(source: ActivitySourceRecord, context: ActivityDeviceContext, metrics: readonly ActivityCanonicalMetric[], vendorDate: string | null)
  : Promise<Preflight | ActivityWithheld[]> {
  const withhold = (reason: ActivityWithheldReason, detail: string) => metrics.map((metric) => ({
    vendorDataType: source.vendorDataType, metric, sourceEnvelopeId: source.sourceEnvelopeId, vendorDate, reason, detail,
  }))
  const scope = { deviceModel: context.deviceModel ?? '', sdkVersion: context.sdkVersion ?? '', firmwareVersion: context.firmwareVersion ?? '' }
  // The minute-anchor scope binds only Type25 semantics; Type24 daily totals carry SDK/FW in provenance instead.
  if (source.vendorDataType === '25' && !type25PolicyApplies(scope)) {
    return withhold('POLICY_SCOPE_MISMATCH', `Type25 minute-anchor semantics (${TYPE25_MINUTE_ANCHOR_POLICY.policyId}) are qualified only for ${ACTIVITY_POLICY_SCOPE.deviceModel} + ${ACTIVITY_POLICY_SCOPE.sdkVersion} + FW ${ACTIVITY_POLICY_SCOPE.firmwareVersion}; got ${scope.deviceModel} + ${scope.sdkVersion} + FW ${scope.firmwareVersion}. Regression qualification required.`)
  }
  if (!isOpaqueJCVitalDeviceId(context.deviceId)) return withhold('OPAQUE_DEVICE_ID_UNAVAILABLE', 'Opaque JCVital device ID unavailable.')
  if (!source.timezone || deviceLocalDate(0, source.timezone) === null) return withhold('TIMEZONE_UNAVAILABLE', 'Phone timezone unavailable or invalid.')
  return { deviceId: context.deviceId, scope, timezone: source.timezone, fingerprint: await sha256Hex(stableJson(source.record)) }
}

function provenanceFor(source: ActivitySourceRecord, pre: Preflight, contract: ActivityMetricContract, vendorDate: string,
  observedLocalDate: string, observedLocalTime: string): ActivityProvenance {
  return {
    provider: JCVITAL_NATIVE_SOURCE.sourceProvider,
    connector: JCVITAL_NATIVE_SOURCE.source,
    sourceConnector: JCVITAL_NATIVE_SOURCE.sourceConnector,
    deviceScopeId: pre.deviceId,
    deviceModel: pre.scope.deviceModel,
    firmwareVersion: pre.scope.firmwareVersion,
    sdkVersion: pre.scope.sdkVersion,
    sourceDataType: source.vendorDataType,
    sourceField: contract.vendorField,
    sourceEnvelopeId: source.sourceEnvelopeId,
    sourceRecordId: sourceRecordIdFor(pre.deviceId, source.vendorDataType, vendorDate),
    sourcePayloadFingerprint: pre.fingerprint,
    nativeObservationIds: [...source.nativeObservationIds],
    nativeSourceRecordIds: [...source.nativeSourceRecordIds],
    acquisitionSessionId: source.acquisitionSessionId,
    parserVersion: source.parserVersion,
    receivedAt: source.receivedAt,
    observedLocalDate,
    observedLocalTime,
    timezone: pre.timezone,
    timezoneSource: ACTIVITY_TIMEZONE_SOURCE,
    normalizerVersion: ACTIVITY_NORMALIZER_VERSION,
    semanticPolicyId: contract.semanticPolicyId,
    semanticConfidence: contract.semanticConfidence,
    vendorDerived: contract.vendorDerived,
    measured: contract.measured,
  }
}

/** Type24 → DAILY_STEPS / DAILY_DISTANCE / DAILY_CALORIES / EXERCISE_DURATION (the daily authority). */
export async function mapType24DailyRecord(source: ActivitySourceRecord, context: ActivityDeviceContext, nowMs: number): Promise<ActivityMappingResult> {
  if (source.vendorDataType !== '24') return { observations: [], withheld: [] }
  const vendorDate = typeof source.record.date === 'string' ? source.record.date : null
  const pre = await preflight(source, context, ACTIVITY_DAILY_METRICS, vendorDate)
  if (Array.isArray(pre)) return { observations: [], withheld: pre }
  const local = parseVendorLocal(vendorDate, false)
  const startMs = local ? zonedLocalToEpochMs(local, pre.timezone) : null
  const endMs = local ? zonedLocalToEpochMs(nextLocalDay(local), pre.timezone) : null
  if (!local || !vendorDate || startMs === null || endMs === null) {
    return { observations: [], withheld: ACTIVITY_DAILY_METRICS.map((metric) => ({
      vendorDataType: '24', metric, sourceEnvelopeId: source.sourceEnvelopeId, vendorDate, reason: 'MISSING_OR_INVALID_DATE',
      detail: 'Type24 date must be a device-local yyyy.MM.dd calendar date.',
    })) }
  }
  const sourceLocalDate = localDateString(local)
  const currentLocalDate = deviceLocalDate(nowMs, pre.timezone)
  const dailyState = sourceLocalDate === currentLocalDate ? 'IN_PROGRESS' as const : 'FINAL' as const
  const observations: ActivityCanonicalObservation[] = []
  const withheld: ActivityWithheld[] = []
  for (const metric of ACTIVITY_DAILY_METRICS) {
    const contract = ACTIVITY_METRIC_CONTRACTS[metric]
    const raw = source.record[contract.vendorField]
    if (raw === undefined || raw === null) {
      withheld.push({ vendorDataType: '24', metric, sourceEnvelopeId: source.sourceEnvelopeId, vendorDate, reason: 'FIELD_ABSENT', detail: `Type24.${contract.vendorField} absent.` })
      continue
    }
    const value = contract.unit === 'km' || contract.unit === 'kcal' ? parseDecimal(raw) : parseCount(raw)
    if (value === null) {
      withheld.push({ vendorDataType: '24', metric, sourceEnvelopeId: source.sourceEnvelopeId, vendorDate, reason: 'INVALID_SOURCE_VALUE', detail: `Type24.${contract.vendorField} = ${JSON.stringify(raw)} is not a valid non-negative number.` })
      continue
    }
    observations.push({
      canonicalIdentityKey: dailyIdentity(JCVITAL_NATIVE_SOURCE.sourceConnector, context.ownerUserId, pre.deviceId, sourceLocalDate, metric),
      measurementKey: dailyMeasurement(context.ownerUserId, pre.deviceId, sourceLocalDate, metric),
      providerAuthority: 'JCVITAL_NATIVE',
      metric,
      canonicalTarget: contract.canonicalTarget,
      consumerLabel: contract.consumerLabel,
      value,
      unit: contract.unit,
      observedAt: new Date(startMs).toISOString(),
      endAt: new Date(endMs).toISOString(),
      sourceLocalDate,
      dailyState,
      vendorRawValue: String(raw),
      ...(metric === 'EXERCISE_DURATION' ? { vendor_exercise_duration_seconds: value, vendor_exercise_duration_minutes: value / 60 } : {}),
      provenance: provenanceFor(source, pre, contract, vendorDate, sourceLocalDate, localTimeString(local)),
    })
  }
  return { observations, withheld }
}

/** Type25 → DETAILED_ACTIVITY_MINUTE_STEPS under jcvital.type25.minute_anchor.v1 (the intraday authority). */
export async function mapType25DetailRecord(source: ActivitySourceRecord, context: ActivityDeviceContext): Promise<ActivityMappingResult> {
  if (source.vendorDataType !== '25') return { observations: [], withheld: [] }
  const metric = MetricType.DETAILED_ACTIVITY_MINUTE_STEPS
  const contract = ACTIVITY_METRIC_CONTRACTS[metric]
  const vendorDate = typeof source.record.date === 'string' ? source.record.date : null
  const pre = await preflight(source, context, [metric], vendorDate)
  if (Array.isArray(pre)) return { observations: [], withheld: pre }
  const local = parseVendorLocal(vendorDate, true)
  const dateEpochMs = local ? zonedLocalToEpochMs(local, pre.timezone) : null
  const sourceRecordId = sourceRecordIdFor(pre.deviceId, '25', vendorDate ?? '')
  const expansion = expandType25Segment({
    sourceEnvelopeId: source.sourceEnvelopeId ?? sourceRecordId,
    dateEpochMs,
    detailMinterStep: source.record.detailMinterStep,
    arraySteps: source.record.arraySteps,
  }, pre.scope)
  if (expansion.status === 'INTEGRITY_WITHHELD') {
    return { observations: [], withheld: [{ vendorDataType: '25', metric, sourceEnvelopeId: source.sourceEnvelopeId, vendorDate, reason: expansion.reason, detail: expansion.detail }] }
  }
  const observations = expansion.minutes.map((minute): ActivityCanonicalObservation => {
    const minuteLocal = zoneParts(minute.epochMs, pre.timezone)
    const sourceLocalDate = localDateString(minuteLocal)
    const observedLocalTime = localTimeString(minuteLocal)
    return {
      canonicalIdentityKey: minuteIdentity(JCVITAL_NATIVE_SOURCE.sourceConnector, context.ownerUserId, pre.deviceId, sourceRecordId, minute.slotIndex, minute.minuteTimestamp, metric),
      measurementKey: minuteMeasurement(context.ownerUserId, pre.deviceId, minute.minuteTimestamp, metric),
      providerAuthority: 'JCVITAL_NATIVE',
      metric,
      canonicalTarget: contract.canonicalTarget,
      consumerLabel: contract.consumerLabel,
      value: minute.steps,
      unit: contract.unit,
      observedAt: minute.minuteTimestamp,
      endAt: new Date(minute.epochMs + 60_000).toISOString(),
      sourceLocalDate,
      vendorRawValue: String(minute.steps),
      provenance: {
        ...provenanceFor(source, pre, contract, vendorDate!, sourceLocalDate, observedLocalTime),
        sourceType25VendorDate: vendorDate!,
        sourceArraySlotIndex: minute.slotIndex,
        resolvedMinuteTimestamp: minute.minuteTimestamp,
      },
    }
  })
  return { observations, withheld: [] }
}

export async function mapActivitySourceRecords(sources: readonly ActivitySourceRecord[], context: ActivityDeviceContext, nowMs: number): Promise<ActivityMappingResult> {
  const results = await Promise.all(sources.map((source) => source.vendorDataType === '24'
    ? mapType24DailyRecord(source, context, nowMs) : mapType25DetailRecord(source, context)))
  return { observations: results.flatMap((result) => result.observations), withheld: results.flatMap((result) => result.withheld) }
}

// ---------------------------------------------------------------------------------------------
// Canonical ledger: current-day upsert, idempotency, conflict preservation, source authority.
// ---------------------------------------------------------------------------------------------

export interface ActivitySourceRef {
  providerAuthority: ActivityProviderAuthority
  sourceEnvelopeId: string | null
  sourceRecordId: string
  sourcePayloadFingerprint: string
  receivedAt: string
  value: number
}

export interface ActivityLedgerRow {
  observation: ActivityCanonicalObservation
  revision: number
  /** Every source that contributed to this canonical identity, oldest first. */
  ancestry: ActivitySourceRef[]
  sourceConflict: boolean
  conflictingSources: ActivitySourceRef[]
  /** Lower-authority sources representing the same physical measurement (preserved, not canonical). */
  supersededSources: ActivitySourceRef[]
}

export interface ActivityLedgerState {
  schema: 'eliteplus.activity-canonical-ledger.v1'
  rows: Record<string, ActivityLedgerRow>
  /** measurementKey → active canonicalIdentityKey. */
  measurements: Record<string, string>
  sourceRecords: Record<string, {
    source: ActivitySourceRecord
    context: ActivityDeviceContext
    sourceRecordId: string
    fingerprint: string
    withheld: ActivityWithheld[]
    sourceConflict: boolean
  }>
}

export type ActivityLedgerOutcome =
  | 'CREATED'
  | 'UPDATED_IN_PROGRESS'
  | 'CORRECTED_HISTORICAL'
  | 'DUPLICATE'
  | 'STALE_READ_IGNORED'
  | 'CONFLICT_PRESERVED'
  | 'SUPERSEDED_BY_HIGHER_AUTHORITY'
  | 'REPLACED_LOWER_AUTHORITY'
  | 'REJECTED_DAILY_AUTHORITY'

export class ActivityAuthorityError extends Error {}

const AUTHORITY_RANK: Record<ActivityProviderAuthority, number> = { JCVITAL_NATIVE: 2, ROOK: 1 }

export function emptyActivityLedger(): ActivityLedgerState {
  return { schema: 'eliteplus.activity-canonical-ledger.v1', rows: {}, measurements: {}, sourceRecords: {} }
}

function sourceRef(observation: ActivityCanonicalObservation): ActivitySourceRef {
  return {
    providerAuthority: observation.providerAuthority,
    sourceEnvelopeId: observation.provenance.sourceEnvelopeId,
    sourceRecordId: observation.provenance.sourceRecordId,
    sourcePayloadFingerprint: observation.provenance.sourcePayloadFingerprint,
    receivedAt: observation.provenance.receivedAt,
    value: observation.value,
  }
}

/** Type24 is the only daily authority for JCVital; Type25-derived daily totals are rejected outright. */
export function assertActivityAuthority(observation: ActivityCanonicalObservation): void {
  const contract = ACTIVITY_METRIC_CONTRACTS[observation.metric]
  if (!contract) throw new ActivityAuthorityError(`Unknown activity metric ${observation.metric}.`)
  if (observation.providerAuthority === 'JCVITAL_NATIVE' && observation.provenance.sourceDataType !== contract.vendorDataType) {
    throw new ActivityAuthorityError(`${observation.metric} must come from Type${contract.vendorDataType}, not Type${observation.provenance.sourceDataType}.`)
  }
  if (contract.authority === 'DAILY' && observation.provenance.sourceDataType === '25') {
    throw new ActivityAuthorityError(`Daily ${observation.metric} is never derived from Type25.`)
  }
}

/** Applies canonical observations to a ledger; returns a new state (input is not mutated). */
export function applyActivityCanonicalObservations(state: ActivityLedgerState, observations: readonly ActivityCanonicalObservation[]): {
  state: ActivityLedgerState
  outcomes: Array<{ canonicalIdentityKey: string; metric: ActivityCanonicalMetric; outcome: ActivityLedgerOutcome }>
} {
  const next: ActivityLedgerState = structuredClone(state)
  const outcomes: Array<{ canonicalIdentityKey: string; metric: ActivityCanonicalMetric; outcome: ActivityLedgerOutcome }> = []
  for (const observation of observations) {
    const record = (outcome: ActivityLedgerOutcome) => outcomes.push({ canonicalIdentityKey: observation.canonicalIdentityKey, metric: observation.metric, outcome })
    try {
      assertActivityAuthority(observation)
    } catch (error) {
      if (!(error instanceof ActivityAuthorityError)) throw error
      record('REJECTED_DAILY_AUTHORITY')
      continue
    }
    const ref = sourceRef(observation)
    const activeKey = next.measurements[observation.measurementKey]
    const active = activeKey ? next.rows[activeKey] : undefined
    if (active && active.observation.providerAuthority !== observation.providerAuthority) {
      if (AUTHORITY_RANK[observation.providerAuthority] < AUTHORITY_RANK[active.observation.providerAuthority]) {
        if (!active.supersededSources.some((entry) => entry.sourcePayloadFingerprint === ref.sourcePayloadFingerprint && entry.sourceRecordId === ref.sourceRecordId)) {
          active.supersededSources.push(ref)
        }
        record('SUPERSEDED_BY_HIGHER_AUTHORITY')
        continue
      }
      delete next.rows[active.observation.canonicalIdentityKey]
      next.rows[observation.canonicalIdentityKey] = {
        observation, revision: 1, ancestry: [ref], sourceConflict: false, conflictingSources: [],
        supersededSources: [...active.supersededSources, ...active.ancestry],
      }
      next.measurements[observation.measurementKey] = observation.canonicalIdentityKey
      record('REPLACED_LOWER_AUTHORITY')
      continue
    }
    const existing = next.rows[observation.canonicalIdentityKey]
    if (!existing) {
      next.rows[observation.canonicalIdentityKey] = { observation, revision: 1, ancestry: [ref], sourceConflict: false, conflictingSources: [], supersededSources: [] }
      next.measurements[observation.measurementKey] = observation.canonicalIdentityKey
      record('CREATED')
      continue
    }
    const intraday = ACTIVITY_METRIC_CONTRACTS[observation.metric].authority === 'INTRADAY'
    const sameSource = intraday
      ? existing.ancestry.some((entry) => entry.sourcePayloadFingerprint === ref.sourcePayloadFingerprint)
        || existing.conflictingSources.some((entry) => entry.sourcePayloadFingerprint === ref.sourcePayloadFingerprint)
      : existing.observation.provenance.sourcePayloadFingerprint === ref.sourcePayloadFingerprint
    if (sameSource) {
      if (!intraday && Date.parse(ref.receivedAt) > Date.parse(existing.observation.provenance.receivedAt)) {
        existing.observation = observation
        existing.ancestry.push(ref)
      }
      if (!intraday && observation.dailyState === 'FINAL') existing.observation.dailyState = 'FINAL'
      record('DUPLICATE')
      continue
    }
    if (intraday) {
      existing.sourceConflict = true
      existing.conflictingSources.push(ref)
      record('CONFLICT_PRESERVED')
      continue
    }
    if (Date.parse(ref.receivedAt) < Date.parse(existing.observation.provenance.receivedAt)) {
      existing.ancestry.push(ref)
      record('STALE_READ_IGNORED')
      continue
    }
    const wasInProgress = existing.observation.dailyState === 'IN_PROGRESS'
    existing.observation = observation
    existing.revision += 1
    existing.ancestry.push(ref)
    record(wasInProgress || observation.dailyState === 'IN_PROGRESS' ? 'UPDATED_IN_PROGRESS' : 'CORRECTED_HISTORICAL')
  }
  return { state: next, outcomes }
}

export function activeActivityObservations(state: ActivityLedgerState): ActivityCanonicalObservation[] {
  return Object.values(state.rows).map((row) => row.observation)
    .sort((a, b) => a.observedAt.localeCompare(b.observedAt) || a.metric.localeCompare(b.metric) || a.canonicalIdentityKey.localeCompare(b.canonicalIdentityKey))
}

// ---------------------------------------------------------------------------------------------
// Base44 NativeObservationInput projection (prepared; delivery activation is behind the Base44 publish gate).
// ---------------------------------------------------------------------------------------------

export async function toActivityNativeObservationInput(ownerUserId: string, observation: ActivityCanonicalObservation): Promise<NativeObservationInput> {
  const p = observation.provenance
  const slot = p.sourceArraySlotIndex ?? 0
  const input: NativeObservationInput = {
    observationId: await sha256Hex(`${ownerUserId}:${p.sourceRecordId}:${observation.metric}:${slot}:${p.sourcePayloadFingerprint}`),
    source: JCVITAL_NATIVE_SOURCE.source,
    provider: JCVITAL_NATIVE_SOURCE.sourceProvider,
    metric: observation.canonicalTarget,
    metricType: observation.metric,
    valueNumber: observation.value,
    unit: observation.unit,
    startTime: observation.observedAt,
    endTime: observation.endAt,
    capturedAt: p.receivedAt,
    timezone: p.timezone,
    sourceRecordId: `${p.sourceRecordId}|${observation.metric}|${slot}`,
    sourceRecordGroupId: p.sourceRecordId,
    sourceId: p.deviceScopeId,
    deviceId: p.deviceScopeId,
    deviceManufacturer: JCVITAL_NATIVE_SOURCE.deviceManufacturer,
    deviceModel: p.deviceModel,
    sourceConnector: JCVITAL_NATIVE_SOURCE.sourceConnector,
    sourceProvider: JCVITAL_NATIVE_SOURCE.sourceProvider,
    sourcePath: JCVITAL_NATIVE_SOURCE.sourcePath,
    acquisitionMode: 'HISTORICAL_SYNC',
    measurementContext: observation.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS' ? 'ACTIVITY_MINUTE_EPOCH' : 'DAILY_ACTIVITY',
    ...(p.acquisitionSessionId ? { sessionId: p.acquisitionSessionId } : {}),
    observedAt: observation.observedAt,
    observedAtSource: p.sourceType25VendorDate ?? p.observedLocalDate,
    timestampSource: observation.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS' ? 'TYPE25_DATE_PLUS_SLOT_MINUTES' : 'TYPE24_DEVICE_LOCAL_DATE',
    timestampConfidence: observation.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS' ? 'MANUAL_ADJUDICATED_PHYSICAL_HIGH_CONFIDENCE' : 'DEVICE_LOCAL_CALENDAR_DATE',
    timestampTimezoneSource: p.timezoneSource,
    receivedAt: p.receivedAt,
    firmwareVersion: p.firmwareVersion,
    sdkVersion: p.sdkVersion,
    vendorDataType: p.sourceDataType,
    vendorField: p.sourceField,
    vendorDerived: p.vendorDerived,
    sequenceNumber: slot,
    ...(observation.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS' ? { samplingIntervalMs: 60_000 } : {}),
    rawSourceMetadata: {
      canonicalPolicy: 'CANONICAL',
      canonicalTarget: observation.canonicalTarget,
      canonicalIdentityKey: observation.canonicalIdentityKey,
      consumerLabel: observation.consumerLabel,
      dailyState: observation.dailyState ?? null,
      sourceLocalDate: observation.sourceLocalDate,
      vendorDataType: p.sourceDataType,
      vendorField: p.sourceField,
      vendorRawValue: observation.vendorRawValue,
      vendorDerived: p.vendorDerived,
      measured: p.measured,
      semanticConfidence: p.semanticConfidence,
      semanticPolicyId: p.semanticPolicyId,
      normalizerVersion: p.normalizerVersion,
      sourceEnvelopeId: p.sourceEnvelopeId,
      sourcePayloadFingerprint: p.sourcePayloadFingerprint,
      acquisitionSessionId: p.acquisitionSessionId,
      observedLocalDate: p.observedLocalDate,
      observedLocalTime: p.observedLocalTime,
      timezoneSource: p.timezoneSource,
      sourceType25VendorDate: p.sourceType25VendorDate ?? null,
      sourceArraySlotIndex: p.sourceArraySlotIndex ?? null,
      resolvedMinuteTimestamp: p.resolvedMinuteTimestamp ?? null,
      vendor_exercise_duration_seconds: observation.vendor_exercise_duration_seconds ?? null,
      vendor_exercise_duration_minutes: observation.vendor_exercise_duration_minutes ?? null,
    },
  }
  const problems = validatePhysiologyObservation(input)
  if (problems.length) throw new Error(`Activity canonical projection invalid: ${problems.join('; ')}`)
  return input
}

/**
 * Production Activity canonicalization entry point: native normalizer output → source records →
 * Type24/Type25 canonical observations → ledger (upsert/dedup/conflict/authority).
 * It performs no acquisition, enqueue, delivery, readiness or scoring.
 */
export async function canonicalizeActivity(
  natives: readonly NativeObservation[],
  context: ActivityDeviceContext,
  ledger: ActivityLedgerState,
  nowMs: number,
) {
  const sources = activitySourceRecordsFromNative(natives)
  const perSource = await Promise.all(sources.map((source) => mapActivitySourceRecords([source], context, nowMs)))
  const mapped = { observations: perSource.flatMap((result) => result.observations), withheld: perSource.flatMap((result) => result.withheld) }
  const applied = applyActivityCanonicalObservations(ledger, mapped.observations)
  // Additive upgrade for ledgers written before durable source/withheld annotations.
  applied.state.sourceRecords ??= {}
  for (const [index, source] of sources.entries()) {
    const fingerprint = await sha256Hex(stableJson(source.record))
    const vendorDate = typeof source.record.date === 'string' ? source.record.date : ''
    const sourceRecordId = sourceRecordIdFor(context.deviceId ?? '', source.vendorDataType, vendorDate)
    const key = stableJson([sourceRecordId, source.sourceEnvelopeId, fingerprint])
    applied.state.sourceRecords[key] ??= {
      source: structuredClone(source), context: { ...context }, sourceRecordId, fingerprint,
      withheld: perSource[index].withheld,
      sourceConflict: false,
    }
    if (source.vendorDataType !== '25') continue
    const siblings = Object.values(applied.state.sourceRecords).filter((entry) => entry.sourceRecordId === sourceRecordId)
    if (new Set(siblings.map((entry) => entry.fingerprint)).size > 1) {
      siblings.forEach((entry) => { entry.sourceConflict = true })
      for (const row of Object.values(applied.state.rows)) {
        if (row.observation.provenance.sourceRecordId === sourceRecordId) row.sourceConflict = true
      }
    }
  }
  return { sources, observations: mapped.observations, withheld: mapped.withheld, ledger: applied.state, outcomes: applied.outcomes }
}
