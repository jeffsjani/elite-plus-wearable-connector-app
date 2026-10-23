import { describe, expect, it, vi } from 'vitest'
import { PpiCertification, selectPpiCertificationSlots } from './PpiCertification'
import { PpiCertificationAttempt, ppiAttemptKey, type PpiAttemptRecord } from './PpiCertificationAttempt'
import { fixture, slots } from './PpiCertification.fixture'
import type { SourceJournalPage } from './jcvitalV8Bridge'
import * as physiology from './PhysiologyContract'
import { copyPpiCertificationJson } from './PpiCertificationJson'
import { sha256Hex } from './HeartRateSeries'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'

async function diagnosticFixture(values?: Array<number | null | string>) {
  const f = await fixture(values)
  let last: PpiAttemptRecord | null = null
  const attempt = new PpiCertificationAttempt(f.deps.storage, (record) => { last = record })
  const listSourceEnvelopes = vi.fn(async (): Promise<SourceJournalPage> => ({
    modelVersion: 'L0', nextSequence: 3, hasMore: false,
    envelopes: [...f.journalRows.values()].map((entry) => {
      const json = JSON.parse(entry.envelopeJson)
      return { ...entry, kind: json.kind, receivedAt: f.sync.startedAt, timezone: 'UTC',
        callbackId: json.callbackId ?? null, recordIndex: json.recordIndex ?? null }
    }),
  }))
  const service = new PpiCertification({ ...f.deps, attemptJournal: { listSourceEnvelopes },
    attemptEvent: (stage, status, details, error) => attempt.event(stage, status, details, error) })
  async function run() {
    attempt.start(f.context.scope.accountId, f.context.scope.deviceScopeId, { ready: f.context.ready })
    let outcome = 'FAILED'
    try {
      const captured = await service.capture()
      outcome = captured.status
      if (captured.group && captured.status !== 'PPI_CERTIFICATION_EVIDENCE_INVALID') {
        outcome = (await service.flushSaved()).status
      }
    } catch (error) {
      attempt.event('OPERATOR_ACTION', 'FAILED', null, error)
    } finally { attempt.finish(outcome) }
    return last!
  }
  return { ...f, service, attempt, run, listSourceEnvelopes, last: () => last! }
}

function event(record: PpiAttemptRecord, stage: string, status?: string) {
  const found = record.events.find((item) => item.stage === stage && (!status || item.status === status))
  expect(found, `${stage} ${status ?? ''}`).toBeDefined()
  return found!
}

