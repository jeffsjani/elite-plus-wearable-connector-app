import { PHYSIOLOGY_CONTRACTS, PHYSIOLOGY_METRIC_KEYS, PHYSIOLOGY_METRIC_LABELS, type PhysiologyMetricKey } from './PhysiologyContract'
import { PHYSIOLOGY_DELIVERY_POLICY, type PhysiologyDeliverySnapshot, type PhysiologyMetricCounters } from './PhysiologyDelivery'
import type { HistoricalHrStreamSummary } from './HistoricalHrStream'
import type { JCVitalV8HistoricalHrStreamStats, JCVitalV8NativeBreadcrumb, JCVitalV8NativeBreadcrumbs } from './jcvitalV8Bridge'
import type { BreadcrumbSession, BreadcrumbState } from '../../services/diagnostics/CrashBreadcrumbs'
import type { ResponseShapeDiagnostic } from '../../services/sync/ObservationBatchManager'

interface PhysiologyDeliveryViewProps {
  snapshot: PhysiologyDeliverySnapshot
  busy: boolean
  onToggleEnabled: (enabled: boolean) => void
  onToggleMetric: (key: PhysiologyMetricKey, enabled: boolean) => void
  onReset: () => void
  safeTestDisabledReason: string | null
  /** Runs the streamed HR sync with a native limit on valid samples. */
  onHistoricalHrSafeTest: (maxValidSamples: number) => void
  heartRateStream: { native: JCVitalV8HistoricalHrStreamStats | null; js: HistoricalHrStreamSummary } | null
  nativeBreadcrumbs: JCVitalV8NativeBreadcrumbs | null
  lastResponseShape: ResponseShapeDiagnostic | null
  breadcrumbs: BreadcrumbState
}

function kb(bytes: number): string { return `${Math.round(bytes / 1024).toLocaleString()} KB` }

function NativeTrail({ label, trail }: { label: string; trail: JCVitalV8NativeBreadcrumb[] }) {
  const last = trail.at(-1)
  return <>
    <span>{label} · last native stage: <strong>{last?.stage ?? '—'}</strong>{last ? ` at ${last.at} ${JSON.stringify(last.detail)}` : ''}</span>
    <span>Native trail: {trail.slice(-12).map((crumb) => crumb.stage).join(' → ') || '—'}</span>
  </>
}

function SessionSummary({ label, session }: { label: string; session: BreadcrumbSession | null }) {
  if (!session) return <span>{label}: none recorded</span>
  const last = session.trail.at(-1)
  return <>
    <span>{label} (started {session.sessionStartedAt}) · last stage: <strong>{session.lastSuccessStage ?? '—'}</strong>{last ? ` at ${last.at}${last.detail ? ` ${JSON.stringify(last.detail)}` : ''}` : ''}</span>
    {session.lastHistoricalDeliveryError && <span role="alert">Last historical delivery error: {session.lastHistoricalDeliveryError.message} ({session.lastHistoricalDeliveryError.context ?? '—'}, {session.lastHistoricalDeliveryError.at})</span>}
    {session.lastUnhandledJsError && <span role="alert">Last unhandled JS error: {session.lastUnhandledJsError.message} ({session.lastUnhandledJsError.at})</span>}
    {session.lastUnhandledPromiseRejection && <span role="alert">Last unhandled promise rejection: {session.lastUnhandledPromiseRejection.message} ({session.lastUnhandledPromiseRejection.at})</span>}
    <span>Trail: {session.trail.slice(-12).map((crumb) => crumb.stage).join(' → ') || '—'}</span>
  </>
}

function Row({ label, counters }: { label: string; counters: PhysiologyMetricCounters }) {
  return <tr>
    <td>{label}</td><td>{counters.captured}</td><td>{counters.notDeliverable}</td><td>{counters.invalid}</td><td>{counters.queued}</td>
    <td>{counters.awaitingDelivery}</td><td>{counters.retrying}</td><td><strong>{counters.uniqueObservationsDelivered}</strong></td>
    <td>{counters.serverAccepted}</td><td>{counters.serverDuplicate}</td><td>{counters.serverRejected}</td>
    <td>{counters.canonicalized}</td><td>{counters.nativeOnly}</td><td>{counters.canonicalFailed}</td><td>{counters.failed}</td>
  </tr>
}

