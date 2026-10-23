export const CONSENT_DOMAINS = [
  'HEALTH_WEARABLE_PROCESSING', 'V8_DEVICE_ASSOCIATION', 'ROOK_PROVIDER_AUTHORIZATION', 'DIGITAL_WELLNESS',
] as const
export type ConsentDomain = typeof CONSENT_DOMAINS[number]
export interface ConsentState {
  domain: ConsentDomain
  state: 'NOT_REQUESTED' | 'GRANTED' | 'REVOKED'
  consentReference: string | null
  policyVersion: string
}
export function initialConsents(): readonly ConsentState[] {
  return CONSENT_DOMAINS.map((domain) => ({ domain, state: 'NOT_REQUESTED', consentReference: null, policyVersion: 'phase2.v1' }))
}
