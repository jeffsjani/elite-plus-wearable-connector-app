import type { PhysicalSemanticNativeEvidence } from './jcvitalV8Bridge'
import { errorDetails, PhysicalAttempt, type FailureResult } from './PhysicalSemanticEvidence'
import { physicalFinalizationRead } from './PhysicalFinalizationTimeout'

export type PhysicalTestOperations = {
  checkpoint(result: FailureResult): void
  markAttempt(): void
  quiesce(attempt: PhysicalAttempt): { wait(): Promise<void>; resume(): void }
  lock(): () => void
  begin(attemptId: string): Promise<PhysicalSemanticNativeEvidence>
  end(): Promise<PhysicalSemanticNativeEvidence>
  readNative(): Promise<PhysicalSemanticNativeEvidence | null>
  preflight(attempt: PhysicalAttempt): Promise<void>
  run(attempt: PhysicalAttempt, finish: () => Promise<PhysicalSemanticNativeEvidence>): Promise<unknown>
  finalize(result: FailureResult): Promise<void>
  persist(result: FailureResult): void
  backup(result: FailureResult): void
}

export async function executePhysicalAttempt(initial: FailureResult, ops: PhysicalTestOperations): Promise<FailureResult> {
  const attempt = new PhysicalAttempt(initial, ops.checkpoint)
  let release: (() => void) | null = null
  let quiescence: ReturnType<PhysicalTestOperations['quiesce']> | null = null
  let nativeActive = false
  let primaryError: unknown
  let failed = false
  const finish = async () => {
    const evidence = await physicalFinalizationRead(ops.end(), 'Closing native physical session')
    nativeActive = false
    attempt.native(evidence)
    return evidence
  }
  try {
    ops.markAttempt()
    attempt.completed('ELIGIBILITY_CONFIRMED')
    attempt.completed('OWNER_SCOPE_CONFIRMED')
    attempt.before('SENDER_QUIESCE_REQUESTED')
    quiescence = ops.quiesce(attempt)
    attempt.completed('SENDER_QUIESCE_REQUESTED')
    await quiescence.wait()
    attempt.completed('SENDER_QUIESCED')
    attempt.before('ISOLATION_LOCK_ACQUIRED')
    release = ops.lock()
    attempt.completed('ISOLATION_LOCK_ACQUIRED')
    attempt.before('ISOLATION_PREFLIGHT')
    await ops.preflight(attempt)
    attempt.before('NATIVE_BRIDGE_ENTERED')
    attempt.result.native_invocation_started = null
    // Until native evidence is returned, transport outcome is unknown, not zero.
    attempt.result.acquisition_started = null
    attempt.result.ble_commands_issued = null
    attempt.result.callbacks_received = null
    attempt.result.source_envelopes_written = null
    ops.checkpoint(attempt.result)
    attempt.before('NATIVE_SESSION_CREATED')
    const native = await ops.begin(attempt.result.attempt_id!)
    nativeActive = true
    attempt.native(native)
    attempt.completed('NATIVE_BRIDGE_ENTERED')
    attempt.completed('NATIVE_SESSION_CREATED')
    attempt.result.acquisition_started = null
    attempt.result.ble_commands_issued = null
    attempt.result.callbacks_received = null
    attempt.result.source_envelopes_written = null
    ops.checkpoint(attempt.result)
    attempt.result.result = await ops.run(attempt, finish)
    attempt.completed('RESULT_BUILT')
  } catch (error) {
    if (attempt.stage === 'NATIVE_SESSION_CREATED'
      && ['UNIMPLEMENTED', 'UNAVAILABLE'].includes(errorDetails(error).code)) {
      attempt.stage = 'NATIVE_BRIDGE_ENTERED'
      attempt.result.native_invocation_started = false
      attempt.result.acquisition_started = false
      attempt.result.ble_commands_issued = 0
      attempt.result.callbacks_received = 0
      attempt.result.source_envelopes_written = 0
    }
    failed = true
    primaryError = error
  } finally {
    if (nativeActive) {
      try { await finish() }
      catch (error) {
        attempt.result.cleanup_errors.push(errorDetails(error).message)
        if (!failed) { failed = true; primaryError = error; attempt.stage = 'CLEANUP' }
      }
    }
    if (attempt.result.native_invocation_started !== false) {
      try {
        const saved = await physicalFinalizationRead(ops.readNative(), 'Reading terminal native evidence')
        if (saved && saved.attemptId === attempt.result.attempt_id) attempt.native(saved)
      } catch (error) { attempt.result.recovery_errors.push(`Reading native failure evidence: ${errorDetails(error).message}`) }
    }
    if (nativeActive) {
      attempt.result.ble_commands_issued = null
      attempt.result.callbacks_received = null
      attempt.result.source_envelopes_written = null
    }
    try { await physicalFinalizationRead(ops.finalize(attempt.result), 'Final isolation accounting') }
    catch (error) {
      attempt.result.recovery_errors.push(`Final isolation snapshot: ${errorDetails(error).message}`)
      if (!failed) { failed = true; primaryError = error; attempt.stage = 'ISOLATION_FINALIZATION' }
    }
    try { release?.() }
    catch (error) {
      attempt.result.cleanup_errors.push(`Isolation release: ${errorDetails(error).message}`)
      if (!failed) { failed = true; primaryError = error; attempt.stage = 'CLEANUP' }
    } finally {
      try { quiescence?.resume() }
      catch (error) {
        attempt.result.cleanup_errors.push(`Sender resume: ${errorDetails(error).message}`)
        if (!failed) { failed = true; primaryError = error; attempt.stage = 'CLEANUP' }
      }
    }
  }
  if (failed) attempt.fail(primaryError)
  else attempt.result.status = 'COMPLETE'
  try {
    if (!failed) attempt.before('RESULT_PERSISTENCE')
    ops.persist(attempt.result)
    if (!failed) {
      attempt.completed('RESULT_PERSISTED')
      attempt.completed('COMPLETE')
      ops.persist(attempt.result)
    }
  } catch (error) {
    attempt.result.persistence_errors.push(errorDetails(error).message)
    if (!failed) {
      attempt.stage = 'RESULT_PERSISTENCE'
      attempt.fail(error)
    }
    try { ops.checkpoint(attempt.result) }
    catch (checkpointError) { attempt.result.persistence_errors.push(`Terminal checkpoint failed: ${errorDetails(checkpointError).message}`) }
    try { ops.backup(attempt.result) }
    catch (backupError) { attempt.result.persistence_errors.push(`Backup failed: ${errorDetails(backupError).message}`) }
  }
  return attempt.result
}
