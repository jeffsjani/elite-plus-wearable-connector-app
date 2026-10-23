import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import type { PipelineEvent } from '../../services/diagnostics/PipelineTrace'
export { registrationEvidence } from './PipelineRegistrationEvidence'

export const PIPELINE_BUILD = { versionCode: 32, versionName: '1.0.0-rc3-diagnostic', schemaVersion: 'v8-pipeline-32A-1' } as const
export const SOURCE_FAMILIES = [
  ['27', 'Type27 HR'], ['68', 'SpO2'], ['59', 'Temperature'], ['82', 'Type82 HR'],
  ['24', 'Activity'], ['25', 'Detailed Activity'], ['26', 'Sleep'], ['121', 'Sleep movement'],
  ['42', 'Type42'], ['127', 'PPI'],
] as const
export type TimestampAuthority = 'VENDOR_DEVICE_TIMESTAMP' | 'ELITE_PLUS_INFERRED_TIMESTAMP' | 'CAPTURE_TIMESTAMP'
  | 'RECEIVED_AT' | 'CERTIFICATION_TIMESTAMP' | 'UNKNOWN'
export type BindingResult = 'ACCOUNT_BINDING_MATCH' | 'ACCOUNT_BINDING_MISMATCH' | 'ACCOUNT_BINDING_INDETERMINATE'
export type PanelStatus = 'PASS' | 'WARN' | 'FAIL' | 'UNKNOWN'
export interface IdentityScope { scope: string; owner: string | null; authority: string }

export function compareAccountScopes(scopes: IdentityScope[]) {
  const known = scopes.filter((scope) => scope.owner !== null)
  const conflicts = known.flatMap((left, index) => known.slice(index + 1)
    .filter((right) => left.owner !== right.owner).map((right) => ({ left, right })))
  const result: BindingResult = conflicts.length ? 'ACCOUNT_BINDING_MISMATCH'
    : known.length === scopes.length && scopes.length >= 6 ? 'ACCOUNT_BINDING_MATCH' : 'ACCOUNT_BINDING_INDETERMINATE'
  return { result, scopes, conflicts, automaticRebinding: false }
}

export function classifyInstall(device: { deviceId?: string | null; model?: string | null; physicalBleId?: string | null; diagnostic?: boolean; legacyTest?: boolean }) {
  if (device.diagnostic || device.deviceId === 'diag-device') return 'DIAGNOSTIC_INSTALL'
  if (device.legacyTest || device.deviceId?.startsWith('__queue_self_test__:')) return 'LEGACY_TEST_INSTALL'
  if (device.physicalBleId && /(?:PRO[_ -]?V8|Elite\+? V8)/i.test(device.model ?? '')) return 'PHYSICAL_PRODUCTION_DEVICE'
  return 'UNKNOWN'
}

export function timestampAuthority(input: { timestampSource?: string | null; observedAtSource?: string | null; field?: string; certificationOnly?: boolean }): TimestampAuthority {
  if (input.field === 'receivedAt') return 'RECEIVED_AT'
  if (input.field === 'capturedAt' || input.field === 'receiptTimestamp') return 'CAPTURE_TIMESTAMP'
  if (input.field === 'certificationTimestamp') return 'CERTIFICATION_TIMESTAMP'
  // Certification membership alone does not change a record's timestamp authority.
  if (input.timestampSource?.includes('NOMINAL_INTERVAL')) return 'ELITE_PLUS_INFERRED_TIMESTAMP'
  if (input.timestampSource === 'DEVICE_HISTORY_RECORD_TIME' && input.observedAtSource) return 'VENDOR_DEVICE_TIMESTAMP'
  if (input.timestampSource?.includes('RECEIPT') || input.timestampSource?.includes('CONNECTOR')) return 'CAPTURE_TIMESTAMP'
  return 'UNKNOWN'
}

