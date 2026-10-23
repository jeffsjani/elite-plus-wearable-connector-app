import { useEffect, useState } from 'react'
import { saveValidationJson } from './CertificationJsonExport'
import { JCVitalV8, type JCVitalV8MonitoringConfiguration } from './jcvitalV8Bridge'
import { parseServerAudit, type ServerAudit } from './V8PipelineDiagnostic'
import { interpretReport, pipelineSnapshot, preSyncReport, resetPipelineGuard, restorePipelineReport,
  runPipelineDiagnostic, type PipelineReport } from './V8PipelineDiagnosticService'

function EvidenceValue({ value }: { value: unknown }) {
  if (value === undefined) return <span>Not captured</span>
  if (value === null) return <span>UNKNOWN</span>
  if (Array.isArray(value)) return value.length
    ? <ol className="engineering-evidence-list">{value.map((item, index) => <li key={index}><EvidenceValue value={item} /></li>)}</ol>
    : <span>None (0)</span>
  if (typeof value === 'object') return <dl className="engineering-evidence-values">
    {Object.entries(value).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><EvidenceValue value={item} /></dd></div>)}
  </dl>
  return <span>{String(value)}</span>
}

export function PipelineEvidenceTable({ label, values }: { label: string; values: Record<string, unknown> }) {
  return <table className="engineering-evidence-table" aria-label={label}>
    <thead><tr><th scope="col">Field</th><th scope="col">Value</th></tr></thead>
    <tbody>{Object.entries(values).map(([key, value]) => <tr key={key}>
      <th scope="row">{key}</th><td data-label={key}><EvidenceValue value={value} /></td>
    </tr>)}</tbody>
  </table>
}

