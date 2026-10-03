import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { BatchDeliveryEvent, BatchDeliveryListener } from '../../services/sync/ObservationBatchManager'
import { crashBreadcrumbs, type BreadcrumbDetail } from '../../services/diagnostics/CrashBreadcrumbs'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import {
  findPhysiologyContract,
  mapPhysiologyObservation,
  PHYSIOLOGY_METRIC_KEYS,
  type PhysiologyMetricKey,
  type PhysiologySourceContext,
} from './PhysiologyContract'

export interface PhysiologyDeliveryDependencies {
  queue: {
    getOwnerUserId: () => string | null
    enqueueMany: (observations: NativeObservationInput[]) => Promise<Array<{ inserted: boolean; alreadyQueued: boolean }>>
  }
  /** One ObservationBatchManager pass (≤100 observations); null when nothing was sent. */
  deliver: () => Promise<unknown>
  subscribe: (listener: BatchDeliveryListener) => () => void
  resolveDeviceId: (bleAddress: string) => string
  breadcrumbs?: { record: (stage: string, detail?: BreadcrumbDetail) => void; recordError: (kind: 'lastHistoricalDeliveryError', error: unknown, context?: string) => void }
  /** Yields between processing chunks so the WebView stays responsive. */
  yieldToEventLoop?: () => Promise<void>
}

export const PHYSIOLOGY_DELIVERY_POLICY = {
  maxDeliveryRoundsPerSync: 500,
  /** Map → validate → enqueue at most this many observations before releasing references and yielding. */
  processingChunkSize: 250,
  changeThrottleMs: 500,
  safeTestMaxObservations: 300,
  /** Second physical step, only after the 300 Safe Test passes. */
  boundedTestMaxObservations: 1_300,
} as const

export type PhysiologyProgressStage = 'IDLE' | 'MAPPING' | 'ENQUEUING' | 'DELIVERING' | 'COMPLETE' | 'FAILED' | 'DISABLED'

export interface PhysiologyProgress {
  syncId: string
  vendorDataType: string
  stage: PhysiologyProgressStage
  safeTest: boolean
  sourceRecords: number
  normalized: number
  selectedForTest: number | null
  mapped: number
  queued: number
  alreadyQueued: number
  /** Non-deliverable (no-measurement placeholder) observations mapped so far in this sync only. */
  notDeliverable: number
  currentChunk: number
  estimatedTotalChunks: number
  largestChunk: number
  startedAt: string
  completedAt: string | null
}

export interface DeliverOptions {
  /** Diagnostic safe test: deliver only the first N valid observations, regardless of the delivery toggle. */
  maxObservations?: number
  /** Streamed chunks: map + enqueue only; the caller drains once via drainDeferred() after the final chunk. */
  deferDrain?: boolean
  /** Streamed chunks: total observations the native stream will send, for the chunk estimate. */
  expectedTotalObservations?: number
}

/** How one batch event's per-observation results were applied (counts only). */
export interface PhysiologyResultHandling {
  batchId: string
  at: string
  outcome: string
  trackedObservations: number
  eventHasResults: boolean
  eventResultCount: number | null
  matchedResults: number
  appliedAccepted: number
  appliedDuplicate: number
  appliedRejected: number
  appliedCanonicalized: number
  withNativeObservationId: number
  /** True when results[] was absent and only batch totals could be attributed. */
  legacyTotalsPath: boolean
}

const MAX_RESULT_HANDLING = 10

function defaultYield(): Promise<void> { return new Promise((resolve) => setTimeout(resolve, 0)) }

function breadcrumbPrefix(vendorDataType: string): string {
  return ({ '27': 'HR', '68': 'SPO2', '59': 'TEMPERATURE', '42': 'HRV', '127': 'PPI' } as Record<string, string>)[vendorDataType] ?? `TYPE_${vendorDataType}`
}

