import type { Confidence } from './authority'
import type { Authorization, ExportCapability } from './types'

export const DIGITAL_METRICS = [
  'wellness.digital.screen_time_minutes',
  'wellness.digital.pickups',
  'wellness.digital.first_pickup',
  'wellness.digital.screen_sessions',
  'wellness.digital.late_night_screen_minutes',
] as const
export const DIGITAL_CAPABILITIES = ['screen_time', 'pickups', 'first_pickup', 'screen_sessions', 'late_night_screen_time'] as const
export const DIGITAL_WELLNESS_SEMANTIC_VERSION = 'android.digital_balance.v1'
export const DIGITAL_WELLNESS_POLICY = Object.freeze({
  enabled: false, scoringAuthority: 'NONE', readinessEffect: 'NONE',
} as const)

interface WellnessEnvelope {
  platform: 'ANDROID'
  osVersion: string
  captureMethod: 'ANDROID_USAGE_STATS'
  sourceMetric: string
  observedInterval: { start: string; end: string }
  timezone: string
  semanticVersion: typeof DIGITAL_WELLNESS_SEMANTIC_VERSION
  confidence: Confidence
  coverage: {
    state: 'UNKNOWN' | 'PARTIAL' | 'QUALIFIED'
    fraction: number | null
    gaps: ReadonlyArray<{ start: string; end: string; reason: string }>
  }
  permissionState: Authorization
  consentReference: string | null
  exportCapability: ExportCapability
  capturedAt: string
  scoringAuthority: 'NONE'
  readinessEffect: 'NONE'
}
export type DigitalWellnessObservation = WellnessEnvelope & (
  | { metric: 'wellness.digital.first_pickup'; value: string | null; unit: 'timestamp' }
  | { metric: 'wellness.digital.pickups' | 'wellness.digital.screen_sessions'; value: number | null; unit: 'count' }
  | { metric: 'wellness.digital.screen_time_minutes' | 'wellness.digital.late_night_screen_minutes'; value: number | null; unit: 'min' }
)
