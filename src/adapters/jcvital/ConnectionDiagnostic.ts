/**
 * Build 32B.1-D on-device Bluetooth connection diagnostic.
 *
 * Observes the unchanged production connection path (permission/state inspection -> scan -> discovery ->
 * optional connect -> READY) and classifies the first failed stage. It never acquires physiological
 * history, runs Type27/68/59 sync, touches the observation queue, calls Base44, starts workouts, or captures
 * certification evidence. The reference V8 below is an annotation only and is never used for matching.
 */
import type { JCVitalV8PermissionResult, JCVitalV8Plugin, JCVitalV8StateResult } from './jcvitalV8Bridge'
import { isElitePlusV8Advertisement } from './jcvitalV8Bridge'

export const CONNECTION_DIAGNOSTIC_SCHEMA = 'elite-plus-v8-connection-diagnostic/1'
export const CONNECTION_DIAGNOSTIC_FILENAME = 'ElitePlus V8 connection diagnostic.json'

export const REFERENCE_V8 = Object.freeze({
  advertisedFamily: 'JCV8B',
  macAddress: 'E7:1B:D8:36:78:CF',
  firmwareVersion: '0.0.8.8',
  sdkVersion: 'v8sdk2.0',
  usage: 'ANNOTATION_ONLY_NOT_USED_FOR_MATCHING',
})

export interface NativePermissionState {
  name: string
  requiredOnThisSdk: boolean
  declaredInManifest: boolean | null
  granted: boolean
}

export interface NativeAndroidBluetoothState {
  sdkInt: number
  manufacturer: string
  model: string
  bluetoothLeFeature: boolean
  adapterSupported: boolean | null
  bluetoothEnabled: boolean | null
  adapterState: string
  leScannerAvailable: boolean | null
  locationServicesEnabled: boolean | null
  inspectionErrors: Array<{ field: string; code: string; message: string }>
  permissions: Record<'BLUETOOTH_SCAN' | 'BLUETOOTH_CONNECT' | 'ACCESS_FINE_LOCATION' | 'BLUETOOTH' | 'BLUETOOTH_ADMIN', NativePermissionState>
}

export interface NativeTraceEvent {
  sequence: number
  at: string
  event: string
  detail: Record<string, unknown>
}

export interface NativeScanCandidate {
  address: string
  name: string | null
  rssi: number
  serviceUuids: string[]
  advertisesJcvitalService: boolean
  connectable: boolean | null
  firstSeenAt: string
  lastSeenAt: string
  scanSession: number
  advertisementCount: number
  v8Candidate: boolean
  acceptedByNativeFilter: boolean
  rejectionReason: string | null
  emittedToJs: number
  emittedWithJsListener: number
}

export interface NativeConnectionTrace {
  enabled: boolean
  pluginLoadedAt: string | null
  scanRequestedCount: number
  scanSession: number
  scanStartedAt: string | null
  scanActive: boolean
  scanCallbackRegistered: boolean
  advertisementsReceived: number
  lateAdvertisementsIgnored: number
  droppedEvents: number
  droppedCandidates: number
  candidates: NativeScanCandidate[]
  events: NativeTraceEvent[]
}

export interface NativeConnectionDiagnosticSnapshot {
  android: NativeAndroidBluetoothState
  capacitorPermissionAlias: string
  capacitorAliasState: string | null
  normalizedPermissionStatus: string
  connectionState: string
  connectedDeviceId: string | null
  jsListeners: { jcvitalScanResult: boolean; jcvitalConnectionState: boolean; jcvitalError: boolean }
  registryDevices: number
  trace: NativeConnectionTrace
  journalHandshake?: JournalHandshakeDiagnostic
}

export interface JournalHandshakeDiagnostic {
  journalState: string
  journalAccountId: string | null
  journalDeviceScopeId: string | null
  journalOpenAttempted: boolean
  journalOpenSucceeded: boolean
  journalFailureCode: string | null
  journalFailureMessage: string | null
  failedClosed: boolean
  priorFailureCode: string | null
  priorFailureMessage: string | null
  priorFailureTimestamp: string | null
  recoveryAudit: Record<string, unknown> | null
  recoveryAuditHistory?: Array<Record<string, unknown>>
  latestRecoveryAudit?: Record<string, unknown> | null
  type27Ingress?: {
    unsolicitedType27Count: number
    firstUnsolicitedAt: string | null
    lastUnsolicitedAt: string | null
    reason: string | null
    connectionGeneration: number
    lastUnsolicitedConnectionGeneration: number | null
  }
  journalFailedClosedAtStartup: boolean
  journalLastOutcome: string
  journalRefusedCount: number
  journalEnvelopeCount: number | null
  journalInspectionFailureCode: string | null
  journalInspectionFailureMessage: string | null
  transportInitializationStarted: boolean
  getDeviceVersionBlockedReason: string | null
  journalPressure?: JournalPressureDiagnostic
}

export interface JournalPressureDiagnostic {
  largestRecentEnvelopeBytes?: number | null
  recentEnvelopeSampleLimit?: number
  maxEntryBytes?: number
  reservedSourceFileBytes?: number | null
  safeHeadroomForNextWrite?: boolean | null
  globalEnvelopeCount: number | null
  globalAccountedBytes: number | null
  maxEnvelopes: number
  maxBytes: number
  envelopeHeadroom: number | null
  byteHeadroom: number | null
  budgetAtOrOverLimit: boolean | null
  limitsScope: string
  metricSource: string
  triggerRule: string
  pendingEnvelopeCountAtFailure: number | null
  pendingBytesAtFailure: number | null
  inspectionErrorCode: string | null
  inspectionErrorMessage: string | null
}

export interface OfflineJournalInspection {
  schema: 'offline-journal-inspection/1'
  status: 'OK' | 'JOURNAL_DATABASE_NOT_FOUND' | 'INSPECTION_FAILED'
  databasePath: string
  databaseExists: boolean
  openedReadOnly: boolean
  normalJournalState: string
  failedClosedAtStartup: boolean
  mutationDetected: boolean
  mutatedFields?: string[]
  beforeEqualsAfter?: boolean
  before?: Record<string, string | number | boolean | null>
  after?: Record<string, string | number | boolean | null>
  shmFileSizeBytesInformational?: number
  hashNote?: string
  errorCode?: string
  errorMessage?: string
  analysisMaxBytesAssumption: string
  analysis?: JournalCapacityAnalysis
}

