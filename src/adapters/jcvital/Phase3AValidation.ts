import type { CompletionStatus } from '../../models/metricTaxonomy'
import type { NativeObservation, SerializableValue } from '../../models/wearableObservation'
import type {
  JCVitalV8DeviceInfo,
  JCVitalV8HistoricalSyncResult,
  JCVitalV8MonitoringConfiguration,
} from './jcvitalV8Bridge'

export type HistoricalFeedKey = 'heartRate' | 'spo2' | 'temperature' | 'hrv' | 'ppi'
export type Phase3AFeedKey = HistoricalFeedKey | 'monitoringConfiguration'

export interface HistoricalFeedRun {
  requestStartedAt: string
  requestCompletedAt: string | null
  result: JCVitalV8HistoricalSyncResult | null
  error: string | null
}

export interface MonitoringFeedRun {
  requestStartedAt: string
  requestCompletedAt: string | null
  result: JCVitalV8MonitoringConfiguration | null
  error: string | null
}

export type Phase3AFeedRun = HistoricalFeedRun | MonitoringFeedRun

const UNKNOWN_UNIT = 'UNKNOWN_VENDOR_UNIT'
const NOT_EMITTED = 'NOT_EMITTED_BY_DEVICE'

function median(values: number[]): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

function finiteValues(observations: NativeObservation[]): number[] {
  return observations.map((observation) => observation.value).filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
}

function intervalSeconds(observations: NativeObservation[]): number[] {
  const timestamps = observations
    .map((observation) => observation.observedAt ? Date.parse(observation.observedAt) : Number.NaN)
    .filter(Number.isFinite)
    .sort((left, right) => left - right)
  return timestamps.slice(1).map((timestamp, index) => (timestamp - timestamps[index]) / 1000)
}

function intervalSummary(observations: NativeObservation[]) {
  const intervals = intervalSeconds(observations)
  return {
    medianIntervalSeconds: median(intervals),
    minimumIntervalSeconds: intervals.length ? Math.min(...intervals) : null,
    maximumIntervalSeconds: intervals.length ? Math.max(...intervals) : null,
  }
}

function asRecord(value: SerializableValue): Record<string, SerializableValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, SerializableValue>
    : null
}

function rawRecord(observation: NativeObservation): SerializableValue {
  return asRecord(observation.rawPayload)?.record ?? observation.rawPayload
}

function diagnosticObservation(observation: NativeObservation) {
  const { rawPayload, ...normalized } = observation
  return { ...normalized, rawVendorPayload: rawPayload }
}

function hrvRecords(observations: NativeObservation[]) {
  const groups = new Map<string, NativeObservation[]>()
  for (const observation of observations) {
    const key = observation.observedAtSource ?? observation.observedAt ?? observation.id
    groups.set(key, [...(groups.get(key) ?? []), observation])
  }
  return Array.from(groups.values()).map((group) => {
    const value = (metricType: string) => group.find((item) => item.metricType === metricType)?.value ?? null
    const fatigue = group.find((item) => item.metricType === 'FATIGUE_VENDOR')
    return {
      timestamp: group[0].observedAt,
      vendorHrv: value('HRV_VENDOR'),
      heartRate: value('HEART_RATE_AUTOMATIC'),
      stress: value('STRESS_VENDOR'),
      estimatedVendorBp: {
        classification: 'ESTIMATED_VENDOR_BP',
        systolic: value('BP_SYSTOLIC_ESTIMATED'),
        diastolic: value('BP_DIASTOLIC_ESTIMATED'),
      },
      fatigue: fatigue ? fatigue.value : NOT_EMITTED,
      rawVendorPayload: group[0].rawPayload,
    }
  })
}

function ppiRecords(observations: NativeObservation[]) {
  return observations.map((observation) => ({
    timestamp: observation.observedAt,
    groupSequence: observation.packetId ?? observation.sequenceNumber,
    rawPpiArray: asRecord(rawRecord(observation))?.ppiData ?? null,
    arrayLength: observation.values?.length ?? 0,
    rawValues: observation.values ?? [],
    unit: observation.unit ?? UNKNOWN_UNIT,
    rawVendorPayload: observation.rawPayload,
  }))
}

function historicalRecords(key: HistoricalFeedKey, observations: NativeObservation[]) {
  if (key === 'hrv') return hrvRecords(observations)
  if (key === 'ppi') return ppiRecords(observations)
  return observations.map(diagnosticObservation)
}

