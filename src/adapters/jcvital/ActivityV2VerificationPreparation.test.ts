import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivitySource } from './Activity24_25Certification'

const { getRecentActivitySourceCandidates, readActivitySource } = vi.hoisted(() => ({
  getRecentActivitySourceCandidates: vi.fn(),
  readActivitySource: vi.fn(),
}))

vi.mock('./jcvitalV8Bridge', () => ({
  JCVitalV8: { getRecentActivitySourceCandidates },
}))

vi.mock('./Activity24_25Certification', () => ({
  readActivitySource,
}))

import { prepareActivityV2Verification } from './ActivityV2VerificationPreparation'

interface Fixture {
  id: string
  type: '24' | '25' | 'other'
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

function fixture(id: string, type: Fixture['type'], date: string, data: Record<string, unknown> = {}): Fixture {
  return { id, type, date, data }
}

function envelope(source: Fixture, sequence: number) {
  return {
    sequence,
    envelopeId: source.id,
    callbackId: null,
    recordIndex: null,
    kind: 'SDK_RECORD',
    receivedAt: '2025-01-02T12:00:00.000Z',
    timezone: 'UTC',
    envelopeJson: JSON.stringify({
      kind: 'SDK_RECORD',
      envelopeId: source.id,
      accountId: scope.accountId,
      deviceScopeId: scope.deviceScopeId,
      vendorDataType: source.type,
      acquisitionMode: 'HISTORICAL_SYNC',
      sourceDate: source.date,
    }),
    rawBytesBase64: null,
    sourceFile: null,
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
  const records = fixtures.map((entry, index) => envelope(entry, index + 1))
  getRecentActivitySourceCandidates.mockImplementation(async () => {
    const candidatesFor = (type: Fixture['type']) => records
      .filter((entry) => entry.envelopeJson && JSON.parse(entry.envelopeJson).vendorDataType === type)
      .sort((left, right) => right.sequence - left.sequence)
      .slice(0, 25)
    return {
      modelVersion: 'L0',
      queryMode: 'TARGETED_RECENT_CANDIDATES',
      perTypeLimit: 25,
      includePayload: true,
      sortOrder: 'sequence_desc',
      type24Candidates: candidatesFor('24'),
      type25Candidates: candidatesFor('25'),
    }
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
    getRecentActivitySourceCandidates.mockReset()
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
    expect(preview.sourceQueryMode).toBe('TARGETED_RECENT_CANDIDATES')
    expect(preview.type24SelectedIndex).toBe(0)
    expect(preview.type25SelectedIndex).toBe(1)
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
    expect(getRecentActivitySourceCandidates).toHaveBeenCalledWith({ ...scope, perTypeLimit: 25 })
    expect(readActivitySource).toHaveBeenCalledTimes(2)
  })

  it('queries only bounded Type24/Type25 candidates despite a 20,000-record journal', async () => {
    configure([
      ...Array.from({ length: 20_000 }, (_, index) => fixture(`other-${index}`, 'other', '2025-01-01')),
      validType24('daily-recent', '2025-01-02'),
      validType25('detail-recent', '2025-01-02 12:00:00'),
    ])
    const prepared = await prepareActivityV2Verification(scope, context)
    expect(prepared.type24?.source.sourceEnvelopeId).toBe('daily-recent')
    expect(prepared.type25?.source.sourceEnvelopeId).toBe('detail-recent')
    expect(prepared.payloads).toHaveLength(14)
    expect(prepared.type24CandidatesRead).toBe(1)
    expect(prepared.type25CandidatesRead).toBe(1)
    expect(prepared.selectionValid).toBe(true)
    expect(getRecentActivitySourceCandidates).toHaveBeenCalledTimes(1)
    expect(readActivitySource).toHaveBeenCalledTimes(2)
    expect(readActivitySource.mock.calls[0][3].envelopeJson).toContain('"vendorDataType":"24"')
  })

  it('caps at 25 per type and deterministically excludes valid candidates outside the window', async () => {
    const olderValid24 = validType24('daily-outside-window', '2025-01-05')
    const newerInvalid24 = Array.from({ length: 25 }, (_, index) => fixture(
      `daily-invalid-${index}`, '24', `2025-01-${String(6 + index).padStart(2, '0')}`,
      { step: 'invalid', distance: 1, calories: 1, exerciseMinutes: 1 },
    ))
    const olderValid25 = validType25('detail-outside-window', '2025-01-05 12:00:00')
    const newerInvalid25 = Array.from({ length: 25 }, (_, index) => fixture(
      `detail-invalid-${index}`, '25', `2025-01-${String(6 + index).padStart(2, '0')} 12:00:00`,
      { arraySteps: '1 2', detailMinterStep: 3 },
    ))
    configure([olderValid24, ...newerInvalid24, olderValid25, ...newerInvalid25])
    const prepared = await prepareActivityV2Verification(scope, context)
    expect(prepared.type24).toBeNull()
    expect(prepared.type25).toBeNull()
    expect(prepared.type24CandidatesRead).toBe(25)
    expect(prepared.type25CandidatesRead).toBe(25)
    expect(prepared.type24FailureReason).toContain('step must be a non-negative safe integer')
    expect(prepared.type25FailureReason).toBe('ARRAY_LENGTH_NOT_10')
  })

  it('selects valid Type24 and Type25 records at the deterministic edge of each 25-candidate window', async () => {
    const invalid24 = Array.from({ length: 24 }, (_, index) => fixture(
      `daily-invalid-${index}`, '24', `2025-01-${String(2 + index).padStart(2, '0')}`,
      { step: 'invalid', distance: 1, calories: 1, exerciseMinutes: 1 },
    ))
    const invalid25 = Array.from({ length: 24 }, (_, index) => fixture(
      `detail-invalid-${index}`, '25', `2025-01-${String(2 + index).padStart(2, '0')} 12:00:00`,
      { arraySteps: '1 2', detailMinterStep: 3 },
    ))
    configure([
      validType24('daily-window-edge', '2025-01-01'),
      ...invalid24,
      validType25('detail-window-edge', '2025-01-01 12:00:00'),
      ...invalid25,
    ])
    const first = await prepareActivityV2Verification(scope, context)
    const second = await prepareActivityV2Verification(scope, context)
    expect(first.type24?.source.sourceEnvelopeId).toBe('daily-window-edge')
    expect(first.type25?.source.sourceEnvelopeId).toBe('detail-window-edge')
    expect(first.type24SelectedIndex).toBe(24)
    expect(first.type25SelectedIndex).toBe(24)
    expect(second.type24SelectedIndex).toBe(first.type24SelectedIndex)
    expect(second.type25SelectedIndex).toBe(first.type25SelectedIndex)
  })

  it('fails closed when Type24 is absent or Type25 has no qualified candidate', async () => {
    configure([])
    await expect(prepareActivityV2Verification(scope, context)).resolves.toMatchObject({
      type24: null,
      type25: null,
      type24FailureReason: expect.stringContaining('No valid Type24 source found'),
      type25FailureReason: expect.stringContaining('No qualified Type25 source found'),
      selectionValid: false,
    })

    configure([validType24('daily', '2025-01-02'), fixture(
      'detail-invalid', '25', '2025-01-02 12:00:00', { arraySteps: '1 2', detailMinterStep: 3 },
    )])
    await expect(prepareActivityV2Verification(scope, context)).resolves.toMatchObject({
      type24: { source: { sourceEnvelopeId: 'daily' } },
      type25: null,
      type25FailureReason: 'ARRAY_LENGTH_NOT_10',
      selectionValid: false,
    })
  })
})
