import type { JCVitalV8ConnectionState } from './jcvitalV8Bridge'
import type { LiveWorkoutStatus } from './WorkoutTelemetry'

export interface WorkoutCaptureGate {
  pluginAvailable: boolean | null
  startMethodAvailable: boolean
  stopMethodAvailable: boolean
  connectionState: JCVitalV8ConnectionState
  activeSync: string | null
  manualMeasurementActive: boolean
  workoutStatus: LiveWorkoutStatus | null
}

export function workoutStartDisabledReason(gate: WorkoutCaptureGate): string | null {
  if (gate.pluginAvailable !== true) return gate.pluginAvailable === null ? 'native plugin availability is checking' : 'native plugin unavailable'
  if (!gate.startMethodAvailable) return 'native startWorkoutCapture method unavailable'
  if (gate.connectionState !== 'READY') return 'V8 not READY'
  if (gate.manualMeasurementActive) return 'manual HR measurement is active'
  if (gate.workoutStatus && !['IDLE', 'STOPPED', 'ERROR', 'DISCONNECTED'].includes(gate.workoutStatus)) return 'workout capture already active'
  if (gate.activeSync !== null) return `another measurement/sync is active (${gate.activeSync})`
  return null
}

export function workoutStopDisabledReason(gate: WorkoutCaptureGate): string | null {
  if (gate.pluginAvailable !== true) return gate.pluginAvailable === null ? 'native plugin availability is checking' : 'native plugin unavailable'
  if (!gate.stopMethodAvailable) return 'native stopWorkoutCapture method unavailable'
  if (gate.connectionState !== 'READY') return 'V8 not READY'
  if (gate.workoutStatus === 'STARTING') return 'waiting for V8 workout start acknowledgment'
  if (gate.workoutStatus !== 'RUNNING' && gate.workoutStatus !== 'PAUSED') return 'workout capture is not running'
  return null
}
