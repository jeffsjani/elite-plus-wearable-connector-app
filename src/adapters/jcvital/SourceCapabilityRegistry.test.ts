import { describe, expect, it } from 'vitest'
import { athleteVisibleSourceCapabilities, JCVitalSourceCapabilityRegistry } from './SourceCapabilityRegistry'

describe('JCVitalSourceCapabilityRegistry', () => {
  it('keeps capture, canonical, and scoring eligibility explicit for every source', () => {
    for (const source of JCVitalSourceCapabilityRegistry) {
      expect(source.captureStatus).toBeTruthy()
      expect(source.canonicalEligibility).toBeTruthy()
      expect(source.scoringEligibility).toBeTruthy()
      expect(source.deliveryEligibility).toBeTruthy()
    }
  })

  it('keeps PPG native-only, unknown-unit, and isolated from glucose', () => {
    const ppg = JCVitalSourceCapabilityRegistry.find((source) => source.sourceFamily === 'Raw PPG')

    expect(ppg).toMatchObject({
      captureStatus: 'CERTIFIED_E2E_LOSSLESS_SOURCE',
      deliveryEligibility: 'RESEARCH_NATIVE_ONLY',
      canonicalEligibility: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
      scoringEligibility: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
      semanticConfidence: 'UNKNOWN_VENDOR_UNIT_AND_SAMPLE_RATE',
    })
    expect(ppg?.knownLimitations).toEqual(expect.arrayContaining([
      'sampleRateHz = null; samplingIntervalMs = null.',
      'RAW_PPG_NOT_GLUCOSE',
      'NO_GLUCOSE_CANONICAL_MAPPING',
      'NO_GLUCOSE_INFERENCE',
      'NO_CGM_SUBSTITUTION',
    ]))
    expect(ppg?.athleteLabel).toBeNull()
  })

  it('keeps ECG blocked and suppresses research-only sources from athlete categories', () => {
    expect(JCVitalSourceCapabilityRegistry.find((source) => source.sourceFamily === 'ECG')).toMatchObject({
      captureStatus: 'BLOCKED_VENDOR_DEPENDENCY',
      deliveryEligibility: 'NOT_SUPPORTED',
      canonicalEligibility: 'BLOCKED',
      scoringEligibility: 'BLOCKED',
    })
    expect(athleteVisibleSourceCapabilities.map((source) => source.sourceFamily)).not.toContain('ECG')
    expect(athleteVisibleSourceCapabilities.map((source) => source.sourceFamily)).not.toContain('Raw PPG')
    expect(athleteVisibleSourceCapabilities.map((source) => source.sourceFamily)).not.toContain('Pulse-to-pulse intervals')
  })

  it('retains the physical Type 29 decoder and parser-defect diagnostic in engineering metadata', () => {
    const workout = JCVitalSourceCapabilityRegistry.find((source) => source.sourceFamily === 'Workout history')

    expect(workout?.knownLimitations).toContain('VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG')
    expect(workout?.knownLimitations).toContain('Retain the 26-byte physical decoder and direct physical decoding.')
  })
})
