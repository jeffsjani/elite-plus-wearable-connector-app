import { describe, expect, it } from 'vitest'
import type { JCVitalV8RawPpgChunk, JCVitalV8RawPpgSession } from './jcvitalV8Bridge'
import { buildRawPpgValidation, EMPTY_RAW_PPG_CHUNK_SUMMARY, includeRawPpgChunk } from './RawPpgDiagnostics'
import { rawPpgStartDisabledReason, rawPpgStopDisabledReason, type RawPpgCaptureGate } from './RawPpgCaptureGuard'

function chunk(sequenceNumber: number, packetCount = 1): JCVitalV8RawPpgChunk {
  return {
    signalType: 'PPG_WORKFLOW_RAW_VENDOR', sessionId: 'ppg-1', sequenceNumber,
    receivedAtStart: '2026-09-30T10:00:00.000Z', receivedAtEnd: '2026-09-30T10:00:01.000Z',
    sampleRateHz: null, sampleIntervalMs: null, unit: 'UNKNOWN_VENDOR_UNIT',
    packets: [], packetCount, bytesReceived: packetCount * 153, decodedSampleCount: 50,
    vendorDataType119Count: packetCount, decodedFieldNames: ['Time', 'PPG'], vendorDerivedFields: [], estimatedBytes: 2048,
  }
}

const allowedGate: RawPpgCaptureGate = {
  pluginAvailable: true, startMethodAvailable: true, stopMethodAvailable: true,
  connectionState: 'READY', activeSync: null, manualMeasurementActive: false,
  workoutStatus: 'STOPPED', rawEcgStatus: 'STOPPED', rawPpgStatus: 'IDLE',
}

describe('raw PPG workflow diagnostics', () => {
  it('retains only first/last chunks and aggregates packet, byte, and type-119 counts', () => {
    let summary = EMPTY_RAW_PPG_CHUNK_SUMMARY
    for (let sequence = 0; sequence < 6; sequence++) summary = includeRawPpgChunk(summary, chunk(sequence, sequence + 1))
    summary = includeRawPpgChunk(summary, chunk(5, 6))
    expect(summary.chunkCount).toBe(6)
    expect(summary.packetCount).toBe(21)
    expect(summary.totalBytes).toBe(21 * 153)
    expect(summary.vendorDataType119Count).toBe(21)
    expect(summary.firstThreeChunks.map((item) => item.sequenceNumber)).toEqual([0, 1, 2])
    expect(summary.lastThreeChunks.map((item) => item.sequenceNumber)).toEqual([3, 4, 5])
  })

  it('exports raw PPG fields without canonical glucose semantics', () => {
    const session = {
      sessionId: 'ppg-1', deviceId: 'device-1', startedAt: 'start', stoppedAt: 'stop', status: 'STOPPED',
      signalType: 'PPG_WORKFLOW_RAW_VENDOR', packetCount: 1, chunkCount: 1, bytesReceived: 153,
      notificationLengthCounts: { '153': 1, '203': 0, other: 0 }, notificationLengthsExactCounts: { '153': 1 },
      vendorDataType119Count: 1, decodedFieldNames: ['Time', 'PPG'], rawSampleDiagnostics: { '153': { decodedSampleCount: 50 } },
      vendorDerivedFields: [{ semanticType: 'VENDOR_DERIVED_BIOMARKER', fieldName: 'bloodPercent', value: 50 }],
      parseErrors: [],
    } as unknown as JCVitalV8RawPpgSession
    const report = buildRawPpgValidation(session, EMPTY_RAW_PPG_CHUNK_SUMMARY, [])
    expect(report).toMatchObject({ packetCount: 1, chunkCount: 1, bytesReceived: 153, vendorDataType119Count: 1 })
    expect(report).toHaveProperty('notificationLengthCounts.153', 1)
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