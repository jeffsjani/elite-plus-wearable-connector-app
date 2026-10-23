import { MAX_CHECKPOINT_GAP_MS, type ProductionState } from './digitalWellnessProduction'
import type { DigitalWellnessState } from './digitalWellnessLocal'

// Live Android AppOps result. Only a direct native hasUsageAccess() probe may set this.
export type OsAccess = 'GRANTED' | 'DENIED' | 'UNKNOWN'
export type EliteConsent = 'ENABLED' | 'DISABLED'
export type CollectionState = 'DISABLED' | 'OS_ACCESS_REQUIRED' | 'AVAILABLE' | 'COLLECTING' | 'LOCAL_DATA_READY' | 'ERROR'
// Historical evidence only. It affects qualification, never current osAccess.
export type ContinuityState = 'CONTINUOUS' | 'GAP_DETECTED' | 'UNVERIFIED'

export interface NativeAccessProbe {
  osAccess: OsAccess
  appOpsResult: number | null
  checkedAt: string
  error: string | null
}
export interface DigitalWellnessAccessModel {
  osAccess: OsAccess
  consent: EliteConsent
  collection: CollectionState
  continuity: ContinuityState
}

export function collectionState(state: DigitalWellnessState): CollectionState {
  switch (state) {
    case 'DISABLED':
    case 'CONSENT_REQUIRED':
      return 'DISABLED'
    case 'OS_ACCESS_REQUIRED':
    case 'PERMISSION_REVOKED':
      return 'OS_ACCESS_REQUIRED'
    case 'AVAILABLE':
    case 'COLLECTING':
    case 'LOCAL_DATA_READY':
      return state
    default:
      return 'ERROR'
  }
}

export function productionContinuity(production: ProductionState | undefined): ContinuityState {
  if (!production?.access_established_at) return 'UNVERIFIED'
  const since = Date.parse(production.access_established_at)
  const checkpoints = production.checkpoints.filter((item) => Date.parse(item.captured_at) >= since)
  if (production.ledger.some((item) => Date.parse(item.captured_at) >= since
    && (item.event === 'ACCESS_DENIED' || item.event === 'CONSENT_DISABLED'))
    || checkpoints.some((item) => item.usage_access === 'DENIED' || item.consent !== 'ENABLED')
    || checkpoints.some((item, index) => index > 0
      && Date.parse(item.captured_at) - Date.parse(checkpoints[index - 1].captured_at) > MAX_CHECKPOINT_GAP_MS)) {
    return 'GAP_DETECTED'
  }
  return checkpoints.some((item) => item.usage_access === 'GRANTED') ? 'CONTINUOUS' : 'UNVERIFIED'
}

export function probeResult(response: unknown, checkedAt: string): NativeAccessProbe {
  const granted = typeof response === 'object' && response !== null && 'granted' in response
    ? (response as { granted: unknown }).granted : undefined
  const diagnostics = typeof response === 'object' && response !== null && 'diagnostics' in response
    ? (response as { diagnostics: unknown }).diagnostics : undefined
  const mode = typeof diagnostics === 'object' && diagnostics !== null && 'appops_result' in diagnostics
    ? (diagnostics as { appops_result: unknown }).appops_result : null
  return {
    osAccess: granted === true ? 'GRANTED' : granted === false ? 'DENIED' : 'UNKNOWN',
    appOpsResult: Number.isSafeInteger(mode) ? mode as number : null,
    checkedAt,
    error: typeof granted === 'boolean' ? null : 'INVALID_NATIVE_RESPONSE',
  }
}

export function appOpsLabel(mode: number | null): string {
  // android.app.AppOpsManager MODE_* constants.
  return mode === null ? 'UNAVAILABLE'
    : mode === 0 ? 'MODE_ALLOWED (0)' : mode === 1 ? 'MODE_IGNORED (1)' : mode === 2 ? 'MODE_ERRORED (2)'
      : mode === 3 ? 'MODE_DEFAULT (3)' : mode === 4 ? 'MODE_FOREGROUND (4)' : `MODE_${mode}`
}
