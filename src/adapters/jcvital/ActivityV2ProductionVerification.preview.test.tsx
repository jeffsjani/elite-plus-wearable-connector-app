// @vitest-environment jsdom
import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listDiagnosticRecords: vi.fn(),
  getQueueStats: vi.fn(),
  getDeliveryDiagnostics: vi.fn(),
  getDiagnostics: vi.fn(),
  enqueueMany: vi.fn(),
  process: vi.fn(),
  saveReport: vi.fn(),
  loadReport: vi.fn(),
  prepare: vi.fn(),
  enqueueActivity: vi.fn(),
  deliverScopedActivityE2E: vi.fn(),
  base44ObservationCall: vi.fn(),
  acquireActivity: vi.fn(),
}))

vi.mock('../../services/base44/ActivityV2Capability', () => ({
  activityV2CapabilityStore: {
    getDecision: () => ({
      capabilitySupported: true,
      productionDeliveryEnabled: true,
      reason: 'CAPABILITY_SUPPORTED',
      capabilityReceived: true,
      evaluatedAt: '2025-01-01T00:00:00.000Z',
      advertisedCapability: 'native-activity-transport-v2',
      responseContractVersion: 'v1',
      deploymentRevision: 'test',
      receivedAt: '2025-01-01T00:00:00.000Z',
      predicates: {},
    }),
  },
}))
vi.mock('../../services/base44/ConnectorIdentityService', () => ({
  connectorIdentityService: { getConnectorDeviceId: () => 'connector-1' },
}))
vi.mock('../../services/sync/ObservationQueue', () => ({
  observationQueue: {
    getOwnerUserId: () => 'owner-1',
    getDiagnostics: mocks.getDiagnostics,
    listDiagnosticRecords: mocks.listDiagnosticRecords,
    getQueueStats: mocks.getQueueStats,
    enqueueMany: mocks.enqueueMany,
  },
}))
vi.mock('../../services/sync/ObservationBatchManager', () => ({
  observationBatchManager: {
    process: mocks.process,
    deliverScopedActivityE2E: mocks.deliverScopedActivityE2E,
    getDeliveryDiagnostics: mocks.getDeliveryDiagnostics,
  },
}))
vi.mock('../../services/base44/base44Environment', () => ({
  BASE44_PRODUCTION_ENVIRONMENT: { observationsFunction: 'nativeConnectorObservations' },
  resolveConnectorFunctionUrl: () => 'https://example.invalid/nativeConnectorObservations',
}))
vi.mock('./CertificationJsonExport', () => ({ saveValidationJson: vi.fn() }))
vi.mock('./ActivityNativeTransportV2', () => ({
  ACTIVITY_NATIVE_TRANSPORT_V2: 'activity-v2',
  ACTIVITY_V2_CAPABILITY: 'native-activity-transport-v2',
}))
vi.mock('./ActivityNativeTransportV2Delivery', () => ({
  ACTIVITY_V2_VERIFICATION_SCOPE: 'scope',
  assessActivityV2Verification: vi.fn(),
  enqueueActivityNativeTransportV2: mocks.enqueueActivity,
}))
vi.mock('./ActivityV2VerificationAttempt', () => ({
  beginActivityV2VerificationAttempt: vi.fn(),
  completeActivityV2VerificationAttempt: vi.fn(),
}))
vi.mock('./ActivityV2DiagnosticReportStore', () => ({
  activityV2DiagnosticReportStore: { save: mocks.saveReport, load: mocks.loadReport },
}))
vi.mock('./ActivityV2VerificationPreparation', () => ({
  prepareActivityV2Verification: mocks.prepare,
}))

import { ActivityV2ProductionVerification } from './ActivityV2ProductionVerification'

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

