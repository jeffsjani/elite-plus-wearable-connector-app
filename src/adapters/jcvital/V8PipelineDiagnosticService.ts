import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { authenticationService } from '../../services/base44/AuthenticationService'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { installationIdentityService } from '../../services/storage/InstallationIdentityService'
import { jcvitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { observationBatchManager, type BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import { runNormalProductionSync } from '../../services/sync/NormalProductionSync'
import { subscribePipeline, type PipelineEvent } from '../../services/diagnostics/PipelineTrace'
import type { NativeObservation } from '../../models/wearableObservation'
import type { PluginListenerHandle } from '@capacitor/core'
import { JCVitalV8, type JCVitalV8MonitoringConfiguration } from './jcvitalV8Bridge'
import { ackChain, acquisitionOutcome, classifyInstall, compareAccountScopes, NORMAL_SYNC_AUDIT, PIPELINE_BUILD,
  SOURCE_FAMILIES, sourceTimes, summarizeQueue, type ServerAudit, type NativePipelineSnapshot, rootCauses } from './V8PipelineDiagnostic'

export const REGISTRATION_EVIDENCE_KEY = 'v8.pipeline.registration.32A'
const guardKey = 'v8.pipeline.normal-sync.32A'
const reportPath = 'v8-pipeline-32A-current.json'
type RegistrationEvidence = ReturnType<typeof import('./V8PipelineDiagnostic').registrationEvidence>

async function evidence<T>(label: string, action: () => Promise<T>, errors: string[]): Promise<T | null> {
  try { return await action() } catch (error) {
    const message = `${label}: ${error instanceof Error ? error.message : String(error)}`
    errors.push(message)
    console.error(message)
    return null
  }
}

export async function pipelineSnapshot(server: ServerAudit | null) {
  const errors: string[] = []
  const [user, native, records, queueStats] = await Promise.all([
    evidence('Authenticated account', () => authenticationService.getCurrentUser(), errors),
    evidence('Native read-only pipeline snapshot', () => JCVitalV8.getPipelineDiagnosticSnapshot(), errors),
    evidence('Durable queue rows', () => observationQueue.listDiagnosticRecords(), errors),
    evidence('Durable queue stats', () => observationQueue.getQueueStats(), errors),
  ])
  let registration: RegistrationEvidence | null = null
  try {
    const json = localStorage.getItem(REGISTRATION_EVIDENCE_KEY)
    if (json) registration = JSON.parse(json) as RegistrationEvidence
  } catch (error) { errors.push(`Persisted registration evidence: ${String(error)}`) }
  const physicalId = native?.physicalDeviceId ?? null
  const deviceScopeId = physicalId ? jcvitalDeviceIdentityService.find(physicalId) : null
  const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
  const registrationScopeMatched = Boolean(server && server.connectorDeviceId === connectorDeviceId)
  const physicalScopeMatched = Boolean(server?.deviceScopeId && server.deviceScopeId === (deviceScopeId ?? native?.activeScope?.deviceScopeId))
  const scopes = [
    { scope: 'authenticated Connector user', owner: user?.id ?? null, authority: 'AUTH_ME' },
    { scope: 'Connector persisted registration owner', owner: registration?.localOwner ?? null, authority: 'LOCAL_REGISTRATION_CONTEXT_NOT_SERVER_PROOF' },
    { scope: 'deviceScope owner', owner: native?.activeScope?.accountId ?? null, authority: 'ACTIVE_NATIVE_JOURNAL_SCOPE' },
    { scope: 'NativeConnector registration owner', owner: (registrationScopeMatched ? server?.nativeConnectorOwnerUserId : null) ?? registration?.serverOwners[0]?.owner ?? null, authority: 'CORRELATED_BASE44_AUDIT_OR_SERVER_RESPONSE' },
    { scope: 'physical V8 registration owner', owner: physicalScopeMatched ? server?.physicalV8OwnerUserId ?? null : null, authority: 'DEVICE_CORRELATED_BASE44_AUDIT_REQUIRED' },
    { scope: 'Base44 receiving athlete', owner: physicalScopeMatched && registrationScopeMatched ? server?.receivingAthleteUserId ?? null : null, authority: 'DEVICE_CORRELATED_BASE44_AUDIT_REQUIRED' },
    { scope: 'durable queue owner', owner: observationQueue.getOwnerUserId(), authority: 'CURRENT_QUEUE_OWNER' },
    ...(server?.intendedOwnerUserId ? [{ scope: 'intended Elite+ owner', owner: server.intendedOwnerUserId, authority: 'ENGINEER_SUPPLIED_BASE44_AUDIT' }] : []),
    ...(registration?.serverOwners ?? []),
  ]
  const binding = compareAccountScopes(scopes)
  const serverEvidenceMatchesDevice = Boolean(server && server.connectorDeviceId === connectorDeviceId
    && server.deviceScopeId && server.deviceScopeId === (deviceScopeId ?? native?.activeScope?.deviceScopeId))
  const applicableServer = serverEvidenceMatchesDevice ? server : null
  const retained = native?.storage.retainedScopes ?? []
  return {
    capturedAt: new Date().toISOString(), errors, binding,
    identity: { authenticatedElitePlusUserId: user?.id ?? null, connectorOwnerUserId: observationQueue.getOwnerUserId(),
      installationId: installationIdentityService.getInstallId(), connectorDeviceId, deviceScopeId,
      physicalBleDeviceId: physicalId, macAddress: native?.deviceInfo.macAddress ?? physicalId,
      model: native?.deviceInfo.deviceName ?? native?.deviceInfo.advertisedName ?? null,
      firmware: native?.deviceInfo.firmwareVersion ?? null, appVersion: PIPELINE_BUILD.versionName,
      registration, serverEvidenceMatchesDevice,
      identityScopeWarnings: [
        ...(observationQueue.getOwnerUserId() !== user?.id ? ['QUEUE_OWNER_DIFFERS_FROM_AUTHENTICATED_USER'] : []),
        ...(deviceScopeId && native?.activeScope?.deviceScopeId !== deviceScopeId ? ['ACTIVE_DEVICE_SCOPE_DIFFERS_FROM_BLE_MAPPING'] : []),
        ...(server && !serverEvidenceMatchesDevice ? ['IMPORTED_BASE44_AUDIT_DEVICE_NOT_MATCHED; timestamps are not applied to this device'] : []),
      ],
      currentInstallClass: classifyInstall({ physicalBleId: physicalId, model: String(native?.deviceInfo.deviceName ?? native?.deviceInfo.advertisedName ?? '') }),
      retainedIdentities: retained.map((scope) => ({ ...scope,
        classification: classifyInstall({ deviceId: scope.deviceScopeId }), authority: 'RETAINED_LOCAL_JOURNAL_SCOPE_NOT_REMOTE_REGISTRATION' })),
      knownBaselineIdentities: [{ deviceId: 'diag-device', classification: 'DIAGNOSTIC_INSTALL', authority: 'USER_SUPPLIED_BUILD5_BASE44_BASELINE' }],
    },
    connectionState: native?.connectionState ?? 'UNKNOWN', native,
    queue: records ? summarizeQueue(records) : null, queueStats, queueDiagnostics: observationQueue.getDiagnostics(),
    delivery: observationBatchManager.getDeliveryDiagnostics(),
    latestTimestampsBySource: sourceTimes(records, native, applicableServer),
    queueRowsCoverage: { exportedSample: Math.min(records?.length ?? 0, 500), retainedTotal: records?.length ?? null,
      authority: 'FIRST_500_ROWS_ONLY; all queue/source aggregates cover complete read; SEND trace covers every observed batch' },
    queueRows: records?.slice(0, 500).map(({ payload, ...row }) => ({ ...row, observation: {
      sourceRecordId: payload.sourceRecordId ?? null, metric: payload.metric, vendorDataType: payload.vendorDataType ?? null,
      observedAt: payload.observedAt ?? payload.startTime, timestampSource: payload.timestampSource ?? null,
      observedAtSource: payload.observedAtSource ?? null, capturedAt: payload.capturedAt, deviceId: payload.deviceId ?? null,
      dedupKey: [row.ownerUserId, row.observationId],
    } })) ?? null,
  }
}
export type PipelineSnapshot = Awaited<ReturnType<typeof pipelineSnapshot>>

export interface PipelineReport {
  build: typeof PIPELINE_BUILD
  normalSyncCallPath: typeof NORMAL_SYNC_AUDIT
  serverAudit: ServerAudit | null
  state: 'PRE_SYNC' | 'RUNNING' | 'COMPLETE' | 'FAILED_OR_INTERRUPTED'
  pre: PipelineSnapshot
  post: PipelineSnapshot | null
  deviceSettings: JCVitalV8MonitoringConfiguration | null
  events: PipelineEvent[]
  deliveries: BatchDeliveryEvent[]
  syncError: string | null
  droppedEvents: number
  normalSyncInvoked: boolean
}

export async function waitForProductionSenderIdle(timeoutMs = 30 * 60 * 1000): Promise<void> {
  const started = Date.now()
  let idleChecks = 0
  while (idleChecks < 2) {
    const state = observationBatchManager.getDeliveryDiagnostics()
    idleChecks = state.activeWorkerCount === 0 && state.activeBatches.length === 0 ? idleChecks + 1 : 0
    if (Date.now() - started > timeoutMs) throw new Error('NORMAL_SYNC_DIAGNOSTIC_OBSERVATION_TIMEOUT; production sender was not paused or cancelled')
    if (idleChecks < 2) await new Promise((resolve) => setTimeout(resolve, 200))
  }
}

export function interpretReport(report: PipelineReport) {
  const current = report.post ?? report.pre
  const start = report.pre.native?.lastCommandSequence ?? 0
  const commands = report.post?.native?.commands.filter((command) => command.sequence > start) ?? []
  const previousRuns = new Set(report.pre.native?.acquisitions.map((run) => run.syncId) ?? [])
  const runs = report.post?.native?.acquisitions.filter((run) => !previousRuns.has(run.syncId)) ?? []
  const acquisitionCommands = commands.filter((command) => command.syncId)
  const applicableBaseline = current.identity.serverEvidenceMatchesDevice ? report.serverAudit : null
  const sent = new Map<string, { vendorDataType: string; observedAt: string; timestampAuthority: string }>()
  for (const row of report.pre.queueRows ?? []) {
    if (row.observation.vendorDataType) sent.set(row.observationId, { vendorDataType: row.observation.vendorDataType,
      observedAt: row.observation.observedAt, timestampAuthority: row.observation.timestampSource ?? 'UNKNOWN' })
  }
  for (const event of report.events.filter((event) => event.stage === 'SEND')) {
    if (!Array.isArray(event.evidence.observations)) continue
    for (const item of event.evidence.observations) {
      if (item && typeof item === 'object' && typeof item.observationId === 'string'
        && typeof item.vendorDataType === 'string' && typeof item.observedAt === 'string') {
        sent.set(item.observationId, { vendorDataType: item.vendorDataType, observedAt: item.observedAt,
          timestampAuthority: typeof item.timestampSource === 'string' ? item.timestampSource : 'UNKNOWN' })
      }
    }
  }
  const acceptedIds = new Set(report.deliveries.flatMap((event) => event.results?.filter((result) =>
    result.status === 'accepted' || result.status === 'duplicate').map((result) => result.observationId) ?? []))
  const attempts = report.events.filter((event) => event.stage === 'ENQUEUE_ATTEMPT')
    .flatMap((event) => Array.isArray(event.evidence.observations) ? event.evidence.observations : [])
  const enqueueResults = report.events.filter((event) => event.stage === 'ENQUEUE_RESULT')
    .flatMap((event) => Array.isArray(event.evidence.rows) ? event.evidence.rows : [])
  const ingressRows = attempts.map((attempt) => {
    const result = enqueueResults.find((row) => row.observationId === attempt.observationId)
    const final = report.post?.queueRows?.find((row) => row.observationId === attempt.observationId)
    return { ...attempt, enqueueAttempted: true, queueRowCreated: result?.queueRowCreated ?? false,
      alreadyQueued: result?.alreadyQueued ?? false, queueState: final?.state ?? result?.queueState ?? 'UNKNOWN',
      queueId: result?.queueId ?? null, sourceEnvelopeId: result?.sourceEnvelopeId ?? null,
      classification: result ? 'ACQUIRED_AND_ENQUEUED' : 'ACQUIRED_BUT_NOT_ENQUEUED' }
  })
  const acquired = report.events.filter((event) => event.stage === 'ACQUIRED').map((event) => {
    const matched = ingressRows.filter((row) => row.vendorDataType === event.evidence.vendorDataType
      && row.observedAt === event.evidence.observedAt && row.metricType === event.evidence.metricType
      && (event.evidence.sourceEnvelopeId ? row.sourceEnvelopeId === event.evidence.sourceEnvelopeId
        : row.observationId === event.evidence.nativeId || row.sourceRecordId === event.evidence.sourceRecordId))
    return { ...event.evidence, enqueueAttempted: matched.length > 0, linkedQueueRows: matched,
      classification: matched.some((row) => row.classification === 'ACQUIRED_AND_ENQUEUED')
        ? 'ACQUIRED_AND_ENQUEUED' : 'ACQUIRED_BUT_NOT_ENQUEUED',
      matchingAuthority: 'SOURCE_ENVELOPE_OR_EXACT_OBSERVATION_SOURCE_RECORD_ID_PLUS_VENDOR_TYPE_METRIC_AND_TIME' }
  })
  const ingressFailed = ingressRows.some((row) => row.classification === 'ACQUIRED_BUT_NOT_ENQUEUED')
    || acquired.some((row) => row.classification === 'ACQUIRED_BUT_NOT_ENQUEUED')
  const sources = SOURCE_FAMILIES.map(([type, source]) => {
    const run = runs.findLast((run) => run.vendorDataType === type)
    const commandsForType = acquisitionCommands.filter((command) => command.vendorDataType === type)
    const timing = current.latestTimestampsBySource.find((row) => row.vendorDataType === type)!
    const confirmed = [...acceptedIds].flatMap((id) => {
      const row = sent.get(id)
      return row?.vendorDataType === type ? [row] : []
    }).sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt)).at(-1)
    return {
      ...timing, source, acquisitionStatus: acquisitionOutcome(run, applicableBaseline?.latestByType[type]),
      base44ConfirmedDuringRun: confirmed?.observedAt ?? null,
      base44ConfirmedTimestampPolicy: confirmed?.timestampAuthority ?? 'UNKNOWN',
      isV8Recording: run && run.recordsParsed > 0 ? 'RETAINED_RECORDS_PROVEN; current periodic recording still unproven' : 'UNKNOWN',
      isConnectorRequesting: commandsForType.length ? 'YES' : 'NO_DURING_NORMAL_SYNC',
      isConnectorReceiving: run ? run.physicalCallbacksReceived > 0 ? 'YES' : 'NO' : 'ACQUISITION_NOT_RUN',
      isConnectorPersisting: 'SEE_LOCAL_SOURCE_JOURNAL_AND_ENQUEUE_TRACE',
      isConnectorQueueing: report.events.some((event) => event.stage === 'ENQUEUE_RESULT') ? 'SEE_PER_OBSERVATION_INGRESS' : 'NO_NEW_ACQUISITION',
      isBase44Receiving: confirmed ? 'YES_DURING_RUN' : 'UNKNOWN',
      paging: { ...NORMAL_SYNC_AUDIT.history, pagesRequested: commandsForType.length,
        callbacksReceived: run?.physicalCallbacksReceived ?? 0,
        terminalCondition: run?.terminalCondition ?? 'ACQUISITION_NOT_RUN', recordCount: run?.recordsParsed ?? 0,
        latestReturnedDeviceTimestamp: run?.latestVendorDeviceTimestamp ?? null,
        reachesNewestDeviceRecord: run?.terminalCondition === 'VENDOR_END_TRUE'
          ? 'SDK_TERMINAL_REACHED; device retention/recording maximum remains unknown' : 'UNKNOWN' },
    }
  })
  const chain = ackChain(report.events, report.deliveries)
  const queueBlocked = Boolean(current.delivery.pauseReason || current.delivery.queuePausedForCanonicalFailure
    || typeof navigator !== 'undefined' && navigator.onLine === false
    || current.identity.identityScopeWarnings.includes('QUEUE_OWNER_DIFFERS_FROM_AUTHENTICATED_USER'))
  const causes = rootCauses({ binding: current.binding.result, ran: report.normalSyncInvoked && Boolean(report.post), commands: acquisitionCommands.length, runs,
    queueBlocked, queued: (report.pre.queue?.pending ?? 0) + (report.pre.queue?.retrying ?? 0), deliveries: report.deliveries,
    syncError: Boolean(report.syncError), ingressFailed, localAckFailed: chain.serverAcceptedLocalAckFailed,
    deviceHasNoNewData: runs.length > 0 && runs.every((run) => run.terminalCondition === 'VENDOR_END_TRUE'
      && acquisitionOutcome(run, applicableBaseline?.latestByType[run.vendorDataType]) === 'NO_NEW_DEVICE_DATA') })
  return {
    ...report, accountBinding: current.binding, acquisitionRuns: runs, commandsDuringRun: commands,
    deviceSettingsClassification: report.deviceSettings ? Object.fromEntries(Object.entries(report.deviceSettings.configurations).map(([source, setting]) => [source, {
      status: setting.enabledModeRaw === '0' ? 'DISABLED' : ['1', '2'].includes(setting.enabledModeRaw ?? '') ? 'CONFIGURED' : 'UNKNOWN',
      ...setting, proof: 'Vendor AutoModeSetActivity: mode 0 disabled, 1 enabled, 2 interval',
    }])) : { HEART_RATE: 'UNKNOWN', SPO2: 'UNKNOWN', TEMPERATURE: 'UNKNOWN', HRV: 'UNKNOWN', ACTIVITY: 'UNKNOWN_SDK_READ_NOT_EXPOSED' },
    latestTimestampsBySource: sources, ackPurgeResults: chain, rootCause: causes,
    queueIngress: { classification: attempts.length || acquired.length
      ? ingressFailed ? 'ACQUIRED_BUT_NOT_ENQUEUED' : 'ACQUIRED_AND_ENQUEUED'
      : 'NO_NEW_ACQUISITION', evidence: report.events.filter((event) => event.stage.startsWith('ENQUEUE')) },
    observationQueueIngress: ingressRows, acquiredObservationIngress: acquired,
    type82: { lastLocalObservedAt: sources.find((row) => row.vendorDataType === '82')?.localLatest ?? null,
      lastBase44ObservedAt: applicableBaseline?.latestByType['82'] ?? null,
      workoutActive: current.native ? ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'].includes(current.native.workout.status) : 'UNKNOWN',
      newWorkoutRequiredToGenerate: true, workoutStartedByDiagnostic: false },
    evidenceLimits: [
      'No remote account identity endpoint exists in this Connector contract; absent owner fields remain INDETERMINATE.',
      'Imported Base44 timestamps apply only when connectorDeviceId and deviceScopeId match.',
      'SDK source-record timestamps are retained evidence, not proof the device currently contains no newer records.',
      'Purged queue rows do not prove ACK success without captured ACK/purge events.',
      'Window events may include an existing production sender; diagnostic does not pause it or change queue policy.',
      'Native command queued is not a GATT write ACK; normal Sync emits no acquisition command.',
      'Type42/PPI Oct.4 baseline authority remains UNKNOWN until original fields are imported.',
      'Base44 confirmed during run is a received-row lower bound, not a remote latest-record query.',
      'Snapshot queue rows and timestamp examples are explicitly sampled; aggregate counts cover all retained rows.',
    ],
    isolation: { base44Changes: 0, canonicalChanges: 0, scoringChanges: 0, metricSemanticChanges: 0, certificationCaptures: 0, ecgAttempts: 0 },
    panels: {
      identity: current.binding.result === 'ACCOUNT_BINDING_MISMATCH' ? 'FAIL' : current.binding.result === 'ACCOUNT_BINDING_MATCH' ? 'PASS' : 'UNKNOWN',
      acquisition: report.post ? acquisitionCommands.length ? runs.some((run) => ['FAILED', 'PARTIAL'].includes(run.completionStatus) || run.recordsRejected > 0)
        ? 'FAIL' : runs.length ? 'PASS' : 'WARN' : 'WARN' : 'UNKNOWN',
      queue: current.queue ? current.queue.failed || current.queue.canonicalRecoveryRequired || queueBlocked ? 'WARN' : 'PASS' : 'UNKNOWN',
      delivery: chain.serverAcceptedLocalAckFailed || report.deliveries.some((event) => event.outcome !== 'DELIVERED') ? 'FAIL'
        : report.deliveries.length ? 'PASS' : 'UNKNOWN',
    },
  }
}

