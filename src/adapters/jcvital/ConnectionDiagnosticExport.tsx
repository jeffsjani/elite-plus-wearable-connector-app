import { registerPlugin } from '@capacitor/core'
import { saveValidationJson } from './CertificationJsonExport'
import {
  CONNECTION_DIAGNOSTIC_FILENAME, serializeConnectionDiagnostic, type ConnectionDiagnosticReport,
  type JournalHandshakeDiagnostic, type JournalCapacityAnalysis,
} from './ConnectionDiagnostic'

interface DiagnosticExportPlugin {
  copyJson(options: { json: string }): Promise<void>
  saveJson(options: { json: string; filename: string }): Promise<void>
}

const nativeExport = registerPlugin<DiagnosticExportPlugin>('ConnectionDiagnosticExport')

export type DiagnosticExportMethod = 'copy' | 'save' | 'share'

export const diagnosticSaveFilename = (generatedAt: string) =>
  `ElitePlus-V8-Connection-Diagnostic-${generatedAt.replace(/[:.]/g, '-')}.json`

export async function exportConnectionDiagnostic(
  report: ConnectionDiagnosticReport,
  method: DiagnosticExportMethod,
): Promise<string> {
  const json = serializeConnectionDiagnostic(report)
  switch (method) {
    case 'copy':
      await nativeExport.copyJson({ json })
      return 'Diagnostic JSON copied'
    case 'save':
      await nativeExport.saveJson({ json, filename: diagnosticSaveFilename(report.generatedAt) })
      return 'Diagnostic JSON saved'
    case 'share':
      await saveValidationJson(CONNECTION_DIAGNOSTIC_FILENAME, json,
        'Elite+ V8 connection diagnostic', 'Share connection diagnostic')
      return 'Diagnostic JSON shared'
  }
}

export async function exportJournalCapacityAnalysis(
  analysis: JournalCapacityAnalysis, method: 'copy' | 'save',
): Promise<string> {
  const json = JSON.stringify(analysis, null, 2)
  if (method === 'copy') await nativeExport.copyJson({ json })
  else await nativeExport.saveJson({
    json, filename: `ElitePlus-V8-Journal-Capacity-${analysis.generatedAt.replace(/[:.]/g, '-')}.json`,
  })
  return `Journal capacity JSON ${method === 'copy' ? 'copied' : 'saved'}`
}

const VENDOR_BUCKETS = ['27', '68', '59', '24/25', '26/121', '42', '127', '29', '118/119', 'OTHER']
const FAMILIES = ['PRODUCTION_PHYSIOLOGICAL', 'CERTIFICATION', 'DIAGNOSTICS', 'PPG', 'WORKOUT', 'SLEEP', 'ACTIVITY', 'UNKNOWN']
const AGES = ['UNDER_24_HOURS', '1_TO_7_DAYS', '8_TO_30_DAYS', '31_TO_90_DAYS', 'OVER_90_DAYS']

function share(bytes: number, total: number): string {
  return total > 0 ? `${(bytes / total * 100).toFixed(2)}%` : 'UNKNOWN'
}

function GroupTable({ analysis, axis, title, keys, limit = 20 }: {
  analysis: JournalCapacityAnalysis; axis: string; title: string; keys?: string[]; limit?: number
}) {
  const all = analysis.groups[axis] ?? []
  const byKey = new Map(all.map((entry) => [entry.key, entry]))
  const entries = keys ? keys.map((key) => byKey.get(key) ?? { key, accountedBytes: 0, envelopes: 0 }) : all.slice(0, limit)
  return <>
    <h4>{title}</h4>
    <table className="engineering-evidence-table" aria-label={title}>
      <thead><tr><th scope="col">Key</th><th scope="col">Envelopes</th><th scope="col">Accounted bytes</th><th scope="col">% of journal</th></tr></thead>
      <tbody>{entries.map((entry) => <tr key={entry.key}>
        <th scope="row">{entry.key}</th><td data-label="Envelopes">{entry.envelopes ?? 'UNKNOWN'}</td>
        <td data-label="Accounted bytes">{entry.accountedBytes}</td>
        <td data-label="% of journal">{share(entry.accountedBytes, analysis.totalAccountedBytes)}</td>
      </tr>)}</tbody>
    </table>
    {!keys && all.length > limit && <p>Showing {limit} of {all.length}; all in JSON.</p>}
  </>
}

