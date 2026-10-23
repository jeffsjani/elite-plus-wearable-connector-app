import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import { JCVitalV8 } from './jcvitalV8Bridge'
import { PPI_CERTIFICATION_SUCCESS, PpiCertification } from './PpiCertification'
import { DEVICE, fixture } from './PpiCertification.fixture'
import { PpiCertificationAttempt } from './PpiCertificationAttempt'
import { PpiCertificationJsonView } from './PpiCertificationJsonView'
import { PpiCertificationResume } from './PpiCertificationResume'
import {
  PPI_RESUME_BUTTON_LABEL, ppiResumeFailureText, runPpiCertificationResume, type PpiResumeUiFailure,
} from './PpiCertificationResumeAction'

const syncHistoricalPpi = vi.hoisted(() => vi.fn())
vi.mock('./jcvitalV8Bridge', async (importOriginal) => {
  const original = await importOriginal<typeof import('./jcvitalV8Bridge')>()
  const calls = new Map<PropertyKey, ReturnType<typeof vi.fn>>()
  const plugin = new Proxy({}, {
    get(_target, property) {
      if (property === 'then') return undefined
      if (property === 'syncHistoricalPpi') return syncHistoricalPpi
      if (!calls.has(property)) calls.set(property, vi.fn(async () => undefined))
      return calls.get(property)
    },
  })
  return { ...original, JCVitalV8: plugin }
})

const rows = new Map<string, string>()
vi.stubGlobal('localStorage', {
  getItem: (key: string) => rows.get(key) ?? null,
  setItem: (key: string, value: string) => { rows.set(key, value) },
  removeItem: (key: string) => { rows.delete(key) },
  key: (index: number) => [...rows.keys()][index] ?? null,
  get length() { return rows.size },
  clear: () => rows.clear(),
})

const OWNER = 'user-1'
const PANEL = readFileSync(new URL('./JCVitalV8Panel.tsx', import.meta.url), 'utf8')

beforeEach(() => { syncHistoricalPpi.mockReset(); rows.clear() })

function certificationKey() {
  return `elitePlus.ppiCertification.v1.${encodeURIComponent(OWNER)}.${encodeURIComponent(DEVICE)}`
}

/** Persists a real last physical attempt diagnostic exactly like the panel's live capture does. */
async function lastPhysicalAttempt(f: Awaited<ReturnType<typeof fixture>>) {
  const attempt = new PpiCertificationAttempt(f.deps.storage)
  attempt.start(OWNER, DEVICE, null)
  const live = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details, error) => attempt.event(stage, status, details, error) })
  await live.capture()
  const result = await live.flushSaved()
  attempt.finish(result.status)
  f.storageRows.delete(certificationKey())
  f.acquire.mockClear()
  f.flush.mockClear()
  return result
}

/** Mirrors the panel's createPpiCertificationResume wiring (JCVitalV8 as journal plugin, no acquire). */
function uiDeps(f: Awaited<ReturnType<typeof fixture>>, created: PpiCertificationResume[] = []) {
  return {
    ownerUserId: () => f.deps.queue.getOwnerUserId(),
    connectedContext: () => f.deps.connectedContext(),
    createResume: (onEngineStage: (stage: string, status: string, error?: unknown) => void) => {
      const resume = new PpiCertificationResume({
        ...f.deps, attemptJournal: JCVitalV8,
        attemptEvent: (stage, status, _details, error) => onEngineStage(stage, status, error),
      })
      created.push(resume)
      return resume
    },
  }
}

function panelSection(html: string, label: string): string {
  const start = html.indexOf(`<section aria-label="${label}"`)
  expect(start).toBeGreaterThanOrEqual(0)
  let depth = 0
  const tag = /<\/?section\b[^>]*>/g
  tag.lastIndex = start
  for (let match = tag.exec(html); match; match = tag.exec(html)) {
    depth += match[0].startsWith('</') ? -1 : 1
    if (depth === 0) return html.slice(start, match.index + match[0].length)
  }
  throw new Error(`Unterminated section ${label}`)
}

async function renderPanel(): Promise<string> {
  const { JCVitalV8Panel } = await import('./JCVitalV8Panel')
  return renderToStaticMarkup(<JCVitalV8Panel ownerUserId={OWNER} />)
}

