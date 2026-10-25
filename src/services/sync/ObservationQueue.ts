import type { NativeObservationInput } from '../base44/base44Types'
import { tracePipeline } from '../diagnostics/PipelineTrace'
import { physicalTestSideEffect } from '../diagnostics/PhysicalTestIsolation'
import { getQueueStore } from '../storage/QueueStoreFactory'
import { activityTransportClaimable, assertActivityRecoveryIds, verifyActivityTransport, type ActivityTransportEvidence } from '../storage/ActivityCertificationTransport'
import {
  QueueStoreError,
  MAX_QUEUE_CLAIM,
  SCOPED_ACTIVITY_E2E_CLAIM_COUNT,
  type EnqueueResult,
  type ObservationQueueStore,
  type QueueErrorCode,
  type QueueErrorMetadata,
  type QueueClaim,
  type CanonicalRecoveryClaim,
  type CanonicalRecoveryBatch,
  type QueueRecord,
  type QueueStats,
  type PendingQueueComposition,
  type QueueStoreType,
  type AcquisitionQueueProvenance,
} from '../storage/ObservationQueueStore'

export const queueLimits = { maxObservations: 100_000, warningAgeMs: 30 * 24 * 60 * 60 * 1000, maxBatchClaim: MAX_QUEUE_CLAIM }

export interface QueueDiagnostics {
  queueStoreType: QueueStoreType
  queueStoreInitialized: boolean
  queueDatabaseName: string
  queueSchemaVersion: number | null
  queueInitializationError: string | null
  queueInitializationAttemptedAt: string | null
  ownerAssigned: boolean
}

export interface QueueSelfTestResult {
  enqueueResult: { inserted: boolean; alreadyQueued: boolean }
  recordId: string | null
  readBack: boolean
  readBackPayloadMatches: boolean
  pendingCount: number
  selfTestStats: QueueStats
  removed: boolean
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : JSON.stringify(error) ?? 'Unknown queue error'
}

export class ObservationQueue {
  private readonly store: ObservationQueueStore
  private ownerUserId: string | null = null
  private initializationError: string | null = null
  private initializationAttemptedAt: string | null = null
  private initialized = false

  constructor(store: ObservationQueueStore = getQueueStore()) { this.store = store }

  async initialize(): Promise<void> {
    this.initializationAttemptedAt = new Date().toISOString()
    try {
      await this.store.initialize()
      this.initialized = true
      this.initializationError = null
    } catch (error) {
      this.initialized = false
      this.initializationError = errorMessage(error)
      throw new QueueStoreError('QUEUE_INIT_FAILED', this.initializationError)
    }
  }

  setOwnerUserId(ownerUserId: string | null): void { this.ownerUserId = ownerUserId }
  getOwnerUserId(): string | null { return this.ownerUserId }

  getDiagnostics(): QueueDiagnostics {
    return {
      queueStoreType: this.store.storeType,
      queueStoreInitialized: this.initialized,
      queueDatabaseName: this.store.databaseName,
      queueSchemaVersion: this.store.getSchemaVersion(),
      queueInitializationError: this.initializationError,
      queueInitializationAttemptedAt: this.initializationAttemptedAt,
      ownerAssigned: this.ownerUserId !== null,
    }
  }

  private requireOwner(): string {
    if (!this.ownerUserId) throw new QueueStoreError('QUEUE_OWNER_MISSING', 'Queue owner is not authenticated.')
    return this.ownerUserId
  }

  /** Initializes lazily so a failed startup initialization recovers on the next queue use. */
  private async ready(): Promise<string> {
    const owner = this.requireOwner()
    if (!this.initialized) await this.initialize()
    return owner
  }

  private async guard<T>(code: QueueErrorCode, operation: () => Promise<T>): Promise<T> {
    try {
      return await (code === 'QUEUE_WRITE_FAILED' ? physicalTestSideEffect('queue', operation) : operation())
    } catch (error) {
      if (error instanceof QueueStoreError) throw error
      throw new QueueStoreError(code, errorMessage(error))
    }
  }

