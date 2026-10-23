import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivitySource } from './Activity24_25Certification'

const { listSourceEnvelopes, readActivitySource } = vi.hoisted(() => ({
  listSourceEnvelopes: vi.fn(),
  readActivitySource: vi.fn(),
}))

vi.mock('./jcvitalV8Bridge', () => ({
  JCVitalV8: { listSourceEnvelopes },
}))

vi.mock('./Activity24_25Certification', () => ({
  readActivitySource,
}))

import { prepareActivityV2Verification } from './ActivityV2VerificationPreparation'

interface Fixture {
  id: string
  type: '24' | '25'
  date: string
  data: Record<string, unknown>
}

const scope = { accountId: 'owner-1', deviceScopeId: 'jcvital_device_9a3d7b4c-1a2b-4c3d-8e5f-123456789012' }
const context = {
  ownerUserId: 'owner-1',
  deviceId: scope.deviceScopeId,
  deviceModel: 'PRO_V8',
  firmwareVersion: '0.0.8.8',
  sdkVersion: 'v8sdk2.0',
}

function fixture(id: string, type: '24' | '25', date: string, data: Record<string, unknown>): Fixture {
  return { id, type, date, data }
}

function envelope(source: Fixture) {
  return {
    sequence: 1,
    envelopeId: source.id,
    callbackId: null,
    recordIndex: null,
    kind: 'SDK_RECORD',
    receivedAt: '2025-01-02T12:00:00.000Z',
    timezone: 'UTC',
    envelopeJson: JSON.stringify({
      kind: 'SDK_RECORD',
      envelopeId: source.id,
      vendorDataType: source.type,
      acquisitionMode: 'HISTORICAL_SYNC',
      sourceDate: source.date,
    }),
    rawBytesBase64: null,
  }
}

function activitySource(source: Fixture): ActivitySource {
  const sdkFields = {
    ...source.data,
    date: source.date,
  }
  return {
    sourceEnvelopeId: source.id,
    sourceRecordGroupId: `${source.type}:${source.id}`,
    sourceFingerprint: `fingerprint:${source.id}`,
    entry: {} as ActivitySource['entry'],
    record: {
      vendorDataType: source.type,
      receivedAt: '2025-01-02T12:00:00.000Z',
      timezone: 'UTC',
      sessionId: `session:${source.id}`,
      parserVersion: 'test-parser',
      provider: 'JCVITAL',
      deviceScopeId: scope.deviceScopeId,
      deviceModel: 'PRO_V8',
      firmwareVersion: '0.0.8.8',
      sdkVersion: 'v8sdk2.0',
      acquisitionMode: 'HISTORICAL_SYNC',
      ...sdkFields,
    },
    fields: Object.fromEntries(Object.entries(sdkFields).map(([name, value]) => [
      name,
      { type: typeof value === 'number' ? 'Number' : 'String', value },
    ])),
    ancestry: [],
    rawByteLength: 0,
    rawByteSha256: '',
  }
}

function configure(fixtures: Fixture[]) {
  const byId = new Map(fixtures.map((entry) => [entry.id, activitySource(entry)]))
  listSourceEnvelopes.mockResolvedValue({
    envelopes: fixtures.map(envelope),
    hasMore: false,
    nextSequence: fixtures.length,
  })
  readActivitySource.mockImplementation(async (_journal, _scope, id: string) => {
    const source = byId.get(id)
    if (!source) throw new Error(`Missing fixture ${id}`)
    return source
  })
}

function validType24(id: string, date: string): Fixture {
  return fixture(id, '24', date, {
    step: 1200,
    distance: 0.8,
    calories: 32,
    exerciseMinutes: 600,
  })
}

function validType25(id: string, date: string): Fixture {
  return fixture(id, '25', date, {
    arraySteps: '1 2 3 4 5 6 7 8 9 10',
    detailMinterStep: 55,
  })
}

describe('prepareActivityV2Verification', () => {
  beforeEach(() => {
    listSourceEnvelopes.mockReset()
    readActivitySource.mockReset()
  })

  it('shares exact Type24 and Type25 selectors and deterministic 14 IDs across repeated preparation', async () => {
    configure([
      validType24('daily-newest', '2025-01-02'),
      validType24('daily-older', '2025-01-01'),
      fixture('detail-newest-invalid', '25', '2025-01-03 12:00:00', {
        arraySteps: '1 2 3 4 5 6 7 8 9',
        detailMinterStep: 45,
      }),
      validType25('detail-qualified', '2025-01-01 12:00:00'),
    ])
    const preview = await prepareActivityV2Verification(scope, context)
    const verify = await prepareActivityV2Verification(scope, context)

    expect(preview.type24?.source.sourceEnvelopeId).toBe('daily-newest')
    expect(preview.type25?.source.sourceEnvelopeId).toBe('detail-qualified')
    expect(preview.type25?.details.qualification?.status).toBe('PASS')
    expect(preview.payloads).toHaveLength(14)
    expect(preview.selectionValid).toBe(true)
    expect(verify.type24?.source.sourceEnvelopeId).toBe(preview.type24?.source.sourceEnvelopeId)
    expect(verify.type25?.source.sourceEnvelopeId).toBe(preview.type25?.source.sourceEnvelopeId)
    expect(verify.payloads.map(({ observationId }) => observationId))
      .toEqual(preview.payloads.map(({ observationId }) => observationId))
    expect(preview.payloads.map(({ metric }) => metric)).toEqual([
      'DAILY_STEPS',
      'DAILY_DISTANCE',
      'DAILY_CALORIES',
      'DAILY_EXERCISE_DURATION',
      ...Array.from({ length: 10 }, () => 'DETAILED_ACTIVITY_EPOCH'),
    ])
  })

  it('rejects missing daily evidence and unqualified Type25 segments using the production mapper policy', async () => {
    configure([
      fixture('daily-incomplete', '24', '2025-01-02', { step: 1200 }),
      fixture('detail-unqualified', '25', '2025-01-02 12:00:00', {
        arraySteps: '1 2 3 4 5 6 7 8 9',
        detailMinterStep: 45,
      }),
    ])
    const prepared = await prepareActivityV2Verification(scope, context)
    expect(prepared.type24).toBeNull()
    expect(prepared.type25).toBeNull()
    expect(prepared.selectionValid).toBe(false)
    expect(prepared.type24FailureReason).toContain('four required daily measurements')
    expect(prepared.type25FailureReason).toBe('ARRAY_LENGTH_NOT_10')
    expect(prepared.payloads).toEqual([])
  })

  it('does not access queue, sender, acquisition, or Base44 services during source preparation', async () => {
    configure([validType24('daily', '2025-01-02'), validType25('detail', '2025-01-02 12:00:00')])
    const prepared = await prepareActivityV2Verification(scope, context)
    expect(prepared.payloads).toHaveLength(14)
    expect(listSourceEnvelopes).toHaveBeenCalled()
    expect(readActivitySource).toHaveBeenCalledTimes(2)
  })
})
