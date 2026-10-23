interface Type42CertificationViewProps {
  busy: boolean
  captureDisabledReason: string | null
  journalScopeAvailable: boolean
  status: string
  evidence: string | null
  exportLocation: string | null
  onCapture: () => void
  onInspect: () => void
  onExport: () => void
}

export function Type42CertificationView({
  busy, captureDisabledReason, journalScopeAvailable, status, evidence, exportLocation,
  onCapture, onInspect, onExport,
}: Type42CertificationViewProps) {
  return <section aria-label="Grouped type-42 certification">
    <h4>Official type-42 grouped certification · native/research only</h4>
    <p>One history retrieval; one durable source record; four linked native-only children.
      No vascularAging or embedded HR promotion. No fatigueDegree expected.</p>
    <div className="wearable-actions">
      <div className="diagnostic-control">
        <button type="button" disabled={busy || captureDisabledReason !== null}
          title={captureDisabledReason ?? 'Acquire type-42 history once and target exactly four child IDs'}
          onClick={onCapture}>Capture + Queue + Targeted Deliver Type 42</button>
        {captureDisabledReason && <small>Disabled: {captureDisabledReason}</small>}
      </div>
      <button type="button" disabled={busy || !journalScopeAvailable} onClick={onInspect}>Inspect Saved Type-42 Certification</button>
      <button type="button" disabled={busy || !journalScopeAvailable} onClick={onExport}>Export Type-42 Certification JSON</button>
    </div>
    <p>Inspection/export reads durable local evidence only: no history command, queue insertion, or Base44 request.
      If a group is already saved, the capture action must not reacquire it.</p>
    {status && <p role="status">{status}</p>}
    {exportLocation && <p>Type-42 export: {exportLocation}</p>}
    {evidence && <details className="jcvital-diagnostics">
      <summary>Saved type-42 source group and exact receipts</summary>
      <pre>{evidence}</pre>
    </details>}
  </section>
}
