import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { createRawPpgSavedEvidenceActions, formatRawPpgDiagnosticSummary, RAW_PPG_FINALIZE_DISABLED_REASON, RawPpgSavedEvidenceControls } from './RawPpgSavedEvidenceView'
import { RAW_PPG_DIAGNOSTIC_FILENAME, RawPpgSavedEvidenceService } from './RawPpgSavedEvidence'

function fakeService(overrides: Partial<RawPpgSavedEvidenceService> = {}): RawPpgSavedEvidenceService {
  return overrides as RawPpgSavedEvidenceService
}

describe('VC27/VC28 Raw PPG saved-evidence offline controls', () => {
  it('exposes the offline control labels plus the always-available diagnostic controls', () => {
    const html = renderToStaticMarkup(<RawPpgSavedEvidenceControls service={fakeService()} />)
    expect(html).toContain('Inspect Existing Raw PPG Evidence')
    expect(html).toContain('Export Existing Raw PPG Evidence')
    expect(html).toContain('Finalize Saved Raw PPG Certification')
    expect(html).toContain('Show Raw PPG Saved-Evidence Diagnostic')
    expect(html).toContain('Share Raw PPG Saved-Evidence Diagnostic JSON')
    expect(html).toContain(RAW_PPG_FINALIZE_DISABLED_REASON)
  })

  it('keeps diagnostic controls enabled while busy/not READY; only inspect/export (and always finalize) are disabled', () => {
    const html = renderToStaticMarkup(<RawPpgSavedEvidenceControls service={fakeService()} disabled />)
    expect(html.match(/disabled=""/g)).toHaveLength(3)
    expect(html).toMatch(/<button type="button">Show Raw PPG Saved-Evidence Diagnostic<\/button>/)
    expect(html).toMatch(/<button type="button">Share Raw PPG Saved-Evidence Diagnostic JSON<\/button>/)
  })

  it('formats the exact error code, stage, message, and evidence sides (never a bare FAILED)', () => {
    const summary = formatRawPpgDiagnosticSummary({
      status: 'FAILED', errorCode: 'PPG_JOURNAL_FOUND_SPOOL_MISSING', failureStage: 'CLASSIFY_EVIDENCE',
      errorMessage: 'journal has 20 PPG notifications but no spool file', findings: ['PPG_JOURNAL_FOUND_SPOOL_MISSING'],
      spoolDirectoryExists: true, candidateSpoolCount: 0, journalRowsAssociatedWithPpgExist: true, matchingBleNotificationCount: 20,
    })
    expect(summary).toContain('FAILED · PPG_JOURNAL_FOUND_SPOOL_MISSING')
    expect(summary).toContain('stage=CLASSIFY_EVIDENCE')
    expect(summary).toContain('message=journal has 20 PPG notifications but no spool file')
    expect(summary).toContain('candidates=0')
    expect(summary).toContain('bleNotifications=20')
    const html = renderToStaticMarkup(<RawPpgSavedEvidenceControls service={fakeService()} initialStatus={summary} />)
    expect(html).toContain('PPG_JOURNAL_FOUND_SPOOL_MISSING')
  })
})

