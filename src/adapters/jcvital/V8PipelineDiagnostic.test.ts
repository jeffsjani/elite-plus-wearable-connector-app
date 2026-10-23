import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { ackChain, acquisitionOutcome, classifyInstall, compareAccountScopes, NORMAL_SYNC_AUDIT,
  parseServerAudit, queueIngress, registrationEvidence, rootCauses, sourceTimes, summarizeQueue, timestampAuthority,
  type IdentityScope, type NativeAcquisition } from './V8PipelineDiagnostic'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import type { PipelineEvent } from '../../services/diagnostics/PipelineTrace'

const identities: IdentityScope[] = ['auth', 'persisted', 'deviceScope', 'registration', 'physical', 'receiving']
  .map((scope) => ({ scope, owner: 'athlete-a', authority: 'TEST' }))
const run: NativeAcquisition = { syncId: 'sync', sdkCommand: 'GetDynamicHRWithMode', vendorDataType: '27',
  startedAt: '2026-10-07T00:00:00Z', completedAt: '2026-10-07T00:01:00Z', completionStatus: 'COMPLETE',
  physicalCallbacksReceived: 2, recordsParsed: 1, recordsStored: null, recordsDeduplicated: 0, recordsRejected: 0,
  earliestSourceTimestamp: '2026-10-07T00:00:00Z', latestSourceTimestamp: '2026-10-07T00:00:00Z',
  latestVendorDeviceTimestamp: '2026-10-07T00:00:00Z', terminalCondition: 'VENDOR_END_TRUE' }
const baseline = { timestamp: '2026-09-14T00:00:00Z', authority: 'VENDOR_DEVICE_TIMESTAMP', field: 'observedAt' } as const
function delivery(overrides: Partial<BatchDeliveryEvent> = {}): BatchDeliveryEvent {
  return { batchId: 'b', attemptedAt: '2026-10-07T00:00:00Z', outcome: 'DELIVERED', observationIds: ['o'],
    acknowledgedIds: ['o'], rejectedIds: [], httpStatus: 200, errorCode: null, accepted: 1, duplicate: 0, rejected: 0, ...overrides }
}
function event(stage: PipelineEvent['stage'], evidence: PipelineEvent['evidence']): PipelineEvent {
  return { stage, at: '2026-10-07T00:00:00Z', evidence }
}
function record(state: QueueRecord['state'] = 'PENDING'): QueueRecord {
  return { queueId: 'q', observationId: 'o', ownerUserId: 'a', state,
    createdAt: '2026-10-07T00:00:00Z', updatedAt: '2026-10-07T00:00:00Z', claimedAt: null,
    attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null, lastErrorMessage: null,
    batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
    payload: { observationId: 'o', source: 'JCVITAL', metric: 'heartRate', vendorDataType: '27', valueNumber: 70,
      unit: 'bpm', startTime: '2026-09-14T00:00:00Z', timezone: 'UTC', capturedAt: '2026-10-07T00:00:00Z', provider: 'JCVITAL' } }
}

