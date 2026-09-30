import type { JCVitalV8ConnectionState } from './jcvitalV8Bridge'
import type { LiveWorkoutStatus } from './WorkoutTelemetry'

export interface RawEcgCaptureGate {
  pluginAvailable: boolean | null
   startMethodAvailable: boolean
   stopMethodAvailable: boolean
  connectionState: JCVitalV8ConnectionState
  activeSync: string | null
  manualMeasurementActive: boolean
  workoutStatus: LiveWorkoutStatus | null
  rawEcgStatus: string | null
}

const TERMINAL = ['IDLE', 'STOPPED', 'ERROR', 'DISCONNECTED']

export function rawEcgStartDisabledReason(gate: RawEcgCaptureGate): string | null {
  if (gate.pluginAvailable !== true) return gate.pluginAvailable === null ? 'native plugin availability is checking' : 'native plugin unavailable'
   if (!gate.startMethodAvailable) return 'native startRawEcg method unavailable'
  if (gate.connectionState !== 'READY') return 'V8 not READY'
  if (gate.activeSync !== null) return `another sync/session is active (${gate.activeSync})`
  if (gate.manualMeasurementActive) return 'manual HR measurement is active'
  if (gate.workoutStatus && !TERMINAL.includes(gate.workoutStatus)) return 'workout capture is active'
  if (gate.rawEcgStatus && !TERMINAL.includes(gate.rawEcgStatus)) return 'raw ECG session already active'
  return null
}

export function rawEcgStopDisabledReason(gate: RawEcgCaptureGate): string | null {
  if (gate.pluginAvailable !== true) return gate.pluginAvailable === null ? 'native plugin availability is checking' : 'native plugin unavailable'
   if (!gate.stopMethodAvailable) return 'native stopRawEcg method unavailable'
  if (gate.connectionState !== 'READY') return 'V8 not READY'
  if (gate.activeSync !== null && !gate.activeSync.startsWith('raw-ecg')) return `another sync/session is active (${gate.activeSync})`
  if (gate.rawEcgStatus !== 'RUNNING') return gate.rawEcgStatus === 'STARTING' ? 'waiting for ECG start writes' : 'raw ECG session is not running'
  return null
}