function ValueTable({ label, rows }: { label: string; rows: Array<[string, number | string | boolean | null | undefined]> }) {
  return <table className="engineering-evidence-table" aria-label={label}>
    <tbody>{rows.map(([key, value]) => <tr key={key}>
      <th scope="row">{key}</th><td data-label={key}>{value == null ? 'UNKNOWN' : String(value)}</td>
    </tr>)}</tbody>
  </table>
}

export function JournalCapacitySummary({ analysis }: { analysis: JournalCapacityAnalysis }) {
  const componentSum = analysis.componentSumBytes ?? (analysis.envelopeJsonBytes + analysis.rawBlobBytes
    + analysis.perEnvelopeOverheadBytes + analysis.reservedSourceFileBytes)
  const difference = analysis.reconciliationDifferenceBytes ?? analysis.totalAccountedBytes - componentSum
  const reconciled = (analysis.reconciliationStatus ?? (analysis.accountingMatches ? 'RECONCILED' : 'NOT_RECONCILED')) === 'RECONCILED'
    && difference === 0 && analysis.accountingMatches
  const raw = analysis.rawBlobAnalysis
  const evidence = analysis.evidenceInventory
  const plan = analysis.recoveryPlanning
  return <section aria-label="Journal Capacity Analysis">
    <h3>Journal Capacity Analysis</h3>
    <p>Read-only snapshot: {analysis.generatedAt}. No archive, deletion, limit change, latch clearing or recovery performed.</p>
    <p>{analysis.classificationReason}</p>
    <ValueTable label="Journal byte accounting" rows={[
      ['TOTAL ACCOUNTED BYTES', analysis.totalAccountedBytes], ['ENVELOPE JSON BYTES', analysis.envelopeJsonBytes],
      ['RAW BLOB BYTES', analysis.rawBlobBytes], ['PER-ENVELOPE OVERHEAD BYTES', analysis.perEnvelopeOverheadBytes],
      ['RESERVED SOURCE-FILE BYTES', analysis.reservedSourceFileBytes], ['OTHER / RECONCILIATION BYTES', analysis.otherAccountedBytes],
      ['COMPONENT SUM (json + blob + overhead + files)', componentSum],
      ['RECONCILIATION DIFFERENCE', difference],
      ['RECONCILIATION STATUS', reconciled ? 'RECONCILED' : 'NOT_RECONCILED'],
      ['failedClosed', analysis.failedClosed], ['lastFailureCode', analysis.lastFailureCode],
    ]} />
    {!reconciled && <p role="alert">Accounting does not reconcile
      ({(analysis.reconciliationReasons ?? []).join(', ') || `difference ${difference} bytes`}). Do not authorize relief or recovery.</p>}
    <GroupTable analysis={analysis} axis="accountId" title="Top byte consumers by account" />
    <GroupTable analysis={analysis} axis="deviceScopeId" title="Top byte consumers by device scope" />
    <GroupTable analysis={analysis} axis="vendorBucket" title="Bytes by vendor data type" keys={VENDOR_BUCKETS} />
    <GroupTable analysis={analysis} axis="displayFamily" title="Bytes by capture/evidence family (display label only)" keys={FAMILIES} />
    <p>Family labels come from explicit kind markers and vendor type. They do not prove purpose and never make
      evidence archive-safe.</p>
    <GroupTable analysis={analysis} axis="ageDistribution" title="Bytes by receipt age" keys={AGES} />
    <h4>Top 20 individual records</h4>
    {analysis.topRecords20 ? <table className="engineering-evidence-table" aria-label="Top 20 individual records">
      <thead><tr>{['Sequence', 'Account', 'Device scope', 'Vendor type', 'Kind', 'Timestamp', 'JSON bytes', 'Blob bytes',
        'Overhead bytes', 'Total accounted', 'Source record / evidence ID'].map((h) => <th scope="col" key={h}>{h}</th>)}</tr></thead>
      <tbody>{analysis.topRecords20.map((r) => <tr key={r.sequence}>
        <td>{r.sequence}</td><td>{r.accountId}</td><td>{r.deviceScopeId}</td><td>{r.vendorDataType}</td><td>{r.kind}</td>
        <td>{r.timestamp}</td><td>{r.jsonBytes}</td><td>{r.blobBytes}</td><td>{r.overheadBytes}</td>
        <td>{r.totalAccountedBytes}</td><td>{r.sourceRecordId}</td>
      </tr>)}</tbody>
    </table> : <p>UNKNOWN</p>}
    <h4>Raw BLOB analysis</h4>
    {raw ? <>
      <ValueTable label="Raw BLOB analysis" rows={[
        ['rawBlobBytesTotal', raw.rawBlobBytesTotal], ['rawBlobCount', raw.rawBlobCount],
        ['largestRawBlobBytes', raw.largestRawBlobBytes], ['duplicateBlobCandidateCount', raw.duplicateBlobCandidateCount],
        ['duplicateBlobCandidateBytes', raw.duplicateBlobCandidateBytes], ['duplicateBasis', raw.duplicateBasis],
        ['removalStatus', raw.removalStatus],
      ]} />
      <details><summary>Top raw BLOB families</summary>
        <ValueTable label="Top raw BLOB families" rows={raw.topRawBlobFamilies.map((f) => [f.family, `${f.rawBlobBytes} bytes / ${f.blobs} blobs`])} />
      </details>
      <details><summary>Duplicate groups (top 20; identical stored bytes, no deletion)</summary>
        <pre>{JSON.stringify(raw.topDuplicateGroups, null, 2)}</pre>
      </details>
    </> : <p>UNKNOWN</p>}
    <h4>Certification / source-file inventory</h4>
    {evidence ? <>
      <ValueTable label="Evidence inventory" rows={[
        ['certificationEvidenceBytes', `${evidence.certificationEvidenceBytes} (${evidence.certificationEvidenceScope})`],
        ['diagnosticEvidenceBytes', `${evidence.diagnosticEvidenceBytes} (${evidence.diagnosticEvidenceScope})`],
        ['rawPpgEnvelopeBytes (inside maxBytes, overlaps other rows)', evidence.rawPpgEnvelopeBytes],
        ['certificationSnapshotBytes', `${evidence.certificationSnapshotBytes} (${evidence.certificationSnapshotScope})`],
        ['reservedSourceFileBytes', `${evidence.reservedSourceFileBytes} (${evidence.reservedSourceFileScope})`],
        ['sourceFileCount', evidence.sourceFileCount],
      ]} />
      <details><summary>Largest source files</summary><pre>{JSON.stringify(evidence.largestSourceFiles, null, 2)}</pre></details>
    </> : <p>UNKNOWN</p>}
    <details><summary>Certification snapshot tables (outside maxBytes)</summary>
      <pre>{JSON.stringify(analysis.certificationSnapshotsOutsideBudget, null, 2)}</pre>
    </details>
    <h4>Recovery planning (read-only, not authorized)</h4>
    {plan ? <ValueTable label="Recovery planning" rows={[
      ['CURRENT_BYTES', plan.currentBytes], ['maxBytes', plan.maxBytes],
      ['current utilization', plan.currentUtilizationPercent == null ? null : `${plan.currentUtilizationPercent.toFixed(4)}%`],
      ['TARGET_80_PERCENT_BYTES', plan.target80PercentBytes],
      ['BYTES_TO_RELIEVE_FOR_80_PERCENT', plan.bytesToRelieveFor80Percent],
      ['90% pressure-warning bytes', plan.pressureWarning90PercentBytes],
      ['bytes to relieve below 90%', plan.bytesToRelieveBelow90Percent],
      ['90% pressure warning active', plan.pressureWarning90Active],
      ['POTENTIAL_ARCHIVABLE_CERTIFICATION_BYTES', plan.potentialArchivableCertificationBytes],
      ['certification-marker bytes (not proof of archivability)', plan.markerBasedCertificationBytes],
      ['POTENTIAL_DUPLICATE_BLOB_BYTES', plan.potentialDuplicateBlobBytes],
      ['POTENTIAL_COLD_DIAGNOSTIC_BYTES', plan.potentialColdDiagnosticBytes],
      ['candidates additive?', 'No: categories overlap'],
      ['candidateStatus', plan.candidateStatus], ['recovery threshold', plan.recoveryThresholdStatus],
    ]} /> : <p>UNKNOWN</p>}
    <p>{plan?.archiveSemantics ?? 'Copying evidence to an archive does not reduce the active journal\'s accounted bytes. Capacity relief requires a later governed operation that both proves immutable archive preservation and removes/reclassifies the archived payload from the active hot-budget accounting. No such operation exists in this build.'}</p>
    <details><summary>Duplicate declared-hash candidates (legacy, unverified; top 20 of {analysis.duplicateRawCandidateGroups})</summary>
      <p>{analysis.duplicateCaveat}</p>
      <pre>{JSON.stringify(analysis.duplicateRawCandidatesTop20, null, 2)}</pre>
    </details>
    <details><summary>Top 5 individual contributors incl. source files</summary>
      <pre>{JSON.stringify(analysis.top5ByteContributors, null, 2)}</pre>
    </details>
  </section>
}

