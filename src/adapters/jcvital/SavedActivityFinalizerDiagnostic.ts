export const FINALIZER_STAGES = [
  'FINALIZER_REQUESTED',
  'SAVED_ATTEMPT_LOADED',
  'SOURCE_REFERENCES_VALIDATED',
  'SOURCE_RECORDS_REHYDRATING',
  'TYPE24_REHYDRATED',
  'TYPE25_REHYDRATED',
  'RECONCILIATION_BUILDING',
  'RESULT_BUILT',
  'RESULT_PERSISTED',
  'ISOLATION_RELEASED',
  'SENDER_RESUMED',
  'COMPLETE',
] as const
export type FinalizerStage = typeof FINALIZER_STAGES[number]

export const FINALIZER_STILL_WAITING_MS = 15_000
export const FINALIZER_ACTION_TIMEOUT_MS = 45_000
export const FINALIZER_SOURCE_BATCH_SIZE = 64

export interface FinalizerProgress {
  stage?: FinalizerStage
  type24Loaded?: number
  type25Loaded?: number
  type24Expected?: number
  type25Expected?: number
  referencesLoaded?: number
  referencesTotal?: number
  batchesCompleted?: number
  batchesTotal?: number
  pendingRead?: string | null
}

export interface FinalizerDiagnostic {
  schema: 'eliteplus.savedActivityFinalizerDiagnostic.v1'
  build: 'v61'
  action_id: string
  clicked_at: string
  attempt_id: string | null
  retry_of_attempt_id: string | null
  owner_user_id: string
  account_id: string | null
  device_scope_id: string | null
  outcome: 'RUNNING' | 'COMPLETE' | 'FAILED' | 'BLOCKED' | 'IGNORED_ALREADY_RUNNING'
  stage: FinalizerStage
  last_completed_stage: FinalizerStage
  stages: { stage: FinalizerStage; at: string }[]
  type24_loaded: number
  type25_loaded: number
  type24_expected: number | null
  type25_expected: number | null
  references_loaded: number
  references_total: number | null
  batch_size: number
  batches_completed: number
  batches_total: number | null
  pending_read_operation: string | null
  last_error: string | null
  blockers: string[]
  last_progress_at: string
  elapsed_ms: number
  watchdog: {
    still_waiting_after_ms: number
    action_timeout_after_ms: number
    still_waiting_shown_at: string | null
    timeout: {
      code: 'FINALIZER_ACTION_TIMEOUT'
      recorded_at: string
      action_id: string
      attempt_id: string | null
      last_completed_stage: FinalizerStage
      type24_loaded: number
      type25_loaded: number
      pending_read_operation: string | null
      elapsed_ms: number
    } | null
  }
  ignored_clicks: { at: string; reason: string }[]
  safety: {
    ble_commands: 0
    acquisition: 0
    source_journal_writes: 0
    queue_enqueue: 0
    base44_test_calls: 0
    canonical_writes: 0
    auto_cancel_or_retry: false
  }
  updated_at: string
}

export function finalizerDiagnosticKey(ownerUserId: string): string {
  return `eliteplus.savedActivityFinalizer.diagnostic.v1:${ownerUserId}`
}

export function newFinalizerDiagnostic(input: {
  actionId: string
  clickedAt: Date
  ownerUserId: string
  attemptId: string | null
  retryOfAttemptId: string | null
  scope: { accountId: string; deviceScopeId: string } | null
}): FinalizerDiagnostic {
  const at = input.clickedAt.toISOString()
  return {
    schema: 'eliteplus.savedActivityFinalizerDiagnostic.v1',
    build: 'v61',
    action_id: input.actionId,
    clicked_at: at,
    attempt_id: input.attemptId,
    retry_of_attempt_id: input.retryOfAttemptId,
    owner_user_id: input.ownerUserId,
    account_id: input.scope?.accountId ?? null,
    device_scope_id: input.scope?.deviceScopeId ?? null,
    outcome: 'RUNNING',
    stage: 'FINALIZER_REQUESTED',
    last_completed_stage: 'FINALIZER_REQUESTED',
    stages: [{ stage: 'FINALIZER_REQUESTED', at }],
    type24_loaded: 0,
    type25_loaded: 0,
    type24_expected: null,
    type25_expected: null,
    references_loaded: 0,
    references_total: null,
    batch_size: FINALIZER_SOURCE_BATCH_SIZE,
    batches_completed: 0,
    batches_total: null,
    pending_read_operation: null,
    last_error: null,
    blockers: [],
    last_progress_at: at,
    elapsed_ms: 0,
    watchdog: {
      still_waiting_after_ms: FINALIZER_STILL_WAITING_MS,
      action_timeout_after_ms: FINALIZER_ACTION_TIMEOUT_MS,
      still_waiting_shown_at: null,
      timeout: null,
    },
    ignored_clicks: [],
    safety: {
      ble_commands: 0, acquisition: 0, source_journal_writes: 0, queue_enqueue: 0,
      base44_test_calls: 0, canonical_writes: 0, auto_cancel_or_retry: false,
    },
    updated_at: at,
  }
}