export async function persistPipelineReport(report: PipelineReport): Promise<void> {
  const json = JSON.stringify(report)
  if (Capacitor.isNativePlatform()) {
    await Filesystem.writeFile({ path: reportPath, data: json, directory: Directory.Data, encoding: Encoding.UTF8 })
  } else sessionStorage.setItem(reportPath, json)
}

export async function restorePipelineReport(): Promise<PipelineReport | null> {
  let json: string | null = null
  if (Capacitor.isNativePlatform()) {
    const files = await Filesystem.readdir({ path: '', directory: Directory.Data })
    if (!files.files.some((file) => file.name === reportPath)) return null
    const result = await Filesystem.readFile({ path: reportPath, directory: Directory.Data, encoding: Encoding.UTF8 })
    if (typeof result.data !== 'string') throw new Error('PIPELINE_REPORT_INVALID_ENCODING')
    json = result.data
  } else json = sessionStorage.getItem(reportPath)
  if (!json) return null
  const report = JSON.parse(json) as PipelineReport
  if (report.build.schemaVersion !== PIPELINE_BUILD.schemaVersion) throw new Error('PIPELINE_REPORT_SCHEMA_MISMATCH')
  if (report.state === 'RUNNING') report.state = 'FAILED_OR_INTERRUPTED'
  return report
}

