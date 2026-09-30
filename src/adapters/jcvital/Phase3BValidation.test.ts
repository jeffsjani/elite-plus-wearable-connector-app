import { describe, expect, it } from 'vitest'
import { AcquisitionMode, CompletionStatus, MetricType } from '../../models/metricTaxonomy'
import type { NativeObservation } from '../../models/wearableObservation'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import type { HistoricalFeedRun } from './Phase3AValidation'
import { buildDetailedActivityResult, buildPhase3BExportResults, buildSleepResult, buildWorkoutResult } from './Phase3BValidation'

function observation(overrides: Partial<NativeObservation>): NativeObservation {
  return {
    id: 'observation-1',
    source: {
      connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: 'device-1',
      macAddress: null, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0',
    },
    metricType: MetricType.DAILY_STEPS,
    observedAt: '2026-09-30T22:00:00.000Z', observedAtSource: '2026.09.30 22:00:00',
    receivedAt: '2026-09-30T23:00:00.000Z', timezone: 'UTC', value: 1, values: null, unit: 'count',
    acquisitionMode: AcquisitionMode.HISTORICAL_SYNC, measurementContext: null, sessionId: 'sync-1', packetId: null,
    sequenceNumber: null, samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: null,
    vendorDataType: '24', vendorField: 'step', vendorDerived: false,
    rawPayload: { record: { date: '2026.09.30 22:00:00' } },
    provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
    ...overrides,
  }
}

function run(observations: NativeObservation[], overrides: Partial<JCVitalV8HistoricalSyncResult> = {}): HistoricalFeedRun {
  return {
    requestStartedAt: '2026-09-30T21:59:00.000Z', requestCompletedAt: '2026-09-30T23:00:01.000Z', error: null,
    result: {
      syncId: 'sync-1', deviceId: 'device-1', provider: 'JCVITAL', sdkCommand: 'fixture', vendorDataType: '24',
      startedAt: '2026-09-30T21:59:00.000Z', completedAt: '2026-09-30T23:00:01.000Z',
      recordsReceived: observations.length, recordGroupsReceived: 1, recordsStored: 0, recordsDeduplicated: 0,
      recordsRejected: 0, earliestObservation: observations[0]?.observedAt ?? null,
      latestObservation: observations.at(-1)?.observedAt ?? null, partial: false,
      completionStatus: CompletionStatus.COMPLETE, packetCount: 1, parseErrors: [], observations,
      ...overrides,
    },
  }
}

