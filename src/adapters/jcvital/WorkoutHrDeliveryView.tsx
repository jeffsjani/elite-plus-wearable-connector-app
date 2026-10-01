import type { QueueStats } from '../../services/storage/ObservationQueueStore'
import type { WorkoutHrDeliverySnapshot } from './WorkoutHrDelivery'

export const WORKOUT_HR_E2E_TEST_DURATION_MS = 120_000

interface WorkoutHrDeliveryViewProps {
  snapshot: WorkoutHrDeliverySnapshot
  queueStats: QueueStats | null
  connectorRegistered: boolean
  bleDeviceLocalOnly: string | null
  online: boolean
  e2eTestEndsAt: number | null
  now: number
  startTestDisabledReason: string | null
  busy: boolean
  onToggleEnabled: (enabled: boolean) => void
  onStartTest: () => void
  onFlush: () => void
  onReplay: () => void
}

export function WorkoutHrDeliveryView({
  snapshot, queueStats, connectorRegistered, bleDeviceLocalOnly, online, e2eTestEndsAt, now, startTestDisabledReason, busy,
  onToggleEnabled, onStartTest, onFlush, onReplay,
}: WorkoutHrDeliveryViewProps) {
  const pendingObservations = (queueStats?.pending ?? 0) + (queueStats?.retrying ?? 0)
  const pendingBatches = Math.ceil(pendingObservations / 100) + (queueStats?.inFlight ? 1 : 0)
  const remainingSeconds = e2eTestEndsAt === null ? null : Math.max(0, Math.ceil((e2eTestEndsAt - now) / 1000))
  return <>
    <h3>Elite+ Delivery · Workout HR</h3>
    <div className="wearable-actions">
      <label className="workout-mode">
        <input type="checkbox" checked={snapshot.enabled} disabled={busy} onChange={(event) => onToggleEnabled(event.target.checked)} />
        {' '}Deliver live workout HR to Elite+
      </label>
      <div className="diagnostic-control">
        <button type="button" disabled={busy || startTestDisabledReason !== null} onClick={onStartTest}>Start 2-min Elite+ HR Test</button>
        {startTestDisabledReason && <small>Disabled: {startTestDisabledReason}</small>}
      </div>
      <button type="button" className="secondary" disabled={busy} onClick={onFlush}>Flush Now</button>
      <button type="button" className="secondary" disabled={busy || snapshot.delivered === 0} onClick={onReplay}>Replay Delivered (idempotency)</button>
    </div>
    <section className="workout-live-diagnostics" aria-label="Connector delivery diagnostics">
      <strong>Connector delivery{remainingSeconds !== null ? ` · test auto-stop in ${remainingSeconds}s` : ''}</strong>
      <span>Backend Device ID (sent to Elite+): {snapshot.backendDeviceId ?? '— (resolved on connect/workout start)'}</span>
      <span>BLE Device: {bleDeviceLocalOnly ?? '—'} · LOCAL ONLY (never sent to Elite+)</span>
      <span>Connector registered: {connectorRegistered ? 'yes' : 'NO — register before testing'} · network: {online ? 'online' : 'OFFLINE'}</span>
      <span>Queue (all sources) · pending: {queueStats?.pending ?? '—'} · sending: {queueStats?.inFlight ?? '—'} · retrying: {queueStats?.retrying ?? '—'} · failed: {queueStats?.failed ?? '—'} · pending batches: {queueStats ? pendingBatches : '—'}</span>
      <span>JCVital HR captured: {snapshot.captured} · queued: {snapshot.queued} · delivered: {snapshot.delivered}</span>
      <span>JCVital awaiting delivery: {snapshot.queuedAwaitingDelivery} · retrying: {snapshot.retrying} · failed: {snapshot.failed} · awaiting enqueue: {snapshot.awaitingEnqueue}</span>
      <span>Not sent · zero/implausible HR: {snapshot.skippedNonDeliverable} · captured while disabled: {snapshot.capturedWhileDisabled} · preflight invalid: {snapshot.invalid} · missing device context: {snapshot.contextMissing}</span>
      <span>Batches · attempted: {snapshot.batchesAttempted} · delivered: {snapshot.batchesDelivered} · retried: {snapshot.batchesRetried} · failed: {snapshot.batchesFailed}</span>
      <span>Server (batch totals) · accepted: {snapshot.serverAcceptedInBatches} · duplicate: {snapshot.serverDuplicateInBatches} · rejected: {snapshot.serverRejectedInBatches}</span>
      <span>Replay · re-queued: {snapshot.replayQueued} · already queued locally: {snapshot.replayAlreadyQueued} · re-acknowledged: {snapshot.replayAcknowledged}</span>
      <span>Last delivery: {snapshot.lastDeliveryAt ?? '—'} · last result: {snapshot.lastResult ? `${snapshot.lastResult.outcome} · HTTP ${snapshot.lastResult.httpStatus ?? '—'}${snapshot.lastResult.errorCode ? ` · ${snapshot.lastResult.errorCode}` : ''}` : '—'}</span>
      <span>Last flush: {snapshot.lastFlushReason ?? '—'} {snapshot.lastFlushAt ?? ''} · workout-stop flushes: {snapshot.workoutStopFlushes}</span>
      <span>Policy: flush every {snapshot.policy.flushObservationCount} observations or {snapshot.policy.flushIntervalMs / 1000}s, and on workout stop · observedAt = {snapshot.timestampPolicy.observedAtSource}</span>
    </section>
  </>
}
