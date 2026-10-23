import type { DigitalWellnessSnapshot } from './digitalWellnessLocal'
import { DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED, QUALIFICATION_POLICY_VERSION } from './digitalWellnessProduction'
import { withTimeout } from './uiActions'

export const VALIDATION_SUMMARY_MAX_CHARS = 12_000
const SUMMARY_DAYS = 3
const MAX_REASONS = 12

export interface SummaryContext { platform: string; androidVersion: string; timezone: string; generatedAt: string }

// Allow-listed fields only. Never includes raw UsageEvents, the event sequence, checkpoint/ledger arrays,
// outbox contents, app/package identity, or stack traces — only counts and approved aggregate/receipt fields.
export function buildValidationSummary(snapshot: DigitalWellnessSnapshot, context: SummaryContext): string {
  const production = snapshot.production
  const receipt = snapshot.validationReceipts.at(-1)
  const summary = {
    schema: 'eliteplus.digital_wellness.validation_summary.v1',
    generated_at: context.generatedAt,
    platform: context.platform,
    android_version: context.androidVersion,
    timezone: context.timezone,
    semantic_version: 'android.digital_balance.v1',
    qualification_policy_version: QUALIFICATION_POLICY_VERSION,
    cloud_sync_enabled: DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED,
    state: snapshot.state,
    setup: snapshot.setup,
    access: { ...snapshot.access },
    native_probe: snapshot.nativeProbe ? {
      os_access: snapshot.nativeProbe.osAccess, appops_result: snapshot.nativeProbe.appOpsResult,
      checked_at: snapshot.nativeProbe.checkedAt, error: snapshot.nativeProbe.error,
    } : null,
    production: production ? {
      owner_kind: production.owner_kind,
      consent: production.consent,
      worker_last_run: production.worker_last_run,
      next_eligible_run: production.next_eligible_run,
      last_usage_access_check: production.last_usage_access_check,
      last_sender_outcome: production.last_sender_outcome,
      error: production.error,
      checkpoint_count: production.checkpoints.length,
      latest_checkpoint_at: production.checkpoints.at(-1)?.captured_at ?? null,
      ledger_count: production.ledger.length,
      pending_outbox_count: production.outbox.filter((item) => !item.ack).length,
      day_count: production.days.length,
      recent_days: production.days.slice(-SUMMARY_DAYS).map((day) => ({
        local_date: day.local_date, timezone: day.timezone, coverage_state: day.coverage_state, confidence: day.confidence,
        screen_time_minutes: day.screen_time_minutes, pickups: day.pickups, first_pickup: day.first_pickup,
        screen_sessions: day.screen_sessions, late_night_screen_minutes: day.late_night_screen_minutes,
        quality_reasons: day.quality_reasons.slice(0, MAX_REASONS), updated_at: day.updated_at,
      })),
    } : null,
    latest_validation_receipt: receipt ? {
      validation_id: receipt.validation_id, started_at: receipt.started_at, completed_at: receipt.completed_at,
      query_window: receipt.query_window, permission_state: receipt.permission_state, event_counts: receipt.event_counts,
      total_supported_events: receipt.total_supported_events, deduplicated_count: receipt.deduplicated_count,
      resulting_metrics: receipt.resulting_metrics, coverage: receipt.coverage, confidence: receipt.confidence,
      quality_reasons: receipt.quality_reasons.slice(0, MAX_REASONS),
      query_error: receipt.query_diagnostics ? {
        stage: receipt.query_diagnostics.error_stage, code: receipt.query_diagnostics.error_code,
      } : null,
    } : null,
    freeze_diagnostics: { ...snapshot.diagnostics },
  }
  let text = JSON.stringify(summary, null, 2)
  if (text.length > VALIDATION_SUMMARY_MAX_CHARS) {
    text = JSON.stringify({ ...summary, production: summary.production && { ...summary.production, recent_days: [] },
      latest_validation_receipt: null, truncated: true }, null, 2)
  }
  return text
}

export type CopyOutcome = 'COPIED' | 'FAILED'
export interface ClipboardEnvironment {
  clipboard?: Pick<Clipboard, 'writeText'> | null
  document?: Document | null
}
export const CLIPBOARD_WRITE_TIMEOUT_MS = 2_000

// Android WebView's async clipboard can reject or never settle; bound it, then try the synchronous copy command
// while the tap's user activation is still valid. Never resolves silently: COPIED or FAILED.
export async function copyText(text: string, env: ClipboardEnvironment = defaultEnvironment()): Promise<CopyOutcome> {
  if (env.clipboard?.writeText) {
    try {
      await withTimeout(env.clipboard.writeText(text), CLIPBOARD_WRITE_TIMEOUT_MS)
      return 'COPIED'
    } catch { /* fall through to the legacy copy command */ }
  }
  return legacyCopy(text, env.document) ? 'COPIED' : 'FAILED'
}

function legacyCopy(text: string, doc: Document | null | undefined): boolean {
  if (!doc?.body || typeof doc.execCommand !== 'function') return false
  const area = doc.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  doc.body.appendChild(area)
  try {
    area.select()
    return doc.execCommand('copy') === true
  } catch {
    return false
  } finally {
    area.remove()
  }
}

function defaultEnvironment(): ClipboardEnvironment {
  return {
    clipboard: typeof navigator !== 'undefined' ? navigator.clipboard ?? null : null,
    document: typeof document !== 'undefined' ? document : null,
  }
}