/** Per-observation delivery outcome; DELIVERED is an acknowledged row whose response carried no results[] entry. */
export type PhysiologyDeliveryState =
  | 'QUEUED' | 'RETRYING'
  | 'DELIVERED_CANONICALIZED' | 'DELIVERED_NATIVE_ONLY' | 'CANONICAL_FAILED' | 'DELIVERED_DUPLICATE' | 'DELIVERED'
  | 'REJECTED' | 'FAILED'

const DELIVERED_STATES = new Set<PhysiologyDeliveryState>(['DELIVERED_CANONICALIZED', 'DELIVERED_NATIVE_ONLY', 'DELIVERED_DUPLICATE', 'DELIVERED'])

interface TrackedObservation { key: PhysiologyMetricKey; state: PhysiologyDeliveryState; nativeObservationId: string | null }

export interface PhysiologyMetricCounters {
  captured: number
  notDeliverable: number
  invalid: number
  queued: number
  alreadyQueued: number
  awaitingDelivery: number
  retrying: number
  uniqueObservationsDelivered: number
  serverAccepted: number
  serverDuplicate: number
  serverRejected: number
  canonicalized: number
  nativeOnly: number
  /** Stored as NativeObservation but canonicalization failed; delivered, not failed. */
  canonicalFailed: number
  failed: number
}

export interface PhysiologyResultIssue { observationId: string | null; metric: PhysiologyMetricKey | null; status: string; reason: string | null; errorCode: string | null; at: string }

export interface PhysiologyDeliverySnapshot {
  enabled: boolean
  enabledMetrics: PhysiologyMetricKey[]
  backendDeviceId: string | null
  metrics: Record<PhysiologyMetricKey, PhysiologyMetricCounters>
  /** Batch-level accepted/duplicate from responses without results[] that mixed metrics or sources. */
  mixedBatchServerAccepted: number
  mixedBatchServerDuplicate: number
  total: PhysiologyMetricCounters & { mixedBatchServerAccepted: number; mixedBatchServerDuplicate: number }
  outcomeCounts: Record<PhysiologyDeliveryState, number>
  lastNativeObservationIds: Record<PhysiologyMetricKey, string | null>
  lastRejection: PhysiologyResultIssue | null
  lastCanonicalFailure: PhysiologyResultIssue | null
  /** errors[] entries without a usable observationId (supplementary only). */
  unattributedErrors: number
  lastInvalidReason: string | null
  lastSync: { vendorDataType: string; syncId: string; at: string; mapped: number; queued: number; notDeliverable: number } | null
  progress: PhysiologyProgress | null
  resultHandling: PhysiologyResultHandling[]
  lastError: string | null
}

export interface PhysiologySyncReport {
  delivered: boolean
  reason: string | null
  mapped: number
  queued: number
  alreadyQueued: number
  /** Non-deliverable (no-measurement placeholder) observations from this sync only; cumulative counters span prior syncs too. */
  notDeliverable: number
}

function emptyCounters(): PhysiologyMetricCounters {
  return { captured: 0, notDeliverable: 0, invalid: 0, queued: 0, alreadyQueued: 0, awaitingDelivery: 0, retrying: 0, uniqueObservationsDelivered: 0, serverAccepted: 0, serverDuplicate: 0, serverRejected: 0, canonicalized: 0, nativeOnly: 0, canonicalFailed: 0, failed: 0 }
}

function emptyMetricCounters(): Record<PhysiologyMetricKey, PhysiologyMetricCounters> {
  return Object.fromEntries(PHYSIOLOGY_METRIC_KEYS.map((key) => [key, emptyCounters()])) as Record<PhysiologyMetricKey, PhysiologyMetricCounters>
}

