import type { NativeObservation, SerializableValue } from '../../models/wearableObservation'
import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import { BLUETOOTH_MAC_PATTERN, isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import type { HistoricalFeedKey, HistoricalFeedRun } from './Phase3AValidation'
import { buildDetailedActivityResult, buildSleepResult, buildWorkoutResult, type SleepFeedRun } from './Phase3BValidation'
import { findPhysiologyContract, mapPhysiologyObservation, PHYSIOLOGY_CONTRACTS, type PhysiologySourceContext } from './PhysiologyContract'
import { buildWorkoutHrObservation, isDeliverableWorkoutHr, WORKOUT_HR_TIMESTAMP_POLICY, type WorkoutHrSourceContext } from './WorkoutHrDelivery'
import { computeWorkoutCadenceDiagnostics, type LiveWorkoutPacket, type LiveWorkoutSession } from './WorkoutTelemetry'
import type { JCVitalV8RawPpgSession } from './jcvitalV8Bridge'
import type { RawPpgChunkSummary } from './RawPpgDiagnostics'
import { certificationDeliveryState, certificationQueueDisposition, type CertificationDeliveryState, type CertificationQueueDisposition } from './CertificationDeliveryState'
import type { CertificationDeliveryResult } from './CertificationDeliveryState'
export type { CertificationDeliveryResult } from './CertificationDeliveryState'

export const CERTIFICATION_ORDER = [
  'historicalHeartRate', 'spo2', 'wearableTemperature', 'hrv', 'stress', 'estimatedBp',
  'ppi', 'activity', 'detailedActivity', 'workoutHistory', 'liveWorkoutHeartRate', 'sleep', 'ppg', 'ecg',
] as const
export type CertificationMetric = typeof CERTIFICATION_ORDER[number]
export type CertificationPolicy = 'CANONICAL' | 'NATIVE_ONLY_VENDOR_DERIVED' | 'RESEARCH_ONLY' | 'BLOCKED'

/** Bounded, payload-free evidence from real delivery events; never sends or acknowledges a row. */
export class CertificationDeliveryEvidence {
  private owner: string | null = null
  private readonly results = new Map<string, CertificationDeliveryResult>()
  private evicted = 0

  record(owner: string | null, event: BatchDeliveryEvent): void {
    if (owner !== this.owner) { this.results.clear(); this.evicted = 0; this.owner = owner }
    if (!owner) return
    const byId = new Map((event.results ?? []).map((result) => [result.observationId, result]))
    const acknowledged = new Set(event.acknowledgedIds)
    const canonicalFailed = new Set(event.canonicalFailedIds ?? [])
    for (const id of event.observationIds) {
      this.results.delete(id)
      this.results.set(id, {
        batchId: event.batchId, at: event.attemptedAt,
        outcome: canonicalFailed.has(id) ? 'CANONICAL_RECOVERY_REQUIRED' : event.outcome,
        acknowledged: acknowledged.has(id) && !canonicalFailed.has(id),
        result: byId.get(id) ?? null,
      })
      if (this.results.size > 1_000) {
        const oldest = this.results.keys().next().value
        if (oldest !== undefined) this.results.delete(oldest)
        this.evicted++
      }
    }
  }

  snapshot(owner: string | null) {
    return owner && owner === this.owner
      ? { results: new Map(this.results), evictedResultCount: this.evicted }
      : { results: new Map<string, CertificationDeliveryResult>(), evictedResultCount: 0 }
  }
}

function record(value: SerializableValue): Record<string, SerializableValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function vendorRecord(native: NativeObservation) {
  return record(native.rawPayload)?.record ?? native.rawPayload
}

function policyFor(native: NativeObservation): CertificationPolicy {
  const contract = findPhysiologyContract(native)
  return contract?.canonicalPolicy === 'CANONICAL' ? 'CANONICAL'
    : contract?.key === 'ppi' ? 'RESEARCH_ONLY'
      : contract?.vendorDerived ? 'NATIVE_ONLY_VENDOR_DERIVED' : 'RESEARCH_ONLY'
}

export interface CertificationObservation {
  sourceEnvelopeId?: string | null
  metric: string
  nativeMetricType: string | null
  value: SerializableValue
  unit: string | null
  observationId: string | null
  nativeCaptureId: string | null
  sourceRecordId: string | null
  sourceRecordGroupId: string | null
  observedAt: string | null
  observedAtSource: string | null
  receivedAt: string | null
  timestampSource: string | null
  timestampTimezoneSource: string | null
  timestampConfidence: string | null
  timezone: string | null
  provider: string | null
  sourceConnector: string | null
  recordingMethod: string | null
  acquisitionMode: string | null
  vendorDataType: string | null
  deviceOpaqueId: string | null
  sequenceNumber: number | null
  samplingIntervalMs: number | null
  context: string | null
  sessionId: string | null
  vendorDerived: boolean | null
  canonicalTarget: string | null
  intendedPolicy: CertificationPolicy
  cuffMeasured: boolean | null
  metadata: NativeObservationInput['rawSourceMetadata'] | null
  deliveryResult: CertificationDeliveryResult | null
  queueState: string | null
  deliveryState: CertificationDeliveryState
  nativeObservationId: string | null
  queueDisposition: CertificationQueueDisposition
  mappingStatus: string
}

export function mappedEvidence(input: NativeObservationInput, policy: CertificationPolicy, canonicalTarget: string | null,
  delivery: Map<string, CertificationDeliveryResult>, native?: NativeObservation): CertificationObservation {
  return {
    ...(native?.provenance.sourceEnvelopeId ? { sourceEnvelopeId: native.provenance.sourceEnvelopeId } : {}),
    metric: input.metric, nativeMetricType: native?.metricType ?? null, value: input.valueNumber, unit: input.unit ?? null,
    observationId: input.observationId, nativeCaptureId: native?.id ?? null,
    sourceRecordId: input.sourceRecordId ?? null, sourceRecordGroupId: input.sourceRecordGroupId ?? null,
    observedAt: input.observedAt ?? input.startTime, receivedAt: input.receivedAt ?? input.capturedAt,
    observedAtSource: input.observedAtSource ?? null,
    timestampSource: input.timestampSource ?? null, timestampTimezoneSource: input.timestampTimezoneSource ?? null,
    timestampConfidence: input.timestampConfidence ?? null, timezone: input.timezone,
    provider: input.provider ?? null, sourceConnector: input.sourceConnector ?? null,
    recordingMethod: input.measurementMethod ?? null, vendorDataType: input.vendorDataType ?? null,
    acquisitionMode: input.acquisitionMode ?? null,
    deviceOpaqueId: isOpaqueJCVitalDeviceId(input.deviceId) ? input.deviceId : null,
    sequenceNumber: input.sequenceNumber ?? input.packetSequence ?? null,
    samplingIntervalMs: input.samplingIntervalMs ?? null, context: input.measurementContext ?? null,
    sessionId: input.sessionId ?? null, vendorDerived: input.vendorDerived ?? null,
    canonicalTarget, intendedPolicy: policy,
    cuffMeasured: typeof input.rawSourceMetadata?.cuffMeasured === 'boolean' ? input.rawSourceMetadata.cuffMeasured : null,
    metadata: input.rawSourceMetadata ?? null, deliveryResult: delivery.get(input.observationId) ?? null,
    queueState: null,
    deliveryState: certificationDeliveryState(delivery.get(input.observationId) ?? null, null),
    nativeObservationId: delivery.get(input.observationId)?.result?.nativeObservationId ?? null,
    queueDisposition: 'NOT_READ',
    mappingStatus: 'DETERMINISTIC_MAPPING_NOT_PROOF_OF_DELIVERY',
  }
}

function captureEvidence(native: NativeObservation, deviceId: string | null, mappingStatus: string): CertificationObservation {
  return {
    metric: native.metricType, nativeMetricType: native.metricType, value: native.values ?? native.value, unit: native.unit,
    observationId: null, nativeCaptureId: native.id, sourceRecordId: native.provenance.sourceRecordId ?? null,
    sourceRecordGroupId: null, observedAt: native.observedAt, receivedAt: native.receivedAt,
    observedAtSource: native.observedAtSource,
    timestampSource: null, timestampTimezoneSource: null, timestampConfidence: null, timezone: native.timezone,
    provider: native.provenance.provider, sourceConnector: native.provenance.sourceConnector,
    recordingMethod: null, vendorDataType: native.vendorDataType,
    acquisitionMode: native.acquisitionMode,
    deviceOpaqueId: isOpaqueJCVitalDeviceId(deviceId) ? deviceId : null,
    sequenceNumber: native.sequenceNumber, samplingIntervalMs: native.samplingIntervalMs,
    context: native.measurementContext, sessionId: native.sessionId, vendorDerived: native.vendorDerived,
    canonicalTarget: findPhysiologyContract(native)?.canonicalTarget ?? null, intendedPolicy: policyFor(native),
    cuffMeasured: null, metadata: null, deliveryResult: null, mappingStatus,
    queueState: null,
    deliveryState: 'CAPTURED_NOT_DELIVERED', nativeObservationId: null,
    queueDisposition: 'NOT_READ',
  }
}

function samples<T>(items: T[]): T[] {
  return items.length <= 10 ? items : [...items.slice(0, 5), ...items.slice(-5)]
}

function captureStatus(runs: HistoricalFeedRun[]) {
  if (!runs.length) return 'NOT_CAPTURED'
  if (runs.some((run) => run.error || run.result?.completionStatus === 'FAILED')) return 'FAILED'
  if (runs.some((run) => !run.result)) return 'IN_PROGRESS'
  if (runs.every((run) => run.result?.completionStatus === 'EMPTY_VALID'
    && !run.result.observations.length && !run.result.parseErrors.length)) return 'EMPTY'
  if (runs.some((run) => run.result?.parseErrors.length)) return 'CAPTURED_WITH_PARSE_ERRORS'
  if (runs.some((run) => run.result?.completionStatus === 'PARTIAL')) return 'PARTIAL'
  return runs.some((run) => run.result?.observations.length) ? 'CAPTURED' : 'UNCONFIRMED_EMPTY'
}

function summary(observations: CertificationObservation[], runs: HistoricalFeedRun[], policy: CertificationPolicy,
  target: string | null, unit: string | null, timestampPolicy: string, vendorTypes: string[], notes: string[]) {
  const times = observations.filter((item) => item.observedAt).sort((a, b) => a.observedAt!.localeCompare(b.observedAt!))
  return {
    physicalCaptureStatus: captureStatus(runs),
    sourceRecordCount: runs.length ? runs.reduce((count, run) => count + (run.result?.recordGroupsReceived ?? 0), 0) : null,
    observationCount: observations.length,
    firstObservation: times[0] ?? observations[0] ?? null,
    lastObservation: times.at(-1) ?? observations.at(-1) ?? null,
    sampleObservations: samples(observations),
    observations,
    unit, timestampPolicy, vendorDataType: vendorTypes, deliveryPolicy: policy, canonicalTarget: target,
    parseErrorCount: runs.reduce((count, run) => count + (run.result?.parseErrors.length ?? 0) + (run.error ? 1 : 0), 0),
    notDeliverableCount: observations.filter((item) => item.mappingStatus === 'NOT_DELIVERABLE').length,
    unknownSemantics: [] as string[],
    certificationNotes: notes,
    testStart: runs.map((run) => run.requestStartedAt).sort()[0] ?? null,
    testEnd: runs.map((run) => run.requestCompletedAt).filter((time): time is string => !!time).sort().at(-1) ?? null,
    rawVendorSamples: samples(runs.flatMap((run) => run.result?.observations ?? [])).map((native) => ({
      nativeCaptureId: native.id, vendorDataType: native.vendorDataType,
      rawVendorRecord: vendorRecord(native), normalizedValue: native.values ?? native.value, unit: native.unit,
    })),
    deliveryEvidenceScope: 'Exact-ID results observed during this screen lifetime; null is UNKNOWN, not success. Counts do not imply canonical/UI consumption.',
    certificationDelivery: runs.flatMap((run) => run.certificationDelivery ? [run.certificationDelivery] : []),
  }
}

export interface CertificationOptions {
  historicalRuns: Partial<Record<HistoricalFeedKey, HistoricalFeedRun>>
  activity?: HistoricalFeedRun
  detailedActivity?: HistoricalFeedRun
  sleep?: SleepFeedRun
  workouts?: HistoricalFeedRun
  ownerUserId: string | null
  physiologyContext: PhysiologySourceContext
  workoutContext: WorkoutHrSourceContext
  workoutSession?: LiveWorkoutSession | null
  workoutPackets?: LiveWorkoutPacket[]
  workoutParseErrorCount?: number
  ppgSession?: JCVitalV8RawPpgSession | null
  ppgChunks?: RawPpgChunkSummary
  preservedQueueSamples?: QueueRecord[]
  deliveryEvidence?: ReturnType<CertificationDeliveryEvidence['snapshot']>
  readQueueRecord?: (observationId: string) => Promise<QueueRecord | null>
  persistedSpo2Samples?: CertificationObservation[]
  spo2QueueInspection?: unknown
  persistedTemperatureSamples?: CertificationObservation[]
  temperatureQueueInspection?: unknown
}

export async function buildJCVitalCertification(options: CertificationOptions) {
  const delivery = options.deliveryEvidence?.results ?? new Map<string, CertificationDeliveryResult>()
  const historical = async (key: CertificationMetric, runs: HistoricalFeedRun[], types: string[], unit: string | null,
    policy: CertificationPolicy, target: string | null, timestampPolicy: string, notes: string[]) => {
    const observations: CertificationObservation[] = []
    for (const run of runs) {
      for (const native of run.result?.observations ?? []) {
        if (types.length && !types.includes(native.metricType)) continue
        const contract = findPhysiologyContract(native)
        if (contract && options.ownerUserId && isOpaqueJCVitalDeviceId(options.physiologyContext.deviceId)) {
          const outcomes = await mapPhysiologyObservation(options.ownerUserId, native, options.physiologyContext, contract)
          for (const outcome of outcomes) {
            const item = outcome.status === 'MAPPED'
              ? mappedEvidence(outcome.observation, policy, target, delivery, native)
              : captureEvidence(native, options.physiologyContext.deviceId, outcome.status)
            const exactReport = run.certificationDelivery?.report.observations?.find((entry) => entry.observationId === item.observationId)
            if (exactReport) {
              item.deliveryResult ??= exactReport.deliveryResult
              item.queueState = exactReport.queueState
              item.queueDisposition = exactReport.queueDisposition
              item.deliveryState = certificationDeliveryState(item.deliveryResult, item.queueState, exactReport.state)
              item.nativeObservationId ??= exactReport.nativeObservationId
            }
            observations.push(item)
          }
        } else {
          observations.push(captureEvidence(native, options.physiologyContext.deviceId,
            contract ? 'MAPPING_CONTEXT_UNAVAILABLE' : 'NO_BACKEND_DELIVERY_MAPPING'))
        }
      }
    }
    const vendorTypes = [...new Set(runs.map((run) => run.result?.vendorDataType).filter((type): type is string => !!type))]
    const result = summary(observations, runs, policy, target, unit, timestampPolicy, vendorTypes, notes)
    if (types.length && !observations.length && result.physicalCaptureStatus === 'CAPTURED') result.physicalCaptureStatus = 'NOT_EMITTED'
    if (key === 'historicalHeartRate' && !observations.length) {
      const queueSamples = (options.preservedQueueSamples ?? []).filter((row) =>
        row.ownerUserId === options.ownerUserId && row.payload.vendorDataType === '27'
        && row.payload.acquisitionMode === 'HISTORICAL_SYNC')
      result.observations = samples(queueSamples).map((row) => ({
        ...mappedEvidence(row.payload, policy, target, delivery),
        mappingStatus: `PRESERVED_DURABLE_QUEUE_${row.state}`,
        queueState: row.state,
      }))
      result.sampleObservations = result.observations
      result.firstObservation = result.observations[0] ?? null
      result.lastObservation = result.observations.at(-1) ?? null
      result.certificationNotes.push('Queue sample is a bounded eligible-row read, not the corpus boundary or total. A missing sample requires an existing validation export, never HR reacquisition.')
    }
    return result
  }
  const run = (key: HistoricalFeedKey) => options.historicalRuns[key] ? [options.historicalRuns[key]!] : []
  const contractSummary = async (key: 'spo2' | 'wearableTemperature' | 'hrv' | 'stress' | 'estimatedBp' | 'ppi', source: HistoricalFeedKey) => {
    const contracts = PHYSIOLOGY_CONTRACTS.filter((contract) => contract.key === key)
    const first = contracts[0]
    const result = await historical(key, run(source), contracts.map((contract) => contract.nativeMetricType),
      first.unit, first.canonicalPolicy === 'CANONICAL' ? 'CANONICAL' : key === 'ppi' ? 'RESEARCH_ONLY' : 'NATIVE_ONLY_VENDOR_DERIVED',
      first.canonicalTarget, first.timestampSourcePolicy, ['Values and units use the unchanged Build 5B-1 mapping.'])
    result.vendorDataType = [first.vendorDataType]
    if (first.unit === 'UNKNOWN_VENDOR_UNIT') result.unknownSemantics.push('Vendor unit/scale UNKNOWN; no conversion or canonical clinical interpretation.')
    if (key === 'wearableTemperature') result.certificationNotes.push('WEARABLE_SKIN_SENSOR, not CORE_TEMPERATURE; canonical unit celsius, not Fahrenheit.')
    if (key === 'stress') result.certificationNotes.push('Not the Elite+ canonical stress score.')
    if (key === 'estimatedBp') result.certificationNotes.push('Separate systolic/diastolic rows; ESTIMATED_VENDOR_BP, cuffMeasured=false, vendorDerived=true.')
    if (key === 'ppi') result.unknownSemantics.push('Slot timing and zero meaning UNKNOWN; all slots including zeros retained. Backend policy remains NATIVE_ONLY.')
    return result
  }

  const historicalHeartRate = await historical('historicalHeartRate', run('heartRate'), ['HEART_RATE_CONTINUOUS'],
    'bpm', 'CANONICAL', 'body.heart_rate', PHYSIOLOGY_CONTRACTS[0].timestampSourcePolicy,
    ['Prior physical and backend passes are supplied by the certification workstream, not inferred from this export. Remaining gate: Base44 downstream/UI consumption.'])
  const stream = options.historicalRuns.heartRate?.streamSummary
  const historicalHrEvidence = {
    ...historicalHeartRate,
    observationCount: stream?.observationsReceived ?? options.historicalRuns.heartRate?.result?.recordsReceived ?? null,
    notDeliverableCount: options.historicalRuns.heartRate?.result?.stream?.skippedNoMeasurementCount ?? historicalHeartRate.notDeliverableCount,
    vendorDataType: ['27'],
    physicalCaptureStatus: 'PASS_PREVIOUSLY_REPORTED',
    corpusObservationCountKnown: !!options.historicalRuns.heartRate?.result || !!stream,
    evidenceOrigin: stream ? 'EXISTING_BOUNDED_STREAM' : options.historicalRuns.heartRate?.result ? 'EXISTING_CAPTURE' : 'PRESERVED_QUEUE_SAMPLE_OR_PRIOR_REPORT_REQUIRED',
    reportedGates: {
      PHYSICAL_CAPTURE: 'PASS', NORMALIZATION: 'PASS', BOUNDED_MEMORY: 'PASS', CHRONOLOGICAL_ORDER: 'PASS',
      DURABLE_QUEUE: 'PASS', BACKEND_NATIVE_DELIVERY: 'PASS', BACKEND_CANONICALIZATION: 'PASS',
      BASE44_DOWNSTREAM_UI: 'PENDING',
    },
    reportedGateSource: 'USER_PROVIDED_BUILD_5B_1_PHYSICAL_CERTIFICATION_BASELINE',
  }
  const spo2 = await contractSummary('spo2', 'spo2')
  if (!spo2.observations.length && options.persistedSpo2Samples?.length) {
    spo2.observations = options.persistedSpo2Samples.map((sample) => ({ ...sample }))
    spo2.sampleObservations = samples(spo2.observations)
    spo2.firstObservation = spo2.observations[0] ?? null
    spo2.lastObservation = spo2.observations.at(-1) ?? null
    spo2.observationCount = spo2.observations.length
    spo2.certificationNotes.push('Restored exact-ID diagnostic samples; not a new capture or proof of the full 160-record corpus.')
  }
  for (const item of spo2.observations) {
    const persisted = options.persistedSpo2Samples?.find((sample) => sample.observationId === item.observationId)
    if (!persisted) continue
    item.deliveryResult ??= persisted.deliveryResult
    item.nativeObservationId ??= persisted.nativeObservationId
    item.deliveryState = certificationDeliveryState(item.deliveryResult, item.queueState, persisted.deliveryState)
  }
  const wearableTemperature = await contractSummary('wearableTemperature', 'temperature')
  const restoredTemperature = !wearableTemperature.observations.length && !!options.persistedTemperatureSamples?.length
  if (restoredTemperature) {
    wearableTemperature.observations = (options.persistedTemperatureSamples ?? []).map((sample) => ({ ...sample }))
    wearableTemperature.sampleObservations = samples(wearableTemperature.observations)
    wearableTemperature.firstObservation = wearableTemperature.observations[0] ?? null
    wearableTemperature.lastObservation = wearableTemperature.observations.at(-1) ?? null
    wearableTemperature.observationCount = wearableTemperature.observations.length
    wearableTemperature.physicalCaptureStatus = 'CAPTURED_PREVIOUSLY_REPORTED'
    wearableTemperature.certificationNotes.push('Restored exact-ID diagnostic samples; not a new capture or proof of the full wearable-temperature corpus.')
  }
  for (const item of wearableTemperature.observations) {
    const persisted = options.persistedTemperatureSamples?.find((sample) => sample.observationId === item.observationId)
    if (!persisted) continue
    item.deliveryResult ??= persisted.deliveryResult
    item.nativeObservationId ??= persisted.nativeObservationId
    item.deliveryState = certificationDeliveryState(item.deliveryResult, item.queueState, persisted.deliveryState)
  }
  const hrv = {
    ...await contractSummary('hrv', 'hrv'),
    companionObservations: (options.historicalRuns.hrv?.result?.observations ?? [])
      .filter((native) => !findPhysiologyContract(native))
      .map((native) => captureEvidence(native, options.physiologyContext.deviceId, 'NO_BACKEND_DELIVERY_MAPPING')),
  }
  const stress = await contractSummary('stress', 'hrv')
  const estimatedBp = await contractSummary('estimatedBp', 'hrv')
  const ppi = await contractSummary('ppi', 'ppi')
  const activity = await historical('activity', options.activity ? [options.activity] : [], [], null, 'RESEARCH_ONLY', null,
    'Native device record timestamp; no new canonical timestamp interpretation.', ['Actual SDK fields only; no connector-side aggregation or new delivery mapping.'])
  const detailedActivity = {
    ...await historical('detailedActivity', options.detailedActivity ? [options.detailedActivity] : [], [], null, 'RESEARCH_ONLY', null,
      'Device block start plus existing per-epoch offset.', ['Detailed epochs are not daily summaries; no aggregation or double counting.']),
    details: buildDetailedActivityResult(options.detailedActivity),
  }
  const sleepRuns = [options.sleep?.stages, options.sleep?.movement].filter((item): item is HistoricalFeedRun => !!item)
  const sleep = {
    ...await historical('sleep', sleepRuns, [], null, 'RESEARCH_ONLY', null,
      'Device-local record time interpreted by the existing normalizer; phone timezone retained.',
      ['Physical data required. Undocumented stage codes remain UNKNOWN.']),
    details: buildSleepResult(options.sleep),
  }
  sleep.unknownSemantics.push('Undocumented vendor sleep stage codes; calculated end/duration are derived, not physically emitted fields.')
  if (sleep.physicalCaptureStatus === 'EMPTY' && sleepRuns.length === 2) {
    sleep.certificationNotes.push('PHYSICAL_DATA = EMPTY', 'Wear V8 overnight, ensure sleep monitoring is enabled, sync sleep the following morning.')
  }
  if (sleepRuns.length < 2 && sleepRuns.length > 0) sleep.physicalCaptureStatus = 'PARTIAL'
  const workoutHistory = {
    ...await historical('workoutHistory', options.workouts ? [options.workouts] : [], [], null, 'RESEARCH_ONLY', null,
      'Device-local saved workout timestamp; unconfirmed duration units remain UNKNOWN.', ['No inferred METS or clinical interpretation.']),
    details: buildWorkoutResult(options.workouts),
  }
  if (workoutHistory.physicalCaptureStatus === 'EMPTY') {
    workoutHistory.certificationNotes.push('PHYSICAL_WORKOUT_HISTORY = EMPTY', 'Record a supported workout on V8, stop/save it on the device, then rerun Sync Workouts.')
  }
  const packets = (options.workoutPackets ?? []).filter((packet) => packet.sessionId === options.workoutSession?.sessionId)
  const live: CertificationObservation[] = []
  for (const packet of packets) {
    if (packet.heartRate === null || !isDeliverableWorkoutHr({ heartRate: packet.heartRate })) continue
    if (options.ownerUserId) {
      const input = await buildWorkoutHrObservation(options.ownerUserId, {
        sessionId: packet.sessionId, heartRate: packet.heartRate, receivedAt: packet.receivedAt,
        packetSequence: packet.packetSequence, vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME',
      }, options.workoutContext)
      if (input) live.push(mappedEvidence(input, 'CANONICAL', 'body.heart_rate', delivery))
    } else {
      live.push({
        metric: 'heartRate', nativeMetricType: 'HEART_RATE_WORKOUT', value: packet.heartRate, unit: 'bpm',
        observationId: null, nativeCaptureId: null, sourceRecordId: null, sourceRecordGroupId: null,
        observedAt: packet.receivedAt, observedAtSource: WORKOUT_HR_TIMESTAMP_POLICY.observedAtSource,
        receivedAt: packet.receivedAt, timestampSource: WORKOUT_HR_TIMESTAMP_POLICY.timestampSource,
        timestampConfidence: WORKOUT_HR_TIMESTAMP_POLICY.timestampConfidence, timestampTimezoneSource: null, timezone: null,
        provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE', recordingMethod: null, acquisitionMode: 'WORKOUT_REALTIME',
        vendorDataType: '82', deviceOpaqueId: isOpaqueJCVitalDeviceId(options.workoutContext.deviceId) ? options.workoutContext.deviceId : null,
        sequenceNumber: packet.packetSequence, samplingIntervalMs: null, context: 'WORKOUT', sessionId: packet.sessionId,
        vendorDerived: null, canonicalTarget: 'body.heart_rate', intendedPolicy: 'CANONICAL',
        cuffMeasured: null, metadata: null, deliveryResult: null, queueState: null, mappingStatus: 'MAPPING_CONTEXT_UNAVAILABLE',
        deliveryState: 'CAPTURED_NOT_DELIVERED', nativeObservationId: null,
        queueDisposition: 'NOT_READ',
      })
    }
  }
  const liveWorkoutHeartRate = {
    ...summary(live, [], 'CANONICAL', 'body.heart_rate', 'bpm', WORKOUT_HR_TIMESTAMP_POLICY.timestampSource, ['82'],
      ['Collect 3-5 minutes if practical, stop, export, then STOP for review. No historical HR acquisition required.',
        'Recording context WORKOUT_REALTIME / WORKOUT; no measurementMethod is emitted by the current delivery mapping.',
        'No METS inference. Cadence is BLE receipt cadence, not an inferred sensor sampling interval.']),
    physicalCaptureStatus: packets.length ? 'CAPTURED' : 'NOT_CAPTURED',
    sourceRecordCount: packets.length,
    testStart: options.workoutSession?.startedAt ?? null,
    testEnd: options.workoutSession?.stoppedAt ?? null,
    sessionId: options.workoutSession?.sessionId ?? null,
    activityContext: options.workoutSession?.activityType ?? null,
    vendorActivityMode: options.workoutSession?.vendorActivityMode ?? null,
    cadence: options.workoutSession ? computeWorkoutCadenceDiagnostics(options.workoutSession, packets) : null,
    firstHr: packets.find((packet) => (packet.heartRate ?? 0) > 0)?.heartRate ?? null,
    lastHr: packets.filter((packet) => (packet.heartRate ?? 0) > 0).at(-1)?.heartRate ?? null,
    parseErrorCount: options.workoutParseErrorCount ?? 0,
    timestampPolicy: WORKOUT_HR_TIMESTAMP_POLICY,
    notDeliverableCount: packets.filter((packet) => packet.heartRate !== null && !isDeliverableWorkoutHr({ heartRate: packet.heartRate })).length,
  }
  const ppg = {
    ...summary([], [], 'RESEARCH_ONLY', null, 'UNKNOWN_VENDOR_UNIT', 'Connector BLE receipt time; sensor sampling semantics UNKNOWN.', ['119'],
      ['Existing physical capture may be reused; prior packet evidence is required if this screen has no retained capture.',
        'Native raw preservation only. Not glucose, BP, SpO2, ECG, or clinical cardiac metrics.']),
    physicalCaptureStatus: (options.ppgSession?.packetCount ?? options.ppgChunks?.packetCount ?? 0) > 0 ? 'CAPTURED' : 'NOT_CAPTURED',
    packetCount: options.ppgSession?.packetCount ?? options.ppgChunks?.packetCount ?? 0,
    chunkCount: options.ppgSession?.chunkCount ?? options.ppgChunks?.chunkCount ?? 0,
    byteCount: options.ppgSession?.bytesReceived ?? options.ppgChunks?.totalBytes ?? 0,
    notificationLengths: options.ppgSession?.notificationLengthsExactCounts ?? null,
    notificationLengthCounts: options.ppgSession?.notificationLengthCounts ?? options.ppgChunks?.notificationLengthCounts ?? null,
    rawFormat: options.ppgSession?.sampleFormat ?? 'UNKNOWN_VENDOR_LAYOUT',
    sampleSemantics: 'UNKNOWN',
    priorPhysicalCapture: 'OBSERVED_USER_REPORTED; exact prior artifact required if no retained packets are available.',
    firstPacketAt: options.ppgSession?.firstPacketAt ?? null,
    lastPacketAt: options.ppgSession?.lastPacketAt ?? null,
    firstChunks: options.ppgSession?.first3Chunks ?? [],
    lastChunks: options.ppgSession?.last3Chunks ?? options.ppgChunks?.lastThreeChunks ?? [],
    unknownSemantics: ['Vendor raw layout, sample units, and clinical meaning UNKNOWN.'],
    parseErrorCount: options.ppgSession?.parseErrorCount ?? 0,
    testStart: options.ppgSession?.startedAt ?? null, testEnd: options.ppgSession?.stoppedAt ?? null,
  }
  const ecg = {
    ...summary([], [], 'BLOCKED', null, null, 'UNKNOWN', [], ['Do not resume waveform development or infer clinical ECG.']),
    physicalCaptureStatus: 'BLOCKED_VENDOR_GUIDANCE',
  }
  const metrics = { historicalHeartRate: historicalHrEvidence, liveWorkoutHeartRate, spo2, wearableTemperature,
    hrv, stress, estimatedBp, ppi, activity, detailedActivity, sleep, workoutHistory, ppg, ecg }
  if (options.readQueueRecord) {
    for (const metric of Object.values(metrics)) {
      for (const item of metric.sampleObservations) {
        if (!item.observationId) continue
        const row = await options.readQueueRecord(item.observationId)
        item.queueState = null
        if (row?.ownerUserId === options.ownerUserId) {
          item.queueState = row.state
          item.nativeObservationId ??= row.nativeObservationId
          if (row.sourceEnvelopeId) item.sourceEnvelopeId ??= row.sourceEnvelopeId
        }
        item.queueDisposition = certificationQueueDisposition(item.deliveryResult, item.queueState)
        item.deliveryState = certificationDeliveryState(item.deliveryResult, item.queueState, item.deliveryState)
      }
    }
  }
  if (restoredTemperature) {
    const observations = wearableTemperature.observations
    const successful = new Set(observations.filter((item) => {
      const result = item.deliveryResult?.result
      return item.metric === 'wearableTemperature' && item.vendorDataType === '59'
        && item.observationId && result?.observationId === item.observationId
        && item.deliveryResult?.acknowledged
        && (item.deliveryState === 'DELIVERED_CANONICALIZED' || item.deliveryState === 'DELIVERED_DUPLICATE')
        && (result.status === 'accepted' || result.status === 'duplicate')
        && result.canonicalStatus === 'canonicalized'
        && (result.status !== 'accepted' || Boolean(result.nativeObservationId))
    }).map((item) => item.observationId))
    if (successful.size >= 5 && successful.size === observations.length) {
      wearableTemperature.physicalCaptureStatus = 'PASS_PREVIOUSLY_REPORTED'
    }
  }
  return {
    ...metrics,
    baseline: {
      responseContractVersion: 'native-observations-results-v1', deploymentRevision: 'nc-observations-5b1-results-2026-10-03-r4',
      batchSize: 100, productionDefaultConcurrency: 1, productionMaximumConcurrency: 1,
      asynchronousCanonicalization: false, deviceFit: 'NOT_DECLARED', downstreamUiVerification: 'PENDING',
    },
    testOrder: CERTIFICATION_ORDER,
    stopAfterEachTest: 'Export JSON and STOP for review before any semantic changes or the next focused test.',
    evictedDeliveryResultCount: options.deliveryEvidence?.evictedResultCount ?? 0,
    spo2QueueInspection: options.spo2QueueInspection ?? [],
    temperatureQueueInspection: options.temperatureQueueInspection ?? [],
    handoff: CERTIFICATION_ORDER.map((key) => ({
      METRIC: key, TEST_START: metrics[key].testStart, TEST_END: metrics[key].testEnd,
      OBSERVATION_WINDOW_START: metrics[key].firstObservation?.observedAt ?? null,
      OBSERVATION_WINDOW_END: metrics[key].lastObservation?.observedAt ?? null,
      samples: metrics[key].sampleObservations.map((item) => ({
        OBSERVATION_ID: item.observationId, SOURCE_RECORD_ID: item.sourceRecordId, SOURCE_RECORD_GROUP_ID: item.sourceRecordGroupId,
        VALUE: item.value, UNIT: item.unit, OBSERVED_AT: item.observedAt, TIMESTAMP_SOURCE: item.timestampSource,
        VENDOR_TYPE: item.vendorDataType, CANONICAL_TARGET: item.canonicalTarget, DELIVERY_POLICY: item.intendedPolicy,
        ...(item.sourceEnvelopeId ? { SOURCE_ENVELOPE_ID: item.sourceEnvelopeId } : {}),
        DELIVERY_RESULT: item.deliveryResult,
        QUEUE_STATE: item.queueState,
        DELIVERY_STATE: item.deliveryState,
        NATIVE_OBSERVATION_ID: item.nativeObservationId,
        QUEUE_DISPOSITION: item.queueDisposition,
      })),
    })),
  }
}

/** Redacts local BLE identifiers and credentials throughout legacy and new diagnostic exports. */
export function sanitizeCertificationExport(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(new RegExp(BLUETOOTH_MAC_PATTERN.source, 'g'), '[REDACTED_MAC]')
  if (Array.isArray(value)) return value.map(sanitizeCertificationExport)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key, /^(macAddress|bleAddress|authorization|password|.*token|.*secret|apiKey|ownerUserId)$/i.test(key)
        ? '[REDACTED]' : sanitizeCertificationExport(item),
    ]))
  }
  return value
}
