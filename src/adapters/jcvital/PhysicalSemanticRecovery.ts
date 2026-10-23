import type { JCVitalV8Plugin, PhysicalSemanticNativeEvidence, SourceJournalScope } from './jcvitalV8Bridge'
import { evidenceKey, errorDetails, isPhysicalResult, latestPhysicalResult, newPhysicalResult, PhysicalAttempt, type FailureResult, type TestKind } from './PhysicalSemanticEvidence'

type RecoveryApi = Pick<JCVitalV8Plugin, 'readPhysicalSemanticTestEvidence' | 'readActivityCertificationSnapshot'
  | 'readWorkoutCertificationSnapshot' | 'listSourceEnvelopes'>

export async function recoverPhysicalFailure(
  kind: TestKind, scope: SourceJournalScope, api: RecoveryApi,
  storage: Pick<Storage, 'getItem'> = localStorage,
): Promise<{ result: FailureResult | null; inspected: string[]; errors: string[] }> {
  const inspected: string[] = []
  const errors: string[] = []
  const prefix = `v8PhysicalSemanticTest.v1:${kind}:${scope.accountId}:${scope.deviceScopeId}`
  let previous: FailureResult | null = null
  let attempted = false
  let legacyResultPresent = false
  try {
    inspected.push('physical result localStorage', 'physical progress localStorage', 'v55 one-shot marker localStorage')
    const saved = storage.getItem(prefix)
    const progress = storage.getItem(evidenceKey(kind, scope))
    const parsed = latestPhysicalResult(saved ? JSON.parse(saved) : null, progress ? JSON.parse(progress) : null)
    previous = isPhysicalResult(parsed) ? parsed : null
    legacyResultPresent = Boolean(saved && parsed && !previous)
    attempted = storage.getItem(`${prefix}:attempted`) === '1'
  } catch (error) { errors.push(`Local evidence: ${errorDetails(error).message}`) }
  let native: PhysicalSemanticNativeEvidence | null = null
  try {
    inspected.push('native physical-session evidence SharedPreferences')
    const saved = await api.readPhysicalSemanticTestEvidence({ ...scope, kind })
    if (saved.json) native = JSON.parse(saved.json) as PhysicalSemanticNativeEvidence
  } catch (error) { errors.push(`Native evidence: ${errorDetails(error).message}`) }
  const candidates: Record<string, unknown> = {}
  try {
    inspected.push(`${kind} certification snapshot`)
    const snapshot = kind === 'activity'
      ? await api.readActivityCertificationSnapshot(scope) : await api.readWorkoutCertificationSnapshot(scope)
    if (snapshot.json) candidates.certificationSnapshot = JSON.parse(snapshot.json)
  } catch (error) { errors.push(`Certification snapshot: ${errorDetails(error).message}`) }
  try {
    inspected.push('owner/device-scoped Source Journal envelope inventory')
    const refs: Array<{ envelopeId: string; kind: string; receivedAt: string }> = []
    let afterSequence = 0
    for (let page = 0; page < 100; page++) {
      const inventory = await api.listSourceEnvelopes({ ...scope, afterSequence, limit: 100 })
      refs.push(...inventory.envelopes.map(({ envelopeId, kind: entryKind, receivedAt }) => ({ envelopeId, kind: entryKind, receivedAt })))
      if (!inventory.hasMore) break
      if (inventory.nextSequence <= afterSequence) throw new Error('Journal inventory pagination did not advance')
      afterSequence = inventory.nextSequence
      if (page === 99) errors.push('Journal inventory capped at 10,000 envelopes; inspection incomplete')
    }
    // v55 has no attempt ID/time in its marker. Inventory is retained as uncorrelated
    // evidence, never counted as commands/callbacks belonging to the failed test.
    candidates.uncorrelatedJournalInventory = refs
  } catch (error) { errors.push(`Source Journal: ${errorDetails(error).message}`) }
  if (legacyResultPresent || (!previous && !attempted && !native)) return { result: null, inspected, errors }
  const result = previous ?? newPhysicalResult(kind, {
    v8_state: 'UNKNOWN', authenticated_owner_resolved: null, owner_scope_resolved: null,
    journal_bound: null, device_scope_resolved: null,
  })
  if (!previous) {
    result.attempt_id = native?.attemptId ?? null
    result.started_at = null
    result.failed_at = null
    result.native_invocation_started = null
    result.acquisition_started = null
    result.ble_commands_issued = null
    result.command_types = null
    result.callbacks_received = null
    result.source_envelopes_written = null
    result.partial_evidence_present = null
  }
  const attempt = new PhysicalAttempt(result, () => {})
  if (native && (!previous || native.attemptId === previous.attempt_id)) {
    attempt.native(native)
    result.native_invocation_started = true
    if (native.sessionClosed !== true) {
      // An interrupted command request can have reached GATT after the last disk
      // checkpoint. Retain that checkpoint, but do not call its counters final.
      result.acquisition_started = null
      result.ble_commands_issued = null
      result.callbacks_received = null
      result.source_envelopes_written = null
    }
  }
  if (result.status !== 'FAILED' && result.status !== 'COMPLETE') {
    result.status = 'FAILED'
    result.failure_stage = native?.failureStage ?? 'UNKNOWN'
    result.error_code = native?.errorCode ?? 'RECOVERED_INCOMPLETE_ATTEMPT'
    result.error_message = native?.errorMessage ?? 'A durable attempt exists without a completed result. v55 did not persist its failure stage or original exception.'
  }
  if (result.status === 'FAILED') {
    result.retry_disposition = result.partial_evidence_present ? 'PARTIAL_SOURCE_EVIDENCE_REVIEW_FIRST'
      : result.ble_commands_issued && result.ble_commands_issued > 0 ? 'DEVICE_COMMAND_ISSUED_REVIEW_FIRST'
        : result.ble_commands_issued === 0 ? 'SAFE_TO_RETRY_NO_DEVICE_COMMAND' : 'RETRY_NOT_ALLOWED'
  }
  result.inspected_stores = inspected
  result.recovery_errors = errors
  result.diagnostics = { ...result.diagnostics, recovered: true, v55AttemptMarkerPresent: attempted, candidates }
  return { result, inspected, errors }
}