describe('Build 32A account binding', () => {
  it('matches six evidenced owner scopes', () => expect(compareAccountScopes(identities).result).toBe('ACCOUNT_BINDING_MATCH'))
  it('reports the exact conflicting identities without rebinding', () => {
    const result = compareAccountScopes([...identities.slice(0, 5), { scope: 'receiving', owner: 'athlete-b', authority: 'SERVER' }])
    expect(result.result).toBe('ACCOUNT_BINDING_MISMATCH')
    expect(result.conflicts[0]).toMatchObject({ left: { owner: 'athlete-a' }, right: { scope: 'receiving', owner: 'athlete-b' } })
    expect(result.automaticRebinding).toBe(false)
  })
  it('never claims a match from local context alone', () => expect(compareAccountScopes(identities.slice(0, 3)).result).toBe('ACCOUNT_BINDING_INDETERMINATE'))
  it('keeps missing remote identities indeterminate', () => expect(compareAccountScopes([...identities.slice(0, 5), { scope: 'physical', owner: null, authority: 'UNKNOWN' }]).result).toBe('ACCOUNT_BINDING_INDETERMINATE'))
  it('classifies Build 5 diag-device without deleting it', () => expect(classifyInstall({ deviceId: 'diag-device' })).toBe('DIAGNOSTIC_INSTALL'))
  it('classifies physical PRO_V8 only with physical identity evidence', () => expect(classifyInstall({ physicalBleId: 'AA:BB:CC:DD:EE:FF', model: 'PRO_V8' })).toBe('PHYSICAL_PRODUCTION_DEVICE'))
  it('does not claim an opaque scope is a physical device', () => expect(classifyInstall({ deviceId: 'jcvital_device_x', model: 'PRO_V8' })).toBe('UNKNOWN'))
  it('preserves legacy test classification', () => expect(classifyInstall({ deviceId: '__queue_self_test__:a' })).toBe('LEGACY_TEST_INSTALL'))
  it('whitelists registration identity evidence and excludes tokens', () => {
    const response = { success: true, connectorDeviceId: 'c', installId: 'i', status: 'registered', registeredAt: 'r', serverTimestamp: 's', sources: [],
      ownerUserId: 'server-a', token: 'secret' }
    const evidence = registrationEvidence(response, 'local-a')
    expect(evidence.serverOwners[0].owner).toBe('server-a')
    expect(JSON.stringify(evidence)).not.toContain('secret')
  })
})

describe('Build 32A acquisition and timestamp authority', () => {
  it('reports the exact production delivery-only call chain', () => {
    expect(NORMAL_SYNC_AUDIT.behavior).toBe('C_DELIVER_QUEUED_OBSERVATIONS_ONLY')
    expect(NORMAL_SYNC_AUDIT.callChain.join(' ')).toContain('App.syncNow → runNormalProductionSync')
    expect(NORMAL_SYNC_AUDIT.nativePluginMethods).toEqual([])
    expect(NORMAL_SYNC_AUDIT.bleCommands).toEqual([])
    expect(NORMAL_SYNC_AUDIT.scheduler.every((source) => !source.automaticAcquisition)).toBe(true)
  })
  it('reports acquisition not invoked', () => expect(acquisitionOutcome(undefined, baseline)).toBe('ACQUISITION_NOT_RUN'))
  it('reports no records returned', () => expect(acquisitionOutcome({ ...run, recordsParsed: 0 }, baseline)).toBe('NO_NEW_DEVICE_DATA'))
  it('reports newer device data', () => expect(acquisitionOutcome(run, baseline)).toBe('NEW_DEVICE_DATA_FOUND'))
  it('reports retained older history rather than assuming a defect', () => expect(acquisitionOutcome(run, { ...baseline, timestamp: '2026-10-08T00:00:00Z' })).toBe('NO_NEW_DEVICE_DATA'))
  it('requires a vendor timestamp baseline for newer-data comparison', () => expect(acquisitionOutcome(run, { ...baseline, authority: 'CAPTURE_TIMESTAMP' })).toBe('INSUFFICIENT_EVIDENCE'))
  it('does not hide partial acquisition failure', () => expect(acquisitionOutcome({ ...run, completionStatus: 'PARTIAL' }, baseline)).toBe('ACQUISITION_FAILED'))
  it.each([
    [{ timestampSource: 'DEVICE_HISTORY_RECORD_TIME', observedAtSource: '2026.10.04' }, 'VENDOR_DEVICE_TIMESTAMP'],
    [{ timestampSource: 'DEVICE_HISTORY_RECORD_TIME_PLUS_NOMINAL_INTERVAL', observedAtSource: '2026.10.04' }, 'ELITE_PLUS_INFERRED_TIMESTAMP'],
    [{ field: 'capturedAt' }, 'CAPTURE_TIMESTAMP'], [{ field: 'receivedAt' }, 'RECEIVED_AT'],
    [{ field: 'certificationTimestamp' }, 'CERTIFICATION_TIMESTAMP'], [{ certificationOnly: true }, 'UNKNOWN'],
    [{ certificationOnly: true, timestampSource: 'DEVICE_HISTORY_RECORD_TIME', observedAtSource: '2026.10.04' }, 'VENDOR_DEVICE_TIMESTAMP'],
  ])('classifies timestamp authority %j', (input, expected) => expect(timestampAuthority(input)).toBe(expected))
  it('does not propagate the Type42/PPI Oct.4 capture time as source time', () => {
    const audit = parseServerAudit(JSON.stringify({ latestByType: { '42': { timestamp: '2026-10-04T00:00:00Z', authority: 'CAPTURE_TIMESTAMP', field: 'capturedAt' } } }))
    const source = sourceTimes([], null, audit).find((row) => row.vendorDataType === '42')!
    expect(source.base44Latest).toBe('2026-10-04T00:00:00Z')
    expect(source.correctedLatestSourceTime).toBeNull()
  })
  it('rejects mislabeled receivedAt authority in imported evidence', () => expect(() => parseServerAudit(JSON.stringify({
    latestByType: { '127': { timestamp: baseline.timestamp, authority: 'VENDOR_DEVICE_TIMESTAMP', field: 'receivedAt' } },
  }))).toThrow('TIMESTAMP_AUTHORITY_CONFLICT'))
  it('rejects malformed audit timestamps', () => expect(() => parseServerAudit('{"latestByType":{"42":{"timestamp":"not a date"}}}')).toThrow())
})

