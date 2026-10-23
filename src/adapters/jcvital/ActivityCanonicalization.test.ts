import { indexedDB } from 'fake-indexeddb'
import { describe, expect, it, vi } from 'vitest'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import type { NativeObservation, SerializableValue } from '../../models/wearableObservation'
import type { ActivityLedgerState } from './ActivityProductionCanonical'
import {
  ACTIVITY_BASE44_DELIVERY_ENABLED,
  canonicalizeAcquiredActivity,
  indexedDbActivityLedgerStore,
  JCVitalActivityCanonicalization,
  type ActivityLedgerStore,
} from './ActivityCanonicalization'

const OWNER = 'owner-1'
const MAC = 'AA:BB:CC:DD:EE:FF'
const DEVICE = 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b'
const TZ = 'America/Los_Angeles'
/** 2026-10-20 15:00 PDT */
const NOW = Date.parse('2026-10-20T22:00:00.000Z')

function memoryStore() {
  const data = new Map<string, string>()
  const writes: string[] = []
  const store: ActivityLedgerStore = {
    async read(key) { const raw = data.get(key); return raw ? JSON.parse(raw) as ActivityLedgerState : null },
    async write(key, state) { writes.push(key); data.set(key, JSON.stringify(state)) },
  }
  return { store, data, writes }
}

