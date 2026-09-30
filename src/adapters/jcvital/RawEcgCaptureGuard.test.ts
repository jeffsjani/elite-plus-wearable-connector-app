import { describe, expect, it } from 'vitest'
import { rawEcgStartDisabledReason, rawEcgStopDisabledReason } from './RawEcgCaptureGuard'

const ready = {
  pluginAvailable: true,
  startMethodAvailable: true,
  stopMethodAvailable: true,
  connectionState: 'READY' as const,
  activeSync: null,
  manualMeasurementActive: false,
  workoutStatus: 'IDLE' as const,
  rawEcgStatus: 'IDLE',
}

describe('raw ECG control gate', () => {
  it('allows a fresh ECG capture only when ready and otherwise idle', () => {
    expect(rawEcgStartDisabledReason(ready)).toBeNull()
    expect(rawEcgStartDisabledReason({ ...ready, pluginAvailable: false })).toBe('native plugin unavailable')
    expect(rawEcgStartDisabledReason({ ...ready, startMethodAvailable: false })).toBe('native startRawEcg method unavailable')
    expect(rawEcgStartDisabledReason({ ...ready, connectionState: 'CONNECTED' })).toBe('V8 not READY')
    expect(rawEcgStartDisabledReason({ ...ready, activeSync: 'phase3b:sleep' })).toContain('another sync/session is active')
    expect(rawEcgStartDisabledReason({ ...ready, manualMeasurementActive: true })).toBe('manual HR measurement is active')
    expect(rawEcgStartDisabledReason({ ...ready, workoutStatus: 'RUNNING' })).toBe('workout capture is active')
    expect(rawEcgStartDisabledReason({ ...ready, rawEcgStatus: 'RUNNING' })).toBe('raw ECG session already active')
  })

  it('only enables ECG stop while capture is running and preserves the active-session lock', () => {
    expect(rawEcgStopDisabledReason({ ...ready, rawEcgStatus: 'RUNNING', activeSync: 'raw-ecg' })).toBeNull()
    expect(rawEcgStopDisabledReason(ready)).toBe('raw ECG session is not running')
    expect(rawEcgStopDisabledReason({ ...ready, stopMethodAvailable: false })).toBe('native stopRawEcg method unavailable')
  })
})
