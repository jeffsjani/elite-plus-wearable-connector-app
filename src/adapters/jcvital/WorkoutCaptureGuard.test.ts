import { describe, expect, it } from 'vitest'
import { workoutStartDisabledReason, workoutStopDisabledReason } from './WorkoutCaptureGuard'

const ready = {
  pluginAvailable: true,
  startMethodAvailable: true,
  stopMethodAvailable: true,
  connectionState: 'READY' as const,
  activeSync: null,
  manualMeasurementActive: false,
  workoutStatus: 'IDLE' as const,
}

describe('workout capture control guard', () => {
  it('allows start only when plugin, method, READY, and all measurements are idle', () => {
    expect(workoutStartDisabledReason(ready)).toBeNull()
    expect(workoutStartDisabledReason({ ...ready, pluginAvailable: false })).toBe('native plugin unavailable')
    expect(workoutStartDisabledReason({ ...ready, startMethodAvailable: false })).toBe('native startWorkoutCapture method unavailable')
    expect(workoutStartDisabledReason({ ...ready, connectionState: 'CONNECTED' })).toBe('V8 not READY')
    expect(workoutStartDisabledReason({ ...ready, activeSync: 'phase3b:sleep' })).toContain('another measurement/sync is active')
    expect(workoutStartDisabledReason({ ...ready, manualMeasurementActive: true })).toBe('manual HR measurement is active')
    expect(workoutStartDisabledReason({ ...ready, workoutStatus: 'RUNNING' })).toBe('workout capture already active')
  })

  it('allows stop only for an acknowledged running or paused session', () => {
    expect(workoutStopDisabledReason({ ...ready, workoutStatus: 'RUNNING' })).toBeNull()
    expect(workoutStopDisabledReason({ ...ready, workoutStatus: 'PAUSED' })).toBeNull()
    expect(workoutStopDisabledReason(ready)).toBe('workout capture is not running')
    expect(workoutStopDisabledReason({ ...ready, workoutStatus: 'STARTING' })).toBe('waiting for V8 workout start acknowledgment')
    expect(workoutStopDisabledReason({ ...ready, stopMethodAvailable: false })).toBe('native stopWorkoutCapture method unavailable')
  })
})