describe('Phase 3B diagnostics', () => {
  it('reports detailed activity epochs without discarding the source array', () => {
    const epochs = [1, 2, 3].map((value, sequenceNumber) => observation({
      id: `epoch-${sequenceNumber}`, metricType: MetricType.DETAILED_ACTIVITY_EPOCH,
      value, sequenceNumber, samplingIntervalMs: 60_000, vendorDataType: '25',
      rawPayload: { record: { arraySteps: '1 2 3' } },
    }))
    const result = buildDetailedActivityResult(run(epochs))

    expect(result.sampleDiagnostics).toMatchObject({ blockCount: 1, epochCount: 3, epochDurationSeconds: 60, sourceArrayPreserved: true })
  })

  it('reconciles sleep duration while retaining every undocumented stage as UNKNOWN', () => {
    const stageRun = run([
      observation({
        id: 'sleep-1', metricType: MetricType.SLEEP_EPISODE, values: [0, 1, 2, 9], value: null,
        samplingIntervalMs: 300_000, acquisitionMode: AcquisitionMode.SLEEP, vendorDataType: '26',
        rawPayload: { record: { arraySleepQuality: '0 1 2 9', sleepUnitLength: '5' } },
      }),
    ], { vendorDataType: '26' })
    const movementRun = run([
      observation({
        id: 'movement-1', metricType: MetricType.SLEEP_MOVEMENT, values: [1, 2, 3], value: null,
        acquisitionMode: AcquisitionMode.SLEEP, vendorDataType: '121', observedAtSource: '2026-09-30 22:00:00',
      }),
      observation({
        id: 'detail-stage-1', metricType: MetricType.SLEEP_STAGE_DETAIL_RAW, values: [0, 1, 2, 3], value: null,
        acquisitionMode: AcquisitionMode.SLEEP, vendorDataType: '121', observedAtSource: '2026-09-30 22:00:00',
      }),
    ], { vendorDataType: '121' })
    const result = buildSleepResult({ stages: stageRun, movement: movementRun })
    const episode = result.sampleDiagnostics.episodes[0]

    expect(result.completionStatus).toBe('COMPLETE')
    expect(episode).toMatchObject({
      epochDurationSeconds: 300, epochCount: 4, unknownEpochCount: 4,
      movementSampleCount: 3, calculatedStageDurationMinutes: 20,
      stageMappingStatus: 'UNDERDOCUMENTED_ALL_CODES_PRESERVED_AS_UNKNOWN',
    })
    expect(episode.sourceStageCodes).toEqual([0, 1, 2, 9])
  })

  it('reports partial sleep when movement response is absent rather than correcting data', () => {
    const stageRun = run([observation({
      metricType: MetricType.SLEEP_EPISODE, values: [], value: null,
      samplingIntervalMs: 60_000, acquisitionMode: AcquisitionMode.SLEEP, vendorDataType: '26',
    })], { vendorDataType: '26' })

    expect(buildSleepResult({ stages: stageRun }).completionStatus).toBe('PARTIAL')
  })

  it('groups duplicate-safe workout metrics into one session and reports no Android METS', () => {
    const rawPayload = { record: { sportModel: '99', heartRate: '120', step: '500' } }
    const workoutRun = run([
      observation({ id: 'type', metricType: MetricType.WORKOUT_TYPE, value: 'OTHER_VENDOR_MODE_99', vendorDataType: '29', rawPayload }),
      observation({ id: 'hr', metricType: MetricType.WORKOUT_HR, value: 120, vendorDataType: '29', rawPayload }),
  observation({ id: 'steps', metricType: MetricType.WORKOUT_STEPS, value: 500, vendorDataType: '29', rawPayload }),
    ], { vendorDataType: '29', recordsDeduplicated: 2 })
    const result = buildWorkoutResult(workoutRun)

    expect(result.sampleDiagnostics.sessionCount).toBe(1)
    expect(result.sampleDiagnostics.sessions[0]).toMatchObject({
      vendorActivityMode: 99, canonicalActivityType: 'OTHER_VENDOR_MODE_99', mets: null,
      metsSupportStatus: 'NOT_EMITTED_ANDROID',
    })
    expect(result.recordsDeduplicated).toBe(2)
  })

  it('reports METS only when an explicit observation is emitted', () => {
    const rawPayload = { record: { sportModel: '0', mets: '8.2' } }
    const result = buildWorkoutResult(run([
      observation({ id: 'type', metricType: MetricType.WORKOUT_TYPE, value: 'RUN', vendorDataType: '29', rawPayload }),
      observation({ id: 'mets', metricType: MetricType.WORKOUT_METS, value: 8.2, unit: 'MET', vendorDataType: '29', rawPayload }),
    ], { vendorDataType: '29' }))

    expect(result.sampleDiagnostics).toMatchObject({ metsSupportStatus: 'EMITTED' })
    expect(result.sampleDiagnostics.sessions[0]).toMatchObject({ mets: 8.2, metsSupportStatus: 'EMITTED' })
  })

  it('removes bulk raw payloads from export summaries but retains first/last samples', () => {
    const rawPayload = { record: { sportModel: '0' } }
    const workouts = run([
      observation({ id: 'type', metricType: MetricType.WORKOUT_TYPE, value: 'RUN', vendorDataType: '29', rawPayload }),
    ], { vendorDataType: '29' })
    const exported = buildPhase3BExportResults({ workouts })

    expect(exported.workouts.sampleDiagnostics.sessions[0]).not.toHaveProperty('rawVendorPayload')
    expect(JSON.stringify(exported.workouts.firstFive)).toContain('rawVendorPayload')
  })
})