export const NORMAL_SYNC_AUDIT = {
  behavior: 'C_DELIVER_QUEUED_OBSERVATIONS_ONLY',
  callChain: [
    'ElitePlusV8Dashboard: Sync Device Data → ElitePlusV8Panel.onSync',
    'App.syncNow → runNormalProductionSync → ObservationBatchManager.process',
    'processLoop → queue claimPending → ConnectorObservationService.submitObservations',
    'Base44Client → existing nativeConnectorObservations → result matching',
    'ObservationQueue.acknowledgeClaims → purgeAcknowledged',
  ],
  nativePluginMethods: [], bleCommands: [], observationCreation: 'NONE',
  nativePluginScope: 'NO_JCVITAL_V8_ACQUISITION_METHOD; native SQLite storage still runs',
  nativeStoragePluginMethods: ['CapacitorSQLite.query', 'CapacitorSQLite.run', 'CapacitorSQLite.executeSet'],
  queueIngress: 'NONE_FROM_SYNC_ACTION', senderConcurrency: 1,
  scheduler: SOURCE_FAMILIES.filter(([type]) => type !== '82').map(([type, source]) => ({
    source, vendorDataType: type, automaticAcquisition: false, trigger: 'NONE_IN_PRODUCTION',
    frequency: 'NONE', requiresReadyForManualHistory: true,
  })),
  lastSeenMeaning: 'Registration refresh/status check-in is not proof of BLE connection, acquisition, sync or delivery. Server lastSeen update semantics are not available in this repository.',
  resumeTriggers: ['session restore/sign-in', 'network online', 'document visible', 'retry timer', 'live workout HR enqueue'],
  backgroundAcquisition: false,
  history: {
    startMode: '0x00', continuationMode: '0x02', dateArgument: 'EMPTY_STRING',
    continuationEveryMatchingCallbacks: 50, timeoutMs: 15000,
    termination: ['vendor DeviceKey.End === true', 'timeout: FAILED or PARTIAL', 'HR explicit Safe Test maxValidSamples, when supplied'],
    hardCodedStartDate: false, certificationDate: false, fixedLookback: false, persistedPagingCursor: false,
    deviceMaximumHistory: 'UNKNOWN_SDK_DEVICE_LIMIT',
    newestRecordCompleteness: 'NOT_PROVEN_WITHOUT_PHYSICAL_HISTORY_QUERY; normal Sync does not query history',
    commandsBySource: {
      '27': 'GetDynamicHRWithMode(mode, "")', '68': 'Oxygen_data(mode, "")',
      '59': 'GetTemperature_historyData(mode, "")', '42': 'GetHRVDataWithMode(mode, "")',
      '127': 'GetPPI(mode, "")', '24': 'GetTotalActivityDataWithMode(mode, "")',
      '25': 'GetDetailActivityDataWithMode(mode, "")', '26': 'GetDetailSleepDataWithMode(mode, "")',
      '121': 'getObtainDetailedSleepData(mode, "")', '29': 'GetActivityModeDataWithMode(mode); no date argument',
    },
  },
  type82: { passiveWearExpected: false, requiresActiveWorkoutForNewRecords: true, automaticWorkoutStart: false },
  baseline: {
    type27: 'Latest historical source data is September-dated; exact timestamp/account not supplied.',
    type82: 'Latest live physical HR is Oct. 1; exact timestamp/account not supplied.',
    type42Ppi: 'Oct. 4 timestamps conflict with the Oct. 1 prose cutoff; authority UNKNOWN until original row fields are supplied.',
    consumer: 'Heart Rate card, canonical selection, freshness, no seed fallback and accepted HR canonicalization are already proven. No changes.',
    nativeConnectorSource: 'Zero rows: separate Base44 source-status task, out of scope.',
  },
} as const

export interface NativeAcquisition {
  syncId: string; sdkCommand: string; vendorDataType: string; startedAt: string; completedAt: string
  completionStatus: string; physicalCallbacksReceived: number; recordsParsed: number
  recordsStored: number | null; recordsDeduplicated: number; recordsRejected: number
  earliestSourceTimestamp: string | null; latestSourceTimestamp: string | null
  latestVendorDeviceTimestamp?: string | null
  terminalCondition?: string
  pagesRequested?: number
}
export interface NativePipelineSnapshot {
  connectionState: string
  physicalDeviceId: string | null
  deviceInfo: Record<string, unknown>
  activeScope: { accountId: string; deviceScopeId: string } | null
  workout: { status: string; sessionId: string | null }
  lastCommandSequence: number
  droppedCommands: number
  commands: Array<{ sequence: number; sdkCommand: string; startedAt: string; syncId: string | null; vendorDataType: string | null; disposition: string; proof: string }>
  acquisitions: NativeAcquisition[]
  storage: {
    journalExists: boolean; queueExists: boolean
    retainedScopes: Array<{ accountId: string; deviceScopeId: string; envelopeCount: number; lastSequence: number }>
    queueOwners: Array<{ ownerUserId: string; state: string; count: number }>
    sourceRecords: Array<{ accountId: string; deviceScopeId: string; vendorDataType: string; sourceRecordCount: number
      latestVendorTimestamp: string | null; latestCaptureTimestamp: string | null; timestampAuthority: TimestampAuthority }>
  }
}

