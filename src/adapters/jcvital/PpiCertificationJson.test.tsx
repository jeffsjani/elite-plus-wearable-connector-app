import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import { PpiCertification } from './PpiCertification'
import { fixture } from './PpiCertification.fixture'
import {
  copyPpiCertificationJson, NO_PPI_CERTIFICATION_GROUP_AVAILABLE,
  ppiSnapshotSavedStatus, readPpiCertificationJson,
} from './PpiCertificationJson'
import { PpiCertificationJsonView } from './PpiCertificationJsonView'

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: vi.fn() },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(Filesystem.writeFile).mockRejectedValue(new Error('Filesystem unavailable'))
  vi.mocked(Share.share).mockRejectedValue(new Error('Share unavailable'))
})

function expectFullJsonVisible(evidence: Awaited<ReturnType<typeof readPpiCertificationJson>>) {
  const html = renderToStaticMarkup(<PpiCertificationJsonView evidence={evidence} />)
  const escapedJson = renderToStaticMarkup(<pre>{evidence.json}</pre>).slice(5, -6)
  expect(html).toContain(`>${escapedJson}</textarea>`)
  expect(html).toMatch(/readonly=""/i)
  expect(html).toContain('rows="24"')
  expect(html).toContain('overflow:auto')
  expect(html).toContain('Select All')
  expect(html).toContain(`Character count: ${evidence.json.length}`)
  expect(html).toContain(evidence.sha256)
  expect(Filesystem.writeFile).not.toHaveBeenCalled()
  expect(Share.share).not.toHaveBeenCalled()
}

