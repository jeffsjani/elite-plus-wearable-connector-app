import 'fake-indexeddb/auto'
import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeObservationInput } from '../base44/base44Types'
import { NativeSQLiteQueueStore } from '../storage/NativeSQLiteQueueStore'
import { QueueStoreError, SCOPED_ACTIVITY_E2E_CLAIM_COUNT, type QueueRecord } from '../storage/ObservationQueueStore'
import { WebQueueStore } from '../storage/WebQueueStore'
import { buildWorkoutHrObservation } from '../../adapters/jcvital/WorkoutHrDelivery'
import { ObservationQueue, observationQueue } from './ObservationQueue'
import { ObservationBatchManager, type BatchDeliveryEvent } from './ObservationBatchManager'
import { authenticationService } from '../base44/AuthenticationService'
import { connectorIdentityService } from '../base44/ConnectorIdentityService'
import { connectorObservationService } from '../base44/ConnectorObservationService'
import { PRIOR_SPO2_CERTIFICATION_IDS, SpO2Certification } from '../../adapters/jcvital/SpO2Certification'
import { TemperatureCertification } from '../../adapters/jcvital/TemperatureCertification'
import { buildCertificationValidationExport, serializeCertificationValidationExport } from '../../adapters/jcvital/CertificationValidationExport'
import { ACTIVITY_RESUME_IDS, ACTIVITY_EXCLUDED_ID, ACTIVITY_R5_REVISION, ACTIVITY_RESPONSE_CONTRACT } from '../../adapters/jcvital/ActivityResumeContract'
import { transportFingerprint, type ActivityTransportEvidence } from '../storage/ActivityCertificationTransport'
import { createSyntheticObservation } from '../testing/SyntheticObservationFactory'

const sqlite = vi.hoisted(() => ({
  connections: new Set<string>(),
  databases: new Map<string, { db: { exec(sql: string): void; prepare(sql: string): { all(...values: unknown[]): unknown[]; run(...values: unknown[]): { changes: number | bigint } } }; open: boolean }>(),
  failCreateConnection: null as string | null,
  failOpenOnce: false,
  runCalls: 0,
  executeSetCalls: 0,
}))

/** Mirrors CapacitorSQLitePlugin.java argument validation on Android, executed against real SQLite. */
vi.mock('@capacitor-community/sqlite', async () => {
  const { DatabaseSync } = await import('node:sqlite')
  const openDatabase = (database: string) => {
    const entry = sqlite.databases.get(database)
    if (!entry || !sqlite.connections.has(database)) throw new Error(`No available connection for database ${database}`)
    if (!entry.open) throw new Error(`database ${database} not opened`)
    return entry.db
  }
  return {
    CapacitorSQLite: {
      async createConnection({ database }: { database: string }) {
        if (sqlite.failCreateConnection) throw new Error(sqlite.failCreateConnection)
        if (sqlite.connections.has(database)) throw new Error(`CreateConnection: Connection ${database} already exists`)
        sqlite.connections.add(database)
        if (!sqlite.databases.has(database)) sqlite.databases.set(database, { db: new DatabaseSync(':memory:'), open: false })
      },
      async isDBOpen({ database }: { database: string }) {
        if (!sqlite.connections.has(database)) throw new Error(`IsDBOpen: No available connection for database ${database}`)
        return { result: sqlite.databases.get(database)!.open }
      },
      async open({ database }: { database: string }) {
        if (sqlite.failOpenOnce) { sqlite.failOpenOnce = false; throw new Error('Open: simulated open failure') }
        sqlite.databases.get(database)!.open = true
      },
      async execute({ database, statements, transaction = true }: { database: string; statements: string; transaction?: boolean }) {
        openDatabase(database).exec(transaction ? `BEGIN; ${statements} COMMIT;` : statements)
        return { changes: { changes: 0 } }
      },
      async query({ database, statement, values }: { database: string; statement: string; values?: unknown[] }) {
        if (!Array.isArray(values)) throw new Error('Query: Must provide an Array of Strings')
        return { values: openDatabase(database).prepare(statement).all(...values) }
      },
      async run({ database, statement, values }: { database: string; statement: string; values?: unknown[] }) {
        if (!Array.isArray(values)) throw new Error('Run: Must provide an Array of values')
        sqlite.runCalls++
        return { changes: { changes: Number(openDatabase(database).prepare(statement).run(...values).changes) } }
      },
      async executeSet({ database, set, transaction = true }: { database: string; set?: Array<{ statement?: string; values?: unknown[] }>; transaction?: boolean }) {
        if (!set || !set.length) throw new Error('ExecuteSet: Must provide a non-empty set of SQL statements')
        sqlite.executeSetCalls++
        const db = openDatabase(database)
        let changes = 0
        if (transaction) db.exec('BEGIN;')
        try {
          for (const entry of set) changes += Number(db.prepare(entry.statement!).run(...(entry.values ?? [])).changes)
          if (transaction) db.exec('COMMIT;')
        } catch (error) {
          if (transaction) db.exec('ROLLBACK;')
          throw error
        }
        return { changes: { changes } }
      },
    },
  }
})

