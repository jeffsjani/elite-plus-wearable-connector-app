import { PHYSIOLOGY_CONTRACTS, PHYSIOLOGY_METRIC_KEYS, PHYSIOLOGY_METRIC_LABELS, type PhysiologyMetricKey } from './PhysiologyContract'
import type { PhysiologyDeliverySnapshot, PhysiologyMetricCounters } from './PhysiologyDelivery'

interface PhysiologyDeliveryViewProps {
  snapshot: PhysiologyDeliverySnapshot
  busy: boolean
  onToggleEnabled: (enabled: boolean) => void
  onToggleMetric: (key: PhysiologyMetricKey, enabled: boolean) => void
  onReset: () => void
}

function Row({ label, counters }: { label: string; counters: PhysiologyMetricCounters }) {
  return <tr>
    <td>{label}</td><td>{counters.captured}</td><td>{counters.notDeliverable}</td><td>{counters.invalid}</td><td>{counters.queued}</td>
    <td>{counters.awaitingDelivery}</td><td>{counters.retrying}</td><td><strong>{counters.uniqueObservationsDelivered}</strong></td>
    <td>{counters.serverAccepted}</td><td>{counters.serverDuplicate}</td><td>{counters.serverRejected}</td>
    <td>{counters.canonicalized}</td><td>{counters.nativeOnly}</td><td>{counters.canonicalFailed}</td><td>{counters.failed}</td>
  </tr>
}

export function PhysiologyDeliveryView({ snapshot, busy, onToggleEnabled, onToggleMetric, onReset }: PhysiologyDeliveryViewProps) {
  return <>
    <h3>Elite+ Delivery · JCVital historical physiology (Build 5B-1)</h3>
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
      <span>Backend Device ID: {snapshot.backendDeviceId ?? '— (resolved on connect)'} · last sync: {snapshot.lastSync ? `type ${snapshot.lastSync.vendorDataType} · mapped ${snapshot.lastSync.mapped} · newly queued ${snapshot.lastSync.queued} · ${snapshot.lastSync.at}` : '—'}</span>
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
