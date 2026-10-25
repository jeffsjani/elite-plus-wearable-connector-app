import { describe, expect, it } from 'vitest'
import {
  evaluateActivityV2ScopedE2ESafety,
  type ActivityV2ScopedE2ESafetyInput,
} from './ActivityV2ScopedE2ESafety'

const phoneState: ActivityV2ScopedE2ESafetyInput = {
  expectedObservationCount: 14,
  testIdCollisionCount: 0,
  testIdsAbsentCount: 14,
  scopedClaimAvailable: true,
  scopedOwnerFilterAvailable: true,
  scopedIdFilterAvailable: true,
  scopedAtomicClaimAvailable: true,
  workerRacePrevented: true,
  diagnosticBypassesNormalFifo: true,
  capabilityPresent: true,
  productionDeliveryEnabled: true,
  type24Valid: true,
  type25Qualified: true,
  previewReadOnly: true,
}

describe('evaluateActivityV2ScopedE2ESafety', () => {
  it('is safe for the exact v75 phone state regardless of unrelated backlog', () => {
    const result = evaluateActivityV2ScopedE2ESafety(phoneState)
    expect(result.safe).toBe(true)
    expect(result.unsafeReasons).toEqual([])
    expect(Object.keys(result.predicates)).toHaveLength(14)
    expect(Object.values(result.predicates).every(Boolean)).toBe(true)
  })

  it.each<[string, Partial<ActivityV2ScopedE2ESafetyInput>, string]>([
    ['expected count != 14', { expectedObservationCount: 13 }, 'expectedObservationCount14'],
    ['test-ID collision', { testIdCollisionCount: 1, testIdsAbsentCount: 13 }, 'zeroTestIdCollisions'],
    ['not all IDs absent', { testIdsAbsentCount: 13 }, 'allExpectedIdsAbsent'],
    ['scoped claim unavailable', { scopedClaimAvailable: false }, 'scopedClaimAvailable'],
    ['owner filter unavailable', { scopedOwnerFilterAvailable: false }, 'scopedOwnerFilterAvailable'],
    ['ID filter unavailable', { scopedIdFilterAvailable: false }, 'scopedIdFilterAvailable'],
    ['atomic claim unavailable', { scopedAtomicClaimAvailable: false }, 'scopedAtomicClaimAvailable'],
    ['worker race protection unavailable', { workerRacePrevented: false }, 'workerRacePrevented'],
    ['FIFO bypass unavailable', { diagnosticBypassesNormalFifo: false }, 'diagnosticBypassesNormalFifo'],
    ['capability absent', { capabilityPresent: false }, 'capabilityPresent'],
    ['production delivery disabled', { productionDeliveryEnabled: false }, 'productionDeliveryEnabled'],
    ['Type24 invalid', { type24Valid: false }, 'type24Valid'],
    ['Type25 qualification fail', { type25Qualified: false }, 'type25Qualified'],
    ['Preview not read-only', { previewReadOnly: false }, 'previewReadOnly'],
  ])('is unsafe when %s', (_name, override, predicate) => {
    const result = evaluateActivityV2ScopedE2ESafety({ ...phoneState, ...override })
    expect(result.safe).toBe(false)
    expect(result.unsafeReasons).toContain(`${predicate}=false`)
  })
})
