import { saveValidationJson } from './CertificationJsonExport'
import { SLEEP_CERTIFICATION_FILENAME } from './SleepCertification'

export async function sleepJsonAction(json: string, action: 'copy' | 'share',
  clipboard: Pick<Clipboard, 'writeText'> | null = navigator.clipboard): Promise<string> {
  if (action === 'copy') {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable; use Show or Share / Save.')
    await clipboard.writeText(json)
    return 'Sleep exact certification JSON copied'
  }
  return saveValidationJson(SLEEP_CERTIFICATION_FILENAME, json, 'JCVital Sleep history certification',
    'Save or share Sleep physical source evidence')
}
