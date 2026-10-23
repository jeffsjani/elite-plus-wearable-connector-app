// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhysicalSemanticNativeEvidence } from './jcvitalV8Bridge'
import { CONTROLLED_MINUTE_PATTERN } from './Type25MinuteAnchor'
import { analyzeSavedType25Records, SAVED_TYPE25_ANCHOR_ATTEMPT, type25RefreshEligibility, type25SnapshotFields } from './SavedType25Anchor'
import { newPhysicalResult } from './PhysicalSemanticEvidence'

const h = vi.hoisted(() => ({
  envelopes: new Map<string, Record<string, unknown>>(),
  calls: [] as string[], native: null as PhysicalSemanticNativeEvidence | null,
  refreshMode: 'overlap', wrongScope: false,
}))
vi.mock('../../buildMode', () => ({ IS_ENGINEERING_BUILD: true }))
vi.mock('../../services/sync/ObservationQueue', () => ({
  observationQueue: {
    getOwnerUserId: () => 'owner',
    getQueueStats: async () => ({ pending: 0, retrying: 0, inFlight: 0, failed: 0, acknowledged: 7 }),
    enqueueMany: () => { throw new Error('Forbidden queue write') },
  },
}))
vi.mock('../../services/sync/ObservationBatchManager', () => ({
  observationBatchManager: {
    getPhysicalTestSenderState: () => ({
      started: true, paused: false, activeRequest: false, activeWorkers: 0, claimOwner: null,
      startupOperations: 0, lastBatchId: null, lastSenderError: null, lastInflightCompletedAt: null,
    }),
    getDeliveryDiagnostics: () => ({ senderGeneration: 0 }),
    resumeAfterPhysicalTest: () => {},
    process: () => { throw new Error('Forbidden Base44 call') },
  },
}))
vi.mock('./jcvitalV8Bridge', () => ({
  JCVitalV8: {
    readSourceEnvelope: async ({ envelopeId }: { envelopeId: string }) => {
      h.calls.push('read')
      const envelope = h.envelopes.get(envelopeId)
      if (!envelope) throw new Error(`Missing fixture ${envelopeId}`)
      return { envelopeId, sequence: 1, rawBytesBase64: null, envelopeJson: JSON.stringify({
        ...envelope, ...(h.wrongScope ? { accountId: 'other' } : {}),
      }) }
    },
    getConnectionState: async () => { h.calls.push('state'); return { state: 'READY' } },
    beginPhysicalSemanticTest: async ({ attemptId }: { attemptId: string }) => {
      h.calls.push('begin')
      h.native = {
        kind: 'activity_type25_anchor', attemptId, commands: [], commandsAllowed: true,
        digitalWellnessBeforeSha256: 'same', digitalWellnessAfterSha256: 'same', digitalWellnessUnchanged: true,
        commandTypes: [], sourceEnvelopeIds: [],
      }
      return h.native
    },
    syncDetailedActivity: async () => {
      h.calls.push('type25')
      if (h.refreshMode === 'error') throw new Error('History timed out')
      const ids = h.refreshMode === 'empty' ? [] : ['fresh-record', 'fresh-callback', 'fresh-receipt']
      if (h.native) Object.assign(h.native, {
        commandTypes: ['25'], commandsIssued: 1, sourceEnvelopeIds: ids,
        commands: [{ name: 'GetDetailActivityDataWithMode', opcode: 25, rawBytesBase64: 'AA==', allowed: true, writeAcknowledged: true }],
        diagnostics: {
          dataEndByType: { '25': true }, recordsByType: { '25': ids.length ? 1 : 0 },
          type24Requested: false, type24CommandWritten: false, unexpectedCallbackTypes: [],
        },
      })
      return {
        vendorDataType: '25', completionStatus: h.refreshMode === 'empty' ? 'EMPTY_VALID' : 'COMPLETE',
        sourceRecordEnvelopeIds: ids.filter((id) => id.endsWith('record')),
        sourceCallbackEnvelopeIds: ids.filter((id) => id.endsWith('callback')),
      }
    },
    endPhysicalSemanticTest: async () => { h.calls.push('end'); return h.native },
    readPhysicalSemanticTestEvidence: async () => ({ json: JSON.stringify(h.native) }),
    syncActivityCertification: () => { throw new Error('Forbidden Type24 acquisition') },
    syncWorkoutHistoryCertification: () => { throw new Error('Forbidden Workout acquisition') },
  },
}))

