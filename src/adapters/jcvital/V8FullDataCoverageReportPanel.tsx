import { useState } from 'react'
import { IS_ENGINEERING_BUILD } from '../../buildMode'
import { saveValidationJson, serializeCertificationJson } from './CertificationJsonExport'
import {
  createV8FullDataCoverageReport,
  V8_FULL_DATA_COVERAGE_REPORT_FILENAME,
} from './V8FullDataCoverageReport'

export function V8FullDataCoverageReportPanel() {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')

  if (!IS_ENGINEERING_BUILD) return null

  async function exportReport(): Promise<void> {
    setStatus('')
    setError('')
    try {
      const json = serializeCertificationJson(createV8FullDataCoverageReport())
      const location = await saveValidationJson(
        V8_FULL_DATA_COVERAGE_REPORT_FILENAME,
        json,
        'Elite+ V8 Full Data Coverage Report',
        'Save or share the read-only V8 coverage report',
      )
      setStatus(`Coverage report exported: ${location}`)
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
    }
  }

  const report = createV8FullDataCoverageReport()
  return (
    <section className="diagnostics engineering-v8-coverage" aria-label="V8 full data coverage report">
      <h2>V8 Full Data Coverage</h2>
      <p>Read-only registry export. This report does not connect, acquire, sync, enqueue, deliver, or modify queue, journal, or canonical data.</p>
      <p>
        Discovered: {report.rollups.totalSdkFieldsDiscovered}
        {' · '}classified: {report.rollups.classifiedFields}
        {' · '}unclassified: {report.rollups.unclassifiedFields}
        {' · '}canonical production: {report.rollups.canonicalProduction}
        {' · '}source-only: {report.rollups.sourceOnlyValidated}
        {' · '}blocked: {report.rollups.blocked}
      </p>
      <button type="button" onClick={() => void exportReport()}>Export V8 Full Data Coverage Report</button>
      {status && <p role="status">{status}</p>}
      {error && <p className="error-message" role="alert">{error}</p>}
      <details>
        <summary>Coverage registry fields ({report.fields.length})</summary>
        <div className="engineering-table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Type / field</th>
                <th scope="col">Exposure / acquisition</th>
                <th scope="col">Capture / certification</th>
                <th scope="col">Semantics / unit</th>
                <th scope="col">Timestamp</th>
                <th scope="col">Canonical / authority</th>
                <th scope="col">Domain eligibility</th>
                <th scope="col">Readiness / scoring</th>
                <th scope="col">Evidence / blockers / state</th>
              </tr>
            </thead>
            <tbody>
              {report.fields.map((field) => (
                <tr key={`${field.vendorDataType ?? 'unknown'}:${field.vendorField}`}>
                  <th scope="row">{field.vendorDataType ?? '—'} / {field.vendorField}</th>
                  <td>{field.sdkExposure} · {field.acquisitionSupport}</td>
                  <td>{field.sourcePreservation} · {field.sourceCertification}</td>
                  <td>{field.semanticClassification} · {field.unit} ({field.unitConfidence})</td>
                  <td>{field.timestampSemantics} · {field.timestampConfidence}</td>
                  <td>{field.canonicalTarget ?? '—'} · {field.canonicalEligibility} · {field.canonicalAuthority}</td>
                  <td>
                    Body {field.bodyEligibility ? 'YES' : 'NO'} · Sleep {field.sleepEligibility ? 'YES' : 'NO'}
                    {' · '}Activity {field.activityEligibility ? 'YES' : 'NO'} · Workout {field.workoutEligibility ? 'YES' : 'NO'}
                  </td>
                  <td>Readiness {field.readinessEligibility ? 'YES' : 'NO'} · Scoring {field.scoringEligibility ? 'YES' : 'NO'}</td>
                  <td>{[...field.evidenceReferences, ...field.knownLimitations, field.finalDisposition].join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </section>
  )
}
