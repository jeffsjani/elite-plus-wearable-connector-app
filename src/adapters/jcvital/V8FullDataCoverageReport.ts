import { ReadinessInputRegistry } from './ReadinessInputRegistry'
import { V8CanonicalPromotionManifest } from './V8CanonicalPromotionManifest'
import { V8DataCoverageRegistry, V8DataCoverageRollup } from './V8DataCoverageRegistry'

export const V8_FULL_DATA_COVERAGE_REPORT_SCHEMA = 'V8FullDataCoverageReport.v1'
export const V8_FULL_DATA_COVERAGE_REPORT_FILENAME = 'ElitePlus-V8-Full-Data-Coverage-Report.json'

/** Static/read-only report construction. Does not access Bluetooth, queue, journal, or Base44. */
export function createV8FullDataCoverageReport() {
  const candidateFields = V8DataCoverageRegistry.filter(
    (field) => field.canonicalEligibility === 'PENDING_SEMANTIC_VALIDATION',
  )
  const promotions = new Map(V8CanonicalPromotionManifest.fields.map((entry) => [
    `${entry.vendorDataType ?? 'null'}|${entry.vendorField}`,
    entry,
  ]))
  return {
    schema: V8_FULL_DATA_COVERAGE_REPORT_SCHEMA,
    package: 'com.hapi.eliteplus.connector',
    sdk: 'android/app/libs/v8sdk2.0.jar',
    phase: 'P1-2A',
    scope: 'Current shipped SDK surface and current source implementation; no acquisition performed.',
    rollups: V8DataCoverageRollup,
    fields: V8DataCoverageRegistry,
    canonicalCandidateFields: candidateFields.map((field) => {
      const promotion = promotions.get(`${field.vendorDataType ?? 'null'}|${field.vendorField}`)
      return {
        vendorDataType: field.vendorDataType,
        vendorField: field.vendorField,
        elitePlusSourceMetric: field.elitePlusSourceMetric,
        manifestOperation: promotion?.operation ?? 'noCanonical',
        exactExistingTarget: promotion?.proposedCanonical?.target ?? promotion?.existingCanonical?.target ?? null,
        knownLimitations: field.knownLimitations,
      }
    }),
    derivedIntelligenceCandidates: {
      restingHrInputs: ['Type 27 historical HR; derived resting-HR algorithm is unchanged and not implemented here.'],
      hrvBaselineAndDeviation: ['Type 42 HRV remains source-only pending unit/definition compatibility.'],
      sleepEfficiencyAndDebt: ['Sleep duration/stage semantics are not promoted by this phase.'],
      activityLoadAndTrainingLoad: ['Activity 24/25 reconciliation and workout semantics remain pending.'],
      strainRecoveryBalanceAndReadiness: ['No V8 vendor score is expected; Elite+ algorithms remain unchanged.'],
    },
    unsupportedSdkFields: V8DataCoverageRegistry.filter((field) => field.sdkExposure === 'NOT_EXPOSED_BY_CURRENT_SDK'),
    blockedFields: V8DataCoverageRegistry.filter((field) => field.finalDisposition === 'BLOCKED_VENDOR_DEPENDENCY'),
    readinessInputs: ReadinessInputRegistry,
    promotionManifest: V8CanonicalPromotionManifest,
    sideEffects: {
      connects: false,
      acquires: false,
      syncs: false,
      enqueues: false,
      delivers: false,
      changesQueue: false,
      changesJournal: false,
      writesCanonicalData: false,
      changesReadinessOrScoring: false,
    },
  } as const
}
