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
import { JCVitalV8, type SourceJournalScope } from './jcvitalV8Bridge'

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

function paginationDiagnostic(
  requestedCursor: number,
  page: { envelopes?: Array<{ sequence?: unknown }>; nextSequence?: unknown; hasMore?: unknown },
): string {
  const records = Array.isArray(page.envelopes) ? page.envelopes : []
  return JSON.stringify({
    requestedCursor,
    returnedRecordCount: records.length,
    firstSequence: records[0]?.sequence ?? null,
    lastSequence: records.at(-1)?.sequence ?? null,
    returnedNextCursor: page.nextSequence ?? null,
    hasMore: page.hasMore ?? null,
  })
}

async function savedActivityEnvelopes(scope: SourceJournalScope, journal: typeof JCVitalV8): Promise<RecordEnvelope[]> {
  const entries: RecordEnvelope[] = []
  const seenSequences = new Set<number>()
  const seenEnvelopeIds = new Set<string>()
  let afterSequence = 0
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await journal.exportSourceJournal({ ...scope, afterSequence, limit: 100 })
    const diagnostic = paginationDiagnostic(afterSequence, page)
    if (!Array.isArray(page.envelopes) || page.envelopes.length > 100 || typeof page.hasMore !== 'boolean') {
      throw new Error(`Saved Activity source journal returned a malformed page. ${diagnostic}`)
    }
    let previousSequence = afterSequence
    for (const entry of page.envelopes) {
      if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previousSequence
        || !entry.envelopeId || seenSequences.has(entry.sequence) || seenEnvelopeIds.has(entry.envelopeId)) {
        throw new Error(`Saved Activity source journal returned duplicate or unordered records. ${diagnostic}`)
      }
      previousSequence = entry.sequence
      seenSequences.add(entry.sequence)
      seenEnvelopeIds.add(entry.envelopeId)
      if (entry.kind !== 'SDK_RECORD') continue
      if (!entry.envelopeJson) {
        throw new Error(`Saved Activity source journal omitted a source record payload. ${diagnostic}`)
      }
      const envelope = JSON.parse(entry.envelopeJson) as RecordEnvelope
      if (envelope.kind !== 'SDK_RECORD' || envelope.envelopeId !== entry.envelopeId) {
        throw new Error(`Saved source envelope ${entry.envelopeId} failed its identity check.`)
      }
      if (envelope.vendorDataType === '24' || envelope.vendorDataType === '25') entries.push(envelope)
    }
    const lastSequence = page.envelopes.at(-1)?.sequence ?? afterSequence
    if (!Number.isSafeInteger(page.nextSequence) || page.nextSequence !== lastSequence) {
      throw new Error(`Saved Activity source journal returned an invalid cursor. ${diagnostic}`)
    }
    if (!page.hasMore) return entries
    if (!page.envelopes.length || page.nextSequence <= afterSequence) {
      throw new Error(`Saved Activity source journal pagination did not advance. ${diagnostic}`)
    }
    afterSequence = page.nextSequence
  }
  throw new Error('Saved Activity source journal exceeded the 10,000-envelope verification read limit.')
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
      const source = await readActivitySource(journal, scope, candidate.envelopeId)
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
  const envelopes = await savedActivityEnvelopes(scope, journal)
  const dailyRead = await readCandidates(scope, envelopes, '24', journal)
  const warnings = [...dailyRead.warnings]
  let type24: ActivityV2SelectedSource | null = null
  let type24FailureReason: string | null = null
  for (const candidate of dailyRead.sources.filter(({ source }) => hasDailyEvidence(source))) {
    try {
      const prepared = await prepareActivityNativeTransportV2(candidate.source, context)
      if (prepared.payloads.length === VERIFY_METRICS.length
        && VERIFY_METRICS.every((metric) => prepared.payloads.some((payload) => payload.metric === metric))) {
        type24 = makeSelectedSource(candidate.source, candidate.envelope, candidate.sourceEnvelope, context)
        break
      }
      type24FailureReason = 'Source did not prepare the exact four daily verification metrics.'
      warnings.push(`${candidate.source.sourceEnvelopeId}: ${type24FailureReason}`)
    } catch (error) {
      type24FailureReason = describeError(error)
      warnings.push(`${candidate.source.sourceEnvelopeId}: ${type24FailureReason}`)
    }
  }
  if (!type24) type24FailureReason ??= 'No persisted Type24 source contains the four required daily measurements.'

  const detailRead = await readCandidates(scope, envelopes, '25', journal)
  warnings.push(...detailRead.warnings)
  let type25: ActivityV2SelectedSource | null = null
  let type25Candidate: ActivityV2SelectedSource | null = null
  let type25FailureReason: string | null = null
  for (const candidate of detailRead.sources) {
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
  if (!type25) type25FailureReason ??= 'No persisted Type25 source passed the existing minute-segment integrity and device-scope policy.'

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
  return { type24, type25, type25Candidate, payloads, warnings, type24FailureReason, type25FailureReason, selectionValid }
}
