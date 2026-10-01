import type {
  JCVitalV8RawPpgChunk,
  JCVitalV8RawPpgErrorEvent,
  JCVitalV8RawPpgLayoutSummary,
  JCVitalV8RawPpgSession,
} from './jcvitalV8Bridge'

export interface RawPpgChunkSummary {
  chunkCount: number
  packetCount: number
  totalBytes: number
  vendorDataType119Count: number
  notificationLengthCounts: Record<'153' | '203' | 'other', number>
  decoded153Summary: JCVitalV8RawPpgLayoutSummary
  decoded203Summary: JCVitalV8RawPpgLayoutSummary
  lastThreeChunks: JCVitalV8RawPpgChunk[]
}

export const EMPTY_RAW_PPG_CHUNK_SUMMARY: RawPpgChunkSummary = {
  chunkCount: 0,
  packetCount: 0,
  totalBytes: 0,
  vendorDataType119Count: 0,
  notificationLengthCounts: { '153': 0, '203': 0, other: 0 },
  decoded153Summary: emptyLayoutSummary(),
  decoded203Summary: emptyLayoutSummary(),
  lastThreeChunks: [],
}

export const RAW_PPG_UI_UPDATE_INTERVAL_MS = 750
const MAX_EXPORTED_PARSE_ERRORS = 50

export interface RawPpgUiUpdate {
  status: JCVitalV8RawPpgSession | null
  chunk: JCVitalV8RawPpgChunk | null
  error: JCVitalV8RawPpgErrorEvent | null
  chunkEventsReceivedByJs: number
  uiUpdateCount: number
  lastEventPayloadBytes: number
  maxEventPayloadBytes: number
}

function emptyLayoutSummary(): JCVitalV8RawPpgLayoutSummary {
  return { packetCount: 0, decodedSampleCount: 0, minimumRawDecodedValue: null, maximumRawDecodedValue: null }
}

function safeCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

function normalizeLayoutSummary(value: unknown): JCVitalV8RawPpgLayoutSummary {
  if (!value || typeof value !== 'object') return emptyLayoutSummary()
  const layout = value as Partial<JCVitalV8RawPpgLayoutSummary>
  return {
    packetCount: safeCount(layout.packetCount),
    decodedSampleCount: safeCount(layout.decodedSampleCount),
    minimumRawDecodedValue: typeof layout.minimumRawDecodedValue === 'number' && Number.isFinite(layout.minimumRawDecodedValue) ? layout.minimumRawDecodedValue : null,
    maximumRawDecodedValue: typeof layout.maximumRawDecodedValue === 'number' && Number.isFinite(layout.maximumRawDecodedValue) ? layout.maximumRawDecodedValue : null,
  }
}

function normalizeChunk(chunk: JCVitalV8RawPpgChunk): JCVitalV8RawPpgChunk {
  const lengthCounts = chunk.notificationLengthCounts && typeof chunk.notificationLengthCounts === 'object'
    ? chunk.notificationLengthCounts
    : { '153': 0, '203': 0, other: 0 }
  return {
    sessionId: typeof chunk.sessionId === 'string' ? chunk.sessionId : '',
    sequenceStart: safeCount(chunk.sequenceStart),
    sequenceEnd: Math.max(safeCount(chunk.sequenceStart), safeCount(chunk.sequenceEnd)),
    packetCount: safeCount(chunk.packetCount),
    chunkCount: safeCount(chunk.chunkCount),
    wireBytes: safeCount(chunk.wireBytes),
    firstReceivedAt: typeof chunk.firstReceivedAt === 'string' ? chunk.firstReceivedAt : '',
    lastReceivedAt: typeof chunk.lastReceivedAt === 'string' ? chunk.lastReceivedAt : '',
    notificationLengthCounts: {
      '153': safeCount(lengthCounts['153']),
      '203': safeCount(lengthCounts['203']),
      other: safeCount(lengthCounts.other),
    },
    vendorType119Count: safeCount(chunk.vendorType119Count),
    decoded153Summary: normalizeLayoutSummary(chunk.decoded153Summary),
    decoded203Summary: normalizeLayoutSummary(chunk.decoded203Summary),
    parseErrorCount: safeCount(chunk.parseErrorCount),
  }
}

function combineLayoutSummaries(
  first: JCVitalV8RawPpgLayoutSummary | null | undefined,
  second: JCVitalV8RawPpgLayoutSummary | null | undefined,
): JCVitalV8RawPpgLayoutSummary {
  const left = first ?? emptyLayoutSummary()
  const right = second ?? emptyLayoutSummary()
  return {
    packetCount: left.packetCount + right.packetCount,
    decodedSampleCount: left.decodedSampleCount + right.decodedSampleCount,
    minimumRawDecodedValue: left.minimumRawDecodedValue == null ? right.minimumRawDecodedValue
      : right.minimumRawDecodedValue == null ? left.minimumRawDecodedValue
        : Math.min(left.minimumRawDecodedValue, right.minimumRawDecodedValue),
    maximumRawDecodedValue: left.maximumRawDecodedValue == null ? right.maximumRawDecodedValue
      : right.maximumRawDecodedValue == null ? left.maximumRawDecodedValue
        : Math.max(left.maximumRawDecodedValue, right.maximumRawDecodedValue),
  }
}