export interface ServerAudit {
  intendedOwnerUserId: string | null
  nativeConnectorOwnerUserId: string | null
  physicalV8OwnerUserId: string | null
  receivingAthleteUserId: string | null
  connectorDeviceId: string | null
  deviceScopeId: string | null
  exportedAt: string | null
  latestByType: Record<string, { timestamp: string; authority: TimestampAuthority; field: string }>
}

const authorities: readonly string[] = ['VENDOR_DEVICE_TIMESTAMP', 'ELITE_PLUS_INFERRED_TIMESTAMP', 'CAPTURE_TIMESTAMP', 'RECEIVED_AT', 'CERTIFICATION_TIMESTAMP', 'UNKNOWN']
export function parseServerAudit(json: string): ServerAudit {
  const value: unknown = JSON.parse(json)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('BASE44_AUDIT_INVALID_OBJECT')
  const input = value as Record<string, unknown>
  const result: ServerAudit = { intendedOwnerUserId: null, nativeConnectorOwnerUserId: null, physicalV8OwnerUserId: null,
    receivingAthleteUserId: null, connectorDeviceId: null, deviceScopeId: null, exportedAt: null, latestByType: {} }
  for (const field of ['intendedOwnerUserId', 'nativeConnectorOwnerUserId', 'physicalV8OwnerUserId', 'receivingAthleteUserId', 'connectorDeviceId', 'deviceScopeId', 'exportedAt'] as const) {
    if (input[field] !== null && input[field] !== undefined && typeof input[field] !== 'string') throw new Error(`BASE44_AUDIT_INVALID_${field}`)
    result[field] = typeof input[field] === 'string' ? input[field] : null
  }
  if (!input.latestByType || typeof input.latestByType !== 'object' || Array.isArray(input.latestByType)) throw new Error('BASE44_AUDIT_LATEST_BY_TYPE_REQUIRED')
  for (const [type, raw] of Object.entries(input.latestByType)) {
    if (!raw || typeof raw !== 'object') throw new Error(`BASE44_AUDIT_INVALID_TIMESTAMP_${type}`)
    const row = raw as Record<string, unknown>
    if (typeof row.timestamp !== 'string' || !Number.isFinite(Date.parse(row.timestamp))
      || typeof row.authority !== 'string' || !authorities.includes(row.authority) || typeof row.field !== 'string') throw new Error(`BASE44_AUDIT_INVALID_TIMESTAMP_${type}`)
    if ((row.field === 'receivedAt' && row.authority !== 'RECEIVED_AT')
      || (row.field === 'capturedAt' && row.authority !== 'CAPTURE_TIMESTAMP')
      || (row.field === 'certificationTimestamp' && row.authority !== 'CERTIFICATION_TIMESTAMP')) throw new Error(`BASE44_AUDIT_TIMESTAMP_AUTHORITY_CONFLICT_${type}`)
    result.latestByType[type] = { timestamp: row.timestamp, authority: row.authority as TimestampAuthority, field: row.field }
  }
  return result
}

export function acquisitionOutcome(run: NativeAcquisition | undefined, baseline: ServerAudit['latestByType'][string] | undefined) {
  if (!run) return 'ACQUISITION_NOT_RUN'
  if (['FAILED', 'PARTIAL'].includes(run.completionStatus) || run.recordsRejected > 0) return 'ACQUISITION_FAILED'
  if (run.recordsParsed === 0) return 'NO_NEW_DEVICE_DATA'
  const deviceLatest = run.latestVendorDeviceTimestamp
  if (!baseline || baseline.authority !== 'VENDOR_DEVICE_TIMESTAMP' || !deviceLatest) return 'INSUFFICIENT_EVIDENCE'
  return Date.parse(deviceLatest) > Date.parse(baseline.timestamp) ? 'NEW_DEVICE_DATA_FOUND' : 'NO_NEW_DEVICE_DATA'
}

function latest(values: Array<string | null | undefined>): string | null {
  const valid = values.filter((value): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value)))
  return valid.sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1) ?? null
}

