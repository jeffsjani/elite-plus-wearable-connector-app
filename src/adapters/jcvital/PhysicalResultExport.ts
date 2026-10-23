import { saveValidationJson } from './CertificationJsonExport'

export function requirePhysicalResultJson(payload: string): string {
  if (payload.length === 0) throw new Error('RESULT_JSON_EMPTY')
  return payload
}

async function clipboardOperation<T>(operation: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('CLIPBOARD_TIMEOUT')), 2000)
    })])
  } finally { clearTimeout(timer) }
}

export async function copyPhysicalResultJson(payload: string): Promise<string> {
  requirePhysicalResultJson(payload)
  if (!navigator.clipboard?.writeText) throw new Error('CLIPBOARD_UNAVAILABLE')
  await clipboardOperation(navigator.clipboard.writeText(payload))
  if (navigator.clipboard.readText) {
    let copied: string
    try { copied = await clipboardOperation(navigator.clipboard.readText()) }
    catch (error) {
      // WebView may permit writing but deny reading. A completed write is still required.
      return `Clipboard write succeeded; read-back unavailable: ${error instanceof Error ? error.message : String(error)}`
    }
    if (copied !== payload) throw new Error('CLIPBOARD_READ_BACK_MISMATCH')
    return 'Clipboard write and exact read-back verified.'
  }
  return 'Clipboard write succeeded; read-back unsupported.'
}

export async function savePhysicalResultJson(filename: string, payload: string, kind: string): Promise<string> {
  requirePhysicalResultJson(payload)
  return saveValidationJson(filename, payload, `Elite+ V8 ${kind} semantic test`, 'Save or share physical semantic test JSON')
}