export interface JournalCapacityAnalysis {
  schema: 'journal-capacity-analysis/1'
  generatedAt: string
  readOnly: true
  limitsScope: string
  failedClosed: boolean
  lastFailureCode: string | null
  maxBytes: number
  totalAccountedBytes: number
  envelopeJsonBytes: number
  rawBlobBytes: number
  perEnvelopeOverheadBytes: number
  reservedSourceFileBytes: number
  otherAccountedBytes: number
  accountingMatches: boolean
  hotProductionBytes: number | null
  coldCertificationBytes: number | null
  classificationReason: string
  groups: Record<string, Array<{ key: string; accountedBytes: number; envelopes?: number }>>
  globalEnvelopeCount?: number
  componentSumBytes?: number
  reconciliationDifferenceBytes?: number
  reconciliationStatus?: 'RECONCILED' | 'NOT_RECONCILED'
  reconciliationReasons?: string[]
  topRecords20?: Array<{
    sequence: number; accountId: string; deviceScopeId: string; vendorDataType: string; kind: string
    timestamp: string; jsonBytes: number; blobBytes: number; overheadBytes: number
    totalAccountedBytes: number; sourceRecordId: string; envelopeId: string
  }>
  rawBlobAnalysis?: {
    rawBlobBytesTotal: number; rawBlobCount: number; largestRawBlobBytes: number
    topRawBlobFamilies: Array<{ family: string; rawBlobBytes: number; blobs: number }>
    duplicateBlobCandidateCount: number; duplicateBlobCandidateBytes: number; duplicateBasis: string
    topDuplicateGroups: Array<{ sha256AndLength: string; copies: number; blobBytesEach: number; repeatedBytes: number; firstSequence: number | null }>
    removalStatus: string
  }
  evidenceInventory?: {
    certificationEvidenceBytes: number; certificationEvidenceScope: string
    diagnosticEvidenceBytes: number; diagnosticEvidenceScope: string
    rawPpgEnvelopeBytes: number
    certificationSnapshotBytes: number; certificationSnapshotScope: string
    reservedSourceFileBytes: number; reservedSourceFileScope: string
    sourceFileCount: number
    largestSourceFiles: Array<Record<string, unknown>>
  }
  recoveryPlanning?: {
    currentBytes: number; maxBytes: number; currentUtilizationPercent: number | null
    target80PercentBytes: number; bytesToRelieveFor80Percent: number
    pressureWarning90PercentBytes: number; bytesToRelieveBelow90Percent: number; pressureWarning90Active: boolean
    potentialArchivableCertificationBytes: number | null; markerBasedCertificationBytes: number
    potentialDuplicateBlobBytes: number; potentialColdDiagnosticBytes: number
    candidatesOverlapAndAreNotAdditive: true; candidateStatus: string
    recoveryThresholdStatus: string; archiveSemantics: string
  }
  top5ByteContributors: Array<{
    storage: string; accountId: string; deviceScopeId: string; kind: string
    accountedBytes: number; retrievalPointer: string
    envelopeId?: string; sequence?: number; sourceRecordId?: string
    vendorDataType?: string; captureFamily?: string; receivedAt?: string; rawBlobBytes?: number
    fileId?: string; sessionId?: string; ageBucket?: string; ageBasis?: string
  }>
  sourceFilesTop20: JournalCapacityAnalysis['top5ByteContributors']
  sourceFileCount: number
  certificationSnapshotsOutsideBudget: Array<{
    table: string; accountId: string; deviceScopeId: string; chunks: number
    utf8Bytes: number; includedInMaxBytes: false; closureAndReferencesVerified: false
  }>
  duplicateRawCandidatesTop20: Array<{
    accountId: string; deviceScopeId: string; kind: string; declaredSha256: string
    copies: number; rawBlobBytes: number; potentialRepeatedRawBytes: number; verifiedByteEquality: false
  }>
  duplicateRawCandidateGroups: number
  duplicateCaveat: string
  expectedNextSyncBytes: number | null
  safeHeadroomForNextWrite: boolean | null
}

export type ConnectionDiagnosticCode =
  | 'A_BLUETOOTH_DISABLED'
  | 'B_SCAN_PERMISSION_MISSING'
  | 'C_CONNECT_PERMISSION_MISSING'
  | 'D_NATIVE_PLUGIN_NOT_INITIALIZED'
  | 'E_SCAN_NOT_INVOKED'
  | 'F_SCAN_START_FAILED'
  | 'G_SCAN_RUNNING_NO_ADVERTISEMENTS'
  | 'H_ADVERTISEMENTS_RECEIVED_V8_NOT_MATCHED'
  | 'I_V8_FOUND_UI_NOT_UPDATED'
  | 'J_CONNECT_REQUEST_FAILED'
  | 'K_GATT_CONNECTION_FAILED'
  | 'L_READY_HANDSHAKE_FAILED'
  | 'M_INSUFFICIENT_EVIDENCE'

export type ConnectionStage =
  | 'NATIVE_PLUGIN' | 'BLUETOOTH_ADAPTER' | 'SCAN_PERMISSION' | 'CONNECT_PERMISSION' | 'SCAN_INVOCATION'
  | 'SCAN_START' | 'ADVERTISEMENTS' | 'V8_MATCH' | 'UI_UPDATE' | 'CONNECT_REQUEST' | 'GATT' | 'READY'

export interface ConnectionClassification {
  primary: ConnectionDiagnosticCode | null
  firstFailedStage: ConnectionStage | null
  summary: string
  supportingEvents: string[]
}

export interface DiagnosticEvent {
  at: string
  source: 'js' | 'native'
  event: string
  detail: Record<string, unknown>
}

export interface ProductionPanelProbe {
  mounted: boolean
  statusTitle: string | null
  statusMessage: string | null
  scanActionLabel: string | null
  permissionActionPresent: boolean
  deviceListCount: number
  connectActionCount: number
  renderedDeviceIds: string[]
}

