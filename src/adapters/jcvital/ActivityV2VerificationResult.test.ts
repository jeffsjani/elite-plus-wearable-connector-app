import { describe, expect, it } from 'vitest'
import { classifyActivityV2Verification } from './ActivityV2VerificationResult'

describe('classifyActivityV2Verification', () => {
  it('keeps successful transport ACK/canonical response evidence distinct from row readback', () => {
    expect(classifyActivityV2Verification(true, true)).toEqual({
      transportE2E: 'PASS',
      canonicalResponseEvidence: 'VERIFIED',
      fullCanonicalE2E: 'UNVERIFIED',
      independentCanonicalRowReadback: 'NOT AVAILABLE',
    })
  })

  it('does not imply canonical persistence when transport or response evidence fails', () => {
    expect(classifyActivityV2Verification(false, false)).toEqual({
      transportE2E: 'FAIL',
      canonicalResponseEvidence: 'FAILED',
      fullCanonicalE2E: 'UNVERIFIED',
      independentCanonicalRowReadback: 'NOT AVAILABLE',
    })
  })
})
