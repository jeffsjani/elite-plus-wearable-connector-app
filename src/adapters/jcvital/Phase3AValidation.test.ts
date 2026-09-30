import { describe, expect, it } from 'vitest'
import { AcquisitionMode, CompletionStatus, MetricType } from '../../models/metricTaxonomy'
import type { NativeObservation } from '../../models/wearableObservation'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import {
  buildHistoricalFeedResult,
  buildPhase3AValidationReport,
  type HistoricalFeedRun,
} from './Phase3AValidation'

function observation(overrides: Partial<NativeObservation>): NativeObservation {
  return {
    id: 'observation-1',
    source: {
      connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: 'device-1',
      macAddress: null, firmwareVersion: '0.0.3.4', sdkVersion: 'v8sdk2.0',
    },
    metricType: MetricType.HEART_RATE_CONTINUOUS,
    observedAt: '2026-09-30T10:00:00.000Z', observedAtSource: '2026.09.30 10:00:00',
    receivedAt: '2026-09-30T10:01:00.000Z', timezone: 'UTC', value: 70, values: null, unit: 'bpm',
    acquisitionMode: AcquisitionMode.HISTORICAL_SYNC, measurementContext: null, sessionId: 'sync-1', packetId: null,
    sequenceNumber: 0, samplingIntervalMs: 5000, sampleRateHz: null, signalQuality: null,
    completeness: null, vendorDataType: '27', vendorField: 'arrayDynamicHR', vendorDerived: false,
    rawPayload: { record: { arrayDynamicHR: '70 71' } },
    provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
    ...overrides,
  }
}

function run(observations: NativeObservation[], overrides: Partial<JCVitalV8HistoricalSyncResult> = {}): HistoricalFeedRun {
  const timestamps = observations.map((item) => item.observedAt).filter((value): value is string => value !== null).sort()
  return {
    requestStartedAt: '2026-09-30T09:59:59.000Z',
    requestCompletedAt: '2026-09-30T10:01:01.000Z',
    error: null,
    result: {
      syncId: 'sync-1', deviceId: 'device-1', provider: 'JCVITAL', sdkCommand: 'fixture', vendorDataType: '27',
      startedAt: '2026-09-30T09:59:59.000Z', completedAt: '2026-09-30T10:01:01.000Z',
      recordsReceived: observations.length, recordGroupsReceived: observations.length, recordsStored: 0,
      recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: timestamps[0] ?? null,
      latestObservation: timestamps.at(-1) ?? null, partial: false, completionStatus: CompletionStatus.COMPLETE,
      packetCount: 1, parseErrors: [], observations,
      ...overrides,
    },
  }
}

