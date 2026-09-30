import { describe, expect, it } from 'vitest'
import { phase3bDisabledReason } from './Phase3BBridgeStatus'

describe('Phase 3B bridge control gate', () => {
  const ready = { pluginAvailable: true, methodAvailable: true, connectionState: 'READY' as const, activeSync: null }

  it('enables diagnostics solely when plugin/method are available, READY, and idle', () => {
    expect(phase3bDisabledReason(ready)).toBeNull()
  })

  it('reports each disabled reason explicitly', () => {
    expect(phase3bDisabledReason({ ...ready, pluginAvailable: null })).toBe('native plugin availability is checking')
    expect(phase3bDisabledReason({ ...ready, pluginAvailable: false })).toBe('native plugin unavailable')
    expect(phase3bDisabledReason({ ...ready, methodAvailable: false })).toBe('native method unavailable')
    expect(phase3bDisabledReason({ ...ready, connectionState: 'CONNECTED' })).toBe('V8 not READY')
    expect(phase3bDisabledReason({ ...ready, activeSync: 'sleep' })).toBe('another sync is active (sleep)')
  })
})