import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeObservation } from '../../models/wearableObservation'
import { authenticationService } from '../../services/base44/AuthenticationService'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import type { ConnectorObservationResult, ConnectorObservationsRequest, ConnectorObservationsResponse, NativeObservationInput } from '../../services/base44/base44Types'
import { JCVitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'
import { MAX_CONCURRENCY, ObservationBatchManager } from '../../services/sync/ObservationBatchManager'
import { observationQueue } from '../../services/sync/ObservationQueue'
import type { NetworkStatus } from '../../services/sync/NetworkStatus'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import { mapPhysiologyObservation, PHYSIOLOGY_CONTRACTS, type PhysiologyMappingOutcome } from './PhysiologyContract'
import { JCVitalPhysiologyDelivery } from './PhysiologyDelivery'
import { sha256Hex } from './HeartRateSeries'
import { buildWorkoutHrObservation } from './WorkoutHrDelivery'
import { buildJCVitalCertification, CertificationDeliveryEvidence } from './JCVitalCertification'

const MAC = 'E7:1B:D8:36:78:CF'
const OPAQUE_ID = 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b'
const context = { deviceId: OPAQUE_ID, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' }
const RECEIPT = '2026-10-02T00:00:00.000Z'

/** Mirrors JCVitalV8EventNormalizer output, including its MAC-bearing native source/provenance. */
function native(metricType: string, vendorDataType: string, vendorField: string, value: number | null, vendorDate: string, observedAt: string, extra: Partial<NativeObservation> = {}): NativeObservation {
  return {
    id: crypto.randomUUID(),
    source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: MAC, macAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
    metricType: metricType as NativeObservation['metricType'], observedAt, observedAtSource: vendorDate, receivedAt: RECEIPT, timezone: 'America/New_York',
    value, values: null, unit: 'x', acquisitionMode: 'HISTORICAL_SYNC', measurementContext: null, sessionId: null, packetId: null,
    sequenceNumber: null, samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: null,
    vendorDataType, vendorField, vendorDerived: false,
    rawPayload: { record: { mac: MAC, date: vendorDate } },
    provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', sourceRecordId: `${MAC}|${vendorDataType}|${vendorDate}` },
    ...extra,
  }
}

function hrSeries(vendorDate: string, startIso: string, values: number[]): NativeObservation[] {
  return values.map((value, sequence) => native('HEART_RATE_CONTINUOUS', '27', 'arrayDynamicHR', value, vendorDate,
    new Date(Date.parse(startIso) + sequence * 5_000).toISOString(), { sequenceNumber: sequence, samplingIntervalMs: 5_000 }))
}

function hrvRecord(vendorDate: string, observedAt: string): NativeObservation[] {
  return [
    native('HRV_VENDOR', '42', 'hrv', 48, vendorDate, observedAt, { vendorDerived: true }),
    native('HEART_RATE_AUTOMATIC', '42', 'heartRate', 71, vendorDate, observedAt),
    native('STRESS_VENDOR', '42', 'stress', 35, vendorDate, observedAt, { vendorDerived: true }),
    native('BP_SYSTOLIC_ESTIMATED', '42', 'highBP', 118, vendorDate, observedAt, { vendorDerived: true }),
    native('BP_DIASTOLIC_ESTIMATED', '42', 'lowBP', 76, vendorDate, observedAt, { vendorDerived: true }),
  ]
}

const ppiValues = [812, 0, 798, 805, ...Array.from({ length: 52 }, () => 0)]
const ppiGroup = native('PPI', '127', 'ppiData', null, '2026.10.01 09:00:00', '2026-10-01T13:00:00.000Z', { values: ppiValues, packetId: '3' })

function syncResult(vendorDataType: string, observations: NativeObservation[]): JCVitalV8HistoricalSyncResult {
  return {
    syncId: crypto.randomUUID(), deviceId: MAC, provider: 'JCVITAL', sdkCommand: 'test', vendorDataType, startedAt: RECEIPT, completedAt: RECEIPT,
    recordsReceived: observations.length, recordGroupsReceived: 1, recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0,
    earliestObservation: null, latestObservation: null, partial: false, completionStatus: 'COMPLETE', packetCount: 1, parseErrors: [], observations,
  }
}

function allFeeds(): JCVitalV8HistoricalSyncResult[] {
  return [
    syncResult('27', hrSeries('2026.10.01 08:00:00', '2026-10-01T12:00:00.000Z', Array.from({ length: 150 }, (_, index) => 60 + (index % 30)))),
    syncResult('68', [96, 97, 98, 95].map((value, index) => native('SPO2', '68', 'Blood_oxygen', value, `2026.10.01 0${index}:30:00`, `2026-10-01T0${4 + index}:30:00.000Z`))),
    syncResult('59', [33.4, 33.6].map((value, index) => native('WEARABLE_TEMPERATURE', '59', 'temperature', value, `2026.10.01 08:${index}0:00`, `2026-10-01T12:${index}0:00.000Z`))),
    syncResult('42', [...hrvRecord('2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z'), ...hrvRecord('2026.10.01 08:00:00', '2026-10-01T12:00:00.000Z')]),
    syncResult('127', [ppiGroup]),
  ]
}

function mapped(outcomes: PhysiologyMappingOutcome[]): NativeObservationInput[] {
  return outcomes.flatMap((outcome) => outcome.status === 'MAPPED' ? [outcome.observation] : [])
}

async function mapOne(observation: NativeObservation): Promise<NativeObservationInput> {
  const [result] = mapped(await mapPhysiologyObservation('user-1', observation, context))
  return result
}

describe('Build 5B-1 metric mapping', () => {
  it('links type-42 siblings to one local envelope without changing scalar IDs, payloads or canonical policy', async () => {
    const siblings = hrvRecord('2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z')
    const envelopeId = 'source-envelope-type42'
    const original = (await Promise.all(siblings.map((item) => mapPhysiologyObservation('user-1', item, context)))).flat()
    const linked = (await Promise.all(siblings.map((item) => mapPhysiologyObservation('user-1', {
      ...item, provenance: { ...item.provenance, sourceEnvelopeId: envelopeId },
    }, context)))).flat()
    expect(mapped(linked)).toEqual(mapped(original))
    expect(mapped(linked)).toHaveLength(4)
    for (const outcome of linked) {
      if (outcome.status === 'MAPPED') {
        expect(outcome.sourceEnvelopeId).toBe(envelopeId)
        expect(outcome.observation.rawSourceMetadata?.canonicalPolicy).toBe('NATIVE_ONLY')
        expect(JSON.stringify(outcome.observation)).not.toContain(envelopeId)
      }
    }
    expect(linked.filter((item) => item.status === 'MAPPED').map((item) => item.observation.metric))
      .not.toContain('heartRate')
  })

  it('links every PPI slot including zeros without adding timing semantics or changing uploads', async () => {
    const original = await mapPhysiologyObservation('user-1', ppiGroup, context)
    const linked = await mapPhysiologyObservation('user-1', {
      ...ppiGroup, provenance: { ...ppiGroup.provenance, sourceEnvelopeId: 'source-envelope-ppi' },
    }, context)
    expect(mapped(linked)).toEqual(mapped(original))
    expect(mapped(linked).map((item) => item.valueNumber)).toEqual(ppiValues)
    expect(linked.every((item) => item.status === 'MAPPED' && item.sourceEnvelopeId === 'source-envelope-ppi')).toBe(true)
  })

  it('maps historical continuous HR with source timestamps and the 5-second interval', async () => {
    const [first, second] = await Promise.all(hrSeries('2026.10.01 08:00:00', '2026-10-01T12:00:00.000Z', [62, 64]).map(mapOne))
    expect(first).toMatchObject({
      metric: 'heartRate', metricType: 'HEART_RATE', unit: 'bpm', valueNumber: 62, vendorDataType: '27', vendorField: 'arrayDynamicHR',
      measurementContext: 'CONTINUOUS_HR_HISTORY', acquisitionMode: 'HISTORICAL_SYNC', samplingIntervalMs: 5000, sequenceNumber: 0,
      observedAt: '2026-10-01T12:00:00.000Z', startTime: '2026-10-01T12:00:00.000Z', observedAtSource: '2026.10.01 08:00:00', receivedAt: RECEIPT,
      timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampConfidence: 'DEVICE_RECORDED', vendorDerived: false,
    })
    expect(second).toMatchObject({ observedAt: '2026-10-01T12:00:05.000Z', sequenceNumber: 1, samplingIntervalMs: 5000, timestampSource: 'DEVICE_HISTORY_RECORD_TIME_PLUS_NOMINAL_INTERVAL', timestampConfidence: 'NOMINAL_INTERVAL_DERIVED' })
    expect(second.observedAt).not.toBe(second.receivedAt)
    const nextRecord = await mapOne(hrSeries('2026.10.01 08:05:00', '2026-10-01T12:05:00.000Z', [66])[0])
    expect(nextRecord).toMatchObject({ observedAt: '2026-10-01T12:05:00.000Z', timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampConfidence: 'DEVICE_RECORDED' })
  })

  it('maps SpO2 as percent without rescaling', async () => {
    const observation = await mapOne(native('SPO2', '68', 'Blood_oxygen', 97, '2026.10.01 07:30:00', '2026-10-01T11:30:00.000Z'))
    expect(observation).toMatchObject({ metric: 'oxygenSaturation', metricType: 'SPO2', unit: 'percent', valueNumber: 97, vendorDataType: '68', vendorField: 'Blood_oxygen', measurementContext: 'AUTOMATIC_SPO2_HISTORY' })
  })

  it('maps temperature as wearable skin temperature in Celsius, never core body temperature', async () => {
    const observation = await mapOne(native('WEARABLE_TEMPERATURE', '59', 'temperature', 33.6, '2026.10.01 08:10:00', '2026-10-01T12:10:00.000Z'))
    expect(observation).toMatchObject({ metric: 'wearableTemperature', metricType: 'WEARABLE_TEMPERATURE', unit: 'celsius', valueNumber: 33.6, measurementContext: 'WEARABLE_SKIN_TEMPERATURE_HISTORY', measurementMethod: 'WEARABLE_SKIN_SENSOR' })
    expect(observation.rawSourceMetadata).toMatchObject({ temperatureSite: 'WEARABLE_SKIN', coreBodyTemperature: false })
    expect(JSON.stringify(observation)).not.toMatch(/"metric":"bodyTemperature"|body\.temperature|CORE_BODY|"coreBodyTemperature":true/)
  })

  it('splits one HRV record into separate HRV, stress and BP observations sharing a group reference', async () => {
    const outcomes = (await Promise.all(hrvRecord('2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z').map((item) => mapPhysiologyObservation('user-1', item, context)))).flat()
    const rows = mapped(outcomes)
    expect(rows.map((row) => row.metricType).sort()).toEqual(['BP_DIASTOLIC_ESTIMATED', 'BP_SYSTOLIC_ESTIMATED', 'HRV_VENDOR', 'STRESS_VENDOR'])
    expect(new Set(rows.map((row) => row.sourceRecordGroupId)).size).toBe(1)
    expect(new Set(rows.map((row) => row.observationId)).size).toBe(4)
    const hrv = rows.find((row) => row.metricType === 'HRV_VENDOR')!
    expect(hrv).toMatchObject({ metric: 'hrvVendor', valueNumber: 48, vendorDataType: '42', vendorField: 'hrv', vendorDerived: true, unit: 'UNKNOWN_VENDOR_UNIT', measurementContext: 'HRV_HISTORY', observedAt: '2026-10-01T11:00:00.000Z' })
  })

  it('marks stress as a JCVital vendor-derived source observation that does not replace Elite+ stress', async () => {
    const stress = await mapOne(native('STRESS_VENDOR', '42', 'stress', 35, '2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z'))
    expect(stress).toMatchObject({ metric: 'stressVendor', metricType: 'STRESS_VENDOR', provider: 'JCVITAL', vendorDerived: true })
    expect(stress.rawSourceMetadata).toMatchObject({ eliteStressScore: false, replacesEliteStress: false, canonicalPolicy: 'NATIVE_ONLY' })
    expect(stress.metric).not.toMatch(/^stress(Score)?$/)
    expect(PHYSIOLOGY_CONTRACTS.find((contract) => contract.key === 'stress')?.canonicalTarget).toBeNull()
  })

  it('labels BP as vendor-estimated with separate systolic/diastolic and no cuff claim', async () => {
    const [systolic, diastolic] = await Promise.all([
      mapOne(native('BP_SYSTOLIC_ESTIMATED', '42', 'highBP', 118, '2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z')),
      mapOne(native('BP_DIASTOLIC_ESTIMATED', '42', 'lowBP', 76, '2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z')),
    ])
    for (const row of [systolic, diastolic]) {
      expect(row).toMatchObject({ measurementMethod: 'ESTIMATED_VENDOR_BP', vendorDerived: true })
      expect(row.rawSourceMetadata).toMatchObject({ cuffMeasured: false })
      expect(JSON.stringify(row)).not.toMatch(/cuff_?measured"?:\s*true|CUFF_BP|"bloodPressureSystolic"|"bloodPressureDiastolic"/i)
    }
    expect(systolic).toMatchObject({ metric: 'bloodPressureSystolicEstimated', valueNumber: 118 })
    expect(diastolic).toMatchObject({ metric: 'bloodPressureDiastolicEstimated', valueNumber: 76 })
  })

  it('preserves every PPI slot including zero padding, with UNKNOWN_VENDOR_UNIT and no millisecond assumption', async () => {
    const rows = mapped(await mapPhysiologyObservation('user-1', ppiGroup, context))
    expect(rows).toHaveLength(56)
    expect(rows.map((row) => row.valueNumber)).toEqual(ppiValues)
    for (const row of rows) {
      expect(row).toMatchObject({ metric: 'ppiVendorRaw', metricType: 'PPI', unit: 'UNKNOWN_VENDOR_UNIT', vendorDataType: '127', sourceRecordGroupId: rows[0].sourceRecordGroupId })
      expect(row.unit).not.toMatch(/^ms$|millisecond/i)
      expect(row.rawSourceMetadata).toMatchObject({ ppiGroupSlotCount: 56, ppiGroupNonZeroCount: 3, vendorGroupSerial: '3', unitConfirmed: false })
    }
    expect(rows[1].rawSourceMetadata).toMatchObject({ ppiZeroValue: true, ppiTrailingZeroPaddingCandidate: false })
    expect(rows[4].rawSourceMetadata).toMatchObject({ ppiZeroValue: true, ppiTrailingZeroPaddingCandidate: true })
    expect(rows[0].rawSourceMetadata).toMatchObject({ ppiZeroValue: false, ppiTrailingZeroPaddingCandidate: false })
  })

  it('applies JCVITAL_NATIVE / DIRECT_BLE provenance and the opaque device ID to every metric, never the MAC', async () => {
    const rows = mapped((await Promise.all(allFeeds().flatMap((feed) => feed.observations).map((item) => mapPhysiologyObservation('user-1', item, context)))).flat())
    expect(new Set(rows.map((row) => row.metricType))).toEqual(new Set(PHYSIOLOGY_CONTRACTS.map((contract) => contract.metricType)))
    for (const row of rows) {
      expect(row).toMatchObject({ source: 'jcvital_native', provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE', sourceProvider: 'JCVITAL', sourcePath: 'DIRECT_BLE', deviceModel: 'PRO_V8', deviceId: OPAQUE_ID, sourceId: OPAQUE_ID, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' })
      expect(row.timestampSource).not.toBe('CONNECTOR_BLE_RECEIPT_TIME')
      expect(row.observedAt).not.toBe(RECEIPT)
      expect(JSON.stringify(row)).not.toMatch(/E7[:-]?1B[:-]?D8[:-]?36[:-]?78[:-]?CF/i)
    }
  })

  it('refuses delivery without an opaque device ID or a source timestamp', async () => {
    const hr = hrSeries('2026.10.01 08:00:00', '2026-10-01T12:00:00.000Z', [70])[0]
    expect(await mapPhysiologyObservation('user-1', hr, { ...context, deviceId: MAC })).toEqual([expect.objectContaining({ status: 'INVALID' })])
    expect(await mapPhysiologyObservation('user-1', { ...hr, observedAt: null }, context)).toEqual([expect.objectContaining({ status: 'INVALID', reason: expect.stringMatching(/source timestamp/) })])
  })

  it('skips zero HR/SpO2 placeholders and does not deliver HR-automatic or fatigue in 5B-1', async () => {
    expect(await mapPhysiologyObservation('user-1', hrSeries('2026.10.01 08:00:00', '2026-10-01T12:00:00.000Z', [0])[0], context)).toEqual([expect.objectContaining({ status: 'NOT_DELIVERABLE' })])
    expect(await mapPhysiologyObservation('user-1', native('SPO2', '68', 'Blood_oxygen', 0, '2026.10.01 07:30:00', '2026-10-01T11:30:00.000Z'), context)).toEqual([expect.objectContaining({ status: 'NOT_DELIVERABLE' })])
    expect(await mapPhysiologyObservation('user-1', native('HEART_RATE_AUTOMATIC', '42', 'heartRate', 71, '2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z'), context)).toEqual([])
    expect(await mapPhysiologyObservation('user-1', native('FATIGUE_VENDOR', '42', 'fatigueDegree', 3, '2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z'), context)).toEqual([])
    expect(await mapPhysiologyObservation('user-1', native('WEARABLE_TEMPERATURE', '23', 'TempData', 33, '', RECEIPT, { acquisitionMode: 'REALTIME' }), context)).toEqual([])
  })

  it('derives identical observation IDs for a re-read slot regardless of value or phone timezone', async () => {
    const original = await mapOne(native('SPO2', '68', 'Blood_oxygen', 97, '2026.10.01 07:30:00', '2026-10-01T11:30:00.000Z'))
    const reread = await mapOne(native('SPO2', '68', 'Blood_oxygen', 97, '2026.10.01 07:30:00', '2026-10-01T14:30:00.000Z', { timezone: 'UTC' }))
    expect(reread.observationId).toBe(original.observationId)
  })
})

describe('Build 5B-1 timestamp timezone provenance', () => {
  const vendorDate = '2026.10.01 08:00:00'
  const observedAt = '2026-10-01T12:00:00.000Z'

  it('labels continuous HR first, derived and next-record samples with PHONE_TIMEZONE without changing derivation', async () => {
    const [first, derived] = await Promise.all(hrSeries(vendorDate, observedAt, [62, 64]).map(mapOne))
    expect(first).toMatchObject({ observedAt, timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampConfidence: 'DEVICE_RECORDED', timestampTimezoneSource: 'PHONE_TIMEZONE', samplingIntervalMs: 5000 })
    expect(derived).toMatchObject({ observedAt: '2026-10-01T12:00:05.000Z', timestampSource: 'DEVICE_HISTORY_RECORD_TIME_PLUS_NOMINAL_INTERVAL', timestampConfidence: 'NOMINAL_INTERVAL_DERIVED', timestampTimezoneSource: 'PHONE_TIMEZONE', samplingIntervalMs: 5000 })
    const nextRecord = await mapOne(hrSeries('2026.10.01 08:05:00', '2026-10-01T12:05:00.000Z', [66])[0])
    expect(nextRecord).toMatchObject({ timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampConfidence: 'DEVICE_RECORDED', timestampTimezoneSource: 'PHONE_TIMEZONE' })
  })

  it('adds PHONE_TIMEZONE to SpO2, temperature, HRV, stress, BP and PPI while keeping their timestamp source/confidence', async () => {
    const rows = mapped((await Promise.all(allFeeds().slice(1).flatMap((feed) => feed.observations).map((item) => mapPhysiologyObservation('user-1', item, context)))).flat())
    expect(new Set(rows.map((row) => row.metricType))).toEqual(new Set(['SPO2', 'WEARABLE_TEMPERATURE', 'HRV_VENDOR', 'STRESS_VENDOR', 'BP_SYSTOLIC_ESTIMATED', 'BP_DIASTOLIC_ESTIMATED', 'PPI']))
    for (const row of rows) {
      expect(row).toMatchObject({ timestampSource: 'DEVICE_HISTORY_RECORD_TIME', timestampConfidence: 'DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE', timestampTimezoneSource: 'PHONE_TIMEZONE' })
    }
  })

  it('keeps rawSourceMetadata free of timestamp provenance so top-level fields stay authoritative', async () => {
    const rows = mapped((await Promise.all(allFeeds().flatMap((feed) => feed.observations).map((item) => mapPhysiologyObservation('user-1', item, context)))).flat())
    for (const row of rows) expect(Object.keys(row.rawSourceMetadata ?? {}).filter((key) => /timestamp|timezone/i.test(key))).toEqual([])
  })

  it('does not add timezone provenance to type-82 workout HR receipt-time observations', async () => {
    const workout = (await buildWorkoutHrObservation('user-1', { sessionId: 's-1', heartRate: 120, packetSequence: 1, receivedAt: RECEIPT, vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME' }, { deviceId: OPAQUE_ID, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }))!
    expect(workout).toMatchObject({ timestampSource: 'CONNECTOR_BLE_RECEIPT_TIME', timestampConfidence: 'RECEIPT_TIME_NO_VENDOR_TIMESTAMP' })
    expect(workout.timestampTimezoneSource ?? null).toBeNull()
    expect(workout).not.toHaveProperty('timestampTimezoneSource')
  })

  it('leaves observation IDs, sourceRecordIds and observedAt identical to the pre-change values', async () => {
    const [first, derived] = await Promise.all(hrSeries(vendorDate, observedAt, [62, 64]).map(mapOne))
    const spo2 = await mapOne(native('SPO2', '68', 'Blood_oxygen', 97, vendorDate, observedAt))
    // Golden values captured before timestampTimezoneSource existed.
    expect([first.observationId, derived.observationId, spo2.observationId]).toEqual([
      'b511607b9bbed625b7c4b3c9c2574318fd22e43ac17e64e00787c47d9c21938b',
      '1c0901f5e5b5e96e149354dcda1105a325514ef1b5e9d9fdd40fdab7b68eeca9',
      '7e0fd6b25b00bae86939346289d95ffc9f25ce3fcbceb86f6a96699c9673982d',
    ])
    expect([first.observedAt, derived.observedAt, spo2.observedAt]).toEqual([observedAt, '2026-10-01T12:00:05.000Z', observedAt])
    for (const row of [first, derived, spo2]) {
      expect(row.sourceRecordId).not.toContain('PHONE_TIMEZONE')
      expect(row.observationId).toBe(await sha256Hex(`user-1:${row.sourceRecordId}`))
    }
  })
})

class TestStorage {
  private readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
  removeItem(key: string): void { this.values.delete(key) }
}

const CANONICAL_METRICS = new Set(['heartRate', 'oxygenSaturation', 'wearableTemperature'])

/** Idempotent stand-in for the certified production nativeConnectorObservations contract. */
class FakeBase44 {
  readonly nativeObservations = new Map<string, NativeObservationInput>()
  readonly ingestionEvents: Array<{ observationId: string; status: 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' }> = []
  readonly requests: ConnectorObservationsRequest[] = []
  /** Simulates a pre-5B-1 response without results[]. */
  legacy = false
  rejectIds = new Set<string>()
  canonicalFailMetric: string | null = null
  accept(request: ConnectorObservationsRequest): ConnectorObservationsResponse {
    this.requests.push(request)
    const results: ConnectorObservationResult[] = request.observations.map((observation) => {
      const observationId = observation.observationId
      if (this.rejectIds.has(observationId)) {
        this.ingestionEvents.push({ observationId, status: 'REJECTED' })
        return { observationId, status: 'rejected', reason: 'valueNumber out of range', errorCode: 'VALIDATION_ERROR', canonicalStatus: null, nativeObservationId: null }
      }
      if (this.nativeObservations.has(observationId)) {
        this.ingestionEvents.push({ observationId, status: 'DUPLICATE' })
        return { observationId, status: 'duplicate', reason: null, errorCode: null, canonicalStatus: null, nativeObservationId: null }
      }
      this.nativeObservations.set(observationId, observation)
      this.ingestionEvents.push({ observationId, status: 'ACCEPTED' })
      const canonicalStatus = !CANONICAL_METRICS.has(observation.metric) ? 'not_applicable' : observation.metric === this.canonicalFailMetric ? 'failed' : 'canonicalized'
      return { observationId, status: 'accepted', reason: null, errorCode: canonicalStatus === 'failed' ? 'CANONICAL_WRITE_FAILED' : null, canonicalStatus, nativeObservationId: `native-${this.nativeObservations.size}` }
    })
    const count = (status: string) => results.filter((result) => result.status === status).length
    const rejectedResults = results.filter((result) => result.status === 'rejected')
    const base = { success: true, batchId: request.batchId, serverTimestamp: new Date().toISOString(), accepted: count('accepted'), duplicate: count('duplicate'), rejected: count('rejected'), errors: rejectedResults.slice(0, 50).map((result) => ({ observationId: result.observationId, reason: result.reason ?? undefined })) }
    if (this.legacy) return base
    return { ...base, processing: { mode: 'sync' }, canonical: { written: results.filter((result) => result.canonicalStatus === 'canonicalized').length }, ingestion_events_created: results.length, results }
  }
  countByMetricType(): Record<string, number> {
    const counts: Record<string, number> = {}
    for (const observation of this.nativeObservations.values()) counts[observation.metricType!] = (counts[observation.metricType!] ?? 0) + 1
    return counts
  }
}

const online: NetworkStatus = { isOnline: () => true, subscribe: () => () => undefined }
let counter = 0
let certificationSamples: NativeObservationInput[][]
let enqueueFinished = false
let certificationEvidenceWasPersistedAfterEnqueue: boolean[]

describe('Build 5B-1 delivery through the Build 5A queue and batch sender', () => {
  let backend: FakeBase44
  let manager: ObservationBatchManager
  let delivery: JCVitalPhysiologyDelivery

  async function syncAll(): Promise<void> { for (const feed of allFeeds()) await delivery.deliverSyncResult(feed) }

  function attachDelivery(): JCVitalPhysiologyDelivery {
    const identity = new JCVitalDeviceIdentityService(() => new TestStorage())
    const nextDelivery = new JCVitalPhysiologyDelivery({
      queue: observationQueue, deliver: () => manager.process(), subscribe: (listener) => manager.subscribe(listener), resolveDeviceId: (address) => identity.resolve(address),
      deliveryDiagnostics: () => manager.getDeliveryDiagnostics(),
      flushCertification: (ids) => manager.flushCertificationObservationIds(ids),
      rememberCertification: (observations) => {
        certificationSamples.push(observations)
        certificationEvidenceWasPersistedAfterEnqueue.push(enqueueFinished)
      },
    })
    nextDelivery.setContext({ bleAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' })
    nextDelivery.setEnabled(true)
    nextDelivery.start()
    return nextDelivery
  }

  beforeEach(async () => {
    Object.assign(globalThis, { localStorage: new TestStorage() })
    observationQueue.setOwnerUserId(`physiology-${Date.now()}-${counter++}`)
    await observationQueue.initialize()
    connectorIdentityService.setConnectorDeviceId('device-test')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    backend = new FakeBase44()
    certificationSamples = []
    enqueueFinished = false
    certificationEvidenceWasPersistedAfterEnqueue = []
    manager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0, requestTimeoutMs: 50 }, online)
    delivery = attachDelivery()
  })
  afterEach(() => { delivery.dispose(); vi.restoreAllMocks() })

  it('keeps envelope links local across durable enqueue and sends the unchanged scalar contract', async () => {
    const siblings = hrvRecord('2026.10.01 07:00:00', '2026-10-01T11:00:00.000Z').map((item) => ({
      ...item, provenance: { ...item.provenance, sourceEnvelopeId: 'source-envelope-type42' },
    }))
    const enqueue = vi.spyOn(observationQueue, 'enqueueMany')
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await delivery.deliverSyncResult(syncResult('42', siblings))
    const references = enqueue.mock.calls[0][1]
    expect(references?.size).toBe(4)
    expect([...references!.values()]).toEqual(Array(4).fill('source-envelope-type42'))
    expect(backend.requests).toHaveLength(1)
    expect(JSON.stringify(backend.requests)).not.toContain('source-envelope-type42')
    expect(JSON.stringify(backend.requests)).not.toContain('sourceEnvelopeId')
    expect(backend.requests[0].observations.map((item) => item.metric)).toEqual([
      'hrvVendor', 'stressVendor', 'bloodPressureSystolicEstimated', 'bloodPressureDiastolicEstimated',
    ])
    expect(MAX_CONCURRENCY).toBe(1)
  })

  it('does nothing while disabled', async () => {
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
    delivery.setEnabled(false)
    await syncAll()
    expect(upload).not.toHaveBeenCalled()
    expect((await observationQueue.getQueueStats()).pending).toBe(0)
  })

  it('keeps explicit CAPTURE_ONLY delivery off, regardless of the master toggle', async () => {
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
    for (const enabled of [false, true]) {
      delivery.setEnabled(enabled)
      const report = await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CAPTURE_ONLY' })
      expect(report).toMatchObject({ delivered: false, mapped: 0, reason: 'capture only' })
      expect(delivery.isEnabled()).toBe(enabled)
    }
    expect(upload).not.toHaveBeenCalled()
    expect(delivery.getSnapshot().metrics.spo2.captured).toBe(0)
  })

  it('durably queues a 160-row capture but targeted-delivers only the first five exact SpO2 IDs', async () => {
    delivery.setEnabled(false)
    const feed = syncResult('68', Array.from({ length: 160 }, (_, index) => native(
      'SPO2', '68', 'Blood_oxygen', 97, `record-${index}`, new Date(Date.parse(RECEIPT) + index * 1800_000).toISOString(),
    )))
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    const report = await delivery.deliverSyncResult(feed, { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report).toMatchObject({ delivered: true, mapped: 160, queued: 160 })
    expect(report.observations).toHaveLength(5)
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0].observations.map((row) => row.observationId)).toEqual(report.observations?.map((row) => row.observationId))
    expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 155, inFlight: 0, failed: 0 })
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ captured: 160, queued: 160, serverAccepted: 5, canonicalized: 5, canonicalFailed: 0 })
    expect(delivery.isEnabled()).toBe(false)
  })

  it('queues all temperature observations but targets exactly five durable canonical rows', async () => {
    delivery.setEnabled(false)
    const observations = Array.from({ length: 6 }, (_, index) => native(
      'WEARABLE_TEMPERATURE', '59', 'temperature', 32 + index / 10,
      `2026.10.01 08:${String(index).padStart(2, '0')}:00`,
      `2026-10-01T12:${String(index).padStart(2, '0')}:00.000Z`,
    ))
    const feed = syncResult('59', observations)
    const originalEnqueueMany = observationQueue.enqueueMany.bind(observationQueue)
    vi.spyOn(observationQueue, 'enqueueMany').mockImplementation(async (rows) => {
      const result = await originalEnqueueMany(rows)
      enqueueFinished = true
      return result
    })
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))

    const report = await delivery.deliverSyncResult(feed, { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'wearableTemperature' })

    expect(report).toMatchObject({ delivered: true, mapped: 6, queued: 6, reason: null, certificationMetric: 'wearableTemperature' })
    expect(report.observations).toHaveLength(5)
    expect(certificationSamples).toHaveLength(1)
    expect(certificationSamples[0]).toHaveLength(5)
    expect(certificationEvidenceWasPersistedAfterEnqueue).toEqual([true])
    expect(backend.requests).toHaveLength(1)
    expect(backend.requests[0].observations).toHaveLength(5)
    expect(backend.requests[0].observations.map((row) => row.observationId)).toEqual(certificationSamples[0].map((row) => row.observationId))
    expect(backend.requests[0].observations.map((row) => row.valueNumber)).toEqual([32, 32.1, 32.2, 32.3, 32.4])
    expect(backend.requests[0].observations.every((row) => row.acquisitionMode === 'HISTORICAL_SYNC' && row.vendorDerived === false)).toBe(true)
    expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 1, inFlight: 0, failed: 0, canonicalRecoveryRequired: false })
    expect(MAX_CONCURRENCY).toBe(1)
  })

  it('does not report temperature certification delivered or send a partial sample below five rows', async () => {
    delivery.setEnabled(false)
    const feed = syncResult('59', Array.from({ length: 4 }, (_, index) => native(
      'WEARABLE_TEMPERATURE', '59', 'temperature', 32 + index / 10,
      `2026.10.01 08:${String(index).padStart(2, '0')}:00`,
      `2026-10-01T12:${String(index).padStart(2, '0')}:00.000Z`,
    )))
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')

    const report = await delivery.deliverSyncResult(feed, { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'wearableTemperature' })

    expect(report.delivered).toBe(false)
    expect(report.reason).toContain('requires five valid observations')
    expect(report.observations).toHaveLength(4)
    expect(certificationSamples[0]).toHaveLength(4)
    expect(upload).not.toHaveBeenCalled()
    expect(await observationQueue.getQueueStats()).toMatchObject({ pending: 4, inFlight: 0 })
  })

  it('delivers only exact SpO2 IDs with master off and leaves all global selections unchanged', async () => {
    delivery.setEnabled(false)
    const before = delivery.getSnapshot()
    const feed = syncResult('68', allFeeds().flatMap((result) => result.observations))
    const owner = observationQueue.getOwnerUserId()!
    const deviceContext = { ...context, deviceId: before.backendDeviceId }
    const expected = (await Promise.all(feed.observations.filter((item) => item.vendorDataType === '68')
      .map((item) => mapPhysiologyObservation(owner, item, deviceContext)))).flatMap(mapped)
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    const report = await delivery.deliverSyncResult(feed, { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report).toMatchObject({ delivered: true, mapped: 4, queued: 4, reason: null, certificationMetric: 'spo2' })
    expect(report.observations?.map((item) => item.observationId)).toEqual(expected.map((item) => item.observationId))
    expect(report.observations?.map((item) => item.sourceRecordId)).toEqual(expected.map((item) => item.sourceRecordId))
    expect(report.observations?.every((item) => item.state === 'DELIVERED_CANONICALIZED' && item.queueState === null && item.queueDisposition === 'ACKNOWLEDGED_PURGED')).toBe(true)
    expect([...backend.nativeObservations.values()]).toEqual(expected)
    const snapshot = delivery.getSnapshot()
    expect(snapshot.enabled).toBe(false)
    expect(snapshot.enabledMetrics).toEqual(before.enabledMetrics)
    expect(snapshot.metrics.spo2).toMatchObject({ captured: 4, queued: 4, serverAccepted: 4, canonicalized: 4, canonicalFailed: 0, failed: 0 })
    expect(snapshot.lastNativeObservationIds.spo2).toMatch(/^native-/)
    for (const key of before.enabledMetrics.filter((key) => key !== 'spo2')) expect(snapshot.metrics[key].captured).toBe(0)
    expect(MAX_CONCURRENCY).toBe(1)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })
    expect(backend.requests.every((request) => request.observations.length <= 100)).toBe(true)
    await delivery.deliverSyncResult(allFeeds()[2])
    expect(backend.requests).toHaveLength(1)
  })

  it.each(['hrv', 'stress', 'estimatedBp'] as const)('scopes type-42 certification to %s, excluding its companions', async (metric) => {
    delivery.setEnabled(false)
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    const report = await delivery.deliverSyncResult(allFeeds()[3], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: metric })
    const types = PHYSIOLOGY_CONTRACTS.filter((contract) => contract.key === metric).map((contract) => contract.metricType)
    expect([...backend.nativeObservations.values()].every((row) => types.includes(row.metricType!))).toBe(true)
    expect(report.delivered).toBe(true)
    expect(report.observations?.every((item) => item.state === 'DELIVERED_NATIVE_ONLY')).toBe(true)
    expect(delivery.isEnabled()).toBe(false)
  })

  it('does not persist a certification selection or alter disabled metric checkboxes', async () => {
    delivery.setEnabled(false)
    delivery.setMetricEnabled('spo2', false)
    const before = delivery.getSnapshot().enabledMetrics
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    expect((await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })).delivered).toBe(true)
    expect(delivery.getSnapshot().enabledMetrics).toEqual(before)
    expect(delivery.isEnabled()).toBe(false)
    expect((await delivery.deliverSyncResult(allFeeds()[1])).mapped).toBe(0)
  })

  it('waits for an already busy shared sender rather than reporting capture as delivery', async () => {
    delivery.dispose()
    manager = new ObservationBatchManager({ retryBaseMs: 0, retryMaxMs: 0, requestTimeoutMs: 5000 }, online)
    delivery.start()
    delivery.setEnabled(false)
    const hrBacklog = mapped(await mapPhysiologyObservation(observationQueue.getOwnerUserId()!, allFeeds()[0].observations[0], {
      ...context, deviceId: delivery.getSnapshot().backendDeviceId,
    }))
    await observationQueue.enqueueMany(hrBacklog)
    let release: (() => void) | undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const submit = vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => {
      if (request.observations[0].vendorDataType === '27') await held
      return backend.accept(request)
    })
    const backlogPass = manager.process()
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1))
    expect(submit.mock.calls[0][0].observations).toHaveLength(1)
    let completed = false
    const pending = delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
      .then((report) => { completed = true; return report })
    await vi.waitFor(() => expect(delivery.getSnapshot().metrics.spo2.queued).toBe(4))
    expect(completed).toBe(false)
    expect(delivery.getSnapshot().metrics.spo2.serverAccepted).toBe(0)
    release!()
    await backlogPass
    expect((await pending).delivered).toBe(true)
    expect(backend.requests.map((request) => request.observations[0].vendorDataType)).toEqual(['27', '68'])
    expect(delivery.getSnapshot().metrics.spo2.serverAccepted).toBe(4)
    expect(delivery.getSnapshot().metrics.heartRateHistory.serverAccepted).toBe(0)
  })

  it('reports QUEUED without claiming success when the sender is offline', async () => {
    delivery.setEnabled(false)
    vi.spyOn(online, 'isOnline').mockReturnValue(false)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
    const report = await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report.delivered).toBe(false)
    expect(report.reason).toContain('No eligible certification rows')
    expect(report.observations?.every((item) => item.state === 'QUEUED' && item.queueState === 'PENDING')).toBe(true)
    expect(upload).not.toHaveBeenCalled()
  })

  it('keeps certification canonical failures in recovery and pauses the shared sender safely', async () => {
    delivery.setEnabled(false)
    backend.canonicalFailMetric = 'oxygenSaturation'
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    const report = await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report.delivered).toBe(false)
    expect(report.observations?.every((item) => item.state === 'CANONICAL_FAILED' && item.queueState === 'CANONICAL_RECOVERY_REQUIRED')).toBe(true)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ queuePausedForCanonicalFailure: true, pauseReason: 'CANONICAL_RECOVERY_REQUIRED', effectiveConcurrency: 1 })
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ serverAccepted: 4, canonicalized: 0, canonicalFailed: 4, failed: 0 })
    expect(await manager.process()).toBeNull()
  })

  it.each([null, 'native-existing'])('attributes duplicates and preserves only a returned native ID (%s)', async (nativeObservationId) => {
    delivery.setEnabled(false)
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => ({
      ...backend.accept(request), accepted: 0, duplicate: request.observations.length,
      results: request.observations.map(({ observationId }) => ({ observationId, status: 'duplicate', canonicalStatus: null, nativeObservationId })),
    }))
    const report = await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report.delivered).toBe(true)
    expect(report.observations?.every((item) => item.state === 'DELIVERED_DUPLICATE' && item.nativeObservationId === nativeObservationId)).toBe(true)
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ serverAccepted: 0, serverDuplicate: 4, canonicalized: 0, canonicalFailed: 0 })
    expect(delivery.getSnapshot().lastNativeObservationIds.spo2).toBe(nativeObservationId)
  })

  it('exports capture, awaited exact delivery and final queue state separately, ignoring HR totals', async () => {
    delivery.setEnabled(false)
    const evidence = new CertificationDeliveryEvidence()
    const unsubscribe = manager.subscribe((event) => evidence.record(observationQueue.getOwnerUserId(), event))
    const feed = allFeeds()[1]
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    const report = await delivery.deliverSyncResult(feed, { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    unsubscribe()
    const certification = await buildJCVitalCertification({
      ownerUserId: observationQueue.getOwnerUserId(),
      physiologyContext: { ...context, deviceId: delivery.getSnapshot().backendDeviceId }, workoutContext: { ...context, vendorActivityMode: null },
      historicalRuns: { spo2: { requestStartedAt: RECEIPT, requestCompletedAt: RECEIPT, result: feed, error: null,
        certificationDelivery: { completedAt: RECEIPT, report } } },
      deliveryEvidence: evidence.snapshot(observationQueue.getOwnerUserId()), readQueueRecord: (id) => observationQueue.getRecord(id),
    })
    expect(certification.spo2.physicalCaptureStatus).toBe('CAPTURED')
    for (const sample of certification.spo2.sampleObservations) {
      expect(sample).toMatchObject({ deliveryState: 'DELIVERED_CANONICALIZED', queueState: null, queueDisposition: 'ACKNOWLEDGED_PURGED',
        canonicalTarget: 'body.oxygen_saturation', vendorDataType: '68', unit: 'percent',
        deliveryResult: { acknowledged: true, result: { observationId: sample.observationId, status: 'accepted', canonicalStatus: 'canonicalized' } } })
      expect(sample.nativeObservationId).toMatch(/^native-/)
      expect(report.observations?.some((item) => item.observationId === sample.observationId && item.sourceRecordId === sample.sourceRecordId)).toBe(true)
    }
    expect(certification.handoff.find((item) => item.METRIC === 'spo2')?.samples[0]).toMatchObject({
      DELIVERY_STATE: 'DELIVERED_CANONICALIZED', QUEUE_STATE: null, QUEUE_DISPOSITION: 'ACKNOWLEDGED_PURGED', NATIVE_OBSERVATION_ID: expect.stringMatching(/^native-/),
    })
    expect(certification.baseline.deploymentRevision).toBe('nc-observations-5b1-results-2026-10-03-r4')
    const withoutScreenEvidence = await buildJCVitalCertification({
      ownerUserId: observationQueue.getOwnerUserId(),
      physiologyContext: { ...context, deviceId: delivery.getSnapshot().backendDeviceId }, workoutContext: { ...context, vendorActivityMode: null },
      historicalRuns: { spo2: { requestStartedAt: RECEIPT, requestCompletedAt: RECEIPT, result: feed, error: null,
        certificationDelivery: { completedAt: RECEIPT, report } } },
    })
    expect(withoutScreenEvidence.spo2.sampleObservations.every((sample) =>
      sample.deliveryResult?.result?.observationId === sample.observationId && sample.deliveryState === 'DELIVERED_CANONICALIZED')).toBe(true)
  })

  it('reports FAILED for an enqueue error without changing the master toggle', async () => {
    delivery.setEnabled(false)
    vi.spyOn(observationQueue, 'enqueueMany').mockRejectedValue(new Error('SQLite write failed'))
    const report = await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report).toMatchObject({ delivered: false, reason: 'SQLite write failed', queued: 0 })
    expect(report.observations?.every((item) => item.state === 'FAILED' && item.deliveryResult === null && item.queueState === null)).toBe(true)
    expect(delivery.isEnabled()).toBe(false)
  })

  it('reports exact certification rejections without a delivery success', async () => {
    delivery.setEnabled(false)
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => {
      for (const row of request.observations) backend.rejectIds.add(row.observationId)
      return backend.accept(request)
    })
    const report = await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report.delivered).toBe(false)
    expect(report.observations?.every((item) => item.state === 'REJECTED' && item.queueState === 'FAILED_PERMANENT'
      && item.deliveryResult?.result?.status === 'rejected')).toBe(true)
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ serverRejected: 4, failed: 4, canonicalized: 0 })
  })

  it('does not turn acknowledgement without results[] into proven certification delivery', async () => {
    delivery.setEnabled(false)
    backend.legacy = true
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    const report = await delivery.deliverSyncResult(allFeeds()[1], { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    expect(report.delivered).toBe(false)
    expect(report.observations?.every((item) => item.state === 'QUEUED')).toBe(true)
    expect(report.observations?.every((item) => ['PENDING', 'IN_FLIGHT', 'RETRY_WAIT'].includes(item.queueState ?? ''))).toBe(true)
    expect(report.observations?.every((item) => item.deliveryResult?.result === null)).toBe(true)
    expect(delivery.getSnapshot().metrics.spo2.canonicalized).toBe(0)
  })

  it('batches mixed metrics through nativeConnectorObservations at ≤100 per request', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await syncAll()

    // 150 HR + 4 SpO2 + 2 temperature + 2×(HRV, stress, 2 BP) + 56 PPI slots
    const expectedTotal = 150 + 4 + 2 + 8 + 56
    expect(backend.nativeObservations.size).toBe(expectedTotal)
    expect(backend.requests.every((request) => request.observations.length <= 100)).toBe(true)
    expect(backend.requests.length).toBeLessThan(expectedTotal / 10)
    expect(backend.countByMetricType()).toEqual({ HEART_RATE: 150, SPO2: 4, WEARABLE_TEMPERATURE: 2, HRV_VENDOR: 2, STRESS_VENDOR: 2, BP_SYSTOLIC_ESTIMATED: 2, BP_DIASTOLIC_ESTIMATED: 2, PPI: 56 })
    const snapshot = delivery.getSnapshot()
    expect(snapshot.metrics.heartRateHistory).toMatchObject({ captured: 150, queued: 150, uniqueObservationsDelivered: 150, failed: 0 })
    expect(snapshot.metrics.estimatedBp.uniqueObservationsDelivered).toBe(4)
    expect(snapshot.metrics.ppi.uniqueObservationsDelivered).toBe(56)
    expect(snapshot.total.uniqueObservationsDelivered).toBe(expectedTotal)
    expect(snapshot.total.serverAccepted + snapshot.mixedBatchServerAccepted).toBe(expectedTotal)
    const stats = await observationQueue.getQueueStats()
    expect([stats.pending, stats.inFlight, stats.retrying, stats.failed]).toEqual([0, 0, 0, 0])
  })

  it('returns duplicates only when the identical historical sync is repeated', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await syncAll()
    const firstCounts = backend.countByMetricType()
    const firstUnique = backend.nativeObservations.size
    const firstSnapshot = delivery.getSnapshot()
    const acceptedFirst = firstSnapshot.total.serverAccepted + firstSnapshot.mixedBatchServerAccepted
    expect(acceptedFirst).toBe(firstUnique)

    delivery.resetDiagnostics()
    await syncAll()

    expect(backend.nativeObservations.size).toBe(firstUnique)
    expect(backend.countByMetricType()).toEqual(firstCounts)
    const second = delivery.getSnapshot()
    expect(second.total.serverAccepted + second.mixedBatchServerAccepted).toBe(0)
    expect(second.total.serverDuplicate + second.mixedBatchServerDuplicate).toBe(firstUnique)
    expect(second.total.uniqueObservationsDelivered).toBe(firstUnique)
    expect(backend.ingestionEvents.filter((event) => event.status === 'DUPLICATE')).toHaveLength(firstUnique)
  })

  it('retries a timed-out batch with the same IDs and creates no extra observations', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations')
      .mockImplementationOnce((request) => { backend.accept(request); return new Promise(() => undefined) })
      .mockImplementation(async (request) => backend.accept(request))
    const spo2 = allFeeds()[1]

    await delivery.deliverSyncResult(spo2)
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ retrying: 4, uniqueObservationsDelivered: 0 })
    expect((await observationQueue.getQueueStats()).retrying).toBe(4)

    await manager.process()

    expect(backend.nativeObservations.size).toBe(4)
    expect(backend.requests).toHaveLength(2)
    expect(backend.requests[1].observations.map((o) => o.observationId).sort()).toEqual(backend.requests[0].observations.map((o) => o.observationId).sort())
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ retrying: 0, uniqueObservationsDelivered: 4, serverAccepted: 0, serverDuplicate: 4 })
  })

  it('counts acknowledged NativeObservation-only metrics as delivered, never failed', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await delivery.deliverSyncResult(allFeeds()[3])
    await delivery.deliverSyncResult(allFeeds()[4])
    const { metrics } = delivery.getSnapshot()
    expect(metrics.hrv).toMatchObject({ uniqueObservationsDelivered: 2, nativeOnly: 2, failed: 0 })
    expect(metrics.stress).toMatchObject({ uniqueObservationsDelivered: 2, nativeOnly: 2, failed: 0 })
    expect(metrics.estimatedBp).toMatchObject({ uniqueObservationsDelivered: 4, nativeOnly: 4, failed: 0 })
    expect(metrics.ppi).toMatchObject({ uniqueObservationsDelivered: 56, nativeOnly: 56, failed: 0 })
    expect(PHYSIOLOGY_CONTRACTS.filter((contract) => contract.canonicalPolicy === 'NATIVE_ONLY').map((contract) => contract.metric).sort())
      .toEqual(['bloodPressureDiastolicEstimated', 'bloodPressureSystolicEstimated', 'hrvVendor', 'ppiVendorRaw', 'stressVendor'])
  })

  it('attributes server counts per metric for single-metric batches', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await delivery.deliverSyncResult(allFeeds()[2])
    expect(delivery.getSnapshot().metrics.wearableTemperature).toMatchObject({ captured: 2, uniqueObservationsDelivered: 2, serverAccepted: 2, serverDuplicate: 0, serverRejected: 0 })
  })

  it('counts server-rejected observations per metric as failed', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => {
      backend.rejectIds.add(request.observations[0].observationId)
      return backend.accept(request)
    })
    await delivery.deliverSyncResult(allFeeds()[1])
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ serverRejected: 1, failed: 1, uniqueObservationsDelivered: 3 })
  })

  it('keeps a legacy response without results[] retryable instead of trusting batch totals', async () => {
    delivery.dispose()
    manager = new ObservationBatchManager({ retryBaseMs: 5_000, retryMaxMs: 5_000, requestTimeoutMs: 50 }, online)
    delivery = attachDelivery()
    backend.legacy = true
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => {
      backend.rejectIds.add(request.observations[0].observationId)
      return backend.accept(request)
    })
    const report = await delivery.deliverSyncResult(allFeeds()[1])
    expect(report.queued).toBe(4)
    expect(backend.requests).toHaveLength(1)
    expect(delivery.getSnapshot().metrics.spo2).toMatchObject({ serverAccepted: 3, serverRejected: 0, uniqueObservationsDelivered: 0 })
    expect((await observationQueue.getQueueStats()).retrying).toBe(4)
  })

  it('parses the production results[] shape into exact per-metric counters for mixed batches', async () => {
    const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await syncAll()
    await vi.waitFor(async () => {
      const stats = await observationQueue.getQueueStats()
      expect(stats.pending + stats.inFlight + stats.retrying + stats.failed).toBe(0)
    })

    expect(upload.mock.calls.some(([request]) => new Set(request.observations.map((o) => o.metric)).size > 1)).toBe(true)
    const snapshot = delivery.getSnapshot()
    expect(snapshot.mixedBatchServerAccepted + snapshot.mixedBatchServerDuplicate).toBe(0)
    expect(snapshot.metrics.heartRateHistory).toMatchObject({ serverAccepted: 150, canonicalized: 150, nativeOnly: 0, uniqueObservationsDelivered: 150 })
    expect(snapshot.metrics.spo2).toMatchObject({ serverAccepted: 4, canonicalized: 4, nativeOnly: 0 })
    expect(snapshot.metrics.wearableTemperature).toMatchObject({ serverAccepted: 2, canonicalized: 2, nativeOnly: 0 })
    expect(snapshot.metrics.hrv).toMatchObject({ serverAccepted: 2, canonicalized: 0, nativeOnly: 2, failed: 0 })
    expect(snapshot.metrics.stress).toMatchObject({ serverAccepted: 2, canonicalized: 0, nativeOnly: 2, failed: 0 })
    expect(snapshot.metrics.estimatedBp).toMatchObject({ serverAccepted: 4, canonicalized: 0, nativeOnly: 4, failed: 0 })
    expect(snapshot.metrics.ppi).toMatchObject({ serverAccepted: 56, canonicalized: 0, nativeOnly: 56, failed: 0 })
    expect(snapshot.outcomeCounts).toMatchObject({ DELIVERED_CANONICALIZED: 156, DELIVERED_NATIVE_ONLY: 64, REJECTED: 0, FAILED: 0, CANONICAL_FAILED: 0 })
    expect(snapshot.total).toMatchObject({ serverAccepted: 220, serverDuplicate: 0, serverRejected: 0, canonicalized: 156, nativeOnly: 64, canonicalFailed: 0, failed: 0 })
  })

  it('maps duplicate results with null canonicalStatus to DELIVERED_DUPLICATE without requiring nativeObservationId', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await delivery.deliverSyncResult(allFeeds()[3])
    const firstNativeIds = delivery.getSnapshot().lastNativeObservationIds
    expect(firstNativeIds.hrv).toMatch(/^native-/)
    expect(firstNativeIds.estimatedBp).toMatch(/^native-/)

    delivery.resetDiagnostics()
    await delivery.deliverSyncResult(allFeeds()[3])
    const second = delivery.getSnapshot()
    expect(second.outcomeCounts).toMatchObject({ DELIVERED_DUPLICATE: 8 })
    expect(second.total).toMatchObject({ serverAccepted: 0, serverDuplicate: 8, uniqueObservationsDelivered: 8, failed: 0, nativeOnly: 0 })
    expect(second.lastNativeObservationIds.hrv).toBeNull()
  })

  it('surfaces accepted + canonical failed as recovery-required, never delivered', async () => {
    backend.canonicalFailMetric = 'oxygenSaturation'
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await delivery.deliverSyncResult(allFeeds()[1])
    const snapshot = delivery.getSnapshot()
    expect(snapshot.metrics.spo2).toMatchObject({ serverAccepted: 4, canonicalFailed: 4, canonicalized: 0, uniqueObservationsDelivered: 0, failed: 0 })
    expect(snapshot.outcomeCounts.CANONICAL_FAILED).toBe(4)
    expect(snapshot.lastCanonicalFailure).toMatchObject({ metric: 'spo2', errorCode: 'CANONICAL_WRITE_FAILED' })
    expect((await observationQueue.getQueueStats()).failed).toBe(0)
    expect((await observationQueue.getQueueStats()).canonicalRecoveryObservationCount).toBe(4)
    expect((await observationQueue.getPending(100))).toHaveLength(0)
  })

  it('maps rejected results with reason/errorCode and rejects them in the queue even beyond the 50-entry errors[] cap', async () => {
    const hr = allFeeds()[0]
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => {
      if (backend.requests.length === 0) request.observations.slice(0, 60).forEach((o) => backend.rejectIds.add(o.observationId))
      return backend.accept(request)
    })
    await delivery.deliverSyncResult(hr)
    expect(backend.requests[0].observations).toHaveLength(100)
    const snapshot = delivery.getSnapshot()
    expect(snapshot.metrics.heartRateHistory).toMatchObject({ serverRejected: 60, failed: 60, serverAccepted: 90, canonicalized: 90, uniqueObservationsDelivered: 90 })
    expect(snapshot.lastRejection).toMatchObject({ metric: 'heartRateHistory', reason: 'valueNumber out of range', errorCode: 'VALIDATION_ERROR' })
    expect((await observationQueue.getQueueStats()).failed).toBe(60)
  })

  it('uses errors[] only as supplementary diagnostics and counts entries without an observationId', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => {
      const response = backend.accept(request)
      return { ...response, rejected: response.rejected + 1, errors: [...response.errors, { reason: 'observation missing observationId' }] }
    })
    await delivery.deliverSyncResult(allFeeds()[2])
    const snapshot = delivery.getSnapshot()
    expect(snapshot.unattributedErrors).toBe(1)
    expect(snapshot.metrics.wearableTemperature).toMatchObject({ serverAccepted: 2, canonicalized: 2, serverRejected: 0, failed: 0 })
  })

  it('includes timestampTimezoneSource in every outgoing historical payload', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await syncAll()
    const sent = backend.requests.flatMap((request) => JSON.parse(JSON.stringify(request.observations)) as NativeObservationInput[])
    expect(sent.length).toBe(220)
    expect(sent.every((observation) => observation.timestampTimezoneSource === 'PHONE_TIMEZONE')).toBe(true)
  })

  it('leaves Build 5A workout HR delivery untouched when sharing a results[] batch', async () => {
    const owner = observationQueue.getOwnerUserId()!
    const workout = (await buildWorkoutHrObservation(owner, { sessionId: 'w-1', heartRate: 128, packetSequence: 1, receivedAt: RECEIPT, vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME' }, { deviceId: OPAQUE_ID, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }))!
    await observationQueue.enqueue(workout)
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    await delivery.deliverSyncResult(allFeeds()[1])

    const sentWorkout = backend.nativeObservations.get(workout.observationId)!
    expect(sentWorkout).toMatchObject({ metric: 'heartRate', timestampSource: 'CONNECTOR_BLE_RECEIPT_TIME', timestampConfidence: 'RECEIPT_TIME_NO_VENDOR_TIMESTAMP' })
    expect(sentWorkout).not.toHaveProperty('timestampTimezoneSource')
    expect(delivery.getSnapshot().total).toMatchObject({ serverAccepted: 4, canonicalized: 4, uniqueObservationsDelivered: 4 })
    expect((await observationQueue.getQueueStats()).pending).toBe(0)
  })

  it('honours per-metric enablement', async () => {
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => backend.accept(request))
    delivery.setMetricEnabled('ppi', false)
    await syncAll()
    expect(backend.countByMetricType().PPI).toBeUndefined()
    expect(delivery.getSnapshot().metrics.ppi.captured).toBe(0)
  })
})
