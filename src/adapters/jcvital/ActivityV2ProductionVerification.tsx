import { useState } from 'react'
import type { ConnectorObservationsResponse, NativeObservationInput } from '../../services/base44/base44Types'
import { activityV2CapabilityStore } from '../../services/base44/ActivityV2Capability'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { installationIdentityService } from '../../services/storage/InstallationIdentityService'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { observationBatchManager, type BatchDeliveryEvent } from '../../services/sync/ObservationBatchManager'
import type { QueueStats } from '../../services/storage/ObservationQueueStore'
import { saveValidationJson } from './CertificationJsonExport'
import {
  readActivitySource,
  type ActivitySource,
} from './Activity24_25Certification'
import {
  ACTIVITY_NATIVE_TRANSPORT_V2,
  ACTIVITY_V2_CAPABILITY,
  prepareActivityNativeTransportV2,
} from './ActivityNativeTransportV2'
import {
  ACTIVITY_V2_VERIFICATION_SCOPE,
  assessActivityV2Verification,
  enqueueActivityNativeTransportV2,
  prepareActivityNativeTransportV2Sources,
} from './ActivityNativeTransportV2Delivery'
import {
  beginActivityV2VerificationAttempt,
  completeActivityV2VerificationAttempt,
} from './ActivityV2VerificationAttempt'
import type {
  ActivityDeviceContext,
  ActivitySourceRecord,
} from './ActivityProductionCanonical'
import { JCVitalV8, type SourceJournalScope } from './jcvitalV8Bridge'

const VERIFY_METRICS = [
  'DAILY_STEPS',
  'DAILY_DISTANCE',
  'DAILY_CALORIES',
  'DAILY_EXERCISE_DURATION',
] as const
const ATTEMPT_KEY_PREFIX = 'elitePlus.activityV2ProductionVerificationAttempt.v1'
const REPORT_FILENAME = 'JCVital Activity v2 production verification.json'
const MAX_SOURCE_CANDIDATES_PER_TYPE = 25

type RecordEnvelope = {
  envelopeId: string
  kind: string
  vendorDataType?: string
  acquisitionMode?: string
  sourceDate?: string | null
  sdkSnapshot?: unknown
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

async function savedActivityEnvelopes(scope: SourceJournalScope): Promise<RecordEnvelope[]> {
  const entries: RecordEnvelope[] = []
  let afterSequence = 0
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await JCVitalV8.listSourceEnvelopes({ ...scope, afterSequence, limit: 100 })
    for (const entry of page.envelopes) {
      if (entry.kind !== 'SDK_RECORD' || !entry.envelopeJson) continue
      const envelope = JSON.parse(entry.envelopeJson) as RecordEnvelope
      if (envelope.kind !== 'SDK_RECORD' || envelope.envelopeId !== entry.envelopeId) {
        throw new Error(`Saved source envelope ${entry.envelopeId} failed its identity check.`)
      }
      if (envelope.vendorDataType === '24' || envelope.vendorDataType === '25') entries.push(envelope)
    }
    if (!page.hasMore) return entries
    if (!Number.isSafeInteger(page.nextSequence) || page.nextSequence <= afterSequence) {
      throw new Error('Saved Activity source journal pagination did not advance.')
    }
    afterSequence = page.nextSequence
  }
  throw new Error('Saved Activity source journal exceeded the 10,000-envelope verification read limit.')
}

function sourceRecord(source: ActivitySource): ActivitySourceRecord {
  const record: Record<string, unknown> = {}
  for (const [name, raw] of Object.entries(source.fields)) {
    const value = object(raw)
    if (typeof value.type !== 'string' || !('value' in value)) continue
    record[name] = value.value
  }
  const dataType = String(source.record.vendorDataType)
  if (dataType !== '24' && dataType !== '25') throw new Error('Saved Activity source type is unsupported.')
  const receivedAt = String(source.record.receivedAt ?? '')
  const timezone = String(source.record.timezone ?? '')
  return {
    vendorDataType: dataType,
    record,
    sourceEnvelopeId: source.sourceEnvelopeId,
    acquisitionSessionId: String(source.record.sessionId ?? ''),
    nativeObservationIds: [source.sourceEnvelopeId],
    nativeSourceRecordIds: [source.sourceEnvelopeId],
    parserVersion: typeof source.record.parserVersion === 'string' ? source.record.parserVersion : null,
    receivedAt,
    timezone,
  }
}

