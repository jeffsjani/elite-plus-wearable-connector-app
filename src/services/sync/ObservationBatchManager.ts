import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import { ConnectorServiceError, type ConnectorObservationResult, type ConnectorObservationsResponse } from '../base44/base44Types'
import { authenticationService } from '../base44/AuthenticationService'
import { installationIdentityService } from '../storage/InstallationIdentityService'
import { QueueStoreError, type QueueRecord } from '../storage/ObservationQueueStore'
import { observationQueue } from './ObservationQueue'
import { BrowserNetworkStatus, type NetworkStatus } from './NetworkStatus'

export interface BatchManagerConfig {
  batchSize: number
  /** Must exceed requestTimeoutMs so a live request is never released. */
  staleInFlightMs: number
  requestTimeoutMs: number
  retryBaseMs: number
  retryMaxMs: number
}

const defaultConfig: BatchManagerConfig = { batchSize: 100, staleInFlightMs: 60_000, requestTimeoutMs: 30_000, retryBaseMs: 5_000, retryMaxMs: 5 * 60 * 1000 }

export type BatchPhase = 'SENDING' | 'AWAITING_BODY' | 'ACKNOWLEDGING' | 'DELIVERED' | 'PARTIAL' | 'RETRYING' | 'FAILED'

export interface BatchDiagnostics {
  batchId: string
  observationCount: number
  attemptNumber: number
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
  serverTimestamp: string | null
  timedOut: boolean
  lastErrorCode: string | null
  lastErrorMessage: string | null
  nextAttemptAt: string | null
}

export type StaleRecoveryTrigger = 'STARTUP' | 'PROCESS' | 'MANUAL'

export interface DeliveryDiagnostics {
  requestTimeoutMs: number
  staleSendingMs: number
  activeBatch: BatchDiagnostics | null
  lastBatch: BatchDiagnostics | null
  retryScheduledAt: string | null
  lastStaleRecovery: { at: string; trigger: StaleRecoveryTrigger; released: number } | null
}

export type BatchDeliveryOutcome = 'DELIVERED' | 'PARTIAL' | 'RETRYING' | 'FAILED'

export interface BatchDeliveryEvent {
  batchId: string
  attemptedAt: string
  outcome: BatchDeliveryOutcome
  observationIds: string[]
  acknowledgedIds: string[]
  rejectedIds: string[]
  httpStatus: number | null
  errorCode: string | null
  accepted: number | null
  duplicate: number | null
  rejected: number | null
  /** Per-observation results from a 2xx response, when the backend provides them. */
  results?: ConnectorObservationResult[] | null
  errors?: ConnectorObservationsResponse['errors'] | null
}

export type BatchDeliveryListener = (event: BatchDeliveryEvent) => void

function createBatchId(): string { return crypto.randomUUID() }

export class ObservationBatchManager {
  private readonly config: BatchManagerConfig
  private readonly network: NetworkStatus
  private processing = false
  private rerunRequested = false
  private paused = false
  private unsubscribeNetwork: () => void = () => undefined
  private readonly listeners = new Set<BatchDeliveryListener>()
  private started = false
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryScheduledAt: string | null = null
  private activeBatch: BatchDiagnostics | null = null
  private lastBatch: BatchDiagnostics | null = null
  private lastStaleRecovery: DeliveryDiagnostics['lastStaleRecovery'] = null

  constructor(config: Partial<BatchManagerConfig> = {}, network: NetworkStatus = new BrowserNetworkStatus()) { this.config = { ...defaultConfig, ...config }; this.network = network }

