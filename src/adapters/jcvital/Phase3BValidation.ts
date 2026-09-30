import type { CompletionStatus } from '../../models/metricTaxonomy'
import type { NativeObservation, SerializableValue } from '../../models/wearableObservation'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import type { HistoricalFeedRun } from './Phase3AValidation'

export type Phase3BFeedKey = 'activity' | 'detailedActivity' | 'sleep' | 'workouts'

export interface SleepFeedRun {
  stages?: HistoricalFeedRun
  movement?: HistoricalFeedRun
}

function asRecord(value: SerializableValue): Record<string, SerializableValue> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, SerializableValue>
    : null
}

function rawRecord(observation: NativeObservation): Record<string, SerializableValue> | null {
  return asRecord(asRecord(observation.rawPayload)?.record ?? observation.rawPayload)
}

function observationSample(observation: NativeObservation) {
  const { rawPayload, ...normalized } = observation
  return { ...normalized, rawVendorPayload: rawPayload }
}

function commonResult(run?: HistoricalFeedRun) {
  if (!run) return emptyResult('UNKNOWN')
  if (!run.result) return {
    ...emptyResult(run.error ? 'FAILED' : 'UNKNOWN'),
    requestStartedAt: run.requestStartedAt,
    requestCompletedAt: run.requestCompletedAt,
    recordsRejected: run.error ? 1 : 0,
    parseErrors: run.error ? [{ message: run.error }] : [],
  }
  const result = run.result
  const records = result.observations.map(observationSample)
  return {
    status: result.completionStatus,
    completionStatus: result.completionStatus,
    requestStartedAt: result.startedAt,
    requestCompletedAt: result.completedAt,
    sourceRecordsReceived: result.recordGroupsReceived,
    normalizedObservationsProduced: result.observations.length,
    recordsAccepted: Math.max(0, result.observations.length - result.recordsRejected),
    recordsDeduplicated: result.recordsDeduplicated,
    recordsRejected: result.recordsRejected,
    earliestObservation: result.earliestObservation,
    latestObservation: result.latestObservation,
    vendorDataType: result.vendorDataType,
    acquisitionMode: result.observations[0]?.acquisitionMode ?? 'HISTORICAL_SYNC',
    parseErrors: result.parseErrors,
    firstFive: records.slice(0, 5),
    lastFive: records.slice(-5),
  }
}

function emptyResult(status: CompletionStatus) {
  return {
    status,
    completionStatus: status,
    requestStartedAt: null as string | null,
    requestCompletedAt: null as string | null,
    sourceRecordsReceived: 0,
    normalizedObservationsProduced: 0,
    recordsAccepted: 0,
    recordsDeduplicated: 0,
    recordsRejected: 0,
    earliestObservation: null as string | null,
    latestObservation: null as string | null,
    vendorDataType: null as string | null,
    acquisitionMode: null as string | null,
    parseErrors: [] as Array<Record<string, unknown>>,
    firstFive: [] as unknown[],
    lastFive: [] as unknown[],
  }
}

export function buildActivityResult(run?: HistoricalFeedRun) {
  const base = commonResult(run)
  const observations = run?.result?.observations ?? []
  return {
    ...base,
    sampleDiagnostics: {
      dayCount: new Set(observations.map((item) => item.observedAtSource).filter(Boolean)).size,
      metrics: Array.from(new Set(observations.map((item) => item.metricType))),
    },
  }
}

export function buildDetailedActivityResult(run?: HistoricalFeedRun) {
  const base = commonResult(run)
  const observations = run?.result?.observations ?? []
  const epochs = observations.filter((item) => item.metricType === 'DETAILED_ACTIVITY_EPOCH')
  return {
    ...base,
    sampleDiagnostics: {
      blockCount: run?.result?.recordGroupsReceived ?? 0,
      epochCount: epochs.length,
      epochDurationSeconds: epochs[0]?.samplingIntervalMs == null ? null : epochs[0].samplingIntervalMs / 1000,
      sourceArrayPreserved: true,
      sourceSemantics: 'ONE_MINUTE_STEPS_PER_VENDOR_ANDROID_COMMENT',
    },
  }
}

function combineStatus(results: Array<JCVitalV8HistoricalSyncResult | null | undefined>): CompletionStatus {
  const present = results.filter((result): result is JCVitalV8HistoricalSyncResult => !!result)
  if (!present.length) return 'UNKNOWN'
  if (present.some((result) => result.completionStatus === 'FAILED')) return 'FAILED'
  if (present.some((result) => result.completionStatus === 'PARTIAL') || present.length < results.length) return 'PARTIAL'
  if (present.every((result) => result.completionStatus === 'EMPTY_VALID')) return 'EMPTY_VALID'
  return 'COMPLETE'
}

