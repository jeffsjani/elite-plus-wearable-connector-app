import type { NativeObservation } from '../../models/wearableObservation'
import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { AcquisitionQueueProvenance, QueueRecord, QueueStats, EnqueueResult } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import type {
  JCVitalV8ConnectionState,
  JCVitalV8HistoricalHrChunk,
  JCVitalV8HistoricalSyncLifecycleEvent,
  JCVitalV8HistoricalSyncResult,
  SourceJournalDiagnostics,
  SourceJournalScope,
} from './jcvitalV8Bridge'
import { HistoricalHrStreamCollector } from './HistoricalHrStream'
import { findPhysiologyContract, mapPhysiologyObservation, type PhysiologyMetricKey, type PhysiologySourceContext } from './PhysiologyContract'
import { ledgerSlotKey, type LedgerSlotKey, type ProductionSyncLedger } from './ProductionSyncLedger'
import { getQueueStore } from '../../services/storage/QueueStoreFactory'

/**
 * Build 32B — manual production V8 sync.
 *
 * READY → identity/scope validation → Type27 → Type68 → Type59 (strictly sequential, existing certified
 * native commands) → source journal (native, already bound at connect) → deterministic dedup → enqueue
 * of eligible new observations → existing durable sender → Base44 → result matching → ACK → purge.
 *
 * This module only orchestrates existing pieces. It never starts Type82/Activity/Sleep/Type42/PPI/Type29/
 * Raw PPG acquisition, never rewrites device timestamps and adds no background scheduling.
 */

export const PRODUCTION_SYNC_RECEIPT_SCHEMA = 'elite-plus.v8-production-sync-receipt.v2'
const LEGACY_PRODUCTION_SYNC_RECEIPT_SCHEMA = 'elite-plus.v8-production-sync-receipt.v1'
export const PRODUCTION_SYNC_RECEIPT_STORAGE_KEY = 'elitePlus.v8ProductionSyncReceipt.last.v1'
export const PRODUCTION_SYNC_FINAL_HR_CHUNK_WAIT_MS = 10_000

export type ProductionSyncSourceKey = 'HEART_RATE' | 'BLOOD_OXYGEN' | 'TEMPERATURE'
export type ProductionSyncMetric = 'heartRate' | 'oxygenSaturation' | 'wearableTemperature'
export type ProductionSyncMetricState =
  | 'NOT_REQUESTED'
  | 'REQUESTED'
  | 'BRIDGE_INVOKED'
  | 'COMMAND_QUEUED'
  | 'COMMAND_WRITTEN'
  | 'ACQUIRING'
  | 'SUCCESS'
  | 'NO_DATA'
  | 'FAILED'
  | 'SKIPPED'

export type ProductionSyncStage =
  | 'CHECKING'
  | 'READING_HEART_RATE'
  | 'READING_BLOOD_OXYGEN'
  | 'READING_TEMPERATURE'
  | 'SAVING'
  | 'DELIVERING'
  | 'UP_TO_DATE'
  | 'PARTIAL'
  | 'PENDING_DELIVERY'
  | 'BLOCKED'
  | 'FAILED'

/** Athlete-facing copy only; no vendor/type terminology. */
export const PRODUCTION_SYNC_STAGE_LABELS: Record<ProductionSyncStage, string> = {
  CHECKING: 'Checking your Elite+ V8…',
  READING_HEART_RATE: 'Reading Heart Rate from V8…',
  READING_BLOOD_OXYGEN: 'Reading Blood Oxygen from V8…',
  READING_TEMPERATURE: 'Reading Temperature from V8…',
  SAVING: 'Saved on this device',
  DELIVERING: 'Sending to Elite+…',
  UP_TO_DATE: 'Synced',
  PARTIAL: 'Could not sync',
  PENDING_DELIVERY: 'Saved on this device',
  BLOCKED: 'Could not sync',
  FAILED: 'Could not sync',
}

export type ProductionSyncOutcome = 'UP_TO_DATE' | 'PARTIAL' | 'PENDING_DELIVERY' | 'BLOCKED' | 'FAILED'

interface SourceDefinition {
  key: ProductionSyncSourceKey
  metric: ProductionSyncMetric
  stage: ProductionSyncStage
  contractKey: PhysiologyMetricKey
  vendorDataType: string
  nativeCommand: string
}

/** The only three sources in the first production sync cycle, in mandatory order. */
export const PRODUCTION_SYNC_SOURCES: readonly SourceDefinition[] = [
  { key: 'HEART_RATE', metric: 'heartRate', stage: 'READING_HEART_RATE', contractKey: 'heartRateHistory', vendorDataType: '27', nativeCommand: 'GetDynamicHRWithMode' },
  { key: 'BLOOD_OXYGEN', metric: 'oxygenSaturation', stage: 'READING_BLOOD_OXYGEN', contractKey: 'spo2', vendorDataType: '68', nativeCommand: 'Oxygen_data' },
  { key: 'TEMPERATURE', metric: 'wearableTemperature', stage: 'READING_TEMPERATURE', contractKey: 'wearableTemperature', vendorDataType: '59', nativeCommand: 'GetTemperature_historyData' },
]

export interface ProductionSyncError { stage: string; source: ProductionSyncSourceKey | null; code: string; message: string }

export interface ProductionSyncSourceReceipt {
  source: ProductionSyncSourceKey
  metric: ProductionSyncMetric
  vendorDataType: string
  nativeCommand: string
  requested: boolean
  status: ProductionSyncMetricState
  bridgeInvoked: boolean
  nativeRequestAccepted: boolean
  nativeCommandQueued: boolean
  nativeCommandWritten: boolean
  callbackReceived: boolean
  acquisitionCompleted: boolean
  acquisitionId: string | null
  acquisitionRequestId: string | null
  nativeSyncId: string | null
  connectionGeneration: number | null
  acquisitionStartedAt: string | null
  acquisitionCompletedAt: string | null
  clientQueuedAt: string | null
  observationProvenance: Record<string, AcquisitionQueueProvenance>
  sourceRecordCount: number
  observationCount: number
  mappedCount: number
  deduplicatedCount: number
  queuedCount: number
  deliveryPendingCount: number | null
  deliveredCount: number
  ackedCount: number
  duplicateAckedCount: number | null
  failedCount: number
  errorCode: string | null
  errorMessage: string | null
  skipReason: string | null
  startedAt: string | null
  completedAt: string | null
  nativeCompletionStatus: string | null
  recordGroupsReceived: number
  /** received = new + duplicate + rejected + noMeasurement */
  received: number
  new: number
  duplicate: number
  rejected: number
  noMeasurement: number
  parseErrors: number
  earliestDeviceTimestamp: string | null
  latestDeviceTimestamp: string | null
  latestObservedAt: string | null
  sourceEnvelopeIds: number
  error: ProductionSyncError | null
}

