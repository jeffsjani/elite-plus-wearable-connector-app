import { JCVitalSourceCapabilityRegistry } from './SourceCapabilityRegistry'

export function SourceCapabilityMatrix() {
  return (
    <details className="engineering-capability-matrix">
      <summary>Source Certification Matrix</summary>
      <div className="engineering-table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Source</th>
              <th scope="col">Vendor Type</th>
              <th scope="col">Capture Status</th>
              <th scope="col">Semantic Status</th>
              <th scope="col">Canonical Authority</th>
              <th scope="col">Scoring Authority</th>
              <th scope="col">Limitation</th>
              <th scope="col">Last Certified Build</th>
            </tr>
          </thead>
          <tbody>
            {JCVitalSourceCapabilityRegistry.map((source) => (
              <tr key={source.sourceFamily}>
                <th scope="row">{source.engineeringLabel}</th>
                <td>{source.vendorDataTypes.length ? source.vendorDataTypes.join(', ') : '—'}</td>
                <td>{source.captureStatus}</td>
                <td>{source.semanticConfidence}</td>
                <td>{source.canonicalEligibility}</td>
                <td>{source.scoringEligibility}</td>
                <td>{source.knownLimitations.length ? source.knownLimitations.join(' ') : '—'}</td>
                <td>{source.lastCertificationBuild ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p>Capture eligibility ≠ canonical eligibility ≠ scoring eligibility.</p>
      <p>ECG is BLOCKED_VENDOR_DEPENDENCY. Awaiting authoritative JCVital SDK/protocol guidance before implementation.</p>
      <p>Raw PPG remains RESEARCH_NATIVE_ONLY, UNKNOWN_VENDOR_UNIT, and isolated from glucose and CGM semantics.</p>
    </details>
  )
}