describe('VC13 PPI attempt persistence and exact stage diagnostics', () => {
  it('persists every successful stage and exact counts/IDs independently of certification snapshot', async () => {
    const f = await diagnosticFixture()
    const record = await f.run()
    expect(record.outcome).toBe('PPI_CERTIFICATION_SUCCESS')
    expect(record.certificationSuccess).toBe(false)
    expect(record.diagnosticPersistence).toEqual({ saved: true, readBack: true, error: null })
    expect(record.storageKey).toBe(ppiAttemptKey('user-1', f.context.scope.deviceScopeId))
    for (const stage of ['BUTTON_INVOKED', 'PHYSICAL_READY', 'SYNC_HISTORICAL_PPI',
      'HISTORY_REQUEST_COMPLETED', 'SDK_RECORD_READ', 'ANCESTRY_VERIFICATION', 'RAW_NOTIFICATION_INTEGRITY',
      'SOURCE_ARRAYS', 'SLOT_ALIGNMENT', 'MAPPING_RESULT', 'SELECTED_INDEXES', 'SELECTED_SOURCE_GROUP',
      'ENQUEUE_RESULT', 'TARGETED_FLUSH_RESULT', 'BASE44_RESULTS', 'SNAPSHOT_SERIALIZATION',
      'LOCAL_STORAGE_SAVE', 'POST_SAVE_READ_BACK']) event(record, stage)
    expect(event(record, 'TYPE_127_JOURNAL_COUNTS').details).toMatchObject({ callbackCount: 1, sdkRecordCount: 1 })
    expect(event(record, 'SELECTED_INDEXES').details).toMatchObject({ indexes: [0, 1, 2, 3, 6] })
    expect(event(record, 'SELECTED_SOURCE_GROUP').details).toMatchObject({
      sourceEnvelopeId: 'record-1', observationIds: f.service.snapshot()!.children.map((child) => child.observationId),
    })
    expect(f.acquire).toHaveBeenCalledTimes(1)
    const restarted = new PpiCertificationAttempt(f.deps.storage)
    expect(restarted.read('user-1', f.context.scope.deviceScopeId)).toEqual(record)
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })

  it('records no data and zero journal callbacks/SDK_RECORDs without reacquiring', async () => {
    const f = await diagnosticFixture()
    f.sync.observations = []
    f.sync.recordsReceived = 0
    f.journalRows.clear()
    const record = await f.run()
    event(record, 'CANDIDATE_GROUPS', 'FAILED')
    expect(event(record, 'TYPE_127_JOURNAL_COUNTS').details).toMatchObject({ callbackCount: 0, sdkRecordCount: 0 })
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.attempt.read('user-1', f.context.scope.deviceScopeId)).toEqual(record)
    expect(f.service.hasSavedEvidence()).toBe(false)
  })

  it('reports multiple candidates without changing the existing first-valid selection', async () => {
    const f = await diagnosticFixture()
    f.sync.observations.push(f.addGroup('record-2').native)
    const record = await f.run()
    expect(event(record, 'CANDIDATE_GROUPS').details).toMatchObject({ count: 2, multipleCandidateGroups: true })
    expect(event(record, 'TYPE_127_JOURNAL_COUNTS').details).toMatchObject({ callbackCount: 2, sdkRecordCount: 2 })
    expect(event(record, 'SELECTED_SOURCE_GROUP').details).toMatchObject({ sourceEnvelopeId: 'record-1' })
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })

  it('records physical-not-READY without invoking acquisition', async () => {
    const f = await diagnosticFixture()
    f.context.ready = false
    const record = await f.run()
    expect(event(record, 'PHYSICAL_READY', 'FAILED').error?.message).toContain('ready physical')
    expect(f.acquire).not.toHaveBeenCalled()
  })

  it('preserves the exact history-request error code and exception', async () => {
    const f = await diagnosticFixture()
    f.acquire.mockRejectedValue({ code: 'PPI_TIMEOUT', message: 'History request timed out' })
    const record = await f.run()
    expect(event(record, 'SYNC_HISTORICAL_PPI', 'FAILED').error).toMatchObject({
      code: 'PPI_TIMEOUT', message: 'History request timed out',
    })
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })

  it('retains journal enumeration failures as unknown counts, never fabricated zero', async () => {
    const f = await diagnosticFixture()
    f.listSourceEnvelopes.mockRejectedValue({ code: 'JOURNAL_FAILED', message: 'Cannot list journal' })
    const record = await f.run()
    expect(event(record, 'TYPE_127_JOURNAL_COUNTS', 'FAILED').details).toMatchObject({ callbackCount: null, sdkRecordCount: null })
    expect(event(record, 'TYPE_127_JOURNAL_COUNTS', 'FAILED').error?.code).toBe('JOURNAL_FAILED')
    expect(record.outcome).toBe('PPI_CERTIFICATION_SUCCESS')
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })

  it('records callback snapshot mismatch as ancestry failure', async () => {
    const f = await diagnosticFixture()
    const entry = f.journalRows.get('record-1-callback')!
    const json = JSON.parse(entry.envelopeJson)
    json.recordEnvelopeIds = ['wrong-record']
    entry.envelopeJson = JSON.stringify(json)
    const record = await f.run()
    expect(event(record, 'ANCESTRY_VERIFICATION', 'FAILED').error?.message).toContain('durable callback link')
  })

  it('records source metadata alignment failure', async () => {
    const f = await diagnosticFixture()
    f.sync.observations[0].packetId = 'wrong-serial'
    const record = await f.run()
    event(record, 'SOURCE_METADATA_ALIGNMENT', 'FAILED')
  })

  it.each(['SDK_RECORD_READ', 'CALLBACK_ANCESTRY', 'NOTIFICATION_ANCESTRY'])('records %s journal failures exactly', async (stage) => {
    const f = await diagnosticFixture()
    const id = stage === 'SDK_RECORD_READ' ? 'record-1'
      : stage === 'CALLBACK_ANCESTRY' ? 'record-1-callback' : 'record-1-ble'
    const originalRead = f.readSourceEnvelope.getMockImplementation()!
    f.readSourceEnvelope.mockImplementation(async (options) => {
      if (options.envelopeId === id) throw { code: 'ENVELOPE_NOT_FOUND', message: `Missing ${id}` }
      return originalRead(options)
    })
    const record = await f.run()
    expect(event(record, stage, 'FAILED').error).toMatchObject({ code: 'ENVELOPE_NOT_FOUND', message: `Missing ${id}` })
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.service.hasSavedEvidence()).toBe(false)
  })

  it.each(['sha256', 'byteLength'])('distinguishes raw notification %s mismatch', async (field) => {
    const f = await diagnosticFixture()
    const entry = f.journalRows.get('record-1-ble')!
    const json = JSON.parse(entry.envelopeJson)
    json[field] = field === 'sha256' ? 'bad-hash' : 999
    entry.envelopeJson = JSON.stringify(json)
    const record = await f.run()
    expect(event(record, 'RAW_NOTIFICATION_INTEGRITY', 'FAILED').details)
      .toMatchObject({ sourceEnvelopeId: 'record-1', actualLength: 4 })
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })

  it('identifies sourceArrays slot-count mismatch', async () => {
    const f = await diagnosticFixture()
    const entry = f.journalRows.get('record-1')!
    const json = JSON.parse(entry.envelopeJson)
    json.sourceArrays[0].sourceLength = 6
    entry.envelopeJson = JSON.stringify(json)
    const record = await f.run()
    expect(event(record, 'SOURCE_ARRAYS', 'FAILED').error?.message).toContain('array annotation differs')
  })

  it.each([[11, null, 22], [11, 'bad', 22]])('identifies malformed/null slot compaction for %j', async (...values) => {
    const f = await diagnosticFixture(values)
    const record = await f.run()
    expect(event(record, 'SLOT_ALIGNMENT', 'FAILED').details).toMatchObject({ sourceSlotCount: 3, normalizedValuesSlotCount: 2 })
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.service.hasSavedEvidence()).toBe(false)
  })

  it('distinguishes normalized slot-count mismatch', async () => {
    const f = await diagnosticFixture()
    f.sync.observations[0].values = [11, 0]
    const record = await f.run()
    event(record, 'SLOT_ALIGNMENT', 'FAILED')
  })

  it('records mapping exceptions without changing the mapper', async () => {
    const f = await diagnosticFixture()
    const mock = vi.spyOn(physiology, 'mapPhysiologyObservation').mockRejectedValue(new Error('Mapping fixture failure'))
    try {
      const record = await f.run()
      expect(event(record, 'MAPPING', 'FAILED').error?.message).toBe('Mapping fixture failure')
    } finally { mock.mockRestore() }
  })

  it.each(['MAPPING_SOURCE_ALIGNMENT', 'CHILD_CONTRACT'])('records %s without changing the mapper', async (stage) => {
    const f = await diagnosticFixture()
    const original = physiology.mapPhysiologyObservation
    const mock = vi.spyOn(physiology, 'mapPhysiologyObservation').mockImplementation(async (...args) => {
      const result = await original(...args)
      for (const item of result) if (item.status === 'MAPPED') {
        if (stage === 'MAPPING_SOURCE_ALIGNMENT') item.sourceEnvelopeId = 'wrong-envelope'
        else item.observation.sequenceNumber = 99
      }
      return result
    })
    try { event(await f.run(), stage, 'FAILED') } finally { mock.mockRestore() }
  })

  it('records enqueue omitted-child validation separately from successful queue invocation', async () => {
    const f = await diagnosticFixture()
    f.enqueueMany.mockResolvedValue([])
    const record = await f.run()
    event(record, 'ENQUEUE', 'PASSED')
    expect(event(record, 'ENQUEUE_VALIDATION', 'FAILED').details).toHaveProperty('observationId')
  })

  it('retains the exact deterministic selection failure and never treats diagnostics as certification', async () => {
    const f = await diagnosticFixture()
    f.attempt.start('user-1', f.context.scope.deviceScopeId, { ready: true })
    try {
      const invalid = slots([11, 0, 22])
      invalid[1].index = 99
      selectPpiCertificationSlots(invalid)
    } catch (error) { f.attempt.event('DETERMINISTIC_SELECTION', 'FAILED', { indexes: [0, 99, 2] }, error) }
    f.attempt.finish('FAILED')
    expect(event(f.last(), 'DETERMINISTIC_SELECTION', 'FAILED').error?.message).toContain('original index order')
    expect(f.service.hasSavedEvidence()).toBe(false)
  })

  it.each(['ENQUEUE', 'TARGETED_FLUSH'])('records %s exceptions and generated IDs', async (stage) => {
    const f = await diagnosticFixture()
    if (stage === 'ENQUEUE') f.enqueueMany.mockRejectedValue({ code: 'SQLITE_FAILED', message: 'Queue unavailable' })
    else f.flush.mockRejectedValue({ code: 'FLUSH_FAILED', message: 'Delivery unavailable' })
    const record = await f.run()
    expect(event(record, stage, 'FAILED').error?.code).toBe(stage === 'ENQUEUE' ? 'SQLITE_FAILED' : 'FLUSH_FAILED')
    expect(event(record, 'SELECTED_SOURCE_GROUP').details).toHaveProperty('observationIds')
    expect(f.acquire).toHaveBeenCalledTimes(1)
  })

  it.each(['BASE44_REJECTION', 'ACCEPTED_WITHOUT_NATIVE_OBSERVATION_ID', 'CANONICALIZED_RESPONSE'])('identifies %s and retains exact backend response', async (stage) => {
    const f = await diagnosticFixture()
    f.setResults((ids) => ids.map((observationId) => ({
      observationId, status: stage === 'BASE44_REJECTION' ? 'rejected' : 'accepted',
      canonicalStatus: stage === 'CANONICALIZED_RESPONSE' ? 'canonicalized' : 'not_applicable',
      nativeObservationId: stage === 'ACCEPTED_WITHOUT_NATIVE_OBSERVATION_ID' ? null : 'backend-native',
      errorCode: stage === 'BASE44_REJECTION' ? 'REJECTED_PPI' : null,
      reason: stage === 'BASE44_REJECTION' ? 'Backend rejected sample' : null,
    })))
    const record = await f.run()
    event(record, stage, 'FAILED')
    expect(record.outcome).not.toBe('PPI_CERTIFICATION_SUCCESS')
    expect(event(record, 'BASE44_RESULTS').details).toHaveProperty('results')
  })

  it('records snapshot serialization failure while persisting the failed attempt', async () => {
    const f = await diagnosticFixture()
    const stringify = JSON.stringify
    const mock = vi.spyOn(JSON, 'stringify').mockImplementation((value, ...rest) => {
      if (value?.version === 1 && Array.isArray(value.children)) throw new Error('Snapshot serialization failed')
      return stringify(value, ...rest)
    })
    try {
      const record = await f.run()
      expect(event(record, 'SNAPSHOT_SERIALIZATION', 'FAILED').error?.message).toBe('Snapshot serialization failed')
      expect(record.diagnosticPersistence.readBack).toBe(true)
    } finally { mock.mockRestore() }
  })

  it('persists failed-attempt diagnostic when certification snapshot setItem fails', async () => {
    const f = await diagnosticFixture()
    const set = f.deps.storage().setItem
    const mock = vi.spyOn(f.deps.storage(), 'setItem').mockImplementation((key, text) => {
      if (key.startsWith('elitePlus.ppiCertification.v1.')) throw new DOMException('Storage quota exceeded', 'QuotaExceededError')
      set(key, text)
    })
    try {
      const record = await f.run()
      expect(event(record, 'LOCAL_STORAGE_SAVE', 'FAILED').error).toMatchObject({
        name: 'QuotaExceededError', message: 'Storage quota exceeded',
      })
      expect(record.diagnosticPersistence.readBack).toBe(true)
      expect(f.attempt.read('user-1', f.context.scope.deviceScopeId)).toEqual(record)
    } finally { mock.mockRestore() }
  })

  it('identifies post-save lookup/key mismatch without changing save semantics', async () => {
    const f = await diagnosticFixture()
    const set = f.deps.storage().setItem
    const mock = vi.spyOn(f.deps.storage(), 'setItem').mockImplementation((key, text) => {
      set(key.startsWith('elitePlus.ppiCertification.v1.') ? `${key}.wrong` : key, text)
    })
    try {
      const record = await f.run()
      expect(event(record, 'POST_SAVE_READ_BACK', 'FAILED').error?.message).toBe('SNAPSHOT_POST_SAVE_LOOKUP_OR_KEY_MISMATCH')
      expect(record.diagnosticPersistence.readBack).toBe(true)
      expect(f.service.hasSavedEvidence()).toBe(true)
      expect(f.service.snapshot()).toBeNull()
      expect(record.outcome).not.toBe('PPI_CERTIFICATION_SUCCESS')
    } finally { mock.mockRestore() }
  })

  it('surfaces diagnostic storage failure in memory when all localStorage writes fail', async () => {
    const f = await diagnosticFixture()
    const mock = vi.spyOn(f.deps.storage(), 'setItem').mockImplementation(() => { throw new Error('Storage disabled') })
    try {
      const record = await f.run()
      expect(record.diagnosticPersistence).toMatchObject({ saved: false, readBack: false, error: 'Storage disabled',
        failureStage: 'DIAGNOSTIC_SAVE', exception: { message: 'Storage disabled' } })
      event(record, 'LOCAL_STORAGE_SAVE', 'FAILED')
    } finally { mock.mockRestore() }
  })

  it('fails clearly for missing or wrong-owner saved diagnostics', async () => {
    const f = await diagnosticFixture()
    expect(() => f.attempt.read('user-1', f.context.scope.deviceScopeId)).toThrow('NO_PPI_CERTIFICATION_ATTEMPT_AVAILABLE')
    await f.run()
    const key = ppiAttemptKey('user-1', f.context.scope.deviceScopeId)
    const text = f.storageRows.get(key)!
    f.storageRows.set(key, text.replace('"accountId":"user-1"', '"accountId":"wrong-owner"'))
    expect(() => f.attempt.read('user-1', f.context.scope.deviceScopeId)).toThrow('PPI_ATTEMPT_SCOPE_OR_KEY_MISMATCH')
  })

  it('explicitly reports diagnostic read-back mismatch and missing scope in memory', async () => {
    const f = await diagnosticFixture()
    const mock = vi.spyOn(f.deps.storage(), 'getItem').mockReturnValue(null)
    try {
      f.attempt.start('user-1', f.context.scope.deviceScopeId, { ready: true })
      expect(f.last().diagnosticPersistence).toMatchObject({
        saved: true, readBack: false, failureStage: 'DIAGNOSTIC_READ_BACK', error: 'ATTEMPT_READ_BACK_MISMATCH',
      })
    } finally { mock.mockRestore() }
    f.attempt.start(null, null, { ready: false })
    expect(f.last().diagnosticPersistence).toMatchObject({ saved: false, failureStage: 'DIAGNOSTIC_SCOPE' })
  })

  it('keeps the existing saved-group acquisition guard and does not overwrite the snapshot with diagnostics', async () => {
    const f = await diagnosticFixture()
    await f.run()
    const saved = f.service.snapshot()!
    const record = await f.run()
    event(record, 'ACQUISITION_SKIPPED')
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.service.snapshot()!.certificationGroupId).toBe(saved.certificationGroupId)
  })

  it('reads and copies failed diagnostics after restart without acquisition, enqueue, delivery or Base44', async () => {
    const f = await diagnosticFixture()
    f.sync.observations = []
    const record = await f.run()
    f.acquire.mockClear()
    f.enqueueMany.mockClear()
    f.flush.mockClear()
    f.readSourceEnvelope.mockClear()
    const backend = vi.spyOn(connectorObservationService, 'submitObservations')
    try {
      const restored = new PpiCertificationAttempt(f.deps.storage).read('user-1', f.context.scope.deviceScopeId)
      expect(restored).toEqual(record)
      const json = JSON.stringify(restored, null, 2)
      const evidence = { json, characterCount: json.length, sha256: await sha256Hex(json) }
      const clipboard = { writeText: vi.fn().mockRejectedValue(new Error('Clipboard denied')) }
      expect(await copyPpiCertificationJson(evidence, clipboard)).toContain('COPY FAILED')
      expect(clipboard.writeText).toHaveBeenCalledWith(json)
      expect(evidence.json).toBe(json)
      expect(f.acquire).not.toHaveBeenCalled()
      expect(f.enqueueMany).not.toHaveBeenCalled()
      expect(f.flush).not.toHaveBeenCalled()
      expect(f.readSourceEnvelope).not.toHaveBeenCalled()
      expect(backend).not.toHaveBeenCalled()
    } finally { backend.mockRestore() }
  })
})
