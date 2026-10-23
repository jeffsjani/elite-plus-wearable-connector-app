import { Component, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { Capacitor } from '@capacitor/core'
import { exportPpiCertificationFile, PPI_CERTIFICATION_FILENAME, saveValidationJson, serializeCertificationJson } from './CertificationJsonExport'
import { sha256Hex } from './HeartRateSeries'
import { PpiCertificationAttempt, type PpiAttemptRecord } from './PpiCertificationAttempt'
import { connectAndBindJournal, startDiscovery } from './ConnectionLifecycle'
import {
  JCVitalV8,
  type JCVitalV8Battery,
  type JCVitalV8ConnectionState,
  type JCVitalV8Device,
  type JCVitalV8DeviceInfo,
  type JCVitalV8ErrorEvent,
  type JCVitalV8HistoricalSyncResult,
  type JCVitalV8HistoricalHrStreamStats,
  type JCVitalV8LiveWorkoutSession,
  type JCVitalV8NativeBreadcrumbs,
  type JCVitalV8Observation,
  type JCVitalV8PermissionResult,
  type JCVitalV8RawEcgErrorEvent,
  type JCVitalV8RawEcgSession,
  type JCVitalV8RawPpgErrorEvent,
  type JCVitalV8RawPpgSession,
  type JCVitalV8WorkoutErrorEvent,
  type JCVitalV8WorkoutHeartRateEvent,
  type RawPpgPhysicalCertificationEvent,
  type SourceJournalDiagnostics,
  type SourceJournalScope,
} from './jcvitalV8Bridge'
import {
  buildHistoricalFeedResult,
  buildMonitoringFeedResult,
  type HistoricalFeedKey,
  type HistoricalFeedRun,
  type MonitoringFeedRun,
} from './Phase3AValidation'
import {
  buildPhase3BFeedResults,
  buildPhase3BExportResults,
  type Phase3BFeedKey,
  type SleepFeedRun,
} from './Phase3BValidation'
import { phase3bDisabledReason } from './Phase3BBridgeStatus'
import { workoutStartDisabledReason, workoutStopDisabledReason } from './WorkoutCaptureGuard'
import { rawEcgStartDisabledReason, rawEcgStopDisabledReason } from './RawEcgCaptureGuard'
import { rawPpgStopDisabledReason } from './RawPpgCaptureGuard'
import { RawPpgSavedEvidenceService } from './RawPpgSavedEvidence'
import { RawPpgSavedEvidenceControls } from './RawPpgSavedEvidenceView'
import { RAW_PPG_LEGACY_START_DISABLED_REASON, RawPpgPhysicalCertificationService } from './RawPpgPhysicalCertification'
import { RawPpgPhysicalCertificationControls } from './RawPpgPhysicalCertificationView'
import { buildRawPpgValidation, createRawPpgUiCoalescer, EMPTY_RAW_PPG_CHUNK_SUMMARY, includeRawPpgChunk, mergeRawPpgSession, type RawPpgChunkSummary, type RawPpgUiUpdate } from './RawPpgDiagnostics'
import { buildRawEcgValidation, EMPTY_RAW_ECG_CHUNK_SUMMARY, includeRawEcgChunk, type RawEcgChunkSummary } from './RawEcgDiagnostics'
import {
  buildWorkoutLiveValidation,
  computeWorkoutCadenceDiagnostics,
  type LiveWorkoutPacket,
  type LiveWorkoutSession,
} from './WorkoutTelemetry'
import {
  buildQueueSelfTestObservation,
  effectiveQueueHealth,
  hrDeliveryTestDisabledReason,
  WorkoutHrDeliveryService,
  type WorkoutHrDeliverySnapshot,
} from './WorkoutHrDelivery'
import { WORKOUT_HR_E2E_TEST_DURATION_MS, WorkoutHrDeliveryView, type QueueSelfTestOutcome } from './WorkoutHrDeliveryView'
import { JCVitalPhysiologyDelivery, type PhysiologyDeliverySnapshot, type FocusedDeliveryOptions } from './PhysiologyDelivery'
import { PhysiologyDeliveryView } from './PhysiologyDeliveryView'
import { auditHistoricalResult, boundHistoricalResult } from './HistoricalResultBounds'
import { chunkAsSyncResult, HistoricalHrStreamCollector, type HistoricalHrStreamSummary } from './HistoricalHrStream'
import { CertificationDeliveryEvidence } from './JCVitalCertification'
import { buildCertificationValidationExport, CERTIFICATION_BUILD, serializeCertificationValidationExport } from './CertificationValidationExport'
import { PRIOR_SPO2_CERTIFICATION_IDS, SpO2Certification, type SpO2Inspection } from './SpO2Certification'
import { TemperatureCertification, type TemperatureInspection } from './TemperatureCertification'
import { Type42Certification, TYPE42_CERTIFICATION_SUCCESS, type Type42ConnectedContext } from './Type42Certification'
import { Type42CertificationView } from './Type42CertificationView'
import { Activity24_25Certification } from './Activity24_25Certification'
import { Activity24_25CertificationView } from './Activity24_25CertificationView'
import { canonicalizeAcquiredActivity, indexedDbActivityLedgerStore, JCVitalActivityCanonicalization } from './ActivityCanonicalization'
import { SleepCertification } from './SleepCertification'
import { SleepCertificationView } from './SleepCertificationView'
import { WorkoutHistoryCertification } from './WorkoutHistoryCertification'
import { WorkoutHistoryCertificationView } from './WorkoutHistoryCertificationView'
import { PpiCertification, PPI_CERTIFICATION_SUCCESS, type PpiCertificationInspection } from './PpiCertification'
import { copyPpiCertificationJson, readPpiCertificationJson, ppiSnapshotSavedStatus, NO_PPI_CERTIFICATION_GROUP_AVAILABLE, type PpiCertificationJson } from './PpiCertificationJson'
import { PpiCertificationJsonView } from './PpiCertificationJsonView'
import { PpiCertificationRecovery, PPI_RECOVERED_CERTIFICATION_FILENAME } from './PpiCertificationRecovery'
import { PpiCertificationResume } from './PpiCertificationResume'
import { ppiResumeFailureText, PPI_RESUME_BUTTON_LABEL, runPpiCertificationResume } from './PpiCertificationResumeAction'
import { crashBreadcrumbs } from '../../services/diagnostics/CrashBreadcrumbs'
import { observationQueue, type QueueDiagnostics } from '../../services/sync/ObservationQueue'
import { observationBatchManager, type DeliveryDiagnostics } from '../../services/sync/ObservationBatchManager'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { activityV2CapabilityStore } from '../../services/base44/ActivityV2Capability'
import { getBackendEnvironmentDiagnostics } from '../../services/base44/base44Environment'
import { installationIdentityService } from '../../services/storage/InstallationIdentityService'
import { jcvitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'
import type { QueueStats } from '../../services/storage/ObservationQueueStore'
import { QueueStoreError } from '../../services/storage/ObservationQueueStore'
import { SourceCapabilityMatrix } from './SourceCapabilityMatrix'
import { V8FullDataCoverageReportPanel } from './V8FullDataCoverageReportPanel'
import { IS_ENGINEERING_BUILD } from '../../buildMode'
import {
  activityV2SourcesFromNative, enqueueActivityNativeTransportV2, selectSavedActivityV2VerificationSources,
} from './ActivityNativeTransportV2Delivery'
import type { ActivityDeviceContext } from './ActivityProductionCanonical'

type ExportStatus = 'EXPORTING' | 'EXPORT SUCCESS' | 'EXPORT FAILED'

/** Chunk events and the call result travel separately over the bridge; wait this long for the final chunk. */
const FINAL_HR_CHUNK_WAIT_MS = 10_000

const PHYSIOLOGY_CERTIFICATION_ACTIONS = [
  { key: 'spo2', metric: 'spo2', label: 'SpO2', action: () => JCVitalV8.syncHistoricalSpo2() },
  { key: 'temperature', metric: 'wearableTemperature', label: 'Wearable Temperature', action: () => JCVitalV8.syncHistoricalTemperature() },
  { key: 'hrv', metric: 'hrv', label: 'HRV', action: () => JCVitalV8.syncHistoricalHrv() },
  { key: 'hrv', metric: 'stress', label: 'Stress', action: () => JCVitalV8.syncHistoricalHrv() },
  { key: 'hrv', metric: 'estimatedBp', label: 'Estimated BP', action: () => JCVitalV8.syncHistoricalHrv() },
  { key: 'ppi', metric: 'ppi', label: 'PPI', action: () => JCVitalV8.syncHistoricalPpi() },
] as const

/** Reuses the shared ObservationBatchManager stage strings but presents the certification-specific wording requested for the temperature UI. */
function temperatureStageLabel(stage: string): string {
  return stage === 'Sending certification rows' ? 'Delivering 5 temperature observations' : stage
}

function errorText(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  return code ? `${code}: ${message ?? ''}` : message ?? 'Unknown error'
}

function eventPayloadBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value) ?? '').length
  } catch {
    return 0
  }
}

interface PpgDiagnosticErrorBoundaryProps {
  children: ReactNode
  onError: (error: Record<string, unknown>) => void
}

interface PpgDiagnosticErrorBoundaryState {
  hasError: boolean
}

export class PpgDiagnosticErrorBoundary extends Component<PpgDiagnosticErrorBoundaryProps, PpgDiagnosticErrorBoundaryState> {
  state: PpgDiagnosticErrorBoundaryState = { hasError: false }

  static getDerivedStateFromError(_error: Error): PpgDiagnosticErrorBoundaryState {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    if (IS_ENGINEERING_BUILD) console.error('PPG diagnostics render failure', error.message, error.stack, info.componentStack)
    this.props.onError({ message: error.message, stack: error.stack ?? info.componentStack })
  }

  render() {
    if (this.state.hasError) return <p role="alert">PPG diagnostics encountered an error</p>
    return this.props.children
  }
}

interface RawPpgDiagnosticsViewProps {
  session: JCVitalV8RawPpgSession | null
  chunks: RawPpgChunkSummary
  parseErrors: Array<Record<string, unknown>>
  error: JCVitalV8RawPpgErrorEvent | null
  uiDiagnostics: Pick<RawPpgUiUpdate, 'chunkEventsReceivedByJs' | 'uiUpdateCount' | 'lastEventPayloadBytes' | 'maxEventPayloadBytes'>
  renderErrors: Array<Record<string, unknown>>
  now: number
  startDisabledReason: string | null
  stopDisabledReason: string | null
  busy: boolean
  onStart: () => void
  onStop: () => void
}

export function RawPpgDiagnosticsView({
  session,
  chunks,
  parseErrors,
  error,
  uiDiagnostics,
  renderErrors,
  now,
  startDisabledReason,
  stopDisabledReason,
  busy,
  onStart,
  onStop,
}: RawPpgDiagnosticsViewProps) {
  const validation = buildRawPpgValidation(session, chunks, parseErrors, uiDiagnostics, renderErrors)
  const running = ['STARTING', 'RUNNING', 'STOPPING'].includes(session?.status ?? '')
  const lengthCounts = session?.notificationLengthCounts
  const lastPacketTime = typeof session?.lastPacketAt === 'string' ? Date.parse(session.lastPacketAt) : Number.NaN
  const lastPacketAgeSeconds = Number.isFinite(lastPacketTime) ? Math.max(0, Math.floor((now - lastPacketTime) / 1000)) : null
  return <>
    <div className="wearable-actions">
      <div className="diagnostic-control">
        <button type="button" disabled={busy || startDisabledReason !== null} title={startDisabledReason ?? 'Start 20-second PPG Safe Test'} onClick={onStart}>PPG Safe Test</button>
        {startDisabledReason && <small>Disabled: {startDisabledReason}</small>}
      </div>
      <div className="diagnostic-control">
        <button type="button" disabled={busy || stopDisabledReason !== null} title={stopDisabledReason ?? 'Stop PPG Safe Test'} onClick={onStop}>Stop PPG</button>
        {stopDisabledReason && <small>Disabled: {stopDisabledReason}</small>}
      </div>
    </div>
    <section className="workout-live-diagnostics" aria-label="PPG safe test diagnostics">
      <strong>PPG Safe Test · {session?.status ?? 'IDLE'}</strong>
      <span>Packets: {session?.packetCount ?? chunks.packetCount} · chunks: {session?.chunkCount ?? chunks.chunkCount} · bytes: {session?.bytesReceived ?? chunks.totalBytes}</span>
      <span>153 count: {lengthCounts?.['153'] ?? chunks.notificationLengthCounts['153']} · 203 count: {lengthCounts?.['203'] ?? chunks.notificationLengthCounts['203']} · other count: {lengthCounts?.other ?? chunks.notificationLengthCounts.other}</span>
      <span>Type-119 count: {session?.vendorDataType119Count ?? chunks.vendorDataType119Count}</span>
      <span>Last update age: {lastPacketAgeSeconds == null ? '—' : `${lastPacketAgeSeconds}s`}</span>
      {error && <span role="alert">PPG test error: {error.message}</span>}
    </section>
    {!running && <details className="jcvital-diagnostics">
      <summary>PPG validation · first {Array.isArray(session?.first3Chunks) ? Math.min(session.first3Chunks.length, 3) : 0}, last {Array.isArray(session?.last3Chunks) ? Math.min(session.last3Chunks.length, 3) : 0}</summary>
      <strong>Validation summary</strong><pre>{JSON.stringify(validation, null, 2)}</pre>
    </details>}
  </>
}

const subscribeRawPpgCertification = (listener: (event: RawPpgPhysicalCertificationEvent) => void) =>
  JCVitalV8.addListener('jcvitalRawPpgCertificationStatus', listener)