  async enqueue(observation: NativeObservationInput, sourceEnvelopeId?: string, provenance?: AcquisitionQueueProvenance): Promise<EnqueueResult> {
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', () => this.traceEnqueue(owner, [observation],
      () => this.store.enqueue(owner, observation, sourceEnvelopeId, provenance).then((result) => [result]))).then((results) => results[0])
  }
  async enqueueMany(
    observations: NativeObservationInput[],
    sourceEnvelopeIds?: ReadonlyMap<string, string>,
    provenanceByObservationId?: ReadonlyMap<string, AcquisitionQueueProvenance>,
  ): Promise<EnqueueResult[]> {
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', () => this.traceEnqueue(owner, observations,
      () => this.store.enqueueMany(owner, observations, sourceEnvelopeIds, provenanceByObservationId)))
  }
  private async traceEnqueue(owner: string, observations: NativeObservationInput[], operation: () => Promise<EnqueueResult[]>): Promise<EnqueueResult[]> {
    tracePipeline('ENQUEUE_ATTEMPT', { owner, observations: observations.map((item) => ({
      observationId: item.observationId, sourceRecordId: item.sourceRecordId ?? null,
      metric: item.metric, vendorDataType: item.vendorDataType ?? null, observedAt: item.observedAt ?? item.startTime,
      metricType: item.metricType ?? null,
      dedupKey: [owner, item.observationId],
    })) })
    try {
      const results = await operation()
      tracePipeline('ENQUEUE_RESULT', { rows: results.map((item) => ({
        observationId: item.record.observationId, queueId: item.record.queueId, queueState: item.record.state,
        queueRowCreated: item.inserted, alreadyQueued: item.alreadyQueued,
        sourceEnvelopeId: item.record.sourceEnvelopeId ?? null,
      })) })
      return results
    } catch (error) {
      tracePipeline('ENQUEUE_ERROR', { observationIds: observations.map((item) => item.observationId), error: errorMessage(error) })
      throw error
    }
  }
  async listDiagnosticRecords(): Promise<QueueRecord[]> {
    const owner = await this.ready()
    if (!this.store.listDiagnosticRecords) throw new QueueStoreError('QUEUE_READ_FAILED', 'Diagnostic row enumeration is unavailable.')
    return this.guard('QUEUE_READ_FAILED', () => this.store.listDiagnosticRecords!(owner))
  }
  async getPendingComposition(currentV49SyncId: string | null): Promise<PendingQueueComposition> {
    const owner = await this.ready()
    return this.guard('QUEUE_READ_FAILED', () => this.store.getPendingComposition(owner, currentV49SyncId))
  }
  async getRecord(observationId: string): Promise<QueueRecord | null> { const owner = await this.ready(); return this.store.getRecord(owner, observationId) }
  async getPayloadJson(observationId: string): Promise<string | null> {
    const owner = await this.ready()
    return this.store.getPayloadJson(owner, observationId)
  }
  async updateAcquisitionProvenance(provenanceByObservationId: ReadonlyMap<string, AcquisitionQueueProvenance>): Promise<number> {
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', () => this.store.updateAcquisitionProvenance(owner, provenanceByObservationId))
  }
  /** Saved evidence must be verified by the Activity service before entering the sender barrier. */
  async recoverActivityCertificationTransport(evidence: readonly ActivityTransportEvidence[]): Promise<{ found: number; reconstructed: number }> {
    assertActivityRecoveryIds(evidence.map((item) => item.observationId))
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', async () => {
      const verified = await Promise.all(evidence.map(async (item) => {
        const payload = await verifyActivityTransport(item)
        const row = await this.store.getRecord(owner, item.observationId)
        const json = await this.store.getPayloadJson(owner, item.observationId)
        if (row && (row.sourceEnvelopeId !== item.sourceEnvelopeId || json !== item.payloadJson
          || JSON.stringify(row.payload) !== item.payloadJson || !activityTransportClaimable(row))) {
          throw new Error(`ACTIVITY_TRANSPORT_RECOVERY_BLOCKED: ${item.observationId} state=${row.state}; changed evidence, live claim or canonical recovery.`)
        }
        return { item, payload, row }
      }))
      if (this.getOwnerUserId() !== owner) throw new Error('Activity queue owner changed before transport recovery.')
      const missing = verified.filter((item) => !item.row)
      if (missing.length) {
        await this.store.enqueueMany(owner, missing.map((item) => item.payload),
          new Map(missing.map(({ item }) => [item.observationId, item.sourceEnvelopeId])))
      }
      for (const { item } of verified) {
        const row = await this.store.getRecord(owner, item.observationId)
        if (!row || row.sourceEnvelopeId !== item.sourceEnvelopeId || !activityTransportClaimable(row)
          || await this.store.getPayloadJson(owner, item.observationId) !== item.payloadJson) {
          throw new Error('ACTIVITY_TRANSPORT_READBACK_FAILED: recovered transport differs from durable certification.')
        }
      }
      if (this.getOwnerUserId() !== owner) throw new Error('Activity queue owner changed after transport recovery.')
      return { found: verified.length - missing.length, reconstructed: missing.length }
    })
  }
  async claimActivityCertificationObservationIds(ids: readonly string[], batchId: string): Promise<QueueRecord[]> {
    assertActivityRecoveryIds(ids)
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', () => this.store.claimActivityCertification(owner, ids, batchId))
  }
  /** Only call inside the sender's certification barrier, after preserving the source snapshot. */
  async removePreservedCertificationObservation(observationId: string, payloadJson: string): Promise<void> {
    const owner = await this.ready()
    await this.guard('QUEUE_WRITE_FAILED', async () => {
      const row = await this.store.getRecord(owner, observationId)
      if (!row) return
      if (row.state === 'IN_FLIGHT' || JSON.stringify(row.payload) !== payloadJson) {
        throw new Error('Preserved certification row is in flight or its payload changed.')
      }
      await this.store.remove(owner, [observationId])
      if (await this.store.getRecord(owner, observationId)) throw new Error('Preserved certification row removal was not confirmed.')
    })
  }
  /** Local certification reconciliation only; this never claims, enqueues, or submits transport rows. */
  async purgeVerifiedDeliveredActivityTransport(evidence: readonly ActivityTransportEvidence[]): Promise<void> {
    assertActivityRecoveryIds(evidence.map((item) => item.observationId))
    const owner = await this.ready()
    await this.guard('QUEUE_WRITE_FAILED', async () => {
      const verified = await Promise.all(evidence.map(async (item) => {
        await verifyActivityTransport(item)
        const row = await this.store.getRecord(owner, item.observationId)
        const payloadJson = await this.store.getPayloadJson(owner, item.observationId)
        if (row && (row.ownerUserId !== owner || row.observationId !== item.observationId
          || row.sourceEnvelopeId !== item.sourceEnvelopeId || payloadJson !== item.payloadJson
          || JSON.stringify(row.payload) !== item.payloadJson || row.state === 'IN_FLIGHT'
          || row.state === 'CANONICAL_RECOVERY_REQUIRED')) {
          throw new Error(`ACTIVITY_LOCAL_RECONCILIATION_BLOCKED: ${item.observationId} queue/source evidence changed or row is in flight.`)
        }
        return row ? item.observationId : null
      }))
      if (this.getOwnerUserId() !== owner) throw new Error('Activity queue owner changed before local reconciliation.')
      const presentIds = verified.filter((id): id is string => id !== null)
      if (presentIds.length) await this.store.remove(owner, presentIds)
      for (const id of presentIds) {
        if (await this.store.getRecord(owner, id)) throw new Error(`ACTIVITY_LOCAL_RECONCILIATION_PURGE_UNCONFIRMED: ${id}`)
      }
      if (this.getOwnerUserId() !== owner) throw new Error('Activity queue owner changed after local reconciliation.')
    })
  }
  async getPending(limit: number): Promise<QueueRecord[]> { const owner = await this.ready(); return this.store.getPending(owner, Math.min(limit, queueLimits.maxBatchClaim)) }
  /** Atomic claim used by the batch manager so concurrent workers never pick up the same PENDING rows. */
  async claimPending(limit: number, batchId: string): Promise<QueueRecord[]> { const owner = await this.ready(); return this.guard('QUEUE_WRITE_FAILED', () => this.store.claimPending(owner, Math.min(limit, queueLimits.maxBatchClaim), batchId)) }
  async claimPendingByObservationIds(ownerUserId: string, observationIds: readonly string[], batchId: string, now = new Date()): Promise<QueueRecord[]> {
    const owner = await this.ready()
    if (owner !== ownerUserId) throw new QueueStoreError('QUEUE_OWNER_MISSING', 'Scoped Activity claim owner does not match the authenticated queue owner.')
    if (observationIds.length !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT
      || new Set(observationIds).size !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT) {
      throw new QueueStoreError('QUEUE_READ_FAILED', `Scoped Activity claim requires exactly ${SCOPED_ACTIVITY_E2E_CLAIM_COUNT} unique observation IDs.`)
    }
    const records = await this.guard('QUEUE_WRITE_FAILED', () =>
      this.store.claimPendingByObservationIds(owner, observationIds, batchId, now))
    const requested = new Set(observationIds)
    if (this.getOwnerUserId() !== owner || records.length !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT
      || records.some((record) => record.ownerUserId !== owner || record.state !== 'IN_FLIGHT'
        || record.batchId !== batchId || !requested.has(record.observationId))
      || new Set(records.map((record) => record.observationId)).size !== SCOPED_ACTIVITY_E2E_CLAIM_COUNT) {
      throw new QueueStoreError('QUEUE_WRITE_FAILED', 'Scoped Activity claim result did not match the exact owner-scoped ID set.')
    }
    return records
  }
  async claimCertificationObservationIds(observationIds: readonly string[], batchId: string, ignoreRetryBackoff = false): Promise<QueueRecord[]> {
    if (observationIds.length > queueLimits.maxBatchClaim) throw new QueueStoreError('QUEUE_READ_FAILED', 'Certification claim exceeds the 100-row limit.')
    const owner = await this.ready()
    return this.guard('QUEUE_WRITE_FAILED', () => this.store.claimPending(owner, queueLimits.maxBatchClaim, batchId, new Date(), observationIds, ignoreRetryBackoff))
  }
  async getNextRetryAt(now = new Date()): Promise<string | null> { const owner = await this.ready(); return this.store.getNextRetryAt(owner, now) }
  async acknowledgeClaims(claims: QueueClaim[]): Promise<number> {
    const owner = await this.ready()
    const count = await this.guard('QUEUE_WRITE_FAILED', () => this.store.acknowledgeClaims(claims, owner))
    tracePipeline('ACK', { owner, claims, requested: claims.length, count })
    return count
  }
  async markCanonicalRecoveryRequired(claims: CanonicalRecoveryClaim[], error: QueueErrorMetadata): Promise<number> { const owner = await this.ready(); return this.guard('QUEUE_WRITE_FAILED', () => this.store.markCanonicalRecoveryRequired(claims, owner, error)) }
  async getCanonicalRecoveryBatches(limit = 10): Promise<CanonicalRecoveryBatch[]> { const owner = await this.ready(); return this.store.getCanonicalRecoveryBatches(owner, limit) }
  async recordCanonicalRecoveryPause(batchId: string, observationCount: number, at: string): Promise<void> { const owner = await this.ready(); return this.guard('QUEUE_WRITE_FAILED', () => this.store.recordCanonicalRecoveryPause(owner, batchId, observationCount, at)) }
  async retryClaims(claims: QueueClaim[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<number> { await this.ready(); return this.guard('QUEUE_WRITE_FAILED', () => this.store.retryClaims(claims, error, nextAttemptAt)) }
  async failClaims(claims: QueueClaim[], error: QueueErrorMetadata): Promise<number> { await this.ready(); return this.guard('QUEUE_WRITE_FAILED', () => this.store.failClaims(claims, error)) }
  async releaseStaleInFlight(staleBefore: string): Promise<number> { const owner = await this.ready(); return this.guard('QUEUE_WRITE_FAILED', () => this.store.releaseStaleInFlight(owner, staleBefore)) }
  async countStaleInFlight(staleBefore: string): Promise<number> { const owner = await this.ready(); return this.store.countStaleInFlight(owner, staleBefore) }
  async getQueueStats(): Promise<QueueStats> {
    const owner = await this.ready()
    return this.guard('QUEUE_READ_FAILED', () => this.store.getQueueStats(owner))
  }
  async getOldestPendingAge(): Promise<number | null> { return this.store.getOldestPendingAge(this.requireOwner()) }
  async purgeAcknowledged(observationIds?: readonly string[]): Promise<number> {
    const count = await this.guard('QUEUE_WRITE_FAILED', () => this.store.purgeAcknowledged(this.requireOwner(), observationIds))
    tracePipeline('PURGE', { observationIds: observationIds ?? null, count })
    return count
  }

  /** Writes, reads back and removes one observation under an isolated owner so it can never be uploaded. */
  async selfTest(observation: NativeObservationInput): Promise<QueueSelfTestResult> {
    const owner = `__queue_self_test__:${await this.ready()}`
    return this.guard('QUEUE_WRITE_FAILED', async () => {
      const enqueued = await this.store.enqueue(owner, observation)
      const record = await this.store.getRecord(owner, observation.observationId)
      const selfTestStats = await this.store.getQueueStats(owner)
      await this.store.remove(owner, [observation.observationId])
      const removed = (await this.store.getRecord(owner, observation.observationId)) === null
      return {
        enqueueResult: { inserted: enqueued.inserted, alreadyQueued: enqueued.alreadyQueued },
        recordId: record?.queueId ?? null,
        readBack: record !== null,
        readBackPayloadMatches: record !== null && JSON.stringify(record.payload) === JSON.stringify(observation),
        pendingCount: selfTestStats.pending,
        selfTestStats,
        removed,
      }
    })
  }
}

export const observationQueue = new ObservationQueue()