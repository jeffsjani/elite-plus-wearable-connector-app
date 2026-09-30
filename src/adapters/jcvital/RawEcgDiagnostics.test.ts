import { describe, expect, it } from 'vitest'
import type { JCVitalV8RawEcgChunk } from './jcvitalV8Bridge'
import { buildRawEcgValidation, EMPTY_RAW_ECG_CHUNK_SUMMARY, includeRawEcgChunk } from './RawEcgDiagnostics'

function chunk(sequenceNumber: number, samples: number[]): JCVitalV8RawEcgChunk {
  return {
    signalType: 'ECG_RAW', sessionId: 'ecg-1', deviceId: 'device-1', sequenceNumber,
    firstPacketId: sequenceNumber * 8, lastPacketId: sequenceNumber * 8 + 7,
    packetSequenceStart: sequenceNumber * 8, packetSequenceEnd: sequenceNumber * 8 + 7,
    packetIds: Array.from({ length: 8 }, (_, index) => sequenceNumber * 8 + index),
    packetCount: 8, receivedAtStart: '2026-09-30T10:00:00.000Z', receivedAtEnd: '2026-09-30T10:00:01.000Z',
    sampleRateHz: null, sampleIntervalMs: null, sampleFormat: 'UINT24_LE_VENDOR_RAW', unit: 'UNKNOWN_VENDOR_UNIT',
    samples, rawPacketBytes: [], sampleCount: samples.length, estimatedBytes: samples.length * 3,
    source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: 'device-1', macAddress: null, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
    firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0',
  }
}

describe('raw ECG diagnostic chunk summary', () => {
  it('retains first and last three chunks, deduplicates replayed chunk sequence, and aggregates sample/byte limits', () => {
    let summary = EMPTY_RAW_ECG_CHUNK_SUMMARY
    for (let sequence = 0; sequence < 6; sequence++) {
      summary = includeRawEcgChunk(summary, chunk(sequence, [sequence, sequence + 10]))
    }
    summary = includeRawEcgChunk(summary, chunk(5, [5, 15]))

    expect(summary.chunkCount).toBe(6)
    expect(summary.totalBytes).toBe(36)
    expect(summary.minRawSample).toBe(0)
    expect(summary.maxRawSample).toBe(15)
    expect(summary.firstThreeChunks.map((item) => item.sequenceNumber)).toEqual([0, 1, 2])
    expect(summary.lastThreeChunks.map((item) => item.sequenceNumber)).toEqual([3, 4, 5])
  })

  it('exports session continuity and only bounded chunk samples', () => {
    const summary = includeRawEcgChunk(EMPTY_RAW_ECG_CHUNK_SUMMARY, chunk(0, [0, 0xFFFFFF]))
    const report = buildRawEcgValidation({
      sessionId: 'ecg-1', deviceId: 'device-1', startedAt: '2026-09-30T10:00:00.000Z', stoppedAt: '2026-09-30T10:05:00.000Z',
      status: 'STOPPED', packetCount: 8, sampleCount: 2, missingPacketCount: 1, duplicatePacketCount: 2,
      outOfOrderPacketCount: 3, parseErrorCount: 0, bytesReceived: 6, chunksEmitted: 1, droppedPacketCount: 0,
      lastPacketId: 7, averageSamplesPerPacket: 0.25, minimumRawSample: 0, maximumRawSample: 0xFFFFFF,
      maxBufferedEstimateBytes: 128, hardChunkBufferLimitBytes: 32 * 1024,
      temporaryStorePath: '/cache/ecg.bin', persistedPacketCount: 8, persistedBytes: 30, storageErrorCount: 0,
      sampleRateHz: null, sampleIntervalMs: null, sampleFormat: 'UINT24_LE_VENDOR_RAW', unit: 'UNKNOWN_VENDOR_UNIT',
      source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: 'device-1', macAddress: null, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0' },
      parseErrors: [],
    }, summary, [])

    expect(report).toMatchObject({
      packetCount: 8, sampleCount: 2, chunkCount: 1, estimatedBytes: 6,
      packetContinuity: { missingPacketCount: 1, duplicatePacketCount: 2, outOfOrderPacketCount: 3 },
      minRawSample: 0, maxRawSample: 0xFFFFFF,
    })
    expect(report).not.toHaveProperty('allSamples')
    expect(report).toHaveProperty('first3Chunks.0.samples', [0, 0xFFFFFF])
  })
})
