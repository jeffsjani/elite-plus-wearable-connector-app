import { describe, expect, it } from 'vitest'
import type { NativeObservationInput } from '../base44/base44Types'
import type { AcquisitionQueueProvenance } from '../storage/ObservationQueueStore'
import { addAcquisitionProvenance, BASE44_PROVENANCE_TRANSMISSION_ENABLED } from './ObservationProvenancePayload'

const payload: NativeObservationInput = {
  observationId: 'observation-1',
  source: 'V8',
  metric: 'heart_rate',
  valueNumber: 72,
  unit: 'bpm',
  startTime: '2026-10-16T12:00:00Z',
  timezone: 'UTC',
  capturedAt: '2026-10-16T12:01:00Z',
  provider: 'JCVITAL',
  sourceRecordId: 'source-record-1',
  sourceRecordGroupId: 'source-group-1',
  vendorDataType: '27',
  observedAt: '2026-10-16T12:00:00Z',
  timestampSource: 'device',
  rawSourceMetadata: { canonicalPolicy: 'EXISTING_ROUTE', sourceEnvelopeId: 'envelope-1' },
}

const provenance: AcquisitionQueueProvenance = {
  syncId: 'sync-1',
  acquisitionId: 'acquisition-1',
  acquisitionRequestId: 'request-1',
  requestedMetric: 'heartRate',
  connectionGeneration: 4,
  acquisitionStartedAt: '2026-10-16T12:00:00Z',
  acquisitionCompletedAt: '2026-10-16T12:00:30Z',
  clientQueuedAt: '2026-10-16T12:00:31Z',
}

describe('acquisition provenance sender mapping', () => {
  it('leaves the current payload unchanged when transmission is disabled', () => {
    expect(BASE44_PROVENANCE_TRANSMISSION_ENABLED).toBe(false)
    const legacy = addAcquisitionProvenance(payload, provenance, BASE44_PROVENANCE_TRANSMISSION_ENABLED)
    expect(legacy).toBe(payload)
    expect(JSON.stringify(legacy)).toBe(JSON.stringify(payload))
  })

  it('maps all locally stored provenance fields to the backward-compatible wire names when enabled', () => {
    expect(addAcquisitionProvenance(payload, provenance, true)).toEqual({
      ...payload,
      sync_id: 'sync-1',
      acquisition_id: 'acquisition-1',
      acquisition_request_id: 'request-1',
      requested_metric: 'heartRate',
      connection_generation: 4,
      acquisition_started_at: '2026-10-16T12:00:00Z',
      acquisition_completed_at: '2026-10-16T12:00:30Z',
      client_queued_at: '2026-10-16T12:00:31Z',
    })
  })

  it('does not add provenance fields when a queued record has no local provenance', () => {
    expect(addAcquisitionProvenance(payload, undefined, true)).toEqual(payload)
  })

  it('only adds provenance without changing observation/canonical identity or legacy fields', () => {
    const before = JSON.stringify(payload)
    const mapped = addAcquisitionProvenance(payload, provenance, true)
    const wireKeys = ['sync_id', 'acquisition_id', 'acquisition_request_id', 'requested_metric',
      'connection_generation', 'acquisition_started_at', 'acquisition_completed_at', 'client_queued_at']
    expect(Object.keys(mapped).filter((key) => !Object.hasOwn(payload, key))).toEqual(wireKeys)
    for (const key of Object.keys(payload) as Array<keyof NativeObservationInput>) {
      expect(mapped[key]).toEqual(payload[key])
    }
    expect(mapped.observationId).toBe(payload.observationId)
    expect(JSON.stringify(payload)).toBe(before)
    expect(addAcquisitionProvenance(payload, provenance, true)).toEqual(mapped)
  })

  it('preserves null acquisition completion/generation values without synthesizing timestamps', () => {
    expect(addAcquisitionProvenance(payload, {
      ...provenance, connectionGeneration: null, acquisitionCompletedAt: null,
    }, true)).toMatchObject({ connection_generation: null, acquisition_completed_at: null })
  })
})