/** Diagnostic panel for the JCVital Pro V8 native bridge (Android). Displays data only; nothing is queued for upload. */
export function JCVitalV8Panel({ ownerUserId }: { ownerUserId: string }) {
  const ownerRef = useRef(ownerUserId)
  const connectionContext = useMemo(() => ({ accountId: ownerUserId, generation: 0 }), [ownerUserId])
  ownerRef.current = ownerUserId
  const sourceJournalScopeRef = useRef<SourceJournalScope | null>(null)
  const rawPpgSavedEvidenceServiceRef = useRef<RawPpgSavedEvidenceService | null>(null)
  if (!rawPpgSavedEvidenceServiceRef.current) {
    // VC28: historical/offline scope. Never require the live capture scope (null after restart/disconnect).
    rawPpgSavedEvidenceServiceRef.current = new RawPpgSavedEvidenceService(JCVitalV8, () => {
      const live = sourceJournalScopeRef.current
      return {
        accountId: ownerRef.current || null,
        deviceScopeId: live && live.accountId === ownerRef.current ? live.deviceScopeId : null,
      }
    })
  }
  const rawPpgPhysicalCertificationRef = useRef<RawPpgPhysicalCertificationService | null>(null)
  if (!rawPpgPhysicalCertificationRef.current) {
    // VC29: persisted account/device owner; inspection/export work after restart without a connected V8.
    rawPpgPhysicalCertificationRef.current = new RawPpgPhysicalCertificationService(JCVitalV8, () => {
      const live = sourceJournalScopeRef.current
      return {
        accountId: ownerRef.current || null,
        deviceScopeId: live && live.accountId === ownerRef.current ? live.deviceScopeId : null,
      }
    })
  }
  const [sourceJournalDiagnostics, setSourceJournalDiagnostics] = useState<SourceJournalDiagnostics | null>(null)
  const [sourceJournalError, setSourceJournalError] = useState<string | null>(null)
  const [sourceJournalPage, setSourceJournalPage] = useState<string | null>(null)
  const [sourceJournalExportCursor, setSourceJournalExportCursor] = useState(0)
  const [permission, setPermission] = useState<JCVitalV8PermissionResult | null>(null)
  const [state, setState] = useState<JCVitalV8ConnectionState>('DISCONNECTED')
  const [devices, setDevices] = useState<JCVitalV8Device[]>([])
  const [info, setInfo] = useState<JCVitalV8DeviceInfo | null>(null)
  const [battery, setBattery] = useState<JCVitalV8Battery | null>(null)
  const [heartRate, setHeartRate] = useState<JCVitalV8Observation | null>(null)
  const [realtime, setRealtime] = useState(false)
  const [lastError, setLastError] = useState<JCVitalV8ErrorEvent | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [pluginAvailable, setPluginAvailable] = useState<boolean | null>(null)
  const [activeSync, setActiveSync] = useState<string | null>(null)
  const [workoutSession, setWorkoutSession] = useState<JCVitalV8LiveWorkoutSession | null>(null)
  const [workoutPackets, setWorkoutPackets] = useState<LiveWorkoutPacket[]>([])
  const [workoutParseErrors, setWorkoutParseErrors] = useState<Array<Record<string, unknown>>>([])
  const [workoutHeartRateEvent, setWorkoutHeartRateEvent] = useState<JCVitalV8WorkoutHeartRateEvent | null>(null)
  const [workoutError, setWorkoutError] = useState<JCVitalV8WorkoutErrorEvent | null>(null)
  const [workoutClock, setWorkoutClock] = useState(Date.now())
  const [activityMode, setActivityMode] = useState(0)
  const [rawEcgSession, setRawEcgSession] = useState<JCVitalV8RawEcgSession | null>(null)
  const [rawEcgChunks, setRawEcgChunks] = useState<RawEcgChunkSummary>(EMPTY_RAW_ECG_CHUNK_SUMMARY)
  const [rawEcgParseErrors, setRawEcgParseErrors] = useState<Array<Record<string, unknown>>>([])
  const [rawEcgError, setRawEcgError] = useState<JCVitalV8RawEcgErrorEvent | null>(null)
  const [rawEcgClock, setRawEcgClock] = useState(Date.now())
  const [rawPpgSession, setRawPpgSession] = useState<JCVitalV8RawPpgSession | null>(null)
  const [rawPpgChunks, setRawPpgChunks] = useState<RawPpgChunkSummary>(EMPTY_RAW_PPG_CHUNK_SUMMARY)
  const [rawPpgParseErrors, setRawPpgParseErrors] = useState<Array<Record<string, unknown>>>([])
  const [rawPpgError, setRawPpgError] = useState<JCVitalV8RawPpgErrorEvent | null>(null)
  const [rawPpgClock, setRawPpgClock] = useState(Date.now())
  const [rawPpgUiDiagnostics, setRawPpgUiDiagnostics] = useState({
    chunkEventsReceivedByJs: 0,
    uiUpdateCount: 0,
    lastEventPayloadBytes: 0,
    maxEventPayloadBytes: 0,
  })
  const [rawPpgRenderErrors, setRawPpgRenderErrors] = useState<Array<Record<string, unknown>>>([])
  const rawPpgUiCoalescerRef = useRef<ReturnType<typeof createRawPpgUiCoalescer> | null>(null)
  const [historicalRuns, setHistoricalRuns] = useState<Partial<Record<HistoricalFeedKey, HistoricalFeedRun>>>({})
  const [hrStream, setHrStream] = useState<{ native: JCVitalV8HistoricalHrStreamStats | null; js: HistoricalHrStreamSummary } | null>(null)
  const [nativeBreadcrumbs, setNativeBreadcrumbs] = useState<JCVitalV8NativeBreadcrumbs | null>(null)
  const [monitoringRun, setMonitoringRun] = useState<MonitoringFeedRun | undefined>()
  const [phase3bRuns, setPhase3bRuns] = useState<Partial<Record<Exclude<Phase3BFeedKey, 'sleep'>, HistoricalFeedRun>>>({})
  const [sleepRun, setSleepRun] = useState<SleepFeedRun>({})
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null)
  const [exportLocation, setExportLocation] = useState<string | null>(null)
  const hrDeliveryRef = useRef<WorkoutHrDeliveryService | null>(null)
  const [hrDeliverySnapshot, setHrDeliverySnapshot] = useState<WorkoutHrDeliverySnapshot | null>(null)
  const physiologyRef = useRef<JCVitalPhysiologyDelivery | null>(null)
  const [physiologySnapshot, setPhysiologySnapshot] = useState<PhysiologyDeliverySnapshot | null>(null)
  const [deliveryQueueStats, setDeliveryQueueStats] = useState<QueueStats | null>(null)
  const [queueDiagnostics, setQueueDiagnostics] = useState<QueueDiagnostics>(() => observationQueue.getDiagnostics())
  const [queueReadError, setQueueReadError] = useState<string | null>(null)
  const [queueSelfTest, setQueueSelfTest] = useState<QueueSelfTestOutcome | null>(null)
  const [deliveryClock, setDeliveryClock] = useState(Date.now())
  const [deliveryDiagnostics, setDeliveryDiagnostics] = useState<DeliveryDiagnostics>(() => observationBatchManager.getDeliveryDiagnostics())
  const [staleSendingCount, setStaleSendingCount] = useState<number | null>(null)
  const [staleRetryResult, setStaleRetryResult] = useState<string | null>(null)
  const [hrTestEndsAt, setHrTestEndsAt] = useState<number | null>(null)
  const hrTestTimerRef = useRef<number | null>(null)
  const certificationDeliveryRef = useRef(new CertificationDeliveryEvidence())
  const spo2CertificationRef = useRef(new SpO2Certification({
    queue: observationQueue,
    flush: (ids, options) => observationBatchManager.flushCertificationObservationIds(ids, options),
  }))
  const [spo2Inspection, setSpo2Inspection] = useState<SpO2Inspection[] | null>(null)
  const [spo2CertificationRunning, setSpo2CertificationRunning] = useState(false)
  const [spo2CertificationStage, setSpo2CertificationStage] = useState('')
  const [spo2SavedIds, setSpo2SavedIds] = useState<string[]>([])
  const [spo2CaptureCounts, setSpo2CaptureCounts] = useState<{ captured: number; queued: number | null } | null>(null)
  const certificationActiveMetricRef = useRef<'spo2' | 'wearableTemperature' | null>(null)
  const temperatureCertificationRef = useRef(new TemperatureCertification({
    queue: observationQueue,
    flush: (ids, options) => observationBatchManager.flushCertificationObservationIds(ids, options),
  }))
  const [temperatureInspection, setTemperatureInspection] = useState<TemperatureInspection[] | null>(null)
  const [temperatureCertificationRunning, setTemperatureCertificationRunning] = useState(false)
  const [temperatureCertificationStage, setTemperatureCertificationStage] = useState('')
  const [temperatureSavedIds, setTemperatureSavedIds] = useState<string[]>([])
  const [temperatureCaptureCounts, setTemperatureCaptureCounts] = useState<{ captured: number; queued: number | null } | null>(null)
  const type42ContextRef = useRef<Type42ConnectedContext | null>(null)
  type42ContextRef.current = sourceJournalScopeRef.current && info ? {
    scope: sourceJournalScopeRef.current,
    bleAddress: info.macAddress ?? info.deviceId,
    firmwareVersion: info.firmwareVersion ?? null,
    sdkVersion: info.sdkVersion,
    ready: state === 'READY', physical: pluginAvailable === true, native: Capacitor.isNativePlatform(),
  } : null
  const type42CertificationRef = useRef(new Type42Certification({
    queue: observationQueue,
    acquire: () => JCVitalV8.syncHistoricalHrv(),
    journal: JCVitalV8,
    flush: (ids, options) => observationBatchManager.flushCertificationObservationIds(ids, options),
    deliveryDiagnostics: () => observationBatchManager.getDeliveryDiagnostics(),
    connectedContext: () => {
      const context = type42ContextRef.current
      if (!context || context.scope.accountId !== observationQueue.getOwnerUserId()) {
        throw new Error('Connect the authenticated physical V8 to establish its source-journal scope.')
      }
      return context
    },
  }))
  const [type42Status, setType42Status] = useState('')
  const [type42Evidence, setType42Evidence] = useState<string | null>(null)
  const [type42ExportLocation, setType42ExportLocation] = useState<string | null>(null)
  function ppiConnectedContext() {
    const context = type42ContextRef.current
    if (!context || context.scope.accountId !== observationQueue.getOwnerUserId()) {
      throw new Error('Connect the authenticated physical V8 to establish its source-journal scope.')
    }
    return context
  }
  const activityCanonical = useMemo(() => new JCVitalActivityCanonicalization({
    owner: () => observationQueue.getOwnerUserId(),
    resolveDeviceId: (bleAddress) => jcvitalDeviceIdentityService.resolve(bleAddress),
    store: indexedDbActivityLedgerStore,
  }), [])
  async function retainActivityCanonical(results: readonly JCVitalV8HistoricalSyncResult[], context: Type42ConnectedContext) {
    const reports = await canonicalizeAcquiredActivity(activityCanonical, context.scope, context, results)
    const problems = reports.filter((report) => report.status !== 'CANONICALIZED')
    if (problems.length) setMessage(`Activity canonicalization: ${problems.map((report) => report.reason).join('; ')}`)
  }
  function activityV2DeviceContext(
    context: Type42ConnectedContext,
    observations: readonly JCVitalV8HistoricalSyncResult['observations'][number][],
  ): ActivityDeviceContext {
    const native = observations.find((observation) => observation.source.deviceModel !== null) ?? observations[0]
    return {
      ownerUserId: context.scope.accountId,
      deviceId: jcvitalDeviceIdentityService.resolve(context.bleAddress),
      deviceModel: native?.source.deviceModel ?? null,
      firmwareVersion: context.firmwareVersion,
      sdkVersion: context.sdkVersion,
    }
  }
  async function sendSavedActivityV2Verification(): Promise<string> {
    const context = ppiConnectedContext()
    const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
    if (!connectorDeviceId) throw new Error('Connector registration is required before Activity v2 verification.')
    const capabilityScope = {
      ownerUserId: context.scope.accountId,
      installId: installationIdentityService.getInstallId(),
      connectorDeviceId,
    }
    if (!activityV2CapabilityStore.isEnabled(capabilityScope)) {
      const decision = activityV2CapabilityStore.getDecision(capabilityScope)
      throw new Error(`Activity v2 capability gate is closed (${decision.reason}).`)
    }
    const inspection = await activityCertificationRef.current.inspectSaved()
    if (!inspection.group || inspection.status === 'ACTIVITY_CERTIFICATION_EVIDENCE_INVALID') {
      throw new Error(inspection.reason ?? 'No verified saved Activity source evidence is available.')
    }
    const group = inspection.group
    if (!group.type24 || !group.type25Group.length || !group.acquisitionResults) {
      throw new Error('Saved Activity evidence does not contain both Type24 and Type25 source records.')
    }
    const savedNative = group.acquisitionResults.results.flatMap((result) => result.observations)
    const sourceRecords = activityV2SourcesFromNative(savedNative)
    const deviceContext = activityV2DeviceContext(context, savedNative)
    const selected = await selectSavedActivityV2VerificationSources(
      sourceRecords,
      group.type24.sourceEnvelopeId,
      group.type25Group.map((source) => source.sourceEnvelopeId),
      deviceContext,
    )
    if (observationQueue.getOwnerUserId() !== capabilityScope.ownerUserId) {
      throw new Error('Authenticated queue owner changed before Activity v2 verification.')
    }
    const enqueued = await enqueueActivityNativeTransportV2(
      selected, deviceContext, observationQueue, activityV2CapabilityStore.isEnabled(capabilityScope),
    )
    if (enqueued.sourceRecordCount !== 2 || enqueued.payloadCount !== 18) {
      throw new Error('Saved Activity v2 verification did not enqueue the bounded Type24/Type25 evidence.')
    }
    const response = await observationBatchManager.process()
    const selectedIds = new Set(enqueued.payloads.map((payload) => payload.observationId))
    const returned = response?.results?.filter((result) => selectedIds.has(result.observationId)) ?? []
    return `Saved Activity v2 evidence queued: 2 source records, ${enqueued.payloadCount} observations `
      + `(${enqueued.insertedCount} new, ${enqueued.duplicateCount} already queued); existing sender invoked. `
      + `Selected IDs: ${[...selectedIds].map((id) => id.slice(0, 12)).join(', ')}. `
      + `This sender response included ${returned.length}/${selectedIds.size} selected results.`
  }
  const activityCertificationRef = useRef(new Activity24_25Certification({
    queue: observationQueue,
    acquire: async () => {
      const context = ppiConnectedContext()
      const acquired = await JCVitalV8.syncActivityCertification()
      await retainActivityCanonical(acquired.results, context)
      return acquired
    },
    journal: JCVitalV8,
    snapshotStore: JCVitalV8,
    flush: (ids, options) => observationBatchManager.flushCertificationObservationIds(ids, options),
    deliveryDiagnostics: () => observationBatchManager.getDeliveryDiagnostics(),
    connectedContext: ppiConnectedContext,
  }))
  const sleepCertificationRef = useRef(new SleepCertification({
    acquire: () => JCVitalV8.syncSleepCertification(),
    journal: JCVitalV8,
    snapshotStore: JCVitalV8,
    connectedContext: ppiConnectedContext,
    owner: () => observationQueue.getOwnerUserId(),
  }))
  const workoutHistoryCertificationRef = useRef(new WorkoutHistoryCertification({
    acquire: () => JCVitalV8.syncWorkoutHistoryCertification(),
    journal: JCVitalV8,
    snapshotStore: JCVitalV8,
    connectedContext: () => type42ContextRef.current,
    owner: () => observationQueue.getOwnerUserId(),
    contextStore: localStorage,
  }))
  const [ppiAttempt, setPpiAttempt] = useState<PpiAttemptRecord | null>(null)
  const [ppiAttemptJson, setPpiAttemptJson] = useState<PpiCertificationJson | null>(null)
  const [ppiAttemptStatus, setPpiAttemptStatus] = useState('')
  const [ppiShareStatus, setPpiShareStatus] = useState('')
  const [ppiAttemptShareStatus, setPpiAttemptShareStatus] = useState('')
  const ppiAttemptRef = useRef(new PpiCertificationAttempt(() => localStorage, (record) => {
    if (record.accountId === observationQueue.getOwnerUserId()) setPpiAttempt(record)
  }))
  const ppiCertificationRef = useRef(new PpiCertification({
    queue: observationQueue,
    acquire: () => JCVitalV8.syncHistoricalPpi(),
    journal: JCVitalV8,
    flush: (ids, options) => observationBatchManager.flushCertificationObservationIds(ids, options),
    deliveryDiagnostics: () => observationBatchManager.getDeliveryDiagnostics(),
    connectedContext: ppiConnectedContext,
    attemptJournal: JCVitalV8,
    attemptEvent: (stage, status, details, error) => ppiAttemptRef.current.event(stage, status, details, error),
  }))
  // Read-only: no acquire, enqueue, flush, or storage-write dependency is accepted.
  const ppiRecoveryRef = useRef(new PpiCertificationRecovery({
    queue: observationQueue, journal: JCVitalV8, connectedContext: ppiConnectedContext,
  }))
  const [ppiRecoveryEnvelopeId, setPpiRecoveryEnvelopeId] = useState('')
  const [ppiRecoveryReport, setPpiRecoveryReport] = useState<string | null>(null)
  const [ppiRecoveryStatus, setPpiRecoveryStatus] = useState('')
  const [ppiRecoveryExportLocation, setPpiRecoveryExportLocation] = useState<string | null>(null)
  const [ppiCertificationStatus, setPpiCertificationStatus] = useState('')
  const [ppiCertificationEvidence, setPpiCertificationEvidence] = useState<string | null>(null)
  const [ppiCertificationExportLocation, setPpiCertificationExportLocation] = useState<string | null>(null)
  const ppiCurrentInspectionRef = useRef<PpiCertificationInspection | null>(null)
  const [ppiJson, setPpiJson] = useState<PpiCertificationJson | null>(null)
  const [ppiSnapshotStatus, setPpiSnapshotStatus] = useState<string | null>(null)
  const [savedPpiAvailable, setSavedPpiAvailable] = useState(false)
  const [ppiEvidenceOwner, setPpiEvidenceOwner] = useState(ownerUserId)
  if (ppiEvidenceOwner !== ownerUserId) {
    setPpiEvidenceOwner(ownerUserId)
    setPpiJson(null)
    setPpiSnapshotStatus(null)
    setPpiCertificationStatus('')
    setPpiCertificationEvidence(null)
    setPpiCertificationExportLocation(null)
    setSavedPpiAvailable(false)
    setPpiAttempt(null)
    setPpiAttemptJson(null)
    setPpiAttemptStatus('')
    setPpiShareStatus('')
    setPpiAttemptShareStatus('')
  }
  useEffect(() => {
    try {
      setSavedPpiAvailable(ppiCertificationRef.current.hasSavedEvidence())
    } catch (error) {
      setPpiCertificationStatus(`Saved PPI lookup failed: ${errorText(error)}`)
    }
  }, [ownerUserId, ppiCertificationEvidence])

  useEffect(() => {
    sourceJournalScopeRef.current = null
    const generation = connectionContext.generation
    const reset = JCVitalV8.configureSourceJournal({ enabled: false })
    void reset.then(() => {
      if (ownerRef.current !== connectionContext.accountId || connectionContext.generation !== generation) return
      setSourceJournalDiagnostics(null)
      setInfo(null)
    }).catch((error) => {
      if (ownerRef.current !== connectionContext.accountId || connectionContext.generation !== generation) return
      setSourceJournalError(`Journal scope reset failed: ${errorText(error)}`)
    })
    return () => {
      connectionContext.generation++
      sourceJournalScopeRef.current = null
      void JCVitalV8.configureSourceJournal({ enabled: false }).catch((error) => {
        crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Source journal scope cleanup')
        if (IS_ENGINEERING_BUILD) console.error('Source journal scope cleanup failed', error)
      })
    }
  }, [ownerUserId, connectionContext])

  async function refreshSourceJournal(): Promise<void> {
    const scope = sourceJournalScopeRef.current
    if (!scope || scope.accountId !== ownerUserId) throw new Error('Connect a device to configure the authenticated source journal.')
    setSourceJournalDiagnostics(await JCVitalV8.getSourceJournalDiagnostics(scope))
    setSourceJournalError(null)
  }

  async function loadSourceJournalPage(): Promise<void> {
    const scope = sourceJournalScopeRef.current
    if (!scope || scope.accountId !== ownerUserId) throw new Error('Source journal scope is unavailable.')
    const page = await JCVitalV8.exportSourceJournal({ ...scope, afterSequence: sourceJournalExportCursor, limit: 10 })
    setSourceJournalPage(JSON.stringify(page, null, 2))
    setSourceJournalExportCursor(page.hasMore ? page.nextSequence : 0)
    await refreshSourceJournal()
  }

  async function captureType42Certification(): Promise<void> {
    setBusy(true)
    setActiveSync('certification:type42')
    setType42Status('Acquiring type-42 history once')
    setType42ExportLocation(null)
    try {
      const captured = await type42CertificationRef.current.capture()
      if (!captured.group || captured.status === 'TYPE42_CERTIFICATION_EVIDENCE_INVALID') {
        setType42Status(`${captured.status}: ${captured.reason ?? 'No complete source record.'}`)
        return
      }
      setType42Evidence(JSON.stringify(captured.group, null, 2))
      if (captured.status === TYPE42_CERTIFICATION_SUCCESS) {
        setType42Status(captured.status)
        return
      }
      const delivered = await type42CertificationRef.current.flushSaved((stage) => setType42Status(stage))
      setType42Status(delivered.reason ? `${delivered.status}: ${delivered.reason}` : delivered.status)
      setType42Evidence(JSON.stringify(delivered.group, null, 2))
    } catch (error) {
      setType42Status(`Type-42 certification stopped: ${errorText(error)}. Inspect saved evidence; do not reacquire.`)
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'Grouped type-42 certification')
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function inspectType42Certification(): Promise<void> {
    setBusy(true)
    try {
      const inspected = await type42CertificationRef.current.inspectSaved()
      setType42Status(inspected.reason ? `${inspected.status}: ${inspected.reason}` : inspected.status)
      setType42Evidence(inspected.group ? JSON.stringify(inspected.group, null, 2) : null)
    } catch (error) {
      setType42Status(`Type-42 inspection failed: ${errorText(error)}`)
    } finally { setBusy(false) }
  }

  async function exportType42Certification(): Promise<void> {
    setBusy(true)
    setType42ExportLocation(null)
    try {
      const json = await type42CertificationRef.current.exportSaved()
      const filename = `jcvital-type42-certification-vc7-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      setType42ExportLocation(await saveValidationJson(filename, json, 'JCVital type-42 grouped certification',
        'Save or share type-42 source and native-only delivery evidence'))
      setType42Status('EXPORT SUCCESS · durable type-42 source and exact delivery evidence')
    } catch (error) {
      setType42Status(`EXPORT FAILED: ${errorText(error)}`)
    } finally { setBusy(false) }
  }

  async function capturePpiCertification(): Promise<void> {
    const context = type42ContextRef.current
    ppiAttemptRef.current.start(observationQueue.getOwnerUserId(), context?.scope.deviceScopeId ?? null, {
      ready, physical: context?.physical ?? null, native: context?.native ?? null,
      accountId: observationQueue.getOwnerUserId(), deviceScopeId: context?.scope.deviceScopeId ?? null,
    })
    setPpiAttemptJson(null)
    let attemptOutcome = 'FAILED'
    setBusy(true)
    setActiveSync('certification:ppi')
    setPpiCertificationStatus('Acquiring type-127 history once')
    setPpiCertificationExportLocation(null)
    setPpiSnapshotStatus(null)
    setPpiJson(null)
    try {
      const captured = await ppiCertificationRef.current.capture()
      ppiAttemptRef.current.event('CAPTURE_RESULT', 'INFO', { status: captured.status, reason: captured.reason,
        certificationGroupId: captured.group?.certificationGroupId ?? null, delivered: captured.delivered })
      attemptOutcome = captured.status
      if (!captured.group || captured.status === 'PPI_CERTIFICATION_EVIDENCE_INVALID') {
        setPpiCertificationStatus(`${captured.status}: ${captured.reason ?? 'No complete source record.'}`)
        return
      }
      setPpiCertificationEvidence(JSON.stringify(captured.group, null, 2))
      if (captured.status === PPI_CERTIFICATION_SUCCESS) {
        await confirmPpiSnapshot(captured)
        ppiCurrentInspectionRef.current = structuredClone(captured)
        setPpiCertificationStatus(captured.reason ?? captured.status)
        return
      }
      ppiCurrentInspectionRef.current = structuredClone(captured)
      const delivered = await ppiCertificationRef.current.flushSaved((stage) => setPpiCertificationStatus(stage))
      ppiAttemptRef.current.event('DELIVERY_INSPECTION_RESULT', 'INFO', { status: delivered.status, reason: delivered.reason,
        certificationGroupId: delivered.group?.certificationGroupId ?? null, delivered: delivered.delivered })
      attemptOutcome = delivered.status
      if (delivered.status === PPI_CERTIFICATION_SUCCESS) await confirmPpiSnapshot(delivered)
      if (delivered.group && delivered.status !== 'PPI_CERTIFICATION_EVIDENCE_INVALID') {
        ppiCurrentInspectionRef.current = structuredClone(delivered)
      }
      setPpiCertificationStatus(delivered.reason ? `${delivered.status}: ${delivered.reason}` : delivered.status)
      setPpiCertificationEvidence(delivered.group ? JSON.stringify(delivered.group, null, 2) : null)
    } catch (error) {
      attemptOutcome = 'FAILED'
      ppiAttemptRef.current.event('OPERATOR_ACTION', 'FAILED', null, error)
      setPpiCertificationStatus(`PPI certification stopped: ${errorText(error)}. Inspect saved evidence; do not reacquire.`)
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'Grouped PPI certification')
    } finally {
      ppiAttemptRef.current.finish(attemptOutcome)
      setActiveSync(null)
      setBusy(false)
    }
  }

  // VC16: replays the persisted last physical attempt via the unchanged VC15 service; never calls syncHistoricalPpi().
  function createPpiCertificationResume(onEngineStage: (stage: string, status: string, error?: unknown) => void) {
    return new PpiCertificationResume({
      queue: observationQueue,
      journal: JCVitalV8,
      flush: (ids, options) => observationBatchManager.flushCertificationObservationIds(ids, options),
      deliveryDiagnostics: () => observationBatchManager.getDeliveryDiagnostics(),
      connectedContext: ppiConnectedContext,
      attemptJournal: JCVitalV8,
      attemptEvent: (stage, status, _details, error) => onEngineStage(stage, status, error),
    })
  }

  async function resumePpiCertification(): Promise<void> {
    setBusy(true)
    setActiveSync('certification:ppi-resume')
    setPpiCertificationStatus('Resuming PPI certification from last physical attempt (no acquisition)')
    setPpiCertificationExportLocation(null)
    setPpiSnapshotStatus(null)
    setPpiJson(null)
    const owner = observationQueue.getOwnerUserId()
    try {
      const result = await runPpiCertificationResume({
        ownerUserId: () => observationQueue.getOwnerUserId(),
        connectedContext: () => type42ContextRef.current,
        createResume: createPpiCertificationResume,
      })
      if (owner !== observationQueue.getOwnerUserId()) throw new Error('PPI_RESUME_OWNER_CHANGED')
      if (!result.ok) {
        if (result.inspection?.group) setPpiCertificationEvidence(JSON.stringify(result.inspection.group, null, 2))
        setPpiCertificationStatus(ppiResumeFailureText(result))
        return
      }
      ppiCurrentInspectionRef.current = structuredClone(result.inspection)
      setPpiCertificationEvidence(JSON.stringify(result.inspection.group, null, 2))
      setPpiJson(result.json)
      setPpiSnapshotStatus(result.snapshotStatus)
      setPpiCertificationStatus(PPI_CERTIFICATION_SUCCESS)
    } catch (error) {
      setPpiCertificationStatus(`PPI RESUME FAILED · stage: UI · code: PPI_RESUME_UI_ERROR · message: ${errorText(error)}. No physical recapture was attempted.`)
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'PPI certification resume')
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function confirmPpiSnapshot(inspection: PpiCertificationInspection): Promise<void> {
    if (!inspection.group) throw new Error(NO_PPI_CERTIFICATION_GROUP_AVAILABLE)
    const key = ppiCertificationRef.current.verifySnapshotPersisted(inspection.group)
    setPpiSnapshotStatus(ppiSnapshotSavedStatus(inspection, key, false))
    const evidence = await readPpiCertificationJson(ppiCertificationRef.current, inspection)
    setPpiJson(evidence)
    setPpiSnapshotStatus(ppiSnapshotSavedStatus(inspection, key, true))
  }

  async function showPpiAttempt(copy = false): Promise<void> {
    setBusy(true)
    try {
      const owner = observationQueue.getOwnerUserId()
      if (copy && ppiAttemptJson && ppiEvidenceOwner === owner) {
        setPpiAttemptStatus(await copyPpiCertificationJson(ppiAttemptJson))
        return
      }
      const context = type42ContextRef.current
      const record = ppiAttempt?.accountId === owner
        && (!context || ppiAttempt.deviceScopeId === context.scope.deviceScopeId) ? ppiAttempt : null
      if (!record && (!owner || !context || context.scope.accountId !== owner)) {
        throw new Error('Reconnect the same authenticated device to read its saved PPI attempt diagnostic.')
      }
      const saved = record ?? ppiAttemptRef.current.read(owner!, context!.scope.deviceScopeId)
      const json = serializeCertificationJson(saved)
      const evidence = { json, characterCount: json.length, sha256: await sha256Hex(json) }
      if (owner !== observationQueue.getOwnerUserId()) throw new Error('PPI_ATTEMPT_OWNER_CHANGED_DURING_VIEW')
      setPpiAttemptJson(evidence)
      setPpiAttemptStatus(copy ? await copyPpiCertificationJson(evidence) : 'PPI ATTEMPT DIAGNOSTIC AVAILABLE (NOT CERTIFICATION SUCCESS)')
    } catch (error) {
      setPpiAttemptStatus(`PPI attempt diagnostic unavailable: ${errorText(error)}`)
    } finally { setBusy(false) }
  }

  async function showPpiCertificationJson(savedOnly = false, copy = false): Promise<void> {
    setBusy(true)
    if (!copy) setPpiJson(null)
    try {
      const current = ppiCurrentInspectionRef.current
      const inspection = !savedOnly && current?.group?.ownerUserId === observationQueue.getOwnerUserId() ? current : null
      const evidence = copy && ppiJson && ppiEvidenceOwner === observationQueue.getOwnerUserId()
        ? ppiJson : await readPpiCertificationJson(ppiCertificationRef.current, inspection)
      setPpiJson(evidence)
      setPpiCertificationStatus(copy ? await copyPpiCertificationJson(evidence) : 'PPI CERTIFICATION JSON AVAILABLE')
    } catch (error) {
      setPpiCertificationStatus(`PPI JSON unavailable: ${errorText(error)}`)
    } finally { setBusy(false) }
  }

  async function shareDisplayedPpiJson(attempt = false): Promise<void> {
    const setStatus = attempt ? setPpiAttemptShareStatus : setPpiShareStatus
    const evidence = attempt ? ppiAttemptJson : ppiJson
    setBusy(true)
    try {
      if (ppiEvidenceOwner !== observationQueue.getOwnerUserId()) throw new Error('PPI_JSON_OWNER_CHANGED')
      if (!evidence) throw new Error(attempt
        ? 'Show Last PPI Certification Attempt before sharing its JSON.'
        : 'Show PPI Certification JSON before sharing its JSON.')
      const filename = attempt ? 'JCVital PPI certification attempt.json' : PPI_CERTIFICATION_FILENAME
      const location = await saveValidationJson(filename, evidence.json,
        attempt ? 'JCVital PPI certification attempt' : 'JCVital PPI grouped certification',
        attempt ? 'Share / Save Last PPI Certification Attempt' : 'Share / Save PPI JSON')
      setStatus(`PPI JSON SHARE / SAVE COMPLETE · SHA-256: ${evidence.sha256} · ${location}`)
    } catch (error) {
      setStatus(`PPI JSON SHARE / SAVE FAILED: ${errorText(error)}. Displayed JSON remains available.`)
    } finally { setBusy(false) }
  }

  async function inspectPpiCertification(): Promise<void> {
    setBusy(true)
    try {
      if (!ppiCertificationRef.current.hasSavedEvidence()) {
        setPpiCertificationStatus(NO_PPI_CERTIFICATION_GROUP_AVAILABLE)
        setPpiCertificationEvidence(null)
        return
      }
      const inspected = await ppiCertificationRef.current.inspectSaved()
      setPpiCertificationStatus(!inspected.group && !inspected.diagnostic ? NO_PPI_CERTIFICATION_GROUP_AVAILABLE
        : inspected.reason ? `${inspected.status}: ${inspected.reason}` : inspected.status)
      setPpiCertificationEvidence(inspected.group ? JSON.stringify(inspected.group, null, 2) : null)
    } catch (error) {
      setPpiCertificationStatus(`PPI inspection failed: ${errorText(error)}`)
    } finally { setBusy(false) }
  }

  async function exportPpiCertification(): Promise<void> {
    setBusy(true)
    setPpiCertificationExportLocation(null)
    try {
      if (!ppiCertificationRef.current.hasSavedEvidence()) {
        setPpiCertificationStatus(NO_PPI_CERTIFICATION_GROUP_AVAILABLE)
        return
      }
      setPpiCertificationExportLocation(await exportPpiCertificationFile(ppiCertificationRef.current))
      setPpiCertificationStatus('EXPORT SUCCESS · complete type-127 source and exact selected-slot delivery evidence')
    } catch (error) {
      setPpiCertificationStatus(`Export failed; saved evidence retained. ${errorText(error)}. Do not reacquire.`)
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'Saved PPI certification export')
    } finally { setBusy(false) }
  }

  async function findSavedPpiCertification(): Promise<void> {
    setBusy(true)
    setPpiRecoveryExportLocation(null)
    try {
      const recovered = await ppiRecoveryRef.current.recover({ sourceEnvelopeId: ppiRecoveryEnvelopeId.trim() || undefined })
      setPpiRecoveryStatus(`${recovered.classification}${recovered.recoverySource ? ` · ${recovered.recoverySource}` : ''}`
        + ` · certificationSuccess=${recovered.certificationSuccess} · ${recovered.reason}`)
      const { group, ...report } = recovered
      setPpiRecoveryReport(JSON.stringify({ ...report, group: group ? { certificationGroupId: group.certificationGroupId } : null }, null, 2))
    } catch (error) {
      setPpiRecoveryStatus(`Saved PPI discovery failed: ${errorText(error)}. Nothing was modified; do not reacquire.`)
    } finally { setBusy(false) }
  }

  async function exportRecoveredPpiCertification(): Promise<void> {
    setBusy(true)
    setPpiRecoveryExportLocation(null)
    try {
      const json = await ppiRecoveryRef.current.exportRecovered({ sourceEnvelopeId: ppiRecoveryEnvelopeId.trim() || undefined })
      setPpiRecoveryExportLocation(await saveValidationJson(PPI_RECOVERED_CERTIFICATION_FILENAME, json,
        'JCVital PPI recovered certification', 'Save or share recovered PPI physical evidence'))
      const parsed = JSON.parse(json) as { classification: string; recoverySource: string; certificationSuccess: boolean }
      setPpiRecoveryStatus(`RECOVERY EXPORT · ${parsed.classification} · ${parsed.recoverySource} · certificationSuccess=${parsed.certificationSuccess}`)
    } catch (error) {
      setPpiRecoveryStatus(`Recovered PPI export failed: ${errorText(error)}. Nothing was modified; do not reacquire.`)
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'Recovered PPI certification export')
    } finally { setBusy(false) }
  }

  useEffect(() => {
    const hrDelivery = new WorkoutHrDeliveryService({
      queue: observationQueue,
      deliver: () => observationBatchManager.process(),
      subscribe: (listener) => observationBatchManager.subscribe(listener),
      resolveDeviceId: (bleAddress) => jcvitalDeviceIdentityService.resolve(bleAddress),
    })
    hrDeliveryRef.current = hrDelivery
    const unsubscribe = hrDelivery.onChange(() => setHrDeliverySnapshot(hrDelivery.getSnapshot()))
    hrDelivery.start()
    const physiology = new JCVitalPhysiologyDelivery({
      queue: observationQueue,
      deliver: () => observationBatchManager.process(),
      subscribe: (listener) => observationBatchManager.subscribe(listener),
      deliveryDiagnostics: () => observationBatchManager.getDeliveryDiagnostics(),
      rememberCertification: (observations) => {
        if (observations[0]?.vendorDataType === '68') { certificationActiveMetricRef.current = 'spo2'; spo2CertificationRef.current.remember(observations) }
        else if (observations[0]?.vendorDataType === '59') { certificationActiveMetricRef.current = 'wearableTemperature'; temperatureCertificationRef.current.remember(observations) }
      },
      onCertificationQueued: (count) => {
        if (certificationActiveMetricRef.current === 'spo2') {
          setSpo2CaptureCounts((current) => current ? { ...current, queued: count } : current)
          setSpo2CertificationStage(`${count} observations durably queued`)
        } else if (certificationActiveMetricRef.current === 'wearableTemperature') {
          setTemperatureCaptureCounts((current) => current ? { ...current, queued: count } : current)
          setTemperatureCertificationStage(`Certification sample queued: ${count} observations durably queued`)
        }
      },
      flushCertification: (ids, metric) => {
        setBusy(false)
        if (metric === 'spo2') { setSpo2CertificationStage('Temporarily prioritizing certification rows'); return spo2CertificationRef.current.flush(ids, setSpo2CertificationStage) }
        if (metric === 'wearableTemperature') {
          setTemperatureCertificationStage('Temporarily prioritizing certification rows')
          return temperatureCertificationRef.current.flush(ids, (stage) => setTemperatureCertificationStage(temperatureStageLabel(stage)))
        }
        return observationBatchManager.flushCertificationObservationIds(ids)
      },
      resolveDeviceId: (bleAddress) => jcvitalDeviceIdentityService.resolve(bleAddress),
    })
    physiologyRef.current = physiology
    const unsubscribePhysiology = physiology.onChange(() => setPhysiologySnapshot(physiology.getSnapshot()))
    const unsubscribeCertification = observationBatchManager.subscribe((event) => {
      certificationDeliveryRef.current.record(observationQueue.getOwnerUserId(), event)
      if (observationQueue.getOwnerUserId()) {
        try { spo2CertificationRef.current.record(event) } catch (error) {
          crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'Persisting SpO2 certification evidence')
          setMessage(errorText(error))
        }
        try { temperatureCertificationRef.current.record(event) } catch (error) {
          crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'Persisting wearable temperature certification evidence')
          setMessage(errorText(error))
        }
      }
    })
    physiology.start()
    return () => {
      unsubscribe()
      hrDelivery.dispose()
      hrDeliveryRef.current = null
      unsubscribePhysiology()
      unsubscribeCertification()
      physiology.dispose()
      physiologyRef.current = null
      if (hrTestTimerRef.current !== null) window.clearTimeout(hrTestTimerRef.current)
      hrTestTimerRef.current = null
    }
  }, [])

  useEffect(() => {
    if (info) hrDeliveryRef.current?.setContext({ bleAddress: info.macAddress ?? info.deviceId, firmwareVersion: info.firmwareVersion ?? null, sdkVersion: info.sdkVersion })
    if (info) physiologyRef.current?.setContext({ bleAddress: info.macAddress ?? info.deviceId, firmwareVersion: info.firmwareVersion ?? null, sdkVersion: info.sdkVersion })
  }, [info])

  useEffect(() => {
    const refresh = () => {
      setDeliveryClock(Date.now())
      setDeliveryDiagnostics(observationBatchManager.getDeliveryDiagnostics())
      void observationBatchManager.getStaleSendingCount().then(setStaleSendingCount, () => setStaleSendingCount(null))
      void observationQueue.getQueueStats().then(
        (stats) => { setDeliveryQueueStats(stats); setQueueReadError(null) },
        (error) => { setDeliveryQueueStats(null); setQueueReadError(errorText(error)) },
      ).finally(() => setQueueDiagnostics(observationQueue.getDiagnostics()))
    }
    refresh()
    const timer = window.setInterval(refresh, 2000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const ppgCoalescer = createRawPpgUiCoalescer((update) => {
      if (update.status) {
        const status = update.status
        setRawPpgSession((current) => mergeRawPpgSession(current, status))
        if (['STARTING', 'RUNNING', 'STOPPING'].includes(update.status.status)) setActiveSync((current) => current ?? 'raw-ppg')
        else setActiveSync((current) => current?.startsWith('raw-ppg') ? null : current)
      }
      if (update.chunk) setRawPpgChunks((current) => includeRawPpgChunk(current, update.chunk!))
      if (update.error) {
        setRawPpgError(update.error)
        setRawPpgParseErrors((current) => [...current, update.error as unknown as Record<string, unknown>].slice(-50))
      }
      setRawPpgUiDiagnostics((current) => ({
        chunkEventsReceivedByJs: current.chunkEventsReceivedByJs + update.chunkEventsReceivedByJs,
        uiUpdateCount: current.uiUpdateCount + 1,
        lastEventPayloadBytes: update.lastEventPayloadBytes,
        maxEventPayloadBytes: Math.max(current.maxEventPayloadBytes, update.maxEventPayloadBytes),
      }))
    })
    rawPpgUiCoalescerRef.current = ppgCoalescer
    const handles = [
      JCVitalV8.addListener('jcvitalScanResult', (device) =>
        setDevices((current) => [device, ...current.filter((item) => item.id !== device.id)].sort((a, b) => Number(b.advertisesJcvitalService) - Number(a.advertisesJcvitalService) || b.rssi - a.rssi))),
      JCVitalV8.addListener('jcvitalConnectionState', (event) => {
        setState(event.state)
        if (event.state !== 'READY') {
          setRealtime(false)
          setActiveSync((current) => current === 'manual:realtime' ? null : current)
        }
      }),
      JCVitalV8.addListener('jcvitalDeviceInfo', setInfo),
      JCVitalV8.addListener('jcvitalBattery', setBattery),
      JCVitalV8.addListener('jcvitalHeartRate', setHeartRate),
      JCVitalV8.addListener('jcvitalError', setLastError),
      JCVitalV8.addListener('sourceJournalOutcome', (outcome) => {
        setSourceJournalError(`L0 preservation ${outcome.operation}: ${outcome.status}. Capture stopped; existing source evidence is retained.`)
      }),
      JCVitalV8.addListener('jcvitalWorkoutState', (session) => {
        setWorkoutSession(session)
        hrDeliveryRef.current?.setContext({ bleAddress: session.deviceId, firmwareVersion: session.firmwareVersion, sdkVersion: session.sdkVersion, vendorActivityMode: session.vendorActivityMode })
        if (['IDLE', 'STOPPED', 'ERROR', 'DISCONNECTED'].includes(session.status)) {
          if (session.status !== 'IDLE') void hrDeliveryRef.current?.handleWorkoutEnded(session.sessionId)
          setActiveSync((current) => current?.startsWith('workout:') ? null : current)
        } else {
          setActiveSync((current) => current ?? 'workout:capture')
        }
      }),
      JCVitalV8.addListener('jcvitalWorkoutPacket', (packet) => {
        setWorkoutPackets((current) => current.length && current[current.length - 1].sessionId === packet.sessionId
          ? [...current, packet]
          : [packet])
      }),
      JCVitalV8.addListener('jcvitalWorkoutHeartRate', (event) => {
        setWorkoutHeartRateEvent(event)
        hrDeliveryRef.current?.handleHeartRate(event)
      }),
      JCVitalV8.addListener('jcvitalWorkoutError', setWorkoutError),
      JCVitalV8.addListener('jcvitalWorkoutParseError', (error) => {
        setWorkoutParseErrors((current) => [...current, typeof error === 'object' && error !== null ? error as Record<string, unknown> : { error }])
      }),
      JCVitalV8.addListener('jcvitalRawEcgStatus', (session) => {
        setRawEcgSession(session)
        if (['STARTING', 'RUNNING', 'STOPPING'].includes(session.status)) setActiveSync((current) => current ?? 'raw-ecg')
        else setActiveSync((current) => current?.startsWith('raw-ecg') ? null : current)
      }),
      JCVitalV8.addListener('jcvitalRawEcgChunk', (chunk) => {
        setRawEcgChunks((current) => includeRawEcgChunk(current, chunk))
      }),
      JCVitalV8.addListener('jcvitalRawEcgError', (error) => {
        setRawEcgError(error)
        setRawEcgParseErrors((current) => [...current, error as unknown as Record<string, unknown>])
      }),
      JCVitalV8.addListener('jcvitalRawPpgStatus', (session) => {
        if (session && typeof session === 'object') ppgCoalescer.pushStatus(session, eventPayloadBytes(session))
      }),
      JCVitalV8.addListener('jcvitalRawPpgChunk', (chunk) => {
        if (chunk && typeof chunk === 'object') ppgCoalescer.pushChunk(chunk, eventPayloadBytes(chunk))
      }),
      JCVitalV8.addListener('jcvitalRawPpgError', (error) => {
        if (error && typeof error === 'object') ppgCoalescer.pushError(error, eventPayloadBytes(error))
      }),
    ]
    void JCVitalV8.isAvailable().then((result) => setPluginAvailable(result.available)).catch(() => setPluginAvailable(false))
    void JCVitalV8.getNativeBreadcrumbs().then(setNativeBreadcrumbs).catch(() => undefined)
    void JCVitalV8.getPermissionStatus().then(setPermission).catch((error) => setMessage(errorText(error)))
    void JCVitalV8.getConnectionState().then((result) => setState(result.state)).catch(() => undefined)
    void JCVitalV8.getWorkoutCaptureStatus().then((session) => {
      setWorkoutSession(session)
      if (!['IDLE', 'STOPPED', 'ERROR', 'DISCONNECTED'].includes(session.status)) setActiveSync('workout:capture')
    }).catch(() => undefined)
    void JCVitalV8.getRawEcgStatus().then((session) => {
      setRawEcgSession(session)
      if (['STARTING', 'RUNNING', 'STOPPING'].includes(session.status)) setActiveSync((current) => current ?? 'raw-ecg')
    }).catch(() => undefined)
    void JCVitalV8.getRawPpgStatus().then((session) => {
      setRawPpgSession((current) => mergeRawPpgSession(current, session))
      if (['STARTING', 'RUNNING', 'STOPPING'].includes(session.status)) setActiveSync((current) => current ?? 'raw-ppg')
    }).catch(() => undefined)
    return () => {
      ppgCoalescer.cancel()
      rawPpgUiCoalescerRef.current = null
      handles.forEach((handle) => void handle.then((h) => h.remove()))
    }
  }, [])

  useEffect(() => {
    if (!workoutSession || !['RUNNING', 'PAUSED', 'STARTING', 'STOPPING'].includes(workoutSession.status)) return
    const timer = window.setInterval(() => setWorkoutClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [workoutSession?.status, workoutSession?.sessionId])

  useEffect(() => {
    if (!rawEcgSession || !['STARTING', 'RUNNING', 'STOPPING'].includes(rawEcgSession.status)) return
    const timer = window.setInterval(() => setRawEcgClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [rawEcgSession?.status, rawEcgSession?.sessionId])

  useEffect(() => {
    if (!rawPpgSession || !['STARTING', 'RUNNING', 'STOPPING'].includes(rawPpgSession.status)) return
    const timer = window.setInterval(() => setRawPpgClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [rawPpgSession?.status, rawPpgSession?.sessionId])

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) }
  }

  async function executeHistoricalSync(key: HistoricalFeedKey, action: () => Promise<JCVitalV8HistoricalSyncResult>, delivery: FocusedDeliveryOptions = {}): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    const prefix = key === 'heartRate' ? 'HR' : key.toUpperCase()
    crashBreadcrumbs.record(`${prefix}_SYNC_STARTED`, { safeTest: false })
    setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    let result: JCVitalV8HistoricalSyncResult
    try {
      const nativeResult = await action()
      crashBreadcrumbs.record(`${prefix}_SYNC_NATIVE_COMPLETE`, { completionStatus: nativeResult.completionStatus, packets: nativeResult.packetCount })
      crashBreadcrumbs.record(`${prefix}_SOURCE_RECORD_COUNT`, { sourceRecords: nativeResult.recordGroupsReceived })
      const audit = auditHistoricalResult(nativeResult)
      crashBreadcrumbs.record(`${prefix}_NORMALIZED_COUNT`, { normalized: audit.normalizedObservations, estimatedNativeResultBytes: audit.estimatedNativeResultBytes, envelopeDuplicated: audit.rawPayloadEnvelopeDuplicated, estimatedDuplicatedEnvelopeBytes: audit.estimatedDuplicatedEnvelopeBytes })
      // Only first/last samples keep raw vendor payloads in React state and exports.
      result = boundHistoricalResult(nativeResult)
      if (delivery.deliveryMode === 'CERTIFICATION_DELIVER' && key === 'spo2') {
        setSpo2CaptureCounts({ captured: result.observations.length, queued: null })
        setSpo2CertificationStage(`${result.observations.length} observations captured; mapping and durably queueing`)
      }
      if (delivery.deliveryMode === 'CERTIFICATION_DELIVER' && key === 'temperature') {
        setTemperatureCaptureCounts({ captured: result.observations.length, queued: null })
        setTemperatureCertificationStage(`Temperature observations normalized: ${result.observations.length} observations; mapping and durably queueing`)
      }
      setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, `${prefix} native sync`)
      setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      if (key === 'spo2' && delivery.deliveryMode === 'CERTIFICATION_DELIVER') setSpo2CertificationStage(`Capture failed or partial: ${text}`)
      if (key === 'temperature' && delivery.deliveryMode === 'CERTIFICATION_DELIVER') setTemperatureCertificationStage(`Capture failed or partial: ${text}`)
      setMessage((current) => current ? `${current}; ${text}` : text)
      return
    }
    const physiology = physiologyRef.current
    if (delivery.deliveryMode === 'CERTIFICATION_DELIVER') {
      try {
        if (!physiology) throw new Error('Physiology delivery service unavailable; capture retained but not delivered.')
        setMessage(`${delivery.certificationMetric}: captured; awaiting exact-ID certification delivery…`)
        const report = await physiology.deliverSyncResult(result, delivery)
        if (key === 'spo2') setSpo2CertificationStage(report.delivered
          ? `${report.queued + report.alreadyQueued} durably queued; ${report.observations?.length ?? 0}/${report.observations?.length ?? 0} targeted samples delivered`
          : report.reason ?? 'Captured and queued; backend delivery pending')
        if (key === 'temperature') setTemperatureCertificationStage(report.delivered
          ? '5/5 delivered. Export JSON and STOP for review.'
          : report.reason ?? 'Captured and queued; backend delivery pending')
        setPhysiologySnapshot(physiology.getSnapshot())
        setHistoricalRuns((current) => ({
          ...current,
          [key]: { ...current[key]!, certificationDelivery: { completedAt: new Date().toISOString(), report } },
        }))
        setMessage(report.delivered
          ? `${delivery.certificationMetric}: exact-ID delivery confirmed. Export JSON and STOP for review.`
          : report.reason ?? 'Certification delivery unconfirmed. Export JSON and STOP for review.')
      } catch (error) {
        crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, `${prefix} certification delivery`)
        setMessage(`Capture retained; certification delivery failed: ${errorText(error)}. Export JSON and STOP.`)
        if (key === 'spo2') setSpo2CertificationStage(`Capture retained; delivery failed/pending: ${errorText(error)}. Inspect before retrying.`)
        if (key === 'temperature') setTemperatureCertificationStage(`Capture retained; delivery failed/pending: ${errorText(error)}. Inspect before retrying.`)
      }
    } else if (delivery.deliveryMode !== 'CAPTURE_ONLY' && physiology?.isEnabled()) {
      // Ordinary sync retains the existing opt-in master-toggle behavior.
      void physiology.deliverSyncResult(result).catch((error) => {
        crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, prefix)
        setMessage(errorText(error))
      })
    }
  }

  /**
   * Historical HR arrives as bounded native chunks; each chunk is mapped and enqueued, then released. Screen state keeps
   * only totals and first/last samples. maxValidSamples is enforced natively, before the bridge.
   */
  async function executeHistoricalHrStream(maxValidSamples?: number): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    const safeTest = maxValidSamples !== undefined
    crashBreadcrumbs.record('HR_SYNC_STARTED', { safeTest, nativeLimit: maxValidSamples ?? null, streamed: true })
    setHistoricalRuns((current) => ({ ...current, heartRate: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    setHrStream(null)
    const physiology = physiologyRef.current
    const deliver = physiology !== null && (safeTest || physiology.isEnabled())
    const collector = new HistoricalHrStreamCollector()
    let work: Promise<void> = Promise.resolve()
    let deliveryFailed = false
    const onDeliveryError = (error: unknown, context: string) => {
      deliveryFailed = true
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, context)
      setMessage(errorText(error))
    }
    const handle = await JCVitalV8.addListener('jcvitalHistoricalHrChunk', (chunk) => {
      const observations = collector.accept(chunk)
      if (!observations) return
      crashBreadcrumbs.record('HR_CHUNK_RECEIVED', { chunk: chunk.chunkIndex, samples: observations.length, isFinal: chunk.isFinal, estimatedBytes: chunk.estimatedSerializedBytes })
      setHrStream({ native: null, js: collector.summary() })
      // Native emits the next chunk only after this ack, so the bridge never holds more than a small window.
      work = work.then(async () => {
        if (!deliver || !physiology || !observations.length || deliveryFailed) return
        await physiology.deliverSyncResult(chunkAsSyncResult(chunk, observations), {
          ...(maxValidSamples !== undefined ? { maxObservations: maxValidSamples } : {}),
          deferDrain: true,
          expectedTotalObservations: chunk.plannedSampleCount,
        })
      }).catch((error) => onDeliveryError(error, `HR chunk ${chunk.chunkIndex}`))
        .finally(() => JCVitalV8.ackHistoricalHrChunk({ syncSessionId: chunk.syncSessionId, chunkIndex: chunk.chunkIndex }).catch(() => undefined))
    })
    try {
      const nativeResult = await JCVitalV8.syncHistoricalHeartRate(safeTest ? { maxValidSamples } : {})
      crashBreadcrumbs.record('HR_SYNC_NATIVE_COMPLETE', { completionStatus: nativeResult.completionStatus, packets: nativeResult.packetCount, chunks: nativeResult.stream?.chunkCount ?? null, vendorOrder: nativeResult.stream?.vendorRecordOrder ?? null })
      const finalReceived = nativeResult.stream?.finalEmitted === false ? false : await collector.waitForFinal(FINAL_HR_CHUNK_WAIT_MS)
      const summary = collector.summary()
      crashBreadcrumbs.record('HR_SOURCE_RECORD_COUNT', { sourceRecords: nativeResult.recordGroupsReceived })
      crashBreadcrumbs.record('HR_NORMALIZED_COUNT', { normalized: summary.observationsReceived, nativeEmitted: nativeResult.stream?.emittedSampleCount ?? null, chunks: summary.chunksReceived, finalReceived })
      setHrStream({ native: nativeResult.stream ?? null, js: summary })
      setHistoricalRuns((current) => ({ ...current, heartRate: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: collector.toSyncResult(nativeResult), error: null, streamSummary: summary } }))
      if (!finalReceived) setMessage('Historical HR: final native chunk not received; delivered chunks remain queued.')
      if (deliver && physiology) {
        void work.then(() => deliveryFailed ? undefined : physiology.drainDeferred(nativeResult.vendorDataType)).catch((error) => onDeliveryError(error, 'HR drain'))
      }
    } catch (error) {
      const text = errorText(error)
      crashBreadcrumbs.recordError('lastHistoricalDeliveryError', error, 'HR native sync')
      setHistoricalRuns((current) => ({ ...current, heartRate: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text, streamSummary: collector.summary() } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    } finally {
      void handle.remove()
      void JCVitalV8.getNativeBreadcrumbs().then(setNativeBreadcrumbs).catch(() => undefined)
    }
  }

  async function runHistoricalHrStream(maxValidSamples?: number): Promise<void> {
    setBusy(true)
    setActiveSync('phase3a:heartRate')
    setMessage('')
    try { await executeHistoricalHrStream(maxValidSamples) } finally { setActiveSync(null); setBusy(false) }
  }

  async function runSync(key: HistoricalFeedKey, action: () => Promise<JCVitalV8HistoricalSyncResult>, delivery: FocusedDeliveryOptions = {}): Promise<void> {
    setBusy(true)
    setActiveSync(delivery.deliveryMode === 'CERTIFICATION_DELIVER' ? `certification:${delivery.certificationMetric}` : `phase3a:${key}`)
    setMessage('')
    try { await executeHistoricalSync(key, action, delivery) } finally { setActiveSync(null); setBusy(false) }
  }

  async function inspectPriorSpo2(): Promise<void> {
    setSpo2CertificationRunning(true)
    setSpo2CertificationStage('Inspecting queue')
    try {
      const inspection = await spo2CertificationRef.current.inspect()
      setSpo2Inspection(inspection)
      setSpo2SavedIds(spo2CertificationRef.current.snapshot().samples.flatMap((sample) => sample.observationId ? [sample.observationId] : []))
      const found = inspection.filter((item) => item.status !== 'NOT_FOUND').length
      setSpo2CertificationStage(found
        ? `Found ${found}/5 certification observations/evidence. Do not reacquire SpO2.`
        : 'FIRST VC3 ATTEMPT DID NOT LEAVE DURABLE EVIDENCE FOR THE FIVE CERTIFICATION IDS')
    } catch (error) {
      setSpo2Inspection(null)
      setSpo2CertificationStage(`Inspection failed: ${errorText(error)}`)
    } finally { setSpo2CertificationRunning(false) }
  }

  async function flushPriorSpo2(): Promise<void> {
    setSpo2CertificationRunning(true)
    try {
      const known = await spo2CertificationRef.current.inspect()
      const ids = known.some((item) => item.status !== 'NOT_FOUND') ? PRIOR_SPO2_CERTIFICATION_IDS
        : spo2CertificationRef.current.snapshot().samples.flatMap((sample) => sample.observationId ? [sample.observationId] : []).slice(0, 5)
      const report = await spo2CertificationRef.current.flush(ids, setSpo2CertificationStage)
      const inspection = await spo2CertificationRef.current.inspect(ids)
      setSpo2Inspection(inspection)
      const delivered = spo2CertificationRef.current.snapshot().samples.filter((sample) =>
        ids.some((id) => id === sample.observationId)
        && ['DELIVERED_CANONICALIZED', 'DELIVERED_DUPLICATE'].includes(sample.deliveryState)).length
      setSpo2CertificationStage(report.reason ?? `${delivered}/${ids.length} delivered. Export JSON and STOP.`)
    } catch (error) {
      setSpo2CertificationStage(`Targeted flush failed: ${errorText(error)}. Inspect; do not reacquire.`)
    } finally { setSpo2CertificationRunning(false) }
  }

  async function captureTargetedSpo2(): Promise<void> {
    setSpo2CertificationRunning(true)
    try {
      const inspection = await spo2CertificationRef.current.inspect()
      setSpo2Inspection(inspection)
      if (inspection.some((item) => item.status !== 'NOT_FOUND')) {
        setSpo2CertificationStage('Prior observations/evidence found. Use Flush existing SpO2 certification rows; do not reacquire.')
        return
      }
      const restored = spo2CertificationRef.current.snapshot().samples
      if (restored.length) {
        setSpo2CertificationStage('A prior certification sample is already recorded. Inspect/flush those exact IDs; do not reacquire.')
        return
      }
      setSpo2CertificationStage('Capturing SpO2')
      await runSync('spo2', () => JCVitalV8.syncHistoricalSpo2(), { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'spo2' })
    } catch (error) {
      setSpo2CertificationStage(`Capture/queue failed or pending: ${errorText(error)}. Inspect before retrying.`)
    } finally { setSpo2CertificationRunning(false) }
  }

  /** First physical attempt for type-59 wearable temperature: no prior hardcoded ID list exists to recover. */
  async function inspectPersistedTemperature(): Promise<void> {
    setTemperatureCertificationRunning(true)
    setTemperatureCertificationStage('Inspecting queue')
    try {
      const ids = temperatureCertificationRef.current.snapshot().samples.flatMap((sample) => sample.observationId ? [sample.observationId] : [])
      if (!ids.length) {
        setTemperatureInspection(null)
        setTemperatureSavedIds([])
        setTemperatureCertificationStage('No persisted wearable temperature certification evidence yet. Use Capture + Queue + Targeted Deliver Temperature.')
        return
      }
      const inspection = await temperatureCertificationRef.current.inspect(ids)
      setTemperatureInspection(inspection)
      setTemperatureSavedIds(ids)
      const found = inspection.filter((item) => item.status !== 'NOT_FOUND').length
      setTemperatureCertificationStage(found
        ? `Found ${found}/${ids.length} certification observations/evidence. Do not reacquire wearable temperature.`
        : 'Persisted sample IDs found but Base44 reports no rows for them.')
    } catch (error) {
      setTemperatureInspection(null)
      setTemperatureCertificationStage(`Inspection failed: ${errorText(error)}`)
    } finally { setTemperatureCertificationRunning(false) }
  }

  async function flushPersistedTemperature(): Promise<void> {
    setTemperatureCertificationRunning(true)
    try {
      const ids = temperatureCertificationRef.current.snapshot().samples.flatMap((sample) => sample.observationId ? [sample.observationId] : []).slice(0, 5)
      if (!ids.length) { setTemperatureCertificationStage('No persisted wearable temperature certification IDs to flush.'); return }
      const report = await temperatureCertificationRef.current.flush(ids, (stage) => setTemperatureCertificationStage(temperatureStageLabel(stage)))
      const inspection = await temperatureCertificationRef.current.inspect(ids)
      setTemperatureInspection(inspection)
      const delivered = temperatureCertificationRef.current.snapshot().samples.filter((sample) =>
        ids.some((id) => id === sample.observationId)
        && ['DELIVERED_CANONICALIZED', 'DELIVERED_DUPLICATE'].includes(sample.deliveryState)).length
      setTemperatureCertificationStage(report.reason ?? `${delivered}/${ids.length} delivered. Export JSON and STOP.`)
    } catch (error) {
      setTemperatureCertificationStage(`Targeted flush failed: ${errorText(error)}. Inspect; do not reacquire.`)
    } finally { setTemperatureCertificationRunning(false) }
  }

  async function captureTargetedTemperature(): Promise<void> {
    setTemperatureCertificationRunning(true)
    try {
      const restored = temperatureCertificationRef.current.snapshot().samples
      if (restored.length) {
        const ids = restored.flatMap((sample) => sample.observationId ? [sample.observationId] : []).slice(0, 5)
        const inspection = await temperatureCertificationRef.current.inspect(ids)
        setTemperatureInspection(inspection)
        setTemperatureCertificationStage('A prior certification sample is already recorded. Inspect/flush those exact IDs; do not reacquire.')
        return
      }
      setTemperatureCertificationStage('Capturing temperature')
      await runSync('temperature', () => JCVitalV8.syncHistoricalTemperature(), { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: 'wearableTemperature' })
    } catch (error) {
      setTemperatureCertificationStage(`Capture/queue failed or pending: ${errorText(error)}. Inspect before retrying.`)
    } finally { setTemperatureCertificationRunning(false) }
  }

  async function syncMonitoringConfiguration(): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setBusy(true)
    setActiveSync('monitoring-configuration')
    setMessage('')
    setMonitoringRun({ requestStartedAt, requestCompletedAt: null, result: null, error: null })
    try {
      const result = await JCVitalV8.getMonitoringConfiguration()
      setMonitoringRun({ requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null })
    } catch (error) {
      const text = errorText(error)
      setMonitoringRun({ requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text })
      setMessage(text)
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function executePhase3BSync(
    key: Exclude<Phase3BFeedKey, 'sleep'>,
    action: () => Promise<JCVitalV8HistoricalSyncResult>,
  ): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const context = key === 'activity' || key === 'detailedActivity' ? ppiConnectedContext() : null
      const result = await action()
      setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
      if (context) {
        await retainActivityCanonical([result], context)
        const connectorDeviceId = connectorIdentityService.getConnectorDeviceId()
        const capabilityScope = {
          ownerUserId: context.scope.accountId,
          installId: installationIdentityService.getInstallId(),
          connectorDeviceId: connectorDeviceId ?? '',
        }
        if (connectorDeviceId && activityV2CapabilityStore.isEnabled(capabilityScope)) {
          if (observationQueue.getOwnerUserId() !== capabilityScope.ownerUserId) {
            throw new Error('Authenticated queue owner changed before Activity v2 enqueue.')
          }
          const deviceContext = activityV2DeviceContext(context, result.observations)
          const enqueued = await enqueueActivityNativeTransportV2(
            activityV2SourcesFromNative(result.observations), deviceContext, observationQueue,
            activityV2CapabilityStore.isEnabled(capabilityScope),
          )
          if (enqueued.payloadCount) {
            await observationBatchManager.process()
            setMessage(`Activity v2: ${enqueued.payloadCount} observations from ${enqueued.sourceRecordCount} saved source records entered the existing queue and sender.`)
          }
        }
      }
    } catch (error) {
      const text = errorText(error)
      setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function runPhase3BSync(
    key: Exclude<Phase3BFeedKey, 'sleep'>,
    action: () => Promise<JCVitalV8HistoricalSyncResult>,
  ): Promise<void> {
    setBusy(true)
    setActiveSync(`phase3b:${key}`)
    setMessage('')
    try { await executePhase3BSync(key, action) } finally { setActiveSync(null); setBusy(false) }
  }

  async function executeSleepSyncPart(part: keyof SleepFeedRun, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const result = await action()
      setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function syncSleep(): Promise<void> {
    setBusy(true)
    setActiveSync('phase3b:sleep')
    setMessage('')
    try {
      await executeSleepSyncPart('stages', () => JCVitalV8.syncHistoricalSleepStages())
      await executeSleepSyncPart('movement', () => JCVitalV8.syncHistoricalSleepMovement())
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function startWorkout(): Promise<boolean> {
    setWorkoutPackets([])
    setWorkoutParseErrors([])
    setWorkoutHeartRateEvent(null)
    setWorkoutError(null)
    setActiveSync('workout:capture')
    setBusy(true)
    setMessage('')
    try {
      const session = await JCVitalV8.startWorkoutCapture({ activityMode })
      hrDeliveryRef.current?.setContext({ bleAddress: session.deviceId, firmwareVersion: session.firmwareVersion, sdkVersion: session.sdkVersion, vendorActivityMode: session.vendorActivityMode ?? activityMode })
      setWorkoutSession(session)
      return true
    } catch (error) {
      setActiveSync(null)
      setMessage(errorText(error))
      return false
    } finally {
      setBusy(false)
    }
  }

  function clearHrTestTimer(): void {
    if (hrTestTimerRef.current !== null) window.clearTimeout(hrTestTimerRef.current)
    hrTestTimerRef.current = null
    setHrTestEndsAt(null)
  }

  async function testQueue(): Promise<void> {
    const at = new Date().toISOString()
    try {
      const owner = observationQueue.getOwnerUserId()
      if (!owner) throw new QueueStoreError('QUEUE_OWNER_MISSING', 'Queue owner is not authenticated.')
      const context = hrDeliveryRef.current?.getContext() ?? { deviceId: null, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }
      const observation = await buildQueueSelfTestObservation(owner, context)
      if (!observation) throw new QueueStoreError('QUEUE_WRITE_FAILED', 'Could not build the self-test observation.')
      setQueueSelfTest({ ok: true, at, result: await observationQueue.selfTest(observation) })
    } catch (error) {
      const { code, message } = (error ?? {}) as { code?: string; message?: string }
      setQueueSelfTest({ ok: false, at, code: code ?? 'QUEUE_WRITE_FAILED', message: message ?? String(error) })
    } finally {
      setQueueDiagnostics(observationQueue.getDiagnostics())
    }
  }

  async function startHrDeliveryTest(durationMs = WORKOUT_HR_E2E_TEST_DURATION_MS): Promise<void> {
    const delivery = hrDeliveryRef.current
    if (!delivery) return
    delivery.resetDiagnostics()
    delivery.setEnabled(true)
    if (!(await startWorkout())) return
    setHrTestEndsAt(Date.now() + durationMs)
    hrTestTimerRef.current = window.setTimeout(() => {
      hrTestTimerRef.current = null
      void stopWorkout()
    }, durationMs)
  }

  async function stopWorkout(): Promise<void> {
    clearHrTestTimer()
    setActiveSync('workout:stopping')
    setBusy(true)
    setMessage('')
    try {
      const session = await JCVitalV8.stopWorkoutCapture()
      setWorkoutSession(session)
      setActiveSync(null)
      await hrDeliveryRef.current?.handleWorkoutEnded(session.sessionId)
    } catch (error) {
      setMessage(errorText(error))
      try { setWorkoutSession(await JCVitalV8.getWorkoutCaptureStatus()) } catch { /* keep last state */ }
      setActiveSync((current) => current === 'workout:stopping' ? 'workout:capture' : current)
    } finally {
      setBusy(false)
    }
  }

  async function changeWorkoutState(action: 'pause' | 'resume'): Promise<void> {
    setBusy(true)
    setMessage('')
    try {
      const session = action === 'pause'
        ? await JCVitalV8.pauseWorkoutCapture()
        : await JCVitalV8.resumeWorkoutCapture()
      setWorkoutSession(session)
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function startRawEcg(): Promise<void> {
    setRawEcgChunks(EMPTY_RAW_ECG_CHUNK_SUMMARY)
    setRawEcgParseErrors([])
    setRawEcgError(null)
    setActiveSync('raw-ecg')
    setBusy(true)
    setMessage('')
    try {
      setRawEcgSession(await JCVitalV8.startRawEcg())
    } catch (error) {
      setActiveSync(null)
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function stopRawEcg(): Promise<void> {
    setActiveSync('raw-ecg:stopping')
    setBusy(true)
    setMessage('')
    try {
      setRawEcgSession(await JCVitalV8.stopRawEcg())
      setActiveSync(null)
    } catch (error) {
      setMessage(errorText(error))
      try { setRawEcgSession(await JCVitalV8.getRawEcgStatus()) } catch { /* keep last state */ }
      setActiveSync((current) => current === 'raw-ecg:stopping' ? 'raw-ecg' : current)
    } finally {
      setBusy(false)
    }
  }

  async function startRawPpg(): Promise<void> {
    rawPpgUiCoalescerRef.current?.cancel()
    setRawPpgChunks(EMPTY_RAW_PPG_CHUNK_SUMMARY)
    setRawPpgParseErrors([])
    setRawPpgError(null)
    setRawPpgUiDiagnostics({ chunkEventsReceivedByJs: 0, uiUpdateCount: 0, lastEventPayloadBytes: 0, maxEventPayloadBytes: 0 })
    setActiveSync('raw-ppg')
    setBusy(true)
    setMessage('')
    try {
      setRawPpgSession(await JCVitalV8.startRawPpg())
    } catch (error) {
      setActiveSync(null)
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function stopRawPpg(): Promise<void> {
    setActiveSync('raw-ppg:stopping')
    setBusy(true)
    setMessage('')
    try {
      const session = await JCVitalV8.stopRawPpg()
      setRawPpgSession((current) => mergeRawPpgSession(current, session))
      setActiveSync(null)
    } catch (error) {
      setMessage(errorText(error))
      try {
        const session = await JCVitalV8.getRawPpgStatus()
        setRawPpgSession((current) => mergeRawPpgSession(current, session))
      } catch { /* keep last state */ }
      setActiveSync((current) => current === 'raw-ppg:stopping' ? 'raw-ppg' : current)
    } finally {
      setBusy(false)
    }
  }

  async function exportValidationReport(): Promise<void> {
    setExportStatus('EXPORTING')
    setExportLocation(null)
    try {
      let deviceInfo = info
      if (!deviceInfo && ready) {
        deviceInfo = await JCVitalV8.getDeviceInfo()
        setInfo(deviceInfo)
      }
      const phase3bFeedResults = buildPhase3BExportResults({
        activity: phase3bRuns.activity,
        detailedActivity: phase3bRuns.detailedActivity,
        sleep: sleepRun,
        workouts: phase3bRuns.workouts,
      })
      const latestResponseShape = observationBatchManager.getDeliveryDiagnostics().recentResponseShapes.at(-1)
      const ownerUserId = observationQueue.getOwnerUserId()
      const context = hrDeliveryRef.current?.getContext()
        ?? { deviceId: null, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }
      const preservedQueueSamples = ownerUserId && observationQueue.getDiagnostics().queueStoreInitialized
        ? await observationQueue.getPending(100) : []
      const persistedSpo2 = ownerUserId ? spo2CertificationRef.current.snapshot() : { samples: [], inspection: [] }
      const persistedTemperature = ownerUserId ? temperatureCertificationRef.current.snapshot() : { samples: [], inspection: [] }
      const journalScope = sourceJournalScopeRef.current
      const journalDiagnostics = journalScope
        ? await JCVitalV8.getSourceJournalDiagnostics(journalScope) : null
      const payload = await buildCertificationValidationExport({
        deviceInfo, historicalRuns, monitoringRun,
        backendEnvironment: getBackendEnvironmentDiagnostics({
          responseContractVersion: latestResponseShape?.responseContractVersion,
          deploymentRevision: latestResponseShape?.deploymentRevision,
        }),
        additionalFeedResults: {
          sourceEnvelopeJournal: journalDiagnostics,
          ...phase3bFeedResults,
          workoutLiveValidation,
          ecgStartDiagnostics: rawEcgSession?.ecgStartDiagnostics ?? null,
          rawEcgValidation: buildRawEcgValidation(rawEcgSession, rawEcgChunks, rawEcgParseErrors),
          rawPpgValidation: buildRawPpgValidation(rawPpgSession, rawPpgChunks, rawPpgParseErrors, rawPpgUiDiagnostics, rawPpgRenderErrors),
          workoutHrDelivery: hrDeliverySnapshot ? { ...hrDeliverySnapshot, queueStats: deliveryQueueStats, queueDiagnostics, queueReadError, queueSelfTest, deliveryDiagnostics: observationBatchManager.getDeliveryDiagnostics(), staleSendingCount } : null,
          physiologyDelivery: physiologySnapshot ? { ...physiologySnapshot, deliveryDiagnostics: observationBatchManager.getDeliveryDiagnostics(), queueStats: deliveryQueueStats } : null,
        },
      }, {
        activity: phase3bRuns.activity, detailedActivity: phase3bRuns.detailedActivity,
        sleep: sleepRun, workouts: phase3bRuns.workouts, ownerUserId,
        physiologyContext: context, workoutContext: context, workoutSession, workoutPackets,
        workoutParseErrorCount: workoutParseErrors.length, ppgSession: rawPpgSession, ppgChunks: rawPpgChunks,
        preservedQueueSamples, deliveryEvidence: certificationDeliveryRef.current.snapshot(ownerUserId),
        persistedSpo2Samples: persistedSpo2.samples, spo2QueueInspection: persistedSpo2.inspection,
        persistedTemperatureSamples: persistedTemperature.samples, temperatureQueueInspection: persistedTemperature.inspection,
        ...(ownerUserId && observationQueue.getDiagnostics().queueStoreInitialized ? {
          readQueueRecord: (observationId: string) => {
            if (observationQueue.getOwnerUserId() !== ownerUserId) throw new QueueStoreError('QUEUE_OWNER_MISSING', 'Account changed during certification export.')
            return observationQueue.getRecord(observationId)
          },
        } : {}),
      })
      const filename = `jcvital-v8-phase3abc-validation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      const json = serializeCertificationValidationExport(payload)

      setExportLocation(await saveValidationJson(filename, json, 'JCVital V8 Phase 3A/3B/3C Validation',
        'Save or share Phase 3A/3B/3C validation JSON'))
      setExportStatus('EXPORT SUCCESS')
    } catch (error) {
      setExportStatus('EXPORT FAILED')
      setExportLocation(errorText(error))
    }
  }

  const ready = state === 'READY'
  const linked = state === 'CONNECTING' || state === 'CONNECTED' || state === 'INITIALIZING' || ready
  // Recomputing these (sorting intervals, mapping every observation) on each 2 s diagnostics tick was unbounded work.
  const feedDiagnostics = useMemo(() => ({
    heartRate: buildHistoricalFeedResult('heartRate', historicalRuns.heartRate),
    spo2: buildHistoricalFeedResult('spo2', historicalRuns.spo2),
    temperature: buildHistoricalFeedResult('temperature', historicalRuns.temperature),
    hrv: buildHistoricalFeedResult('hrv', historicalRuns.hrv),
    ppi: buildHistoricalFeedResult('ppi', historicalRuns.ppi),
    monitoringConfiguration: buildMonitoringFeedResult(monitoringRun),
  }), [historicalRuns, monitoringRun])
  const connectDevice = async (device: JCVitalV8Device): Promise<void> => {
    setInfo(null)
    setBattery(null)
    setHeartRate(null)
    sourceJournalScopeRef.current = null
    const connectionEpoch = connectionContext.generation
    try {
      const connected = await connectAndBindJournal(JCVitalV8, ownerUserId, device.id,
        (address) => jcvitalDeviceIdentityService.resolve(address),
        () => ownerRef.current === ownerUserId && connectionContext.generation === connectionEpoch)
      sourceJournalScopeRef.current = connected.scope
      setSourceJournalDiagnostics(connected.diagnostics)
      setSourceJournalError(null)
      setSourceJournalPage(null)
      setSourceJournalExportCursor(0)
      setInfo(connected.info)
    } catch (error) {
      setSourceJournalError(`SOURCE_JOURNAL_NOT_READY: ${errorText(error)}`)
      throw error
    }
  }
  const phase3bDiagnostics = buildPhase3BFeedResults({
    activity: phase3bRuns.activity,
    detailedActivity: phase3bRuns.detailedActivity,
    sleep: sleepRun,
    workouts: phase3bRuns.workouts,
  })
  const automaticHrInterval = monitoringRun?.result?.configurations.HEART_RATE.intervalMinutesRaw ?? null
  const historicalHrDiagnostics = feedDiagnostics.heartRate.sampleDiagnostics as { medianIntervalSeconds?: number | null } | null
  const phase3bMethods = {
    activity: typeof JCVitalV8.syncHistoricalActivity === 'function',
    detailedActivity: typeof JCVitalV8.syncDetailedActivity === 'function',
    sleep: typeof JCVitalV8.syncHistoricalSleepStages === 'function' && typeof JCVitalV8.syncHistoricalSleepMovement === 'function',
    workouts: typeof JCVitalV8.syncHistoricalWorkouts === 'function',
  }
  const phase3bDisabledReasons = {
    activity: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.activity, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
    detailedActivity: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.detailedActivity, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
    sleep: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.sleep, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
    workouts: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.workouts, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
  }
  const workoutMethods = {
    start: typeof JCVitalV8.startWorkoutCapture === 'function',
    stop: typeof JCVitalV8.stopWorkoutCapture === 'function',
    pause: typeof JCVitalV8.pauseWorkoutCapture === 'function',
    resume: typeof JCVitalV8.resumeWorkoutCapture === 'function',
  }
  const workoutGate = {
    pluginAvailable,
    startMethodAvailable: workoutMethods.start,
    stopMethodAvailable: workoutMethods.stop,
    connectionState: state,
    activeSync,
    manualMeasurementActive: realtime,
    workoutStatus: workoutSession?.status ?? 'IDLE' as const,
  }
  const workoutStartReason = workoutStartDisabledReason(workoutGate)
  const workoutStopReason = workoutStopDisabledReason(workoutGate)
  const workoutSessionForDiagnostics = workoutSession as LiveWorkoutSession | null
  const workoutIsTerminal = workoutSession?.status === 'STOPPED' || workoutSession?.status === 'ERROR' || workoutSession?.status === 'DISCONNECTED'
  const workoutDiagnostics = workoutSessionForDiagnostics
    ? computeWorkoutCadenceDiagnostics(workoutSessionForDiagnostics, workoutPackets, workoutIsTerminal)
    : null
  const currentWorkoutPacket = workoutPackets.at(-1) ?? null
  const currentWorkoutHr = [...workoutPackets].reverse().find((packet) => packet.heartRate !== null)?.heartRate ?? null
  const workoutElapsedSeconds = workoutSession?.startedAt
    ? Math.max(0, ((workoutSession.stoppedAt ? Date.parse(workoutSession.stoppedAt) : workoutClock) - Date.parse(workoutSession.startedAt)) / 1000)
    : 0
  const lastWorkoutPacketAgeSeconds = currentWorkoutPacket
    ? Math.max(0, (workoutClock - Date.parse(currentWorkoutPacket.receivedAt)) / 1000)
    : null
  const workoutLiveValidation = buildWorkoutLiveValidation(workoutSessionForDiagnostics, workoutPackets, workoutParseErrors)
  const rawEcgMethods = {
     start: typeof JCVitalV8.startRawEcg === 'function',
    stop: typeof JCVitalV8.stopRawEcg === 'function',
  }
  const rawEcgGate = {
    pluginAvailable,
    startMethodAvailable: rawEcgMethods.start,
    stopMethodAvailable: rawEcgMethods.stop,
    connectionState: state,
    activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null),
    manualMeasurementActive: realtime,
    workoutStatus: workoutSession?.status ?? 'IDLE' as const,
    rawEcgStatus: rawEcgSession?.status ?? 'IDLE',
  }
  const rawEcgStartReason = rawEcgStartDisabledReason(rawEcgGate)
  const rawEcgStopReason = rawEcgStopDisabledReason(rawEcgGate)
  const rawEcgElapsedSeconds = rawEcgSession?.startedAt
    ? Math.max(0, ((rawEcgSession.stoppedAt ? Date.parse(rawEcgSession.stoppedAt) : rawEcgClock) - Date.parse(rawEcgSession.startedAt)) / 1000)
    : 0
  const rawEcgValidation = buildRawEcgValidation(rawEcgSession, rawEcgChunks, rawEcgParseErrors)
  const rawPpgGate = {
    pluginAvailable,
    startMethodAvailable: typeof JCVitalV8.startRawPpg === 'function',
    stopMethodAvailable: typeof JCVitalV8.stopRawPpg === 'function',
    connectionState: state,
    activeSync,
    manualMeasurementActive: realtime,
    workoutStatus: workoutSession?.status ?? 'IDLE',
    rawEcgStatus: rawEcgSession?.status ?? 'IDLE',
    rawPpgStatus: rawPpgSession?.status ?? 'IDLE',
  }
  const rawPpgStopReason = rawPpgStopDisabledReason(rawPpgGate)
  const otherActiveMeasurement = activeSync ?? (realtime ? 'manual HR measurement' : null)
  const workoutStatus = workoutSession?.status ?? 'IDLE'
  const workoutActive = ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'].includes(workoutStatus)
  const connectorRegistered = Boolean(connectorIdentityService.getConnectorDeviceId())
  const deliveryQueueHealth = effectiveQueueHealth(queueDiagnostics.queueStoreInitialized, hrDeliverySnapshot?.queueHealth ?? 'HEALTHY')
  return (
    <section className="wearables" aria-labelledby="jcvital-v8-title">
      <SourceCapabilityMatrix />
      <V8FullDataCoverageReportPanel />
      <div className="wearables-heading"><h2 id="jcvital-v8-title">JCVital Pro V8</h2><strong>{state}</strong></div>
      <p>Bluetooth: {permission ? `${permission.status}${permission.bluetoothEnabled ? '' : ' (Bluetooth off)'}` : 'Checking…'}</p>
      <div className="wearable-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => setPermission(await JCVitalV8.requestPermissions()))}>Allow Bluetooth</button>
        <button type="button" disabled={busy || !ownerUserId || linked || state === 'SCANNING'} onClick={() => void run(async () => { setDevices([]); await startDiscovery(JCVitalV8, ownerUserId) })}>Start Scan</button>
        <button type="button" className="secondary" disabled={state !== 'SCANNING'} onClick={() => void run(() => JCVitalV8.stopScan())}>Stop Scan</button>
      </div>
      {!linked && devices.length > 0 && <ul className="jcvital-devices">
        {devices.map((device) => <li key={device.id}>
          <button type="button" disabled={busy} onClick={() => void run(() => connectDevice(device))}>Connect</button>
          {' '}{device.name ?? 'Unnamed'} · {device.macAddress} · {device.rssi} dBm{device.advertisesJcvitalService ? ' · JCVital service' : ''}{device.bonded ? ' · bonded' : ''}
        </li>)}
      </ul>}
      <details>
        <summary>L0 source-envelope journal (local only)</summary>
        <p>Append-only source preservation. No automatic eviction; storage pressure stops new capture. Scalar acknowledgements never remove source evidence.</p>
        {sourceJournalDiagnostics && <p>
          Scope envelopes: {sourceJournalDiagnostics.totalEnvelopeCount} · global limit: {sourceJournalDiagnostics.maxEnvelopes}
          {' '}Scope bytes: {sourceJournalDiagnostics.totalStoredBytes} · global limit: {sourceJournalDiagnostics.maxBytes}
          {' '}Status: {sourceJournalDiagnostics.lastOutcome}
          {' '}Refused writes: {sourceJournalDiagnostics.refusedCount}
        </p>}
        {sourceJournalError && <p role="alert">{sourceJournalError}</p>}
        <button type="button" disabled={busy || !sourceJournalScopeRef.current} onClick={() => void run(refreshSourceJournal)}>Refresh journal storage status</button>
        <button type="button" disabled={busy || !sourceJournalScopeRef.current} onClick={() => void run(loadSourceJournalPage)}>Read next source-envelope page (10)</button>
        {sourceJournalPage && <pre>{sourceJournalPage}</pre>}
      </details>
      {linked && <div className="wearable-actions">
        <button type="button" disabled={busy || !ready} onClick={() => void run(async () => setInfo(await JCVitalV8.getDeviceInfo()))}>Device Info</button>
        <button type="button" disabled={busy || !ready} onClick={() => void run(async () => setBattery(await JCVitalV8.getBattery()))}>Battery</button>
        <button type="button" disabled={busy || !ready || realtime || activeSync !== null} onClick={() => void run(async () => {
          setActiveSync('manual:realtime')
          try {
            await JCVitalV8.startRealtimeData({ measurementSeconds: 60 })
            setRealtime(true)
          } catch (error) {
            setActiveSync(null)
            throw error
          }
        })}>Start Realtime</button>
        <button type="button" disabled={busy || !ready || !realtime} onClick={() => void run(async () => { await JCVitalV8.stopRealtimeData(); setRealtime(false); setActiveSync(null) })}>Stop Realtime</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => JCVitalV8.disconnect())}>Disconnect</button>
      </div>}
      {info && <p>Device: {info.deviceName ?? info.advertisedName ?? '—'} · MAC {info.macAddress ?? info.deviceId} · Firmware {info.firmwareVersion ?? '—'} · ID {info.vendorDeviceId ?? '—'} · SDK {info.sdkVersion}{info.missingFields.length ? ` · missing: ${info.missingFields.join(', ')}` : ''}</p>}
      {battery && <p>Battery: {battery.level ?? '—'}%{battery.charging === null ? '' : battery.charging ? ' (charging)' : ' (not charging)'}</p>}
      {heartRate && <p>Heart rate: <strong>{heartRate.value} {heartRate.unit}</strong> · received {new Date(heartRate.receiptTimestamp).toLocaleTimeString()} · packet type {heartRate.vendorDataType}</p>}
      <h3>Data Sync</h3>
      <p><strong>Certification export build:</strong> {CERTIFICATION_BUILD.schemaVersion}
        {' '}(baseline {CERTIFICATION_BUILD.baselineCommit.slice(0, 7)}).
        Baseline JSON must contain both certificationBuild and jcvitalCertification before any physical test.</p>
      <p><strong>V8 certification gate:</strong> historical HR is already proven; its remaining durable
        backlog is preserved and is not a blocker. Test one feed, export JSON, then STOP for review.
        Order: SpO2, wearable temperature, type-42 HRV/stress/estimated BP, PPI, activity, detailed activity,
        workout history, live workout HR, sleep. Reuse existing PPG evidence; ECG remains blocked.
        No scaling or asynchronous canonicalization.</p>
      <h4>Focused certification delivery (one selected metric only)</h4>
      <div className="wearable-actions">
        <button type="button" disabled={busy || spo2CertificationRunning} onClick={() => void inspectPriorSpo2()}>Inspect prior SpO2 certification IDs</button>
        <button type="button" disabled={busy || spo2CertificationRunning || (!spo2SavedIds.length && !spo2Inspection?.some((item) => item.status !== 'NOT_FOUND'))}
          onClick={() => void flushPriorSpo2()}>Flush existing SpO2 certification rows</button>
        <button type="button" disabled={busy || spo2CertificationRunning || !ready || !spo2Inspection?.every((item) => item.status === 'NOT_FOUND')}
          onClick={() => void captureTargetedSpo2()}>Capture + Queue + Targeted Deliver SpO2</button>
      </div>
      {spo2CertificationStage && <p role="status">{spo2CertificationStage}</p>}
      {spo2CaptureCounts && <p>{spo2CaptureCounts.captured} observations captured
        {' · '}{spo2CaptureCounts.queued === null ? 'Enqueue not yet confirmed' : `${spo2CaptureCounts.queued} observations durably queued`}</p>}
      {spo2Inspection && <pre>{JSON.stringify(spo2Inspection, null, 2)}</pre>}
      <h4>Focused certification delivery — wearable temperature (type 59)</h4>
      <div className="wearable-actions">
        <button type="button" disabled={busy || temperatureCertificationRunning} onClick={() => void inspectPersistedTemperature()}>Inspect persisted wearable temperature certification IDs</button>
        <button type="button" disabled={busy || temperatureCertificationRunning || (!temperatureSavedIds.length && !temperatureInspection?.some((item) => item.status !== 'NOT_FOUND'))}
          onClick={() => void flushPersistedTemperature()}>Flush existing wearable temperature certification rows</button>
        <button type="button" disabled={busy || temperatureCertificationRunning || !ready}
          onClick={() => void captureTargetedTemperature()}>Capture + Queue + Targeted Deliver Temperature</button>
      </div>
      {temperatureCertificationStage && <p role="status">{temperatureCertificationStage}</p>}
      {temperatureCaptureCounts && <p>{temperatureCaptureCounts.captured} observations captured
        {' · '}{temperatureCaptureCounts.queued === null ? 'Enqueue not yet confirmed' : `${temperatureCaptureCounts.queued} observations durably queued`}</p>}
      {temperatureInspection && <pre>{JSON.stringify(temperatureInspection, null, 2)}</pre>}
      <p>Elite+ V8 wearable temperature is skin-sensor temperature, not core/clinical/fever body
        temperature. These explicit actions capture and await delivery for the selected metric without
        changing the master toggle or other metric selections. Ordinary Sync buttons below retain their
        existing capture-only behavior when the master toggle is off. Export JSON after completion and
        STOP. For type 42, use the official grouped action below rather than the individual
        metric certification controls.</p>
      <Type42CertificationView
        busy={busy || spo2CertificationRunning || temperatureCertificationRunning}
        captureDisabledReason={!ready ? 'V8 not READY' : otherActiveMeasurement !== null
          ? `${otherActiveMeasurement} active` : !sourceJournalScopeRef.current ? 'Journal scope unavailable' : null}
        journalScopeAvailable={type42ContextRef.current !== null}
        status={type42Status}
        evidence={type42Evidence}
        exportLocation={type42ExportLocation}
        onCapture={() => void captureType42Certification()}
        onInspect={() => void inspectType42Certification()}
        onExport={() => void exportType42Certification()}
      />
      <Activity24_25CertificationView
        service={activityCertificationRef.current}
        busy={busy || spo2CertificationRunning || temperatureCertificationRunning}
        captureDisabled={!ready || otherActiveMeasurement !== null || !type42ContextRef.current || !Capacitor.isNativePlatform() || pluginAvailable !== true}
        onSendSavedActivityV2Verification={IS_ENGINEERING_BUILD ? sendSavedActivityV2Verification : undefined}
        setBusy={setBusy}
        setActiveSync={setActiveSync}
        scopeKey={sourceJournalScopeRef.current ? `${ownerUserId}:${sourceJournalScopeRef.current.deviceScopeId}` : null}
      />
      <SleepCertificationView
        service={sleepCertificationRef.current}
        busy={busy || spo2CertificationRunning || temperatureCertificationRunning}
        captureDisabled={!ready || otherActiveMeasurement !== null || !type42ContextRef.current || !Capacitor.isNativePlatform() || pluginAvailable !== true}
        setBusy={setBusy}
        setActiveSync={setActiveSync}
        scopeKey={sourceJournalScopeRef.current ? `${ownerUserId}:${sourceJournalScopeRef.current.deviceScopeId}` : null}
      />
      <WorkoutHistoryCertificationView
        service={workoutHistoryCertificationRef.current}
        busy={busy || spo2CertificationRunning || temperatureCertificationRunning}
        captureDisabled={!ready || otherActiveMeasurement !== null || !type42ContextRef.current || !Capacitor.isNativePlatform() || pluginAvailable !== true}
        setBusy={setBusy}
        setActiveSync={setActiveSync}
        scopeKey={workoutHistoryCertificationRef.current.scopeKey()}
      />
      <section aria-label="PPI Certification">
      <h4>PPI Certification</h4>
      <p>Grouped physical certification (type 127). Viewing JSON requires no clipboard or file permissions.
        File export is optional; use the full on-screen JSON for certification evidence.</p>
      {savedPpiAvailable && <p role="status">Saved PPI certification available</p>}
      <p>Inspection and export use saved evidence only, with no acquisition, enqueue, or Base44 request.
        After restart, reconnect the same device only to establish journal scope; do not capture again.</p>
      <p>Resume replays the last persisted physical PPI attempt from the connected journal: no syncHistoricalPpi()
        call and no BLE history acquisition. On failure it reports the exact stage and never recaptures.</p>
      <div className="wearable-actions">
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null || !type42ContextRef.current}
          onClick={() => void capturePpiCertification()}>Capture + Queue + Targeted Deliver PPI</button>
        <button type="button" disabled={busy} onClick={() => void resumePpiCertification()}>{PPI_RESUME_BUTTON_LABEL}</button>
        <button type="button" disabled={busy} onClick={() => void inspectPpiCertification()}>Inspect Saved PPI Certification</button>
        <button type="button" disabled={busy} onClick={() => void exportPpiCertification()}>Export PPI Certification JSON</button>
        <button type="button" disabled={busy} onClick={() => void showPpiCertificationJson()}>Show PPI Certification JSON</button>
        <button type="button" disabled={busy} onClick={() => void showPpiCertificationJson(false, true)}>Copy PPI Certification JSON</button>
        <button type="button" disabled={busy || !ppiJson} onClick={() => void shareDisplayedPpiJson()}>Share / Save PPI JSON</button>
        <button type="button" disabled={busy} onClick={() => void showPpiCertificationJson()}>Show Current PPI Certification JSON</button>
        <button type="button" disabled={busy} onClick={() => void showPpiCertificationJson(true)}>Show Saved PPI Certification JSON</button>
      </div>
      {ppiCertificationStatus && <p role="status">{ppiCertificationStatus}</p>}
      {ppiSnapshotStatus && <pre role="status">{ppiSnapshotStatus}</pre>}
      {ppiCertificationExportLocation && <p>{ppiCertificationExportLocation}</p>}
      {ppiShareStatus && <p role="status">{ppiShareStatus}</p>}
      <PpiCertificationJsonView evidence={ppiJson} />
      <section aria-label="PPI Certification Attempt Diagnostic">
        <h5>PPI Certification Attempt Diagnostic</h5>
        <p>Diagnostic only, never certification success. No automatic reacquisition.
          After restart, reconnect the same device and show the last attempt.</p>
        <div className="wearable-actions">
          <button type="button" disabled={busy} onClick={() => void showPpiAttempt()}>Show Last PPI Certification Attempt</button>
          <button type="button" disabled={busy} onClick={() => void showPpiAttempt(true)}>Copy Last PPI Certification Attempt</button>
          <button type="button" disabled={busy || !ppiAttemptJson} onClick={() => void shareDisplayedPpiJson(true)}>Share / Save Last PPI Certification Attempt</button>
        </div>
        {ppiAttemptStatus && <p role="status">{ppiAttemptStatus}</p>}
        {ppiAttemptShareStatus && <p role="status">{ppiAttemptShareStatus}</p>}
        {ppiAttempt && <pre role="status" style={{ maxHeight: '30rem', overflow: 'auto', whiteSpace: 'pre-wrap' }}>
          {serializeCertificationJson(ppiAttempt)}
        </pre>}
        <PpiCertificationJsonView evidence={ppiAttemptJson} label="Full PPI Certification Attempt JSON" />
      </section>
      {ppiCertificationEvidence && <details><summary>Saved PPI certification evidence</summary><pre>{ppiCertificationEvidence}</pre></details>}
      </section>
      <section aria-label="Read-Only Recovery Tools" style={{ borderTop: '2px solid', marginTop: '1.5rem', paddingTop: '1rem' }}>
      <h4>Read-Only Recovery Tools</h4>
      <p>Recovery is read-only: it lists only PPI certification keys and the connected owner/device L0 journal, and never
        acquires, enqueues, sends, or rewrites a snapshot. With several journal candidates, enter one sourceEnvelopeId.</p>
      <div className="wearable-actions">
        <label>Candidate sourceEnvelopeId (optional){' '}
          <input type="text" value={ppiRecoveryEnvelopeId} onChange={(event) => setPpiRecoveryEnvelopeId(event.target.value)} />
        </label>
        <button type="button" disabled={busy} onClick={() => void findSavedPpiCertification()}>Find Saved PPI Certification</button>
        <button type="button" disabled={busy} onClick={() => void exportRecoveredPpiCertification()}>Export Recovered PPI Certification JSON</button>
      </div>
      {ppiRecoveryStatus && <p role="status">{ppiRecoveryStatus}</p>}
      {ppiRecoveryExportLocation && <p>{ppiRecoveryExportLocation}</p>}
      {ppiRecoveryReport && <details><summary>PPI saved-key and journal recovery report</summary><pre>{ppiRecoveryReport}</pre></details>}
      </section>
      <p>Individual metric certification controls below are diagnostics only, not the grouped type-42 or PPI physical certification paths.</p>
      <div className="wearable-actions">
        {PHYSIOLOGY_CERTIFICATION_ACTIONS.filter(({ metric }) => metric !== 'spo2' && metric !== 'wearableTemperature').map(({ key, metric, label, action }) =>
          <button key={metric} type="button" disabled={busy || spo2CertificationRunning || temperatureCertificationRunning || !ready || otherActiveMeasurement !== null}
            onClick={() => void runSync(key, action, { deliveryMode: 'CERTIFICATION_DELIVER', certificationMetric: metric })}>
            Certify {label} + Deliver
          </button>)}
      </div>
      <div className="wearable-actions">
        <button type="button" disabled title="Certification reuses existing HR evidence; do not reacquire full history.">Historical HR: preserved evidence only</button>
        <button type="button" disabled={busy || spo2CertificationRunning || !ready || otherActiveMeasurement !== null} onClick={() => void runSync('spo2', () => JCVitalV8.syncHistoricalSpo2())}>Sync SpO2</button>
        <button type="button" disabled={busy || temperatureCertificationRunning || !ready || otherActiveMeasurement !== null} onClick={() => void runSync('temperature', () => JCVitalV8.syncHistoricalTemperature())}>Sync Temperature</button>
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void runSync('hrv', () => JCVitalV8.syncHistoricalHrv())}>Sync HRV / Stress / Estimated BP (type 42)</button>
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void runSync('ppi', () => JCVitalV8.syncHistoricalPpi())}>Sync PPI (type 127)</button>
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void syncMonitoringConfiguration()}>Sync Automatic Monitoring / Configuration</button>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.activity !== null} onClick={() => void runPhase3BSync('activity', () => JCVitalV8.syncHistoricalActivity())}>Sync Activity</button>
          {phase3bDisabledReasons.activity && <small>Disabled: {phase3bDisabledReasons.activity}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.detailedActivity !== null} onClick={() => void runPhase3BSync('detailedActivity', () => JCVitalV8.syncDetailedActivity())}>Sync Detailed Activity</button>
          {phase3bDisabledReasons.detailedActivity && <small>Disabled: {phase3bDisabledReasons.detailedActivity}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.sleep !== null} onClick={() => void syncSleep()}>Sync Sleep</button>
          {phase3bDisabledReasons.sleep && <small>Disabled: {phase3bDisabledReasons.sleep}</small>}
        </div>
        <div className="diagnostic-control">
          <p>VC25 workout history uses the dedicated one-shot certification controls above, not generic delivery sync.</p>
        </div>
        <button type="button" disabled={busy || hrDeliveryTestDisabledReason({ workoutStartReason, queueStoreInitialized: queueDiagnostics.queueStoreInitialized, queueHealth: deliveryQueueHealth, connectorRegistered }) !== null} onClick={() => void startHrDeliveryTest(180_000)}>Certify Live Workout HR (3 minutes)</button>
        <button type="button" className="secondary" disabled={exportStatus === 'EXPORTING'} onClick={() => void exportValidationReport()}>Export Phase 3A/3B/3C Validation JSON</button>
      </div>
      <div className="phase3b-bridge-status">
        <strong>Phase 3B bridge</strong>
        <span>activity: {phase3bMethods.activity ? 'AVAILABLE' : 'MISSING'}</span>
        <span>detailedActivity: {phase3bMethods.detailedActivity ? 'AVAILABLE' : 'MISSING'}</span>
        <span>sleep: {phase3bMethods.sleep ? 'AVAILABLE' : 'MISSING'}</span>
        <span>workouts: {phase3bMethods.workouts ? 'AVAILABLE' : 'MISSING'}</span>
        <span>connectionState: {state}</span>
        <span>pluginAvailable: {pluginAvailable === null ? 'CHECKING' : pluginAvailable ? 'AVAILABLE' : 'MISSING'}</span>
        <span>activeSync: {activeSync ?? 'NONE'}</span>
      </div>
      <p><strong>Automatic HR monitoring interval:</strong> {automaticHrInterval === null ? '—' : `${automaticHrInterval} minutes (vendor configuration)`}</p>
      <p><strong>Historical HR observed median interval:</strong> {historicalHrDiagnostics?.medianIntervalSeconds == null ? '—' : `${historicalHrDiagnostics.medianIntervalSeconds} seconds (observed data)`}</p>
      {exportStatus && <p role="status"><strong>{exportStatus}</strong>{exportLocation ? ` · ${exportLocation}` : ''}</p>}
      {Object.entries(feedDiagnostics).map(([key, diagnostics]) => {
        const showAllRecords = key === 'spo2' || key === 'hrv' || key === 'ppi' || key === 'monitoringConfiguration'
        return <details key={key} className="jcvital-diagnostics">
          <summary>{key}: {diagnostics.completionStatus} · {diagnostics.recordsAccepted} accepted · {diagnostics.parseErrors.length} parse errors</summary>
          <p>Started: {diagnostics.requestStartedAt ?? '—'} · Completed: {diagnostics.requestCompletedAt ?? '—'}</p>
          <p>Source records received: {diagnostics.sourceRecordsReceived} · Normalized observations produced: {diagnostics.normalizedObservationsProduced}</p>
          <p>Accepted: {diagnostics.recordsAccepted} · Deduplicated: {diagnostics.recordsDeduplicated} · Rejected: {diagnostics.recordsRejected}</p>
          <p>Earliest: {diagnostics.earliestObservation ?? '—'} · Latest: {diagnostics.latestObservation ?? '—'}</p>
          <p>Vendor type: {diagnostics.vendorDataType ?? '—'} · Acquisition: {diagnostics.acquisitionMode ?? '—'}</p>
          <strong>Sample diagnostics</strong><pre>{JSON.stringify(diagnostics.sampleDiagnostics, null, 2)}</pre>
          <strong>Parse errors</strong><pre>{JSON.stringify(diagnostics.parseErrors, null, 2)}</pre>
          <strong>First 5 normalized observations</strong><pre>{JSON.stringify(diagnostics.firstFive, null, 2)}</pre>
          <strong>Last 5 normalized observations</strong><pre>{JSON.stringify(diagnostics.lastFive, null, 2)}</pre>
          {showAllRecords && <><strong>All returned diagnostic records</strong><pre>{JSON.stringify(diagnostics.allRecords, null, 2)}</pre></>}
        </details>
      })}
      <h3>Phase 3B History</h3>
      {Object.entries(phase3bDiagnostics).map(([key, diagnostics]) => <details key={key} className="jcvital-diagnostics">
        <summary>{key}: {diagnostics.completionStatus} · {diagnostics.recordsAccepted} accepted · {diagnostics.parseErrors.length} parse errors</summary>
        <p>Source records received: {diagnostics.sourceRecordsReceived} · Normalized observations produced: {diagnostics.normalizedObservationsProduced}</p>
        <p>Accepted: {diagnostics.recordsAccepted} · Deduplicated: {diagnostics.recordsDeduplicated} · Rejected: {diagnostics.recordsRejected}</p>
        <p>Earliest: {diagnostics.earliestObservation ?? '—'} · Latest: {diagnostics.latestObservation ?? '—'}</p>
        <strong>Diagnostics</strong><pre>{JSON.stringify(diagnostics.sampleDiagnostics, null, 2)}</pre>
        <strong>Parse errors</strong><pre>{JSON.stringify(diagnostics.parseErrors, null, 2)}</pre>
        <strong>First 5</strong><pre>{JSON.stringify(diagnostics.firstFive, null, 2)}</pre>
        <strong>Last 5</strong><pre>{JSON.stringify(diagnostics.lastFive, null, 2)}</pre>
      </details>)}
      <h3>Raw Capture</h3>
      <PpgDiagnosticErrorBoundary onError={(renderError) => setRawPpgRenderErrors((current) => [...current, renderError].slice(-10))}>
        <RawPpgDiagnosticsView
          session={rawPpgSession}
          chunks={rawPpgChunks}
          parseErrors={rawPpgParseErrors}
          error={rawPpgError}
          uiDiagnostics={rawPpgUiDiagnostics}
          renderErrors={rawPpgRenderErrors}
          now={rawPpgClock}
          startDisabledReason={RAW_PPG_LEGACY_START_DISABLED_REASON}
          stopDisabledReason={rawPpgStopReason}
          busy={busy}
          onStart={() => void startRawPpg()}
          onStop={() => void stopRawPpg()}
        />
      </PpgDiagnosticErrorBoundary>
      <RawPpgPhysicalCertificationControls
        key={`${ownerUserId}|${sourceJournalScopeRef.current?.deviceScopeId ?? ''}`}
        service={rawPpgPhysicalCertificationRef.current}
        scopeKey={`${ownerUserId}|${state}`}
        gate={{
          native: Capacitor.isNativePlatform(),
          pluginAvailable,
          ready,
          authenticated: Boolean(ownerUserId),
          busy,
          otherActiveMeasurement: otherActiveMeasurement ?? (workoutActive ? 'workout capture' : null),
        }}
        subscribe={subscribeRawPpgCertification}
      />
      <RawPpgSavedEvidenceControls service={rawPpgSavedEvidenceServiceRef.current} disabled={busy} />
      <div className="wearable-actions">
        <div className="diagnostic-control">
          <button type="button" disabled={rawEcgStartReason !== null || busy} title={rawEcgStartReason ?? 'Start raw ECG capture'} onClick={() => void startRawEcg()}>Start ECG</button>
          {rawEcgStartReason && <small>Disabled: {rawEcgStartReason}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={rawEcgStopReason !== null || busy} title={rawEcgStopReason ?? 'Stop raw ECG capture'} onClick={() => void stopRawEcg()}>Stop ECG</button>
          {rawEcgStopReason && <small>Disabled: {rawEcgStopReason}</small>}
        </div>
      </div>
      <section className="workout-live-diagnostics" aria-label="Raw ECG diagnostics">
        <strong>Status: {rawEcgSession?.status ?? 'IDLE'}</strong>
        <span>Session ID: {rawEcgSession?.sessionId ?? '—'}</span>
        <span>Elapsed wall time: {Math.floor(rawEcgElapsedSeconds / 60).toString().padStart(2, '0')}:{Math.floor(rawEcgElapsedSeconds % 60).toString().padStart(2, '0')}</span>
        <span>Packets: {rawEcgSession?.packetCount ?? 0} · samples: {rawEcgSession?.sampleCount ?? 0} · chunks: {rawEcgSession?.chunksEmitted ?? rawEcgChunks.chunkCount}</span>
        <span>Last packet ID: {rawEcgSession?.lastPacketId ?? '—'} · missing: {rawEcgSession?.missingPacketCount ?? 0} · duplicates: {rawEcgSession?.duplicatePacketCount ?? 0} · out of order: {rawEcgSession?.outOfOrderPacketCount ?? 0}</span>
        <span>Average samples/packet: {rawEcgSession?.averageSamplesPerPacket?.toFixed(1) ?? '—'} · raw min/max: {rawEcgSession?.minimumRawSample ?? rawEcgChunks.minRawSample ?? '—'} / {rawEcgSession?.maximumRawSample ?? rawEcgChunks.maxRawSample ?? '—'}</span>
        <span>Bytes received: {rawEcgSession?.bytesReceived ?? rawEcgChunks.totalBytes} · buffered estimate: {rawEcgSession?.maxBufferedEstimateBytes ?? 0}/{rawEcgSession?.hardChunkBufferLimitBytes ?? '—'} bytes</span>
        <span>Parse errors: {rawEcgSession?.parseErrorCount ?? rawEcgParseErrors.length} · stored packets/bytes: {rawEcgSession?.persistedPacketCount ?? 0}/{rawEcgSession?.persistedBytes ?? 0} · storage errors: {rawEcgSession?.storageErrorCount ?? 0}</span>
        <span>Sample format: {rawEcgSession?.sampleFormat ?? 'UINT24_LE'} · unit: {rawEcgSession?.unit ?? 'UNKNOWN_VENDOR_UNIT'} · sample rate: {rawEcgSession?.sampleRateHz ?? 'unknown'}</span>
        {rawEcgError && <span role="alert">Last raw ECG error: {rawEcgError.message}</span>}
      </section>
      <details className="jcvital-diagnostics">
        <summary>Raw ECG chunk summaries · first {rawEcgChunks.firstThreeChunks.length}, last {rawEcgChunks.lastThreeChunks.length}</summary>
        <strong>ECG start diagnostics</strong><pre>{JSON.stringify(rawEcgSession?.ecgStartDiagnostics ?? null, null, 2)}</pre>
        <strong>First chunks</strong><pre>{JSON.stringify(rawEcgChunks.firstThreeChunks, null, 2)}</pre>
        <strong>Last chunks</strong><pre>{JSON.stringify(rawEcgChunks.lastThreeChunks, null, 2)}</pre>
        <strong>Validation summary</strong><pre>{JSON.stringify(rawEcgValidation, null, 2)}</pre>
      </details>
      <h3>Workout Test</h3>
      <div className="wearable-actions">
        <label className="workout-mode">Activity mode
          <select value={activityMode} disabled={busy || workoutActive} onChange={(event) => setActivityMode(Number(event.target.value))}>
            {['Run', 'Cycling', 'Badminton', 'Football', 'Tennis', 'Yoga', 'Breathing training', 'Dance', 'Basketball', 'Walk', 'Workout', 'Cricket', 'Hiking', 'Aerobics', 'Table tennis'].map((label, mode) => <option key={mode} value={mode}>{mode}: {label}</option>)}
          </select>
        </label>
        <div className="diagnostic-control">
          <button type="button" disabled={workoutStartReason !== null || busy} onClick={() => void startWorkout()}>Start Workout Capture</button>
          {workoutStartReason && <small>Disabled: {workoutStartReason}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={workoutStopReason !== null || busy} onClick={() => void stopWorkout()}>Stop Workout Capture</button>
          {workoutStopReason && <small>Disabled: {workoutStopReason}</small>}
        </div>
        <button type="button" disabled={busy || !workoutMethods.pause || workoutStatus !== 'RUNNING'} onClick={() => void changeWorkoutState('pause')}>Pause</button>
        <button type="button" disabled={busy || !workoutMethods.resume || workoutStatus !== 'PAUSED'} onClick={() => void changeWorkoutState('resume')}>Resume</button>
      </div>
      <p>Target: 10:00 · manual stop</p>
      <section className="workout-live-diagnostics" aria-label="Live workout diagnostics">
        <strong>Status: {workoutStatus}</strong>
        <span>Session ID: {workoutSession?.sessionId ?? '—'}</span>
        <span>Elapsed wall time: {Math.floor(workoutElapsedSeconds / 60).toString().padStart(2, '0')}:{Math.floor(workoutElapsedSeconds % 60).toString().padStart(2, '0')}</span>
        <span>Session packet count: {workoutSession?.packetCount ?? 0} · received here: {workoutPackets.length}</span>
        <span>HR packets: {workoutDiagnostics?.hrPacketCount ?? 0}</span>
        <span>Current HR: {currentWorkoutHr ?? '—'} bpm</span>
        <span>Current steps: {currentWorkoutPacket?.steps ?? '—'} · calories: {currentWorkoutPacket?.calories ?? '—'}</span>
        <span>ExerciseTime: {currentWorkoutPacket?.elapsedSeconds ?? '—'} s · raw vendor value: {currentWorkoutPacket?.exerciseTimeRaw ?? '—'} · {currentWorkoutPacket?.exerciseTimeValidationStatus ?? 'not emitted'}</span>
        <span>Last packet age: {lastWorkoutPacketAgeSeconds === null ? '—' : `${lastWorkoutPacketAgeSeconds.toFixed(1)} s`}</span>
        <span>Heartbeat attempts/sent/skipped: {workoutSession?.heartbeatAttemptCount ?? 0}/{workoutSession?.heartbeatSentCount ?? 0}/{workoutSession?.heartbeatSkippedCount ?? 0}</span>
          <span>App-supplied sendHeartPackage inputs: distance {workoutSession?.heartbeatInputs?.distanceKm ?? '—'} km · pace {workoutSession?.heartbeatInputs?.paceSeconds ?? '—'} s · signal {workoutSession?.heartbeatInputs?.rssiStrength ?? '—'} (vendor scale, not Android dBm)</span>
          <span>Type 82 band-returned fields: heartRate, step, calories, ExerciseTime. Not returned: distance, pace, METS, temperature, SpO2, RSSI.</span>
        <span>Packet interval median/P95: {workoutDiagnostics?.medianPacketIntervalMs?.toFixed(0) ?? '—'} / {workoutDiagnostics?.p95PacketIntervalMs?.toFixed(0) ?? '—'} ms</span>
        <span>Packets 750–1250 ms: {workoutDiagnostics?.percentagePacketsBetween750And1250Ms?.toFixed(1) ?? '—'}%</span>
        <span>HR-bearing interval median/P95: {workoutDiagnostics?.medianHrPacketIntervalMs?.toFixed(0) ?? '—'} / {workoutDiagnostics?.p95HrPacketIntervalMs?.toFixed(0) ?? '—'} ms</span>
        <span>Nonzero HR observation interval median/P95: {workoutDiagnostics?.medianNonZeroHrIntervalMs?.toFixed(0) ?? '—'} / {workoutDiagnostics?.p95NonZeroHrIntervalMs?.toFixed(0) ?? '—'} ms</span>
        <span>Zero HR: {workoutDiagnostics?.zeroHrCount ?? 0} · missing HR: {workoutDiagnostics?.missingHrCount ?? 0}</span>
        <span>Unique nonzero HR values: {workoutDiagnostics?.uniqueHrValueCount ?? 0} · consecutive repeats: {workoutDiagnostics?.consecutiveRepeatedHrCount ?? 0} · longest repeated run: {workoutDiagnostics?.longestRepeatedHrRun ?? 0}</span>
        <span>Classification: {workoutDiagnostics?.classification ?? 'PENDING'}</span>
        {workoutHeartRateEvent && <span>Last dedicated HR event: {workoutHeartRateEvent.heartRate} bpm · seq {workoutHeartRateEvent.packetSequence}</span>}
        {workoutError && <span role="alert">Workout error: {workoutError.message}</span>}
      </section>
      <div className="workout-packet-table-wrap">
        <table className="workout-packet-table">
          <thead><tr><th>Seq</th><th>Received</th><th>HR</th><th>Steps</th><th>Calories</th><th>ExerciseTime raw</th></tr></thead>
          <tbody>{workoutPackets.slice(-10).map((packet) => <tr key={`${packet.sessionId}-${packet.packetSequence}`}>
            <td>{packet.packetSequence}</td><td>{new Date(packet.receivedAt).toLocaleTimeString()}</td><td>{packet.heartRate ?? '—'}</td>
            <td>{packet.steps ?? '—'}</td><td>{packet.calories ?? '—'}</td><td>{packet.elapsedSeconds ?? '—'} s ({packet.exerciseTimeRaw ?? '—'})</td>
          </tr>)}</tbody>
        </table>
      </div>
      {hrDeliverySnapshot && <WorkoutHrDeliveryView
        snapshot={hrDeliverySnapshot}
        queueStats={deliveryQueueStats}
        connectorRegistered={connectorRegistered}
        bleDeviceLocalOnly={info?.macAddress ?? info?.deviceId ?? workoutSession?.deviceId ?? null}
        online={typeof navigator === 'undefined' || navigator.onLine}
        e2eTestEndsAt={hrTestEndsAt}
        now={deliveryClock}
        startTestDisabledReason={hrDeliveryTestDisabledReason({ workoutStartReason, queueStoreInitialized: queueDiagnostics.queueStoreInitialized, queueHealth: deliveryQueueHealth, connectorRegistered })}
        busy={busy}
        onToggleEnabled={(enabled) => hrDeliveryRef.current?.setEnabled(enabled)}
        onStartTest={() => void startHrDeliveryTest()}
        onFlush={() => void hrDeliveryRef.current?.flush('MANUAL')}
        onReplay={() => void hrDeliveryRef.current?.replay()}
        onTestQueue={() => void testQueue()}
        deliveryDiagnostics={deliveryDiagnostics}
        staleSendingCount={staleSendingCount}
        staleRetryResult={staleRetryResult}
        onRetryStaleSending={() => void observationBatchManager.retryStaleSending().then(
          (released) => setStaleRetryResult(`${new Date().toISOString()}: released ${released} stale SENDING observation(s) to RETRYING`),
          (error) => setStaleRetryResult(`${new Date().toISOString()}: failed — ${errorText(error)}`),
        )}
        queueDiagnostics={queueDiagnostics}
        queueHealth={deliveryQueueHealth}
        queueReadError={queueReadError}
        selfTest={queueSelfTest}
      />}
      {physiologySnapshot && <PhysiologyDeliveryView
        snapshot={physiologySnapshot}
        busy={busy}
        onToggleEnabled={(enabled) => physiologyRef.current?.setEnabled(enabled)}
        onToggleMetric={(key, enabled) => physiologyRef.current?.setMetricEnabled(key, enabled)}
        onReset={() => physiologyRef.current?.resetDiagnostics()}
        safeTestDisabledReason={busy ? 'busy' : !ready ? 'V8 not READY' : otherActiveMeasurement !== null ? `${otherActiveMeasurement} active` : null}
        onHistoricalHrSafeTest={(limit) => void runHistoricalHrStream(limit)}
        heartRateStream={hrStream}
        nativeBreadcrumbs={nativeBreadcrumbs}
        lastResponseShape={deliveryDiagnostics.recentResponseShapes.at(-1) ?? null}
        breadcrumbs={crashBreadcrumbs.getState()}
      />}
      {message && <p className="error-message" role="alert">{message}</p>}
      {lastError && <p>Last native error: {lastError.code} — {lastError.message}</p>}
    </section>
  )
}

export default JCVitalV8Panel