function sleepEpisodes(stageResult?: JCVitalV8HistoricalSyncResult, movementResult?: JCVitalV8HistoricalSyncResult) {
  const observations = stageResult?.observations ?? []
  const movementObservations = movementResult?.observations ?? []
  return observations.filter((item) => item.metricType === 'SLEEP_EPISODE').map((episode) => {
    const epochDurationSeconds = episode.samplingIntervalMs == null ? null : episode.samplingIntervalMs / 1000
    const sourceCodes = (episode.values ?? []).filter((value): value is number => typeof value === 'number')
    const startedMs = episode.observedAt ? Date.parse(episode.observedAt) : Number.NaN
    const calculatedStageDurationSeconds = epochDurationSeconds == null ? null : epochDurationSeconds * sourceCodes.length
    const sameEpisode = (item: NativeObservation) => item.observedAt === episode.observedAt
      || item.observedAtSource === episode.observedAtSource
    const movement = movementObservations.find((item) => sameEpisode(item) && item.metricType === 'SLEEP_MOVEMENT')
    const detailStages = movementObservations.find((item) => sameEpisode(item) && item.metricType === 'SLEEP_STAGE_DETAIL_RAW')
    return {
      sleepId: episode.id,
      sleepStart: episode.observedAt,
      sleepEnd: Number.isFinite(startedMs) && calculatedStageDurationSeconds != null
        ? new Date(startedMs + calculatedStageDurationSeconds * 1000).toISOString()
        : null,
      totalSleepMinutes: calculatedStageDurationSeconds == null ? null : calculatedStageDurationSeconds / 60,
      epochDurationSeconds,
      epochCount: sourceCodes.length,
      deepEpochCount: 0,
      lightEpochCount: 0,
      remEpochCount: 0,
      awakeEpochCount: 0,
      unknownEpochCount: sourceCodes.length,
      deepMinutes: 0,
      lightMinutes: 0,
      remMinutes: 0,
      awakeMinutes: 0,
      movementSampleCount: movement?.values?.length ?? 0,
      detailedStageSampleCount: detailStages?.values?.length ?? 0,
      arraysHaveIdenticalLengths: movement && detailStages ? movement.values?.length === detailStages.values?.length : null,
      reportedSleepDurationMinutes: null,
      calculatedStageDurationMinutes: calculatedStageDurationSeconds == null ? null : calculatedStageDurationSeconds / 60,
      durationDifferenceMinutes: null,
      stageMappingStatus: 'UNDERDOCUMENTED_ALL_CODES_PRESERVED_AS_UNKNOWN',
      sourceStageCodes: sourceCodes,
      rawVendorPayload: episode.rawPayload,
    }
  })
}

export function buildSleepResult(run?: SleepFeedRun) {
  const stageResult = run?.stages?.result
  const movementResult = run?.movement?.result
  const episodes = sleepEpisodes(stageResult ?? undefined, movementResult ?? undefined)
  const results = [stageResult, movementResult]
  const parseErrors = results.flatMap((result) => result?.parseErrors ?? [])
  const starts = [run?.stages?.requestStartedAt, run?.movement?.requestStartedAt].filter((value): value is string => !!value).sort()
  const completions = [run?.stages?.requestCompletedAt, run?.movement?.requestCompletedAt].filter((value): value is string => !!value).sort()
  const allObservations = results.flatMap((result) => result?.observations ?? [])
  const samples = allObservations.map(observationSample)
  return {
    status: combineStatus(results),
    completionStatus: combineStatus(results),
    requestStartedAt: starts[0] ?? null,
    requestCompletedAt: completions.at(-1) ?? null,
    sourceRecordsReceived: results.reduce((total, result) => total + (result?.recordGroupsReceived ?? 0), 0),
    normalizedObservationsProduced: allObservations.length,
    recordsAccepted: Math.max(0, allObservations.length - parseErrors.length),
    recordsDeduplicated: results.reduce((total, result) => total + (result?.recordsDeduplicated ?? 0), 0),
    recordsRejected: parseErrors.length,
    earliestObservation: allObservations.map((item) => item.observedAt).filter((value): value is string => !!value).sort()[0] ?? null,
    latestObservation: allObservations.map((item) => item.observedAt).filter((value): value is string => !!value).sort().at(-1) ?? null,
    vendorDataType: '26 + 121',
    acquisitionMode: 'SLEEP',
    parseErrors,
    sampleDiagnostics: {
      episodeCount: episodes.length,
      epochCount: episodes.reduce((total, episode) => total + episode.epochCount, 0),
      deepEpochCount: 0,
      lightEpochCount: 0,
      remEpochCount: 0,
      awakeEpochCount: 0,
      unknownEpochCount: episodes.reduce((total, episode) => total + episode.unknownEpochCount, 0),
      movementSampleCount: episodes.reduce((total, episode) => total + episode.movementSampleCount, 0),
      episodes,
    },
    firstFive: samples.slice(0, 5),
    lastFive: samples.slice(-5),
  }
}

