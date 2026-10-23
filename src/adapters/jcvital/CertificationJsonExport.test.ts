import { beforeEach, describe, expect, it, vi } from 'vitest'
import { Capacitor } from '@capacitor/core'
import { Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import {
  exportPpiCertificationFile, PPI_CERTIFICATION_FILENAME, saveValidationJson, serializeCertificationJson,
} from './CertificationJsonExport'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: vi.fn(() => true) } }))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: vi.fn() },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn() } }))

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(Capacitor.isNativePlatform).mockReturnValue(true)
  vi.mocked(Filesystem.writeFile).mockImplementation(async ({ path }) => ({ uri: `file:///cache/${path}` }))
  vi.mocked(Share.share).mockResolvedValue({})
})

describe('shared Android-safe certification JSON export', () => {
  it('exports the exact saved PPI JSON through a cache file and native share, never a Blob/download', async () => {
    const json = '{"certificationGroupId":"saved-vc9","slotEvidence":[0,0,22,22]}'
    const service = { exportSaved: vi.fn(async () => json) }
    const location = await exportPpiCertificationFile(service)
    expect(service.exportSaved).toHaveBeenCalledTimes(1)
    expect(Filesystem.writeFile).toHaveBeenCalledWith({
      path: PPI_CERTIFICATION_FILENAME, data: json, directory: 'CACHE', encoding: 'utf8',
    })
    expect(PPI_CERTIFICATION_FILENAME.endsWith('.json')).toBe(true)
    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
      files: ['file:///cache/JCVital%20PPI%20grouped%20certification.json'],
    }))
    expect(location).toContain('.json')
  })

  it.each([
    ['Type-42', 'jcvital-type42-certification-vc7.json'],
    ['Phase 3A/3B/3C', 'jcvital-v8-phase3abc-validation.json'],
  ])('retains the native file/share path for %s', async (title, filename) => {
    await saveValidationJson(filename, '{"evidence":"unchanged"}', title, title)
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ path: filename }))
    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ files: [`file:///cache/${filename}`] }))
  })

  it('does not double-encode an already encoded Filesystem URI', async () => {
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'file:///cache/JCVital%20PPI%20grouped%20certification.json' })
    await exportPpiCertificationFile({ exportSaved: async () => '{}' })
    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({
      files: ['file:///cache/JCVital%20PPI%20grouped%20certification.json'],
    }))
  })

  it('preserves explicit serialization diagnostics', () => {
    expect(() => serializeCertificationJson({ value: 1n })).toThrow(/JSON_SERIALIZATION:.*BigInt/i)
    expect(() => serializeCertificationJson(undefined)).toThrow(/JSON_SERIALIZATION:.*not JSON serializable/)
  })

  it('preserves filesystem error code/message and does not share after write failure', async () => {
    vi.mocked(Filesystem.writeFile).mockRejectedValue({ code: 'OS-PLUG-FILE-0006', message: 'Disk full' })
    await expect(exportPpiCertificationFile({ exportSaved: async () => '{}' }))
      .rejects.toThrow('FILESYSTEM_WRITE: OS-PLUG-FILE-0006: Disk full')
    expect(Share.share).not.toHaveBeenCalled()
  })

  it('preserves URI/FileProvider/share failure diagnostics after creating the file', async () => {
    vi.mocked(Share.share).mockRejectedValue({ code: 'SHARE_FAILED', message: 'Failed to find configured root' })
    await expect(exportPpiCertificationFile({ exportSaved: async () => '{}' }))
      .rejects.toThrow('SHARE: SHARE_FAILED: Failed to find configured root')
    expect(Filesystem.writeFile).toHaveBeenCalledTimes(1)
  })

  it('does not create or share a file if the saved-evidence read fails', async () => {
    await expect(exportPpiCertificationFile({ exportSaved: async () => { throw new Error('JOURNAL_READ: ENVELOPE_NOT_FOUND') } }))
      .rejects.toThrow('JOURNAL_READ: ENVELOPE_NOT_FOUND')
    expect(Filesystem.writeFile).not.toHaveBeenCalled()
    expect(Share.share).not.toHaveBeenCalled()
  })

  it('uses application/json for the browser fallback and releases the URL', async () => {
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false)
    const click = vi.fn()
    const anchor = { href: '', download: '', click }
    vi.stubGlobal('document', { createElement: vi.fn(() => anchor) })
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:json')
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {})
    try {
      await saveValidationJson('saved.json', '{}', 'Saved', 'Saved')
      expect(create.mock.calls[0][0]).toMatchObject({ type: 'application/json' })
      expect(anchor.download).toBe('saved.json')
      expect(click).toHaveBeenCalledOnce()
      expect(revoke).toHaveBeenCalledWith('blob:json')
      expect(Filesystem.writeFile).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
      create.mockRestore()
      revoke.mockRestore()
    }
  })
})
