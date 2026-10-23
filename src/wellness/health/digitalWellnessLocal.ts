import {
  processAndroidDigitalWellness,
  type AndroidDigitalWellnessResult,
  type AndroidUsageEventType,
  type AndroidWellnessQualityReason,
} from './androidDigitalWellness'
import type { ConsentState } from './consent'
import { initialConsents } from './consent'
import type { DigitalWellnessNative, DigitalWellnessProductionNative } from './digitalWellnessNative'
import type { ProductionState } from './digitalWellnessProduction'
import type { Authorization } from './types'
import { queryDiagnostics, type QueryDiagnostics, type QueryErrorStage } from './queryDiagnostics'
import {
  collectionState, probeResult, productionContinuity,
  type DigitalWellnessAccessModel, type NativeAccessProbe, type OsAccess,
} from './digitalWellnessAccess'
import {
  NATIVE_ACCESS_PROBE_TIMEOUT_MS, PRODUCTION_CONSENT_WRITE_TIMEOUT_MS, PRODUCTION_REFRESH_HARD_CAP_MS,
  PRODUCTION_STATE_READ_TIMEOUT_MS, UI_ACTION_TIMEOUT_MS,
  errorCode, initialFreezeDiagnostics, isTimeout, withTimeout,
  type FreezeDiagnostics, type UiAction, type UiActionOutcome, type UiErrorCode,
} from './uiActions'

export type DigitalWellnessState = 'DISABLED' | 'CONSENT_REQUIRED' | 'OS_ACCESS_REQUIRED' | 'AVAILABLE'
  | 'COLLECTING' | 'LOCAL_DATA_READY' | 'PERMISSION_REVOKED' | 'UNAVAILABLE' | 'ERROR'
// User-driven consent flow, kept apart from the derived `state` so access probes, resume, and refresh results
// can never silently dismiss an open opt-in or report success before native persistence confirms it.
export type DigitalWellnessSetupPhase = 'IDLE' | 'CONSENT_PROMPT' | 'SAVING' | 'DISABLING'
export interface LocalDigitalWellnessRecord {
  result: AndroidDigitalWellnessResult
  capturedAt: string
  consentReference: string
  deliveryCapability: 'LOCAL_ONLY'
  queryStart: string
  queryEnd: string
  osVersion: string
  timezone: string
}
export interface DigitalWellnessContinuityEntry {
  timestamp: string
  usageAccess: 'GRANTED' | 'DENIED' | null
  consent: 'ENABLED' | 'DISABLED'
  reason: 'ACCESS_CHECK' | 'CONSENT_ENABLED' | 'CONSENT_DISABLED'
}
export interface DigitalWellnessValidationReceipt {
  query_diagnostics?: QueryDiagnostics
  validation_id: string
  started_at: string
  completed_at: string
  query_window: { start: string; end: string; duration_hours: number }
  permission_state: 'GRANTED' | 'DENIED' | 'NOT_CHECKED' | 'QUERY_FAILED'
  event_counts: Record<AndroidUsageEventType, number | null>
  total_supported_events: number | null
  deduplicated_count: number | null
  semantic_version: 'android.digital_balance.v1'
  resulting_metrics: {
    screen_time_minutes: number | null
    pickups: number | null
    first_pickup: string | null
    screen_sessions: number | null
    late_night_screen_minutes: number | null
  }
  coverage: 'UNKNOWN' | 'PARTIAL' | 'QUALIFIED'
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'UNKNOWN'
  quality_reasons: readonly AndroidWellnessQualityReason[]
}
export interface DigitalWellnessSnapshot {
  production?: ProductionState
  state: DigitalWellnessState
  setup: DigitalWellnessSetupPhase
  // Current OS access comes only from the latest direct native probe, never from history or workers.
  osAccess: OsAccess
  nativeProbe: NativeAccessProbe | null
  access: DigitalWellnessAccessModel
  consent: ConsentState
  permission: Authorization
  deliveryCapability: 'LOCAL_ONLY'
  records: readonly LocalDigitalWellnessRecord[]
  validationReceipts: readonly DigitalWellnessValidationReceipt[]
  continuityLedger: readonly DigitalWellnessContinuityEntry[]
  eventSequence: ReadonlyArray<{ eventType: AndroidUsageEventType; timestamp: string }>
  error: string | null
  diagnostics: FreezeDiagnostics
}
const CONSENT_KEY = 'eliteplus.digitalWellness.consent.v1'
const RECORDS_KEY = 'eliteplus.digitalWellness.aggregates.v1'
const RECEIPTS_KEY = 'eliteplus.digitalWellness.validationReceipts.v1'
const LEDGER_KEY = 'eliteplus.digitalWellness.continuity.v1'
const EVENT_TYPES: readonly AndroidUsageEventType[] = [
  'SCREEN_INTERACTIVE', 'SCREEN_NON_INTERACTIVE', 'KEYGUARD_SHOWN', 'KEYGUARD_HIDDEN',
]
type LocalStorage = Pick<Storage, 'getItem' | 'setItem'> & Partial<Pick<Storage, 'removeItem'>>