describe('VC28 Raw PPG saved-evidence controls (interactive)', () => {
  async function mount(service: RawPpgSavedEvidenceService, saveJson = vi.fn().mockResolvedValue('file://diag.json')) {
    const state = { status: '', json: null as string | null, busy: false }
    const actions = createRawPpgSavedEvidenceActions(service, {
      setStatus: (v) => { state.status = v }, setJson: (v) => { state.json = v }, setBusy: (v) => { state.busy = v },
    }, saveJson)
    const byLabel: Record<string, () => Promise<void>> = {
      'Inspect Existing Raw PPG Evidence': () => actions.inspect(),
      'Show Raw PPG Saved-Evidence Diagnostic': () => actions.showDiagnostic(),
      'Share Raw PPG Saved-Evidence Diagnostic JSON': () => actions.shareDiagnostic(),
    }
    return { click: (label: string) => byLabel[label](), status: () => state.status, json: () => state.json, busy: () => state.busy, saveJson }
  }

  it('shows the exact native code/message when inspect is rejected, then still exports the diagnostic JSON', async () => {
    const storage = new Map<string, string>()
    const plugin = {
      inspectSavedRawPpgEvidence: vi.fn().mockRejectedValue(Object.assign(new Error('PPG_SCOPE_NOT_RESOLVED: Failure: no account'), {
        code: 'PPG_SCOPE_NOT_RESOLVED', data: { exceptionClass: 'JCVitalV8SourceJournal$Failure' },
      })),
      exportSavedRawPpgEvidence: vi.fn(), finalizeSavedRawPpgCertification: vi.fn(), readSavedRawPpgCertification: vi.fn(),
      readSavedRawPpgDiagnostic: vi.fn().mockResolvedValue({ json: null }),
    }
    const service = new RawPpgSavedEvidenceService(plugin, () => ({ accountId: null }), {
      getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => { storage.set(k, v) },
    })
    const ui = await mount(service)
    await ui.click('Inspect Existing Raw PPG Evidence')
    expect(ui.status()).toContain('PPG_SCOPE_NOT_RESOLVED')
    expect(ui.status()).toContain('PPG_SCOPE_NOT_RESOLVED: Failure: no account')
    expect(ui.status()).toContain('exception=JCVitalV8SourceJournal$Failure')
    expect(ui.status()).not.toMatch(/: FAILED$/)

    await ui.click('Show Raw PPG Saved-Evidence Diagnostic')
    expect(ui.status()).toContain('FAILED · PPG_SCOPE_NOT_RESOLVED')

    await ui.click('Share Raw PPG Saved-Evidence Diagnostic JSON')
    expect(ui.saveJson).toHaveBeenCalledTimes(1)
    const [filename, json] = ui.saveJson.mock.calls[0]
    expect(filename).toBe(RAW_PPG_DIAGNOSTIC_FILENAME)
    expect(JSON.parse(json).latestBridgeFailure.errorCode).toBe('PPG_SCOPE_NOT_RESOLVED')
    expect(plugin.finalizeSavedRawPpgCertification).not.toHaveBeenCalled()
    expect(ui.busy()).toBe(false)
  })

  it('renders a resolved native diagnostic with its exact failure code and evidence counts', async () => {
    const diagnostic = {
      kind: 'RawPpgSavedEvidenceDiagnostic', generatedAt: 'x', status: 'FAILED', errorCode: 'PPG_SPOOL_FOUND_METADATA_MISSING',
      errorMessage: 'spool present, no PPG journal rows', failureStage: 'CLASSIFY', spoolDirectoryExists: true,
      candidateSpoolCount: 1, journalRowsAssociatedWithPpgExist: false, operation: 'INSPECT_EXISTING_RAW_PPG_EVIDENCE',
      candidates: [], found: true, recommendedSessionId: null,
    }
    const plugin = {
      inspectSavedRawPpgEvidence: vi.fn().mockResolvedValue(diagnostic),
      exportSavedRawPpgEvidence: vi.fn(), finalizeSavedRawPpgCertification: vi.fn(), readSavedRawPpgCertification: vi.fn(),
      readSavedRawPpgDiagnostic: vi.fn().mockResolvedValue({ json: JSON.stringify(diagnostic) }),
    }
    const ui = await mount(new RawPpgSavedEvidenceService(plugin, () => ({ accountId: 'owner-1' }), null))
    await ui.click('Inspect Existing Raw PPG Evidence')
    expect(ui.status()).toContain('FAILED · PPG_SPOOL_FOUND_METADATA_MISSING')
    expect(ui.status()).toContain('candidates=1')
    expect(ui.status()).toContain('journalPpgRows=no')
    expect(ui.json()).toContain('"errorCode": "PPG_SPOOL_FOUND_METADATA_MISSING"')
  })
})
