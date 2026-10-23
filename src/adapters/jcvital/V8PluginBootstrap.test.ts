import { afterEach, describe, expect, it, vi } from 'vitest'
import { V8PluginBootstrap } from './V8PluginBootstrap'

function fixture() {
  const bridge = {
    initialize: vi.fn(async () => ({ initialized: true, pluginName: 'JCVitalV8' })),
    isAvailable: vi.fn(async () => ({ available: true, enabled: true })),
  }
  const available = vi.fn(() => true)
  return { bridge, available, bootstrap: new V8PluginBootstrap(bridge, available) }
}

afterEach(() => vi.useRealTimers())

describe('application-owned V8 native bootstrap', () => {
  it('resolves bridge registration before initialization, and requires a native ACK before READY', async () => {
    const { bridge, bootstrap } = fixture()
    const states: string[] = []
    bootstrap.subscribe(() => states.push(bootstrap.getSnapshot().state))
    await bootstrap.ensureReady()
    expect(states).toEqual(['REGISTERING', 'INITIALIZING', 'READY'])
    expect(bridge.initialize).toHaveBeenCalledOnce()
    expect(bootstrap.getSnapshot()).toEqual({ state: 'READY', error: null, adapterAvailable: true })
  })

  it('shares a single initialization across concurrent consumers and subsequent remounts', async () => {
    const { bootstrap, bridge } = fixture()
    await Promise.all([bootstrap.ensureReady(), bootstrap.ensureReady()])
    await bootstrap.ensureReady()
    expect(bridge.initialize).toHaveBeenCalledOnce()
  })

  it('does not confuse Bluetooth being off with plugin initialization failure', async () => {
    const { bootstrap, bridge } = fixture()
    bridge.isAvailable.mockResolvedValue({ available: true, enabled: false })
    await bootstrap.ensureReady()
    expect(bootstrap.getSnapshot().state).toBe('READY')
  })

  it('surfaces a missing bridge plugin without calling initialization', async () => {
    const { bootstrap, bridge, available } = fixture()
    available.mockReturnValue(false)
    await expect(bootstrap.ensureReady()).rejects.toThrow('not registered')
    expect(bootstrap.getSnapshot().state).toBe('UNAVAILABLE')
    expect(bridge.initialize).not.toHaveBeenCalled()
  })

  it.each([
    { initialized: false, pluginName: 'JCVitalV8' },
    { initialized: true, pluginName: 'WrongPlugin' },
  ])('refuses an invalid native ACK %j', async (ack) => {
    const { bootstrap, bridge } = fixture()
    bridge.initialize.mockResolvedValue(ack)
    await expect(bootstrap.ensureReady()).rejects.toThrow('Invalid')
    expect(bootstrap.getSnapshot().state).toBe('FAILED')
    expect(bridge.isAvailable).not.toHaveBeenCalled()
  })

  it('surfaces native failures and safely retries on the next authentication', async () => {
    const { bootstrap, bridge } = fixture()
    bridge.initialize.mockRejectedValueOnce(new Error('SDK_INITIALIZATION_FAILED'))
    await expect(bootstrap.ensureReady()).rejects.toThrow('SDK_INITIALIZATION_FAILED')
    expect(bootstrap.getSnapshot()).toMatchObject({ state: 'FAILED', error: 'SDK_INITIALIZATION_FAILED' })
    await bootstrap.ensureReady()
    expect(bootstrap.getSnapshot().state).toBe('READY')
    expect(bridge.initialize).toHaveBeenCalledTimes(2)
  })

  it('times out a missing ACK and never publishes READY for its late resolution', async () => {
    vi.useFakeTimers()
    const { bootstrap, bridge } = fixture()
    let acknowledge!: (result: { initialized: boolean; pluginName: string }) => void
    bridge.initialize.mockImplementation(() => new Promise((resolve) => { acknowledge = resolve }))
    const rejected = expect(bootstrap.ensureReady()).rejects.toThrow('ACK timed out')
    await vi.advanceTimersByTimeAsync(10000)
    await rejected
    acknowledge({ initialized: true, pluginName: 'JCVitalV8' })
    await Promise.resolve()
    expect(bootstrap.getSnapshot().state).toBe('FAILED')
  })
})