export interface ProductionSyncReceipt {
  schema: typeof PRODUCTION_SYNC_RECEIPT_SCHEMA
  syncId: string
  appVersion: string
  versionCode: number
  startedAt: string
  completedAt: string | null
  outcome: ProductionSyncOutcome | null
  overallState: ProductionSyncOutcome | null
  requestedMetrics: ProductionSyncMetric[]
  accountScope: {
    authenticatedOwnerUserId: string | null
    persistedConnectorOwnerUserId: string | null
    queueOwnerUserId: string | null
    journalScopeAccountId: string | null
    connectorDeviceId: string | null
    match: boolean
  }
  deviceScopeId: string | null
  physicalDevice: { bleDeviceId: string | null; name: string | null; firmwareVersion: string | null; sdkVersion: string | null; connectionState: string | null }
  sourceJournal: { enabled: boolean | null; failedClosed: boolean | null; totalEnvelopeCountBefore: number | null; totalEnvelopeCountAfter: number | null }
  sources: ProductionSyncSourceReceipt[]
  totals: { received: number; new: number; duplicate: number; rejected: number; noMeasurement: number; latestDeviceTimestamp: string | null }
  queueBefore: { pending: number; retrying: number; inFlight: number; failed: number; acknowledged: number } | null
  queue: { queued: number; newlyEnqueued: number; alreadyQueued: number; depthAfterSave: number | null; depthAfterDelivery: number | null }
  delivery: {
    attempted: boolean
    rounds: number
    attempts: number
    delivered: number
    serverAccepted: number
    serverDuplicate: number
    serverDuplicates: number
    serverRejected: number
    canonical: { canonicalized: number; notApplicable: number; failed: number; unreported: number }
    lastServerResult: string | null
    ackCount: number
    purgeCount: number
    unresolved: number
    pauseReason: string | null
  }
  errors: ProductionSyncError[]
  isolation: {
    nativeCommandsIssued: string[]
    backgroundScheduler: false
    observedAtRewritten: false
  }
}

export interface ProductionSyncOwners {
  authenticatedOwnerUserId: string | null
  persistedConnectorOwnerUserId: string | null
  connectorDeviceId: string | null
}

export interface ProductionSyncDevice {
  bleDeviceId: string | null
  name: string | null
  firmwareVersion: string | null
  sdkVersion: string | null
}

export interface ProductionSyncInput {
  appVersion: string
  versionCode: number
  owners: ProductionSyncOwners
  /** Scope returned by connectAndBindJournal for the current connection. */
  journalScope: SourceJournalScope | null
  device: ProductionSyncDevice
  /** Engineering-only selection; omitted means the full athlete production set. */
  metrics?: readonly ProductionSyncMetric[]
  onProgress?: (stage: ProductionSyncStage) => void
}

export interface ProductionSyncBridge {
  getConnectionState(): Promise<{ state: JCVitalV8ConnectionState; deviceId: string | null }>
  getSourceJournalDiagnostics(options: SourceJournalScope): Promise<SourceJournalDiagnostics>
  syncHistoricalHeartRate(options?: { maxValidSamples?: number }): Promise<JCVitalV8HistoricalSyncResult>
  ackHistoricalHrChunk(options: { syncSessionId: string; chunkIndex: number }): Promise<void>
  syncHistoricalSpo2(): Promise<JCVitalV8HistoricalSyncResult>
  syncHistoricalTemperature(): Promise<JCVitalV8HistoricalSyncResult>
  addListener(event: 'jcvitalHistoricalHrChunk', listener: (chunk: JCVitalV8HistoricalHrChunk) => void): Promise<{ remove: () => Promise<void> }>
  addListener(event: 'jcvitalHistoricalSyncLifecycle', listener: (event: JCVitalV8HistoricalSyncLifecycleEvent) => void): Promise<{ remove: () => Promise<void> }>
}

export interface ProductionSyncQueue {
  getOwnerUserId(): string | null
  enqueueMany(
    observations: NativeObservationInput[],
    sourceEnvelopeIds?: ReadonlyMap<string, string>,
    provenanceByObservationId?: ReadonlyMap<string, AcquisitionQueueProvenance>,
  ): Promise<EnqueueResult[]>
  getRecord(observationId: string): Promise<QueueRecord | null>
  getQueueStats(): Promise<QueueStats>
  updateAcquisitionProvenance(provenanceByObservationId: ReadonlyMap<string, AcquisitionQueueProvenance>): Promise<number>
}

export interface ProductionSyncDelivery {
  process(): Promise<unknown>
  subscribe(listener: (event: BatchDeliveryEvent) => void): () => void
  getDeliveryDiagnostics(): { activeWorkerCount: number; pauseReason?: string | null }
}

export interface ProductionSyncDependencies {
  bridge: ProductionSyncBridge
  queue: ProductionSyncQueue
  delivery: ProductionSyncDelivery
  ledger: ProductionSyncLedger
  resolveDeviceScopeId(bleDeviceId: string): string
  now?: () => Date
  createId?: () => string
  sleep?: (ms: number) => Promise<void>
  finalHrChunkWaitMs?: number
  deliveryPollMs?: number
  deliveryDeadlineMs?: number
  maxDeliveryRounds?: number
  /** Purge verification reads individual rows only up to this many IDs; above it queue stats are used. */
  purgeVerifyLimit?: number
  allowMetricSubset?: boolean
  storeReceipt?: (receipt: ProductionSyncReceipt) => void | Promise<void>
}

class BlockedError extends Error {
  readonly code: string
  constructor(code: string, message: string) { super(message); this.code = code }
}

