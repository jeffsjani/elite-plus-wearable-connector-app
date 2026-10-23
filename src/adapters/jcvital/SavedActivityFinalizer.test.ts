import { IDBFactory } from 'fake-indexeddb'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { JCVitalV8Plugin, JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import { newPhysicalResult, type FailureResult } from './PhysicalSemanticEvidence'
import { finalizeSavedActivity, rehydrateSavedActivity, SAVED_ACTIVITY_ATTEMPT } from './SavedActivityFinalizer'
import { persistSavedActivityFinalization, readSavedActivityFinalization } from './SavedActivityResultStore'
import { executePhysicalAttempt } from './PhysicalSemanticController'

const scope = { accountId: 'owner', deviceScopeId: 'device' }
type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
function typed(value: unknown): unknown {
  if (value === null) return null
  if (Array.isArray(value)) return { type: 'int[]', values: value.map(typed) }
  if (typeof value === 'object') return {
    type: 'Map', entries: Object.entries(value).map(([key, item]) => ({ key: typed(key), value: typed(item) })),
  }
  return { type: typeof value === 'string' ? 'String' : 'Integer', value: String(value) }
}

async function fixture(full = false) {
  const saved = newPhysicalResult('activity', {
    v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true,
    journal_bound: true, device_scope_resolved: true,
  })
  saved.attempt_id = full ? SAVED_ACTIVITY_ATTEMPT : 'saved-scoped-attempt'
  saved.retry_of_attempt_id = '4f79f7cc-54fe-4689-939e-c8a0063dafe2'
  saved.last_completed_stage = 'SOURCE_JOURNALED'
  const rows = new Map<string, Entry>()
  const header = { ...scope, sessionId: 'session', provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE',
    acquisitionMode: 'HISTORICAL_SYNC', timezone: 'UTC' }
  function put(id: string, data: Record<string, unknown>, rawBytesBase64: string | null = null) {
    rows.set(id, { envelopeId: id, sequence: rows.size + 1, envelopeJson: JSON.stringify({
      ...header, envelopeId: id, ...data,
    }), rawBytesBase64, sourceFile: null })
  }
  const results: JCVitalV8HistoricalSyncResult[] = []
  const callbacksByType: Record<string, number> = {}
  const recordsByType: Record<string, number> = {}
  for (const type of ['24', '25']) {
    const count = full ? type === '24' ? 16 : 640 : type === '24' ? 1 : 2
    const callbackCount = full ? type === '24' ? 2 : 72 : 1
    const ids = Array.from({ length: count }, (_, i) => `${type}-record-${i}`)
    const callbackIds: string[] = []
    let index = 0
    for (let c = 0; c < callbackCount; c++) {
      const callbackId = `${type}-callback-${c}`
      callbackIds.push(callbackId)
      const raw = Uint8Array.from([type === '24' ? 0x51 : 0x52, c])
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
        .map((b) => b.toString(16).padStart(2, '0')).join('')
      put(`${callbackId}-ble`, { kind: 'BLE_NOTIFICATION', byteLength: raw.length, sha256 },
        btoa(String.fromCharCode(...raw)))
      const size = Math.floor(count / callbackCount) + (c < count % callbackCount ? 1 : 0)
      const group = ids.slice(index, index + size)
      const snapshots = group.map((_, localIndex) => {
        const i = index + localIndex
        const day = full ? type === '24' ? i : Math.floor(i / 40) : 0
        const minute = full ? i % 40 * 10 : i * 10
        const date = `2026.10.${String(day + 1).padStart(2, '0')}`
        return typed(type === '24'
          ? { date, step: full ? '800' : '40', distance: '1.00', calories: '40', exerciseMinutes: '0',
            ExerciseTime: '0000', goal: '0', unknown: [0, 0, 7], rawString: ' 00 ' }
          : { date: `${date} ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}:00`,
            arraySteps: [0, 2, 0, 2, 0, 2, 0, 2, 0, 12], detailMinterStep: '20',
            distance: full ? '0.025' : '0.5', calories: full ? '1' : '20', unknown: 'unchanged' })
      })
      const sdkSnapshot = { type: 'Map', entries: [{ key: typed('dicData'), value: { type: 'List', values: snapshots } }] }
      put(callbackId, { kind: 'SDK_CALLBACK', vendorDataType: type, callbackId,
        notificationEnvelopeId: `${callbackId}-ble`, recordEnvelopeIds: group, sdkSnapshot })
      group.forEach((id, recordIndex) => put(id, {
        kind: 'SDK_RECORD', vendorDataType: type, callbackId, notificationEnvelopeId: `${callbackId}-ble`,
        sourceRecordId: id, sourceRecordGroupId: callbackId, recordIndex, sourceIndex: recordIndex,
        sdkSnapshot: snapshots[recordIndex],
      }))
      index += size
    }
    callbacksByType[type] = callbackCount
    recordsByType[type] = count
    results.push({
      syncId: 'session', deviceId: 'device', provider: 'JCVITAL', sdkCommand: type, vendorDataType: type,
      startedAt: '2026-10-19', completedAt: '2026-10-19', recordsReceived: 0, recordGroupsReceived: count,
      recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: null,
      latestObservation: null, partial: false, completionStatus: 'EMPTY_VALID', packetCount: callbackCount,
      parseErrors: [], observations: [], sourceRecordEnvelopeIds: ids, sourceCallbackEnvelopeIds: callbackIds,
    })
  }
  saved.diagnostics.activity = { acquisitionSessionId: 'session', results }
  saved.native_evidence = {
    kind: 'activity', attemptId: saved.attempt_id, sessionClosed: true, failureStage: null, errorCode: null,
    commands: [], commandsAllowed: true, digitalWellnessBeforeSha256: 'same', digitalWellnessAfterSha256: 'same',
    digitalWellnessUnchanged: true, commandTypes: ['24', '25'],
    sourceEnvelopeIds: [...rows.keys(), ...(full ? Array.from({ length: 74 }, (_, i) => `parse-outcome-${i}`) : [])],
    diagnostics: { recordsByType, callbacksByType },
  }
  const api = {
    readSourceEnvelope: vi.fn(async ({ envelopeId }: { envelopeId: string }) => {
      const entry = rows.get(envelopeId)
      if (!entry) throw new Error('Source envelope missing')
      return entry
    }),
    readPhysicalSemanticTestEvidence: vi.fn(async () => ({ json: JSON.stringify(saved.native_evidence) })),
  }
  const cleanup = vi.fn(() => ({
    isolationReleasedAt: '2026-10-19T18:00:00Z', senderResumedAt: '2026-10-19T18:00:00Z',
    state: { disposition: 'ALREADY_RUNNING_NO_NEW_WORKER' },
  }))
  const persisted: FailureResult[] = []
  const ops = { api, cleanup, assertScope: vi.fn(), persist: vi.fn(async (result: FailureResult) => { persisted.push(structuredClone(result)) }) }
  return { saved, rows, api, ops, persisted }
}

beforeEach(() => { vi.stubGlobal('indexedDB', new IDBFactory()) })

describe('v61 saved finalizer observability and bounded exact-ID reads', () => {
  it('reports every finalizer stage with 16/640 counters, reads only saved IDs in bounded batches, and never enumerates the journal', async () => {
    const f = await fixture(true)
    let inFlight = 0
    let peak = 0
    const listSourceEnvelopes = vi.fn()
    const api = {
      ...f.api, listSourceEnvelopes,
      readSourceEnvelope: vi.fn(async (options: { envelopeId: string }) => {
        inFlight++; peak = Math.max(peak, inFlight)
        await Promise.resolve()
        try { return await f.api.readSourceEnvelope(options) } finally { inFlight-- }
      }),
    }
    const events: Array<Record<string, unknown>> = []
    const result = await finalizeSavedActivity(f.saved, scope, { ...f.ops, api, onProgress: (p) => { events.push({ ...p }) } })
    expect(result.status).toBe('COMPLETE')
    expect(events.flatMap((e) => e.stage ? [e.stage] : [])).toEqual([
      'SAVED_ATTEMPT_LOADED', 'SOURCE_REFERENCES_VALIDATED', 'SOURCE_RECORDS_REHYDRATING', 'TYPE24_REHYDRATED',
      'TYPE25_REHYDRATED', 'RECONCILIATION_BUILDING', 'RESULT_BUILT', 'ISOLATION_RELEASED', 'SENDER_RESUMED',
      'RESULT_PERSISTED', 'COMPLETE',
    ])
    const counters = events.filter((e) => e.type25Loaded !== undefined)
    expect(counters.at(-1)).toMatchObject({ type24Loaded: 16, type25Loaded: 640, referencesLoaded: 656, batchesCompleted: 11 })
    expect(events.find((e) => e.stage === 'SOURCE_REFERENCES_VALIDATED'))
      .toMatchObject({ type24Expected: 16, type25Expected: 640, referencesTotal: 656, batchesTotal: 11 })
    expect(events.some((e) => typeof e.pendingRead === 'string' && /Type25 source batch 10\/10/.test(e.pendingRead))).toBe(true)
    expect(listSourceEnvelopes).not.toHaveBeenCalled()
    const allowed = new Set(f.saved.native_evidence!.sourceEnvelopeIds)
    expect(api.readSourceEnvelope.mock.calls.every(([o]) => allowed.has(o.envelopeId))).toBe(true)
    const ids = api.readSourceEnvelope.mock.calls.map(([o]) => o.envelopeId)
    expect(new Set(ids).size).toBe(ids.length)
    expect(peak).toBeGreaterThan(1)
    expect(peak).toBeLessThanOrEqual(64 * 3)
  })

  it('rejects an out-of-range batch size and keeps observability failures from changing the result', async () => {
    const f = await fixture()
    await expect(rehydrateSavedActivity(f.saved, scope, f.api, () => {}, 101)).rejects.toThrow('batch size')
    const result = await finalizeSavedActivity(f.saved, scope, { ...f.ops, onProgress: () => { throw new Error('ui gone') } })
    expect(result.status).toBe('COMPLETE')
  })
})

describe('saved Activity finalization without reacquisition', () => {
  it('terminalizes all 16/640 source records despite EMPTY_VALID and empty observations, with exact original lineage and raw fields', async () => {
    const f = await fixture(true)
    const original = structuredClone(f.saved)
    const result = await finalizeSavedActivity(f.saved, scope, f.ops)
    expect(result.status).toBe('COMPLETE')
    expect(result.stages.map((s) => s.stage)).toEqual(['RESULT_BUILT', 'RESULT_PERSISTED', 'COMPLETE'])
    expect(f.saved).toEqual(original)
    expect(result.native_evidence).toEqual(original.native_evidence)
    expect(result.retry_of_attempt_id).toBe(original.retry_of_attempt_id)
    expect(result.retry_disposition).toBe('RETRY_NOT_ALLOWED')
    expect(result.isolation_released_at).toBeTruthy()
    expect(result.sender_resumed_at).toBeTruthy()
    const output = await rehydrateSavedActivity(f.saved, scope, f.api)
    expect(output.sourceCounts).toEqual({ '24': 16, '25': 640 })
    expect(output.reconciliation.overlappingDays).toHaveLength(16)
    expect(output.reconciliation.days).toHaveLength(16)
    for (const day of output.reconciliation.days) {
      expect(day.type24Steps).toBe(800)
      expect(day.summedType25Steps).toBe(800)
      expect(day.absoluteStepDifference).toBe(0)
      expect(day.percentageStepDifference).toBe(0)
      expect(day.distanceDifference).toBe('0')
      expect(day.calorieDifference).toBe('0')
    }
    expect(output.reconciliation.records[0].fields.unknown).toEqual(['0', '0', '7'])
    expect(output.reconciliation.records[0].fields.rawString).toBe(' 00 ')
    expect(output.originalAcquisition.results.every((r) => r.completionStatus === 'EMPTY_VALID' && r.observations.length === 0)).toBe(true)
    expect(output.readinessEligible).toBe(false)
    expect(output.physicalTestEnqueue + output.physicalTestBase44Calls + output.physicalTestAckMutations + output.bleCommands).toBe(0)
    expect(f.ops.cleanup).toHaveBeenCalledOnce()
    expect(f.persisted.at(-1)?.status).toBe('COMPLETE')
    expect(Object.keys(f.api).sort()).toEqual(['readPhysicalSemanticTestEvidence', 'readSourceEnvelope'])
  })

  it.each(['owner', 'device', 'session', 'callback', 'hash', 'snapshot', 'uniqueness', 'count', 'lineage', 'typeRefs', 'callbackCount', 'wellness'])(
    'fails closed on %s corruption and always cleans up/persists failure', async (corruption) => {
      const f = await fixture()
      const id = '24-record-0'
      const entry = f.rows.get(id)!
      const record = JSON.parse(entry.envelopeJson)
      if (corruption === 'owner') record.accountId = 'other'
      if (corruption === 'device') record.deviceScopeId = 'other'
      if (corruption === 'session') record.sessionId = 'other'
      if (corruption === 'callback') record.callbackId = 'other'
      if (corruption === 'snapshot') record.sdkSnapshot.entries[0].value.value = 'changed'
      if (corruption === 'lineage') f.saved.native_evidence!.attemptId = 'other'
      if (corruption === 'uniqueness') {
        const acquisition = f.saved.diagnostics.activity as { results: JCVitalV8HistoricalSyncResult[] }
        acquisition.results[0].sourceRecordEnvelopeIds!.push(id)
      }
      if (corruption === 'count') f.saved.native_evidence!.diagnostics!.recordsByType = { '24': 0, '25': 2 }
      if (corruption === 'typeRefs') {
        const acquisition = f.saved.diagnostics.activity as { results: JCVitalV8HistoricalSyncResult[] }
        acquisition.results[0].sourceRecordEnvelopeIds = ['25-record-0']
        acquisition.results[1].sourceRecordEnvelopeIds = ['24-record-0', '25-record-1']
      }
      if (corruption === 'callbackCount') {
        const callbackEntry = f.rows.get('24-callback-0')!
        const callback = JSON.parse(callbackEntry.envelopeJson)
        callback.sdkSnapshot.entries[0].value.values.push(record.sdkSnapshot)
        callbackEntry.envelopeJson = JSON.stringify(callback)
      }
      if (corruption === 'wellness') f.saved.native_evidence!.digitalWellnessUnchanged = null
      if (corruption === 'hash') f.rows.get('24-callback-0-ble')!.rawBytesBase64 = 'AAAA'
      entry.envelopeJson = JSON.stringify(record)
      const result = await finalizeSavedActivity(f.saved, scope, f.ops)
      expect(result.status).toBe('FAILED')
      expect(result.stages.some((s) => s.stage === 'COMPLETE')).toBe(false)
      expect(f.ops.cleanup).toHaveBeenCalledOnce()
      expect(f.persisted.at(-1)?.status).toBe('FAILED')
      expect(result.retry_disposition).toBe('RETRY_NOT_ALLOWED')
    })

  it('reads authoritative closed native evidence even when the old outer checkpoint predates close', async () => {
    const f = await fixture()
    const closed = structuredClone(f.saved.native_evidence)
    f.api.readPhysicalSemanticTestEvidence.mockResolvedValue({ json: JSON.stringify(closed) })
    f.saved.native_evidence!.sessionClosed = false
    const result = await finalizeSavedActivity(f.saved, scope, f.ops)
    expect(result.status).toBe('COMPLETE')
    expect(f.saved.native_evidence!.sessionClosed).toBe(false)
    expect(result.native_evidence!.sessionClosed).toBe(true)
  })

  it('deduplicates identical timestamp/fields but does not drop repeated zeros at distinct timestamps', async () => {
    const f = await fixture()
    const original = await rehydrateSavedActivity(f.saved, scope, f.api)
    const sources = original.reconciliation.records
    expect(sources.filter((r) => r.vendorDataType === '25')).toHaveLength(2)
    expect(original.reconciliation.days[0].summedType25Steps).toBe(40)
    const first = f.rows.get('25-record-0')!
    const second = f.rows.get('25-record-1')!
    const a = JSON.parse(first.envelopeJson)
    const b = JSON.parse(second.envelopeJson)
    b.sdkSnapshot = a.sdkSnapshot
    second.envelopeJson = JSON.stringify(b)
    const callback = f.rows.get('25-callback-0')!
    const c = JSON.parse(callback.envelopeJson)
    c.sdkSnapshot.entries[0].value.values[1] = a.sdkSnapshot
    callback.envelopeJson = JSON.stringify(c)
    const output = await rehydrateSavedActivity(f.saved, scope, f.api)
    expect(output.reconciliation.days[0].excludedExactRepeats).toBe(1)
    expect(output.reconciliation.days[0].summedType25Steps).toBe(20)
    expect(output.reconciliation.days[0].hypotheses.overlappingIntervals.ruledOut).toBe(false)
  })

  it('suppresses sums for conflicting same-start intervals, without guessing which record to keep', async () => {
    const f = await fixture()
    const first = JSON.parse(f.rows.get('25-record-0')!.envelopeJson)
    const secondEntry = f.rows.get('25-record-1')!
    const second = JSON.parse(secondEntry.envelopeJson)
    second.sdkSnapshot.entries[0] = first.sdkSnapshot.entries[0]
    second.sdkSnapshot.entries.find((entry: { key: { value: string } }) => entry.key.value === 'distance').value.value = '999'
    secondEntry.envelopeJson = JSON.stringify(second)
    const callbackEntry = f.rows.get('25-callback-0')!
    const callback = JSON.parse(callbackEntry.envelopeJson)
    callback.sdkSnapshot.entries[0].value.values[1] = second.sdkSnapshot
    callbackEntry.envelopeJson = JSON.stringify(callback)
    const output = await rehydrateSavedActivity(f.saved, scope, f.api)
    const day = output.reconciliation.days[0]
    expect(day.conflictingStarts).toBe(true)
    expect(day.summedType25Steps).toBeNull()
    expect(day.aggregatedType25DistanceRaw).toBeNull()
    expect(day.excludedExactRepeats).toBe(0)
  })

  it('compares raw decimal values exactly without binary floating-point residue or assumed vendor units', async () => {
    const f = await fixture()
    for (const [id, value] of [['24-record-0', '0.3'], ['25-record-0', '0.1'], ['25-record-1', '0.2']]) {
      const entry = f.rows.get(id)!
      const record = JSON.parse(entry.envelopeJson)
      record.sdkSnapshot.entries.find((entry: { key: { value: string } }) => entry.key.value === 'distance').value.value = value
      entry.envelopeJson = JSON.stringify(record)
      const callbackEntry = f.rows.get(record.callbackId)!
      const callback = JSON.parse(callbackEntry.envelopeJson)
      callback.sdkSnapshot.entries[0].value.values[record.recordIndex] = record.sdkSnapshot
      callbackEntry.envelopeJson = JSON.stringify(callback)
    }
    const output = await rehydrateSavedActivity(f.saved, scope, f.api)
    expect(output.reconciliation.days[0].aggregatedType25DistanceRaw).toBe('0.3')
    expect(output.reconciliation.days[0].distanceDifference).toBe('0')
    expect(output.fieldDispositions.DAILY_DISTANCE).toBe('SEMANTICS_STILL_UNPROVEN')
  })

  it('persists failure rather than COMPLETE if terminal persistence fails', async () => {
    const f = await fixture()
    f.ops.persist.mockRejectedValueOnce(new Error('disk full'))
    const result = await finalizeSavedActivity(f.saved, scope, f.ops)
    expect(result.status).toBe('FAILED')
    expect(result.failure_stage).toBe('RESULT_PERSISTENCE')
    expect(f.ops.cleanup).toHaveBeenCalledOnce()
  })

  it('does not retain an uncommitted COMPLETE stage if the second terminal write fails', async () => {
    const f = await fixture()
    f.ops.persist.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('terminal commit failed'))
    const result = await finalizeSavedActivity(f.saved, scope, f.ops)
    expect(result.status).toBe('FAILED')
    expect(result.last_completed_stage).toBe('RESULT_PERSISTED')
    expect(result.stages.some((stage) => stage.stage === 'COMPLETE')).toBe(false)
    expect(f.persisted.at(-1)?.status).toBe('FAILED')
    expect(f.persisted.at(-1)?.stages.some((stage) => stage.stage === 'COMPLETE')).toBe(false)
  })

  it('still persists an explicit failure if cleanup fails after result construction', async () => {
    const f = await fixture()
    f.ops.cleanup.mockImplementation(() => { throw new Error('sender resume failed') })
    const result = await finalizeSavedActivity(f.saved, scope, f.ops)
    expect(result.status).toBe('FAILED')
    expect(result.failure_stage).toBe('CLEANUP')
    expect(result.cleanup_errors).toContain('sender resume failed')
    expect(f.persisted.at(-1)?.status).toBe('FAILED')
  })

  it('retains successful isolation release when sender cleanup reports a partial failure', async () => {
    const f = await fixture()
    const result = await finalizeSavedActivity(f.saved, scope, {
      ...f.ops,
      cleanup: () => ({
        isolationReleasedAt: '2026-10-19T18:00:00Z', senderResumedAt: null,
        state: { disposition: 'SENDER_POLICY_NOT_RUNNING' }, errors: ['Sender not resumed: NOT_STARTED'],
      }),
    })
    expect(result.status).toBe('FAILED')
    expect(result.failure_stage).toBe('CLEANUP')
    expect(result.isolation_released_at).toBe('2026-10-19T18:00:00Z')
    expect(result.sender_resumed_at).toBeNull()
    expect(f.persisted.at(-1)?.cleanup_errors).toContain('Sender not resumed: NOT_STARTED')
  })

  it('persists and restores the full result outside localStorage quota, retaining the immutable original', async () => {
    const f = await fixture()
    const result = await finalizeSavedActivity(f.saved, scope, {
      ...f.ops, persist: (value) => persistSavedActivityFinalization(scope, f.saved, value),
    })
    expect(await readSavedActivityFinalization(scope)).toEqual(result)
    expect(await readSavedActivityFinalization({ ...scope, accountId: 'other' })).toBeNull()
  })

  it('bounds post-native reads so cleanup and terminal persistence cannot hang behind a never-settling final snapshot', async () => {
    vi.useFakeTimers()
    try {
      const f = await fixture()
      const release = vi.fn()
      const resume = vi.fn()
      const operation = executePhysicalAttempt(f.saved, {
        checkpoint: vi.fn(), markAttempt: vi.fn(), quiesce: () => ({ wait: async () => {}, resume }),
        lock: () => release, begin: async () => f.saved.native_evidence!,
        end: async () => f.saved.native_evidence!, readNative: async () => f.saved.native_evidence!,
        preflight: async () => {}, run: async (_, finish) => { await finish(); return {} },
        finalize: () => new Promise(() => {}), persist: vi.fn(), backup: vi.fn(),
      })
      await vi.advanceTimersByTimeAsync(15_001)
      const result = await operation
      expect(result.recovery_errors.join()).toContain('timed out')
      expect(release).toHaveBeenCalledOnce()
      expect(resume).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })
})