const physicalContext = { deviceId: 'jcvital_device_864cdfe8-8beb-481f-b4d5-5f361d57bfbb', firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0', vendorActivityMode: 0 }

async function physicalFixture(owner: string): Promise<NativeObservationInput> {
  const observation = await buildWorkoutHrObservation(owner, {
    sessionId: '6c1f3a52-0d8e-4b7a-9e21-5f4c3b2a1d0e', heartRate: 112, packetSequence: 42,
    receivedAt: '2026-10-01T16:42:18.517Z', vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME',
  }, physicalContext, 'America/New_York')
  return observation!
}

describe('exact scoped Activity E2E claims on both queue stores', () => {
  it.each(['SQLITE', 'INDEXEDDB'] as const)('%s claims only the 14 supplied PENDING rows and rejects invalid owner/state', async (kind) => {
    const store = kind === 'SQLITE' ? new NativeSQLiteQueueStore() : new WebQueueStore()
    const queue = new ObservationQueue(store)
    const owner = `scoped-e2e-${kind}-${Date.now()}`
    queue.setOwnerUserId(owner)
    await queue.initialize()
    const ids = Array.from({ length: SCOPED_ACTIVITY_E2E_CLAIM_COUNT }, (_, index) => index.toString(16).padStart(64, '0'))
    const payloads = ids.map((observationId) => ({ ...createSyntheticObservation('activity-v2-e2e'), observationId }))
    await queue.enqueueMany(payloads)

    await expect(queue.claimPendingByObservationIds(`${owner}-wrong`, ids, 'wrong-owner'))
      .rejects.toThrow(/does not match/)
    await expect(queue.claimPendingByObservationIds(owner, ids.slice(0, 13), '13-ids'))
      .rejects.toThrow(/exactly 14/)
    await expect(queue.claimPendingByObservationIds(owner, [...ids, 'f'.repeat(64)], '15-ids'))
      .rejects.toThrow(/exactly 14/)
    await expect(queue.claimPendingByObservationIds(owner, [...ids.slice(0, 13), ids[0]], 'duplicate-ids'))
      .rejects.toThrow(/exactly 14/)

    const claimed = await queue.claimPendingByObservationIds(owner, ids, 'scoped-batch')
    expect(claimed).toHaveLength(14)
    expect(claimed.map((record) => record.observationId).sort()).toEqual([...ids].sort())
    expect(claimed.every((record) => record.ownerUserId === owner && record.state === 'IN_FLIGHT'
      && record.batchId === 'scoped-batch')).toBe(true)

    const missingOwner = `${owner}-missing`
    queue.setOwnerUserId(missingOwner)
    await queue.enqueueMany(payloads.slice(0, 13))
    await expect(queue.claimPendingByObservationIds(missingOwner, ids, 'missing-row'))
      .rejects.toThrow(/must exist/)
    expect((await Promise.all(ids.slice(0, 13).map((id) => queue.getRecord(id))))
      .every((record) => record?.state === 'PENDING')).toBe(true)

    const nonClaimableOwner = `${owner}-nonclaimable`
    queue.setOwnerUserId(nonClaimableOwner)
    await queue.enqueueMany(payloads)
    const preclaimed = await queue.claimPending(1, 'pre-existing-claim')
    expect(preclaimed).toHaveLength(1)
    await expect(queue.claimPendingByObservationIds(nonClaimableOwner, ids, 'nonclaimable'))
      .rejects.toThrow(/must exist/)
    expect((await Promise.all(ids.slice(1).map((id) => queue.getRecord(id))))
      .every((record) => record?.state === 'PENDING')).toBe(true)
  })

  it('rejects a scoped store result that contains an ID outside the requested set', async () => {
    const store = new WebQueueStore()
    const queue = new ObservationQueue(store)
    const owner = `scoped-e2e-bad-result-${Date.now()}`
    queue.setOwnerUserId(owner)
    await queue.initialize()
    const ids = Array.from({ length: 14 }, (_, index) => `bad-result-${index}`)
    await queue.enqueueMany(ids.map((observationId) => ({ ...createSyntheticObservation(), observationId })))
    const claim = store.claimPendingByObservationIds.bind(store)
    vi.spyOn(store, 'claimPendingByObservationIds').mockImplementation(async (...args) => {
      const records = await claim(...args)
      return records.map((record, index) => index === 0 ? { ...record, observationId: 'unrelated-id' } : record)
    })

    await expect(queue.claimPendingByObservationIds(owner, ids, 'bad-readback'))
      .rejects.toThrow(/exact owner-scoped ID set/)
  })
})

beforeEach(() => {
  sqlite.connections.clear()
  sqlite.databases.clear()
  sqlite.failCreateConnection = null
  sqlite.failOpenOnce = false
  sqlite.runCalls = 0
  sqlite.executeSetCalls = 0
})

async function activityTransportEvidence(owner: string): Promise<ActivityTransportEvidence[]> {
  const template = await physicalFixture(owner)
  return Promise.all(ACTIVITY_RESUME_IDS.map(async (observationId, index) => {
    const sourceEnvelopeId = `activity-source-${index}`
    const payload: NativeObservationInput = {
      ...template, observationId, metric: 'activityVendorDAILY_STEPS', metricType: 'DAILY_STEPS',
      provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE', vendorDataType: '24', vendorField: 'step',
      sourceRecordGroupId: `activity-group-${index}`, valueNumber: 105, unit: 'count',
      rawSourceMetadata: { certificationOnly: true, canonicalPolicy: 'NATIVE_ONLY', canonicalTarget: null, sourceEnvelopeId,
        sourceFingerprint: `source-fingerprint-${index}` },
    }
    const payloadJson = JSON.stringify(payload)
    return { observationId, payloadJson, payloadFingerprint: await transportFingerprint(payloadJson), sourceEnvelopeId }
  }))
}

describe('VC19 dedicated Activity transport recovery on both durable stores', () => {
  afterEach(() => vi.restoreAllMocks())
  it.each(['SQLITE', 'INDEXEDDB'] as const)('%s restores missing rows, reuses failed/retry rows, bypasses backoff without exposing them to auto-drain', async (kind) => {
    const store = kind === 'SQLITE' ? new NativeSQLiteQueueStore() : new WebQueueStore()
    const queue = new ObservationQueue(store)
    const owner = `vc19-${kind}-${Date.now()}`
    queue.setOwnerUserId(owner)
    const evidence = await activityTransportEvidence(owner)
    await queue.recoverActivityCertificationTransport(evidence.slice(0, 2))
    const original = await queue.claimActivityCertificationObservationIds(ACTIVITY_RESUME_IDS.slice(0, 2), 'old-r4')
    const claim = (row: QueueRecord) => ({ queueId: row.queueId, batchId: row.batchId!, attemptCount: row.attemptCount })
    await queue.failClaims([claim(original[0])], { code: 'UNSUPPORTED_JCVITAL_METRIC', message: 'old backend' })
    await queue.retryClaims([claim(original[1])], { code: 'ACK_PROCESSING_FAILED', message: 'old backend' }, '2099-01-01T00:00:00Z')
    const before = await Promise.all(ACTIVITY_RESUME_IDS.slice(0, 2).map((id) => queue.getRecord(id)))
    expect(await queue.claimPending(100, 'background')).toEqual([])
    // Reproduces VC18: exact IDs + backoff bypass still cannot claim FAILED_PERMANENT.
    const vc18 = await queue.claimCertificationObservationIds([original[0].observationId], 'vc18', true)
    expect(vc18).toEqual([])
    expect(await queue.recoverActivityCertificationTransport(evidence)).toEqual({ found: 2, reconstructed: 15 })
    expect(await Promise.all(ACTIVITY_RESUME_IDS.slice(0, 2).map((id) => queue.getRecord(id)))).toEqual(before)
    expect(await queue.claimPending(100, 'background-again')).toEqual([])
    const claimed = await queue.claimActivityCertificationObservationIds(ACTIVITY_RESUME_IDS, 'vc19')
    expect(claimed.map((row) => row.observationId).sort()).toEqual([...ACTIVITY_RESUME_IDS].sort())
    for (const row of claimed) {
      const source = evidence.find((item) => item.observationId === row.observationId)!
      expect(JSON.stringify(row.payload)).toBe(source.payloadJson)
      expect(await queue.getPayloadJson(row.observationId)).toBe(source.payloadJson)
      expect(await transportFingerprint(JSON.stringify(row.payload))).toBe(source.payloadFingerprint)
      expect(row.sourceEnvelopeId).toBe(source.sourceEnvelopeId)
    }
    const reused = claimed.find((row) => row.observationId === original[0].observationId)!
    expect(reused.queueId).toBe(original[0].queueId)
    expect(reused.attemptCount).toBe(original[0].attemptCount + 1)
    expect(reused.createdAt).toBe(original[0].createdAt)
    await expect(queue.recoverActivityCertificationTransport(evidence)).rejects.toThrow('state=IN_FLIGHT')
    await expect(queue.claimActivityCertificationObservationIds([ACTIVITY_EXCLUDED_ID], 'forbidden')).rejects.toThrow('only approved')
    await expect(queue.recoverActivityCertificationTransport([{ ...evidence[0], observationId: ACTIVITY_EXCLUDED_ID }])).rejects.toThrow('only approved')
  })
  it.each(['SQLITE', 'INDEXEDDB'] as const)('%s fails payload/hash/provenance verification before restoring any row', async (kind) => {
    const queue = new ObservationQueue(kind === 'SQLITE' ? new NativeSQLiteQueueStore() : new WebQueueStore())
    queue.setOwnerUserId(`vc19-corrupt-${kind}-${Date.now()}`)
    const evidence = await activityTransportEvidence(queue.getOwnerUserId()!)
    await expect(queue.recoverActivityCertificationTransport([evidence[0], { ...evidence[1], payloadFingerprint: 'corrupt' }]))
      .rejects.toThrow('bytes/fingerprint/provenance differ')
    expect(await queue.getRecord(evidence[0].observationId)).toBeNull()
    await queue.recoverActivityCertificationTransport([evidence[0]])
    const modified = JSON.parse(evidence[0].payloadJson)
    modified.valueNumber = 999
    await expect(queue.recoverActivityCertificationTransport([{ ...evidence[0], payloadJson: JSON.stringify(modified),
      payloadFingerprint: await transportFingerprint(JSON.stringify(modified)) }])).rejects.toThrow('changed evidence')
    expect(await queue.getPayloadJson(evidence[0].observationId)).toBe(evidence[0].payloadJson)
  })
  it.each(['SQLITE', 'INDEXEDDB'] as const)('%s locally purges exact verified delivered rows, including FAILED_PERMANENT, only through Activity reconciliation', async (kind) => {
    const queue = new ObservationQueue(kind === 'SQLITE' ? new NativeSQLiteQueueStore() : new WebQueueStore())
    queue.setOwnerUserId(`vc20-local-finalize-${kind}-${Date.now()}`)
    const evidence = await activityTransportEvidence(queue.getOwnerUserId()!)
    await queue.recoverActivityCertificationTransport(evidence)
    const claims = await queue.claimActivityCertificationObservationIds(ACTIVITY_RESUME_IDS, 'old-failed-batch')
    expect(claims).toHaveLength(17)
    await queue.failClaims(claims.map((row) => ({
      queueId: row.queueId, batchId: row.batchId!, attemptCount: row.attemptCount,
    })), { code: 'ACK_PROCESSING_FAILED', message: 'saved production success needs local reconciliation' })
    expect((await queue.getRecord(ACTIVITY_RESUME_IDS[0]))?.state).toBe('FAILED_PERMANENT')
    await queue.purgeVerifiedDeliveredActivityTransport(evidence)
    expect(await Promise.all(ACTIVITY_RESUME_IDS.map((id) => queue.getRecord(id)))).toEqual(Array(17).fill(null))
  })
  it('local Activity reconciliation fails closed on changed payloads and live queue claims', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId(`vc20-local-finalize-blocked-${Date.now()}`)
    const evidence = await activityTransportEvidence(queue.getOwnerUserId()!)
    await queue.recoverActivityCertificationTransport(evidence)
    await expect(queue.purgeVerifiedDeliveredActivityTransport([
      evidence[0], { ...evidence[1], payloadFingerprint: 'changed' },
    ])).rejects.toThrow('bytes/fingerprint/provenance differ')
    expect(await queue.getRecord(evidence[0].observationId)).not.toBeNull()
    const claimed = await queue.claimActivityCertificationObservationIds([evidence[0].observationId], 'live')
    await expect(queue.purgeVerifiedDeliveredActivityTransport([evidence[0]])).rejects.toThrow('in flight')
    expect(claimed).toHaveLength(1)
  })

  it.each(['partial', 'revision', 'contract', 'canonical'] as const)(
    'real sender %s: gates before ACK and purges only evidence-confirmed successful IDs', async (mode) => {
      const storage = new Map<string, string>()
      Object.assign(globalThis, { localStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => { storage.set(key, value) },
        removeItem: (key: string) => { storage.delete(key) },
      } })
      observationQueue.setOwnerUserId(`vc19-sender-${mode}-${Date.now()}`)
      await observationQueue.initialize()
      const evidence = await activityTransportEvidence(observationQueue.getOwnerUserId()!)
      connectorIdentityService.setConnectorDeviceId('activity-backend-device')
      vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
      const receipts: BatchDeliveryEvent[] = []
      const upload = vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request, options) => {
        expect(request.observations.map((payload) => payload.observationId).sort()).toEqual([...ACTIVITY_RESUME_IDS].sort())
        expect(request.observations.some((payload) => payload.observationId === ACTIVITY_EXCLUDED_ID)).toBe(false)
        for (const payload of request.observations) {
          expect(JSON.stringify(payload)).toBe(evidence.find((item) => item.observationId === payload.observationId)!.payloadJson)
        }
        const response = {
          success: true, batchId: request.batchId, accepted: 16, duplicate: 0, rejected: 1,
          errors: [], serverTimestamp: new Date().toISOString(),
          canonical: { created: mode === 'canonical' ? 1 : 0, failed: 0 },
          results: request.observations.map((payload) => ({
            observationId: payload.observationId,
            status: payload.observationId === ACTIVITY_RESUME_IDS[0] ? 'rejected' as const : 'accepted' as const,
            nativeObservationId: payload.observationId === ACTIVITY_RESUME_IDS[1] ? null : `native-${payload.observationId}`,
            canonicalStatus: 'not_applicable' as const, canonicalTarget: null,
          })).filter((result) => result.observationId !== ACTIVITY_RESUME_IDS[2]),
        }
        options?.onResponseBody?.({ ...response, responseContractVersion: mode === 'contract' ? 'wrong' : ACTIVITY_RESPONSE_CONTRACT,
          deploymentRevision: mode === 'revision' ? 'wrong' : ACTIVITY_R5_REVISION })
        return response
      })
      const ack = vi.spyOn(observationQueue, 'acknowledgeClaims')
      const manager = new ObservationBatchManager({ concurrency: 1 }, { isOnline: () => true, subscribe: () => () => {} })
      const report = await manager.flushCertificationObservationIds(ACTIVITY_RESUME_IDS, {
        activityRecovery: true,
        prepare: async () => { await observationQueue.recoverActivityCertificationTransport(evidence) },
        validateResults: (event) => event.observationIds.filter((id) => {
          const result = event.results?.find((item) => item.observationId === id)
          return result?.status === 'accepted' && !!result.nativeObservationId && result.canonicalStatus === 'not_applicable'
        }),
        persistEvidence: async (event) => {
          if (!event.acknowledgedIds.length) {
            expect(ack).not.toHaveBeenCalled()
            expect((await observationQueue.getQueueStats()).inFlight).toBe(17)
          }
          receipts.push(structuredClone(event))
        },
      })
      expect(upload).toHaveBeenCalledOnce()
      if (mode === 'partial') {
        expect(receipts).toHaveLength(2)
        expect(ack.mock.calls[0][0]).toHaveLength(14)
        expect(report.events[0].acknowledgedIds).toHaveLength(14)
        expect(receipts[0].batchId).toBe(report.events[0].batchId)
        expect(receipts[0].completedAt).toBeTruthy()
        for (const id of ACTIVITY_RESUME_IDS.slice(0, 3)) expect((await observationQueue.getRecord(id))?.state).toBe('RETRY_WAIT')
        for (const id of ACTIVITY_RESUME_IDS.slice(3)) expect(await observationQueue.getRecord(id)).toBeNull()
        await manager.process()
        expect(upload).toHaveBeenCalledOnce()
      } else {
        expect(ack).not.toHaveBeenCalled()
        expect((await observationQueue.getQueueStats()).retrying).toBe(17)
        expect(report.events[0].errorCode).toBe('ACK_PROCESSING_FAILED')
      }
    })
})

