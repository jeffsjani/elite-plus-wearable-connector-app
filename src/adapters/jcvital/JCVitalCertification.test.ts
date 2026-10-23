import { describe, expect, it, vi } from 'vitest'
import type { NativeObservation } from '../../models/wearableObservation'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import { MAX_CONCURRENCY } from '../../services/sync/ObservationBatchManager'
import { BLUETOOTH_MAC_PATTERN } from '../../services/storage/JCVitalDeviceIdentityService'
import { buildJCVitalCertification, CERTIFICATION_ORDER, CertificationDeliveryEvidence, sanitizeCertificationExport, type CertificationOptions } from './JCVitalCertification'
import { buildPhase3AValidationReport, type HistoricalFeedRun } from './Phase3AValidation'
import { mapPhysiologyObservation } from './PhysiologyContract'
import { buildWorkoutHrObservation } from './WorkoutHrDelivery'
import type { LiveWorkoutPacket, LiveWorkoutSession } from './WorkoutTelemetry'
import { EMPTY_RAW_PPG_CHUNK_SUMMARY } from './RawPpgDiagnostics'

const deviceId = 'jcvital_device_12345678-1234-4123-8123-123456789abc'
const context = { deviceId, firmwareVersion: '0.0.3.4', sdkVersion: 'v8sdk2.0', vendorActivityMode: 0 }
const time = '2026-10-03T10:00:00.000Z'

function native(overrides: Partial<NativeObservation> = {}): NativeObservation {
  return {
    id: 'capture-1',
    source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8',
      deviceId: 'AA:BB:CC:DD:EE:FF', macAddress: 'AA:BB:CC:DD:EE:FF', firmwareVersion: '0.0.3.4', sdkVersion: 'v8sdk2.0' },
    metricType: 'SPO2', value: 97, values: null, unit: 'percent',
    observedAt: time, observedAtSource: '2026.10.03 10:00:00', receivedAt: '2026-10-03T10:01:00.000Z',
    timezone: 'UTC', acquisitionMode: 'HISTORICAL_SYNC', measurementContext: null, sessionId: 'sync-1',
    packetId: null, sequenceNumber: 0, samplingIntervalMs: null, sampleRateHz: null, signalQuality: null,
    completeness: 'COMPLETE', vendorDataType: '68', vendorField: 'Blood_oxygen', vendorDerived: false,
    rawPayload: { record: { Blood_oxygen: '97' } }, provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
    ...overrides,
  }
}

function run(observations: NativeObservation[], status: 'COMPLETE' | 'PARTIAL' | 'EMPTY_VALID' = 'COMPLETE'): HistoricalFeedRun {
  return {
    requestStartedAt: time, requestCompletedAt: '2026-10-03T10:01:01.000Z', error: null,
    result: {
      syncId: 'sync-1', deviceId: 'AA:BB:CC:DD:EE:FF', provider: 'JCVITAL', sdkCommand: 'fixture',
      vendorDataType: observations[0]?.vendorDataType ?? '44', startedAt: time, completedAt: '2026-10-03T10:01:01.000Z',
      recordsReceived: observations.length, recordGroupsReceived: observations.length ? 1 : 0,
      recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0,
      earliestObservation: observations[0]?.observedAt ?? null, latestObservation: observations.at(-1)?.observedAt ?? null,
      partial: status === 'PARTIAL', completionStatus: status, packetCount: 1, parseErrors: [], observations,
    },
  }
}

function options(overrides: Partial<CertificationOptions> = {}): CertificationOptions {
  return { historicalRuns: {}, ownerUserId: 'owner-1', physiologyContext: context, workoutContext: context, ...overrides }
}

function event(ids: string[], overrides: Partial<BatchDeliveryEvent> = {}): BatchDeliveryEvent {
  return {
    batchId: 'batch-1', attemptedAt: time, outcome: 'DELIVERED', observationIds: ids, acknowledgedIds: ids,
    rejectedIds: [], httpStatus: 200, errorCode: null, accepted: ids.length, duplicate: 0, rejected: 0,
    results: ids.map((id) => ({ observationId: id, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: `native-${id}` })),
    ...overrides,
  }
}

