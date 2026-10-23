import { describe, expect, it, vi } from 'vitest'
import type { JCVitalV8HistoricalSyncResult, JCVitalV8Plugin, SourceJournalScope } from './jcvitalV8Bridge'
import {
  buildActivitySemanticReport,
  buildWorkoutSemanticReport,
  acquireActivity24And25,
  acquirePhysicalWorkoutHistory,
  captureControlledWorkout,
  decodePhysicalWorkoutHistory,
  hasPhysicalTestAttempt,
  markPhysicalTestAttempt,
  persistPhysicalTestResult,
  readSavedPhysicalTestResult,
  type PhysicalTestIsolation,
} from './V8PhysicalSemanticTests'
import type { LiveWorkoutPacket } from './WorkoutTelemetry'
import type { WorkoutHistoryAcquisition } from './jcvitalV8Bridge'
import { vc25PhysicalBytes } from './Type29PhysicalWire.fixture'
import { wireSha256 } from './Type29PhysicalWire'
import type { WorkoutHistoryCertificationSnapshot } from './WorkoutHistoryCertification'

type SourceEntry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type ActivityResult = Awaited<ReturnType<JCVitalV8Plugin['syncActivityCertification']>>

const scope: SourceJournalScope = { accountId: 'user-1', deviceScopeId: 'device-1' }

function typed(value: unknown) {
  return typeof value === 'string' ? { type: 'String', value } : { type: 'Null', value: null }
}

function sourceEntry(envelopeId: string, vendorDataType: '24' | '25', fields: Record<string, string>): SourceEntry {
  const envelopeFields = Object.entries(fields).map(([key, value]) => ({
    key: typed(key),
    value: typed(value),
  }))
  return {
    envelopeId,
    sequence: 1,
    envelopeJson: JSON.stringify({
      vendorDataType,
      recordIndex: 0,
      sdkSnapshot: { type: 'Map', entries: envelopeFields },
    }),
    rawBytesBase64: null,
    sourceFile: null,
  }
}

function syncResult(vendorDataType: string, sourceRecordEnvelopeIds: string[]): JCVitalV8HistoricalSyncResult {
  return {
    syncId: `sync-${vendorDataType}`,
    deviceId: 'device-1',
    provider: 'JCVITAL',
    sdkCommand: `Test-${vendorDataType}`,
    vendorDataType,
    startedAt: '2026-01-01T00:00:00.000Z',
    completedAt: '2026-01-01T00:01:00.000Z',
    recordsReceived: sourceRecordEnvelopeIds.length,
    recordGroupsReceived: sourceRecordEnvelopeIds.length,
    recordsStored: 0,
    recordsDeduplicated: 0,
    recordsRejected: 0,
    earliestObservation: null,
    latestObservation: null,
    partial: false,
    completionStatus: 'COMPLETE',
    nativeCommandWritten: true,
    packetCount: 1,
    parseErrors: [],
    observations: [],
    sourceRecordEnvelopeIds,
  }
}

function activityResult(fields: { steps?: string; distance?: string; calories?: string } = {}): {
  acquisition: ActivityResult
  sources: SourceEntry[]
} {
  const summary = sourceEntry('source-24', '24', {
    date: '2026-01-01',
    step: fields.steps ?? '55',
    distance: fields.distance ?? '1.25',
    calories: fields.calories ?? '100',
    exerciseMinutes: '12',
    ExerciseTime: '720',
    activeTime: '13',
    goal: '1',
  })
  const detail = sourceEntry('source-25', '25', {
    date: '2026-01-01',
    arraySteps: '1 2 3 4 5 6 7 8 9 10',
    detailMinterStep: '55',
    distance: '1.25',
    calories: '100',
  })
  return {
    acquisition: {
      acquisitionSessionId: 'activity-session',
      results: [syncResult('24', [summary.envelopeId]), syncResult('25', [detail.envelopeId])],
    },
    sources: [summary, detail],
  }
}

function isolation(): PhysicalTestIsolation {
  const queue = {
    pending: 0,
    retrying: 0,
    failed: 0,
    inFlight: 0,
    acknowledged: 0,
    oldestPendingAgeMs: null,
    lastAttemptAt: null,
    lastSuccessfulUploadAt: null,
    warnings: [],
  }
  const sender = {
    configuredConcurrency: 1,
    effectiveConcurrency: 1,
    senderActive: false,
    senderGeneration: 0,
    activeWorkerCount: 0,
    successfulBatches: 0,
    retryBatches: 0,
    failedBatches: 0,
    canonicalFailureCount: 0,
    canonicalRecoveryRequired: false,
    lastCanonicalFailureBatchId: null,
    lastCanonicalFailureAt: null,
    retryScheduledAt: null,
    startupQueueResumeAttempted: false,
    startupQueueResumeStarted: false,
    activeBatchIds: [],
  }
  return {
    queueWrites: 0,
    base44Requests: 0,
    base44Writes: 0,
    digitalWellnessChanged: false,
    queueBefore: queue,
    queueAfter: queue,
    queueUnchanged: true,
    acknowledgedBefore: 0,
    acknowledgedAfter: 0,
    acknowledgedUnchanged: true,
    senderBefore: sender,
    senderAfter: sender,
    senderNotInvoked: true,
    passed: true,
  }
}