  start(): void {
    this.started = true
    this.unsubscribeNetwork = this.network.subscribe((online) => { if (online) void this.process() })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibility)
    void this.recoverStaleSending('STARTUP').catch(() => 0).finally(() => { void this.process() })
  }

  stop(): void {
    this.started = false
    this.unsubscribeNetwork()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.handleVisibility)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.retryScheduledAt = null
  }

  getDeliveryDiagnostics(): DeliveryDiagnostics {
    const active = this.activeBatch ? { ...this.activeBatch, elapsedMs: Date.now() - Date.parse(this.activeBatch.startedAt) } : null
    return {
      requestTimeoutMs: this.config.requestTimeoutMs,
      staleSendingMs: this.config.staleInFlightMs,
      activeBatch: active,
      lastBatch: this.lastBatch ? { ...this.lastBatch } : null,
      retryScheduledAt: this.retryScheduledAt,
      lastStaleRecovery: this.lastStaleRecovery,
    }
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
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryScheduledAt = at
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.retryScheduledAt = null; void this.process() }, Math.max(0, Date.parse(at) - Date.now()))
  }

  pause(): void { this.paused = true }
  resume(): void { this.paused = false; void this.process() }

  subscribe(listener: BatchDeliveryListener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(event: BatchDeliveryEvent): void {
    for (const listener of this.listeners) {
      try { listener(event) } catch { /* diagnostics listeners must not affect delivery */ }
    }
  }

  private handleVisibility = (): void => { if (document.visibilityState === 'visible') void this.process() }

  async process(): Promise<ConnectorObservationsResponse | null> {
    if (this.paused) return null
    if (this.processing) { this.rerunRequested = true; return null }
    this.processing = true
    let result: ConnectorObservationsResponse | null = null
    try { result = await this.processLoop() } catch (error) {
      // Local queue unavailability is surfaced through queue diagnostics; nothing was sent.
      if (!(error instanceof QueueStoreError)) throw error
    } finally { this.processing = false; if (this.rerunRequested) { this.rerunRequested = false; void this.process() } }
    return result
  }

  private async processLoop(): Promise<ConnectorObservationsResponse | null> {
    const ownerUserId = observationQueue.getOwnerUserId()
    if (!ownerUserId) return null
    // Runs before connectivity checks so interrupted batches are released on any trigger.
    await this.recoverStaleSending('PROCESS')
    if (!this.network.isOnline() || !(await authenticationService.isAuthenticated())) return null
    const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
    if (!connectorDeviceId) return null
    const records = await observationQueue.getPending(this.config.batchSize)
    if (!records.length) return null
    const batchId = createBatchId()
    const attemptedAt = new Date().toISOString()
    const observationIds = records.map((record) => record.observationId)
    const queueIds = records.map((record) => record.queueId)
    const diag: BatchDiagnostics = {
      batchId, observationCount: records.length, attemptNumber: Math.max(0, ...records.map((record) => record.attemptCount)) + 1,
      phase: 'SENDING', startedAt: attemptedAt, requestStartedAt: null, requestCompletedAt: null, requestDurationMs: null, elapsedMs: 0,
      httpStatus: null, backendResponseReceived: false, responseSuccess: null, responseBatchId: null, responseAccepted: null,
      responseDuplicate: null, responseRejected: null, responseErrorCount: null, serverTimestamp: null, timedOut: false,
      lastErrorCode: null, lastErrorMessage: null, nextAttemptAt: null,
    }
    this.activeBatch = diag
    try {
      await observationQueue.markInFlight(queueIds, batchId)
      let response: ConnectorObservationsResponse
      try {
        response = await this.submitWithTimeout({ installId: this.installId(), connectorDeviceId, batchId, observations: records.map((record) => record.payload) }, diag)
      } catch (error) {
        this.completeRequest(diag)
        return await this.handleRequestFailure(error, diag, records, attemptedAt)
      }
      this.completeRequest(diag)
      Object.assign(diag, {
        phase: 'ACKNOWLEDGING', backendResponseReceived: true, httpStatus: diag.httpStatus ?? 200, responseSuccess: response.success,
        responseBatchId: response.batchId ?? null, responseAccepted: response.accepted ?? null, responseDuplicate: response.duplicate ?? null,
        responseRejected: response.rejected ?? null, responseErrorCount: response.errors?.length ?? 0, serverTimestamp: response.serverTimestamp ?? null,
      })
      // results[] is authoritative; errors[] is capped at 50 so it can miss rejections.
      const rejectedIds = new Set([
        ...(response.results ?? []).filter((result) => result.status === 'rejected').map((result) => result.observationId),
        ...(response.errors ?? []).map((error) => error.observationId),
      ].filter((id): id is string => Boolean(id) && observationIds.includes(id!)))
      const successfulIds = observationIds.filter((id) => !rejectedIds.has(id))
      try {
        await observationQueue.markAcknowledged(successfulIds)
        if (rejectedIds.size) {
          const rejectedQueueIds = records.filter((record) => rejectedIds.has(record.observationId)).map((record) => record.queueId)
          await observationQueue.markPermanentFailure(rejectedQueueIds, { code: 'VALIDATION_ERROR', message: 'Observation rejected by the connector service.' })
        }
        await observationQueue.purgeAcknowledged()
      } catch (error) {
        // Base44 accepted the batch; replaying the same observation IDs is idempotent.
        diag.lastErrorCode = 'ACK_PROCESSING_FAILED'
        diag.lastErrorMessage = `Base44 responded (accepted ${response.accepted}, duplicate ${response.duplicate}) but the local queue ACK failed: ${error instanceof Error ? error.message : String(error)}`
        await this.scheduleBatchRetry(diag, records, { code: diag.lastErrorCode, message: diag.lastErrorMessage }).catch(() => undefined)
        this.notify({ batchId, attemptedAt, outcome: 'RETRYING', observationIds, acknowledgedIds: [], rejectedIds: [], httpStatus: diag.httpStatus, errorCode: diag.lastErrorCode, accepted: response.accepted, duplicate: response.duplicate, rejected: response.rejected, results: response.results ?? null, errors: response.errors ?? null })
        return null
      }
      diag.phase = rejectedIds.size ? 'PARTIAL' : 'DELIVERED'
      this.notify({ batchId, attemptedAt, outcome: diag.phase, observationIds, acknowledgedIds: successfulIds, rejectedIds: [...rejectedIds], httpStatus: diag.httpStatus, errorCode: null, accepted: response.accepted, duplicate: response.duplicate, rejected: response.rejected, results: response.results ?? null, errors: response.errors ?? null })
      return response
    } finally {
      this.lastBatch = { ...diag, elapsedMs: Date.now() - Date.parse(diag.startedAt) }
      this.activeBatch = null
    }
  }

  /** Hard deadline: the race guarantees settlement even if the platform ignores the abort signal. */
  private async submitWithTimeout(request: Parameters<typeof connectorObservationService.submitObservations>[0], diag: BatchDiagnostics): Promise<ConnectorObservationsResponse> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
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
        connectorObservationService.submitObservations(request, { signal: controller.signal, onHttpResponse: (status) => { diag.httpStatus = status; diag.phase = 'AWAITING_BODY' } }),
        timeout,
      ])
    } finally {
      clearTimeout(timer)
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
      if (mapped.code === 'AUTH_REQUIRED' || mapped.status === 401) this.pause()
      await this.scheduleBatchRetry(diag, records, { code: mapped.code, message: mapped.message })
    } else {
      diag.phase = 'FAILED'
      await observationQueue.markPermanentFailure(records.map((record) => record.queueId), { code: mapped.code, message: mapped.message })
    }
    this.notify({ batchId: diag.batchId, attemptedAt, outcome: retryable ? 'RETRYING' : 'FAILED', observationIds, acknowledgedIds: [], rejectedIds: retryable ? [] : observationIds, httpStatus: diag.httpStatus, errorCode: mapped.code, accepted: null, duplicate: null, rejected: null })
    return null
  }

  private async scheduleBatchRetry(diag: BatchDiagnostics, records: QueueRecord[], error: { code: string; message: string }): Promise<void> {
    diag.phase = 'RETRYING'
    diag.nextAttemptAt = this.nextAttempt(records)
    await observationQueue.markRetry(records.map((record) => record.queueId), error, diag.nextAttemptAt)
    this.scheduleRetry(diag.nextAttemptAt)
  }

  private installId(): string { return installationIdentityService.getInstallId() }
  private nextAttempt(records: QueueRecord[]): string { const attempt = Math.max(...records.map((record) => record.attemptCount), 1); const delay = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** (attempt - 1)); const jitter = Math.floor(Math.random() * Math.max(1, delay * 0.2)); return new Date(Date.now() + delay + jitter).toISOString() }
}

export const observationBatchManager = new ObservationBatchManager()