export function summarizeQueue(records: QueueRecord[], now = Date.now()) {
  const counts = { total: records.length, pending: 0, inFlight: 0, retrying: 0, failed: 0, acknowledgedAwaitingPurge: 0, canonicalRecoveryRequired: 0 }
  for (const row of records) {
    const key = { PENDING: 'pending', IN_FLIGHT: 'inFlight', RETRY_WAIT: 'retrying', FAILED_PERMANENT: 'failed',
      ACKNOWLEDGED: 'acknowledgedAwaitingPurge', CANONICAL_RECOVERY_REQUIRED: 'canonicalRecoveryRequired' } as const
    counts[key[row.state]]++
  }
  return {
    ...counts, newestRowAgeMs: records.length ? now - records.reduce((latest, row) => Math.max(latest, Date.parse(row.createdAt)), -Infinity) : null,
    oldestPendingAgeMs: records.some((row) => row.state === 'PENDING')
      ? now - records.reduce((oldest, row) => row.state === 'PENDING' ? Math.min(oldest, Date.parse(row.createdAt)) : oldest, Infinity) : null,
    stuckRows: records.filter((row) => row.state === 'IN_FLIGHT' && now - Date.parse(row.claimedAt ?? row.updatedAt) > 60000).map((row) => row.observationId),
    repeatedlyRetried: records.filter((row) => row.attemptCount >= 3).map((row) => row.observationId),
    starvation: 'UNKNOWN_WITHOUT_LONGITUDINAL_EVIDENCE',
  }
}

export function sourceTimes(records: QueueRecord[] | null, native: NativePipelineSnapshot | null, server: ServerAudit | null) {
  return SOURCE_FAMILIES.map(([type, source]) => {
    const rows = (records ?? []).filter((row) => row.payload.vendorDataType === type)
    const sourceRecords = native?.storage.sourceRecords.filter((row) => row.vendorDataType === type
      && row.accountId === native.activeScope?.accountId && row.deviceScopeId === native.activeScope?.deviceScopeId) ?? []
    const baseline = server?.latestByType[type]
    return {
      source, vendorDataType: type, deviceLatest: latest(sourceRecords.map((row) => row.latestVendorTimestamp)),
      deviceLatestAuthority: 'RETAINED_VENDOR_SOURCE_RECORD_NOT_CURRENT_DEVICE_QUERY',
      localLatest: latest(rows.map((row) => row.payload.observedAt ?? row.payload.startTime)),
      localLatestCoverage: 'RETAINED_QUEUE_ONLY; purged scalar observations cannot be counted retrospectively',
      localObservationCount: records ? rows.length : null, localObservationCountCoverage: records ? 'RETAINED_QUEUE_ONLY' : 'QUEUE_READ_UNAVAILABLE',
      sourceRecordCount: native?.storage.journalExists && native.activeScope
        ? sourceRecords.reduce((sum, row) => sum + row.sourceRecordCount, 0) : null,
      queuedLatest: latest(rows.map((row) => row.payload.observedAt ?? row.payload.startTime)),
      queuedRowCount: records ? rows.length : null, oldestQueuedAt: rows.map((row) => row.createdAt).sort()[0] ?? null,
      newestQueuedAt: latest(rows.map((row) => row.createdAt)), lastDeliveryAttempt: latest(rows.map((row) => row.lastAttemptAt)),
      lastAck: latest(rows.map((row) => row.acknowledgedAt)),
      base44Latest: baseline?.timestamp ?? null, base44TimestampAuthority: baseline?.authority ?? 'UNKNOWN',
      correctedLatestSourceTime: baseline?.authority === 'VENDOR_DEVICE_TIMESTAMP' ? baseline.timestamp : null,
      timestampEvidenceCoverage: 'FIRST_20_RETAINED_ROWS; source/queue aggregate counts cover all retained rows',
      timestampAuthorityCounts: rows.reduce<Record<string, number>>((counts, row) => {
        const authority = timestampAuthority(row.payload)
        counts[authority] = (counts[authority] ?? 0) + 1
        return counts
      }, {}),
      timestampEvidence: rows.slice(0, 20).map((row) => ({ observationId: row.observationId,
        observedAt: row.payload.observedAt, authority: timestampAuthority(row.payload),
        receivedAt: row.payload.receivedAt, receivedAtAuthority: 'RECEIVED_AT',
        capturedAt: row.payload.capturedAt, capturedAtAuthority: 'CAPTURE_TIMESTAMP' })),
      status: 'UNKNOWN_PENDING_PHYSICAL_RECONCILIATION',
    }
  })
}

export function queueIngress(observations: Pick<NativeObservationInput, 'observationId' | 'sourceRecordId' | 'metric' | 'observedAt'>[],
  attempted: Set<string>, enqueued: Set<string>) {
  return observations.map((row) => ({ ...row, enqueueAttempted: attempted.has(row.observationId),
    queueRowCreatedOrAlreadyDurable: enqueued.has(row.observationId),
    classification: enqueued.has(row.observationId) ? 'ACQUIRED_AND_ENQUEUED' : 'ACQUIRED_BUT_NOT_ENQUEUED' }))
}

