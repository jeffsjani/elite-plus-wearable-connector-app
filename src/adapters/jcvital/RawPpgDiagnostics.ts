import type { JCVitalV8RawPpgChunk, JCVitalV8RawPpgSession } from './jcvitalV8Bridge'

export interface RawPpgChunkSummary {
  chunkCount: number
  packetCount: number
  totalBytes: number
  decodedSampleCount: number
  vendorDataType119Count: number
  firstThreeChunks: JCVitalV8RawPpgChunk[]
  lastThreeChunks: JCVitalV8RawPpgChunk[]
  decodedFieldNames: string[]
  vendorDerivedFields: Array<Record<string, unknown>>
}

export const EMPTY_RAW_PPG_CHUNK_SUMMARY: RawPpgChunkSummary = {
  chunkCount: 0,
  packetCount: 0,
  totalBytes: 0,
  decodedSampleCount: 0,
  vendorDataType119Count: 0,
  firstThreeChunks: [],
  lastThreeChunks: [],
  decodedFieldNames: [],
  vendorDerivedFields: [],
}

export function includeRawPpgChunk(summary: RawPpgChunkSummary, chunk: JCVitalV8RawPpgChunk): RawPpgChunkSummary {
  if (summary.firstThreeChunks.some((item) => item.sequenceNumber === chunk.sequenceNumber) ||
      summary.lastThreeChunks.some((item) => item.sequenceNumber === chunk.sequenceNumber)) return summary
  const firstThreeChunks = summary.firstThreeChunks.length < 3 ? [...summary.firstThreeChunks, chunk] : summary.firstThreeChunks
  const lastThreeChunks = [...summary.lastThreeChunks, chunk].slice(-3)
  const packetCount = summary.packetCount + chunk.packetCount
  return {
    chunkCount: summary.chunkCount + 1,
    packetCount,
    totalBytes: summary.totalBytes + chunk.bytesReceived,
    decodedSampleCount: summary.decodedSampleCount + chunk.decodedSampleCount,
    vendorDataType119Count: summary.vendorDataType119Count + chunk.vendorDataType119Count,
    firstThreeChunks,
    lastThreeChunks,
    decodedFieldNames: [...new Set([...summary.decodedFieldNames, ...chunk.decodedFieldNames])],
    vendorDerivedFields: [...summary.vendorDerivedFields, ...chunk.vendorDerivedFields],
  }
}

export function buildRawPpgValidation(
  session: JCVitalV8RawPpgSession | null,
  chunks: RawPpgChunkSummary,
  parseErrors: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const errors = session?.parseErrors ?? []
  return {
    session,
    packetCount: session?.packetCount ?? chunks.packetCount,
    chunkCount: session?.chunkCount ?? chunks.chunkCount,
    bytesReceived: session?.bytesReceived ?? chunks.totalBytes,
    notificationLengthCounts: session?.notificationLengthCounts ?? { '153': 0, '203': 0, other: 0 },
    notificationLengthsExactCounts: session?.notificationLengthsExactCounts ?? {},
    vendorDataType119Count: session?.vendorDataType119Count ?? chunks.vendorDataType119Count,
    first3Chunks: chunks.firstThreeChunks,
    last3Chunks: chunks.lastThreeChunks,
    decodedFieldNames: session?.decodedFieldNames ?? chunks.decodedFieldNames,
    rawSampleDiagnostics: session?.rawSampleDiagnostics ?? null,
    vendorDerivedFields: session?.vendorDerivedFields ?? chunks.vendorDerivedFields,
    parseErrors: [...errors, ...parseErrors.filter((error) => !errors.includes(error))],
  }
}