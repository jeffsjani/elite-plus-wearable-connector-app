import type { PhysicalSemanticNativeEvidence, SourceJournalScope } from './jcvitalV8Bridge'

export type TestKind = 'activity' | 'activity_type25_anchor' | 'workout'
export type TestStage = 'ELIGIBILITY_CONFIRMED' | 'OWNER_SCOPE_CONFIRMED' | 'SENDER_QUIESCE_REQUESTED' | 'SENDER_QUIESCED' | 'ISOLATION_LOCK_ACQUIRED'
  | 'NATIVE_BRIDGE_ENTERED' | 'NATIVE_SESSION_CREATED' | 'COMMAND_REQUESTED' | 'COMMAND_WRITTEN'
  | 'CALLBACK_RECEIVED' | 'SOURCE_JOURNALED' | 'RESULT_BUILT' | 'RESULT_PERSISTED' | 'COMPLETE'
export type FailureStage = TestStage | 'PREFLIGHT' | 'ISOLATION_PREFLIGHT' | 'CALLBACK_COLLECTION'
  | 'ISOLATION_FINALIZATION' | 'SOURCE_JOURNAL_PERSISTENCE' | 'RESULT_CONSTRUCTION' | 'RESULT_PERSISTENCE' | 'CLEANUP' | 'UNKNOWN'
export type FailureResult = {
  schema: 'eliteplus.v8.physical_semantic_test_result.v1'
  test_type: TestKind
  status: 'STARTING' | 'RUNNING' | 'FAILED' | 'COMPLETE'
  build?: 'v58' | 'v59' | 'v60' | 'v62' | 'v64'
  isolation_released_at?: string | null
  sender_resumed_at?: string | null
  attempt_id: string | null
  device_scope_id?: string
  owner_account?: string
  timezone?: string
  monotonic_start_marker_ms?: number
  retry_of_attempt_id?: string | null
  started_at: string | null
  failed_at: string | null
  last_completed_stage: TestStage | null
  current_stage?: FailureStage
  failure_stage: FailureStage | null
  error_code: string | null
  error_message: string | null
  native_error_code: string | null
  native_error_message: string | null
  exception_class: string | null
  v8_state: string
  authenticated_owner_resolved: boolean | null
  owner_scope_resolved: boolean | null
  journal_bound: boolean | null
  device_scope_resolved: boolean | null
  native_invocation_started: boolean | null
  acquisition_started: boolean | null
  ble_commands_issued: number | null
  command_types: string[] | null
  callbacks_received: number | null
  source_envelopes_written: number | null
  queue_before: Record<string, unknown> | null
  queue_after: Record<string, unknown> | null
  queue_delta: number | null
  base44_calls: number | null
  sender_calls: number | null
  ack_mutations: number | null
  partial_evidence_present: boolean | null
  source_journal_refs: string[]
  retry_disposition: 'SAFE_TO_RETRY_NO_DEVICE_COMMAND' | 'DEVICE_COMMAND_ISSUED_REVIEW_FIRST'
    | 'PARTIAL_SOURCE_EVIDENCE_REVIEW_FIRST' | 'RETRY_NOT_ALLOWED'
  stages: Array<{ stage: TestStage; at: string }>
  native_evidence: PhysicalSemanticNativeEvidence | null
  diagnostics: Record<string, unknown>
  inspected_stores: string[]
  recovery_errors: string[]
  persistence_errors: string[]
  cleanup_errors: string[]
  result: unknown
}

export function evidenceKey(kind: TestKind, scope: SourceJournalScope) {
  return `v8PhysicalSemanticTest.v1:${kind}:${scope.accountId}:${scope.deviceScopeId}:progress`
}

