import { Capacitor } from '@capacitor/core'
import { createContext, useCallback, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import { crashBreadcrumbs } from '../../services/diagnostics/CrashBreadcrumbs'
import { JCVitalV8, type JCVitalV8Plugin, type SourceJournalScope, type JCVitalV8Device, type JCVitalV8DeviceInfo } from './jcvitalV8Bridge'

export type V8PluginStartupState = 'UNAVAILABLE' | 'REGISTERING' | 'INITIALIZING' | 'READY' | 'FAILED'
export type V8PluginStartup = {
  state: V8PluginStartupState
  error: string | null
  adapterAvailable: boolean | null
}

type BootstrapBridge = Pick<JCVitalV8Plugin, 'initialize' | 'isAvailable'>
const unavailable: V8PluginStartup = { state: 'UNAVAILABLE', error: null, adapterAvailable: null }

export class V8PluginBootstrap {
  private snapshot: V8PluginStartup = unavailable
  private pending: Promise<void> | null = null
  private readonly listeners = new Set<() => void>()
  private readonly bridge: BootstrapBridge
  private readonly nativeAvailable: () => boolean

  constructor(bridge: BootstrapBridge, nativeAvailable: () => boolean) {
    this.bridge = bridge
    this.nativeAvailable = nativeAvailable
  }

  getSnapshot = () => this.snapshot
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private publish(state: V8PluginStartupState, error: string | null = null, adapterAvailable: boolean | null = null) {
    this.snapshot = { state, error, adapterAvailable }
    this.listeners.forEach((listener) => listener())
  }

  ensureReady(): Promise<void> {
    if (this.snapshot.state === 'READY') return Promise.resolve()
    if (this.pending) return this.pending
    this.publish('REGISTERING')
    this.pending = this.initialize().finally(() => { this.pending = null })
    return this.pending
  }

  private async initialize(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      if (!this.nativeAvailable()) {
        const message = 'JCVitalV8 is not registered with the native Capacitor bridge.'
        this.publish('UNAVAILABLE', message)
        throw new Error(message)
      }
      this.publish('INITIALIZING')
      const result = await Promise.race([
        (async () => {
          const ack = await this.bridge.initialize()
          if (ack.initialized !== true || ack.pluginName !== 'JCVitalV8') {
            throw new Error('Invalid JCVitalV8 initialization ACK.')
          }
          return this.bridge.isAvailable()
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('JCVitalV8 initialization ACK timed out.')), 10000)
        }),
      ])
      this.publish('READY', null, result.available)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (this.snapshot.state !== 'UNAVAILABLE') this.publish('FAILED', message)
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
}

export const v8PluginBootstrap = new V8PluginBootstrap(
  JCVitalV8,
  () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('JCVitalV8'),
)

const BootstrapContext = createContext<V8PluginStartup>(unavailable)

type V8JournalBinding = { scope: SourceJournalScope; device: JCVitalV8Device; info: JCVitalV8DeviceInfo }
const JournalBindingContext = createContext<{
  authenticatedOwner: string | null
  binding: V8JournalBinding | null
  setBinding: (binding: V8JournalBinding | null) => void
} | null>(null)

export function V8BootstrapProvider({ authenticated, ownerUserId, children }: { authenticated: boolean; ownerUserId: string; children: ReactNode }) {
  const startup = useSyncExternalStore(v8PluginBootstrap.subscribe, v8PluginBootstrap.getSnapshot, v8PluginBootstrap.getSnapshot)
  const [binding, setBinding] = useState<V8JournalBinding | null>(null)
  const updateBinding = useCallback((next: V8JournalBinding | null) => {
    if (next && (!authenticated || !ownerUserId.trim() || next.scope.accountId !== ownerUserId)) {
      throw new Error('OWNER_SCOPE_MISMATCH')
    }
    setBinding(next)
  }, [authenticated, ownerUserId])
  useEffect(() => {
    if (!authenticated) return
    void v8PluginBootstrap.ensureReady().catch((error: unknown) => {
      crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'V8 native plugin initialization')
    })
  }, [authenticated])
  // The authenticated session owns the binding, not a Companion/Engineering screen mount.
  useEffect(() => {
    if (startup.state !== 'READY') return
    setBinding(null)
    void JCVitalV8.configureSourceJournal({ enabled: false }).catch((error: unknown) => {
      crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Source journal initialization')
    })
    return () => {
      void JCVitalV8.configureSourceJournal({ enabled: false }).catch((error: unknown) => {
        crashBreadcrumbs.recordError('lastUnhandledJsError', error, 'Source journal cleanup')
      })
    }
  }, [authenticated, ownerUserId, startup.state])
  return <BootstrapContext.Provider value={authenticated ? startup : unavailable}>
    <JournalBindingContext.Provider value={{
      authenticatedOwner: authenticated ? ownerUserId : null,
      binding,
      setBinding: updateBinding,
    }}>{children}</JournalBindingContext.Provider>
  </BootstrapContext.Provider>
}

export const useV8PluginStartup = () => useContext(BootstrapContext)
export function useV8JournalBinding() {
  const value = useContext(JournalBindingContext)
  if (!value) throw new Error('V8 authenticated session provider is required.')
  return value
}
