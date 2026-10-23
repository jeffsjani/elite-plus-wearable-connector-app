import { V8DataCoverageRegistry } from './V8DataCoverageRegistry'

export type V8CanonicalManifestOperation = 'existingCanonical' | 'proposedCanonical' | 'noCanonical'

export interface V8CanonicalPromotionManifestEntry {
  vendorDataType: string | null
  vendorField: string
  elitePlusSourceMetric: string
  operation: V8CanonicalManifestOperation
  existingCanonical?: {
    target: string
    sourceUnit: string
    canonicalUnit: string
    conversion: string
    timestampPolicy: string
    dedupPolicy: string
    authorityPolicy: string
    provenance: readonly string[]
    readinessDefault: false
    evidenceRequiredForProduction: readonly string[]
  }
  proposedCanonical?: {
    target: string
    sourceUnit: string
    canonicalUnit: string
    conversion: string
    timestampPolicy: string
    dedupPolicy: string
    authorityPolicy: string
    provenance: readonly string[]
    readinessDefault: false
    evidenceRequiredForProduction: readonly string[]
  }
  noCanonical?: {
    reason: string
    readinessDefault: false
  }
}

const existingCanonicalPolicies: Record<string, {
  canonicalUnit: string
  conversion: string
  timestampPolicy: string
  dedupPolicy: string
  evidenceRequiredForProduction: readonly string[]
}> = {
  '27|arrayDynamicHR': {
    canonicalUnit: 'bpm',
    conversion: 'identity (bpm)',
    timestampPolicy: 'Use source record date for sample 0; subsequent samples use the established nominal 5-second offset in phone timezone.',
    dedupPolicy: 'Keep existing stable JCVital observation/sourceRecordId generation and queue dedup behavior unchanged.',
    evidenceRequiredForProduction: ['Existing Type 27 authorization', 'Source record and receipt timestamps', 'Preserved source envelope'],
  },
  '82|heartRate': {
    canonicalUnit: 'bpm',
    conversion: 'identity (bpm)',
    timestampPolicy: 'Existing live Type 82 receipt-time policy; no device timestamp is inferred.',
    dedupPolicy: 'Keep existing Type 82 sourceRecordId/observation ID and sender behavior unchanged.',
    evidenceRequiredForProduction: ['Existing live Type 82 authorization', 'BLE receipt time', 'Workout/source session provenance'],
  },
  '68|Blood_oxygen': {
    canonicalUnit: 'percent',
    conversion: 'identity (0-100 percent)',
    timestampPolicy: 'Use the device-local Type 68 record timestamp with existing phone-timezone policy.',
    dedupPolicy: 'Keep existing Type 68 sourceRecordId/observation ID and queue dedup behavior unchanged.',
    evidenceRequiredForProduction: ['Existing Type 68 authorization', 'Source record timestamp', 'Preserved source envelope'],
  },
  '59|temperature': {
    canonicalUnit: 'celsius',
    conversion: 'identity (celsius)',
    timestampPolicy: 'Use the device-local Type 59 record timestamp with existing phone-timezone policy.',
    dedupPolicy: 'Keep existing Type 59 sourceRecordId/observation ID and queue dedup behavior unchanged.',
    evidenceRequiredForProduction: ['Existing Type 59 authorization', 'Skin-sensor site provenance', 'Source record timestamp'],
  },
}

const proposedCanonicalEvidence: readonly string[] = [
  'Approved existing Elite+ canonical target and semantic contract',
  'Vendor-authoritative unit, conversion, timestamp and cadence evidence',
  'Deterministic source identity/dedup and authority policy',
  'Complete preserved source envelope and lineage',
  'Passing deterministic mapping and regression tests',
]

function manifestEntry(field: (typeof V8DataCoverageRegistry)[number]): V8CanonicalPromotionManifestEntry {
  const key = `${field.vendorDataType}|${field.vendorField}`
  const existing = existingCanonicalPolicies[key]
  if (existing && field.canonicalTarget) {
    return {
      vendorDataType: field.vendorDataType,
      vendorField: field.vendorField,
      elitePlusSourceMetric: field.elitePlusSourceMetric,
      operation: 'existingCanonical',
      existingCanonical: {
        target: field.canonicalTarget,
        sourceUnit: field.unit,
        ...existing,
        authorityPolicy: 'JCVITAL_NATIVE is authoritative for the same physical V8 measurement; existing policy unchanged.',
        provenance: field.provenanceRequirements,
        readinessDefault: false,
      },
    }
  }

  if (field.canonicalEligibility === 'PENDING_SEMANTIC_VALIDATION' && field.canonicalTarget) {
    return {
      vendorDataType: field.vendorDataType,
      vendorField: field.vendorField,
      elitePlusSourceMetric: field.elitePlusSourceMetric,
      operation: 'proposedCanonical',
      proposedCanonical: {
        target: field.canonicalTarget,
        sourceUnit: field.unit,
        canonicalUnit: 'UNRESOLVED',
        conversion: 'UNRESOLVED; no conversion inferred',
        timestampPolicy: field.timestampSemantics,
        dedupPolicy: 'Must be approved before production; no dedup behavior is changed in P1-2A.',
        authorityPolicy: 'JCVITAL_NATIVE; direct V8 is authoritative for the same physical measurement.',
        provenance: field.provenanceRequirements,
        readinessDefault: false,
        evidenceRequiredForProduction: proposedCanonicalEvidence,
      },
    }
  }

  return {
    vendorDataType: field.vendorDataType,
    vendorField: field.vendorField,
    elitePlusSourceMetric: field.elitePlusSourceMetric,
    operation: 'noCanonical',
    noCanonical: {
      reason: field.finalDisposition === 'BLOCKED_VENDOR_DEPENDENCY'
        ? 'Blocked vendor dependency; no acquisition or canonical projection is allowed.'
        : 'No exact, approved existing Elite+ canonical target and complete semantic contract is established in the current repository.',
      readinessDefault: false,
    },
  }
}

/** Deterministic P1-2A machine-readable plan; contains no new canonical mapping. */
export const V8CanonicalPromotionManifest = {
  schema: 'V8CanonicalPromotionManifest.v1',
  phase: 'P1-2A',
  productionCanonicalChanges: 0,
  fields: V8DataCoverageRegistry.map(manifestEntry),
}

export function canonicalManifestEntry(vendorDataType: string | null, vendorField: string) {
  return V8CanonicalPromotionManifest.fields.find(
    (field) => field.vendorDataType === vendorDataType && field.vendorField === vendorField,
  )
}