function errorCode(error: unknown, fallback: string): string {
  const code = (error as { code?: unknown } | null)?.code
  return typeof code === 'string' && code ? code : fallback
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function isHardStopError(error: unknown): boolean {
  const code = errorCode(error, '')
  const message = errorMessage(error).toUpperCase()
  return code.startsWith('QUEUE_')
    || ['DEVICE_NOT_READY', 'DEVICE_IDENTITY_MISSING', 'DEVICE_IDENTITY_MISMATCH', 'DEVICE_SCOPE_MISMATCH', 'OWNER_MISMATCH'].includes(code)
    || ['JOURNAL_FAILED_CLOSED', 'SCOPE_NOT_CONFIGURED', 'JOURNAL_UNBOUND', 'OWNER_MISMATCH', 'IDENTITY_MISMATCH'].some((marker) => message.includes(marker))
}

function emptySourceReceipt(definition: SourceDefinition): ProductionSyncSourceReceipt {
  return {
    source: definition.key, vendorDataType: definition.vendorDataType, nativeCommand: definition.nativeCommand,
    metric: definition.metric, requested: false, status: 'NOT_REQUESTED',
    bridgeInvoked: false, nativeRequestAccepted: false, nativeCommandQueued: false, nativeCommandWritten: false,
    callbackReceived: false, acquisitionCompleted: false, sourceRecordCount: 0, observationCount: 0,
    acquisitionId: null, acquisitionRequestId: null, nativeSyncId: null, connectionGeneration: null,
    acquisitionStartedAt: null, acquisitionCompletedAt: null, clientQueuedAt: null, observationProvenance: {},
    mappedCount: 0, deduplicatedCount: 0, queuedCount: 0, deliveryPendingCount: 0, deliveredCount: 0,
    ackedCount: 0, duplicateAckedCount: 0, failedCount: 0,
    errorCode: null, errorMessage: null, skipReason: null,
    startedAt: null, completedAt: null, nativeCompletionStatus: null, recordGroupsReceived: 0,
    received: 0, new: 0, duplicate: 0, rejected: 0, noMeasurement: 0, parseErrors: 0,
    earliestDeviceTimestamp: null, latestDeviceTimestamp: null, sourceEnvelopeIds: 0, error: null,
    latestObservedAt: null,
  }
}

function laterIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) > Date.parse(a) ? b : a
}
function earlierIso(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  return Date.parse(b) < Date.parse(a) ? b : a
}

export async function storeProductionSyncReceipt(receipt: ProductionSyncReceipt): Promise<void> {
  const ownerUserId = receipt.accountScope.authenticatedOwnerUserId
    ?? receipt.accountScope.persistedConnectorOwnerUserId
    ?? receipt.accountScope.queueOwnerUserId
  if (!ownerUserId) throw new Error('Cannot durably store a production sync receipt without an account owner.')
  const store = getQueueStore()
  await store.initialize()
  await store.saveProductionSyncReceipt({
    ownerUserId,
    syncId: receipt.syncId,
    startedAt: receipt.startedAt,
    completedAt: receipt.completedAt,
    overallState: receipt.overallState ?? 'IN_PROGRESS',
    requestedMetricsJson: JSON.stringify(receipt.requestedMetrics),
    receiptJson: JSON.stringify(receipt),
  })
}

export async function loadProductionSyncReceipt(ownerUserId: string): Promise<ProductionSyncReceipt | null> {
  const store = getQueueStore()
  await store.initialize()
  const stored = await store.loadLatestProductionSyncReceipt(ownerUserId)
  if (stored === null) return null
  const parsed = JSON.parse(stored) as Omit<ProductionSyncReceipt, 'schema'> & { schema: string }
  if ((parsed?.schema !== PRODUCTION_SYNC_RECEIPT_SCHEMA && parsed?.schema !== LEGACY_PRODUCTION_SYNC_RECEIPT_SCHEMA)
    || !Array.isArray(parsed.sources) || !Array.isArray(parsed.requestedMetrics)) {
    throw new Error('The saved production sync receipt has an unsupported or invalid format.')
  }
  if (parsed.schema === LEGACY_PRODUCTION_SYNC_RECEIPT_SCHEMA) {
    return {
      ...parsed,
      schema: PRODUCTION_SYNC_RECEIPT_SCHEMA,
      sources: parsed.sources.map((source) => ({
        ...source,
        requested: parsed.requestedMetrics.includes(source.metric),
        acquisitionId: null,
        acquisitionRequestId: null,
        nativeSyncId: null,
        connectionGeneration: null,
        acquisitionStartedAt: source.startedAt ?? null,
        acquisitionCompletedAt: source.completedAt ?? null,
        clientQueuedAt: null,
        observationProvenance: {},
        deliveryPendingCount: null,
        duplicateAckedCount: null,
      })),
    }
  }
  return { ...parsed, schema: PRODUCTION_SYNC_RECEIPT_SCHEMA }
}

export function productionSyncReceiptFilename(receipt: Pick<ProductionSyncReceipt, 'syncId'>): string {
  return `elite-plus-v8-sync-receipt-${receipt.syncId}.json`
}

export class ProductionV8Sync {
  private readonly deps: Required<Omit<ProductionSyncDependencies, 'storeReceipt'>> & Pick<ProductionSyncDependencies, 'storeReceipt'>
  private running = false

