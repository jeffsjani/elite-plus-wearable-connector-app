import type { NativeObservationInput } from '../../services/base44/base44Types'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import {
  ACTIVITY_NORMALIZER_VERSION,
  ACTIVITY_TIMEZONE_SOURCE,
  TYPE24_DAILY_POLICY_ID,
  mapActivitySourceRecords,
  zonedLocalToEpochMs,
  type ActivityDeviceContext,
  type ActivitySourceRecord,
} from './ActivityProductionCanonical'
import { sha256Hex } from './HeartRateSeries'
import { validatePhysiologyObservation } from './PhysiologyContract'
import { TYPE25_MINUTE_ANCHOR_POLICY_ID, expandType25Segment } from './Type25MinuteAnchorPolicy'
import { JCVITAL_NATIVE_SOURCE } from './WorkoutHrDelivery'

export const ACTIVITY_NATIVE_TRANSPORT_V2 = 'jcvital.native.activity.transport.v2'
export const ACTIVITY_V2_CAPABILITY = 'JCVITAL_ACTIVITY_TRANSPORT_V2'
export const ACTIVITY_V2_PRODUCTION_ENABLED = true as const
export const ACTIVITY_V2_LIMITS = Object.freeze({
  metadataString: 512,
  metadataKey: 64,
  metadataEntries: 64,
  payloadBytes: 16_384,
  sourceString: 256,
})

type Metadata = NonNullable<NativeObservationInput['rawSourceMetadata']>

export class ActivityTransportContractError extends Error {}

function fail(message: string): never { throw new ActivityTransportContractError(message) }

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > ACTIVITY_V2_LIMITS.sourceString) {
    fail(`${name} must be a non-empty string of at most ${ACTIVITY_V2_LIMITS.sourceString} characters; evidence is never truncated.`)
  }
  return value
}

function numeric(value: unknown, name: string, integer = false): number {
  const parsed = typeof value === 'number' ? value
    : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value) ? Number(value) : Number.NaN
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > Number.MAX_SAFE_INTEGER || (integer && !Number.isSafeInteger(parsed))) {
    fail(`${name} must be a non-negative ${integer ? 'safe integer' : 'finite number'}. Preserve the source; do not enqueue a partial v2 payload.`)
  }
  return parsed
}

function localDateTime(source: ActivitySourceRecord): { vendorDate: string; localDate: string; epochMs: number } {
  const vendorDate = text(source.record.date, 'device date')
  const pattern = source.vendorDataType === '24'
    ? /^(\d{4})[.-](\d{2})[.-](\d{2})$/
    : /^(\d{4})[.-](\d{2})[.-](\d{2}) (\d{2}):(\d{2}):(\d{2})$/
  const match = pattern.exec(vendorDate)
  if (!match) fail('Invalid device-local Activity date.')
  const [year, month, day, hour = 0, minute = 0, second = 0] = match.slice(1).map(Number)
  const epochMs = zonedLocalToEpochMs({ year, month, day, hour, minute, second }, text(source.timezone, 'timezone'))
  if (epochMs === null) fail('Activity date/time or timezone is invalid; receipt time must not be substituted.')
  return { vendorDate, localDate: `${match[1]}-${match[2]}-${match[3]}`, epochMs }
}

export function assertActivityV2PayloadLimits(payload: NativeObservationInput): void {
  const metadata = payload.rawSourceMetadata ?? {}
  if (Object.keys(metadata).length > ACTIVITY_V2_LIMITS.metadataEntries) fail('Activity v2 metadata entry limit exceeded.')
  for (const [key, value] of Object.entries(metadata)) {
    if (key.length > ACTIVITY_V2_LIMITS.metadataKey
      || (typeof value === 'string' && value.length > ACTIVITY_V2_LIMITS.metadataString)
      || (typeof value === 'number' && !Number.isFinite(value))) {
      fail(`Activity v2 metadata limit exceeded for ${key}; evidence is never truncated.`)
    }
  }
  if (new TextEncoder().encode(JSON.stringify(payload)).length > ACTIVITY_V2_LIMITS.payloadBytes) {
    fail('Activity v2 payload byte limit exceeded; evidence is never truncated.')
  }
}

/**
 * Offline preparation only. Returns ordinary existing-queue payloads; does not enqueue, acquire or send.
 * The caller retains the original source even when a contract error prevents lossless representation.
 */
