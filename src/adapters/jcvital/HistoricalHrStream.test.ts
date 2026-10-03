import { describe, expect, it, vi } from 'vitest'
import type { NativeObservation } from '../../models/wearableObservation'
import type { ConnectorObservationResult, NativeObservationInput } from '../../services/base44/base44Types'
import { CrashBreadcrumbs } from '../../services/diagnostics/CrashBreadcrumbs'
import type { BatchDeliveryListener } from '../../services/sync/ObservationBatchManager'
import { chunkAsSyncResult, HistoricalHrStreamCollector, HR_STREAM_SAMPLE_SIZE } from './HistoricalHrStream'
import type { JCVitalV8HistoricalHrChunk, JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import { buildHistoricalFeedResult } from './Phase3AValidation'
import { JCVitalPhysiologyDelivery } from './PhysiologyDelivery'

const MAC = 'E7:1B:D8:36:78:CF'
const CHUNK = 250

function bpm(index: number): number { return index % 97 === 13 ? 0 : 60 + Math.floor(index / 3) % 40 }

/** Streamed native shape: 15 samples per vendor record; raw record only on sample 0, never the packet envelope. */
function observation(index: number): NativeObservation {
  const record = Math.floor(index / 15)
  const sequence = index % 15
  const start = Date.UTC(2026, 8, 1) + record * 75_000
  const date = new Date(start)
  const vendorDate = `${date.getUTCFullYear()}.${String(date.getUTCMonth() + 1).padStart(2, '0')}.${String(date.getUTCDate()).padStart(2, '0')} ${String(date.getUTCHours()).padStart(2, '0')}:${String(date.getUTCMinutes()).padStart(2, '0')}:${String(date.getUTCSeconds()).padStart(2, '0')}`
  return {
    id: `native-${index}`,
    source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: MAC, macAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
    metricType: 'HEART_RATE_CONTINUOUS', observedAt: new Date(start + sequence * 5_000).toISOString(), observedAtSource: vendorDate,
    receivedAt: '2026-10-02T00:00:00.000Z', timezone: 'UTC', value: bpm(index), values: null, unit: 'bpm',
    acquisitionMode: 'HISTORICAL_SYNC', measurementContext: 'CONTINUOUS_HISTORY', sessionId: 'sync-1', packetId: null, sequenceNumber: sequence,
    samplingIntervalMs: 5_000, sampleRateHz: null, signalQuality: null, completeness: null, vendorDataType: '27', vendorField: 'arrayDynamicHR', vendorDerived: false,
    rawPayload: sequence === 0 ? { record: { date: vendorDate, arrayDynamicHR: '...' } } : null,
    provenance: { sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL', sourceRecordId: `${MAC}|27|${vendorDate}|${sequence}` },
  }
}

/** Mirrors JCVitalV8HistoricalHrStream: ≤250 per chunk, final chunk always emitted, Safe Test keeps only valid samples. */
function* nativeChunks(samples: number, maxValid?: number): Generator<JCVitalV8HistoricalHrChunk> {
  let pending: NativeObservation[] = []
  let emitted = 0
  let index = 0
  const planned = maxValid === undefined ? samples : Math.min(maxValid, Array.from({ length: samples }, (_, i) => bpm(i)).filter((value) => value > 0).length)
  const make = (isFinal: boolean, chunkIndex: number): JCVitalV8HistoricalHrChunk => {
    const observations = pending
    pending = []
    return { syncSessionId: 'sync-1', chunkIndex, isFinal, vendorDataType: '27', safeTestLimit: maxValid ?? null, sourceRecordCount: Math.ceil(samples / 15), plannedSampleCount: planned, sampleCount: observations.length, emittedSampleCountTotal: emitted, estimatedSerializedBytes: observations.length * 970, observations }
  }
  let chunkIndex = 0
  for (; index < samples; index++) {
    if (maxValid !== undefined && emitted >= maxValid) break
    const next = observation(index)
    if (maxValid !== undefined && !(next.value as number > 0)) continue
    pending.push(next)
    emitted++
    if (pending.length === CHUNK) yield make(false, chunkIndex++)
  }
  yield make(true, chunkIndex)
}

function nativeSummary(chunks: number): JCVitalV8HistoricalSyncResult {
  return {
    syncId: 'sync-1', deviceId: MAC, provider: 'JCVITAL', sdkCommand: 'GetDynamicHRWithMode', vendorDataType: '27', startedAt: '', completedAt: '',
    recordsReceived: 0, recordGroupsReceived: 0, recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: null, latestObservation: null,
    partial: false, completionStatus: 'COMPLETE', packetCount: 1, parseErrors: [], observations: [], streamed: true,
    stream: {
      syncSessionId: 'sync-1', chunkSize: CHUNK, safeTestLimit: null, safeTestLimitReached: false, packetCount: 1, vendorRecordCount: 0, bufferedRecordCount: 0,
      vendorRecordOrder: 'NEWEST_FIRST', vendorAscendingTransitions: 0, vendorDescendingTransitions: 0, emittedOrder: 'CHRONOLOGICAL_BY_RECORD_START', outOfOrderEmitted: 0,
      plannedSampleCount: 0, expandedSampleCount: 0, emittedSampleCount: 0, validSampleCount: 0, skippedNoMeasurementCount: 0, duplicateCount: 0, chunkCount: chunks,
      largestChunkCount: CHUNK, estimatedSerializedChunkBytes: 0, parseErrorCount: 0, finalEmitted: true,
    },
  }
}

class Harness {
  private readonly withResults: boolean
  constructor(withResults = true) { this.withResults = withResults }
  readonly rows = new Map<string, NativeObservationInput>()
  readonly server = new Map<string, NativeObservationInput>()
  readonly enqueueSizes: number[] = []
  private readonly listeners = new Set<BatchDeliveryListener>()
  private readonly storage = new Map<string, string>()
  readonly deps = {
    queue: {
      getOwnerUserId: () => 'user-1',
      enqueueMany: vi.fn(async (observations: NativeObservationInput[]) => {
        this.enqueueSizes.push(observations.length)
        return observations.map((item) => {
          if (this.rows.has(item.observationId) || this.server.has(item.observationId)) return { inserted: false, alreadyQueued: true }
          this.rows.set(item.observationId, item)
          return { inserted: true, alreadyQueued: false }
        })
      }),
    },
    deliver: vi.fn(async () => {
      const batch = [...this.rows.values()].slice(0, 100)
      if (!batch.length) return null
      const results: ConnectorObservationResult[] = batch.map((item) => {
        this.rows.delete(item.observationId)
        const duplicate = this.server.has(item.observationId)
        this.server.set(item.observationId, item)
        return { observationId: item.observationId, status: duplicate ? 'duplicate' : 'accepted', canonicalStatus: duplicate ? null : 'canonicalized', nativeObservationId: duplicate ? null : `native-${this.server.size}` }
      })
      const ids = batch.map((item) => item.observationId)
      const accepted = results.filter((result) => result.status === 'accepted').length
      this.listeners.forEach((listener) => listener({ batchId: 'b', attemptedAt: '', outcome: 'DELIVERED', observationIds: ids, acknowledgedIds: ids, rejectedIds: [], httpStatus: 200, errorCode: null, accepted, duplicate: ids.length - accepted, rejected: 0, results: this.withResults ? results : null, errors: [] }))
      return { success: true }
    }),
    subscribe: (listener: BatchDeliveryListener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
    resolveDeviceId: () => 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-e71bd83678cf',
    breadcrumbs: new CrashBreadcrumbs(() => ({ getItem: (key: string) => this.storage.get(key) ?? null, setItem: (key: string, value: string) => { this.storage.set(key, value) } })),
  }

  service(): JCVitalPhysiologyDelivery {
    const delivery = new JCVitalPhysiologyDelivery(this.deps)
    delivery.setContext({ bleAddress: MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' })
    delivery.setEnabled(true)
    delivery.start()
    return delivery
  }
}

/** The panel's consumer loop: accept → map + enqueue per chunk (deferred drain, total limit) → drain once. */
async function streamThrough(harness: Harness, samples: number, maxValid?: number) {
  const delivery = harness.service()
  const collector = new HistoricalHrStreamCollector()
  let chunks = 0
  for (const chunk of nativeChunks(samples, maxValid)) {
    chunks++
    const observations = collector.accept(chunk)!
    if (!observations.length) continue
    await delivery.deliverSyncResult(chunkAsSyncResult(chunk, observations), { ...(maxValid !== undefined ? { maxObservations: maxValid } : {}), deferDrain: true, expectedTotalObservations: chunk.plannedSampleCount })
  }
  await delivery.drainDeferred('27')
  return { delivery, collector, chunks, mapped: delivery.getSnapshot().progress?.mapped ?? 0 }
}

describe('Historical HR bounded native stream consumer', () => {
  it.each([300, 1_300, 17_280, 34_560])('full sync of %i samples is consumed chunk by chunk with bounded retained state', async (samples) => {
    const harness = new Harness()
    const { delivery, collector, chunks } = await streamThrough(harness, samples)
    const summary = collector.summary()
    const zeros = Array.from({ length: samples }, (_, index) => bpm(index)).filter((value) => value === 0).length

    expect(chunks).toBe(Math.floor(samples / CHUNK) + 1)
    expect(summary.largestChunkReceived).toBeLessThanOrEqual(CHUNK)
    expect(summary.observationsReceived).toBe(samples)
    expect(summary.finalReceived).toBe(true)
    expect(summary.firstFive.map((item) => item.id)).toEqual(['native-0', 'native-1', 'native-2', 'native-3', 'native-4'])
    expect(summary.lastFive.map((item) => item.id)).toEqual(Array.from({ length: 5 }, (_, offset) => `native-${samples - 5 + offset}`))
    expect(summary.intervals).toMatchObject({ medianSeconds: 5, minimumSeconds: 5, maximumSeconds: 5, outOfOrderTimestamps: 0 })
    expect(Math.max(...harness.enqueueSizes)).toBeLessThanOrEqual(CHUNK)
    // Zero samples stay NOT_DELIVERABLE; repeated BPM values are each delivered.
    expect(harness.server.size).toBe(samples - zeros)
    expect(delivery.getSnapshot().metrics.heartRateHistory).toMatchObject({ notDeliverable: zeros, uniqueObservationsDelivered: samples - zeros, failed: 0 })
    expect(delivery.getSnapshot().progress?.stage).toBe('COMPLETE')
    const retained = new TextEncoder().encode(JSON.stringify(collector.toSyncResult(nativeSummary(chunks)))).length
    expect(retained).toBeLessThan(20_000)
    delivery.dispose()
  }, 120_000)

  it('Safe Test receives and delivers at most 300 valid samples', async () => {
    const harness = new Harness()
    const { delivery, collector, mapped } = await streamThrough(harness, 34_560, 300)
    expect(collector.summary().observationsReceived).toBe(300)
    expect(mapped).toBe(300)
    expect(harness.server.size).toBe(300)
    expect(delivery.getSnapshot().progress?.stage).toBe('COMPLETE')
    delivery.dispose()
  })

  it('progress is cumulative across the whole streamed 1,300 sync, not the last chunk', async () => {
    const harness = new Harness()
    const { delivery } = await streamThrough(harness, 34_560, 1_300)
    expect(delivery.getSnapshot().progress).toMatchObject({
      stage: 'COMPLETE', safeTest: true, selectedForTest: 1_300, normalized: 1_300, mapped: 1_300, queued: 1_300,
      currentChunk: 6, estimatedTotalChunks: 6, largestChunk: 250, sourceRecords: Math.ceil(34_560 / 15),
    })
    expect(harness.server.size).toBe(1_300)
    delivery.dispose()
  })

  it('fresh accepted results[] become DELIVERED_CANONICALIZED with a nativeObservationId', async () => {
    const harness = new Harness(true)
    const { delivery } = await streamThrough(harness, 34_560, 300)
    const snapshot = delivery.getSnapshot()
    expect(snapshot.outcomeCounts.DELIVERED_CANONICALIZED).toBe(300)
    expect(snapshot.metrics.heartRateHistory.canonicalized).toBe(300)
    expect(snapshot.lastNativeObservationIds.heartRateHistory).not.toBeNull()
    expect(snapshot.resultHandling.at(-1)).toMatchObject({ eventHasResults: true, legacyTotalsPath: false, appliedCanonicalized: 100, withNativeObservationId: 100 })
    delivery.dispose()
  })

  it('a response without results[] reproduces the physical signature (DELIVERED, canonicalized 0, null nativeObservationId)', async () => {
    const harness = new Harness(false)
    const { delivery } = await streamThrough(harness, 34_560, 300)
    const snapshot = delivery.getSnapshot()
    expect(snapshot.outcomeCounts).toMatchObject({ DELIVERED: 300, DELIVERED_CANONICALIZED: 0, DELIVERED_DUPLICATE: 0 })
    expect(snapshot.metrics.heartRateHistory).toMatchObject({ serverAccepted: 300, canonicalized: 0 })
    expect(snapshot.lastNativeObservationIds.heartRateHistory).toBeNull()
    expect(snapshot.resultHandling.at(-1)).toMatchObject({ eventHasResults: false, legacyTotalsPath: true, matchedResults: 0 })
    delivery.dispose()
  })

  it('streamed observation IDs equal the one-shot delivery IDs', async () => {
    const streamed = new Harness()
    await streamThrough(streamed, 1_300)
    const oneShot = new Harness()
    const delivery = oneShot.service()
    await delivery.deliverSyncResult({ ...nativeSummary(1), observations: Array.from({ length: 1_300 }, (_, index) => observation(index)) })
    expect([...streamed.server.keys()]).toEqual([...oneShot.server.keys()])
    delivery.dispose()
  })

  it('ignores chunks from another sync and waits for a late final chunk', async () => {
    const collector = new HistoricalHrStreamCollector()
    const [first, final] = [...nativeChunks(300)]
    collector.accept(first)
    expect(collector.accept({ ...final, syncSessionId: 'other' })).toBeNull()
    const waiting = collector.waitForFinal(1_000)
    collector.accept(final)
    await expect(waiting).resolves.toBe(true)
    expect(collector.summary().ignoredChunks).toBe(1)
    await expect(new HistoricalHrStreamCollector().waitForFinal(5)).resolves.toBe(false)
  })

  it('feed diagnostics use stream totals while result state holds only first/last samples', () => {
    const collector = new HistoricalHrStreamCollector()
    for (const chunk of nativeChunks(17_280)) collector.accept(chunk)
    const result = collector.toSyncResult(nativeSummary(70))
    expect(result.observations).toHaveLength(HR_STREAM_SAMPLE_SIZE * 2)
    const feed = buildHistoricalFeedResult('heartRate', { requestStartedAt: '', requestCompletedAt: '', result, error: null, streamSummary: collector.summary() })
    expect(feed.normalizedObservationsProduced).toBe(17_280)
    expect(feed.sampleDiagnostics).toMatchObject({ totalSampleCount: 17_280, medianIntervalSeconds: 5 })
    expect(feed.firstFive).toHaveLength(5)
    expect(feed.lastFive).toHaveLength(5)
  })
})
