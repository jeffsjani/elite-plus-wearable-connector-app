import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { saveValidationJson, serializeCertificationJson } from './CertificationJsonExport'
import { copyPpiCertificationJson, readPpiCertificationJson } from './PpiCertificationJson'
import { PpiCertificationJsonView } from './PpiCertificationJsonView'
import { PpiCertificationAttempt } from './PpiCertificationAttempt'
import { fixture } from './PpiCertification.fixture'
import { sha256Hex } from './HeartRateSeries'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => true) } }))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: vi.fn() },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path }) => ({ uri: `file:///cache/${path}` }))
  vi.mocked(Share.share).mockResolvedValue({})
})

describe('VC14 displayed PPI JSON through the unchanged standard Phase export helper', () => {
  it.each(['certification', 'attempt'] as const)('shows, copies and shares identical %s UTF-8 bytes and SHA with zero certification side effects', async (kind) => {
    const f = await fixture()
    const current = await f.service.capture()
    let evidence = await readPpiCertificationJson(f.service, current)
    if (kind === 'attempt') {
      const attempt = new PpiCertificationAttempt(f.deps.storage)
      attempt.start('user-1', f.context.scope.deviceScopeId, { ready: true })
      attempt.event('EXAMPLE_FAILURE', 'FAILED', { sourceEnvelopeId: 'record-1' }, new Error('Exact diagnostic'))
      attempt.finish('FAILED')
      const json = serializeCertificationJson(attempt.read('user-1', f.context.scope.deviceScopeId))
      evidence = { json, characterCount: json.length, sha256: await sha256Hex(json) }
    }
    const filename = kind === 'attempt' ? 'JCVital PPI certification attempt.json' : 'JCVital PPI grouped certification.json'
    const snapshotBefore = [...f.storageRows.entries()]
    const journalBefore = [...f.journalRows.entries()]
    f.acquire.mockClear()
    f.enqueueMany.mockClear()
    f.flush.mockClear()
    f.readSourceEnvelope.mockClear()
    const backend = vi.spyOn(connectorObservationService, 'submitObservations')
    const clipboard = { writeText: vi.fn(async (_text: string) => {}) }
    const createUrl = vi.spyOn(URL, 'createObjectURL')
    const mapping = vi.spyOn(await import('./PhysiologyContract'), 'mapPhysiologyObservation')
    try {
      const html = renderToStaticMarkup(<PpiCertificationJsonView evidence={evidence} />)
      const escaped = renderToStaticMarkup(<pre>{evidence.json}</pre>).slice(5, -6)
      expect(html).toContain(`>${escaped}</textarea>`)
      await copyPpiCertificationJson(evidence, clipboard)
      await saveValidationJson(filename, evidence.json, 'PPI JSON', 'Share / Save PPI JSON')
      const shared = vi.mocked(Filesystem.writeFile).mock.calls[0][0]
      expect(shared).toEqual({ path: filename, data: evidence.json, directory: 'CACHE', encoding: 'utf8' })
      expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(shared.data)
      expect(typeof shared.data).toBe('string')
      expect(createHash('sha256').update(String(shared.data), 'utf8').digest('hex')).toBe(evidence.sha256)
      expect(await sha256Hex(clipboard.writeText.mock.calls[0][0])).toBe(evidence.sha256)
      expect(filename).toMatch(/\.json$/)
      expect(Share.share).toHaveBeenCalledExactlyOnceWith({
        title: 'PPI JSON', text: filename, files: [`file:///cache/${filename.replaceAll(' ', '%20')}`],
        dialogTitle: 'Share / Save PPI JSON',
      })
      expect(createUrl).not.toHaveBeenCalled()
      expect(f.acquire).not.toHaveBeenCalled()
      expect(f.enqueueMany).not.toHaveBeenCalled()
      expect(f.flush).not.toHaveBeenCalled()
      expect(f.readSourceEnvelope).not.toHaveBeenCalled()
      expect(backend).not.toHaveBeenCalled()
      expect(mapping).not.toHaveBeenCalled()
      expect([...f.storageRows.entries()]).toEqual(snapshotBefore)
      expect([...f.journalRows.entries()]).toEqual(journalBefore)
    } finally {
      backend.mockRestore()
      createUrl.mockRestore()
      mapping.mockRestore()
    }
  })

  it('wires both share buttons directly to the Phase helper with displayed evidence, not another exporter', () => {
    const panel = readFileSync(new URL('./JCVitalV8Panel.tsx', import.meta.url), 'utf8')
    const handler = panel.slice(panel.indexOf('  async function shareDisplayedPpiJson('),
      panel.indexOf('  async function inspectPpiCertification('))
    expect(handler).toContain('const evidence = attempt ? ppiAttemptJson : ppiJson')
    expect(handler).toContain('await saveValidationJson(filename, evidence.json,')
    expect(handler).not.toMatch(/serialize|readPpi|capture|enqueue|flush|exportSaved|writeFile|Share\.share|setPpiCertification|setPpiSnapshot/)
    expect(panel).toContain('shareDisplayedPpiJson()}>Share / Save PPI JSON')
    expect(panel).toContain('shareDisplayedPpiJson(true)}>Share / Save Last PPI Certification Attempt')
    expect(panel).toContain("await saveValidationJson(filename, json, 'JCVital V8 Phase 3A/3B/3C Validation'")
    expect(panel).toContain('? ppiJson : await readPpiCertificationJson')
    expect(panel).toContain('copyPpiCertificationJson(ppiAttemptJson)')
  })

  it('preserves displayed JSON on native share failure and reports the exact existing helper stage', async () => {
    const json = '{\n  "evidence": "exact"\n}\n'
    vi.mocked(Share.share).mockRejectedValue({ code: 'SHARE_FAILED', message: 'No activity available' })
    await expect(saveValidationJson('JCVital PPI certification attempt.json', json, 'PPI', 'Save'))
      .rejects.toThrow('SHARE: SHARE_FAILED: No activity available')
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ data: json }))
    expect(json).toBe('{\n  "evidence": "exact"\n}\n')
  })
})
