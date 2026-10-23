import { saveValidationJson } from './CertificationJsonExport'
import { WORKOUT_CERTIFICATION_FILENAME } from './WorkoutHistoryCertification'

export async function workoutJsonAction(json: string, action: 'copy' | 'share',
  clipboard: Pick<Clipboard, 'writeText'> | null = navigator.clipboard): Promise<string> {
  if (action === 'copy') {
    if (!clipboard?.writeText) throw new Error('Clipboard unavailable; use Show or Share / Save.')
    await clipboard.writeText(json)
    return 'Workout exact certification JSON copied'
  }
  return saveValidationJson(WORKOUT_CERTIFICATION_FILENAME, json, 'JCVital Workout history certification',
    'Save or share Workout physical source evidence')
}
