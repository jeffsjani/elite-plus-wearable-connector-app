// @vitest-environment jsdom
import { act } from 'react'
import { IDBFactory } from 'fake-indexeddb'
import { webcrypto } from 'node:crypto'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FailureResult, FailureStage } from './PhysicalSemanticEvidence'
import type { PhysicalSemanticNativeEvidence } from './jcvitalV8Bridge'

const h = vi.hoisted(() => ({
  scenario: '', native: null as PhysicalSemanticNativeEvidence | null,
  calls: [] as string[], attemptId: '', copied: '', saved: '', queueWrites: 0, base44: 0, ack: 7,
  inFlight: 0, nativeReady: true,
}))
vi.mock('../../buildMode', () => ({ IS_ENGINEERING_BUILD: true }))
vi.mock('./CertificationJsonExport', () => ({
  serializeCertificationJson: (value: unknown) => JSON.stringify(value, null, 2),
  saveValidationJson: async (_name: string, json: string) => { h.saved = json; return 'saved' },
}))
vi.mock('../../services/sync/ObservationQueue', () => ({
  observationQueue: {
    getOwnerUserId: () => 'owner',
    getQueueStats: async () => {
      if (h.scenario === 'preflight') throw Object.assign(new Error('queue snapshot unavailable'), { code: 'QUEUE_READ_FAILURE' })
      return { pending: h.scenario === 'quiesce' ? 76992 : 0, retrying: 0, inFlight: h.inFlight, failed: 0, acknowledged: h.ack }
    },
    listDiagnosticRecords: async () => [],
    enqueueMany: async () => { h.queueWrites++; throw new Error('Unexpected enqueue') },
  },
}))
vi.mock('../../services/sync/ObservationBatchManager', () => ({
  observationBatchManager: {
    getPhysicalTestSenderState: () => ({
      started: true, paused: false, pauseReason: null,
      activeRequest: h.inFlight > 0, claimOwner: h.inFlight > 0 ? 'sender' : null, activeWorkers: h.inFlight > 0 ? 1 : 0, startupOperations: 0,
      lastBatchId: 'last-batch', lastSenderError: 'last sender error', lastInflightCompletedAt: null,
    }),
    resumeAfterPhysicalTest: vi.fn(),
    getDeliveryDiagnostics: () => ({
      senderActive: false, activeWorkerCount: 0, senderGeneration: 0, activeBatches: [],
    }),
    process: async () => { h.base44++; throw new Error('Unexpected sender invocation') },
  },
}))
vi.mock('./jcvitalV8Bridge', async (original) => {
  function fail(stage: FailureStage, code: string, message: string): never {
    if (h.native) Object.assign(h.native, { failureStage: stage, errorCode: code, errorMessage: message })
    throw Object.assign(new Error(message), { code })
  }
  return {
    ...await original<typeof import('./jcvitalV8Bridge')>(),
    JCVitalV8: {
      getConnectionState: async () => ({ state: h.nativeReady ? 'READY' : 'DISCONNECTED', deviceId: 'device' }),
      beginPhysicalSemanticTest: async ({ kind, attemptId }: { kind: 'activity' | 'workout'; attemptId: string }) => {
        h.calls.push('begin'); h.attemptId = attemptId
        if (h.scenario === 'bridge') fail('NATIVE_BRIDGE_ENTERED', 'UNIMPLEMENTED', 'native method is not registered')
        if (h.scenario === 'native') fail('NATIVE_SESSION_CREATED', 'COMMAND_FAILED', 'Physical test transport is busy')
        h.native = {
          kind, attemptId, commands: [], commandsAllowed: true,
          digitalWellnessBeforeSha256: 'hash', digitalWellnessAfterSha256: 'hash', digitalWellnessUnchanged: true,
          commandsIssued: 0, callbacksReceived: 0, commandTypes: [], sourceEnvelopeIds: [],
          lastCompletedStage: 'NATIVE_SESSION_CREATED',
        }
        return h.native
      },
      endPhysicalSemanticTest: async () => { h.calls.push('end'); return h.native },
      readPhysicalSemanticTestEvidence: async () => ({ json: h.native ? JSON.stringify(h.native) : null }),
      readActivityCertificationSnapshot: async () => ({ json: null }),
      readWorkoutCertificationSnapshot: async () => ({ json: null }),
      listSourceEnvelopes: async () => ({ envelopes: [], hasMore: false, nextSequence: 0 }),
      syncActivityCertification: async () => {
        h.calls.push('activity')
        if (h.scenario === 'command') fail('COMMAND_WRITTEN', 'COMMAND_WRITE_FAILED', 'Type24 GATT write rejected')
        if (h.native) Object.assign(h.native, {
          commandsIssued: 1, callbacksReceived: h.scenario === 'timeout' ? 0 : 1, commandTypes: ['24'],
          lastCompletedStage: 'COMMAND_WRITTEN',
        })
        if (h.scenario === 'timeout') fail('CALLBACK_COLLECTION', 'CALLBACK_TIMEOUT', 'Type24 terminal callback timed out')
        if (h.scenario === 'journal') fail('SOURCE_JOURNAL_PERSISTENCE', 'JOURNAL_WRITE_FAILED', 'Source journal storage full')
        return {
          results: [{ vendorDataType: '24', completionStatus: 'COMPLETE',
            nativeCommandWritten: true, sourceRecordEnvelopeIds: h.scenario === 'build' ? ['bad-record'] : [] }],
        }
      },
      readSourceEnvelope: async () => ({ envelopeId: 'bad-record', envelopeJson: '{bad JSON' }),
      startWorkoutCapture: async () => {
        h.calls.push('workout')
        fail('COMMAND_WRITTEN', 'WORKOUT_START_REJECTED', 'V8 rejected workout start')
      },
      addListener: async () => ({ remove: async () => {} }),
    },
  }
})

import { V8PhysicalSemanticTests, type PhysicalSemanticEligibility } from './V8PhysicalSemanticTests'
import { beginPhysicalTestIsolation, physicalTestIsolationSnapshot } from '../../services/diagnostics/PhysicalTestIsolation'
import { recoverPhysicalFailure } from './PhysicalSemanticRecovery'
import { JCVitalV8 } from './jcvitalV8Bridge'
import { canSafelyRetryPhysicalAttempt, newPhysicalResult } from './PhysicalSemanticEvidence'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'
import * as jsonExport from './CertificationJsonExport'
import { readSavedActivityFinalization } from './SavedActivityResultStore'

