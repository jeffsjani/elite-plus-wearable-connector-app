import { describe, expect, it, vi } from 'vitest'
import { DigitalWellnessOutbox, enqueueQualifiedDay, type DigitalWellnessOutboxEntry, type SenderAuthorization } from './digitalWellnessOutbox'
import { DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED, type DigitalWellnessDayObservation } from './digitalWellnessProduction'

const now = Date.parse('2026-01-03T06:00:00Z')
const day: DigitalWellnessDayObservation = {
  local_date: '2026-01-02', timezone: 'UTC', observed_start: '2026-01-02T00:00:00Z', observed_end: '2026-01-03T00:00:00Z',
  screen_time_minutes: 30, pickups: 1, first_pickup: '2026-01-02T10:00:00Z', screen_sessions: 1, late_night_screen_minutes: 0,
  coverage_state: 'QUALIFIED', confidence: 'HIGH', quality_reasons: [], source: 'ANDROID_USAGE_STATS',
  semantic_version: 'android.digital_balance.v1', qualification_policy_version: 'android.digital_balance.qualification.v1',
  captured_at: '2026-01-03T06:00:00Z', updated_at: '2026-01-03T06:00:00Z',
}
function fixture() {
  let serialized = JSON.stringify(enqueueQualifiedDay([], day, 'owner-scope-a', now))
  const store = {
    read: (): DigitalWellnessOutboxEntry[] => JSON.parse(serialized),
    write: (entries: DigitalWellnessOutboxEntry[]) => { serialized = JSON.stringify(entries) },
  }
  let auth: SenderAuthorization | null = { scope: 'owner-scope-a', consent: true, usageAccess: true }
  const transport = vi.fn<(items: unknown[]) => Promise<unknown>>(async () => { throw new Error('offline') })
  const sender = (flag = true, time = now) => new DigitalWellnessOutbox(store, transport, () => auth, flag, () => time)
  return { store, transport, sender, setAuth: (value: SenderAuthorization | null) => { auth = value } }
}
describe('dedicated DigitalWellnessOutbox', () => {
  it('offline enqueue, restart, and retry preserve deterministic identities', async () => {
    const { store, sender, transport } = fixture()
    const original = store.read().map((entry) => entry.observation.client_observation_id)
    await sender().send()
    expect(store.read()[0].ack).toBeNull()
    expect(store.read()[0].attempts).toBe(1)
    await sender(true, now + 60001).send()
    expect(transport).toHaveBeenCalledTimes(2)
    expect(store.read()[0].attempts).toBe(2)
    expect(store.read().map((entry) => entry.observation.client_observation_id)).toEqual(original)
    expect(enqueueQualifiedDay(store.read(), day, 'owner-scope-a', now + 60001)).toHaveLength(5)
  })
  it.each(['ACCEPTED', 'DUPLICATE'])('only explicit matching %s is acknowledged', async (status) => {
    const { store, sender, transport } = fixture()
    const id = store.read()[0].observation.client_observation_id
    transport.mockResolvedValue({ status, client_observation_id: id })
    await sender().send()
    expect(store.read()[0].ack).toBe(status)
  })
  it.each([{}, { status: 'ACCEPTED' }, { status: 'REJECTED' }, { status: 'ACCEPTED', client_observation_id: 'wrong' }])(
    'ambiguous or rejected response remains retryable (%j)', async (response) => {
      const { store, sender, transport } = fixture()
      transport.mockResolvedValue(response)
      await sender().send()
      expect(store.read()[0].ack).toBeNull()
      expect(store.read()[0].next_attempt_at).toBeGreaterThan(now)
    })
  it('isolates owners and stops on revocation, logout, or access denial', async () => {
    const { sender, setAuth, transport } = fixture()
    for (const auth of [
      null, { scope: 'owner-scope-b', consent: true, usageAccess: true },
      { scope: 'owner-scope-a', consent: false, usageAccess: true },
      { scope: 'owner-scope-a', consent: true, usageAccess: false },
    ]) { setAuth(auth); await sender().send() }
    expect(transport).not.toHaveBeenCalled()
  })
  it('does not apply a late response to another owner or revoked consent', async () => {
    const { sender, store, transport, setAuth } = fixture()
    transport.mockImplementation(async () => {
      setAuth(null)
      return { status: 'ACCEPTED', client_observation_id: store.read()[0].observation.client_observation_id }
    })
    await sender().send()
    expect(store.read()[0].ack).toBeNull()
  })
  it('cloud flag false guarantees zero transport calls even while eligible and online', async () => {
    const { sender, transport } = fixture()
    expect(DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED).toBe(false)
    await sender(DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED).send()
    expect(transport).not.toHaveBeenCalled()
  })
  it('partial, unknown, and open days never enqueue; retention is bounded', () => {
    for (const coverage_state of ['PARTIAL', 'UNKNOWN'] as const) {
      expect(enqueueQualifiedDay([], { ...day, coverage_state }, 'owner-a', now)).toEqual([])
    }
    expect(enqueueQualifiedDay([], day, 'owner-a', now - 86400000)).toEqual([])
    const entries = enqueueQualifiedDay([], day, 'owner-a', now)
    expect(enqueueQualifiedDay(entries, day, 'owner-b', now + 91 * 86400000)).toHaveLength(5)
    expect(JSON.stringify(entries)).not.toMatch(/package|applicationName|activityName|https?:|notification|message|screenContents|UsageEvents/)
    expect(Object.keys(entries[0].observation).sort()).toEqual([
      'client_observation_id', 'local_date', 'timezone', 'metric_key', 'value', 'unit', 'observed_start',
      'observed_end', 'source', 'semantic_version', 'qualification_policy_version', 'coverage_state',
      'confidence', 'quality_reasons', 'captured_at', 'client_queued_at',
    ].sort())
  })
})