export function newPhysicalResult(kind: TestKind, resolved: Pick<FailureResult,
  'v8_state' | 'authenticated_owner_resolved' | 'owner_scope_resolved' | 'journal_bound' | 'device_scope_resolved'>): FailureResult {
  return {
    schema: 'eliteplus.v8.physical_semantic_test_result.v1', test_type: kind, status: 'RUNNING',
    attempt_id: crypto.randomUUID(), retry_of_attempt_id: null, started_at: new Date().toISOString(), failed_at: null,
    last_completed_stage: null, failure_stage: null, error_code: null, error_message: null,
    native_error_code: null, native_error_message: null, exception_class: null, ...resolved,
    native_invocation_started: false, acquisition_started: false, ble_commands_issued: 0,
    command_types: [], callbacks_received: 0, source_envelopes_written: 0,
    queue_before: null, queue_after: null, queue_delta: null, base44_calls: null, sender_calls: null,
    ack_mutations: null, partial_evidence_present: false, source_journal_refs: [],
    retry_disposition: 'RETRY_NOT_ALLOWED', stages: [], native_evidence: null,
    diagnostics: kind === 'activity' || kind === 'activity_type25_anchor' ? {
      type24Requested: null, type24CommandWritten: null, type24Callbacks: null, type24Records: null,
      type25Requested: null, type25CommandWritten: null, type25Callbacks: null, type25Records: null,
      terminalCompletionStatus: null, nativeError: null,
      ...(kind === 'activity_type25_anchor' ? { type25Only: true } : {}),
    } : {
      workoutStartRequested: null, workoutStartAcknowledged: null, type82SchedulerStarted: null,
      type82CommandsSent: null, type82Callbacks: null, workoutStopRequested: null,
      workoutStopAcknowledged: null, type29HistoryRequested: null, type29CommandWritten: null,
      rawType29Notifications: null, direct26ByteDecoderResult: null,
    },
    inspected_stores: [], recovery_errors: [], persistence_errors: [], cleanup_errors: [], result: null,
  }
}

export function errorDetails(error: unknown) {
  const item = error && typeof error === 'object' ? error : {}
  return {
    code: 'code' in item && typeof item.code === 'string' ? item.code : 'PHYSICAL_TEST_EXCEPTION',
    message: 'message' in item && typeof item.message === 'string' ? item.message : String(error),
    exceptionClass: error instanceof Error ? error.constructor.name : null,
  }
}

export class PhysicalAttempt {
  stage: FailureStage = 'PREFLIGHT'
  constructor(public result: FailureResult, private readonly checkpoint: (value: FailureResult) => void) {}

  before(stage: FailureStage) {
    this.stage = stage
    this.result.current_stage = stage
    try { this.checkpoint(this.result) }
    catch (error) {
      this.stage = 'RESULT_PERSISTENCE'
      throw error
    }
  }

  completed(stage: TestStage) {
    this.result.last_completed_stage = stage
    this.result.stages.push({ stage, at: new Date().toISOString() })
    try { this.checkpoint(this.result) }
    catch (error) {
      this.stage = 'RESULT_PERSISTENCE'
      throw error
    }
  }

  native(evidence: PhysicalSemanticNativeEvidence) {
    this.result.native_evidence = evidence
    this.result.native_invocation_started = true
    this.result.native_error_code = evidence.errorCode ?? null
    this.result.native_error_message = evidence.errorMessage ?? null
    if (typeof evidence.commandsIssued === 'number') {
      this.result.ble_commands_issued = evidence.commandsIssued
      this.result.acquisition_started = evidence.acquisitionStarted ?? (evidence.commandsIssued > 0 ? true : null)
    }
    this.result.command_types = evidence.commandTypes ?? null
    this.result.callbacks_received = evidence.callbacksReceived ?? null
    this.result.source_envelopes_written = evidence.sourceEnvelopeIds?.length ?? null
    this.result.source_journal_refs = evidence.sourceEnvelopeIds ?? []
    this.result.partial_evidence_present = evidence.sourceEnvelopeIds ? evidence.sourceEnvelopeIds.length > 0 : null
    this.result.diagnostics = { ...this.result.diagnostics, ...evidence.diagnostics, native: evidence }
    if (evidence.lastCompletedStage && this.result.last_completed_stage !== 'RESULT_BUILT'
      && this.result.last_completed_stage !== 'RESULT_PERSISTED' && this.result.last_completed_stage !== 'COMPLETE') {
      this.result.last_completed_stage = evidence.lastCompletedStage
    }
  }

