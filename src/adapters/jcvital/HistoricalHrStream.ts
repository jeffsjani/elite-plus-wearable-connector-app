import type { NativeObservation } from '../../models/wearableObservation'
import type { JCVitalV8HistoricalHrChunk, JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'

export const HR_STREAM_SAMPLE_SIZE = 5
/** Distinct interval values tracked for the median; further distinct values only affect min/max/count. */
const MAX_INTERVAL_BUCKETS = 200

export interface HistoricalHrIntervalStats {
  count: number
  minimumSeconds: number | null
  maximumSeconds: number | null
  medianSeconds: number | null
  between4And6Seconds: number
  percentageBetween4And6Seconds: number | null
  /** Non-increasing consecutive timestamps across the stream (should be 0). */
  outOfOrderTimestamps: number
}

export interface HistoricalHrStreamSummary {
  syncSessionId: string | null
  chunksReceived: number
  observationsReceived: number
  largestChunkReceived: number
  largestChunkEstimatedBytes: number
  sourceRecordCount: number
  finalReceived: boolean
  ignoredChunks: number
  firstFive: NativeObservation[]
  lastFive: NativeObservation[]
  intervals: HistoricalHrIntervalStats
}

/** Wraps one chunk in the sync-result shape consumed by the unchanged physiology delivery pipeline. */
export function chunkAsSyncResult(chunk: JCVitalV8HistoricalHrChunk, observations: NativeObservation[]): JCVitalV8HistoricalSyncResult {
  const now = new Date().toISOString()
  return {
    syncId: chunk.syncSessionId, deviceId: null, provider: 'JCVITAL', sdkCommand: 'GetDynamicHRWithMode', vendorDataType: chunk.vendorDataType,
    startedAt: now, completedAt: now, recordsReceived: observations.length, recordGroupsReceived: chunk.sourceRecordCount, recordsStored: 0,
    recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: null, latestObservation: null, partial: !chunk.isFinal,
    completionStatus: chunk.isFinal ? 'COMPLETE' : 'PARTIAL', packetCount: 0, parseErrors: [], observations,
  }
}

/**
 * Consumes bounded native HR chunks while retaining only totals, first/last samples and interval statistics,
 * so screen state never holds the full history.
 */
export class HistoricalHrStreamCollector {
  private syncSessionId: string | null = null
  private chunksReceived = 0
  private observationsReceived = 0
  private largestChunk = 0
  private largestChunkBytes = 0
  private sourceRecordCount = 0
  private finalReceived = false
  private ignoredChunks = 0
  private readonly firstFive: NativeObservation[] = []
  private lastFive: NativeObservation[] = []
  private previousTime: number | null = null
  private readonly intervalBuckets = new Map<number, number>()
  private intervalCount = 0
  private minimumInterval: number | null = null
  private maximumInterval: number | null = null
  private nearFiveSeconds = 0
  private outOfOrder = 0
  private finalWaiters: Array<() => void> = []

  /** Returns the chunk's observations for delivery, or null when the chunk belongs to another sync. */
  accept(chunk: JCVitalV8HistoricalHrChunk): NativeObservation[] | null {
    if (this.syncSessionId === null && !this.finalReceived) this.syncSessionId = chunk.syncSessionId
    if (chunk.syncSessionId !== this.syncSessionId || this.finalReceived) { this.ignoredChunks++; return null }
    const observations = Array.isArray(chunk.observations) ? chunk.observations : []
    this.chunksReceived++
    this.observationsReceived += observations.length
    this.largestChunk = Math.max(this.largestChunk, observations.length)
    this.largestChunkBytes = Math.max(this.largestChunkBytes, chunk.estimatedSerializedBytes ?? 0)
    this.sourceRecordCount = Math.max(this.sourceRecordCount, chunk.sourceRecordCount ?? 0)
    for (const observation of observations) {
      if (this.firstFive.length < HR_STREAM_SAMPLE_SIZE) this.firstFive.push(observation)
      this.trackInterval(observation)
    }
    this.lastFive = [...this.lastFive, ...observations.slice(-HR_STREAM_SAMPLE_SIZE)].slice(-HR_STREAM_SAMPLE_SIZE)
    if (chunk.isFinal) {
      this.finalReceived = true
      this.finalWaiters.forEach((resolve) => resolve())
      this.finalWaiters = []
    }
    return observations
  }

  /** Chunk events and the call result may reach JS in either order; resolves false on timeout. */
  waitForFinal(timeoutMs: number): Promise<boolean> {
    if (this.finalReceived) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs)
      this.finalWaiters.push(() => { clearTimeout(timer); resolve(true) })
    })
  }

  summary(): HistoricalHrStreamSummary {
    return {
      syncSessionId: this.syncSessionId,
      chunksReceived: this.chunksReceived,
      observationsReceived: this.observationsReceived,
      largestChunkReceived: this.largestChunk,
      largestChunkEstimatedBytes: this.largestChunkBytes,
      sourceRecordCount: this.sourceRecordCount,
      finalReceived: this.finalReceived,
      ignoredChunks: this.ignoredChunks,
      firstFive: [...this.firstFive],
      lastFive: [...this.lastFive],
      intervals: {
        count: this.intervalCount,
        minimumSeconds: this.minimumInterval,
        maximumSeconds: this.maximumInterval,
        medianSeconds: this.medianInterval(),
        between4And6Seconds: this.nearFiveSeconds,
        percentageBetween4And6Seconds: this.intervalCount ? this.nearFiveSeconds / this.intervalCount * 100 : null,
        outOfOrderTimestamps: this.outOfOrder,
      },
    }
  }

  /** The native summary with only first/last samples attached; totals come from the stream. */
  toSyncResult(native: JCVitalV8HistoricalSyncResult): JCVitalV8HistoricalSyncResult {
    const seen = new Set<string>()
    const observations = [...this.firstFive, ...this.lastFive].filter((observation) => !seen.has(observation.id) && seen.add(observation.id))
    return { ...native, observations }
  }

  private trackInterval(observation: NativeObservation): void {
    const time = observation.observedAt ? Date.parse(observation.observedAt) : Number.NaN
    if (!Number.isFinite(time)) return
    if (this.previousTime !== null) {
      const seconds = (time - this.previousTime) / 1000
      if (seconds <= 0) this.outOfOrder++
      this.intervalCount++
      this.minimumInterval = this.minimumInterval === null ? seconds : Math.min(this.minimumInterval, seconds)
      this.maximumInterval = this.maximumInterval === null ? seconds : Math.max(this.maximumInterval, seconds)
      if (seconds >= 4 && seconds <= 6) this.nearFiveSeconds++
      if (this.intervalBuckets.has(seconds) || this.intervalBuckets.size < MAX_INTERVAL_BUCKETS) this.intervalBuckets.set(seconds, (this.intervalBuckets.get(seconds) ?? 0) + 1)
    }
    this.previousTime = time
  }

  private medianInterval(): number | null {
    const total = [...this.intervalBuckets.values()].reduce((sum, count) => sum + count, 0)
    if (!total) return null
    const sorted = [...this.intervalBuckets.entries()].sort(([left], [right]) => left - right)
    const valueAt = (rank: number) => {
      let seen = 0
      for (const [value, count] of sorted) { seen += count; if (rank < seen) return value }
      return sorted[sorted.length - 1][0]
    }
    return total % 2 ? valueAt((total - 1) / 2) : (valueAt(total / 2 - 1) + valueAt(total / 2)) / 2
  }
}