function workoutSessions(result?: JCVitalV8HistoricalSyncResult) {
  if (!result) return []
  const groups = new Map<string, NativeObservation[]>()
  for (const observation of result.observations) {
    const key = observation.observedAtSource ?? observation.observedAt ?? observation.id
    groups.set(key, [...(groups.get(key) ?? []), observation])
  }
  return Array.from(groups.values()).map((group) => {
    const item = (metricType: string) => group.find((observation) => observation.metricType === metricType)
    const raw = rawRecord(group[0])
    const vendorMode = raw?.sportModel == null ? null : Number(raw.sportModel)
    const mets = item('WORKOUT_METS')?.value
    return {
      sessionId: group[0].id,
      vendorActivityMode: Number.isFinite(vendorMode) ? vendorMode : null,
      canonicalActivityType: item('WORKOUT_TYPE')?.value ?? `OTHER_VENDOR_MODE_${raw?.sportModel ?? 'UNKNOWN'}`,
      startedAt: group[0].observedAt,
      endedAt: null,
      durationSeconds: null,
      durationRaw: item('WORKOUT_DURATION')?.value ?? null,
      heartRateSummary: item('WORKOUT_HR')?.value ?? null,
      steps: item('WORKOUT_STEPS')?.value ?? null,
      distanceRaw: item('WORKOUT_DISTANCE')?.value ?? null,
      caloriesRaw: item('WORKOUT_CALORIES')?.value ?? null,
      pace: item('WORKOUT_PACE')?.value ?? null,
      mets: typeof mets === 'number' ? mets : null,
      metsSupportStatus: typeof mets === 'number' ? 'EMITTED' : 'NOT_EMITTED_ANDROID',
      rawVendorPayload: group[0].rawPayload,
    }
  })
}

export function buildWorkoutResult(run?: HistoricalFeedRun) {
  const base = commonResult(run)
  const sessions = workoutSessions(run?.result ?? undefined)
  return {
    ...base,
    sampleDiagnostics: {
      sessionCount: sessions.length,
      activityTypes: sessions.map((session) => session.canonicalActivityType),
      metsSupportStatus: sessions.some((session) => session.metsSupportStatus === 'EMITTED') ? 'EMITTED' : 'NOT_EMITTED_ANDROID',
      sessions,
    },
  }
}

export function buildPhase3BFeedResults(options: {
  activity?: HistoricalFeedRun
  detailedActivity?: HistoricalFeedRun
  sleep?: SleepFeedRun
  workouts?: HistoricalFeedRun
}) {
  return {
    activity: buildActivityResult(options.activity),
    detailedActivity: buildDetailedActivityResult(options.detailedActivity),
    sleep: buildSleepResult(options.sleep),
    workouts: buildWorkoutResult(options.workouts),
  }
}

export function buildPhase3BExportResults(options: {
  activity?: HistoricalFeedRun
  detailedActivity?: HistoricalFeedRun
  sleep?: SleepFeedRun
  workouts?: HistoricalFeedRun
}) {
  const results = buildPhase3BFeedResults(options)
  const sleepEpisodes = results.sleep.sampleDiagnostics.episodes.map(({ rawVendorPayload: _rawVendorPayload, ...episode }) => episode)
  const workoutSessions = results.workouts.sampleDiagnostics.sessions.map(({ rawVendorPayload: _rawVendorPayload, ...session }) => session)
  return {
    ...results,
    sleep: {
      ...results.sleep,
      sampleDiagnostics: { ...results.sleep.sampleDiagnostics, episodes: sleepEpisodes },
    },
    workouts: {
      ...results.workouts,
      sampleDiagnostics: { ...results.workouts.sampleDiagnostics, sessions: workoutSessions },
    },
  }
}