describe('read-only V8 certification evidence', () => {
  it('exports all required sections and fields without claiming unperformed physical tests', async () => {
    const report = await buildJCVitalCertification(options())
    for (const key of CERTIFICATION_ORDER) {
      expect(report[key]).toHaveProperty('physicalCaptureStatus')
      for (const field of ['sourceRecordCount', 'observationCount', 'firstObservation', 'lastObservation',
        'sampleObservations', 'unit', 'timestampPolicy', 'vendorDataType', 'deliveryPolicy', 'canonicalTarget',
        'parseErrorCount', 'notDeliverableCount', 'unknownSemantics', 'certificationNotes']) {
        expect(report[key]).toHaveProperty(field)
      }
    }
    expect(report.spo2.physicalCaptureStatus).toBe('NOT_CAPTURED')
    expect(report.sleep.certificationNotes).not.toContain('PHYSICAL_DATA = EMPTY')
    expect(report.workoutHistory.certificationNotes).not.toContain('PHYSICAL_WORKOUT_HISTORY = EMPTY')
    expect(report.ecg.physicalCaptureStatus).toBe('BLOCKED_VENDOR_GUIDANCE')
    expect(report.baseline).toMatchObject({ batchSize: 100, productionDefaultConcurrency: 1, productionMaximumConcurrency: 1, asynchronousCanonicalization: false })
    expect(MAX_CONCURRENCY).toBe(1)
  })

  it('uses the real mapping for exact SpO2 backend identifiers, units and timestamp provenance', async () => {
    const capture = native()
    const mapped = await mapPhysiologyObservation('owner-1', capture, context)
    expect(mapped[0].status).toBe('MAPPED')
    if (mapped[0].status !== 'MAPPED') throw new Error('fixture did not map')
    const evidence = new CertificationDeliveryEvidence()
    evidence.record('owner-1', event([mapped[0].observation.observationId]))
    const report = await buildJCVitalCertification(options({
      historicalRuns: { spo2: run([capture]) }, deliveryEvidence: evidence.snapshot('owner-1'),
    }))
    expect(report.spo2.observations[0]).toMatchObject({
      observationId: mapped[0].observation.observationId, sourceRecordId: mapped[0].observation.sourceRecordId,
      sourceRecordGroupId: mapped[0].observation.sourceRecordGroupId,
      metric: 'oxygenSaturation', value: 97, unit: 'percent', canonicalTarget: 'body.oxygen_saturation',
      timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampTimezoneSource: 'PHONE_TIMEZONE',
      timestampConfidence: 'DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE', deviceOpaqueId: deviceId,
      deliveryResult: { acknowledged: true, result: { status: 'accepted', canonicalStatus: 'canonicalized' } },
    })
    expect(report.handoff.find((item) => item.METRIC === 'spo2')?.samples[0].OBSERVATION_ID).toBe(mapped[0].observation.observationId)
  })

  it('does not turn a computed ID into a claimed delivery success', async () => {
    const report = await buildJCVitalCertification(options({ historicalRuns: { spo2: run([native()]) } }))
    expect(report.spo2.observations[0].observationId).toMatch(/^[0-9a-f]{64}$/)
    expect(report.spo2.observations[0].deliveryResult).toBeNull()
    expect(report.spo2.physicalCaptureStatus).toBe('CAPTURED')
    expect(report.spo2.observations[0].deliveryState).toBe('CAPTURED_NOT_DELIVERED')
    expect(report.spo2.observations[0].nativeObservationId).toBeNull()
    expect(report.spo2.observations[0].mappingStatus).toContain('NOT_PROOF_OF_DELIVERY')
  })

  it('reads queue state only for bounded samples and propagates diagnostic read failures', async () => {
    const capture = run(Array.from({ length: 25 }, (_, sequenceNumber) => native({ sequenceNumber })))
    const readQueueRecord = vi.fn().mockResolvedValue(null)
    const report = await buildJCVitalCertification(options({
      historicalRuns: { spo2: capture }, readQueueRecord,
    }))
    expect(report.spo2.observations).toHaveLength(25)
    expect(report.spo2.sampleObservations).toHaveLength(10)
    expect(readQueueRecord).toHaveBeenCalledTimes(10)
    expect(report.spo2.sampleObservations[0].queueState).toBeNull()
    await expect(buildJCVitalCertification(options({
      historicalRuns: { spo2: capture },
      readQueueRecord: async () => { throw new Error('queue read unavailable') },
    }))).rejects.toThrow('queue read unavailable')
  })

  it('preserves native evidence and reports missing mapping context explicitly', async () => {
    const report = await buildJCVitalCertification(options({
      ownerUserId: null, physiologyContext: { ...context, deviceId: null }, historicalRuns: { spo2: run([native()]) },
    }))
    expect(report.spo2.observations[0]).toMatchObject({ observationId: null, value: 97, mappingStatus: 'MAPPING_CONTEXT_UNAVAILABLE' })
  })

  it('preserves celsius wearable temperature and raw vendor value without core/Fahrenheit conversion', async () => {
    const report = await buildJCVitalCertification(options({ historicalRuns: { temperature: run([
      native({ metricType: 'WEARABLE_TEMPERATURE', vendorDataType: '59', vendorField: 'temperature',
        value: 36.4, unit: 'celsius', rawPayload: { record: { temperature: '36.4' } } }),
    ]) } }))
    expect(report.wearableTemperature.observations[0]).toMatchObject({
      metric: 'wearableTemperature', value: 36.4, unit: 'celsius', recordingMethod: 'WEARABLE_SKIN_SENSOR',
      canonicalTarget: 'body.wearable_temperature',
    })
    expect(report.wearableTemperature.rawVendorSamples[0].rawVendorRecord).toEqual({ temperature: '36.4' })
  })

  it('retains type-42 linkage, unknown units, distinct estimated BP and unmapped companion HR', async () => {
    const types = ['HRV_VENDOR', 'STRESS_VENDOR', 'BP_SYSTOLIC_ESTIMATED', 'BP_DIASTOLIC_ESTIMATED', 'HEART_RATE_AUTOMATIC'] as const
    const report = await buildJCVitalCertification(options({ historicalRuns: { hrv: run(types.map((metricType, index) => native({
      id: `type42-${index}`, metricType, vendorDataType: '42', value: [42, 3, 118, 76, 66][index],
      unit: metricType === 'HEART_RATE_AUTOMATIC' ? 'bpm' : 'UNKNOWN_VENDOR_UNIT', vendorDerived: true,
    }))) } }))
    const rows = [...report.hrv.observations, ...report.stress.observations, ...report.estimatedBp.observations]
    expect(new Set(rows.map((item) => item.sourceRecordGroupId)).size).toBe(1)
    expect(new Set(rows.map((item) => item.sourceRecordId)).size).toBe(4)
    expect(rows.every((item) => item.unit === 'UNKNOWN_VENDOR_UNIT' && item.intendedPolicy === 'NATIVE_ONLY_VENDOR_DERIVED' && item.canonicalTarget === null)).toBe(true)
    expect(report.estimatedBp.observations).toHaveLength(2)
    expect(report.estimatedBp.observations.every((item) => item.recordingMethod === 'ESTIMATED_VENDOR_BP' && item.cuffMeasured === false && item.vendorDerived)).toBe(true)
    expect(report.hrv.companionObservations[0].metric).toBe('HEART_RATE_AUTOMATIC')
  })

  it('preserves every PPI slot including zero, unknown unit and shared group', async () => {
    const report = await buildJCVitalCertification(options({ historicalRuns: { ppi: run([
      native({ metricType: 'PPI', vendorDataType: '127', values: [700, 0, 710, 0], value: null, unit: 'UNKNOWN_VENDOR_UNIT', packetId: 'group-7' }),
    ]) } }))
    expect(report.ppi.observations.map((item) => item.value)).toEqual([700, 0, 710, 0])
    expect(report.ppi.observations.map((item) => item.sequenceNumber)).toEqual([0, 1, 2, 3])
    expect(new Set(report.ppi.observations.map((item) => item.sourceRecordGroupId)).size).toBe(1)
    expect(report.ppi.unit).toBe('UNKNOWN_VENDOR_UNIT')
    expect(report.ppi.deliveryPolicy).toBe('RESEARCH_ONLY')
    expect(report.ppi.observations[1].metadata?.ppiZeroValue).toBe(true)
  })

  it('counts no-measurement placeholders and parse errors without changing capture data', async () => {
    const capture = run([native({ value: 0 }), native()])
    capture.result!.parseErrors.push({ message: 'bad vendor date', vendorDataType: '68', rawRecord: null, receivedAt: time })
    const before = JSON.stringify(capture)
    const report = await buildJCVitalCertification(options({ historicalRuns: { spo2: capture } }))
    expect(report.spo2.notDeliverableCount).toBe(1)
    expect(report.spo2.parseErrorCount).toBe(1)
    expect(report.spo2.physicalCaptureStatus).toBe('CAPTURED_WITH_PARSE_ERRORS')
    expect(report.spo2.observations[0].observationId).toBeNull()
    expect(JSON.stringify(capture)).toBe(before)
  })

  it('uses only retained bounded historical HR samples and labels prior pass provenance', async () => {
    const capture = native({ metricType: 'HEART_RATE_CONTINUOUS', vendorDataType: '27', value: 70, unit: 'bpm' })
    const outcomes = await mapPhysiologyObservation('owner-1', capture, context)
    if (outcomes[0].status !== 'MAPPED') throw new Error('fixture did not map')
    const row: QueueRecord = {
      queueId: 'queue-1', ownerUserId: 'owner-1', observationId: outcomes[0].observation.observationId,
      payload: outcomes[0].observation, state: 'PENDING', createdAt: time, updatedAt: time, claimedAt: null,
      attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null,
      batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
    }
    const before = JSON.stringify(row)
    const report = await buildJCVitalCertification(options({ preservedQueueSamples: [row] }))
    expect(report.historicalHeartRate.sampleObservations[0].observationId).toBe(row.observationId)
    expect(report.historicalHeartRate.reportedGates).toMatchObject({ PHYSICAL_CAPTURE: 'PASS', BACKEND_CANONICALIZATION: 'PASS', BASE44_DOWNSTREAM_UI: 'PENDING' })
    expect(report.historicalHeartRate.corpusObservationCountKnown).toBe(false)
    expect(report.historicalHeartRate.observationCount).toBeNull()
    expect(report.historicalHeartRate.sourceRecordCount).toBeNull()
    expect(JSON.stringify(row)).toBe(before)
    const differentOwner = await buildJCVitalCertification(options({ ownerUserId: 'owner-2', preservedQueueSamples: [row] }))
    expect(differentOwner.historicalHeartRate.sampleObservations).toEqual([])
  })

  it('reports EMPTY sleep only after both validated commands, not failure/partial/no-data', async () => {
    const empty = run([], 'EMPTY_VALID')
    const complete = await buildJCVitalCertification(options({ sleep: { stages: empty, movement: empty }, workouts: empty }))
    expect(complete.sleep.certificationNotes).toContain('PHYSICAL_DATA = EMPTY')
    expect(complete.workoutHistory.certificationNotes).toContain('PHYSICAL_WORKOUT_HISTORY = EMPTY')
    const partial = await buildJCVitalCertification(options({ sleep: { stages: empty } }))
    expect(partial.sleep.physicalCaptureStatus).toBe('PARTIAL')
    expect(partial.sleep.certificationNotes).not.toContain('PHYSICAL_DATA = EMPTY')
    const failed = await buildJCVitalCertification(options({ sleep: { stages: empty, movement: { ...empty, result: null, error: 'timeout' } } }))
    expect(failed.sleep.physicalCaptureStatus).toBe('FAILED')
    expect(failed.sleep.certificationNotes).not.toContain('PHYSICAL_DATA = EMPTY')
  })

  it('does not certify a missing type-42 metric merely because its family returned other fields', async () => {
    const report = await buildJCVitalCertification(options({ historicalRuns: { hrv: run([
      native({ metricType: 'STRESS_VENDOR', vendorDataType: '42', value: 3, vendorDerived: true }),
    ]) } }))
    expect(report.hrv.physicalCaptureStatus).toBe('NOT_EMITTED')
    expect(report.stress.physicalCaptureStatus).toBe('CAPTURED')
    expect(report.estimatedBp.physicalCaptureStatus).toBe('NOT_EMITTED')
  })

  it('keeps unknown sleep stage codes, movement and timezone without canonicalization', async () => {
    const report = await buildJCVitalCertification(options({ sleep: {
      stages: run([native({ metricType: 'SLEEP_EPISODE', vendorDataType: '28', values: [2, 7, 9], value: null, unit: 'source_stage_code', samplingIntervalMs: 60_000 })]),
      movement: run([native({ metricType: 'SLEEP_MOVEMENT', vendorDataType: '44', values: [0, 1, 0], value: null })]),
    } }))
    expect(report.sleep.observations[0].value).toEqual([2, 7, 9])
    expect(report.sleep.observations[0].timezone).toBe('UTC')
    expect(report.sleep.details.sampleDiagnostics.episodes[0].stageMappingStatus).toContain('UNKNOWN')
    expect(report.sleep.canonicalTarget).toBeNull()
  })

  it('keeps detailed minute epochs distinct from daily activity without double-count aggregation', async () => {
    const epochs = [0, 1, 2].map((sequenceNumber) => native({
      metricType: 'DETAILED_ACTIVITY_EPOCH', sequenceNumber, vendorDataType: '25', value: sequenceNumber + 1,
      samplingIntervalMs: 60_000, rawPayload: { record: { arraySteps: [1, 2, 3] } },
    }))
    const report = await buildJCVitalCertification(options({
      activity: run([native({ metricType: 'DAILY_STEPS', value: 1000, unit: 'count', vendorDataType: '24' })]),
      detailedActivity: run(epochs),
    }))
    expect(report.activity.observationCount).toBe(1)
    expect(report.detailedActivity.observationCount).toBe(3)
    expect(report.detailedActivity.details.sampleDiagnostics).toMatchObject({ blockCount: 1, epochCount: 3, epochDurationSeconds: 60, sourceArrayPreserved: true })
    expect(report.detailedActivity.observations.every((item) => item.observationId === null)).toBe(true)
  })

  it('reports live type-82 HR at exact receipt cadence with stable IDs and no historical sync/METS', async () => {
    const session: LiveWorkoutSession = {
      sessionId: 'workout-1', deviceId, activityType: 'WALK', vendorActivityMode: 0, startedAt: time,
      stoppedAt: '2026-10-03T10:03:00.000Z', status: 'STOPPED', packetCount: 180, firstPacketAt: time,
      lastPacketAt: '2026-10-03T10:02:59.000Z', heartbeatAttemptCount: 6, heartbeatSentCount: 6,
      heartbeatSkippedCount: 0, heartbeatIntervalMs: 30000,
    }
    const packets: LiveWorkoutPacket[] = Array.from({ length: 180 }, (_, index) => ({
      sessionId: 'workout-1', receivedAt: new Date(Date.parse(time) + index * 1000).toISOString(),
      vendorTimestamp: null, packetSequence: index, heartRate: index ? 70 + index % 3 : 0,
      elapsedSeconds: index, exerciseTimeRaw: index, steps: null, calories: null, distance: null,
      pace: null, mets: null, rssi: null, temperature: null, spo2: null, rawVendorPayload: {},
    }))
    const report = await buildJCVitalCertification(options({ workoutSession: session, workoutPackets: packets }))
    expect(report.liveWorkoutHeartRate.observationCount).toBe(179)
    expect(report.liveWorkoutHeartRate.cadence).toMatchObject({
      packetCount: 180, nonZeroHrPacketCount: 179, medianNonZeroHrIntervalMs: 1000,
      p5NonZeroHrIntervalMs: 1000, p95NonZeroHrIntervalMs: 1000,
    })
    const exact = await buildWorkoutHrObservation('owner-1', {
      sessionId: 'workout-1', receivedAt: packets[1].receivedAt, packetSequence: 1, heartRate: 71,
      vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME',
    }, context)
    expect(report.liveWorkoutHeartRate.observations[0]).toMatchObject({
      observationId: exact?.observationId, timestampSource: 'CONNECTOR_BLE_RECEIPT_TIME',
      sessionId: 'workout-1', context: 'WORKOUT', acquisitionMode: 'WORKOUT_REALTIME', vendorDataType: '82',
    })
    expect(report.historicalHeartRate.sampleObservations).toEqual([])
    expect(report.liveWorkoutHeartRate).not.toHaveProperty('mets')
    const captureOnly = await buildJCVitalCertification(options({ ownerUserId: null, workoutSession: session, workoutPackets: packets }))
    expect(captureOnly.liveWorkoutHeartRate.observationCount).toBe(179)
    expect(captureOnly.liveWorkoutHeartRate.observations[0]).toMatchObject({
      value: 71, observationId: null, mappingStatus: 'MAPPING_CONTEXT_UNAVAILABLE',
    })
  })

  it('reports physical PPG transport evidence without inventing sample semantics or clinical targets', async () => {
    const report = await buildJCVitalCertification(options({
      ppgChunks: { ...EMPTY_RAW_PPG_CHUNK_SUMMARY, packetCount: 10, chunkCount: 2, totalBytes: 1530,
        notificationLengthCounts: { '153': 10, '203': 0, other: 0 } },
    }))
    expect(report.ppg).toMatchObject({
      physicalCaptureStatus: 'CAPTURED', packetCount: 10, chunkCount: 2, byteCount: 1530,
      notificationLengthCounts: { '153': 10, '203': 0, other: 0 }, rawFormat: 'UNKNOWN_VENDOR_LAYOUT',
      sampleSemantics: 'UNKNOWN', canonicalTarget: null, deliveryPolicy: 'RESEARCH_ONLY',
    })
    expect(report.ecg.deliveryPolicy).toBe('BLOCKED')
  })

  it('redacts MACs and secret fields throughout legacy and certification evidence, preserving opaque IDs', async () => {
    const certification = await buildJCVitalCertification(options({ historicalRuns: { spo2: run([native()]) } }))
    const payload = buildPhase3AValidationReport({
      deviceInfo: null, historicalRuns: { spo2: run([native()]) }, jcvitalCertification: certification,
      additionalFeedResults: { raw: { deviceId: 'AA:BB:CC:DD:EE:FF', password: 'private-value', accessToken: 'private-token',
        nested: { authorization: 'Bearer private', apiKey: 'private-key', localId: 'v8-AA-BB-CC-DD-EE-FF' } } },
    })
    const text = JSON.stringify(sanitizeCertificationExport(payload))
    expect(BLUETOOTH_MAC_PATTERN.test(text)).toBe(false)
    for (const secret of ['private-value', 'private-token', 'Bearer private', 'private-key']) expect(text).not.toContain(secret)
    expect(text).toContain(deviceId)
    expect(payload.jcvitalCertification?.spo2.observations[0].value).toBe(97)
  })
})