import { Type25AnchorTest } from './Type25AnchorTest'

const start = Date.parse('2026-10-20T10:22:51.000Z')
const transitions = CONTROLLED_MINUTE_PATTERN.map((instruction, index) => ({
  minute: index + 1, instruction, localTimestamp: new Date(start + index * 60_000).toISOString(),
  epochMs: start + index * 60_000, monotonicMs: index * 60_000,
}))
const key = 'v8Type25AnchorTest.v1:owner:device'
const walk = (instruction: string) => instruction === 'WALK' ? 20 : 0
// Under model A (FIRST_MINUTE + OLDEST_TO_NEWEST): saved segment starts 6 min before the window
// (like 10:16 vs 10:22), so only 4 of its slots can overlap; the delayed segment starts 4 min in.
const AMBIGUOUS_SAVED = [0, 0, 0, 0, 0, 0, ...CONTROLLED_MINUTE_PATTERN.slice(0, 4).map(walk)]
const DELAYED_NEXT = [...CONTROLLED_MINUTE_PATTERN.slice(4).map(walk), 0, 0]
const FULL_PATTERN = CONTROLLED_MINUTE_PATTERN.slice(0, 10).map(walk)

function typed(value: unknown): unknown {
  if (value && typeof value === 'object') return {
    type: 'Map', entries: Object.entries(value).map(([key, item]) => ({ key: typed(key), value: typed(item) })),
  }
  return { type: typeof value === 'string' ? 'String' : 'Integer', value }
}
function fixture(prefix: string, at: number, values: number[] = FULL_PATTERN) {
  for (const kind of ['record', 'callback', 'receipt']) {
    const envelopeId = `${prefix}-${kind}`
    h.envelopes.set(envelopeId, {
      envelopeId, accountId: 'owner', deviceScopeId: 'device', timezone: 'UTC',
      kind: kind === 'record' ? 'SDK_RECORD' : kind === 'callback' ? 'SDK_CALLBACK' : 'NOTIFICATION',
      receivedAt: '2026-10-20T10:40:00.000Z', vendorDataType: '25',
      callbackId: `${prefix}-callback`, notificationEnvelopeId: `${prefix}-receipt`,
      parsedSourceDateMillis: at, sourceDate: new Date(at).toISOString(),
      sdkSnapshot: typed({
        date: new Date(at).toISOString(), detailMinterStep: String(values.reduce((sum, value) => sum + value, 0)),
        arraySteps: values.join(' '),
      }),
    })
  }
}
function seed(update: (saved: ReturnType<typeof newPhysicalResult>) => void = () => {}) {
  const saved = newPhysicalResult('activity_type25_anchor', {
    v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true,
    journal_bound: true, device_scope_resolved: true,
  })
  Object.assign(saved, {
    attempt_id: SAVED_TYPE25_ANCHOR_ATTEMPT, owner_account: 'owner', device_scope_id: 'device', timezone: 'UTC',
    status: 'COMPLETE', build: 'v62', source_journal_refs: ['saved-record', 'saved-callback', 'saved-receipt'],
  })
  saved.diagnostics.controlledTransitions = transitions
  saved.diagnostics.sourceEvidencePersistedBeforeAnalysis = { persistedBeforeAnalysis: true }
  update(saved)
  localStorage.setItem(key, JSON.stringify(saved))
  return saved
}

