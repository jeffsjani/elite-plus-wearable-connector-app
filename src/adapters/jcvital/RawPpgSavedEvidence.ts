import type {
  JCVitalV8Plugin,
  RawPpgSavedEvidenceCertification,
  RawPpgSavedEvidenceDiagnostic,
  RawPpgSavedEvidenceInspection,
  RawPpgSavedEvidenceScope,
} from './jcvitalV8Bridge'

/**
 * Offline saved-evidence inspection/export/finalize for Raw PPG. Every function here delegates to
 * native plugin methods that read only from app-private storage (spool file + source journal);
 * none of them issue a BLE command, open a device connection, start a new acquisition, touch the
 * network, or call Base44/enqueue/deliver/canonicalize.
 *
 * VC28: the scope is the persisted authenticated account (+ optional opaque device), never the live
 * capture scope, so inspection works after restart with the V8 disconnected. Native errors keep their
 * exact code/message/exceptionClass and every failure leaves an exportable diagnostic.
 */
type RawPpgSavedEvidencePlugin = Pick<
  JCVitalV8Plugin,
  'inspectSavedRawPpgEvidence' | 'exportSavedRawPpgEvidence' | 'finalizeSavedRawPpgCertification'
  | 'readSavedRawPpgCertification' | 'readSavedRawPpgDiagnostic'
>

export const RAW_PPG_DIAGNOSTIC_FILENAME = 'JCVital Raw PPG saved-evidence diagnostic.json'
export const RAW_PPG_LOCAL_DIAGNOSTIC_KEY = 'jcvitalRawPpgSavedEvidenceDiagnostic.v1'

type DiagnosticStorage = Pick<Storage, 'getItem' | 'setItem'>

function defaultStorage(): DiagnosticStorage | null {
  try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
}

/** A failure that preserves the exact native error code/message/data instead of a generic FAILED. */
export class RawPpgSavedEvidenceError extends Error {
  readonly code: string
  readonly failureStage: string
  readonly exceptionClass: string | null
  readonly data: Record<string, unknown> | null

  constructor(code: string, message: string, failureStage: string, exceptionClass: string | null, data: Record<string, unknown> | null) {
    super(message)
    this.name = 'RawPpgSavedEvidenceError'
    this.code = code
    this.failureStage = failureStage
    this.exceptionClass = exceptionClass
    this.data = data
  }
}

/** Normalizes a Capacitor rejection ({message, code, data}) without dropping the native code. */
export function toRawPpgSavedEvidenceError(error: unknown, failureStage: string): RawPpgSavedEvidenceError {
  if (error instanceof RawPpgSavedEvidenceError) return error
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  const data = (typeof record.data === 'object' && record.data !== null ? record.data : null) as Record<string, unknown> | null
  const nativeCode = typeof record.code === 'string' && record.code ? record.code
    : typeof data?.errorCode === 'string' ? data.errorCode : null
  const message = error instanceof Error ? error.message : typeof record.message === 'string' ? record.message : String(error)
  const exceptionClass = typeof data?.exceptionClass === 'string' ? data.exceptionClass
    : error instanceof Error ? error.name : null
  return new RawPpgSavedEvidenceError(nativeCode ?? 'PPG_INSPECTION_INTERNAL_ERROR', message, failureStage, exceptionClass, data)
}

export class RawPpgSavedEvidenceService {
  private readonly plugin: RawPpgSavedEvidencePlugin
  private readonly scope: () => RawPpgSavedEvidenceScope
  private readonly storage: DiagnosticStorage | null

  constructor(plugin: RawPpgSavedEvidencePlugin, scope: () => RawPpgSavedEvidenceScope, storage: DiagnosticStorage | null = defaultStorage()) {
    this.plugin = plugin
    this.scope = scope
    this.storage = storage
  }

  private resolveScope(): RawPpgSavedEvidenceScope {
    try {
      const { accountId, deviceScopeId } = this.scope()
      return { accountId: accountId || null, ...(deviceScopeId ? { deviceScopeId } : {}) }
    } catch {
      // Native reports PPG_SCOPE_NOT_RESOLVED while still listing the spool directory.
      return { accountId: null }
    }
  }

  private async call<T>(stage: string, action: () => Promise<T>): Promise<T> {
    try {
      return await action()
    } catch (error) {
      const failure = toRawPpgSavedEvidenceError(error, stage)
      this.recordLocalFailure(failure)
      throw failure
    }
  }

  private recordLocalFailure(failure: RawPpgSavedEvidenceError): void {
    const snapshot: RawPpgSavedEvidenceDiagnostic = {
      kind: 'RawPpgSavedEvidenceBridgeFailure',
      generatedAt: new Date().toISOString(),
      status: 'FAILED',
      errorCode: failure.code,
      errorMessage: failure.message,
      failureStage: failure.failureStage,
      exceptionClass: failure.exceptionClass,
      nativeErrorData: failure.data,
      certificationTransition: 'NONE_DIAGNOSTIC_ONLY',
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
      bleCommandsIssued: 0, networkCalls: 0, base44Calls: 0, enqueued: 0, delivered: 0, canonicalized: 0,
    }
    try { this.storage?.setItem(RAW_PPG_LOCAL_DIAGNOSTIC_KEY, JSON.stringify(snapshot)) } catch { /* best effort */ }
  }

