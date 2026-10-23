import { CapacitorSQLite } from '@capacitor-community/sqlite'
import type { NativeObservationInput } from '../base44/base44Types'
import { assertActivityRecoveryIds } from './ActivityCertificationTransport'
import { MAX_QUEUE_CLAIM } from './ObservationQueueStore'
import type {
  EnqueueResult,
  CanonicalRecoveryBatch,
  CanonicalRecoveryClaim,
  ObservationQueueStore,
  QueueClaim,
  QueueErrorMetadata,
  QueueRecord,
  QueueStats,
  PendingQueueComposition,
  QueueCompositionGroup,
  PersistedProductionSyncReceipt,
  AcquisitionQueueProvenance,
} from './ObservationQueueStore'

const database = 'elite_plus_connector'
const schemaVersion = 8
const maxObservations = 100_000
const warningAgeMs = 30 * 24 * 60 * 60 * 1000
/** Keeps the IN (...) list well under SQLite's bound-parameter limit. */
export const ENQUEUE_CHUNK = 250

function createId(): string { return crypto.randomUUID() }
function nowIso(): string { return new Date().toISOString() }

export class NativeSQLiteQueueStore implements ObservationQueueStore {
  readonly storeType = 'SQLITE' as const
  readonly databaseName = database
  private initialized = false
  private initializing: Promise<void> | null = null
  private schemaVersion: number | null = null

  getSchemaVersion(): number | null { return this.schemaVersion }

  async saveProductionSyncReceipt(receipt: PersistedProductionSyncReceipt): Promise<void> {
    await this.initialize()
    await CapacitorSQLite.run({
      database,
      statement: `INSERT INTO production_sync_receipts
        (owner_user_id, sync_id, started_at, completed_at, overall_state, requested_metrics_json, receipt_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(owner_user_id) DO UPDATE SET
          sync_id = excluded.sync_id, started_at = excluded.started_at, completed_at = excluded.completed_at,
          overall_state = excluded.overall_state, requested_metrics_json = excluded.requested_metrics_json,
          receipt_json = excluded.receipt_json;`,
      values: [receipt.ownerUserId, receipt.syncId, receipt.startedAt, receipt.completedAt, receipt.overallState, receipt.requestedMetricsJson, receipt.receiptJson],
    })
  }

