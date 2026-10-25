export interface ActivityV2ScopedE2ESafetyInput {
  expectedObservationCount: number
  testIdCollisionCount: number
  testIdsAbsentCount: number
  scopedClaimAvailable: boolean
  scopedOwnerFilterAvailable: boolean
  scopedIdFilterAvailable: boolean
  scopedAtomicClaimAvailable: boolean
  workerRacePrevented: boolean
  diagnosticBypassesNormalFifo: boolean
  capabilityPresent: boolean
  productionDeliveryEnabled: boolean
  type24Valid: boolean
  type25Qualified: boolean
  previewReadOnly: boolean
}

export interface ActivityV2ScopedE2ESafetyPredicates {
  expectedObservationCount14: boolean
  zeroTestIdCollisions: boolean
  allExpectedIdsAbsent: boolean
  scopedClaimAvailable: boolean
  scopedOwnerFilterAvailable: boolean
  scopedIdFilterAvailable: boolean
  scopedAtomicClaimAvailable: boolean
  workerRacePrevented: boolean
  diagnosticBypassesNormalFifo: boolean
  capabilityPresent: boolean
  productionDeliveryEnabled: boolean
  type24Valid: boolean
  type25Qualified: boolean
  previewReadOnly: boolean
}

export interface ActivityV2ScopedE2ESafetyResult {
  safe: boolean
  predicates: ActivityV2ScopedE2ESafetyPredicates
  unsafeReasons: string[]
}

export const ACTIVITY_V2_SCOPED_E2E_EXPECTED_COUNT = 14

// Unrelated queue backlog is intentionally not an input: the scoped claim never touches those rows.
export function evaluateActivityV2ScopedE2ESafety(
  input: ActivityV2ScopedE2ESafetyInput,
): ActivityV2ScopedE2ESafetyResult {
  const expected = ACTIVITY_V2_SCOPED_E2E_EXPECTED_COUNT
  const predicates: ActivityV2ScopedE2ESafetyPredicates = {
    expectedObservationCount14: input.expectedObservationCount === expected,
    zeroTestIdCollisions: input.testIdCollisionCount === 0,
    allExpectedIdsAbsent: input.testIdsAbsentCount === expected,
    scopedClaimAvailable: input.scopedClaimAvailable === true,
    scopedOwnerFilterAvailable: input.scopedOwnerFilterAvailable === true,
    scopedIdFilterAvailable: input.scopedIdFilterAvailable === true,
    scopedAtomicClaimAvailable: input.scopedAtomicClaimAvailable === true,
    workerRacePrevented: input.workerRacePrevented === true,
    diagnosticBypassesNormalFifo: input.diagnosticBypassesNormalFifo === true,
    capabilityPresent: input.capabilityPresent === true,
    productionDeliveryEnabled: input.productionDeliveryEnabled === true,
    type24Valid: input.type24Valid === true,
    type25Qualified: input.type25Qualified === true,
    previewReadOnly: input.previewReadOnly === true,
  }
  const unsafeReasons = (Object.keys(predicates) as (keyof ActivityV2ScopedE2ESafetyPredicates)[])
    .filter((key) => !predicates[key])
    .map((key) => `${key}=false`)
  return { safe: unsafeReasons.length === 0, predicates, unsafeReasons }
}
