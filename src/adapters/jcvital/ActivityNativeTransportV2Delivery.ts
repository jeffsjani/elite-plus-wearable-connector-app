import type { NativeObservation } from '../../models/wearableObservation'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { EnqueueResult } from '../../services/storage/ObservationQueueStore'
import { sha256Hex } from './HeartRateSeries'
import {
  activitySourceRecordsFromNative,
  activeActivityObservations,
  applyActivityCanonicalObservations,
  emptyActivityLedger,
  mapActivitySourceRecords,
  type ActivityDeviceContext,
  type ActivitySourceRecord,
} from './ActivityProductionCanonical'
import { ACTIVITY_NATIVE_TRANSPORT_V2, prepareActivityNativeTransportV2 } from './ActivityNativeTransportV2'

export const ACTIVITY_V2_VERIFICATION_SCOPE = 'activity-v2-production-verification.v1'

export interface ActivityV2Queue {
  getOwnerUserId(): string | null
  enqueueMany(
    observations: NativeObservationInput[],
    sourceEnvelopeIds?: ReadonlyMap<string, string>,
  ): Promise<EnqueueResult[]>
}

export interface ActivityV2EnqueueResult {
  sourceRecordCount: number
  payloadCount: number
  insertedCount: number
  duplicateCount: number
  payloads: NativeObservationInput[]
  results: EnqueueResult[]
}

export interface PreparedActivityV2Sources {
  sourceRecordCount: number
  payloads: NativeObservationInput[]
  sourceEnvelopeIds: ReadonlyMap<string, string>
}