let root: Root
let container: HTMLDivElement
let clipboard: string[]
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear(); sessionStorage.clear()
  h.envelopes.clear(); h.calls = []; h.native = null; h.refreshMode = 'overlap'; h.wrongScope = false
  clipboard = []
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true, value: { writeText: async (text: string) => { clipboard.push(text) } },
  })
  fixture('saved', start - 6 * 60_000, AMBIGUOUS_SAVED); fixture('fresh', start + 4 * 60_000, DELAYED_NEXT)
  seed()
  container = document.createElement('div'); document.body.append(container); root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove(); vi.unstubAllGlobals(); vi.restoreAllMocks()
})
async function render() {
  await act(async () => root.render(<Type25AnchorTest
    context={{ scope: { accountId: 'owner', deviceScopeId: 'device' }, bleAddress: 'AA', sdkVersion: 'test',
      firmwareVersion: null, ready: true, native: true, physical: true }}
    ownerUserId="owner"
    eligibility={{ ready: true, authenticatedOwner: 'owner', connectorOwner: 'owner',
      journalScope: { accountId: 'owner', deviceScopeId: 'device' }, sourceJournalBound: true,
      connectionBusy: false, productionSyncActive: false, physicalTestActive: false, workoutControlAvailable: true }}
    setBusy={() => {}} workoutActive={false} onTestActiveChange={() => {}}
  />))
}
function button(label: string) {
  const found = [...container.querySelectorAll('button')].find((node) => node.textContent === label)
  if (!found) throw new Error(`Missing button ${label}`)
  return found
}
async function click(label: string) {
  await act(async () => button(label).click())
}
const REFRESH = 'Refresh Saved Type25 Anchor History'
const ANALYZE = 'Analyze Saved Type25 Anchor Result (No BLE)'
const REQUIRED_RECOVERY_FIELDS = [
  'recovery_schema', 'recovery_build', 'original_attempt_id', 'analysis_run_at', 'original_record_count',
  'refreshed_record_count', 'latest_vendor_date_before', 'latest_vendor_date_after', 'valid_array_count',
  'invalid_array_count', 'sum_invariant_pass_count', 'candidateModels', 'selectedTimestampModel', 'arrayOrdering',
  'controlledPatternMatch', 'canonicalMinuteTimestampsDeterministic', 'refreshReason', 'queueWrites', 'base44Calls',
  'canonicalWrites', 'readinessWrites', 'READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION',
]

