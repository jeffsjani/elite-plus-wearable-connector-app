import { describe, expect, it } from 'vitest'
import { certificationDeliveryState, type ExactDeliveryEvidence } from './CertificationDeliveryState'

const evidence = (overrides: Partial<ExactDeliveryEvidence> = {}): ExactDeliveryEvidence => ({
  acknowledged: true, outcome: 'DELIVERED',
  result: { observationId: 'exact-id', status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: 'native-id' },
  ...overrides,
})

describe('exact-ID certification delivery states', () => {
  it('keeps capture and unknown acknowledgements separate from proven delivery', () => {
    expect(certificationDeliveryState(null, null)).toBe('CAPTURED_NOT_DELIVERED')
    expect(certificationDeliveryState(null, 'ACKNOWLEDGED')).toBe('DELIVERY_UNKNOWN')
    expect(certificationDeliveryState(evidence({ result: null }), 'ACKNOWLEDGED')).toBe('DELIVERY_UNKNOWN')
  })

  it.each(['PENDING', 'IN_FLIGHT', 'RETRY_WAIT'])('reports durable %s rows as QUEUED', (state) => {
    expect(certificationDeliveryState(null, state)).toBe('QUEUED')
  })

  it.each([
    ['canonicalized', 'DELIVERED_CANONICALIZED'],
    ['not_applicable', 'DELIVERED_NATIVE_ONLY'],
    ['failed', 'CANONICAL_FAILED'],
  ] as const)('attributes accepted canonicalStatus=%s exactly', (canonicalStatus, expected) => {
    expect(certificationDeliveryState(evidence({
      result: { observationId: 'exact-id', status: 'accepted', canonicalStatus },
    }), 'ACKNOWLEDGED')).toBe(expected)
  })

  it('reports duplicates, rejections and failures without assuming canonicalization', () => {
    expect(certificationDeliveryState(evidence({ result: { observationId: 'exact-id', status: 'duplicate', canonicalStatus: null } }), 'ACKNOWLEDGED')).toBe('DELIVERED_DUPLICATE')
    expect(certificationDeliveryState(evidence({ acknowledged: false, result: { observationId: 'exact-id', status: 'rejected' } }), 'FAILED_PERMANENT')).toBe('REJECTED')
    expect(certificationDeliveryState(null, 'FAILED_PERMANENT')).toBe('FAILED')
    expect(certificationDeliveryState(evidence({ acknowledged: false, result: null, outcome: 'FAILED' }), null)).toBe('FAILED')
  })

  it('never lets an old duplicate or acknowledgement mask canonical recovery', () => {
    expect(certificationDeliveryState(evidence({ result: { observationId: 'exact-id', status: 'duplicate' } }), 'CANONICAL_RECOVERY_REQUIRED')).toBe('CANONICAL_FAILED')
    expect(certificationDeliveryState(evidence({ outcome: 'CANONICAL_RECOVERY_REQUIRED' }), null)).toBe('CANONICAL_FAILED')
  })

  it('does not attribute a batch canonical failure from another observation to a successful exact ID', () => {
    expect(certificationDeliveryState(evidence({ outcome: 'CANONICAL_FAILED' }), null)).toBe('DELIVERED_CANONICALIZED')
  })
})