function sampleDiagnostics(key: HistoricalFeedKey, result: JCVitalV8HistoricalSyncResult) {
  const observations = result.observations
  const values = finiteValues(observations)
  const intervals = intervalSeconds(observations)
  const commonIntervals = intervalSummary(observations)

  if (key === 'heartRate') {
    const nearFiveSecondCount = intervals.filter((interval) => interval >= 4 && interval <= 6).length
    return {
      totalSampleCount: observations.length,
      earliestTimestamp: result.earliestObservation,
      latestTimestamp: result.latestObservation,
      ...commonIntervals,
      intervalsBetween4And6Seconds: nearFiveSecondCount,
      percentageBetween4And6Seconds: intervals.length ? nearFiveSecondCount / intervals.length * 100 : null,
      resampled: false,
    }
  }

  if (key === 'spo2') {
    return {
      count: observations.length,
      earliestTimestamp: result.earliestObservation,
      latestTimestamp: result.latestObservation,
      minimum: values.length ? Math.min(...values) : null,
      maximum: values.length ? Math.max(...values) : null,
      median: median(values),
      duplicateCount: result.recordsDeduplicated,
      invalidOrZeroCount: observations.filter((observation) => typeof observation.value !== 'number' || observation.value <= 0).length,
      ...commonIntervals,
    }
  }

  if (key === 'temperature') {
    return {
      count: observations.length,
      earliestTimestamp: result.earliestObservation,
      latestTimestamp: result.latestObservation,
      minimumCelsius: values.length ? Math.min(...values) : null,
      maximumCelsius: values.length ? Math.max(...values) : null,
      medianCelsius: median(values),
      measurementLabel: 'wearable_temperature_c',
      ...commonIntervals,
    }
  }

  if (key === 'ppi') {
    const ppiValues = observations.flatMap((observation) => observation.values ?? [])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value))
    return {
      groupCount: result.recordGroupsReceived,
      intervalCount: ppiValues.length,
      minimumValue: ppiValues.length ? Math.min(...ppiValues) : null,
      maximumValue: ppiValues.length ? Math.max(...ppiValues) : null,
      medianValue: median(ppiValues),
      paddingOrZeroCount: ppiValues.filter((value) => value === 0).length,
      zeroSemantics: 'PROBABLE_UNUSED_ARRAY_CAPACITY_NOT_INVALID_PHYSIOLOGY',
      invalidCount: result.recordsRejected,
      unit: observations[0]?.unit ?? UNKNOWN_UNIT,
      ...commonIntervals,
    }
  }

  return { recordCount: hrvRecords(observations).length, ...commonIntervals }
}

export function buildHistoricalFeedResult(key: HistoricalFeedKey, run?: HistoricalFeedRun) {
  if (!run) return unknownFeedResult()
  if (!run.result) return run.error ? failedFeedResult(run) : pendingFeedResult(run)
  const records = historicalRecords(key, run.result.observations)
  return {
    status: run.result.completionStatus,
    requestStartedAt: run.result.startedAt ?? run.requestStartedAt,
    requestCompletedAt: run.result.completedAt ?? run.requestCompletedAt,
    recordsReceived: run.result.recordsReceived,
    sourceRecordsReceived: run.result.recordGroupsReceived,
    normalizedObservationsProduced: run.result.observations.length,
    recordsAccepted: Math.max(0, run.result.observations.length - run.result.recordsRejected),
    recordsDeduplicated: run.result.recordsDeduplicated,
    recordsRejected: run.result.recordsRejected,
    earliestObservation: run.result.earliestObservation,
    latestObservation: run.result.latestObservation,
    completionStatus: run.result.completionStatus,
    vendorDataType: run.result.vendorDataType,
    acquisitionMode: run.result.observations[0]?.acquisitionMode ?? 'HISTORICAL_SYNC',
    sampleDiagnostics: sampleDiagnostics(key, run.result),
    parseErrors: run.result.parseErrors,
    firstFive: records.slice(0, 5),
    lastFive: records.slice(-5),
    allRecords: records,
  }
}

function monitoringRecords(configuration: JCVitalV8MonitoringConfiguration) {
  return Object.entries(configuration.configurations).map(([metric, config]) => {
    const enabledMode = config.enabledModeRaw === null ? null : Number(config.enabledModeRaw)
    return {
      metric,
      enabled: enabledMode === null || Number.isNaN(enabledMode) ? null : enabledMode !== 0,
      enabledModeRaw: config.enabledModeRaw,
      intervalMinutesRaw: config.intervalMinutesRaw,
      monitorStartTime: config.startHourRaw === null ? null : `${config.startHourRaw}:${config.startMinuteRaw ?? '00'}`,
      monitorEndTime: config.endHourRaw === null ? null : `${config.endHourRaw}:${config.endMinuteRaw ?? '00'}`,
      weekdaysRaw: config.weekdaysRaw,
      vendorDataType: config.vendorDataType,
      rawVendorPayload: config.rawPayload,
    }
  })
}

