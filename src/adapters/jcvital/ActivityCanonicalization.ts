import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import {
  ACTIVITY_NORMALIZER_VERSION,
  activeActivityObservations,
  canonicalizeActivity,
  emptyActivityLedger,
  type ActivityCanonicalMetric,
  type ActivityCanonicalObservation,
  type ActivityDeviceContext,
  type ActivityLedgerOutcome,
  type ActivityLedgerState,
  type ActivityWithheldReason,
} from './ActivityProductionCanonical'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'

/**
 * Base44 Activity delivery stays off until the separate Base44 publish gate. This service has no queue
 * dependency, so it cannot enqueue or deliver while the gate is closed.
 */
export const ACTIVITY_BASE44_DELIVERY_ENABLED = false as const

export const ACTIVITY_CANONICAL_LEDGER_STORE = 'eliteplus.activityCanonicalLedger.v1'

export interface ActivityLedgerStore {
  read(scopeKey: string): Promise<ActivityLedgerState | null>
  write(scopeKey: string, state: ActivityLedgerState): Promise<void>
}

export interface ActivityCanonicalizationDependencies {
  owner: () => string | null
  resolveDeviceId: (bleAddress: string) => string | null
  store?: ActivityLedgerStore
  now?: () => number
}

export interface ActivityIngestReport {
  status: 'CANONICALIZED' | 'SKIPPED' | 'FAILED'
  reason: string | null
  vendorDataType: string
  syncId: string
  sourceRecords: number
  observations: number
  withheld: Partial<Record<ActivityWithheldReason, number>>
  outcomes: Partial<Record<ActivityLedgerOutcome, number>>
  completedAt: string
}

export interface ActivityCanonicalizationSnapshot {
  normalizerVersion: typeof ACTIVITY_NORMALIZER_VERSION
  base44DeliveryEnabled: typeof ACTIVITY_BASE44_DELIVERY_ENABLED
  queueWrites: 0
  scopeKey: string | null
  ledgerRows: Partial<Record<ActivityCanonicalMetric, number>>
  lastIngest: ActivityIngestReport | null
  lastError: string | null
}

interface SourceContext { deviceId: string | null; firmwareVersion: string | null; sdkVersion: string | null }