export function PhysiologyDeliveryView({ snapshot, busy, onToggleEnabled, onToggleMetric, onReset, safeTestDisabledReason, onHistoricalHrSafeTest, heartRateStream, nativeBreadcrumbs, lastResponseShape, breadcrumbs }: PhysiologyDeliveryViewProps) {
  const progress = snapshot.progress
  const lastHandling = snapshot.resultHandling.at(-1) ?? null
  const nativeStream = heartRateStream?.native ?? null
  const jsStream = heartRateStream?.js ?? null
  return <>
    <h3>Elite+ Delivery · JCVital historical physiology (Build 5B-1)</h3>
    <section className="workout-live-diagnostics" aria-label="Crash breadcrumbs">
      <strong>Crash breadcrumbs (persisted across restarts)</strong>
      <SessionSummary label="Previous app session" session={breadcrumbs.previous} />
      <SessionSummary label="This session" session={breadcrumbs.current} />
      {nativeBreadcrumbs && <>
        <NativeTrail label="Previous app session (native)" trail={nativeBreadcrumbs.previous} />
        <NativeTrail label="This session (native)" trail={nativeBreadcrumbs.current} />
      </>}
    </section>
    <div className="wearable-actions">
      <div className="diagnostic-control">
        <button type="button" disabled={safeTestDisabledReason !== null} onClick={() => onHistoricalHrSafeTest(PHYSIOLOGY_DELIVERY_POLICY.safeTestMaxObservations)}>Historical HR Safe Test (native-bounded first {PHYSIOLOGY_DELIVERY_POLICY.safeTestMaxObservations})</button>
        <small>{safeTestDisabledReason ? `Disabled: ${safeTestDisabledReason}` : 'Native stops expanding the band history after the first valid samples; at most that many cross the bridge. Works even with delivery toggled off.'}</small>
      </div>
      <div className="diagnostic-control">
        <button type="button" className="secondary" disabled={safeTestDisabledReason !== null} onClick={() => onHistoricalHrSafeTest(PHYSIOLOGY_DELIVERY_POLICY.boundedTestMaxObservations)}>Historical HR Bounded Test (native-bounded first {PHYSIOLOGY_DELIVERY_POLICY.boundedTestMaxObservations.toLocaleString()})</button>
        <small>Run only after the {PHYSIOLOGY_DELIVERY_POLICY.safeTestMaxObservations} Safe Test passes.</small>
      </div>
    </div>
    {jsStream && <section className="workout-live-diagnostics" aria-label="Historical HR native stream">
      <strong>Historical HR native stream{nativeStream?.safeTestLimit ? ` · native limit ${nativeStream.safeTestLimit}` : ''}{jsStream.finalReceived ? ' · final chunk received' : ' · streaming'}</strong>
      <span>JS received: {jsStream.chunksReceived} chunks · {jsStream.observationsReceived} observations · largest chunk {jsStream.largestChunkReceived} (≈ {kb(jsStream.largestChunkEstimatedBytes)}) · source records {jsStream.sourceRecordCount}</span>
      {nativeStream && <span>Native: vendor records {nativeStream.vendorRecordCount} · expanded {nativeStream.expandedSampleCount} · bridged {nativeStream.emittedSampleCount} (valid {nativeStream.validSampleCount}, skipped no-measurement {nativeStream.skippedNoMeasurementCount}, duplicate {nativeStream.duplicateCount}) · chunks {nativeStream.chunkCount} · largest {nativeStream.largestChunkCount} (≈ {kb(nativeStream.estimatedSerializedChunkBytes)}){nativeStream.safeTestLimitReached ? ' · limit reached' : ''}</span>}
      {nativeStream && <span>Ordering: vendor records arrived {nativeStream.vendorRecordOrder} (ascending {nativeStream.vendorAscendingTransitions} / descending {nativeStream.vendorDescendingTransitions}) · emitted {nativeStream.emittedOrder} · native out-of-order {nativeStream.outOfOrderEmitted}</span>}
      <span>Intervals: median {jsStream.intervals.medianSeconds ?? '—'} s · min {jsStream.intervals.minimumSeconds ?? '—'} · max {jsStream.intervals.maximumSeconds ?? '—'} · out-of-order {jsStream.intervals.outOfOrderTimestamps}</span>
    </section>}
    {(lastResponseShape || lastHandling) && <section className="workout-live-diagnostics" aria-label="Base44 per-observation results">
      <strong>Base44 per-observation results (last batch)</strong>
      {lastResponseShape && <span>Contract: {lastResponseShape.responseContractVersion ?? 'MISSING'} · deployment revision: {lastResponseShape.deploymentRevision ?? 'MISSING'}</span>}
      {lastResponseShape && (!lastResponseShape.responseContractVersion || !lastResponseShape.deploymentRevision) && <span role="alert">BASE44 RESPONSE FINGERPRINT MISSING · stop physical validation</span>}
      {lastResponseShape && <span>Transport: results[] {lastResponseShape.transportHasResults ? `present (${lastResponseShape.transportResultCount})` : 'ABSENT'} · keys [{lastResponseShape.transportTopLevelKeys.join(', ')}] · manager: results[] {lastResponseShape.responseHasResults ? `present (${lastResponseShape.responseResultCount})` : 'ABSENT'} · accepted {lastResponseShape.accepted ?? '—'} · duplicate {lastResponseShape.duplicate ?? '—'} · rejected {lastResponseShape.rejected ?? '—'} · canonical created {lastResponseShape.canonicalCreated ?? '—'} / failed {lastResponseShape.canonicalFailed ?? '—'}</span>}
      {lastResponseShape?.firstResults.map((result, index) => <span key={index}>#{index + 1} {result.observationIdPrefix ?? '—'}… · {result.status ?? '—'} · canonical {result.canonicalStatus ?? '—'} · nativeObservationId {result.hasNativeObservationId ? 'yes' : 'NO'}{result.reason ? ` · ${result.reason}` : ''}{result.errorCode ? ` · ${result.errorCode}` : ''}</span>)}
      {lastHandling && <span>PhysiologyDelivery: event results[] {lastHandling.eventHasResults ? `present (${lastHandling.eventResultCount})` : 'ABSENT'} · matched {lastHandling.matchedResults}/{lastHandling.trackedObservations} · accepted {lastHandling.appliedAccepted} · duplicate {lastHandling.appliedDuplicate} · canonicalized {lastHandling.appliedCanonicalized} · with nativeObservationId {lastHandling.withNativeObservationId}{lastHandling.legacyTotalsPath ? ' · LEGACY TOTALS PATH' : ''}</span>}
    </section>}
    {progress && <section className="workout-live-diagnostics" aria-label="Historical delivery progress">
      <strong>Historical delivery progress · type {progress.vendorDataType}{progress.safeTest ? ' · SAFE TEST' : ''} · {progress.stage}</strong>
      <span>Source records {progress.sourceRecords} · normalized {progress.normalized} · selected for test {progress.selectedForTest ?? 'all'} · mapped {progress.mapped} · queued {progress.queued} · already queued {progress.alreadyQueued} · non-deliverable {progress.notDeliverable}</span>
      <span>Chunk {progress.currentChunk} / ~{progress.estimatedTotalChunks} (≤ {PHYSIOLOGY_DELIVERY_POLICY.processingChunkSize} per chunk, largest {progress.largestChunk}) · delivered {snapshot.total.uniqueObservationsDelivered} · duplicate {snapshot.total.serverDuplicate} · rejected {snapshot.total.serverRejected}</span>
    </section>}
    <div className="wearable-actions">
      <label className="workout-mode">
        <input type="checkbox" checked={snapshot.enabled} disabled={busy} onChange={(event) => onToggleEnabled(event.target.checked)} />
        {' '}Deliver historical physiology to Elite+ after each Sync
      </label>
      {PHYSIOLOGY_METRIC_KEYS.map((key) => <label key={key} className="workout-mode">
        <input type="checkbox" checked={snapshot.enabledMetrics.includes(key)} disabled={busy} onChange={(event) => onToggleMetric(key, event.target.checked)} />
        {' '}{PHYSIOLOGY_METRIC_LABELS[key]}
      </label>)}
      <button type="button" className="secondary" disabled={busy} onClick={onReset}>Reset 5B-1 counters</button>
    </div>
    <section className="workout-live-diagnostics" aria-label="Historical physiology delivery diagnostics">
      <span>Backend Device ID: {snapshot.backendDeviceId ?? '— (resolved on connect)'} · last sync: {snapshot.lastSync ? `type ${snapshot.lastSync.vendorDataType} · mapped ${snapshot.lastSync.mapped} · newly queued ${snapshot.lastSync.queued} · non-deliverable ${snapshot.lastSync.notDeliverable} · ${snapshot.lastSync.at}` : '—'}</span>
      {snapshot.lastError && <span role="alert">Last delivery error: {snapshot.lastError}</span>}
      {snapshot.lastInvalidReason && <span>Last invalid observation: {snapshot.lastInvalidReason}</span>}
      <span>Per-observation outcomes · {Object.entries(snapshot.outcomeCounts).filter(([, count]) => count > 0).map(([state, count]) => `${state} ${count}`).join(' · ') || '—'}. Native-only (canonical not applicable) is a successful delivery.</span>
      {snapshot.lastRejection && <span role="alert">Last rejection: {snapshot.lastRejection.metric ?? '—'} {snapshot.lastRejection.observationId?.slice(0, 12) ?? '—'} · {snapshot.lastRejection.errorCode ?? '—'} · {snapshot.lastRejection.reason ?? '—'}</span>}
      {snapshot.lastCanonicalFailure && <span role="alert">CANONICAL_FAILED (stored as NativeObservation): {snapshot.lastCanonicalFailure.metric} · {snapshot.lastCanonicalFailure.errorCode ?? '—'} · {snapshot.lastCanonicalFailure.reason ?? '—'}</span>}
      {snapshot.unattributedErrors > 0 && <span>errors[] entries without observationId: {snapshot.unattributedErrors}</span>}
      <span>Server counts come from per-observation results[]; batch-level totals are used only for responses without results[] (mixed · accepted {snapshot.mixedBatchServerAccepted} · duplicate {snapshot.mixedBatchServerDuplicate}). Duplicate receipts are not duplicate physiology.</span>
    </section>
    <div className="workout-packet-table-wrap">
      <table className="workout-packet-table">
        <thead><tr><th>Metric</th><th>Captured</th><th>No-measurement</th><th>Invalid</th><th>Queued</th><th>Awaiting</th><th>Retrying</th><th>Unique delivered</th><th>Server accepted</th><th>Server duplicate</th><th>Server rejected</th><th>Canonicalized</th><th>Native only</th><th>Canonical failed</th><th>Failed</th></tr></thead>
        <tbody>
          {PHYSIOLOGY_METRIC_KEYS.map((key) => <Row key={key} label={PHYSIOLOGY_METRIC_LABELS[key]} counters={snapshot.metrics[key]} />)}
          <Row label="JCVital 5B-1 total" counters={snapshot.total} />
        </tbody>
      </table>
    </div>
    <div className="workout-packet-table-wrap">
      <table className="workout-packet-table">
        <thead><tr><th>Connector metricType</th><th>metric</th><th>Unit</th><th>Vendor type</th><th>Canonical target</th><th>Vendor-derived</th><th>Policy</th></tr></thead>
        <tbody>{PHYSIOLOGY_CONTRACTS.map((contract) => <tr key={contract.metricType}>
          <td>{contract.metricType}</td><td>{contract.metric}</td><td>{contract.unit}</td><td>{contract.vendorDataType}</td>
          <td>{contract.canonicalTarget ?? '— (NativeObservation only)'}</td><td>{String(contract.vendorDerived)}</td><td>{contract.canonicalPolicy}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>
}