/** Build 5B-1: JCVital historical physiology → durable queue → the unchanged Build 5A batch sender. */
export class JCVitalPhysiologyDelivery {
  private readonly deps: PhysiologyDeliveryDependencies
  private enabled = false
  private readonly enabledMetrics = new Set<PhysiologyMetricKey>(PHYSIOLOGY_METRIC_KEYS)
  private context: PhysiologySourceContext = { deviceId: null, firmwareVersion: null, sdkVersion: null }
  private readonly tracked = new Map<string, TrackedObservation>()
  private readonly deliveredIds = new Map<PhysiologyMetricKey, Set<string>>()
  private counters = emptyMetricCounters()
  private mixedAccepted = 0
  private mixedDuplicate = 0
  private lastNativeObservationIds = Object.fromEntries(PHYSIOLOGY_METRIC_KEYS.map((key) => [key, null])) as Record<PhysiologyMetricKey, string | null>
  private lastRejection: PhysiologyResultIssue | null = null
  private lastCanonicalFailure: PhysiologyResultIssue | null = null
  private unattributedErrors = 0
  private lastInvalidReason: string | null = null
  private lastSync: PhysiologyDeliverySnapshot['lastSync'] = null
  private lastError: string | null = null
  private unsubscribe: (() => void) | null = null
  private draining = false
  private progress: PhysiologyProgress | null = null
  private resultHandling: PhysiologyResultHandling[] = []
  private lastEmitAt = 0
  private pendingEmit: ReturnType<typeof setTimeout> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(deps: PhysiologyDeliveryDependencies) { this.deps = deps }

