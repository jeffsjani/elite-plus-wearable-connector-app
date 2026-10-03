import type { NativeObservation } from '../../models/wearableObservation'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'

/** First/last observations keep their raw vendor payload for validation export; all others drop it. */
export const RAW_PAYLOAD_SAMPLE_SIZE = 5

export interface HistoricalMemoryAudit {
  vendorDataType: string
  sourceRecordGroups: number
  normalizedObservations: number
  sampleObservationBytes: number
  sampleRawPayloadBytes: number
  sampleVendorEnvelopeBytes: number
  /** True when consecutive observations carry an identical full vendor envelope. */
  rawPayloadEnvelopeDuplicated: boolean
  estimatedNativeResultBytes: number
  estimatedDuplicatedEnvelopeBytes: number
  estimatedBoundedResultBytes: number
}

function bytes(value: unknown): number {
  try { return new TextEncoder().encode(JSON.stringify(value) ?? '').length } catch { return 0 }
}

function envelopeOf(observation: NativeObservation | undefined): unknown {
  const raw = observation?.rawPayload
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>).vendorEnvelope ?? null : null
}

/** Estimates from a bounded sample (first/second/last) so auditing never stringifies the whole result. */
export function auditHistoricalResult(result: JCVitalV8HistoricalSyncResult): HistoricalMemoryAudit {
  const observations = result.observations
  const first = observations[0]
  const last = observations[observations.length - 1]
  const firstEnvelope = envelopeOf(first)
  const envelopeBytes = firstEnvelope === null ? 0 : bytes(firstEnvelope)
  const duplicated = observations.length > 1 && envelopeBytes > 0 && bytes(envelopeOf(observations[1])) === envelopeBytes && JSON.stringify(envelopeOf(observations[1])) === JSON.stringify(firstEnvelope)
  const averageObservationBytes = observations.length ? Math.round((bytes(first) + bytes(last)) / (first === last ? 1 : 2)) : 0
  const rawBytes = first ? bytes(first.rawPayload) : 0
  const strippedBytes = first ? bytes({ ...first, rawPayload: null }) : 0
  const sampled = Math.min(observations.length, RAW_PAYLOAD_SAMPLE_SIZE * 2)
  return {
    vendorDataType: result.vendorDataType,
    sourceRecordGroups: result.recordGroupsReceived,
    normalizedObservations: observations.length,
    sampleObservationBytes: averageObservationBytes,
    sampleRawPayloadBytes: rawBytes,
    sampleVendorEnvelopeBytes: envelopeBytes,
    rawPayloadEnvelopeDuplicated: duplicated,
    estimatedNativeResultBytes: averageObservationBytes * observations.length,
    estimatedDuplicatedEnvelopeBytes: duplicated ? envelopeBytes * (observations.length - 1) : 0,
    estimatedBoundedResultBytes: strippedBytes * (observations.length - sampled) + averageObservationBytes * sampled,
  }
}

/** Drops rawPayload from all but the first/last samples; acquisition data and normalized fields are untouched. */
export function boundHistoricalResult(result: JCVitalV8HistoricalSyncResult, keep = RAW_PAYLOAD_SAMPLE_SIZE): JCVitalV8HistoricalSyncResult {
  const count = result.observations.length
  if (count <= keep * 2) return result
  return {
    ...result,
    observations: result.observations.map((observation, index) => index < keep || index >= count - keep ? observation : { ...observation, rawPayload: null }),
  }
}