  inspectExisting(sessionId?: string): Promise<RawPpgSavedEvidenceInspection> {
    return this.call('BRIDGE_INSPECT', () => this.plugin.inspectSavedRawPpgEvidence({ ...this.resolveScope(), ...(sessionId ? { sessionId } : {}) }))
  }

  exportExisting(sessionId?: string): Promise<RawPpgSavedEvidenceCertification> {
    return this.call('BRIDGE_EXPORT', () => this.plugin.exportSavedRawPpgEvidence({ ...this.resolveScope(), sessionId }))
  }

  finalizeCertification(sessionId?: string): Promise<RawPpgSavedEvidenceCertification> {
    return this.call('BRIDGE_FINALIZE', () => this.plugin.finalizeSavedRawPpgCertification({ ...this.resolveScope(), sessionId }))
  }

  async readFinalizedCertification(): Promise<RawPpgSavedEvidenceCertification | null> {
    const { json } = await this.call('BRIDGE_READ_CERTIFICATION', () => this.plugin.readSavedRawPpgCertification(this.resolveScope()))
    return json ? (JSON.parse(json) as RawPpgSavedEvidenceCertification) : null
  }

  /**
   * Always available: returns the persisted native diagnostic plus the latest TS bridge failure (if any).
   * Never throws; requires no READY state, connected V8, BLE or network.
   */
  async readDiagnostic(): Promise<{ native: RawPpgSavedEvidenceDiagnostic | null; bridgeFailure: RawPpgSavedEvidenceDiagnostic | null; readError: string | null }> {
    let native: RawPpgSavedEvidenceDiagnostic | null = null
    let readError: string | null = null
    try {
      const { json } = await this.plugin.readSavedRawPpgDiagnostic()
      native = json ? (JSON.parse(json) as RawPpgSavedEvidenceDiagnostic) : null
    } catch (error) {
      const failure = toRawPpgSavedEvidenceError(error, 'BRIDGE_READ_DIAGNOSTIC')
      readError = `${failure.code}: ${failure.message}`
    }
    let bridgeFailure: RawPpgSavedEvidenceDiagnostic | null = null
    try {
      const raw = this.storage?.getItem(RAW_PPG_LOCAL_DIAGNOSTIC_KEY)
      bridgeFailure = raw ? (JSON.parse(raw) as RawPpgSavedEvidenceDiagnostic) : null
    } catch { bridgeFailure = null }
    return { native, bridgeFailure, readError }
  }

  async diagnosticJson(): Promise<string> {
    const { native, bridgeFailure, readError } = await this.readDiagnostic()
    return JSON.stringify({
      kind: 'JCVitalRawPpgSavedEvidenceDiagnosticExport',
      exportedAt: new Date().toISOString(),
      nativeDiagnostic: native,
      latestBridgeFailure: bridgeFailure,
      nativeDiagnosticReadError: readError,
      certificationTransition: 'NONE_DIAGNOSTIC_ONLY',
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
    }, null, 2)
  }
}

/** Hard glucose-isolation assertions required to accompany any Raw PPG evidence. */
export const RAW_PPG_GLUCOSE_ISOLATION_KEYS = [
  'RAW_PPG_NOT_GLUCOSE',
  'NO_GLUCOSE_CANONICAL_MAPPING',
  'NO_GLUCOSE_INFERENCE',
  'NO_CGM_SUBSTITUTION',
] as const

export function assertNoGlucoseMapping(evidence: Pick<RawPpgSavedEvidenceCertification, 'glucoseIsolation' | 'unit'>): void {
  for (const key of RAW_PPG_GLUCOSE_ISOLATION_KEYS) {
    if (evidence.glucoseIsolation[key] !== true) {
      throw new Error(`RAW_PPG_GLUCOSE_ISOLATION_VIOLATED: ${key} was not asserted true`)
    }
  }
  if (evidence.unit !== 'UNKNOWN_VENDOR_UNIT') {
    throw new Error('RAW_PPG_UNIT_NOT_AUTHORITATIVE: unit must remain UNKNOWN_VENDOR_UNIT until semantics are confirmed')
  }
}

export function isCertifiedLosslessSource(evidence: RawPpgSavedEvidenceCertification): boolean {
  return evidence.state === 'CERTIFIED'
    && evidence.sourceStatus === 'CERTIFIED_E2E_LOSSLESS_SOURCE'
    && evidence.semanticClassification === 'RESEARCH_NATIVE_ONLY'
    && evidence.canonicalAuthority === 'NONE_UNTIL_SEMANTICS_CONFIRMED'
    && evidence.base44DeliveryRequired === false
}

/** Reconstructs the exact concatenated packet-payload bytes (no length prefixes) for a shareable .bin. */
export function concatenatePacketPayloadsBase64(evidence: Pick<RawPpgSavedEvidenceCertification, 'packets'>): string {
  const ordered = [...evidence.packets].sort((a, b) => a.index - b.index)
  const total = ordered.reduce((sum, packet) => sum + packet.byteLength, 0)
  const buffer = new Uint8Array(total)
  let offset = 0
  for (const packet of ordered) {
    const decoded = atob(packet.base64)
    for (let i = 0; i < decoded.length; i++) buffer[offset + i] = decoded.charCodeAt(i)
    offset += decoded.length
  }
  let binary = ''
  for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i])
  return btoa(binary)
}