/** Evidence for one classified window (pre-run production behaviour, or the diagnostic run). */
export interface ClassificationSegment {
  pluginReachable: boolean
  pluginError: string | null
  android: NativeAndroidBluetoothState | null
  traceEnabled: boolean
  pluginLoaded: boolean
  events: DiagnosticEvent[]
  candidates: NativeScanCandidate[]
  advertisementsReceived: number
  maxDomDeviceCount: number
  scanResultListenerRegistered: boolean
  connectRequested: boolean
  connectError: string | null
  readyReached: boolean
}

const has = (events: DiagnosticEvent[], name: string) => events.some((event) => event.event === name)
const lastIndex = (events: DiagnosticEvent[], name: string) => events.map((event) => event.event).lastIndexOf(name)
const names = (events: DiagnosticEvent[], ...wanted: string[]) =>
  events.filter((event) => wanted.includes(event.event)).map((event) => `${event.at} ${event.source}:${event.event}`)

function permissionMissing(android: NativeAndroidBluetoothState, key: keyof NativeAndroidBluetoothState['permissions']) {
  const permission = android.permissions[key]
  return Boolean(permission?.requiredOnThisSdk && !permission.granted)
}

function result(primary: ConnectionDiagnosticCode | null, firstFailedStage: ConnectionStage | null, summary: string, supportingEvents: string[]): ConnectionClassification {
  return { primary, firstFailedStage, summary, supportingEvents }
}

export function classifyConnectionSegment(segment: ClassificationSegment): ConnectionClassification {
  const { events, android } = segment
  if (!segment.pluginReachable || !android || !segment.traceEnabled || !segment.pluginLoaded) {
    return result('D_NATIVE_PLUGIN_NOT_INITIALIZED', 'NATIVE_PLUGIN',
      segment.pluginError ? `JCVitalV8 native plugin unavailable: ${segment.pluginError}` : 'JCVitalV8 native plugin trace is not initialized.',
      names(events, 'PLUGIN_UNAVAILABLE', 'PLUGIN_INITIALIZED'))
  }
  if (android.adapterSupported === false || !android.bluetoothLeFeature) {
    return result('A_BLUETOOTH_DISABLED', 'BLUETOOTH_ADAPTER', 'This phone reports no Bluetooth LE adapter.', names(events, 'BLUETOOTH_UNSUPPORTED'))
  }
  if (android.bluetoothEnabled === false) {
    return result('A_BLUETOOTH_DISABLED', 'BLUETOOTH_ADAPTER', `Bluetooth adapter is ${android.adapterState}.`, names(events, 'BLUETOOTH_DISABLED'))
  }
  if (permissionMissing(android, 'BLUETOOTH_SCAN') || permissionMissing(android, 'ACCESS_FINE_LOCATION')) {
    return result('B_SCAN_PERMISSION_MISSING', 'SCAN_PERMISSION', 'Nearby Devices scan permission is not granted.',
      names(events, 'SCAN_PERMISSION_DENIED', 'PERMISSION_REQUEST_INVOKED', 'PERMISSION_PROMPT_SHOWN', 'PERMISSION_PROMPT_RESULT'))
  }
  if (permissionMissing(android, 'BLUETOOTH_CONNECT')) {
    return result('C_CONNECT_PERMISSION_MISSING', 'CONNECT_PERMISSION', 'Nearby Devices connect permission is not granted.',
      names(events, 'CONNECT_PERMISSION_DENIED', 'PERMISSION_REQUEST_INVOKED', 'PERMISSION_PROMPT_RESULT'))
  }
  if (android.bluetoothEnabled == null || android.adapterSupported == null) {
    return result('M_INSUFFICIENT_EVIDENCE', 'BLUETOOTH_ADAPTER', 'Android adapter state could not be read; see inspection errors.',
      names(events, 'ANDROID_STATE_INSPECTION_FAILED'))
  }
  if (segment.readyReached || has(events, 'READY')) {
    return result(null, null, 'Elite+ V8 reached READY.', names(events, 'CONNECT_REQUESTED', 'GATT_CONNECTED', 'SERVICES_DISCOVERED', 'NOTIFICATIONS_ENABLED', 'DEVICE_VERSION_REQUESTED', 'READY'))
  }
  if (has(events, 'PRODUCTION_SCAN_NOT_INVOKED') || has(events, 'PRODUCTION_SCAN_ACTION_ABSENT')) {
    return result('E_SCAN_NOT_INVOKED', 'SCAN_INVOCATION', 'The production V8 panel did not invoke a native scan; see fallbackClassification for the direct-scan result.',
      names(events, 'CONNECTION_PANEL_NOT_MOUNTED', 'PRODUCTION_SCAN_ACTION_ABSENT', 'PRODUCTION_SCAN_ACTION_CLICKED', 'PRODUCTION_SCAN_NOT_INVOKED', 'DIRECT_SCAN_FALLBACK'))
  }
  if (!has(events, 'SCAN_REQUESTED') && !has(events, 'SCAN_ALREADY_ACTIVE')) {
    return result('E_SCAN_NOT_INVOKED', 'SCAN_INVOCATION', 'No native startScan call reached the JCVitalV8 plugin.',
      names(events, 'PRODUCTION_SCAN_ACTION_ABSENT', 'PRODUCTION_SCAN_ACTION_CLICKED', 'PRODUCTION_SCAN_NOT_INVOKED', 'SCAN_REJECTED_BY_JS'))
  }
  if (lastIndex(events, 'SCAN_START_FAILED') > lastIndex(events, 'SCAN_STARTED') || (!has(events, 'SCAN_STARTED') && !has(events, 'SCAN_ALREADY_ACTIVE'))) {
    return result('F_SCAN_START_FAILED', 'SCAN_START', 'startScan was requested but Android did not start the LE scan.',
      names(events, 'SCAN_REQUESTED', 'SCAN_START_FAILED', 'SCAN_REJECTED_BY_JS'))
  }
  if (segment.advertisementsReceived === 0) {
    return result('G_SCAN_RUNNING_NO_ADVERTISEMENTS', 'ADVERTISEMENTS', 'The LE scan ran but Android delivered no advertisements.',
      names(events, 'SCAN_STARTED', 'SCAN_STOPPED', 'NO_ADVERTISEMENTS'))
  }
  const v8 = segment.candidates.filter(isElitePlusV8Advertisement)
  const accepted = v8.filter((candidate) => candidate.acceptedByNativeFilter)
  if (accepted.length === 0) {
    return result('H_ADVERTISEMENTS_RECEIVED_V8_NOT_MATCHED', 'V8_MATCH', v8.length
      ? `V8 advertiser seen but rejected by the native filter (${v8.map((candidate) => candidate.rejectionReason).join(', ')}).`
      : `${segment.advertisementsReceived} advertisements received; none matched an Elite+ V8.`,
    names(events, 'ADVERTISEMENT_RECEIVED', 'V8_FILTERED', 'ADVERTISEMENTS_RECEIVED_NO_V8_MATCH'))
  }
  const emitted = accepted.filter((candidate) => candidate.emittedToJs > 0)
  const delivered = emitted.filter((candidate) => candidate.emittedWithJsListener > 0)
  if (emitted.length === 0 || delivered.length === 0 || !segment.scanResultListenerRegistered || segment.maxDomDeviceCount === 0) {
    const reason = emitted.length === 0 ? 'V8 matched natively but no scan result was emitted to JavaScript.'
      : delivered.length === 0 || !segment.scanResultListenerRegistered ? 'V8 scan result emitted while no jcvitalScanResult listener was registered.'
        : 'V8 scan result reached JavaScript but the production device list stayed empty.'
    return result('I_V8_FOUND_UI_NOT_UPDATED', 'UI_UPDATE', reason,
      names(events, 'V8_CANDIDATE_MATCHED', 'SCAN_RESULT_EMITTED_TO_JS', 'V8_DISCOVERED_UI_NOT_UPDATED'))
  }
  if (!segment.connectRequested) {
    return result(null, null, 'Elite+ V8 discovered and rendered; connect was not requested.',
      names(events, 'V8_CANDIDATE_MATCHED', 'SCAN_RESULT_EMITTED_TO_JS', 'V8_RENDERED_IN_PRODUCTION_LIST'))
  }
  if (!has(events, 'CONNECT_REQUESTED') && !has(events, 'GATT_CONNECT_REQUESTED') && !segment.connectError) {
    return result('M_INSUFFICIENT_EVIDENCE', null, 'Connect was requested but neither native connect evidence nor an error was captured.',
      events.slice(-12).map((event) => `${event.at} ${event.source}:${event.event}`))
  }
  if (!has(events, 'GATT_CONNECT_REQUESTED') || has(events, 'CONNECT_FAILED')) {
    return result('J_CONNECT_REQUEST_FAILED', 'CONNECT_REQUEST', segment.connectError ?? 'Native connect request did not reach connectGatt.',
      names(events, 'PRODUCTION_CONNECT_ACTION_CLICKED', 'CONNECT_REQUESTED', 'CONNECT_FAILED', 'CONNECTION_FAILURE'))
  }
  if (!has(events, 'GATT_CONNECTED') || !has(events, 'SERVICES_DISCOVERED')) {
    return result('K_GATT_CONNECTION_FAILED', 'GATT', segment.connectError ?? 'GATT did not connect and discover services.',
      names(events, 'GATT_CONNECT_REQUESTED', 'GATT_CONNECTED', 'GATT_FAILED', 'GATT_DISCONNECTED', 'SERVICE_DISCOVERY_FAILED', 'CONNECTION_FAILURE'))
  }
  if (has(events, 'SERVICES_DISCOVERED')) {
    return result('L_READY_HANDSHAKE_FAILED', 'READY', segment.connectError ?? 'GATT connected but READY was not reached.',
      names(events, 'SERVICES_DISCOVERED', 'JOURNAL_BOUND_INITIALIZING_TRANSPORT', 'MTU_CHANGED', 'NOTIFICATIONS_ENABLED', 'DEVICE_VERSION_REQUESTED', 'READY_TIMEOUT', 'CONNECTION_FAILURE'))
  }
  return result('M_INSUFFICIENT_EVIDENCE', null, 'Evidence does not identify a single failed stage.', events.slice(-12).map((event) => `${event.at} ${event.source}:${event.event}`))
}