function permissionSummary(report: ConnectionDiagnosticReport, scan: boolean): string {
  const permissions = report.permissions.android
  if (!permissions) return 'Unknown'
  const permission = scan
    ? permissions.BLUETOOTH_SCAN.requiredOnThisSdk ? permissions.BLUETOOTH_SCAN : permissions.ACCESS_FINE_LOCATION
    : permissions.BLUETOOTH_CONNECT
  return permission.requiredOnThisSdk ? String(permission.granted) : 'Not required'
}

export function JournalStoragePressure({ journal }: { journal: JournalHandshakeDiagnostic | null | undefined }) {
  const pressure = journal?.journalPressure
  const envelopes = pressure?.globalEnvelopeCount
  const bytes = pressure?.globalAccountedBytes
  const envelopeOver = envelopes == null || !pressure ? null : envelopes > pressure.maxEnvelopes
  const byteOver = bytes == null || !pressure ? null : bytes > pressure.maxBytes
  const trigger = envelopeOver == null || byteOver == null ? 'UNKNOWN'
    : envelopeOver && byteOver ? 'BOTH' : envelopeOver ? 'ENVELOPE_LIMIT' : byteOver ? 'BYTE_LIMIT' : 'UNKNOWN'
  const percent = (value: number | null | undefined, limit: number | undefined) =>
    value == null || limit == null || limit <= 0 ? null : `${(value / limit * 100).toFixed(2)}%`
  const rows: Array<[string, string | number | boolean | null | undefined]> = [
    ['globalEnvelopeCount', envelopes], ['globalAccountedBytes', bytes],
    ['maxEnvelopes', pressure?.maxEnvelopes], ['maxBytes', pressure?.maxBytes],
    ['envelopeUtilizationPercent', percent(envelopes, pressure?.maxEnvelopes)],
    ['byteUtilizationPercent', percent(bytes, pressure?.maxBytes)],
    ['remainingEnvelopeHeadroom', pressure?.envelopeHeadroom], ['remainingByteHeadroom', pressure?.byteHeadroom],
    ['failedClosed', journal ? journal.journalState === 'JOURNAL_FAILED_CLOSED' : null],
    ['lastFailureCode', journal?.journalFailureCode], ['lastFailureMessage', journal?.journalFailureMessage],
    ['pressureCurrentlyActive', pressure?.budgetAtOrOverLimit],
    ['STORAGE_PRESSURE_TRIGGER', trigger],
    ['CURRENT_GLOBAL_ENVELOPES', envelopes], ['CURRENT_GLOBAL_BYTES', bytes],
    ['ENVELOPE_LIMIT', pressure?.maxEnvelopes], ['BYTE_LIMIT', pressure?.maxBytes],
    ['CURRENTLY_OVER_ENVELOPE_LIMIT', envelopeOver], ['CURRENTLY_OVER_BYTE_LIMIT', byteOver],
    ['largestRecentEnvelopeBytes', pressure?.largestRecentEnvelopeBytes],
    ['maxEntryBytes', pressure?.maxEntryBytes], ['reservedSourceFileBytes', pressure?.reservedSourceFileBytes],
    ['safeHeadroomForNextWrite', pressure?.safeHeadroomForNextWrite],
    ['inspectionError', pressure?.inspectionErrorMessage ?? pressure?.inspectionErrorCode],
  ]
  return <section aria-label="Journal Storage Pressure">
    <h3>Journal Storage Pressure</h3>
    <p>Global totals across all owners. Current pressure means a budget is at or above its limit.
      Over-limit flags use strict greater-than. UNKNOWN trigger means unavailable metrics or neither
      current total exceeds its limit; it does not reconstruct the historical failed write.</p>
    <p>Largest recent envelope: accounted bytes from the latest 100 global envelopes.
      Future write size is unknown; being below a limit does not prove the next write fits.
      Storage-pressure recovery is gated during journal binding; these diagnostics do not change journal state.</p>
    <table className="engineering-evidence-table" aria-label="Journal Storage Pressure values">
      <tbody>{rows.map(([key, value]) => <tr key={key}>
        <th scope="row">{key}</th><td data-label={key}>{value == null ? 'UNKNOWN' : String(value)}</td>
      </tr>)}</tbody>
    </table>
  </section>
}