describe('ObservationQueue on the Android SQLite path', () => {
  it('ordinary SQLite claims skip preserved Activity certification without blocking unrelated observations', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('vc18-automatic')
    const original = await physicalFixture('vc18-automatic')
    const activity = { ...original, observationId: 'saved-activity', vendorDataType: '24', metricType: 'DAILY_STEPS',
      rawSourceMetadata: { certificationOnly: true } }
    const excluded = { ...activity, observationId: 'saved-exercise', metricType: 'DAILY_EXERCISE_MINUTES' }
    await queue.enqueueMany([activity, excluded, original])
    const claimed = await queue.claimPending(100, 'ordinary')
    expect(claimed.map((row) => row.observationId)).toEqual([original.observationId])
    expect((await queue.getRecord(activity.observationId))?.state).toBe('PENDING')
    expect((await queue.getRecord(excluded.observationId))?.state).toBe('PENDING')
  })
  it('retries exact saved IDs through SQLite despite backoff and removes only preserved semantic-conflict rows', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('vc18-owner')
    const eligible = await physicalFixture('vc18-owner')
    const excluded = { ...eligible, observationId: 'excluded-activity' }
    const other = { ...eligible, observationId: 'unrelated' }
    await queue.enqueueMany([eligible, excluded, other])
    const claims = await queue.claimPending(100, 'first')
    await queue.retryClaims(claims.map((row) => ({ queueId: row.queueId, batchId: 'first', attemptCount: row.attemptCount })),
      { code: 'ACK_PROCESSING_FAILED', message: 'retry' }, new Date(Date.now() + 60_000).toISOString())
    expect(await queue.claimPending(100, 'automatic')).toEqual([])
    await expect(queue.removePreservedCertificationObservation(excluded.observationId, 'changed')).rejects.toThrow('payload changed')
    await queue.removePreservedCertificationObservation(excluded.observationId, JSON.stringify(excluded))
    expect(await queue.getRecord(excluded.observationId)).toBeNull()
    const resumed = await queue.claimCertificationObservationIds([eligible.observationId], 'resume', true)
    expect(resumed.map((row) => row.observationId)).toEqual([eligible.observationId])
    await expect(queue.removePreservedCertificationObservation(eligible.observationId, JSON.stringify(eligible))).rejects.toThrow('in flight')
    expect((await queue.getRecord(other.observationId))?.state).toBe('RETRY_WAIT')
  })
  it('initializes the SQLite store and reports its identity', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    await queue.initialize()
    expect(queue.getDiagnostics()).toMatchObject({
      queueStoreType: 'SQLITE', queueStoreInitialized: true, queueDatabaseName: 'elite_plus_connector',
      queueSchemaVersion: 8, queueInitializationError: null,
    })
  })

  it('enqueues one observation and reads it back', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const observation = await physicalFixture('user-1')
    const result = await queue.enqueue(observation)
    expect(result).toMatchObject({ inserted: true, alreadyQueued: false })
    const pending = await queue.getPending(100)
    expect(pending[0].payload.timestampSource).toBe('CONNECTOR_BLE_RECEIPT_TIME')
    expect(pending.map((record) => record.queueId)).toEqual([result.record.queueId])
    expect((await queue.getQueueStats()).pending).toBe(1)
    expect(await queue.enqueue(observation)).toMatchObject({ inserted: false, alreadyQueued: true })
  })

  it('reads pending composition and FIFO positions without mutating queue rows', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const base = await physicalFixture('user-1')
    const rows = [
      { ...base, observationId: 'old-heart-1', metric: 'heartRate', metricType: 'HEART_RATE', vendorDataType: '27' },
      { ...base, observationId: 'old-heart-2', metric: 'heartRate', metricType: 'HEART_RATE', vendorDataType: '27' },
      { ...base, observationId: 'v49-spo2', metric: 'oxygenSaturation', metricType: 'OXYGEN_SATURATION', vendorDataType: '68' },
      { ...base, observationId: 'v49-temp', metric: 'wearableTemperature', metricType: 'WEARABLE_TEMPERATURE', vendorDataType: '59' },
    ]
    const provenance = new Map(rows.slice(2).map((row, index) => [row.observationId, {
      syncId: 'v49-sync', acquisitionId: `acquisition-${index}`, acquisitionRequestId: `request-${index}`,
      requestedMetric: index === 0 ? 'oxygenSaturation' : 'wearableTemperature', connectionGeneration: 1,
      acquisitionStartedAt: '2026-10-16T10:00:00.000Z', acquisitionCompletedAt: '2026-10-16T10:00:01.000Z',
      clientQueuedAt: '2026-10-16T10:00:02.000Z',
    }]))
    await queue.enqueueMany(rows, undefined, provenance)
    const db = sqlite.databases.get('elite_plus_connector')!.db
    rows.forEach((row, index) => {
      db.prepare('UPDATE observation_queue SET created_at = ?, attempt_count = ? WHERE observation_id = ?')
        .run(`2026-10-16T0${index + 1}:00:00.000Z`, index, row.observationId)
    })
    const runCallsBeforeRead = sqlite.runCalls

    const composition = await queue.getPendingComposition('v49-sync')

    expect(composition).toMatchObject({
      totalPending: 4,
      distinctObservationIds: 4,
      duplicateObservationIdRows: 0,
      attemptCount: { zero: 1, one: 1, two: 1, threePlus: 1 },
      currentV49SyncPending: 2,
      currentV49FirstPosition: 3,
      currentV49LastPosition: 4,
      currentV49RowsAhead: 2,
      heartRateRowsAheadCurrentV49: 2,
      priorSyncPending: 2,
    })
    expect(composition.byVendorDataType).toContainEqual({ key: '27', count: 2 })
    expect(composition.byRequestedMetric).toContainEqual({ key: 'oxygenSaturation', count: 1 })
    expect(composition.oldestPendingAt).toBe('2026-10-16T01:00:00.000Z')
    expect(composition.newestPendingAt).toBe('2026-10-16T04:00:00.000Z')
    expect(sqlite.runCalls).toBe(runCallsBeforeRead)
    expect((await queue.getQueueStats()).pending).toBe(4)
  })

  it('summarizes 120,000 pending rows without mutations or changes to ordering, states, or IDs', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-120k')
    await queue.initialize()
    const db = sqlite.databases.get('elite_plus_connector')!.db
    const insert = db.prepare(`INSERT INTO observation_queue
      (queue_id, owner_user_id, observation_id, acquisition_provenance_json, payload_json, state, created_at, updated_at, attempt_count)
      VALUES (?, ?, ?, ?, ?, 'PENDING', ?, ?, ?);`)
    const metricFor = (index: number) => {
      const slot = index % 1000
      if (slot < 800) return { metric: 'heartRate', metricType: 'HEART_RATE', vendorDataType: '27', requestedMetric: 'heartRate' }
      if (slot < 900) return { metric: 'oxygenSaturation', metricType: 'OXYGEN_SATURATION', vendorDataType: '68', requestedMetric: 'oxygenSaturation' }
      if (slot < 950) return { metric: 'wearableTemperature', metricType: 'WEARABLE_TEMPERATURE', vendorDataType: '59', requestedMetric: 'wearableTemperature' }
      return { metric: 'activityVendorDAILY_STEPS', metricType: 'DAILY_STEPS', vendorDataType: '24', requestedMetric: 'activity' }
    }
    db.exec('BEGIN;')
    for (let index = 0; index < 120_000; index++) {
      const metric = metricFor(index)
      const timestamp = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString()
      const syncIndex = Math.floor(index / 30_000)
      const observationId = `synthetic-observation-${index.toString().padStart(6, '0')}`
      const payload = JSON.stringify({
        observationId, metric: metric.metric, metricType: metric.metricType, vendorDataType: metric.vendorDataType,
        observedAt: timestamp, startTime: timestamp, valueNumber: index, unit: 'count',
      })
      const provenance = JSON.stringify({
        syncId: `sync-${syncIndex}`, acquisitionId: `acquisition-${Math.floor(index / 7_500)}`,
        acquisitionRequestId: `request-${Math.floor(index / 7_500)}`, requestedMetric: metric.requestedMetric,
        connectionGeneration: syncIndex, acquisitionStartedAt: timestamp, acquisitionCompletedAt: timestamp,
        clientQueuedAt: timestamp,
      })
      insert.run(`synthetic-queue-${index.toString().padStart(6, '0')}`, 'user-120k', observationId,
        provenance, payload, timestamp, timestamp, index % 4)
    }
    db.exec('COMMIT;')

    const snapshot = () => {
      const digest = createHash('sha256')
      let rowCount = 0
      for (const row of db.prepare(`SELECT queue_id, observation_id, state, created_at, attempt_count
        FROM observation_queue WHERE owner_user_id = ? ORDER BY created_at, rowid;`).all('user-120k')) {
        digest.update(JSON.stringify(row))
        rowCount++
      }
      return { rowCount, sha256: digest.digest('hex') }
    }
    const before = snapshot()
    const runCallsBefore = sqlite.runCalls
    const executeSetCallsBefore = sqlite.executeSetCalls

    const composition = await queue.getPendingComposition('sync-0')

    expect(composition).toMatchObject({
      totalPending: 120_000,
      byMetric: expect.arrayContaining([
        { key: 'heartRate', count: 96_000 },
        { key: 'oxygenSaturation', count: 12_000 },
        { key: 'wearableTemperature', count: 6_000 },
        { key: 'activityVendorDAILY_STEPS', count: 6_000 },
      ]),
      bySyncId: expect.arrayContaining([
        { key: 'sync-0', count: 30_000 }, { key: 'sync-1', count: 30_000 },
        { key: 'sync-2', count: 30_000 }, { key: 'sync-3', count: 30_000 },
      ]),
      byAcquisitionId: expect.arrayContaining([{ key: 'acquisition-0', count: 7_500 }, { key: 'acquisition-15', count: 7_500 }]),
      byRequestedMetric: expect.arrayContaining([{ key: 'heartRate', count: 96_000 }, { key: 'oxygenSaturation', count: 12_000 }]),
      attemptCount: { zero: 30_000, one: 30_000, two: 30_000, threePlus: 30_000 },
      distinctObservationIds: 120_000,
      duplicateObservationIdRows: 0,
      currentV49SyncPending: 30_000,
      currentV49FirstPosition: 801,
      currentV49RowsAhead: 800,
      heartRateRowsAheadCurrentV49: 800,
      priorSyncPending: 90_000,
    })
    expect(composition.byVendorDataType).toContainEqual({ key: '27', count: 96_000 })
    expect(composition.byVendorDataType).toContainEqual({ key: '68', count: 12_000 })
    expect(composition.currentV49MetricPending).toEqual([
      { key: 'oxygenSaturation', count: 3_000 },
      { key: 'wearableTemperature', count: 1_500 },
    ])

    expect(sqlite.runCalls).toBe(runCallsBefore)
    expect(sqlite.executeSetCalls).toBe(executeSetCallsBefore)
    expect(snapshot()).toEqual(before)
  }, 120_000)

  it('keeps envelope associations local, owner-isolated and first-write-only across SQLite restart', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const payload = await physicalFixture('user-1')
    const first = await queue.enqueue(payload, 'envelope-first')
    expect((await queue.enqueue({ ...payload, valueNumber: 999 }, 'envelope-later')).record).toEqual(first.record)
    const legacy = { ...payload, observationId: 'legacy-unlinked' }
    const unlinked = await queue.enqueue(legacy)
    const [associated] = await queue.enqueueMany([legacy, legacy], new Map([[legacy.observationId, 'envelope-backfill']]))
    expect(associated.record).toEqual({ ...unlinked.record, sourceEnvelopeId: 'envelope-backfill' })
    expect((await queue.enqueue(legacy, 'envelope-ignored')).record).toEqual(associated.record)
    const bulk = { ...payload, observationId: 'bulk-linked' }
    expect((await queue.enqueueMany([bulk], new Map([[bulk.observationId, 'envelope-bulk']])))[0].record.sourceEnvelopeId).toBe('envelope-bulk')
    const singleLegacy = { ...payload, observationId: 'single-legacy' }
    const singleBefore = await queue.enqueue(singleLegacy)
    expect((await queue.enqueue(singleLegacy, 'envelope-single')).record).toEqual({ ...singleBefore.record, sourceEnvelopeId: 'envelope-single' })
    queue.setOwnerUserId('user-2')
    await queue.enqueue(payload, 'envelope-other-owner')

    const reopened = new ObservationQueue(new NativeSQLiteQueueStore())
    reopened.setOwnerUserId('user-1')
    expect(await reopened.getRecord(payload.observationId)).toEqual(first.record)
    const [claim] = await reopened.claimPending(1, 'linked-batch')
    expect(claim.sourceEnvelopeId).toBe('envelope-first')
    expect(claim.payload).toEqual(payload)
    expect(claim.payload).not.toHaveProperty('sourceEnvelopeId')
    const row = sqlite.databases.get('elite_plus_connector')!.db.prepare('SELECT source_envelope_id, payload_json FROM observation_queue WHERE queue_id = ?').all(first.record.queueId)[0]
    expect(row).toMatchObject({ source_envelope_id: 'envelope-first', payload_json: JSON.stringify(payload) })
    await reopened.acknowledgeClaims([{ queueId: claim.queueId, batchId: claim.batchId!, attemptCount: claim.attemptCount }])
    await reopened.purgeAcknowledged()
    reopened.setOwnerUserId('user-2')
    expect((await reopened.getRecord(payload.observationId))?.sourceEnvelopeId).toBe('envelope-other-owner')
  })

  it('adds nullable SQLite v6-v8 metadata without rewriting 10,000 v5 queue records', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const payload = await physicalFixture('user-1')
    await queue.enqueueMany(Array.from({ length: 10_000 }, (_, index) => ({ ...payload, observationId: `legacy-${index}` })))
    const db = sqlite.databases.get('elite_plus_connector')!.db
    db.exec(`
      UPDATE observation_queue SET state = CASE rowid % 5
        WHEN 0 THEN 'PENDING' WHEN 1 THEN 'IN_FLIGHT' WHEN 2 THEN 'RETRY_WAIT'
        WHEN 3 THEN 'ACKNOWLEDGED' ELSE 'FAILED_PERMANENT' END;
      ALTER TABLE observation_queue DROP COLUMN source_envelope_id;
      ALTER TABLE observation_queue DROP COLUMN acquisition_provenance_json;
      DELETE FROM schema_version WHERE version >= 6;
    `)
    const before = db.prepare('SELECT * FROM observation_queue ORDER BY rowid').all()
    const restarted = new ObservationQueue(new NativeSQLiteQueueStore())
    restarted.setOwnerUserId('user-1')
    await restarted.initialize()
    expect(restarted.getDiagnostics().queueSchemaVersion).toBe(8)
    const after = db.prepare('SELECT * FROM observation_queue ORDER BY rowid').all() as Array<Record<string, unknown>>
    expect(after).toHaveLength(10_000)
    expect(after.every((row) => row.source_envelope_id === null)).toBe(true)
    expect(after.map(({ source_envelope_id: _sourceEnvelopeId, acquisition_provenance_json: _provenance, ...row }) => row)).toEqual(before)
    expect((await restarted.getRecord('legacy-0'))?.sourceEnvelopeId).toBeUndefined()
  })

  it('preserves acquisition provenance through SQLite claim, retry, and store reopen', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-provenance')
    const payload = { ...(await physicalFixture('user-provenance')), observationId: 'provenance-row'.padStart(64, '0') }
    const provenance = {
      syncId: 'sync-1', acquisitionId: 'acq-1', acquisitionRequestId: 'request-1',
      requestedMetric: 'oxygenSaturation', connectionGeneration: 9,
      acquisitionStartedAt: '2026-10-15T12:00:00.000Z', acquisitionCompletedAt: null,
      clientQueuedAt: '2026-10-15T12:01:00.000Z',
    }
    const inserted = await queue.enqueue(payload, undefined, provenance)
    const [claimed] = await queue.claimPending(1, 'batch-1')
    expect(claimed.acquisitionProvenance).toEqual(provenance)
    expect(claimed.payload).not.toHaveProperty('acquisitionProvenance')
    await queue.retryClaims([{ queueId: claimed.queueId, batchId: 'batch-1', attemptCount: claimed.attemptCount }],
      { code: 'NETWORK_ERROR', message: 'offline' }, new Date(Date.now() + 1_000).toISOString())

    const reopened = new ObservationQueue(new NativeSQLiteQueueStore())
    reopened.setOwnerUserId('user-provenance')
    expect(await reopened.getRecord(payload.observationId)).toMatchObject({
      queueId: inserted.record.queueId, state: 'RETRY_WAIT', acquisitionProvenance: provenance, payload,
    })
  })

  it('migrates schema-v2 SQLite pending, in-flight, and acknowledged rows without data loss, then recovers stale work', async () => {
    const firstInstall = new ObservationQueue(new NativeSQLiteQueueStore())
    firstInstall.setOwnerUserId('user-1')
    const base = await physicalFixture('user-1')
    const observations = ['pending', 'inflight', 'acknowledged'].map((key) => ({ ...base, observationId: key.padStart(64, '0') }))
    const inserted = await firstInstall.enqueueMany(observations)

    const db = sqlite.databases.get('elite_plus_connector')!.db
    db.prepare("UPDATE observation_queue SET state = 'IN_FLIGHT', batch_id = 'prior-build-in-flight', attempt_count = 1 WHERE queue_id = ?").run(inserted[1].record.queueId)
    db.prepare("UPDATE observation_queue SET state = 'ACKNOWLEDGED', acknowledged_at = ? WHERE queue_id = ?").run(new Date().toISOString(), inserted[2].record.queueId)
    db.exec('ALTER TABLE observation_queue DROP COLUMN source_envelope_id; ALTER TABLE observation_queue DROP COLUMN acquisition_provenance_json; ALTER TABLE observation_queue DROP COLUMN canonical_failure_at; ALTER TABLE observation_queue DROP COLUMN native_observation_id; ALTER TABLE observation_queue DROP COLUMN claimed_at; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_at; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_observation_count; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_batch_id; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_required; DELETE FROM schema_version WHERE version >= 3;')

    const upgradedInstall = new ObservationQueue(new NativeSQLiteQueueStore())
    upgradedInstall.setOwnerUserId('user-1')
    await upgradedInstall.initialize()
    const retained = await Promise.all(observations.map((observation) => upgradedInstall.getRecord(observation.observationId)))
    expect(upgradedInstall.getDiagnostics().queueSchemaVersion).toBe(8)
    expect(retained).toEqual([
      expect.objectContaining({ observationId: observations[0].observationId, payload: observations[0], state: 'PENDING', claimedAt: null, attemptCount: 0, nativeObservationId: null, canonicalFailureAt: null }),
      expect.objectContaining({ observationId: observations[1].observationId, payload: observations[1], state: 'IN_FLIGHT', batchId: 'prior-build-in-flight', claimedAt: null, attemptCount: 1, nativeObservationId: null, canonicalFailureAt: null }),
      expect.objectContaining({ observationId: observations[2].observationId, payload: observations[2], state: 'ACKNOWLEDGED', claimedAt: null, attemptCount: 0, nativeObservationId: null, canonicalFailureAt: null }),
    ])
    expect((await upgradedInstall.getQueueStats()).acknowledged).toBe(1)
    expect(await upgradedInstall.releaseStaleInFlight(new Date(Date.now() + 1_000).toISOString())).toBe(1)
    expect(await upgradedInstall.getRecord(observations[1].observationId)).toMatchObject({
      observationId: observations[1].observationId,
      payload: observations[1],
      state: 'RETRY_WAIT',
      attemptCount: 1,
      batchId: 'prior-build-in-flight',
    })
    expect((await upgradedInstall.getQueueStats()).pending).toBe(1)
  })

  it('round-trips the physical JCVital HR observation shape without losing any field', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const observation = await physicalFixture('user-1')
    await queue.enqueue(observation)
    const [record] = await queue.getPending(100)
    expect(record.payload).toEqual(observation)
    expect(record.payload).toMatchObject({
      source: 'jcvital_native', metricType: 'HEART_RATE', deviceId: physicalContext.deviceId,
      observedAtSource: 'CONNECTOR_BLE_RECEIPT_TIME', rawSourceMetadata: { vendorDataType: '82', vendorTimestamp: null },
    })
    expect(record.payload.sourceRecordId).toContain(physicalContext.deviceId)
  })

  it('self-tests under an isolated owner, leaving nothing to upload', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const result = await queue.selfTest(await physicalFixture('user-1'))
    expect(result).toMatchObject({ enqueueResult: { inserted: true }, readBack: true, readBackPayloadMatches: true, pendingCount: 1, removed: true })
    expect(result.recordId).toMatch(/^[0-9a-f-]{36}$/)
    expect((await queue.getQueueStats()).pending).toBe(0)
  })

  it('records the initialization failure cause and recovers lazily once the store is available', async () => {
    sqlite.failCreateConnection = 'CreateConnection: simulated plugin failure'
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    await expect(queue.initialize()).rejects.toMatchObject({ code: 'QUEUE_INIT_FAILED' })
    expect(queue.getDiagnostics()).toMatchObject({ queueStoreInitialized: false, queueInitializationError: 'CreateConnection: simulated plugin failure' })

    sqlite.failCreateConnection = null
    await expect(queue.enqueue(await physicalFixture('user-1'))).resolves.toMatchObject({ inserted: true })
    expect(queue.getDiagnostics()).toMatchObject({ queueStoreInitialized: true, queueInitializationError: null })
  })

  it('reuses an existing native connection after a partially failed initialization', async () => {
    sqlite.failOpenOnce = true
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    await expect(queue.initialize()).rejects.toBeInstanceOf(QueueStoreError)
    await expect(queue.initialize()).resolves.toBeUndefined()
    expect(queue.getDiagnostics().queueStoreInitialized).toBe(true)
  })

  it('rejects use without an owner with a coded error', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    await expect(queue.enqueue(await physicalFixture('user-1'))).rejects.toMatchObject({ code: 'QUEUE_OWNER_MISSING' })
  })

  it('bulk-enqueues 1,300 observations in one transaction per 250-row chunk, idempotently and in FIFO order', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const base = await physicalFixture('user-1')
    const observations = Array.from({ length: 1_300 }, (_, index) => ({ ...base, observationId: index.toString(16).padStart(64, '0'), packetSequence: index }))

    const first = await queue.enqueueMany(observations)
    expect(first.every((result) => result.inserted)).toBe(true)
    expect(sqlite.executeSetCalls).toBe(Math.ceil(1_300 / 250))
    expect(sqlite.runCalls).toBe(0)

    const second = await queue.enqueueMany(observations)
    expect(second.every((result) => result.alreadyQueued && !result.inserted)).toBe(true)
    expect(second.map((result) => result.record.observationId)).toEqual(observations.map((observation) => observation.observationId))
    expect(sqlite.executeSetCalls).toBe(Math.ceil(1_300 / 250))

    const pending = await queue.getPending(100)
    expect(pending.map((record) => record.payload.packetSequence)).toEqual(Array.from({ length: 100 }, (_, index) => index))
    expect(pending[0].payload).toEqual(observations[0])
    expect(await queue.getQueueStats()).toMatchObject({ pending: 1_300, retrying: 0, failed: 0, inFlight: 0, acknowledged: 0 })
  })

  it('atomically claims disjoint 100-row slices from a 37,230-row queue with bounded claim results', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const base = await physicalFixture('user-1')
    const observations = Array.from({ length: 37_230 }, (_, index) => ({
      ...base,
      observationId: index.toString(16).padStart(64, '0'),
      packetSequence: index,
    }))
    await queue.enqueueMany(observations)

    const [first, second] = await Promise.all([
      queue.claimPending(100, 'scale-claim-1'),
      queue.claimPending(100, 'scale-claim-2'),
    ])
    expect(first).toHaveLength(100)
    expect(second).toHaveLength(100)
    const firstIds = new Set(first.map((record) => record.observationId))
    expect(second.every((record) => !firstIds.has(record.observationId))).toBe(true)
    expect(first.every((record) => record.state === 'IN_FLIGHT' && record.batchId === 'scale-claim-1' && record.attemptCount === 1 && record.claimedAt !== null)).toBe(true)
    expect(second.every((record) => record.state === 'IN_FLIGHT' && record.batchId === 'scale-claim-2' && record.attemptCount === 1 && record.claimedAt !== null)).toBe(true)
    expect(await queue.getQueueStats()).toMatchObject({ pending: 37_030, inFlight: 200, acknowledged: 0 })
  }, 60_000)

  it('computes queue stats and pending selection in SQL with the original semantics', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('user-1')
    const base = await physicalFixture('user-1')
    const results = await queue.enqueueMany(Array.from({ length: 5 }, (_, index) => ({ ...base, observationId: `${index}`.padStart(64, 'a'), packetSequence: index })))
    const ids = results.map((result) => result.record.queueId)
    const inFlight = await queue.claimPending(1, 'batch-1')
    const retry = await queue.claimPending(1, 'batch-2')
    const failure = await queue.claimPending(1, 'batch-3')
    const acknowledged = await queue.claimPending(1, 'batch-4')
    await queue.retryClaims(retry.map((record) => ({ queueId: record.queueId, batchId: record.batchId!, attemptCount: record.attemptCount })), { code: 'TIMEOUT', message: 't' }, new Date(Date.now() + 60_000).toISOString())
    await queue.failClaims(failure.map((record) => ({ queueId: record.queueId, batchId: record.batchId!, attemptCount: record.attemptCount })), { code: 'VALIDATION_ERROR', message: 'v' })
    await queue.acknowledgeClaims(acknowledged.map((record) => ({ queueId: record.queueId, batchId: record.batchId!, attemptCount: record.attemptCount })))

    const stats = await queue.getQueueStats()
    expect(stats).toMatchObject({ pending: 1, inFlight: 1, retrying: 1, failed: 1, acknowledged: 1 })
    expect(stats.oldestPendingAgeMs).toBeGreaterThanOrEqual(0)
    expect(stats.lastAttemptAt).not.toBeNull()
    expect(stats.lastSuccessfulUploadAt).not.toBeNull()
    expect(inFlight.map((record) => record.queueId)).toEqual([ids[0]])
    expect((await queue.getPending(100)).map((record) => record.queueId)).toEqual([ids[4]])
  })
})