export async function runPipelineDiagnostic(pre: PipelineSnapshot, server: ServerAudit | null,
  settings: JCVitalV8MonitoringConfiguration | null, update: (report: PipelineReport) => void,
  bindingMismatchExported = false): Promise<PipelineReport> {
  if (sessionStorage.getItem(guardKey)) throw new Error('NORMAL_SYNC_DIAGNOSTIC_ALREADY_RUN')
  if (pre.binding.result === 'ACCOUNT_BINDING_MISMATCH' && !bindingMismatchExported) throw new Error('ACCOUNT_BINDING_MISMATCH_EXPORT_FIRST')
  if (pre.connectionState !== 'READY') throw new Error('NORMAL_SYNC_DIAGNOSTIC_REQUIRES_READY')
  if (pre.delivery.activeWorkerCount || pre.delivery.activeBatch || pre.delivery.activeBatches.length) throw new Error('NORMAL_SYNC_DIAGNOSTIC_WAIT_FOR_EXISTING_DELIVERY')
  if (pre.native?.workout && ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'].includes(pre.native.workout.status)) throw new Error('NORMAL_SYNC_DIAGNOSTIC_WORKOUT_ACTIVE')
  sessionStorage.setItem(guardKey, 'RUNNING')
  const report: PipelineReport = { build: PIPELINE_BUILD, normalSyncCallPath: NORMAL_SYNC_AUDIT, serverAudit: server,
    state: 'RUNNING', pre, post: null, deviceSettings: settings, events: [], deliveries: [], syncError: null, droppedEvents: 0, normalSyncInvoked: false }
  const unsubscribe = subscribePipeline((event) => {
    if (report.events.length < 10000) report.events.push(event)
    else report.droppedEvents++
  })
  const unsubscribeDelivery = observationBatchManager.subscribe((event) => report.deliveries.push({
    ...event, completedAt: event.completedAt ?? new Date().toISOString(),
  }))
  const nativeListeners: PluginListenerHandle[] = []
  const capture = (observation: NativeObservation, origin: string) => {
    if (report.events.length >= 10000) { report.droppedEvents++; return }
    if (report.events.some((event) => event.stage === 'ACQUIRED' && event.evidence.nativeId === observation.id)) return
    report.events.push({ stage: 'ACQUIRED', at: new Date().toISOString(), evidence: {
      origin, nativeId: observation.id, sourceRecordId: observation.provenance.sourceRecordId ?? null,
      sourceEnvelopeId: observation.provenance.sourceEnvelopeId ?? null,
      vendorDataType: observation.vendorDataType, metricType: observation.metricType,
      observedAt: observation.observedAt, observedAtSource: observation.observedAtSource,
      receivedAt: observation.receivedAt, sessionId: observation.sessionId,
    } })
  }
  update(report)
  try {
    await persistPipelineReport(report)
    nativeListeners.push(await JCVitalV8.addListener('jcvitalObservation', (observation) => capture(observation, 'NATIVE_NORMALIZED_OBSERVATION')))
    nativeListeners.push(await JCVitalV8.addListener('jcvitalHistoricalHrChunk', (chunk) => {
      chunk.observations.forEach((observation) => capture(observation, 'NATIVE_HR_CHUNK'))
    }))
    nativeListeners.push(await JCVitalV8.addListener('jcvitalParseError', (error) => {
      if (report.events.length >= 10000) { report.droppedEvents++; return }
      report.events.push({ stage: 'PARSE_ERROR', at: new Date().toISOString(),
        evidence: { message: error.message, vendorDataType: error.vendorDataType, receivedAt: error.receivedAt } })
    }))
    report.normalSyncInvoked = true
    await runNormalProductionSync()
    await waitForProductionSenderIdle()
    report.state = 'COMPLETE'
  } catch (error) {
    report.syncError = error instanceof Error ? error.message : String(error)
    report.state = 'FAILED_OR_INTERRUPTED'
    console.error('Normal Sync diagnostic failed', error)
  } finally {
    unsubscribe()
    unsubscribeDelivery()
    for (const listener of nativeListeners) {
      await evidence('Removing pipeline-only passive listener', () => listener.remove(), report.pre.errors)
    }
    report.post = await pipelineSnapshot(server)
    sessionStorage.setItem(guardKey, 'COMPLETE')
    update({ ...report })
    await persistPipelineReport(report)
  }
  return report
}

export function resetPipelineGuard(exported: boolean): void {
  if (!exported) throw new Error('PIPELINE_EXPORT_REQUIRED_BEFORE_RESET')
  sessionStorage.removeItem(guardKey)
}

export function preSyncReport(pre: PipelineSnapshot, server: ServerAudit | null, settings: JCVitalV8MonitoringConfiguration | null): PipelineReport {
  return { build: PIPELINE_BUILD, normalSyncCallPath: NORMAL_SYNC_AUDIT, serverAudit: server, state: 'PRE_SYNC',
    pre, post: null, deviceSettings: settings, events: [], deliveries: [], syncError: null, droppedEvents: 0, normalSyncInvoked: false }
}

export function commandsSince(before: NativePipelineSnapshot, after: NativePipelineSnapshot) {
  return after.commands.filter((command) => command.sequence > before.lastCommandSequence)
}