function mergeChunkSummaries(first: JCVitalV8RawPpgChunk | null, next: JCVitalV8RawPpgChunk): JCVitalV8RawPpgChunk {
  const normalizedNext = normalizeChunk(next)
  if (!first) return normalizedNext
  const normalizedFirst = normalizeChunk(first)
  const lengths = normalizedFirst.notificationLengthCounts
  const nextLengths = normalizedNext.notificationLengthCounts
  return {
    ...normalizedNext,
    sequenceStart: Math.min(normalizedFirst.sequenceStart, normalizedNext.sequenceStart),
    sequenceEnd: Math.max(normalizedFirst.sequenceEnd, normalizedNext.sequenceEnd),
    packetCount: normalizedFirst.packetCount + normalizedNext.packetCount,
    chunkCount: (normalizedFirst.chunkCount || normalizedFirst.sequenceEnd - normalizedFirst.sequenceStart + 1) + (normalizedNext.chunkCount || normalizedNext.sequenceEnd - normalizedNext.sequenceStart + 1),
    wireBytes: normalizedFirst.wireBytes + normalizedNext.wireBytes,
    firstReceivedAt: normalizedFirst.firstReceivedAt,
    notificationLengthCounts: {
      '153': lengths['153'] + nextLengths['153'],
      '203': lengths['203'] + nextLengths['203'],
      other: lengths.other + nextLengths.other,
    },
    vendorType119Count: normalizedFirst.vendorType119Count + normalizedNext.vendorType119Count,
    decoded153Summary: combineLayoutSummaries(normalizedFirst.decoded153Summary, normalizedNext.decoded153Summary),
    decoded203Summary: combineLayoutSummaries(normalizedFirst.decoded203Summary, normalizedNext.decoded203Summary),
    parseErrorCount: normalizedFirst.parseErrorCount + normalizedNext.parseErrorCount,
  }
}

export function createRawPpgUiCoalescer(
  onUpdate: (update: RawPpgUiUpdate) => void,
  intervalMs = RAW_PPG_UI_UPDATE_INTERVAL_MS,
): {
  pushStatus: (status: JCVitalV8RawPpgSession, payloadBytes: number) => void
  pushChunk: (chunk: JCVitalV8RawPpgChunk, payloadBytes: number) => void
  pushError: (error: JCVitalV8RawPpgErrorEvent, payloadBytes: number) => void
  cancel: () => void
} {
  let status: JCVitalV8RawPpgSession | null = null
  let chunk: JCVitalV8RawPpgChunk | null = null
  let error: JCVitalV8RawPpgErrorEvent | null = null
  let chunkEventsReceivedByJs = 0
  let uiUpdateCount = 0
  let lastEventPayloadBytes = 0
  let maxEventPayloadBytes = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    timer = null
    uiUpdateCount += 1
    onUpdate({ status, chunk, error, chunkEventsReceivedByJs, uiUpdateCount, lastEventPayloadBytes, maxEventPayloadBytes })
    status = null
    chunk = null
    error = null
    chunkEventsReceivedByJs = 0
    lastEventPayloadBytes = 0
    maxEventPayloadBytes = 0
  }
  const queue = (payloadBytes: number) => {
    lastEventPayloadBytes = payloadBytes
    maxEventPayloadBytes = Math.max(maxEventPayloadBytes, payloadBytes)
    if (timer === null) timer = setTimeout(flush, intervalMs)
  }

  return {
    pushStatus(next, payloadBytes) {
      status = next
      queue(payloadBytes)
    },
    pushChunk(next, payloadBytes) {
      chunk = mergeChunkSummaries(chunk, next)
      chunkEventsReceivedByJs += 1
      queue(payloadBytes)
    },
    pushError(next, payloadBytes) {
      error = next
      queue(payloadBytes)
    },
    cancel() {
      if (timer !== null) clearTimeout(timer)
      timer = null
    },
  }
}

