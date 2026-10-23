export const SOURCE_AUTHORITIES = ['JCVITAL_NATIVE', 'ROOK', 'DIGITAL_WELLNESS_NATIVE'] as const
export type TransportSource = typeof SOURCE_AUTHORITIES[number]
export interface Confidence {
  level: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  reasons: readonly string[]
}
export interface SourceIdentity {
  transportSource: TransportSource
  originalProvider: string
  originalDevice: string | null
  sourceRecordId: string
  semanticVersion: string
}
export interface SourceAuthorityCandidate {
  sourceTransport: TransportSource
  originalProvider: string
  originalDevice: string | null
  metric: string
  observedAt: string
  sourceRecordId: string
  semanticVersion: string
}
export const SOURCE_AUTHORITY_POLICY = Object.freeze({
  directV8OutranksRookCopyOfSameProvenRecord: true,
  rookRetainsExternalProviderRecordAuthority: true,
  digitalWellnessCompetesWithPhysiologicalSources: false,
} as const)
export interface LineageLink {
  source: SourceIdentity
  relationship: 'ORIGINAL' | 'TRANSPORTED_COPY' | 'POSSIBLE_DUPLICATE'
}
export interface AuthorityEvidence extends SourceIdentity {
  lineage: readonly LineageLink[]
  authority: 'DIRECT_DEVICE' | 'PROVIDER' | 'PHONE_CONTEXT' | 'UNRESOLVED'
  confidence: Confidence
}
