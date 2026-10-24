import type { QueueRecord } from '../../services/storage/ObservationQueueStore'

type CountEntry = { key: string; count: number }

function rankedCounts(values: readonly string[], limit = 20): CountEntry[] {
  const counts = new Map<string, number>()
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1)
  return [...counts]
    .map(([key, count]) => ({ key, count }))
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .slice(0, limit)
}

function validDates(values: readonly (string | undefined)[]): string[] {
  return values.filter((value): value is string => Boolean(value) && Number.isFinite(Date.parse(value!)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))
}

function metadataValue(record: QueueRecord, key: string): unknown {
  return record.payload.rawSourceMetadata?.[key]
}

function explicitTestOrDevelopmentMarker(record: QueueRecord): boolean {
  return ['certificationOnly', 'synthetic', 'testOnly', 'developmentOnly']
    .some((key) => metadataValue(record, key) === true)
}

function errorClass(record: QueueRecord): 'AUTH' | 'NETWORK' | 'SERVER' | 'OTHER' | null {
  if (!record.lastErrorCode && !record.lastErrorMessage) return null
  const text = `${record.lastErrorCode ?? ''} ${record.lastErrorMessage ?? ''}`.toLowerCase()
  if (/auth|unauthori[sz]ed|forbidden|token|http[_ -]?(401|403)|\b(401|403)\b/.test(text)) return 'AUTH'
  if (/network|timeout|timed out|offline|fetch|connection|dns|socket/.test(text)) return 'NETWORK'
  if (/server|http[_ -]?5\d\d|\b5\d\d\b/.test(text)) return 'SERVER'
  return 'OTHER'
}

function aliasesByCount(values: readonly string[]) {
  const groups = rankedCounts(values, Number.MAX_SAFE_INTEGER)
  return {
    distinctCount: groups.length,
    counts: groups.map((entry, index) => ({ label: `${index + 1}`, count: entry.count })),
  }
}

export function summarizeActivityV2QueueBacklog(records: readonly QueueRecord[]) {
  const pending = records.filter((record) => record.state === 'PENDING')
  const pendingCreated = validDates(pending.map((record) => record.createdAt))
  const pendingObserved = validDates(pending.map((record) => record.payload.observedAt ?? record.payload.startTime))
  const pendingLastAttempt = validDates(pending.map((record) => record.lastAttemptAt ?? undefined))
  const pendingNextRetry = validDates(pending.map((record) => record.nextAttemptAt ?? undefined))
  const stateCounts = {
    pending: pending.length,
    retryWait: records.filter((record) => record.state === 'RETRY_WAIT').length,
    inFlight: records.filter((record) => record.state === 'IN_FLIGHT').length,
    failedPermanent: records.filter((record) => record.state === 'FAILED_PERMANENT').length,
  }
  const byType = pending.map((record) =>
    `${record.payload.metric || record.payload.metricType || '(missing metric)'} / type ${record.payload.vendorDataType || '(missing)'}`)
  const bySource = pending.map((record) =>
    record.payload.sourceProvider || record.payload.provider || record.payload.source || '(missing)')
  const errors = { auth: 0, network: 0, server: 0, other: 0 }
  for (const record of pending) {
    const classification = errorClass(record)
    if (classification === 'AUTH') errors.auth++
    else if (classification === 'NETWORK') errors.network++
    else if (classification === 'SERVER') errors.server++
    else if (classification === 'OTHER') errors.other++
  }

  let syntheticOrCertification = 0
  let activity = 0
  let physiology = 0
  let historicalSync = 0
  let unknown = 0
  for (const record of pending) {
    const certificationMarker = metadataValue(record, 'certificationOnly') === true
      || metadataValue(record, 'synthetic') === true
    const activityMarker = ['24', '25'].includes(record.payload.vendorDataType ?? '')
      || metadataValue(record, 'activityTransportVersion') !== undefined
    const physiologyMarker = typeof record.payload.vendorField === 'string' && record.payload.vendorField.length > 0
    if (certificationMarker) syntheticOrCertification++
    else if (activityMarker) activity++
    else if (physiologyMarker) physiology++
    else unknown++
    if (record.payload.acquisitionMode === 'HISTORICAL_SYNC') historicalSync++
  }
  const knownCount = syntheticOrCertification + activity + physiology
  const classification = knownCount === 0 ? 'UNKNOWN'
    : unknown > 0 ? 'MIXED_WITH_UNKNOWN'
      : [syntheticOrCertification, activity, physiology].filter((count) => count > 0).length > 1 ? 'MIXED' : 'IDENTIFIED'

  return {
    QUEUE_TOTAL: records.length,
    QUEUE_PENDING: stateCounts.pending,
    QUEUE_RETRY_WAIT: stateCounts.retryWait,
    QUEUE_IN_FLIGHT: stateCounts.inFlight,
    QUEUE_FAILED_PERMANENT: stateCounts.failedPermanent,
    QUEUE_OTHER: records.length - stateCounts.pending - stateCounts.retryWait - stateCounts.inFlight - stateCounts.failedPermanent,
    OLDEST_PENDING_CREATED_AT: pendingCreated[0] ?? null,
    NEWEST_PENDING_CREATED_AT: pendingCreated.at(-1) ?? null,
    OLDEST_PENDING_LAST_ATTEMPT_AT: pendingLastAttempt[0] ?? null,
    NEWEST_PENDING_LAST_ATTEMPT_AT: pendingLastAttempt.at(-1) ?? null,
    PENDING_WITH_NEXT_RETRY_COUNT: pendingNextRetry.length,
    EARLIEST_PENDING_NEXT_RETRY_AT: pendingNextRetry[0] ?? null,
    PENDING_BY_OBSERVATION_TYPE: rankedCounts(byType),
    PENDING_BY_SOURCE_OR_PROVIDER: rankedCounts(bySource),
    PENDING_BY_OWNER: aliasesByCount(pending.map((record) => record.ownerUserId)),
    PENDING_BY_DEVICE: aliasesByCount(pending.map((record) => record.payload.deviceId || '(missing)')),
    QUEUE_BACKLOG_CLASSIFICATION: classification,
    QUEUE_BACKLOG_OLDEST_DATE: pendingObserved[0] ?? null,
    QUEUE_BACKLOG_NEWEST_DATE: pendingObserved.at(-1) ?? null,
    SYNTHETIC_OR_CERTIFICATION_COUNT: syntheticOrCertification,
    ACTIVITY_COUNT: activity,
    PHYSIOLOGY_COUNT: physiology,
    OTHER_COUNT: unknown,
    HISTORICAL_SYNC_COUNT: historicalSync,
    EXPLICIT_TEST_OR_DEVELOPMENT_MARKER_COUNT: pending.filter(explicitTestOrDevelopmentMarker).length,
    FAILED_TEST_OR_DEVELOPMENT_MARKER_COUNT: records
      .filter((record) => record.state === 'FAILED_PERMANENT' && explicitTestOrDevelopmentMarker(record)).length,
    PENDING_NEVER_ATTEMPTED: pending.filter((record) => record.attemptCount === 0).length,
    PENDING_PREVIOUSLY_ATTEMPTED: pending.filter((record) => record.attemptCount > 0).length,
    AUTH_RELATED_COUNT: errors.auth,
    NETWORK_ERROR_COUNT: errors.network,
    SERVER_ERROR_COUNT: errors.server,
    OTHER_ERROR_COUNT: errors.other,
  }
}
