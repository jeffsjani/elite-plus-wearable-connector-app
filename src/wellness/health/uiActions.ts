// Engineering freeze diagnostics and bounded UI actions. Memory only; never persisted or sent.
export const UI_ACTION_TIMEOUT_MS = 10_000
export const NATIVE_ACCESS_PROBE_TIMEOUT_MS = 5_000
export const PRODUCTION_STATE_READ_TIMEOUT_MS = 8_000
// Native consent write: bounded store lock (3s) + commit + WorkManager enqueue/cancel + read-back.
export const PRODUCTION_CONSENT_WRITE_TIMEOUT_MS = 8_000
// Hard cap for the JS side of a native production refresh (sandbox start + evaluation are natively bounded at 65s).
// Abandoning the JS wait never cancels the native refresh or the WorkManager worker.
export const PRODUCTION_REFRESH_HARD_CAP_MS = 90_000

export type UiAction = 'CHECK_NATIVE_USAGE_ACCESS' | 'CHECK_USAGE_ACCESS' | 'REFRESH' | 'COPY_VALIDATION_SUMMARY'
export type UiErrorCode = 'ACTION_TIMEOUT' | 'ACTION_FAILED' | 'COPY_FAILED' | 'STORE_BUSY' | 'REFRESH_TIMEOUT'
  | 'NATIVE_CHECK_TIMEOUT'
export type UiActionOutcome = 'COMPLETED' | UiErrorCode

export interface FreezeDiagnostics {
  last_ui_action: UiAction | null
  last_ui_action_started_at: string | null
  last_ui_action_completed_at: string | null
  ui_actions_in_flight: number
  active_refresh_count: number
  max_active_refresh_count: number
  refresh_in_progress: boolean
  last_native_access_check_started_at: string | null
  last_native_access_check_completed_at: string | null
  last_production_refresh_started_at: string | null
  last_production_refresh_completed_at: string | null
  subscription_update_count: number
  visibility_event_count: number
  visibility_refresh_count: number
  last_ui_error_code: UiErrorCode | null
}

export const initialFreezeDiagnostics = (): FreezeDiagnostics => ({
  last_ui_action: null, last_ui_action_started_at: null, last_ui_action_completed_at: null, ui_actions_in_flight: 0,
  active_refresh_count: 0, max_active_refresh_count: 0, refresh_in_progress: false,
  last_native_access_check_started_at: null, last_native_access_check_completed_at: null,
  last_production_refresh_started_at: null, last_production_refresh_completed_at: null,
  subscription_update_count: 0, visibility_event_count: 0, visibility_refresh_count: 0, last_ui_error_code: null,
})

export class ActionTimeoutError extends Error {
  readonly code = 'ACTION_TIMEOUT'
  constructor() { super('ACTION_TIMEOUT') }
}

export function isTimeout(error: unknown): error is ActionTimeoutError {
  return error instanceof ActionTimeoutError
}

export function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string' ? error.code : null
}

// Rejects with ActionTimeoutError after `ms`; the underlying operation is not cancelled.
export function withTimeout<T>(operation: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new ActionTimeoutError()), ms) })
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timer))
}
