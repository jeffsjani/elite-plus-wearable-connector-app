import {
  readActivitySource,
  type ActivitySource,
} from './Activity24_25Certification'
import {
  ACTIVITY_NATIVE_TRANSPORT_V2,
  prepareActivityNativeTransportV2,
} from './ActivityNativeTransportV2'
import {
  ACTIVITY_V2_VERIFICATION_SCOPE,
  prepareActivityNativeTransportV2Sources,
} from './ActivityNativeTransportV2Delivery'
import type {
  ActivityDeviceContext,
  ActivitySourceRecord,
} from './ActivityProductionCanonical'
import {
  JCVitalV8,
  type RecentActivitySourceCandidate,
  type SourceJournalScope,
} from './jcvitalV8Bridge'

const VERIFY_METRICS = [
  'DAILY_STEPS',
  'DAILY_DISTANCE',
  'DAILY_CALORIES',
  'DAILY_EXERCISE_DURATION',
] as const
const MAX_SOURCE_CANDIDATES_PER_TYPE = 25

type RecordEnvelope = {
  envelopeId: string
  kind: string
  vendorDataType?: string
  acquisitionMode?: string
  sourceDate?: string | null
  candidateEntry: RecentActivitySourceCandidate
}

export interface ActivityV2SelectedSource {
  source: ActivitySourceRecord
  details: {
    sourceEnvelopeId: string
    sourceDate: string | null
    receivedAt: string
    provider: string
    deviceScopeId: string | null
    deviceModel: string | null
    acquisitionMode: string | null
    firmwareVersion: string | null
    sdkVersion: string | null
    fields: Record<string, unknown>
    timezone: string | null
    qualification?: {
      status: 'PASS' | 'FAIL'
      reason: string | null
      arrayLength: number | null
      arraySum: number | null
      declaredTotal: unknown
    }
  }
}

export interface ActivityV2PreparedVerification {
  type24: ActivityV2SelectedSource | null
  type25: ActivityV2SelectedSource | null
  type25Candidate: ActivityV2SelectedSource | null
  payloads: Awaited<ReturnType<typeof prepareActivityNativeTransportV2Sources>>['payloads']
  warnings: string[]
  type24FailureReason: string | null
  type25FailureReason: string | null
  selectionValid: boolean
  sourceQueryMode: 'TARGETED_RECENT_CANDIDATES'
  type24CandidatesRead: number
  type25CandidatesRead: number
  type24SelectedIndex: number | null
  type25SelectedIndex: number | null
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function sourceRecord(source: ActivitySource): ActivitySourceRecord {
  const record: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(source.fields)) {
    const value = object(raw)
    if (typeof value.type !== 'string' || !('value' in value)) continue
    record[name] = value.value
  }
  const dataType = String(source.record.vendorDataType)
  if (dataType !== '24' && dataType !== '25') throw new Error('Saved Activity source type is unsupported.')
  const receivedAt = String(source.record.receivedAt ?? '')
  const timezone = String(source.record.timezone ?? '')
  return {
    vendorDataType: dataType,
    record,
    sourceEnvelopeId: source.sourceEnvelopeId,
    acquisitionSessionId: String(source.record.sessionId ?? ''),
    nativeObservationIds: [source.sourceEnvelopeId],
    nativeSourceRecordIds: [source.sourceEnvelopeId],
    parserVersion: typeof source.record.parserVersion === 'string' ? source.record.parserVersion : null,
    receivedAt,
    timezone,
  }
}

function hasDailyEvidence(source: ActivitySourceRecord): boolean {
  return source.vendorDataType === '24'
    && ['step', 'distance', 'calories', 'exerciseMinutes'].every((field) => source.record[field] !== undefined)
}

function makeSelectedSource(
  source: ActivitySourceRecord,
  envelope: RecordEnvelope,
  sourceEnvelope: Record<string, unknown>,
  context: ActivityDeviceContext,
): ActivityV2SelectedSource {
  return {
    source,
    details: {
      sourceEnvelopeId: source.sourceEnvelopeId ?? '',
      sourceDate: typeof sourceEnvelope.date === 'string'
        ? sourceEnvelope.date : typeof envelope.sourceDate === 'string' ? envelope.sourceDate : null,
      receivedAt: source.receivedAt,
      provider: typeof sourceEnvelope.provider === 'string' ? sourceEnvelope.provider : 'JCVITAL',
      deviceScopeId: typeof sourceEnvelope.deviceScopeId === 'string' ? sourceEnvelope.deviceScopeId : context.deviceId,
      deviceModel: typeof sourceEnvelope.deviceModel === 'string' ? sourceEnvelope.deviceModel : context.deviceModel,
      acquisitionMode: typeof sourceEnvelope.acquisitionMode === 'string'
        ? sourceEnvelope.acquisitionMode : envelope.acquisitionMode ?? null,
      firmwareVersion: typeof sourceEnvelope.firmwareVersion === 'string' ? sourceEnvelope.firmwareVersion : null,
      sdkVersion: typeof sourceEnvelope.sdkVersion === 'string' ? sourceEnvelope.sdkVersion : null,
      fields: source.record,
      timezone: source.timezone,
    },
  }
}

