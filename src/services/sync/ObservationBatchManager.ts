import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import { ConnectorServiceError, type ConnectorObservationResult, type ConnectorObservationsResponse } from '../base44/base44Types'
import { authenticationService } from '../base44/AuthenticationService'
import { installationIdentityService } from '../storage/InstallationIdentityService'
import { QueueStoreError, type QueueRecord, type QueueStats, type CanonicalRecoveryBatch } from '../storage/ObservationQueueStore'
import { observationQueue } from './ObservationQueue'
import { BrowserNetworkStatus, type NetworkStatus } from './NetworkStatus'
import { assertActivityRecoveryIds } from '../storage/ActivityCertificationTransport'
import { ACTIVITY_R5_REVISION, ACTIVITY_RESPONSE_CONTRACT } from '../../adapters/jcvital/ActivityResumeContract'
import { tracePipeline } from '../diagnostics/PipelineTrace'
import { addAcquisitionProvenance, BASE44_PROVENANCE_TRANSMISSION_ENABLED } from './ObservationProvenancePayload'
import { activityV2CapabilityStore } from '../base44/ActivityV2Capability'
import { isActivityNativeTransportV2 } from '../../adapters/jcvital/ActivityNativeTransportV2'

export interface BatchManagerConfig {
  batchSize: number
  /** Must exceed requestTimeoutMs so a live request is never released. */
  staleInFlightMs: number
  requestTimeoutMs: number
  retryBaseMs: number
  retryMaxMs: number
  /** Number of batches that may be in flight at once. Claiming is atomic, so workers never race the same rows. */
  concurrency: number
}

/** Build 5B-1 release policy: sustained canonical ingest is safe only at one request at a time. */
export const MAX_CONCURRENCY = 1

export type StartupQueueResumeBlockedReason =
  | 'NOT_AUTHENTICATED'
  | 'QUEUE_OWNER_UNAVAILABLE'
  | 'BACKEND_DEVICE_ID_UNAVAILABLE'
  | 'QUEUE_NOT_INITIALIZED'
  | 'NO_ELIGIBLE_ROWS'
  | 'NETWORK_OFFLINE'
  | 'DELIVERY_PAUSED'
  | 'CANONICAL_RECOVERY_REQUIRED'

const defaultConfig: BatchManagerConfig = { batchSize: 100, staleInFlightMs: 60_000, requestTimeoutMs: 30_000, retryBaseMs: 5_000, retryMaxMs: 5 * 60 * 1000, concurrency: 1 }
const LAG_PROBE_INTERVAL_MS = 1_000
const RECOVERY_SUCCESS_STREAK = 1
const BACKOFF_FAILURE_STREAK = 2
const THROUGHPUT_WINDOW_MS = 5 * 60 * 1000

export type BatchPhase = 'SENDING' | 'AWAITING_BODY' | 'ACKNOWLEDGING' | 'DELIVERED' | 'PARTIAL' | 'RETRYING' | 'FAILED' | 'CANONICAL_RECOVERY_REQUIRED'

export interface BatchDiagnostics {
  batchId: string
  observationCount: number
  attemptNumber: number
  acknowledgedCount: number
  duplicateAcknowledgedCount: number
  phase: BatchPhase
  startedAt: string
  requestStartedAt: string | null
  requestCompletedAt: string | null
  requestDurationMs: number | null
  elapsedMs: number
  httpStatus: number | null
  /** True once a 2xx JSON body arrived, i.e. Base44 processed the batch. */
  backendResponseReceived: boolean
  responseSuccess: boolean | null
  responseBatchId: string | null
  responseAccepted: number | null
  responseDuplicate: number | null
  responseRejected: number | null
  responseErrorCount: number | null
  responseContractVersion: string | null
  deploymentRevision: string | null
  serverTimestamp: string | null
  timedOut: boolean
  /** performance.now() duration; unlike requestDurationMs (wall clock) it does not advance while the device sleeps. */
  requestDurationMonotonicMs: number | null
  /** Largest delay of a 1 s probe timer during the request; large values mean the JS thread was blocked. */
  maxEventLoopLagMs: number | null
  pageHiddenDuringRequest: boolean
  responseShape: ResponseShapeDiagnostic | null
  lastErrorCode: string | null
  lastErrorMessage: string | null
  nextAttemptAt: string | null
  canonicalFailureCount: number
  healthyBatch: boolean
}

export type StaleRecoveryTrigger = 'STARTUP' | 'PROCESS' | 'MANUAL'

/** Shape of one Base44 response; IDs truncated, no observation payloads. */
export interface ResponseShapeDiagnostic {
  batchId: string
  at: string
  /** Keys of the JSON body as parsed by the transport (before ConnectorObservationService). */
  transportTopLevelKeys: string[]
  transportHasResults: boolean
  transportResultCount: number | null
  /** results[] as seen by ObservationBatchManager after the service layer. */
  responseHasResults: boolean
  responseResultCount: number | null
  accepted: number | null
  duplicate: number | null
  rejected: number | null
  canonicalKeys: string[] | null
  canonicalCreated: number | null
  canonicalFailed: number | null
  responseContractVersion: string | null
  deploymentRevision: string | null
  firstResults: Array<{ observationIdPrefix: string | null; status: string | null; canonicalStatus: string | null; hasNativeObservationId: boolean; reason: string | null; errorCode: string | null }>
}

const MAX_RESPONSE_SHAPES = 10
const CANONICAL_ROUTED_METRICS = new Set(['heartRate', 'oxygenSaturation', 'wearableTemperature'])

function keysOf(value: unknown): string[] | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value).slice(0, 30) : null
}

function numberField(value: unknown, key: string): number | null {
  const field = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return typeof field === 'number' ? field : null
}

function stringField(value: unknown, key: string): string | null {
  const field = value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[key] : undefined
  return typeof field === 'string' ? field.slice(0, 120) : null
}

function shortText(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value).slice(0, 120)
}

export function summarizeResponseShape(batchId: string, rawBody: unknown, response: ConnectorObservationsResponse): ResponseShapeDiagnostic {
  const rawResults = rawBody !== null && typeof rawBody === 'object' ? (rawBody as Record<string, unknown>).results : undefined
  const results = Array.isArray(response.results) ? response.results : null
  return {
    batchId,
    at: new Date().toISOString(),
    transportTopLevelKeys: keysOf(rawBody) ?? [],
    transportHasResults: Array.isArray(rawResults),
    transportResultCount: Array.isArray(rawResults) ? rawResults.length : null,
    responseHasResults: results !== null,
    responseResultCount: results?.length ?? null,
    accepted: typeof response.accepted === 'number' ? response.accepted : null,
    duplicate: typeof response.duplicate === 'number' ? response.duplicate : null,
    rejected: typeof response.rejected === 'number' ? response.rejected : null,
    canonicalKeys: keysOf(response.canonical),
    canonicalCreated: numberField(response.canonical, 'created'),
    canonicalFailed: numberField(response.canonical, 'failed'),
    responseContractVersion: stringField(rawBody, 'responseContractVersion'),
    deploymentRevision: stringField(rawBody, 'deploymentRevision'),
    firstResults: (results ?? []).slice(0, 3).map((result) => {
      const entry = (result ?? {}) as unknown as Record<string, unknown>
      return {
        observationIdPrefix: typeof entry.observationId === 'string' ? entry.observationId.slice(0, 16) : null,
        status: shortText(entry.status),
        canonicalStatus: shortText(entry.canonicalStatus),
        hasNativeObservationId: typeof entry.nativeObservationId === 'string' && entry.nativeObservationId.length > 0,
        reason: shortText(entry.reason),
        errorCode: shortText(entry.errorCode),
      }
    }),
  }
}

