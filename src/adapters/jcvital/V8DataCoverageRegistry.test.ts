import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { PHYSIOLOGY_CONTRACTS } from './PhysiologyContract'
import { ReadinessInputRegistry, readinessEntryForSource } from './ReadinessInputRegistry'
import { V8CanonicalPromotionManifest } from './V8CanonicalPromotionManifest'
import {
  V8DataCoverageRegistry,
  V8DataCoverageRollup,
} from './V8DataCoverageRegistry'
import {
  createV8FullDataCoverageReport,
  V8_FULL_DATA_COVERAGE_REPORT_SCHEMA,
} from './V8FullDataCoverageReport'
import { TYPE29_WIRE_LAYOUT } from './Type29PhysicalWire'

const key = (vendorDataType: string | null, vendorField: string) => `${vendorDataType ?? 'null'}|${vendorField}`
const coverageKeys = new Set(V8DataCoverageRegistry.map((field) => key(field.vendorDataType, field.vendorField)))

function coverage(vendorDataType: string | null, vendorField: string) {
  const field = V8DataCoverageRegistry.find((entry) =>
    entry.vendorDataType === vendorDataType && entry.vendorField === vendorField)
  expect(field, `coverage entry ${vendorDataType}|${vendorField}`).toBeDefined()
  return field!
}

