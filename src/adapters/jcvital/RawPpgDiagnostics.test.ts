import { afterEach, describe, expect, it, vi } from 'vitest'
import { PpgDiagnosticErrorBoundary, RawPpgDiagnosticsView } from './JCVitalV8Panel'
import type { JCVitalV8RawPpgChunk, JCVitalV8RawPpgSession } from './jcvitalV8Bridge'
import { buildRawPpgValidation, createRawPpgUiCoalescer, EMPTY_RAW_PPG_CHUNK_SUMMARY, includeRawPpgChunk } from './RawPpgDiagnostics'
import { rawPpgStartDisabledReason, rawPpgStopDisabledReason, type RawPpgCaptureGate } from './RawPpgCaptureGuard'

function chunk(sequenceStart: number, packetCount = 1): JCVitalV8RawPpgChunk {
  return {
    sessionId: 'ppg-1', sequenceStart, sequenceEnd: sequenceStart,
    firstReceivedAt: '2026-09-30T10:00:00.000Z', lastReceivedAt: '2026-09-30T10:00:01.000Z',
    packetCount, wireBytes: packetCount * 153,
    notificationLengthCounts: { '153': packetCount, '203': 0, other: 0 },
    vendorType119Count: packetCount,
    decoded153Summary: { packetCount, decodedSampleCount: 50, minimumRawDecodedValue: 1, maximumRawDecodedValue: 50 },
    decoded203Summary: null, parseErrorCount: 0,
  }
}

const allowedGate: RawPpgCaptureGate = {
  pluginAvailable: true, startMethodAvailable: true, stopMethodAvailable: true,
  connectionState: 'READY', activeSync: null, manualMeasurementActive: false,
  workoutStatus: 'STOPPED', rawEcgStatus: 'STOPPED', rawPpgStatus: 'IDLE',
}