describe('VC16 Resume PPI Certification button UI wiring', () => {
  it('renders the Resume button in the panel', async () => {
    const html = await renderPanel()
    expect(PPI_RESUME_BUTTON_LABEL).toBe('Resume PPI Certification From Last Physical Attempt')
    expect(html).toContain(`>${PPI_RESUME_BUTTON_LABEL}</button>`)
    expect(syncHistoricalPpi).not.toHaveBeenCalled()
  })

  it('places the button inside the PPI Certification section, not Read-Only Recovery Tools', async () => {
    const html = await renderPanel()
    const ppi = panelSection(html, 'PPI Certification')
    const recovery = panelSection(html, 'Read-Only Recovery Tools')
    expect(ppi).toContain(`>${PPI_RESUME_BUTTON_LABEL}</button>`)
    expect(recovery).not.toContain(PPI_RESUME_BUTTON_LABEL)
    expect(panelSection(html, 'PPI Certification Attempt Diagnostic')).not.toContain(PPI_RESUME_BUTTON_LABEL)
    // Existing JSON controls remain alongside it in the same section.
    for (const label of ['Show PPI Certification JSON', 'Copy PPI Certification JSON', 'Share / Save PPI JSON']) {
      expect(ppi).toContain(`>${label}</button>`)
    }
  })

  it('wires the button click to the VC15 PpiCertificationResume service, never to physical capture', () => {
    expect(PANEL).toContain('onClick={() => void resumePpiCertification()}>{PPI_RESUME_BUTTON_LABEL}</button>')
    const factory = PANEL.slice(PANEL.indexOf('  function createPpiCertificationResume('), PANEL.indexOf('  async function resumePpiCertification('))
    const handler = PANEL.slice(PANEL.indexOf('  async function resumePpiCertification('), PANEL.indexOf('  async function confirmPpiSnapshot('))
    expect(factory).toContain('return new PpiCertificationResume({')
    expect(handler).toContain('await runPpiCertificationResume({')
    expect(handler).toContain('createResume: createPpiCertificationResume')
    for (const code of [factory, handler]) {
      expect(code).not.toMatch(/syncHistoricalPpi|acquire|capturePpiCertification|ppiCertificationRef\.current\.capture|startDiscovery|connectAndBindJournal/)
    }
  })

  it('click handler invokes PpiCertificationResume.resume() with zero physical acquisition and zero syncHistoricalPpi()', async () => {
    const f = await fixture()
    await lastPhysicalAttempt(f)
    const resumeSpy = vi.spyOn(PpiCertificationResume.prototype, 'resume')
    const backend = vi.spyOn(connectorObservationService, 'submitObservations')
    const created: PpiCertificationResume[] = []
    try {
      const result = await runPpiCertificationResume(uiDeps(f, created))
      expect(result.ok).toBe(true)
      expect(resumeSpy).toHaveBeenCalledTimes(1)
      expect(created).toHaveLength(1)
      expect(created[0].operationCounts()).toEqual({ syncHistoricalPpiCalls: 0, bleHistoryAcquisitions: 0 })
      expect(result.counts).toEqual({ syncHistoricalPpiCalls: 0, bleHistoryAcquisitions: 0 })
      expect(f.acquire).not.toHaveBeenCalled()
      expect(syncHistoricalPpi).not.toHaveBeenCalled()
      expect(backend).not.toHaveBeenCalled()
    } finally {
      resumeSpy.mockRestore()
      backend.mockRestore()
    }
  })

  it('successful resume saves the snapshot and exposes the certification JSON for Show/Copy/Share', async () => {
    const f = await fixture()
    const live = await lastPhysicalAttempt(f)
    const result = await runPpiCertificationResume(uiDeps(f))
    if (!result.ok) throw new Error(ppiResumeFailureText(result))
    const group = result.inspection.group!
    expect(result.inspection.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(result.snapshotStatus).toContain('PPI CERTIFICATION SNAPSHOT SAVED')
    expect(result.snapshotStatus).toContain(`certificationGroupId: ${group.certificationGroupId}`)
    expect(result.snapshotStatus).toContain(`sourceEnvelopeId: ${group.sourceEnvelopeId}`)
    expect(result.snapshotStatus).toContain(`selected child count: ${group.children.length}`)
    expect(result.snapshotStatus).toContain(`delivered child count: ${result.inspection.delivered}`)
    expect(f.storageRows.has(result.snapshotKey)).toBe(true)
    expect(result.snapshotKey).toBe(certificationKey())
    // Targeted delivery of only the deterministic selected child IDs.
    expect(f.flush).toHaveBeenCalledTimes(1)
    expect([...f.flush.mock.calls[0][0]].sort())
      .toEqual(group.children.map((child) => child.observationId).sort())
    expect(group.sourceEnvelopeId).toBe(live.group?.sourceEnvelopeId)
    // JSON is the same export the existing Show/Copy/Share controls use.
    expect(result.json.json).toBe(await new PpiCertification(f.deps).exportSaved())
    const view = renderToStaticMarkup(<PpiCertificationJsonView evidence={result.json} />)
    expect(view).toContain(result.json.sha256)
    // Panel publishes the resume result into the state those existing controls read.
    const handler = PANEL.slice(PANEL.indexOf('  async function resumePpiCertification('), PANEL.indexOf('  async function confirmPpiSnapshot('))
    expect(handler).toContain('ppiCurrentInspectionRef.current = structuredClone(result.inspection)')
    expect(handler).toContain('setPpiJson(result.json)')
    expect(handler).toContain('setPpiSnapshotStatus(result.snapshotStatus)')
    expect(PANEL).toContain('disabled={busy || !ppiJson} onClick={() => void shareDisplayedPpiJson()}>Share / Save PPI JSON')
  })

  it('missing last attempt fails with exact stage/code/message and never auto-recaptures', async () => {
    const f = await fixture()
    const result = await runPpiCertificationResume(uiDeps(f)) as PpiResumeUiFailure
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('LAST_ATTEMPT_READ')
    expect(result.code).toBe('NO_PPI_CERTIFICATION_ATTEMPT_AVAILABLE')
    expect(ppiResumeFailureText(result)).toContain('stage: LAST_ATTEMPT_READ · code: NO_PPI_CERTIFICATION_ATTEMPT_AVAILABLE')
    expect(ppiResumeFailureText(result)).toContain('No physical recapture was attempted')
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(syncHistoricalPpi).not.toHaveBeenCalled()
  })

  it('journal ancestry failure during resume reports the pipeline stage and never auto-recaptures', async () => {
    const f = await fixture()
    await lastPhysicalAttempt(f)
    f.journalRows.delete('record-1-ble')
    const result = await runPpiCertificationResume(uiDeps(f)) as PpiResumeUiFailure
    expect(result.ok).toBe(false)
    expect(result.stage).toBe('RESUME_PIPELINE')
    expect(result.message).toBeTruthy()
    expect(result.counts).toEqual({ syncHistoricalPpiCalls: 0, bleHistoryAcquisitions: 0 })
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(syncHistoricalPpi).not.toHaveBeenCalled()
  })

  it.each([
    ['no authenticated owner', 'OWNER_CHECK', 'PPI_RESUME_OWNER_REQUIRED', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...uiDeps(f), ownerUserId: () => null })],
    ['no connected source-journal scope', 'SOURCE_SCOPE_CHECK', 'PPI_RESUME_SOURCE_SCOPE_REQUIRED', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...uiDeps(f), connectedContext: () => null })],
    ['scope owned by another account', 'SOURCE_SCOPE_CHECK', 'PPI_RESUME_OWNER_SCOPE_MISMATCH', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...uiDeps(f), ownerUserId: () => 'user-2' })],
    ['non-physical device', 'SOURCE_SCOPE_CHECK', 'PPI_RESUME_PHYSICAL_V8_REQUIRED', (f: Awaited<ReturnType<typeof fixture>>) => ({ ...uiDeps(f), connectedContext: () => ({ ...f.deps.connectedContext(), physical: false }) })],
  ])('rejects %s before touching the resume service', async (_name, stage, code, build) => {
    const f = await fixture()
    await lastPhysicalAttempt(f)
    const resumeSpy = vi.spyOn(PpiCertificationResume.prototype, 'resume')
    try {
      const result = await runPpiCertificationResume(build(f)) as PpiResumeUiFailure
      expect(result).toMatchObject({ ok: false, stage, code })
      expect(resumeSpy).not.toHaveBeenCalled()
      expect(f.acquire).not.toHaveBeenCalled()
      expect(syncHistoricalPpi).not.toHaveBeenCalled()
    } finally { resumeSpy.mockRestore() }
  })

  it('panel failure path shows the failure text and has no fallback to capture or syncHistoricalPpi()', () => {
    const handler = PANEL.slice(PANEL.indexOf('  async function resumePpiCertification('), PANEL.indexOf('  async function confirmPpiSnapshot('))
    expect(handler).toContain('setPpiCertificationStatus(ppiResumeFailureText(result))')
    expect(handler).not.toMatch(/capture\(|syncHistoricalPpi|capturePpiCertification/)
  })
})
