import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import { ConnectorServiceError, type ConnectorObservationsResponse } from '../base44/base44Types'
import { authenticationService } from '../base44/AuthenticationService'
import { installationIdentityService } from '../storage/InstallationIdentityService'
import type { QueueRecord } from '../storage/ObservationQueueStore'
import { observationQueue } from './ObservationQueue'
import { BrowserNetworkStatus, type NetworkStatus } from './NetworkStatus'

export interface BatchManagerConfig {
  batchSize: number
  staleInFlightMs: number
  retryBaseMs: number
  retryMaxMs: number
}

const defaultConfig: BatchManagerConfig = { batchSize: 100, staleInFlightMs: 15 * 60 * 1000, retryBaseMs: 5_000, retryMaxMs: 5 * 60 * 1000 }

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

  constructor(config: Partial<BatchManagerConfig> = {}, network: NetworkStatus = new BrowserNetworkStatus()) { this.config = { ...defaultConfig, ...config }; this.network = network }

  start(): void {
    this.unsubscribeNetwork = this.network.subscribe((online) => { if (online) void this.process() })
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', this.handleVisibility)
    void this.process()
  }

  stop(): void {
    this.unsubscribeNetwork()
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', this.handleVisibility)
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
    try { result = await this.processLoop() } finally { this.processing = false; if (this.rerunRequested) { this.rerunRequested = false; void this.process() } }
    return result
  }

  private async processLoop(): Promise<ConnectorObservationsResponse | null> {
    const ownerUserId = observationQueue.getOwnerUserId()
    if (!ownerUserId || !this.network.isOnline() || !(await authenticationService.isAuthenticated())) return null
    const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
    if (!connectorDeviceId) return null
    await observationQueue.releaseStaleInFlight(new Date(Date.now() - this.config.staleInFlightMs).toISOString())
    const records = await observationQueue.getPending(this.config.batchSize)
    if (!records.length) return null
    const batchId = createBatchId()
    const attemptedAt = new Date().toISOString()
    const observationIds = records.map((record) => record.observationId)
    await observationQueue.markInFlight(records.map((record) => record.queueId), batchId)
    try {
      const response = await connectorObservationService.submitObservations({ installId: this.installId(), connectorDeviceId, batchId, observations: records.map((record) => record.payload) })
      const rejectedIds = new Set(response.errors.map((error) => error.observationId).filter((id): id is string => Boolean(id)))
      const successfulIds = records.map((record) => record.observationId).filter((id) => !rejectedIds.has(id))
      await observationQueue.markAcknowledged(successfulIds)
      if (rejectedIds.size) {
        const rejectedQueueIds = records.filter((record) => rejectedIds.has(record.observationId)).map((record) => record.queueId)
        await observationQueue.markPermanentFailure(rejectedQueueIds, { code: 'VALIDATION_ERROR', message: 'Observation rejected by the connector service.' })
      }
      await observationQueue.purgeAcknowledged()
      this.notify({ batchId, attemptedAt, outcome: rejectedIds.size ? 'PARTIAL' : 'DELIVERED', observationIds, acknowledgedIds: successfulIds, rejectedIds: [...rejectedIds], httpStatus: 200, errorCode: null, accepted: response.accepted, duplicate: response.duplicate, rejected: response.rejected })
      return response
    } catch (error) {
      const mapped = error instanceof ConnectorServiceError ? error : new ConnectorServiceError('NETWORK_ERROR', 'Observation upload failed.')
      const retryable = mapped.code === 'NETWORK_ERROR' || mapped.status === 408 || mapped.status === 429 || (mapped.status !== undefined && mapped.status >= 500) || mapped.code === 'AUTH_REQUIRED'
      if (retryable) {
        if (mapped.code === 'AUTH_REQUIRED' || mapped.status === 401) this.pause()
        await observationQueue.markRetry(records.map((record) => record.queueId), { code: mapped.code, message: mapped.message }, this.nextAttempt(records))
      }
      else await observationQueue.markPermanentFailure(records.map((record) => record.queueId), { code: mapped.code, message: mapped.message })
      this.notify({ batchId, attemptedAt, outcome: retryable ? 'RETRYING' : 'FAILED', observationIds, acknowledgedIds: [], rejectedIds: retryable ? [] : observationIds, httpStatus: mapped.status ?? null, errorCode: mapped.code, accepted: null, duplicate: null, rejected: null })
      return null
    }
  }

  private installId(): string { return installationIdentityService.getInstallId() }
  private nextAttempt(records: QueueRecord[]): string { const attempt = Math.max(...records.map((record) => record.attemptCount), 1); const delay = Math.min(this.config.retryMaxMs, this.config.retryBaseMs * 2 ** (attempt - 1)); const jitter = Math.floor(Math.random() * Math.max(1, delay * 0.2)); return new Date(Date.now() + delay + jitter).toISOString() }
}

export const observationBatchManager = new ObservationBatchManager()