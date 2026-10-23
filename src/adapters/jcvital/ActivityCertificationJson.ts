import { ACTIVITY_CERTIFICATION_FILENAME } from './Activity24_25Certification'
import { saveValidationJson } from './CertificationJsonExport'

export async function activityJsonAction(json: string, action: 'copy' | 'share', clipboard: Pick<Clipboard, 'writeText'> | null = navigator.clipboard): Promise<string> {
  if (action === 'copy') {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable; use Show or Share / Save.')
    await clipboard.writeText(json)
    return 'Activity 24/25 exact certification JSON copied'
  }
  return saveValidationJson(ACTIVITY_CERTIFICATION_FILENAME, json, 'JCVital Activity 24/25 certification',
    'Save or share Activity 24/25 source and delivery evidence')
}
