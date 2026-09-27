import type { NativeObservationInput } from '../base44/base44Types'
import { getQueueStore } from '../storage/QueueStoreFactory'
import type { EnqueueResult, QueueErrorMetadata, QueueRecord, QueueStats } from '../storage/ObservationQueueStore'

export const queueLimits = { maxObservations: 100_000, warningAgeMs: 30 * 24 * 60 * 60 * 1000 }

export class ObservationQueue {
  private readonly store = getQueueStore()
  private ownerUserId: string | null = null

  async initialize(): Promise<void> { await this.store.initialize() }
  setOwnerUserId(ownerUserId: string | null): void { this.ownerUserId = ownerUserId }
  getOwnerUserId(): string | null { return this.ownerUserId }

  private requireOwner(): string { if (!this.ownerUserId) throw new Error('Queue owner is not authenticated.') ; return this.ownerUserId }
  async enqueue(observation: NativeObservationInput): Promise<EnqueueResult> { return this.store.enqueue(this.requireOwner(), observation) }
  async enqueueMany(observations: NativeObservationInput[]): Promise<EnqueueResult[]> { return this.store.enqueueMany(this.requireOwner(), observations) }
  async getPending(limit: number): Promise<QueueRecord[]> { return this.store.getPending(this.requireOwner(), Math.min(limit, 100)) }
  async markInFlight(queueIds: string[], batchId: string): Promise<void> { await this.store.markInFlight(queueIds, batchId) }
  async markAcknowledged(observationIds: string[]): Promise<void> { await this.store.markAcknowledged(observationIds, this.requireOwner()) }
  async markRetry(queueIds: string[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<void> { await this.store.markRetry(queueIds, error, nextAttemptAt) }
  async markPermanentFailure(queueIds: string[], error: QueueErrorMetadata): Promise<void> { await this.store.markPermanentFailure(queueIds, error) }
  async releaseStaleInFlight(staleBefore: string): Promise<void> { await this.store.releaseStaleInFlight(this.requireOwner(), staleBefore) }
  async getQueueStats(): Promise<QueueStats> { return this.store.getQueueStats(this.requireOwner()) }
  async getOldestPendingAge(): Promise<number | null> { return this.store.getOldestPendingAge(this.requireOwner()) }
  async purgeAcknowledged(): Promise<number> { return this.store.purgeAcknowledged(this.requireOwner()) }
}

export const observationQueue = new ObservationQueue()