export async function prepareActivityNativeTransportV2(source: ActivitySourceRecord, context: ActivityDeviceContext) {
  if (!context.ownerUserId.trim() || !isOpaqueJCVitalDeviceId(context.deviceId)) fail('Authenticated owner and opaque device scope are required.')
  const deviceId = context.deviceId
  const deviceModel = text(context.deviceModel, 'deviceModel')
  const firmwareVersion = text(context.firmwareVersion, 'firmwareVersion')
  const sdkVersion = text(context.sdkVersion, 'sdkVersion')
  const envelopeId = text(source.sourceEnvelopeId, 'sourceEnvelopeId')
  const sessionId = text(source.acquisitionSessionId, 'acquisitionSessionId')
  const { vendorDate, localDate, epochMs } = localDateTime(source)
  const timezone = text(source.timezone, 'timezone')
  text(source.receivedAt, 'receivedAt')
  if (Number.isNaN(Date.parse(source.receivedAt))) fail('Invalid source receivedAt.')
  const groupId = `${JCVITAL_NATIVE_SOURCE.sourceConnector}:${deviceModel}:${deviceId}:${source.vendorDataType}:${vendorDate}`
  const fingerprint = await sha256Hex(JSON.stringify(Object.fromEntries(Object.entries(source.record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))))
  const base: Metadata = {
    activityTransportVersion: ACTIVITY_NATIVE_TRANSPORT_V2,
    sourceDataType: Number(source.vendorDataType),
    sourceLocalDate: localDate, timezone, timezoneSource: ACTIVITY_TIMEZONE_SOURCE,
    sourceEnvelopeId: envelopeId, sourceRecordGroupId: groupId, acquisitionSessionId: sessionId,
    deviceScopeId: deviceId, deviceModel, firmwareVersion, sdkVersion,
    semanticPolicyVersion: source.vendorDataType === '24' ? TYPE24_DAILY_POLICY_ID : TYPE25_MINUTE_ANCHOR_POLICY_ID,
    normalizerVersion: ACTIVITY_NORMALIZER_VERSION,
    sourcePayloadFingerprint: fingerprint,
    canonicalPolicy: 'NATIVE_ONLY',
  }
  const payloads: NativeObservationInput[] = []
  async function scalar(metric: string, field: string, value: number, unit: string, extra: Metadata = {}, slot?: number) {
    const sourceRecordId = `${groupId}|${metric}|${slot ?? 'record'}`
    const observedAt = new Date(epochMs + (slot ?? 0) * 60_000).toISOString()
    const payload: NativeObservationInput = {
      observationId: await sha256Hex(`${context.ownerUserId}:${sourceRecordId}:${fingerprint}:${ACTIVITY_NATIVE_TRANSPORT_V2}`),
      source: JCVITAL_NATIVE_SOURCE.source, provider: JCVITAL_NATIVE_SOURCE.sourceProvider,
      sourceConnector: JCVITAL_NATIVE_SOURCE.sourceConnector, sourceProvider: JCVITAL_NATIVE_SOURCE.sourceProvider,
      sourcePath: JCVITAL_NATIVE_SOURCE.sourcePath, deviceManufacturer: JCVITAL_NATIVE_SOURCE.deviceManufacturer,
      deviceId, sourceId: deviceId, deviceModel, firmwareVersion, sdkVersion,
      metric, metricType: metric, valueNumber: value, unit,
      startTime: observedAt, observedAt, observedAtSource: vendorDate,
      capturedAt: source.receivedAt, receivedAt: source.receivedAt, timezone,
      timestampSource: source.vendorDataType === '24' ? 'TYPE24_DEVICE_LOCAL_DATE' : 'TYPE25_DATE_PLUS_SLOT_MINUTES',
      timestampConfidence: source.vendorDataType === '24' ? 'DEVICE_LOCAL_CALENDAR_DATE'
        : extra.type25IntegrityStatus === 'FAIL' ? 'SOURCE_ONLY_UNQUALIFIED' : 'MANUAL_ADJUDICATED_PHYSICAL_HIGH_CONFIDENCE',
      timestampTimezoneSource: ACTIVITY_TIMEZONE_SOURCE, acquisitionMode: 'HISTORICAL_SYNC',
      measurementContext: source.vendorDataType === '24' ? 'DAILY_ACTIVITY' : 'DETAIL_ACTIVITY_BLOCK',
      sessionId, sourceRecordId, sourceRecordGroupId: groupId,
      vendorDataType: source.vendorDataType, vendorField: field,
      vendorDerived: extra.vendorDerived === true,
      ...(slot === undefined ? {} : { sequenceNumber: slot, samplingIntervalMs: 60_000 }),
      rawSourceMetadata: { ...base, sourceRecordId, sourceField: field, vendorRawValue: String(source.record[field]), ...extra },
    }
    assertActivityV2PayloadLimits(payload)
    const problems = validatePhysiologyObservation(payload)
    if (problems.length) fail(`Invalid Activity v2 queue input: ${problems.join('; ')}`)
    payloads.push(payload)
  }
  if (source.vendorDataType === '24') {
    const fields = [
      ['DAILY_STEPS', 'step', 'count', false, true],
      ['DAILY_DISTANCE', 'distance', 'km', true, false],
      ['DAILY_CALORIES', 'calories', 'kcal', true, false],
      ['DAILY_EXERCISE_DURATION', 'exerciseMinutes', 'second', true, false],
    ] as const
    for (const [metric, field, unit, vendorDerived, measured] of fields) {
      if (source.record[field] === undefined) continue
      const value = numeric(source.record[field], field, field === 'step' || field === 'exerciseMinutes')
      const extra: Metadata = {
        vendorDerived, measured, canonicalEligible: true,
        semanticConfidence: vendorDerived ? 'VENDOR_DERIVED' : 'HIGH',
      }
      if (field === 'exerciseMinutes') Object.assign(extra, {
        rawUnit: 'second', normalizedMinutes: value / 60, semanticLabel: 'V8 Exercise Duration',
      })
      if (field === 'calories') extra.semanticLabel = 'Activity Calories / Activity Energy'
      await scalar(metric, field, value, unit, extra)
    }
  } else {
    const raw = source.record.arraySteps
    const tokens: unknown[] = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.trim().split(/\s+/).filter(Boolean) : fail('arraySteps must be an integer array or SDK space-delimited string.')
    const steps = tokens.map((value) => numeric(value, 'arraySteps', true))
    const serialized = steps.join(',')
    if (serialized.length > ACTIVITY_V2_LIMITS.metadataString) fail('Complete Type25 array exceeds metadata limit; preserve source and stop, never truncate.')
    const declared = numeric(source.record.detailMinterStep, 'detailMinterStep', true)
    const expansion = expandType25Segment({
      sourceEnvelopeId: envelopeId, dateEpochMs: epochMs, arraySteps: steps, detailMinterStep: declared,
    }, { deviceModel, firmwareVersion, sdkVersion })
    const pass = expansion.status === 'EXPANDED'
    const integrity: Metadata = {
      type25IntegrityStatus: pass ? 'PASS' : 'FAIL',
      ...(pass ? { type25ArraySum: steps.reduce((sum, value) => sum + value, 0) }
        : { type25IntegrityReason: expansion.reason }),
    }
    const evidence: Metadata = {
      ...integrity, type25VendorDate: vendorDate,
      type25DetailMinterStep: typeof source.record.detailMinterStep === 'string' ? source.record.detailMinterStep : declared,
      type25ArraySteps: serialized, type25ArrayLength: steps.length,
      semanticPolicy: TYPE25_MINUTE_ANCHOR_POLICY_ID,
      dateMeaning: 'FIRST_MINUTE', arrayOrdering: 'OLDEST_TO_NEWEST', slotDurationSeconds: 60, segmentSlots: 10,
    }
    // Empty invalid arrays still need a source-preserving carrier, not a fabricated zero epoch.
    for (const [slot, value] of steps.entries()) {
      await scalar('DETAILED_ACTIVITY_EPOCH', 'arraySteps', value, 'count', {
        ...(slot === 0 ? evidence : integrity), segmentAnchor: slot === 0,
        canonicalEligible: pass && slot === 0, vendorDerived: false, measured: true, semanticConfidence: pass ? 'HIGH' : 'WITHHELD',
      }, slot)
    }
  }
  const reference = await mapActivitySourceRecords([source], context, Date.parse(source.receivedAt))
  return { source: structuredClone(source), payloads, reference }
}

