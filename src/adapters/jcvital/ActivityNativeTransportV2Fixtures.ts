import {
  activeActivityObservations,
  applyActivityCanonicalObservations,
  emptyActivityLedger,
  mapActivitySourceRecords,
  type ActivityDeviceContext,
  type ActivitySourceRecord,
} from './ActivityProductionCanonical'
import { ACTIVITY_NATIVE_TRANSPORT_V2, prepareActivityNativeTransportV2 } from './ActivityNativeTransportV2'

export const ACTIVITY_V2_FIXTURE_CONTEXT: ActivityDeviceContext = {
  ownerUserId: 'fixture-owner-p1-2d',
  deviceId: 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b',
  deviceModel: 'PRO_V8', sdkVersion: 'v8sdk2.0', firmwareVersion: '0.0.8.8',
}

export function activityV2FixtureSource(type: '24' | '25', fields: Record<string, unknown> = {}, envelope = `fixture-type${type}`): ActivitySourceRecord {
  return {
    vendorDataType: type,
    record: type === '24'
      ? { date: '2026.10.20', step: '4321', distance: '12.345', calories: '153.47', exerciseMinutes: '1537', goal: '80', ...fields }
      : { date: '2026.10.20 10:28:53', detailMinterStep: '10', arraySteps: '10 0 0 0 0 0 0 0 0 0', distance: '0.01', calories: '0.40', ...fields },
    sourceEnvelopeId: envelope, acquisitionSessionId: 'fixture-session-p1-2d',
    nativeObservationIds: [`${envelope}-native`], nativeSourceRecordIds: [`${envelope}-record`],
    parserVersion: 'phase3b-1', receivedAt: '2026-10-20T22:00:00.000Z', timezone: 'America/Los_Angeles',
  }
}

/** Deterministic offline server handoff: outgoing native payloads plus the unchanged v65 oracle. */
export async function generateActivityNativeTransportV2Fixture() {
  const day = activityV2FixtureSource('24')
  const minute = activityV2FixtureSource('25', {}, '023d885d-bfec-40d2-823c-bb36b8553407')
  const correction = activityV2FixtureSource('24', { step: '5000', distance: '3.31', calories: '170.00', exerciseMinutes: '1801' }, 'fixture-type24-correction')
  correction.receivedAt = '2026-10-20T23:00:00.000Z'
  const historical = activityV2FixtureSource('24', { date: '2026.10.18' }, 'fixture-type24-historical')
  const cases: Array<{ name: string; expectedBehavior: string; sources: ActivitySourceRecord[] }> = [
    { name: 'qualified-type24-and-physical-type25-example', expectedBehavior: '4 daily canonical rows and 10 minute rows; goal remains native-only.', sources: [day, minute] },
    { name: 'type24-same-day-correction', expectedBehavior: 'Same daily identity, updated value, 4 rows, both source ancestries retained.', sources: [day, correction] },
    { name: 'type24-historical-replay', expectedBehavior: 'FINAL daily rows; replay adds no canonical rows.', sources: [historical, { ...historical, sourceEnvelopeId: 'fixture-historical-replay' }] },
    { name: 'type25-exact-replay', expectedBehavior: '10 minute rows; replay is DUPLICATE, no added epochs.', sources: [minute, { ...minute, sourceEnvelopeId: 'fixture-minute-replay' }] },
    { name: 'type25-conflicting-replay', expectedBehavior: 'Same vendor date with changed payload: both sources preserved, original 10 minutes retained, CONFLICT_PRESERVED.', sources: [
      minute, activityV2FixtureSource('25', { detailMinterStep: '12', arraySteps: '12 0 0 0 0 0 0 0 0 0' }, 'fixture-minute-conflict'),
    ] },
    { name: 'type25-invalid-array-length', expectedBehavior: 'Integrity FAIL, ARRAY_LENGTH_NOT_10, raw record retained; no canonical minutes.', sources: [
      activityV2FixtureSource('25', { arraySteps: '10 0 0 0 0 0 0 0 0' }, 'fixture-minute-invalid-length'),
    ] },
    { name: 'type25-sum-mismatch', expectedBehavior: 'Integrity FAIL, SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP, raw record retained; no canonical minutes.', sources: [
      activityV2FixtureSource('25', { detailMinterStep: '11' }, 'fixture-minute-sum-mismatch'),
    ] },
    { name: 'type25-missing-segment', expectedBehavior: '20 minute rows for two returned records; missing middle segment has no synthetic zeros.', sources: [
      activityV2FixtureSource('25', { date: '2026.10.20 10:16:06' }, 'fixture-minute-before-gap'),
      activityV2FixtureSource('25', { date: '2026.10.20 10:46:06' }, 'fixture-minute-after-gap'),
    ] },
    { name: 'type25-never-replaces-type24-daily-authority', expectedBehavior: 'Type25 supporting distance/calories and minute sums do not change any Type24 daily value.', sources: [
      day, activityV2FixtureSource('25', { distance: '999', calories: '999', detailMinterStep: '100', arraySteps: '100 0 0 0 0 0 0 0 0 0' }, 'fixture-minute-not-daily'),
    ] },
  ]
  const scenarios = []
  for (const scenario of cases) {
    let ledger = emptyActivityLedger()
    const actions = []
    for (const source of scenario.sources) {
      const transport = await prepareActivityNativeTransportV2(source, ACTIVITY_V2_FIXTURE_CONTEXT)
      const reference = await mapActivitySourceRecords([source], ACTIVITY_V2_FIXTURE_CONTEXT, Date.parse(source.receivedAt))
      const applied = applyActivityCanonicalObservations(ledger, reference.observations)
      ledger = applied.state
      actions.push({
        source, outgoingNativeObservations: transport.payloads,
        expectedCanonicalOutput: reference.observations,
        expectedWithheld: reference.withheld, expectedLedgerOutcomes: applied.outcomes,
      })
    }
    scenarios.push({
      name: scenario.name, expectedBehavior: scenario.expectedBehavior, actions,
      expectedFinalCanonicalRows: activeActivityObservations(ledger).map((row) => ({
        canonicalIdentityKey: row.canonicalIdentityKey, metric: row.metric, value: row.value, unit: row.unit,
        observedAt: row.observedAt, dailyState: row.dailyState ?? null,
      })),
      expectedSourceConflicts: Object.values(ledger.rows).filter((row) => row.sourceConflict).map((row) => ({
        canonicalIdentityKey: row.observation.canonicalIdentityKey, conflictingSources: row.conflictingSources,
      })),
    })
  }
  return {
    schema: 'eliteplus.p1-2d.activity-native-transport-fixture.v1',
    transportVersion: ACTIVITY_NATIVE_TRANSPORT_V2,
    generatedOffline: true, productionCallerEnabled: false,
    currentLiveRevisionReportedByBase44: 'nc-observations-v8-provenance-2026-10-16-r6-provenance-observability',
    proposedServerRevision: 'nc-observations-2026-10-21-r7-activity-canonical',
    evidenceNote: 'Type25 date/steps example is from qualified P1-2B evidence; owner/device/session identifiers and Type24 values are synthetic fixtures, not a claim of another physical acquisition.',
    context: ACTIVITY_V2_FIXTURE_CONTEXT, scenarios,
  }
}