function service(store: ActivityLedgerStore, owner: string | null = OWNER) {
  const svc = new JCVitalActivityCanonicalization({
    owner: () => owner,
    resolveDeviceId: (ble) => (ble === MAC ? DEVICE : null),
    store,
    now: () => NOW,
  })
  svc.setContext({ bleAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' })
  return svc
}

function native(vendorDataType: '24' | '25' | '27', record: Record<string, unknown>, i: number, envelope: string, firmwareVersion = '0.0.8.8'): NativeObservation {
  return {
    id: `n-${vendorDataType}-${envelope}-${i}`,
    source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: MAC, macAddress: MAC, firmwareVersion, sdkVersion: 'v8sdk2.0' },
    metricType: vendorDataType === '25' ? 'DETAILED_ACTIVITY_EPOCH' : vendorDataType === '24' ? 'DAILY_STEPS' : 'HEART_RATE_AUTOMATIC',
    observedAt: null, observedAtSource: null, receivedAt: '2026-10-20T21:46:00.000Z', timezone: TZ, value: 0, values: null, unit: null,
    acquisitionMode: 'HISTORICAL_SYNC', measurementContext: null, sessionId: 'session-x', packetId: null, sequenceNumber: i,
    samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: null, vendorDataType, vendorField: null, vendorDerived: false,
    rawPayload: { vendorEnvelope: { dataType: Number(vendorDataType) }, record } as SerializableValue,
    provenance: { sourceEnvelopeId: envelope, sourceRecordId: `${envelope}-${i}`, sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', parserVersion: 'phase3b-1' },
  }
}

function result(vendorDataType: '24' | '25' | '27', observations: NativeObservation[], syncId = `sync-${vendorDataType}`): JCVitalV8HistoricalSyncResult {
  return {
    syncId, deviceId: MAC, provider: 'JCVITAL', sdkCommand: 'x', vendorDataType, startedAt: '2026-10-20T21:45:00.000Z', completedAt: '2026-10-20T21:46:00.000Z',
    recordsReceived: observations.length, recordGroupsReceived: 1, recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0, observations,
  } as unknown as JCVitalV8HistoricalSyncResult
}

const t24 = (step: string, envelope = 'env-24-a', firmwareVersion = '0.0.8.8') => result('24',
  ['step', 'distance', 'calories', 'exerciseMinutes', 'goal'].map((_, i) => native('24',
    { date: '2026.10.20', step, distance: '2.87', calories: '153.40', exerciseMinutes: '1530', goal: '80' }, i, envelope, firmwareVersion)))
const t25 = (arraySteps = '10 0 0 0 0 0 0 0 0 0', detailMinterStep = '10', envelope = '023d885d-bfec-40d2-823c-bb36b8553407', firmwareVersion = '0.0.8.8') => result('25',
  Array.from({ length: 10 }, (_, i) => native('25', { date: '2026.10.20 10:28:53', detailMinterStep, arraySteps, distance: '0.01', calories: '0.40' }, i, envelope, firmwareVersion)))

describe('P1-2C production Activity canonicalization wiring', () => {
  it('canonicalizes Type24/Type25 sync results into a durable owner/device ledger with no queue or Base44 path', async () => {
    const { store, data } = memoryStore()
    const svc = service(store)
    const daily = await svc.ingest(t24('4321'))
    const detail = await svc.ingest(t25())
    expect(daily).toMatchObject({ status: 'CANONICALIZED', observations: 4, outcomes: { CREATED: 4 } })
    expect(detail).toMatchObject({ status: 'CANONICALIZED', observations: 10, outcomes: { CREATED: 10 } })
    expect([...data.keys()]).toEqual([`${OWNER}:${DEVICE}`])
    expect(svc.getSnapshot()).toMatchObject({
      base44DeliveryEnabled: false, queueWrites: 0,
      ledgerRows: { DAILY_STEPS: 1, DAILY_DISTANCE: 1, DAILY_CALORIES: 1, EXERCISE_DURATION: 1, DETAILED_ACTIVITY_MINUTE_STEPS: 10 },
    })
    expect(ACTIVITY_BASE44_DELIVERY_ENABLED).toBe(false)
    const active = await svc.activeObservations()
    expect(active.find((o) => o.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS' && o.provenance.sourceArraySlotIndex === 0)?.observedAt)
      .toBe('2026-10-20T17:28:53.000Z')
  })

  it('persists across restarts: same-day Type24 refresh updates; exact Type25 replay is a duplicate', async () => {
    const { store } = memoryStore()
    await service(store).ingestAll([t24('4321'), t25()])
    const restarted = service(store)
    const refresh = await restarted.ingest(t24('5000', 'env-24-b'))
    const replay = await restarted.ingest(t25())
    expect(refresh.outcomes).toEqual({ UPDATED_IN_PROGRESS: 4 })
    expect(replay.outcomes).toEqual({ DUPLICATE: 10 })
    const active = await restarted.activeObservations()
    expect(active.filter((o) => o.metric === 'DAILY_STEPS')).toHaveLength(1)
    expect(active.find((o) => o.metric === 'DAILY_STEPS')?.value).toBe(5000)
    expect(active.filter((o) => o.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS')).toHaveLength(10)
  })

  it('preserves a conflicting Type25 payload and withholds integrity failures without zero-fill', async () => {
    const { store } = memoryStore()
    const svc = service(store)
    await svc.ingest(t25())
    const conflict = await svc.ingest(t25('12 0 0 0 0 0 0 0 0 0', '12', 'env-conflict'))
    expect(conflict.outcomes).toMatchObject({ CONFLICT_PRESERVED: expect.any(Number) })
    const bad = await svc.ingest(result('25', [native('25', { date: '2026.10.20 11:00:00', detailMinterStep: '9', arraySteps: '10 0 0 0 0 0 0 0 0 0' }, 0, 'env-bad')]))
    expect(bad).toMatchObject({ observations: 0, withheld: { SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP: 1 } })
    const minutes = (await svc.activeObservations()).filter((o) => o.metric === 'DETAILED_ACTIVITY_MINUTE_STEPS')
    expect(minutes).toHaveLength(10)
    expect(minutes.find((o) => o.provenance.sourceArraySlotIndex === 0)?.value).toBe(10)
  })

  it('withholds only Type25 outside the qualified scope; Type24 daily authority still canonicalizes', async () => {
    const { store } = memoryStore()
    const svc = service(store)
    const daily = await svc.ingest(t24('4321', 'env-24-a', '0.0.8.9'))
    const detail = await svc.ingest(t25(undefined, undefined, undefined, '0.0.8.9'))
    expect(daily).toMatchObject({ status: 'CANONICALIZED', observations: 4, withheld: {} })
    expect(detail).toMatchObject({ status: 'CANONICALIZED', observations: 0, withheld: { POLICY_SCOPE_MISMATCH: 1 } })
  })

  it('ignores non-Activity results and unauthenticated owners without touching the ledger store', async () => {
    const { store, writes } = memoryStore()
    expect(await service(store).ingest(result('27', [native('27', {}, 0, 'env-hr')]))).toMatchObject({ status: 'SKIPPED' })
    expect(await service(store, null).ingest(t24('4321'))).toMatchObject({ status: 'SKIPPED', reason: 'Queue owner is not authenticated.' })
    expect(writes).toEqual([])
  })

  it('serializes concurrent ingests so no ledger update is lost', async () => {
    const { store } = memoryStore()
    const svc = service(store)
    await Promise.all([svc.ingest(t24('4321')), svc.ingest(t25())])
    const fresh = service(store)
    await fresh.ingest(t25())
    expect(fresh.getSnapshot().ledgerRows).toMatchObject({ DAILY_STEPS: 1, DETAILED_ACTIVITY_MINUTE_STEPS: 10 })
  })

  it('acquisition hook uses the opaque source-journal scope and canonicalizes both Type24 and Type25 results', async () => {
    const { store, data } = memoryStore()
    const svc = new JCVitalActivityCanonicalization({ owner: () => OWNER, resolveDeviceId: () => null, store, now: () => NOW })
    const reports = await canonicalizeAcquiredActivity(svc, { accountId: OWNER, deviceScopeId: DEVICE }, { firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' }, [t24('4321'), t25()])
    expect(reports.map((r) => [r.vendorDataType, r.status, r.observations])).toEqual([['24', 'CANONICALIZED', 4], ['25', 'CANONICALIZED', 10]])
    expect([...data.keys()]).toEqual([`${OWNER}:${DEVICE}`])
  })

  it('refuses an acquired result from a different source-journal owner without writing it under the current account', async () => {
    const { store, writes } = memoryStore()
    const reports = await canonicalizeAcquiredActivity(service(store), { accountId: 'previous-owner', deviceScopeId: DEVICE },
      { firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' }, [t24('4321'), t25()])
    expect(reports).toHaveLength(2)
    expect(reports.every((report) => report.status === 'SKIPPED'
      && report.reason === 'Activity source-journal owner does not match the authenticated owner.')).toBe(true)
    expect(writes).toEqual([])
  })

  it('durably retains both raw conflict payloads and integrity-withheld reasons across restart', async () => {
    const { store, data } = memoryStore()
    const first = service(store)
    await first.ingest(t25())
    await first.ingest(t25('12 0 0 0 0 0 0 0 0 0', '12', 'env-conflict'))
    const invalid = t25('7 0 0', '7', 'env-invalid')
    await service(store).ingest(invalid)
    const saved = JSON.parse(data.get(`${OWNER}:${DEVICE}`)!) as ActivityLedgerState
    const sources = Object.values(saved.sourceRecords)
    expect(sources).toHaveLength(3)
    expect(sources.every((entry) => entry.sourceConflict)).toBe(true)
    expect(sources.map((entry) => entry.source.record.arraySteps)).toEqual([
      '10 0 0 0 0 0 0 0 0 0', '12 0 0 0 0 0 0 0 0 0', '7 0 0',
    ])
    expect(sources.find((entry) => entry.source.sourceEnvelopeId === 'env-invalid')?.withheld)
      .toEqual([expect.objectContaining({ reason: 'ARRAY_LENGTH_NOT_10', detail: expect.stringContaining('arrayLength = 3') })])
    expect(Object.values(saved.rows)).toHaveLength(10)
    expect(Object.values(saved.rows).every((row) => row.sourceConflict)).toBe(true)
  })

  it('persists a wholly withheld source even when no canonical epoch is emitted', async () => {
    const { store, data } = memoryStore()
    const report = await service(store).ingest(t25(undefined, '11'))
    expect(report).toMatchObject({ observations: 0, withheld: { SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP: 1 } })
    const saved = JSON.parse(data.get(`${OWNER}:${DEVICE}`)!) as ActivityLedgerState
    expect(saved.rows).toEqual({})
    expect(Object.values(saved.sourceRecords)).toEqual([expect.objectContaining({
      source: expect.objectContaining({ record: expect.objectContaining({ detailMinterStep: '11' }) }),
      withheld: [expect.objectContaining({ reason: 'SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP' })],
    })])
  })

  it('does not reuse qualified firmware after it is explicitly cleared on a new connection', async () => {
    const { store } = memoryStore()
    const svc = service(store)
    svc.setContext({ firmwareVersion: null })
    const acquired = t25()
    acquired.observations.forEach((observation) => { observation.source.firmwareVersion = null })
    expect(await svc.ingest(acquired)).toMatchObject({ observations: 0, withheld: { POLICY_SCOPE_MISMATCH: 1 } })
  })

  it('captures owner and device scope before concurrent ingests are queued', async () => {
    const { store, data } = memoryStore()
    let owner = OWNER
    const svc = new JCVitalActivityCanonicalization({ owner: () => owner, resolveDeviceId: () => null, store, now: () => NOW })
    svc.setContext({ deviceId: DEVICE })
    const first = svc.ingest(t24('4321'))
    const otherDevice = 'jcvital_device_aaaaaaaa-9a4d-4b6e-8f10-2c3d4e5f6a7b'
    owner = 'owner-2'
    svc.setContext({ deviceId: otherDevice })
    const second = svc.ingest(t25())
    await Promise.all([first, second])
    expect([...data.keys()]).toEqual([`${OWNER}:${DEVICE}`, `owner-2:${otherDevice}`])
    const original = JSON.parse(data.get(`${OWNER}:${DEVICE}`)!) as ActivityLedgerState
    expect(Object.values(original.rows).every((row) => row.observation.provenance.deviceScopeId === DEVICE)).toBe(true)
  })

  it('keeps one grouped acquisition in its captured account/device scope even if the UI switches during persistence', async () => {
    const { store, data } = memoryStore()
    let owner = OWNER
    const svc = new JCVitalActivityCanonicalization({ owner: () => owner, resolveDeviceId: () => null, store, now: () => NOW })
    svc.setContext({ deviceId: DEVICE })
    const write = store.write
    vi.spyOn(store, 'write').mockImplementation(async (key, state) => {
      await write(key, state)
      owner = 'owner-2'
      svc.setContext({ deviceId: 'jcvital_device_aaaaaaaa-9a4d-4b6e-8f10-2c3d4e5f6a7b' })
    })
    const reports = await svc.ingestAll([t24('4321'), t25()], OWNER)
    expect(reports.every((report) => report.status === 'CANONICALIZED')).toBe(true)
    expect([...data.keys()]).toEqual([`${OWNER}:${DEVICE}`])
    const saved = JSON.parse(data.get(`${OWNER}:${DEVICE}`)!) as ActivityLedgerState
    expect(Object.values(saved.rows)).toHaveLength(14)
  })

  it('surfaces storage failures explicitly and permits a subsequent retry', async () => {
    const { store } = memoryStore()
    const write = vi.spyOn(store, 'write').mockRejectedValueOnce(new Error('ledger disk unavailable'))
    const svc = service(store)
    expect(await svc.ingest(t25())).toMatchObject({ status: 'FAILED', reason: 'ledger disk unavailable' })
    expect(svc.getSnapshot().lastError).toBe('ledger disk unavailable')
    expect(await svc.ingest(t25())).toMatchObject({ status: 'CANONICALIZED', outcomes: { CREATED: 10 } })
    expect(write).toHaveBeenCalledTimes(2)
    expect(svc.getSnapshot().lastError).toBeNull()
  })

  it('reports incomplete native sync results without throwing into the acquisition workflow', async () => {
    const { store, writes } = memoryStore()
    const acquired = t25()
    Reflect.deleteProperty(acquired, 'observations')
    const svc = service(store)
    await expect(svc.ingest(acquired)).resolves.toMatchObject({
      status: 'FAILED', reason: 'Activity sync result is missing its native observations array.',
    })
    expect(svc.getSnapshot().lastError).toBe('Activity sync result is missing its native observations array.')
    expect(writes).toEqual([])
  })

  it('uses the real IndexedDB store to survive service recreation with raw evidence and no duplicate epochs', async () => {
    vi.stubGlobal('indexedDB', indexedDB)
    try {
      const owner = 'indexeddb-owner'
      await service(indexedDbActivityLedgerStore, owner).ingestAll([t24('4321'), t25()])
      const restarted = service(indexedDbActivityLedgerStore, owner)
      expect(await restarted.ingest(t25())).toMatchObject({ outcomes: { DUPLICATE: 10 } })
      const saved = await indexedDbActivityLedgerStore.read(`${owner}:${DEVICE}`)
      expect(Object.values(saved!.rows)).toHaveLength(14)
      expect(Object.values(saved!.sourceRecords)).toHaveLength(2)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
