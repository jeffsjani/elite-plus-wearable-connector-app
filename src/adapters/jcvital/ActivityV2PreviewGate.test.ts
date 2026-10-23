import { describe, expect, it } from 'vitest'
import { activityV2PreviewCanVerify } from './ActivityV2PreviewGate'

const identity = {
  ownerUserId: 'owner-1',
  installId: 'install-1',
  connectorDeviceId: 'connector-1',
  accountId: 'owner-1',
  deviceScopeId: 'device-1',
}
const capability = {
  capabilitySupported: true,
  productionDeliveryEnabled: true,
  reason: 'CAPABILITY_SUPPORTED',
}

function preview(overrides: Record<string, unknown> = {}) {
  return {
    previewStatus: 'PASS',
    expectedObservationCount: 14,
    selectionScope: identity,
    type24: { sourceEnvelopeId: 'type24-id', mappingValid: true },
    type25: { sourceEnvelopeId: 'type25-id', qualification: 'PASS' },
    queue: { queueConflict: false },
    observations: Array.from({ length: 14 }, (_, index) => ({ observationId: `observation-${index}` })),
    ...overrides,
  }
}

function canVerify(report: Record<string, unknown>, currentCapability = capability) {
  return activityV2PreviewCanVerify(JSON.stringify(report), currentCapability, identity)
}

describe('activityV2PreviewCanVerify', () => {
  it('enables only a passing, correctly scoped preview with 14 unique mapped observation IDs', () => {
    expect(canVerify(preview())).toBe(true)
  })

  it.each([
    ['capability absent', { ...capability, capabilitySupported: false }],
    ['production delivery disabled', { ...capability, productionDeliveryEnabled: false }],
    ['capability decision unsupported', { ...capability, reason: 'CAPABILITY_UNSUPPORTED' }],
  ])('blocks Verify when %s', (_label, currentCapability) => {
    expect(activityV2PreviewCanVerify(JSON.stringify(preview()), currentCapability, identity)).toBe(false)
  })

  it.each([
    ['missing Type24', { type24: { mappingValid: false } }],
    ['missing qualified Type25', { type25: { qualification: 'FAIL' } }],
    ['queue conflict', { queue: { queueConflict: true } }],
    ['wrong observation count', { expectedObservationCount: 13 }],
    ['duplicate observation IDs', {
      observations: [...Array.from({ length: 13 }, (_, index) => ({ observationId: `observation-${index}` })),
        { observationId: 'observation-0' }],
    }],
    ['different install scope', { selectionScope: { ...identity, installId: 'other-install' } }],
  ])('blocks Verify for %s', (_label, overrides) => {
    expect(canVerify(preview(overrides))).toBe(false)
  })
})
