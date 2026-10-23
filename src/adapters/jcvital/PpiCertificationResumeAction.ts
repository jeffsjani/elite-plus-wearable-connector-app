import { CertificationExportError } from './CertificationJsonExport'
import { PPI_CERTIFICATION_SUCCESS, type PpiCertificationInspection } from './PpiCertification'
import { ppiSnapshotSavedStatus, readPpiCertificationJson, type PpiCertificationJson } from './PpiCertificationJson'
import type { PpiCertificationResume, PpiResumeOperationCounts } from './PpiCertificationResume'
import type { Type42ConnectedContext } from './Type42Certification'

export const PPI_RESUME_BUTTON_LABEL = 'Resume PPI Certification From Last Physical Attempt'

export type PpiResumeUiStage =
  | 'OWNER_CHECK' | 'SOURCE_SCOPE_CHECK' | 'LAST_ATTEMPT_READ' | 'RESUME_PIPELINE'
  | 'ZERO_ACQUISITION_CHECK' | 'SNAPSHOT_VERIFY' | 'CERTIFICATION_JSON_READ'

export interface PpiResumeUiDependencies {
  ownerUserId(): string | null
  /** The live connected physical V8 context, or null when no source-journal scope is established. */
  connectedContext(): Type42ConnectedContext | null
  /** Builds the existing VC15 resume service; the returned instance must report engine stages to `onEngineStage`. */
  createResume(onEngineStage: (stage: string, status: string, error?: unknown) => void): PpiCertificationResume
}

export interface PpiResumeUiSuccess {
  ok: true
  inspection: PpiCertificationInspection
  snapshotKey: string
  snapshotStatus: string
  json: PpiCertificationJson
  counts: PpiResumeOperationCounts
}

export interface PpiResumeUiFailure {
  ok: false
  stage: PpiResumeUiStage
  engineStage: string | null
  code: string
  message: string
  counts: PpiResumeOperationCounts | null
  inspection: PpiCertificationInspection | null
}

export type PpiResumeUiResult = PpiResumeUiSuccess | PpiResumeUiFailure

function errorCode(error: unknown, fallback: string): string {
  if (error instanceof CertificationExportError) return error.stage
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === 'string' && code) return code
  const message = error instanceof Error ? error.message : String(error)
  return /^[A-Z][A-Z0-9_]+$/.test(message) ? message : fallback
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * UI orchestration for the "Resume PPI Certification From Last Physical Attempt" button. It only gates on the
 * authenticated owner and connected physical source-journal scope, then delegates entirely to the unchanged
 * VC15 `PpiCertificationResume`. It never acquires, never calls `syncHistoricalPpi()`, and never falls back to
 * a physical capture on failure.
 */
export async function runPpiCertificationResume(deps: PpiResumeUiDependencies): Promise<PpiResumeUiResult> {
  let engineStage: string | null = null
  let engineFailure: { stage: string; error: unknown } | null = null
  let counts: PpiResumeOperationCounts | null = null
  const fail = (stage: PpiResumeUiStage, code: string, message: string,
    inspection: PpiCertificationInspection | null = null): PpiResumeUiFailure =>
    ({ ok: false, stage, engineStage, code, message, counts, inspection })

  const owner = deps.ownerUserId()
  if (!owner) return fail('OWNER_CHECK', 'PPI_RESUME_OWNER_REQUIRED', 'Sign in as the authenticated owner before resuming.')

  const context = deps.connectedContext()
  if (!context) {
    return fail('SOURCE_SCOPE_CHECK', 'PPI_RESUME_SOURCE_SCOPE_REQUIRED',
      'Connect the same authenticated physical V8 to establish its source-journal scope.')
  }
  if (context.scope.accountId !== owner) {
    return fail('SOURCE_SCOPE_CHECK', 'PPI_RESUME_OWNER_SCOPE_MISMATCH',
      'Connected source-journal scope belongs to a different owner.')
  }
  if (!context.physical || !context.native || !context.ready) {
    return fail('SOURCE_SCOPE_CHECK', 'PPI_RESUME_PHYSICAL_V8_REQUIRED',
      'Resume requires the connected, ready, native physical V8.')
  }

  const resume = deps.createResume((stage, status, error) => {
    engineStage = stage
    if (status === 'FAILED' && !engineFailure) engineFailure = { stage, error }
  })

  try {
    resume.readLastAttempt(owner, context.scope.deviceScopeId)
  } catch (error) {
    counts = resume.operationCounts()
    return fail('LAST_ATTEMPT_READ', errorCode(error, 'PPI_RESUME_LAST_ATTEMPT_UNAVAILABLE'), errorMessage(error))
  }

  let inspection: PpiCertificationInspection
  try {
    inspection = await resume.resume()
  } catch (error) {
    counts = resume.operationCounts()
    const failure = engineFailure as { stage: string; error: unknown } | null
    if (failure) engineStage = failure.stage
    return fail('RESUME_PIPELINE', errorCode(error, 'PPI_RESUME_FAILED'), errorMessage(error))
  }
  counts = resume.operationCounts()

  if (counts.syncHistoricalPpiCalls !== 0 || counts.bleHistoryAcquisitions !== 0) {
    return fail('ZERO_ACQUISITION_CHECK', 'PPI_RESUME_ACQUISITION_DETECTED',
      `Resume must not acquire: syncHistoricalPpi=${counts.syncHistoricalPpiCalls}, BLE=${counts.bleHistoryAcquisitions}.`, inspection)
  }
  if (inspection.status !== PPI_CERTIFICATION_SUCCESS || !inspection.group) {
    return fail('RESUME_PIPELINE', inspection.status, inspection.reason ?? 'Resume did not reach certification success.', inspection)
  }

  let snapshotKey: string
  try {
    snapshotKey = resume.service.verifySnapshotPersisted(inspection.group)
  } catch (error) {
    return fail('SNAPSHOT_VERIFY', errorCode(error, 'PPI_RESUME_SNAPSHOT_NOT_PERSISTED'), errorMessage(error), inspection)
  }

  let json: PpiCertificationJson
  try {
    json = await readPpiCertificationJson(resume.service, inspection)
  } catch (error) {
    return fail('CERTIFICATION_JSON_READ', errorCode(error, 'PPI_RESUME_JSON_UNAVAILABLE'), errorMessage(error), inspection)
  }

  return {
    ok: true, inspection, snapshotKey, json, counts,
    snapshotStatus: ppiSnapshotSavedStatus(inspection, snapshotKey, true),
  }
}

export function ppiResumeFailureText(failure: PpiResumeUiFailure): string {
  return `PPI RESUME FAILED · stage: ${failure.stage}${failure.engineStage ? ` (engine: ${failure.engineStage})` : ''}`
    + ` · code: ${failure.code} · message: ${failure.message}. No physical recapture was attempted.`
}