export function ackChain(events: PipelineEvent[], deliveries: BatchDeliveryEvent[]) {
  const count = (stage: PipelineEvent['stage']) => events.filter((event) => event.stage === stage)
    .reduce((sum, event) => sum + Number(event.evidence.count ?? 0), 0)
  const responses = events.filter((event) => event.stage === 'RESPONSE')
  const accepted = responses.reduce((sum, event) => sum + Number(event.evidence.accepted ?? 0), 0)
  const duplicate = responses.reduce((sum, event) => sum + Number(event.evidence.duplicate ?? 0), 0)
  const results = responses.flatMap((event) => {
    const ids = new Set(deliveries.filter((delivery) => delivery.batchId === event.evidence.batchId).flatMap((delivery) => delivery.observationIds))
    for (const send of events.filter((send) => send.stage === 'SEND' && send.evidence.batchId === event.evidence.batchId)) {
      if (Array.isArray(send.evidence.observations)) for (const row of send.evidence.observations) {
        if (typeof row?.observationId === 'string') ids.add(row.observationId)
      }
    }
    return Array.isArray(event.evidence.results) ? event.evidence.results.filter((result) => ids.has(result?.observationId)) : []
  })
  return {
    deliveryAttempts: events.filter((event) => event.stage === 'SEND').length,
    serverAccepted: accepted, serverDuplicates: duplicate,
    resultMatched: results.filter((result) => result.status === 'accepted' || result.status === 'duplicate').length,
    queueAck: count('ACK'), purged: count('PURGE'),
    serverAcceptedLocalAckFailed: deliveries.some((event) => event.errorCode === 'ACK_PROCESSING_FAILED')
      || (accepted + duplicate > 0 && count('ACK') < results.filter((result) => result.status !== 'rejected' && result.canonicalStatus !== 'failed').length),
    purgeCountScope: 'PRODUCTION_PURGE_MAY_INCLUDE_PREEXISTING_ACKED_ROWS',
  }
}

export function rootCauses(input: { binding: BindingResult; ran: boolean; commands: number; runs: readonly NativeAcquisition[];
  queueBlocked: boolean; queued: number; deliveries: readonly BatchDeliveryEvent[]; ingressFailed?: boolean; syncError?: boolean;
  deviceHasNoNewData?: boolean; localAckFailed?: boolean }) {
  const causes: string[] = []
  if (input.binding === 'ACCOUNT_BINDING_MISMATCH') causes.push('C — ACCOUNT_BINDING_MISMATCH')
  if (!input.ran) return { classification: 'F — INSUFFICIENT_EVIDENCE', causes }
  if (!input.commands) causes.push('A2 — CONNECTOR_DID_NOT_REQUEST_DATA')
  else if (!input.runs.length) causes.push('A3 — CONNECTOR_REQUESTED_BUT_DEVICE_RETURNED_NO_DATA')
  else if (input.runs.some((run) => run.completionStatus === 'FAILED' || run.recordsRejected)) causes.push('A4 — CONNECTOR_PARSE/PERSISTENCE_FAILURE')
  else if (input.runs.every((run) => run.recordsParsed === 0)) causes.push('A3 — CONNECTOR_REQUESTED_BUT_DEVICE_RETURNED_NO_DATA')
  else if (input.deviceHasNoNewData) causes.push('A1 — DEVICE_HAS_NO_NEW_DATA')
  if (input.ingressFailed) causes.push('B1 — ACQUIRED_BUT_NOT_ENQUEUED')
  if (input.queueBlocked) causes.push('B2 — QUEUE_BLOCKED')
  if (input.queued && !input.deliveries.length && !input.queueBlocked) causes.push('B3 — DELIVERY_NOT_TRIGGERED')
  if (input.localAckFailed || input.deliveries.some((event) => event.errorCode === 'ACK_PROCESSING_FAILED')) causes.push('B5 — SERVER_ACCEPTED_LOCAL_ACK_FAILED')
  else if (input.syncError || input.deliveries.some((event) => event.outcome !== 'DELIVERED' || (event.rejected ?? 0) > 0)) causes.push('B4 — DELIVERY_FAILED')
  return { classification: causes.length > 1 ? 'D — MULTIPLE_CONCURRENT_CAUSES' : causes[0]
    ?? (input.binding === 'ACCOUNT_BINDING_MATCH' ? 'E — PIPELINE_HEALTHY_AFTER_NORMAL_SYNC' : 'F — INSUFFICIENT_EVIDENCE'), causes }
}