  async loadLatestProductionSyncReceipt(ownerUserId: string): Promise<string | null> {
    await this.initialize()
    const result = await CapacitorSQLite.query({
      database,
      statement: 'SELECT receipt_json FROM production_sync_receipts WHERE owner_user_id = ?;',
      values: [ownerUserId],
    })
    const value = result.values?.[0]?.receipt_json
    return typeof value === 'string' ? value : null
  }

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
    if (currentVersion < 3) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        ALTER TABLE observation_queue ADD COLUMN claimed_at TEXT NULL;
        INSERT INTO schema_version(version) VALUES (3);
      ` })
    }
    if (currentVersion < 4) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        ALTER TABLE observation_queue ADD COLUMN native_observation_id TEXT NULL;
        ALTER TABLE observation_queue ADD COLUMN canonical_failure_at TEXT NULL;
        INSERT INTO schema_version(version) VALUES (4);
      ` })
    }
    if (currentVersion < 5) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        ALTER TABLE queue_metadata ADD COLUMN canonical_recovery_required INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE queue_metadata ADD COLUMN canonical_recovery_batch_id TEXT NULL;
        ALTER TABLE queue_metadata ADD COLUMN canonical_recovery_observation_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE queue_metadata ADD COLUMN canonical_recovery_at TEXT NULL;
        INSERT INTO schema_version(version) VALUES (5);
      ` })
    }
    if (currentVersion < 6) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        ALTER TABLE observation_queue ADD COLUMN source_envelope_id TEXT NULL;
        INSERT INTO schema_version(version) VALUES (6);
      ` })
    }
    if (currentVersion < 7) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        CREATE TABLE IF NOT EXISTS production_sync_receipts (
          owner_user_id TEXT PRIMARY KEY,
          sync_id TEXT NOT NULL,
          started_at TEXT NOT NULL,
          completed_at TEXT NULL,
          overall_state TEXT NOT NULL,
          requested_metrics_json TEXT NOT NULL,
          receipt_json TEXT NOT NULL
        );
        INSERT INTO schema_version(version) VALUES (7);
      ` })
    }
    if (currentVersion < 8) {
      await CapacitorSQLite.execute({ database, transaction: true, statements: `
        ALTER TABLE observation_queue ADD COLUMN acquisition_provenance_json TEXT NULL;
        INSERT INTO schema_version(version) VALUES (8);
      ` })
    }
    this.schemaVersion = schemaVersion
    this.initialized = true
  }

  private fromRow(row: Record<string, unknown>): QueueRecord {
    return {
      queueId: String(row.queue_id),
      ownerUserId: String(row.owner_user_id),
      observationId: String(row.observation_id),
      ...(row.source_envelope_id == null ? {} : { sourceEnvelopeId: String(row.source_envelope_id) }),
      ...(row.acquisition_provenance_json == null ? {} : {
        acquisitionProvenance: JSON.parse(String(row.acquisition_provenance_json)) as AcquisitionQueueProvenance,
      }),
      payload: JSON.parse(String(row.payload_json)) as NativeObservationInput,
      state: String(row.state) as QueueRecord['state'],
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      claimedAt: row.claimed_at ? String(row.claimed_at) : null,
      attemptCount: Number(row.attempt_count),
      nextAttemptAt: row.next_attempt_at ? String(row.next_attempt_at) : null,
      lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
      lastErrorCode: row.last_error_code ? String(row.last_error_code) : null,
      lastErrorMessage: row.last_error_message ? String(row.last_error_message) : null,
      batchId: row.batch_id ? String(row.batch_id) : null,
      acknowledgedAt: row.acknowledged_at ? String(row.acknowledged_at) : null,
      nativeObservationId: row.native_observation_id ? String(row.native_observation_id) : null,
      canonicalFailureAt: row.canonical_failure_at ? String(row.canonical_failure_at) : null,
    }
  }

  async listDiagnosticRecords(ownerUserId: string): Promise<QueueRecord[]> {
    await this.initialize()
    const records: QueueRecord[] = []
    let afterRowId = 0
    while (true) {
      const page = await CapacitorSQLite.query({ database,
        statement: 'SELECT rowid AS diagnostic_rowid, * FROM observation_queue WHERE owner_user_id = ? AND rowid > ? ORDER BY rowid LIMIT 500;',
        values: [ownerUserId, afterRowId] })
      const rows = page.values ?? []
      for (const row of rows) records.push(this.fromRow(row))
      if (rows.length < 500) return records
      afterRowId = Number(rows[rows.length - 1].diagnostic_rowid)
    }
  }

  async getPendingComposition(ownerUserId: string, currentV49SyncId: string | null): Promise<PendingQueueComposition> {
    await this.initialize()
    const summaryResult = await CapacitorSQLite.query({ database, statement: `
      SELECT
        COUNT(*) AS total_pending,
        MIN(created_at) AS oldest_pending_at,
        MAX(created_at) AS newest_pending_at,
        MIN(COALESCE(json_extract(payload_json, '$.observedAt'), json_extract(payload_json, '$.startTime'))) AS oldest_observed_at,
        MAX(COALESCE(json_extract(payload_json, '$.observedAt'), json_extract(payload_json, '$.startTime'))) AS newest_observed_at,
        SUM(CASE WHEN attempt_count = 0 THEN 1 ELSE 0 END) AS attempts_0,
        SUM(CASE WHEN attempt_count = 1 THEN 1 ELSE 0 END) AS attempts_1,
        SUM(CASE WHEN attempt_count = 2 THEN 1 ELSE 0 END) AS attempts_2,
        SUM(CASE WHEN attempt_count >= 3 THEN 1 ELSE 0 END) AS attempts_3_plus,
        (SELECT COUNT(DISTINCT observation_id) FROM observation_queue WHERE owner_user_id = ?) AS distinct_observation_ids,
        (SELECT COUNT(*) - COUNT(DISTINCT observation_id) FROM observation_queue WHERE owner_user_id = ?) AS duplicate_observation_id_rows
      FROM observation_queue
      WHERE owner_user_id = ? AND state = 'PENDING';`,
      values: [ownerUserId, ownerUserId, ownerUserId] })
    const summary = (summaryResult.values?.[0] ?? {}) as Record<string, unknown>

    const syncMetricSql = currentV49SyncId === null ? '' : `
      UNION ALL SELECT 'currentV49Metric', COALESCE(json_extract(payload_json, '$.metric'), json_extract(payload_json, '$.metricType'), '(missing)'), COUNT(*)
        FROM pending WHERE json_extract(acquisition_provenance_json, '$.syncId') = ? GROUP BY 2`
    const groupValues = currentV49SyncId === null ? [ownerUserId] : [ownerUserId, currentV49SyncId]
    const groupsResult = await CapacitorSQLite.query({ database, statement: `
      WITH pending AS (
        SELECT payload_json, acquisition_provenance_json FROM observation_queue
        WHERE owner_user_id = ? AND state = 'PENDING'
      )
      SELECT 'metric' AS dimension, COALESCE(json_extract(payload_json, '$.metric'), json_extract(payload_json, '$.metricType'), '(missing)') AS item, COUNT(*) AS item_count FROM pending GROUP BY 2
      UNION ALL SELECT 'vendorDataType', COALESCE(json_extract(payload_json, '$.vendorDataType'), '(missing)'), COUNT(*) FROM pending GROUP BY 2
      UNION ALL SELECT 'syncId', COALESCE(json_extract(acquisition_provenance_json, '$.syncId'), '(missing)'), COUNT(*) FROM pending GROUP BY 2
      UNION ALL SELECT 'acquisitionId', COALESCE(json_extract(acquisition_provenance_json, '$.acquisitionId'), '(missing)'), COUNT(*) FROM pending GROUP BY 2
      UNION ALL SELECT 'requestedMetric', COALESCE(json_extract(acquisition_provenance_json, '$.requestedMetric'), '(missing)'), COUNT(*) FROM pending GROUP BY 2
      ${syncMetricSql};`,
      values: groupValues })
    const groups = (groupsResult.values ?? []).map((row) => {
      const value = row as Record<string, unknown>
      return {
        dimension: String(value.dimension),
        group: { key: String(value.item), count: Number(value.item_count) },
      }
    })
    const byDimension = (dimension: string): QueueCompositionGroup[] => groups
      .filter((item) => item.dimension === dimension)
      .map((item) => item.group)
      .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))

    let currentV49SyncPending: number | null = null
    let currentV49FirstPosition: number | null = null
    let currentV49LastPosition: number | null = null
    let currentV49RowsAhead: number | null = null
    let heartRateRowsAheadCurrentV49: number | null = null
    let priorSyncPending: number | null = null
    if (currentV49SyncId !== null) {
      const positionsResult = await CapacitorSQLite.query({ database, statement: `
        WITH scoped AS (
          SELECT rowid, created_at, payload_json FROM observation_queue
          WHERE owner_user_id = ? AND state = 'PENDING'
            AND json_extract(acquisition_provenance_json, '$.syncId') = ?
        ),
        target AS (
          SELECT rowid, created_at FROM scoped
          WHERE COALESCE(json_extract(payload_json, '$.vendorDataType'), '') IN ('59', '68')
            OR instr(lower(COALESCE(json_extract(payload_json, '$.metric'), '') || ' ' ||
              COALESCE(json_extract(payload_json, '$.metricType'), '')), 'oxygen') > 0
            OR instr(lower(COALESCE(json_extract(payload_json, '$.metric'), '') || ' ' ||
              COALESCE(json_extract(payload_json, '$.metricType'), '')), 'spo2') > 0
            OR instr(lower(COALESCE(json_extract(payload_json, '$.metric'), '') || ' ' ||
              COALESCE(json_extract(payload_json, '$.metricType'), '')), 'temp') > 0
        ),
        first_target AS (SELECT rowid, created_at FROM target ORDER BY created_at, rowid LIMIT 1),
        last_target AS (SELECT rowid, created_at FROM target ORDER BY created_at DESC, rowid DESC LIMIT 1)
        SELECT
          (SELECT COUNT(*) FROM scoped) AS current_sync_pending,
          (SELECT COUNT(*) FROM target) AS current_metric_pending,
          (SELECT COUNT(*) FROM observation_queue AS prior, first_target
            WHERE prior.owner_user_id = ? AND prior.state = 'PENDING'
              AND (prior.created_at < first_target.created_at OR
                (prior.created_at = first_target.created_at AND prior.rowid < first_target.rowid))) AS rows_ahead,
          (SELECT COUNT(*) + 1 FROM observation_queue AS before_first, first_target
            WHERE before_first.owner_user_id = ? AND before_first.state = 'PENDING'
              AND (before_first.created_at < first_target.created_at OR
                (before_first.created_at = first_target.created_at AND before_first.rowid < first_target.rowid))) AS first_position,
          (SELECT COUNT(*) FROM observation_queue AS through_last, last_target
            WHERE through_last.owner_user_id = ? AND through_last.state = 'PENDING'
              AND (through_last.created_at < last_target.created_at OR
                (through_last.created_at = last_target.created_at AND through_last.rowid <= last_target.rowid))) AS last_position,
          (SELECT COUNT(*) FROM observation_queue AS prior_hr, first_target
            WHERE prior_hr.owner_user_id = ? AND prior_hr.state = 'PENDING'
              AND (prior_hr.created_at < first_target.created_at OR
                (prior_hr.created_at = first_target.created_at AND prior_hr.rowid < first_target.rowid))
              AND (COALESCE(json_extract(prior_hr.payload_json, '$.vendorDataType'), '') IN ('27', '82')
                OR instr(lower(COALESCE(json_extract(prior_hr.payload_json, '$.metric'), '') || ' ' ||
                  COALESCE(json_extract(prior_hr.payload_json, '$.metricType'), '')), 'heart') > 0)) AS heart_rate_rows_ahead
        FROM (SELECT 1);`,
        values: [ownerUserId, currentV49SyncId, ownerUserId, ownerUserId, ownerUserId, ownerUserId] })
      const positions = (positionsResult.values?.[0] ?? {}) as Record<string, unknown>
      currentV49SyncPending = Number(positions.current_sync_pending ?? 0)
      const targetCount = Number(positions.current_metric_pending ?? 0)
      if (targetCount > 0) {
        currentV49FirstPosition = Number(positions.first_position)
        currentV49LastPosition = Number(positions.last_position)
        currentV49RowsAhead = Number(positions.rows_ahead)
        heartRateRowsAheadCurrentV49 = Number(positions.heart_rate_rows_ahead)
      }
      priorSyncPending = Number(summary.total_pending ?? 0) - currentV49SyncPending
    }

    return {
      totalPending: Number(summary.total_pending ?? 0),
      byMetric: byDimension('metric'),
      byVendorDataType: byDimension('vendorDataType'),
      bySyncId: byDimension('syncId'),
      byAcquisitionId: byDimension('acquisitionId'),
      byRequestedMetric: byDimension('requestedMetric'),
      oldestPendingAt: summary.oldest_pending_at == null ? null : String(summary.oldest_pending_at),
      newestPendingAt: summary.newest_pending_at == null ? null : String(summary.newest_pending_at),
      oldestObservedAt: summary.oldest_observed_at == null ? null : String(summary.oldest_observed_at),
      newestObservedAt: summary.newest_observed_at == null ? null : String(summary.newest_observed_at),
      attemptCount: {
        zero: Number(summary.attempts_0 ?? 0),
        one: Number(summary.attempts_1 ?? 0),
        two: Number(summary.attempts_2 ?? 0),
        threePlus: Number(summary.attempts_3_plus ?? 0),
      },
      distinctObservationIds: Number(summary.distinct_observation_ids ?? 0),
      duplicateObservationIdRows: Number(summary.duplicate_observation_id_rows ?? 0),
      currentV49SyncId,
      currentV49SyncPending,
      currentV49MetricPending: currentV49SyncId === null ? null : byDimension('currentV49Metric')
        .filter((group) => ['59', '68'].includes(group.key) || /oxygen|spo2|temp/i.test(group.key)),
      currentV49FirstPosition,
      currentV49LastPosition,
      currentV49RowsAhead,
      heartRateRowsAheadCurrentV49,
      priorSyncPending,
    }
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
  async getPayloadJson(ownerUserId: string, observationId: string): Promise<string | null> {
    await this.initialize()
    const result = await CapacitorSQLite.query({ database,
      statement: 'SELECT payload_json FROM observation_queue WHERE owner_user_id = ? AND observation_id = ?;',
      values: [ownerUserId, observationId] })
    const row = result.values?.[0]
    return row ? String(row.payload_json) : null
  }
  async updateAcquisitionProvenance(
    ownerUserId: string,
    provenanceByObservationId: ReadonlyMap<string, AcquisitionQueueProvenance>,
  ): Promise<number> {
    if (!provenanceByObservationId.size) return 0
    await this.initialize()
    const entries = [...provenanceByObservationId]
    let updated = 0
    for (let start = 0; start < entries.length; start += ENQUEUE_CHUNK) {
      const chunk = entries.slice(start, start + ENQUEUE_CHUNK)
      const result = await CapacitorSQLite.executeSet({
        database,
        transaction: true,
        set: chunk.map(([observationId, provenance]) => ({
          statement: `UPDATE observation_queue SET acquisition_provenance_json = ?
            WHERE owner_user_id = ? AND observation_id = ?;`,
          values: [JSON.stringify(provenance), ownerUserId, observationId],
        })),
      })
      updated += Number(result.changes?.changes ?? 0)
    }
    return updated
  }
  async claimActivityCertification(ownerUserId: string, observationIds: readonly string[], batchId: string): Promise<QueueRecord[]> {
    assertActivityRecoveryIds(observationIds)
    await this.initialize()
    const timestamp = nowIso()
    await CapacitorSQLite.run({ database,
      statement: `UPDATE observation_queue SET state = 'IN_FLIGHT', batch_id = ?, updated_at = ?, claimed_at = ?,
        last_attempt_at = ?, attempt_count = attempt_count + 1
        WHERE owner_user_id = ? AND observation_id IN (${observationIds.map(() => '?').join(',')})
        AND state IN ('PENDING', 'RETRY_WAIT', 'FAILED_PERMANENT', 'ACKNOWLEDGED')
        AND json_extract(payload_json, '$.rawSourceMetadata.certificationOnly') = 1
        AND json_extract(payload_json, '$.rawSourceMetadata.canonicalPolicy') = 'NATIVE_ONLY'
        AND json_extract(payload_json, '$.vendorDataType') IN ('24', '25')
        AND json_extract(payload_json, '$.metricType') != 'DAILY_EXERCISE_MINUTES';`,
      values: [batchId, timestamp, timestamp, timestamp, ownerUserId, ...observationIds] })
    const result = await CapacitorSQLite.query({ database,
      statement: 'SELECT * FROM observation_queue WHERE owner_user_id = ? AND batch_id = ? ORDER BY created_at ASC, rowid ASC;',
      values: [ownerUserId, batchId] })
    return (result.values ?? []).map((row) => this.fromRow(row as Record<string, unknown>))
  }

  async enqueue(
    ownerUserId: string,
    observation: NativeObservationInput,
    sourceEnvelopeId?: string,
    provenance?: AcquisitionQueueProvenance,
  ): Promise<EnqueueResult> {
    const existing = await this.getRecord(ownerUserId, observation.observationId)
    if (existing) {
      if (existing.sourceEnvelopeId === undefined && sourceEnvelopeId !== undefined) {
        await CapacitorSQLite.run({ database, statement: 'UPDATE observation_queue SET source_envelope_id = ? WHERE owner_user_id = ? AND observation_id = ? AND source_envelope_id IS NULL;', values: [sourceEnvelopeId, ownerUserId, observation.observationId] })
        return { inserted: false, alreadyQueued: true, record: (await this.getRecord(ownerUserId, observation.observationId))! }
      }
      return { inserted: false, alreadyQueued: true, record: existing }
    }
    const timestamp = nowIso()
    const record: QueueRecord = {
      queueId: createId(), ownerUserId, observationId: observation.observationId,
      ...(sourceEnvelopeId === undefined ? {} : { sourceEnvelopeId }),
      ...(provenance === undefined ? {} : { acquisitionProvenance: provenance }),
      payload: observation, state: 'PENDING', createdAt: timestamp, updatedAt: timestamp, claimedAt: null,
      attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null,
      batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
    }
    await CapacitorSQLite.run({
      database,
      statement: 'INSERT INTO observation_queue (queue_id, owner_user_id, observation_id, source_envelope_id, acquisition_provenance_json, payload_json, state, created_at, updated_at, attempt_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
      values: [record.queueId, ownerUserId, observation.observationId, sourceEnvelopeId ?? null,
        provenance === undefined ? null : JSON.stringify(provenance), JSON.stringify(observation), record.state, timestamp, timestamp, 0],
    })
    return { inserted: true, alreadyQueued: false, record }
  }

  /** One existence query and one transactional executeSet per chunk instead of two bridge calls per row. */
  async enqueueMany(
    ownerUserId: string,
    observations: NativeObservationInput[],
    sourceEnvelopeIds?: ReadonlyMap<string, string>,
    provenanceByObservationId?: ReadonlyMap<string, AcquisitionQueueProvenance>,
  ): Promise<EnqueueResult[]> {
    if (!observations.length) return []
    await this.initialize()
    const results: EnqueueResult[] = []
    for (let start = 0; start < observations.length; start += ENQUEUE_CHUNK) {
      const chunk = observations.slice(start, start + ENQUEUE_CHUNK)
      const existing = await CapacitorSQLite.query({ database, statement: `SELECT * FROM observation_queue WHERE owner_user_id = ? AND observation_id IN (${chunk.map(() => '?').join(',')});`, values: [ownerUserId, ...chunk.map((observation) => observation.observationId)] })
      const known = new Map((existing.values ?? []).map((row) => { const record = this.fromRow(row as Record<string, unknown>); return [record.observationId, record] }))
      const timestamp = nowIso()
      const set: Array<{ statement: string; values: unknown[] }> = []
      const associated = new Set<string>()
      const resultStart = results.length
      for (const observation of chunk) {
        const sourceEnvelopeId = sourceEnvelopeIds?.get(observation.observationId)
        const acquisitionProvenance = provenanceByObservationId?.get(observation.observationId)
        const already = known.get(observation.observationId)
        if (already) {
          if (already.sourceEnvelopeId === undefined && sourceEnvelopeId !== undefined && !associated.has(observation.observationId)) {
            set.push({ statement: 'UPDATE observation_queue SET source_envelope_id = ? WHERE owner_user_id = ? AND observation_id = ? AND source_envelope_id IS NULL;', values: [sourceEnvelopeId, ownerUserId, observation.observationId] })
            associated.add(observation.observationId)
          }
          results.push({ inserted: false, alreadyQueued: true, record: already })
          continue
        }
        const record: QueueRecord = {
          queueId: createId(), ownerUserId, observationId: observation.observationId,
          ...(sourceEnvelopeId === undefined ? {} : { sourceEnvelopeId }),
          ...(acquisitionProvenance === undefined ? {} : { acquisitionProvenance }),
          payload: observation, state: 'PENDING', createdAt: timestamp, updatedAt: timestamp, claimedAt: null,
          attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null,
          batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
        }
        known.set(observation.observationId, record)
        set.push({
          statement: 'INSERT OR IGNORE INTO observation_queue (queue_id, owner_user_id, observation_id, source_envelope_id, acquisition_provenance_json, payload_json, state, created_at, updated_at, attempt_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?);',
          values: [record.queueId, ownerUserId, observation.observationId, sourceEnvelopeId ?? null,
            acquisitionProvenance === undefined ? null : JSON.stringify(acquisitionProvenance),
            JSON.stringify(observation), record.state, timestamp, timestamp, 0],
        })
        results.push({ inserted: true, alreadyQueued: false, record })
      }
      if (set.length) await CapacitorSQLite.executeSet({ database, set, transaction: true })
      if (associated.size) {
        const persisted = await CapacitorSQLite.query({ database, statement: `SELECT * FROM observation_queue WHERE owner_user_id = ? AND observation_id IN (${[...associated].map(() => '?').join(',')});`, values: [ownerUserId, ...associated] })
        const records = new Map((persisted.values ?? []).map((row) => { const record = this.fromRow(row as Record<string, unknown>); return [record.observationId, record] }))
        for (let index = resultStart; index < results.length; index++) {
          const record = records.get(results[index].record.observationId)
          if (record) results[index].record = record
        }
      }
    }
    return results
  }

  async getPending(ownerUserId: string, limit: number, now = new Date()): Promise<QueueRecord[]> {
    await this.initialize()
    const result = await CapacitorSQLite.query({ database, statement: "SELECT * FROM observation_queue WHERE owner_user_id = ? AND state IN ('PENDING', 'RETRY_WAIT') AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at ASC, rowid ASC LIMIT ?;", values: [ownerUserId, now.toISOString(), limit] })
    return (result.values ?? []).map((row) => this.fromRow(row as Record<string, unknown>))
  }

  async getNextRetryAt(ownerUserId: string, now = new Date()): Promise<string | null> {
    await this.initialize()
    const result = await CapacitorSQLite.query({
      database,
      statement: "SELECT MIN(next_attempt_at) AS next_retry_at FROM observation_queue WHERE owner_user_id = ? AND state = 'RETRY_WAIT' AND next_attempt_at > ?;",
      values: [ownerUserId, now.toISOString()],
    })
    const value = result.values?.[0]?.next_retry_at
    return typeof value === 'string' ? value : null
  }

  /**
   * Atomic claim: the eligible-row selection and the IN_FLIGHT mark happen inside a single UPDATE statement
   * (subquery), so the native SQLite engine never yields control between select and claim. A second SELECT,
   * scoped to this call's unique batchId, reads back exactly the rows this call claimed - safe even if other
   * concurrent workers are claiming other rows at the same time under a different batchId.
   */
  async claimPending(ownerUserId: string, limit: number, batchId: string, now = new Date(), observationIds?: readonly string[], ignoreRetryBackoff = false): Promise<QueueRecord[]> {
    await this.initialize()
    if (observationIds?.length === 0) return []
    const claimLimit = Math.max(0, Math.min(MAX_QUEUE_CLAIM, Math.floor(limit)))
    if (claimLimit === 0) return []
    const timestamp = now.toISOString()
    const retryImmediately = observationIds !== undefined && ignoreRetryBackoff
    await CapacitorSQLite.run({
      database,
      statement: `UPDATE observation_queue SET state = 'IN_FLIGHT', batch_id = ?, updated_at = ?, claimed_at = ?, last_attempt_at = ?, attempt_count = attempt_count + 1
        WHERE queue_id IN (
          SELECT queue_id FROM observation_queue
          WHERE owner_user_id = ? AND state IN ('PENDING', 'RETRY_WAIT')
          ${retryImmediately ? '' : 'AND (next_attempt_at IS NULL OR next_attempt_at <= ?)'}
          ${observationIds ? '' : `AND NOT (
            COALESCE(json_extract(payload_json, '$.rawSourceMetadata.certificationOnly'), 0) = 1
            AND COALESCE(json_extract(payload_json, '$.vendorDataType'), '') IN ('24', '25')
          )`}
          ${observationIds ? `AND observation_id IN (${observationIds.map(() => '?').join(',')})` : ''}
          ORDER BY created_at ASC, rowid ASC LIMIT ?
        );`,
      values: [batchId, timestamp, timestamp, timestamp, ownerUserId, ...(retryImmediately ? [] : [timestamp]), ...(observationIds ?? []), claimLimit],
    })
    const result = await CapacitorSQLite.query({ database, statement: 'SELECT * FROM observation_queue WHERE owner_user_id = ? AND batch_id = ? ORDER BY created_at ASC, rowid ASC;', values: [ownerUserId, batchId] })
    return (result.values ?? []).map((row) => this.fromRow(row as Record<string, unknown>))
  }

  async acknowledgeClaims(claims: QueueClaim[], ownerUserId: string): Promise<number> {
    if (!claims.length) return 0
    const timestamp = nowIso()
    const set = claims.map((claim) => ({
      statement: `UPDATE observation_queue SET state = 'ACKNOWLEDGED', acknowledged_at = ?, updated_at = ?
        WHERE owner_user_id = ? AND queue_id = ? AND state = 'IN_FLIGHT' AND batch_id = ? AND attempt_count = ?;`,
      values: [timestamp, timestamp, ownerUserId, claim.queueId, claim.batchId, claim.attemptCount],
    }))
    const result = await CapacitorSQLite.executeSet({ database, set, transaction: true })
    const changed = Number(result.changes?.changes ?? 0)
    if (changed > 0) await CapacitorSQLite.run({ database, statement: 'INSERT INTO queue_metadata(owner_user_id, last_successful_upload_at) VALUES (?, ?) ON CONFLICT(owner_user_id) DO UPDATE SET last_successful_upload_at = excluded.last_successful_upload_at;', values: [ownerUserId, timestamp] })
    return changed
  }

  async markCanonicalRecoveryRequired(claims: CanonicalRecoveryClaim[], ownerUserId: string, error: QueueErrorMetadata): Promise<number> {
    if (!claims.length) return 0
    const result = await CapacitorSQLite.executeSet({ database, transaction: true, set: claims.map((claim) => ({
      statement: `UPDATE observation_queue SET state = 'CANONICAL_RECOVERY_REQUIRED', native_observation_id = ?, canonical_failure_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE owner_user_id = ? AND queue_id = ? AND state = 'IN_FLIGHT' AND batch_id = ? AND attempt_count = ?;`,
      values: [claim.nativeObservationId, claim.canonicalFailureAt, error.code, error.message, claim.canonicalFailureAt, ownerUserId, claim.queueId, claim.batchId, claim.attemptCount],
    })) })
    return Number(result.changes?.changes ?? 0)
  }

  async getCanonicalRecoveryBatches(ownerUserId: string, limit: number): Promise<CanonicalRecoveryBatch[]> {
    await this.initialize()
    const result = await CapacitorSQLite.query({
      database,
      statement: `SELECT batch_id, COUNT(*) AS observation_count, MAX(canonical_failure_at) AS last_failure_at
        FROM observation_queue WHERE owner_user_id = ? AND state = 'CANONICAL_RECOVERY_REQUIRED'
        GROUP BY batch_id ORDER BY last_failure_at DESC LIMIT ?;`,
      values: [ownerUserId, Math.max(0, Math.floor(limit))],
    })
    const batches = (result.values ?? []).map((row) => ({
      batchId: String((row as Record<string, unknown>).batch_id ?? ''),
      observationCount: Number((row as Record<string, unknown>).observation_count ?? 0),
      lastFailureAt: String((row as Record<string, unknown>).last_failure_at ?? ''),
    }))
    const metadata = await CapacitorSQLite.query({
      database,
      statement: 'SELECT canonical_recovery_required, canonical_recovery_batch_id, canonical_recovery_observation_count, canonical_recovery_at FROM queue_metadata WHERE owner_user_id = ?;',
      values: [ownerUserId],
    })
    const marker = metadata.values?.[0] as Record<string, unknown> | undefined
    const batchId = String(marker?.canonical_recovery_batch_id ?? '')
    if (Number(marker?.canonical_recovery_required ?? 0) === 1 && batchId) {
      const existing = batches.find((batch) => batch.batchId === batchId)
      if (existing) {
        existing.observationCount = Math.max(existing.observationCount, Number(marker?.canonical_recovery_observation_count ?? 0))
        existing.lastFailureAt = String(marker?.canonical_recovery_at ?? existing.lastFailureAt)
      } else batches.push({ batchId, observationCount: Number(marker?.canonical_recovery_observation_count ?? 0), lastFailureAt: String(marker?.canonical_recovery_at ?? '') })
    }
    return batches.sort((left, right) => right.lastFailureAt.localeCompare(left.lastFailureAt)).slice(0, Math.max(0, Math.floor(limit)))
  }

  async recordCanonicalRecoveryPause(ownerUserId: string, batchId: string, observationCount: number, at: string): Promise<void> {
    await this.initialize()
    await CapacitorSQLite.run({
      database,
      statement: `INSERT INTO queue_metadata(owner_user_id, canonical_recovery_required, canonical_recovery_batch_id, canonical_recovery_observation_count, canonical_recovery_at)
        VALUES (?, 1, ?, ?, ?)
        ON CONFLICT(owner_user_id) DO UPDATE SET canonical_recovery_required = 1,
          canonical_recovery_batch_id = excluded.canonical_recovery_batch_id,
          canonical_recovery_observation_count = queue_metadata.canonical_recovery_observation_count + excluded.canonical_recovery_observation_count,
          canonical_recovery_at = excluded.canonical_recovery_at;`,
      values: [ownerUserId, batchId, Math.max(0, Math.floor(observationCount)), at],
    })
  }

  async retryClaims(claims: QueueClaim[], error: QueueErrorMetadata, nextAttemptAt: string): Promise<number> {
    if (!claims.length) return 0
    const timestamp = nowIso()
    const result = await CapacitorSQLite.executeSet({ database, transaction: true, set: claims.map((claim) => ({
      statement: `UPDATE observation_queue SET state = 'RETRY_WAIT', next_attempt_at = ?, last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE queue_id = ? AND state = 'IN_FLIGHT' AND batch_id = ? AND attempt_count = ?;`,
      values: [nextAttemptAt, error.code, error.message, timestamp, claim.queueId, claim.batchId, claim.attemptCount],
    })) })
    return Number(result.changes?.changes ?? 0)
  }

  async failClaims(claims: QueueClaim[], error: QueueErrorMetadata): Promise<number> {
    if (!claims.length) return 0
    const timestamp = nowIso()
    const result = await CapacitorSQLite.executeSet({ database, transaction: true, set: claims.map((claim) => ({
      statement: `UPDATE observation_queue SET state = 'FAILED_PERMANENT', last_error_code = ?, last_error_message = ?, updated_at = ?
        WHERE queue_id = ? AND state = 'IN_FLIGHT' AND batch_id = ? AND attempt_count = ?;`,
      values: [error.code, error.message, timestamp, claim.queueId, claim.batchId, claim.attemptCount],
    })) })
    return Number(result.changes?.changes ?? 0)
  }

  async releaseStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number> { await this.initialize(); const timestamp = nowIso(); const result = await CapacitorSQLite.run({ database, statement: `UPDATE observation_queue SET state = 'RETRY_WAIT', next_attempt_at = ?, last_error_code = 'STALE_IN_FLIGHT', last_error_message = 'Recovered after an interrupted upload.', updated_at = ? WHERE owner_user_id = ? AND state = 'IN_FLIGHT' AND updated_at < ?;`, values: [timestamp, timestamp, ownerUserId, staleBefore] }); return result.changes?.changes ?? 0 }

  async countStaleInFlight(ownerUserId: string, staleBefore: string): Promise<number> { await this.initialize(); const result = await CapacitorSQLite.query({ database, statement: `SELECT COUNT(*) AS stale FROM observation_queue WHERE owner_user_id = ? AND state = 'IN_FLIGHT' AND updated_at < ?;`, values: [ownerUserId, staleBefore] }); return Number(result.values?.[0]?.stale ?? 0) }

  /** Aggregates in SQL so periodic diagnostics never load payload_json. */
  async getQueueStats(ownerUserId: string, now = new Date()): Promise<QueueStats> {
    await this.initialize()
    const result = await CapacitorSQLite.query({ database, statement: `SELECT COUNT(*) AS total,
      SUM(CASE WHEN state = 'PENDING' THEN 1 ELSE 0 END) AS pending,
      SUM(CASE WHEN state = 'RETRY_WAIT' THEN 1 ELSE 0 END) AS retrying,
      SUM(CASE WHEN state = 'FAILED_PERMANENT' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN state = 'IN_FLIGHT' THEN 1 ELSE 0 END) AS in_flight,
      SUM(CASE WHEN state = 'ACKNOWLEDGED' THEN 1 ELSE 0 END) AS acknowledged,
      SUM(CASE WHEN state = 'CANONICAL_RECOVERY_REQUIRED' THEN 1 ELSE 0 END) AS canonical_recovery,
      COUNT(DISTINCT CASE WHEN state = 'CANONICAL_RECOVERY_REQUIRED' THEN batch_id END) AS canonical_recovery_batches,
      MIN(CASE WHEN state = 'PENDING' THEN created_at END) AS oldest_pending,
      MIN(CASE WHEN state = 'IN_FLIGHT' THEN claimed_at END) AS oldest_in_flight,
      MAX(last_attempt_at) AS last_attempt_at,
      MAX(acknowledged_at) AS last_acknowledged_at
      , MAX(canonical_failure_at) AS last_canonical_failure_at
      FROM observation_queue WHERE owner_user_id = ?;`, values: [ownerUserId] })
    const row = (result.values?.[0] ?? {}) as Record<string, unknown>
    const count = (key: string) => Number(row[key] ?? 0)
    const oldestPendingAgeMs = row.oldest_pending ? now.getTime() - Date.parse(String(row.oldest_pending)) : null
    const oldestInFlightAgeMs = row.oldest_in_flight ? now.getTime() - Date.parse(String(row.oldest_in_flight)) : null
    const warnings: string[] = []
    if (count('total') >= maxObservations) warnings.push('QUEUE_CAPACITY_NEAR_LIMIT')
    if (oldestPendingAgeMs !== null && oldestPendingAgeMs >= warningAgeMs) warnings.push('QUEUE_AGE_OVER_30_DAYS')
    const metadata = await CapacitorSQLite.query({ database, statement: 'SELECT * FROM queue_metadata WHERE owner_user_id = ?;', values: [ownerUserId] })
    const metadataRow = metadata.values?.[0] as Record<string, unknown> | undefined
    const metadataRecovery = Number(metadataRow?.canonical_recovery_required ?? 0) === 1
    const recoveryBatches = count('canonical_recovery') || metadataRecovery ? await this.getCanonicalRecoveryBatches(ownerUserId, 1) : []
    const canonicalRecoveryObservationCount = Math.max(count('canonical_recovery'), Number(metadataRow?.canonical_recovery_observation_count ?? 0))
    const metadataBatchId = String(metadataRow?.canonical_recovery_batch_id ?? '')
    const metadataBatchAlreadyCounted = metadataRecovery && metadataBatchId
      ? await CapacitorSQLite.query({ database, statement: "SELECT COUNT(*) AS count FROM observation_queue WHERE owner_user_id = ? AND state = 'CANONICAL_RECOVERY_REQUIRED' AND batch_id = ?;", values: [ownerUserId, metadataBatchId] }).then((batchResult) => Number(batchResult.values?.[0]?.count ?? 0) > 0)
      : false
    const canonicalRecoveryBatchCount = count('canonical_recovery_batches') + (metadataRecovery && !metadataBatchAlreadyCounted ? 1 : 0)
    const lastRecovery = recoveryBatches[0]
    return {
      pending: count('pending'), retrying: count('retrying'), failed: count('failed'), inFlight: count('in_flight'), acknowledged: count('acknowledged'),
      canonicalRecoveryRequired: count('canonical_recovery') > 0 || metadataRecovery,
      canonicalRecoveryObservationCount, canonicalRecoveryBatchCount,
      lastCanonicalFailureBatchId: lastRecovery?.batchId ?? null,
      lastCanonicalFailureAt: lastRecovery?.lastFailureAt ?? (row.last_canonical_failure_at ? String(row.last_canonical_failure_at) : null),
      oldestPendingAgeMs, oldestInFlightAgeMs, lastAttemptAt: row.last_attempt_at ? String(row.last_attempt_at) : null,
      lastSuccessfulUploadAt: String(metadataRow?.last_successful_upload_at ?? row.last_acknowledged_at ?? '') || null, warnings,
    }
  }

  async getOldestPendingAge(ownerUserId: string, now = new Date()): Promise<number | null> { return (await this.getQueueStats(ownerUserId, now)).oldestPendingAgeMs }

  async purgeAcknowledged(ownerUserId: string, observationIds?: readonly string[]): Promise<number> {
    if (observationIds?.length === 0) return 0
    const result = await CapacitorSQLite.run({
      database,
      statement: `DELETE FROM observation_queue WHERE owner_user_id = ? AND state = 'ACKNOWLEDGED'
        ${observationIds ? `AND observation_id IN (${observationIds.map(() => '?').join(',')})` : ''};`,
      values: [ownerUserId, ...(observationIds ?? [])],
    })
    return result.changes?.changes ?? 0
  }
}