describe('V8 targeted physical semantic tests', () => {
  it('reconciles only Type24 and Type25 on a matching local day without converting units', () => {
    const { acquisition, sources } = activityResult()
    const result = buildActivitySemanticReport(acquisition, sources, isolation(), '2026-01-02T00:00:00.000Z')

    expect(result.commands).toEqual({ type24: true, type25: true })
    expect(result.prohibitedCommandTypesIssued).toEqual([])
    expect(result.sameLocalDay).toBe('2026-01-01')
    expect(result.reconciliation.stepsDifference).toBe(0)
    expect(result.reconciliation.distanceDifference).toBe(0)
    expect(result.reconciliation.caloriesDifference).toBe(0)
    expect(result.type25.epochCount).toBe(10)
    expect(result.type25.summedEpochSteps).toBe(55)
    expect(result.type24?.distanceNormalized).toBeNull()
    expect(result.type24?.caloriesNormalized).toBeNull()
    expect(result.classifications).toEqual({
      DAILY_STEPS: 'SOURCE_ONLY_VALIDATED',
      DAILY_DISTANCE: 'SOURCE_ONLY_VALIDATED',
      DAILY_CALORIES: 'SOURCE_ONLY_VALIDATED',
      DETAILED_ACTIVITY: 'SOURCE_ONLY_VALIDATED',
      EXERCISE_MINUTES: 'SOURCE_ONLY_VALIDATED',
    })
    expect(result.reconciliation.doubleCountAnalysis).toContain('never added into canonical totals')
    expect(result.sourceJournalUsed).toBe(true)
  })

  it('limits the activity acquisition adapter to Type24/25 results and their journal reads', async () => {
    const { acquisition, sources } = activityResult()
    const sourceById = new Map(sources.map((source) => [source.envelopeId, source]))
    const api = {
      syncActivityCertification: vi.fn(async () => acquisition),
      readSourceEnvelope: vi.fn(async ({ envelopeId }: SourceJournalScope & { envelopeId: string }) => {
        const source = sourceById.get(envelopeId)
        if (!source) throw new Error('Unexpected source envelope.')
        return source
      }),
    }

    const actual = await acquireActivity24And25(api, scope)

    expect(api.syncActivityCertification).toHaveBeenCalledTimes(1)
    expect(api.readSourceEnvelope.mock.calls.map(([arg]) => arg.envelopeId)).toEqual(['source-24', 'source-25'])
    expect(actual.sourceEntries).toHaveLength(2)
  })

  it('decodes a new journaled Type29 acquisition directly despite absent/corrupt SDK records', async () => {
    const bytes = vc25PhysicalBytes()
    const entries: SourceEntry[] = [{
      envelopeId: 'notification', sequence: 3,
      envelopeJson: JSON.stringify({
        kind: 'BLE_NOTIFICATION', envelopeId: 'notification', accountId: scope.accountId,
        deviceScopeId: scope.deviceScopeId, sessionId: 'sync-29',
        byteLength: bytes.length, sha256: await wireSha256(bytes),
      }),
      rawBytesBase64: btoa(String.fromCharCode(...bytes)), sourceFile: null,
    }]
    for (const [envelopeId, kind, sequence] of [
      ['command', 'WORKOUT_COMMAND_REQUEST', 1],
      ['ack', 'WORKOUT_COMMAND_WRITE_ACK', 2],
      ['outcome', 'SDK_PARSE_OUTCOME', 4],
    ] as const) {
      entries.push({
        envelopeId, sequence, sourceFile: null,
        rawBytesBase64: kind === 'SDK_PARSE_OUTCOME' ? null : btoa(String.fromCharCode(...bytes)),
        envelopeJson: JSON.stringify({
          envelopeId, kind, accountId: scope.accountId, deviceScopeId: scope.deviceScopeId,
          sessionId: 'sync-29', byteLength: bytes.length, sha256: await wireSha256(bytes),
          parentEnvelopeId: kind === 'WORKOUT_COMMAND_WRITE_ACK' ? 'command' : null,
        }),
      })
    }
    const acquisition: WorkoutHistoryAcquisition = {
      ...syncResult('29', []), sdkCommand: 'GetActivityModeDataWithMode',
      sourceCommandEnvelopeIds: ['command'], sourceCommandAckEnvelopeIds: ['ack'],
      sourceNotificationEnvelopeIds: ['notification'], sourceParserOutcomeEnvelopeIds: ['outcome'],
      sourceCallbackEnvelopeIds: [], sourceRecordEnvelopeIds: [], observations: [],
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
      deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY', retryCount: 0,
    }
    const decoded = await decodePhysicalWorkoutHistory(acquisition, entries, scope)
    expect(decoded.records).toHaveLength(3)
    expect(decoded.records[1].fields.date).toBe('2026.09.15 16:15:45')
    expect(decoded.records[2].fields.ExerciseTime).toBe('600')
    expect(decoded.records[0].notificationEnvelopeIds).toEqual(['notification'])
    expect(decoded.entries[0].rawBytesBase64).toBe(entries[0].rawBytesBase64)
    let saved: WorkoutHistoryCertificationSnapshot | null = null
    const api = {
      writeWorkoutCertificationSnapshot: vi.fn(async ({ json }: SourceJournalScope & { json: string }) => {
        saved = JSON.parse(json) as WorkoutHistoryCertificationSnapshot
        return { saved: true }
      }),
      syncWorkoutHistoryCertification: vi.fn(async () => {
        expect(saved?.state).toBe('ACQUIRING')
        return acquisition
      }),
      readWorkoutSourceEnvelope: vi.fn(async ({ envelopeId }: SourceJournalScope & { envelopeId: string }) => {
        expect(saved?.acquisition?.syncId).toBe(acquisition.syncId)
        const entry = entries.find((source) => source.envelopeId === envelopeId)
        if (!entry) throw new Error('Unexpected journal read')
        return entry
      }),
    }
    const captured = await acquirePhysicalWorkoutHistory(api, {
      scope, bleAddress: 'AA:BB:CC:DD:EE:FF', firmwareVersion: 'v8', sdkVersion: 'v8sdk2.0',
      ready: true, native: true, physical: true,
    })
    expect(captured.records).toHaveLength(3)
    expect(api.syncWorkoutHistoryCertification).toHaveBeenCalledTimes(1)
    expect(api.writeWorkoutCertificationSnapshot.mock.calls.map(([options]) => JSON.parse(options.json).state))
      .toEqual(['ACQUIRING', 'CAPTURED', 'CAPTURED'])
    await expect(decodePhysicalWorkoutHistory(acquisition, entries, { ...scope, accountId: 'another-owner' }))
      .rejects.toThrow('ancestry')
    await expect(decodePhysicalWorkoutHistory({ ...acquisition, partial: true }, entries, scope))
      .rejects.toThrow('incomplete')
  })

  it('does not promote mismatched activity summaries and rejects any unexpected activity type', () => {
    const mismatched = activityResult({ steps: '56' })
    const result = buildActivitySemanticReport(mismatched.acquisition, mismatched.sources, isolation())
    expect(result.classifications.DAILY_STEPS).toBe('PHYSICAL_EVIDENCE_INSUFFICIENT')

    const prohibited: ActivityResult = {
      acquisitionSessionId: 'bad-session',
      results: [syncResult('27', [])],
    }
    expect(() => buildActivitySemanticReport(prohibited, [], isolation())).toThrow('prohibited vendor data type')
  })

  it('persists a saved test result so a new app view can recover it by source scope', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const result = { kind: 'ACTIVITY_24_25_SEMANTIC_TEST', capturedAt: '2026-01-02T00:00:00.000Z' }
    persistPhysicalTestResult('activity', scope, result, storage)
    const workoutResult = { kind: 'WORKOUT_29_82_LINKAGE_TEST', capturedAt: '2026-01-02T00:01:00.000Z' }
    persistPhysicalTestResult('workout', scope, workoutResult, storage)

    expect(readSavedPhysicalTestResult<typeof result>('activity', scope, storage)).toEqual(result)
    expect(readSavedPhysicalTestResult<typeof workoutResult>('workout', scope, storage)).toEqual(workoutResult)
  })

  it('persists one-shot acquisition claims per journal scope', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }

    expect(hasPhysicalTestAttempt('activity', scope, storage)).toBe(false)
    markPhysicalTestAttempt('activity', scope, storage)
    expect(hasPhysicalTestAttempt('activity', scope, storage)).toBe(true)
    expect(hasPhysicalTestAttempt('workout', scope, storage)).toBe(false)
  })

  it('keeps Type82 packet ancestry and refuses canonical workout mapping without proven linkage', () => {
    const started = {
      sessionId: 'live-session',
      deviceId: 'device-1',
      activityType: 'RUN',
      vendorActivityMode: 0,
      startedAt: '2026-01-01T10:00:00.000Z',
      stoppedAt: null,
      status: 'RUNNING' as const,
      packetCount: 0,
      firstPacketAt: null,
      lastPacketAt: null,
      heartbeatAttemptCount: 0,
      heartbeatSentCount: 0,
      heartbeatSkippedCount: 0,
      heartbeatIntervalMs: 1000,
      firmwareVersion: 'v8',
      sdkVersion: 'v8sdk2.0',
      parseErrors: [],
    }
    const stopped = { ...started, status: 'STOPPED' as const, stoppedAt: '2026-01-01T10:01:00.000Z' }
    const packet: LiveWorkoutPacket = {
      sessionId: 'live-session',
      receivedAt: '2026-01-01T10:00:30.000Z',
      vendorTimestamp: null,
      packetSequence: 1,
      heartRate: 100,
      elapsedSeconds: 30,
      exerciseTimeRaw: '30',
      exerciseTimeMetricType: 'WORKOUT_ELAPSED_SECONDS',
      exerciseTimeUnit: 'second',
      exerciseTimeValidationStatus: 'CONFIRMED_HARDWARE',
      steps: 5,
      calories: 1,
      distance: null,
      pace: null,
      mets: null,
      rssi: null,
      temperature: null,
      spo2: null,
      rawVendorPayload: { hr: 100 },
      provenance: { sourceEnvelopeId: 'type82-source', sourceCallbackId: 'type82-callback' },
    }
    const result = buildWorkoutSemanticReport(started, stopped, [packet], null, null, isolation())

    expect(result.type82.hrSamples).toHaveLength(1)
    expect(result.type82.sourceEnvelopeIds).toEqual(['type82-source'])
    expect(result.type29.decoder).toBe('NOT_APPLIED_NO_PHYSICAL_RECORD')
    expect(result.linkageEvidence.explicitSharedSessionIdentity).toBe(false)
    expect(result.result).toBe('LINKAGE_NOT_PROVEN')
    expect(result.canonicalMappingAllowed).toBe(false)
  })

  it('runs only the controlled workout lifecycle and preserves Type82 packet sequence', async () => {
    const started = {
      sessionId: 'live-session', deviceId: 'device-1', activityType: 'RUN', vendorActivityMode: 0,
      startedAt: '2026-01-01T10:00:00.000Z', stoppedAt: null, status: 'RUNNING' as const,
      packetCount: 0, firstPacketAt: null, lastPacketAt: null, heartbeatAttemptCount: 0,
      heartbeatSentCount: 0, heartbeatSkippedCount: 0, heartbeatIntervalMs: 1000,
      firmwareVersion: 'v8', sdkVersion: 'v8sdk2.0', parseErrors: [],
    }
    const stopped = { ...started, status: 'STOPPED' as const, stoppedAt: '2026-01-01T10:01:00.000Z' }
    const packet: LiveWorkoutPacket = {
      sessionId: 'live-session', receivedAt: '2026-01-01T10:00:30.000Z', vendorTimestamp: null,
      packetSequence: 1, heartRate: 100, elapsedSeconds: 30, exerciseTimeRaw: '30',
      steps: 5, calories: 1, distance: null, pace: null, mets: null, rssi: null,
      temperature: null, spo2: null, rawVendorPayload: {},
    }
    let packetListener: ((value: LiveWorkoutPacket) => void) | null = null
    const remove = vi.fn(async () => undefined)
    const api = {
      addWorkoutPacketListener: vi.fn(async (listener: (value: LiveWorkoutPacket) => void) => {
        packetListener = listener
        return { remove }
      }),
      startWorkoutCapture: vi.fn(async (options: { activityMode: number }) => {
        expect(options).toEqual({ activityMode: 0 })
        packetListener?.(packet)
        return started
      }),
      stopWorkoutCapture: vi.fn(async () => stopped),
      getWorkoutCaptureStatus: vi.fn(async () => stopped),
    }
    const delay = vi.fn(async (duration: number) => { expect(duration).toBe(60_000) })

    const outcome = await captureControlledWorkout(api, 60_000, delay)

    expect(api.addWorkoutPacketListener).toHaveBeenCalledTimes(1)
    expect(api.startWorkoutCapture).toHaveBeenCalledTimes(1)
    expect(api.stopWorkoutCapture).toHaveBeenCalledTimes(1)
    expect(api.getWorkoutCaptureStatus).not.toHaveBeenCalled()
    expect(remove).toHaveBeenCalledTimes(1)
    expect(outcome.packets).toEqual([packet])
  })
})
