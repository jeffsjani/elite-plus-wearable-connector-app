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
        return { changes: { changes: Number(openDatabase(database).prepare(statement).run(...values).changes) } }
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
})

describe('ObservationQueue on the Android SQLite path', () => {
  it('initializes the SQLite store and reports its identity', async () => {
    const queue = new ObservationQueue(new NativeSQLiteQueueStore())
    await queue.initialize()
    expect(queue.getDiagnostics()).toMatchObject({
      queueStoreType: 'SQLITE', queueStoreInitialized: true, queueDatabaseName: 'elite_plus_connector',
      queueSchemaVersion: 2, queueInitializationError: null,
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
})

describe('ObservationQueue on the browser IndexedDB path', () => {
  it('round-trips the physical JCVital HR observation and self-tests', async () => {
    const queue = new ObservationQueue(new WebQueueStore())
    const owner = `web-${Date.now()}`
    queue.setOwnerUserId(owner)
    await queue.initialize()
    expect(queue.getDiagnostics()).toMatchObject({ queueStoreType: 'INDEXEDDB', queueStoreInitialized: true, queueSchemaVersion: 2 })
    const observation = await physicalFixture(owner)
    await queue.enqueue(observation)
    expect((await queue.getPending(100))[0].payload).toEqual(observation)
    const selfTest = await queue.selfTest({ ...observation, observationId: 'f'.repeat(64) })
    expect(selfTest).toMatchObject({ readBack: true, readBackPayloadMatches: true, removed: true })
  })
})
