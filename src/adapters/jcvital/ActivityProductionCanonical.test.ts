import { describe, expect, it } from 'vitest'
import type { NativeObservation, SerializableValue } from '../../models/wearableObservation'
import {
  ACTIVITY_BASE44_CANONICAL_PREP,
  ACTIVITY_METRIC_CONTRACTS,
  ACTIVITY_NON_MAPPED_FIELDS,
  ACTIVITY_NORMALIZER_VERSION,
  EXERCISE_DURATION_FORBIDDEN_LABELS,
  activeActivityObservations,
  activitySourceRecordsFromNative,
  applyActivityCanonicalObservations,
  assertActivityAuthority,
  canonicalizeActivity,
  emptyActivityLedger,
  mapType24DailyRecord,
  mapType25DetailRecord,
  toActivityNativeObservationInput,
  type ActivityCanonicalObservation,
  type ActivityDeviceContext,
  type ActivitySourceRecord,
} from './ActivityProductionCanonical'
import { TYPE25_MINUTE_ANCHOR_POLICY, TYPE25_MINUTE_ANCHOR_POLICY_ID } from './Type25MinuteAnchorPolicy'

const OWNER = 'owner-1'
const DEVICE = 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b'
const OTHER_DEVICE = 'jcvital_device_aaaaaaaa-9a4d-4b6e-8f10-2c3d4e5f6a7b'
const TZ = 'America/Los_Angeles'
const CONTEXT: ActivityDeviceContext = { ownerUserId: OWNER, deviceId: DEVICE, deviceModel: 'PRO_V8', firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' }
/** 2026-10-20 15:00 PDT */
const NOW_SAME_DAY = Date.parse('2026-10-20T22:00:00.000Z')
/** 2026-10-22 09:00 PDT */
const NOW_LATER = Date.parse('2026-10-22T16:00:00.000Z')

function type24(record: Record<string, unknown>, extra: Partial<ActivitySourceRecord> = {}): ActivitySourceRecord {
  return {
    vendorDataType: '24',
    record: { date: '2026.10.20', step: '4321', distance: '2.87', calories: '153.40', exerciseMinutes: '1530', goal: '80', ...record },
    sourceEnvelopeId: 'env-24-a', acquisitionSessionId: 'session-a', nativeObservationIds: ['n-24'], nativeSourceRecordIds: ['nsr-24'],
    parserVersion: 'phase3b-1', receivedAt: '2026-10-20T21:00:00.000Z', timezone: TZ, ...extra,
  }
}

function type25(record: Record<string, unknown>, extra: Partial<ActivitySourceRecord> = {}): ActivitySourceRecord {
  return {
    vendorDataType: '25',
    record: { date: '2026.10.20 10:28:53', detailMinterStep: '10', arraySteps: '10 0 0 0 0 0 0 0 0 0', distance: '0.01', calories: '0.40', ...record },
    sourceEnvelopeId: '023d885d-bfec-40d2-823c-bb36b8553407', acquisitionSessionId: 'session-25', nativeObservationIds: ['n-25'], nativeSourceRecordIds: ['nsr-25'],
    parserVersion: 'phase3b-1', receivedAt: '2026-10-20T21:46:00.000Z', timezone: TZ, ...extra,
  }
}

async function daily(record: Record<string, unknown> = {}, extra: Partial<ActivitySourceRecord> = {}, nowMs = NOW_SAME_DAY) {
  return mapType24DailyRecord(type24(record, extra), CONTEXT, nowMs)
}

const byMetric = (observations: ActivityCanonicalObservation[], metric: string) => observations.find((o) => o.metric === metric)!

describe('P1-2C Type24 daily authority', () => {
  it('maps Type24.step to DAILY_STEPS (count)', async () => {
    const { observations, withheld } = await daily()
    expect(withheld).toEqual([])
    const steps = byMetric(observations, 'DAILY_STEPS')
    expect(steps).toMatchObject({ value: 4321, unit: 'count', canonicalTarget: 'activity.daily_steps', sourceLocalDate: '2026-10-20' })
    expect(steps.provenance).toMatchObject({ sourceDataType: '24', sourceField: 'step' })
  })

  it('preserves Type24.distance exactly as km, vendor-derived and not measured', async () => {
    const distance = byMetric((await daily({ distance: '12.345' })).observations, 'DAILY_DISTANCE')
    expect(distance).toMatchObject({ value: 12.345, unit: 'km', vendorRawValue: '12.345' })
    expect(distance.provenance).toMatchObject({ vendorDerived: true, measured: false })
  })

  it('preserves Type24.calories exactly as kcal labelled Activity Calories / Activity Energy', async () => {
    const calories = byMetric((await daily({ calories: '153.47' })).observations, 'DAILY_CALORIES')
    expect(calories).toMatchObject({ value: 153.47, unit: 'kcal', vendorRawValue: '153.47', canonicalTarget: 'activity.daily_activity_energy' })
    expect(ACTIVITY_METRIC_CONTRACTS.DAILY_CALORIES.semanticLabel).toBe('Activity Calories / Activity Energy')
    expect(calories.provenance).toMatchObject({ vendorDerived: true, measured: false })
  })

  it('preserves Type24.exerciseMinutes as raw seconds and derives unrounded decimal minutes', async () => {
    const duration = byMetric((await daily({ exerciseMinutes: '1537' })).observations, 'EXERCISE_DURATION')
    expect(duration).toMatchObject({ value: 1537, unit: 'second', vendorRawValue: '1537', vendor_exercise_duration_seconds: 1537 })
    expect(duration.vendor_exercise_duration_minutes).toBe(1537 / 60)
    expect(Number.isInteger(duration.vendor_exercise_duration_minutes)).toBe(false)
    expect(duration.consumerLabel).toBe('V8 Exercise Duration')
    const labels = JSON.stringify(ACTIVITY_METRIC_CONTRACTS.EXERCISE_DURATION).toLowerCase()
    for (const forbidden of EXERCISE_DURATION_FORBIDDEN_LABELS) expect(labels).not.toContain(forbidden.toLowerCase())
  })

  it('does not canonicalize goal, ExerciseTime or iOS activeMinutes', async () => {
    const { observations } = await daily({ ExerciseTime: '30', activeMinutes: '22' })
    expect(observations.map((o) => o.metric).sort()).toEqual(['DAILY_CALORIES', 'DAILY_DISTANCE', 'DAILY_STEPS', 'EXERCISE_DURATION'])
    expect(observations.map((o) => o.provenance.sourceField)).not.toEqual(expect.arrayContaining(['goal']))
    expect(ACTIVITY_NON_MAPPED_FIELDS.map((f) => f.vendorField)).toEqual(expect.arrayContaining(['goal', 'ExerciseTime', 'activeMinutes']))
  })

  it('derives sourceLocalDate from the device date, not through UTC, and marks current day IN_PROGRESS', async () => {
    // 2026-10-20 22:30 PDT is already 2026-10-21 in UTC; the local day must stay 2026-10-20.
    const lateEvening = Date.parse('2026-10-21T05:30:00.000Z')
    const steps = byMetric((await daily({}, {}, lateEvening)).observations, 'DAILY_STEPS')
    expect(steps.sourceLocalDate).toBe('2026-10-20')
    expect(steps.dailyState).toBe('IN_PROGRESS')
    expect(steps.observedAt).toBe('2026-10-20T07:00:00.000Z')
    expect(steps.endAt).toBe('2026-10-21T07:00:00.000Z')
    expect(steps.provenance).toMatchObject({ timezone: TZ, timezoneSource: 'PHONE_TIMEZONE', observedLocalDate: '2026-10-20' })
    expect(byMetric((await daily({}, {}, NOW_LATER)).observations, 'DAILY_STEPS').dailyState).toBe('FINAL')
  })

  it('same-day Type24 refresh updates the canonical row instead of duplicating it', async () => {
    const first = await daily()
    const second = await daily({ step: '5000', distance: '3.31', calories: '170.00', exerciseMinutes: '1800' },
      { sourceEnvelopeId: 'env-24-b', receivedAt: '2026-10-20T21:30:00.000Z' })
    const a = applyActivityCanonicalObservations(emptyActivityLedger(), first.observations)
    const b = applyActivityCanonicalObservations(a.state, second.observations)
    expect(b.outcomes.every((o) => o.outcome === 'UPDATED_IN_PROGRESS')).toBe(true)
    const rows = Object.values(b.state.rows)
    expect(rows).toHaveLength(4)
    const steps = rows.find((r) => r.observation.metric === 'DAILY_STEPS')!
    expect(steps.observation.value).toBe(5000)
    expect(steps.revision).toBe(2)
    expect(steps.ancestry.map((s) => s.sourceEnvelopeId)).toEqual(['env-24-a', 'env-24-b'])
  })

  it('historical Type24 replay is idempotent and a historical correction replaces the same identity', async () => {
    const original = await daily({ date: '2026.10.18' }, {}, NOW_LATER)
    const a = applyActivityCanonicalObservations(emptyActivityLedger(), original.observations)
    const replay = applyActivityCanonicalObservations(a.state, (await daily({ date: '2026.10.18' }, { sourceEnvelopeId: 'env-replay' }, NOW_LATER)).observations)
    expect(replay.outcomes.every((o) => o.outcome === 'DUPLICATE')).toBe(true)
    expect(replay.state).toEqual(a.state)
    const corrected = applyActivityCanonicalObservations(a.state, (await daily({ date: '2026.10.18', step: '4400' },
      { sourceEnvelopeId: 'env-corr', receivedAt: '2026-10-22T16:00:00.000Z' }, NOW_LATER)).observations)
    const steps = Object.values(corrected.state.rows).find((r) => r.observation.metric === 'DAILY_STEPS')!
    expect(Object.keys(corrected.state.rows)).toHaveLength(4)
    expect(steps.observation.value).toBe(4400)
    expect(steps.observation.dailyState).toBe('FINAL')
    expect(corrected.outcomes.find((o) => o.metric === 'DAILY_STEPS')!.outcome).toBe('CORRECTED_HISTORICAL')
    expect(steps.ancestry.map((s) => s.sourceEnvelopeId)).toEqual(['env-24-a', 'env-corr'])
  })

  it('an older read never overwrites a newer current-day value', async () => {
    const newer = await daily({ step: '5000' }, { receivedAt: '2026-10-20T21:30:00.000Z', sourceEnvelopeId: 'env-new' })
    const older = await daily({ step: '4000' }, { receivedAt: '2026-10-20T20:00:00.000Z', sourceEnvelopeId: 'env-old' })
    const state = applyActivityCanonicalObservations(applyActivityCanonicalObservations(emptyActivityLedger(), newer.observations).state, older.observations)
    expect(Object.values(state.state.rows).find((r) => r.observation.metric === 'DAILY_STEPS')!.observation.value).toBe(5000)
  })

  it('accepts a later daily correction back to an earlier payload rather than treating it as replay', async () => {
    const a = await daily({ step: '4321' }, { receivedAt: '2026-10-20T20:00:00.000Z' })
    const b = await daily({ step: '5000' }, { sourceEnvelopeId: 'env-b', receivedAt: '2026-10-20T21:00:00.000Z' })
    const correction = await daily({ step: '4321' }, { sourceEnvelopeId: 'env-c', receivedAt: '2026-10-20T22:00:00.000Z' })
    const result = applyActivityCanonicalObservations(emptyActivityLedger(), [...a.observations, ...b.observations, ...correction.observations])
    expect(Object.values(result.state.rows)).toHaveLength(4)
    const row = Object.values(result.state.rows).find((entry) => entry.observation.metric === 'DAILY_STEPS')!
    expect(row.observation.value).toBe(4321)
    expect(row.revision).toBe(3)
    expect(row.ancestry.map((entry) => entry.sourceEnvelopeId)).toEqual(['env-24-a', 'env-b', 'env-c'])
  })

  it('finalizes an unchanged current-day value when replayed on a later local day', async () => {
    const first = await daily()
    const later = await daily({}, {}, NOW_LATER)
    const result = applyActivityCanonicalObservations(emptyActivityLedger(), [...first.observations, ...later.observations])
    expect(Object.values(result.state.rows)).toHaveLength(4)
    expect(Object.values(result.state.rows).every((row) => row.observation.dailyState === 'FINAL')).toBe(true)
  })

  it('an unchanged newer daily refresh prevents a delayed older correction from overwriting it', async () => {
    const first = await daily({}, { receivedAt: '2026-10-20T20:00:00.000Z' })
    const refresh = await daily({}, { sourceEnvelopeId: 'env-new', receivedAt: '2026-10-20T22:00:00.000Z' })
    const delayed = await daily({ step: '4000' }, { sourceEnvelopeId: 'env-delayed', receivedAt: '2026-10-20T21:00:00.000Z' })
    const result = applyActivityCanonicalObservations(emptyActivityLedger(), [...first.observations, ...refresh.observations, ...delayed.observations])
    const row = Object.values(result.state.rows).find((entry) => entry.observation.metric === 'DAILY_STEPS')!
    expect(row.observation.value).toBe(4321)
    expect(row.observation.provenance.sourceEnvelopeId).toBe('env-new')
    expect(result.outcomes.at(-4)?.outcome).toBe('STALE_READ_IGNORED')
  })
})

describe('P1-2C Type25 intraday authority (jcvital.type25.minute_anchor.v1)', () => {
  it('expands a valid 10-slot record with FIRST_MINUTE anchor and OLDEST_TO_NEWEST ordering', async () => {
    const { observations, withheld } = await mapType25DetailRecord(type25({ date: '2026.10.20 10:16:06', detailMinterStep: '123', arraySteps: '77 0 0 46 0 0 0 0 0 0' },
      { sourceEnvelopeId: '91dde3ab-8828-45bb-b205-c159e4f8e282' }), CONTEXT)
    expect(withheld).toEqual([])
    expect(observations).toHaveLength(10)
    expect(observations[0].observedAt).toBe('2026-10-20T17:16:06.000Z')
    expect(observations[9].observedAt).toBe('2026-10-20T17:25:06.000Z')
    expect(observations.map((o) => o.value)).toEqual([77, 0, 0, 46, 0, 0, 0, 0, 0, 0])
    expect(observations.map((o) => o.provenance.sourceArraySlotIndex)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    for (let i = 1; i < 10; i += 1) expect(Date.parse(observations[i].observedAt) - Date.parse(observations[i - 1].observedAt)).toBe(60_000)
  })

  it('slot 0 equals the Type25 date (strongest v64 physical evidence: Minute 7 WALK at 10:28:53)', async () => {
    const { observations } = await mapType25DetailRecord(type25({}), CONTEXT)
    expect(observations[0]).toMatchObject({ observedAt: '2026-10-20T17:28:53.000Z', value: 10 })
    expect(observations[0].provenance).toMatchObject({
      sourceType25VendorDate: '2026.10.20 10:28:53', sourceArraySlotIndex: 0, resolvedMinuteTimestamp: '2026-10-20T17:28:53.000Z',
      observedLocalTime: '2026-10-20T10:28:53', semanticPolicyId: TYPE25_MINUTE_ANCHOR_POLICY_ID,
    })
    expect(observations[9].observedAt).toBe('2026-10-20T17:37:53.000Z')
  })

  it('timestamp generation is deterministic', async () => {
    const a = await mapType25DetailRecord(type25({}), CONTEXT)
    const b = await mapType25DetailRecord(type25({}), CONTEXT)
    expect(b).toEqual(a)
  })

  it('withholds invalid slot count with an explicit reason and preserves the source', async () => {
    const source = type25({ arraySteps: '10 0 0 0 0 0 0 0 0' })
    const before = structuredClone(source)
    const { observations, withheld } = await mapType25DetailRecord(source, CONTEXT)
    expect(observations).toEqual([])
    expect(withheld).toEqual([expect.objectContaining({ reason: 'ARRAY_LENGTH_NOT_10', sourceEnvelopeId: source.sourceEnvelopeId })])
    expect(source).toEqual(before)
  })

  it('withholds sum(arraySteps) != detailMinterStep', async () => {
    const { observations, withheld } = await mapType25DetailRecord(type25({ detailMinterStep: '11' }), CONTEXT)
    expect(observations).toEqual([])
    expect(withheld[0].reason).toBe('SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP')
  })

  it('validates the raw arraySteps string, rejecting malformed tokens instead of dropping them', async () => {
    const { withheld } = await mapType25DetailRecord(type25({ arraySteps: '10 0 0 x 0 0 0 0 0 0' }), CONTEXT)
    expect(withheld[0].reason).toBe('UNPARSEABLE_ARRAY_STEPS')
  })

  it('missing Type25 segments are never zero-filled', async () => {
    const result = await mapType25DetailRecord(type25({ date: '2026.10.20 10:16:06', detailMinterStep: '123', arraySteps: '77 0 0 46 0 0 0 0 0 0' }), CONTEXT)
    const later = await mapType25DetailRecord(type25({ date: '2026.10.20 10:46:06', detailMinterStep: '5', arraySteps: '5 0 0 0 0 0 0 0 0 0' }, { sourceEnvelopeId: 'env-later' }), CONTEXT)
    const ledger = applyActivityCanonicalObservations(emptyActivityLedger(), [...result.observations, ...later.observations]).state
    const minutes = activeActivityObservations(ledger).map((o) => o.observedAt)
    expect(minutes).toHaveLength(20)
    expect(minutes).not.toContain('2026-10-20T17:26:06.000Z')
    expect(minutes).not.toContain('2026-10-20T17:45:06.000Z')
  })

  it('exact Type25 replay does not duplicate canonical epochs', async () => {
    const first = await mapType25DetailRecord(type25({}), CONTEXT)
    const replay = await mapType25DetailRecord(type25({}, { sourceEnvelopeId: 'env-replay', receivedAt: '2026-10-21T00:00:00.000Z' }), CONTEXT)
    const a = applyActivityCanonicalObservations(emptyActivityLedger(), first.observations)
    const b = applyActivityCanonicalObservations(a.state, replay.observations)
    expect(b.outcomes.every((o) => o.outcome === 'DUPLICATE')).toBe(true)
    expect(Object.keys(b.state.rows)).toHaveLength(10)
    expect(b.state).toEqual(a.state)
  })

  it('conflicting Type25 payload for the same vendor timestamp is preserved and flagged, never overwritten', async () => {
    const first = await mapType25DetailRecord(type25({}), CONTEXT)
    const conflicting = await mapType25DetailRecord(type25({ detailMinterStep: '12', arraySteps: '12 0 0 0 0 0 0 0 0 0' }, { sourceEnvelopeId: 'env-conflict' }), CONTEXT)
    const a = applyActivityCanonicalObservations(emptyActivityLedger(), first.observations)
    const b = applyActivityCanonicalObservations(a.state, conflicting.observations)
    expect(b.outcomes.every((o) => o.outcome === 'CONFLICT_PRESERVED')).toBe(true)
    expect(Object.keys(b.state.rows)).toHaveLength(10)
    const slot0 = Object.values(b.state.rows).find((r) => r.observation.provenance.sourceArraySlotIndex === 0)!
    expect(slot0.observation.value).toBe(10)
    expect(slot0.sourceConflict).toBe(true)
    expect(slot0.ancestry.map((s) => s.sourceEnvelopeId)).toEqual(['023d885d-bfec-40d2-823c-bb36b8553407'])
    expect(slot0.conflictingSources).toEqual([expect.objectContaining({ sourceEnvelopeId: 'env-conflict', value: 12 })])
  })

  it('Type25 policy is scoped to PRO_V8 + v8sdk2.0 + FW 0.0.8.8; other scopes require regression qualification', async () => {
    for (const scope of [{ firmwareVersion: '0.0.8.9' }, { sdkVersion: 'v8sdk2.1' }, { deviceModel: 'PRO_V9' }, { firmwareVersion: null }]) {
      const context = { ...CONTEXT, ...scope }
      const t25 = await mapType25DetailRecord(type25({}), context)
      expect(t25.observations).toEqual([])
      expect(t25.withheld[0].reason).toBe('POLICY_SCOPE_MISMATCH')
    }
    expect(TYPE25_MINUTE_ANCHOR_POLICY).toMatchObject({ deviceModel: 'PRO_V8', sdkVersion: 'v8sdk2.0', firmwareVersion: '0.0.8.8' })
  })

  it('Type25 scope never withholds Type24 daily authority; SDK/FW are recorded in Type24 provenance', async () => {
    for (const scope of [{ firmwareVersion: '0.0.8.9' }, { sdkVersion: 'v8sdk2.1' }, { firmwareVersion: null, sdkVersion: null }]) {
      const context = { ...CONTEXT, ...scope }
      const t24 = await mapType24DailyRecord(type24({}), context, NOW_SAME_DAY)
      expect(t24.withheld).toEqual([])
      expect(t24.observations.map((o) => o.metric).sort()).toEqual(['DAILY_CALORIES', 'DAILY_DISTANCE', 'DAILY_STEPS', 'EXERCISE_DURATION'])
      for (const o of t24.observations) {
        expect(o.provenance.firmwareVersion).toBe(context.firmwareVersion ?? '')
        expect(o.provenance.sdkVersion).toBe(context.sdkVersion ?? '')
        expect(o.provenance.semanticPolicyId).toBe('jcvital.type24.daily_activity.v1')
      }
    }
  })
})

describe('P1-2C daily vs intraday authority', () => {
  it('Type25 minute steps never replace Type24 daily steps, distance or calories', async () => {
    const t24 = await daily({ step: '4321', distance: '2.87', calories: '153.40' })
    const t25 = await mapType25DetailRecord(type25({}), CONTEXT)
    const ledger = applyActivityCanonicalObservations(emptyActivityLedger(), [...t24.observations, ...t25.observations]).state
    const active = activeActivityObservations(ledger)
    expect(byMetric(active, 'DAILY_STEPS').value).toBe(4321)
    expect(byMetric(active, 'DAILY_DISTANCE').value).toBe(2.87)
    expect(byMetric(active, 'DAILY_CALORIES').value).toBe(153.4)
    expect(active.filter((o) => o.metric !== 'DETAILED_ACTIVITY_MINUTE_STEPS').every((o) => o.provenance.sourceDataType === '24')).toBe(true)
    expect(t25.observations.every((o) => o.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS')).toBe(true)
    expect(t25.observations.some((o) => ['distance', 'calories', 'detailMinterStep'].includes(o.provenance.sourceField))).toBe(false)
  })

  it('rejects any daily metric sourced from Type25 (no Type25 daily steps/distance/calories)', async () => {
    const t24 = await daily()
    for (const metric of ['DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES'] as const) {
      const forged = structuredClone(byMetric(t24.observations, metric))
      forged.provenance.sourceDataType = '25'
      forged.canonicalIdentityKey += '|t25'
      expect(() => assertActivityAuthority(forged)).toThrow()
      const result = applyActivityCanonicalObservations(emptyActivityLedger(), [forged])
      expect(result.outcomes[0].outcome).toBe('REJECTED_DAILY_AUTHORITY')
      expect(result.state.rows).toEqual({})
    }
  })
})

describe('P1-2C source authority JCVITAL_NATIVE > ROOK', () => {
  const asRook = (o: ActivityCanonicalObservation, value: number, device = DEVICE): ActivityCanonicalObservation => {
    const rook = structuredClone(o)
    rook.providerAuthority = 'ROOK'
    rook.value = value
    rook.canonicalIdentityKey = rook.canonicalIdentityKey.replace('JCVITAL_NATIVE', 'ROOK')
    rook.measurementKey = rook.measurementKey.replace(DEVICE, device)
    rook.provenance = { ...rook.provenance, provider: 'ROOK', sourceConnector: 'ROOK', sourceEnvelopeId: 'rook-env', sourcePayloadFingerprint: `rook-${value}` }
    return rook
  }

  it('native V8 wins over a later ROOK duplicate of the same V8 measurement; ROOK raw preserved', async () => {
    const native = byMetric((await daily()).observations, 'DAILY_STEPS')
    const result = applyActivityCanonicalObservations(emptyActivityLedger(), [native, asRook(native, 4300)])
    expect(result.outcomes.map((o) => o.outcome)).toEqual(['CREATED', 'SUPERSEDED_BY_HIGHER_AUTHORITY'])
    const rows = Object.values(result.state.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0].observation).toMatchObject({ providerAuthority: 'JCVITAL_NATIVE', value: 4321 })
    expect(rows[0].supersededSources).toEqual([expect.objectContaining({ providerAuthority: 'ROOK', value: 4300 })])
  })

  it('native V8 replaces an earlier ROOK copy of the same measurement once, keeping ROOK ancestry', async () => {
    const native = byMetric((await daily()).observations, 'DAILY_STEPS')
    const result = applyActivityCanonicalObservations(emptyActivityLedger(), [asRook(native, 4300), native])
    expect(result.outcomes.map((o) => o.outcome)).toEqual(['CREATED', 'REPLACED_LOWER_AUTHORITY'])
    const rows = Object.values(result.state.rows)
    expect(rows).toHaveLength(1)
    expect(rows[0].observation.providerAuthority).toBe('JCVITAL_NATIVE')
    expect(rows[0].supersededSources[0]).toMatchObject({ providerAuthority: 'ROOK', value: 4300 })
  })

  it('does not suppress ROOK data from a different wearable', async () => {
    const native = byMetric((await daily()).observations, 'DAILY_STEPS')
    const result = applyActivityCanonicalObservations(emptyActivityLedger(), [native, asRook(native, 9000, OTHER_DEVICE)])
    expect(result.outcomes.map((o) => o.outcome)).toEqual(['CREATED', 'CREATED'])
    expect(Object.keys(result.state.rows)).toHaveLength(2)
  })
})

describe('P1-2C provenance, projection and end-to-end canonicalization', () => {
  it('records complete provenance and the semantic policy version on every observation', async () => {
    const t24 = await daily()
    const t25 = await mapType25DetailRecord(type25({}), CONTEXT)
    for (const o of [...t24.observations, ...t25.observations]) {
      expect(o.provenance).toMatchObject({
        provider: 'JCVITAL', connector: 'jcvital_native', sourceConnector: 'JCVITAL_NATIVE', deviceScopeId: DEVICE, deviceModel: 'PRO_V8',
        firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0', timezone: TZ, timezoneSource: 'PHONE_TIMEZONE', normalizerVersion: ACTIVITY_NORMALIZER_VERSION,
      })
      for (const key of ['sourceDataType', 'sourceField', 'sourceEnvelopeId', 'sourceRecordId', 'acquisitionSessionId', 'observedLocalDate', 'observedLocalTime',
        'semanticPolicyId', 'semanticConfidence', 'vendorDerived', 'measured', 'sourcePayloadFingerprint']) {
        expect(o.provenance[key as keyof typeof o.provenance], key).not.toBeUndefined()
        expect(o.provenance[key as keyof typeof o.provenance], key).not.toBeNull()
      }
      expect(JSON.stringify(o)).not.toMatch(/([0-9A-F]{2}:){5}[0-9A-F]{2}/i)
    }
    expect(t24.observations.every((o) => o.provenance.semanticPolicyId === 'jcvital.type24.daily_activity.v1')).toBe(true)
    expect(t25.observations.every((o) => o.provenance.semanticPolicyId === 'jcvital.type25.minute_anchor.v1'
      && o.provenance.sourceType25VendorDate && o.provenance.resolvedMinuteTimestamp && Number.isInteger(o.provenance.sourceArraySlotIndex))).toBe(true)
  })

  it('projects to a valid Base44 NativeObservationInput with canonical identity for server upsert (prepared, unpublished)', async () => {
    const t25 = await mapType25DetailRecord(type25({}), CONTEXT)
    const input = await toActivityNativeObservationInput(OWNER, t25.observations[0])
    expect(input).toMatchObject({
      metric: 'activity.minute_steps', metricType: 'DETAILED_ACTIVITY_MINUTE_STEPS', valueNumber: 10, unit: 'count',
      startTime: '2026-10-20T17:28:53.000Z', endTime: '2026-10-20T17:29:53.000Z', deviceId: DEVICE, vendorDataType: '25', vendorField: 'arraySteps',
    })
    expect(input.rawSourceMetadata).toMatchObject({ canonicalIdentityKey: t25.observations[0].canonicalIdentityKey, semanticPolicyId: TYPE25_MINUTE_ANCHOR_POLICY_ID, sourceArraySlotIndex: 0 })
    const duration = await toActivityNativeObservationInput(OWNER, byMetric((await daily()).observations, 'EXERCISE_DURATION'))
    expect(duration.rawSourceMetadata).toMatchObject({ vendor_exercise_duration_seconds: 1530, vendor_exercise_duration_minutes: 25.5, consumerLabel: 'V8 Exercise Duration' })
    expect(ACTIVITY_BASE44_CANONICAL_PREP).toMatchObject({ preparedLocally: true, published: false, existingProductionActivityRevisionUnchanged: true })
    expect(new Set(ACTIVITY_BASE44_CANONICAL_PREP.targets.map((t) => t.canonicalTarget)).size).toBe(5)
  })

  it('retains every required Activity provenance field in all five Base44 payload projections', async () => {
    const mapped = [
      ...(await daily({ distance: '12.345', calories: '153.47', exerciseMinutes: '1537' })).observations,
      ...(await mapType25DetailRecord(type25({}), CONTEXT)).observations,
    ]
    for (const observation of mapped) {
      const input = await toActivityNativeObservationInput(OWNER, observation)
      const p = observation.provenance
      expect(input).toMatchObject({
        metric: observation.canonicalTarget, metricType: observation.metric,
        valueNumber: observation.value, unit: observation.unit,
        provider: p.provider, source: p.connector, sourceConnector: p.sourceConnector,
        sourceId: p.deviceScopeId, deviceId: p.deviceScopeId, deviceModel: p.deviceModel,
        firmwareVersion: p.firmwareVersion, sdkVersion: p.sdkVersion,
        vendorDataType: p.sourceDataType, vendorField: p.sourceField,
        sourceRecordGroupId: p.sourceRecordId, sessionId: p.acquisitionSessionId,
        timezone: p.timezone, timestampTimezoneSource: p.timezoneSource,
        rawSourceMetadata: {
          sourceEnvelopeId: p.sourceEnvelopeId, sourcePayloadFingerprint: p.sourcePayloadFingerprint,
          canonicalIdentityKey: observation.canonicalIdentityKey,
          sourceLocalDate: observation.sourceLocalDate,
          observedLocalDate: p.observedLocalDate, observedLocalTime: p.observedLocalTime,
          semanticPolicyId: p.semanticPolicyId, normalizerVersion: p.normalizerVersion,
          semanticConfidence: p.semanticConfidence, vendorDerived: p.vendorDerived, measured: p.measured,
        },
      })
      expect(input.sourceRecordId).toBe(`${p.sourceRecordId}|${observation.metric}|${p.sourceArraySlotIndex ?? 0}`)
      if (observation.metric === 'EXERCISE_DURATION') {
        expect(input.valueNumber).toBe(1537)
        expect(input.unit).toBe('second')
        expect(input.rawSourceMetadata).toMatchObject({
          vendor_exercise_duration_seconds: 1537, vendor_exercise_duration_minutes: 1537 / 60,
        })
      }
      if (observation.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS') {
        expect(input.rawSourceMetadata).toMatchObject({
          sourceType25VendorDate: p.sourceType25VendorDate, sourceArraySlotIndex: p.sourceArraySlotIndex,
          resolvedMinuteTimestamp: input.startTime, semanticPolicyId: 'jcvital.type25.minute_anchor.v1',
        })
      }
      expect(JSON.parse(JSON.stringify(input))).toEqual(input)
    }
  })

  it('distinguishes transport replay identity from canonical daily upsert and minute conflict identity', async () => {
    const original = byMetric((await daily()).observations, 'DAILY_STEPS')
    const corrected = byMetric((await daily({ step: '5000' })).observations, 'DAILY_STEPS')
    const before = await toActivityNativeObservationInput(OWNER, original)
    const after = await toActivityNativeObservationInput(OWNER, corrected)
    expect(after.observationId).not.toBe(before.observationId)
    expect(after.rawSourceMetadata?.canonicalIdentityKey).toBe(before.rawSourceMetadata?.canonicalIdentityKey)
    expect(after.sourceRecordId).toBe(before.sourceRecordId)
    expect(await toActivityNativeObservationInput(OWNER, original)).toEqual(before)
    const first = (await mapType25DetailRecord(type25({}), CONTEXT)).observations[0]
    const conflict = (await mapType25DetailRecord(type25({ detailMinterStep: '12', arraySteps: '12 0 0 0 0 0 0 0 0 0' }), CONTEXT)).observations[0]
    const minute = await toActivityNativeObservationInput(OWNER, first)
    const changed = await toActivityNativeObservationInput(OWNER, conflict)
    expect(changed.observationId).not.toBe(minute.observationId)
    expect(changed.rawSourceMetadata?.canonicalIdentityKey).toBe(minute.rawSourceMetadata?.canonicalIdentityKey)
    expect(changed.rawSourceMetadata?.sourcePayloadFingerprint).not.toBe(minute.rawSourceMetadata?.sourcePayloadFingerprint)
    expect(changed.startTime).toBe(minute.startTime)
  })

  it('canonicalizes native normalizer output end to end without mutating native evidence', async () => {
    const base = {
      source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: DEVICE, macAddress: null, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
      observedAtSource: null, receivedAt: '2026-10-20T21:46:00.000Z', timezone: TZ, values: null, unit: null, acquisitionMode: 'HISTORICAL_SYNC' as const,
      measurementContext: null, sessionId: 'session-x', packetId: null, sampleRateHz: null, samplingIntervalMs: null, signalQuality: null, completeness: null,
      vendorDerived: false,
    }
    const t25Record = { date: '2026.10.20 10:28:53', detailMinterStep: '10', arraySteps: '10 0 0 0 0 0 0 0 0 0', distance: '0.01', calories: '0.40' }
    const t24Record = { date: '2026.10.20', step: '4321', distance: '2.87', calories: '153.40', exerciseMinutes: '1530', goal: '80' }
    const natives: NativeObservation[] = [
      ...Array.from({ length: 10 }, (_, i) => ({ ...base, id: `n25-${i}`, metricType: 'DETAILED_ACTIVITY_EPOCH' as const, observedAt: null, value: 0, sequenceNumber: i,
        vendorDataType: '25', vendorField: 'arraySteps', rawPayload: { vendorEnvelope: { dataType: 25 }, record: t25Record } as SerializableValue,
        provenance: { sourceEnvelopeId: 'env-25', sourceRecordId: `rec25-${i}`, sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', parserVersion: 'phase3b-1' } })),
      ...['step', 'distance', 'calories', 'exerciseMinutes', 'goal'].map((field) => ({ ...base, id: `n24-${field}`, metricType: 'DAILY_STEPS' as const, observedAt: null, value: 0,
        sequenceNumber: null, vendorDataType: '24', vendorField: field, rawPayload: { vendorEnvelope: { dataType: 24 }, record: t24Record } as SerializableValue,
        provenance: { sourceEnvelopeId: 'env-24', sourceRecordId: `rec24-${field}`, sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', parserVersion: 'phase3b-1' } })),
    ]
    const frozen = structuredClone(natives)
    expect(activitySourceRecordsFromNative(natives)).toHaveLength(2)
    const result = await canonicalizeActivity(natives, CONTEXT, emptyActivityLedger(), NOW_SAME_DAY)
    expect(natives).toEqual(frozen)
    expect(result.withheld).toEqual([])
    expect(result.observations).toHaveLength(14)
    expect(result.outcomes.every((o) => o.outcome === 'CREATED')).toBe(true)
    const again = await canonicalizeActivity(natives, CONTEXT, result.ledger, NOW_SAME_DAY)
    expect(again.outcomes.every((o) => o.outcome === 'DUPLICATE')).toBe(true)
    expect(again.ledger).toEqual(result.ledger)
  })
})
