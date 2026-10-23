import { beforeEach, describe, expect, it, vi } from 'vitest'
import { tracePipeline } from '../../services/diagnostics/PipelineTrace'
import type { BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import { observationBatchManager } from '../../services/sync/ObservationBatchManager'
import { JCVitalV8 } from './jcvitalV8Bridge'
import { pipelineSnapshot, preSyncReport, resetPipelineGuard, runPipelineDiagnostic,
  interpretReport, restorePipelineReport, type PipelineReport } from './V8PipelineDiagnosticService'

const mocks = vi.hoisted(() => ({
  active: 0,
  subscribers: new Set<(event: BatchDeliveryEvent) => void>(),
  process: vi.fn(),
}))
vi.mock('../../buildMode', () => ({ IS_ENGINEERING_BUILD: true }))
vi.mock('../../services/base44/AuthenticationService', () => ({ authenticationService: { getCurrentUser: async () => ({ id: 'a' }) } }))
vi.mock('../../services/base44/ConnectorIdentityService', () => ({ connectorIdentityService: { getConnectorDeviceId: () => 'connector' } }))
vi.mock('../../services/storage/InstallationIdentityService', () => ({ installationIdentityService: { getInstallId: () => 'install' } }))
vi.mock('../../services/storage/JCVitalDeviceIdentityService', () => ({ jcvitalDeviceIdentityService: { find: () => 'device' } }))
vi.mock('../../services/sync/ObservationQueue', () => ({ observationQueue: {
  getOwnerUserId: () => 'a', listDiagnosticRecords: async () => [], getQueueStats: async () => ({ pending: 0 }),
  getDiagnostics: () => ({ queueStoreInitialized: true }),
} }))
vi.mock('../../services/sync/ObservationBatchManager', () => ({ observationBatchManager: {
  process: mocks.process, getDeliveryDiagnostics: () => ({ activeWorkerCount: mocks.active, activeBatch: null, activeBatches: [],
    pauseReason: null, queuePausedForCanonicalFailure: false }),
  subscribe: (listener: (event: BatchDeliveryEvent) => void) => { mocks.subscribers.add(listener); return () => mocks.subscribers.delete(listener) },
} }))
vi.mock('./jcvitalV8Bridge', () => ({ JCVitalV8: {
  addListener: vi.fn(async () => ({ remove: async () => undefined })),
  getPipelineDiagnosticSnapshot: vi.fn(async () => ({
    connectionState: 'READY', physicalDeviceId: 'AA:BB:CC:DD:EE:FF', deviceInfo: { deviceName: 'PRO_V8' },
    activeScope: { accountId: 'a', deviceScopeId: 'device' }, workout: { status: 'IDLE' },
    commands: [], acquisitions: [], lastCommandSequence: 0, droppedCommands: 0,
    storage: { retainedScopes: [], sourceRecords: [], queueOwners: [] },
  })),
  syncHistoricalHeartRate: vi.fn(), startWorkoutCapture: vi.fn(),
} }))

function storage(): Storage {
  const entries = new Map<string, string>()
  return { get length() { return entries.size }, key: (index) => [...entries.keys()][index] ?? null,
    getItem: (key) => entries.get(key) ?? null, setItem: (key, value) => { entries.set(key, value) },
    removeItem: (key) => { entries.delete(key) }, clear: () => entries.clear() }
}
beforeEach(() => {
  vi.stubGlobal('sessionStorage', storage())
  vi.stubGlobal('localStorage', storage())
  mocks.active = 0
  mocks.subscribers.clear()
  mocks.process.mockReset().mockResolvedValue(null)
})

describe('one controlled normal production sync', () => {
  it('runs only the existing production sender and records no acquisition', async () => {
    const report = await runPipelineDiagnostic(await pipelineSnapshot(null), null, null, () => undefined)
    expect(mocks.process).toHaveBeenCalledTimes(1)
    expect(JCVitalV8.syncHistoricalHeartRate).not.toHaveBeenCalled()
    expect(JCVitalV8.startWorkoutCapture).not.toHaveBeenCalled()
    expect(interpretReport(report).acquisitionRuns).toEqual([])
    expect(interpretReport(report).rootCause.classification).toBe('A2 — CONNECTOR_DID_NOT_REQUEST_DATA')
  })
  it('prevents rapid repeated diagnostics and requires export before reset', async () => {
    const pre = await pipelineSnapshot(null)
    await runPipelineDiagnostic(pre, null, null, () => undefined)
    await expect(runPipelineDiagnostic(pre, null, null, () => undefined)).rejects.toThrow('NORMAL_SYNC_DIAGNOSTIC_ALREADY_RUN')
    expect(() => resetPipelineGuard(false)).toThrow('PIPELINE_EXPORT_REQUIRED')
    resetPipelineGuard(true)
    await runPipelineDiagnostic(pre, null, null, () => undefined)
    expect(mocks.process).toHaveBeenCalledTimes(2)
  })
  it('does not issue any sender trigger before READY', async () => {
    const pre = await pipelineSnapshot(null)
    await expect(runPipelineDiagnostic({ ...pre, connectionState: 'DISCONNECTED' }, null, null, () => undefined)).rejects.toThrow('REQUIRES_READY')
    expect(mocks.process).not.toHaveBeenCalled()
  })
  it('requires preserving/exporting a mismatch before running normal Sync', async () => {
    const pre = await pipelineSnapshot(null)
    pre.binding.result = 'ACCOUNT_BINDING_MISMATCH'
    await expect(runPipelineDiagnostic(pre, null, null, () => undefined)).rejects.toThrow('ACCOUNT_BINDING_MISMATCH_EXPORT_FIRST')
    expect(mocks.process).not.toHaveBeenCalled()
    await runPipelineDiagnostic(pre, null, null, () => undefined, true)
    expect(mocks.process).toHaveBeenCalledTimes(1)
  })
  it('waits for the production auto-drain after the first process promise resolves', async () => {
    mocks.process.mockImplementation(async () => {
      mocks.active = 1
      setTimeout(() => {
        tracePipeline('SEND', { batchId: 'b' })
        tracePipeline('RESPONSE', { batchId: 'b', accepted: 1, results: [{ observationId: 'o', status: 'accepted', nativeObservationId: 'native' }] })
        tracePipeline('ACK', { count: 1 })
        tracePipeline('PURGE', { count: 1 })
        for (const listener of mocks.subscribers) listener({ batchId: 'b', attemptedAt: '2026-10-07T00:00:00Z',
          observationIds: ['o'], acknowledgedIds: ['o'], rejectedIds: [], outcome: 'DELIVERED',
          httpStatus: 200, accepted: 1, duplicate: 0, rejected: 0, errorCode: null })
        mocks.active = 0
      }, 50)
      return null
    })
    const report = await runPipelineDiagnostic(await pipelineSnapshot(null), null, null, () => undefined)
    expect(interpretReport(report).ackPurgeResults).toMatchObject({ serverAccepted: 1, queueAck: 1, purged: 1 })
    expect(report.deliveries).toHaveLength(1)
    expect(await restorePipelineReport()).toMatchObject({ state: 'COMPLETE', deliveries: [{ batchId: 'b' }] })
  })
  it('retains sender failure rather than returning success-shaped evidence', async () => {
    mocks.process.mockRejectedValue(new Error('network failure'))
    const report = await runPipelineDiagnostic(await pipelineSnapshot(null), null, null, () => undefined)
    expect(report.state).toBe('FAILED_OR_INTERRUPTED')
    expect(report.syncError).toBe('network failure')
    expect(report.post).not.toBeNull()
    expect(interpretReport(report).rootCause.causes).toContain('B4 — DELIVERY_FAILED')
  })
  it('refuses a controlled run while the existing sender is active without pausing it', async () => {
    mocks.active = 1
    const pre = await pipelineSnapshot(null)
    // The worker may be awaiting a queue read before an activeBatch is published.
    pre.delivery.activeWorkerCount = 1
    expect(observationBatchManager.getDeliveryDiagnostics().activeWorkerCount).toBe(1)
    await expect(runPipelineDiagnostic(pre, null, null, () => undefined)).rejects.toThrow('WAIT_FOR_EXISTING_DELIVERY')
    expect(mocks.process).not.toHaveBeenCalled()
  })
  it('keeps absent remote ownership UNKNOWN and physical classification independent', async () => {
    const pre = await pipelineSnapshot(null)
    expect(pre.binding.result).toBe('ACCOUNT_BINDING_INDETERMINATE')
    expect(pre.identity.currentInstallClass).toBe('PHYSICAL_PRODUCTION_DEVICE')
  })
  it('does not apply timestamps from an unrelated Base44 device', async () => {
    const pre = await pipelineSnapshot({ intendedOwnerUserId: 'a', nativeConnectorOwnerUserId: 'a',
      physicalV8OwnerUserId: 'a', receivingAthleteUserId: 'a', connectorDeviceId: 'other', deviceScopeId: 'other',
      exportedAt: null, latestByType: { '27': { timestamp: '2026-10-07T00:00:00Z', authority: 'VENDOR_DEVICE_TIMESTAMP', field: 'observedAt' } } })
    expect(pre.identity.serverEvidenceMatchesDevice).toBe(false)
    expect(pre.latestTimestampsBySource.find((row) => row.vendorDataType === '27')?.base44Latest).toBeNull()
  })
  it('persists the before snapshot before triggering delivery', async () => {
    mocks.process.mockImplementation(async () => {
      const saved = await restorePipelineReport()
      expect(saved?.state).toBe('FAILED_OR_INTERRUPTED')
      expect(saved?.pre.connectionState).toBe('READY')
      return null
    })
    await runPipelineDiagnostic(await pipelineSnapshot(null), null, null, () => undefined)
  })
  it('builds exportable pre-sync evidence without triggering the sender', async () => {
    const pre = preSyncReport(await pipelineSnapshot(null), null, null)
    expect(pre.state).toBe('PRE_SYNC')
    expect(mocks.process).not.toHaveBeenCalled()
    const report: PipelineReport = pre
    expect(interpretReport(report).rootCause.classification).toBe('F — INSUFFICIENT_EVIDENCE')
  })
  it('links acquired evidence to a durable enqueue by exact source envelope', async () => {
    const report = preSyncReport(await pipelineSnapshot(null), null, null)
    report.events = [
      { stage: 'ACQUIRED', at: 'now', evidence: { nativeId: 'native', sourceEnvelopeId: 'envelope',
        vendorDataType: '27', metricType: 'HEART_RATE', observedAt: '2026-10-07T00:00:00Z' } },
      { stage: 'ENQUEUE_ATTEMPT', at: 'now', evidence: { observations: [{ observationId: 'mapped',
        vendorDataType: '27', metricType: 'HEART_RATE', observedAt: '2026-10-07T00:00:00Z' }] } },
      { stage: 'ENQUEUE_RESULT', at: 'now', evidence: { rows: [{ observationId: 'mapped', sourceEnvelopeId: 'envelope',
        queueRowCreated: true, queueId: 'queue', queueState: 'PENDING' }] } },
    ]
    expect(interpretReport(report).acquiredObservationIngress[0]).toMatchObject({
      classification: 'ACQUIRED_AND_ENQUEUED', enqueueAttempted: true,
    })
  })
  it('does not infer ingress from an unrelated same-time observation', async () => {
    const report = preSyncReport(await pipelineSnapshot(null), null, null)
    report.events = [
      { stage: 'ACQUIRED', at: 'now', evidence: { nativeId: 'native', sourceEnvelopeId: 'unmatched',
        vendorDataType: '27', metricType: 'HEART_RATE', observedAt: '2026-10-07T00:00:00Z' } },
      { stage: 'ENQUEUE_ATTEMPT', at: 'now', evidence: { observations: [{ observationId: 'mapped',
        vendorDataType: '27', metricType: 'HEART_RATE', observedAt: '2026-10-07T00:00:00Z' }] } },
      { stage: 'ENQUEUE_RESULT', at: 'now', evidence: { rows: [{ observationId: 'mapped', sourceEnvelopeId: 'other',
        queueRowCreated: true, queueId: 'queue', queueState: 'PENDING' }] } },
    ]
    expect(interpretReport(report).acquiredObservationIngress[0].classification).toBe('ACQUIRED_BUT_NOT_ENQUEUED')
  })
})