export interface ConnectionDiagnosticBridge {
  getConnectionDiagnosticSnapshot: JCVitalV8Plugin['getConnectionDiagnosticSnapshot']
  isAvailable: JCVitalV8Plugin['isAvailable']
  getPermissionStatus(): Promise<JCVitalV8PermissionResult>
  requestPermissions(): Promise<JCVitalV8PermissionResult>
  startScan(options?: { timeoutMs?: number }): Promise<void>
  stopScan(): Promise<void>
  getConnectionState(): Promise<JCVitalV8StateResult>
}

/** Reads and drives the unchanged production V8 panel through its rendered DOM. */
export interface ProductionPanelDriver {
  probe(): ProductionPanelProbe
  clickScanAction(): boolean
  clickPermissionAction(): boolean
  clickConnectAction(deviceId: string): boolean
}

export interface ConnectionDiagnosticEnvironment {
  bridge: ConnectionDiagnosticBridge
  panel: ProductionPanelDriver
  now(): number
  sleep(ms: number): Promise<void>
  appLifecycle(): string
  platform: string
  authenticated: boolean
  appVersion: string
  versionCode: number
  /** Direct-scan fallback using the shared production lifecycle helper. */
  startDiscovery(): Promise<void>
  /** Panel mount/unmount and app lifecycle transitions observed before the run. */
  priorEvents?: DiagnosticEvent[]
}

export interface ConnectionDiagnosticOptions {
  connect: boolean
  scanWindowMs?: number
  readyTimeoutMs?: number
  pollMs?: number
  productionActionGraceMs?: number
}

