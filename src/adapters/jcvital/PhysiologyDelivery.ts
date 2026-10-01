import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import type { BatchDeliveryEvent, BatchDeliveryListener } from '../../services/sync/ObservationBatchManager'
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
}

export const PHYSIOLOGY_DELIVERY_POLICY = { maxDeliveryRoundsPerSync: 500 } as const

/** Per-observation delivery outcome; DELIVERED is an acknowledged row whose response carried no results[] entry. */
export type PhysiologyDeliveryState =
  | 'QUEUED' | 'RETRYING'
  | 'DELIVERED_CANONICALIZED' | 'DELIVERED_NATIVE_ONLY' | 'CANONICAL_FAILED' | 'DELIVERED_DUPLICATE' | 'DELIVERED'
  | 'REJECTED' | 'FAILED'

const DELIVERED_STATES = new Set<PhysiologyDeliveryState>(['DELIVERED_CANONICALIZED', 'DELIVERED_NATIVE_ONLY', 'CANONICAL_FAILED', 'DELIVERED_DUPLICATE', 'DELIVERED'])

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
  lastSync: { vendorDataType: string; syncId: string; at: string; mapped: number; queued: number } | null
  lastError: string | null
}

export interface PhysiologySyncReport {
  delivered: boolean
  reason: string | null
  mapped: number
  queued: number
  alreadyQueued: number
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
  private readonly listeners = new Set<() => void>()

  constructor(deps: PhysiologyDeliveryDependencies) { this.deps = deps }

  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.deps.subscribe((event) => this.handleBatch(event))
    this.changed()
  }
  dispose(): void { this.unsubscribe?.(); this.unsubscribe = null; this.listeners.clear() }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private changed(): void { this.listeners.forEach((listener) => listener()) }

  setEnabled(enabled: boolean): void { this.enabled = enabled; this.changed() }
  setMetricEnabled(key: PhysiologyMetricKey, enabled: boolean): void {
    if (enabled) this.enabledMetrics.add(key)
    else this.enabledMetrics.delete(key)
    this.changed()
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
    this.changed()
  }

  /** Maps, enqueues and drains one historical sync result. Capture/acquisition is never altered. */
  async deliverSyncResult(result: JCVitalV8HistoricalSyncResult): Promise<PhysiologySyncReport> {
    const report: PhysiologySyncReport = { delivered: false, reason: null, mapped: 0, queued: 0, alreadyQueued: 0 }
    if (!this.enabled) return { ...report, reason: 'physiology delivery disabled' }
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) { this.lastError = 'Queue owner is not authenticated.'; this.changed(); return { ...report, reason: this.lastError } }
    const mapped: Array<{ key: PhysiologyMetricKey; observation: NativeObservationInput }> = []
    for (const native of result.observations) {
      const contract = findPhysiologyContract(native)
      if (!contract || !this.enabledMetrics.has(contract.key)) continue
      for (const outcome of await mapPhysiologyObservation(owner, native, this.context, contract)) {
        const counters = this.counters[outcome.key]
        counters.captured++
        if (outcome.status === 'MAPPED') mapped.push(outcome)
        else if (outcome.status === 'NOT_DELIVERABLE') counters.notDeliverable++
        else { counters.invalid++; this.lastInvalidReason = `${outcome.key}: ${outcome.reason}` }
      }
    }
    report.mapped = mapped.length
    if (mapped.length) {
      try {
        const results = await this.deps.queue.enqueueMany(mapped.map((item) => item.observation))
        results.forEach((enqueued, index) => {
          const { key, observation } = mapped[index]
          if (enqueued.inserted) { this.counters[key].queued++; report.queued++ }
          else { this.counters[key].alreadyQueued++; report.alreadyQueued++ }
          const existing = this.tracked.get(observation.observationId)
          if (!existing || !DELIVERED_STATES.has(existing.state)) this.tracked.set(observation.observationId, { key, state: 'QUEUED', nativeObservationId: null })
        })
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : String(error)
        this.changed()
        return { ...report, reason: this.lastError }
      }
    }
    this.lastSync = { vendorDataType: result.vendorDataType, syncId: result.syncId, at: new Date().toISOString(), mapped: report.mapped, queued: report.queued }
    this.changed()
    if (report.queued || report.alreadyQueued) await this.drain()
    return { ...report, delivered: true }
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
    else if (result.canonicalStatus === 'failed') { counters.canonicalFailed++; this.lastCanonicalFailure = issue('accepted/canonical_failed'); this.markDelivered(id, entry, 'CANONICAL_FAILED') }
    else this.markDelivered(id, entry, 'DELIVERED')
  }

  private handleBatch(event: BatchDeliveryEvent): void {
    const ours = event.observationIds.filter((id) => this.tracked.has(id))
    if (!ours.length) return
    if (event.outcome === 'DELIVERED' || event.outcome === 'PARTIAL') {
      const results = new Map((event.results ?? []).map((result) => [result.observationId, result]))
      const errorReasons = new Map((event.errors ?? []).filter((error) => error.observationId).map((error) => [error.observationId!, error.reason ?? error.message ?? null]))
      this.unattributedErrors += (event.errors ?? []).filter((error) => !error.observationId).length
      const rejected = new Set(event.rejectedIds)
      const withoutResult: string[] = []
      for (const id of ours) {
        const entry = this.tracked.get(id)!
        const result = results.get(id)
        if (result) { this.applyResult(id, entry, result, event.attemptedAt); continue }
        withoutResult.push(id)
        if (rejected.has(id)) {
          this.counters[entry.key].serverRejected++
          entry.state = 'REJECTED'
          this.lastRejection = { observationId: id, metric: entry.key, status: 'rejected', reason: errorReasons.get(id) ?? null, errorCode: null, at: event.attemptedAt }
        } else if (event.acknowledgedIds.includes(id)) this.markDelivered(id, entry, 'DELIVERED')
      }
      if (!event.results) {
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
      lastError: this.lastError,
    }
  }
}
