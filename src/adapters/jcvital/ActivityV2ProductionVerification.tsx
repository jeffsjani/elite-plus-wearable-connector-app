import { useEffect, useState } from 'react'
import type { ConnectorObservationsResponse, NativeObservationInput } from '../../services/base44/base44Types'
import { activityV2CapabilityStore } from '../../services/base44/ActivityV2Capability'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { observationBatchManager, type BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import type { QueueRecord, QueueStats } from '../../services/storage/ObservationQueueStore'
import { BASE44_PRODUCTION_ENVIRONMENT, resolveConnectorFunctionUrl } from '../../services/base44/base44Environment'
import { saveValidationJson } from './CertificationJsonExport'
import {
  ACTIVITY_NATIVE_TRANSPORT_V2,
  ACTIVITY_V2_CAPABILITY,
} from './ActivityNativeTransportV2'
import {
  ACTIVITY_V2_VERIFICATION_SCOPE,
  assessActivityV2Verification,
  enqueueActivityNativeTransportV2,
} from './ActivityNativeTransportV2Delivery'
import {
  beginActivityV2VerificationAttempt,
  completeActivityV2VerificationAttempt,
} from './ActivityV2VerificationAttempt'
import {
  activityV2DiagnosticReportStore,
} from './ActivityV2DiagnosticReportStore'
import { prepareActivityV2Verification } from './ActivityV2VerificationPreparation'
import { activityV2PreviewCanVerify } from './ActivityV2PreviewGate'
import { classifyActivityV2Verification } from './ActivityV2VerificationResult'
import type { ActivityDeviceContext } from './ActivityProductionCanonical'
import type { SourceJournalScope } from './jcvitalV8Bridge'

const VERIFY_METRICS = [
  'DAILY_STEPS',
  'DAILY_DISTANCE',
  'DAILY_CALORIES',
  'DAILY_EXERCISE_DURATION',
] as const
const ATTEMPT_KEY_PREFIX = 'elitePlus.activityV2ProductionVerificationAttempt.v1'
const REPORT_FILENAME = 'JCVital Activity v2 production verification.json'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function summarizeResults(event: BatchDeliveryEvent | null) {
  return (event?.results ?? []).map((result) => ({
    observationId: result.observationId,
    status: result.status,
    reason: result.reason ?? null,
    errorCode: result.errorCode ?? null,
    canonicalStatus: result.canonicalStatus ?? null,
    canonicalTarget: result.canonicalTarget ?? null,
    nativeObservationId: result.nativeObservationId ?? null,
  }))
}

function idleQueue(stats: QueueStats): boolean {
  return stats.pending === 0 && stats.retrying === 0 && stats.inFlight === 0 && stats.failed === 0
    && stats.canonicalRecoveryRequired !== true
    && (stats.canonicalRecoveryObservationCount ?? 0) === 0
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function countQueueStates(records: readonly QueueRecord[]) {
  return {
    count: records.length,
    pending: records.filter((record) => record.state === 'PENDING').length,
    failed: records.filter((record) => record.state === 'FAILED_PERMANENT').length,
  }
}

function queueRowsChanged(before: readonly QueueRecord[], after: readonly QueueRecord[], excludedIds: ReadonlySet<string>): boolean {
  const state = (records: readonly QueueRecord[]) => new Map(records
    .filter((record) => !excludedIds.has(record.observationId))
    .map((record) => [record.queueId, `${record.observationId}:${record.state}:${record.updatedAt}`]))
  const beforeState = state(before)
  const afterState = state(after)
  return beforeState.size !== afterState.size
    || [...beforeState].some(([queueId, value]) => afterState.get(queueId) !== value)
}

function checksCanonicalResponseEvidence(
  payloads: readonly NativeObservationInput[],
  results: ReturnType<typeof summarizeResults>,
): boolean {
  const canonicalPayloads = payloads.filter((payload) =>
    payload.rawSourceMetadata?.sourceDataType === 24 || payload.rawSourceMetadata?.segmentAnchor === true)
  return canonicalPayloads.length === 5 && canonicalPayloads.every((payload) =>
    results.some((result) => result.observationId === payload.observationId
      && result.canonicalStatus === 'canonicalized' && typeof result.canonicalTarget === 'string'
      && result.canonicalTarget.length > 0))
}

async function copyReport(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) throw new Error('Clipboard copy is not available in this WebView.')
  await navigator.clipboard.writeText(text)
}

export function ActivityV2ProductionVerification({
  ownerUserId, scope, device, onBusyChange,
}: {
  ownerUserId: string
  scope: SourceJournalScope
  device: Pick<ActivityDeviceContext, 'deviceId' | 'deviceModel' | 'firmwareVersion' | 'sdkVersion'>
  onBusyChange?(value: boolean): void
}) {
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState('')
  const [json, setJson] = useState('')
  const [previewJson, setPreviewJson] = useState('')
  const [reportStoreError, setReportStoreError] = useState('')
  const installId = localStorage.getItem('installId') ?? ''
  const connectorDeviceId = connectorIdentityService.getConnectorDeviceId() ?? ''
  const capability = activityV2CapabilityStore.getDecision({ ownerUserId, installId, connectorDeviceId })
  const attemptKey = `${ATTEMPT_KEY_PREFIX}:${ownerUserId}:${installId}:${connectorDeviceId}`
  const previewStorageKey = `latest-preview:${ownerUserId}:${installId}:${connectorDeviceId}`
  const verificationStorageKey = `latest-verification:${ownerUserId}:${installId}:${connectorDeviceId}`

  useEffect(() => {
    let active = true
    void Promise.all([
      activityV2DiagnosticReportStore.load(previewStorageKey),
      activityV2DiagnosticReportStore.load(verificationStorageKey),
    ]).then(([preview, verification]) => {
      if (!active) return
      if (preview) setPreviewJson(preview)
      if (verification) setJson(verification)
    }).catch((error: unknown) => {
      if (active) setReportStoreError(describeError(error))
    })
    return () => { active = false }
  }, [previewStorageKey, verificationStorageKey])

  async function readQueueSnapshot(observationIds: readonly string[]) {
    if (!observationQueue.getDiagnostics().queueStoreInitialized) {
      throw new Error('Production queue is not already initialized; read-only preview will not initialize or migrate it.')
    }
    const records = await observationQueue.listDiagnosticRecords()
    const stats = await observationQueue.getQueueStats()
    const expectedIds = new Set(observationIds)
    const matchingRecords = records.filter((record) => expectedIds.has(record.observationId))
    return { records, stats, matchingRecords, counts: countQueueStates(records) }
  }

  async function preview() {
    if (busy) return
    setBusy(true)
    onBusyChange?.(true)
    setStatus('')
    setReportStoreError('')
    const currentInstallId = localStorage.getItem('installId') ?? ''
    const currentConnectorDeviceId = connectorIdentityService.getConnectorDeviceId() ?? ''
    const currentCapability = activityV2CapabilityStore.getDecision({
      ownerUserId, installId: currentInstallId, connectorDeviceId: currentConnectorDeviceId,
    })
    const report: Record<string, unknown> = {
      schema: 'eliteplus.activity-v2-e2e-preview.v1',
      generatedAt: new Date().toISOString(),
      selectionScope: {
        ownerUserId, installId: currentInstallId, connectorDeviceId: currentConnectorDeviceId,
        accountId: scope.accountId, deviceScopeId: scope.deviceScopeId,
      },
      previewStatus: 'FAIL',
      capability: {
        base44Capability: currentCapability.capabilitySupported ? 'PRESENT' : 'NOT PRESENT',
        productionCapabilityDecision: currentCapability.productionDeliveryEnabled ? 'PRESENT' : 'NOT PRESENT',
        reason: currentCapability.reason,
        productionDeliveryEnabled: currentCapability.productionDeliveryEnabled,
      },
      type24: null,
      type25: null,
      sourceSelectionWarnings: [],
      expectedObservationCount: 0,
      observations: [],
      queue: null,
      safetyAssertions: {
        activityAcquisitionRun: 'NO',
        generalSyncRun: 'NO',
        activitySyncRun: 'NO',
        queueChangedByPreview: 'NO',
        base44ObservationCallsByPreview: 0,
        sourceRecordsChanged: 'NO',
        ownerDeviceEvidenceChanged: 'NO',
      },
      blockers: [],
    }
    try {
      if (!currentInstallId || !currentConnectorDeviceId) throw new Error('Persisted install or connector identity is unavailable; preview will not create one.')
      if (scope.accountId !== ownerUserId) throw new Error('Saved Activity journal owner does not match the authenticated owner.')
      if (observationQueue.getOwnerUserId() !== ownerUserId) throw new Error('Production queue owner does not match the authenticated owner.')
      const context: ActivityDeviceContext = { ownerUserId, ...device }
      const prepared = await prepareActivityV2Verification(scope, context)
      report.sourceSelectionWarnings = prepared.warnings
      report.type24FailureReason = prepared.type24FailureReason
      report.type25FailureReason = prepared.type25FailureReason
      report.type24 = prepared.type24 ? {
        sourceEnvelopeId: prepared.type24.details.sourceEnvelopeId,
        sourceDate: prepared.type24.details.sourceDate,
        receivedDate: prepared.type24.details.receivedAt,
        provider: prepared.type24.details.provider,
        device: {
          deviceScopeId: prepared.type24.details.deviceScopeId,
          model: prepared.type24.details.deviceModel,
        },
        acquisitionMode: prepared.type24.details.acquisitionMode,
        step: prepared.type24.source.record.step,
        distance: prepared.type24.source.record.distance,
        calories: prepared.type24.source.record.calories,
        exerciseMinutes: prepared.type24.source.record.exerciseMinutes,
        mappingValid: true,
      } : { mappingValid: false }
      const type25Display = prepared.type25 ?? prepared.type25Candidate
      report.type25 = type25Display ? {
        sourceEnvelopeId: type25Display.details.sourceEnvelopeId,
        sourceDate: type25Display.details.sourceDate,
        receivedDate: type25Display.details.receivedAt,
        provider: type25Display.details.provider,
        device: {
          deviceScopeId: type25Display.details.deviceScopeId,
          model: type25Display.details.deviceModel,
        },
        firmware: type25Display.details.firmwareVersion,
        sdkVersion: type25Display.details.sdkVersion,
        acquisitionMode: type25Display.details.acquisitionMode,
        arraySteps: type25Display.source.record.arraySteps,
        detailMinterStep: type25Display.source.record.detailMinterStep,
        timezone: type25Display.details.timezone,
        qualification: type25Display.details.qualification?.status ?? 'FAIL',
        qualificationFailureReason: type25Display.details.qualification?.reason ?? prepared.type25FailureReason,
        qualificationEvidence: type25Display.details.qualification ?? null,
      } : { qualification: 'FAIL', qualificationFailureReason: prepared.type25FailureReason }
      report.expectedObservationCount = prepared.payloads.length
      report.observations = prepared.payloads.map((payload) => ({
        observationId: payload.observationId,
        metric: payload.metric,
        type: payload.vendorDataType,
        sourceEnvelopeId: payload.rawSourceMetadata?.sourceEnvelopeId ?? null,
        timeWindow: payload.observedAt,
        slot: payload.sequenceNumber ?? 'record',
        value: payload.valueNumber,
      }))
      const ids = prepared.payloads.map((payload) => payload.observationId)
      const queue = await readQueueSnapshot(ids)
      const queueConflict = queue.records.length > 0 || !idleQueue(queue.stats)
      report.queue = {
        queueCountBefore: queue.counts.count,
        pendingCountBefore: queue.stats.pending,
        failedCountBefore: queue.stats.failed,
        existingTestObservationCount: queue.matchingRecords.length,
        existingTestObservationIds: queue.matchingRecords.map((record) => record.observationId),
        existingTestObservationStates: queue.matchingRecords.map((record) => ({
          observationId: record.observationId, state: record.state,
        })),
        queueConflict,
      }
      const valid = currentCapability.capabilitySupported && currentCapability.productionDeliveryEnabled
        && currentCapability.reason === 'CAPABILITY_SUPPORTED'
        && Boolean(prepared.type24 && prepared.type25 && prepared.selectionValid)
        && prepared.payloads.length === 14 && !queueConflict
      report.previewStatus = valid ? 'PASS' : 'FAIL'
      if (!currentCapability.productionDeliveryEnabled) (report.blockers as string[]).push('Production Activity V2 capability is not enabled.')
      if (!prepared.type24) (report.blockers as string[]).push(prepared.type24FailureReason ?? 'Qualified Type24 source unavailable.')
      if (!prepared.type25) (report.blockers as string[]).push(prepared.type25FailureReason ?? 'Qualified Type25 source unavailable.')
      if (prepared.payloads.length !== 14 || !prepared.selectionValid) (report.blockers as string[]).push('Expected observation set is not exactly four daily plus ten minute observations.')
      if (queueConflict) (report.blockers as string[]).push('Queue is not clear for a first controlled verification or matching observations already exist.')
    } catch (error) {
      ;(report.blockers as string[]).push(describeError(error))
    }
    const serialized = JSON.stringify(report, null, 2)
    setPreviewJson(serialized)
    try {
      await activityV2DiagnosticReportStore.save(previewStorageKey, serialized)
    } catch (error) {
      setReportStoreError(describeError(error))
      report.previewStatus = 'FAIL'
      ;(report.blockers as string[]).push(`Preview report could not be persisted: ${describeError(error)}`)
      setPreviewJson(JSON.stringify(report, null, 2))
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  async function verify() {
    if (busy) return
    let preview: Record<string, unknown>
    try {
      preview = object(JSON.parse(previewJson))
      if (preview.previewStatus !== 'PASS') throw new Error('A passing Preview Activity V2 E2E report is required.')
      const selectionScope = object(preview.selectionScope)
      if (selectionScope.ownerUserId !== ownerUserId || selectionScope.installId !== installId
        || selectionScope.connectorDeviceId !== connectorDeviceId
        || selectionScope.accountId !== scope.accountId || selectionScope.deviceScopeId !== scope.deviceScopeId) {
        throw new Error('Preview belongs to a different authenticated owner, installation or device scope.')
      }
      const previewQueue = object(preview.queue)
      if (previewQueue.queueConflict !== false || preview.expectedObservationCount !== 14) {
        throw new Error('Preview queue or observation-count gate did not pass.')
      }
    } catch (error) {
      setStatus(`Verification remains disabled until preview passes. ${describeError(error)}`)
      return
    }
    if (!window.confirm('This verifies the Activity data connection using already saved wearable records. It does not perform a new device measurement.')) return
    let previousAttempt: string | null
    try {
      previousAttempt = localStorage.getItem(attemptKey)
    } catch (error) {
      setStatus(`Saved verification state is unavailable; no observations were enqueued. ${describeError(error)}`)
      return
    }
    if (previousAttempt !== null) {
      try {
        const saved = object(JSON.parse(previousAttempt))
        if (typeof saved.report === 'string') {
          setJson(saved.report)
          setStatus('Previous Activity v2 verification result shown. No observations were re-enqueued.')
        } else {
          setStatus('A previous Activity v2 verification started but has no completed report. No observations were re-enqueued.')
        }
      } catch (error) {
        setStatus(`A previous verification marker is invalid; no observations were re-enqueued. ${describeError(error)}`)
      }
      return
    }
    setBusy(true)
    onBusyChange?.(true)
    setStatus('')
    const report: Record<string, unknown> = {
      schema: 'eliteplus.activity-v2-production-verification.v1',
      verifiedAt: new Date().toISOString(),
      e2eAttemptTime: new Date().toISOString(),
      endpoint: resolveConnectorFunctionUrl(BASE44_PRODUCTION_ENVIRONMENT.observationsFunction),
      requestMethod: 'POST',
      transportE2E: 'FAIL',
      fullCanonicalE2E: 'UNVERIFIED',
      canonicalResponseEvidence: 'FAILED',
      independentCanonicalRowReadback: 'NOT AVAILABLE',
      firstSendDuplicateIndication: 'NO',
      serverCapabilityObserved: {
        name: ACTIVITY_V2_CAPABILITY,
        received: capability.capabilityReceived,
        advertisedValue: capability.capabilitySupported ? ACTIVITY_NATIVE_TRANSPORT_V2 : null,
        enabled: capability.productionDeliveryEnabled,
        reason: capability.reason,
        responseContractVersion: capability.responseContractVersion,
        deploymentRevision: capability.deploymentRevision,
        receivedAt: capability.receivedAt || null,
        evaluatedAt: capability.evaluatedAt || null,
      },
      transportVersion: ACTIVITY_NATIVE_TRANSPORT_V2,
      sourceObservationIds: { type24: [], type25: [] },
      queue: { preflightClear: false, enqueueCount: 0, insertedCount: 0, duplicateCount: 0, pendingIdsAfterEnqueue: [] },
      queueLifecycle: null,
      delivery: { outcome: null, batchId: null, httpStatus: null, accepted: null, duplicate: null, rejected: null, acknowledgedIds: [], queueStates: {}, results: [] },
      base44CanonicalDisposition: null,
      type24DailyCanonicalResults: [],
      type25MinuteExpansionResult: null,
      exerciseDuration: null,
      provenanceResult: { valid: false, details: [] },
      verificationChecks: null,
      summary: { sourceRecordsProjected: 0, observationsQueued: 0, delivered: 0, acknowledged: 0, failed: 0 },
      sourceSelectionWarnings: [] as string[],
      errorsBlockers: [] as string[],
    }
    const eventRef: { current: BatchDeliveryEvent | null } = { current: null }
    let payloads: NativeObservationInput[] = []
    let response: ConnectorObservationsResponse | null = null
    let attemptStarted = false
    let queueRecordsBefore: QueueRecord[] = []
    let queueStatsBefore: QueueStats | null = null
    try {
      const currentInstallId = localStorage.getItem('installId') ?? ''
      const currentConnectorDeviceId = connectorIdentityService.getConnectorDeviceId() ?? ''
      const currentCapability = activityV2CapabilityStore.getDecision({
        ownerUserId, installId: currentInstallId, connectorDeviceId: currentConnectorDeviceId,
      })
      if (!currentCapability.productionDeliveryEnabled || !currentInstallId || !currentConnectorDeviceId) {
        throw new Error(`Current authenticated registration does not enable ${ACTIVITY_V2_CAPABILITY} (${currentCapability.reason}).`)
      }
      if (scope.accountId !== ownerUserId) throw new Error('Saved Activity journal account does not match the authenticated owner.')
      if (observationQueue.getOwnerUserId() !== ownerUserId) throw new Error('Production queue owner does not match the authenticated owner.')
      if (observationBatchManager.getDeliveryDiagnostics().senderActive) throw new Error('Production sender is active; verification was not enqueued.')

      const context: ActivityDeviceContext = { ownerUserId, ...device }
      if (!context.deviceId || !context.deviceModel || !context.firmwareVersion || !context.sdkVersion) {
        throw new Error('Current authenticated device metadata is incomplete.')
      }
      const preparedSources = await prepareActivityV2Verification(scope, context)
      report.sourceSelectionWarnings = preparedSources.warnings
      const type24 = preparedSources.type24?.source
      const type25 = preparedSources.type25?.source
      if (!type24 || !type25 || !preparedSources.selectionValid) {
        throw new Error(preparedSources.type24FailureReason ?? preparedSources.type25FailureReason
          ?? 'Saved Activity source selection is not eligible for production verification.')
      }
      if (!type24.sourceEnvelopeId || !type25.sourceEnvelopeId) {
        throw new Error('Saved Activity verification sources require exact source-envelope identities.')
      }
      const previewSources = object(preview.type24)
      const previewDetail = object(preview.type25)
      if (previewSources.sourceEnvelopeId !== type24.sourceEnvelopeId
        || previewDetail.sourceEnvelopeId !== type25.sourceEnvelopeId) {
        throw new Error('Selected saved Activity records changed after preview; run Preview again before verification.')
      }
      report.sourceObservationIds = { type24: [type24.sourceEnvelopeId], type25: [type25.sourceEnvelopeId] }
      payloads = preparedSources.payloads
      const dailyPayloads = payloads.filter((payload) => VERIFY_METRICS.includes(payload.metric as typeof VERIFY_METRICS[number]))
      const epochPayloads = payloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')
      const previewIds = Array.isArray(preview.observations)
        ? preview.observations.map((entry) => object(entry).observationId) : []
      if (payloads.length !== 14 || dailyPayloads.length !== 4 || epochPayloads.length !== 10
        || payloads.some((payload) => payload.rawSourceMetadata?.canonicalPolicy !== 'NATIVE_ONLY')
        || JSON.stringify(previewIds) !== JSON.stringify(payloads.map((payload) => payload.observationId))) {
        throw new Error('Prepared Activity v2 set differs from the bounded four-daily-plus-ten-minute verification contract.')
      }
      const selectedCapability = activityV2CapabilityStore.getDecision({
        ownerUserId, installId: currentInstallId, connectorDeviceId: currentConnectorDeviceId,
      })
      if (!selectedCapability.capabilitySupported || !selectedCapability.productionDeliveryEnabled
        || selectedCapability.reason !== 'CAPABILITY_SUPPORTED') {
        throw new Error(`Production capability gate changed after preview (${selectedCapability.reason}).`)
      }

      const queueBefore = await readQueueSnapshot(payloads.map((payload) => payload.observationId))
      queueRecordsBefore = queueBefore.records
      queueStatsBefore = queueBefore.stats
      if (queueBefore.records.length || queueBefore.matchingRecords.length || !idleQueue(queueBefore.stats)) {
        const queueStates = Object.fromEntries(queueBefore.matchingRecords.map((record) => [record.observationId, record.state]))
        report.queue = {
          preflightClear: false, enqueueCount: 0, insertedCount: 0,
          duplicateCount: queueBefore.matchingRecords.length, pendingIdsAfterEnqueue: [],
          queueCountBefore: queueBefore.counts.count,
          pendingCountBefore: queueBefore.stats.pending,
          failedCountBefore: queueBefore.stats.failed,
        }
        report.delivery = { ...(report.delivery as object), queueStates }
        throw new Error('Production queue conflict detected after preview; no observations were enqueued.')
      }
      const before = queueBefore.stats
      report.queue = {
        preflightClear: true, enqueueCount: 0, insertedCount: 0, duplicateCount: 0, pendingIdsAfterEnqueue: [],
        queueCountBefore: queueBefore.counts.count,
        pendingCountBefore: before.pending,
        failedCountBefore: before.failed,
      }
      if (!beginActivityV2VerificationAttempt(localStorage, attemptKey, {
        type24: type24.sourceEnvelopeId, type25: type25.sourceEnvelopeId,
      })) {
        throw new Error('A saved verification attempt already exists; no duplicate enqueue is allowed.')
      }
      attemptStarted = true
      const prepared = await enqueueActivityNativeTransportV2(
        [type24, type25], context, observationQueue,
        activityV2CapabilityStore.isEnabled({ ownerUserId, installId, connectorDeviceId }),
        ACTIVITY_V2_VERIFICATION_SCOPE,
      )
      payloads = prepared.payloads
      if (payloads.length !== 14 || prepared.payloadCount !== 14) {
        throw new Error('Prepared Activity v2 set differs from the bounded four-daily-plus-ten-minute verification contract.')
      }
      const insertedCount = prepared.insertedCount
      const duplicateCount = prepared.duplicateCount
      report.summary = {
        sourceRecordsProjected: prepared.sourceRecordCount,
        observationsQueued: insertedCount,
        delivered: 0,
        acknowledged: 0,
        failed: 0,
      }
      Object.assign(report.queue as object, {
        enqueueCount: prepared.payloadCount, insertedCount, duplicateCount,
      })
      if (insertedCount !== prepared.payloadCount || duplicateCount !== 0) {
        const queueStates: Record<string, string> = {}
        for (const payload of payloads) queueStates[payload.observationId] = (await observationQueue.getRecord(payload.observationId))?.state ?? 'MISSING'
        report.delivery = { ...(report.delivery as object), queueStates }
        const acknowledged = Object.values(queueStates).filter((state) => state === 'ACKNOWLEDGED').length
        report.summary = {
          sourceRecordsProjected: prepared.sourceRecordCount,
          observationsQueued: insertedCount,
          delivered: acknowledged,
          acknowledged,
          failed: Object.values(queueStates).filter((state) => state === 'FAILED_PERMANENT').length,
        }
        ;(report.errorsBlockers as string[]).push('Equivalent deterministic observations were found during enqueue; no sender retry was attempted.')
        return
      }

      const pending = await observationQueue.getPending(100)
      const ids = payloads.map((payload) => payload.observationId)
      const pendingIds = pending.map((record) => record.observationId)
      Object.assign(report.queue as object, { pendingIdsAfterEnqueue: pendingIds })
      if (pendingIds.length !== ids.length || ids.some((id) => !pendingIds.includes(id))) {
        throw new Error('Production queue changed during verification preflight; normal sender was not invoked by this action.')
      }
      if (observationBatchManager.getDeliveryDiagnostics().senderActive) {
        throw new Error('Production sender became active; normal sender was not invoked by this action.')
      }

      let notifyResult: (() => void) | undefined
      const unsubscribe = observationBatchManager.subscribe((candidate) => {
        if (candidate.observationIds.some((id) => ids.includes(id))) {
          eventRef.current = candidate
          notifyResult?.()
        }
      })
      try {
        response = await observationBatchManager.process()
        if (!eventRef.current) {
          await new Promise<void>((resolve) => {
            const timer = window.setTimeout(resolve, 35_000)
            notifyResult = () => { window.clearTimeout(timer); resolve() }
          })
        }
      } finally {
        unsubscribe()
      }
      const deliveryEvent = eventRef.current
      const results = summarizeResults(deliveryEvent)
      const queueStates: Record<string, string> = {}
      const queueAfter = await readQueueSnapshot(ids)
      for (const id of ids) {
        const row = queueAfter.matchingRecords.find((record) => record.observationId === id)
        queueStates[id] = row?.state ?? (deliveryEvent?.acknowledgedIds.includes(id) ? 'ACKNOWLEDGED_PURGED' : 'MISSING')
      }
      const deliveryDiagnostics = observationBatchManager.getDeliveryDiagnostics()
      const lastBatch = deliveryDiagnostics.lastBatch
      const requestAttemptCount = lastBatch && deliveryEvent && lastBatch.batchId === deliveryEvent.batchId
        ? lastBatch.attemptNumber : deliveryEvent ? 1 : 0
      const unrelatedChanged = queueRowsChanged(queueRecordsBefore, queueAfter.records, new Set(ids))
      const perObservation = payloads.map((payload) => {
        const result = results.find((candidate) => candidate.observationId === payload.observationId) ?? null
        return {
          observationId: payload.observationId,
          metric: payload.metric,
          sourceEnvelopeId: payload.rawSourceMetadata?.sourceEnvelopeId ?? null,
          timeWindow: payload.observedAt,
          slot: payload.sequenceNumber ?? 'record',
          value: payload.valueNumber,
          resultStatus: result?.status ?? null,
          ackState: queueStates[payload.observationId],
          canonicalStatus: result?.canonicalStatus ?? null,
          canonicalTarget: result?.canonicalTarget ?? null,
          errorCode: result?.errorCode ?? result?.reason ?? null,
          errorMessage: result?.reason ?? null,
        }
      })
      const daily = dailyPayloads.map((payload) => ({
        metric: payload.metric,
        value: payload.valueNumber,
        unit: payload.unit,
        observationId: payload.observationId,
        result: results.find((result) => result.observationId === payload.observationId) ?? null,
      }))
      const exercise = dailyPayloads.find((payload) => payload.metric === 'DAILY_EXERCISE_DURATION')
      const minutes = exercise && typeof exercise.rawSourceMetadata?.normalizedMinutes === 'number'
        ? exercise.rawSourceMetadata.normalizedMinutes : null
      const epochs = epochPayloads.map((payload) => ({
        observationId: payload.observationId,
        observedAt: payload.observedAt,
        steps: payload.valueNumber,
        result: results.find((result) => result.observationId === payload.observationId) ?? null,
      }))
      const provenanceDetails = payloads.map((payload) => ({
        observationId: payload.observationId,
        sourceEnvelopeId: prepared.results.find((result) => result.record.observationId === payload.observationId)?.record.sourceEnvelopeId ?? null,
        sourceRecordId: payload.sourceRecordId ?? null,
        transportVersion: payload.rawSourceMetadata?.activityTransportVersion ?? null,
        canonicalPolicy: payload.rawSourceMetadata?.canonicalPolicy ?? null,
        resultReceived: results.some((result) => result.observationId === payload.observationId),
      }))
      Object.assign(report.delivery as object, {
        outcome: deliveryEvent?.outcome ?? 'NO_ACK_RESULT',
        batchId: deliveryEvent?.batchId ?? response?.batchId ?? null,
        httpStatus: deliveryEvent?.httpStatus ?? null,
        accepted: deliveryEvent?.accepted ?? response?.accepted ?? null,
        duplicate: deliveryEvent?.duplicate ?? response?.duplicate ?? null,
        rejected: deliveryEvent?.rejected ?? response?.rejected ?? null,
        acknowledgedIds: deliveryEvent?.acknowledgedIds ?? [],
        queueStates,
        results,
      })
      const canonicalResponseConfirmed = checksCanonicalResponseEvidence(payloads, results)
      const ackComplete = Boolean(deliveryEvent && deliveryEvent.acknowledgedIds.length === 14
        && ids.every((id) => deliveryEvent.acknowledgedIds.includes(id)))
      const noUnexpectedRejection = !deliveryEvent?.rejectedIds.length && results.every((result) => result.status !== 'rejected')
      const testPendingAfter = queueAfter.matchingRecords.filter((record) =>
        record.state === 'PENDING' || record.state === 'RETRY_WAIT' || record.state === 'IN_FLIGHT').length
      const testFailedAfter = queueAfter.matchingRecords.filter((record) =>
        record.state === 'FAILED_PERMANENT' || record.state === 'CANONICAL_RECOVERY_REQUIRED').length
      const transportPass = insertedCount === 14 && prepared.payloadCount === 14
        && (deliveryEvent?.httpStatus ?? 0) >= 200 && (deliveryEvent?.httpStatus ?? 0) < 300
        && ackComplete && noUnexpectedRejection && testPendingAfter === 0 && testFailedAfter === 0
        && requestAttemptCount === 1 && !unrelatedChanged
      Object.assign(report, classifyActivityV2Verification(transportPass, canonicalResponseConfirmed))
      report.firstSendDuplicateIndication = (deliveryEvent?.duplicate ?? response?.duplicate ?? 0) > 0
        || results.some((result) => result.status === 'duplicate') ? 'YES' : 'NO'
      report.requestAttemptCount = requestAttemptCount
      report.observationCountSent = insertedCount
      report.ackReceived = Boolean(deliveryEvent)
      report.ackAcceptedCount = response?.accepted ?? deliveryEvent?.accepted ?? 0
      report.ackDuplicateCount = response?.duplicate ?? deliveryEvent?.duplicate ?? 0
      report.ackRejectedCount = response?.rejected ?? deliveryEvent?.rejected ?? 0
      report.observationResults = perObservation
      report.queueLifecycle = {
        queueCountBefore: queueRecordsBefore.length,
        queueCountAfter: queueAfter.counts.count,
        pendingCountBefore: queueStatsBefore?.pending ?? null,
        pendingCountAfter: queueAfter.stats.pending,
        failedCountBefore: queueStatsBefore?.failed ?? null,
        failedCountAfter: queueAfter.stats.failed,
        testObservationsPendingAfter: testPendingAfter,
        testObservationsFailedAfter: testFailedAfter,
        unrelatedQueueItemsChanged: unrelatedChanged,
      }
      report.summary = {
        sourceRecordsProjected: prepared.sourceRecordCount,
        observationsQueued: insertedCount,
        delivered: deliveryEvent?.observationIds.length ?? 0,
        acknowledged: deliveryEvent?.acknowledgedIds.length ?? 0,
        failed: deliveryEvent?.rejectedIds.length
          ?? Object.values(queueStates).filter((state) => state === 'FAILED_PERMANENT').length,
      }
      report.base44CanonicalDisposition = {
        response: response?.canonical ?? null,
        statuses: results.map(({ observationId, canonicalStatus, canonicalTarget }) => ({ observationId, canonicalStatus, canonicalTarget })),
      }
      report.type24DailyCanonicalResults = daily
      report.type25MinuteExpansionResult = {
        status: epochs.length === 10 && epochs.every((epoch) => typeof epoch.observedAt === 'string') ? 'EXPANDED_10_MINUTES' : 'INVALID',
        policy: type25.record.semanticPolicyVersion ?? 'jcvital.type25.minute_anchor.v1',
        sourceEnvelopeId: type25.sourceEnvelopeId,
        segment: epochs,
      }
      report.exerciseDuration = exercise ? { seconds: exercise.valueNumber, minutes } : null
      const provenanceValid = provenanceDetails.length === 14 && provenanceDetails.every((detail) =>
        detail.sourceEnvelopeId !== null && detail.sourceRecordId !== null
          && detail.transportVersion === ACTIVITY_NATIVE_TRANSPORT_V2
          && detail.canonicalPolicy === 'NATIVE_ONLY')
      report.provenanceResult = { valid: provenanceValid, details: provenanceDetails }
      const checks = await assessActivityV2Verification(
        [type24, type25], context, payloads, deliveryEvent?.results ?? [], deliveryEvent?.acknowledgedIds ?? [],
      )
      report.verificationChecks = {
        serverCapabilityPresent: capability.productionDeliveryEnabled ? 'PASS' : 'FAIL',
        queueAccepted: insertedCount === 14 && duplicateCount === 0 ? 'PASS' : 'FAIL',
        ...checks,
      }
      if (checks.canonicalRowsCreatedOrUpserted.status !== 'PASS') {
        (report.errorsBlockers as string[]).push('Canonical creation/upsert was not confirmed for all four Type24 metrics and the Type25 segment anchor; a native ACK alone is insufficient.')
      }
      if (checks.type25MinuteTimestampsCorrect.payload !== 'PASS') {
        (report.errorsBlockers as string[]).push('Type25 payload timestamps or values differ from the existing canonical policy.')
      }
      report.serverVerificationLimitations = 'The existing ACK contract does not return canonical rows or readiness/scoring snapshots. Server timestamp readback, duplicate-row counts, and readiness/scoring state comparison remain UNVERIFIED; no extra endpoint or resend is used.'
      if (!deliveryEvent) (report.errorsBlockers as string[]).push('Normal production sender returned no matching Base44 ACK/result before timeout.')
      else if (deliveryEvent.acknowledgedIds.length !== 14 || deliveryEvent.rejectedIds.length > 0) {
        (report.errorsBlockers as string[]).push('Base44 ACK/result did not acknowledge the complete bounded verification set.')
      }
      if (!provenanceValid) (report.errorsBlockers as string[]).push('One or more queued observations failed the source provenance verification.')
    } catch (error) {
      (report.errorsBlockers as string[]).push(describeError(error))
    } finally {
      let serialized = JSON.stringify(report, null, 2)
      if (attemptStarted) {
        try {
          completeActivityV2VerificationAttempt(localStorage, attemptKey, serialized)
        } catch (error) {
          ;(report.errorsBlockers as string[]).push(`Verification report could not be persisted locally: ${describeError(error)}`)
          serialized = JSON.stringify(report, null, 2)
        }
      }
      try {
        await activityV2DiagnosticReportStore.save(verificationStorageKey, serialized)
      } catch (error) {
        setReportStoreError(describeError(error))
        ;(report.errorsBlockers as string[]).push(`Verification report could not be persisted in diagnostic storage: ${describeError(error)}`)
        serialized = JSON.stringify(report, null, 2)
      }
      setJson(serialized)
      const summary = report.summary as {
        sourceRecordsProjected: number; observationsQueued: number; delivered: number; acknowledged: number; failed: number
      }
      setStatus(`Base44 capability = ${capability.productionDeliveryEnabled ? 'PRESENT' : 'NOT PRESENT'} · source records projected = ${summary.sourceRecordsProjected} · observations queued = ${summary.observationsQueued} · delivered = ${summary.delivered} · acknowledged = ${summary.acknowledged} · failed = ${summary.failed}${(report.errorsBlockers as string[]).length ? ' · blockers reported' : ''} · export JSON for canonical checks and server verification limits`)
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  async function exportReport() {
    if (!json) return
    setBusy(true)
    onBusyChange?.(true)
    try {
      setStatus(await saveValidationJson(REPORT_FILENAME, json, 'Activity v2 production verification',
        'Export Activity v2 production verification JSON'))
    } catch (error) {
      setStatus(`Verification JSON export failed: ${describeError(error)}`)
    } finally {
      setBusy(false)
      onBusyChange?.(false)
    }
  }

  async function copyPreviewReport() {
    if (!previewJson) return
    try {
      await copyReport(previewJson)
      setStatus('Preview report copied.')
    } catch (error) {
      setStatus(`Preview report copy failed: ${describeError(error)}`)
    }
  }

  async function copyVerificationReport() {
    if (!json) return
    try {
      await copyReport(json)
      setStatus('E2E report copied.')
    } catch (error) {
      setStatus(`E2E report copy failed: ${describeError(error)}`)
    }
  }

  const previewCanVerify = activityV2PreviewCanVerify(previewJson, capability, {
    ownerUserId, installId, connectorDeviceId,
    accountId: scope.accountId, deviceScopeId: scope.deviceScopeId,
  })

  return <section className="diagnostics" aria-label="Activity v2 production verification">
    <h2>Diagnostics</h2>
    <p>Activity delivery verification uses already saved wearable records and the existing production queue and sender. No new device measurement is performed.</p>
    <p>Base44 capability = {capability.capabilitySupported ? 'PRESENT' : 'NOT PRESENT'} · registration capability received = {String(capability.capabilityReceived)} · evaluated = {capability.evaluatedAt || 'not available'}</p>
    <p>Production capability decision = {capability.productionDeliveryEnabled ? 'PRESENT' : 'NOT PRESENT'}</p>
    <p>Decision reason = {capability.reason}</p>
    <p>Persisted capabilitySupported = {String(capability.capabilitySupported)}</p>
    <p>Persisted productionDeliveryEnabled = {String(capability.productionDeliveryEnabled)}</p>
    <p>Persisted advertisedCapability = {capability.advertisedCapability ?? 'Not advertised'}</p>
    <dl aria-label="Activity v2 production capability predicates">
      {Object.entries(capability.predicates).map(([name, value]) => (
        <div key={name}><dt>{name}</dt><dd>{String(value)}</dd></div>
      ))}
    </dl>
    <button type="button" disabled={busy} onClick={() => void preview()}>
      Preview Activity V2 E2E
    </button>
    <button type="button" disabled={busy || !capability.productionDeliveryEnabled || !previewCanVerify} onClick={() => void verify()}>
      Verify Activity V2 E2E
    </button>
    {previewJson && <>
      <button type="button" disabled={busy} onClick={() => void copyPreviewReport()}>Copy Preview Report</button>
      <textarea aria-label="Activity v2 E2E preview report" readOnly rows={28} value={previewJson} />
    </>}
    {reportStoreError && <p role="alert">Diagnostic report persistence error: {reportStoreError}</p>}
    {status && <p role="status">{status}</p>}
    {json && <>
      <button type="button" disabled={busy} onClick={() => void copyVerificationReport()}>Copy E2E Report</button>
      <button type="button" disabled={busy} onClick={() => void exportReport()}>Export Verification JSON</button>
      <textarea aria-label="Activity v2 production verification JSON" readOnly rows={28} value={json} />
    </>}
  </section>
}
