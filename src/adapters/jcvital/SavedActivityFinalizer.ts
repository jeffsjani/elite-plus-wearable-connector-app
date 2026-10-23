import { readActivitySource, readActivitySourceEnvelope, verifyActivitySourceNotification, type ActivitySource } from './Activity24_25Certification'
import type { JCVitalV8Plugin, SourceJournalScope } from './jcvitalV8Bridge'
import { errorDetails, PhysicalAttempt, type FailureResult } from './PhysicalSemanticEvidence'
import { physicalFinalizationRead } from './PhysicalFinalizationTimeout'
import { FINALIZER_SOURCE_BATCH_SIZE, type FinalizerProgress } from './SavedActivityFinalizerDiagnostic'

const FINALIZER_BATCH_TIMEOUT_MS = 60_000
type Acquisition = Awaited<ReturnType<JCVitalV8Plugin['syncActivityCertification']>>
type ReadApi = Pick<JCVitalV8Plugin, 'readSourceEnvelope'>
type FinalizerApi = ReadApi & Pick<JCVitalV8Plugin, 'readPhysicalSemanticTestEvidence'>
type Fields = Record<string, unknown>
export const SAVED_ACTIVITY_ATTEMPT = '6beb253f-709b-4d7b-a1ce-e4d7d44a917f'
const SAVED_ACTIVITY_PARENT = '4f79f7cc-54fe-4689-939e-c8a0063dafe2'

function object(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved Activity evidence object.')
  return value as Fields
}

export function decodeSavedActivitySnapshot(value: unknown): unknown {
  if (value === null) return null
  const typed = object(value)
  if (Array.isArray(typed.values)) return typed.values.map(decodeSavedActivitySnapshot)
  if (typed.type === 'Map' && Array.isArray(typed.entries)) {
    return Object.fromEntries(typed.entries.map((raw) => {
      const entry = object(raw)
      const key = decodeSavedActivitySnapshot(entry.key)
      if (typeof key !== 'string') throw new Error('Non-string source map key; inspect original typed snapshot.')
      return [key, decodeSavedActivitySnapshot(entry.value)]
    }))
  }
  if (!Object.hasOwn(typed, 'value')) throw new Error('Invalid typed source value.')
  return typed.value
}

function numeric(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value))) return null
  const number = Number(value)
  return Number.isFinite(number) && Math.abs(number) <= Number.MAX_SAFE_INTEGER ? number : null
}

function total(values: unknown[]): number | null {
  const numbers = values.map(numeric)
  if (!numbers.length || numbers.some((value) => value === null)) return null
  const sum = numbers.reduce<number>((sum, value) => sum + value!, 0)
  return Number.isFinite(sum) && Math.abs(sum) <= Number.MAX_SAFE_INTEGER ? sum : null
}

function slots(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw
  if (typeof raw !== 'string' || !raw.trim()) return []
  return raw.trim().replace(/^\[/, '').replace(/\]$/, '').split(/[,\s]+/)
}