export interface ConnectionDiagnosticReport {
  schema: typeof CONNECTION_DIAGNOSTIC_SCHEMA
  build: { appVersion: string; versionCode: number; variant: 'connection-diagnostic' }
  generatedAt: string
  session: { authenticated: boolean; platform: string; appLifecycleAtStart: string; appLifecycleAtEnd: string }
  options: { connect: boolean; scanWindowMs: number; readyTimeoutMs: number }
  plugin: { reachable: boolean; error: string | null; available: boolean | null; bluetoothEnabled: boolean | null; initializedAt: string | null }
  permissions: {
    normalizedBeforeRun: string | null
    normalizedAfterRun: string | null
    capacitorAlias: string | null
    capacitorAliasState: string | null
    android: NativeAndroidBluetoothState['permissions'] | null
  }
  bluetoothAdapter: Omit<NativeAndroidBluetoothState, 'permissions'> | null
  productionPanel: { beforeRun: ProductionPanelProbe; afterScan: ProductionPanelProbe | null; afterRun: ProductionPanelProbe }
  scan: {
    path: 'PRODUCTION_UI' | 'DIRECT_FALLBACK' | 'NOT_STARTED'
    requested: boolean
    startedAt: string | null
    activeAtEnd: boolean
    callbackRegistered: boolean
    nativeCallbackRegistered: boolean
    advertisementsReceived: number
    devicesDiscovered: number
    v8CandidatesDetected: number
    candidatesFiltered: number
    lastScanError: string | null
  }
  discoveredDevices: Array<NativeScanCandidate & { referenceDeviceObserved: boolean }>
  journalHandshake?: JournalHandshakeDiagnostic | null
  connection: {
    path: 'PRODUCTION_UI' | 'PRODUCTION_CONNECT_ACTION_UNAVAILABLE' | 'NOT_REQUESTED'
    deviceSelected: string | null
    connectRequested: boolean
    gattState: string
    servicesDiscovered: boolean
    notificationsEnabled: boolean
    deviceVersionRequested: boolean
    readyReached: boolean
    finalConnectionState: string | null
    lastError: string | null
  }
  referenceDevice: typeof REFERENCE_V8 & { observed: boolean; observedName: string | null; acceptedByNativeFilter: boolean | null; renderedInProductionList: boolean | null }
  events: DiagnosticEvent[]
  errors: string[]
  preRunClassification: ConnectionClassification
  classification: ConnectionClassification
  /** Run classification ignoring the production-scan invocation stage, from the direct-scan fallback. */
  fallbackClassification: ConnectionClassification | null
  firstFailedStage: ConnectionStage | null
  nativeTraceDroppedEvents: number
}

const errorText = (error: unknown) => {
  if (error && typeof error === 'object') {
    const code = 'code' in error && typeof error.code === 'string' ? `${error.code}: ` : ''
    const message = 'message' in error && typeof error.message === 'string' ? error.message : String(error)
    return `${code}${message}`
  }
  return String(error)
}

const nativeEvents = (snapshot: NativeConnectionDiagnosticSnapshot | null, afterSequence = 0): DiagnosticEvent[] =>
  (snapshot?.trace.events ?? []).filter((event) => event.sequence > afterSequence)
    .map((event) => ({ at: event.at, source: 'native', event: event.event, detail: event.detail ?? {} }))

export function mergeEvents(...groups: DiagnosticEvent[][]): DiagnosticEvent[] {
  return groups.flat().map((event, index) => ({ event, index }))
    .sort((left, right) => left.event.at.localeCompare(right.event.at) || left.index - right.index)
    .map(({ event }) => event)
}

const isReference = (candidate: NativeScanCandidate) => candidate.address.toUpperCase() === REFERENCE_V8.macAddress
const maxSequence = (snapshot: NativeConnectionDiagnosticSnapshot | null) =>
  Math.max(0, ...(snapshot?.trace.events ?? []).map((event) => event.sequence))

function segmentFrom(
  snapshot: NativeConnectionDiagnosticSnapshot | null,
  pluginError: string | null,
  events: DiagnosticEvent[],
  candidates: NativeScanCandidate[],
  advertisementsReceived: number,
  extras: Pick<ClassificationSegment, 'maxDomDeviceCount' | 'connectRequested' | 'connectError' | 'readyReached'> & { listenerRegistered?: boolean },
): ClassificationSegment {
  return {
    pluginReachable: Boolean(snapshot),
    pluginError,
    android: snapshot?.android ?? null,
    traceEnabled: snapshot?.trace.enabled ?? false,
    pluginLoaded: Boolean(snapshot?.trace.pluginLoadedAt),
    events,
    candidates,
    advertisementsReceived,
    scanResultListenerRegistered: extras.listenerRegistered ?? snapshot?.jsListeners.jcvitalScanResult ?? false,
    maxDomDeviceCount: extras.maxDomDeviceCount,
    connectRequested: extras.connectRequested,
    connectError: extras.connectError,
    readyReached: extras.readyReached,
  }
}