describe('Phase 3A physical validation diagnostics', () => {
  it('uses UNKNOWN while pending and FAILED only after an error', () => {
    expect(buildHistoricalFeedResult('heartRate', {
      requestStartedAt: '2026-09-30T10:00:00.000Z', requestCompletedAt: null, result: null, error: null,
    }).completionStatus).toBe('UNKNOWN')
    expect(buildHistoricalFeedResult('heartRate', {
      requestStartedAt: '2026-09-30T10:00:00.000Z', requestCompletedAt: '2026-09-30T10:00:01.000Z', result: null, error: 'timeout',
    }).completionStatus).toBe('FAILED')
  })

  it('reports unresampled HR cadence and the proportion within 4-6 seconds', () => {
    const observations = [0, 5000, 10000, 17000].map((offset, index) => observation({
      id: `hr-${index}`, sequenceNumber: index, observedAt: new Date(Date.parse('2026-09-30T10:00:00.000Z') + offset).toISOString(),
    }))
    const feed = buildHistoricalFeedResult('heartRate', run(observations))

    expect(feed.sampleDiagnostics).toMatchObject({
      totalSampleCount: 4, medianIntervalSeconds: 5, minimumIntervalSeconds: 5,
      maximumIntervalSeconds: 7, intervalsBetween4And6Seconds: 2,
      percentageBetween4And6Seconds: 2 / 3 * 100, resampled: false,
    })
  })

  it('reports SpO2 values individually with zero/invalid counts', () => {
    const observations = [97, 0, null].map((value, index) => observation({
      id: `spo2-${index}`, metricType: MetricType.SPO2, value, unit: 'percent', vendorDataType: '68',
      observedAt: new Date(Date.parse('2026-09-30T10:00:00.000Z') + index * 300000).toISOString(),
    }))
    const feed = buildHistoricalFeedResult('spo2', run(observations, { recordsDeduplicated: 1 }))

    expect(feed.allRecords).toHaveLength(3)
    expect(feed.sampleDiagnostics).toMatchObject({ minimum: 0, maximum: 97, median: 48.5, duplicateCount: 1, invalidOrZeroCount: 2 })
  })

  it('keeps raw temperature and labels only wearable temperature', () => {
    const feed = buildHistoricalFeedResult('temperature', run([
      observation({ metricType: MetricType.WEARABLE_TEMPERATURE, value: 36.4, unit: 'celsius', vendorDataType: '59', rawPayload: { record: { temperature: '36.4' } } }),
    ]))

    expect(feed.sampleDiagnostics).toMatchObject({ minimumCelsius: 36.4, maximumCelsius: 36.4, measurementLabel: 'wearable_temperature_c' })
    expect(JSON.stringify(feed.firstFive)).toContain('36.4')
    expect(JSON.stringify(feed.firstFive)).not.toContain('core body')
  })

  it('groups HRV vendor metrics and labels absent fatigue and estimated BP', () => {
    const rawPayload = { record: { hrv: '42', heartRate: '66', stress: '3', highBP: '118', lowBP: '76' } }
    const metrics: Array<[NativeObservation['metricType'], number]> = [
      [MetricType.HRV_VENDOR, 42], [MetricType.HEART_RATE_AUTOMATIC, 66], [MetricType.STRESS_VENDOR, 3],
      [MetricType.BP_SYSTOLIC_ESTIMATED, 118], [MetricType.BP_DIASTOLIC_ESTIMATED, 76],
    ]
    const feed = buildHistoricalFeedResult('hrv', run(metrics.map(([metricType, value], index) => observation({
      id: `hrv-${index}`, metricType, value, unit: metricType === MetricType.HEART_RATE_AUTOMATIC ? 'bpm' : 'UNKNOWN_VENDOR_UNIT',
      vendorDataType: '42', observedAtSource: '2026.09.30 10:00:00', rawPayload,
    })), { recordGroupsReceived: 1 }))

    expect(feed.sourceRecordsReceived).toBe(1)
    expect(feed.normalizedObservationsProduced).toBe(5)
    expect(feed.allRecords[0]).toMatchObject({
      vendorHrv: 42, heartRate: 66, stress: 3,
      estimatedVendorBp: { classification: 'ESTIMATED_VENDOR_BP', systolic: 118, diastolic: 76 },
      fatigue: 'NOT_EMITTED_BY_DEVICE',
    })
  })

  it('preserves PPI groups, arrays, counts, and unknown units', () => {
    const feed = buildHistoricalFeedResult('ppi', run([
      observation({
        metricType: MetricType.PPI, value: null, values: [812, 0, 799], unit: 'UNKNOWN_VENDOR_UNIT',
        packetId: '513', vendorDataType: '127', rawPayload: { record: { ppiData: '[812, 0, 799]' } },
      }),
    ], { recordGroupsReceived: 1 }))

    expect(feed.sampleDiagnostics).toMatchObject({
      groupCount: 1, intervalCount: 3, minimumValue: 0, maximumValue: 812,
      medianValue: 799, paddingOrZeroCount: 1,
      zeroSemantics: 'PROBABLE_UNUSED_ARRAY_CAPACITY_NOT_INVALID_PHYSIOLOGY',
      unit: 'UNKNOWN_VENDOR_UNIT',
    })
    expect(feed.allRecords[0]).toMatchObject({ groupSequence: '513', arrayLength: 3, rawValues: [812, 0, 799] })
  })

  it('exports device/session/feed structure and limits raw payloads to first/last samples', () => {
    const observations = Array.from({ length: 12 }, (_, index) => observation({ id: `hr-${index}`, value: 60 + index }))
    const report = buildPhase3AValidationReport({
      deviceInfo: { deviceId: 'device-1', firmwareVersion: '0.0.3.4', sdkVersion: 'v8sdk2.0', missingFields: [] },
      historicalRuns: { heartRate: run(observations) },
    })

    expect(report.device).toEqual({ model: 'PRO_V8', deviceId: 'device-1', firmwareVersion: '0.0.3.4', sdkVersion: 'v8sdk2.0' })
    expect(report.feedResults.heartRate.firstFive).toHaveLength(5)
    expect(report.feedResults.heartRate.lastFive).toHaveLength(5)
    expect(report.feedResults.heartRate).not.toHaveProperty('allRecords')
    expect(report.feedResults.monitoringConfiguration.completionStatus).toBe('UNKNOWN')
  })
})