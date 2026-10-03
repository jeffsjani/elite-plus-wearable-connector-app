import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { NativeObservationInput } from '../base44/base44Types'
import { NativeSQLiteQueueStore } from '../storage/NativeSQLiteQueueStore'
import { QueueStoreError } from '../storage/ObservationQueueStore'
import { WebQueueStore } from '../storage/WebQueueStore'
import { buildWorkoutHrObservation } from '../../adapters/jcvital/WorkoutHrDelivery'
import { ObservationQueue } from './ObservationQueue'

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

beforeEach(() => {
  sqlite.connections.clear()
  sqlite.databases.clear()
  sqlite.failCreateConnection = null
  sqlite.failOpenOnce = false
  sqlite.runCalls = 0
  sqlite.executeSetCalls = 0
})

describe('ObservationQueue on the Android SQLite path', () => {
  it('initializes the SQLite store and reports its identity', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    await queue.initialize()
    expect(queue.getDiagnostics()).toMatchObject({
      queueStoreType: 'SQLITE', queueStoreInitialized: true, queueDatabaseName: 'elite_plus_connector',
      queueSchemaVersion: 5, queueInitializationError: null,
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

  it('migrates schema-v2 SQLite pending, in-flight, and acknowledged rows without data loss, then recovers stale work', async () => {
    const firstInstall = new ObservationQueue(new NativeSQLiteQueueStore())
    firstInstall.setOwnerUserId('user-1')
    const base = await physicalFixture('user-1')
    const observations = ['pending', 'inflight', 'acknowledged'].map((key) => ({ ...base, observationId: key.padStart(64, '0') }))
    const inserted = await firstInstall.enqueueMany(observations)

    const db = sqlite.databases.get('elite_plus_connector')!.db
    db.prepare("UPDATE observation_queue SET state = 'IN_FLIGHT', batch_id = 'prior-build-in-flight', attempt_count = 1 WHERE queue_id = ?").run(inserted[1].record.queueId)
    db.prepare("UPDATE observation_queue SET state = 'ACKNOWLEDGED', acknowledged_at = ? WHERE queue_id = ?").run(new Date().toISOString(), inserted[2].record.queueId)
    db.exec('ALTER TABLE observation_queue DROP COLUMN canonical_failure_at; ALTER TABLE observation_queue DROP COLUMN native_observation_id; ALTER TABLE observation_queue DROP COLUMN claimed_at; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_at; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_observation_count; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_batch_id; ALTER TABLE queue_metadata DROP COLUMN canonical_recovery_required; DELETE FROM schema_version WHERE version >= 3;')

    const upgradedInstall = new ObservationQueue(new NativeSQLiteQueueStore())
    upgradedInstall.setOwnerUserId('user-1')
    await upgradedInstall.initialize()
    const retained = await Promise.all(observations.map((observation) => upgradedInstall.getRecord(observation.observationId)))
    expect(upgradedInstall.getDiagnostics().queueSchemaVersion).toBe(5)
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

describe('ObservationQueue on the browser IndexedDB path', () => {
  it('round-trips the physical JCVital HR observation and self-tests', async () => {
    const queue = new ObservationQueue(new WebQueueStore())
    const owner = `web-${Date.now()}`
    queue.setOwnerUserId(owner)
    await queue.initialize()
    expect(queue.getDiagnostics()).toMatchObject({ queueStoreType: 'INDEXEDDB', queueStoreInitialized: true, queueSchemaVersion: 5 })
    const observation = await physicalFixture(owner)
    await queue.enqueue(observation)
    expect((await queue.getPending(100))[0].payload).toEqual(observation)
    const selfTest = await queue.selfTest({ ...observation, observationId: 'f'.repeat(64) })
    expect(selfTest).toMatchObject({ readBack: true, readBackPayloadMatches: true, removed: true })
  })
})
