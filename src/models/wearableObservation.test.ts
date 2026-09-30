import { describe, expect, it } from 'vitest'
import { AcquisitionMode, CompletionStatus, MetricType } from './metricTaxonomy'
import type { NativeObservation, WearableSource } from './wearableObservation'

describe('lossless wearable observation contracts', () => {
  const source: WearableSource = {
    connector: 'JCVITAL_NATIVE',
    provider: 'JCVITAL',
    deviceModel: 'PRO_V8',
    deviceId: null,
    macAddress: null,
    firmwareVersion: null,
    sdkVersion: 'v8sdk2.0',
  }

  it('uses stable canonical identifiers and explicit acquisition modes', () => {
    expect(MetricType.HEART_RATE_CONTINUOUS).toBe('HEART_RATE_CONTINUOUS')
    expect(MetricType.WEARABLE_TEMPERATURE).toBe('WEARABLE_TEMPERATURE')
    expect(AcquisitionMode.HISTORICAL_SYNC).toBe('HISTORICAL_SYNC')
    expect(CompletionStatus.EMPTY_VALID).toBe('EMPTY_VALID')
  })

  it('preserves unknown values as null and retains the full raw payload', () => {
    const observation: NativeObservation = {
      id: 'fixture-1', source, metricType: MetricType.PPI,
      observedAt: null, observedAtSource: null, receivedAt: '2026-09-30T00:00:00.000Z', timezone: null,
      value: null, values: [812, 0, 799], unit: 'UNKNOWN_VENDOR_UNIT',
      acquisitionMode: AcquisitionMode.HISTORICAL_SYNC, measurementContext: null,
      sessionId: 'sync-1', packetId: null, sequenceNumber: null,
      samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: null,
      vendorDataType: '127', vendorField: 'ppiData', vendorDerived: false,
      rawPayload: { ppiData: '[812, 0, 799]', extraVendorKey: 3 },
      provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', sourceRecordId: null },
    }

    expect(observation.observedAt).toBeNull()
    expect(observation.unit).toBe('UNKNOWN_VENDOR_UNIT')
    expect(observation.rawPayload).toEqual({ ppiData: '[812, 0, 799]', extraVendorKey: 3 })
  })
})