export class LocalDigitalWellness {
  private snapshot: DigitalWellnessSnapshot
  private listeners = new Set<() => void>()
  private generation = 0
  private busy = false
  private previouslyAuthorized = false
  private permissionGap = false
  private settingsPending = false
  private receiptSequence = 0
  private accessDiagnostics: QueryDiagnostics | undefined
  private refreshFlight: Promise<void> | null = null
  private probeFlight: Promise<NativeAccessProbe> | null = null
  private resumeFlight: Promise<void> | null = null
  private activeRefreshes = 0
  private uiActionsInFlight = 0

  constructor(
    private readonly native: DigitalWellnessNative,
    private readonly storage: LocalStorage,
    private readonly android: boolean,
    private readonly now = () => Date.now(),
    private readonly timezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone,
    private readonly production?: DigitalWellnessProductionNative,
  ) {
    const initial = initialConsents().find(({ domain }) => domain === 'DIGITAL_WELLNESS')!
    this.snapshot = {
      state: 'DISABLED', setup: 'IDLE', osAccess: 'UNKNOWN', nativeProbe: null,
      access: { osAccess: 'UNKNOWN', consent: 'DISABLED', collection: 'DISABLED', continuity: 'UNVERIFIED' },
      consent: initial, permission: 'NOT_REQUESTED',
      deliveryCapability: 'LOCAL_ONLY', records: [], validationReceipts: [], continuityLedger: [], eventSequence: [], error: null,
      diagnostics: initialFreezeDiagnostics(),
    }
    if (production) {
      // The native production store is the only consent authority; a 3B-2 local consent flag must not linger as a
      // second, divergent source. Legacy aggregates/ledger stay untouched under their own retention.
      try { storage.removeItem?.(CONSENT_KEY) } catch { /* best effort */ }
      return
    }
    try {
      const saved = storage.getItem(CONSENT_KEY)
      let savedConsent: ConsentState | null = null
      if (saved) {
        const consent: ConsentState = JSON.parse(saved)
        if (consent.domain !== 'DIGITAL_WELLNESS' || !['GRANTED', 'REVOKED', 'NOT_REQUESTED'].includes(consent.state)
          || consent.policyVersion !== 'digitalWellness.3b2.v1'
          || (consent.state === 'GRANTED' && typeof consent.consentReference !== 'string')) {
          throw new Error('Invalid local consent')
        }
        savedConsent = consent
      }
      const records = storage.getItem(RECORDS_KEY)
      if (records) {
        const parsed: LocalDigitalWellnessRecord[] = JSON.parse(records)
        if (!Array.isArray(parsed) || parsed.some((record) => record.deliveryCapability !== 'LOCAL_ONLY'
          || record.result?.semanticVersion !== 'android.digital_balance.v1'
          || !Array.isArray(record.result.days) || !Array.isArray(record.result.observations))) {
          throw new Error('Invalid local aggregates')
        }
        this.snapshot.records = parsed
        this.previouslyAuthorized = parsed.length > 0
      }
      const receipts = storage.getItem(RECEIPTS_KEY)
      if (receipts) this.snapshot.validationReceipts = this.parseReceipts(receipts)
      const ledger = storage.getItem(LEDGER_KEY)
      if (ledger) this.snapshot.continuityLedger = this.parseLedger(ledger)
      const latestLedgerEntry = this.snapshot.continuityLedger.at(-1)
      if (latestLedgerEntry) {
        const enabledAt = [...this.snapshot.continuityLedger].reverse()
          .find((entry) => entry.reason === 'CONSENT_ENABLED')?.timestamp
        const consentEnabled = latestLedgerEntry.consent === 'ENABLED'
        this.snapshot.consent = {
          domain: 'DIGITAL_WELLNESS',
          state: consentEnabled ? 'GRANTED' : 'REVOKED',
          consentReference: consentEnabled
            ? savedConsent?.consentReference ?? (enabledAt
              ? `digital-wellness-${Date.parse(enabledAt)}` : this.snapshot.records.at(-1)?.consentReference ?? null)
            : savedConsent?.consentReference ?? null,
          policyVersion: savedConsent?.policyVersion ?? 'digitalWellness.3b2.v1',
        }
        this.snapshot.state = consentEnabled ? 'OS_ACCESS_REQUIRED' : 'DISABLED'
        if (saved && storage.removeItem) storage.removeItem(CONSENT_KEY)
      } else if (savedConsent) {
        this.snapshot.consent = savedConsent
        this.snapshot.state = savedConsent.state === 'GRANTED' ? 'OS_ACCESS_REQUIRED' : 'DISABLED'
        if (savedConsent.state === 'GRANTED' || savedConsent.state === 'REVOKED') {
          const reason = savedConsent.state === 'GRANTED' ? 'CONSENT_ENABLED' : 'CONSENT_DISABLED'
          if (this.observeContinuity(reason, null) && storage.removeItem) storage.removeItem(CONSENT_KEY)
        } else if (storage.removeItem) {
          storage.removeItem(CONSENT_KEY)
        }
      }
      let hasPriorGrant = false
      for (const entry of this.snapshot.continuityLedger) {
        if (entry.usageAccess === 'GRANTED') hasPriorGrant = true
        else if (entry.usageAccess === 'DENIED' && hasPriorGrant) this.permissionGap = true
      }
    } catch {
      this.snapshot.state = 'ERROR'
      this.snapshot.error = 'Local Digital Wellness storage could not be read. Collection is disabled.'
      this.snapshot.consent = initial
    }
  }