function decimalSum(values: unknown[]): string | null {
  const tokens = values.map((value) => typeof value === 'string' || typeof value === 'number' ? String(value) : '')
  if (!tokens.length || tokens.some((value) => !/^[+-]?\d+(?:\.\d+)?$/.test(value))) return null
  const scale = Math.max(...tokens.map((value) => value.split('.')[1]?.length ?? 0))
  const sum = tokens.reduce((sum, token) => {
    const [integer, fractional = ''] = token.replace(/^[+-]/, '').split('.')
    return sum + (token.startsWith('-') ? -1n : 1n) * BigInt(integer + fractional.padEnd(scale, '0'))
  }, 0n)
  const digits = (sum < 0n ? -sum : sum).toString().padStart(scale + 1, '0')
  const decimal = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}`.replace(/\.?0+$/, '') : digits
  return `${sum < 0n ? '-' : ''}${decimal}`
}

function decimalDifference(a: unknown, b: string | null): string | null {
  return b === null ? null : decimalSum([a, b.startsWith('-') ? b.slice(1) : `-${b}`])
}

export function reconcileSavedActivity(sources: readonly ActivitySource[]) {
  const records = sources.map((source) => {
    const fields = Object.fromEntries(Object.entries(source.fields).map(([key, value]) => [key, decodeSavedActivitySnapshot(value)]))
    const date = typeof fields.date === 'string' ? fields.date : null
    const day = date?.match(/^(\d{4})[./-](\d{2})[./-](\d{2})(?:$|[ T])/)?.slice(1).join('-') ?? null
    const stepSlots = slots(fields.arraySteps)
    return {
      envelopeId: source.sourceEnvelopeId, sourceRecordId: source.record.sourceRecordId,
      callbackId: source.record.callbackId, vendorDataType: String(source.record.vendorDataType),
      sourceDate: date, envelopeSourceDate: source.record.sourceDate, localDate: day, timezone: source.record.timezone,
      fields, stepSlots, slotCount: stepSlots.length, summedStepSlots: total(stepSlots),
    }
  })
  const dates = (type: string) => [...new Set(records.filter((r) => r.vendorDataType === type)
    .map((r) => r.localDate).filter((date): date is string => date !== null))].sort()
  const dates24 = dates('24')
  const dates25 = dates('25')
  const overlappingDays = dates24.filter((date) => dates25.includes(date))
  const days = overlappingDays.map((day) => {
    const summaries = records.filter((r) => r.localDate === day && r.vendorDataType === '24')
    const details = records.filter((r) => r.localDate === day && r.vendorDataType === '25')
      .sort((a, b) => (a.sourceDate ?? '').localeCompare(b.sourceDate ?? ''))
    const uniqueDetails = details.filter((record, index) => details.findIndex((other) =>
      other.sourceDate === record.sourceDate && JSON.stringify(other.fields) === JSON.stringify(record.fields)) === index)
    const conflictingStarts = uniqueDetails.some((record, index) =>
      uniqueDetails.some((other, otherIndex) => otherIndex !== index && other.sourceDate === record.sourceDate))
    const uniqueSummaries = summaries.filter((record, index) => summaries.findIndex((other) =>
      JSON.stringify(other.fields) === JSON.stringify(record.fields)) === index)
    const summary = uniqueSummaries.length === 1 ? uniqueSummaries[0] : null
    const aggregate = (values: unknown[]) => conflictingStarts ? null : total(values)
    const steps24 = numeric(summary?.fields.step)
    const steps25 = aggregate(uniqueDetails.map((r) => r.summedStepSlots))
    const distance25 = conflictingStarts ? null : decimalSum(uniqueDetails.map((r) => r.fields.distance))
    const calories25 = conflictingStarts ? null : decimalSum(uniqueDetails.map((r) => r.fields.calories))
    const difference = (a: number | null, b: number | null) => a === null || b === null ? null : a - b
    const stepDifference = difference(steps24, steps25)
    const counters = uniqueDetails.map((r) => numeric(r.fields.detailMinterStep))
    const comparable = counters.length > 1 && counters.every((value) => value !== null)
    const decreases = comparable ? uniqueDetails.slice(1).filter((_, i) => counters[i + 1]! < counters[i]!)
      .map((r) => r.sourceDate) : []
    const slotTotalsAgree = uniqueDetails.length > 0 && uniqueDetails.every((r) =>
      r.summedStepSlots !== null && numeric(r.fields.detailMinterStep) === r.summedStepSlots)
    const timezones = new Set([...summaries, ...details].map((r) => r.timezone))
    const ambiguous = conflictingStarts || timezones.size !== 1 || records.some((r) => r.localDate === day && !r.sourceDate)
    return {
      localDay: day, type24: summaries, type25: details,
      type24Steps: steps24, summedType25Steps: ambiguous ? null : steps25,
      absoluteStepDifference: ambiguous || stepDifference === null ? null : Math.abs(stepDifference),
      percentageStepDifference: ambiguous || stepDifference === null || steps24 === null ? null
        : steps24 === 0 ? stepDifference === 0 ? 0 : null : Math.abs(stepDifference) / Math.abs(steps24) * 100,
      type24DistanceRaw: summary?.fields.distance ?? null,
      aggregatedType25DistanceRaw: ambiguous ? null : distance25,
      distanceDifference: ambiguous ? null : decimalDifference(summary?.fields.distance, distance25),
      type24CaloriesRaw: summary?.fields.calories ?? null,
      aggregatedType25CaloriesRaw: ambiguous ? null : calories25,
      calorieDifference: ambiguous ? null : decimalDifference(summary?.fields.calories, calories25),
      coverageStart: details[0]?.sourceDate ?? null, coverageEnd: details.at(-1)?.sourceDate ?? null,
      coverageEndMeaning: 'LAST_RECORD_START_ONLY_SLOT_DURATION_UNPROVEN',
      apparentResetBoundary: decreases,
      resetInterpretation: 'DECREASE_IS_NOT_PROOF_OF_RESET_OR_CUMULATIVE_COUNTER',
      excludedExactRepeats: details.length - uniqueDetails.length,
      excludedEnvelopeIds: details.filter((r) => !uniqueDetails.includes(r)).map((r) => r.envelopeId),
      conflictingStarts, ambiguousSummary: uniqueSummaries.length !== 1,
      hypotheses: {
        componentEpochs: { slotTotalsAgree, dailyStepTotalsMatch: stepDifference === 0 && !ambiguous, proven: false },
        independentSummaries: { multipleRecords: uniqueDetails.length > 1, proven: false },
        cumulativeCounters: {
          testable: comparable, nondecreasing: comparable ? decreases.length === 0 : null,
          firstToLastDelta: comparable ? counters.at(-1)! - counters[0]! : null, proven: false,
        },
        overlappingIntervals: {
          exactRepeats: details.length - uniqueDetails.length, conflictingStarts,
          intervalDuration: 'UNPROVEN', ruledOut: false,
        },
      },
      aggregationInterpretation: 'CANDIDATE_RAW_SUMS_EXCLUDING_EXACT_REPEATS_NOT_PROVEN_NONOVERLAPPING_COMPONENT_TOTALS',
    }
  })
  const present = (type: string, name: string) => records.some((r) =>
    r.vendorDataType === type && Object.hasOwn(r.fields, name))
  return {
    datesReturnedByType24: records.filter((r) => r.vendorDataType === '24').map((r) => r.sourceDate),
    datesReturnedByType25: records.filter((r) => r.vendorDataType === '25').map((r) => r.sourceDate),
    localDatesType24: dates24, localDatesType25: dates25, overlappingDays, days,
    unparsedDateEnvelopeIds: records.filter((r) => !r.localDate).map((r) => r.envelopeId),
    records,
    fieldDispositions: {
      DAILY_STEPS: present('24', 'step') ? 'SOURCE_ONLY_VALIDATED' : 'SEMANTICS_STILL_UNPROVEN',
      DAILY_DISTANCE: 'SEMANTICS_STILL_UNPROVEN',
      DAILY_CALORIES: 'SEMANTICS_STILL_UNPROVEN',
      DETAILED_ACTIVITY: present('25', 'arraySteps') ? 'SOURCE_ONLY_VALIDATED' : 'SEMANTICS_STILL_UNPROVEN',
      EXERCISE_MINUTES: 'SEMANTICS_STILL_UNPROVEN',
    },
    units: 'NO_VENDOR_DISTANCE_CALORIE_TIME_OR_SLOT_UNITS_ASSUMED',
    readinessEligible: false, canonicalProductionEnabled: false,
  }
}

export async function rehydrateSavedActivity(saved: FailureResult, scope: SourceJournalScope, api: ReadApi,
  onProgress: (progress: FinalizerProgress) => void = () => {}, batchSize = FINALIZER_SOURCE_BATCH_SIZE) {
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('Saved source batch size must be 1–100.')
  if (saved.test_type !== 'activity' || !saved.attempt_id) throw new Error('Saved Activity attempt required.')
  const native = saved.native_evidence
  if (!native || native.attemptId !== saved.attempt_id || native.kind !== 'activity' || native.sessionClosed !== true
    || native.failureStage != null || native.errorCode != null || native.errorMessage != null || !native.commandsAllowed
    || native.digitalWellnessUnchanged !== true
    || !native.commandTypes?.includes('24') || !native.commandTypes.includes('25')
    || native.commandTypes.some((type) => type !== '24' && type !== '25')
    || native.commands.some((command) => !command.allowed)) {
    throw new Error('Successful closed native Activity session required; no reacquisition permitted.')
  }
  const raw = object(saved.diagnostics.activity)
  if (typeof raw.acquisitionSessionId !== 'string' || !raw.acquisitionSessionId || !Array.isArray(raw.results)) {
    throw new Error('Saved acquisition/session evidence missing.')
  }
  const acquisition = raw as Acquisition
  if (acquisition.results.length !== 2 || new Set(acquisition.results.map((r) => r.vendorDataType)).size !== 2
    || acquisition.results.some((r) => !['24', '25'].includes(r.vendorDataType)
      || !['COMPLETE', 'EMPTY_VALID'].includes(r.completionStatus))) throw new Error('Invalid saved acquisition terminals.')
  if (saved.attempt_id === SAVED_ACTIVITY_ATTEMPT && saved.retry_of_attempt_id !== SAVED_ACTIVITY_PARENT) {
    throw new Error('v59 retry lineage mismatch.')
  }
  if (saved.attempt_id === SAVED_ACTIVITY_ATTEMPT && native.sourceEnvelopeIds?.length !== 878) {
    throw new Error('v59 expected exactly 878 captured source envelope references.')
  }
  const refs = acquisition.results.flatMap((r) => r.sourceRecordEnvelopeIds ?? [])
  if (!refs.length || new Set(refs).size !== refs.length) throw new Error('Missing/duplicate sourceRecordEnvelopeIds.')
  const nativeRefs = new Set(native.sourceEnvelopeIds)
  if (nativeRefs.size !== native.sourceEnvelopeIds?.length) throw new Error('Missing/duplicate native source envelope references.')
  const typeRefs = Object.fromEntries(['24', '25'].map((type) => [type,
    acquisition.results.find((r) => r.vendorDataType === type)?.sourceRecordEnvelopeIds ?? []])) as Record<'24' | '25', string[]>
  const batchesTotal = Math.ceil(typeRefs['24'].length / batchSize) + Math.ceil(typeRefs['25'].length / batchSize)
  onProgress({
    stage: 'SOURCE_REFERENCES_VALIDATED', referencesTotal: refs.length, referencesLoaded: 0,
    type24Expected: typeRefs['24'].length, type25Expected: typeRefs['25'].length, batchesTotal, batchesCompleted: 0,
    pendingRead: null,
  })
  // Exact saved IDs only (indexed native lookup); never enumerates the journal, queue or diagnostic rows.
  const cache = new Map<string, ReturnType<ReadApi['readSourceEnvelope']>>()
  const journal: ReadApi = {
    readSourceEnvelope(options) {
      if (!nativeRefs.has(options.envelopeId)) throw new Error('Envelope is outside saved native attempt ancestry.')
      let pending = cache.get(options.envelopeId)
      if (!pending) {
        pending = api.readSourceEnvelope(options)
        cache.set(options.envelopeId, pending)
      }
      return pending
    },
  }
  const byId = new Map<string, ActivitySource>()
  const loaded = { '24': 0, '25': 0 }
  let batchesCompleted = 0
  onProgress({ stage: 'SOURCE_RECORDS_REHYDRATING' })
  for (const type of ['24', '25'] as const) {
    const ids = typeRefs[type]
    for (let start = 0; start < ids.length; start += batchSize) {
      const batch = ids.slice(start, start + batchSize)
      const label = `Type${type} source batch ${Math.floor(start / batchSize) + 1}/${Math.ceil(ids.length / batchSize)} `
        + `(refs ${start + 1}–${start + batch.length} of ${ids.length}; readSourceEnvelope by exact ID)`
      onProgress({ pendingRead: label })
      const sources = await physicalFinalizationRead(Promise.all(batch.map((id) => readActivitySource(journal, scope, id))),
        label, FINALIZER_BATCH_TIMEOUT_MS)
      for (const source of sources) {
        if (source.record.sessionId !== acquisition.acquisitionSessionId) throw new Error('Acquisition/session ancestry mismatch.')
        byId.set(source.sourceEnvelopeId, source)
      }
      loaded[type] += batch.length
      batchesCompleted++
      onProgress({
        type24Loaded: loaded['24'], type25Loaded: loaded['25'], referencesLoaded: loaded['24'] + loaded['25'],
        batchesCompleted, pendingRead: null,
      })
    }
    onProgress({ stage: type === '24' ? 'TYPE24_REHYDRATED' : 'TYPE25_REHYDRATED' })
  }
  if (byId.size !== refs.length) throw new Error('Saved source reference set changed during rehydration.')
  const sources: ActivitySource[] = refs.map((id) => byId.get(id)!)
  const counts = Object.fromEntries(['24', '25'].map((type) => [type, sources.filter((s) => s.record.vendorDataType === type).length]))
  const nativeCounts = object(native.diagnostics?.recordsByType)
  if (Number(nativeCounts['29'] ?? 0) > 0 || Number(nativeCounts['82'] ?? 0) > 0
    || Number(native.diagnostics?.rawType29Notifications ?? 0) > 0) {
    throw new Error('Saved Activity evidence contains prohibited Workout traffic.')
  }
  for (const type of ['24', '25']) {
    if (!counts[type] || nativeCounts[type] !== counts[type]) throw new Error(`Type${type} native/source count mismatch.`)
    const acquisitionResult = acquisition.results.find((r) => r.vendorDataType === type)!
    if (acquisitionResult.recordGroupsReceived !== counts[type] || acquisitionResult.partial) {
      throw new Error(`Type${type} saved record count/terminal mismatch.`)
    }
    if (acquisitionResult.sourceRecordEnvelopeIds?.some((id) =>
      sources.find((source) => source.sourceEnvelopeId === id)?.record.vendorDataType !== type)) {
      throw new Error(`Type${type} source reference type mismatch.`)
    }
  }
  if (saved.attempt_id === SAVED_ACTIVITY_ATTEMPT && (counts['24'] !== 16 || counts['25'] !== 640)) {
    throw new Error('v59 expected exactly 16 Type24 and 640 Type25 records.')
  }
  const callbacksByType = object(native.diagnostics?.callbacksByType)
  if (saved.attempt_id === SAVED_ACTIVITY_ATTEMPT && (callbacksByType['24'] !== 2 || callbacksByType['25'] !== 72)) {
    throw new Error('v59 expected exactly 2 Type24 and 72 Type25 callbacks.')
  }
  const callbackIds = acquisition.results.flatMap((r) => r.sourceCallbackEnvelopeIds ?? [])
  const callbackRefs = new Set(callbackIds)
  const sourcesById = new Map(sources.map((source) => [source.sourceEnvelopeId, source]))
  if (callbackRefs.size !== callbackIds.length) throw new Error('Duplicate saved callback references.')
  for (const source of sources) {
    if (!callbackRefs.has(String(source.record.callbackId))) throw new Error('Callback outside saved acquisition.')
  }
  let callbackIndex = 0
  for (const id of callbackIds) {
    callbackIndex++
    onProgress({ pendingRead: `Callback ancestry ${callbackIndex}/${callbackIds.length} (cached exact-ID read)` })
    const { json: callback } = await physicalFinalizationRead(readActivitySourceEnvelope(journal, scope, id, 'SDK_CALLBACK'),
      `Saved callback ${id}`)
    const expectedType = acquisition.results.find((r) => r.sourceCallbackEnvelopeIds?.includes(id))!.vendorDataType
    if (callback.callbackId !== id || callback.vendorDataType !== expectedType
      || callback.sessionId !== acquisition.acquisitionSessionId) throw new Error('Invalid saved callback scope/session/type.')
    if (!Array.isArray(callback.recordEnvelopeIds) || callback.recordEnvelopeIds.some((recordId, index) =>
      typeof recordId !== 'string' || sourcesById.get(recordId)?.record.callbackId !== id
      || sourcesById.get(recordId)?.record.recordIndex !== index)) {
      throw new Error('Incomplete saved callback record set.')
    }
    const callbackFields = object(decodeSavedActivitySnapshot(callback.sdkSnapshot))
    if (!Array.isArray(callbackFields.dicData) || callbackFields.dicData.length !== callback.recordEnvelopeIds.length) {
      throw new Error('Saved callback snapshot/record count mismatch.')
    }
    if (typeof callback.notificationEnvelopeId !== 'string') throw new Error('Saved callback notification ancestry missing.')
    const notification = await physicalFinalizationRead(
      readActivitySourceEnvelope(journal, scope, callback.notificationEnvelopeId, 'BLE_NOTIFICATION'),
      `Saved notification ${callback.notificationEnvelopeId}`)
    await verifyActivitySourceNotification(notification, acquisition.acquisitionSessionId)
  }
  onProgress({ pendingRead: null })
  for (const type of ['24', '25']) {
    const result = acquisition.results.find((r) => r.vendorDataType === type)!
    if (result.sourceCallbackEnvelopeIds?.length !== callbacksByType[type]) throw new Error(`Type${type} callback count mismatch.`)
  }
  onProgress({ stage: 'RECONCILIATION_BUILDING' })
  const reconciliation = reconcileSavedActivity(sources)
  return {
    originalAttemptId: saved.attempt_id, retry_of_attempt_id: saved.retry_of_attempt_id ?? null,
    originalNativeEvidence: native, originalAcquisition: acquisition,
    interpretation: 'SOURCE_ONLY_CAPTURE_COMPLETE', sourceStatus: 'SOURCE_RECORDS_PRESENT',
    sourceCounts: counts, reconciliation, fieldDispositions: reconciliation.fieldDispositions,
    sourceEnvelopeReferences: refs,
    sources: sources.map((source) => ({
      envelopeId: source.sourceEnvelopeId, envelopeSha256: source.sourceFingerprint,
      rawByteSha256: source.rawByteSha256, rawByteLength: source.rawByteLength,
    })),
    sourceEvidence: await Promise.all([...cache.values()]),
    integrity: 'CALLBACK_SNAPSHOT_EQUALITY_AND_STORED_BLE_SHA256_VERIFIED_ENVELOPE_HASHES_COMPUTED_AT_FINALIZATION',
    physicalReacquisition: false, bleCommands: 0, acquisition: 0, sourceJournalWrites: 0,
    physicalTestEnqueue: 0, physicalTestBase44Calls: 0, physicalTestAckMutations: 0,
    accountingBasis: 'READ_ONLY_FINALIZER_CAPABILITIES_ORDINARY_SENDER_DRAIN_EXCLUDED_NOT_PENDING_COUNT_DELTA',
    canonicalWrites: 0, readinessChanges: 0, digitalWellnessChanged: false,
    readinessEligible: false,
  }
}

export function savedActivityReadyForExport(result: FailureResult): boolean {
  if (result.status !== 'COMPLETE' || !result.isolation_released_at || !result.sender_resumed_at
    || !result.result || typeof result.result !== 'object') return false
  return 'interpretation' in result.result && result.result.interpretation === 'SOURCE_ONLY_CAPTURE_COMPLETE'
    && 'reconciliation' in result.result && result.result.reconciliation !== null
    && result.stages.some((entry) => entry.stage === 'RESULT_PERSISTED')
    && result.stages.some((entry) => entry.stage === 'COMPLETE')
}

export async function finalizeSavedActivity(saved: FailureResult, scope: SourceJournalScope, ops: {
  api: FinalizerApi
  assertScope(): void
  persist(result: FailureResult): Promise<void>
  cleanup(): { isolationReleasedAt: string | null; senderResumedAt: string | null; state: unknown; errors?: string[] }
  onProgress?(progress: FinalizerProgress): void
}) {
  const progress = (value: FinalizerProgress) => {
    try { ops.onProgress?.(value) } catch { /* observability must never alter finalization */ }
  }
  const result = structuredClone(saved)
  const attempt = new PhysicalAttempt(result, () => {})
  let succeeded = false
  result.retry_disposition = 'RETRY_NOT_ALLOWED'
  result.diagnostics.savedFinalization = { build: 'v61', startedAt: new Date().toISOString() }
  try {
    ops.assertScope()
    attempt.before('RESULT_CONSTRUCTION')
    progress({ pendingRead: 'readPhysicalSemanticTestEvidence(activity) — saved closed native evidence' })
    const nativeSaved = await physicalFinalizationRead(ops.api.readPhysicalSemanticTestEvidence({ ...scope, kind: 'activity' }),
      'Reading saved closed native Activity evidence')
    if (!nativeSaved.json) throw new Error('Durable native Activity evidence missing.')
    const native: FailureResult['native_evidence'] = JSON.parse(nativeSaved.json)
    progress({ stage: 'SAVED_ATTEMPT_LOADED', pendingRead: null })
    const captured = { ...saved, native_evidence: native }
    result.result = await rehydrateSavedActivity(captured, scope, ops.api, progress)
    if (native) attempt.native(native)
    ops.assertScope()
    attempt.completed('RESULT_BUILT')
    progress({ stage: 'RESULT_BUILT' })
    succeeded = true
  } catch (error) { attempt.fail(error) }
  finally {
    try {
      progress({ pendingRead: 'Releasing physical-test isolation and inspecting sender' })
      const cleanup = ops.cleanup()
      result.isolation_released_at = cleanup.isolationReleasedAt
      result.sender_resumed_at = cleanup.senderResumedAt
      result.diagnostics.savedFinalizationCleanup = cleanup.state
      if (cleanup.isolationReleasedAt) progress({ stage: 'ISOLATION_RELEASED' })
      if (cleanup.senderResumedAt) progress({ stage: 'SENDER_RESUMED' })
      progress({ pendingRead: null })
      if (cleanup.errors?.length || !cleanup.isolationReleasedAt || !cleanup.senderResumedAt) {
        const error = new Error(cleanup.errors?.join('\n') || 'Isolation release and sender resume must both be confirmed.')
        succeeded = false
        result.cleanup_errors.push(error.message)
        attempt.stage = 'CLEANUP'
        attempt.fail(error)
      }
    } catch (error) {
      succeeded = false
      result.cleanup_errors.push(errorDetails(error).message)
      attempt.stage = 'CLEANUP'
      attempt.fail(error)
    }
  }
  result.retry_disposition = 'RETRY_NOT_ALLOWED'
  if (succeeded) {
    result.failure_stage = null
    result.error_code = null
    result.error_message = null
    result.failed_at = null
    result.status = 'RUNNING'
  }
  let completeStageIndex: number | null = null
  try {
    attempt.before('RESULT_PERSISTENCE')
    progress({ pendingRead: 'Persisting saved Activity result (IndexedDB, local only)' })
    await ops.persist(result)
    if (succeeded) {
      attempt.completed('RESULT_PERSISTED')
      progress({ stage: 'RESULT_PERSISTED' })
      completeStageIndex = result.stages.length
      attempt.completed('COMPLETE')
      result.status = 'COMPLETE'
      progress({ pendingRead: 'Persisting terminal COMPLETE result (IndexedDB, local only)' })
      await ops.persist(result)
      progress({ stage: 'COMPLETE', pendingRead: null })
    }
  } catch (error) {
    if (completeStageIndex !== null) {
      result.stages.splice(completeStageIndex)
      result.last_completed_stage = result.stages.at(-1)?.stage ?? saved.last_completed_stage
    }
    result.persistence_errors.push(errorDetails(error).message)
    attempt.stage = 'RESULT_PERSISTENCE'
    attempt.fail(error)
    result.retry_disposition = 'RETRY_NOT_ALLOWED'
    // A failed terminal write must not leave a durable success-shaped checkpoint.
    try { await ops.persist(result) }
    catch (backupError) { result.persistence_errors.push(errorDetails(backupError).message) }
  }
  return result
}