export interface DeliveryDiagnostics {
  requestTimeoutMs: number
  staleSendingMs: number
  activeBatch: BatchDiagnostics | null
  activeBatches: BatchDiagnostics[]
  configuredConcurrency: number
  configWarning: string | null
  effectiveConcurrency: number
  activeWorkerCount: number
  senderActive: boolean
  senderGeneration: number
  observationsPerMinute: number
  batchesPerMinute: number
  averageBatchLatencyMs: number | null
  medianBatchDurationMs: number | null
  p95BatchDurationMs: number | null
  successfulBatches: number
  retryBatches: number
  failedBatches: number
  canonicalFailureCount: number
  canonicalFailureAlert: string | null
  canonicalRecoveryRequired: boolean
  canonicalRecoveryObservationCount: number
  canonicalRecoveryBatchCount: number
  lastCanonicalFailureBatchId: string | null
  lastCanonicalFailureAt: string | null
  canonicalRecoveryBatches: CanonicalRecoveryBatch[]
  queuePausedForCanonicalFailure: boolean
  pauseReason: string | null
  previousEffectiveConcurrency: number | null
  newEffectiveConcurrency: number | null
  queueStats: Pick<QueueStats, 'pending' | 'inFlight' | 'retrying' | 'failed' | 'acknowledged' | 'oldestPendingAgeMs' | 'oldestInFlightAgeMs' | 'lastSuccessfulUploadAt'> | null
  queueStatsError: string | null
  estimatedMinutesRemaining: number | null
  lastBatch: BatchDiagnostics | null
  retryScheduledAt: string | null
  lastStaleRecovery: { at: string; trigger: StaleRecoveryTrigger; released: number } | null
  startupQueueResumeAttempted: boolean
  startupQueueResumeStarted: boolean
  startupQueueResumeBlockedReason: StartupQueueResumeBlockedReason | null
  restoredBackendDeviceId: boolean
  persistedDeliveryEnablement: boolean
  recentResponseShapes: ResponseShapeDiagnostic[]
}

export interface StartupQueueResumeContext {
  restoredBackendDeviceId: boolean
  persistedDeliveryEnablement: boolean
}

export type BatchDeliveryOutcome = 'DELIVERED' | 'PARTIAL' | 'RETRYING' | 'FAILED' | 'CANONICAL_FAILED'

export interface BatchDeliveryEvent {
  batchId: string
  attemptedAt: string
  responseContractVersion?: string | null
  deploymentRevision?: string | null
  outcome: BatchDeliveryOutcome
  observationIds: string[]
  acknowledgedIds: string[]
  rejectedIds: string[]
  httpStatus: number | null
  errorCode: string | null
  canonicalFailedIds?: string[]
  accepted: number | null
  duplicate: number | null
  rejected: number | null
  /** Per-observation results from a 2xx response, when the backend provides them. */
  results?: ConnectorObservationResult[] | null
  errors?: ConnectorObservationsResponse['errors'] | null
  completedAt?: string
}

export type BatchDeliveryListener = (event: BatchDeliveryEvent) => void

export interface CertificationFlushOptions {
  activityRecovery?: boolean
  validateResults?: (event: BatchDeliveryEvent) => readonly string[]
  retryImmediately?: boolean
  onStage?: (stage: 'Waiting for active batch' | 'Sending certification rows') => void
  persistEvidence?: (event: BatchDeliveryEvent) => void | Promise<void>
  prepare?: () => Promise<void>
}

export interface CertificationFlushReport {
  events: BatchDeliveryEvent[]
  reason: string | null
}

function createBatchId(): string { return crypto.randomUUID() }

export class ObservationBatchManager {
  private readonly config: BatchManagerConfig
  private readonly network: NetworkStatus
  private activeWorkers = 0
  private senderGeneration = 0
  private effectiveConcurrency: number
  private configWarning: string | null = null
  private rerunRequested = false
  private paused = false
  private unsubscribeNetwork: () => void = () => undefined
  private readonly listeners = new Set<BatchDeliveryListener>()
  private started = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryScheduledAt: string | null = null
  private readonly activeBatches = new Map<string, BatchDiagnostics>()
  private lastBatch: BatchDiagnostics | null = null
  private readonly batchDurations: number[] = []
  private readonly acknowledgedWindows: Array<{ at: number; count: number; durationMs: number }> = []
  private successfulBatches = 0
  private retryBatches = 0
  private failedBatches = 0
  private canonicalFailureCount = 0
  private canonicalFailureAlert: string | null = null
  private canonicalRecoveryBatches: CanonicalRecoveryBatch[] = []
  private queuePausedForCanonicalFailure = false
  private pauseReason: string | null = null
  private previousEffectiveConcurrency: number | null = null
  private newEffectiveConcurrency: number | null = null
  private consecutiveTransientFailures = 0
  private consecutiveSuccessfulBatches = 0
  private latestQueueStats: QueueStats | null = null
  private latestQueueStatsError: string | null = null
  private lastStaleRecovery: DeliveryDiagnostics['lastStaleRecovery'] = null
  private startupQueueResumeAttempted = false
  private startupQueueResumeStarted = false
  private startupQueueResumeBlockedReason: StartupQueueResumeBlockedReason | null = null
  private restoredBackendDeviceId = false
  private persistedDeliveryEnablement = false
  private recentResponseShapes: ResponseShapeDiagnostic[] = []
  private certificationClaimBarrier = false
  private startupOperations = 0
  private lastBatchSettledAt: string | null = null

  getPhysicalTestSenderState() {
    const batches = [...this.activeBatches.values()]
    return {
      started: this.started,
      paused: this.paused,
      pauseReason: this.pauseReason,
      activeRequest: batches.some((batch) => batch.requestStartedAt !== null && batch.requestCompletedAt === null),
      claimOwner: this.activeWorkers > 0 || this.certificationClaimBarrier ? 'sender' : null,
      activeWorkers: this.activeWorkers,
      startupOperations: this.startupOperations,
      lastBatchId: batches[0]?.batchId ?? this.lastBatch?.batchId ?? null,
      lastSenderError: batches[0]?.lastErrorMessage ?? this.lastBatch?.lastErrorMessage ?? null,
      lastInflightCompletedAt: this.lastBatchSettledAt,
    }
  }

  resumeAfterPhysicalTest(): void {
    if (this.started && !this.paused) void this.process()
  }

  constructor(config: Partial<BatchManagerConfig> = {}, network: NetworkStatus = new BrowserNetworkStatus()) {
    const requestedConcurrency = config.concurrency ?? defaultConfig.concurrency
    const boundedConcurrency = Math.max(1, Math.min(MAX_CONCURRENCY, requestedConcurrency))
    if (boundedConcurrency !== requestedConcurrency) {
      this.configWarning = `Requested concurrency ${requestedConcurrency} was clamped to the release maximum of ${MAX_CONCURRENCY}.`
    }
    this.config = {
      ...defaultConfig,
      ...config,
      batchSize: 100,
      concurrency: boundedConcurrency,
    }
    this.effectiveConcurrency = this.config.concurrency
    this.network = network
  }

