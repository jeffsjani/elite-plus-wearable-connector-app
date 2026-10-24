import { describe, expect, it } from 'vitest'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import { summarizeActivityV2QueueBacklog } from './ActivityV2QueueBacklogDiagnostic'

function record(overrides: Partial<QueueRecord> = {}): QueueRecord {
  return {
    queueId: 'queue-1',
    ownerUserId: 'owner-private',
    observationId: 'observation-private',
    payload: {
      observationId: 'observation-private',
      source: 'wearable',
      metric: 'heartRate',
      valueNumber: 70,
      unit: 'bpm',
      startTime: '2026-10-20T10:00:00.000Z',
      observedAt: '2026-10-20T10:00:00.000Z',
      timezone: 'UTC',
      capturedAt: '2026-10-20T10:00:00.000Z',
      provider: 'JCVITAL',
      deviceId: 'device-private',
      vendorDataType: '27',
      vendorField: 'heart_rate',
      acquisitionMode: 'HISTORICAL_SYNC',
    },
    state: 'PENDING',
    createdAt: '2026-10-21T10:00:00.000Z',
    updatedAt: '2026-10-21T10:00:00.000Z',
    claimedAt: null,
    attemptCount: 0,
    nextAttemptAt: null,
    lastAttemptAt: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    batchId: null,
    acknowledgedAt: null,
    nativeObservationId: null,
    canonicalFailureAt: null,
    ...overrides,
  }
}

describe('Activity V2 read-only queue backlog summary', () => {
  it('aggregates pending rows, lifecycle metadata, types and redacted owner/device counts', () => {
    const source = [
      record(),
      record({
        queueId: 'queue-2',
        observationId: 'activity-id',
        ownerUserId: 'owner-private',
        createdAt: '2026-10-22T10:00:00.000Z',
        attemptCount: 2,
        lastAttemptAt: '2026-10-23T10:00:00.000Z',
        lastErrorCode: 'HTTP_503',
        lastErrorMessage: 'server unavailable',
        payload: {
          ...record().payload,
          observationId: 'activity-id',
          metric: 'DAILY_STEPS',
          vendorDataType: '24',
          vendorField: undefined,
          deviceId: 'device-private',
          rawSourceMetadata: { activityTransportVersion: 'activity-v2' },
        },
      }),
      record({
        queueId: 'queue-3',
        observationId: 'cert-id',
        state: 'RETRY_WAIT',
        payload: { ...record().payload, rawSourceMetadata: { certificationOnly: true } },
      }),
      record({
        queueId: 'queue-4',
        observationId: 'auth-id',
        lastErrorCode: 'AUTH_REQUIRED',
        lastErrorMessage: 'authentication required',
      }),
      record({
        queueId: 'queue-5',
        observationId: 'network-id',
        lastErrorCode: 'NETWORK_TIMEOUT',
        lastErrorMessage: 'network timeout',
      }),
      record({
        queueId: 'queue-6',
        observationId: 'inflight-id',
        state: 'IN_FLIGHT',
      }),
      record({
        queueId: 'queue-7',
        observationId: 'failed-id',
        state: 'FAILED_PERMANENT',
      }),
      record({
        queueId: 'queue-8',
        observationId: 'ack-id',
        state: 'ACKNOWLEDGED',
      }),
    ]

    const summary = summarizeActivityV2QueueBacklog(source)
    expect(summary).toMatchObject({
      QUEUE_TOTAL: 8,
      QUEUE_PENDING: 4,
      QUEUE_RETRY_WAIT: 1,
      QUEUE_IN_FLIGHT: 1,
      QUEUE_FAILED_PERMANENT: 1,
      QUEUE_OTHER: 1,
      OLDEST_PENDING_CREATED_AT: '2026-10-21T10:00:00.000Z',
      NEWEST_PENDING_CREATED_AT: '2026-10-22T10:00:00.000Z',
      QUEUE_BACKLOG_CLASSIFICATION: 'MIXED',
      SYNTHETIC_OR_CERTIFICATION_COUNT: 0,
      ACTIVITY_COUNT: 1,
      PHYSIOLOGY_COUNT: 3,
      OTHER_COUNT: 0,
      HISTORICAL_SYNC_COUNT: 4,
      EXPLICIT_TEST_OR_DEVELOPMENT_MARKER_COUNT: 0,
      FAILED_TEST_OR_DEVELOPMENT_MARKER_COUNT: 0,
      PENDING_NEVER_ATTEMPTED: 3,
      PENDING_PREVIOUSLY_ATTEMPTED: 1,
      AUTH_RELATED_COUNT: 1,
      NETWORK_ERROR_COUNT: 1,
      SERVER_ERROR_COUNT: 1,
      OTHER_ERROR_COUNT: 0,
    })
    expect(summary.PENDING_BY_OBSERVATION_TYPE[0]).toMatchObject({
      key: 'heartRate / type 27',
      count: 3,
    })
    expect(summary.PENDING_BY_SOURCE_OR_PROVIDER).toEqual([{ key: 'JCVITAL', count: 4 }])
    expect(summary.PENDING_BY_OWNER).toEqual({
      distinctCount: 1,
      counts: [{ label: '1', count: 4 }],
    })
    expect(summary.PENDING_BY_DEVICE).toEqual({
      distinctCount: 1,
      counts: [{ label: '1', count: 4 }],
    })
    expect(JSON.stringify(summary)).not.toContain('owner-private')
    expect(JSON.stringify(summary)).not.toContain('device-private')
    expect(JSON.stringify(summary)).not.toContain('observation-private')
  })

  it('returns unknown provenance rather than inferring it from generic queue rows', () => {
    const summary = summarizeActivityV2QueueBacklog([
      record({ payload: { ...record().payload, vendorDataType: undefined, vendorField: undefined, acquisitionMode: undefined } }),
    ])
    expect(summary).toMatchObject({
      QUEUE_BACKLOG_CLASSIFICATION: 'UNKNOWN',
      SYNTHETIC_OR_CERTIFICATION_COUNT: 0,
      ACTIVITY_COUNT: 0,
      PHYSIOLOGY_COUNT: 0,
      OTHER_COUNT: 1,
      HISTORICAL_SYNC_COUNT: 0,
    })
  })

  it('caps observation-type detail at the top 20 groups', () => {
    const summary = summarizeActivityV2QueueBacklog(Array.from({ length: 25 }, (_, index) => record({
      queueId: `queue-${index}`,
      observationId: `observation-${index}`,
      payload: { ...record().payload, metric: `metric-${index}` },
    })))
    expect(summary.PENDING_BY_OBSERVATION_TYPE).toHaveLength(20)
    expect(summary.PENDING_BY_OBSERVATION_TYPE[0]).toMatchObject({ key: 'metric-0 / type 27', count: 1 })
  })
})
