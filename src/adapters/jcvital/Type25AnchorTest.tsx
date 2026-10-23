import { useMemo, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import type { QueueStats } from '../../services/storage/ObservationQueueStore'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { beginPhysicalTestIsolation, physicalTestIsolationSnapshot } from '../../services/diagnostics/PhysicalTestIsolation'
import { requestPhysicalTestQuiescence } from '../../services/diagnostics/PhysicalTestQuiescence'
import { executePhysicalAttempt } from './PhysicalSemanticController'
import { evidenceKey, newPhysicalResult, type FailureResult } from './PhysicalSemanticEvidence'
import { saveValidationJson, serializeCertificationJson } from './CertificationJsonExport'
import { JCVitalV8, type JCVitalV8Plugin, type PhysicalSemanticNativeEvidence, type SourceEnvelopeEntry, type SourceJournalScope } from './jcvitalV8Bridge'
import type { PhysicalSemanticEligibility } from './V8PhysicalSemanticTests'
import type { Type42ConnectedContext } from './Type42Certification'
import {
  buildType25RecoveryAnalysis, combineType25Records, savedType25Transitions, type25RefreshEligibility,
  type25SemanticResolutionAchieved, type25SnapshotFields, TYPE25_RECOVERY_BUILD,
  type SavedType25Analysis,
} from './SavedType25Anchor'
import {
  CONTROLLED_MINUTE_PATTERN, evaluateType25MinuteAnchor, localTimestamp,
  type MinuteTransition, type Type25AnchorRecord, type Type25ModelFit,
} from './Type25MinuteAnchor'

const RESULT_KEY = 'v8Type25AnchorTest.v1'
const RECOVERY_ANALYSIS_FILENAME = 'ElitePlus-P1-2B-Type25-Recovery-Analysis.json'
const PERSISTENCE_WAIT_MS = 75_000
const MINUTE_MS = 60_000

type EnvelopeJson = Record<string, unknown>
type ReadEnvelope = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type StableQueueState = Omit<QueueStats, 'oldestPendingAgeMs' | 'oldestInFlightAgeMs'>

type CandidateReport = Type25AnchorRecord & {
  callbackEnvelope: string | null
  receiptEnvelope: string | null
  sumArraySteps: number | null
  arrayLength: number
}

type AnchorReport = {
  physicalTest: 'PASS' | 'FAIL'
  attempt_id: string
  device_scope_id: string
  owner_account: string
  started_at: string
  timezone: string
  monotonic_start_marker_ms: number
  transitions: MinuteTransition[]
  type25RecordsCaptured: number
  sourceJournalEvidence: {
    persistedBeforeAnalysis: boolean
    envelopeIds: string[]
    verifiedEnvelopeCount: number
    candidateProvenanceComplete: boolean
    dataEndReached: boolean
    completionStatus: string
  }
  records: CandidateReport[]
  fits: Type25ModelFit[]
  arrayLength: number | null
  sumArrayStepsEqualsDetailMinterStep: 'PASS' | 'FAIL'
  selectedTimestampModel: string | null
  type25DateMeans: 'FIRST_MINUTE' | 'LAST_MINUTE' | 'OTHER'
  arrayOrdering: 'OLDEST_TO_NEWEST' | 'NEWEST_TO_OLDEST' | null
  slotDurationSeconds: 60
  controlledPatternMatch: 'PASS' | 'FAIL'
  maximumTimingErrorMs: number | null
  overlappingConflictingRecords: Array<{ minute: string; sourceEnvelopeIds: string[]; values: number[] }>
  canonicalMinuteTimestampsDeterministic: 'YES' | 'NO'
  semanticPolicy: null | {
    name: 'jcvital.type25.minute_anchor.v1'
    anchor: 'FIRST_MINUTE' | 'LAST_MINUTE'
    ordering: 'OLDEST_TO_NEWEST' | 'NEWEST_TO_OLDEST'
    slot_duration_seconds: 60
    segment_slots: 10
  }
  queueWrites: number
  base44Calls: number
  canonicalWrites: number
  readinessWrites: number
  isolationPassed: boolean
  senderResumed: boolean
  readyForActivityProductionFinalization: 'YES' | 'NO'
}

function object(value: unknown): EnvelopeJson {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as EnvelopeJson : {}
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(object(value)).sort().map((key) => `${JSON.stringify(key)}:${stableJson(object(value)[key])}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function parsedEnvelope(entry: SourceEnvelopeEntry): EnvelopeJson {
  if (!entry.envelopeJson) throw new Error(`Source envelope ${entry.envelopeId} has no persisted envelope JSON.`)
  const result: unknown = JSON.parse(entry.envelopeJson)
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new Error(`Source envelope ${entry.envelopeId} is not a JSON object.`)
  }
  return result as EnvelopeJson
}

function normalizeReadEnvelope(entry: ReadEnvelope): SourceEnvelopeEntry {
  const json: unknown = entry.envelopeJson ? JSON.parse(entry.envelopeJson) : null
  const envelope = object(json)
  return {
    envelopeId: entry.envelopeId,
    sequence: entry.sequence,
    callbackId: typeof envelope.callbackId === 'string' ? envelope.callbackId : null,
    recordIndex: typeof envelope.recordIndex === 'number' ? envelope.recordIndex : null,
    kind: typeof envelope.kind === 'string' ? envelope.kind : '',
    receivedAt: typeof envelope.receivedAt === 'string' ? envelope.receivedAt : '',
    timezone: typeof envelope.timezone === 'string' ? envelope.timezone : '',
    envelopeJson: entry.envelopeJson,
    rawBytesBase64: entry.rawBytesBase64,
  }
}

function stableQueue(stats: QueueStats): StableQueueState {
  const { oldestPendingAgeMs: _pendingAge, oldestInFlightAgeMs: _inFlightAge, ...stable } = stats
  return stable
}

function mapText(value: unknown): Record<string, unknown> {
  return object(value)
}

function readStored(scope: SourceJournalScope, suffix = ''): FailureResult | null {
  const raw = localStorage.getItem(`${RESULT_KEY}:${scope.accountId}:${scope.deviceScopeId}${suffix}`)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  return value && typeof value === 'object' ? value as FailureResult : null
}

function readStoredAnalysis(scope: SourceJournalScope, suffix: ':analysis' | ':recovery'): SavedType25Analysis | null {
  const raw = localStorage.getItem(`${RESULT_KEY}:${scope.accountId}:${scope.deviceScopeId}${suffix}`)
  if (!raw) return null
  const value: unknown = JSON.parse(raw)
  return value && typeof value === 'object' && 'recovery_schema' in value ? value as SavedType25Analysis : null
}

function latestAnalysis(...values: Array<SavedType25Analysis | null>): SavedType25Analysis | null {
  return values.filter((value): value is SavedType25Analysis => value !== null)
    .sort((a, b) => Date.parse(b.analysis_run_at) - Date.parse(a.analysis_run_at))[0] ?? null
}

type CandidateWithProvenance = ReturnType<typeof buildCandidate>

/** Reads only the saved attempt's Source Journal IDs (zero BLE) and rebuilds its Type25 candidates. */
async function loadSavedType25Records(scope: SourceJournalScope, savedResult: FailureResult): Promise<CandidateWithProvenance[]> {
  if (savedResult.owner_account !== scope.accountId || savedResult.device_scope_id !== scope.deviceScopeId) {
    throw new Error('Saved Type25 attempt owner/device scope does not match.')
  }
  const ids = [...new Set(savedResult.source_journal_refs ?? [])]
  if (!ids.length) throw new Error('Saved attempt has no persisted source-journal references.')
  const entries: SourceEnvelopeEntry[] = []
  for (let offset = 0; offset < ids.length; offset += 20) {
    const batch = await Promise.all(ids.slice(offset, offset + 20).map(async (envelopeId) => {
      const read = await JCVitalV8.readSourceEnvelope({ ...scope, envelopeId })
      const entry = normalizeReadEnvelope(read)
      const envelope = parsedEnvelope(entry)
      if (read.envelopeId !== envelopeId || envelope.envelopeId !== envelopeId
        || envelope.accountId !== scope.accountId || envelope.deviceScopeId !== scope.deviceScopeId) {
        throw new Error(`Saved source envelope ancestry mismatch: ${envelopeId}.`)
      }
      return entry
    }))
    entries.push(...batch)
  }
  const byId = new Map(entries.map((entry) => [entry.envelopeId, entry]))
  const records = entries.filter((entry) => {
    const envelope = parsedEnvelope(entry)
    return envelope.vendorDataType === '25' && entry.kind === 'SDK_RECORD'
  }).map((entry) => {
    const envelope = parsedEnvelope(entry)
    const callback = typeof envelope.callbackId === 'string' ? byId.get(envelope.callbackId) ?? null : null
    const receiptId = callback ? parsedEnvelope(callback).notificationEnvelopeId : null
    const receipt = typeof receiptId === 'string' ? byId.get(receiptId) ?? null : null
    if (!callback || !receipt) throw new Error(`Saved Type25 provenance is incomplete: ${entry.envelopeId}.`)
    return buildCandidate(entry, callback, receipt)
  })
  if (!records.length) throw new Error('Saved attempt has no persisted Type25 SDK records.')
  const expectedCount = completeReport(savedResult)?.type25RecordsCaptured
  if (expectedCount !== undefined && expectedCount !== records.length) {
    throw new Error(`Saved Type25 record coverage is incomplete: expected ${expectedCount}, read ${records.length}.`)
  }
  return records
}

function persistResult(scope: SourceJournalScope, result: FailureResult): void {
  localStorage.setItem(`${RESULT_KEY}:${scope.accountId}:${scope.deviceScopeId}`, serializeCertificationJson(result))
}

function localTimeZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
  if (!zone) throw new Error('The device local time zone could not be resolved.')
  return zone
}

function buildCandidate(entry: SourceEnvelopeEntry, callback: SourceEnvelopeEntry | null, receipt: SourceEnvelopeEntry | null): Type25AnchorRecord & {
  callbackEnvelope: string | null
  receiptEnvelope: string | null
} {
  const envelope = parsedEnvelope(entry)
  const fields = type25SnapshotFields(envelope.sdkSnapshot)
  const parsedMs = typeof envelope.parsedSourceDateMillis === 'number' && Number.isFinite(envelope.parsedSourceDateMillis)
    ? envelope.parsedSourceDateMillis : null
  return {
    sourceEnvelopeId: entry.envelopeId,
    sourceEnvelope: entry.envelopeJson!,
    vendorDate: typeof fields.date === 'string' ? fields.date : typeof envelope.sourceDate === 'string' ? envelope.sourceDate : null,
    parsedDateMs: parsedMs,
    timezone: typeof envelope.timezone === 'string' ? envelope.timezone : entry.timezone,
    callbackTimestamp: callback?.receivedAt ?? null,
    receiptTimestamp: receipt?.receivedAt ?? null,
    payloadFingerprint: stableJson(fields),
    detailMinterStep: fields.detailMinterStep,
    arraySteps: fields.arraySteps,
    callbackEnvelope: callback?.envelopeJson ?? null,
    receiptEnvelope: receipt?.envelopeJson ?? null,
  }
}

function nativeDataEnd(evidence: PhysicalSemanticNativeEvidence | null): boolean {
  const diagnostics = mapText(evidence?.diagnostics)
  const dataEnd = mapText(diagnostics.dataEndByType)
  return dataEnd['25'] === true
}

function nativeType25Only(evidence: PhysicalSemanticNativeEvidence | null): boolean {
  const diagnostics = mapText(evidence?.diagnostics)
  return evidence?.kind === 'activity_type25_anchor'
    && evidence.commandsAllowed === true
    && JSON.stringify(evidence.commandTypes ?? []) === JSON.stringify(['25'])
    && diagnostics.type24Requested === false
    && diagnostics.type24CommandWritten === false
    && evidence.commands.every((command) => command.allowed && command.name.startsWith('GetDetailActivityDataWithMode'))
    && mapText(diagnostics).unexpectedCallbackTypes instanceof Array
    && (mapText(diagnostics).unexpectedCallbackTypes as unknown[]).length === 0
}

function completeReport(result: FailureResult): AnchorReport | null {
  return result.result && typeof result.result === 'object' && 'transitions' in result.result
    ? result.result as AnchorReport : null
}

function updateResult(result: FailureResult, update: Partial<FailureResult>): FailureResult {
  return { ...result, ...update }
}

type Type25AnchorTestProps = {
  context: Type42ConnectedContext | null
  ownerUserId: string
  eligibility: PhysicalSemanticEligibility
  setBusy(value: boolean): void
  workoutActive: boolean
  onTestActiveChange(active: boolean): void
}

export function Type25AnchorTest(props: Type25AnchorTestProps) {
  return <ScopedType25AnchorTest
    key={`${props.ownerUserId}:${props.eligibility.journalScope?.accountId}:${props.eligibility.journalScope?.deviceScopeId}`}
    {...props}
  />
}

function ScopedType25AnchorTest({
  context, ownerUserId, eligibility, setBusy, workoutActive, onTestActiveChange,
}: Type25AnchorTestProps) {
  const scope = useMemo(() => {
    const current = eligibility.journalScope
    return current && current.accountId === ownerUserId && current.deviceScopeId
      ? { accountId: current.accountId, deviceScopeId: current.deviceScopeId } : null
  }, [eligibility.journalScope, ownerUserId])
  const stored = useMemo(() => {
    const empty = { result: null, refresh: null, analysis: null, error: '' }
    if (!scope) return empty
    let analysis: SavedType25Analysis | null = null
    try {
      analysis = latestAnalysis(readStoredAnalysis(scope, ':analysis'), readStoredAnalysis(scope, ':recovery'))
    } catch { /* A corrupt analysis is ignored; it can be regenerated from saved evidence with zero BLE. */ }
    try {
      return { result: readStored(scope), refresh: readStored(scope, ':refresh'), analysis, error: '' }
    } catch (error) {
      return { ...empty, analysis, error: `Saved Type25 anchor result could not be read: ${error instanceof Error ? error.message : String(error)}` }
    }
  }, [scope])
  const [savedResult, setSavedResult] = useState<FailureResult | null>(stored.result)
  const [savedAnalysis, setSavedAnalysis] = useState<SavedType25Analysis | null>(
    stored.analysis && stored.result && stored.analysis.original_attempt_id === stored.result.attempt_id ? stored.analysis : null)
  const [analysisShown, setAnalysisShown] = useState(false)
  const [evidenceError, setEvidenceError] = useState('')
  const [refreshResult, setRefreshResult] = useState<FailureResult | null>(stored.refresh)
  const [display, setDisplay] = useState({ minute: 0, instruction: 'Ready', remainingSeconds: 0, phase: 'idle' })
  const [status, setStatus] = useState(stored.error)
  const [running, setRunning] = useState(false)
  const executing = useRef(false)
  const savedScopeRef = useRef<SourceJournalScope | null>(scope)

  const authenticatedOwnerValid = Boolean(eligibility.authenticatedOwner?.trim())
  const ownerMatches = authenticatedOwnerValid
    && eligibility.authenticatedOwner === ownerUserId
    && eligibility.connectorOwner === ownerUserId
    && eligibility.journalScope?.accountId === ownerUserId
    && context?.scope.accountId === ownerUserId
  const blockers = [
    ...(!eligibility.ready ? ['V8_NOT_READY'] : []),
    ...(!ownerMatches ? ['OWNER_ACCOUNT_MISMATCH'] : []),
    ...(!eligibility.sourceJournalBound || !scope ? ['SOURCE_JOURNAL_NOT_BOUND'] : []),
    ...(eligibility.connectionBusy ? ['CONNECTION_BUSY'] : []),
    ...(eligibility.productionSyncActive ? ['PRODUCTION_SYNC_ACTIVE'] : []),
    ...(eligibility.physicalTestActive ? ['PHYSICAL_TEST_ACTIVE'] : []),
    ...(workoutActive ? ['WORKOUT_ACTIVE'] : []),
    ...(!context ? ['PHYSICAL_CONTEXT_NOT_RESOLVED'] : []),
    ...(context && (!context.physical || !context.native) ? ['PHYSICAL_NATIVE_DEVICE_REQUIRED'] : []),
    ...(context && scope && context.scope.deviceScopeId !== scope.deviceScopeId ? ['DEVICE_SCOPE_MISMATCH'] : []),
  ]

  const savedScopeMatches = Boolean(savedResult && scope && savedResult.owner_account === scope.accountId
    && savedResult.device_scope_id === scope.deviceScopeId)
  const baseEligibility = type25RefreshEligibility(savedResult, [savedAnalysis])
  const refreshEligibility = !baseEligibility.enabled ? baseEligibility
    : !savedScopeMatches ? { enabled: false, reasons: ['SAVED_ATTEMPT_SCOPE_MISMATCH'], refreshReason: null }
      : evidenceError ? { enabled: false, reasons: ['SAVED_SOURCE_EVIDENCE_UNREADABLE'], refreshReason: null }
        : baseEligibility

  async function analyzeSaved(): Promise<void> {
    if (executing.current || !scope || !savedResult) return
    executing.current = true
    setRunning(true)
    setSavedAnalysis(null)
    try {
      const transitions = savedType25Transitions(savedResult)
      const records = await loadSavedType25Records(scope, savedResult)
      const preliminary = buildType25RecoveryAnalysis({
        originalAttemptId: savedResult.attempt_id!, originalRecords: records, refreshedRecords: [], transitions,
        refreshReason: '', bleAcquisitions: 0,
        protectedWrites: { queueWrites: 0, base44Calls: 0, canonicalWrites: 0, readinessWrites: 0 },
      })
      const gate = type25RefreshEligibility(savedResult, [preliminary])
      const analysis: SavedType25Analysis = {
        ...preliminary,
        refreshReason: gate.refreshReason ?? (type25SemanticResolutionAchieved(preliminary)
          ? 'NOT_REQUIRED: unique semantic resolution achieved from saved records.'
          : `REFRESH_NOT_ELIGIBLE: ${gate.reasons.join(', ')}`),
      }
      setEvidenceError('')
      localStorage.setItem(`${RESULT_KEY}:${scope.accountId}:${scope.deviceScopeId}:analysis`, serializeCertificationJson(analysis))
      setSavedAnalysis(analysis)
      setStatus(`Saved-only analysis: ${records.length} records; invariants ${analysis.allRecordInvariantsPass ? 'PASS' : 'FAIL'}; `
        + `${analysis.overlappingRecordCount} records possibly overlap the saved window. BLE acquisitions=0. `
        + (type25SemanticResolutionAchieved(analysis)
          ? `Unique model ${analysis.selectedTimestampModel}; refresh not required.`
          : 'Anchor unresolved — Refresh Saved Type25 Anchor History is available; do not repeat the pattern.'))
    } catch (error) {
      setEvidenceError(error instanceof Error ? error.message : String(error))
      setStatus(`Saved Type25 analysis failed: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      executing.current = false
      setRunning(false)
    }
  }

  async function run(refreshParent?: FailureResult): Promise<void> {
    if (executing.current) return
    if (blockers.length || !scope || !context) {
      setStatus(`BLOCKED — ${blockers.join(', ') || 'PHYSICAL_CONTEXT_NOT_RESOLVED'}`)
      return
    }
    let timezone: string
    let reusedTransitions: MinuteTransition[] | null = null
    let originalRecords: CandidateWithProvenance[] = []
    let refreshedRecords: CandidateWithProvenance[] = []
    let refreshReason = ''
    try {
      if (refreshParent) {
        if (!refreshEligibility.enabled) {
          throw new Error(`Refresh is not eligible: ${refreshEligibility.reasons.join(', ')}.`)
        }
        refreshReason = refreshEligibility.refreshReason ?? ''
        reusedTransitions = savedType25Transitions(refreshParent)
        if (Date.now() < reusedTransitions[0].epochMs + 12 * MINUTE_MS + PERSISTENCE_WAIT_MS) {
          throw new Error('The saved controlled window and device persistence wait have not elapsed.')
        }
        timezone = refreshParent.timezone ?? localTimeZone()
        originalRecords = await loadSavedType25Records(scope, refreshParent)
      } else timezone = localTimeZone()
    } catch (error) {
      if (refreshParent) setEvidenceError(error instanceof Error ? error.message : String(error))
      setStatus(`Type25 anchor test cannot start: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
    executing.current = true
    setRunning(true)
    setBusy(true)
    onTestActiveChange(true)
    const monotonicStartMarker = performance.now()
    const initial = newPhysicalResult('activity_type25_anchor', {
      v8_state: eligibility.ready ? 'READY' : 'UNKNOWN',
      authenticated_owner_resolved: ownerMatches,
      owner_scope_resolved: ownerMatches,
      journal_bound: eligibility.sourceJournalBound,
      device_scope_resolved: Boolean(scope.deviceScopeId),
    })
    initial.status = 'STARTING'
    initial.build = TYPE25_RECOVERY_BUILD
    initial.diagnostics = {
      ...initial.diagnostics,
      test_type: 'activity_type25_anchor',
      device_scope_id: scope.deviceScopeId,
      owner_account: scope.accountId,
      timezone,
      monotonic_start_marker_ms: monotonicStartMarker,
      progress: 'Waiting for sender quiescence',
      ...(refreshParent ? { parent_attempt_id: refreshParent.attempt_id, action: 'Refresh Saved Type25 Anchor History',
        controlledTransitions: reusedTransitions, refreshReason } : {}),
    }
    initial.device_scope_id = scope.deviceScopeId
    initial.owner_account = scope.accountId
    initial.timezone = timezone
    initial.monotonic_start_marker_ms = monotonicStartMarker
    if (refreshParent) initial.retry_of_attempt_id = refreshParent.attempt_id
    let beforeQueue: StableQueueState | null = null
    let beforeEffects: ReturnType<typeof physicalTestIsolationSnapshot> | null = null
    let afterQueue: StableQueueState | null = null
    let beforeSenderGeneration: number | null = null
    let senderResumeAt: string | null = null
    const checkpoint = (value: FailureResult) => {
      if (refreshParent) {
        localStorage.setItem(`${RESULT_KEY}:${scope.accountId}:${scope.deviceScopeId}:refresh`, serializeCertificationJson(value))
      } else persistResult(scope, value)
      if (savedScopeRef.current?.accountId === scope.accountId
        && savedScopeRef.current.deviceScopeId === scope.deviceScopeId) {
        if (refreshParent) setRefreshResult(structuredClone(value))
        else setSavedResult(structuredClone(value))
      }
    }
    const batchRead = async (ids: readonly string[]) => {
      const entries: SourceEnvelopeEntry[] = []
      for (let offset = 0; offset < ids.length; offset += 20) {
        const batch = await Promise.all(ids.slice(offset, offset + 20).map((envelopeId) =>
          JCVitalV8.readSourceEnvelope({ ...scope, envelopeId })))
        entries.push(...batch.map(normalizeReadEnvelope))
      }
      return entries
    }
    try {
      const result = await executePhysicalAttempt(initial, {
        checkpoint,
        markAttempt: () => checkpoint(initial),
        quiesce: (attempt) => {
          setStatus('Blocking new sender claims; waiting for current in-flight work to finish.')
          const coordinator = requestPhysicalTestQuiescence(observationBatchManager, observationQueue, scope.accountId, (inFlight) => {
            attempt.result.diagnostics.progress = `Waiting for ${inFlight} in-flight queue rows`
            checkpoint(attempt.result)
            setStatus(`Sender quiescence requested. Current in-flight queue rows: ${inFlight}.`)
          })
          attempt.result.diagnostics.senderQuiescence = coordinator.evidence
          return {
            wait: async () => {
              await coordinator.wait()
              setStatus('Sender quiesced.')
            },
            resume: () => {
              try { coordinator.resume() }
              finally {
                senderResumeAt = coordinator.evidence.sender_resumed_at
                attempt.result.isolation_released_at = coordinator.evidence.isolation_released_at
                attempt.result.sender_resumed_at = coordinator.evidence.sender_resumed_at
              }
            },
          }
        },
        lock: () => {
          setStatus('Sender quiesced. Acquiring physical-test isolation.')
          return beginPhysicalTestIsolation()
        },
        begin: async (attemptId) => {
          const state = await JCVitalV8.getConnectionState()
          if (state.state !== 'READY') throw Object.assign(new Error('V8 disconnected before Type25 test acquisition.'), { code: 'V8_NOT_READY' })
          initial.status = 'RUNNING'
          initial.diagnostics.progress = refreshParent ? 'Refreshing history using saved controlled timestamps' : 'Starting 12-minute controlled pattern'
          checkpoint(initial)
          return JCVitalV8.beginPhysicalSemanticTest({ kind: 'activity_type25_anchor', attemptId })
        },
        end: () => JCVitalV8.endPhysicalSemanticTest(),
        readNative: async () => {
          const saved = await JCVitalV8.readPhysicalSemanticTestEvidence({ ...scope, kind: 'activity_type25_anchor' })
          return saved.json ? JSON.parse(saved.json) as PhysicalSemanticNativeEvidence : null
        },
        preflight: async (attempt) => {
          beforeEffects = physicalTestIsolationSnapshot()
          const [queue, sender] = await Promise.all([
            observationQueue.getQueueStats(),
            Promise.resolve(observationBatchManager.getPhysicalTestSenderState()),
          ])
          beforeSenderGeneration = observationBatchManager.getDeliveryDiagnostics().senderGeneration
          beforeQueue = stableQueue(queue)
          attempt.result.queue_before = { ...beforeQueue }
          if (queue.inFlight > 0 || sender.activeRequest || sender.activeWorkers > 0 || sender.claimOwner !== null
            || sender.startupOperations > 0 || physicalTestIsolationSnapshot().senderPause !== 'PHYSICAL_TEST_QUIESCED') {
            throw Object.assign(new Error('Queue or sender is not quiescent; no queue mutation is permitted.'), { code: 'ISOLATION_DELIVERY_NOT_IDLE' })
          }
        },
        run: async (attempt, finish) => {
          let wakeLock: WakeLockSentinel | null = null
          try {
            if ('wakeLock' in navigator) {
              try { wakeLock = await navigator.wakeLock.request('screen') }
              catch (error) { setStatus(`Screen wake lock unavailable; keep the display awake. ${error instanceof Error ? error.message : String(error)}`) }
            } else {
              setStatus('Screen wake lock is unsupported; keep the display awake and this app in the foreground.')
            }
            let controlStart: number | null = null
            const transitions: MinuteTransition[] = reusedTransitions ? structuredClone(reusedTransitions) : []
            const waitUntil = async (deadline: number, label: string) => {
              while (true) {
                if (document.visibilityState !== 'visible') {
                  throw Object.assign(new Error('The guided test left the foreground; discard this attempt and start a fresh pattern.'), { code: 'GUIDED_TEST_LEFT_FOREGROUND' })
                }
                const remaining = deadline - performance.now()
                if (remaining <= 0) return
                const remainingSeconds = Math.ceil(remaining / 1000)
                setDisplay((current) => ({ ...current, remainingSeconds, phase: label }))
                await new Promise((resolve) => window.setTimeout(resolve, Math.min(250, remaining)))
              }
            }
            if (!reusedTransitions) {
              for (let index = 0; index < CONTROLLED_MINUTE_PATTERN.length; index++) {
                if (index > 0) await waitUntil(controlStart! + index * MINUTE_MS, 'guided pattern')
                const instruction = CONTROLLED_MINUTE_PATTERN[index]
                flushSync(() => setDisplay({
                  minute: index + 1, instruction,
                  remainingSeconds: 60, phase: 'guided pattern',
                }))
                const date = new Date()
                const transition = {
                  minute: index + 1,
                  instruction,
                  localTimestamp: localTimestamp(date),
                  epochMs: date.getTime(),
                  monotonicMs: performance.now(),
                } satisfies MinuteTransition
                controlStart ??= transition.monotonicMs
                transitions.push(transition)
                attempt.result.diagnostics.controlledTransitions = transitions
                attempt.result.diagnostics.control_window_monotonic_start_ms = transitions[0].monotonicMs
                attempt.result.diagnostics.progress = `Minute ${transition.minute} — ${transition.instruction}`
                checkpoint(attempt.result)
                setStatus(`Minute ${transition.minute} of 12 — ${transition.instruction}`)
              }
              await waitUntil(controlStart! + CONTROLLED_MINUTE_PATTERN.length * MINUTE_MS, 'pattern complete')
              flushSync(() => setDisplay({ minute: 12, instruction: 'STILL', remainingSeconds: 75, phase: 'device persistence wait' }))
              const waitStarted = performance.now()
              while (performance.now() - waitStarted < PERSISTENCE_WAIT_MS) {
                if (document.visibilityState !== 'visible') {
                  throw Object.assign(new Error('The device-persistence wait left the foreground; this attempt is invalid.'), { code: 'GUIDED_TEST_LEFT_FOREGROUND' })
                }
                const remainingSeconds = Math.ceil((PERSISTENCE_WAIT_MS - (performance.now() - waitStarted)) / 1000)
                setDisplay({ minute: 12, instruction: 'STILL', remainingSeconds, phase: 'device persistence wait' })
                await new Promise((resolve) => window.setTimeout(resolve, 250))
              }
            }
            setDisplay({ minute: 12, instruction: 'STILL', remainingSeconds: 0, phase: 'Type25 history acquisition' })
            setStatus('Pattern complete. Requesting Type25 detailed history only.')
            attempt.result.diagnostics.progress = 'Requesting Type25 history'
            checkpoint(attempt.result)
            const acquisition = await JCVitalV8.syncDetailedActivity()
            if (acquisition.vendorDataType !== '25') throw new Error(`Unexpected history data type: ${acquisition.vendorDataType}`)
            if (!['COMPLETE', 'EMPTY_VALID'].includes(acquisition.completionStatus)) {
              throw new Error(`Type25 history did not reach dataEnd: ${acquisition.completionStatus}`)
            }
            const recordIds = acquisition.sourceRecordEnvelopeIds ?? []
            const callbackIds = acquisition.sourceCallbackEnvelopeIds ?? []
            const nativeIds = attempt.result.native_evidence?.sourceEnvelopeIds ?? []
            const envelopeIds = [...new Set([...recordIds, ...callbackIds, ...nativeIds])]
            if (recordIds.length === 0 && !refreshParent) {
              throw new Error('Type25 history completed without persisted Type25 source-record envelopes. No model selected; retain the saved pattern.')
            }
            const entries = await batchRead(envelopeIds)
            const missing = envelopeIds.filter((id) => !entries.some((entry) => entry.envelopeId === id && entry.envelopeJson))
            if (missing.length) throw new Error(`Type25 source evidence is missing persisted envelopes: ${missing.join(', ')}`)
            const callbacks = entries.filter((entry) => callbackIds.includes(entry.envelopeId))
            const recordEntries = entries.filter((entry) => recordIds.includes(entry.envelopeId))
            if (callbacks.length !== callbackIds.length) throw new Error('At least one Type25 callback envelope is missing.')
            if (recordEntries.some((entry) => object(JSON.parse(entry.envelopeJson ?? '{}')).vendorDataType !== '25')) {
              throw new Error('A non-Type25 source record appeared in the Type25-only acquisition.')
            }
            const notificationRefs = callbacks.map((entry) => {
              const callbackEnvelope = parsedEnvelope(entry)
              const id = callbackEnvelope.notificationEnvelopeId
              return typeof id === 'string' ? id : null
            })
            if (notificationRefs.some((id) => id === null)) {
              throw new Error('A Type25 callback has no persisted source-notification reference.')
            }
            const notificationIds = [...new Set(notificationRefs.filter((id): id is string => id !== null))]
            const receipts = await batchRead(notificationIds)
            const allEvidence = [...entries, ...receipts]
            const missingEvidence = [...envelopeIds, ...notificationIds].filter((id) =>
              !allEvidence.some((entry) => entry.envelopeId === id && entry.envelopeJson))
            if (missingEvidence.length) throw new Error(`Complete Type25 source evidence could not be verified: ${missingEvidence.join(', ')}`)
            attempt.result.diagnostics.sourceEvidencePersistedBeforeAnalysis = {
              persistedBeforeAnalysis: true,
              sourceJournalUsed: true,
              envelopeIds: allEvidence.map((entry) => entry.envelopeId),
              verifiedEnvelopeCount: allEvidence.filter((entry) => entry.envelopeJson !== null).length,
              allReferencedSourceEvidenceVerified: true,
              savedAt: new Date().toISOString(),
            }
            checkpoint(attempt.result)
            attempt.result.diagnostics.acquisition = acquisition
            attempt.result.source_journal_refs = allEvidence.map((entry) => entry.envelopeId)
            await finish()
            const native = attempt.result.native_evidence
            const dataEndReached = nativeDataEnd(native)
            if (!dataEndReached) throw new Error('Native evidence did not confirm the Type25 dataEnd terminal callback.')
            const callbackById = new Map(callbacks.map((entry) => [entry.envelopeId, entry]))
            const receiptById = new Map(receipts.map((entry) => [entry.envelopeId, entry]))
            const sourceRecords = recordEntries.map((entry) => {
              const envelope = parsedEnvelope(entry)
              const callbackId = typeof envelope.callbackId === 'string' ? envelope.callbackId : null
              const callback = callbackId ? callbackById.get(callbackId) ?? null : null
              const receiptId = callback ? parsedEnvelope(callback).notificationEnvelopeId : null
              const receipt = typeof receiptId === 'string' ? receiptById.get(receiptId) ?? null : null
              return buildCandidate(entry, callback, receipt)
            })
            refreshedRecords = sourceRecords
            const analyzedRecords = refreshParent
              ? combineType25Records(originalRecords, sourceRecords).records as CandidateWithProvenance[] : sourceRecords
            const analysis = evaluateType25MinuteAnchor(analyzedRecords, transitions)
            attempt.result.diagnostics.savedRecordAnalysis = buildType25RecoveryAnalysis({
              originalAttemptId: refreshParent?.attempt_id ?? attempt.result.attempt_id!,
              refreshAttemptId: refreshParent ? attempt.result.attempt_id : null,
              originalRecords: refreshParent ? originalRecords : sourceRecords,
              refreshedRecords: refreshParent ? sourceRecords : [],
              transitions, refreshReason, bleAcquisitions: 1,
              protectedWrites: { queueWrites: 0, base44Calls: 0, canonicalWrites: 0, readinessWrites: 0 },
              refreshIsolationPassed: false,
            })
            const sourceById = new Map(analyzedRecords.map((record) => [record.sourceEnvelopeId, record]))
            const records: CandidateReport[] = analysis.records.map((record) => {
              const provenance = sourceById.get(record.sourceEnvelopeId)
              if (!provenance) throw new Error(`Candidate source provenance is missing for ${record.sourceEnvelopeId}.`)
              return {
                ...record,
                callbackEnvelope: provenance.callbackEnvelope,
                receiptEnvelope: provenance.receiptEnvelope,
              sumArraySteps: typeof record.arraySteps === 'string'
                ? record.arraySteps.trim().split(/\s+/).map(Number).reduce((sum, value) => sum + value, 0) : null,
              arrayLength: typeof record.arraySteps === 'string' ? record.arraySteps.trim().split(/\s+/).length : 0,
              }
            })
            const selected = analysis.selected
            const maxTimingErrorMs = selected?.maximumTimingErrorMs ?? null
            const nativeDiagnostics = mapText(native?.diagnostics)
            const recordCounts = mapText(nativeDiagnostics.recordsByType)
            attempt.result.result = {
              physicalTest: 'FAIL',
              attempt_id: attempt.result.attempt_id!,
              device_scope_id: scope.deviceScopeId,
              owner_account: scope.accountId,
              started_at: attempt.result.started_at!,
              timezone,
              monotonic_start_marker_ms: attempt.result.monotonic_start_marker_ms!,
              transitions,
              type25RecordsCaptured: typeof recordCounts['25'] === 'number' ? recordCounts['25'] : recordIds.length,
              sourceJournalEvidence: {
                persistedBeforeAnalysis: true,
                envelopeIds: allEvidence.map((entry) => entry.envelopeId),
                verifiedEnvelopeCount: allEvidence.filter((entry) => entry.envelopeJson !== null).length,
                candidateProvenanceComplete: records.every((record) => Boolean(record.callbackTimestamp
                    && record.receiptTimestamp && record.callbackEnvelope && record.receiptEnvelope
                    && record.timezone === timezone)),
                dataEndReached,
                completionStatus: acquisition.completionStatus,
              },
              records,
              fits: analysis.fits,
              arrayLength: records[0]?.arrayLength ?? null,
              sumArrayStepsEqualsDetailMinterStep: analysis.invariantPass ? 'PASS' : 'FAIL',
              selectedTimestampModel: selected ? `${selected.anchor} + ${selected.ordering}` : null,
              type25DateMeans: selected?.anchor ?? 'OTHER',
              arrayOrdering: selected?.ordering ?? null,
              slotDurationSeconds: 60,
              controlledPatternMatch: analysis.patternPass ? 'PASS' : 'FAIL',
              maximumTimingErrorMs: maxTimingErrorMs,
              overlappingConflictingRecords: analysis.fits.flatMap((fit) => fit.conflicts),
              canonicalMinuteTimestampsDeterministic: selected && analysis.patternPass ? 'YES' : 'NO',
              semanticPolicy: selected && analysis.patternPass ? {
                name: 'jcvital.type25.minute_anchor.v1',
                anchor: selected.anchor,
                ordering: selected.ordering,
                slot_duration_seconds: 60,
                segment_slots: 10,
              } : null,
              queueWrites: 0,
              base44Calls: 0,
              canonicalWrites: 0,
              readinessWrites: 0,
              isolationPassed: false,
              senderResumed: false,
              readyForActivityProductionFinalization: 'NO',
            } satisfies AnchorReport
            attempt.result.diagnostics.anchorAnalysis = {
              uniqueBest: analysis.uniqueBest,
              invariantPass: analysis.invariantPass,
              patternPass: analysis.patternPass,
              conflictingRecords: analysis.conflictingRecords,
              sourceEvidencePersistedBeforeAnalysis: true,
            }
            checkpoint(attempt.result)
            return attempt.result.result
          } finally {
            if (wakeLock) await wakeLock.release()
          }
        },
        finalize: async (result) => {
          const effects = physicalTestIsolationSnapshot()
          afterQueue = stableQueue(await observationQueue.getQueueStats())
          result.queue_after = { ...afterQueue }
          result.base44_calls = beforeEffects ? effects.counts.base44 - beforeEffects.counts.base44 : null
          result.queue_delta = beforeEffects ? effects.counts.queue - beforeEffects.counts.queue : null
          result.ack_mutations = beforeQueue && afterQueue ? afterQueue.acknowledged - beforeQueue.acknowledged : null
          const senderAfter = observationBatchManager.getDeliveryDiagnostics()
          const senderStateAfter = observationBatchManager.getPhysicalTestSenderState()
          result.diagnostics.physicalTestIsolation = {
            queueWrites: result.queue_delta,
            base44Calls: result.base44_calls,
            canonicalWrites: 0,
            readinessWrites: 0,
            queueUnchanged: Boolean(beforeQueue && afterQueue && JSON.stringify(beforeQueue) === JSON.stringify(afterQueue)),
            acknowledgementsUnchanged: result.ack_mutations === 0,
            senderGenerationDelta: beforeSenderGeneration === null ? null : senderAfter.senderGeneration - beforeSenderGeneration,
            senderIdleBeforeResume: !senderStateAfter.activeRequest && senderStateAfter.activeWorkers === 0
              && senderStateAfter.claimOwner === null && senderStateAfter.startupOperations === 0
              && afterQueue.inFlight === 0,
            blockedOperations: effects.blocked,
            senderWasQuiesced: physicalTestIsolationSnapshot().senderPause === 'PHYSICAL_TEST_QUIESCED',
          }
        },
        persist: checkpoint,
        backup: (value) => sessionStorage.setItem(`${evidenceKey('activity_type25_anchor', scope)}${refreshParent ? ':refresh' : ''}`, serializeCertificationJson(value)),
      })
      let final = result
      const report = completeReport(result)
      const isolation = mapText(result.diagnostics.physicalTestIsolation)
      const senderAfterCleanup = observationBatchManager.getPhysicalTestSenderState()
      const senderResumed = Boolean(result.sender_resumed_at && senderResumeAt
        && senderAfterCleanup.started && !senderAfterCleanup.paused)
      if (report) {
        const queueWrites = typeof result.queue_delta === 'number' ? result.queue_delta : -1
        const base44Calls = typeof result.base44_calls === 'number' ? result.base44_calls : -1
        const isolationPassed = queueWrites === 0 && base44Calls === 0
          && result.ack_mutations === 0 && isolation.queueUnchanged === true
          && isolation.acknowledgementsUnchanged === true
          && isolation.senderGenerationDelta === 0 && isolation.senderIdleBeforeResume === true
          && Array.isArray(isolation.blockedOperations)
          && (isolation.blockedOperations as unknown[]).every((operation) => operation === 'sender')
        const native = result.native_evidence
        const passed = result.status === 'COMPLETE'
          && report.sourceJournalEvidence.dataEndReached
          && report.sourceJournalEvidence.candidateProvenanceComplete
          && report.records.length > 0
          && report.records.every((record) => record.arrayLength === 10)
          && report.sumArrayStepsEqualsDetailMinterStep === 'PASS'
          && report.canonicalMinuteTimestampsDeterministic === 'YES'
          && report.controlledPatternMatch === 'PASS'
          && report.overlappingConflictingRecords.length === 0
          && nativeType25Only(native)
          && isolationPassed && senderResumed
        const completed = {
          ...report,
          physicalTest: passed ? 'PASS' as const : 'FAIL' as const,
          queueWrites,
          base44Calls,
          isolationPassed,
          senderResumed,
          readyForActivityProductionFinalization: passed ? 'YES' as const : 'NO' as const,
        }
        final = updateResult(result, {
          result: completed,
          diagnostics: { ...result.diagnostics, physicalTestAccepted: passed },
        })
      }
      if (refreshParent && final.status === 'COMPLETE' && final.diagnostics.savedRecordAnalysis) {
        const finalReport = completeReport(final)
        const recovery = buildType25RecoveryAnalysis({
          originalAttemptId: refreshParent.attempt_id!, refreshAttemptId: final.attempt_id ?? null,
          originalRecords, refreshedRecords,
          transitions: reusedTransitions!, refreshReason, bleAcquisitions: 1,
          protectedWrites: {
            queueWrites: finalReport?.queueWrites ?? -1, base44Calls: finalReport?.base44Calls ?? -1,
            canonicalWrites: 0, readinessWrites: 0,
          },
          refreshIsolationPassed: Boolean(finalReport?.isolationPassed && finalReport.senderResumed),
        })
        final = updateResult(final, { diagnostics: { ...final.diagnostics, savedRecordAnalysis: recovery } })
        localStorage.setItem(`${RESULT_KEY}:${scope.accountId}:${scope.deviceScopeId}:recovery`, serializeCertificationJson(recovery))
        if (savedScopeRef.current?.accountId === scope.accountId
          && savedScopeRef.current.deviceScopeId === scope.deviceScopeId) setSavedAnalysis(recovery)
      }
      checkpoint(final)
      if (refreshParent) {
        const delayed = final.diagnostics.savedRecordAnalysis as SavedType25Analysis | undefined
        const newOverlap = Boolean(delayed && refreshedRecords.some((record) =>
          delayed.overlappingRecordIds.includes(record.sourceEnvelopeId)))
        setStatus(final.status !== 'COMPLETE'
          ? `Delayed Type25 refresh failed: ${final.error_message ?? 'inspect saved refresh evidence'}. Do not repeat the physical pattern on a refresh error.`
          : delayed && type25SemanticResolutionAchieved(delayed)
            ? `PASS — saved + refreshed Type25 history uniquely supports ${delayed.selectedTimestampModel} using the saved pattern.`
            : !newOverlap
              ? 'Delayed Type25 refresh completed without usable new overlapping records. Only now consider a separate decision to repeat the physical pattern.'
              : 'Delayed history contains new overlapping records but no accepted unique model. Inspect Saved Type25 Analysis JSON; do not repeat the pattern.')
      } else {
        setStatus(completeReport(final)?.physicalTest === 'PASS'
          ? 'PASS — Type25 timestamp anchor uniquely established. P1-2C remains a separate gated step.'
          : 'FAIL — inspect the saved Type25 anchor evidence; production finalization remains blocked.')
      }
    } catch (error) {
      setStatus(`Type25 anchor test stopped: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      executing.current = false
      setRunning(false)
      onTestActiveChange(false)
      setBusy(false)
      setDisplay((current) => ({ ...current, phase: 'complete' }))
    }
  }

  const report = savedResult ? completeReport(savedResult) : null
  const hasSavedControlledPattern = report?.transitions.length === 12
    || (Array.isArray(savedResult?.diagnostics.controlledTransitions)
      && savedResult.diagnostics.controlledTransitions.length === 12)
  const resultJson = savedResult ? serializeCertificationJson(savedResult) : ''
  const analysisJson = savedAnalysis ? serializeCertificationJson(savedAnalysis) : ''
  async function copyAnalysis(): Promise<void> {
    if (!analysisJson) return
    try {
      await navigator.clipboard.writeText(analysisJson)
      setStatus(`Saved Type25 analysis JSON copied (${savedAnalysis!.recovery_build}).`)
    } catch (error) {
      setStatus(`Saved analysis copy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  async function shareAnalysis(): Promise<void> {
    if (!analysisJson) return
    try {
      const location = await saveValidationJson(RECOVERY_ANALYSIS_FILENAME, analysisJson,
        'Elite+ P1-2B Type25 recovery analysis', 'Share / Save Saved Type25 Analysis JSON')
      setStatus(`Saved Type25 analysis JSON shared / saved: ${location}`)
    } catch (error) {
      setStatus(`Saved analysis share / save failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  async function copyResult(): Promise<void> {
    if (!resultJson) return
    try {
      await navigator.clipboard.writeText(resultJson)
      setStatus('Original Type25 physical attempt JSON copied.')
    } catch (error) {
      setStatus(`Type25 evidence copy failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  return <section aria-label="Validate Type25 Minute Anchor">
    <h4>Validate Type25 Minute Anchor</h4>
    <p>Engineering-only, source-journal-only physical test. It requests Type25 only after the guided pattern and persistence wait. No queue enqueue, Base44 call, canonical write, or readiness write is performed.</p>
    <p>Pattern: STILL · WALK · STILL · WALK · WALK · STILL · WALK · STILL · STILL · WALK · STILL · STILL.</p>
    <div className="wearable-actions">
      <button type="button" disabled={running || blockers.length > 0 || hasSavedControlledPattern} onClick={() => void run()}>
        {running ? 'Running Type25 Anchor Test…' : 'Validate Type25 Minute Anchor'}
      </button>
      <button type="button" disabled={running || !savedResult} onClick={() => void analyzeSaved()}>
        Analyze Saved Type25 Anchor Result (No BLE)
      </button>
      <button type="button" disabled={running || blockers.length > 0 || !refreshEligibility.enabled}
        onClick={() => savedResult && void run(savedResult)}>
        Refresh Saved Type25 Anchor History
      </button>
    </div>
    <p role="note">Refresh eligibility: {refreshEligibility.enabled
      ? `ENABLED — ${refreshEligibility.refreshReason}`
      : `DISABLED — ${refreshEligibility.reasons.join(', ')}`}</p>
    <div className="wearable-actions" aria-label="Saved Type25 analysis JSON controls">
      <button type="button" disabled={!savedAnalysis} onClick={() => setAnalysisShown((shown) => !shown)}>
        Show Saved Type25 Analysis JSON
      </button>
      <button type="button" disabled={!savedAnalysis} onClick={() => void copyAnalysis()}>Copy Saved Type25 Analysis JSON</button>
      <button type="button" disabled={!savedAnalysis} onClick={() => void shareAnalysis()}>Share / Save Saved Type25 Analysis JSON</button>
    </div>
    <div className="wearable-actions" aria-label="Original Type25 physical attempt controls">
      <button type="button" disabled={!savedResult} onClick={() => void copyResult()}>Copy Original Type25 Physical Attempt JSON</button>
      {savedResult && <button type="button" onClick={() => {
        const blob = new Blob([resultJson], { type: 'application/json' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = 'ElitePlus-P1-2B-Type25-Anchor-Result.json'
        link.click()
        URL.revokeObjectURL(url)
      }}>Save Original Type25 Physical Attempt JSON</button>}
    </div>
    <p role="status">Type25 anchor eligibility: {blockers.length ? `BLOCKED — ${blockers.join(', ')}` : 'ENABLED'}</p>
    {running && display.phase !== 'idle' && <section aria-label="Guided Type25 activity pattern" aria-live="assertive">
      <h5>{display.minute > 0 ? `Minute ${display.minute} of 12 — ${display.instruction}` : 'Preparing guided pattern'}</h5>
      <p>{display.phase === 'device persistence wait'
        ? `Pattern complete. Waiting ${display.remainingSeconds} seconds for device persistence.`
        : display.phase === 'Type25 history acquisition'
          ? 'Persistence wait complete. Reading Type25 history only.'
          : `${display.instruction} for ${display.remainingSeconds} seconds.`}</p>
    </section>}
    {status && <p role="status">{status}</p>}
    {savedResult && <p>Saved attempt: {savedResult.attempt_id}. Refresh reuses its 12 saved transitions; it never starts a guided pattern or requests Type24 or Workout data.</p>}
    {savedAnalysis && <p>Saved Type25 analysis: {savedAnalysis.recovery_build} · {savedAnalysis.analysis_run_at} ·
      original {savedAnalysis.original_record_count} / refreshed {savedAnalysis.refreshed_record_count} records ·
      model {savedAnalysis.selectedTimestampModel ?? 'UNRESOLVED'} · READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION ={' '}
      {savedAnalysis.READY_FOR_ACTIVITY_PRODUCTION_FINALIZATION}</p>}
    {savedAnalysis && analysisShown && <section aria-label="Saved Type25 analysis">
      <h5>Saved Type25 Recovery Analysis JSON ({savedAnalysis.recovery_build})</h5>
      <pre aria-label="Saved Type25 analysis JSON">{analysisJson}</pre>
    </section>}
    {refreshResult && <details open>
      <summary>Delayed Type25 history refresh result</summary>
      <pre aria-label="Type25 refresh result JSON">{JSON.stringify(refreshResult, null, 2)}</pre>
      <button type="button" onClick={() => {
        void navigator.clipboard.writeText(serializeCertificationJson(refreshResult)).then(
          () => setStatus('Delayed Type25 refresh evidence copied.'),
          (error: unknown) => setStatus(`Refresh evidence copy failed: ${error instanceof Error ? error.message : String(error)}`),
        )
      }}>Copy Type25 Refresh Evidence JSON</button>
    </details>}
    {savedResult && <details>
      <summary>Original Type25 physical attempt ({savedResult.build ?? 'unknown build'}) — not the recovery analysis</summary>
      <pre aria-label="Type25 anchor result JSON">{JSON.stringify(savedResult, null, 2)}</pre>
    </details>}
    {report?.semanticPolicy && <p>Validated semantic policy: {report.semanticPolicy.name} — {report.semanticPolicy.anchor}, {report.semanticPolicy.ordering}.</p>}
  </section>
}
