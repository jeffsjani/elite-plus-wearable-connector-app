import { DIGITAL_METRICS } from './digitalWellness'
import type { DigitalWellnessDayObservation } from './digitalWellnessProduction'

export interface WellnessContextObservation {
  client_observation_id: string
  local_date: string
  timezone: string
  metric_key: typeof DIGITAL_METRICS[number]
  value: number | string | null
  unit: 'min' | 'count' | 'timestamp'
  observed_start: string
  observed_end: string
  source: 'ANDROID_USAGE_STATS'
  semantic_version: 'android.digital_balance.v1'
  qualification_policy_version: 'android.digital_balance.qualification.v1'
  coverage_state: 'QUALIFIED'
  confidence: 'HIGH'
  quality_reasons: string[]
  captured_at: string
  client_queued_at: string
}
export interface DigitalWellnessOutboxEntry {
  scope: string
  observation: WellnessContextObservation
  attempts: number
  next_attempt_at: number
  ack: 'ACCEPTED' | 'DUPLICATE' | null
}
export function enqueueQualifiedDay(
  entries: DigitalWellnessOutboxEntry[], day: DigitalWellnessDayObservation, scope: string, now: number,
): DigitalWellnessOutboxEntry[] {
  if (day.coverage_state !== 'QUALIFIED' || Date.parse(day.observed_end) > now) return entries
  const retained = entries.filter((entry) => Date.parse(entry.observation.client_queued_at) >= now - 90 * 86400000)
  const values = [day.screen_time_minutes, day.pickups, day.first_pickup, day.screen_sessions, day.late_night_screen_minutes]
  DIGITAL_METRICS.forEach((metric, index) => {
    const id = JSON.stringify([scope, day.source, day.local_date, day.timezone, metric, day.semantic_version])
    if (retained.some((entry) => entry.observation.client_observation_id === id)) return
    retained.push({
      scope, attempts: 0, next_attempt_at: now, ack: null,
      observation: {
        client_observation_id: id, local_date: day.local_date, timezone: day.timezone,
        metric_key: metric, value: values[index], unit: index === 2 ? 'timestamp' : index === 1 || index === 3 ? 'count' : 'min',
        observed_start: day.observed_start, observed_end: day.observed_end,
        source: day.source, semantic_version: day.semantic_version, qualification_policy_version: day.qualification_policy_version,
        coverage_state: 'QUALIFIED', confidence: 'HIGH', quality_reasons: [...day.quality_reasons],
        captured_at: day.captured_at, client_queued_at: new Date(now).toISOString(),
      },
    })
  })
  if (retained.length > 1350) throw new Error('DIGITAL_WELLNESS_OUTBOX_CAPACITY')
  return retained
}
export interface OutboxStore {
  read(): DigitalWellnessOutboxEntry[]
  write(entries: DigitalWellnessOutboxEntry[]): void
}
export interface SenderAuthorization { scope: string; consent: boolean; usageAccess: boolean }
export type WellnessTransport = (observations: WellnessContextObservation[]) => Promise<unknown>

export class DigitalWellnessOutbox {
  lastOutcome = 'INACTIVE'
  private busy = false
  constructor(
    private readonly store: OutboxStore,
    private readonly transport: WellnessTransport,
    private readonly authorization: () => SenderAuthorization | null,
    private readonly cloudEnabled: boolean,
    private readonly now = () => Date.now(),
  ) {}
  async send(): Promise<void> {
    if (!this.cloudEnabled) { this.lastOutcome = 'CLOUD_DISABLED'; return }
    if (this.busy) return
    const auth = this.authorization()
    if (!auth?.consent || !auth.usageAccess) { this.lastOutcome = 'REVOKED_OR_SIGNED_OUT'; return }
    this.busy = true
    try {
      const now = this.now()
      const entry = this.store.read().find((item) => item.scope === auth.scope && !item.ack && item.next_attempt_at <= now
        && Date.parse(item.observation.client_queued_at) >= now - 90 * 86400000)
      if (!entry) { this.lastOutcome = 'IDLE'; return }
      entry.attempts++
      entry.next_attempt_at = now + Math.min(24 * 3600000, 30000 * 2 ** Math.min(entry.attempts, 12))
      this.store.write(this.store.read().map((item) =>
        item.observation.client_observation_id === entry.observation.client_observation_id ? entry : item))
      let response: unknown
      try { response = await this.transport([entry.observation]) }
      catch { this.lastOutcome = 'TRANSPORT_FAILED_RETRY_PENDING'; return }
      const current = this.authorization()
      if (!current?.consent || !current.usageAccess || current.scope !== auth.scope) {
        this.lastOutcome = 'AUTHORIZATION_CHANGED_ACK_NOT_APPLIED'; return
      }
      if (typeof response !== 'object' || response === null || !('client_observation_id' in response)
        || response.client_observation_id !== entry.observation.client_observation_id || !('status' in response)
        || (response.status !== 'ACCEPTED' && response.status !== 'DUPLICATE')) {
        this.lastOutcome = 'UNACKNOWLEDGED_RETRY_PENDING'; return
      }
      entry.ack = response.status
      this.store.write(this.store.read().map((item) =>
        item.observation.client_observation_id === entry.observation.client_observation_id ? entry : item))
      this.lastOutcome = response.status
    } finally { this.busy = false }
  }
}