function count<K extends string>(values: readonly K[]): Partial<Record<K, number>> {
  const out: Partial<Record<K, number>> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

/**
 * Production Activity canonicalization: consumes Type24/Type25 historical sync results that existing paths
 * already acquired, maps them under the P1-2C contracts, and durably applies them to the per-owner/device
 * canonical ledger. It never issues device commands, enqueues, delivers, or touches readiness/scoring.
 */
export class JCVitalActivityCanonicalization {
  private readonly deps: ActivityCanonicalizationDependencies
  private context: SourceContext = { deviceId: null, firmwareVersion: null, sdkVersion: null }
  private chain: Promise<unknown> = Promise.resolve()
  private ledgerScopeKey: string | null = null
  private ledger: ActivityLedgerState | null = null
  private lastIngest: ActivityIngestReport | null = null
  private lastError: string | null = null
  private readonly listeners = new Set<() => void>()

  constructor(deps: ActivityCanonicalizationDependencies) { this.deps = deps }

  setContext(update: { deviceId?: string | null; bleAddress?: string | null; firmwareVersion?: string | null; sdkVersion?: string | null }): void {
    this.context = {
      deviceId: update.deviceId !== undefined ? (isOpaqueJCVitalDeviceId(update.deviceId) ? update.deviceId : null)
        : update.bleAddress ? this.deps.resolveDeviceId(update.bleAddress) : this.context.deviceId,
      firmwareVersion: update.firmwareVersion === undefined ? this.context.firmwareVersion : update.firmwareVersion,
      sdkVersion: update.sdkVersion === undefined ? this.context.sdkVersion : update.sdkVersion,
    }
  }

  onChange(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private emit(): void { this.listeners.forEach((listener) => listener()) }

  getSnapshot(): ActivityCanonicalizationSnapshot {
    return {
      normalizerVersion: ACTIVITY_NORMALIZER_VERSION,
      base44DeliveryEnabled: ACTIVITY_BASE44_DELIVERY_ENABLED,
      queueWrites: 0,
      scopeKey: this.ledgerScopeKey,
      ledgerRows: this.ledger ? count(Object.values(this.ledger.rows).map((row) => row.observation.metric)) : {},
      lastIngest: this.lastIngest,
      lastError: this.lastError,
    }
  }

  /** Canonical Activity observations for the current scope (the future Base44 projection input). */
  async activeObservations(): Promise<ActivityCanonicalObservation[]> {
    await this.chain.catch(() => undefined)
    return this.ledger ? activeActivityObservations(this.ledger) : []
  }

  /** Serialized so concurrent sync results cannot race the read-modify-write of the durable ledger. */
  ingest(result: JCVitalV8HistoricalSyncResult, expectedOwner?: string): Promise<ActivityIngestReport> {
    const owner = this.deps.owner()
    const context = { ...this.context }
    const run = this.chain.catch(() => undefined).then(() => expectedOwner !== undefined && owner !== expectedOwner
      ? this.report(result, 'SKIPPED', 'Activity source-journal owner does not match the authenticated owner.')
      : this.ingestNow(result, owner, context))
    this.chain = run
    return run
  }

  ingestAll(results: readonly JCVitalV8HistoricalSyncResult[], expectedOwner?: string): Promise<ActivityIngestReport[]> {
    return Promise.all(results.map((result) => this.ingest(result, expectedOwner)))
  }

  private report(result: JCVitalV8HistoricalSyncResult, status: ActivityIngestReport['status'], reason: string | null,
    extra: Partial<ActivityIngestReport> = {}): ActivityIngestReport {
    const report: ActivityIngestReport = {
      status, reason, vendorDataType: result.vendorDataType, syncId: result.syncId, sourceRecords: 0, observations: 0,
      withheld: {}, outcomes: {}, completedAt: new Date(this.now()).toISOString(), ...extra,
    }
    this.lastIngest = report
    if (status === 'FAILED') this.lastError = reason
    this.emit()
    return report
  }

  private now(): number { return (this.deps.now ?? Date.now)() }

  private async ingestNow(result: JCVitalV8HistoricalSyncResult, owner: string | null, capturedContext: SourceContext): Promise<ActivityIngestReport> {
    if (result.vendorDataType !== '24' && result.vendorDataType !== '25') return this.report(result, 'SKIPPED', 'Not a Type24/Type25 Activity result.')
    if (!owner) return this.report(result, 'SKIPPED', 'Queue owner is not authenticated.')
    if (!Array.isArray(result.observations)) return this.report(result, 'FAILED', 'Activity sync result is missing its native observations array.')
    const native = result.observations.find((observation) => observation.source)?.source ?? null
    const deviceId = capturedContext.deviceId ?? (native?.deviceId ? this.deps.resolveDeviceId(native.deviceId) : null)
    if (!isOpaqueJCVitalDeviceId(deviceId)) return this.report(result, 'SKIPPED', 'Opaque JCVital device ID unavailable.')
    const context: ActivityDeviceContext = {
      ownerUserId: owner,
      deviceId,
      deviceModel: native?.deviceModel ?? null,
      firmwareVersion: native?.firmwareVersion ?? capturedContext.firmwareVersion,
      sdkVersion: native?.sdkVersion ?? capturedContext.sdkVersion,
    }
    try {
      const scopeKey = `${owner}:${deviceId}`
      const ledger = await this.loadLedger(scopeKey)
      const canonical = await canonicalizeActivity(result.observations, context, ledger, this.now())
      if (canonical.sources.length) await this.deps.store?.write(scopeKey, canonical.ledger)
      this.ledger = canonical.ledger
      this.lastError = null
      return this.report(result, 'CANONICALIZED', null, {
        sourceRecords: canonical.sources.length,
        observations: canonical.observations.length,
        withheld: count(canonical.withheld.map((w) => w.reason)),
        outcomes: count(canonical.outcomes.map((o) => o.outcome)),
      })
    } catch (error) {
      return this.report(result, 'FAILED', error instanceof Error ? error.message : String(error))
    }
  }

  private async loadLedger(scopeKey: string): Promise<ActivityLedgerState> {
    if (this.ledger && this.ledgerScopeKey === scopeKey) return this.ledger
    const stored = await this.deps.store?.read(scopeKey) ?? null
    if (stored && stored.schema !== 'eliteplus.activity-canonical-ledger.v1') throw new Error('Unsupported Activity canonical ledger schema.')
    this.ledgerScopeKey = scopeKey
    this.ledger = stored?.schema === 'eliteplus.activity-canonical-ledger.v1' ? stored : emptyActivityLedger()
    return this.ledger
  }
}

/**
 * Hook for results that an existing acquisition path already returned (no new device command is issued).
 * The opaque source-journal device scope is used directly as the canonical device scope.
 */
export function canonicalizeAcquiredActivity(
  service: JCVitalActivityCanonicalization,
  scope: { accountId: string; deviceScopeId: string },
  connected: { firmwareVersion: string | null; sdkVersion: string | null },
  results: readonly JCVitalV8HistoricalSyncResult[],
): Promise<ActivityIngestReport[]> {
  service.setContext({ deviceId: scope.deviceScopeId, firmwareVersion: connected.firmwareVersion, sdkVersion: connected.sdkVersion })
  return service.ingestAll(results, scope.accountId)
}

async function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('Activity canonical ledger store is unavailable.')
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ACTIVITY_CANONICAL_LEDGER_STORE, 1)
    request.onupgradeneeded = () => request.result.createObjectStore('ledgers')
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Activity canonical ledger upgrade blocked.'))
  })
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve()
    transaction.onabort = () => reject(transaction.error ?? new Error('Activity canonical ledger transaction aborted.'))
    transaction.onerror = () => reject(transaction.error)
  })
}

/** Durable per-owner/device ledger in its own IndexedDB database; the observation queue schema is untouched. */
export const indexedDbActivityLedgerStore: ActivityLedgerStore = {
  async read(scopeKey) {
    const db = await database()
    try {
      const transaction = db.transaction('ledgers', 'readonly')
      const request = transaction.objectStore('ledgers').get(scopeKey)
      await committed(transaction)
      return (request.result as ActivityLedgerState | undefined) ?? null
    } finally { db.close() }
  },
  async write(scopeKey, state) {
    const db = await database()
    try {
      const transaction = db.transaction('ledgers', 'readwrite')
      transaction.objectStore('ledgers').put(state, scopeKey)
      await committed(transaction)
    } finally { db.close() }
  },
}