describe('raw PPG workflow diagnostics', () => {
  afterEach(() => vi.useRealTimers())

  it('retains no more than the last three chunk summaries and aggregates counts', () => {
    let summary = EMPTY_RAW_PPG_CHUNK_SUMMARY
    for (let sequence = 0; sequence < 6; sequence++) summary = includeRawPpgChunk(summary, chunk(sequence, sequence + 1))
    summary = includeRawPpgChunk(summary, chunk(5, 6))
    expect(summary.chunkCount).toBe(6)
    expect(summary.packetCount).toBe(21)
    expect(summary.totalBytes).toBe(21 * 153)
    expect(summary.vendorDataType119Count).toBe(21)
    expect(summary.lastThreeChunks.map((item) => item.sequenceStart)).toEqual([3, 4, 5])
    expect(summary.lastThreeChunks).toHaveLength(3)
    expect(summary.lastThreeChunks[0]).not.toHaveProperty('packets')
  })

  it('tolerates missing 153/203 decoded diagnostics and unsupported-only packets', () => {
    const session = {
      sessionId: 'ppg-1', deviceId: 'device-1', startedAt: 'start', stoppedAt: 'stop', status: 'STOPPED',
      signalType: 'PPG_WORKFLOW_RAW_VENDOR', packetCount: 1, chunkCount: 1, bytesReceived: 153,
      notificationLengthCounts: { '153': 1, '203': 0, other: 0 }, notificationLengthsExactCounts: { '153': 1 },
      vendorDataType119Count: 0, decodedFieldNames: [], rawSampleDiagnostics: undefined,
      vendorDerivedFields: [], first3Chunks: undefined, last3Chunks: undefined,
      parseErrors: [],
    } as unknown as JCVitalV8RawPpgSession
    const report = buildRawPpgValidation(session, EMPTY_RAW_PPG_CHUNK_SUMMARY, [])
    expect(report).toMatchObject({ packetCount: 1, chunkCount: 1, bytesReceived: 153, vendorDataType119Count: 0 })
    expect(report).toHaveProperty('notificationLengthCounts.153', 1)
    expect(report).toEqual(expect.objectContaining({ rawSampleDiagnostics: {}, first3Chunks: [], last3Chunks: [] }))
    expect(report).not.toHaveProperty('glucose')
    expect(report).not.toHaveProperty('mgDl')
  })

  it('renders unsupported-only packets with missing decoded layouts safely', () => {
    expect(() => RawPpgDiagnosticsView({
      session: {
        status: 'STOPPED', packetCount: 1, chunkCount: 1, bytesReceived: 17,
        notificationLengthCounts: { '153': 0, '203': 0, other: 1 },
        rawSampleDiagnostics: undefined, decodedFieldNames: undefined,
        first3Chunks: undefined, last3Chunks: undefined, parseErrors: undefined,
        vendorDerivedFields: undefined,
      } as unknown as JCVitalV8RawPpgSession,
      chunks: EMPTY_RAW_PPG_CHUNK_SUMMARY,
      parseErrors: [], error: null,
      uiDiagnostics: { chunkEventsReceivedByJs: 0, uiUpdateCount: 0, lastEventPayloadBytes: 0, maxEventPayloadBytes: 0 },
      renderErrors: [], now: Date.now(), startDisabledReason: null, stopDisabledReason: 'No active test',
      busy: false, onStart: () => {}, onStop: () => {},
    })).not.toThrow()
  })

  it('keeps raw packet arrays out of the live chunk event type and fixture', () => {
    const liveEvent = chunk(0)
    expect(liveEvent).not.toHaveProperty('packets')
    expect(liveEvent).not.toHaveProperty('originalBytes')
    expect(new TextEncoder().encode(JSON.stringify(liveEvent)).length).toBeLessThan(1024)
  })

  it('normalizes missing event counts and decoded layouts without throwing', () => {
    const partialEvent = {
      sessionId: 'ppg-1', sequenceStart: undefined, sequenceEnd: undefined,
      packetCount: undefined, wireBytes: undefined, notificationLengthCounts: undefined,
      vendorType119Count: undefined, decoded153Summary: undefined, decoded203Summary: undefined,
      firstReceivedAt: undefined, lastReceivedAt: undefined, parseErrorCount: undefined,
    } as unknown as JCVitalV8RawPpgChunk
    expect(includeRawPpgChunk(EMPTY_RAW_PPG_CHUNK_SUMMARY, partialEvent)).toMatchObject({
      chunkCount: 1, packetCount: 0, totalBytes: 0, vendorDataType119Count: 0,
      notificationLengthCounts: { '153': 0, '203': 0, other: 0 },
    })
  })

  it('shows an isolated PPG fallback and records render error details', () => {
    const onError = vi.fn()
    const error = new Error('diagnostic render failed')
    const boundary = new PpgDiagnosticErrorBoundary({ children: null, onError })
    boundary.state = PpgDiagnosticErrorBoundary.getDerivedStateFromError(error)
    const fallback = boundary.render()
    expect(fallback).toMatchObject({ props: { children: 'PPG diagnostics encountered an error' } })

    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    boundary.componentDidCatch(error, { componentStack: 'PPGView' })
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: error.message, stack: error.stack }))
    consoleError.mockRestore()
  })

  it('coalesces event bursts into one 750 ms UI update and records payload sizes', () => {
    vi.useFakeTimers()
    const updates: Array<{ chunk: JCVitalV8RawPpgChunk | null; chunkEventsReceivedByJs: number; uiUpdateCount: number; maxEventPayloadBytes: number }> = []
    const coalescer = createRawPpgUiCoalescer((update) => updates.push(update), 750)
    coalescer.pushChunk(chunk(0), 200)
    coalescer.pushChunk({ ...chunk(1), packetCount: 2, wireBytes: 306 }, 400)
    expect(updates).toHaveLength(0)
    vi.advanceTimersByTime(749)
    expect(updates).toHaveLength(0)
    vi.advanceTimersByTime(1)
    expect(updates).toHaveLength(1)
    expect(updates[0]).toMatchObject({ chunkEventsReceivedByJs: 2, uiUpdateCount: 1, maxEventPayloadBytes: 400 })
    expect(updates[0].chunk).toMatchObject({ sequenceStart: 0, sequenceEnd: 1, packetCount: 3, wireBytes: 459 })
    coalescer.cancel()
  })

  it('exports bounded native samples and diagnostics without canonical glucose semantics', () => {
    const session = {
      sessionId: 'ppg-1', deviceId: 'device-1', startedAt: 'start', stoppedAt: 'stop', status: 'STOPPED',
      packetCount: 1, chunkCount: 1, bytesReceived: 153,
      notificationLengthCounts: { '153': 1, '203': 0, other: 0 }, notificationLengthsExactCounts: { '153': 1 },
      vendorDataType119Count: 1, decodedFieldNames: ['Time', 'PPG'], rawSampleDiagnostics: { '153': { decodedSampleCount: 50 } },
      first3Chunks: [{ ...chunk(0), packets: [{ originalBytes: [1, 2, 3] }] }],
      last3Chunks: [{ ...chunk(0), packets: [{ originalBytes: [1, 2, 3] }] }],
      vendorDerivedFields: [{ semanticType: 'VENDOR_DERIVED_BIOMARKER', fieldName: 'bloodPercent', value: 50 }],
      parseErrors: [],
    } as unknown as JCVitalV8RawPpgSession
    const report = buildRawPpgValidation(session, EMPTY_RAW_PPG_CHUNK_SUMMARY, [])
    expect(report).toMatchObject({ packetCount: 1, chunkCount: 1, bytesReceived: 153, vendorDataType119Count: 1 })
    expect(report).toHaveProperty('first3Chunks.0.packets.0.originalBytes', [1, 2, 3])
    expect(report).toHaveProperty('rawSampleDiagnostics.153.decodedSampleCount', 50)
    expect(report).not.toHaveProperty('glucose')
    expect(report).not.toHaveProperty('mgDl')
  })

  it('enables capture only when the V8 is ready and other workflows are idle', () => {
    expect(rawPpgStartDisabledReason(allowedGate)).toBeNull()
    expect(rawPpgStartDisabledReason({ ...allowedGate, pluginAvailable: false })).toContain('plugin is unavailable')
    expect(rawPpgStartDisabledReason({ ...allowedGate, pluginAvailable: null })).toContain('Checking')
    expect(rawPpgStartDisabledReason({ ...allowedGate, connectionState: 'CONNECTED' })).toContain('READY')
    expect(rawPpgStartDisabledReason({ ...allowedGate, activeSync: 'phase3a:hrv' })).toContain('Another sync')
    expect(rawPpgStartDisabledReason({ ...allowedGate, manualMeasurementActive: true })).toContain('Manual measurement')
    expect(rawPpgStartDisabledReason({ ...allowedGate, workoutStatus: 'RUNNING' })).toContain('Workout')
    expect(rawPpgStartDisabledReason({ ...allowedGate, rawEcgStatus: 'RUNNING' })).toContain('ECG')
    expect(rawPpgStartDisabledReason({ ...allowedGate, rawPpgStatus: 'STARTING' })).toContain('already active')
    expect(rawPpgStopDisabledReason(allowedGate)).toContain('No running')
    expect(rawPpgStopDisabledReason({ ...allowedGate, rawPpgStatus: 'STOPPING' })).toContain('No running')
    expect(rawPpgStopDisabledReason({ ...allowedGate, rawPpgStatus: 'RUNNING' })).toBeNull()
  })
})