export interface ActivityV2HandshakeScope {
  ownerUserId: string
  installId: string
  connectorDeviceId: string
}

export function extractActivityV2RegistrationEnvelope(response: unknown): Record<string, unknown> | null {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return null
  const root = response as Record<string, unknown>
  if (root.success === false) return root
  if (typeof root.installId === 'string' && typeof root.connectorDeviceId === 'string') return root
  for (const key of ['data', 'result']) {
    const nested = extractActivityV2RegistrationEnvelope(root[key])
    if (nested) return nested
  }
  return root
}

function advertisesActivityV2(response: unknown): boolean {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return false
  const candidate = response as Record<string, unknown>
  for (const field of ['SERVER_CAPABILITIES', 'serverCapabilities', 'server_capabilities', 'capabilities']) {
    const value = candidate[field]
    if (Array.isArray(value) && value.includes(ACTIVITY_V2_CAPABILITY)) return true
  }
  const capabilities = candidate.capabilities
  if (capabilities && typeof capabilities === 'object' && !Array.isArray(capabilities)
    && (capabilities as Record<string, unknown>)[ACTIVITY_V2_CAPABILITY] === ACTIVITY_NATIVE_TRANSPORT_V2) return true
  return advertisesActivityV2(candidate.data) || advertisesActivityV2(candidate.result)
}