function validateCandidates(
  candidates: readonly RecentActivitySourceCandidate[],
  type: '24' | '25',
  scope: SourceJournalScope,
): RecordEnvelope[] {
  if (candidates.length > MAX_SOURCE_CANDIDATES_PER_TYPE) {
    throw new Error(`Targeted Activity query returned more than ${MAX_SOURCE_CANDIDATES_PER_TYPE} Type${type} candidates.`)
  }
  let previousSequence = Number.POSITIVE_INFINITY
  const seenIds = new Set<string>()
  return candidates.map((candidate) => {
    if (!Number.isSafeInteger(candidate.sequence) || candidate.sequence >= previousSequence
      || !candidate.envelopeId || seenIds.has(candidate.envelopeId) || candidate.kind !== 'SDK_RECORD'
      || typeof candidate.envelopeJson !== 'string') {
      throw new Error(`Targeted Type${type} candidates were malformed, duplicated, or not newest-first.`)
    }
    previousSequence = candidate.sequence
    seenIds.add(candidate.envelopeId)
    const envelope = JSON.parse(candidate.envelopeJson) as Record<string, unknown>
    if (envelope.kind !== 'SDK_RECORD' || envelope.envelopeId !== candidate.envelopeId
      || envelope.accountId !== scope.accountId || envelope.deviceScopeId !== scope.deviceScopeId
      || envelope.vendorDataType !== type || envelope.acquisitionMode !== 'HISTORICAL_SYNC') {
      throw new Error(`Targeted Type${type} source ${candidate.envelopeId} failed its identity or query-scope check.`)
    }
    return {
      envelopeId: candidate.envelopeId,
      kind: candidate.kind,
      vendorDataType: type,
      acquisitionMode: 'HISTORICAL_SYNC',
      sourceDate: typeof envelope.sourceDate === 'string' ? envelope.sourceDate : null,
      candidateEntry: candidate,
    }
  })
}

async function savedActivityEnvelopes(
  scope: SourceJournalScope,
  journal: typeof JCVitalV8,
): Promise<{ entries: RecordEnvelope[]; type24CandidatesRead: number; type25CandidatesRead: number }> {
  const response = await journal.getRecentActivitySourceCandidates({ ...scope, perTypeLimit: MAX_SOURCE_CANDIDATES_PER_TYPE })
  if (response.queryMode !== 'TARGETED_RECENT_CANDIDATES' || response.perTypeLimit !== MAX_SOURCE_CANDIDATES_PER_TYPE
    || response.includePayload !== true || response.sortOrder !== 'sequence_desc') {
    throw new Error('Native Activity source query did not satisfy the targeted payload-bearing candidate contract.')
  }
  const type24 = validateCandidates(response.type24Candidates, '24', scope)
  const type25 = validateCandidates(response.type25Candidates, '25', scope)
  return {
    entries: [...type24, ...type25],
    type24CandidatesRead: type24.length,
    type25CandidatesRead: type25.length,
  }
}

async function readCandidates(
  scope: SourceJournalScope,
  entries: readonly RecordEnvelope[],
  type: '24' | '25',
  journal: typeof JCVitalV8,
): Promise<{ sources: Array<{ source: ActivitySourceRecord; envelope: RecordEnvelope; sourceEnvelope: Record<string, unknown> }>; warnings: string[] }> {
  const candidates = entries.filter((entry) => entry.vendorDataType === type
    && entry.acquisitionMode === 'HISTORICAL_SYNC')
  candidates.sort((left, right) => String(right.sourceDate ?? '').localeCompare(String(left.sourceDate ?? '')))
  const sources: Array<{ source: ActivitySourceRecord; envelope: RecordEnvelope; sourceEnvelope: Record<string, unknown> }> = []
  const warnings: string[] = []
  for (const candidate of candidates.slice(0, MAX_SOURCE_CANDIDATES_PER_TYPE)) {
    try {
      const source = await readActivitySource(journal, scope, candidate.envelopeId, candidate.candidateEntry)
      sources.push({ source: sourceRecord(source), envelope: candidate, sourceEnvelope: object(source.record) })
    } catch (error) {
      warnings.push(`${candidate.envelopeId}: ${describeError(error)}`)
    }
  }
  return { sources, warnings }
}