  constructor(deps: ProductionSyncDependencies) {
    this.deps = {
      now: () => new Date(),
      createId: () => crypto.randomUUID(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      finalHrChunkWaitMs: PRODUCTION_SYNC_FINAL_HR_CHUNK_WAIT_MS,
      deliveryPollMs: 250,
      deliveryDeadlineMs: 5 * 60_000,
      maxDeliveryRounds: 500,
      purgeVerifyLimit: 500,
      allowMetricSubset: false,
      ...deps,
    }
  }

  isRunning(): boolean { return this.running }

  async run(input: ProductionSyncInput): Promise<ProductionSyncReceipt> {
    if (this.running) throw new BlockedError('SYNC_ALREADY_RUNNING', 'A device sync is already running.')
    this.running = true
    try {
      const metrics = input.metrics === undefined ? PRODUCTION_SYNC_SOURCES.map(({ metric }) => metric) : [...input.metrics]
      const known = new Set(PRODUCTION_SYNC_SOURCES.map(({ metric }) => metric))
      if (metrics.length === 0 || metrics.some((metric) => !known.has(metric)) || new Set(metrics).size !== metrics.length) {
        throw new BlockedError('INVALID_METRIC_SELECTION', 'Production sync metric selection is invalid.')
      }
      const defaultMetrics = PRODUCTION_SYNC_SOURCES.map(({ metric }) => metric)
      if (input.metrics !== undefined && (metrics.length !== defaultMetrics.length || metrics.some((metric, index) => metric !== defaultMetrics[index])) && !this.deps.allowMetricSubset) {
        throw new BlockedError('ENGINEERING_SUBSET_DISABLED', 'Metric-scoped production sync is available only in Engineering mode.')
      }
      return await this.execute({ ...input, metrics })
    } finally { this.running = false }
  }

  private iso(): string { return this.deps.now().toISOString() }

  private async execute(input: ProductionSyncInput): Promise<ProductionSyncReceipt> {
    const { bridge, queue } = this.deps
    const requestedMetrics = input.metrics ?? PRODUCTION_SYNC_SOURCES.map(({ metric }) => metric)
    const requested = new Set(requestedMetrics)
    const progress = (stage: ProductionSyncStage) => { try { input.onProgress?.(stage) } catch { /* UI callback must not break sync */ } }
    const receipt: ProductionSyncReceipt = {
      schema: PRODUCTION_SYNC_RECEIPT_SCHEMA,
      syncId: this.deps.createId(),
      appVersion: input.appVersion,
      versionCode: input.versionCode,
      startedAt: this.iso(),
      completedAt: null,
      outcome: null,
      overallState: null,
      requestedMetrics: [...requestedMetrics],
      accountScope: {
        authenticatedOwnerUserId: input.owners.authenticatedOwnerUserId,
        persistedConnectorOwnerUserId: input.owners.persistedConnectorOwnerUserId,
        queueOwnerUserId: queue.getOwnerUserId(),
        journalScopeAccountId: input.journalScope?.accountId ?? null,
        connectorDeviceId: input.owners.connectorDeviceId,
        match: false,
      },
      deviceScopeId: input.journalScope?.deviceScopeId ?? null,
      physicalDevice: { bleDeviceId: input.device.bleDeviceId, name: input.device.name, firmwareVersion: input.device.firmwareVersion, sdkVersion: input.device.sdkVersion, connectionState: null },
      sourceJournal: { enabled: null, failedClosed: null, totalEnvelopeCountBefore: null, totalEnvelopeCountAfter: null },
      sources: PRODUCTION_SYNC_SOURCES.map(emptySourceReceipt),
      totals: { received: 0, new: 0, duplicate: 0, rejected: 0, noMeasurement: 0, latestDeviceTimestamp: null },
      queueBefore: null,
      queue: { queued: 0, newlyEnqueued: 0, alreadyQueued: 0, depthAfterSave: null, depthAfterDelivery: null },
      delivery: {
        attempted: false, rounds: 0, attempts: 0, delivered: 0, serverAccepted: 0, serverDuplicate: 0, serverDuplicates: 0, serverRejected: 0,
        canonical: { canonicalized: 0, notApplicable: 0, failed: 0, unreported: 0 }, lastServerResult: null,
        ackCount: 0, purgeCount: 0, unresolved: 0, pauseReason: null,
      },
      errors: [],
      isolation: { nativeCommandsIssued: [], backgroundScheduler: false, observedAtRewritten: false },
    }
    for (const source of receipt.sources) if (requested.has(source.metric)) {
      source.requested = true
      source.status = 'REQUESTED'
    }
    const persist = async (snapshot: ProductionSyncReceipt = receipt): Promise<void> => {
      if (!this.deps.storeReceipt) return
      try {
        await this.deps.storeReceipt(snapshot)
      } catch (error) {
        if (!receipt.errors.some((entry) => entry.code === 'RECEIPT_PERSIST_FAILED')) {
          receipt.errors.push({ stage: 'RECEIPT', source: null, code: 'RECEIPT_PERSIST_FAILED', message: errorMessage(error) })
        }
      }
    }
    const finish = async (initialOutcome: ProductionSyncOutcome): Promise<ProductionSyncReceipt> => {
      receipt.outcome = receipt.errors.some((entry) => entry.code === 'RECEIPT_PERSIST_FAILED') ? 'PARTIAL' : initialOutcome
      receipt.overallState = receipt.outcome
      receipt.completedAt = this.iso()
      progress(receipt.outcome)
      await persist()
      if (receipt.errors.some((entry) => entry.code === 'RECEIPT_PERSIST_FAILED') && receipt.outcome !== 'PARTIAL') {
        receipt.outcome = 'PARTIAL'
        receipt.overallState = 'PARTIAL'
        progress('PARTIAL')
        await persist()
      }
      return receipt
    }

    await persist()
    progress('CHECKING')
    let context: { owner: string; scope: SourceJournalScope; source: PhysiologySourceContext }
    try {
      context = await this.preflight(input, receipt)
    } catch (error) {
      receipt.errors.push({ stage: 'PREFLIGHT', source: null, code: errorCode(error, 'PREFLIGHT_FAILED'), message: errorMessage(error) })
      await persist()
      return finish('BLOCKED')
    }
    await persist()

    try {
      const stats = await queue.getQueueStats()
      receipt.queueBefore = {
        pending: stats.pending,
        retrying: stats.retrying,
        inFlight: stats.inFlight,
        failed: stats.failed,
        acknowledged: stats.acknowledged,
      }
    } catch (error) {
      receipt.errors.push({ stage: 'QUEUE_SNAPSHOT', source: null, code: errorCode(error, 'QUEUE_STATS_FAILED'), message: errorMessage(error) })
    }

    const newIds = new Set<string>()
    const sourceByObservationId = new Map<string, ProductionSyncSourceKey>()
    const seenThisSync = new Set<string>()
    let hardStopReason: string | null = null
    for (const [index, definition] of PRODUCTION_SYNC_SOURCES.entries()) {
      const sourceReceipt = receipt.sources[index]
      if (!requested.has(definition.metric)) continue
      if (hardStopReason) {
        sourceReceipt.status = 'SKIPPED'
        sourceReceipt.skipReason = hardStopReason
        sourceReceipt.errorCode = 'HARD_STOP'
        sourceReceipt.errorMessage = hardStopReason
        sourceReceipt.error = { stage: 'ACQUISITION', source: definition.key, code: 'HARD_STOP', message: hardStopReason }
        receipt.errors.push(sourceReceipt.error)
        await persist()
        continue
      }
      progress(definition.stage)
      try {
        const connection = await bridge.getConnectionState()
        if (connection.state !== 'READY' || (input.device.bleDeviceId && connection.deviceId && connection.deviceId !== input.device.bleDeviceId)) {
          throw new BlockedError('DEVICE_NOT_READY', `Elite+ V8 is ${connection.state}; remaining sources were not read.`)
        }
      } catch (error) {
        sourceReceipt.status = 'SKIPPED'
        sourceReceipt.skipReason = errorMessage(error)
        sourceReceipt.errorCode = errorCode(error, 'DEVICE_NOT_READY')
        sourceReceipt.errorMessage = errorMessage(error)
        sourceReceipt.error = { stage: 'ACQUISITION', source: definition.key, code: errorCode(error, 'DEVICE_NOT_READY'), message: errorMessage(error) }
        receipt.errors.push(sourceReceipt.error)
        hardStopReason = sourceReceipt.skipReason
        await persist()
        continue
      }
      sourceReceipt.startedAt = this.iso()
      sourceReceipt.acquisitionId = this.deps.createId()
      sourceReceipt.acquisitionRequestId = this.deps.createId()
      sourceReceipt.acquisitionStartedAt = sourceReceipt.startedAt
      sourceReceipt.status = 'BRIDGE_INVOKED'
      sourceReceipt.bridgeInvoked = true
      await persist()
      try {
        await this.acquire(definition, sourceReceipt, receipt, context, newIds, seenThisSync, sourceByObservationId, persist)
      } catch (error) {
        sourceReceipt.status = 'FAILED'
        sourceReceipt.errorCode = errorCode(error, 'SOURCE_FAILED')
        sourceReceipt.errorMessage = errorMessage(error)
        sourceReceipt.error = { stage: 'ACQUISITION', source: definition.key, code: errorCode(error, 'SOURCE_FAILED'), message: errorMessage(error) }
        receipt.errors.push(sourceReceipt.error)
        if (isHardStopError(error)) hardStopReason = sourceReceipt.errorMessage
      }
      sourceReceipt.completedAt = this.iso()
      sourceReceipt.acquisitionCompletedAt = sourceReceipt.completedAt
      if (Object.keys(sourceReceipt.observationProvenance).length) {
        const completedProvenance = new Map(Object.entries(sourceReceipt.observationProvenance).map(([observationId, provenance]) => [
          observationId,
          {
            ...provenance,
            acquisitionRequestId: sourceReceipt.acquisitionRequestId!,
            connectionGeneration: sourceReceipt.connectionGeneration,
            acquisitionCompletedAt: sourceReceipt.acquisitionCompletedAt!,
          },
        ]))
        try {
          const updated = await queue.updateAcquisitionProvenance(completedProvenance)
          if (updated !== completedProvenance.size) throw new Error(`Updated ${updated} of ${completedProvenance.size} queue provenance rows.`)
          sourceReceipt.observationProvenance = Object.fromEntries(completedProvenance)
        } catch (error) {
          sourceReceipt.errorCode ??= 'PROVENANCE_PERSIST_FAILED'
          sourceReceipt.errorMessage ??= errorMessage(error)
          const provenanceError = {
            stage: 'PROVENANCE', source: definition.key, code: 'PROVENANCE_PERSIST_FAILED',
            message: `Acquisition provenance could not be finalized in the durable queue: ${errorMessage(error)}`,
          }
          sourceReceipt.error = provenanceError
          receipt.errors.push(provenanceError)
        }
      }
      await persist()
    }
    for (const source of receipt.sources) {
      if (!requested.has(source.metric)) continue
      receipt.totals.received += source.received
      receipt.totals.new += source.new
      receipt.totals.duplicate += source.duplicate
      receipt.totals.rejected += source.rejected
      receipt.totals.noMeasurement += source.noMeasurement
      receipt.totals.latestDeviceTimestamp = laterIso(receipt.totals.latestDeviceTimestamp, source.latestDeviceTimestamp)
    }

    progress('SAVING')
    try {
      const stats = await queue.getQueueStats()
      receipt.queue.depthAfterSave = stats.pending + stats.retrying + stats.inFlight
      const after = await bridge.getSourceJournalDiagnostics(context.scope)
      receipt.sourceJournal.totalEnvelopeCountAfter = after.totalEnvelopeCount
    } catch (error) {
      receipt.errors.push({ stage: 'SAVE_VERIFY', source: null, code: errorCode(error, 'SAVE_VERIFY_FAILED'), message: errorMessage(error) })
    }

    progress('DELIVERING')
    await this.deliver(receipt, newIds, sourceByObservationId, context.owner)
    await persist()

    const requestedSources = receipt.sources.filter((source) => requested.has(source.metric))
    const sourceProblem = requestedSources.some((source) => source.status !== 'SUCCESS' && source.status !== 'NO_DATA')
    const allFailed = requestedSources.every((source) => source.status === 'FAILED' || source.status === 'SKIPPED')
    if (allFailed) return finish('FAILED')
    if (sourceProblem || receipt.errors.some((error) => error.stage === 'PROVENANCE')
      || receipt.delivery.serverRejected > 0 || receipt.delivery.canonical.failed > 0) return finish('PARTIAL')
    if (receipt.delivery.unresolved > 0) return finish('PENDING_DELIVERY')
    return finish('UP_TO_DATE')
  }

  private async preflight(input: ProductionSyncInput, receipt: ProductionSyncReceipt): Promise<{ owner: string; scope: SourceJournalScope; source: PhysiologySourceContext }> {
    const { bridge, queue } = this.deps
    const connection = await bridge.getConnectionState()
    receipt.physicalDevice.connectionState = connection.state
    if (connection.state !== 'READY') throw new BlockedError('DEVICE_NOT_READY', 'Connect your Elite+ V8 before syncing.')
    const bleDeviceId = input.device.bleDeviceId ?? connection.deviceId
    if (!bleDeviceId) throw new BlockedError('DEVICE_IDENTITY_MISSING', 'Connected device identity is unavailable.')
    if (connection.deviceId && connection.deviceId !== bleDeviceId) throw new BlockedError('DEVICE_IDENTITY_MISMATCH', 'Connected device differs from the device bound for this session.')
    receipt.physicalDevice.bleDeviceId = bleDeviceId

    const owners = input.owners
    const authenticated = owners.authenticatedOwnerUserId
    if (!authenticated) throw new BlockedError('NOT_AUTHENTICATED', 'Sign in before syncing.')
    if (!owners.connectorDeviceId) throw new BlockedError('CONNECTOR_NOT_REGISTERED', 'Connector registration is required before syncing.')
    const scope = input.journalScope
    if (!scope) throw new BlockedError('SCOPE_NOT_CONFIGURED', 'No source journal scope is bound for this connection.')
    const queueOwner = queue.getOwnerUserId()
    const persisted = owners.persistedConnectorOwnerUserId
    const mismatches = [
      persisted !== authenticated && `persisted Connector owner (${persisted ?? 'none'})`,
      queueOwner !== authenticated && `durable queue owner (${queueOwner ?? 'none'})`,
      scope.accountId !== authenticated && `journal scope owner (${scope.accountId})`,
    ].filter(Boolean)
    if (mismatches.length) throw new BlockedError('OWNER_MISMATCH', `Account scope mismatch: ${mismatches.join(', ')} ≠ authenticated owner. Sync blocked; nothing was migrated.`)

    const expectedScopeId = this.deps.resolveDeviceScopeId(bleDeviceId)
    if (scope.deviceScopeId !== expectedScopeId) throw new BlockedError('DEVICE_SCOPE_MISMATCH', 'Journal device scope does not match the connected Elite+ V8.')
    // Throws OWNER_MISMATCH / SCOPE_NOT_CONFIGURED when the native active journal scope differs.
    const journal = await bridge.getSourceJournalDiagnostics(scope)
    receipt.sourceJournal.enabled = journal.enabled
    receipt.sourceJournal.failedClosed = journal.failedClosed
    receipt.sourceJournal.totalEnvelopeCountBefore = journal.totalEnvelopeCount
    if (!journal.enabled || journal.failedClosed) throw new BlockedError('SOURCE_JOURNAL_UNAVAILABLE', 'Source journal is not accepting evidence; sync blocked to preserve source records.')
    receipt.accountScope.match = true
    return {
      owner: authenticated,
      scope,
      source: { deviceId: scope.deviceScopeId, firmwareVersion: input.device.firmwareVersion, sdkVersion: input.device.sdkVersion },
    }
  }

  private async acquire(
    definition: SourceDefinition,
    sourceReceipt: ProductionSyncSourceReceipt,
    receipt: ProductionSyncReceipt,
    context: { owner: string; scope: SourceJournalScope; source: PhysiologySourceContext },
    newIds: Set<string>,
    seenThisSync: Set<string>,
    sourceByObservationId: Map<string, ProductionSyncSourceKey>,
    persist: (snapshot?: ProductionSyncReceipt) => Promise<void>,
  ): Promise<void> {
    const { bridge } = this.deps
    receipt.isolation.nativeCommandsIssued.push(definition.nativeCommand)
    let lifecycleHandle: { remove: () => Promise<void> } | null = null
    let lifecycleWrites = Promise.resolve()
    try {
      lifecycleHandle = await bridge.addListener('jcvitalHistoricalSyncLifecycle', (event) => {
        if (event.vendorDataType !== definition.vendorDataType) return
        sourceReceipt.nativeRequestAccepted ||= event.nativeRequestAccepted
        sourceReceipt.nativeSyncId = event.syncId
        sourceReceipt.acquisitionRequestId = event.syncId
        sourceReceipt.connectionGeneration = event.connectionGeneration
        sourceReceipt.nativeCommandQueued ||= event.nativeCommandQueued
        sourceReceipt.nativeCommandWritten ||= event.nativeCommandWritten
        if (event.stage === 'NATIVE_COMMAND_QUEUED') sourceReceipt.status = 'COMMAND_QUEUED'
        else if (event.stage === 'NATIVE_COMMAND_WRITTEN') sourceReceipt.status = 'COMMAND_WRITTEN'
        else if (event.stage === 'ACQUIRING') sourceReceipt.status = 'ACQUIRING'
        else if (event.stage === 'FAILED') {
          sourceReceipt.status = 'FAILED'
          sourceReceipt.errorCode ??= 'NATIVE_COMMAND_WRITE_FAILED'
          sourceReceipt.errorMessage ??= 'Native command write was not acknowledged.'
        }
        const snapshot = JSON.parse(JSON.stringify(receipt)) as ProductionSyncReceipt
        lifecycleWrites = lifecycleWrites.then(() => persist(snapshot))
      })
    } catch (error) {
      receipt.errors.push({ stage: 'LIFECYCLE_LISTENER', source: definition.key, code: errorCode(error, 'LIFECYCLE_LISTENER_FAILED'), message: errorMessage(error) })
    }
    let result: JCVitalV8HistoricalSyncResult
    try {
      if (definition.key === 'HEART_RATE') {
        const collector = new HistoricalHrStreamCollector()
        let work: Promise<void> = Promise.resolve()
        let workError: unknown = null
        const handle = await bridge.addListener('jcvitalHistoricalHrChunk', (chunk) => {
          const observations = collector.accept(chunk)
          if (observations === null) return
          work = work
            .then(() => workError ? undefined : this.persistObservations(definition, observations, sourceReceipt, receipt, context, newIds, seenThisSync, sourceByObservationId))
            .catch((error) => { workError ??= error })
            .finally(() => bridge.ackHistoricalHrChunk({ syncSessionId: chunk.syncSessionId, chunkIndex: chunk.chunkIndex }).catch(() => undefined))
        })
        try {
          result = await bridge.syncHistoricalHeartRate({})
          sourceReceipt.callbackReceived = true
          sourceReceipt.acquisitionCompleted = true
          if (result.stream && result.stream.chunkCount > 0) await collector.waitForFinal(this.deps.finalHrChunkWaitMs)
          await work
        } finally {
          await handle.remove().catch(() => undefined)
        }
        if (workError) throw workError
        if (!result.streamed && result.observations?.length) {
          await this.persistObservations(definition, result.observations, sourceReceipt, receipt, context, newIds, seenThisSync, sourceByObservationId)
        }
        sourceReceipt.parseErrors += result.stream?.parseErrorCount ?? result.parseErrors.length
        if (result.stream && result.stream.chunkCount > 0 && !collector.summary().finalReceived) {
          sourceReceipt.errorCode = 'HR_FINAL_CHUNK_MISSING'
          sourceReceipt.errorMessage = 'Final heart-rate chunk was not received; some history may remain on the device.'
          sourceReceipt.error = { stage: 'ACQUISITION', source: definition.key, code: sourceReceipt.errorCode, message: sourceReceipt.errorMessage }
          receipt.errors.push(sourceReceipt.error)
          sourceReceipt.status = 'FAILED'
        }
      } else {
        result = definition.key === 'BLOOD_OXYGEN' ? await bridge.syncHistoricalSpo2() : await bridge.syncHistoricalTemperature()
        sourceReceipt.callbackReceived = true
        sourceReceipt.acquisitionCompleted = true
        sourceReceipt.parseErrors += result.parseErrors.length
        await this.persistObservations(definition, result.observations ?? [], sourceReceipt, receipt, context, newIds, seenThisSync, sourceByObservationId)
      }
    } finally {
      await lifecycleHandle?.remove().catch(() => undefined)
      await lifecycleWrites
    }
    if (sourceReceipt.nativeSyncId && sourceReceipt.nativeSyncId !== result.syncId) {
      throw new Error(`Native lifecycle request ${sourceReceipt.nativeSyncId} did not match completed request ${result.syncId}.`)
    }
    sourceReceipt.nativeRequestAccepted ||= result.nativeRequestAccepted ?? false
    sourceReceipt.nativeSyncId ??= result.syncId
    sourceReceipt.acquisitionRequestId = result.syncId
    sourceReceipt.nativeCommandQueued ||= result.nativeCommandQueued ?? false
    sourceReceipt.nativeCommandWritten ||= result.nativeCommandWritten ?? false
    sourceReceipt.acquisitionCompleted = true
    sourceReceipt.received += sourceReceipt.parseErrors
    sourceReceipt.rejected += sourceReceipt.parseErrors
    sourceReceipt.recordGroupsReceived = result.recordGroupsReceived
    sourceReceipt.sourceRecordCount = result.recordGroupsReceived
    sourceReceipt.nativeCompletionStatus = result.completionStatus
    sourceReceipt.sourceEnvelopeIds = result.sourceRecordEnvelopeIds?.length ?? 0
    sourceReceipt.earliestDeviceTimestamp = earlierIso(sourceReceipt.earliestDeviceTimestamp, result.earliestObservation)
    sourceReceipt.latestDeviceTimestamp = laterIso(sourceReceipt.latestDeviceTimestamp, result.latestObservation)
    sourceReceipt.latestObservedAt = sourceReceipt.latestDeviceTimestamp
    if (sourceReceipt.status !== 'FAILED') {
      const completedNormally = (result.completionStatus === 'COMPLETE' || result.completionStatus === 'EMPTY_VALID')
        && !result.partial
      const lifecycleCompleted = sourceReceipt.nativeRequestAccepted && sourceReceipt.nativeCommandWritten
        && sourceReceipt.callbackReceived && sourceReceipt.acquisitionCompleted
      const validNoData = result.completionStatus === 'EMPTY_VALID' && sourceReceipt.sourceRecordCount === 0
        && sourceReceipt.observationCount === 0 && sourceReceipt.parseErrors === 0
      sourceReceipt.status = !completedNormally || !lifecycleCompleted
        ? 'FAILED'
        : validNoData ? 'NO_DATA'
          : sourceReceipt.observationCount > 0 ? 'SUCCESS' : 'FAILED'
      if (sourceReceipt.status === 'FAILED') {
        sourceReceipt.errorCode ??= `SOURCE_${result.completionStatus}`
        sourceReceipt.errorMessage ??= `Acquisition completed without a valid data result (${result.completionStatus}).`
        sourceReceipt.error = { stage: 'ACQUISITION', source: definition.key, code: sourceReceipt.errorCode, message: sourceReceipt.errorMessage }
        receipt.errors.push(sourceReceipt.error)
      }
    }
    if (sourceReceipt.status === 'FAILED') {
      sourceReceipt.errorCode ??= 'SOURCE_FAILED'
      sourceReceipt.errorMessage ??= 'Native acquisition failed.'
    }
    await persist()
  }

  /** Maps with the existing contract, classifies new vs duplicate and enqueues only eligible new rows. */
  private async persistObservations(
    definition: SourceDefinition,
    natives: NativeObservation[],
    sourceReceipt: ProductionSyncSourceReceipt,
    receipt: ProductionSyncReceipt,
    context: { owner: string; scope: SourceJournalScope; source: PhysiologySourceContext },
    newIds: Set<string>,
    seenThisSync: Set<string>,
    sourceByObservationId: Map<string, ProductionSyncSourceKey>,
  ): Promise<void> {
    const { ledger, queue } = this.deps
    const candidates: Array<{ observation: NativeObservationInput; slot: LedgerSlotKey }> = []
    const envelopes = new Map<string, string>()
    for (const native of natives) {
      sourceReceipt.received++
      sourceReceipt.observationCount++
      if (native.observedAt && !Number.isNaN(Date.parse(native.observedAt))) {
        sourceReceipt.earliestDeviceTimestamp = earlierIso(sourceReceipt.earliestDeviceTimestamp, native.observedAt)
        sourceReceipt.latestDeviceTimestamp = laterIso(sourceReceipt.latestDeviceTimestamp, native.observedAt)
        sourceReceipt.latestObservedAt = sourceReceipt.latestDeviceTimestamp
      }
      const contract = findPhysiologyContract(native)
      if (!contract || contract.key !== definition.contractKey) { sourceReceipt.rejected++; continue }
      const outcomes = await mapPhysiologyObservation(context.owner, native, context.source, contract)
      // Non-PPI contracts map one native record to exactly one slot.
      const outcome = outcomes[0]
      if (outcome?.status === 'NOT_DELIVERABLE') { sourceReceipt.noMeasurement++; continue }
      if (outcome?.status !== 'MAPPED') { sourceReceipt.rejected++; continue }
      sourceReceipt.mappedCount++
      const slot = ledgerSlotKey(outcome.observation)
      if (!slot) { sourceReceipt.rejected++; continue }
      if (seenThisSync.has(outcome.observation.observationId) || ledger.has(context.owner, context.scope.deviceScopeId, slot)) {
        sourceReceipt.duplicate++
        sourceReceipt.deduplicatedCount++
        continue
      }
      seenThisSync.add(outcome.observation.observationId)
      candidates.push({ observation: outcome.observation, slot })
      if (outcome.sourceEnvelopeId) envelopes.set(outcome.observation.observationId, outcome.sourceEnvelopeId)
    }
    if (!candidates.length) return
    if (queue.getOwnerUserId() !== context.owner) throw new BlockedError('QUEUE_OWNER_CHANGED', 'Account changed during sync; nothing further was saved.')
    const queuedAt = this.iso()
    const provenanceById = new Map(candidates.map(({ observation }) => [observation.observationId, {
      syncId: receipt.syncId,
      acquisitionId: sourceReceipt.acquisitionId!,
      acquisitionRequestId: sourceReceipt.acquisitionRequestId!,
      requestedMetric: definition.metric,
      connectionGeneration: sourceReceipt.connectionGeneration,
      acquisitionStartedAt: sourceReceipt.acquisitionStartedAt!,
      acquisitionCompletedAt: null,
      clientQueuedAt: queuedAt,
    } satisfies AcquisitionQueueProvenance]))
    const results = await queue.enqueueMany(candidates.map((candidate) => candidate.observation), envelopes, provenanceById)
    for (const result of results) {
      if (result.inserted) {
        sourceReceipt.new++
        sourceReceipt.queuedCount++
        receipt.queue.queued++
        receipt.queue.newlyEnqueued++
        newIds.add(result.record.observationId)
        sourceByObservationId.set(result.record.observationId, definition.key)
        sourceReceipt.observationProvenance[result.record.observationId] = provenanceById.get(result.record.observationId)!
        sourceReceipt.clientQueuedAt ??= queuedAt
      } else {
        sourceReceipt.duplicate++
        sourceReceipt.deduplicatedCount++
        receipt.queue.alreadyQueued++
      }
    }
    ledger.record(context.owner, context.scope.deviceScopeId, candidates.map((candidate) => candidate.slot))
  }

  private async deliver(
    receipt: ProductionSyncReceipt,
    tracked: Set<string>,
    sourceByObservationId: Map<string, ProductionSyncSourceKey>,
    owner: string,
  ): Promise<void> {
    const { delivery, queue } = this.deps
    const delivered = new Set<string>()
    const acknowledged = new Set<string>()
    const rejected = new Set<string>()
    const canonicalFailed = new Set<string>()
    const canonical = new Map<string, string>()
    const accepted = new Set<string>()
    const duplicate = new Set<string>()
    const duplicateAcknowledged = new Set<string>()
    const unsubscribe = delivery.subscribe((event) => {
      if (event.accepted !== null || event.duplicate !== null || event.rejected !== null) {
        receipt.delivery.lastServerResult = `Accepted ${event.accepted ?? 0}, duplicate ${event.duplicate ?? 0}, rejected ${event.rejected ?? 0}`
      }
      for (const result of event.results ?? []) {
        if (!tracked.has(result.observationId)) continue
        delivered.add(result.observationId)
        if (result.status === 'accepted') { accepted.add(result.observationId); canonical.set(result.observationId, result.canonicalStatus ?? 'unreported') }
        if (result.status === 'duplicate') {
          duplicate.add(result.observationId)
          duplicateAcknowledged.add(result.observationId)
        }
        if (result.status === 'rejected') rejected.add(result.observationId)
      }
      for (const id of event.rejectedIds) if (tracked.has(id)) rejected.add(id)
      for (const id of event.acknowledgedIds) if (tracked.has(id)) acknowledged.add(id)
      for (const id of event.canonicalFailedIds ?? []) if (tracked.has(id)) canonicalFailed.add(id)
      if ((event.outcome === 'RETRYING' || event.outcome === 'FAILED') && event.observationIds.some((id) => tracked.has(id))) {
        receipt.errors.push({ stage: 'DELIVERY', source: null, code: event.errorCode ?? event.outcome, message: `Batch ${event.batchId} ${event.outcome.toLowerCase()}${event.httpStatus ? ` (HTTP ${event.httpStatus})` : ''}.` })
      }
    })
    const resolved = () => [...tracked].every((id) => acknowledged.has(id) || rejected.has(id) || canonicalFailed.has(id))
    const deadline = this.deps.now().getTime() + this.deps.deliveryDeadlineMs
    try {
      receipt.delivery.attempted = true
      while (receipt.delivery.rounds < this.deps.maxDeliveryRounds && this.deps.now().getTime() < deadline) {
        if (queue.getOwnerUserId() !== owner) {
          receipt.errors.push({ stage: 'DELIVERY', source: null, code: 'QUEUE_OWNER_CHANGED', message: 'Account changed during delivery.' })
          break
        }
        receipt.delivery.rounds++
        receipt.delivery.attempts++
        const response = await delivery.process()
        if (tracked.size > 0 && resolved()) break
        if (response !== null && response !== undefined) continue
        const diagnostics = delivery.getDeliveryDiagnostics()
        if (diagnostics.activeWorkerCount > 0) { await this.deps.sleep(this.deps.deliveryPollMs); continue }
        receipt.delivery.pauseReason = diagnostics.pauseReason ?? null
        break
      }
    } catch (error) {
      receipt.errors.push({ stage: 'DELIVERY', source: null, code: errorCode(error, 'DELIVERY_FAILED'), message: errorMessage(error) })
    } finally {
      unsubscribe()
    }

    receipt.delivery.delivered = delivered.size
    receipt.delivery.serverAccepted = accepted.size
    receipt.delivery.serverDuplicate = duplicate.size
    receipt.delivery.serverDuplicates = duplicate.size
    receipt.delivery.serverRejected = rejected.size
    receipt.delivery.ackCount = acknowledged.size
    for (const id of tracked) {
      if (canonicalFailed.has(id)) { receipt.delivery.canonical.failed++; continue }
      const status = canonical.get(id)
      if (status === undefined) continue
      if (status === 'canonicalized') receipt.delivery.canonical.canonicalized++
      else if (status === 'not_applicable') receipt.delivery.canonical.notApplicable++
      else if (status === 'failed') receipt.delivery.canonical.failed++
      else receipt.delivery.canonical.unreported++
    }
    receipt.delivery.unresolved = [...tracked].filter((id) => !acknowledged.has(id) && !rejected.has(id) && !canonicalFailed.has(id)).length
    for (const source of receipt.sources) {
      const ids = [...tracked].filter((id) => sourceByObservationId.get(id) === source.source)
      source.deliveredCount = ids.filter((id) => delivered.has(id)).length
      source.ackedCount = ids.filter((id) => acknowledged.has(id)).length
      source.duplicateAckedCount = ids.filter((id) => acknowledged.has(id) && duplicateAcknowledged.has(id)).length
      source.failedCount = ids.filter((id) => rejected.has(id) || canonicalFailed.has(id)).length
      source.deliveryPendingCount = ids.filter((id) => !acknowledged.has(id)
        && !rejected.has(id) && !canonicalFailed.has(id)).length
    }
    try {
      const stats = await queue.getQueueStats()
      receipt.queue.depthAfterDelivery = stats.pending + stats.retrying + stats.inFlight
      if (acknowledged.size <= this.deps.purgeVerifyLimit) {
        let purged = 0
        for (const id of acknowledged) if (await queue.getRecord(id) === null) purged++
        receipt.delivery.purgeCount = purged
      } else {
        receipt.delivery.purgeCount = stats.acknowledged === 0 ? acknowledged.size : 0
      }
    } catch (error) {
      receipt.errors.push({ stage: 'PURGE_VERIFY', source: null, code: errorCode(error, 'PURGE_VERIFY_FAILED'), message: errorMessage(error) })
    }
  }
}