const scope = { accountId: 'owner', deviceScopeId: 'device' }
let root: Root
let container: HTMLDivElement
beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); sessionStorage.clear()
  Object.assign(h, { scenario: '', native: null, calls: [], copied: '', saved: '', queueWrites: 0, base44: 0, ack: 7, inFlight: 0, nativeReady: true })
  vi.mocked(observationBatchManager.resumeAfterPhysicalTest).mockClear()
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { h.copied = text } } })
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals()
})
async function render(screen = 'Companion', ready = true, changes: Partial<PhysicalSemanticEligibility> = {}) {
  await act(async () => root.render(<V8PhysicalSemanticTests key={screen}
    context={{ scope, bleAddress: 'AA', sdkVersion: 'test', firmwareVersion: null, ready, native: true, physical: true }}
    ownerUserId="owner" eligibility={{
      ready, authenticatedOwner: 'owner', connectorOwner: 'owner', journalScope: scope,
      sourceJournalBound: true, connectionBusy: false, physicalTestActive: false,
      productionSyncActive: false, workoutControlAvailable: true, ...changes,
    }} setBusy={() => {}} workoutActive={false} onTestActiveChange={() => {}}
  />))
}
function buttons(kind = 'Activity 24 + 25') {
  return Array.from(container.querySelectorAll<HTMLButtonElement>(`[aria-label="Test ${kind}"] button`))
}
function seedSafeFailure() {
  const result = newPhysicalResult('activity', {
    v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true,
    journal_bound: true, device_scope_resolved: true,
  })
  result.status = 'FAILED'
  result.failure_stage = 'ISOLATION_LOCK_ACQUIRED'
  result.retry_disposition = 'SAFE_TO_RETRY_NO_DEVICE_COMMAND'
  localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify(result))
  localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device:attempted', '1')
  return result
}
function seedSourceOnlyAttempt() {
  const saved = seedSafeFailure()
  saved.attempt_id = 'saved-source-only-attempt'
  saved.retry_of_attempt_id = 'saved-parent-attempt'
  saved.status = 'RUNNING'
  saved.last_completed_stage = 'SOURCE_JOURNALED'
  saved.diagnostics.activity = { acquisitionSessionId: 'saved-session', results: ['24', '25'].map((type) => ({
    vendorDataType: type, completionStatus: 'EMPTY_VALID', observations: [], recordGroupsReceived: 1,
    sourceRecordEnvelopeIds: [type], sourceCallbackEnvelopeIds: [`${type}-cb`],
  })) }
  h.native = {
    kind: 'activity', attemptId: saved.attempt_id, sessionClosed: true, failureStage: null, errorCode: null,
    commands: [], commandsAllowed: true, digitalWellnessBeforeSha256: 'same', digitalWellnessAfterSha256: 'same',
    digitalWellnessUnchanged: true, commandTypes: ['24', '25'],
    sourceEnvelopeIds: ['24', '24-cb', '24-ble', '25', '25-cb', '25-ble'],
    diagnostics: { recordsByType: { '24': 1, '25': 1 }, callbacksByType: { '24': 1, '25': 1 } },
  }
  localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify(saved))
  return { saved }
}
async function assertExports(kind = 'Activity 24 + 25') {
  expect(buttons(kind).slice(1).every((button) => !button.disabled)).toBe(true)
  for (const button of buttons(kind).slice(1)) await act(async () => button.click())
  const copied = JSON.parse(h.copied) as FailureResult
  expect(JSON.parse(h.saved)).toEqual(copied)
  expect(copied.status).toBe('FAILED')
  expect(container.textContent).toContain('acquisition started:')
  expect(container.textContent).toContain('source journal records:')
  return copied
}