export function isActivityNativeTransportV2(payload: NativeObservationInput): boolean {
  return payload.rawSourceMetadata?.activityTransportVersion === ACTIVITY_NATIVE_TRANSPORT_V2
}

/** Enables v2 only for an exact, fresh registration response in the current account/install/device scope. */
export function activityV2CapabilityDecision(
  response: unknown,
  capturedScope: ActivityV2HandshakeScope,
  currentScope: ActivityV2HandshakeScope,
  receivedAtMs: number,
  nowMs: number,
  productionEnvironmentValid: boolean,
): {
  capabilitySupported: boolean
  productionDeliveryEnabled: boolean
  reason: string
  predicates: ActivityV2CapabilityPredicates
} {
  const r = extractActivityV2RegistrationEnvelope(response)
  const predicates: ActivityV2CapabilityPredicates = {
    registrationResponseAvailable: r !== null,
    registrationSuccess: r?.success === true,
    registrationStatusValid: r?.status === 'active' || r?.status === 'registered',
    productionEnvironmentValid,
    capabilityRawPresent: advertisesActivityV2(response),
    capabilityRecognized: advertisesActivityV2(response),
    scopeValid: Boolean(capturedScope.ownerUserId && capturedScope.installId && capturedScope.connectorDeviceId)
      && capturedScope.ownerUserId === currentScope.ownerUserId
      && capturedScope.installId === currentScope.installId
      && capturedScope.connectorDeviceId === currentScope.connectorDeviceId,
    contractValid: typeof r?.registeredAt === 'string' && Number.isFinite(Date.parse(r.registeredAt))
      && typeof r.serverTimestamp === 'string' && Number.isFinite(Date.parse(r.serverTimestamp))
      && Array.isArray(r.sources) && r.sources.every((source) => typeof source === 'string'),
    registrationIdentityValid: Boolean(r)
      && r?.installId === capturedScope.installId
      && r?.connectorDeviceId === capturedScope.connectorDeviceId,
    freshnessValid: Number.isFinite(nowMs) && Number.isFinite(receivedAtMs)
      && nowMs >= receivedAtMs && nowMs - receivedAtMs <= 300_000,
  }
  const blocked = (reason: string) => ({
    capabilitySupported: false,
    productionDeliveryEnabled: false,
    reason,
    predicates,
  })
  if (!predicates.registrationResponseAvailable) return blocked('REGISTRATION_RESPONSE_UNAVAILABLE')
  if (!predicates.productionEnvironmentValid) return blocked('PRODUCTION_ENVIRONMENT_MISMATCH')
  if (!predicates.scopeValid) return blocked('HANDSHAKE_SCOPE_MISMATCH')
  if (!predicates.freshnessValid) return blocked('HANDSHAKE_STALE')
  if (!predicates.registrationSuccess) return blocked('REGISTRATION_FAILED')
  if (!predicates.registrationStatusValid) return blocked('REGISTRATION_STATUS_INVALID')
  if (!predicates.registrationIdentityValid) return blocked('REGISTRATION_IDENTITY_MISMATCH')
  if (!predicates.contractValid) return blocked('REGISTRATION_CONTRACT_INVALID')
  if (!predicates.capabilityRecognized) return blocked('CAPABILITY_ABSENT')
  return {
    capabilitySupported: true,
    productionDeliveryEnabled: ACTIVITY_V2_PRODUCTION_ENABLED,
    reason: 'CAPABILITY_SUPPORTED',
    predicates,
  }
}

export interface ActivityV2CapabilityPredicates {
  registrationResponseAvailable: boolean
  registrationSuccess: boolean
  registrationStatusValid: boolean
  productionEnvironmentValid: boolean
  capabilityRawPresent: boolean
  capabilityRecognized: boolean
  scopeValid: boolean
  contractValid: boolean
  registrationIdentityValid: boolean
  freshnessValid: boolean
}
