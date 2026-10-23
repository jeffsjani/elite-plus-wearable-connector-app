import type { QueueStats } from '../storage/ObservationQueueStore'
import type { ObservationBatchManager } from '../sync/ObservationBatchManager'
import { physicalTestIsolationSnapshot, releaseSavedPhysicalTestIsolation, requestPhysicalTestSenderPause } from './PhysicalTestIsolation'

export const PHYSICAL_TEST_QUIESCE_TIMEOUT_MS = 60_000

export function cleanupSavedPhysicalTest(
  sender: Pick<ObservationBatchManager, 'getPhysicalTestSenderState' | 'resumeAfterPhysicalTest'>,
  release = releaseSavedPhysicalTestIsolation,
) {
  let isolationReleasedAt: string | null = null
  let senderResumedAt: string | null = null
  let previous: ReturnType<typeof release> | null = null
  let state: ReturnType<typeof sender.getPhysicalTestSenderState> | null = null
  let disposition = 'CLEANUP_FAILED'
  const errors: string[] = []
  try {
    previous = release()
    isolationReleasedAt = new Date().toISOString()
  } catch (error) {
    errors.push(`Isolation release: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    try {
      state = sender.getPhysicalTestSenderState()
      const alreadyRunning = state.activeRequest || state.activeWorkers > 0 || state.claimOwner !== null
        || state.startupOperations > 0
      if (!alreadyRunning && isolationReleasedAt && (previous?.active || previous?.senderPause !== null)) {
        sender.resumeAfterPhysicalTest()
      }
      if (!state.started || state.paused) {
        disposition = 'SENDER_POLICY_NOT_RUNNING'
        errors.push(`Sender not resumed: ${state.paused ? state.pauseReason ?? 'DELIVERY_PAUSED' : 'NOT_STARTED'}; existing enablement/pause policy preserved.`)
      } else if (isolationReleasedAt) {
        senderResumedAt = new Date().toISOString()
        disposition = alreadyRunning ? 'ALREADY_RUNNING_NO_NEW_WORKER'
          : previous?.active || previous?.senderPause !== null ? 'RESUME_REQUESTED' : 'ALREADY_UNPAUSED_NO_NEW_WORKER'
      }
    } catch (error) {
      errors.push(`Sender resume: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {
    isolationReleasedAt, senderResumedAt, errors,
    state: { previous, sender: state, disposition,
      timestampMeaning: 'V60_OBSERVED_OR_RELEASED_NOT_HISTORICAL_V59_TIME' },
  }
}

export type SenderQuiescenceEvidence = {
  queue_before_quiesce: QueueStats | null
  inFlight_before: number | null
  quiesce_requested_at: string
  last_inflight_completed_at: string | null
  quiesce_completed_at: string | null
  queue_at_test_start: QueueStats | null
  senderQuiesced: boolean
  current_inFlight: number | null
  last_batch_id: string | null
  last_sender_error: string | null
  isolation_released_at: string | null
  sender_resumed_at: string | null
}

export function requestPhysicalTestQuiescence(
  sender: Pick<ObservationBatchManager, 'getPhysicalTestSenderState' | 'resumeAfterPhysicalTest'>,
  queue: { getQueueStats(): Promise<QueueStats>; getOwnerUserId(): string | null },
  owner: string,
  onWaiting: (inFlight: number) => void,
  timeoutMs = PHYSICAL_TEST_QUIESCE_TIMEOUT_MS,
) {
  const pause = requestPhysicalTestSenderPause()
  const evidence: SenderQuiescenceEvidence = {
    queue_before_quiesce: null, inFlight_before: null, quiesce_requested_at: new Date().toISOString(),
    last_inflight_completed_at: null, quiesce_completed_at: null, queue_at_test_start: null,
    senderQuiesced: false, current_inFlight: null, last_batch_id: null, last_sender_error: null,
    isolation_released_at: null, sender_resumed_at: null,
  }
  let released = false
  return {
    evidence,
    async wait() {
      const deadline = performance.now() + timeoutMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('The current saved-data upload did not settle before the physical-test wait expired.'), {
          code: 'SENDER_QUIESCE_TIMEOUT',
        })), timeoutMs)
      })
      const inspect = async () => {
        while (!released && performance.now() < deadline) {
          if (queue.getOwnerUserId() !== owner) throw Object.assign(new Error('Queue owner changed while preparing the isolated test.'), { code: 'OWNER_SCOPE_MISMATCH' })
          const stats = await queue.getQueueStats()
          if (released) return
          if (queue.getOwnerUserId() !== owner) throw Object.assign(new Error('Queue owner changed while reading saved-data state.'), { code: 'OWNER_SCOPE_MISMATCH' })
          const state = sender.getPhysicalTestSenderState()
          evidence.queue_before_quiesce ??= { ...stats }
          evidence.inFlight_before ??= stats.inFlight
          evidence.current_inFlight = stats.inFlight
          evidence.last_batch_id = state.lastBatchId
          evidence.last_sender_error = state.lastSenderError
          evidence.last_inflight_completed_at = state.lastInflightCompletedAt
          const effects = physicalTestIsolationSnapshot()
          if (stats.inFlight === 0 && !state.activeRequest && state.claimOwner === null
            && state.activeWorkers === 0 && state.startupOperations === 0
            && effects.inFlight.queue === 0 && effects.inFlight.base44 === 0) {
            evidence.senderQuiesced = true
            evidence.quiesce_completed_at = new Date().toISOString()
            evidence.queue_at_test_start = { ...stats }
            pause.quiesced()
            return
          }
          onWaiting(stats.inFlight)
          await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - performance.now()))))
        }
        await timeout
      }
      try { await Promise.race([inspect(), timeout]) }
      finally { clearTimeout(timer) }
    },
    resume() {
      if (released) return
      released = true
      evidence.isolation_released_at = new Date().toISOString()
      pause.release()
      evidence.sender_resumed_at = new Date().toISOString()
      sender.resumeAfterPhysicalTest()
    },
  }
}