describe('actual rendered physical-test failure results', () => {
  it('immediately records and displays a STARTING linked retry before active sender quiescence, retaining prior evidence', async () => {
    vi.useFakeTimers()
    const prior = seedSafeFailure()
    h.inFlight = 100
    const isolation = await import('../../services/diagnostics/PhysicalTestIsolation')
    const requestPause = isolation.requestPhysicalTestSenderPause
    const pause = vi.spyOn(isolation, 'requestPhysicalTestSenderPause').mockImplementation(() => {
      const starting = JSON.parse(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress')!) as FailureResult
      expect(starting.status).toBe('STARTING')
      expect(starting.attempt_id).not.toBe(prior.attempt_id)
      expect(starting.retry_of_attempt_id).toBe(prior.attempt_id)
      return requestPause()
    })
    await render()
    expect(buttons()[0].textContent).toBe('Retry Activity Test')
    expect(buttons()[0].disabled).toBe(false)
    expect(container.textContent).toContain('Prior failed attempt will be preserved.')
    expect(container.textContent).toContain('This creates a new linked attempt.')
    expect(container.textContent).toContain('No new retry attempt recorded.')
    await act(async () => buttons()[0].click())
    expect(pause).toHaveBeenCalledOnce()
    const progress = JSON.parse(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress')!) as FailureResult
    expect(progress.status).toBe('STARTING')
    expect(progress.attempt_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(progress.attempt_id).not.toBe(prior.attempt_id)
    expect(progress.retry_of_attempt_id).toBe(prior.attempt_id)
    expect(progress.last_completed_stage).toBe('SENDER_QUIESCE_REQUESTED')
    expect(progress.diagnostics.senderQuiescence).toMatchObject({ current_inFlight: 100 })
    expect(JSON.parse(localStorage.getItem(`v8PhysicalSemanticTest.v1:activity:owner:device:attempt:${prior.attempt_id}`)!)).toEqual(prior)
    expect(container.textContent).toContain(`Result attempt: ${progress.attempt_id}`)
    expect(container.textContent).toContain(`Retry attempt: ${progress.attempt_id}`)
    expect(container.textContent).toContain(`Previous attempt: ${prior.attempt_id}`)
    expect(container.textContent).toContain('Build: v60')
    expect(container.textContent).not.toContain('Showing previous saved result.')
    expect(h.calls).toEqual([])
    await act(async () => buttons()[2].click())
    expect(JSON.parse(h.copied).attempt_id).toBe(progress.attempt_id)
    h.inFlight = 0
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(container.textContent).toContain('Sender quiesced')
    expect(container.textContent).toContain('Isolation acquired')
    expect(container.textContent).toContain('Starting V8 Activity acquisition…')
  })

  it('v59: one safe-retry state drives copy, Retry Activity Test label, and a linked retry handler', async () => {
    vi.useFakeTimers()
    const prior = seedSafeFailure()
    h.inFlight = 100
    const isolation = await import('../../services/diagnostics/PhysicalTestIsolation')
    const pause = vi.spyOn(isolation, 'requestPhysicalTestSenderPause')
    await render()
    expect(container.textContent).toContain('Safe retry available')
    expect(buttons()[0].textContent).toBe('Retry Activity Test')
    expect(buttons().some((button) => button.textContent === 'Run')).toBe(false)
    expect(container.textContent).toContain(`Retry of: ${prior.attempt_id}`)
    await act(async () => buttons()[0].click())
    expect(buttons()[0].textContent).toBe('Preparing Retry…')
    expect(buttons()[0].disabled).toBe(true)
    expect(pause).toHaveBeenCalledOnce()
    const progress = JSON.parse(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress')!) as FailureResult
    expect(progress.attempt_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(progress.attempt_id).not.toBe(prior.attempt_id)
    expect(progress.retry_of_attempt_id).toBe(prior.attempt_id)
    expect(progress.build).toBe('v60')
    expect(progress.diagnostics.senderQuiescence).toBeTruthy()
    expect(JSON.parse(localStorage.getItem(`v8PhysicalSemanticTest.v1:activity:owner:device:attempt:${prior.attempt_id}`)!)).toEqual(prior)
    expect(buttons().some((button) => button.textContent === 'Run')).toBe(false)
    h.inFlight = 0
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(buttons()[0].textContent).not.toMatch(/Preparing/)
  })

  it('v59: without a saved failure the ordinary Run path is shown and creates an unlinked first attempt', async () => {
    vi.useFakeTimers()
    h.inFlight = 100
    await render()
    expect(buttons()[0].textContent).toBe('Run')
    expect(container.textContent).not.toContain('Retry Activity Test')
    expect(container.textContent).not.toContain('Safe retry available')
    await act(async () => buttons()[0].click())
    expect(buttons()[0].textContent).toBe('Preparing Activity Test…')
    const progress = JSON.parse(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress')!) as FailureResult
    expect(progress.status).toBe('STARTING')
    expect(progress.retry_of_attempt_id).toBeNull()
    h.inFlight = 0
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    await act(async () => { await vi.runAllTimersAsync() })
    expect(buttons()[0].textContent).not.toMatch(/Preparing/)
  })

  it('v59: a SAFE disposition without approved zero-invocation evidence never claims safe retry and names the gap', async () => {
    const prior = seedSafeFailure()
    Object.assign(prior, { native_invocation_started: true, acquisition_started: null })
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify(prior))
    await render()
    expect(buttons()[0].textContent).toBe('Run')
    expect(buttons()[0].disabled).toBe(true)
    expect(container.textContent).not.toContain('Safe retry available')
    expect(container.textContent).not.toContain('Retry Activity Test')
    expect(container.textContent).toContain('native_invocation_started=true')
    expect(container.textContent).toContain('acquisition_started=UNKNOWN')
  })

  it('v59: the retry handler blocks without creating an attempt if persisted evidence no longer matches the displayed failure', async () => {
    const prior = seedSafeFailure()
    await render()
    expect(buttons()[0].textContent).toBe('Retry Activity Test')
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify({ ...prior, attempt_id: 'other-attempt' }))
    await act(async () => buttons()[0].click())
    expect(container.textContent).toContain('BLOCKED — ACTIVITY_RETRY_EVIDENCE_CHANGED')
    expect(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress')).toBeNull()
    expect(h.calls).toEqual([])
  })

  it('disables a saved safe retry when V8 is disconnected', async () => {
    seedSafeFailure()
    await render('Companion', false)
    expect(buttons()[0].textContent).toBe('Retry Activity Test')
    expect(buttons()[0].disabled).toBe(true)
    expect(container.textContent).toContain('BLOCKED — V8_NOT_READY')
    expect(h.calls).toEqual([])
  })

  it('rejects stale rendered READY using the native click-time connection state without creating an attempt', async () => {
    const prior = seedSafeFailure()
    await render()
    h.nativeReady = false
    await act(async () => buttons()[0].click())
    expect(buttons()[0].disabled).toBe(true)
    expect(container.textContent).toContain('BLOCKED — V8_NOT_READY')
    expect(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress')).toBeNull()
    expect(JSON.parse(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device')!).attempt_id).toBe(prior.attempt_id)
    expect(h.calls).toEqual([])
  })

  it.each([
    { authenticatedOwner: null },
    { connectorOwner: 'different-owner' },
    { sourceJournalBound: false },
    { journalScope: { ...scope, deviceScopeId: '' } },
    { ready: false },
  ] satisfies Array<Partial<PhysicalSemanticEligibility>>)('re-evaluates live prerequisites after native click-time read: %j', async (changes) => {
    seedSafeFailure()
    let finishRead: ((value: { state: 'READY'; deviceId: string }) => void) | undefined
    vi.spyOn(JCVitalV8, 'getConnectionState').mockImplementation(() => new Promise((resolve) => { finishRead = resolve }))
    await render()
    await act(async () => buttons()[0].click())
    await render('Companion', true, changes)
    await act(async () => finishRead!({ state: 'READY', deviceId: 'device' }))
    expect(container.textContent).toContain('BLOCKED')
    expect(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress')).toBeNull()
    expect(h.calls).toEqual([])
  })

  it.each(['unavailable', 'rejected', 'blank-readback'])('shows complete selectable fallback JSON when clipboard is %s', async (mode) => {
    seedSafeFailure()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: mode === 'unavailable' ? undefined : {
      writeText: async () => { if (mode === 'rejected') throw new Error('NotAllowedError') },
      readText: async () => '',
    } })
    await render()
    await act(async () => buttons()[2].click())
    const manual = container.querySelector<HTMLTextAreaElement>('[aria-label="Manual full result JSON"]')!
    const shown = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Complete result JSON"]')!
    expect(manual.readOnly).toBe(true)
    expect(manual.value.length).toBeGreaterThan(0)
    expect(manual.value).toBe(shown.value)
    expect(container.textContent).toContain('Copy failed — select JSON manually')
    expect(container.textContent).not.toContain('result JSON copied.')
  })

  it('Show, awaited Copy/read-back and Save use exactly the same nonempty JSON and show its SHA-256', async () => {
    seedSafeFailure()
    let finishWrite: (() => void) | undefined
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: (text: string) => new Promise<void>((resolve) => { h.copied = text; finishWrite = resolve }),
      readText: async () => h.copied,
    } })
    await render()
    await act(async () => buttons()[1].click())
    const json = container.querySelector<HTMLTextAreaElement>('textarea[aria-label="Complete result JSON"]')!.value
    expect(container.textContent).toContain(`JSON characters: ${json.length}`)
    let hash = ''
    await act(async () => {
      const { createHash } = await import('node:crypto')
      hash = createHash('sha256').update(json).digest('hex')
    })
    expect(container.textContent).toContain(`JSON SHA-256: ${hash}`)
    await act(async () => buttons()[2].click())
    expect(container.textContent).not.toContain('result JSON copied.')
    await act(async () => finishWrite!())
    expect(container.textContent).toContain('exact read-back verified')
    expect(h.copied).toBe(json)
    await act(async () => buttons()[3].click())
    expect(h.saved).toBe(json)
  })

  it('renders RESULT_JSON_EMPTY and never writes blank clipboard or file content', async () => {
    seedSafeFailure()
    vi.spyOn(jsonExport, 'serializeCertificationJson').mockReturnValue('')
    const write = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    await render()
    await act(async () => buttons()[1].click())
    expect(container.textContent).toContain('JSON characters: 0')
    expect(container.textContent).toContain('RESULT_JSON_EMPTY')
    await act(async () => buttons()[2].click())
    expect(write).not.toHaveBeenCalled()
    expect(container.textContent).toContain('RESULT_JSON_EMPTY')
    await act(async () => buttons()[3].click())
    expect(h.saved).toBe('')
    expect(container.textContent).toContain('RESULT_JSON_EMPTY')
  })

  it('shows preparation as progress, waits for 100 in-flight rows, then captures a post-drain isolation baseline', async () => {
    h.scenario = 'quiesce'; h.inFlight = 100
    await render()
    await act(async () => buttons()[0].click())
    expect(container.textContent).toContain('Preparing isolated Activity test')
    expect(container.textContent).toContain('Waiting for active upload to finish…')
    expect(container.textContent).toContain('Current in-flight rows: 100')
    expect(container.textContent).not.toContain('FAILED')
    expect(h.calls).toEqual([])
    h.inFlight = 0
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 80)) })
    const result = JSON.parse(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device')!) as FailureResult
    expect(h.calls).toEqual(['begin', 'activity', 'end'])
    expect(result.diagnostics.senderQuiescence).toMatchObject({
      queue_before_quiesce: { pending: 76992, inFlight: 100 }, inFlight_before: 100,
      senderQuiesced: true, queue_at_test_start: { pending: 76992, inFlight: 0 },
      sender_resumed_at: expect.any(String), isolation_released_at: expect.any(String),
    })
    expect(result.queue_before).toMatchObject({ pending: 76992, inFlight: 0 })
    expect(result.queue_delta).toBe(0)
    expect(result.ack_mutations).toBe(0)
    expect(observationBatchManager.resumeAfterPhysicalTest).toHaveBeenCalledTimes(1)
  })

  it('exports SENDER_QUIESCE_TIMEOUT with live batch diagnostics and no native invocation, then resumes the sender', async () => {
    vi.useFakeTimers()
    h.scenario = 'quiesce'; h.inFlight = 100
    await render()
    await act(async () => {
      buttons()[0].click()
      await vi.advanceTimersByTimeAsync(60_000)
    })
    const result = await assertExports()
    expect(result.error_code).toBe('SENDER_QUIESCE_TIMEOUT')
    expect(result.failure_stage).toBe('SENDER_QUIESCE_REQUESTED')
    expect(result.diagnostics.senderQuiescence).toMatchObject({
      current_inFlight: 100, last_batch_id: 'last-batch', last_sender_error: 'last sender error',
      senderQuiesced: false, sender_resumed_at: expect.any(String),
    })
    expect(result.native_invocation_started).toBe(false)
    expect(result.acquisition_started).toBe(false)
    expect(h.calls).toEqual([])
    expect(h.inFlight).toBe(100)
    expect(observationBatchManager.resumeAfterPhysicalTest).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['preflight', 'SENDER_QUIESCE_REQUESTED', 'QUEUE_READ_FAILURE', 'queue snapshot unavailable'],
    ['bridge', 'NATIVE_BRIDGE_ENTERED', 'UNIMPLEMENTED', 'native method is not registered'],
    ['native', 'NATIVE_SESSION_CREATED', 'COMMAND_FAILED', 'Physical test transport is busy'],
    ['command', 'COMMAND_WRITTEN', 'COMMAND_WRITE_FAILED', 'Type24 GATT write rejected'],
    ['timeout', 'CALLBACK_COLLECTION', 'CALLBACK_TIMEOUT', 'Type24 terminal callback timed out'],
    ['journal', 'SOURCE_JOURNAL_PERSISTENCE', 'JOURNAL_WRITE_FAILED', 'Source journal storage full'],
    ['build', 'RESULT_CONSTRUCTION', 'PHYSICAL_TEST_EXCEPTION', null],
  ])('persists and exports %s failure with stage/code/message; restart and Engineering remount do not retry', async (scenario, stage, code, message) => {
    h.scenario = scenario!
    const before = physicalTestIsolationSnapshot()
    await render()
    await act(async () => buttons()[0].click())
    const result = await assertExports()
    expect(result.failure_stage).toBe(stage)
    expect(result.error_code).toBe(code)
    if (message) expect(result.error_message).toBe(message)
    else expect(result.error_message).toMatch(/JSON|position|property/i)
    expect(JSON.parse(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device')!)).toEqual(result)
    expect(result.base44_calls).toBe(scenario === 'preflight' ? null : 0)
    expect(result.queue_delta).toBe(scenario === 'preflight' ? null : 0)
    expect(h.queueWrites).toBe(0); expect(h.base44).toBe(0); expect(h.ack).toBe(7)
    expect(physicalTestIsolationSnapshot().counts).toEqual(before.counts)
    expect(physicalTestIsolationSnapshot().active).toBe(false)
    const calls = [...h.calls]
    await render('Engineering')
    await assertExports()
    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    await assertExports()
    window.dispatchEvent(new Event('focus')); window.dispatchEvent(new Event('online'))
    expect(h.calls).toEqual(calls)
    expect(buttons()[0].disabled).toBe(!canSafelyRetryPhysicalAttempt(result))
    expect(observationBatchManager.resumeAfterPhysicalTest).toHaveBeenCalledTimes(1)
  })

  it('keeps a result-store failure exportable and exposes the storage error; session backup survives remount', async () => {
    const original = Storage.prototype.setItem
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
      if (this === localStorage && key === 'v8PhysicalSemanticTest.v1:activity:owner:device') {
        throw Object.assign(new Error('result storage quota exceeded'), { code: 'QUOTA_EXCEEDED' })
      }
      return original.call(this, key, value)
    })

    await render()
    await act(async () => buttons()[0].click())
    const result = await assertExports()
    expect(result.failure_stage).toBe('RESULT_PERSISTENCE')
    expect(result.error_code).toBe('QUOTA_EXCEEDED')
    expect(result.persistence_errors).toContain('result storage quota exceeded')
    await render('Engineering')
    await assertExports()
  })

  it('records isolation-lock rejection before any native invocation and preserves the existing lock owner', async () => {
    const release = beginPhysicalTestIsolation()
    try {
      await render()
      await act(async () => buttons()[0].click())
      const result = await assertExports()
      expect(result.failure_stage).toBe('SENDER_QUIESCE_REQUESTED')
      expect(result.native_invocation_started).toBe(false)
      expect(result.ble_commands_issued).toBe(0)
      expect(result.retry_disposition).toBe('SAFE_TO_RETRY_NO_DEVICE_COMMAND')
      expect(physicalTestIsolationSnapshot().active).toBe(true)
      expect(h.calls).toEqual([])
    } finally { release() }
  })

  it('allows only a manual proven-safe Activity retry, preserving and linking the v56 failure across restart without consuming Workout', async () => {
    const previous = newPhysicalResult('activity', {
      v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true,
      journal_bound: true, device_scope_resolved: true,
    })
    previous.status = 'FAILED'
    previous.failure_stage = 'ISOLATION_LOCK_ACQUIRED'
    previous.retry_disposition = 'SAFE_TO_RETRY_NO_DEVICE_COMMAND'
    const original = JSON.stringify(previous)
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', original)
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device:attempted', '1')
    await render()
    expect(buttons()[0].disabled).toBe(false)
    expect(h.calls).toEqual([])
    h.scenario = 'command'
    await act(async () => buttons()[0].click())
    const retried = await assertExports()
    expect(retried.attempt_id).not.toBe(previous.attempt_id)
    expect(retried.retry_of_attempt_id).toBe(previous.attempt_id)
    const archived = localStorage.getItem(`v8PhysicalSemanticTest.v1:activity:owner:device:attempt:${previous.attempt_id}`)
    expect(JSON.parse(archived!)).toEqual(previous)
    expect(JSON.parse(localStorage.getItem(`v8PhysicalSemanticTest.v1:activity:owner:device:attempt:${retried.attempt_id}`)!)).toEqual(retried)
    expect(localStorage.getItem('v8PhysicalSemanticTest.v1:workout:owner:device:attempted')).toBeNull()
    expect(h.calls).toEqual(['begin', 'activity', 'end'])
    const calls = [...h.calls]
    await render('Engineering')
    expect(h.calls).toEqual(calls)
    expect(localStorage.getItem(`v8PhysicalSemanticTest.v1:activity:owner:device:attempt:${previous.attempt_id}`)).toBe(archived)
    expect(buttons()[0].disabled).toBe(true)
  })

  it.each([
    ['acquisition_started', true], ['native_invocation_started', true],
    ['ble_commands_issued', 1], ['callbacks_received', 1], ['source_envelopes_written', 1],
    ['partial_evidence_present', true], ['retry_disposition', 'RETRY_NOT_ALLOWED'],
    ['acquisition_started', null], ['native_invocation_started', null],
    ['ble_commands_issued', null], ['callbacks_received', null], ['source_envelopes_written', null],
    ['partial_evidence_present', null], ['attempt_id', null],
  ])('does not authorize retry when %s is %s', async (field, value) => {
    const result = newPhysicalResult('activity', {
      v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true,
      journal_bound: true, device_scope_resolved: true,
    })
    Object.assign(result, { status: 'FAILED', retry_disposition: 'SAFE_TO_RETRY_NO_DEVICE_COMMAND', [field as string]: value })
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify(result))
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device:attempted', '1')
    await render()
    expect(buttons()[0].disabled).toBe(true)
    expect(h.calls).toEqual([])
  })

  it('does not reuse an old safe failure when a newer retry was interrupted, even if the device clock moved backward', async () => {
    const old = newPhysicalResult('activity', {
      v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true,
      journal_bound: true, device_scope_resolved: true,
    })
    old.status = 'FAILED'; old.retry_disposition = 'SAFE_TO_RETRY_NO_DEVICE_COMMAND'
    old.started_at = '2027-01-01T00:00:00.000Z'
    const interrupted = {
      ...old, attempt_id: 'new-attempt', retry_of_attempt_id: old.attempt_id,
      status: 'RUNNING', started_at: '2026-01-01T00:00:00.000Z',
    }
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify(old))
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device:progress', JSON.stringify(interrupted))
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device:attempted', '1')
    await render()
    expect(buttons()[0].disabled).toBe(true)
    expect(h.calls).toEqual([])
    const recovered = await recoverPhysicalFailure('activity', scope, JCVitalV8)
    expect(recovered.result?.attempt_id).toBe('new-attempt')
  })

  it('passes only the test kind and generated attempt ID to the native session bridge', async () => {
    const begin = vi.spyOn(JCVitalV8, 'beginPhysicalSemanticTest')
    h.scenario = 'command'
    await render()
    await act(async () => buttons()[0].click())
    expect(begin).toHaveBeenCalledExactlyOnceWith({ kind: 'activity', attemptId: expect.any(String) })
    const result = await assertExports()
    expect(result.attempt_id).toBe(h.attemptId)
    expect(result.native_evidence?.attemptId).toBe(h.attemptId)
  })

  it('makes Workout shared-native-session and acquisition failures exportable, without retry', async () => {
    for (const scenario of ['native', 'workout-command']) {
      localStorage.clear()
      const activity = seedSafeFailure()
      Object.assign(activity, { status: 'COMPLETE', isolation_released_at: '2026-10-19', sender_resumed_at: '2026-10-19' })
      activity.result = { interpretation: 'SOURCE_ONLY_CAPTURE_COMPLETE', reconciliation: {} }
      activity.stages = [{ stage: 'RESULT_PERSISTED', at: '2026-10-19' }, { stage: 'COMPLETE', at: '2026-10-19' }]
      localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify(activity))
      h.scenario = scenario
      await render(scenario)
      expect(buttons('Workout 29 + 82')[0].disabled).toBe(true)
      await act(async () => buttons()[3].click())
      await act(async () => buttons('Workout 29 + 82')[0].click())
      const result = await assertExports('Workout 29 + 82')
      expect(result.failure_stage).toBe(scenario === 'native' ? 'NATIVE_SESSION_CREATED' : 'COMMAND_WRITTEN')
      expect(h.queueWrites).toBe(0); expect(h.base44).toBe(0); expect(h.ack).toBe(7)
    }
  })

  it('v61 renders the actual panel, shows FINALIZER_REQUESTED synchronously and persists the receipt before any native/journal read', async () => {
    const { saved } = seedSourceOnlyAttempt()
    const key = 'eliteplus.savedActivityFinalizer.diagnostic.v1:owner'
    const seen: { receipt: unknown; rendered: boolean } = { receipt: null, rendered: false }
    const evidence = vi.spyOn(JCVitalV8, 'readPhysicalSemanticTestEvidence').mockImplementation(() => {
      seen.receipt = JSON.parse(localStorage.getItem(key) ?? 'null')
      seen.rendered = container.textContent?.includes('stage: FINALIZER_REQUESTED') ?? false
      return new Promise(() => {})
    })
    const sourceRead = vi.spyOn(JCVitalV8, 'readSourceEnvelope')
    await render('v61-click', false)
    const control = container.querySelector<HTMLButtonElement>('[aria-label="Saved Activity Finalization"] button')!
    expect(control.textContent).toBe('Finalize Saved Activity 24 + 25 Test')
    act(() => control.click())
    expect(evidence).toHaveBeenCalledTimes(1)
    expect(sourceRead).not.toHaveBeenCalled()
    expect(seen.rendered).toBe(true)
    expect(seen.receipt).toMatchObject({
      stage: 'FINALIZER_REQUESTED', attempt_id: saved.attempt_id, account_id: 'owner', device_scope_id: 'device',
      outcome: 'RUNNING',
    })
    expect(typeof (seen.receipt as { action_id: unknown }).action_id).toBe('string')
    expect(typeof (seen.receipt as { clicked_at: unknown }).clicked_at).toBe('string')
    const status = container.querySelector('[aria-label="Saved Activity Finalizer status"]')!
    expect(status.textContent).toContain('Finalizer action received')
    expect(status.textContent).toContain(`attempt: ${saved.attempt_id}`)
    expect(control.textContent).toBe('Finalizing Saved Activity…')
    act(() => control.click())
    expect(evidence).toHaveBeenCalledTimes(1)
    expect(JSON.parse(localStorage.getItem(key)!).ignored_clicks).toHaveLength(1)
    expect(h.calls).toEqual([])
  })

  it('v61 makes a previously silent blocked click visible beside the button, with no native read', async () => {
    const evidence = vi.spyOn(JCVitalV8, 'readPhysicalSemanticTestEvidence')
    await render('v61-blocked', true, { productionSyncActive: true })
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Saved Activity Finalization"] button')!.click())
    const status = container.querySelector('[aria-label="Saved Activity Finalizer status"]')!
    expect(status.textContent).toContain('Finalizer action received')
    expect(status.textContent).toContain('stage: FINALIZER_REQUESTED')
    expect(status.textContent).toContain('outcome: BLOCKED')
    expect(status.textContent).toContain('SAVED_ACTIVITY_ATTEMPT_NOT_LOADED')
    expect(status.textContent).toContain('PRODUCTION_SYNC_ACTIVE')
    expect(evidence).not.toHaveBeenCalled()
    const exports = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Saved Activity Finalization"] .wearable-actions button'))
    expect(exports.map((b) => [b.textContent, b.disabled])).toEqual([
      ['Show Finalizer Diagnostic', false], ['Copy Finalizer Diagnostic JSON', false], ['Save Finalizer Diagnostic JSON', false],
    ])
    await act(async () => exports[1].click())
    expect(JSON.parse(h.copied)).toMatchObject({ outcome: 'BLOCKED', stage: 'FINALIZER_REQUESTED' })
  })

  it('v61 hanging Source Journal read: UI stays responsive, watchdog shows waiting then FINALIZER_ACTION_TIMEOUT, no second finalizer, export works, cleanup runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    const { saved } = seedSourceOnlyAttempt()
    const key = 'eliteplus.savedActivityFinalizer.diagnostic.v1:owner'
    const evidence = vi.spyOn(JCVitalV8, 'readPhysicalSemanticTestEvidence')
    const sourceRead = vi.spyOn(JCVitalV8, 'readSourceEnvelope').mockImplementation(() => new Promise(() => {}))
    await render('v61-hang', false)
    const control = container.querySelector<HTMLButtonElement>('[aria-label="Saved Activity Finalization"] button')!
    await act(async () => { control.click(); await vi.advanceTimersByTimeAsync(0) })
    const status = () => container.querySelector('[aria-label="Saved Activity Finalizer status"]')!.textContent ?? ''
    expect(status()).toContain('stage: SOURCE_RECORDS_REHYDRATING')
    expect(status()).toContain('Type24 source batch 1/1')
    expect(status()).toContain('Type24 records loaded: 0 / 1')
    expect(sourceRead).toHaveBeenCalled()
    expect(sourceRead.mock.calls.every(([o]) => ['24', '25'].includes(o.envelopeId))).toBe(true)
    await act(async () => { await vi.advanceTimersByTimeAsync(16_000) })
    expect(status()).toContain('Finalizer still waiting')
    expect(status()).toContain('last completed stage: SOURCE_RECORDS_REHYDRATING')
    expect(status()).toMatch(/elapsed: 1[67] s/)
    await act(async () => control.click())
    expect(evidence).toHaveBeenCalledTimes(1)
    const exports = Array.from(container.querySelectorAll<HTMLButtonElement>('[aria-label="Saved Activity Finalization"] .wearable-actions button'))
    expect(exports.every((b) => !b.disabled)).toBe(true)
    await act(async () => exports[0].click())
    expect(container.querySelector('[aria-label="Finalizer diagnostic JSON"]')?.textContent).toContain('SOURCE_RECORDS_REHYDRATING')
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })
    const timedOut = JSON.parse(localStorage.getItem(key)!)
    expect(timedOut.outcome).toBe('RUNNING')
    expect(timedOut.watchdog.timeout).toMatchObject({
      code: 'FINALIZER_ACTION_TIMEOUT', action_id: timedOut.action_id, attempt_id: saved.attempt_id,
      last_completed_stage: 'SOURCE_RECORDS_REHYDRATING', type24_loaded: 0, type25_loaded: 0,
    })
    expect(timedOut.watchdog.timeout.pending_read_operation).toContain('Type24 source batch 1/1')
    expect(timedOut.watchdog.timeout.elapsed_ms).toBeGreaterThanOrEqual(45_000)
    expect(status()).toContain('FINALIZER_ACTION_TIMEOUT')
    await act(async () => exports[1].click())
    expect(JSON.parse(h.copied).watchdog.timeout.code).toBe('FINALIZER_ACTION_TIMEOUT')
    await act(async () => exports[2].click())
    expect(JSON.parse(h.saved).action_id).toBe(timedOut.action_id)
    expect(evidence).toHaveBeenCalledTimes(1)
    await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
    await act(async () => { vi.useRealTimers() })
    await vi.waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).outcome).toBe('FAILED'))
    const failed = JSON.parse(localStorage.getItem(key)!)
    expect(failed.last_error).toContain('timed out')
    expect(failed.stages.map((s: { stage: string }) => s.stage)).toContain('ISOLATION_RELEASED')
    expect(failed.stages.map((s: { stage: string }) => s.stage)).toContain('SENDER_RESUMED')
    expect(evidence).toHaveBeenCalledTimes(1)
    expect(h.calls).toEqual([])
    expect(h.queueWrites).toBe(0)
    expect(h.base44).toBe(0)
    expect(h.ack).toBe(7)
  })

  it('v60 finalizes a saved source-only attempt while disconnected, survives remount, and never begins acquisition or duplicates a running sender', async () => {
    vi.stubGlobal('crypto', webcrypto)
    const saved = seedSafeFailure()
    const typed = (value: string) => ({ type: 'String', value })
    const snapshot = (fields: Record<string, string>) => ({
      type: 'Map', entries: Object.entries(fields).map(([key, value]) => ({ key: typed(key), value: typed(value) })),
    })
    const rows = new Map<string, Awaited<ReturnType<typeof JCVitalV8.readSourceEnvelope>>>()
    const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from([1, 2]))))
      .map((value) => value.toString(16).padStart(2, '0')).join('')
    const header = { ...scope, sessionId: 'saved-session', provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE',
      acquisitionMode: 'HISTORICAL_SYNC', timezone: 'UTC' }
    const put = (id: string, data: Record<string, unknown>, rawBytesBase64: string | null = null) =>
      rows.set(id, { envelopeId: id, sequence: rows.size + 1, sourceFile: null, rawBytesBase64,
        envelopeJson: JSON.stringify({ ...header, envelopeId: id, ...data }) })
    for (const type of ['24', '25']) {
      const sdkSnapshot = snapshot(type === '24'
        ? { date: '2026.10.19', step: '10', distance: '0', calories: '0' }
        : { date: '2026.10.19 00:00:00', arraySteps: '0 10', detailMinterStep: '10', distance: '0', calories: '0' })
      put(`${type}-ble`, { kind: 'BLE_NOTIFICATION', byteLength: 2, sha256 }, 'AQI=')
      put(`${type}-cb`, { kind: 'SDK_CALLBACK', vendorDataType: type, callbackId: `${type}-cb`,
        notificationEnvelopeId: `${type}-ble`, recordEnvelopeIds: [type],
        sdkSnapshot: { type: 'Map', entries: [{ key: typed('dicData'), value: { type: 'List', values: [sdkSnapshot] } }] } })
      put(type, { kind: 'SDK_RECORD', vendorDataType: type, sourceRecordId: type, sourceRecordGroupId: `${type}-cb`,
        callbackId: `${type}-cb`, notificationEnvelopeId: `${type}-ble`, recordIndex: 0, sourceIndex: 0, sdkSnapshot })
    }
    h.native = {
      kind: 'activity', attemptId: saved.attempt_id, sessionClosed: true, failureStage: null, errorCode: null,
      commands: [], commandsAllowed: true, digitalWellnessBeforeSha256: 'same', digitalWellnessAfterSha256: 'same',
      digitalWellnessUnchanged: true, commandTypes: ['24', '25'], sourceEnvelopeIds: [...rows.keys()],
      diagnostics: { recordsByType: { '24': 1, '25': 1 }, callbacksByType: { '24': 1, '25': 1 } },
    }
    saved.status = 'RUNNING'
    saved.diagnostics.activity = { acquisitionSessionId: 'saved-session', results: ['24', '25'].map((type) => ({
      vendorDataType: type, completionStatus: 'EMPTY_VALID', observations: [], recordGroupsReceived: 1,
      sourceRecordEnvelopeIds: [type], sourceCallbackEnvelopeIds: [`${type}-cb`],
    })) }
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', JSON.stringify(saved))
    vi.spyOn(JCVitalV8, 'readSourceEnvelope').mockImplementation(async ({ envelopeId }) => rows.get(envelopeId)!)
    h.inFlight = 100
    await render('saved-finalization', false)
    expect(buttons()[0].disabled).toBe(true)
    const control = container.querySelector<HTMLButtonElement>('[aria-label="Saved Activity Finalization"] button')!
    expect(control.disabled).toBe(false)
    await act(async () => {
      control.click()
      await vi.waitFor(async () => {
        expect((await readSavedActivityFinalization(scope))?.status).toBe('COMPLETE')
      })
    })
    expect(container.textContent).toContain('Saved Activity finalized.')
    expect(h.calls).toEqual([])
    expect(h.queueWrites).toBe(0)
    expect(h.base44).toBe(0)
    expect(h.ack).toBe(7)
    expect(observationBatchManager.resumeAfterPhysicalTest).not.toHaveBeenCalled()
    await act(async () => buttons()[2].click())
    const result = JSON.parse(h.copied) as FailureResult
    expect(result.status).toBe('COMPLETE')
    expect(result.attempt_id).toBe(saved.attempt_id)
    expect(result.retry_of_attempt_id).toBe(saved.retry_of_attempt_id)
    expect(result.isolation_released_at).toBeTruthy()
    expect(result.sender_resumed_at).toBeTruthy()
    await render('saved-finalization', true)
    expect(buttons('Workout 29 + 82')[0].disabled).toBe(true)
    await act(async () => buttons()[3].click())
    expect(h.saved).toBe(h.copied)
    expect(buttons('Workout 29 + 82')[0].disabled).toBe(false)
    expect(h.calls).toEqual([])
    let finishOldExport!: (value: string) => void
    vi.spyOn(jsonExport, 'saveValidationJson').mockImplementationOnce(() =>
      new Promise<string>((resolve) => { finishOldExport = resolve }))
    await act(async () => buttons()[3].click())
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Saved Activity Finalization"] button')!.click()
      await vi.waitFor(async () => {
        const finalized = await readSavedActivityFinalization(scope)
        expect(finalized?.stages.filter((s) => s.stage === 'COMPLETE')).toHaveLength(2)
      })
    })
    await act(async () => finishOldExport('saved old result'))
    expect(buttons('Workout 29 + 82')[0].disabled).toBe(true)
    await act(async () => buttons()[3].click())
    expect(buttons('Workout 29 + 82')[0].disabled).toBe(false)
    expect(h.calls).toEqual([])
    await render('saved-finalization-remount', false)
    await act(async () => {
      await readSavedActivityFinalization(scope)
    })
    expect(container.textContent).toContain('RESULT_PERSISTED')
    expect(h.calls).toEqual([])
    expect(buttons('Workout 29 + 82')[0].disabled).toBe(true)
  })

  it('recovers a v55 one-shot marker read-only without inventing stage, counters, or attempt timestamp', async () => {
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device:attempted', '1')
    await render()
    const recovery = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Recover Last Physical Test Failure')!
    await act(async () => recovery.click())
    const result = await assertExports()
    expect(result.failure_stage).toBe('UNKNOWN')
    expect(result.started_at).toBeNull()
    expect(result.ble_commands_issued).toBeNull()
    expect(result.callbacks_received).toBeNull()
    expect(result.retry_disposition).toBe('RETRY_NOT_ALLOWED')
    expect(result.inspected_stores).toContain('owner/device-scoped Source Journal envelope inventory')
    expect(h.calls).toEqual([])
    expect(h.queueWrites).toBe(0); expect(h.base44).toBe(0); expect(h.ack).toBe(7)
  })

  it('reports NO_DURABLE_FAILURE_EVIDENCE and inspected stores without acquiring or fabricating a failure', async () => {
    const result = await recoverPhysicalFailure('activity', scope, JCVitalV8)
    expect(result.result).toBeNull()
    expect(result.errors).toEqual([])
    await render()
    const recovery = Array.from(container.querySelectorAll('button')).find((button) => button.textContent === 'Recover Last Physical Test Failure')!
    await act(async () => recovery.click())
    expect(container.textContent).toContain('NO_DURABLE_FAILURE_EVIDENCE')
    expect(container.textContent).toContain('certification snapshot')
    expect(h.calls).toEqual([])
    expect(buttons().slice(1).every((button) => button.disabled)).toBe(true)
  })

  it('does not relabel a legacy successful v55 result as a recovered failure', async () => {
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device:attempted', '1')
    const success = '{"kind":"ACTIVITY_24_25_SEMANTIC_TEST","version":1}'
    localStorage.setItem('v8PhysicalSemanticTest.v1:activity:owner:device', success)
    const recovery = await recoverPhysicalFailure('activity', scope, JCVitalV8)
    expect(recovery.result).toBeNull()
    expect(localStorage.getItem('v8PhysicalSemanticTest.v1:activity:owner:device')).toBe(success)
    expect(h.calls).toEqual([])
  })

  it('does not call an interrupted native command checkpoint final or safe to retry', async () => {
    h.native = {
      kind: 'activity', attemptId: 'interrupted', commands: [], commandsAllowed: true,
      digitalWellnessBeforeSha256: 'hash', digitalWellnessAfterSha256: 'hash', digitalWellnessUnchanged: true,
      commandsIssued: 0, acquisitionStarted: false, sessionClosed: false, callbacksReceived: 0,
      sourceEnvelopeIds: [], lastCompletedStage: 'COMMAND_REQUESTED',
    }
    const recovery = await recoverPhysicalFailure('activity', scope, JCVitalV8)
    expect(recovery.result?.last_completed_stage).toBe('COMMAND_REQUESTED')
    expect(recovery.result?.ble_commands_issued).toBeNull()
    expect(recovery.result?.callbacks_received).toBeNull()
    expect(recovery.result?.retry_disposition).toBe('RETRY_NOT_ALLOWED')
    expect(h.calls).toEqual([])
  })
})