export async function assessActivityV2Verification(
  sources: readonly ActivitySourceRecord[],
  context: ActivityDeviceContext,
  payloads: readonly NativeObservationInput[],
  results: readonly ConnectorObservationResult[],
  acknowledgedIds: readonly string[],
) {
  const expected = await mapActivitySourceRecords(sources, context, Date.now())
  const daily = payloads.filter((payload) => payload.rawSourceMetadata?.sourceDataType === 24)
  const epochs = payloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')
  const anchors = epochs.filter((payload) => payload.rawSourceMetadata?.segmentAnchor === true)
  const canonicalPayloads = [...daily, ...anchors]
  const expectedMinutes = expected.observations.filter((observation) => observation.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS')
  const first = applyActivityCanonicalObservations(emptyActivityLedger(), expected.observations)
  const replay = applyActivityCanonicalObservations(first.state, expected.observations)
  const firstRows = activeActivityObservations(first.state)
  const replayRows = activeActivityObservations(replay.state)
  const exactResults = results.length === payloads.length
    && new Set(results.map((result) => result.observationId)).size === payloads.length
    && payloads.every((payload) => results.some((result) => result.observationId === payload.observationId
      && (result.status === 'accepted' || result.status === 'duplicate') && Boolean(result.nativeObservationId)))
  const canonicalConfirmed = canonicalPayloads.length === 5 && exactResults
    && canonicalPayloads.every((payload) => results.some((result) =>
      result.observationId === payload.observationId && result.canonicalStatus === 'canonicalized'
      && expected.observations.some((observation) => observation.canonicalTarget === result.canonicalTarget
        && observation.metric === (payload.metric === 'DAILY_EXERCISE_DURATION' ? 'EXERCISE_DURATION'
          : payload.metric === 'DETAILED_ACTIVITY_EPOCH' ? 'DETAILED_ACTIVITY_MINUTE_STEPS' : payload.metric))))
  return {
    v2PayloadCreated: payloads.length === 14 && payloads.every((payload) =>
      payload.rawSourceMetadata?.activityTransportVersion === ACTIVITY_NATIVE_TRANSPORT_V2) ? 'PASS' : 'FAIL',
    base44Acknowledged: exactResults && acknowledgedIds.length === payloads.length
      && new Set(acknowledgedIds).size === payloads.length
      && payloads.every((payload) => acknowledgedIds.includes(payload.observationId)) ? 'PASS' : 'FAIL',
    canonicalRowsCreatedOrUpserted: {
      status: canonicalConfirmed ? 'PASS' : 'UNVERIFIED',
      evidence: 'Existing Base44 per-observation canonicalStatus and canonicalTarget; not a server row readback.',
      expectedDailyRows: 4,
      expectedMinuteRows: 10,
      confirmedDailyResults: daily.filter((payload) => results.some((result) =>
        result.observationId === payload.observationId && result.canonicalStatus === 'canonicalized')).length,
      confirmedSegmentAnchors: anchors.filter((payload) => results.some((result) =>
        result.observationId === payload.observationId && result.canonicalStatus === 'canonicalized')).length,
    },
    type24DailyAuthorityPreserved: daily.length === 4
      && ['DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES', 'DAILY_EXERCISE_DURATION']
        .every((metric) => daily.some((payload) => payload.metric === metric))
      && daily.every((payload) => payload.vendorDataType === '24')
      && epochs.length === 10 && payloads.length === daily.length + epochs.length
      && epochs.every((payload) => payload.vendorDataType === '25'
        && payload.rawSourceMetadata?.sourceDataType === 25)
      ? 'PASS' : 'FAIL',
    type25MinuteTimestampsCorrect: {
      payload: epochs.length === 10 && expectedMinutes.length === 10
        && epochs.every((payload, slot) => payload.sequenceNumber === slot
          && expectedMinutes.some((minute) => minute.provenance.sourceArraySlotIndex === slot
            && minute.observedAt === payload.observedAt && minute.value === payload.valueNumber))
        ? 'PASS' : 'FAIL',
      serverRowReadback: 'UNVERIFIED',
    },
    noDuplicateRows: {
      transportIdentities: new Set(payloads.map((payload) => payload.observationId)).size === 14 ? 'PASS' : 'FAIL',
      canonicalReplay: firstRows.length === 14 && replayRows.length === 14
        && replay.outcomes.every((outcome) => outcome.outcome === 'DUPLICATE') ? 'PASS' : 'FAIL',
      serverRowReadback: 'UNVERIFIED',
    },
    noReadinessScoringChange: {
      companionWrites: 0,
      serverStateComparison: 'UNVERIFIED',
      evidence: 'Activity-only verification uses the existing observations sender; no readiness or scoring API is invoked.',
    },
  }
}

export async function prepareActivityNativeTransportV2Sources(
  sources: readonly ActivitySourceRecord[],
  context: ActivityDeviceContext,
  identityScope?: typeof ACTIVITY_V2_VERIFICATION_SCOPE,
): Promise<PreparedActivityV2Sources> {
  const unique = new Map<string, ActivitySourceRecord>()
  for (const source of sources) {
    if (!source.sourceEnvelopeId || !source.acquisitionSessionId) {
      throw new Error('Activity v2 requires exact saved source-envelope and acquisition-session identities.')
    }
    const identity = `${source.vendorDataType}:${source.sourceEnvelopeId}`
    const previous = unique.get(identity)
    if (previous && JSON.stringify(previous) !== JSON.stringify(source)) {
      throw new Error(`Conflicting Activity source evidence for ${identity}.`)
    }
    unique.set(identity, source)
  }

  const payloads: NativeObservationInput[] = []
  const sourceEnvelopeIds = new Map<string, string>()
  for (const source of unique.values()) {
    const prepared = await prepareActivityNativeTransportV2(source, context)
    for (const payload of prepared.payloads) {
      if (identityScope) {
        const sourceEnvelopeId = payload.rawSourceMetadata?.sourceEnvelopeId
        if (typeof sourceEnvelopeId !== 'string' || !sourceEnvelopeId) {
          throw new Error('Activity v2 verification requires exact source-envelope identity.')
        }
        const identity = [
          sourceEnvelopeId,
          payload.metric,
          ACTIVITY_NATIVE_TRANSPORT_V2,
          identityScope,
          payload.sequenceNumber ?? 'record',
        ].join(':')
        payload.observationId = await sha256Hex(identity)
        payload.rawSourceMetadata = {
          ...payload.rawSourceMetadata,
          activityVerificationScope: identityScope,
        }
      }
      payloads.push(payload)
      sourceEnvelopeIds.set(payload.observationId, source.sourceEnvelopeId!)
    }
  }
  return { sourceRecordCount: unique.size, payloads, sourceEnvelopeIds }
}

export async function enqueueActivityNativeTransportV2(
  sources: readonly ActivitySourceRecord[],
  context: ActivityDeviceContext,
  queue: ActivityV2Queue,
  capabilityEnabled: boolean,
  identityScope?: typeof ACTIVITY_V2_VERIFICATION_SCOPE,
): Promise<ActivityV2EnqueueResult> {
  if (!capabilityEnabled) throw new Error('Activity v2 enqueue blocked: registration did not enable JCVITAL_ACTIVITY_TRANSPORT_V2.')
  if (queue.getOwnerUserId() !== context.ownerUserId) throw new Error('Activity v2 enqueue blocked: authenticated queue owner does not match the source owner.')
  const prepared = await prepareActivityNativeTransportV2Sources(sources, context, identityScope)
  if (queue.getOwnerUserId() !== context.ownerUserId) throw new Error('Activity v2 enqueue blocked: authenticated queue owner changed during payload preparation.')
  if (!prepared.payloads.length) {
    return {
      sourceRecordCount: prepared.sourceRecordCount, payloadCount: 0, insertedCount: 0,
      duplicateCount: 0, payloads: prepared.payloads, results: [],
    }
  }
  const results = await queue.enqueueMany(prepared.payloads, prepared.sourceEnvelopeIds)
  if (results.length !== prepared.payloads.length) throw new Error('Activity v2 queue returned an incomplete enqueue result set.')
  return {
    sourceRecordCount: prepared.sourceRecordCount, payloadCount: prepared.payloads.length,
    insertedCount: results.filter((result) => result.inserted).length,
    duplicateCount: results.filter((result) => result.alreadyQueued).length, payloads: prepared.payloads,
    results,
  }
}

export function activityV2SourcesFromNative(observations: readonly NativeObservation[]): ActivitySourceRecord[] {
  return activitySourceRecordsFromNative(observations)
}

export async function selectSavedActivityV2VerificationSources(
  sources: readonly ActivitySourceRecord[],
  type24SourceEnvelopeId: string,
  qualifiedType25SourceEnvelopeIds: readonly string[],
  context: ActivityDeviceContext,
): Promise<[ActivitySourceRecord, ActivitySourceRecord]> {
  const type24 = sources.find((source) => source.vendorDataType === '24'
    && source.sourceEnvelopeId === type24SourceEnvelopeId)
  if (!type24) throw new Error('Saved Activity v2 verification requires the selected physical Type24 source.')
  const type25Ids = new Set(qualifiedType25SourceEnvelopeIds)
  const candidates = sources.filter((source) => source.vendorDataType === '25'
    && source.sourceEnvelopeId && type25Ids.has(source.sourceEnvelopeId))
  candidates.sort((left, right) => {
    const preferred = '2026.10.20 10:28:53'
    return Number(String(right.record.date) === preferred) - Number(String(left.record.date) === preferred)
  })
  for (const source of candidates) {
    const prepared = await prepareActivityNativeTransportV2(source, context)
    const epochs = prepared.payloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')
    if (epochs.length === 10 && epochs[0].rawSourceMetadata?.type25IntegrityStatus === 'PASS'
      && epochs[0].rawSourceMetadata?.type25ArrayLength === 10) {
      return [type24, source]
    }
  }
  throw new Error('No saved, physically qualified Type25 segment passed the v2 integrity policy.')
}