describe('V8 full data coverage and promotion inventory', () => {
  it('accounts for every known currently exposed and explicitly unsupported V8 field', () => {
    const expectedFields = [
      '27|date', '27|arrayDynamicHR',
      '23|step', '23|calories', '23|distance', '23|exerciseMinutes', '23|ExerciseTime', '23|heartRate', '23|TempData',
      '74|heartRate',
      '82|heartRate', '82|ExerciseTime', '82|step', '82|calories',
      '68|Blood_oxygen', '59|temperature',
      '42|date', '42|hrv', '42|heartRate', '42|stress', '42|highBP', '42|lowBP',
      '42|fatigueDegree', '42|vascularAging', '42|respiratoryRate', '42|mood',
      'ECG|ECGMoodValue', 'ECG|ECGBreathValue',
      '127|ppiData', '127|serial_number',
      '24|date', '24|step', '24|distance', '24|calories', '24|exerciseMinutes', '24|ExerciseTime', '24|goal',
      '25|date', '25|arraySteps', '25|detailMinterStep', '25|distance', '25|calories',
      '26|date', '26|arraySleepQuality', '26|sleepUnitLength',
      '121|date', '121|sleepLength', '121|Sleep_level', '121|ActivityData',
      '29|date', '29|sportModel', '29|heartRate', '29|ExerciseTime', '29|step', '29|sportModelSpeed', '29|distance', '29|calories',
      '119|rawNotificationBytes', '119|PPG',
      '9|batteryLevel', '9|Chargingstate', '9|VoltageValue',
      '11|deviceVersion', '117|deviceName', '10|macAddress', '2|deviceId',
      '16|workModel', '16|intervalTime', '16|heartStartHour', '16|heartStartMinter',
      '16|heartEndHour', '16|heartEndMinter', '16|weekValue',
      'null|respiratoryRate', 'null|bloodPressureMeasured', 'null|vascularAgeChronological', 'null|mood',
    ]
    expect([...coverageKeys].sort()).toEqual(expectedFields.sort())
    expect(V8DataCoverageRegistry.every((field) => field.semanticClassification.length > 0)).toBe(true)
    expect(new Set(V8DataCoverageRegistry.map((field) => key(field.vendorDataType, field.vendorField))).size)
      .toBe(V8DataCoverageRegistry.length)
    expect(V8DataCoverageRollup.unclassifiedFields).toBe(0)
    expect(V8DataCoverageRegistry.filter((field) => field.sdkExposure === 'NOT_EXPOSED_BY_CURRENT_SDK')
      .every((field) => field.finalDisposition === 'BLOCKED_VENDOR_DEPENDENCY')).toBe(true)
  })

  it('retains only existing canonical targets and requires explicit units and timestamp policies', () => {
    const targets = new Set(PHYSIOLOGY_CONTRACTS.flatMap((contract) => contract.canonicalTarget ?? []))
    const production = V8DataCoverageRegistry.filter((field) => field.finalDisposition === 'CANONICAL_PRODUCTION')
    expect(production.map((field) => field.canonicalTarget).sort()).toEqual([
      'body.heart_rate', 'body.heart_rate', 'body.oxygen_saturation', 'body.wearable_temperature',
    ].sort())
    for (const field of production) {
      expect(targets.has(field.canonicalTarget!)).toBe(true)
      expect(field.unit).not.toBe('UNKNOWN_VENDOR_UNIT')
      expect(field.unitConfidence).not.toBe('UNCONFIRMED')
      expect(field.timestampSemantics.length).toBeGreaterThan(0)
      expect(field.timestampConfidence.length).toBeGreaterThan(0)
    }
    expect(V8CanonicalPromotionManifest.schema).toBe('V8CanonicalPromotionManifest.v1')
    expect(V8CanonicalPromotionManifest.fields).toHaveLength(V8DataCoverageRegistry.length)
    expect(V8CanonicalPromotionManifest.productionCanonicalChanges).toBe(0)
    expect(V8CanonicalPromotionManifest.fields.reduce<Record<string, number>>((counts, field) => {
      counts[field.operation] = (counts[field.operation] ?? 0) + 1
      return counts
    }, {})).toEqual({ existingCanonical: 4, noCanonical: 73 })
    expect(V8CanonicalPromotionManifest.fields.every((field) =>
      field.operation === 'existingCanonical' || field.operation === 'proposedCanonical' || field.operation === 'noCanonical',
    )).toBe(true)
    expect(V8DataCoverageRegistry.every((field) => field.acquisitionSupport.length > 0
      && field.sourcePreservation.length > 0 && field.sourceCertification.length > 0
      && field.unit.length > 0 && field.unitConfidence.length > 0
      && field.timestampSemantics.length > 0 && field.timestampConfidence.length > 0
      && field.semanticClassification.length > 0)).toBe(true)
    for (const field of V8CanonicalPromotionManifest.fields) {
      if (field.operation === 'existingCanonical') {
        expect(field.existingCanonical?.sourceUnit).toBeTruthy()
        expect(field.existingCanonical?.canonicalUnit).toBeTruthy()
        expect(field.existingCanonical?.conversion).toBeTruthy()
        expect(field.existingCanonical?.timestampPolicy).toBeTruthy()
        expect(field.existingCanonical?.dedupPolicy).toBeTruthy()
        expect(field.existingCanonical?.authorityPolicy).toBeTruthy()
      }
      if (field.operation === 'proposedCanonical') {
        expect(field.proposedCanonical?.evidenceRequiredForProduction.length).toBeGreaterThan(0)
        expect(field.proposedCanonical?.readinessDefault).toBe(false)
      }
      if (field.operation === 'noCanonical') expect(field.noCanonical?.reason).toBeTruthy()
    }
  })

  it('keeps source-only and semantically pending fields out of canonical and readiness output', () => {
    for (const field of V8DataCoverageRegistry) {
      if (field.finalDisposition !== 'CANONICAL_PRODUCTION') expect(field.canonicalTarget).toBeNull()
      if (!field.canonicalTarget) expect(field.readinessEligibility).toBe(false)
    }
    for (const field of ReadinessInputRegistry) expect(field.readinessEligible).toBe(false)
    for (const field of V8DataCoverageRegistry.filter((item) => item.canonicalEligibility === 'PENDING_SEMANTIC_VALIDATION')) {
      expect(readinessEntryForSource(field.elitePlusSourceMetric), field.elitePlusSourceMetric).toBeDefined()
      expect(readinessEntryForSource(field.elitePlusSourceMetric)?.readinessEligible).toBe(false)
    }
    expect(coverage('127', 'ppiData').canonicalTarget).toBeNull()
    expect(coverage('127', 'ppiData').elitePlusSourceMetric).toBe('PPI')
    expect(coverage('119', 'rawNotificationBytes').canonicalTarget).toBeNull()
    expect(coverage('119', 'rawNotificationBytes').knownLimitations.join(' ')).toContain('NO_GLUCOSE_CANONICAL_MAPPING')
    expect(coverage('42', 'highBP').canonicalTarget).toBeNull()
    expect(coverage('42', 'highBP').knownLimitations.join(' ')).toContain('clinically measured')
    expect(coverage('42', 'vascularAging').canonicalTarget).toBeNull()
    expect(coverage('42', 'vascularAging').knownLimitations.join(' ')).toContain('chronological age')
    expect(coverage('26', 'arraySleepQuality').canonicalTarget).toBeNull()
    expect(coverage('24', 'step').knownLimitations.join(' ')).toContain('Do not double count')
    expect(coverage('25', 'arraySteps').canonicalTarget).toBeNull()
    expect(coverage('ECG', 'ECGMoodValue').finalDisposition).toBe('BLOCKED_VENDOR_DEPENDENCY')
    expect(coverage('82', 'heartRate').bodyEligibility).toBe(true)
    expect(coverage('82', 'heartRate').workoutEligibility).toBe(true)
    expect(coverage('29', 'ExerciseTime').unit).toBe('vendor_seconds_unconfirmed')
    expect(coverage('29', 'sportModelSpeed').canonicalTarget).toBeNull()
    expect(TYPE29_WIRE_LAYOUT.recordLength).toBe(26)
    expect(TYPE29_WIRE_LAYOUT.sdkStride).toBe(25)
  })

  it('persists SDK callback envelopes before normalization and exports only static registry data', () => {
    const manager = readFileSync('android/app/src/main/java/com/hapi/eliteplus/connector/jcvital/JCVitalV8Manager.kt', 'utf8')
    const reportPanel = readFileSync('src/adapters/jcvital/V8FullDataCoverageReportPanel.tsx', 'utf8')
    const callbackCapture = manager.indexOf('sourceJournal.appendCallback(maps')
    const normalization = manager.indexOf('normalizer.normalize(', callbackCapture)
    expect(callbackCapture).toBeGreaterThanOrEqual(0)
    expect(normalization).toBeGreaterThan(callbackCapture)

    const report = createV8FullDataCoverageReport()
    expect(report.schema).toBe(V8_FULL_DATA_COVERAGE_REPORT_SCHEMA)
    expect(report.fields).toBe(V8DataCoverageRegistry)
    expect(report.sideEffects).toEqual({
      connects: false, acquires: false, syncs: false, enqueues: false, delivers: false,
      changesQueue: false, changesJournal: false, writesCanonicalData: false, changesReadinessOrScoring: false,
    })
    expect(reportPanel).toContain('if (!IS_ENGINEERING_BUILD) return null')
    expect(reportPanel).toContain('Export V8 Full Data Coverage Report')
  })
})