/** Runs permission/state inspection -> scan -> discovery -> optional connect, observing the production panel. */
export async function runConnectionDiagnostic(
  env: ConnectionDiagnosticEnvironment,
  options: ConnectionDiagnosticOptions,
): Promise<ConnectionDiagnosticReport> {
  const scanWindowMs = options.scanWindowMs ?? 15000
  const readyTimeoutMs = options.readyTimeoutMs ?? 30000
  const pollMs = options.pollMs ?? 500
  const graceMs = options.productionActionGraceMs ?? 2000
  const iso = () => new Date(env.now()).toISOString()
  const jsEvents: DiagnosticEvent[] = []
  const errors: string[] = []
  const record = (event: string, detail: Record<string, unknown> = {}) => { jsEvents.push({ at: iso(), source: 'js', event, detail }) }
  const lifecycleAtStart = env.appLifecycle()

  let pluginError: string | null = null
  const readSnapshot = async (): Promise<NativeConnectionDiagnosticSnapshot | null> => {
    try { return await env.bridge.getConnectionDiagnosticSnapshot() } catch (error) {
      pluginError = errorText(error)
      if (!errors.includes(`getConnectionDiagnosticSnapshot: ${pluginError}`)) {
        errors.push(`getConnectionDiagnosticSnapshot: ${pluginError}`)
        record('PLUGIN_SNAPSHOT_FAILED', { message: pluginError })
      }
      return null
    }
  }

  // Inspection: everything the production panel did before this run is the pre-run segment.
  if (env.authenticated) record('APP_AUTHENTICATED')
  record('APP_LIFECYCLE', { state: lifecycleAtStart, platform: env.platform })
  const beforeRun = env.panel.probe()
  record(beforeRun.mounted ? 'CONNECTION_PANEL_MOUNTED' : 'CONNECTION_PANEL_NOT_MOUNTED', { ...beforeRun })
  const pre = await readSnapshot()
  if (!pre) record('PLUGIN_UNAVAILABLE', { error: pluginError })
  let available: { available: boolean; enabled: boolean } | null = null
  let permissionBefore: JCVitalV8PermissionResult | null = null
  try { available = await env.bridge.isAvailable() } catch (error) { errors.push(`isAvailable: ${errorText(error)}`) }
  try { permissionBefore = await env.bridge.getPermissionStatus() } catch (error) { errors.push(`getPermissionStatus: ${errorText(error)}`) }
  const preEvents = mergeEvents(nativeEvents(pre), jsEvents.slice())
  const preRunClassification = classifyConnectionSegment(segmentFrom(pre, pluginError, preEvents, pre?.trace.candidates ?? [],
    pre?.trace.advertisementsReceived ?? 0, {
      maxDomDeviceCount: beforeRun.deviceListCount,
      connectRequested: has(preEvents, 'CONNECT_REQUESTED'),
      connectError: null,
      readyReached: pre?.connectionState === 'READY',
    }))
  const startSequence = maxSequence(pre)
  const startSession = pre?.trace.scanSession ?? 0
  const startAdvertisements = pre?.trace.advertisementsReceived ?? 0
  record('RUN_STARTED', { connect: options.connect, preRunPrimary: preRunClassification.primary })

  if (pre) {
    const android = pre.android
    if (android.bluetoothEnabled != null) {
      record(android.bluetoothEnabled ? 'BLUETOOTH_ADAPTER_ENABLED' : 'BLUETOOTH_DISABLED', { adapterState: android.adapterState })
    }
    for (const error of android.inspectionErrors) record('ANDROID_STATE_INSPECTION_FAILED', { ...error })
    const scanMissing = permissionMissing(android, 'BLUETOOTH_SCAN') || permissionMissing(android, 'ACCESS_FINE_LOCATION')
    record(scanMissing ? 'SCAN_PERMISSION_DENIED' : 'SCAN_PERMISSION_GRANTED')
    record(permissionMissing(android, 'BLUETOOTH_CONNECT') ? 'CONNECT_PERMISSION_DENIED' : 'CONNECT_PERMISSION_GRANTED')
  }

  // Scan through the production UI first so the exact production path is exercised.
  let scanPath: ConnectionDiagnosticReport['scan']['path'] = 'NOT_STARTED'
  let lastScanError: string | null = null
  const nativeRequestedSince = async () => {
    const snapshot = await readSnapshot()
    return { snapshot, requested: nativeEvents(snapshot, startSequence).some((event) => event.event === 'SCAN_REQUESTED' || event.event === 'SCAN_ALREADY_ACTIVE') }
  }
  if (pre?.trace.scanActive) {
    scanPath = 'PRODUCTION_UI'
    record('SCAN_ALREADY_ACTIVE', { scanSession: pre.trace.scanSession, startedAt: pre.trace.scanStartedAt })
  }
  if (env.authenticated && pre?.trace.enabled && pre.trace.pluginLoadedAt && pre.connectionState !== 'READY' && !pre.trace.scanActive) {
    const clicked = beforeRun.scanActionLabel ? env.panel.clickScanAction()
      : beforeRun.permissionActionPresent ? env.panel.clickPermissionAction() : false
    if (clicked) {
      record('PRODUCTION_SCAN_ACTION_CLICKED', { label: beforeRun.scanActionLabel ?? 'Allow Bluetooth' })
      scanPath = 'PRODUCTION_UI'
      let waited = 0
      let requested = false
      while (waited <= graceMs && !requested) {
        await env.sleep(pollMs)
        waited += pollMs
        requested = (await nativeRequestedSince()).requested
      }
      if (!requested && beforeRun.permissionActionPresent && !beforeRun.scanActionLabel) {
        const after = env.panel.probe()
        if (after.scanActionLabel && env.panel.clickScanAction()) {
          record('PRODUCTION_SCAN_ACTION_CLICKED', { label: after.scanActionLabel, afterPermission: true })
          await env.sleep(graceMs)
          requested = (await nativeRequestedSince()).requested
        }
      }
      if (!requested) record('PRODUCTION_SCAN_NOT_INVOKED', { waitedMs: waited })
    } else {
      record('PRODUCTION_SCAN_ACTION_ABSENT', { statusTitle: beforeRun.statusTitle, mounted: beforeRun.mounted })
    }
    const { requested } = await nativeRequestedSince()
    if (!requested) {
      scanPath = 'DIRECT_FALLBACK'
      record('DIRECT_SCAN_FALLBACK')
      try {
        const permission = permissionBefore?.status === 'AUTHORIZED' ? permissionBefore : await env.bridge.requestPermissions()
        if (permission.status === 'AUTHORIZED' && permission.bluetoothEnabled) await env.startDiscovery()
        else record('SCAN_REJECTED_BY_JS', { permission: permission.status, bluetoothEnabled: permission.bluetoothEnabled })
      } catch (error) {
        lastScanError = errorText(error)
        record('SCAN_REJECTED_BY_JS', { error: lastScanError })
      }
    }
  }

  // Discovery window: poll native trace and the production device list.
  let maxDomDeviceCount = 0
  let afterScan: ProductionPanelProbe | null = null
  let latest = await readSnapshot()
  const runCandidates = () => (latest?.trace.candidates ?? []).filter((candidate) =>
    candidate.scanSession > startSession || (pre?.trace.scanActive && candidate.scanSession === startSession))
  const visibleV8Count = (probe: ProductionPanelProbe) => runCandidates().filter((candidate) =>
    isElitePlusV8Advertisement(candidate) && probe.renderedDeviceIds.includes(candidate.address)).length
  let elapsed = 0
  while (latest && elapsed < scanWindowMs) {
    afterScan = env.panel.probe()
    maxDomDeviceCount = Math.max(maxDomDeviceCount, visibleV8Count(afterScan))
    const v8Emitted = runCandidates().some((candidate) => isElitePlusV8Advertisement(candidate) && candidate.emittedToJs > 0)
    if (v8Emitted && maxDomDeviceCount > 0) break
    if (!latest.trace.scanActive && elapsed > 0 && nativeEvents(latest, startSequence).some((event) => event.event === 'SCAN_STOPPED' || event.event === 'SCAN_START_FAILED')) break
    await env.sleep(pollMs)
    elapsed += pollMs
    latest = await readSnapshot() ?? latest
  }
  afterScan = env.panel.probe()
  maxDomDeviceCount = Math.max(maxDomDeviceCount, visibleV8Count(afterScan))

  const scanFailure = nativeEvents(latest, startSequence).filter((event) => event.event === 'SCAN_START_FAILED').at(-1)
  if (scanFailure) lastScanError = `${String(scanFailure.detail.code ?? 'SCAN_FAILED')}: ${String(scanFailure.detail.message ?? '')}`
  const runAdvertisements = (latest?.trace.advertisementsReceived ?? 0) - (pre?.trace.scanActive ? 0 : startAdvertisements)
  const v8Accepted = runCandidates().filter((candidate) => isElitePlusV8Advertisement(candidate) && candidate.acceptedByNativeFilter)
  if (latest && scanPath !== 'NOT_STARTED' && nativeEvents(latest, startSequence).some((event) => event.event === 'SCAN_STARTED')) {
    if (runAdvertisements === 0) record('NO_ADVERTISEMENTS', { windowMs: elapsed })
    else if (v8Accepted.length === 0) record('ADVERTISEMENTS_RECEIVED_NO_V8_MATCH', { advertisements: runAdvertisements })
    else if (maxDomDeviceCount === 0) record('V8_DISCOVERED_UI_NOT_UPDATED', { v8: v8Accepted.map((candidate) => candidate.address) })
    else record('V8_RENDERED_IN_PRODUCTION_LIST', { deviceListCount: maxDomDeviceCount })
  }

  // Optional connect, again through the production Connect button where it rendered.
  let connectionPath: ConnectionDiagnosticReport['connection']['path'] = 'NOT_REQUESTED'
  let deviceSelected: string | null = null
  let connectError: string | null = null
  let readyReached = latest?.connectionState === 'READY'
  if (options.connect && latest && !readyReached && v8Accepted.length > 0 && maxDomDeviceCount > 0) {
    const best = [...v8Accepted].sort((left, right) => right.rssi - left.rssi)[0]
    deviceSelected = best.address
    record('DEVICE_SELECTED', { address: best.address, name: best.name, rssi: best.rssi })
    if (maxDomDeviceCount > 0 && env.panel.clickConnectAction(best.address)) {
      connectionPath = 'PRODUCTION_UI'
      record('PRODUCTION_CONNECT_ACTION_CLICKED')
    } else {
      connectionPath = 'PRODUCTION_CONNECT_ACTION_UNAVAILABLE'
      record('PRODUCTION_CONNECT_ACTION_ABSENT')
      connectError = 'Production device list has no Connect action; connect not attempted outside the production panel.'
    }
    if (connectionPath === 'PRODUCTION_UI') {
      let waited = 0
      while (waited < readyTimeoutMs) {
        await env.sleep(pollMs)
        waited += pollMs
        latest = await readSnapshot() ?? latest
        const runNative = nativeEvents(latest, startSequence)
        if (latest?.connectionState === 'READY' || runNative.some((event) => event.event === 'READY')) { readyReached = true; break }
        const failure = runNative.filter((event) => event.event === 'CONNECTION_FAILURE' || event.event === 'CONNECT_FAILED').at(-1)
        if (failure) { connectError = `${String(failure.detail.code ?? failure.event)}: ${String(failure.detail.message ?? '')}`; break }
      }
      if (!readyReached && !connectError) {
        connectError = `READY not reached within ${readyTimeoutMs} ms`
        record('READY_TIMEOUT', { waitedMs: waited })
      }
    }
  }

  // Leave discovery idle when no connection is in progress.
  latest = await readSnapshot() ?? latest
  if (latest?.trace.scanActive && !readyReached) {
    try { await env.bridge.stopScan(); record('SCAN_STOP_REQUESTED') } catch (error) { errors.push(`stopScan: ${errorText(error)}`) }
    latest = await readSnapshot() ?? latest
  }
  let permissionAfter: JCVitalV8PermissionResult | null = null
  try { permissionAfter = await env.bridge.getPermissionStatus() } catch (error) { errors.push(`getPermissionStatus(after): ${errorText(error)}`) }
  let finalState: string | null = latest?.connectionState ?? null
  try { finalState = (await env.bridge.getConnectionState()).state } catch (error) { errors.push(`getConnectionState: ${errorText(error)}`) }
  const afterRun = env.panel.probe()
  record('RUN_FINISHED', { finalConnectionState: finalState })

  const runNative = nativeEvents(latest, startSequence)
  const runEvents = mergeEvents(runNative, jsEvents.slice(jsEvents.findIndex((event) => event.event === 'RUN_STARTED')))
  const candidates = runCandidates()
  const connectRequested = runNative.some((event) => event.event === 'CONNECT_REQUESTED') || connectionPath === 'PRODUCTION_UI'
  const runExtras = {
    maxDomDeviceCount, connectRequested: connectRequested || connectionPath === 'PRODUCTION_CONNECT_ACTION_UNAVAILABLE', connectError, readyReached,
    listenerRegistered: (pre?.jsListeners.jcvitalScanResult ?? false) || (latest?.jsListeners.jcvitalScanResult ?? false),
  }
  const classification = classifyConnectionSegment(segmentFrom(latest, pluginError, runEvents, candidates, runAdvertisements, runExtras))
  const fallbackClassification = classification.primary === 'E_SCAN_NOT_INVOKED'
    ? classifyConnectionSegment(segmentFrom(latest, pluginError, runEvents.filter((event) =>
      event.event !== 'PRODUCTION_SCAN_NOT_INVOKED' && event.event !== 'PRODUCTION_SCAN_ACTION_ABSENT'), candidates, runAdvertisements, runExtras))
    : null
  const reference = [...(latest?.trace.candidates ?? [])].reverse().find(isReference) ?? null
  const { permissions: androidPermissions, ...adapter } = latest?.android ?? { permissions: null }
  const allEvents = mergeEvents(nativeEvents(latest), env.priorEvents ?? [], jsEvents)
  if (lastScanError) errors.push(`scan: ${lastScanError}`)
  if (connectError) errors.push(`connect: ${connectError}`)
  for (const error of latest?.android.inspectionErrors ?? []) {
    errors.push(`Android ${error.field}: ${error.code}: ${error.message}`)
  }
  return {
    schema: CONNECTION_DIAGNOSTIC_SCHEMA,
    build: { appVersion: env.appVersion, versionCode: env.versionCode, variant: 'connection-diagnostic' },
    generatedAt: iso(),
    session: { authenticated: env.authenticated, platform: env.platform, appLifecycleAtStart: lifecycleAtStart, appLifecycleAtEnd: env.appLifecycle() },
    options: { connect: options.connect, scanWindowMs, readyTimeoutMs },
    plugin: {
      reachable: Boolean(latest), error: pluginError, available: available?.available ?? null,
      bluetoothEnabled: available?.enabled ?? null, initializedAt: latest?.trace.pluginLoadedAt ?? null,
    },
    permissions: {
      normalizedBeforeRun: permissionBefore?.status ?? null,
      normalizedAfterRun: permissionAfter?.status ?? null,
      capacitorAlias: latest?.capacitorPermissionAlias ?? null,
      capacitorAliasState: latest?.capacitorAliasState ?? null,
      android: androidPermissions,
    },
    bluetoothAdapter: latest ? adapter as Omit<NativeAndroidBluetoothState, 'permissions'> : null,
    productionPanel: { beforeRun, afterScan, afterRun },
    scan: {
      path: scanPath,
      requested: runNative.some((event) => event.event === 'SCAN_REQUESTED' || event.event === 'SCAN_ALREADY_ACTIVE'),
      startedAt: latest?.trace.scanStartedAt ?? null,
      activeAtEnd: latest?.trace.scanActive ?? false,
      callbackRegistered: latest?.jsListeners.jcvitalScanResult ?? false,
      nativeCallbackRegistered: latest?.trace.scanCallbackRegistered ?? false,
      advertisementsReceived: runAdvertisements,
      devicesDiscovered: candidates.length,
      v8CandidatesDetected: candidates.filter(isElitePlusV8Advertisement).length,
      candidatesFiltered: candidates.filter((candidate) => !candidate.acceptedByNativeFilter).length,
      lastScanError,
    },
    discoveredDevices: (latest?.trace.candidates ?? []).map((candidate) => ({ ...candidate, referenceDeviceObserved: isReference(candidate) })),
    journalHandshake: latest?.journalHandshake ?? null,
    connection: {
      path: connectionPath,
      deviceSelected,
      connectRequested,
      gattState: has(runNative, 'GATT_CONNECTED') ? (has(runNative, 'GATT_DISCONNECTED') ? 'DISCONNECTED_AFTER_CONNECT' : 'CONNECTED')
        : has(runNative, 'GATT_FAILED') ? 'FAILED' : has(runNative, 'GATT_CONNECT_REQUESTED') ? 'REQUESTED' : 'NOT_REQUESTED',
      servicesDiscovered: has(runNative, 'SERVICES_DISCOVERED'),
      notificationsEnabled: has(runNative, 'NOTIFICATIONS_ENABLED'),
      deviceVersionRequested: has(runNative, 'DEVICE_VERSION_REQUESTED'),
      readyReached,
      finalConnectionState: finalState,
      lastError: connectError,
    },
    referenceDevice: {
      ...REFERENCE_V8,
      observed: Boolean(reference),
      observedName: reference?.name ?? null,
      acceptedByNativeFilter: reference?.acceptedByNativeFilter ?? null,
      renderedInProductionList: reference ? [beforeRun, afterScan, afterRun].some((probe) =>
        probe?.renderedDeviceIds.includes(reference.address)) : null,
    },
    events: allEvents,
    errors,
    preRunClassification,
    classification,
    fallbackClassification,
    firstFailedStage: classification.firstFailedStage,
    nativeTraceDroppedEvents: latest?.trace.droppedEvents ?? 0,
  }
}

