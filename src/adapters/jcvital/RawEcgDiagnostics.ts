import type { JCVitalV8RawEcgChunk, JCVitalV8RawEcgSession } from './jcvitalV8Bridge'

export interface RawEcgChunkSummary {
  chunkCount: number
  totalBytes: number
  minRawSample: number | null
  maxRawSample: number | null
  firstThreeChunks: JCVitalV8RawEcgChunk[]
  lastThreeChunks: JCVitalV8RawEcgChunk[]
  seenSequences: number[]
}

export const EMPTY_RAW_ECG_CHUNK_SUMMARY: RawEcgChunkSummary = {
  chunkCount: 0,
  totalBytes: 0,
  minRawSample: null,
  maxRawSample: null,
  firstThreeChunks: [],
  lastThreeChunks: [],
  seenSequences: [],
}

export function includeRawEcgChunk(
  summary: RawEcgChunkSummary,
  chunk: JCVitalV8RawEcgChunk,
): RawEcgChunkSummary {
  if (summary.seenSequences.includes(chunk.sequenceNumber)) return summary
  const ordered = [...summary.firstThreeChunks, ...summary.lastThreeChunks, chunk]
    .filter((item, index, all) => all.findIndex((candidate) => candidate.sequenceNumber === item.sequenceNumber) === index)
    .sort((left, right) => left.sequenceNumber - right.sequenceNumber)
  const samples = chunk.samples
  return {
    chunkCount: summary.chunkCount + 1,
    totalBytes: summary.totalBytes + chunk.estimatedBytes,
    minRawSample: samples.length ? Math.min(summary.minRawSample ?? Number.POSITIVE_INFINITY, ...samples) : summary.minRawSample,
    maxRawSample: samples.length ? Math.max(summary.maxRawSample ?? Number.NEGATIVE_INFINITY, ...samples) : summary.maxRawSample,
    firstThreeChunks: ordered.slice(0, 3),
    lastThreeChunks: ordered.slice(-3),
    seenSequences: [...summary.seenSequences, chunk.sequenceNumber].slice(-64),
  }
}

export function buildRawEcgValidation(
  session: JCVitalV8RawEcgSession | null,
  chunks: RawEcgChunkSummary,
  parseErrors: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    status: session?.status ?? 'IDLE',
    session: session ? {
      sessionId: session.sessionId,
      deviceId: session.deviceId,
      startedAt: session.startedAt,
      stoppedAt: session.stoppedAt,
      firmwareVersion: session.source?.firmwareVersion ?? null,
      sdkVersion: session.source?.sdkVersion ?? 'v8sdk2.0',
      sampleFormat: session.sampleFormat,
      unit: session.unit,
      sampleRateHz: session.sampleRateHz,
      sampleIntervalMs: session.sampleIntervalMs,
      hardChunkBufferLimitBytes: session.hardChunkBufferLimitBytes,
      maxBufferedEstimateBytes: session.maxBufferedEstimateBytes,
      temporaryStorePath: session.temporaryStorePath,
      persistedPacketCount: session.persistedPacketCount,
      persistedBytes: session.persistedBytes,
      storageErrorCount: session.storageErrorCount,
    } : null,
    chunkCount: session?.chunksEmitted ?? chunks.chunkCount,
    packetCount: session?.packetCount ?? 0,
    sampleCount: session?.sampleCount ?? 0,
    packetContinuity: {
      missingPacketCount: session?.missingPacketCount ?? 0,
      duplicatePacketCount: session?.duplicatePacketCount ?? 0,
      outOfOrderPacketCount: session?.outOfOrderPacketCount ?? 0,
      lastPacketId: session?.lastPacketId ?? null,
      averageSamplesPerPacket: session?.averageSamplesPerPacket ?? null,
    },
    minRawSample: session?.minimumRawSample ?? chunks.minRawSample,
    maxRawSample: session?.maximumRawSample ?? chunks.maxRawSample,
    estimatedBytes: session?.bytesReceived ?? chunks.totalBytes,
    maxBufferedEstimateBytes: session?.maxBufferedEstimateBytes ?? 0,
    parseErrorCount: session?.parseErrorCount ?? parseErrors.length,
    first3Chunks: chunks.firstThreeChunks,
    last3Chunks: chunks.lastThreeChunks,
    parseErrors,
  }
}
