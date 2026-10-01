import { CapacitorSQLite } from '@capacitor-community/sqlite'
import type { NativeObservationInput } from '../base44/base44Types'
import type {
  EnqueueResult,
  ObservationQueueStore,
  QueueErrorMetadata,
  QueueRecord,
  QueueStats,
} from './ObservationQueueStore'

const database = 'elite_plus_connector'
const schemaVersion = 2
const maxObservations = 100_000
const warningAgeMs = 30 * 24 * 60 * 60 * 1000

function createId(): string { return crypto.randomUUID() }
function nowIso(): string { return new Date().toISOString() }

export class NativeSQLiteQueueStore implements ObservationQueueStore {
  readonly storeType = 'SQLITE' as const
  readonly databaseName = database
  private initialized = false
  private initializing: Promise<void> | null = null
  private schemaVersion: number | null = null

  getSchemaVersion(): number | null { return this.schemaVersion }

  async initialize(): Promise<void> {
    if (this.initialized) return
    if (!this.initializing) this.initializing = this.openAndMigrate().finally(() => { this.initializing = null })
    await this.initializing
  }

  private async openAndMigrate(): Promise<void> {
    try {
      await CapacitorSQLite.createConnection({ database, version: schemaVersion, encrypted: false, mode: 'no-encryption', readonly: false })
    } catch (error) {
      // A failed earlier attempt leaves the native connection registered; reuse it.
      if (!/already exists/i.test(error instanceof Error ? error.message : String(error))) throw error
    }
    const open = await CapacitorSQLite.isDBOpen({ database, readonly: false }).catch(() => ({ result: false }))
    if (!open.result) await CapacitorSQLite.open({ database, readonly: false })
    await CapacitorSQLite.execute({ database, statements: 'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL);' })
    // Android's plugin rejects query/run calls without a values array.
    const current = await CapacitorSQLite.query({ database, statement: 'SELECT version FROM schema_version ORDER BY version DESC LIMIT 1;', values: [] })
    const currentVersion = Number(current.values?.[0]?.version ?? 0)
    if (currentVersion < 1) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        CREATE TABLE IF NOT EXISTS observation_queue (
          queue_id TEXT PRIMARY KEY,
          owner_user_id TEXT NOT NULL,
          observation_id TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          next_attempt_at TEXT NULL,
          last_attempt_at TEXT NULL,
          last_error_code TEXT NULL,
          last_error_message TEXT NULL,
          batch_id TEXT NULL,
          acknowledged_at TEXT NULL,
          UNIQUE(owner_user_id, observation_id)
        );
        CREATE INDEX IF NOT EXISTS idx_queue_state ON observation_queue(state);
        CREATE INDEX IF NOT EXISTS idx_queue_owner_state ON observation_queue(owner_user_id, state);
        CREATE INDEX IF NOT EXISTS idx_queue_next_attempt ON observation_queue(next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_queue_created ON observation_queue(created_at);
        DELETE FROM schema_version;
        INSERT INTO schema_version(version) VALUES (1);
      ` })
    }
    if (currentVersion < 2) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        CREATE TABLE IF NOT EXISTS queue_metadata (
          owner_user_id TEXT PRIMARY KEY,
          last_successful_upload_at TEXT NULL
        );
        INSERT INTO schema_version(version) VALUES (2);
      ` })
    }
    this.schemaVersion = schemaVersion
    this.initialized = true
  }

  private async rows(ownerUserId?: string): Promise<QueueRecord[]> {
    await this.initialize()
    const values = await CapacitorSQLite.query({ database, statement: ownerUserId
      ? 'SELECT * FROM observation_queue WHERE owner_user_id = ? ORDER BY created_at ASC;'
      : 'SELECT * FROM observation_queue ORDER BY created_at ASC;', values: ownerUserId ? [ownerUserId] : [] })
    return (values.values ?? []).map((row) => this.fromRow(row as Record<string, unknown>))
  }

  private fromRow(row: Record<string, unknown>): QueueRecord {
    return { queueId: String(row.queue_id), ownerUserId: String(row.owner_user_id), observationId: String(row.observation_id), payload: JSON.parse(String(row.payload_json)) as NativeObservationInput, state: String(row.state) as QueueRecord['state'], createdAt: String(row.created_at), updatedAt: String(row.updated_at), attemptCount: Number(row.attempt_count), nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null, lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null, lastErrorCode: row.last_error_code ? String(row.last_error_code) : null, lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null, batchId: row.batch_id ? String(row.batch_id) : null, acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null }
  }

  async getRecord(ownerUserId: string, observationId: string): Promise<QueueRecord | null> {
    await this.initialize()
    const result = await CapacitorSQLite.query({ database, statement: 'SELECT * FROM observation_queue WHERE owner_user_id = ? AND observation_id = ?;', values: [ownerUserId, observationId] })
    const row = result.values?.[0] as Record<string, unknown> | undefined
    return row ? this.fromRow(row) : null
  }

  async remove(ownerUserId: string, observationIds: string[]): Promise<void> {
    if (!observationIds.length) return
    await this.initialize()
    await CapacitorSQLite.run({ database, statement: `DELETE FROM observation_queue WHERE owner_user_id = ? AND observation_id IN (${observationIds.map(() => '?').join(',')});`, values: [ownerUserId, ...observationIds] })
  }

  async enqueue(ownerUserId: string, observation: NativeObservationInput): Promise<EnqueueResult> {
    const existing = (await this.rows(ownerUserId)).find((record) => record.observationId === observation.observationId)
    if (existing) return { inserted: false, alreadyQueued: true, record: existing }
    const timestamp = nowIso(); const record: QueueRecord = { queueId: createId(), ownerUserId, observationId: observation.observationId, payload: observation, state: 'PENDING', createdAt: timestamp, updatedAt: timestamp, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null, batchId: null, acknowledgedAt: null }
    await CapacitorSQLite.run({ database, statement: 'INSERT INTO observation_queue (queue_id, owner_user_id, observation_id, payload_json, state, created_at, updated_at, attempt_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?);', values: [record.queueId, ownerUserId, observation.observationId, JSON.stringify(observation), record.state, timestamp, timestamp, 0] })
    return { inserted: true, alreadyQueued: false, record }
  }

  async enqueueMany(ownerUserId: string, observations: NativeObservationInput[]): Promise<EnqueueResult[]> { const results: EnqueueResult[] = []; for (const observation of observations) results.push(await this.enqueue(ownerUserId, observation)); return results }

  async getPending(ownerUserId: string, limit: number, now = new Date()): Promise<QueueRecord[]> { return (await this.rows(ownerUserId)).filter((record) => (record.state === 'PENDING' || record.state === 'RETRY_WAIT') && (!record.nextAttemptAt || record.nextAttemptAt <= now.toISOString())).slice(0, limit) }

  async markInFlight(queueIds: string[], batchId: string): Promise<void> { if (!queueIds.length) return; const timestamp = nowIso(); await CapacitorSQLite.run({ database, statement: `UPDATE observation_queue SET state = 'IN_FLIGHT', batch_id = ?, updated_at = ?, last_attempt_at = ?, attempt_count = attempt_count + 1 WHERE queue_id IN (${queueIds.map(() => '?').join(',')});`, values: [batchId, timestamp, timestamp, ...queueIds] }) }

  async markAcknowledged(observationIds: string[], ownerUserId: string): Promise<void> { if (!observationIds.length) return; const timestamp = nowIso(); await CapacitorSQLite.run({ database, statement: `UPDATE observation_queue SET state = 'ACKNOWLEDGED', acknowledged_at = ?, updated_at = ? WHERE owner_user_id = ? AND observation_id IN (${observationIds.map(() => '?').join(',')});`, values: [timestamp, timestamp, ownerUserId, ...observationIds] }); await CapacitorSQLite.run({ database, statement: 'INSERT INTO queue_metadata(owner_user_id, last_successful_upload_at) VALUES (?, ?) ON CONFLICT(owner_user_id) DO UPDATE SET last_successful_upload_at = excluded.last_successful_upload_at;', values: [ownerUserId, timestamp] }) }

  async markRetry(queueIds: string[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<void> { if (!queueIds.length) return; const timestamp = nowIso(); await CapacitorSQLite.run({ database, statement: `UPDATE observation_queue SET state = 'RETRY_WAIT', next_attempt_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ? WHERE queue_id IN (${queueIds.map(() => '?').join(',')});`, values: [nextAttemptAt, error.code, error.message, timestamp, ...queueIds] }) }

  async markPermanentFailure(queueIds: string[], error: QueueErrorMetadata): Promise<void> { if (!queueIds.length) return; const timestamp = nowIso(); await CapacitorSQLite.run({ database, statement: `UPDATE observation_queue SET state = 'FAILED_PERMANENT', last_error_code = ?, last_error_message = ?, updated_at = ? WHERE queue_id IN (${queueIds.map(() => '?').join(',')});`, values: [error.code, error.message, timestamp, ...queueIds] }) }

  async releaseStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number> { await this.initialize(); const timestamp = nowIso(); const result = await CapacitorSQLite.run({ database, statement: `UPDATE observation_queue SET state = 'RETRY_WAIT', next_attempt_at = ?, last_error_code = 'STALE_IN_FLIGHT', last_error_message = 'Recovered after an interrupted upload.', updated_at = ? WHERE owner_user_id = ? AND state = 'IN_FLIGHT' AND updated_at < ?;`, values: [timestamp, timestamp, ownerUserId, staleBefore] }); return result.changes?.changes ?? 0 }

  async countStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number> { await this.initialize(); const result = await CapacitorSQLite.query({ database, statement: `SELECT COUNT(*) AS stale FROM observation_queue WHERE owner_user_id = ? AND state = 'IN_FLIGHT' AND updated_at < ?;`, values: [ownerUserId, staleBefore] }); return Number(result.values?.[0]?.stale ?? 0) }

  async getQueueStats(ownerUserId: string, now = new Date()): Promise<QueueStats> { const records = await this.rows(ownerUserId); const pending = records.filter((record) => record.state === 'PENDING'); const oldestPendingAgeMs = pending.length ? now.getTime() - Date.parse(pending[0].createdAt) : null; const warnings: string[] = []; if (records.length >= maxObservations) warnings.push('QUEUE_CAPACITY_NEAR_LIMIT'); if (oldestPendingAgeMs !== null && oldestPendingAgeMs >= warningAgeMs) warnings.push('QUEUE_AGE_OVER_30_DAYS'); const metadata = await CapacitorSQLite.query({ database, statement: 'SELECT last_successful_upload_at FROM queue_metadata WHERE owner_user_id = ?;', values: [ownerUserId] }); return { pending: pending.length, retrying: records.filter((record) => record.state === 'RETRY_WAIT').length, failed: records.filter((record) => record.state === 'FAILED_PERMANENT').length, inFlight: records.filter((record) => record.state === 'IN_FLIGHT').length, acknowledged: records.filter((record) => record.state === 'ACKNOWLEDGED').length, oldestPendingAgeMs, lastAttemptAt: records.map((record) => record.lastAttemptAt).filter(Boolean).sort().at(-1) ?? null, lastSuccessfulUploadAt: String(metadata.values?.[0]?.last_successful_upload_at ?? records.map((record) => record.acknowledgedAt).filter(Boolean).sort().at(-1) ?? '') || null, warnings } }

  async getOldestPendingAge(ownerUserId: string, now = new Date()): Promise<number | null> { return (await this.getQueueStats(ownerUserId, now)).oldestPendingAgeMs }

  async purgeAcknowledged(ownerUserId: string): Promise<number> { const result = await CapacitorSQLite.run({ database, statement: "DELETE FROM observation_queue WHERE owner_user_id = ? AND state = 'ACKNOWLEDGED';", values: [ownerUserId] }); return result.changes?.changes ?? 0 }
}