const FORBIDDEN_EXPORT_KEYS = /token|password|secret|api[-_]?key|authorization|email|bearer/i

export function serializeConnectionDiagnostic(report: ConnectionDiagnosticReport): string {
  return JSON.stringify(report, (key, value) => (key && FORBIDDEN_EXPORT_KEYS.test(key) ? undefined : value), 2)
}

const SCAN_ACTION = /^(Connect your Elite\+ V8|Reconnect your Elite\+ V8|Scan for Elite\+ V8)$/

/** DOM driver for the production ElitePlusV8Dashboard; it only reads text and clicks rendered buttons. */
export function createDomPanelDriver(root: ParentNode = document): ProductionPanelDriver {
  const card = () => root.querySelector('.elite-v8-dashboard .elite-v8-device-card')
  const buttons = () => Array.from(card()?.querySelectorAll('button') ?? []) as HTMLButtonElement[]
  const scanButton = () => buttons().find((button) => SCAN_ACTION.test(button.textContent?.trim() ?? ''))
  const permissionButton = () => buttons().find((button) => button.textContent?.trim() === 'Allow Bluetooth')
  const connectButtons = () => Array.from(root.querySelectorAll('ul[aria-label="Available Elite+ V8 devices"] > li button')) as HTMLButtonElement[]
  const click = (button: HTMLButtonElement | undefined) => {
    if (!button || button.disabled) return false
    button.click()
    return true
  }
  return {
    probe() {
      const status = card()?.querySelector('[role="status"]')
      return {
        mounted: Boolean(root.querySelector('.elite-v8-dashboard')),
        statusTitle: status?.querySelector('strong')?.textContent?.trim() ?? null,
        statusMessage: status?.querySelector('span')?.textContent?.trim() ?? null,
        scanActionLabel: scanButton()?.textContent?.trim() ?? null,
        permissionActionPresent: Boolean(permissionButton()),
        deviceListCount: root.querySelectorAll('ul[aria-label="Available Elite+ V8 devices"] > li').length,
        connectActionCount: connectButtons().length,
        renderedDeviceIds: Array.from(root.querySelectorAll('ul[aria-label="Available Elite+ V8 devices"] > li'))
          .map((item) => item.getAttribute('data-device-id') ?? ''),
      }
    },
    clickScanAction: () => click(scanButton()),
    clickPermissionAction: () => click(permissionButton()),
    clickConnectAction: (deviceId) => {
      const item = Array.from(root.querySelectorAll('ul[aria-label="Available Elite+ V8 devices"] > li'))
        .find((candidate) => candidate.getAttribute('data-device-id') === deviceId)
      return click(item?.querySelector<HTMLButtonElement>('button') ?? undefined)
    },
  }
}
