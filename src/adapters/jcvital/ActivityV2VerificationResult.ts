export function classifyActivityV2Verification(transportPassed: boolean, canonicalResponseConfirmed: boolean) {
  return {
    transportE2E: transportPassed ? 'PASS' as const : 'FAIL' as const,
    canonicalResponseEvidence: canonicalResponseConfirmed ? 'VERIFIED' as const : 'FAILED' as const,
    fullCanonicalE2E: 'UNVERIFIED' as const,
    independentCanonicalRowReadback: 'NOT AVAILABLE' as const,
  }
}
