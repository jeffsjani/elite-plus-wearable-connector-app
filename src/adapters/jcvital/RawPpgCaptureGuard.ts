import type { JCVitalV8ConnectionState } from './jcvitalV8Bridge'

export interface RawPpgCaptureGate {
  pluginAvailable: boolean | null
  startMethodAvailable: boolean
  stopMethodAvailable: boolean
  connectionState: JCVitalV8ConnectionState
  activeSync: string | null
  manualMeasurementActive: boolean
  workoutStatus: string
  rawEcgStatus: string
  rawPpgStatus: string
}

const ACTIVE_WORKOUT_STATUSES = new Set(['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'])
const ACTIVE_CAPTURE_STATUSES = new Set(['STARTING', 'RUNNING', 'STOPPING'])

export function rawPpgStartDisabledReason(gate: RawPpgCaptureGate): string | null {
  if (gate.pluginAvailable === false) return 'JCVital V8 plugin is unavailable'
  if (gate.pluginAvailable === null) return 'Checking JCVital V8 plugin availability'
  if (!gate.startMethodAvailable) return 'Raw PPG workflow method is unavailable'
  if (gate.connectionState !== 'READY') return 'V8 must be READY'
  if (gate.activeSync !== null) return 'Another sync or measurement is active'
  if (gate.manualMeasurementActive) return 'Manual measurement is active'
  if (ACTIVE_WORKOUT_STATUSES.has(gate.workoutStatus)) return 'Workout capture is active'
  if (ACTIVE_CAPTURE_STATUSES.has(gate.rawEcgStatus)) return 'Raw ECG capture is active'
  if (ACTIVE_CAPTURE_STATUSES.has(gate.rawPpgStatus)) return 'PPG workflow capture is already active'
  return null
}

export function rawPpgStopDisabledReason(gate: RawPpgCaptureGate): string | null {
  if (!gate.stopMethodAvailable) return 'Raw PPG workflow stop method is unavailable'
  if (gate.rawPpgStatus !== 'RUNNING') return 'No running PPG workflow capture'
  return null
}