export function includeRawPpgChunk(summary: RawPpgChunkSummary, chunk: JCVitalV8RawPpgChunk): RawPpgChunkSummary {
  const normalizedChunk = normalizeChunk(chunk)
  const lastSequence = summary.lastThreeChunks.at(-1)?.sequenceEnd ?? -1
  if (normalizedChunk.sequenceEnd <= lastSequence) return summary
  const packetCount = summary.packetCount + normalizedChunk.packetCount
  return {
    chunkCount: summary.chunkCount + (normalizedChunk.chunkCount || normalizedChunk.sequenceEnd - normalizedChunk.sequenceStart + 1),
    packetCount,
    totalBytes: summary.totalBytes + normalizedChunk.wireBytes,
    vendorDataType119Count: summary.vendorDataType119Count + normalizedChunk.vendorType119Count,
    notificationLengthCounts: {
      '153': summary.notificationLengthCounts['153'] + normalizedChunk.notificationLengthCounts['153'],
      '203': summary.notificationLengthCounts['203'] + normalizedChunk.notificationLengthCounts['203'],
      other: summary.notificationLengthCounts.other + normalizedChunk.notificationLengthCounts.other,
    },
    decoded153Summary: combineLayoutSummaries(summary.decoded153Summary, normalizedChunk.decoded153Summary),
    decoded203Summary: combineLayoutSummaries(summary.decoded203Summary, normalizedChunk.decoded203Summary),
    lastThreeChunks: [...summary.lastThreeChunks, normalizedChunk].slice(-3),
  }
}

function boundedChunkSummaries(value: unknown, keep: 'first' | 'last'): JCVitalV8RawPpgChunk[] {
  if (!Array.isArray(value)) return []
  const items = keep === 'first' ? value.slice(0, 3) : value.slice(-3)
  return items.filter((item) => item && typeof item === 'object').map((item) => normalizeChunk(item as JCVitalV8RawPpgChunk))
}

/** Applies a native PPG session update while keeping bounded chunk summaries from an earlier payload of the same session. */
export function mergeRawPpgSession(
  current: JCVitalV8RawPpgSession | null,
  next: JCVitalV8RawPpgSession,
): JCVitalV8RawPpgSession {
  const sameSession = current != null && current.sessionId === next.sessionId
  const first3Chunks = Array.isArray(next.first3Chunks) ? boundedChunkSummaries(next.first3Chunks, 'first')
    : sameSession ? current.first3Chunks : undefined
  const last3Chunks = Array.isArray(next.last3Chunks) ? boundedChunkSummaries(next.last3Chunks, 'last')
    : sameSession ? current.last3Chunks : undefined
  return { ...next, first3Chunks, last3Chunks }
}

export function buildRawPpgValidation(
  session: JCVitalV8RawPpgSession | null,
  chunks: RawPpgChunkSummary,
  parseErrors: Array<Record<string, unknown>>,
  uiDiagnostics?: Partial<RawPpgUiUpdate>,
  renderErrors: Array<Record<string, unknown>> = [],
): Record<string, unknown> {
  const errors = Array.isArray(session?.parseErrors) ? session.parseErrors : []
  const suppliedErrors = Array.isArray(parseErrors) ? parseErrors : []
  const distinctErrors = [...errors, ...suppliedErrors.filter((error) => !errors.includes(error))].slice(-MAX_EXPORTED_PARSE_ERRORS)
  return {
    session,
    packetCount: session?.packetCount ?? chunks.packetCount ?? 0,
    chunkCount: session?.chunkCount ?? chunks.chunkCount ?? 0,
    bytesReceived: session?.bytesReceived ?? chunks.totalBytes ?? 0,
    notificationLengthCounts: session?.notificationLengthCounts ?? chunks.notificationLengthCounts,
    notificationLengthsExactCounts: session?.notificationLengthsExactCounts ?? {},
    vendorDataType119Count: session?.vendorDataType119Count ?? chunks.vendorDataType119Count ?? 0,
    first3Chunks: boundedChunkSummaries(session?.first3Chunks, 'first'),
    last3Chunks: boundedChunkSummaries(session?.last3Chunks, 'last'),
    decodedFieldNames: Array.isArray(session?.decodedFieldNames) ? session.decodedFieldNames.slice(0, 32) : [],
    rawSampleDiagnostics: session?.rawSampleDiagnostics ?? {},
    vendorDerivedFields: Array.isArray(session?.vendorDerivedFields) ? session.vendorDerivedFields.slice(0, 16) : [],
    parseErrors: distinctErrors,
    ppgNativePacketCount: session?.ppgNativePacketCount ?? session?.packetCount ?? 0,
    ppgNativeChunkCount: session?.ppgNativeChunkCount ?? session?.chunkCount ?? 0,
    ppgChunkEventsSentToJs: session?.ppgChunkEventsSentToJs ?? 0,
    ppgChunkEventsReceivedByJs: uiDiagnostics?.chunkEventsReceivedByJs ?? 0,
    ppgUiUpdateCount: uiDiagnostics?.uiUpdateCount ?? 0,
    ppgLastEventPayloadBytes: Math.max(session?.ppgLastEventPayloadBytes ?? 0, uiDiagnostics?.lastEventPayloadBytes ?? 0),
    ppgMaxEventPayloadBytes: Math.max(session?.ppgMaxEventPayloadBytes ?? 0, uiDiagnostics?.maxEventPayloadBytes ?? 0),
    ppgUiSummaryEventDropped: session?.ppgUiSummaryEventDropped ?? 0,
    renderErrors: renderErrors.slice(-10),
  }
}