  fail(error: unknown) {
    const details = errorDetails(error)
    this.result.status = 'FAILED'
    this.result.failed_at = new Date().toISOString()
    this.result.failure_stage = this.stage === 'RESULT_CONSTRUCTION' || this.stage === 'RESULT_PERSISTENCE'
      ? this.stage : this.result.native_evidence?.failureStage ?? this.stage
    this.result.error_code = details.code
    this.result.error_message = details.message
    this.result.exception_class = details.exceptionClass
    if (this.result.native_invocation_started) {
      this.result.native_error_code = this.result.native_evidence?.errorCode ?? (this.stage === 'NATIVE_SESSION_CREATED' ? details.code : null)
      this.result.native_error_message = this.result.native_evidence?.errorMessage ?? (this.stage === 'NATIVE_SESSION_CREATED' ? details.message : null)
    }
    this.result.retry_disposition = this.result.partial_evidence_present
      ? 'PARTIAL_SOURCE_EVIDENCE_REVIEW_FIRST'
      : this.result.ble_commands_issued !== null && this.result.ble_commands_issued > 0
        ? 'DEVICE_COMMAND_ISSUED_REVIEW_FIRST'
        : this.result.ble_commands_issued === 0
          ? 'SAFE_TO_RETRY_NO_DEVICE_COMMAND' : 'RETRY_NOT_ALLOWED'
  }
}

export function isPhysicalResult(value: unknown): value is FailureResult {
  return Boolean(value && typeof value === 'object' && 'schema' in value
    && value.schema === 'eliteplus.v8.physical_semantic_test_result.v1')
}

export function canSafelyRetryPhysicalAttempt(value: unknown): value is FailureResult {
  return isPhysicalResult(value) && value.status === 'FAILED'
    && typeof value.attempt_id === 'string' && value.attempt_id.length > 0
    && value.acquisition_started === false && value.native_invocation_started === false
    && value.ble_commands_issued === 0 && value.callbacks_received === 0
    && value.source_envelopes_written === 0 && value.partial_evidence_present === false
    && value.retry_disposition === 'SAFE_TO_RETRY_NO_DEVICE_COMMAND'
}

export function latestPhysicalResult(saved: unknown, checkpoint: unknown): unknown {
  // The progress pointer is written before every attempt; device clock changes cannot revive an older safe failure.
  return isPhysicalResult(checkpoint) && (!isPhysicalResult(saved)
    || checkpoint.attempt_id !== saved.attempt_id)
    ? checkpoint : saved
}

export function failureResultText(result: FailureResult) {
  const value = (item: unknown) => item === null || item === undefined ? 'UNKNOWN' : String(item)
  return [
    result.status, `stage: ${result.failure_stage ?? result.last_completed_stage ?? 'UNKNOWN'}`,
    `last completed stage: ${result.last_completed_stage ?? 'UNKNOWN'}`,
    `code: ${value(result.error_code)}`, `message: ${value(result.error_message)}`,
    `acquisition started: ${result.acquisition_started === null ? 'UNKNOWN' : result.acquisition_started ? 'YES' : 'NO'}`,
    `BLE commands issued: ${value(result.ble_commands_issued)}`,
    `callbacks received: ${value(result.callbacks_received)}`,
    `source journal records: ${value(result.source_envelopes_written)}`,
    `queue delta: ${value(result.queue_delta)}`, `Base44 calls: ${value(result.base44_calls)}`,
    `retry disposition: ${result.retry_disposition}`,
    ...result.persistence_errors.map((error) => `PERSISTENCE ERROR: ${error}`),
    ...result.recovery_errors.map((error) => `RECOVERY ERROR: ${error}`),
    ...result.cleanup_errors.map((error) => `CLEANUP ERROR: ${error}`),
  ].join('\n')
}
