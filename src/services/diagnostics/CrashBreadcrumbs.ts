export type BreadcrumbDetail = Record<string, string | number | boolean | null>

export interface Breadcrumb {
  stage: string
  at: string
  detail?: BreadcrumbDetail
}

export interface BreadcrumbError {
  at: string
  message: string
  context?: string
}

export interface BreadcrumbSession {
  sessionStartedAt: string
  trail: Breadcrumb[]
  lastSuccessStage: string | null
  lastHistoricalDeliveryError: BreadcrumbError | null
  lastUnhandledJsError: BreadcrumbError | null
  lastUnhandledPromiseRejection: BreadcrumbError | null
}

export interface BreadcrumbState {
  current: BreadcrumbSession
  /** The session before this launch; survives a crash/restart. */
  previous: BreadcrumbSession | null
}

const STORAGE_KEY = 'elitePlus.crashBreadcrumbs.v1'
const MAX_TRAIL = 40
const MAX_TEXT = 300

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem'>

function emptySession(): BreadcrumbSession {
  return { sessionStartedAt: new Date().toISOString(), trail: [], lastSuccessStage: null, lastHistoricalDeliveryError: null, lastUnhandledJsError: null, lastUnhandledPromiseRejection: null }
}

function text(value: unknown): string {
  const raw = value instanceof Error ? `${value.name}: ${value.message}` : typeof value === 'string' ? value : (() => { try { return JSON.stringify(value) ?? String(value) } catch { return String(value) } })()
  return raw.length > MAX_TEXT ? `${raw.slice(0, MAX_TEXT)}…` : raw
}

/** Non-standard Chromium/WebView heap counter; null elsewhere. */
export function jsHeapUsedMb(): number | null {
  const memory = (globalThis.performance as (Performance & { memory?: { usedJSHeapSize?: number } }) | undefined)?.memory
  return typeof memory?.usedJSHeapSize === 'number' ? Math.round(memory.usedJSHeapSize / 1_048_576) : null
}

/** Small, synchronous, localStorage-persisted stage trail that survives a WebView/app crash. */
export class CrashBreadcrumbs {
  private readonly storage: () => KeyValueStorage
  private state: BreadcrumbState

  constructor(storage: () => KeyValueStorage = () => localStorage) {
    this.storage = storage
    this.state = { current: emptySession(), previous: this.read()?.current ?? null }
  }

  private read(): BreadcrumbState | null {
    try {
      const parsed = JSON.parse(this.storage().getItem(STORAGE_KEY) ?? 'null') as BreadcrumbState | null
      return parsed && typeof parsed === 'object' && parsed.current ? parsed : null
    } catch {
      return null
    }
  }

  private persist(): void {
    try { this.storage().setItem(STORAGE_KEY, JSON.stringify(this.state)) } catch { /* breadcrumbs must never break the app */ }
  }

  /** Call once per app launch: the persisted session becomes `previous`. */
  startSession(): void {
    this.state = { current: emptySession(), previous: this.read()?.current ?? null }
    this.persist()
  }

  record(stage: string, detail?: BreadcrumbDetail): void {
    const heap = jsHeapUsedMb()
    const entry: Breadcrumb = { stage, at: new Date().toISOString(), ...(detail || heap !== null ? { detail: { ...detail, ...(heap !== null ? { jsHeapUsedMb: heap } : {}) } } : {}) }
    const trail = [...this.state.current.trail, entry]
    this.state.current = { ...this.state.current, trail: trail.slice(-MAX_TRAIL), lastSuccessStage: stage }
    this.persist()
  }

  recordError(kind: 'lastHistoricalDeliveryError' | 'lastUnhandledJsError' | 'lastUnhandledPromiseRejection', error: unknown, context?: string): void {
    this.state.current = { ...this.state.current, [kind]: { at: new Date().toISOString(), message: text(error), ...(context ? { context } : {}) } }
    this.persist()
  }

  getState(): BreadcrumbState { return this.state }
}

export const crashBreadcrumbs = new CrashBreadcrumbs()

export function installGlobalCrashHandlers(target: Pick<Window, 'addEventListener'> = window, breadcrumbs = crashBreadcrumbs): void {
  target.addEventListener('error', (event) => breadcrumbs.recordError('lastUnhandledJsError', (event as ErrorEvent).error ?? (event as ErrorEvent).message, (event as ErrorEvent).filename || undefined))
  target.addEventListener('unhandledrejection', (event) => breadcrumbs.recordError('lastUnhandledPromiseRejection', (event as PromiseRejectionEvent).reason))
}