describe('Build 32A queue, delivery and root-cause evidence', () => {
  it('reports a new observation durably enqueued', () => expect(queueIngress([{ observationId: 'o', metric: 'heartRate' }], new Set(['o']), new Set(['o']))[0].classification).toBe('ACQUIRED_AND_ENQUEUED'))
  it('reports acquired but not enqueued', () => expect(queueIngress([{ observationId: 'o', metric: 'heartRate' }], new Set(['o']), new Set())[0].classification).toBe('ACQUIRED_BUT_NOT_ENQUEUED'))
  it('counts every queue state, not only eligible rows', () => {
    const states = ['PENDING', 'IN_FLIGHT', 'RETRY_WAIT', 'FAILED_PERMANENT', 'ACKNOWLEDGED', 'CANONICAL_RECOVERY_REQUIRED'] as const
    expect(summarizeQueue(states.map(record))).toMatchObject({ total: 6, pending: 1, inFlight: 1, retrying: 1, failed: 1, acknowledgedAwaitingPurge: 1, canonicalRecoveryRequired: 1 })
  })
  it('identifies stuck rows and repeated retries', () => expect(summarizeQueue([{ ...record('IN_FLIGHT'), attemptCount: 4 }], Date.parse('2026-10-07T00:05:00Z'))).toMatchObject({ stuckRows: ['o'], repeatedlyRetried: ['o'] }))
  it('verifies accepted, matched, ACK and purge as separate stages', () => {
    const chain = ackChain([event('SEND', { batchId: 'b' }), event('RESPONSE', { batchId: 'b', accepted: 1, results: [{ observationId: 'o', status: 'accepted' }] }),
      event('ACK', { count: 1 }), event('PURGE', { count: 1 })], [delivery()])
    expect(chain).toMatchObject({ deliveryAttempts: 1, serverAccepted: 1, resultMatched: 1, queueAck: 1, purged: 1, serverAcceptedLocalAckFailed: false })
  })
  it('classifies server accepted/local ACK failed separately', () => expect(ackChain([event('RESPONSE', { accepted: 1 })], [delivery({ errorCode: 'ACK_PROCESSING_FAILED', outcome: 'RETRYING' })]).serverAcceptedLocalAckFailed).toBe(true))
  it('does not count server rejection as acceptance', () => expect(ackChain([event('RESPONSE', { accepted: 0, rejected: 1, results: [{ status: 'rejected' }] })], [delivery({ rejected: 1 })])).toMatchObject({ serverAccepted: 0, resultMatched: 0 }))
  it('does not count unmatched server result IDs as matched rows', () => expect(ackChain([
    event('RESPONSE', { batchId: 'b', accepted: 1, results: [{ observationId: 'foreign', status: 'accepted' }] }),
  ], [delivery()]).resultMatched).toBe(0))
  const healthy = { binding: 'ACCOUNT_BINDING_MATCH', ran: true, commands: 1, runs: [run], queueBlocked: false, queued: 1, deliveries: [delivery()] } as const
  it('reports no acquisition even when delivery succeeds', () => expect(rootCauses({ ...healthy, runs: [], commands: 0 }).classification).toBe('A2 — CONNECTOR_DID_NOT_REQUEST_DATA'))
  it('preserves concurrent account and acquisition causes', () => expect(rootCauses({ ...healthy, binding: 'ACCOUNT_BINDING_MISMATCH', runs: [], commands: 0 })).toMatchObject({ classification: 'D — MULTIPLE_CONCURRENT_CAUSES', causes: ['C — ACCOUNT_BINDING_MISMATCH', 'A2 — CONNECTOR_DID_NOT_REQUEST_DATA'] }))
  it('identifies queue blocked', () => expect(rootCauses({ ...healthy, queueBlocked: true }).classification).toBe('B2 — QUEUE_BLOCKED'))
  it('requires terminal evidence before concluding the device has no newer data', () => expect(rootCauses({ ...healthy, deviceHasNoNewData: true }).classification).toBe('A1 — DEVICE_HAS_NO_NEW_DATA'))
  it('identifies delivery not triggered', () => expect(rootCauses({ ...healthy, deliveries: [] }).classification).toBe('B3 — DELIVERY_NOT_TRIGGERED'))
  it('identifies rejected delivery', () => expect(rootCauses({ ...healthy, deliveries: [delivery({ outcome: 'PARTIAL', rejected: 1 })] }).classification).toBe('B4 — DELIVERY_FAILED'))
  it('identifies accepted/local ACK failure', () => expect(rootCauses({ ...healthy, deliveries: [delivery({ errorCode: 'ACK_PROCESSING_FAILED' })] }).classification).toBe('B5 — SERVER_ACCEPTED_LOCAL_ACK_FAILED'))
  it('does not declare healthy before executing', () => expect(rootCauses({ ...healthy, ran: false }).classification).toBe('F — INSUFFICIENT_EVIDENCE'))
  it('identifies parse/persistence failure', () => expect(rootCauses({ ...healthy, runs: [{ ...run, recordsRejected: 1 }] }).classification).toBe('A4 — CONNECTOR_PARSE/PERSISTENCE_FAILURE'))
  it('identifies requested but empty acquisition', () => expect(rootCauses({ ...healthy, runs: [{ ...run, recordsParsed: 0 }] }).classification).toBe('A3 — CONNECTOR_REQUESTED_BUT_DEVICE_RETURNED_NO_DATA'))
  it('identifies queue ingress failure', () => expect(rootCauses({ ...healthy, ingressFailed: true }).classification).toBe('B1 — ACQUIRED_BUT_NOT_ENQUEUED'))
  it('requires owner and acquisition evidence before declaring the pipeline healthy', () => expect(rootCauses(healthy).classification).toBe('E — PIPELINE_HEALTHY_AFTER_NORMAL_SYNC'))
  it('keeps history date/window and scoring semantics frozen', () => {
    expect(NORMAL_SYNC_AUDIT.history).toMatchObject({ hardCodedStartDate: false, fixedLookback: false, persistedPagingCursor: false, dateArgument: 'EMPTY_STRING' })
    const sync = readFileSync(new URL('../../services/sync/NormalProductionSync.ts', import.meta.url), 'utf8')
    expect(sync).not.toMatch(/syncHistorical|startWorkout|canonical|scoring/)
    const config = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')
    expect(config).toContain("engineering ? 'PipelineDiagnosticV8Panel.tsx' : 'ElitePlusV8Panel.tsx'")
    const production = readFileSync(new URL('./ElitePlusV8Panel.tsx', import.meta.url), 'utf8')
    expect(production).not.toContain('PipelineDiagnostic')
  })
})