async function readCandidates(
  scope: SourceJournalScope,
  entries: readonly RecordEnvelope[],
  type: '24' | '25',
): Promise<{ sources: ActivitySourceRecord[]; warnings: string[] }> {
  const candidates = entries.filter((entry) => entry.vendorDataType === type
    && entry.acquisitionMode === 'HISTORICAL_SYNC')
  candidates.sort((left, right) => String(right.sourceDate ?? '').localeCompare(String(left.sourceDate ?? '')))
  const sources: ActivitySourceRecord[] = []
  const warnings: string[] = []
  for (const candidate of candidates.slice(0, MAX_SOURCE_CANDIDATES_PER_TYPE)) {
    try {
      const source = await readActivitySource(JCVitalV8, scope, candidate.envelopeId)
      sources.push(sourceRecord(source))
    } catch (error) {
      warnings.push(`${candidate.envelopeId}: ${describeError(error)}`)
    }
  }
  return { sources, warnings }
}

function hasDailyEvidence(source: ActivitySourceRecord): boolean {
  return source.vendorDataType === '24'
    && ['step', 'distance', 'calories', 'exerciseMinutes'].every((field) => source.record[field] !== undefined)
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
  const installId = installationIdentityService.getInstallId()
  const connectorDeviceId = connectorIdentityService.getConnectorDeviceId() ?? ''
  const capability = activityV2CapabilityStore.getDecision({ ownerUserId, installId, connectorDeviceId })
  const attemptKey = `${ATTEMPT_KEY_PREFIX}:${ownerUserId}:${installId}:${connectorDeviceId}`

  async function verify() {
    if (busy) return
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
    try {
      if (!capability.productionDeliveryEnabled || !connectorDeviceId) {
        throw new Error(`Current authenticated registration does not enable ${ACTIVITY_V2_CAPABILITY} (${capability.reason}).`)
      }
      if (scope.accountId !== ownerUserId) throw new Error('Saved Activity journal account does not match the authenticated owner.')
      if (observationQueue.getOwnerUserId() !== ownerUserId) throw new Error('Production queue owner does not match the authenticated owner.')
      if (observationBatchManager.getDeliveryDiagnostics().senderActive) throw new Error('Production sender is active; verification was not enqueued.')

      const context: ActivityDeviceContext = { ownerUserId, ...device }
      if (!context.deviceId || !context.deviceModel || !context.firmwareVersion || !context.sdkVersion) {
        throw new Error('Current authenticated device metadata is incomplete.')
      }
      const envelopes = await savedActivityEnvelopes(scope)
      const dailyRead = await readCandidates(scope, envelopes, '24')
      let type24: ActivitySourceRecord | undefined
      for (const candidate of dailyRead.sources.filter(hasDailyEvidence)) {
        try {
          const preparedDaily = await prepareActivityNativeTransportV2(candidate, context)
          if (preparedDaily.payloads.length === VERIFY_METRICS.length
            && VERIFY_METRICS.every((metric) => preparedDaily.payloads.some((payload) => payload.metric === metric))) {
            type24 = candidate
            break
          }
          dailyRead.warnings.push(`${candidate.sourceEnvelopeId}: source did not prepare the exact four daily verification metrics.`)
        } catch (error) {
          dailyRead.warnings.push(`${candidate.sourceEnvelopeId}: ${describeError(error)}`)
        }
      }
      const detailRead = await readCandidates(scope, envelopes, '25')
      report.sourceSelectionWarnings = [...dailyRead.warnings, ...detailRead.warnings]
      if (!type24) throw new Error('No persisted Type24 source contains the four required daily measurements.')
      let type25: ActivitySourceRecord | null = null
      for (const candidate of detailRead.sources) {
        try {
          const { payloads: candidatePayloads } = await prepareActivityNativeTransportV2(candidate, context)
          const epochs = candidatePayloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')
          if (epochs.length === 10 && epochs[0].rawSourceMetadata?.type25IntegrityStatus === 'PASS'
            && epochs[0].rawSourceMetadata?.type25ArrayLength === 10) {
            type25 = candidate
            break
          }
          detailRead.warnings.push(`${candidate.sourceEnvelopeId}: source failed the Type25 minute integrity check.`)
        } catch (error) {
          detailRead.warnings.push(`${candidate.sourceEnvelopeId}: ${describeError(error)}`)
        }
      }
      report.sourceSelectionWarnings = [...dailyRead.warnings, ...detailRead.warnings]
      if (!type25) throw new Error('No persisted Type25 source passed the existing minute-segment integrity and device-scope policy.')
      if (!type24.sourceEnvelopeId || !type25.sourceEnvelopeId) {
        throw new Error('Saved Activity verification sources require exact source-envelope identities.')
      }
      report.sourceObservationIds = { type24: [type24.sourceEnvelopeId], type25: [type25.sourceEnvelopeId] }

      const projection = await prepareActivityNativeTransportV2Sources(
        [type24, type25], context, ACTIVITY_V2_VERIFICATION_SCOPE,
      )
      payloads = projection.payloads
      const dailyPayloads = payloads.filter((payload) => VERIFY_METRICS.includes(payload.metric as typeof VERIFY_METRICS[number]))
      const epochPayloads = payloads.filter((payload) => payload.metric === 'DETAILED_ACTIVITY_EPOCH')
      if (projection.sourceRecordCount !== 2 || payloads.length !== 14 || dailyPayloads.length !== 4 || epochPayloads.length !== 10
        || payloads.some((payload) => payload.rawSourceMetadata?.canonicalPolicy !== 'NATIVE_ONLY')) {
        throw new Error('Prepared Activity v2 set differs from the bounded four-daily-plus-ten-minute verification contract.')
      }

      const existingRows = await Promise.all(payloads.map((payload) => observationQueue.getRecord(payload.observationId)))
      if (existingRows.some(Boolean)) {
        const queueStates = Object.fromEntries(payloads.map((payload, index) => [
          payload.observationId, existingRows[index]?.state ?? 'NOT_PRESENT',
        ]))
        const acknowledged = existingRows.filter((record) => record?.state === 'ACKNOWLEDGED').length
        const failed = existingRows.filter((record) => record?.state === 'FAILED_PERMANENT').length
        report.queue = {
          preflightClear: false, enqueueCount: 0, insertedCount: 0,
          duplicateCount: existingRows.filter(Boolean).length, pendingIdsAfterEnqueue: [],
        }
        report.delivery = { ...(report.delivery as object), queueStates }
        report.summary = {
          sourceRecordsProjected: 2, observationsQueued: existingRows.filter(Boolean).length,
          delivered: acknowledged, acknowledged, failed,
        }
        ;(report.errorsBlockers as string[]).push('Equivalent deterministic verification observations already exist; no resend was attempted.')
        return
      }

      const before = await observationQueue.getQueueStats()
      if (!idleQueue(before)) throw new Error('Production queue is not empty and healthy; verification was not enqueued.')
      report.queue = { preflightClear: true, enqueueCount: 0, insertedCount: 0, duplicateCount: 0, pendingIdsAfterEnqueue: [] }
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
      for (const id of ids) queueStates[id] = (await observationQueue.getRecord(id))?.state ?? 'MISSING'
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

  return <section className="diagnostics" aria-label="Activity v2 production verification">
    <h2>Diagnostics</h2>
    <p>Activity delivery verification uses already saved wearable records and the existing production queue and sender. No new device measurement is performed.</p>
    <p>Base44 capability = {capability.productionDeliveryEnabled ? 'PRESENT' : 'NOT PRESENT'} · registration capability received = {String(capability.capabilityReceived)} · evaluated = {capability.evaluatedAt || 'not available'}</p>
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
    <button type="button" disabled={busy || !capability.productionDeliveryEnabled} onClick={() => void verify()}>
      Verify Activity V2 E2E
    </button>
    {status && <p role="status">{status}</p>}
    {json && <>
      <button type="button" disabled={busy} onClick={() => void exportReport()}>Export Verification JSON</button>
      <textarea aria-label="Activity v2 production verification JSON" readOnly rows={18} value={json} />
    </>}
  </section>
}