describe('v64 Type25 recovery gate (synthetic persisted SDK fixtures)', () => {
  it('decodes typed fields, not the Map wrapper, and rejects duplicate fields', () => {
    expect(type25SnapshotFields(typed({ detailMinterStep: '100', arraySteps: '0 20 0 20 20 0 20 0 0 20' })))
      .toEqual({ detailMinterStep: '100', arraySteps: '0 20 0 20 20 0 20 0 0 20' })
    expect(() => type25SnapshotFields({ type: 'Map', entries: [
      { key: typed('arraySteps'), value: typed('0') }, { key: typed('arraySteps'), value: typed('1') },
    ] })).toThrow('Duplicate')
  })

  it('unresolved ambiguous saved analysis (possible overlap) → refresh ENABLED, zero BLE, original unchanged', async () => {
    const original = localStorage.getItem(key)
    await render()
    expect(button('Validate Type25 Minute Anchor').disabled).toBe(true)
    expect(button(REFRESH).disabled).toBe(false)
    await click(ANALYZE)
    expect(new Set(h.calls)).toEqual(new Set(['read']))
    const result = JSON.parse(localStorage.getItem(`${key}:analysis`)!)
    for (const field of REQUIRED_RECOVERY_FIELDS) expect(result).toHaveProperty(field)
    expect(Object.keys(result.candidateModels)).toEqual(['A', 'B', 'C', 'D'])
    expect(result).toMatchObject({
      recovery_build: 'v64', original_attempt_id: SAVED_TYPE25_ANCHOR_ATTEMPT,
      original_record_count: 1, refreshed_record_count: 0,
      valid_array_count: 1, invalid_array_count: 0, sum_invariant_pass_count: 1,
      overlappingRecordCount: 1, selectedTimestampModel: null, controlledPatternMatch: 'FAIL',
      canonicalMinuteTimestampsDeterministic: 'NO', bleAcquisitions: 0,
      queueWrites: 0, base44Calls: 0, canonicalWrites: 0, readinessWrites: 0,
      READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: 'NO',
    })
    expect(result.refreshReason).toContain('SAVED_ANALYSIS_UNRESOLVED')
    expect(result.controlledWindow.lastTransition).toBe('2026-10-20T10:33:51.000Z')
    expect(button(REFRESH).disabled).toBe(false)
    expect(container.textContent).toContain('Refresh eligibility: ENABLED')
    expect(localStorage.getItem(key)).toBe(original)
  })

  it('malformed possibly-overlapping saved records stay unresolved → refresh ENABLED', async () => {
    h.envelopes.get('saved-record')!.sdkSnapshot = typed({
      date: new Date(start).toISOString(), detailMinterStep: '0', arraySteps: '0 0',
    })
    await render()
    await click(ANALYZE)
    const result = JSON.parse(localStorage.getItem(`${key}:analysis`)!)
    expect(result).toMatchObject({ allRecordInvariantsPass: false, invalid_array_count: 1, selectedTimestampModel: null })
    expect(button(REFRESH).disabled).toBe(false)
  })

  it('resolved unique PASS → refresh DISABLED (from saved analysis or original report)', async () => {
    fixture('saved', start, FULL_PATTERN)
    await render()
    await click(ANALYZE)
    const result = JSON.parse(localStorage.getItem(`${key}:analysis`)!)
    expect(result).toMatchObject({
      selectedTimestampModel: 'FIRST_MINUTE + OLDEST_TO_NEWEST', controlledPatternMatch: 'PASS',
      canonicalMinuteTimestampsDeterministic: 'YES',
    })
    expect(result.refreshReason).toContain('NOT_REQUIRED')
    expect(button(REFRESH).disabled).toBe(true)
    expect(container.textContent).toContain('UNIQUE_SEMANTIC_RESOLUTION_ACHIEVED')
    expect(new Set(h.calls)).toEqual(new Set(['read']))

    const resolvedReport = { selectedTimestampModel: 'LAST_MINUTE + OLDEST_TO_NEWEST', controlledPatternMatch: 'PASS',
      canonicalMinuteTimestampsDeterministic: 'YES' }
    expect(type25RefreshEligibility(seed((saved) => { saved.result = resolvedReport }), [])).toMatchObject({
      enabled: false, reasons: ['UNIQUE_SEMANTIC_RESOLUTION_ACHIEVED'],
    })
  })

  it('missing/corrupt saved attempt → refresh DISABLED', async () => {
    expect(type25RefreshEligibility(null, []).enabled).toBe(false)
    expect(type25RefreshEligibility(seed((saved) => { saved.status = 'FAILED' }), []).reasons)
      .toContain('SAVED_ATTEMPT_STATUS_FAILED')
    expect(type25RefreshEligibility(seed((saved) => { saved.diagnostics.controlledTransitions = transitions.slice(0, 11) }), []).reasons)
      .toContain('CONTROLLED_TRANSITIONS_INCOMPLETE')
    expect(type25RefreshEligibility(seed((saved) => {
      saved.source_journal_refs = []
      saved.diagnostics.sourceEvidencePersistedBeforeAnalysis = undefined
    }), []).reasons).toContain('SOURCE_EVIDENCE_NOT_PERSISTED')
    expect(type25RefreshEligibility({ status: 'COMPLETE', diagnostics: null } as never, []).enabled).toBe(false)

    localStorage.setItem(key, '{not json')
    await render()
    expect(button(REFRESH).disabled).toBe(true)
    expect(container.textContent).toContain('could not be read')
  })

  it('cross-owner / unreadable source evidence → refresh DISABLED after analysis fails', async () => {
    h.wrongScope = true
    await render()
    await click(ANALYZE)
    expect(container.textContent).toContain('ancestry mismatch')
    expect(button(REFRESH).disabled).toBe(true)
    expect(container.textContent).toContain('SAVED_SOURCE_EVIDENCE_UNREADABLE')
    const invalid = analyzeSavedType25Records([{
      sourceEnvelopeId: 'bad', sourceEnvelope: '{}', vendorDate: transitions[0].localTimestamp,
      parsedDateMs: null, timezone: 'UTC', callbackTimestamp: null, receiptTimestamp: null,
      detailMinterStep: '0', arraySteps: '0 0 0 0 0 0 0 0 0 0',
    }], transitions)
    expect(invalid.overlapDeterminate).toBe(false)
    expect(invalid.selectedModel).toBeNull()
  })

  it('refresh issues Type25 only, reuses all 12 transitions exactly, combines saved + refreshed records, zero protected writes', async () => {
    const original = localStorage.getItem(key)
    await render()
    await click(REFRESH)
    expect(h.calls.filter((call) => call !== 'read')).toEqual(['state', 'begin', 'type25', 'end'])
    expect(h.native?.commandTypes).toEqual(['25'])
    expect(localStorage.getItem(key)).toBe(original)
    expect(h.envelopes.has('saved-record')).toBe(true)
    const refresh = JSON.parse(localStorage.getItem(`${key}:refresh`)!)
    expect(refresh.retry_of_attempt_id).toBe(SAVED_TYPE25_ANCHOR_ATTEMPT)
    expect(refresh.build).toBe('v64')
    expect(refresh.diagnostics.controlledTransitions).toEqual(transitions)
    expect(refresh.result.transitions).toEqual(transitions)
    expect(refresh.result).toMatchObject({
      physicalTest: 'PASS', arrayLength: 10, sumArrayStepsEqualsDetailMinterStep: 'PASS',
      queueWrites: 0, base44Calls: 0, canonicalWrites: 0, readinessWrites: 0, isolationPassed: true,
    })
    const recovery = JSON.parse(localStorage.getItem(`${key}:recovery`)!)
    for (const field of REQUIRED_RECOVERY_FIELDS) expect(recovery).toHaveProperty(field)
    expect(recovery).toMatchObject({
      recovery_build: 'v64', original_attempt_id: SAVED_TYPE25_ANCHOR_ATTEMPT,
      refresh_attempt_id: refresh.attempt_id, original_record_count: 1, refreshed_record_count: 1,
      latest_vendor_date_before: new Date(start - 6 * 60_000).toISOString(),
      latest_vendor_date_after: new Date(start + 4 * 60_000).toISOString(),
      selectedTimestampModel: 'FIRST_MINUTE + OLDEST_TO_NEWEST', arrayOrdering: 'OLDEST_TO_NEWEST',
      controlledPatternMatch: 'PASS', canonicalMinuteTimestampsDeterministic: 'YES',
      queueWrites: 0, base44Calls: 0, canonicalWrites: 0, readinessWrites: 0, bleAcquisitions: 1,
      READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION: 'YES',
    })
    expect(recovery.refreshReason).toContain('SAVED_ANALYSIS_UNRESOLVED')
    expect(recovery.fits.find((fit: { id: string }) => fit.id === 'A').comparedMinutes).toBe(12)
    expect(button(REFRESH).disabled).toBe(true)
  })

  it('recovery analysis JSON is separately showable/copyable/shareable, distinct from the original v62 attempt, and rehydrates', async () => {
    const created: Blob[] = []
    const downloads: string[] = []
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (blob: Blob) => { created.push(blob); return 'blob:test' }, revokeObjectURL: () => {},
    }))
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push(this.download)
    })
    await render()
    expect(button('Show Saved Type25 Analysis JSON').disabled).toBe(true)
    await click(ANALYZE)
    await click('Show Saved Type25 Analysis JSON')
    const shown = container.querySelector('[aria-label="Saved Type25 analysis JSON"]')!.textContent!
    expect(JSON.parse(shown)).toMatchObject({ recovery_build: 'v64', original_attempt_id: SAVED_TYPE25_ANCHOR_ATTEMPT })
    await click('Copy Saved Type25 Analysis JSON')
    expect(JSON.parse(clipboard.at(-1)!).recovery_schema).toBeTruthy()
    await click('Copy Original Type25 Physical Attempt JSON')
    expect(JSON.parse(clipboard.at(-1)!)).toMatchObject({ build: 'v62' })
    expect(JSON.parse(clipboard.at(-1)!).recovery_schema).toBeUndefined()
    await click('Share / Save Saved Type25 Analysis JSON')
    expect(downloads).toEqual(['ElitePlus-P1-2B-Type25-Recovery-Analysis.json'])
    expect(JSON.parse(await created[0].text()).recovery_build).toBe('v64')

    await act(async () => root.unmount())
    root = createRoot(container)
    await render()
    expect(button('Show Saved Type25 Analysis JSON').disabled).toBe(false)
    expect(container.textContent).toContain('Saved Type25 analysis: v64')
  })

  it.each(['empty', 'stale', 'error'])('handles delayed %s history without a new physical pattern', async (mode) => {
    h.refreshMode = mode
    fixture('saved', start - 90 * 60_000)
    if (mode === 'stale') fixture('fresh', start - 90 * 60_000)
    await render()
    await click(REFRESH)
    const refresh = JSON.parse(localStorage.getItem(`${key}:refresh`)!)
    expect(refresh.result?.semanticPolicy ?? null).toBeNull()
    expect(refresh.status).toBe(mode === 'error' ? 'FAILED' : 'COMPLETE')
    expect(container.textContent).toContain(mode === 'error'
      ? 'Do not repeat the physical pattern on a refresh error'
      : 'Only now consider a separate decision to repeat the physical pattern')
    expect(h.calls.filter((call) => call === 'type25')).toHaveLength(1)
  })
})