export function buildMonitoringFeedResult(run?: MonitoringFeedRun) {
  if (!run) return unknownFeedResult()
  if (!run.result) return run.error ? failedFeedResult(run) : pendingFeedResult(run)
  const records = monitoringRecords(run.result)
  return {
    status: 'COMPLETE' as CompletionStatus,
    requestStartedAt: run.requestStartedAt,
    requestCompletedAt: run.requestCompletedAt,
    recordsReceived: records.length,
    sourceRecordsReceived: records.length,
    normalizedObservationsProduced: records.length,
    recordsAccepted: records.length,
    recordsDeduplicated: 0,
    recordsRejected: 0,
    earliestObservation: null,
    latestObservation: null,
    completionStatus: 'COMPLETE' as CompletionStatus,
    vendorDataType: '16',
    acquisitionMode: run.result.acquisitionMode,
    sampleDiagnostics: null,
    parseErrors: [],
    firstFive: records.slice(0, 5),
    lastFive: records.slice(-5),
    allRecords: records,
  }
}

function unknownFeedResult() {
  return {
    status: 'UNKNOWN' as CompletionStatus,
    requestStartedAt: null,
    requestCompletedAt: null,
    recordsReceived: 0,
    sourceRecordsReceived: 0,
    normalizedObservationsProduced: 0,
    recordsAccepted: 0,
    recordsDeduplicated: 0,
    recordsRejected: 0,
    earliestObservation: null,
    latestObservation: null,
    completionStatus: 'UNKNOWN' as CompletionStatus,
    vendorDataType: null,
    acquisitionMode: null,
    sampleDiagnostics: null,
    parseErrors: [],
    firstFive: [],
    lastFive: [],
    allRecords: [],
  }
}

function failedFeedResult(run: Phase3AFeedRun) {
  return {
    ...unknownFeedResult(),
    status: 'FAILED' as CompletionStatus,
    completionStatus: 'FAILED' as CompletionStatus,
    requestStartedAt: run.requestStartedAt,
    requestCompletedAt: run.requestCompletedAt,
    recordsRejected: 1,
    parseErrors: [{ message: run.error ?? 'Unknown sync failure' }],
  }
}

function pendingFeedResult(run: Phase3AFeedRun) {
  return {
    ...unknownFeedResult(),
    requestStartedAt: run.requestStartedAt,
    requestCompletedAt: run.requestCompletedAt,
  }
}

function exportFeed<T extends { allRecords: unknown }>(feed: T): Omit<T, 'allRecords'> {
  const { allRecords: _allRecords, ...exported } = feed
  return exported
}

export function buildPhase3AValidationReport(options: {
  deviceInfo: JCVitalV8DeviceInfo | null
  historicalRuns: Partial<Record<HistoricalFeedKey, HistoricalFeedRun>>
  monitoringRun?: MonitoringFeedRun
}) {
  const feeds = {
    heartRate: buildHistoricalFeedResult('heartRate', options.historicalRuns.heartRate),
    spo2: buildHistoricalFeedResult('spo2', options.historicalRuns.spo2),
    temperature: buildHistoricalFeedResult('temperature', options.historicalRuns.temperature),
    hrv: buildHistoricalFeedResult('hrv', options.historicalRuns.hrv),
    ppi: buildHistoricalFeedResult('ppi', options.historicalRuns.ppi),
    monitoringConfiguration: buildMonitoringFeedResult(options.monitoringRun),
  }
  const starts = Object.values(feeds).map((feed) => feed.requestStartedAt).filter((value): value is string => value !== null).sort()
  const completions = Object.values(feeds).map((feed) => feed.requestCompletedAt).filter((value): value is string => value !== null).sort()
  return {
    reportType: 'JCVITAL_V8_PHASE_3A_PHYSICAL_VALIDATION',
    generatedAt: new Date().toISOString(),
    device: {
      model: 'PRO_V8',
      deviceId: options.deviceInfo?.deviceId ?? null,
      firmwareVersion: options.deviceInfo?.firmwareVersion ?? null,
      sdkVersion: options.deviceInfo?.sdkVersion ?? 'v8sdk2.0',
    },
    syncSession: {
      startedAt: starts[0] ?? null,
      completedAt: completions.at(-1) ?? null,
    },
    feedResults: {
      heartRate: exportFeed(feeds.heartRate),
      spo2: exportFeed(feeds.spo2),
      temperature: exportFeed(feeds.temperature),
      hrv: exportFeed(feeds.hrv),
      ppi: exportFeed(feeds.ppi),
      monitoringConfiguration: exportFeed(feeds.monitoringConfiguration),
    },
  }
}