/** Uses the completed report, not the live poller or export status. */
export function ConnectionDiagnosticSummary({ report }: { report: ConnectionDiagnosticReport }) {
  const values: Array<[string, string | boolean | number | null | undefined]> = [
    ['classification', report.classification.primary ?? (report.connection.readyReached ? 'READY' : 'V8 discovered')],
    ['firstFailedStage', report.firstFailedStage ?? 'None'],
    ['bluetoothEnabled', report.bluetoothAdapter?.bluetoothEnabled],
    ['scanPermission', permissionSummary(report, true)],
    ['connectPermission', permissionSummary(report, false)],
    ['pluginInitialized', Boolean(report.plugin.initializedAt)],
    ['scanRequested', report.scan.requested],
    ['scanActive', report.scan.activeAtEnd],
    ['advertisementCount', report.scan.advertisementsReceived],
    ['v8CandidateCount', report.scan.v8CandidatesDetected],
    ['connectRequested', report.connection.connectRequested],
    ['gattConnected', report.connection.gattState === 'CONNECTED'],
    ['readyReached', report.connection.readyReached],
    ['journalState', report.journalHandshake?.journalState],
    ['journalAccountId', report.journalHandshake?.journalAccountId],
    ['journalDeviceScopeId', report.journalHandshake?.journalDeviceScopeId],
    ['journalOpenAttempted', report.journalHandshake?.journalOpenAttempted],
    ['journalOpenSucceeded', report.journalHandshake?.journalOpenSucceeded],
    ['journalFailureCode', report.journalHandshake?.journalFailureCode],
    ['journalFailureMessage', report.journalHandshake?.journalFailureMessage],
    ['failedClosed', report.journalHandshake?.failedClosed],
    ['priorFailureCode', report.journalHandshake?.priorFailureCode],
    ['priorFailureMessage', report.journalHandshake?.priorFailureMessage],
    ['priorFailureTimestamp', report.journalHandshake?.priorFailureTimestamp],
    ['recoveryAudit', report.journalHandshake?.recoveryAudit == null
      ? null : JSON.stringify(report.journalHandshake.recoveryAudit)],
    ['recoveryAuditHistory', report.journalHandshake?.recoveryAuditHistory == null
      ? null : JSON.stringify(report.journalHandshake.recoveryAuditHistory)],
    ['latestRecoveryAudit', report.journalHandshake?.latestRecoveryAudit == null
      ? null : JSON.stringify(report.journalHandshake.latestRecoveryAudit)],
    ['type27Ingress', report.journalHandshake?.type27Ingress == null
      ? null : JSON.stringify(report.journalHandshake.type27Ingress)],
    ['journalFailedClosedAtStartup', report.journalHandshake?.journalFailedClosedAtStartup],
    ['journalEnvelopeCount', report.journalHandshake?.journalEnvelopeCount],
    ['transportInitializationStarted', report.journalHandshake?.transportInitializationStarted],
    ['getDeviceVersionBlockedReason', report.journalHandshake?.getDeviceVersionBlockedReason],
    ['globalJournalEnvelopeCount', report.journalHandshake?.journalPressure?.globalEnvelopeCount],
    ['globalJournalAccountedBytes', report.journalHandshake?.journalPressure?.globalAccountedBytes],
    ['journalMaxEnvelopes', report.journalHandshake?.journalPressure?.maxEnvelopes],
    ['journalMaxBytes', report.journalHandshake?.journalPressure?.maxBytes],
    ['journalEnvelopeHeadroom', report.journalHandshake?.journalPressure?.envelopeHeadroom],
    ['journalByteHeadroom', report.journalHandshake?.journalPressure?.byteHeadroom],
    ['journalBudgetAtOrOverLimit', report.journalHandshake?.journalPressure?.budgetAtOrOverLimit],
    ['journalPressureScope', report.journalHandshake?.journalPressure?.limitsScope],
    ['journalPressureTrigger', report.journalHandshake?.journalPressure?.triggerRule],
    ['journalPressureInspectionError', report.journalHandshake?.journalPressure?.inspectionErrorMessage
      ?? report.journalHandshake?.journalPressure?.inspectionErrorCode],
    ['lastError', report.connection.lastError ?? report.scan.lastScanError ?? report.errors.at(-1) ?? 'None'],
  ]
  return <><table className="engineering-evidence-table" aria-label="Completed connection diagnostic summary">
    <tbody>{values.map(([key, value]) =>
      <tr key={key}><th scope="row">{key}</th><td data-label={key}>{value == null ? 'Unknown' : String(value)}</td></tr>,
    )}</tbody>
  </table><JournalStoragePressure journal={report.journalHandshake} /></>
}