  private get breadcrumbs() { return this.deps.breadcrumbs ?? crashBreadcrumbs }

  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.deps.subscribe((event) => this.handleBatch(event))
    this.emit()
  }
  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.pendingEmit) clearTimeout(this.pendingEmit)
    this.pendingEmit = null
    this.listeners.clear()
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }

  private emit(): void {
    this.lastEmitAt = Date.now()
    this.listeners.forEach((listener) => listener())
  }

  /** Leading + trailing throttle so historical delivery cannot re-render React per observation or batch. */
  private changed(): void {
    const wait = PHYSIOLOGY_DELIVERY_POLICY.changeThrottleMs - (Date.now() - this.lastEmitAt)
    if (wait <= 0 && !this.pendingEmit) { this.emit(); return }
    if (!this.pendingEmit) this.pendingEmit = setTimeout(() => { this.pendingEmit = null; this.emit() }, Math.max(0, wait))
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; this.emit() }
  isEnabled(): boolean { return this.enabled }
  setMetricEnabled(key: PhysiologyMetricKey, enabled: boolean): void {
    if (enabled) this.enabledMetrics.add(key)
    else this.enabledMetrics.delete(key)
    this.emit()
  }

  setContext(update: { bleAddress?: string | null; firmwareVersion?: string | null; sdkVersion?: string | null }): void {
    this.context = {
      deviceId: update.bleAddress ? this.deps.resolveDeviceId(update.bleAddress) : this.context.deviceId,
      firmwareVersion: update.firmwareVersion ?? this.context.firmwareVersion,
      sdkVersion: update.sdkVersion ?? this.context.sdkVersion,
    }
    this.changed()
  }

  resetDiagnostics(): void {
    this.counters = emptyMetricCounters()
    for (const [id, entry] of this.tracked) if (DELIVERED_STATES.has(entry.state) || entry.state === 'REJECTED' || entry.state === 'FAILED') this.tracked.delete(id)
    this.deliveredIds.clear()
    this.mixedAccepted = 0
    this.mixedDuplicate = 0
    this.lastNativeObservationIds = Object.fromEntries(PHYSIOLOGY_METRIC_KEYS.map((key) => [key, null])) as Record<PhysiologyMetricKey, string | null>
    this.lastRejection = null
    this.lastCanonicalFailure = null
    this.unattributedErrors = 0
    this.lastInvalidReason = null
    this.lastError = null
    this.progress = null
    this.resultHandling = []
    this.emit()
  }

  /**
   * Maps, enqueues and drains one historical sync result in bounded chunks. Capture/acquisition is never altered,
   * and no mapped payload is retained after its chunk is enqueued.
   */
  async deliverSyncResult(result: JCVitalV8HistoricalSyncResult, options: DeliverOptions = {}): Promise<PhysiologySyncReport> {
    const report: PhysiologySyncReport = { delivered: false, reason: null, mapped: 0, queued: 0, alreadyQueued: 0, notDeliverable: 0 }
    const safeTest = options.maxObservations !== undefined
    if (!this.enabled && !safeTest) return { ...report, reason: 'physiology delivery disabled' }
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) { this.lastError = 'Queue owner is not authenticated.'; this.changed(); return { ...report, reason: this.lastError } }
    const prefix = breadcrumbPrefix(result.vendorDataType)
    const chunkSize = PHYSIOLOGY_DELIVERY_POLICY.processingChunkSize
    const limit = options.maxObservations ?? Number.POSITIVE_INFINITY
    const natives = result.observations
    const previous = this.progress
    // Streamed chunks of one sync accumulate into one progress record.
    const continuing = options.deferDrain === true && previous !== null && previous.syncId === result.syncId && previous.stage !== 'COMPLETE' && previous.stage !== 'FAILED'
    const progress: PhysiologyProgress = continuing && previous ? previous : {
      syncId: result.syncId, vendorDataType: result.vendorDataType, stage: 'MAPPING', safeTest, sourceRecords: 0, normalized: 0,
      selectedForTest: safeTest ? options.maxObservations! : null, mapped: 0, queued: 0, alreadyQueued: 0, notDeliverable: 0, currentChunk: 0,
      estimatedTotalChunks: 1, largestChunk: 0, startedAt: new Date().toISOString(), completedAt: null,
    }
    progress.stage = 'MAPPING'
    progress.sourceRecords = Math.max(progress.sourceRecords, result.recordGroupsReceived)
    progress.normalized += natives.length
    const expectedTotal = Math.max(options.expectedTotalObservations ?? 0, progress.normalized)
    progress.estimatedTotalChunks = Math.max(progress.currentChunk + 1, Math.ceil(Math.min(expectedTotal, limit) / chunkSize))
    this.progress = progress
    if (!continuing) this.breadcrumbs.record(`${prefix}_DELIVERY_MAPPING_STARTED`, { normalized: natives.length, sourceRecords: result.recordGroupsReceived, safeTest, limit: safeTest ? limit : null, streamed: options.deferDrain === true })
    this.changed()
    let pending: Array<{ key: PhysiologyMetricKey; observation: NativeObservationInput }> = []
    const flush = async (force: boolean) => {
      while (pending.length >= chunkSize || (force && pending.length)) {
        const chunk = pending.slice(0, chunkSize)
        pending = pending.slice(chunkSize)
        progress.stage = 'ENQUEUING'
        progress.currentChunk++
        progress.largestChunk = Math.max(progress.largestChunk, chunk.length)
        if (progress.currentChunk === 1) this.breadcrumbs.record(`${prefix}_ENQUEUE_STARTED`, { chunkSize })
        this.breadcrumbs.record(`${prefix}_ENQUEUE_CHUNK_INDEX`, { chunk: progress.currentChunk, size: chunk.length, mappedSoFar: progress.mapped })
        const results = await this.deps.queue.enqueueMany(chunk.map((item) => item.observation))
        results.forEach((enqueued, index) => {
          const { key, observation } = chunk[index]
          if (enqueued.inserted) { this.counters[key].queued++; progress.queued++ }
          else { this.counters[key].alreadyQueued++; progress.alreadyQueued++ }
          const existing = this.tracked.get(observation.observationId)
          if (!existing || !DELIVERED_STATES.has(existing.state)) this.tracked.set(observation.observationId, { key, state: 'QUEUED', nativeObservationId: null })
        })
        this.changed()
        await (this.deps.yieldToEventLoop ?? defaultYield)()
      }
    }
    try {
      for (const native of natives) {
        if (progress.mapped >= limit) break
        const contract = findPhysiologyContract(native)
        if (!contract || !this.enabledMetrics.has(contract.key)) continue
        for (const outcome of await mapPhysiologyObservation(owner, native, this.context, contract)) {
          if (progress.mapped >= limit) break
          const counters = this.counters[outcome.key]
          counters.captured++
          if (outcome.status === 'MAPPED') { pending.push(outcome); progress.mapped++ }
          else if (outcome.status === 'NOT_DELIVERABLE') { counters.notDeliverable++; progress.notDeliverable++ }
          else { counters.invalid++; this.lastInvalidReason = `${outcome.key}: ${outcome.reason}` }
        }
        if (pending.length >= chunkSize) await flush(false)
      }
      this.breadcrumbs.record(`${prefix}_MAPPED_COUNT`, { mapped: progress.mapped })
      await flush(true)
      this.breadcrumbs.record(`${prefix}_ENQUEUED_COUNT`, { queued: progress.queued, alreadyQueued: progress.alreadyQueued, chunks: progress.currentChunk })
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
      progress.stage = 'FAILED'
      this.breadcrumbs.recordError('lastHistoricalDeliveryError', error, `${prefix} chunk ${progress.currentChunk}`)
      this.changed()
      return { ...report, mapped: progress.mapped, queued: progress.queued, alreadyQueued: progress.alreadyQueued, notDeliverable: progress.notDeliverable, reason: this.lastError }
    }
    Object.assign(report, { mapped: progress.mapped, queued: progress.queued, alreadyQueued: progress.alreadyQueued, notDeliverable: progress.notDeliverable })
    this.lastSync = { vendorDataType: result.vendorDataType, syncId: result.syncId, at: new Date().toISOString(), mapped: report.mapped, queued: report.queued, notDeliverable: report.notDeliverable }
    if (options.deferDrain) {
      this.changed()
      return { ...report, delivered: true }
    }
    if (report.queued || report.alreadyQueued) {
      progress.stage = 'DELIVERING'
      this.changed()
      this.breadcrumbs.record(`${prefix}_BATCH_SEND_STARTED`, { queued: report.queued })
      await this.drain()
      this.breadcrumbs.record(`${prefix}_BATCH_SEND_DRAINED`, { delivered: this.getSnapshot().total.uniqueObservationsDelivered })
    }
    progress.stage = 'COMPLETE'
    progress.completedAt = new Date().toISOString()
    this.changed()
    return { ...report, delivered: true }
  }

  /** Completes a streamed sync whose chunks were enqueued with deferDrain. */
  async drainDeferred(vendorDataType: string): Promise<void> {
    const prefix = breadcrumbPrefix(vendorDataType)
    const progress = this.progress
    if (progress) progress.stage = 'DELIVERING'
    this.changed()
    this.breadcrumbs.record(`${prefix}_BATCH_SEND_STARTED`, { deferred: true })
    await this.drain()
    this.breadcrumbs.record(`${prefix}_BATCH_SEND_DRAINED`, { delivered: this.getSnapshot().total.uniqueObservationsDelivered })
    if (progress) { progress.stage = 'COMPLETE'; progress.completedAt = new Date().toISOString() }
    this.changed()
  }

  private hasQueued(): boolean {
    for (const entry of this.tracked.values()) if (entry.state === 'QUEUED') return true
    return false
  }

  /** Retries after RETRYING are owned by the batch manager's backoff timer. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (let round = 0; round < PHYSIOLOGY_DELIVERY_POLICY.maxDeliveryRoundsPerSync; round++) {
        const sent = await this.deps.deliver()
        if (!sent || !this.hasQueued()) break
      }
    } finally {
      this.draining = false
    }
  }

  private markDelivered(id: string, entry: TrackedObservation, state: PhysiologyDeliveryState): void {
    if (entry.state === 'CANONICAL_FAILED') return
    // Replays must not downgrade an earlier canonical outcome to DELIVERED_DUPLICATE.
    if (!DELIVERED_STATES.has(entry.state) || entry.state === 'DELIVERED') entry.state = state
    const set = this.deliveredIds.get(entry.key) ?? new Set<string>()
    set.add(id)
    this.deliveredIds.set(entry.key, set)
  }

  private applyResult(id: string, entry: TrackedObservation, result: ConnectorObservationResult, at: string): void {
    const counters = this.counters[entry.key]
    const issue = (status: string): PhysiologyResultIssue => ({ observationId: id, metric: entry.key, status, reason: result.reason ?? null, errorCode: result.errorCode ?? null, at })
    if (result.status === 'rejected') {
      counters.serverRejected++
      entry.state = 'REJECTED'
      this.lastRejection = issue('rejected')
      return
    }
    if (result.status === 'duplicate') {
      counters.serverDuplicate++
      this.markDelivered(id, entry, 'DELIVERED_DUPLICATE')
      return
    }
    counters.serverAccepted++
    if (result.nativeObservationId) {
      entry.nativeObservationId = result.nativeObservationId
      this.lastNativeObservationIds[entry.key] = result.nativeObservationId
    }
    if (result.canonicalStatus === 'canonicalized') { counters.canonicalized++; this.markDelivered(id, entry, 'DELIVERED_CANONICALIZED') }
    else if (result.canonicalStatus === 'not_applicable') { counters.nativeOnly++; this.markDelivered(id, entry, 'DELIVERED_NATIVE_ONLY') }
    else if (result.canonicalStatus === 'failed') { counters.canonicalFailed++; this.lastCanonicalFailure = issue('accepted/canonical_failed'); entry.state = 'CANONICAL_FAILED' }
    else this.markDelivered(id, entry, 'DELIVERED')
  }

  private handleBatch(event: BatchDeliveryEvent): void {
    const ours = event.observationIds.filter((id) => this.tracked.has(id))
    if (!ours.length) return
    const handling: PhysiologyResultHandling = {
      batchId: event.batchId, at: event.attemptedAt, outcome: event.outcome, trackedObservations: ours.length,
      eventHasResults: Array.isArray(event.results), eventResultCount: Array.isArray(event.results) ? event.results.length : null,
      matchedResults: 0, appliedAccepted: 0, appliedDuplicate: 0, appliedRejected: 0, appliedCanonicalized: 0, withNativeObservationId: 0,
      legacyTotalsPath: false,
    }
    this.resultHandling = [...this.resultHandling, handling].slice(-MAX_RESULT_HANDLING)
    if (event.outcome === 'DELIVERED' || event.outcome === 'PARTIAL' || event.outcome === 'CANONICAL_FAILED') {
      const results = new Map((event.results ?? []).map((result) => [result.observationId, result]))
      const errorReasons = new Map((event.errors ?? []).filter((error) => error.observationId).map((error) => [error.observationId!, error.reason ?? error.message ?? null]))
      this.unattributedErrors += (event.errors ?? []).filter((error) => !error.observationId).length
      const rejected = new Set(event.rejectedIds)
      const withoutResult: string[] = []
      for (const id of ours) {
        const entry = this.tracked.get(id)!
        const result = results.get(id)
        if (result) {
          handling.matchedResults++
          if (result.status === 'accepted') handling.appliedAccepted++
          else if (result.status === 'duplicate') handling.appliedDuplicate++
          else if (result.status === 'rejected') handling.appliedRejected++
          if (result.canonicalStatus === 'canonicalized') handling.appliedCanonicalized++
          if (result.nativeObservationId) handling.withNativeObservationId++
          this.applyResult(id, entry, result, event.attemptedAt)
          continue
        }
        withoutResult.push(id)
        if (rejected.has(id)) {
          this.counters[entry.key].serverRejected++
          entry.state = 'REJECTED'
          this.lastRejection = { observationId: id, metric: entry.key, status: 'rejected', reason: errorReasons.get(id) ?? null, errorCode: null, at: event.attemptedAt }
        } else if (event.acknowledgedIds.includes(id)) this.markDelivered(id, entry, 'DELIVERED')
      }
      for (const id of event.canonicalFailedIds ?? []) {
        const entry = this.tracked.get(id)
        if (!entry) continue
        if (entry.state === 'CANONICAL_FAILED') continue
        entry.state = 'CANONICAL_FAILED'
        this.counters[entry.key].canonicalFailed++
        this.lastCanonicalFailure = { observationId: id, metric: entry.key, status: 'accepted/canonical_failed', reason: null, errorCode: 'CANONICAL_FAILURE', at: event.attemptedAt }
      }
      if (!event.results) {
        handling.legacyTotalsPath = true
        // Legacy response: only batch totals exist, so attribute them only when unambiguous.
        const keys = new Set(ours.map((id) => this.tracked.get(id)!.key))
        const singleMetric = keys.size === 1 && ours.length === event.observationIds.length ? [...keys][0] : null
        if (singleMetric) {
          this.counters[singleMetric].serverAccepted += event.accepted ?? 0
          this.counters[singleMetric].serverDuplicate += event.duplicate ?? 0
        } else {
          this.mixedAccepted += event.accepted ?? 0
          this.mixedDuplicate += event.duplicate ?? 0
        }
      }
      // A batch triggered elsewhere (retry timer, other source) may leave our rows still queued.
      if (!this.draining && this.hasQueued()) queueMicrotask(() => { void this.drain() })
    } else {
      const state: PhysiologyDeliveryState = event.outcome === 'RETRYING' ? 'RETRYING' : 'FAILED'
      for (const id of ours) { const entry = this.tracked.get(id)!; if (!DELIVERED_STATES.has(entry.state)) entry.state = state }
    }
    this.changed()
  }

  getSnapshot(): PhysiologyDeliverySnapshot {
    const metrics = emptyMetricCounters()
    for (const key of PHYSIOLOGY_METRIC_KEYS) metrics[key] = { ...this.counters[key], awaitingDelivery: 0, retrying: 0, failed: 0, uniqueObservationsDelivered: this.deliveredIds.get(key)?.size ?? 0 }
    const outcomeCounts = { QUEUED: 0, RETRYING: 0, DELIVERED_CANONICALIZED: 0, DELIVERED_NATIVE_ONLY: 0, CANONICAL_FAILED: 0, DELIVERED_DUPLICATE: 0, DELIVERED: 0, REJECTED: 0, FAILED: 0 } satisfies Record<PhysiologyDeliveryState, number>
    for (const { key, state } of this.tracked.values()) {
      outcomeCounts[state]++
      if (state === 'QUEUED') metrics[key].awaitingDelivery++
      else if (state === 'RETRYING') metrics[key].retrying++
      else if (state === 'REJECTED' || state === 'FAILED') metrics[key].failed++
    }
    const total = emptyCounters()
    for (const key of PHYSIOLOGY_METRIC_KEYS) for (const field of Object.keys(total) as Array<keyof PhysiologyMetricCounters>) total[field] += metrics[key][field]
    return {
      enabled: this.enabled,
      enabledMetrics: PHYSIOLOGY_METRIC_KEYS.filter((key) => this.enabledMetrics.has(key)),
      backendDeviceId: this.context.deviceId,
      metrics,
      mixedBatchServerAccepted: this.mixedAccepted,
      mixedBatchServerDuplicate: this.mixedDuplicate,
      total: { ...total, mixedBatchServerAccepted: this.mixedAccepted, mixedBatchServerDuplicate: this.mixedDuplicate },
      outcomeCounts,
      lastNativeObservationIds: { ...this.lastNativeObservationIds },
      lastRejection: this.lastRejection,
      lastCanonicalFailure: this.lastCanonicalFailure,
      unattributedErrors: this.unattributedErrors,
      lastInvalidReason: this.lastInvalidReason,
      lastSync: this.lastSync,
      progress: this.progress ? { ...this.progress } : null,
      resultHandling: [...this.resultHandling],
      lastError: this.lastError,
    }
  }
}