  private parseReceipts(value: string): DigitalWellnessValidationReceipt[] {
    const parsed: DigitalWellnessValidationReceipt[] = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((receipt) =>
      receipt.semantic_version !== 'android.digital_balance.v1'
      || !['UNKNOWN', 'PARTIAL', 'QUALIFIED'].includes(receipt.coverage)
      || Object.keys(receipt).some((key) => /package|appName|activity|className|url|content/i.test(key)))) {
      throw new Error('Invalid validation receipts')
    }
    return parsed.map((receipt) => ({
      ...receipt,
      ...(receipt.query_diagnostics ? {
        query_diagnostics: queryDiagnostics(receipt.query_diagnostics,
          Date.parse(receipt.query_window.start), Date.parse(receipt.query_window.end)),
      } : {}),
    }))
  }

  private parseLedger(value: string): DigitalWellnessContinuityEntry[] {
    const parsed: DigitalWellnessContinuityEntry[] = JSON.parse(value)
    if (!Array.isArray(parsed) || parsed.some((entry) =>
      ![null, 'GRANTED', 'DENIED'].includes(entry.usageAccess)
      || !['ENABLED', 'DISABLED'].includes(entry.consent)
      || !['ACCESS_CHECK', 'CONSENT_ENABLED', 'CONSENT_DISABLED'].includes(entry.reason))) {
      throw new Error('Invalid continuity ledger')
    }
    return parsed
  }

  private observeContinuity(reason: DigitalWellnessContinuityEntry['reason'], granted: boolean | null): boolean {
    const entry: DigitalWellnessContinuityEntry = {
      timestamp: new Date(this.now()).toISOString(),
      usageAccess: granted === null ? null : granted ? 'GRANTED' : 'DENIED',
      consent: this.snapshot.consent.state === 'GRANTED' ? 'ENABLED' : 'DISABLED',
      reason,
    }
    const ledger = [...this.snapshot.continuityLedger, entry]
    try {
      this.storage.setItem(LEDGER_KEY, JSON.stringify(ledger))
      this.update({ continuityLedger: ledger })
      return true
    } catch {
      this.fail('Digital Wellness continuity state could not be saved.')
      return false
    }
  }

  private saveReceipt(receipt: DigitalWellnessValidationReceipt) {
    const validationReceipts = [...this.snapshot.validationReceipts, receipt]
    try {
      this.storage.setItem(RECEIPTS_KEY, JSON.stringify(validationReceipts))
      this.update({ validationReceipts })
    } catch {
      this.fail('The privacy-safe validation receipt could not be saved.')
    }
  }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }
  private update(update: Partial<DigitalWellnessSnapshot>) {
    const next = { ...this.snapshot, ...update }
    next.access = {
      osAccess: next.osAccess,
      consent: next.consent.state === 'GRANTED' ? 'ENABLED' : 'DISABLED',
      collection: collectionState(next.state),
      continuity: next.production ? productionContinuity(next.production)
        : this.permissionGap ? 'GAP_DETECTED' : 'UNVERIFIED',
    }
    next.diagnostics = { ...next.diagnostics, subscription_update_count: next.diagnostics.subscription_update_count + 1 }
    this.snapshot = next
    this.listeners.forEach((listener) => listener())
  }
  private diag(patch: Partial<FreezeDiagnostics>) {
    this.update({ diagnostics: { ...this.snapshot.diagnostics, ...patch } })
  }
  private iso() { return new Date(Date.now()).toISOString() }

  // Every Engineering/consumer button goes through here: bounded by UI_ACTION_TIMEOUT_MS, never throws, and
  // always leaves the UI interactive. A timeout only stops waiting; native work and the worker keep running.
  async runUiAction(action: UiAction, run: () => Promise<unknown>, timeoutMs = UI_ACTION_TIMEOUT_MS): Promise<UiActionOutcome> {
    this.uiActionsInFlight++
    this.diag({
      last_ui_action: action, last_ui_action_started_at: this.iso(), last_ui_action_completed_at: null,
      ui_actions_in_flight: this.uiActionsInFlight,
    })
    let outcome: UiActionOutcome = 'COMPLETED'
    try {
      await withTimeout(Promise.resolve().then(run), timeoutMs)
    } catch (error) {
      const code = errorCode(error)
      outcome = isTimeout(error) ? 'ACTION_TIMEOUT' : code === 'COPY_FAILED' ? 'COPY_FAILED' : 'ACTION_FAILED'
    }
    if (outcome === 'ACTION_TIMEOUT' && this.snapshot.state === 'COLLECTING') {
      // The in-flight refresh stays single-flight; the controls just stop showing a stuck COLLECTING state.
      if (this.snapshot.production) this.applyProduction(this.snapshot.production)
      else this.update({ state: this.snapshot.consent.state === 'GRANTED' ? 'AVAILABLE' : 'DISABLED' })
    }
    this.uiActionsInFlight--
    this.diag({
      last_ui_action_completed_at: this.iso(), ui_actions_in_flight: this.uiActionsInFlight,
      last_ui_error_code: outcome === 'COMPLETED' ? this.snapshot.diagnostics.last_ui_error_code : outcome,
    })
    return outcome
  }
  private recordError(code: UiErrorCode) { this.diag({ last_ui_error_code: code }) }

  // One resume/visibility event → at most one access probe and one eligible refresh; repeats join the running chain.
  onForegroundResume(): Promise<void> {
    this.diag({ visibility_event_count: this.snapshot.diagnostics.visibility_event_count + 1 })
    if (this.resumeFlight) return this.resumeFlight
    this.diag({ visibility_refresh_count: this.snapshot.diagnostics.visibility_refresh_count + 1 })
    const flight = this.foregroundRefresh().catch(() => {}).finally(() => {
      if (this.resumeFlight === flight) this.resumeFlight = null
    })
    this.resumeFlight = flight
    return flight
  }
  // Engineering ground truth: calls AppOps directly, bypassing consent, owner scope, WorkManager, and stored state.
  // Only hasUsageAccess() is called: no store, WorkManager, refresh, or semantic work. Concurrent callers share one probe.
  checkNativeUsageAccess(): Promise<NativeAccessProbe> {
    if (this.probeFlight) return this.probeFlight
    const flight = this.probeNativeUsageAccess().finally(() => {
      if (this.probeFlight === flight) this.probeFlight = null
    })
    this.probeFlight = flight
    return flight
  }
  private async probeNativeUsageAccess(): Promise<NativeAccessProbe> {
    this.diag({ last_native_access_check_started_at: this.iso() })
    let probe: NativeAccessProbe
    try {
      probe = probeResult(await withTimeout(this.native.hasUsageAccess(), NATIVE_ACCESS_PROBE_TIMEOUT_MS),
        new Date(this.now()).toISOString())
    } catch (error) {
      const timedOut = isTimeout(error)
      // A timed-out probe proves nothing about access; keep the last live result rather than inventing one.
      probe = {
        osAccess: timedOut ? this.snapshot.osAccess : 'UNKNOWN', appOpsResult: null,
        checkedAt: new Date(this.now()).toISOString(), error: timedOut ? 'NATIVE_CHECK_TIMEOUT' : 'NATIVE_CHECK_FAILED',
      }
      if (timedOut) this.recordError('NATIVE_CHECK_TIMEOUT')
    }
    this.update({ osAccess: probe.osAccess, nativeProbe: probe })
    this.diag({ last_native_access_check_completed_at: this.iso() })
    if (this.snapshot.production && this.snapshot.state !== 'COLLECTING') this.applyProduction(this.snapshot.production)
    return probe
  }
  async checkUsageAccess(): Promise<boolean> {
    if (!this.production && this.android && this.snapshot.consent.state !== 'GRANTED') await this.checkNativeUsageAccess()
    return this.recheckAccess()
  }
  beginSetup() {
    if (this.snapshot.setup === 'SAVING' || this.snapshot.setup === 'DISABLING') return
    this.update({ setup: 'CONSENT_PROMPT', state: 'CONSENT_REQUIRED', error: null })
  }
  cancelSetup() {
    if (this.snapshot.setup === 'SAVING' || this.snapshot.setup === 'DISABLING') return
    this.update({ setup: 'IDLE' })
    if (this.production && this.snapshot.production) { this.applyProduction(this.snapshot.production); return }
    this.update({ state: this.snapshot.consent.state === 'GRANTED' ? 'OS_ACCESS_REQUIRED' : 'DISABLED' })
  }
  private fail(message: string) { this.update({ state: 'ERROR', error: message }) }

  async initializeProduction() {
    if (!this.production || !this.android) return
    const generation = this.generation
    try {
      const state = await withTimeout(this.production.getProductionState(), PRODUCTION_STATE_READ_TIMEOUT_MS)
      await this.checkNativeUsageAccess()
      if (generation === this.generation) this.applyProduction(state)
    } catch (error) {
      if (generation !== this.generation) return
      if (isTimeout(error) || errorCode(error) === 'WELLNESS_STORE_BUSY') {
        // A worker holds the store: report BUSY and keep the last known state instead of blocking or failing.
        this.recordError('STORE_BUSY')
        this.update({ error: 'Digital Wellness is updating in the background. Try again shortly.' })
        return
      }
      this.fail('Digital Wellness production storage could not be read. Collection is disabled.')
    }
  }
  private applyProduction(production: ProductionState) {
    const consent: ConsentState = {
      domain: 'DIGITAL_WELLNESS', state: production.consent ? 'GRANTED' : 'REVOKED',
      consentReference: production.consent ? production.scope : null, policyVersion: 'digitalWellness.3b2.v1',
    }
    // Stored checkpoints/ledger are continuity history only; the live probe decides current access.
    const access = this.snapshot.osAccess
    // An open opt-in survives any probe/resume/refresh until the user confirms or cancels it.
    const prompting = !production.consent && (this.snapshot.setup === 'CONSENT_PROMPT' || this.snapshot.setup === 'SAVING')
    this.update({
      production, consent,
      state: prompting ? 'CONSENT_REQUIRED' : production.error ? 'ERROR' : !production.consent ? 'DISABLED'
        : access === 'GRANTED' ? production.days.length ? 'LOCAL_DATA_READY' : 'AVAILABLE'
          : access === 'DENIED' && production.access_established_at ? 'PERMISSION_REVOKED' : 'OS_ACCESS_REQUIRED',
      permission: access === 'GRANTED' ? 'AUTHORIZED'
        : access === 'DENIED' ? production.access_established_at ? 'REVOKED' : 'DENIED' : 'NOT_REQUESTED',
      error: production.error ? 'Digital Wellness refresh is unavailable. Saved observations are not fresh.' : null,
    })
  }
  async foregroundRefresh() {
    if (!this.production || !this.android) return
    if (this.snapshot.consent.state !== 'GRANTED') {
      await this.checkNativeUsageAccess()
      return
    }
    await this.refresh()
  }
  async closeOwnerScope() {
    this.generation++
    if (!this.production) { await this.disable(); return }
    try {
      this.applyProduction(await this.production.closeProductionScope())
      this.update({ records: [], validationReceipts: [], continuityLedger: [], eventSequence: [] })
    } catch { this.fail('Digital Wellness owner scope could not be closed.') }
  }
  // Single-flight: manual Refresh, Check Usage Access, settings return, and resume all join the running refresh.
  private productionRefresh(): Promise<void> {
    if (!this.production || this.snapshot.consent.state !== 'GRANTED' || this.snapshot.setup === 'DISABLING') {
      return Promise.resolve()
    }
    if (this.refreshFlight) return this.refreshFlight
    const flight = this.runProductionRefresh(this.production).finally(() => {
      if (this.refreshFlight === flight) this.refreshFlight = null
    })
    this.refreshFlight = flight
    return flight
  }
  private async runProductionRefresh(production: DigitalWellnessProductionNative) {
    const generation = this.generation
    this.activeRefreshes++
    this.diag({
      active_refresh_count: this.activeRefreshes, refresh_in_progress: true, last_production_refresh_started_at: this.iso(),
      max_active_refresh_count: Math.max(this.snapshot.diagnostics.max_active_refresh_count, this.activeRefreshes),
    })
    this.update({ state: 'COLLECTING', error: null })
    try {
      const state = await withTimeout(production.refreshProduction(), PRODUCTION_REFRESH_HARD_CAP_MS)
      await this.checkNativeUsageAccess()
      if (generation === this.generation) this.applyProduction(state)
    } catch (error) {
      if (generation === this.generation) {
        if (isTimeout(error)) {
          // Stop waiting on the bridge only; the native refresh/worker continues and persists its own result.
          this.recordError('REFRESH_TIMEOUT')
          await this.initializeProduction()
          if (this.snapshot.state === 'COLLECTING' && this.snapshot.production) this.applyProduction(this.snapshot.production)
        } else {
          await this.initializeProduction()
          this.fail('Digital Wellness refresh failed. No new qualified observation was saved.')
        }
      }
    } finally {
      this.activeRefreshes--
      this.diag({
        active_refresh_count: this.activeRefreshes, refresh_in_progress: this.activeRefreshes > 0,
        last_production_refresh_completed_at: this.iso(),
      })
    }
  }
  async confirmSetup() {
    if (!this.android) { this.update({ state: 'UNAVAILABLE', setup: 'IDLE' }); return }
    if (this.production) { await this.confirmProductionSetup(this.production); return }
    this.update({ setup: 'IDLE' })
    const previousConsent = this.snapshot.consent
    const consent: ConsentState = {
      domain: 'DIGITAL_WELLNESS', state: 'GRANTED', consentReference: `digital-wellness-${this.now()}`,
      policyVersion: 'digitalWellness.3b2.v1',
    }
    this.update({ consent, state: 'OS_ACCESS_REQUIRED', error: null })
    if (!this.observeContinuity('CONSENT_ENABLED', null)) {
      this.update({ consent: previousConsent, state: 'ERROR' })
      return
    }
    await this.openSettings()
  }
  // Explicit Elite+ opt-in. Success is only ever derived from the native production store reporting
  // consent === true; Android Usage Access is checked separately afterwards by a direct native probe.
  private async confirmProductionSetup(production: DigitalWellnessProductionNative) {
    if (this.snapshot.setup === 'SAVING' || this.snapshot.setup === 'DISABLING') return
    const generation = ++this.generation
    this.update({ setup: 'SAVING', error: null })
    const persisted = await this.writeProductionConsent(production, true)
    if (generation !== this.generation) return
    if (persisted?.consent !== true) {
      this.update({ setup: 'CONSENT_PROMPT' })
      if (persisted) this.applyProduction(persisted)
      this.fail('Digital Wellness could not be turned on. Your choice was not saved; collection is still off.')
      return
    }
    this.update({ setup: 'IDLE' })
    this.applyProduction(persisted)
    const probe = await this.checkNativeUsageAccess()
    if (generation !== this.generation) return
    if (probe.osAccess === 'GRANTED') {
      // Native refresh reschedules the periodic worker whenever consent and access are both present.
      await this.productionRefresh()
      return
    }
    await this.openSettings()
  }
  // Returns the native persisted state after the write, or null if neither the write nor a read-back answered.
  // A rejected or timed-out bridge call does not prove nothing was committed, so the store is re-read.
  private async writeProductionConsent(production: DigitalWellnessProductionNative, enabled: boolean) {
    try {
      const state = await withTimeout(production.setProductionConsent({ enabled }), PRODUCTION_CONSENT_WRITE_TIMEOUT_MS)
      if (state.consent === enabled) return state
    } catch { /* reconciled below */ }
    try {
      return await withTimeout(production.getProductionState(), PRODUCTION_STATE_READ_TIMEOUT_MS)
    } catch {
      return null
    }
  }
  async disable(): Promise<void> {
    if (this.production) {
      if (this.snapshot.setup === 'DISABLING') return
      const generation = ++this.generation
      this.update({ setup: 'DISABLING', error: null, eventSequence: [] })
      const persisted = await this.writeProductionConsent(this.production, false)
      if (generation !== this.generation) return
      this.update({ setup: 'IDLE' })
      if (persisted) this.applyProduction(persisted)
      if (persisted?.consent !== false) {
        this.fail('Digital Wellness could not be disabled. Retry disabling before leaving this screen.')
      }
      return
    }
    this.generation++
    const consent: ConsentState = { ...this.snapshot.consent, state: 'REVOKED', policyVersion: 'digitalWellness.3b2.v1' }
    this.update({ consent, state: 'DISABLED', setup: 'IDLE', error: null })
    this.observeContinuity('CONSENT_DISABLED', null)
  }
  async openSettings() {
    if (!this.android) { this.update({ state: 'UNAVAILABLE' }); return }
    try {
      this.settingsPending = true
      await this.native.openUsageAccessSettings()
      await this.returnedFromSettings()
    } catch {
      this.settingsPending = false
      this.fail('Android Usage Access settings could not be opened.')
    }
  }
  async returnedFromSettings() {
    if (!this.settingsPending) return
    this.settingsPending = false
    await this.recheckAccess()
  }
  async recheckAccess(): Promise<boolean> {
    if (this.production && this.android) {
      await this.checkNativeUsageAccess()
      // Refresh appends continuity evidence (including DENIED); it re-probes before deriving state.
      if (this.snapshot.consent.state === 'GRANTED') await this.productionRefresh()
      return this.snapshot.osAccess === 'GRANTED'
    }
    if (this.snapshot.consent.state !== 'GRANTED') { this.update({ state: 'DISABLED' }); return false }
    if (!this.android) { this.update({ state: 'UNAVAILABLE', permission: 'UNAVAILABLE' }); return false }
    const generation = this.generation
    try {
      const availability = await this.native.isUsageAccessAvailable()
      const { available } = availability
      this.accessDiagnostics = queryDiagnostics(availability, 0, 0, 'USAGE_STATS_UNAVAILABLE', 'SERVICE_LOOKUP')
      const access = available ? await this.native.hasUsageAccess() : { granted: false }
      const { granted } = access
      if (available) {
        const probe = probeResult(access, new Date(this.now()).toISOString())
        this.update({ osAccess: probe.osAccess, nativeProbe: probe })
        this.accessDiagnostics = queryDiagnostics(access, 0, 0,
          'USAGE_ACCESS_DENIED', 'ACCESS_CHECK', this.accessDiagnostics)
        this.accessDiagnostics.usage_access_at_query = granted ? 'GRANTED' : 'DENIED'
      }
      if (generation !== this.generation) return false
      if (!available) { this.update({ state: 'UNAVAILABLE', permission: 'UNAVAILABLE' }); return false }
      if (!this.observeContinuity('ACCESS_CHECK', granted)) return false
      if (!granted) {
        if (this.previouslyAuthorized) this.permissionGap = true
        this.update({
          state: this.previouslyAuthorized ? 'PERMISSION_REVOKED' : 'OS_ACCESS_REQUIRED',
          permission: this.previouslyAuthorized ? 'REVOKED' : 'DENIED',
        })
        return false
      }
      this.previouslyAuthorized = true
      this.update({ state: 'AVAILABLE', permission: 'AUTHORIZED', error: null })
      return true
    } catch (error) {
      this.accessDiagnostics = queryDiagnostics(error, 0, 0, 'QUERY_FAILED', 'ACCESS_CHECK', this.accessDiagnostics)
      if (generation === this.generation) this.fail('Android Usage Access could not be checked.')
      return false
    }
  }
  async refresh(options: {
    hours?: 1 | 6 | 24 | 48
    validation?: boolean
    lateNightWindow?: { start: string; end: string }
  } = {}) {
    if (this.production) { await this.productionRefresh(); return }
    if (this.busy) return
    this.busy = true
    const generation = this.generation
    const hours = options.hours ?? 24
    const startedAt = new Date(this.now()).toISOString()
    const queryEnd = this.now()
    const queryStart = queryEnd - hours * 60 * 60 * 1000
    const emptyCounts = Object.fromEntries(EVENT_TYPES.map((type) => [type, null])) as Record<AndroidUsageEventType, number | null>
    let receiptPermission: DigitalWellnessValidationReceipt['permission_state'] =
      this.snapshot.consent.state === 'GRANTED' ? 'DENIED' : 'NOT_CHECKED'
    let eventCounts = emptyCounts
    let totalSupportedEvents: number | null = null
    let deduplicatedCount: number | null = null
    let result: AndroidDigitalWellnessResult | null = null
    let diagnostics: QueryDiagnostics | undefined
    let stage: QueryErrorStage = 'ACCESS_CHECK'
    if (options.validation) this.update({ eventSequence: [] })
    try {
      if (this.snapshot.consent.state !== 'GRANTED' && options.validation) {
        this.update({ state: 'CONSENT_REQUIRED' })
        return
      }
      if (!await this.recheckAccess() || generation !== this.generation) {
        if (this.accessDiagnostics) diagnostics = queryDiagnostics(this.accessDiagnostics, queryStart, queryEnd)
        if (this.snapshot.permission === 'DENIED' || this.snapshot.permission === 'REVOKED') receiptPermission = 'DENIED'
        else receiptPermission = this.snapshot.state === 'ERROR' ? 'QUERY_FAILED' : 'NOT_CHECKED'
        return
      }
      receiptPermission = 'GRANTED'
      this.update({ state: 'COLLECTING', error: null })
      const timezone = this.timezone()
      stage = 'QUERY_EVENTS'
      const response = await this.native.queryDigitalWellnessEvents({ start: queryStart, end: queryEnd })
      diagnostics = queryDiagnostics(response, queryStart, queryEnd, 'BRIDGE_FAILURE', 'BRIDGE_SERIALIZATION',
        this.accessDiagnostics)
      stage = 'ACCESS_CHECK'
      if (generation !== this.generation) { receiptPermission = 'NOT_CHECKED'; return }
      if (!await this.recheckAccess()) {
        diagnostics = queryDiagnostics(this.accessDiagnostics, queryStart, queryEnd)
        receiptPermission = 'DENIED'
        return
      }
      stage = 'BRIDGE_SERIALIZATION'
      if (response.permissionState !== 'AUTHORIZED' || response.queryStart !== queryStart || response.queryEnd !== queryEnd
        || response.historyCompleteness !== 'UNVERIFIED' || response.events.length > 50_000
        || !Number.isFinite(response.collectionTimestamp)
        || typeof response.OSVersion !== 'string' || !response.OSVersion.trim()
        || !Number.isSafeInteger(response.totalSupportedEvents) || response.totalSupportedEvents < response.events.length
        || !Number.isSafeInteger(response.deduplicatedCount)
        || response.deduplicatedCount !== response.totalSupportedEvents - response.events.length
        || EVENT_TYPES.some((type) => !Number.isSafeInteger(response.eventCounts[type]) || response.eventCounts[type] < 0)
        || EVENT_TYPES.reduce((sum, type) => sum + response.eventCounts[type], 0) !== response.events.length) {
        throw new Error('Invalid native result')
      }
      eventCounts = response.eventCounts
      totalSupportedEvents = response.totalSupportedEvents
      deduplicatedCount = response.deduplicatedCount
      const supported = new Set(['SCREEN_INTERACTIVE', 'SCREEN_NON_INTERACTIVE', 'KEYGUARD_SHOWN', 'KEYGUARD_HIDDEN'])
      const events = response.events.map(({ eventType, timestamp }) => {
        if (!supported.has(eventType) || !Number.isSafeInteger(timestamp) || timestamp < queryStart || timestamp >= queryEnd) {
          throw new Error('Invalid native event')
        }
        return { type: eventType, timestamp: new Date(timestamp).toISOString() }
      })
      if (options.validation) {
        this.update({
          eventSequence: response.events.map(({ eventType, timestamp }) => ({
            eventType, timestamp: new Date(timestamp).toISOString(),
          })),
        })
      }
      stage = 'SEMANTIC_PROCESSING'
      result = processAndroidDigitalWellness({
        events, start: new Date(queryStart).toISOString(), end: new Date(queryEnd).toISOString(),
        osVersion: response.OSVersion, timezone, dayBoundary: '00:00',
        lateNightWindow: options.lateNightWindow ?? { start: '22:00', end: '06:00' },
        gaps: [
          { start: new Date(queryStart).toISOString(), end: new Date(queryEnd).toISOString(), reason: 'HISTORY_GAP' },
          ...(this.permissionGap ? [{
            start: new Date(queryStart).toISOString(), end: new Date(queryEnd).toISOString(), reason: 'PERMISSION_GAP' as const,
          }] : []),
        ],
        qualification: {
          usageAccessContinuous: false,
          historyCoverage: false,
          noPermissionGaps: false,
          noRebootGaps: false,
        },
      })
      stage = 'UNKNOWN'
      const consentReference = this.snapshot.consent.consentReference
      if (!consentReference || generation !== this.generation) return
      const aggregateResult: AndroidDigitalWellnessResult = {
        ...result,
        days: result.days.map((day) => ({ ...day, sessions: null })),
      }
      const record: LocalDigitalWellnessRecord = {
        result: aggregateResult, capturedAt: new Date(response.collectionTimestamp).toISOString(),
        consentReference, deliveryCapability: 'LOCAL_ONLY',
        queryStart: new Date(queryStart).toISOString(), queryEnd: new Date(queryEnd).toISOString(),
        osVersion: response.OSVersion, timezone,
      }
      const records = [...this.snapshot.records, record]
      this.storage.setItem(RECORDS_KEY, JSON.stringify(records))
      this.update({ records, state: 'LOCAL_DATA_READY', error: null })
      diagnostics = undefined
    } catch (error) {
      if (generation !== this.generation) return
      diagnostics = queryDiagnostics(error, queryStart, queryEnd,
        stage === 'BRIDGE_SERIALIZATION' ? 'BRIDGE_FAILURE'
          : stage === 'SEMANTIC_PROCESSING' ? 'SEMANTIC_PROCESSING_FAILED' : 'QUERY_FAILED',
        stage, diagnostics ?? this.accessDiagnostics)
      result = null
      eventCounts = emptyCounts
      totalSupportedEvents = null
      deduplicatedCount = null
      if (options.validation) this.update({ eventSequence: [] })
      if (diagnostics.error_code === 'USAGE_ACCESS_DENIED'
        || diagnostics.error_code === 'SECURITY_EXCEPTION'
        || (typeof error === 'object' && error !== null && 'code' in error && error.code === 'USAGE_ACCESS_REQUIRED')) {
        receiptPermission = 'DENIED'
        this.permissionGap = true
        this.update({ state: 'PERMISSION_REVOKED', permission: 'REVOKED' })
      } else {
        receiptPermission = 'QUERY_FAILED'
        this.fail('Digital Wellness refresh failed. No new observations were saved.')
      }
    } finally {
      if (options.validation) {
        const metricDay = result?.days.at(-1)
        this.saveReceipt({
          validation_id: `${queryEnd}-${++this.receiptSequence}`,
          started_at: startedAt,
          completed_at: new Date(this.now()).toISOString(),
          query_window: { start: new Date(queryStart).toISOString(), end: new Date(queryEnd).toISOString(), duration_hours: hours },
          permission_state: receiptPermission,
          ...(diagnostics ? { query_diagnostics: diagnostics } : {}),
          event_counts: eventCounts,
          total_supported_events: totalSupportedEvents,
          deduplicated_count: deduplicatedCount,
          semantic_version: 'android.digital_balance.v1',
          resulting_metrics: {
            screen_time_minutes: metricDay?.screen_time_minutes ?? null,
            pickups: metricDay?.pickups ?? null,
            first_pickup: metricDay?.first_pickup ?? null,
            screen_sessions: metricDay?.screen_sessions ?? null,
            late_night_screen_minutes: metricDay?.late_night_screen_minutes ?? null,
          },
          coverage: metricDay?.coverage.state ?? 'UNKNOWN',
          confidence: metricDay?.confidence ?? 'UNKNOWN',
          quality_reasons: result?.qualityReasons ?? [receiptPermission === 'QUERY_FAILED' || this.snapshot.state === 'UNAVAILABLE'
            ? 'QUERY_FAILURE' : receiptPermission === 'NOT_CHECKED' && this.snapshot.consent.state !== 'GRANTED'
              ? 'CONSENT_REQUIRED' : 'USAGE_ACCESS_REQUIRED'],
        })
      }
      this.busy = false
    }
  }
}

const installedLifecycles = new WeakMap<Document, LocalDigitalWellness>()
// Idempotent: exactly one visibility listener per document, and every resume goes through the coalesced chain.
export function installForegroundLifecycle(doc: Document, wellness: LocalDigitalWellness): Promise<void> {
  if (!installedLifecycles.has(doc)) {
    installedLifecycles.set(doc, wellness)
    doc.addEventListener('visibilitychange', () => {
      if (doc.visibilityState === 'visible') void installedLifecycles.get(doc)?.onForegroundResume()
    })
  }
  // initializeProduction() already ran the startup access probe; only an eligible refresh may follow it.
  return wellness.initializeProduction().then(() => wellness.getSnapshot().consent.state === 'GRANTED'
    ? wellness.onForegroundResume() : undefined)
}