describe('certification-only targeted sender on real Android SQLite SQL', () => {
  let queue: ObservationQueue
  let manager: ObservationBatchManager
  let diagnostic: SpO2Certification
  let networkOnline: boolean
  const storageValues = new Map<string, string>()
  const storage = { getItem: (key: string) => storageValues.get(key) ?? null, setItem: (key: string, value: string) => { storageValues.set(key, value) }, removeItem: (key: string) => { storageValues.delete(key) } }

  beforeEach(async () => {
    storageValues.clear()
    Object.assign(globalThis, { localStorage: storage })
    queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('certification-owner')
    await queue.initialize()
    vi.spyOn(observationQueue, 'getOwnerUserId').mockImplementation(() => queue.getOwnerUserId())
    vi.spyOn(observationQueue, 'getDiagnostics').mockImplementation(() => queue.getDiagnostics())
    vi.spyOn(observationQueue, 'getQueueStats').mockImplementation(() => queue.getQueueStats())
    vi.spyOn(observationQueue, 'getCanonicalRecoveryBatches').mockImplementation((limit) => queue.getCanonicalRecoveryBatches(limit))
    vi.spyOn(observationQueue, 'releaseStaleInFlight').mockImplementation((time) => queue.releaseStaleInFlight(time))
    vi.spyOn(observationQueue, 'getPending').mockImplementation((limit) => queue.getPending(limit))
    vi.spyOn(observationQueue, 'getNextRetryAt').mockImplementation(() => queue.getNextRetryAt())
    vi.spyOn(observationQueue, 'claimPending').mockImplementation((limit, batch) => queue.claimPending(limit, batch))
    vi.spyOn(observationQueue, 'claimCertificationObservationIds').mockImplementation((ids, batch) => queue.claimCertificationObservationIds(ids, batch))
    vi.spyOn(observationQueue, 'acknowledgeClaims').mockImplementation((claims) => queue.acknowledgeClaims(claims))
    vi.spyOn(observationQueue, 'purgeAcknowledged').mockImplementation((ids) => queue.purgeAcknowledged(ids))
    vi.spyOn(observationQueue, 'markCanonicalRecoveryRequired').mockImplementation((claims, error) => queue.markCanonicalRecoveryRequired(claims, error))
    vi.spyOn(observationQueue, 'recordCanonicalRecoveryPause').mockImplementation((batch, count, at) => queue.recordCanonicalRecoveryPause(batch, count, at))
    vi.spyOn(observationQueue, 'failClaims').mockImplementation((claims, error) => queue.failClaims(claims, error))
    vi.spyOn(observationQueue, 'retryClaims').mockImplementation((claims, error, at) => queue.retryClaims(claims, error, at))
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    connectorIdentityService.setConnectorDeviceId('registered-connector')
    networkOnline = true
    manager = new ObservationBatchManager({}, { isOnline: () => networkOnline, subscribe: () => () => undefined })
    diagnostic = new SpO2Certification({ queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options), storage: () => storage })
  })
  afterEach(() => { manager.stop(); vi.restoreAllMocks() })

  async function seed(hrCount = 10_112) {
    const base = await physicalFixture('certification-owner')
    await queue.enqueueMany(Array.from({ length: hrCount }, (_, index) => ({
      ...base, observationId: index.toString(16).padStart(64, '0'), metric: 'heartRate', vendorDataType: '27',
    })))
    const spo2 = PRIOR_SPO2_CERTIFICATION_IDS.map((observationId) => ({
      ...base, observationId, metric: 'oxygenSaturation', metricType: 'SPO2', valueNumber: 97, unit: 'percent', vendorDataType: '68', sourceRecordId: `spo2-${observationId}`,
    }))
    await queue.enqueueMany(spo2)
    return spo2
  }

  function hrSnapshot() {
    return sqlite.databases.get('elite_plus_connector')!.db.prepare(
      "SELECT rowid, * FROM observation_queue WHERE owner_user_id = ? AND json_extract(payload_json, '$.vendorDataType') = '27' ORDER BY created_at, rowid",
    ).all('certification-owner')
  }

  function accept() {
    return vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, serverTimestamp: new Date().toISOString(),
      accepted: request.observations.length, duplicate: 0, rejected: 0, errors: [],
      results: request.observations.map((row) => ({
        observationId: row.observationId, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: `native-${row.observationId}`,
      })),
    }))
  }

  it('inspects all five IDs without capture, claims, sending or queue mutation', async () => {
    await seed()
    const before = hrSnapshot()
    const send = accept()
    expect((await diagnostic.inspect()).map((item) => item.status)).toEqual(Array(5).fill('FOUND_PENDING'))
    expect(send).not.toHaveBeenCalled()
    expect(observationQueue.claimPending).not.toHaveBeenCalled()
    expect(observationQueue.claimCertificationObservationIds).not.toHaveBeenCalled()
    expect(hrSnapshot()).toEqual(before)
  })

  it('delivers five exact SpO2 rows ahead of 10,112 HR rows with the complete HR snapshot unchanged', async () => {
    const spo2 = await seed()
    await queue.enqueueMany(spo2, new Map(spo2.map((row, index) => [row.observationId, `local-envelope-${index}`])))
    expect((await queue.getRecord(spo2[0].observationId))?.sourceEnvelopeId).toBe('local-envelope-0')
    const db = sqlite.databases.get('elite_plus_connector')!.db
    db.prepare("UPDATE observation_queue SET state = 'ACKNOWLEDGED' WHERE observation_id = ?").run('0'.repeat(64))
    const before = hrSnapshot()
    const send = accept()
    await diagnostic.inspect()
    const report = await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)
    expect(report.reason).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].observations).toEqual(spo2)
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain('sourceEnvelopeId')
    expect(JSON.stringify(send.mock.calls[0][0])).not.toContain('local-envelope-')
    expect(hrSnapshot()).toEqual(before)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })
    expect(diagnostic.snapshot().samples.every((sample) => sample.deliveryState === 'DELIVERED_CANONICALIZED'
      && sample.deliveryResult?.result?.observationId === sample.observationId)).toBe(true)
    expect(diagnostic.snapshot().inspection.every((item) => item.status === 'ACKNOWLEDGED_EVIDENCE')).toBe(true)
    expect(await queue.getQueueStats()).toMatchObject({ canonicalRecoveryRequired: false, failed: 0, inFlight: 0 })
  })

  it('waits for an active 100-row HR batch, blocks new normal claims, then sends only the five IDs', async () => {
    await seed()
    const before = hrSnapshot()
    let finishHr: (() => void) | undefined
    const held = new Promise<void>((resolve) => { finishHr = resolve })
    const send = accept()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (request, options) => {
      if (request.observations[0].vendorDataType === '27') await held
      return original(request, options)
    })
    const hr = manager.process()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const stages: string[] = []
    const pending = diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS, (stage) => { stages.push(stage) })
    await vi.waitFor(() => expect(stages).toContain('Waiting for active batch'))
    expect(await manager.process()).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    finishHr!()
    await hr
    await pending
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([request]) => request.observations.length)).toEqual([100, 5])
    expect(hrSnapshot()).toEqual(before.slice(100))
    expect(stages).toContain('Sending certification rows')
    await manager.process()
    expect(send.mock.calls[2][0].observations[0].vendorDataType).toBe('27')
  })

  it('resumes the started ordinary worker after a targeted flush', async () => {
    await seed(300)
    networkOnline = false
    await manager.start()
    networkOnline = true
    const send = accept()
    await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)
    await vi.waitFor(() => expect(send.mock.calls.some(([request]) => request.observations[0].vendorDataType === '27')).toBe(true))
    expect(send.mock.calls[0][0].observations.map((row) => row.observationId)).toEqual([...PRIOR_SPO2_CERTIFICATION_IDS])
    manager.pause()
    await vi.waitFor(() => expect(manager.getDeliveryDiagnostics().activeWorkerCount).toBe(0))
  })

  it('holds the ordinary claim barrier while certification preparation is pending', async () => {
    await seed(300)
    const before = hrSnapshot()
    const send = accept()
    let release!: () => void
    const waiting = new Promise<void>((resolve) => { release = resolve })
    const prepare = vi.fn(async () => { await waiting })
    const pending = manager.flushCertificationObservationIds(PRIOR_SPO2_CERTIFICATION_IDS, { prepare })
    try {
      await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1))
      expect(await manager.process()).toBeNull()
      expect(send).not.toHaveBeenCalled()
      expect(hrSnapshot()).toEqual(before)
    } finally { release() }
    await pending
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].observations.map((row) => row.observationId)).toEqual([...PRIOR_SPO2_CERTIFICATION_IDS])
    expect(hrSnapshot()).toEqual(before)
  })

  it('releases the ordinary claim barrier if certification preparation fails', async () => {
    await seed(300)
    const send = accept()
    await expect(manager.flushCertificationObservationIds(PRIOR_SPO2_CERTIFICATION_IDS, {
      prepare: async () => { throw new Error('Certification evidence storage unavailable') },
    })).rejects.toThrow('Certification evidence storage unavailable')
    expect(send).not.toHaveBeenCalled()
    await manager.process()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].observations).toHaveLength(100)
    expect(send.mock.calls[0][0].observations.every((row) => row.vendorDataType === '27')).toBe(true)
  })

  it('reports acknowledged and missing IDs without fabricating delivery or sending them', async () => {
    await seed(1)
    const db = sqlite.databases.get('elite_plus_connector')!.db
    db.prepare("UPDATE observation_queue SET state = 'ACKNOWLEDGED' WHERE observation_id = ?").run(PRIOR_SPO2_CERTIFICATION_IDS[0])
    db.prepare('DELETE FROM observation_queue WHERE observation_id = ?').run(PRIOR_SPO2_CERTIFICATION_IDS[1])
    const send = accept()
    const inspection = await diagnostic.inspect()
    expect(inspection.map((item) => item.status)).toEqual(['ACKNOWLEDGED_EVIDENCE', 'NOT_FOUND', 'FOUND_PENDING', 'FOUND_PENDING', 'FOUND_PENDING'])
    await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)
    expect(send.mock.calls[0][0].observations.map((row) => row.observationId)).toEqual(PRIOR_SPO2_CERTIFICATION_IDS.slice(2))
    expect((await diagnostic.inspect())[1].status).toBe('NOT_FOUND')
  })

  it('preserves canonical failure protection and never resumes ordinary claims after recovery is required', async () => {
    await seed(300)
    const before = hrSnapshot()
    const send = accept()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (request, options) => {
      const response = await original(request, options)
      return { ...response, results: response.results?.map((result) => ({ ...result, canonicalStatus: 'failed' })) }
    })

    await diagnostic.inspect()
    const report = await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)
    expect(report.reason).toBe('CANONICAL_RECOVERY_REQUIRED')
    expect(diagnostic.snapshot().inspection.every((item) => item.status === 'RECOVERY_REQUIRED')).toBe(true)
    expect(diagnostic.snapshot().samples.every((sample) => sample.deliveryState === 'CANONICAL_FAILED')).toBe(true)
    expect(hrSnapshot()).toEqual(before)
    expect(await manager.process()).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('keeps canonical recovery paused even if diagnostic persistence fails after the response', async () => {
    await seed(1)
    const send = accept()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (request, options) => {
      const response = await original(request, options)
      return { ...response, results: response.results?.map((result) => ({ ...result, canonicalStatus: 'failed' })) }
    })
    const report = await manager.flushCertificationObservationIds(PRIOR_SPO2_CERTIFICATION_IDS, {
      persistEvidence: () => { throw new Error('Diagnostic storage full') },
    })
    expect(report.reason).toBe('CANONICAL_RECOVERY_REQUIRED')
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ queuePausedForCanonicalFailure: true, effectiveConcurrency: 1 })
    expect(await queue.getQueueStats()).toMatchObject({ canonicalRecoveryObservationCount: 5 })
    expect(await manager.process()).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('awaits asynchronous certification snapshot persistence before ACK/purge and retains the exact receipt', async () => {
    await seed(1)
    accept()
    let release!: () => void
    let saving = false
    const held = new Promise<void>((resolve) => { release = resolve })
    const savedEvents: BatchDeliveryEvent[] = []
    const pending = manager.flushCertificationObservationIds(PRIOR_SPO2_CERTIFICATION_IDS, {
      persistEvidence: async (event) => {
        if (!event.acknowledgedIds.length) { saving = true; await held }
        savedEvents.push(structuredClone(event))
      },
    })
    await vi.waitFor(() => expect(saving).toBe(true))
    expect(observationQueue.acknowledgeClaims).not.toHaveBeenCalled()
    expect(observationQueue.purgeAcknowledged).not.toHaveBeenCalled()
    release()
    await pending
    expect(savedEvents).toHaveLength(2)
    expect(savedEvents[0].acknowledgedIds).toEqual([])
    expect(savedEvents[1].acknowledgedIds).toEqual([...PRIOR_SPO2_CERTIFICATION_IDS])
    expect(savedEvents[0].results?.every((result) => result.nativeObservationId)).toBe(true)
    expect(observationQueue.purgeAcknowledged).toHaveBeenCalledWith([...PRIOR_SPO2_CERTIFICATION_IDS])
  })

  it('async certification storage rejection prevents ACK/purge and keeps rows for idempotent delivery', async () => {
    await seed(1)
    accept()
    await manager.flushCertificationObservationIds(PRIOR_SPO2_CERTIFICATION_IDS, {
      persistEvidence: async () => { throw new Error('Native snapshot write failed') },
    })
    expect(observationQueue.acknowledgeClaims).not.toHaveBeenCalled()
    expect(observationQueue.purgeAcknowledged).not.toHaveBeenCalled()
    for (const id of PRIOR_SPO2_CERTIFICATION_IDS) {
      expect((await queue.getRecord(id))?.lastErrorCode).toBe('ACK_PROCESSING_FAILED')
    }
  })

  it('rejects overlapping flushes and invalid IDs without releasing an active barrier', async () => {
    await seed(1)
    let finish: (() => void) | undefined
    const held = new Promise<void>((resolve) => { finish = resolve })
    const send = accept()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (request, options) => { await held; return original(request, options) })
    const pending = manager.flushCertificationObservationIds(PRIOR_SPO2_CERTIFICATION_IDS)
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    await expect(manager.flushCertificationObservationIds(PRIOR_SPO2_CERTIFICATION_IDS)).rejects.toThrow('already active')
    await expect(manager.flushCertificationObservationIds(['bad-id'])).rejects.toThrow('SHA-256')
    expect(await manager.process()).toBeNull()
    finish!()
    await pending
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('restores diagnostic metadata and queued rows across a restart before targeted flush', async () => {
    await seed(100)
    await diagnostic.inspect()
    queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('certification-owner')
    await queue.initialize()
    manager = new ObservationBatchManager({}, { isOnline: () => true, subscribe: () => () => undefined })
    const restarted = new SpO2Certification({ queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options), storage: () => storage })
    expect(restarted.snapshot().samples).toHaveLength(5)
    expect((await restarted.inspect()).every((item) => item.status === 'FOUND_PENDING')).toBe(true)
    const send = accept()
    await restarted.flush(PRIOR_SPO2_CERTIFICATION_IDS)
    expect(send).toHaveBeenCalledTimes(1)
    const reopened = new SpO2Certification({ queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options), storage: () => storage })
    expect(reopened.snapshot().samples.every((sample) => sample.deliveryResult?.result?.canonicalStatus === 'canonicalized')).toBe(true)
    const context = { deviceId: null, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }
    const exported = await buildCertificationValidationExport({ deviceInfo: null, historicalRuns: {} }, {
      ownerUserId: queue.getOwnerUserId(), physiologyContext: context, workoutContext: context,
      persistedSpo2Samples: reopened.snapshot().samples, spo2QueueInspection: reopened.snapshot().inspection,
      readQueueRecord: (id) => queue.getRecord(id),
    })
    const json = JSON.parse(serializeCertificationValidationExport(exported))
    expect(json.jcvitalCertification.spo2.sampleObservations).toHaveLength(5)
    expect(json.jcvitalCertification.handoff.find((item: { METRIC: string }) => item.METRIC === 'spo2').samples[0]).toMatchObject({
      OBSERVATION_ID: PRIOR_SPO2_CERTIFICATION_IDS[0], SOURCE_RECORD_ID: `spo2-${PRIOR_SPO2_CERTIFICATION_IDS[0]}`,
      VALUE: 97, UNIT: 'percent', VENDOR_TYPE: '68', CANONICAL_TARGET: 'body.oxygen_saturation',
      DELIVERY_STATE: 'DELIVERED_CANONICALIZED', NATIVE_OBSERVATION_ID: `native-${PRIOR_SPO2_CERTIFICATION_IDS[0]}`,
      QUEUE_DISPOSITION: 'ACKNOWLEDGED_PURGED',
    })
    expect(json.jcvitalCertification.baseline.deploymentRevision).toBe('nc-observations-5b1-results-2026-10-03-r4')
    queue.setOwnerUserId('another-owner')
    expect(reopened.snapshot()).toEqual({ samples: [], inspection: [] })
  })

  it('does not overwrite an ordinary-worker exact result arriving between inspection reads', async () => {
    await seed(1)
    const getRecord = queue.getRecord.bind(queue)
    vi.spyOn(queue, 'getRecord').mockImplementation(async (id) => {
      if (id === PRIOR_SPO2_CERTIFICATION_IDS[1]) {
        const deliveredId = PRIOR_SPO2_CERTIFICATION_IDS[0]
        diagnostic.record({
          batchId: 'ordinary-batch', attemptedAt: new Date().toISOString(), outcome: 'DELIVERED',
          observationIds: [deliveredId], acknowledgedIds: [deliveredId], rejectedIds: [],
          httpStatus: 200, errorCode: null, accepted: 1, duplicate: 0, rejected: 0,
          results: [{ observationId: deliveredId, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: 'actual-native-id' }],
        })
      }
      return getRecord(id)
    })
    await diagnostic.inspect()
    const sample = diagnostic.snapshot().samples.find((item) => item.observationId === PRIOR_SPO2_CERTIFICATION_IDS[0])
    expect(sample?.deliveryResult?.acknowledged).toBe(true)
    expect(sample?.nativeObservationId).toBe('actual-native-id')
    expect(sample?.deliveryResult?.result?.canonicalStatus).toBe('canonicalized')
  })

  it('reports all five missing without capture/sending and preserves storage failures explicitly', async () => {
    const send = accept()
    expect((await diagnostic.inspect()).map((item) => item.status)).toEqual(Array(5).fill('NOT_FOUND'))
    expect(send).not.toHaveBeenCalled()
    const unavailable = new SpO2Certification({
      queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options),
      storage: () => ({ getItem: () => null, setItem: () => { throw new Error('Diagnostic storage full') } }),
    })
    await expect(unavailable.inspect()).rejects.toThrow('Diagnostic storage full')
    expect(send).not.toHaveBeenCalled()
  })

  it('rejects a different metric with the supplied ID rather than targeted-flushing HR', async () => {
    const base = await physicalFixture('certification-owner')
    await queue.enqueue({ ...base, observationId: PRIOR_SPO2_CERTIFICATION_IDS[0], metric: 'heartRate', vendorDataType: '27' })
    const send = accept()
    await expect(diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)).rejects.toThrow('type-68 SpO2')
    expect(send).not.toHaveBeenCalled()
  })

  it('releases the ordinary claim barrier after offline/paused targeted delivery', async () => {
    await seed(1)
    networkOnline = false
    expect((await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)).reason).toContain('No eligible')
    networkOnline = true
    const send = accept()
    manager.pause()
    expect((await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)).reason).toBe('DELIVERY_PAUSED')
    manager.resume()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    expect(send.mock.calls[0][0].observations[0].vendorDataType).toBe('27')
    await vi.waitFor(() => expect(manager.getDeliveryDiagnostics().activeWorkerCount).toBe(0))
  })

  it.each([null, 'existing-native-id'])('preserves duplicate native IDs only when returned (%s)', async (nativeObservationId) => {
    await seed(1)
    vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, serverTimestamp: new Date().toISOString(), accepted: 0,
      duplicate: request.observations.length, rejected: 0, errors: [],
      results: request.observations.map((row) => ({ observationId: row.observationId, status: 'duplicate', canonicalStatus: null, nativeObservationId })),
    }))
    await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)
    expect(diagnostic.snapshot().samples.every((sample) => sample.deliveryState === 'DELIVERED_DUPLICATE' && sample.nativeObservationId === nativeObservationId)).toBe(true)
  })

  it('leaves future retries and sending rows untouched and reports their exact states', async () => {
    await seed(1)
    const db = sqlite.databases.get('elite_plus_connector')!.db
    db.prepare("UPDATE observation_queue SET state = 'RETRY_WAIT', next_attempt_at = ? WHERE observation_id = ?")
      .run(new Date(Date.now() + 60_000).toISOString(), PRIOR_SPO2_CERTIFICATION_IDS[0])
    db.prepare("UPDATE observation_queue SET state = 'IN_FLIGHT', batch_id = 'previous-launch' WHERE observation_id = ?").run(PRIOR_SPO2_CERTIFICATION_IDS[1])
    const rows = await Promise.all(PRIOR_SPO2_CERTIFICATION_IDS.slice(0, 2).map((id) => queue.getRecord(id)))
    const send = accept()
    const inspection = await diagnostic.inspect()
    expect(inspection[0].status).toBe('FOUND_RETRYING')
    expect(inspection[1].status).toBe('FOUND_SENDING')
    await diagnostic.flush(PRIOR_SPO2_CERTIFICATION_IDS)
    expect(send.mock.calls[0][0].observations).toHaveLength(3)
    expect(await Promise.all(PRIOR_SPO2_CERTIFICATION_IDS.slice(0, 2).map((id) => queue.getRecord(id)))).toEqual(rows)
  })
})