export function V8PipelineDiagnosticView({ ownerUserId }: { ownerUserId: string }) {
  const [report, setReport] = useState<PipelineReport | null>(null)
  const [server, setServer] = useState<ServerAudit | null>(null)
  const [settings, setSettings] = useState<JCVitalV8MonitoringConfiguration | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [exported, setExported] = useState(false)
  const [saved, setSaved] = useState('')
  const [otherOwnerEvidence, setOtherOwnerEvidence] = useState(false)
  const [preExportSignature, setPreExportSignature] = useState('')
  const diagnostic = report ? interpretReport(report) : null
  const sameOwner = !report || report.pre.identity.authenticatedElitePlusUserId === ownerUserId

  useEffect(() => {
    let active = true
    void restorePipelineReport().then((savedReport) => {
      if (!active || !savedReport) return
      if (savedReport.pre.identity.authenticatedElitePlusUserId !== ownerUserId) {
        setOtherOwnerEvidence(true)
        setError('A diagnostic for another account is preserved locally. Sign in to that account to inspect/export it; it has not been deleted.')
        return
      }
      setReport(savedReport)
      setServer(savedReport.serverAudit)
      setSettings(savedReport.deviceSettings)
    }).catch((failure: unknown) => { if (active) setError(`Restore diagnostic: ${String(failure)}`) })
    return () => { active = false }
  }, [ownerUserId])

  async function action(operation: () => Promise<void>) {
    setBusy(true)
    setError('')
    try { await operation() } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure))
      console.error('V8 Pipeline Diagnostic', failure)
    } finally { setBusy(false) }
  }

  async function share(phase: 'pre' | 'post') {
    const source = phase === 'pre'
      ? preSyncReport(report?.post ? report.pre : await pipelineSnapshot(server), server, settings)
      : report
    if (!source || !sameOwner) throw new Error('PIPELINE_REPORT_NOT_AVAILABLE_FOR_CURRENT_OWNER')
    const json = JSON.stringify(interpretReport(source), null, 2)
    const filename = `ElitePlus-V8-Pipeline-32A-${phase}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
    setSaved(await saveValidationJson(filename, json, 'V8 Pipeline Diagnostic', 'Share V8 Pipeline Diagnostic JSON'))
    if (phase === 'pre') setPreExportSignature(JSON.stringify({
      scopes: source.pre.binding.scopes, deviceScopeId: source.pre.identity.deviceScopeId, physicalBleDeviceId: source.pre.identity.physicalBleDeviceId,
    }))
    if (phase === 'pre' && !report?.post) setReport(source)
    if (phase === 'post' && (source.post || source.state === 'FAILED_OR_INTERRUPTED')) setExported(true)
  }

  return <section className="diagnostics engineering-pipeline" aria-label="V8 Pipeline Diagnostic">
    <h2>V8 Pipeline Diagnostic</h2>
    <p>Build 32A.1 UI hotfix · Build 32A diagnostic unchanged. Engineering only. No certification, workout, ECG, rebinding, configuration changes or manual queue replay.</p>
    <p>Normal Build 31 Sync delivers queued rows only. It does not pull history. Missing server owner identity remains UNKNOWN, never a guessed match.</p>
    <section aria-label="Account Binding">
      <h3>Account Binding / Identity{diagnostic && ` — ${diagnostic.panels.identity}`}</h3>
      {diagnostic && <p>{diagnostic.accountBinding.result}</p>}
      <PipelineEvidenceTable label="Account Binding" values={diagnostic ? {
        'Authenticated owner': diagnostic.pre.identity.authenticatedElitePlusUserId,
        'Queue owner': diagnostic.pre.identity.connectorOwnerUserId,
        'Device scope': diagnostic.pre.identity.deviceScopeId,
        'Identity': diagnostic.pre.identity,
        'Scopes': diagnostic.accountBinding.scopes,
        'Conflicts': diagnostic.accountBinding.conflicts,
      } : {
        'Authenticated owner': ownerUserId,
        'Queue owner': 'UNKNOWN — inspect snapshot',
        'Device scope': 'UNKNOWN — inspect snapshot',
      }} />
    </section>
    <section aria-label="Diagnostic actions/export">
    <h3>Diagnostic actions/export</h3>
    {error && <p role="alert" className="error-message">{error}</p>}
    {report?.syncError && <p role="alert" className="error-message">{report.syncError}</p>}
    <div className="wearable-actions">
      <button disabled={busy} onClick={() => void action(async () => {
        const snapshot = await pipelineSnapshot(server)
        if (!report?.post) setReport(preSyncReport(snapshot, server, settings))
      })}>Inspect Pipeline Snapshot</button>
      <button disabled={busy} onClick={() => void action(() => share('pre'))}>Export Pre-Sync Diagnostic</button>
      <button disabled={busy || Boolean(report?.post) || !sameOwner || otherOwnerEvidence} onClick={() => void action(async () => {
        const pre = await pipelineSnapshot(server)
        setExported(false)
        const signature = JSON.stringify({ scopes: pre.binding.scopes,
          deviceScopeId: pre.identity.deviceScopeId, physicalBleDeviceId: pre.identity.physicalBleDeviceId })
        await runPipelineDiagnostic(pre, server, settings, (next) => setReport({ ...next }), signature === preExportSignature)
      })}>Run Normal Sync Diagnostic</button>
      <button disabled={busy || !report || !sameOwner} onClick={() => void action(() => share('post'))}>Export Post-Sync Diagnostic</button>
      <button disabled={busy} onClick={() => void action(async () => {
        if ((await JCVitalV8.getConnectionState()).state !== 'READY') throw new Error('DEVICE_SETTINGS_READ_REQUIRES_READY')
        const configuration = await JCVitalV8.getMonitoringConfiguration()
        setSettings(configuration)
        if (report) setReport({ ...report, deviceSettings: configuration })
      })}>Read Device Auto-Record Settings (read only)</button>
      <button disabled={busy || !exported} onClick={() => void action(async () => {
        resetPipelineGuard(exported)
        setReport(null)
        setExported(false)
        setSaved('Engineering session guard reset after export. Saved exports remain unchanged.')
      })}>Explicit Engineering Reset After Export</button>
    </div>
    <label>Import original Base44 audit identity/timestamp JSON (local reconciliation only)
      <input type="file" accept=".json,application/json" disabled={busy || Boolean(report?.post)} onChange={(event) => {
        const file = event.currentTarget.files?.[0]
        if (file) void action(async () => { setServer(parseServerAudit(await file.text())); setReport(null) })
      }} />
    </label>
    {saved && <p role="status">{saved}</p>}
    </section>
    {diagnostic && <>
      <section aria-label="Acquisition">
      <h3>B. Acquisition — {diagnostic.panels.acquisition}</h3>
      <p>{diagnostic.normalSyncCallPath.behavior} · {diagnostic.state}</p>
      <PipelineEvidenceTable label="Acquisition" values={{ callChain: diagnostic.normalSyncCallPath.callChain,
        scheduler: diagnostic.normalSyncCallPath.scheduler, settings: diagnostic.deviceSettings ?? 'UNKNOWN_NOT_READ',
        commands: diagnostic.commandsDuringRun, acquisitionRuns: diagnostic.acquisitionRuns, type82: diagnostic.type82 }} />
      </section>
      <section aria-label="Queue">
      <h3>C. Queue — {diagnostic.panels.queue}</h3>
      <PipelineEvidenceTable label="Queue" values={{ before: diagnostic.pre.queue, after: diagnostic.post?.queue,
        gating: diagnostic.post?.delivery ?? diagnostic.pre.delivery, ingress: diagnostic.queueIngress }} />
      </section>
      <section aria-label="Delivery">
      <h3>D. Delivery / ACK — {diagnostic.panels.delivery}</h3>
      <PipelineEvidenceTable label="Delivery" values={{ ackPurge: diagnostic.ackPurgeResults, deliveries: diagnostic.deliveries, rootCause: diagnostic.rootCause,
        evidenceErrors: [...diagnostic.pre.errors, ...diagnostic.post?.errors ?? []],
        evidenceLimits: diagnostic.evidenceLimits }} />
      </section>
      <section aria-label="Source/timestamp details">
        <h3>Source/timestamp details</h3>
        {diagnostic.latestTimestampsBySource.map((row) => <div key={row.vendorDataType}>
          <h4>{row.source}</h4>
          <PipelineEvidenceTable label={`${row.source} timestamps`} values={{
            'Metric': row.source, 'Device latest (retained)': row.deviceLatest ?? 'UNKNOWN',
            'Local latest (retained queue)': row.localLatest ?? 'UNKNOWN', 'Queued latest': row.queuedLatest ?? 'NONE',
            'Base44 latest': row.base44Latest ?? 'UNKNOWN', 'Timestamp authority': row.base44TimestampAuthority,
            'Status': row.acquisitionStatus,
          }} />
        </div>)}
      </section>
      <details className="engineering-raw-json">
        <summary>Show Raw JSON</summary>
        <pre>{JSON.stringify(diagnostic, null, 2)}</pre>
      </details>
    </>}
  </section>
}