describe('VC12 full PPI certification JSON view/copy fallback', () => {
  it('renders every character of a large current export immediately after capture without Filesystem or Share', async () => {
    const f = await fixture(Array.from({ length: 1000 }, (_, index) => index % 3 === 0 ? 0 : 22))
    const current = await f.service.capture()
    const evidence = await readPpiCertificationJson(f.service, current)
    expect(evidence.json).toBe(await f.service.exportSaved())
    expect(evidence.json.length).toBeGreaterThan(100000)
    expect(JSON.parse(evidence.json).slotEvidence).toHaveLength(1000)
    expectFullJsonVisible(evidence)
  })

  it('uses current validated memory even when the saved snapshot is no longer available', async () => {
    const f = await fixture()
    const current = await f.service.capture()
    const expected = await readPpiCertificationJson(f.service, current)
    f.storageRows.clear()
    f.readSourceEnvelope.mockClear()
    expect(await readPpiCertificationJson(f.service, current)).toEqual(expected)
    expect(f.readSourceEnvelope).not.toHaveBeenCalled()
    await expect(readPpiCertificationJson(f.service)).rejects.toThrow(NO_PPI_CERTIFICATION_GROUP_AVAILABLE)
  })

  it('renders identical saved JSON after restart and re-reads journal ancestry without acquiring/enqueuing/delivering/Base44', async () => {
    const f = await fixture()
    await f.service.capture()
    await f.service.flushSaved()
    const expected = await f.service.exportSaved()
    f.acquire.mockClear()
    f.enqueueMany.mockClear()
    f.flush.mockClear()
    f.readSourceEnvelope.mockClear()
    const backend = vi.spyOn(connectorObservationService, 'submitObservations')
    try {
      const restarted = new PpiCertification(f.deps)
      f.context.ready = false
      const evidence = await readPpiCertificationJson(restarted)
      expect(evidence.json).toBe(expected)
      expect(f.readSourceEnvelope.mock.calls.map(([options]) => options.envelopeId))
        .toEqual(['record-1', 'record-1-callback', 'record-1-ble'])
      expectFullJsonVisible(evidence)
      const clipboard = { writeText: vi.fn(async () => undefined) }
      expect(await copyPpiCertificationJson(evidence, clipboard)).toContain('JSON COPIED')
      expect(clipboard.writeText).toHaveBeenCalledWith(expected)
      expect(f.acquire).not.toHaveBeenCalled()
      expect(f.enqueueMany).not.toHaveBeenCalled()
      expect(f.flush).not.toHaveBeenCalled()
      expect(backend).not.toHaveBeenCalled()
    } finally { backend.mockRestore() }
  })

  it('copies the exact current JSON with zero acquisition/enqueue/delivery/Base44 operations', async () => {
    const f = await fixture()
    const current = await f.service.capture()
    f.acquire.mockClear()
    f.enqueueMany.mockClear()
    f.flush.mockClear()
    const backend = vi.spyOn(connectorObservationService, 'submitObservations')
    try {
      const evidence = await readPpiCertificationJson(f.service, current)
      const clipboard = { writeText: vi.fn(async () => undefined) }
      await copyPpiCertificationJson(evidence, clipboard)
      expect(clipboard.writeText).toHaveBeenCalledExactlyOnceWith(evidence.json)
      expect(f.acquire).not.toHaveBeenCalled()
      expect(f.enqueueMany).not.toHaveBeenCalled()
      expect(f.flush).not.toHaveBeenCalled()
      expect(backend).not.toHaveBeenCalled()
    } finally { backend.mockRestore() }
  })

  it.each(['denied', 'unavailable'])('leaves the full exact JSON visible when clipboard is %s', async (failure) => {
    const f = await fixture()
    const current = await f.service.capture()
    const evidence = await readPpiCertificationJson(f.service, current)
    const original = evidence.json
    const clipboard = failure === 'denied'
      ? { writeText: vi.fn().mockRejectedValue(new Error('Permission denied')) } : undefined
    const status = await copyPpiCertificationJson(evidence, clipboard)
    expect(status).toContain('COPY FAILED')
    expect(status).toContain('Select All and Copy manually')
    expect(evidence.json).toBe(original)
    expectFullJsonVisible(evidence)
  })

  it('hashes the exact UTF-8 JSON deterministically across current/saved/restart views', async () => {
    const f = await fixture()
    const current = await f.service.capture()
    const a = await readPpiCertificationJson(f.service, current)
    const b = await readPpiCertificationJson(f.service)
    const c = await readPpiCertificationJson(new PpiCertification(f.deps))
    expect(a).toEqual(b)
    expect(b).toEqual(c)
    expect(a.sha256).toBe(createHash('sha256').update(a.json, 'utf8').digest('hex'))
    expect(a.characterCount).toBe(a.json.length)
  })

  it('keeps the full JSON available when accessing the Clipboard API itself throws', async () => {
    const f = await fixture()
    const evidence = await readPpiCertificationJson(f.service, await f.service.capture())
    vi.stubGlobal('navigator', {
      get clipboard(): Clipboard { throw new Error('Clipboard access denied') },
    })
    try {
      expect(await copyPpiCertificationJson(evidence)).toContain('COPY FAILED: Clipboard access denied')
      expectFullJsonVisible(evidence)
    } finally { vi.unstubAllGlobals() }
  })

  it('reports a missing snapshot clearly, including before reconnect, without any write operation', async () => {
    const f = await fixture()
    f.deps.connectedContext = () => { throw new Error('Not reconnected') }
    await expect(readPpiCertificationJson(f.service)).rejects.toThrow(NO_PPI_CERTIFICATION_GROUP_AVAILABLE)
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.readSourceEnvelope).not.toHaveBeenCalled()
  })

  it('fails explicitly for corrupt snapshots or unavailable journal ancestry, without file export', async () => {
    const f = await fixture()
    await f.service.capture()
    f.readSourceEnvelope.mockRejectedValue(new Error('Journal unavailable'))
    await expect(readPpiCertificationJson(new PpiCertification(f.deps))).rejects.toThrow('JOURNAL_READ: Journal unavailable')
    for (const key of f.storageRows.keys()) f.storageRows.set(key, '{broken')
    await expect(readPpiCertificationJson(f.service)).rejects.toThrow('SNAPSHOT_READ')
    expect(Filesystem.writeFile).not.toHaveBeenCalled()
    expect(Share.share).not.toHaveBeenCalled()
  })

  it('verifies exact snapshot persistence before reporting saved group, source, key, counts and JSON availability', async () => {
    const f = await fixture()
    await f.service.capture()
    const delivered = await f.service.flushSaved()
    const key = f.service.verifySnapshotPersisted(delivered.group!)
    const status = ppiSnapshotSavedStatus(delivered, key, true)
    expect(status).toBe(`PPI CERTIFICATION SNAPSHOT SAVED\ncertificationGroupId: ${delivered.group!.certificationGroupId}`
      + `\nsourceEnvelopeId: record-1\nsnapshot storage key: ${[...f.storageRows.keys()][0]}`
      + '\nselected child count: 5\ndelivered child count: 5\nJSON available = true')
    expect(ppiSnapshotSavedStatus(delivered, key, false)).toContain('JSON available = false')
    f.storageRows.clear()
    expect(() => f.service.verifySnapshotPersisted(delivered.group!)).toThrow('snapshot persistence verification failed')
  })

  it('rejects snapshot persistence verification if the stored group was changed', async () => {
    const f = await fixture()
    await f.service.capture()
    const delivered = await f.service.flushSaved()
    const key = f.service.verifySnapshotPersisted(delivered.group!)
    const altered = structuredClone(delivered.group!)
    altered.children[0].receipts = []
    f.storageRows.set(key, JSON.stringify(altered))
    expect(() => f.service.verifySnapshotPersisted(delivered.group!))
      .toThrow('snapshot persistence verification failed')
  })

  it('does not report certification success when storage rejects the capture or delivery snapshot', async () => {
    const f = await fixture()
    const write = vi.spyOn(f.deps.storage(), 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    await expect(f.service.capture()).rejects.toThrow('Storage full')
    expect(f.flush).not.toHaveBeenCalled()
    write.mockRestore()
    await f.service.capture()
    const failed = vi.spyOn(f.deps.storage(), 'setItem').mockImplementation(() => { throw new Error('Storage full') })
    await expect(f.service.flushSaved()).rejects.toThrow('Storage full')
    failed.mockRestore()
  })
})
