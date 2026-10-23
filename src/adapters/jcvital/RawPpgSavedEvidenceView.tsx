import { useState } from 'react'
import type { RawPpgSavedEvidenceDiagnostic } from './jcvitalV8Bridge'
import { saveValidationJson } from './CertificationJsonExport'
import { buildRawPpgCertificationJson } from './RawPpgCertificationJson'
import { RAW_PPG_DIAGNOSTIC_FILENAME, toRawPpgSavedEvidenceError } from './RawPpgSavedEvidence'
import type { RawPpgSavedEvidenceService } from './RawPpgSavedEvidence'

export const RAW_PPG_FINALIZE_DISABLED_REASON = 'VC28 diagnostic build: certification finalization is disabled.'

type SaveJson = (filename: string, json: string, title: string, dialogTitle: string) => Promise<string>

/** Exact, never-generic summary of a diagnostic/inspection result. */
export function formatRawPpgDiagnosticSummary(d: Partial<RawPpgSavedEvidenceDiagnostic>): string {
  const parts = [
    `${d.status ?? 'UNKNOWN'} · ${d.errorCode ?? 'NO_ERROR_CODE'}`,
    d.failureStage ? `stage=${d.failureStage}` : null,
    d.errorMessage ? `message=${d.errorMessage}` : null,
    d.exceptionClass ? `exception=${d.exceptionClass}` : null,
    d.findings?.length ? `findings=${d.findings.join(',')}` : null,
    d.spoolDirectoryExists !== undefined ? `spoolDir=${d.spoolDirectoryExists ? 'present' : 'absent'}` : null,
    d.candidateSpoolCount !== undefined ? `candidates=${d.candidateSpoolCount}` : null,
    d.journalRowsAssociatedWithPpgExist !== undefined ? `journalPpgRows=${d.journalRowsAssociatedWithPpgExist ? 'yes' : 'no'}` : null,
    d.matchingBleNotificationCount !== undefined ? `bleNotifications=${d.matchingBleNotificationCount}` : null,
    d.matchingSdkCallbackCount !== undefined ? `sdkCallbacks=${d.matchingSdkCallbackCount}` : null,
    d.matchingCommandRequestCount !== undefined ? `commands=${d.matchingCommandRequestCount}` : null,
    d.sourceChainMissing?.length ? `chainMissing=${d.sourceChainMissing.join(',')}` : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

export interface RawPpgSavedEvidenceSink {
  setStatus(status: string): void
  setJson(json: string | null): void
  setBusy(busy: boolean): void
}

/** UI-independent actions so exact-error rendering and post-failure export are testable without a DOM. */
export function createRawPpgSavedEvidenceActions(service: RawPpgSavedEvidenceService, sink: RawPpgSavedEvidenceSink, saveJson: SaveJson = saveValidationJson) {
  async function run(label: string, stage: string, action: () => Promise<void>) {
    sink.setBusy(true)
    sink.setStatus(`${label}: running…`)
    try {
      await action()
    } catch (error) {
      const failure = toRawPpgSavedEvidenceError(error, stage)
      sink.setStatus(`${label}: ${failure.code} · stage=${failure.failureStage} · ${failure.message}`
        + (failure.exceptionClass ? ` · exception=${failure.exceptionClass}` : ''))
    } finally {
      sink.setBusy(false)
    }
  }

  return {
    inspect: () => run('Inspect Existing Raw PPG Evidence', 'BRIDGE_INSPECT', async () => {
      const result = await service.inspectExisting()
      sink.setStatus(`Inspect Existing Raw PPG Evidence: ${formatRawPpgDiagnosticSummary(result)}`
        + (result.recommendedSessionId ? ` · recommended sessionId=${result.recommendedSessionId}` : ''))
      sink.setJson(JSON.stringify(result, null, 2))
    }),

    exportEvidence: (sessionId?: string) => run('Export Existing Raw PPG Evidence', 'BRIDGE_EXPORT', async () => {
      const evidence = await service.exportExisting(sessionId)
      sink.setStatus(`${evidence.state}${evidence.state === 'CERTIFIED' ? ` · ${evidence.sourceStatus}` : ` · missing: ${evidence.missingEvidence.join(',')}`}`
        + ` · packetCount=${evidence.packetCount} · spoolSha256=${evidence.sourceSpool.sha256}`)
      sink.setJson(buildRawPpgCertificationJson(evidence))
    }),

    async showDiagnostic() {
      const { native, bridgeFailure, readError } = await service.readDiagnostic()
      const latest = native ?? bridgeFailure
      sink.setStatus(latest
        ? `Raw PPG saved-evidence diagnostic: ${formatRawPpgDiagnosticSummary(latest)}`
          + (native && bridgeFailure ? ` · latest bridge failure: ${bridgeFailure.errorCode} · ${bridgeFailure.errorMessage}` : '')
        : `Raw PPG saved-evidence diagnostic: none persisted yet${readError ? ` · readError=${readError}` : ''} · press Inspect Existing Raw PPG Evidence`)
      sink.setJson(await service.diagnosticJson())
    },

    async shareDiagnostic() {
      try {
        const text = await service.diagnosticJson()
        sink.setJson(text)
        const saved = await saveJson(RAW_PPG_DIAGNOSTIC_FILENAME, text, 'JCVital Raw PPG saved-evidence diagnostic', 'Share Raw PPG diagnostic JSON')
        sink.setStatus(`Raw PPG saved-evidence diagnostic JSON shared · ${saved}`)
      } catch (error) {
        const failure = toRawPpgSavedEvidenceError(error, 'DIAGNOSTIC_SHARE')
        sink.setStatus(`Share Raw PPG Saved-Evidence Diagnostic JSON: ${failure.code} · ${failure.message} · JSON shown below`)
      }
    },
  }
}

/**
 * Offline saved-evidence controls for Raw PPG. Every action here reads only from app-private
 * storage already captured by a prior physical session: 0 BLE commands, 0 device connection,
 * 0 acquisition, 0 network, 0 Base44, 0 enqueue, 0 delivery, 0 canonicalization. Works after
 * app restart because the native methods never depend on an in-memory capture session.
 * The diagnostic Show/Share controls are never disabled (no READY/BLE/network requirement).
 */
export function RawPpgSavedEvidenceControls({
  service,
  disabled,
  initialStatus = '',
  initialJson = null,
  saveJson = saveValidationJson,
}: {
  service: RawPpgSavedEvidenceService
  disabled?: boolean
  initialStatus?: string
  initialJson?: string | null
  saveJson?: SaveJson
}) {
  const [status, setStatus] = useState(initialStatus)
  const [json, setJson] = useState<string | null>(initialJson)
  const [busy, setBusy] = useState(false)
  const actions = createRawPpgSavedEvidenceActions(service, { setStatus, setJson, setBusy }, saveJson)

  return (
    <section aria-label="Raw PPG saved evidence">
      <h3>Raw PPG saved evidence (offline)</h3>
      <button type="button" disabled={disabled || busy} onClick={() => void actions.inspect()}>Inspect Existing Raw PPG Evidence</button>
      <button type="button" disabled={disabled || busy} onClick={() => void actions.exportEvidence()}>Export Existing Raw PPG Evidence</button>
      <button type="button" disabled title={RAW_PPG_FINALIZE_DISABLED_REASON}>Finalize Saved Raw PPG Certification</button>
      <small>{RAW_PPG_FINALIZE_DISABLED_REASON}</small>
      <div className="diagnostic-control">
        <button type="button" onClick={() => void actions.showDiagnostic()}>Show Raw PPG Saved-Evidence Diagnostic</button>
        <button type="button" onClick={() => void actions.shareDiagnostic()}>Share Raw PPG Saved-Evidence Diagnostic JSON</button>
      </div>
      <p role="status">{status}</p>
      {json && <textarea aria-label="Raw PPG saved-evidence JSON" rows={20} readOnly value={json} />}
    </section>
  )
}
