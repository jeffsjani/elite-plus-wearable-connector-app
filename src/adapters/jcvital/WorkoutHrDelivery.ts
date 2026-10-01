import type { NativeObservationInput } from '../../services/base44/base44Types'
import { BLUETOOTH_MAC_PATTERN, isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import type { BatchDeliveryEvent, BatchDeliveryListener, BatchDeliveryOutcome } from '../../services/sync/ObservationBatchManager'
import { sha256Hex } from './HeartRateSeries'
import type { JCVitalV8WorkoutHeartRateEvent } from './jcvitalV8Bridge'

export const JCVITAL_NATIVE_SOURCE = {
  source: 'jcvital_native',
  sourceConnector: 'JCVITAL_NATIVE',
  sourceProvider: 'JCVITAL',
  sourcePath: 'DIRECT_BLE',
  deviceModel: 'PRO_V8',
  deviceManufacturer: 'JCVital',
} as const

/** V8 type-82 workout packets carry no device timestamp; observedAt is the Connector's native BLE receipt time. */
export const WORKOUT_HR_TIMESTAMP_POLICY = {
  observedAtSource: 'CONNECTOR_BLE_RECEIPT_TIME',
  timestampSource: 'CONNECTOR_BLE_RECEIPT_TIME',
  timestampConfidence: 'RECEIPT_TIME_NO_VENDOR_TIMESTAMP',
} as const

export const WORKOUT_HR_DELIVERY_POLICY = {
  flushObservationCount: 15,
  flushIntervalMs: 15_000,
  maxDeliveryRoundsPerFlush: 10,
  maxRetainedReplayObservations: 2_000,
} as const

export const WORKOUT_HR_QUEUE_POLICY = {
  unavailableAfterConsecutiveFailures: 3,
  retryBaseMs: 5_000,
  retryMaxMs: 60_000,
  maxBufferedObservations: 1_000,
  maxErrorSamples: 5,
} as const

export type QueueHealth = 'HEALTHY' | 'DEGRADED' | 'UNAVAILABLE'

const DEFAULT_VENDOR_DATA_TYPE = '82'
const MAX_PLAUSIBLE_BPM = 250
const UNKNOWN_DEVICE_ID = 'UNKNOWN_DEVICE'

/** `deviceId` is the opaque backend-facing ID, never the BLE MAC. */
export interface WorkoutHrSourceContext {
  deviceId: string | null
  firmwareVersion: string | null
  sdkVersion: string | null
  vendorActivityMode: number | null
}

export interface WorkoutHrContextUpdate {
  bleAddress?: string | null
  firmwareVersion?: string | null
  sdkVersion?: string | null
  vendorActivityMode?: number | null
}

export function buildWorkoutHrSourceRecordId(deviceId: string, sessionId: string, packetSequence: number, observedAt: string): string {
  return `${JCVITAL_NATIVE_SOURCE.sourceConnector}:${JCVITAL_NATIVE_SOURCE.deviceModel}:${deviceId}:${sessionId}:HEART_RATE:${packetSequence}:${observedAt}`
}

export function isDeliverableWorkoutHr(event: Pick<JCVitalV8WorkoutHeartRateEvent, 'heartRate'>): boolean {
  return typeof event.heartRate === 'number' && Number.isInteger(event.heartRate) && event.heartRate > 0 && event.heartRate <= MAX_PLAUSIBLE_BPM
}

/** Client-side preflight mirroring the fields the backend must require; returns a list of problems. */
export function validateWorkoutHrObservation(observation: NativeObservationInput): string[] {
  const problems: string[] = []
  if (!/^[0-9a-f]{64}$/.test(observation.observationId)) problems.push('observationId must be a SHA-256 hex digest')
  if (observation.source !== JCVITAL_NATIVE_SOURCE.source) problems.push('source must be jcvital_native')
  if (observation.sourceConnector !== JCVITAL_NATIVE_SOURCE.sourceConnector) problems.push('sourceConnector must be JCVITAL_NATIVE')
  if (observation.sourcePath !== JCVITAL_NATIVE_SOURCE.sourcePath) problems.push('sourcePath must be DIRECT_BLE')
  if (observation.metric !== 'heartRate' || observation.metricType !== 'HEART_RATE') problems.push('metric must be heart rate')
  if (observation.unit !== 'bpm') problems.push('unit must be bpm')
  if (!isDeliverableWorkoutHr({ heartRate: observation.valueNumber })) problems.push('valueNumber must be a positive plausible bpm')
  if (!observation.sourceRecordId || !observation.sessionId || observation.packetSequence === undefined) problems.push('sourceRecordId, sessionId and packetSequence are required')
  if (!observation.observedAt || Number.isNaN(Date.parse(observation.observedAt))) problems.push('observedAt must be an ISO timestamp')
  if (observation.timestampSource !== WORKOUT_HR_TIMESTAMP_POLICY.timestampSource) problems.push('timestampSource must be CONNECTOR_BLE_RECEIPT_TIME')
  if (!observation.receivedAt || Number.isNaN(Date.parse(observation.receivedAt))) problems.push('receivedAt must be an ISO timestamp')
  if (!isOpaqueJCVitalDeviceId(observation.deviceId) && observation.deviceId !== UNKNOWN_DEVICE_ID) problems.push('deviceId must be an opaque jcvital_device_ ID')
  if (BLUETOOTH_MAC_PATTERN.test(JSON.stringify(observation))) problems.push('payload must not contain a Bluetooth MAC address')
  return problems
}

export async function buildWorkoutHrObservation(
  ownerUserId: string,
  event: JCVitalV8WorkoutHeartRateEvent,
  context: WorkoutHrSourceContext,
  timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
): Promise<NativeObservationInput | null> {
  if (!isDeliverableWorkoutHr(event)) return null
  const deviceId = isOpaqueJCVitalDeviceId(context.deviceId) ? context.deviceId : UNKNOWN_DEVICE_ID
  const observedAt = event.receivedAt
  const vendorDataType = event.vendorDataType || DEFAULT_VENDOR_DATA_TYPE
  const sourceRecordId = buildWorkoutHrSourceRecordId(deviceId, event.sessionId, event.packetSequence, observedAt)
  return {
    observationId: await sha256Hex(`${ownerUserId}:${sourceRecordId}`),
    source: JCVITAL_NATIVE_SOURCE.source,
    provider: JCVITAL_NATIVE_SOURCE.sourceProvider,
    metric: 'heartRate',
    metricType: 'HEART_RATE',
    valueNumber: event.heartRate,
    unit: 'bpm',
    startTime: observedAt,
    capturedAt: event.receivedAt,
    timezone,
    sourceRecordId,
    sourceId: deviceId,
    deviceManufacturer: JCVITAL_NATIVE_SOURCE.deviceManufacturer,
    deviceModel: JCVITAL_NATIVE_SOURCE.deviceModel,
    sourceConnector: JCVITAL_NATIVE_SOURCE.sourceConnector,
    sourceProvider: JCVITAL_NATIVE_SOURCE.sourceProvider,
    sourcePath: JCVITAL_NATIVE_SOURCE.sourcePath,
    acquisitionMode: 'WORKOUT_REALTIME',
    measurementContext: 'WORKOUT',
    sessionId: event.sessionId,
    packetSequence: event.packetSequence,
    observedAt,
    observedAtSource: WORKOUT_HR_TIMESTAMP_POLICY.observedAtSource,
    timestampSource: WORKOUT_HR_TIMESTAMP_POLICY.timestampSource,
    timestampConfidence: WORKOUT_HR_TIMESTAMP_POLICY.timestampConfidence,
    receivedAt: event.receivedAt,
    deviceId,
    firmwareVersion: context.firmwareVersion,
    sdkVersion: context.sdkVersion,
    vendorDataType,
    rawSourceMetadata: {
      vendorDataType,
      vendorTimestamp: null,
      vendorActivityMode: context.vendorActivityMode,
      bridgeEvent: 'jcvitalWorkoutHeartRate',
      contextMissing: deviceId === UNKNOWN_DEVICE_ID,
    },
  }
}

export interface WorkoutHrQueue {
  getOwnerUserId(): string | null
  enqueue(observation: NativeObservationInput): Promise<{ inserted: boolean; alreadyQueued: boolean }>
}

/** Combines store initialization with observed enqueue health. */
export function effectiveQueueHealth(queueStoreInitialized: boolean, serviceHealth: QueueHealth): QueueHealth {
  return queueStoreInitialized ? serviceHealth : 'UNAVAILABLE'
}

export function hrDeliveryTestDisabledReason(input: {
  workoutStartReason: string | null
  queueStoreInitialized: boolean
  queueHealth: QueueHealth
  connectorRegistered: boolean
}): string | null {
  if (input.workoutStartReason) return input.workoutStartReason
  if (!input.queueStoreInitialized || input.queueHealth !== 'HEALTHY') return 'delivery queue unavailable'
  if (!input.connectorRegistered) return 'Connector is not registered with Elite+'
  return null
}

/** A real-shape JCVital HR observation for the local queue self-test; it is written under an isolated owner and never uploaded. */
export function buildQueueSelfTestObservation(ownerUserId: string, context: WorkoutHrSourceContext): Promise<NativeObservationInput | null> {
  return buildWorkoutHrObservation(ownerUserId, {
    sessionId: `queue-self-test-${crypto.randomUUID()}`,
    heartRate: 60,
    receivedAt: new Date().toISOString(),
    packetSequence: 0,
    vendorDataType: '82',
    acquisitionMode: 'WORKOUT_REALTIME',
  }, context)
}


export interface WorkoutHrDeliveryDependencies {
  queue: WorkoutHrQueue
  deliver: () => Promise<unknown>
  subscribe: (listener: BatchDeliveryListener) => () => void
  /** Maps the local-only BLE address to the persistent opaque backend device ID. */
  resolveDeviceId: (bleAddress: string) => string
}

type TrackedState = 'QUEUED' | 'RETRYING' | 'DELIVERED' | 'FAILED'
type FlushReason = 'BATCH_SIZE' | 'INTERVAL' | 'WORKOUT_STOP' | 'REPLAY' | 'MANUAL'

export interface EnqueueErrorSample {
  code: string
  message: string
  count: number
  firstAt: string
  lastAt: string
}

export interface WorkoutHrDeliverySnapshot {
  enabled: boolean
  backendDeviceId: string | null
  policy: typeof WORKOUT_HR_DELIVERY_POLICY
  timestampPolicy: typeof WORKOUT_HR_TIMESTAMP_POLICY
  queueHealth: QueueHealth
  consecutiveEnqueueFailures: number
  nextEnqueueAttemptAt: string | null
  enqueueAttempts: number
  lastEnqueueErrorCode: string | null
  lastEnqueueErrorMessage: string | null
  lastEnqueueErrorAt: string | null
  enqueueErrorSamples: EnqueueErrorSample[]
  droppedFromMemory: number
  captured: number
  capturedWhileDisabled: number
  skippedNonDeliverable: number
  invalid: number
  contextMissing: number
  queued: number
  alreadyQueued: number
  awaitingEnqueue: number
  enqueueErrors: number
  queuedAwaitingDelivery: number
  retrying: number
  delivered: number
  failed: number
  /** Unique tracked observation IDs acknowledged as delivered, whether the server counted them accepted or duplicate. */
  uniqueObservationsDelivered: number
  batchesAttempted: number
  batchesDelivered: number
  batchesRetried: number
  batchesFailed: number
  serverAcceptedInBatches: number
  serverDuplicateInBatches: number
  serverRejectedInBatches: number
  replayQueued: number
  replayAlreadyQueued: number
  replayAcknowledged: number
  workoutStopFlushes: number
  lastFlushReason: FlushReason | null
  lastFlushAt: string | null
  lastDeliveryAt: string | null
  lastResult: { batchId: string; outcome: BatchDeliveryOutcome; httpStatus: number | null; errorCode: string | null; at: string } | null
  sessionIds: string[]
}

interface PendingEnqueue { event: JCVitalV8WorkoutHeartRateEvent; context: WorkoutHrSourceContext }

function describeQueueError(error: unknown): { code: string; message: string } {
  const { code, message } = (error ?? {}) as { code?: unknown; message?: unknown }
  return {
    code: typeof code === 'string' && code ? code : 'QUEUE_WRITE_FAILED',
    message: typeof message === 'string' && message ? message : String(error),
  }
}

/** Connector-side golden path: workout HR event -> durable queue -> batched Elite+ delivery. Capture never waits on HTTP. */
export class WorkoutHrDeliveryService {
  private readonly deps: WorkoutHrDeliveryDependencies
  private enabled = false
  private context: WorkoutHrSourceContext = { deviceId: null, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }
  private chain: Promise<void> = Promise.resolve()
  private flushing: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private unsubscribe: (() => void) | null = null
  private pendingEnqueue: PendingEnqueue[] = []
  private enqueueInProgress = 0
  private sinceLastFlush = 0
  private readonly tracked = new Map<string, TrackedState>()
  private readonly deliveredIds = new Set<string>()
  private replayPayloads: NativeObservationInput[] = []
  private readonly stopFlushedSessions = new Set<string>()
  private readonly sessions = new Set<string>()
  private counters = WorkoutHrDeliveryService.emptyCounters()
  private listeners = new Set<() => void>()
  private consecutiveEnqueueFailures = 0
  private nextEnqueueAttemptAt = 0
  private ownerMissing = false
  private errorSamples: EnqueueErrorSample[] = []

  constructor(deps: WorkoutHrDeliveryDependencies) { this.deps = deps }

  private static emptyCounters() {
    return {
      captured: 0, capturedWhileDisabled: 0, skippedNonDeliverable: 0, invalid: 0, contextMissing: 0,
      queued: 0, alreadyQueued: 0, enqueueErrors: 0, batchesAttempted: 0, batchesDelivered: 0, batchesRetried: 0,
      batchesFailed: 0, serverAcceptedInBatches: 0, serverDuplicateInBatches: 0, serverRejectedInBatches: 0,
      replayQueued: 0, replayAlreadyQueued: 0, replayAcknowledged: 0, workoutStopFlushes: 0,
      enqueueAttempts: 0, droppedFromMemory: 0,
      lastEnqueueErrorCode: null as string | null, lastEnqueueErrorMessage: null as string | null, lastEnqueueErrorAt: null as string | null,
      lastFlushReason: null as FlushReason | null, lastFlushAt: null as string | null, lastDeliveryAt: null as string | null,
      lastResult: null as WorkoutHrDeliverySnapshot['lastResult'],
    }
  }

  start(): void {
    if (!this.unsubscribe) this.unsubscribe = this.deps.subscribe((event) => this.handleBatch(event))
    if (!this.timer) this.timer = setInterval(() => { if (this.hasUndeliveredWork()) void this.flush('INTERVAL') }, WORKOUT_HR_DELIVERY_POLICY.flushIntervalMs)
    this.changed()
  }

  dispose(): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.listeners.clear()
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private changed(): void { this.listeners.forEach((listener) => listener()) }

  setEnabled(enabled: boolean): void { this.enabled = enabled; this.changed() }
  isEnabled(): boolean { return this.enabled }
  getContext(): WorkoutHrSourceContext { return { ...this.context } }

  setContext(update: WorkoutHrContextUpdate): void {
    this.context = {
      deviceId: update.bleAddress ? this.deps.resolveDeviceId(update.bleAddress) : this.context.deviceId,
      firmwareVersion: update.firmwareVersion ?? this.context.firmwareVersion,
      sdkVersion: update.sdkVersion ?? this.context.sdkVersion,
      vendorActivityMode: update.vendorActivityMode ?? this.context.vendorActivityMode,
    }
    this.changed()
  }

  /** Clears diagnostic counters for a new test; queued rows remain in the durable queue. */
  resetDiagnostics(): void {
    this.counters = WorkoutHrDeliveryService.emptyCounters()
    for (const [id, state] of this.tracked) if (state === 'DELIVERED' || state === 'FAILED') this.tracked.delete(id)
    this.deliveredIds.clear()
    this.replayPayloads = []
    this.sessions.clear()
    this.stopFlushedSessions.clear()
    this.errorSamples = []
    this.changed()
  }

  getQueueHealth(): QueueHealth {
    if (this.ownerMissing || this.consecutiveEnqueueFailures >= WORKOUT_HR_QUEUE_POLICY.unavailableAfterConsecutiveFailures) return 'UNAVAILABLE'
    return this.consecutiveEnqueueFailures > 0 ? 'DEGRADED' : 'HEALTHY'
  }

  private inBackoff(): boolean {
    return this.getQueueHealth() === 'UNAVAILABLE' && Date.now() < this.nextEnqueueAttemptAt
  }

  private buffer(item: PendingEnqueue): void {
    this.pendingEnqueue.push(item)
    if (this.pendingEnqueue.length > WORKOUT_HR_QUEUE_POLICY.maxBufferedObservations) {
      this.pendingEnqueue.shift()
      this.counters.droppedFromMemory++
    }
  }

  private recordEnqueueFailure(code: string, message: string): void {
    const at = new Date().toISOString()
    this.counters.enqueueErrors++
    this.counters.lastEnqueueErrorCode = code
    this.counters.lastEnqueueErrorMessage = message
    this.counters.lastEnqueueErrorAt = at
    const sample = this.errorSamples.find((entry) => entry.code === code && entry.message === message)
    if (sample) { sample.count++; sample.lastAt = at }
    else if (this.errorSamples.length < WORKOUT_HR_QUEUE_POLICY.maxErrorSamples) this.errorSamples.push({ code, message, count: 1, firstAt: at, lastAt: at })
    this.consecutiveEnqueueFailures++
    if (this.getQueueHealth() === 'UNAVAILABLE') {
      const exponent = Math.max(0, this.consecutiveEnqueueFailures - WORKOUT_HR_QUEUE_POLICY.unavailableAfterConsecutiveFailures)
      this.nextEnqueueAttemptAt = Date.now() + Math.min(WORKOUT_HR_QUEUE_POLICY.retryMaxMs, WORKOUT_HR_QUEUE_POLICY.retryBaseMs * 2 ** exponent)
    }
  }

  private recordEnqueueSuccess(): void {
    this.consecutiveEnqueueFailures = 0
    this.nextEnqueueAttemptAt = 0
    this.ownerMissing = false
  }

  handleHeartRate(event: JCVitalV8WorkoutHeartRateEvent): void {
    this.counters.captured++
    if (!this.enabled) { this.counters.capturedWhileDisabled++; this.changed(); return }
    this.sessions.add(event.sessionId)
    const context = { ...this.context }
    if (!context.deviceId) this.counters.contextMissing++
    if (this.inBackoff()) {
      if (isDeliverableWorkoutHr(event)) this.buffer({ event, context })
      else this.counters.skippedNonDeliverable++
      this.changed()
      return
    }
    this.enqueueInProgress++
    this.chain = this.chain.then(async () => { await this.enqueueOne({ event, context }) }).finally(() => { this.enqueueInProgress-- })
  }

  /** Returns false when the queue rejected the observation, which was buffered for a later attempt. */
  private async enqueueOne(item: PendingEnqueue): Promise<boolean> {
    if (!isDeliverableWorkoutHr(item.event)) { this.counters.skippedNonDeliverable++; this.changed(); return true }
    if (this.inBackoff()) { this.buffer(item); this.changed(); return false }
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) {
      this.ownerMissing = true
      this.recordEnqueueFailure('QUEUE_OWNER_MISSING', 'Queue owner is not authenticated.')
      this.buffer(item)
      this.changed()
      return false
    }
    const observation = await buildWorkoutHrObservation(owner, item.event, item.context)
    if (!observation) return true
    if (validateWorkoutHrObservation(observation).length) { this.counters.invalid++; this.changed(); return true }
    this.counters.enqueueAttempts++
    try {
      const result = await this.deps.queue.enqueue(observation)
      this.recordEnqueueSuccess()
      if (result.inserted) this.counters.queued++
      else this.counters.alreadyQueued++
      if (!this.tracked.has(observation.observationId)) this.tracked.set(observation.observationId, 'QUEUED')
      this.replayPayloads.push(observation)
      if (this.replayPayloads.length > WORKOUT_HR_DELIVERY_POLICY.maxRetainedReplayObservations) this.replayPayloads.shift()
      this.sinceLastFlush++
    } catch (error) {
      const { code, message } = describeQueueError(error)
      this.recordEnqueueFailure(code, message)
      this.buffer(item)
      this.changed()
      return false
    }
    this.changed()
    if (this.sinceLastFlush >= WORKOUT_HR_DELIVERY_POLICY.flushObservationCount) void this.flush('BATCH_SIZE')
    return true
  }

  private hasUndeliveredWork(): boolean {
    if (this.enqueueInProgress || this.pendingEnqueue.length || this.sinceLastFlush > 0) return true
    for (const state of this.tracked.values()) if (state === 'QUEUED' || state === 'RETRYING') return true
    return false
  }

  private countState(state: TrackedState): number {
    let count = 0
    for (const value of this.tracked.values()) if (value === state) count++
    return count
  }

  async flush(reason: FlushReason): Promise<void> {
    if (this.flushing) {
      await this.flushing
      if (reason === 'BATCH_SIZE' || reason === 'INTERVAL') return
      while (this.flushing) await this.flushing
    }
    this.flushing = this.runFlush(reason).finally(() => { this.flushing = null })
    await this.flushing
  }

  private async runFlush(reason: FlushReason): Promise<void> {
    await this.chain
    await this.drainBuffered()
    this.sinceLastFlush = 0
    this.counters.lastFlushReason = reason
    this.counters.lastFlushAt = new Date().toISOString()
    this.changed()
    for (let round = 0; round < WORKOUT_HR_DELIVERY_POLICY.maxDeliveryRoundsPerFlush; round++) {
      const result = await this.deps.deliver()
      if (!result || this.countState('QUEUED') === 0) break
    }
  }

  /** Probes the queue with the oldest buffered item and stops at the first failure instead of retrying every item. */
  private async drainBuffered(): Promise<void> {
    while (this.pendingEnqueue.length && !this.inBackoff()) {
      const item = this.pendingEnqueue.shift()!
      if (!(await this.enqueueOne(item))) {
        // enqueueOne re-buffered the item at the tail; restore oldest-first order.
        this.pendingEnqueue.unshift(this.pendingEnqueue.pop()!)
        return
      }
    }
  }

  async handleWorkoutEnded(sessionId: string | null): Promise<void> {
    if (!sessionId || this.stopFlushedSessions.has(sessionId)) return
    this.stopFlushedSessions.add(sessionId)
    this.counters.workoutStopFlushes++
    await this.flush('WORKOUT_STOP')
  }

  /** Re-submits retained observations with unchanged IDs to prove local and server idempotency. */
  async replay(): Promise<void> {
    for (const observation of [...this.replayPayloads]) {
      try {
        const result = await this.deps.queue.enqueue(observation)
        if (result.inserted) this.counters.replayQueued++
        else this.counters.replayAlreadyQueued++
      } catch (error) {
        const { code, message } = describeQueueError(error)
        this.recordEnqueueFailure(code, message)
        break
      }
    }
    this.changed()
    await this.flush('REPLAY')
  }

  private handleBatch(event: BatchDeliveryEvent): void {
    const ours = event.observationIds.filter((id) => this.tracked.has(id))
    if (!ours.length) return
    this.counters.batchesAttempted++
    this.counters.lastResult = { batchId: event.batchId, outcome: event.outcome, httpStatus: event.httpStatus, errorCode: event.errorCode, at: event.attemptedAt }
    if (event.outcome === 'DELIVERED' || event.outcome === 'PARTIAL') {
      this.counters.batchesDelivered++
      this.counters.lastDeliveryAt = event.attemptedAt
      this.counters.serverAcceptedInBatches += event.accepted ?? 0
      this.counters.serverDuplicateInBatches += event.duplicate ?? 0
      this.counters.serverRejectedInBatches += event.rejected ?? 0
      for (const id of event.acknowledgedIds) {
        const state = this.tracked.get(id)
        if (state === undefined) continue
        this.deliveredIds.add(id)
        if (state === 'DELIVERED') this.counters.replayAcknowledged++
        else this.tracked.set(id, 'DELIVERED')
      }
      for (const id of event.rejectedIds) if (this.tracked.has(id)) this.tracked.set(id, 'FAILED')
    } else if (event.outcome === 'RETRYING') {
      this.counters.batchesRetried++
      for (const id of ours) if (this.tracked.get(id) !== 'DELIVERED') this.tracked.set(id, 'RETRYING')
    } else {
      this.counters.batchesFailed++
      for (const id of ours) if (this.tracked.get(id) !== 'DELIVERED') this.tracked.set(id, 'FAILED')
    }
    this.changed()
  }

  getSnapshot(): WorkoutHrDeliverySnapshot {
    return {
      enabled: this.enabled,
      backendDeviceId: this.context.deviceId,
      queueHealth: this.getQueueHealth(),
      consecutiveEnqueueFailures: this.consecutiveEnqueueFailures,
      nextEnqueueAttemptAt: this.nextEnqueueAttemptAt ? new Date(this.nextEnqueueAttemptAt).toISOString() : null,
      enqueueErrorSamples: this.errorSamples.map((sample) => ({ ...sample })),
      policy: WORKOUT_HR_DELIVERY_POLICY,
      timestampPolicy: WORKOUT_HR_TIMESTAMP_POLICY,
      ...this.counters,
      awaitingEnqueue: this.pendingEnqueue.length,
      queuedAwaitingDelivery: this.countState('QUEUED'),
      retrying: this.countState('RETRYING'),
      delivered: this.countState('DELIVERED'),
      failed: this.countState('FAILED'),
      uniqueObservationsDelivered: this.deliveredIds.size,
      sessionIds: [...this.sessions],
    }
  }
}
