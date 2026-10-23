export interface PpiAttemptEvent {
  stage: string
  status: 'STARTED' | 'PASSED' | 'FAILED' | 'INFO'
  details: unknown
  error: { code: string | null; name: string; message: string; stack: string | null } | null
  at: string
}

export interface PpiAttemptRecord {
  version: 1
  attemptId: string
  accountId: string | null
  deviceScopeId: string | null
  storageKey: string | null
  startedAt: string
  completedAt: string | null
  certificationSuccess: false
  outcome: string
  events: PpiAttemptEvent[]
  diagnosticPersistence: {
    saved: boolean
    readBack: boolean
    error: string | null
    failureStage?: string
    exception?: NonNullable<PpiAttemptEvent['error']>
  }
}

export function ppiAttemptKey(owner: string, device: string): string {
  return `elitePlus.ppiCertificationAttempt.v1.${encodeURIComponent(owner)}.${encodeURIComponent(device)}`
}

export function attemptError(error: unknown): NonNullable<PpiAttemptEvent['error']> {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null
  return {
    code: code == null ? null : String(code),
    name: error instanceof Error ? error.name : typeof error,
    message: error instanceof Error ? error.message
      : error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error),
    stack: error instanceof Error ? error.stack ?? null : null,
  }
}

/** Diagnostic persistence never authorizes capture or changes the certification outcome. */
export class PpiCertificationAttempt {
  private record: PpiAttemptRecord | null = null
  private readonly storage: () => Pick<Storage, 'getItem' | 'setItem'>
  private readonly publish: (record: PpiAttemptRecord) => void
  constructor(
    storage: () => Pick<Storage, 'getItem' | 'setItem'>,
    publish: (record: PpiAttemptRecord) => void = () => {},
  ) {
    this.storage = storage
    this.publish = publish
  }

  start(accountId: string | null, deviceScopeId: string | null, physicalState: unknown): void {
    this.record = {
      version: 1, attemptId: crypto.randomUUID(), accountId, deviceScopeId,
      storageKey: accountId && deviceScopeId ? ppiAttemptKey(accountId, deviceScopeId) : null,
      startedAt: new Date().toISOString(), completedAt: null,
      certificationSuccess: false, outcome: 'IN_PROGRESS', events: [],
      diagnosticPersistence: { saved: false, readBack: false, error: null },
    }
    this.event('BUTTON_INVOKED', 'INFO', physicalState)
  }

  event(stage: string, status: PpiAttemptEvent['status'], details: unknown = null, error?: unknown): void {
    if (!this.record || this.record.completedAt) return
    this.record.events.push({ stage, status, details: structuredClone(details),
      error: error === undefined ? null : attemptError(error), at: new Date().toISOString() })
    this.persist()
  }

  finish(outcome: string): void {
    if (!this.record) return
    this.record.outcome = outcome
    this.record.completedAt = new Date().toISOString()
    this.persist()
  }

  private persist(): void {
    const record = this.record!
    record.diagnosticPersistence = { saved: false, readBack: false, error: null }
    let stage = 'DIAGNOSTIC_SCOPE'
    let saved = false
    try {
      if (!record.storageKey) throw new Error('ATTEMPT_SCOPE_UNAVAILABLE: accountId/deviceScopeId unavailable; diagnostic remains in memory.')
      record.diagnosticPersistence = { saved: true, readBack: true, error: null }
      stage = 'DIAGNOSTIC_SERIALIZATION'
      const text = JSON.stringify(record)
      stage = 'DIAGNOSTIC_SAVE'
      this.storage().setItem(record.storageKey, text)
      saved = true
      stage = 'DIAGNOSTIC_READ_BACK'
      if (this.storage().getItem(record.storageKey) !== text) throw new Error('ATTEMPT_READ_BACK_MISMATCH')
    } catch (error) {
      const exception = attemptError(error)
      record.diagnosticPersistence = { saved, readBack: false, error: exception.message, failureStage: stage, exception }
    }
    this.publish(structuredClone(record))
  }

  read(owner: string, device: string): PpiAttemptRecord {
    const key = ppiAttemptKey(owner, device)
    const text = this.storage().getItem(key)
    if (!text) throw new Error('NO_PPI_CERTIFICATION_ATTEMPT_AVAILABLE')
    const record: PpiAttemptRecord = JSON.parse(text)
    if (record.version !== 1 || record.accountId !== owner || record.deviceScopeId !== device
      || record.storageKey !== key || record.certificationSuccess !== false || !Array.isArray(record.events)) {
      throw new Error('PPI_ATTEMPT_SCOPE_OR_KEY_MISMATCH')
    }
    return record
  }
}
