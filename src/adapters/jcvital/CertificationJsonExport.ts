import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

export type CertificationExportStage = 'SNAPSHOT_READ' | 'JOURNAL_READ' | 'EVIDENCE_VALIDATION'
  | 'JSON_SERIALIZATION' | 'FILESYSTEM_WRITE' | 'SHARE' | 'BLOB_CREATION' | 'BROWSER_DOWNLOAD'

function errorDetails(error: unknown): string {
  if (error && typeof error === 'object') {
    const code = 'code' in error ? String(error.code) : null
    const message = 'message' in error ? String(error.message) : String(error)
    return code ? `${code}: ${message}` : message
  }
  return String(error)
}

export class CertificationExportError extends Error {
  readonly stage: CertificationExportStage

  constructor(stage: CertificationExportStage, cause: unknown) {
    super(`${stage}: ${errorDetails(cause)}`, { cause })
    this.stage = stage
    this.name = 'CertificationExportError'
  }
}

export async function exportStage<T>(stage: CertificationExportStage, action: () => T | Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof CertificationExportError) throw error
    throw new CertificationExportError(stage, error)
  }
}

export function serializeCertificationJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2)
    if (json === undefined) throw new Error('Certification evidence is not JSON serializable.')
    return json
  } catch (error) {
    throw new CertificationExportError('JSON_SERIALIZATION', error)
  }
}

export async function saveValidationJson(filename: string, json: string, title: string, dialogTitle: string): Promise<string> {
  if (!filename.endsWith('.json')) throw new CertificationExportError('FILESYSTEM_WRITE', new Error('A .json filename is required.'))
  if (Capacitor.isNativePlatform()) {
    const saved = await exportStage('FILESYSTEM_WRITE', () => Filesystem.writeFile({
      path: filename, data: json, directory: Directory.Cache, encoding: Encoding.UTF8,
    }))
    // Share infers application/json from the extension; URL-encode spaces for Android MimeTypeMap.
    await exportStage('SHARE', () => Share.share({ title, text: filename, files: [new URL(saved.uri).href], dialogTitle }))
    return `${filename} · ${saved.uri}`
  }
  const url = await exportStage('BLOB_CREATION', () => URL.createObjectURL(new Blob([json], { type: 'application/json' })))
  try {
    await exportStage('BROWSER_DOWNLOAD', () => {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
    })
    return filename
  } finally {
    URL.revokeObjectURL(url)
  }
}

export const PPI_CERTIFICATION_FILENAME = 'JCVital PPI grouped certification.json'

export async function exportPpiCertificationFile(service: { exportSaved(): Promise<string> }): Promise<string> {
  const json = await service.exportSaved()
  return saveValidationJson(PPI_CERTIFICATION_FILENAME, json, 'JCVital PPI grouped certification',
    'Save or share PPI source and native-only delivery evidence')
}