export function applyFinalizerProgress(diagnostic: FinalizerDiagnostic, progress: FinalizerProgress, now: Date): FinalizerDiagnostic {
  const at = now.toISOString()
  const next: FinalizerDiagnostic = {
    ...diagnostic,
    stages: [...diagnostic.stages],
    last_progress_at: at,
    updated_at: at,
    elapsed_ms: elapsedMs(diagnostic, now),
  }
  if (progress.stage) {
    next.stage = progress.stage
    next.last_completed_stage = progress.stage
    next.stages.push({ stage: progress.stage, at })
  }
  if (progress.type24Loaded !== undefined) next.type24_loaded = progress.type24Loaded
  if (progress.type25Loaded !== undefined) next.type25_loaded = progress.type25Loaded
  if (progress.type24Expected !== undefined) next.type24_expected = progress.type24Expected
  if (progress.type25Expected !== undefined) next.type25_expected = progress.type25Expected
  if (progress.referencesLoaded !== undefined) next.references_loaded = progress.referencesLoaded
  if (progress.referencesTotal !== undefined) next.references_total = progress.referencesTotal
  if (progress.batchesCompleted !== undefined) next.batches_completed = progress.batchesCompleted
  if (progress.batchesTotal !== undefined) next.batches_total = progress.batchesTotal
  if (progress.pendingRead !== undefined) next.pending_read_operation = progress.pendingRead
  return next
}

export function elapsedMs(diagnostic: Pick<FinalizerDiagnostic, 'clicked_at'>, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(diagnostic.clicked_at))
}

export function sinceProgressMs(diagnostic: Pick<FinalizerDiagnostic, 'last_progress_at'>, now: Date): number {
  return Math.max(0, now.getTime() - Date.parse(diagnostic.last_progress_at))
}

/** Observability only: records FINALIZER_ACTION_TIMEOUT without cancelling or retrying the running finalizer. */
export function applyFinalizerWatchdog(diagnostic: FinalizerDiagnostic, now: Date): FinalizerDiagnostic {
  if (diagnostic.outcome !== 'RUNNING') return diagnostic
  const stalled = sinceProgressMs(diagnostic, now)
  const at = now.toISOString()
  let next = diagnostic
  if (stalled >= FINALIZER_STILL_WAITING_MS && !diagnostic.watchdog.still_waiting_shown_at) {
    next = { ...next, watchdog: { ...next.watchdog, still_waiting_shown_at: at } }
  }
  if (stalled >= FINALIZER_ACTION_TIMEOUT_MS && !diagnostic.watchdog.timeout) {
    const elapsed = elapsedMs(diagnostic, now)
    next = {
      ...next,
      elapsed_ms: elapsed,
      updated_at: at,
      watchdog: {
        ...next.watchdog,
        timeout: {
          code: 'FINALIZER_ACTION_TIMEOUT',
          recorded_at: at,
          action_id: diagnostic.action_id,
          attempt_id: diagnostic.attempt_id,
          last_completed_stage: diagnostic.last_completed_stage,
          type24_loaded: diagnostic.type24_loaded,
          type25_loaded: diagnostic.type25_loaded,
          pending_read_operation: diagnostic.pending_read_operation,
          elapsed_ms: elapsed,
        },
      },
    }
  }
  return next
}

export function persistFinalizerDiagnostic(diagnostic: FinalizerDiagnostic, storage: Pick<Storage, 'setItem'> = localStorage): string | null {
  try {
    storage.setItem(finalizerDiagnosticKey(diagnostic.owner_user_id), JSON.stringify(diagnostic))
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

export function readFinalizerDiagnostic(ownerUserId: string, storage: Pick<Storage, 'getItem'> = localStorage): FinalizerDiagnostic | null {
  try {
    const raw = storage.getItem(finalizerDiagnosticKey(ownerUserId))
    const parsed: unknown = raw ? JSON.parse(raw) : null
    if (!parsed || typeof parsed !== 'object' || (parsed as FinalizerDiagnostic).schema !== 'eliteplus.savedActivityFinalizerDiagnostic.v1'
      || (parsed as FinalizerDiagnostic).owner_user_id !== ownerUserId) return null
    return parsed as FinalizerDiagnostic
  } catch {
    return null
  }
}

export function newActionId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `finalizer-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