/** First physical attempt for type-59 wearable temperature: synthetic test-only IDs, since no prior run exists to recover. */
const TEST_TEMPERATURE_IDS = [
  'e1687584c20b3005dd1eeb4f3ef08760929d520aa34e92359521caac79e96441',
  'e4ba4557d53033904d374c00fead3e0beab4708ffe794c9825cd39486b6ae0a1',
  'b1c605b16fba5a903feb633e44ac4f150e2dd25e15264392f9e928c59d61cfc4',
  '522347047918a6520067576e17b30c4739e00d30297addc15c17eff76f75e89d',
  'f8c3f138487470c1d2fabb3213eefb6bf9430488fe4c331d08e9232cfec016b4',
] as const

describe('wearable temperature certification-only targeted sender on real Android SQLite SQL', () => {
  let queue: ObservationQueue
  let manager: ObservationBatchManager
  let diagnostic: TemperatureCertification
  let networkOnline: boolean
  const storageValues = new Map<string, string>()
  const storage = { getItem: (key: string) => storageValues.get(key) ?? null, setItem: (key: string, value: string) => { storageValues.set(key, value) }, removeItem: (key: string) => { storageValues.delete(key) } }

  beforeEach(async () => {
    storageValues.clear()
    Object.assign(globalThis, { localStorage: storage })
    queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('certification-owner')
    await queue.initialize()
    vi.spyOn(observationQueue, 'getOwnerUserId').mockImplementation(() => queue.getOwnerUserId())
    vi.spyOn(observationQueue, 'getDiagnostics').mockImplementation(() => queue.getDiagnostics())
    vi.spyOn(observationQueue, 'getQueueStats').mockImplementation(() => queue.getQueueStats())
    vi.spyOn(observationQueue, 'getCanonicalRecoveryBatches').mockImplementation((limit) => queue.getCanonicalRecoveryBatches(limit))
    vi.spyOn(observationQueue, 'releaseStaleInFlight').mockImplementation((time) => queue.releaseStaleInFlight(time))
    vi.spyOn(observationQueue, 'getPending').mockImplementation((limit) => queue.getPending(limit))
    vi.spyOn(observationQueue, 'getNextRetryAt').mockImplementation(() => queue.getNextRetryAt())
    vi.spyOn(observationQueue, 'claimPending').mockImplementation((limit, batch) => queue.claimPending(limit, batch))
    vi.spyOn(observationQueue, 'claimCertificationObservationIds').mockImplementation((ids, batch) => queue.claimCertificationObservationIds(ids, batch))
    vi.spyOn(observationQueue, 'acknowledgeClaims').mockImplementation((claims) => queue.acknowledgeClaims(claims))
    vi.spyOn(observationQueue, 'purgeAcknowledged').mockImplementation((ids) => queue.purgeAcknowledged(ids))
    vi.spyOn(observationQueue, 'markCanonicalRecoveryRequired').mockImplementation((claims, error) => queue.markCanonicalRecoveryRequired(claims, error))
    vi.spyOn(observationQueue, 'recordCanonicalRecoveryPause').mockImplementation((batch, count, at) => queue.recordCanonicalRecoveryPause(batch, count, at))
    vi.spyOn(observationQueue, 'failClaims').mockImplementation((claims, error) => queue.failClaims(claims, error))
    vi.spyOn(observationQueue, 'retryClaims').mockImplementation((claims, error, at) => queue.retryClaims(claims, error, at))
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    connectorIdentityService.setConnectorDeviceId('registered-connector')
    networkOnline = true
    manager = new ObservationBatchManager({}, { isOnline: () => networkOnline, subscribe: () => () => undefined })
    diagnostic = new TemperatureCertification({ queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options), storage: () => storage })
  })
  afterEach(() => { manager.stop(); vi.restoreAllMocks() })

  async function seed(hrCount = 10_112) {
    const base = await physicalFixture('certification-owner')
    await queue.enqueueMany(Array.from({ length: hrCount }, (_, index) => ({
      ...base, observationId: index.toString(16).padStart(64, '0'), metric: 'heartRate', vendorDataType: '27',
    })))
    const temperature = TEST_TEMPERATURE_IDS.map((observationId) => ({
      ...base, observationId, metric: 'wearableTemperature', metricType: 'WEARABLE_TEMPERATURE', valueNumber: 33.4, unit: 'celsius', vendorDataType: '59', sourceRecordId: `temperature-${observationId}`,
    }))
    await queue.enqueueMany(temperature)
    return temperature
  }

  function hrSnapshot() {
    return sqlite.databases.get('elite_plus_connector')!.db.prepare(
      "SELECT rowid, * FROM observation_queue WHERE owner_user_id = ? AND json_extract(payload_json, '$.vendorDataType') = '27' ORDER BY created_at, rowid",
    ).all('certification-owner')
  }

  function accept() {
    return vi.spyOn(connectorObservationService, 'submitObservations').mockImplementation(async (request) => ({
      success: true, batchId: request.batchId, serverTimestamp: new Date().toISOString(),
      accepted: request.observations.length, duplicate: 0, rejected: 0, errors: [],
      results: request.observations.map((row) => ({
        observationId: row.observationId, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: `native-${row.observationId}`,
      })),
    }))
  }

  it('inspects all five IDs without capture, claims, sending or queue mutation', async () => {
    await seed()
    const before = hrSnapshot()
    const send = accept()
    expect((await diagnostic.inspect(TEST_TEMPERATURE_IDS)).map((item) => item.status)).toEqual(Array(5).fill('FOUND_PENDING'))
    expect(send).not.toHaveBeenCalled()
    expect(observationQueue.claimPending).not.toHaveBeenCalled()
    expect(observationQueue.claimCertificationObservationIds).not.toHaveBeenCalled()
    expect(hrSnapshot()).toEqual(before)
  })

  it('delivers five exact wearable temperature rows ahead of 10,112 HR rows with the complete HR snapshot unchanged', async () => {
    const temperature = await seed()
    const db = sqlite.databases.get('elite_plus_connector')!.db
    db.prepare("UPDATE observation_queue SET state = 'ACKNOWLEDGED' WHERE observation_id = ?").run('0'.repeat(64))
    const before = hrSnapshot()
    const send = accept()
    await diagnostic.inspect(TEST_TEMPERATURE_IDS)
    const report = await diagnostic.flush(TEST_TEMPERATURE_IDS)
    expect(report.reason).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0][0].observations).toEqual(temperature)
    expect(hrSnapshot()).toEqual(before)
    expect(manager.getDeliveryDiagnostics()).toMatchObject({ configuredConcurrency: 1, effectiveConcurrency: 1 })
    expect(diagnostic.snapshot().samples.every((sample) => sample.deliveryState === 'DELIVERED_CANONICALIZED'
      && sample.deliveryResult?.result?.observationId === sample.observationId)).toBe(true)
    expect(diagnostic.snapshot().inspection.every((item) => item.status === 'ACKNOWLEDGED_EVIDENCE')).toBe(true)
    expect(await queue.getQueueStats()).toMatchObject({ canonicalRecoveryRequired: false, failed: 0, inFlight: 0 })
  })

  it('waits for an active 100-row HR batch, blocks new normal claims, then sends only the five IDs', async () => {
    await seed()
    const before = hrSnapshot()
    let finishHr: (() => void) | undefined
    const held = new Promise<void>((resolve) => { finishHr = resolve })
    const send = accept()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (request, options) => {
      if (request.observations[0].vendorDataType === '27') await held
      return original(request, options)
    })
    const hr = manager.process()
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1))
    const stages: string[] = []
    const pending = diagnostic.flush(TEST_TEMPERATURE_IDS, (stage) => { stages.push(stage) })
    await vi.waitFor(() => expect(stages).toContain('Waiting for active batch'))
    expect(await manager.process()).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
    finishHr!()
    await hr
    await pending
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls.map(([request]) => request.observations.length)).toEqual([100, 5])
    expect(hrSnapshot()).toEqual(before.slice(100))
    expect(stages).toContain('Sending certification rows')
    await manager.process()
    expect(send.mock.calls[2][0].observations[0].vendorDataType).toBe('27')
  })

  it('preserves canonical failure protection and never resumes ordinary claims after recovery is required', async () => {
    await seed(300)
    const before = hrSnapshot()
    const send = accept()
    const original = send.getMockImplementation()!
    send.mockImplementation(async (request, options) => {
      const response = await original(request, options)
      return { ...response, results: response.results?.map((result) => ({ ...result, canonicalStatus: 'failed' })) }
    })

    await diagnostic.inspect(TEST_TEMPERATURE_IDS)
    const report = await diagnostic.flush(TEST_TEMPERATURE_IDS)
    expect(report.reason).toBe('CANONICAL_RECOVERY_REQUIRED')
    expect(diagnostic.snapshot().inspection.every((item) => item.status === 'RECOVERY_REQUIRED')).toBe(true)
    expect(diagnostic.snapshot().samples.every((sample) => sample.deliveryState === 'CANONICAL_FAILED')).toBe(true)
    expect(hrSnapshot()).toEqual(before)
    expect(await manager.process()).toBeNull()
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('restores diagnostic metadata and queued rows across a restart before targeted flush, and exports the exact celsius/body.wearable_temperature handoff shape', async () => {
    await seed(100)
    await diagnostic.inspect(TEST_TEMPERATURE_IDS)
    queue = new ObservationQueue(new NativeSQLiteQueueStore())
    queue.setOwnerUserId('certification-owner')
    await queue.initialize()
    manager = new ObservationBatchManager({}, { isOnline: () => true, subscribe: () => () => undefined })
    const restarted = new TemperatureCertification({ queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options), storage: () => storage })
    expect(restarted.snapshot().samples).toHaveLength(5)
    expect((await restarted.inspect(TEST_TEMPERATURE_IDS)).every((item) => item.status === 'FOUND_PENDING')).toBe(true)
    const send = accept()
    await restarted.flush(TEST_TEMPERATURE_IDS)
    expect(send).toHaveBeenCalledTimes(1)
    const reopened = new TemperatureCertification({ queue, flush: (ids, options) => manager.flushCertificationObservationIds(ids, options), storage: () => storage })
    expect(reopened.snapshot().samples.every((sample) => sample.deliveryResult?.result?.canonicalStatus === 'canonicalized')).toBe(true)
    const context = { deviceId: null, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }
    const exported = await buildCertificationValidationExport({ deviceInfo: null, historicalRuns: {} }, {
      ownerUserId: queue.getOwnerUserId(), physiologyContext: context, workoutContext: context,
      persistedTemperatureSamples: reopened.snapshot().samples, temperatureQueueInspection: reopened.snapshot().inspection,
      readQueueRecord: (id) => queue.getRecord(id),
    })
    const json = JSON.parse(serializeCertificationValidationExport(exported))
    expect(json.jcvitalCertification.wearableTemperature.sampleObservations).toHaveLength(5)
    expect(json.jcvitalCertification.handoff.find((item: { METRIC: string }) => item.METRIC === 'wearableTemperature').samples[0]).toMatchObject({
      OBSERVATION_ID: TEST_TEMPERATURE_IDS[0], SOURCE_RECORD_ID: `temperature-${TEST_TEMPERATURE_IDS[0]}`,
      VALUE: 33.4, UNIT: 'celsius', VENDOR_TYPE: '59', CANONICAL_TARGET: 'body.wearable_temperature',
      DELIVERY_STATE: 'DELIVERED_CANONICALIZED', NATIVE_OBSERVATION_ID: `native-${TEST_TEMPERATURE_IDS[0]}`,
      QUEUE_DISPOSITION: 'ACKNOWLEDGED_PURGED',
    })
    expect(json.jcvitalCertification.baseline.deploymentRevision).toBe('nc-observations-5b1-results-2026-10-03-r4')
    queue.setOwnerUserId('another-owner')
    expect(reopened.snapshot()).toEqual({ samples: [], inspection: [] })
  })

  it('rejects a different vendor type presented as wearable temperature', async () => {
    const base = await physicalFixture('certification-owner')
    await queue.enqueue({ ...base, observationId: TEST_TEMPERATURE_IDS[0], metric: 'heartRate', vendorDataType: '27' })
    const send = accept()
    await expect(diagnostic.flush(TEST_TEMPERATURE_IDS)).rejects.toThrow('type-59 wearable temperature')
    expect(send).not.toHaveBeenCalled()
  })
})

describe('ObservationQueue on the browser IndexedDB path', () => {
  it('round-trips the physical JCVital HR observation and self-tests', async () => {
    const queue = new ObservationQueue(new WebQueueStore())
    const owner = `web-${Date.now()}`
    queue.setOwnerUserId(owner)
    await queue.initialize()
    expect(queue.getDiagnostics()).toMatchObject({ queueStoreType: 'INDEXEDDB', queueStoreInitialized: true, queueSchemaVersion: 8 })
    const observation = await physicalFixture(owner)
    await queue.enqueue(observation)
    expect((await queue.getPending(100))[0].payload).toEqual(observation)
    const selfTest = await queue.selfTest({ ...observation, observationId: 'f'.repeat(64) })
    expect(selfTest).toMatchObject({ readBack: true, readBackPayloadMatches: true, removed: true })
  })
})
