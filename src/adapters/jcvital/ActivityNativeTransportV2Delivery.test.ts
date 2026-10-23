import { describe, expect, it, vi } from 'vitest'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { EnqueueResult } from '../../services/storage/ObservationQueueStore'
import { sha256Hex } from './HeartRateSeries'
import { ACTIVITY_NATIVE_TRANSPORT_V2 } from './ActivityNativeTransportV2'
import { ACTIVITY_V2_FIXTURE_CONTEXT as context, activityV2FixtureSource } from './ActivityNativeTransportV2Fixtures'
import {
  ACTIVITY_V2_VERIFICATION_SCOPE,
  assessActivityV2Verification,
  enqueueActivityNativeTransportV2,
  prepareActivityNativeTransportV2Sources,
  selectSavedActivityV2VerificationSources,
} from './ActivityNativeTransportV2Delivery'

describe('Activity v2 production queue caller', () => {
  async function verification() {
    const sources = [activityV2FixtureSource('24'), activityV2FixtureSource('25')]
    const { payloads } = await prepareActivityNativeTransportV2Sources(sources, context)
    const targets: Record<string, string> = {
      DAILY_STEPS: 'activity.daily_steps',
      DAILY_DISTANCE: 'activity.daily_distance',
      DAILY_CALORIES: 'activity.daily_activity_energy',
      DAILY_EXERCISE_DURATION: 'activity.exercise_duration',
      DETAILED_ACTIVITY_EPOCH: 'activity.minute_steps',
    }
    const results: ConnectorObservationResult[] = payloads.map((payload) => ({
      observationId: payload.observationId, status: 'accepted', nativeObservationId: `native-${payload.observationId}`,
      canonicalStatus: payload.rawSourceMetadata?.canonicalEligible ? 'canonicalized' : 'not_applicable',
      canonicalTarget: payload.rawSourceMetadata?.canonicalEligible ? targets[payload.metric] : null,
    }))
    return { sources, payloads, results, ids: payloads.map((payload) => payload.observationId) }
  }

  it('reports canonical evidence separately from ACKs and never invents server readback', async () => {
    const { sources, payloads, results, ids } = await verification()
    const checks = await assessActivityV2Verification(sources, context, payloads, results, ids)
    expect(checks).toMatchObject({
      v2PayloadCreated: 'PASS', base44Acknowledged: 'PASS', type24DailyAuthorityPreserved: 'PASS',
      canonicalRowsCreatedOrUpserted: {
        status: 'PASS', expectedDailyRows: 4, expectedMinuteRows: 10,
        confirmedDailyResults: 4, confirmedSegmentAnchors: 1,
      },
      type25MinuteTimestampsCorrect: { payload: 'PASS', serverRowReadback: 'UNVERIFIED' },
      noDuplicateRows: { transportIdentities: 'PASS', canonicalReplay: 'PASS', serverRowReadback: 'UNVERIFIED' },
      noReadinessScoringChange: { companionWrites: 0, serverStateComparison: 'UNVERIFIED' },
    })
    const nativeOnly = results.map((result) => ({ ...result, canonicalStatus: 'not_applicable' as const, canonicalTarget: null }))
    const ackOnly = await assessActivityV2Verification(sources, context, payloads, nativeOnly, ids)
    expect(ackOnly.base44Acknowledged).toBe('PASS')
    expect(ackOnly.canonicalRowsCreatedOrUpserted.status).toBe('UNVERIFIED')
  })

  it('rejects incomplete, duplicate or wrongly routed server results and shifted minute timestamps', async () => {
    const { sources, payloads, results, ids } = await verification()
    const missing = await assessActivityV2Verification(sources, context, payloads, results.slice(1), ids)
    expect(missing.base44Acknowledged).toBe('FAIL')
    expect(missing.canonicalRowsCreatedOrUpserted.status).toBe('UNVERIFIED')
    const duplicate = await assessActivityV2Verification(sources, context, payloads, results, [...ids.slice(1), ids[1]])
    expect(duplicate.base44Acknowledged).toBe('FAIL')
    const wronglyRouted = results.map((result) => ({ ...result, canonicalTarget: 'body.temperature' }))
    expect((await assessActivityV2Verification(sources, context, payloads, wronglyRouted, ids))
      .canonicalRowsCreatedOrUpserted.status).toBe('UNVERIFIED')
    const shifted = structuredClone(payloads)
    shifted[4].observedAt = new Date(Date.parse(shifted[4].observedAt!) + 60_000).toISOString()
    expect((await assessActivityV2Verification(sources, context, shifted, results, ids))
      .type25MinuteTimestampsCorrect.payload).toBe('FAIL')
    const wrongAuthority = structuredClone(payloads)
    wrongAuthority[0].vendorDataType = '25'
    expect((await assessActivityV2Verification(sources, context, wrongAuthority, results, ids))
      .type24DailyAuthorityPreserved).toBe('FAIL')
  })

  it('fails closed before enqueue when registration capability is absent', async () => {
    const queue = { getOwnerUserId: () => context.ownerUserId, enqueueMany: vi.fn() }
    await expect(enqueueActivityNativeTransportV2(
      [activityV2FixtureSource('24')], context, queue, false,
    )).rejects.toThrow('registration did not enable')
    expect(queue.enqueueMany).not.toHaveBeenCalled()
  })

  it('blocks cross-owner enqueue, including an owner change during asynchronous preparation', async () => {
    const queue = { getOwnerUserId: vi.fn(() => 'another-owner'), enqueueMany: vi.fn() }
    await expect(enqueueActivityNativeTransportV2(
      [activityV2FixtureSource('24')], context, queue, true,
    )).rejects.toThrow('does not match the source owner')
    queue.getOwnerUserId.mockReturnValueOnce(context.ownerUserId)
    await expect(enqueueActivityNativeTransportV2(
      [activityV2FixtureSource('24')], context, queue, true,
    )).rejects.toThrow('owner changed during payload preparation')
    expect(queue.enqueueMany).not.toHaveBeenCalled()
  })

  it('enqueues only the selected saved Type24 and qualified Type25 records with deterministic IDs', async () => {
    const day = activityV2FixtureSource('24', {}, 'saved-type24')
    const preferred = activityV2FixtureSource('25', {}, 'saved-qualified-type25')
    const other = activityV2FixtureSource('25', { date: '2026.10.20 10:46:06' }, 'saved-other-type25')
    const selected = await selectSavedActivityV2VerificationSources(
      [day, other, preferred], day.sourceEnvelopeId!, [other.sourceEnvelopeId!, preferred.sourceEnvelopeId!], context,
    )
    expect(selected.map((source) => source.sourceEnvelopeId)).toEqual(['saved-type24', 'saved-qualified-type25'])

    const persisted = new Map<string, string>()
    const queue = {
      getOwnerUserId: () => context.ownerUserId,
      enqueueMany: vi.fn(async (payloads: NativeObservationInput[], refs?: ReadonlyMap<string, string>): Promise<EnqueueResult[]> => payloads.map((payload) => {
        const previous = persisted.get(payload.observationId)
        const json = JSON.stringify(payload)
        if (previous && previous !== json) throw new Error('observation ID conflict')
        persisted.set(payload.observationId, json)
        return {
          inserted: !previous, alreadyQueued: !!previous,
          record: {
            queueId: payload.observationId, ownerUserId: context.ownerUserId,
            observationId: payload.observationId, sourceEnvelopeId: refs?.get(payload.observationId),
            payload, state: 'PENDING', createdAt: '2026-10-21T00:00:00.000Z',
            updatedAt: '2026-10-21T00:00:00.000Z', claimedAt: null, attemptCount: 0,
            nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null,
            batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
          },
        }
      })),
    }

    const first = await enqueueActivityNativeTransportV2(selected, context, queue, true, ACTIVITY_V2_VERIFICATION_SCOPE)
    const replay = await enqueueActivityNativeTransportV2(selected, context, queue, true, ACTIVITY_V2_VERIFICATION_SCOPE)
    expect(first.sourceRecordCount).toBe(2)
    expect(first.payloadCount).toBe(14)
    expect(first.insertedCount).toBe(14)
    expect(replay.insertedCount).toBe(0)
    expect(replay.duplicateCount).toBe(14)
    expect(new Set(first.payloads.map((payload) => payload.observationId)).size).toBe(14)
    expect(first.payloads.map((payload) => payload.metric)).toEqual([
      'DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES', 'DAILY_EXERCISE_DURATION',
      ...Array.from({ length: 10 }, () => 'DETAILED_ACTIVITY_EPOCH'),
    ])
    expect(first.payloads.every((payload) =>
      ['saved-type24', 'saved-qualified-type25'].includes(String(
        first.results.find((result) => result.record.observationId === payload.observationId)?.record.sourceEnvelopeId,
      )))).toBe(true)
    expect(first.payloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')).toHaveLength(10)
    expect(first.payloads.some((payload) => payload.metric === 'DAILY_GOAL_COMPLETION'
      || payload.metric.startsWith('DETAILED_ACTIVITY_STEPS_TOTAL')
      || payload.metric === 'DETAILED_ACTIVITY_DISTANCE'
      || payload.metric === 'DETAILED_ACTIVITY_CALORIES')).toBe(false)
    expect(first.payloads.find((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')?.rawSourceMetadata)
      .toMatchObject({
        type25ArraySteps: '10,0,0,0,0,0,0,0,0,0',
        type25DetailMinterStep: '10',
        type25IntegrityStatus: 'PASS',
        semanticPolicy: 'jcvital.type25.minute_anchor.v1',
      })
  })

  it('derives verification IDs from saved source, metric, transport and fixed verification scope', async () => {
    const selected = [activityV2FixtureSource('24', {}, 'stable-day'), activityV2FixtureSource('25', {}, 'stable-segment')]
    const queue = {
      getOwnerUserId: () => context.ownerUserId,
      enqueueMany: vi.fn(async (payloads: NativeObservationInput[]) => payloads.map((payload) => ({
        inserted: true,
        alreadyQueued: false,
        record: {
          queueId: payload.observationId, ownerUserId: context.ownerUserId, observationId: payload.observationId,
          sourceEnvelopeId: String(payload.rawSourceMetadata?.sourceEnvelopeId), payload, state: 'PENDING' as const,
          createdAt: '2026-10-21T00:00:00.000Z', updatedAt: '2026-10-21T00:00:00.000Z',
          claimedAt: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null,
          lastErrorMessage: null, batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
        },
      }))),
    }
    const first = await enqueueActivityNativeTransportV2(selected, context, queue, true, ACTIVITY_V2_VERIFICATION_SCOPE)
    const second = await enqueueActivityNativeTransportV2(selected, context, queue, true, ACTIVITY_V2_VERIFICATION_SCOPE)
    expect(first.payloads.map((payload) => payload.observationId)).toEqual(second.payloads.map((payload) => payload.observationId))
    expect(new Set(first.payloads.map((payload) => payload.observationId)).size).toBe(14)
    expect(first.payloads.every((payload) => payload.rawSourceMetadata?.activityVerificationScope === ACTIVITY_V2_VERIFICATION_SCOPE)).toBe(true)
    for (const payload of first.payloads) {
      const sourceEnvelopeId = String(payload.rawSourceMetadata?.sourceEnvelopeId)
      const slot = payload.sequenceNumber ?? 'record'
      expect(payload.observationId).toBe(await sha256Hex([
        sourceEnvelopeId, payload.metric, ACTIVITY_NATIVE_TRANSPORT_V2, ACTIVITY_V2_VERIFICATION_SCOPE, slot,
      ].join(':')))
    }
  })
})