describe('bounded exact-ID certification delivery diagnostics', () => {
  it('never treats canonical failure as acknowledged delivery', () => {
    const evidence = new CertificationDeliveryEvidence()
    evidence.record('owner-1', event(['one'], { outcome: 'CANONICAL_FAILED', acknowledgedIds: [], canonicalFailedIds: ['one'],
      results: [{ observationId: 'one', status: 'accepted', canonicalStatus: 'failed' }] }))
    expect(evidence.snapshot('owner-1').results.get('one')).toMatchObject({ acknowledged: false, outcome: 'CANONICAL_RECOVERY_REQUIRED' })
  })

  it('bounds diagnostics at 1000 IDs and isolates owner changes', () => {
    const evidence = new CertificationDeliveryEvidence()
    evidence.record('owner-1', event(Array.from({ length: 1300 }, (_, index) => `id-${index}`)))
    expect(evidence.snapshot('owner-1').results.size).toBe(1000)
    expect(evidence.snapshot('owner-1').evictedResultCount).toBe(300)
    expect(evidence.snapshot('owner-2').results.size).toBe(0)
    evidence.record('owner-2', event(['two']))
    expect(evidence.snapshot('owner-1').results.size).toBe(0)
    expect(evidence.snapshot('owner-2').results.size).toBe(1)
  })
})