  async start(context: StartupQueueResumeContext = { restoredBackendDeviceId: false, persistedDeliveryEnablement: false }): Promise<void> {
    this.paused = false
    this.restoredBackendDeviceId = context.restoredBackendDeviceId
    this.persistedDeliveryEnablement = context.persistedDeliveryEnablement
    if (!this.started) {
      this.started = true
      this.unsubscribeNetwork = this.network.subscribe((online) => { if (online) void this.attemptStartupQueueResume() })
      if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibility)
    }
    await this.attemptStartupQueueResume()
  }

  stop(): void {
    this.started = false
    this.rerunRequested = false
    this.unsubscribeNetwork()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.handleVisibility)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryScheduledAt = null
  }

  getDeliveryDiagnostics(): DeliveryDiagnostics {
    const now = Date.now()
    const activeBatches = [...this.activeBatches.values()].map((batch) => ({ ...batch, elapsedMs: now - Date.parse(batch.startedAt) }))
    const active = activeBatches[0] ?? null
    const throughputSamples = this.acknowledgedWindows.filter((entry) => entry.at >= now - THROUGHPUT_WINDOW_MS)
    const acknowledgedCount = throughputSamples.reduce((sum, entry) => sum + entry.count, 0)
    const earliestStart = throughputSamples.length ? throughputSamples[0].at - throughputSamples[0].durationMs : now
    const elapsedWindowMs = Math.min(THROUGHPUT_WINDOW_MS, Math.max(1_000, now - earliestStart))
    const observationsPerMinute = acknowledgedCount / (elapsedWindowMs / 60_000)
    const batchesPerMinute = throughputSamples.length / (elapsedWindowMs / 60_000)
    const averageBatchLatencyMs = throughputSamples.length
      ? throughputSamples.reduce((sum, entry) => sum + entry.durationMs, 0) / throughputSamples.length
      : null
    const durations = [...this.batchDurations].sort((left, right) => left - right)
    const percentile = (fraction: number) => durations.length ? durations[Math.min(durations.length - 1, Math.ceil(durations.length * fraction) - 1)] : null
    const remaining = this.latestQueueStats ? this.latestQueueStats.pending + this.latestQueueStats.retrying + this.latestQueueStats.inFlight : null
    return {
      requestTimeoutMs: this.config.requestTimeoutMs,
      staleSendingMs: this.config.staleInFlightMs,
      activeBatch: active,
      activeBatches,
      configuredConcurrency: this.config.concurrency,
      configWarning: this.configWarning,
      effectiveConcurrency: this.effectiveConcurrency,
      activeWorkerCount: this.activeWorkers,
      senderActive: this.activeWorkers > 0,
      senderGeneration: this.senderGeneration,
      observationsPerMinute,
      batchesPerMinute,
      averageBatchLatencyMs,
      medianBatchDurationMs: percentile(0.5),
      p95BatchDurationMs: percentile(0.95),
      successfulBatches: this.successfulBatches,
      retryBatches: this.retryBatches,
      failedBatches: this.failedBatches,
      canonicalFailureCount: this.canonicalFailureCount,
      canonicalFailureAlert: this.canonicalFailureAlert,
      canonicalRecoveryRequired: this.latestQueueStats?.canonicalRecoveryRequired === true || (this.latestQueueStats?.canonicalRecoveryObservationCount ?? 0) > 0 || this.queuePausedForCanonicalFailure,
      canonicalRecoveryObservationCount: this.latestQueueStats?.canonicalRecoveryObservationCount ?? 0,
      canonicalRecoveryBatchCount: this.latestQueueStats?.canonicalRecoveryBatchCount ?? this.canonicalRecoveryBatches.length,
      lastCanonicalFailureBatchId: this.latestQueueStats?.lastCanonicalFailureBatchId ?? this.canonicalRecoveryBatches[0]?.batchId ?? null,
      lastCanonicalFailureAt: this.latestQueueStats?.lastCanonicalFailureAt ?? this.canonicalRecoveryBatches[0]?.lastFailureAt ?? null,
      canonicalRecoveryBatches: [...this.canonicalRecoveryBatches],
      queuePausedForCanonicalFailure: this.queuePausedForCanonicalFailure,
      pauseReason: this.pauseReason,
      previousEffectiveConcurrency: this.previousEffectiveConcurrency,
      newEffectiveConcurrency: this.newEffectiveConcurrency,
      queueStats: this.latestQueueStats ? {
        pending: this.latestQueueStats.pending,
        inFlight: this.latestQueueStats.inFlight,
        retrying: this.latestQueueStats.retrying,
        failed: this.latestQueueStats.failed,
        acknowledged: this.latestQueueStats.acknowledged,
        oldestPendingAgeMs: this.latestQueueStats.oldestPendingAgeMs,
        oldestInFlightAgeMs: this.latestQueueStats.oldestInFlightAgeMs ?? null,
        lastSuccessfulUploadAt: this.latestQueueStats.lastSuccessfulUploadAt,
      } : null,
      queueStatsError: this.latestQueueStatsError,
      estimatedMinutesRemaining: observationsPerMinute > 0 && remaining !== null ? remaining / observationsPerMinute : null,
      lastBatch: this.lastBatch ? { ...this.lastBatch } : null,
      retryScheduledAt: this.retryScheduledAt,
      lastStaleRecovery: this.lastStaleRecovery,
      startupQueueResumeAttempted: this.startupQueueResumeAttempted,
      startupQueueResumeStarted: this.startupQueueResumeStarted,
      startupQueueResumeBlockedReason: this.startupQueueResumeBlockedReason,
      restoredBackendDeviceId: this.restoredBackendDeviceId,
      persistedDeliveryEnablement: this.persistedDeliveryEnablement,
      recentResponseShapes: [...this.recentResponseShapes],
    }
  }

  private async attemptStartupQueueResume(): Promise<void> {
    if (physicalTestBlocksSender()) return
    this.startupOperations++
    try { await this.runStartupQueueResume() }
    finally { this.startupOperations-- }
  }

  private async runStartupQueueResume(): Promise<void> {
    this.startupQueueResumeAttempted = true
    this.startupQueueResumeStarted = false
    this.startupQueueResumeBlockedReason = null

    const block = (reason: StartupQueueResumeBlockedReason) => { this.startupQueueResumeBlockedReason = reason }
    if (!observationQueue.getOwnerUserId()) { block('QUEUE_OWNER_UNAVAILABLE'); return }
    if (!observationQueue.getDiagnostics().queueStoreInitialized) { block('QUEUE_NOT_INITIALIZED'); return }
    if (this.paused) { block('DELIVERY_PAUSED'); return }
    if (!(await authenticationService.isAuthenticated())) { block('NOT_AUTHENTICATED'); return }
    if (!connectorIdentityService.getConnectorDeviceId()) { block('BACKEND_DEVICE_ID_UNAVAILABLE'); return }
    if (!this.network.isOnline()) { block('NETWORK_OFFLINE'); return }

    await observationQueue.purgeAcknowledged()
    const recoveryStats = await observationQueue.getQueueStats()
    this.latestQueueStats = recoveryStats
    this.canonicalRecoveryBatches = await observationQueue.getCanonicalRecoveryBatches(10)
    if (recoveryStats.canonicalRecoveryRequired === true || (recoveryStats.canonicalRecoveryObservationCount ?? 0) > 0) {
      this.canonicalFailureCount = Math.max(this.canonicalFailureCount, recoveryStats.canonicalRecoveryObservationCount ?? 0)
      this.paused = true
      this.queuePausedForCanonicalFailure = true
      this.pauseReason = 'CANONICAL_RECOVERY_REQUIRED'
      this.canonicalFailureAlert = `Canonical recovery required for ${recoveryStats.canonicalRecoveryObservationCount} observation(s) across ${recoveryStats.canonicalRecoveryBatchCount ?? this.canonicalRecoveryBatches.length} batch(es); queue draining remains paused.`
      block('CANONICAL_RECOVERY_REQUIRED')
      return
    }

    await this.recoverStaleSending('STARTUP')
    const eligible = await observationQueue.getPending(1)
    if (!eligible.length) {
      const nextRetryAt = await observationQueue.getNextRetryAt()
      if (nextRetryAt) {
        this.startupQueueResumeStarted = true
        this.scheduleRetry(nextRetryAt)
      } else {
        block('NO_ELIGIBLE_ROWS')
      }
      return
    }

    this.startupQueueResumeStarted = true
    for (let worker = 0; worker < this.effectiveConcurrency; worker++) void this.process()
  }

  private staleBefore(): string { return new Date(Date.now() - this.config.staleInFlightMs).toISOString() }

  async getStaleSendingCount(): Promise<number> { return observationQueue.countStaleInFlight(this.staleBefore()) }

  /** Returns rows left IN_FLIGHT past the stale threshold to RETRY_WAIT with their original observation IDs. */
  async recoverStaleSending(trigger: StaleRecoveryTrigger): Promise<number> {
    if (!observationQueue.getOwnerUserId()) return 0
    const released = await observationQueue.releaseStaleInFlight(this.staleBefore())
    if (released > 0 || trigger !== 'PROCESS') this.lastStaleRecovery = { at: new Date().toISOString(), trigger, released }
    return released
  }

  /** Engineering control: releases only stale SENDING rows, then attempts delivery. */
  async retryStaleSending(): Promise<number> {
    const released = await this.recoverStaleSending('MANUAL')
    if (released > 0) void this.process()
    return released
  }

  private scheduleRetry(at: string): void {
    if (!this.started) return
    if (this.retryTimer && this.retryScheduledAt && Date.parse(this.retryScheduledAt) <= Date.parse(at)) return
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryScheduledAt = at
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (physicalTestBlocksSender()) return
      this.retryScheduledAt = null
      void this.process()
    }, Math.max(0, Date.parse(at) - Date.now()))
  }

  pause(): void { this.paused = true; this.pauseReason = 'DELIVERY_PAUSED' }
  resume(): void {
    if (this.queuePausedForCanonicalFailure || (this.latestQueueStats?.canonicalRecoveryObservationCount ?? 0) > 0) return
    this.paused = false
    this.pauseReason = null
    void this.process()
  }

  subscribe(listener: BatchDeliveryListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(event: BatchDeliveryEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* diagnostics listeners must not affect delivery */ }
    }
  }

  private handleVisibility = (): void => { if (document.visibilityState === 'visible') void this.attemptStartupQueueResume() }

  /**
   * Launches a worker when a concurrency slot is free (claiming is atomic, so concurrent workers never pick up
   * the same PENDING rows); otherwise flags a rerun so the slot owner picks up the extra work when it frees up.
   * With the default concurrency of 1 this preserves the original single-worker reentrancy behavior exactly.
   */
  async process(): Promise<ConnectorObservationsResponse | null> {
    if (physicalTestBlocksSender()) return null
    if (this.certificationClaimBarrier) { this.rerunRequested = true; return null }
    if (this.paused) return null
    if (this.activeWorkers >= this.effectiveConcurrency) { this.rerunRequested = true; return null }
    this.senderGeneration++
    this.activeWorkers++
    let result: ConnectorObservationsResponse | null = null
    let claimedWork = false
    try { result = await this.processLoop((claimed) => { claimedWork = claimed }) } catch (error) {
      // Local queue unavailability is surfaced through queue diagnostics; nothing was sent.
      if (!(error instanceof QueueStoreError)) throw error
    } finally {
      this.activeWorkers--
      if (this.started && !this.paused && !this.certificationClaimBarrier && (this.rerunRequested || claimedWork)) {
        this.rerunRequested = false
        void this.process()
      }
    }
    return result
  }

  async flushCertificationObservationIds(observationIds: readonly string[], options: CertificationFlushOptions = {}): Promise<CertificationFlushReport> {
    if (physicalTestBlocksSender()) throw new Error('Physical test isolation defers certification delivery.')
    const ids = [...new Set(observationIds)]
    if (!ids.length || ids.length > 100 || ids.some((id) => !/^[0-9a-f]{64}$/.test(id))) {
      throw new Error('Certification flush requires 1-100 exact SHA-256 observation IDs.')
    }
    if (options.activityRecovery) {
      assertActivityRecoveryIds(ids)
      if (!options.prepare || !options.persistEvidence || !options.validateResults) {
        throw new Error('Activity recovery requires saved-evidence preparation, result validation and receipt persistence.')
      }
    }
    if (this.certificationClaimBarrier) throw new Error('Another certification flush is already active.')
    const owner = observationQueue.getOwnerUserId()
    if (!owner) throw new QueueStoreError('QUEUE_OWNER_MISSING', 'Certification flush requires an authenticated queue owner.')
    const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
    const selectedRows = await Promise.all(ids.map((id) => observationQueue.getRecord(id)))
    if (selectedRows.some((record) => record && isActivityNativeTransportV2(record.payload))
      && (!connectorDeviceId || !activityV2CapabilityStore.isEnabled({
        ownerUserId: owner, installId: this.installId(), connectorDeviceId,
      }))) {
      throw new Error('Activity v2 delivery blocked: current registration does not advertise JCVITAL_ACTIVITY_TRANSPORT_V2.')
    }
    this.certificationClaimBarrier = true
    const events: BatchDeliveryEvent[] = []
    const selected = new Set(ids)
    const unsubscribe = this.subscribe((event) => {
      if (event.observationIds.some((id) => selected.has(id))) events.push(event)
    })
    try {
      options.onStage?.('Waiting for active batch')
      const deadline = Date.now() + 60_000
      while (this.activeWorkers > 0) {
        if (Date.now() >= deadline) return { events, reason: 'Active batch still running; certification rows remain queued. Inspect and retry flush, not capture.' }
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      if (observationQueue.getOwnerUserId() !== owner) throw new Error('Account changed before certification flush.')
      if (this.paused) return { events, reason: this.pauseReason ?? 'Delivery paused.' }
      await options.prepare?.()
      if (observationQueue.getOwnerUserId() !== owner) throw new Error('Account changed while preparing certification rows.')
      options.onStage?.('Sending certification rows')
      const delivery = { ids, owner, persistEvidence: options.persistEvidence,
        retryImmediately: options.retryImmediately, activityRecovery: options.activityRecovery,
        validateResults: options.validateResults, blockedReason: null as string | null }
      this.activeWorkers++
      this.senderGeneration++
      try {
        await this.processLoop(() => undefined, delivery)
      } finally { this.activeWorkers-- }
      return { events, reason: this.pauseReason ?? delivery.blockedReason
        ?? (events.length ? null : 'No eligible certification rows sent: inspect queue state, authentication and connectivity.') }
    } finally {
      unsubscribe()
      this.certificationClaimBarrier = false
      if (this.started && !this.paused) {
        this.rerunRequested = false
        void this.process()
      }
    }
  }

  private async processLoop(
    onClaimed: (claimed: boolean) => void,
    certification?: { ids: string[]; owner: string; persistEvidence?: (event: BatchDeliveryEvent) => void | Promise<void>;
      retryImmediately?: boolean; activityRecovery?: boolean; validateResults?: (event: BatchDeliveryEvent) => readonly string[];
      blockedReason?: string | null },
  ): Promise<ConnectorObservationsResponse | null> {
    const ownerUserId = observationQueue.getOwnerUserId()
    if (!ownerUserId || this.paused) return null
    const recoveryStats = await observationQueue.getQueueStats()
    this.latestQueueStats = recoveryStats
    if (recoveryStats.canonicalRecoveryRequired === true || (recoveryStats.canonicalRecoveryObservationCount ?? 0) > 0) {
      this.paused = true
      this.queuePausedForCanonicalFailure = true
      this.pauseReason = 'CANONICAL_RECOVERY_REQUIRED'
      this.canonicalRecoveryBatches = await observationQueue.getCanonicalRecoveryBatches(10)
      return null
    }
    // Runs before connectivity checks so interrupted batches are released on any trigger.
    if (physicalTestBlocksSender()) return null
    if (!certification) await this.recoverStaleSending('PROCESS')
    if (!this.network.isOnline()) {
      if (certification?.activityRecovery) certification.blockedReason = 'ACTIVITY_NETWORK_OFFLINE'
      return null
    }
    if (!(await authenticationService.isAuthenticated())) {
      if (certification?.activityRecovery) certification.blockedReason = 'ACTIVITY_AUTHENTICATION_REQUIRED'
      return null
    }
    const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
    if (!connectorDeviceId) {
      if (certification?.activityRecovery) certification.blockedReason = 'ACTIVITY_BACKEND_DEVICE_ID_UNAVAILABLE'
      return null
    }
    const batchId = createBatchId()
    if (certification ? observationQueue.getOwnerUserId() !== certification.owner : this.certificationClaimBarrier) return null
    // Recheck after asynchronous preflight; an already-started claim still settles normally.
    if (physicalTestBlocksSender()) return null
    // Atomic: selection + IN_FLIGHT marking happen in one transaction so concurrent workers never claim the same rows.
    let ordinaryClaimLimit = this.config.batchSize
    if (!certification && !activityV2CapabilityStore.isEnabled({
      ownerUserId: ownerUserId, installId: this.installId(), connectorDeviceId,
    })) {
      const pending = await observationQueue.getPending(this.config.batchSize)
      const firstV2 = pending.findIndex((record) => isActivityNativeTransportV2(record.payload))
      if (firstV2 === 0) {
        onClaimed(false)
        return null
      }
      if (firstV2 > 0) ordinaryClaimLimit = firstV2
    }
    const records = certification
      ? certification.activityRecovery
        ? await observationQueue.claimActivityCertificationObservationIds(certification.ids, batchId)
        : await observationQueue.claimCertificationObservationIds(certification.ids, batchId, certification.retryImmediately)
      : await observationQueue.claimPending(ordinaryClaimLimit, batchId)
    if (certification && observationQueue.getOwnerUserId() !== ownerUserId) throw new Error('Queue account changed while claiming a certification batch.')
    onClaimed(records.length > 0)
    if (!records.length) {
      if (certification?.activityRecovery) certification.blockedReason = 'ACTIVITY_EXACT_CLAIM_ZERO_ROWS'
      const nextRetryAt = await observationQueue.getNextRetryAt()
      if (nextRetryAt) this.scheduleRetry(nextRetryAt)
      return null
    }
    const attemptedAt = new Date().toISOString()
    const observationIds = records.map((record) => record.observationId)
    const diag: BatchDiagnostics = {
      batchId, observationCount: records.length, attemptNumber: Math.max(1, ...records.map((record) => record.attemptCount)), acknowledgedCount: 0,
      duplicateAcknowledgedCount: 0,
      phase: 'SENDING', startedAt: attemptedAt, requestStartedAt: null, requestCompletedAt: null, requestDurationMs: null, elapsedMs: 0,
      httpStatus: null, backendResponseReceived: false, responseSuccess: null, responseBatchId: null, responseAccepted: null,
      responseDuplicate: null, responseRejected: null, responseErrorCount: null, responseContractVersion: null, deploymentRevision: null, serverTimestamp: null, timedOut: false,
      requestDurationMonotonicMs: null, maxEventLoopLagMs: null, pageHiddenDuringRequest: false, responseShape: null,
      lastErrorCode: null, lastErrorMessage: null, nextAttemptAt: null, canonicalFailureCount: 0,
      healthyBatch: false,
    }
    this.activeBatches.set(batchId, diag)
    try {
      if (certification?.activityRecovery && records.length !== certification.ids.length) {
        await observationQueue.retryClaims(records.map((record) => ({
          queueId: record.queueId, batchId, attemptCount: record.attemptCount,
        })), { code: 'ACTIVITY_EXACT_CLAIM_INCOMPLETE', message: 'Dedicated claim did not acquire every pending approved ID.' },
        new Date(Date.now() + this.config.retryMaxMs).toISOString())
        diag.phase = 'RETRYING'
        diag.lastErrorCode = 'ACTIVITY_EXACT_CLAIM_INCOMPLETE'
        this.notify({ batchId, attemptedAt, observationIds, acknowledgedIds: [], rejectedIds: [], outcome: 'RETRYING',
          httpStatus: null, errorCode: diag.lastErrorCode, accepted: null, duplicate: null, rejected: null })
        return null
      }
      const activityCertification = records.filter((record) => record.payload.rawSourceMetadata?.certificationOnly === true
        && ['24', '25'].includes(record.payload.vendorDataType ?? ''))
      if (activityCertification.length && (!certification
        || activityCertification.some((record) => record.payload.metricType === 'DAILY_EXERCISE_MINUTES'))) {
        const message = 'Activity certification requires explicit saved-evidence resume; exerciseMinutes is not delivery eligible.'
        await observationQueue.retryClaims(records.map((record) => ({
          queueId: record.queueId, batchId: record.batchId!, attemptCount: record.attemptCount,
        })), { code: 'ACTIVITY_CERTIFICATION_RESUME_REQUIRED', message }, new Date(Date.now() + this.config.retryMaxMs).toISOString())
        diag.lastErrorCode = 'ACTIVITY_CERTIFICATION_RESUME_REQUIRED'
        diag.lastErrorMessage = message
        diag.phase = 'RETRYING'
        this.notify({ batchId, attemptedAt, outcome: 'RETRYING', observationIds, acknowledgedIds: [], rejectedIds: [],
          httpStatus: null, errorCode: diag.lastErrorCode, accepted: null, duplicate: null, rejected: null })
        return null
      }
      let response: ConnectorObservationsResponse
      let rawBody: unknown = null
      try {
        tracePipeline('SEND', { batchId, attemptedAt, ownerUserId, connectorDeviceId, observations: records.map((record) => ({
          queueId: record.queueId, observationId: record.observationId, sourceRecordId: record.payload.sourceRecordId ?? null,
          vendorDataType: record.payload.vendorDataType ?? null, metric: record.payload.metric,
          observedAt: record.payload.observedAt ?? record.payload.startTime,
          timestampSource: record.payload.timestampSource ?? null,
        })) })
        response = await this.submitWithTimeout({
          installId: this.installId(),
          connectorDeviceId,
          batchId,
          observations: records.map((record) => BASE44_PROVENANCE_TRANSMISSION_ENABLED
            ? addAcquisitionProvenance(record.payload, record.acquisitionProvenance, true)
            : record.payload),
        }, diag, (body) => { rawBody = body })
      } catch (error) {
        this.completeRequest(diag)
        return await this.handleRequestFailure(error, diag, records, attemptedAt)
      }
      this.completeRequest(diag)
      diag.responseShape = summarizeResponseShape(batchId, rawBody, response)
      this.recentResponseShapes = [...this.recentResponseShapes, diag.responseShape].slice(-MAX_RESPONSE_SHAPES)
      Object.assign(diag, {
        phase: 'ACKNOWLEDGING', backendResponseReceived: true, httpStatus: diag.httpStatus ?? 200, responseSuccess: response.success,
        responseBatchId: response.batchId ?? null, responseAccepted: response.accepted ?? null, responseDuplicate: response.duplicate ?? null,
        responseRejected: response.rejected ?? null, responseErrorCount: response.errors?.length ?? 0,
        responseContractVersion: diag.responseShape.responseContractVersion, deploymentRevision: diag.responseShape.deploymentRevision,
        serverTimestamp: response.serverTimestamp ?? null,
      })
      tracePipeline('RESPONSE', { batchId, completedAt: diag.requestCompletedAt, httpStatus: diag.httpStatus,
        responseContractVersion: diag.responseContractVersion, accepted: response.accepted, duplicate: response.duplicate,
        rejected: response.rejected, errors: response.errors, results: response.results ?? null, serverTimestamp: response.serverTimestamp })
      const canonicalFailed = Math.max(0, numberField(response.canonical, 'failed') ?? 0)
      // results[] is authoritative; errors[] is capped at 50 so it can miss rejections.
      const resultsById = new Map((response.results ?? []).map((result) => [result.observationId, result]))
      const rejectedIds = new Set((response.results ?? [])
        .filter((result) => result.status === 'rejected')
        .map((result) => result.observationId)
        .filter((id) => observationIds.includes(id)))
      const resultCanonicalFailures = (response.results ?? []).filter((result) => result.canonicalStatus === 'failed')
      const canonicalFailedIds = new Set(resultCanonicalFailures.map((result) => result.observationId).filter((id) => observationIds.includes(id)))
      if (canonicalFailed > 0) {
        for (const record of records) {
          const result = resultsById.get(record.observationId)
          if (
            rejectedIds.has(record.observationId) ||
            result?.status === 'duplicate' ||
            result?.status === 'rejected' ||
            result?.canonicalStatus === 'canonicalized' ||
            result?.canonicalStatus === 'not_applicable' ||
            !CANONICAL_ROUTED_METRICS.has(record.payload.metric)
          ) continue
          canonicalFailedIds.add(record.observationId)
        }
      }
      const canonicalFailureCount = certification?.activityRecovery ? 0 : Math.max(canonicalFailed, canonicalFailedIds.size)
      diag.canonicalFailureCount = canonicalFailureCount
      let successfulIds = observationIds.filter((id) => {
        const status = resultsById.get(id)?.status
        return (status === 'accepted' || status === 'duplicate')
          && !rejectedIds.has(id)
          && !canonicalFailedIds.has(id)
      })
      const claimsFor = (selectedIds: Set<string>) => records
        .filter((record) => selectedIds.has(record.observationId))
        .map((record) => ({ queueId: record.queueId, batchId: diag.batchId, attemptCount: record.attemptCount }))
      try {
        if (certification && observationQueue.getOwnerUserId() !== ownerUserId) throw new Error('Queue account changed before certification acknowledgement; claimed rows retained for recovery.')
        if (certification?.activityRecovery) {
          if (!certification.validateResults || canonicalFailed > 0 || (numberField(response.canonical, 'created') ?? 0) > 0
            || diag.responseContractVersion !== ACTIVITY_RESPONSE_CONTRACT || diag.deploymentRevision !== ACTIVITY_R5_REVISION) {
            throw new Error('Activity exact r5 contract/revision gate failed or canonical promotion reported; ACK blocked.')
          }
          const verified = certification.validateResults({
            batchId, attemptedAt, completedAt: diag.requestCompletedAt ?? undefined,
            outcome: 'PARTIAL', observationIds, acknowledgedIds: [], rejectedIds: [...rejectedIds],
            canonicalFailedIds: [...canonicalFailedIds], httpStatus: diag.httpStatus, errorCode: null,
            accepted: response.accepted, duplicate: response.duplicate, rejected: response.rejected,
            results: response.results ?? null, errors: response.errors ?? null,
          })
          if (new Set(verified).size !== verified.length || verified.some((id) => !observationIds.includes(id))) {
            throw new Error('Activity result gate returned non-targeted/duplicate ACK IDs.')
          }
          successfulIds = [...verified]
        }
        if (canonicalFailureCount > 0) {
          const canonicalFailureAt = new Date().toISOString()
          const previousEffectiveConcurrency = this.effectiveConcurrency
          this.paused = true
          this.queuePausedForCanonicalFailure = true
          this.pauseReason = 'CANONICAL_RECOVERY_REQUIRED'
          await observationQueue.recordCanonicalRecoveryPause(batchId, canonicalFailureCount, canonicalFailureAt)
          const recoveryClaims = records.filter((record) => canonicalFailedIds.has(record.observationId)).map((record) => ({
            queueId: record.queueId,
            batchId: diag.batchId,
            attemptCount: record.attemptCount,
            nativeObservationId: resultsById.get(record.observationId)?.nativeObservationId ?? null,
            canonicalFailureAt,
          }))
          const marked = recoveryClaims.length
            ? await observationQueue.markCanonicalRecoveryRequired(
              recoveryClaims,
              { code: 'CANONICAL_FAILURE', message: 'The service accepted the reading but could not finish processing it; server-side recovery is required.' },
            )
            : 0
          if (marked !== recoveryClaims.length) throw new Error(`Only ${marked} of ${recoveryClaims.length} canonical-failed queue claims were persisted.`)
          this.canonicalFailureCount += canonicalFailureCount
          this.previousEffectiveConcurrency = previousEffectiveConcurrency
          this.effectiveConcurrency = Math.max(1, this.effectiveConcurrency - 1)
          this.newEffectiveConcurrency = this.effectiveConcurrency
          this.canonicalFailureAlert = `Canonical recovery required for ${canonicalFailureCount} observation(s) in batch ${batchId}; queue draining paused. Effective concurrency ${this.previousEffectiveConcurrency === this.newEffectiveConcurrency ? `held at ${this.newEffectiveConcurrency}` : `reduced ${this.previousEffectiveConcurrency} → ${this.newEffectiveConcurrency}`}.`
          this.consecutiveSuccessfulBatches = 0
          this.consecutiveTransientFailures = 0
          this.latestQueueStats = await observationQueue.getQueueStats()
          this.canonicalRecoveryBatches = await observationQueue.getCanonicalRecoveryBatches(10)
        }
        await certification?.persistEvidence?.({
          batchId, attemptedAt, outcome: canonicalFailureCount > 0 ? 'CANONICAL_FAILED' : rejectedIds.size ? 'PARTIAL' : 'DELIVERED',
          observationIds, acknowledgedIds: [], rejectedIds: [...rejectedIds], canonicalFailedIds: [...canonicalFailedIds],
          httpStatus: diag.httpStatus, errorCode: null, accepted: response.accepted, duplicate: response.duplicate, rejected: response.rejected,
          results: response.results ?? null, errors: response.errors ?? null,
          ...(certification?.activityRecovery ? { completedAt: diag.requestCompletedAt ?? attemptedAt } : {}),
        })
        diag.acknowledgedCount = await observationQueue.acknowledgeClaims(claimsFor(new Set(successfulIds)))
        diag.duplicateAcknowledgedCount = successfulIds.filter((id) => resultsById.get(id)?.status === 'duplicate').length
        if (diag.acknowledgedCount !== successfulIds.length && certification?.activityRecovery) throw new Error('Activity ACK claim count differs from verified successes.')
        if (certification?.activityRecovery) {
          const unresolved = new Set(observationIds.filter((id) => !successfulIds.includes(id)))
          if (unresolved.size) {
            const retried = await observationQueue.retryClaims(claimsFor(unresolved),
              { code: 'ACTIVITY_EXPLICIT_RETRY_REQUIRED', message: 'Missing, rejected or ambiguous Activity results; explicit recovery required.' },
              new Date(Date.now() + this.config.retryMaxMs).toISOString())
            if (retried !== unresolved.size) throw new Error('Activity unresolved claim count differs from preserved rows.')
          }
        } else if (rejectedIds.size) {
          await observationQueue.failClaims(claimsFor(rejectedIds), { code: 'VALIDATION_ERROR', message: 'Observation rejected by the connector service.' })
        }
        if (!certification) {
          const unresolvedIds = observationIds.filter((id) => !successfulIds.includes(id)
            && !rejectedIds.has(id) && !canonicalFailedIds.has(id))
          if (unresolvedIds.length) {
            const unresolvedClaims = claimsFor(new Set(unresolvedIds))
            const retried = await observationQueue.retryClaims(unresolvedClaims,
              { code: 'AMBIGUOUS_SERVER_RESULT', message: 'The server response omitted an explicit result for this observation; it remains queued for safe retry.' },
              this.nextAttempt(records.filter((record) => unresolvedIds.includes(record.observationId))))
            if (retried !== unresolvedIds.length) {
              throw new Error(`Only ${retried} of ${unresolvedIds.length} ambiguous server-result claims were returned to retry state.`)
            }
          }
        }
        await observationQueue.purgeAcknowledged(certification ? observationIds : undefined)
      } catch (error) {
        // Base44 accepted the batch; replaying the same observation IDs is idempotent.
        diag.lastErrorCode = 'ACK_PROCESSING_FAILED'
        diag.lastErrorMessage = `Base44 responded (accepted ${response.accepted}, duplicate ${response.duplicate}) but the local queue ACK failed: ${error instanceof Error ? error.message : String(error)}`
        await this.scheduleBatchRetry(diag, records, { code: diag.lastErrorCode, message: diag.lastErrorMessage }).catch(() => undefined)
        this.notify({ batchId, attemptedAt, outcome: 'RETRYING', observationIds, acknowledgedIds: [], rejectedIds: [], httpStatus: diag.httpStatus, errorCode: diag.lastErrorCode, accepted: response.accepted, duplicate: response.duplicate, rejected: response.rejected, results: response.results ?? null, errors: response.errors ?? null })
        return null
      }
      const canonicalRecoveryRequired = canonicalFailureCount > 0
      const hasAmbiguousResults = observationIds.some((id) => !successfulIds.includes(id)
        && !rejectedIds.has(id) && !canonicalFailedIds.has(id))
      diag.phase = canonicalRecoveryRequired ? 'CANONICAL_RECOVERY_REQUIRED'
        : rejectedIds.size || hasAmbiguousResults || certification?.activityRecovery && successfulIds.length !== observationIds.length ? 'PARTIAL' : 'DELIVERED'
      const healthyBatch = response.success && canonicalFailureCount === 0 && rejectedIds.size === 0 &&
        response.results !== undefined &&
        records.every((record) => {
          const result = resultsById.get(record.observationId)
          if (!result) return false
          if (result.status !== 'accepted') return result.status === 'duplicate'
          if (CANONICAL_ROUTED_METRICS.has(record.payload.metric)) return result.canonicalStatus === 'canonicalized'
          return result.canonicalStatus === 'canonicalized' || result.canonicalStatus === 'not_applicable'
        })
      const event: BatchDeliveryEvent = { batchId, attemptedAt, outcome: canonicalRecoveryRequired ? 'CANONICAL_FAILED' : diag.phase as 'DELIVERED' | 'PARTIAL', observationIds, acknowledgedIds: successfulIds, rejectedIds: [...rejectedIds], canonicalFailedIds: [...canonicalFailedIds], httpStatus: diag.httpStatus, errorCode: canonicalRecoveryRequired ? 'CANONICAL_FAILURE' : hasAmbiguousResults ? 'AMBIGUOUS_SERVER_RESULT' : null, accepted: response.accepted, duplicate: response.duplicate, rejected: response.rejected, results: response.results ?? null, errors: response.errors ?? null,
        ...(certification?.activityRecovery ? { completedAt: diag.requestCompletedAt ?? attemptedAt } : {}) }
      this.notify(event)
      await certification?.persistEvidence?.(event)
      diag.healthyBatch = healthyBatch && !canonicalRecoveryRequired
      return response
    } finally {
      this.lastBatchSettledAt = new Date().toISOString()
      const elapsedMs = Date.now() - Date.parse(diag.startedAt)
      this.lastBatch = { ...diag, elapsedMs }
      this.activeBatches.delete(batchId)
      this.batchDurations.push(diag.requestDurationMs ?? elapsedMs)
      if (this.batchDurations.length > 100) this.batchDurations.shift()
      if ((diag.phase === 'DELIVERED' || diag.phase === 'PARTIAL') && diag.healthyBatch) {
        this.successfulBatches++
        this.consecutiveTransientFailures = 0
        this.consecutiveSuccessfulBatches++
        if (diag.acknowledgedCount > 0) this.acknowledgedWindows.push({ at: Date.now(), count: diag.acknowledgedCount, durationMs: diag.requestDurationMs ?? elapsedMs })
        if (this.consecutiveSuccessfulBatches >= RECOVERY_SUCCESS_STREAK && this.effectiveConcurrency < this.config.concurrency) {
          this.previousEffectiveConcurrency = this.effectiveConcurrency
          this.effectiveConcurrency++
          this.newEffectiveConcurrency = this.effectiveConcurrency
          this.consecutiveSuccessfulBatches = 0
        }
      } else if (diag.phase === 'DELIVERED' || diag.phase === 'PARTIAL' || diag.phase === 'CANONICAL_RECOVERY_REQUIRED') {
        this.consecutiveSuccessfulBatches = 0
        this.consecutiveTransientFailures = 0
      } else if (diag.phase === 'RETRYING') {
        this.retryBatches++
      } else if (diag.phase === 'FAILED') {
        this.failedBatches++
      }
      const cutoff = Date.now() - THROUGHPUT_WINDOW_MS
      while (this.acknowledgedWindows.length && this.acknowledgedWindows[0].at < cutoff) this.acknowledgedWindows.shift()
      void observationQueue.getQueueStats().then((stats) => {
        this.latestQueueStats = stats
        this.latestQueueStatsError = null
        if ((stats.canonicalRecoveryObservationCount ?? 0) > 0) {
          this.queuePausedForCanonicalFailure = true
          this.pauseReason = 'CANONICAL_RECOVERY_REQUIRED'
        }
        void observationQueue.getCanonicalRecoveryBatches(10).then((batches) => { this.canonicalRecoveryBatches = batches })
      }, (error: unknown) => {
        this.latestQueueStatsError = error instanceof Error ? error.message : String(error)
      })
    }
  }

  /** Hard deadline: the race guarantees settlement even if the platform ignores the abort signal. */
  private async submitWithTimeout(request: Parameters<typeof connectorObservationService.submitObservations>[0], diag: BatchDiagnostics, onResponseBody?: (body: unknown) => void): Promise<ConnectorObservationsResponse> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const monotonicStart = performance.now()
    let probeExpected = monotonicStart + LAG_PROBE_INTERVAL_MS
    let maxLag = 0
    const probe = setInterval(() => {
      const now = performance.now()
      maxLag = Math.max(maxLag, now - probeExpected)
      probeExpected = now + LAG_PROBE_INTERVAL_MS
    }, LAG_PROBE_INTERVAL_MS)
    const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'
    const onVisibility = () => { if (hidden()) diag.pageHiddenDuringRequest = true }
    diag.pageHiddenDuringRequest = hidden()
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        diag.timedOut = true
        controller.abort()
        reject(new ConnectorServiceError('TIMEOUT', `No complete Base44 response within ${this.config.requestTimeoutMs / 1000}s${diag.httpStatus !== null ? ` (HTTP ${diag.httpStatus} headers received, body incomplete)` : ''}.`))
      }, this.config.requestTimeoutMs)
    })
    diag.requestStartedAt = new Date().toISOString()
    try {
      return await Promise.race([
        connectorObservationService.submitObservations(request, { signal: controller.signal, onHttpResponse: (status) => { diag.httpStatus = status; diag.phase = 'AWAITING_BODY' }, onResponseBody }),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
      clearInterval(probe)
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
      diag.requestDurationMonotonicMs = Math.round(performance.now() - monotonicStart)
      diag.maxEventLoopLagMs = Math.round(Math.max(maxLag, performance.now() - probeExpected, 0))
    }
  }

  private completeRequest(diag: BatchDiagnostics): void {
    diag.requestCompletedAt = new Date().toISOString()
    if (diag.requestStartedAt) diag.requestDurationMs = Date.parse(diag.requestCompletedAt) - Date.parse(diag.requestStartedAt)
  }

  private async handleRequestFailure(error: unknown, diag: BatchDiagnostics, records: QueueRecord[], attemptedAt: string): Promise<null> {
    const mapped = error instanceof ConnectorServiceError ? error : new ConnectorServiceError('NETWORK_ERROR', error instanceof Error ? `Observation upload failed: ${error.message}` : 'Observation upload failed.')
    const retryable = mapped.code === 'NETWORK_ERROR' || mapped.code === 'TIMEOUT' || mapped.status === 408 || mapped.status === 429 || (mapped.status !== undefined && mapped.status >= 500) || mapped.code === 'AUTH_REQUIRED'
    diag.lastErrorCode = mapped.code
    diag.lastErrorMessage = mapped.message
    if (mapped.status !== undefined) diag.httpStatus = mapped.status
    const observationIds = records.map((record) => record.observationId)
    if (retryable) {
      if (mapped.code === 'TIMEOUT' || mapped.code === 'NETWORK_ERROR' || mapped.status === 429 || (mapped.status !== undefined && mapped.status >= 500)) {
        this.consecutiveTransientFailures++
        this.consecutiveSuccessfulBatches = 0
        if (this.consecutiveTransientFailures >= BACKOFF_FAILURE_STREAK) {
          this.previousEffectiveConcurrency = this.effectiveConcurrency
          this.effectiveConcurrency = Math.max(1, this.effectiveConcurrency - 1)
          this.newEffectiveConcurrency = this.effectiveConcurrency
          this.consecutiveTransientFailures = 0
        }
      }
      if (mapped.code === 'AUTH_REQUIRED' || mapped.status === 401) this.pause()
      await this.scheduleBatchRetry(diag, records, { code: mapped.code, message: mapped.message })
    } else {
      diag.phase = 'FAILED'
      await observationQueue.failClaims(records.map((record) => ({ queueId: record.queueId, batchId: diag.batchId, attemptCount: record.attemptCount })), { code: mapped.code, message: mapped.message })
    }
    this.notify({ batchId: diag.batchId, attemptedAt, outcome: retryable ? 'RETRYING' : 'FAILED', observationIds, acknowledgedIds: [], rejectedIds: retryable ? [] : observationIds, httpStatus: diag.httpStatus, errorCode: mapped.code, accepted: null, duplicate: null, rejected: null })
    return null
  }

  private async scheduleBatchRetry(diag: BatchDiagnostics, records: QueueRecord[], error: { code: string; message: string }): Promise<void> {
    diag.phase = 'RETRYING'
    diag.nextAttemptAt = this.nextAttempt(records)
    await observationQueue.retryClaims(records.map((record) => ({ queueId: record.queueId, batchId: diag.batchId, attemptCount: record.attemptCount })), error, diag.nextAttemptAt)
    this.scheduleRetry(diag.nextAttemptAt)
  }

  private installId(): string { return installationIdentityService.getInstallId() }
  private nextAttempt(records: QueueRecord[]): string { const attempt = Math.max(...records.map((record) => record.attemptCount), 1); const delay = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** (attempt - 1)); const jitter = Math.floor(Math.random() * Math.max(1, delay * 0.2)); return new Date(Date.now() + delay + jitter).toISOString() }
}

export const observationBatchManager = new ObservationBatchManager()
import { physicalTestBlocksSender } from '../diagnostics/PhysicalTestIsolation'