export async function prepareActivityV2Verification(
  scope: SourceJournalScope,
  context: ActivityDeviceContext,
  journal: typeof JCVitalV8 = JCVitalV8,
): Promise<ActivityV2PreparedVerification> {
  const query = await savedActivityEnvelopes(scope, journal)
  const dailyRead = await readCandidates(scope, query.entries, '24', journal)
  const warnings = [...dailyRead.warnings]
  let type24: ActivityV2SelectedSource | null = null
  let type24SelectedIndex: number | null = null
  let type24FailureReason: string | null = null
  const dailySelectionCandidates = dailyRead.sources.filter(({ source }) => hasDailyEvidence(source))
  for (const [candidateIndex, candidate] of dailySelectionCandidates.entries()) {
    try {
      const prepared = await prepareActivityNativeTransportV2(candidate.source, context)
      if (prepared.payloads.length === VERIFY_METRICS.length
        && VERIFY_METRICS.every((metric) => prepared.payloads.some((payload) => payload.metric === metric))) {
        type24 = makeSelectedSource(candidate.source, candidate.envelope, candidate.sourceEnvelope, context)
        type24SelectedIndex = candidateIndex
        break
      }
      type24FailureReason = 'Source did not prepare the exact four daily verification metrics.'
      warnings.push(`${candidate.source.sourceEnvelopeId}: ${type24FailureReason}`)
    } catch (error) {
      type24FailureReason = describeError(error)
      warnings.push(`${candidate.source.sourceEnvelopeId}: ${type24FailureReason}`)
    }
  }
  if (!type24) {
    type24FailureReason ??= 'No valid Type24 source found: no persisted record contains the four required daily measurements.'
  }

  const detailRead = await readCandidates(scope, query.entries, '25', journal)
  warnings.push(...detailRead.warnings)
  let type25: ActivityV2SelectedSource | null = null
  let type25SelectedIndex: number | null = null
  let type25Candidate: ActivityV2SelectedSource | null = null
  let type25FailureReason: string | null = null
  for (const [candidateIndex, candidate] of detailRead.sources.entries()) {
    try {
      const { payloads } = await prepareActivityNativeTransportV2(candidate.source, context)
      const epochs = payloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')
      const evidence = epochs[0]?.rawSourceMetadata
      const arraySteps = candidate.source.record.arraySteps
      const arrayValues = Array.isArray(arraySteps) ? arraySteps.map(Number)
        : typeof arraySteps === 'string' ? arraySteps.trim().split(/\s+/).filter(Boolean).map(Number) : []
      const integrityStatus = evidence?.type25IntegrityStatus === 'PASS' ? 'PASS' : 'FAIL'
      const failureReason = integrityStatus === 'PASS' ? null
        : String(evidence?.type25IntegrityReason ?? 'Source failed the Type25 minute-segment integrity check.')
      type25Candidate = makeSelectedSource(candidate.source, candidate.envelope, candidate.sourceEnvelope, context)
      type25Candidate.details.qualification = {
        status: integrityStatus,
        reason: failureReason,
        arrayLength: arrayValues.length,
        arraySum: arrayValues.reduce((sum, value) => sum + value, 0),
        declaredTotal: candidate.source.record.detailMinterStep,
      }
      if (epochs.length === 10 && epochs[0].rawSourceMetadata?.type25IntegrityStatus === 'PASS'
        && epochs[0].rawSourceMetadata?.type25ArrayLength === 10) {
        type25 = type25Candidate
        type25SelectedIndex = candidateIndex
        break
      }
      type25FailureReason = failureReason
        ?? 'Source failed the Type25 minute-segment integrity check.'
      warnings.push(`${candidate.source.sourceEnvelopeId}: ${type25FailureReason}`)
    } catch (error) {
      type25FailureReason = describeError(error)
      warnings.push(`${candidate.source.sourceEnvelopeId}: ${type25FailureReason}`)
      type25Candidate = makeSelectedSource(candidate.source, candidate.envelope, candidate.sourceEnvelope, context)
      type25Candidate.details.qualification = {
        status: 'FAIL', reason: type25FailureReason, arrayLength: null, arraySum: null,
        declaredTotal: candidate.source.record.detailMinterStep,
      }
    }
  }
  if (!type25) {
    type25FailureReason ??= 'No qualified Type25 source found: no persisted record passed the existing minute-segment integrity and device-scope policy.'
  }

  let payloads: Awaited<ReturnType<typeof prepareActivityNativeTransportV2Sources>>['payloads'] = []
  let selectionValid = false
  if (type24 && type25) {
    const projection = await prepareActivityNativeTransportV2Sources(
      [type24.source, type25.source], context, ACTIVITY_V2_VERIFICATION_SCOPE,
    )
    payloads = projection.payloads
    const dailyPayloads = payloads.filter((payload) => VERIFY_METRICS.includes(payload.metric as typeof VERIFY_METRICS[number]))
    const epochPayloads = payloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')
    selectionValid = projection.sourceRecordCount === 2 && payloads.length === 14
      && dailyPayloads.length === 4 && epochPayloads.length === 10
      && payloads.every((payload) => payload.rawSourceMetadata?.canonicalPolicy === 'NATIVE_ONLY'
        && payload.rawSourceMetadata?.activityTransportVersion === ACTIVITY_NATIVE_TRANSPORT_V2)
    if (!selectionValid) warnings.push('Prepared Activity v2 set differs from the bounded four-daily-plus-ten-minute verification contract.')
  }
  return {
    type24,
    type25,
    type25Candidate,
    payloads,
    warnings,
    type24FailureReason,
    type25FailureReason,
    selectionValid,
    sourceQueryMode: 'TARGETED_RECENT_CANDIDATES',
    type24CandidatesRead: query.type24CandidatesRead,
    type25CandidatesRead: query.type25CandidatesRead,
    type24SelectedIndex,
    type25SelectedIndex,
  }
}