describe('ActivityV2ProductionVerification preview', () => {
  let root: Root
  let container: HTMLDivElement
  let setItem: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem('installId', 'install-1')
    setItem = vi.spyOn(Storage.prototype, 'setItem')
    mocks.loadReport.mockResolvedValue(null)
    mocks.saveReport.mockResolvedValue(undefined)
    mocks.getDiagnostics.mockReturnValue({ queueStoreInitialized: true })
    mocks.getDeliveryDiagnostics.mockReturnValue({
      queuePausedForCanonicalFailure: false,
      pauseReason: null,
    })
    mocks.getQueueStats.mockResolvedValue({
      pending: 0, retrying: 0, inFlight: 0, failed: 0,
      canonicalRecoveryRequired: false, canonicalRecoveryObservationCount: 0,
    })
    mocks.listDiagnosticRecords.mockResolvedValue([])
    mocks.prepare.mockResolvedValue({
      type24: {
        source: { sourceEnvelopeId: 'type24-source', record: {
          step: 1200, distance: 0.8, calories: 32, exerciseMinutes: 600,
        } },
        details: {
          sourceEnvelopeId: 'type24-source', sourceDate: '2025-01-01',
          receivedAt: '2025-01-02T00:00:00.000Z', provider: 'JCVITAL',
          deviceScopeId: 'device-1', deviceModel: 'PRO_V8',
          acquisitionMode: 'HISTORICAL_SYNC', fields: {}, timezone: 'UTC',
        },
      },
      type25: {
        source: { sourceEnvelopeId: 'type25-source', record: {
          arraySteps: '1 2 3 4 5 6 7 8 9 10', detailMinterStep: 55,
        } },
        details: {
          sourceEnvelopeId: 'type25-source', sourceDate: '2025-01-01 12:00:00',
          receivedAt: '2025-01-02T00:00:00.000Z', provider: 'JCVITAL',
          deviceScopeId: 'device-1', deviceModel: 'PRO_V8',
          acquisitionMode: 'HISTORICAL_SYNC', firmwareVersion: '0.0.8.8',
          sdkVersion: 'v8sdk2.0', timezone: 'UTC',
          qualification: { status: 'PASS', reason: null, arrayLength: 10, arraySum: 55, declaredTotal: 55 },
        },
      },
      type25Candidate: null,
      payloads: Array.from({ length: 14 }, (_, index) => ({
        observationId: `observation-${index}`,
        metric: index < 4 ? [
          'DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES', 'DAILY_EXERCISE_DURATION',
        ][index] : 'DETAILED_ACTIVITY_EPOCH',
        vendorDataType: index < 4 ? '24' : '25',
        rawSourceMetadata: { sourceEnvelopeId: index < 4 ? 'type24-source' : 'type25-source' },
        observedAt: '2025-01-01T00:00:00.000Z',
        sequenceNumber: index < 4 ? undefined : index - 4,
        valueNumber: index + 1,
      })),
      warnings: [],
      type24FailureReason: null,
      type25FailureReason: null,
      selectionValid: true,
      sourceQueryMode: 'TARGETED_RECENT_CANDIDATES',
      type24CandidatesRead: 25,
      type25CandidatesRead: 25,
      type24SelectedIndex: 0,
      type25SelectedIndex: 2,
    })
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
    setItem.mockRestore()
  })

  it('renders all 14 shared-source observations without enqueue, sender, network, acquisition, or localStorage writes', async () => {
    await act(async () => {
      root.render(createElement(ActivityV2ProductionVerification, {
        ownerUserId: 'owner-1',
        scope: { accountId: 'owner-1', deviceScopeId: 'device-1' },
        device: {
          deviceId: 'device-1', deviceModel: 'PRO_V8',
          firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0',
        },
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const previewButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Preview Activity V2 E2E'))
    expect(previewButton).toBeDefined()
    await act(async () => {
      previewButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const report = JSON.parse(
      (container.querySelector('textarea[aria-label="Activity v2 E2E preview report"]') as HTMLTextAreaElement | null)?.value ?? '',
    )
    expect(report.previewStatus).toBe('PASS')
    expect(report.ACTIVITY_SOURCE_QUERY_MODE).toBe('TARGETED_RECENT_CANDIDATES')
    expect(report.TYPE24_CANDIDATES_READ).toBe(25)
    expect(report.TYPE25_CANDIDATES_READ).toBe(25)
    expect(report.TYPE24_SELECTED_INDEX).toBe(0)
    expect(report.TYPE25_SELECTED_INDEX).toBe(2)
    expect(report.TYPE24_SELECTED_SOURCE_ID).toBe('type24-source')
    expect(report.TYPE25_SELECTED_SOURCE_ID).toBe('type25-source')
    expect(report.expectedObservationCount).toBe(14)
    expect(report.SCOPED_E2E_SUPPORTED).toBe('YES')
    expect(report.SCOPED_E2E_SAFE).toBe('YES')
    expect(report.DIAGNOSTIC_WORKER_RACE_PREVENTED).toBe('YES')
    expect(report.NORMAL_FIFO_BACKLOG_PROCESSING_BYPASSED_FOR_DIAGNOSTIC).toBe('YES')
    expect(report.observations).toHaveLength(14)
    expect(report.observations.map((entry: { observationId: string }) => entry.observationId))
      .toEqual(Array.from({ length: 14 }, (_, index) => `observation-${index}`))
    expect(report.queue.TEST_OBSERVATION_COLLISION_COUNT).toBe(0)
    expect(report.queue.TEST_OBSERVATION_IDS_ABSENT).toBe(14)
    expect(report.queue.QUEUE_TOTAL).toBe(0)
    expect(report.queue.QUEUE_PENDING).toBe(0)
    expect(report.queue.PENDING_BY_OBSERVATION_TYPE).toEqual([])
    expect(report.queue.PENDING_BY_OWNER).toEqual({ distinctCount: 0, counts: [] })
    expect(report.queue.PENDING_BY_DEVICE).toEqual({ distinctCount: 0, counts: [] })
    const buttons = [...container.querySelectorAll('button')]
    const previewIndex = buttons.findIndex((button) => button.textContent?.includes('Preview Activity V2 E2E'))
    const verifyIndex = buttons.findIndex((button) => button.textContent?.includes('Verify Activity V2 E2E'))
    expect(verifyIndex).toBe(previewIndex + 1)
    expect(buttons[verifyIndex].disabled).toBe(false)
    expect(mocks.enqueueMany).not.toHaveBeenCalled()
    expect(mocks.process).not.toHaveBeenCalled()
    expect(mocks.enqueueActivity).not.toHaveBeenCalled()
    expect(mocks.base44ObservationCall).not.toHaveBeenCalled()
    expect(mocks.acquireActivity).not.toHaveBeenCalled()
    expect(setItem).not.toHaveBeenCalled()
    expect(mocks.saveReport).toHaveBeenCalledTimes(1)
  })

  it('passes Preview with an unrelated pending backlog when scoped E2E safety is available', async () => {
    mocks.getQueueStats.mockResolvedValue({
      pending: 1, retrying: 0, inFlight: 0, failed: 0,
      canonicalRecoveryRequired: false, canonicalRecoveryObservationCount: 0,
    })
    await act(async () => {
      root.render(createElement(ActivityV2ProductionVerification, {
        ownerUserId: 'owner-1',
        scope: { accountId: 'owner-1', deviceScopeId: 'device-1' },
        device: {
          deviceId: 'device-1', deviceModel: 'PRO_V8',
          firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0',
        },
      }))
    })
    await act(async () => new Promise((resolve) => setTimeout(resolve, 0)))
    const previewButton = [...container.querySelectorAll('button')]
      .find((button) => button.textContent?.includes('Preview Activity V2 E2E'))
    await act(async () => {
      previewButton?.click()
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    const report = JSON.parse(
      (container.querySelector('textarea[aria-label="Activity v2 E2E preview report"]') as HTMLTextAreaElement | null)?.value ?? '',
    )
    expect(report.previewStatus).toBe('PASS')
    expect(report.QUEUE_BACKLOG_PRESENT).toBe('YES')
    expect(report.queue.TEST_OBSERVATION_COLLISION_COUNT).toBe(0)
    expect(report.SCOPED_E2E_SUPPORTED).toBe('YES')
    expect(report.SCOPED_E2E_SAFE).toBe('YES')
    expect(mocks.process).not.toHaveBeenCalled()
    expect(mocks.deliverScopedActivityE2E).not.toHaveBeenCalled()
    expect(mocks.enqueueActivity).not.toHaveBeenCalled()
  })
})
