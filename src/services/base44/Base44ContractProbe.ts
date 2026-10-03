import { connectorObservationService } from './ConnectorObservationService'
import type { ConnectorRequestMetadata, ConnectorResponseMetadata } from './Base44Client'
import { BASE44_PRODUCTION_ENVIRONMENT, getBackendEnvironmentDiagnostics } from './base44Environment'
import { ConnectorServiceError, type ConnectorObservationsRequest, type ConnectorObservationsResponse } from './base44Types'

export const BASE44_CONTRACT_PROBE_VALUE = 1_000_000
export const BASE44_CONTRACT_PROBE_CONTRACT = 'native-observations-results-v1'
export const BASE44_CONTRACT_PROBE_REVISION = 'nc-observations-5b1-results-2026-10-03-r4'

export interface Base44ContractProbeResult {
  generatedAt: string
  observationId: string
  resolvedRequestUrl: string
  resolvedHost: string
  configuredAppId: string
  httpStatus: number | null
  topLevelResponseKeys: string[]
  responseContractVersion: string | null
  deploymentRevision: string | null
  transportHasResults: boolean
  transportResultCount: number | null
  responseHasResults: boolean
  responseResultCount: number | null
  accepted: number | null
  duplicate: number | null
  rejected: number | null
  firstResult: {
    observationId: string | null
    status: string | null
    canonicalStatus: string | null
    reason: string | null
    errorCode: string | null
    hasNativeObservationId: boolean
  } | null
  safeRequestTraceId: ConnectorResponseMetadata['safeRequestTraceId']
  requestErrorCode: string | null
  passed: boolean
  failures: string[]
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}

function stringValue(value: unknown, maxLength = 500): string | null {
  return typeof value === 'string' ? value.slice(0, maxLength) : null
}

function numberValue(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function resultSummary(value: unknown): Base44ContractProbeResult['firstResult'] {
  const result = recordOf(value)
  if (!result) return null
  const nativeObservationId = stringValue(result.nativeObservationId)
  return {
    observationId: stringValue(result.observationId),
    status: stringValue(result.status, 80),
    canonicalStatus: stringValue(result.canonicalStatus, 80),
    reason: stringValue(result.reason),
    errorCode: stringValue(result.errorCode, 120),
    hasNativeObservationId: Boolean(nativeObservationId),
  }
}

function expectedFailures(result: Omit<Base44ContractProbeResult, 'passed' | 'failures'>): string[] {
  const failures: string[] = []
  if (result.resolvedHost !== BASE44_PRODUCTION_ENVIRONMENT.expectedHost) failures.push('resolvedHost mismatch')
  if (result.configuredAppId !== BASE44_PRODUCTION_ENVIRONMENT.appId) failures.push('configuredAppId mismatch')
  if (result.httpStatus !== 200) failures.push('HTTP status was not 200')
  if (result.responseContractVersion !== BASE44_CONTRACT_PROBE_CONTRACT) failures.push('responseContractVersion mismatch or absent')
  if (result.deploymentRevision !== BASE44_CONTRACT_PROBE_REVISION) failures.push('deploymentRevision mismatch or absent')
  if (!result.transportHasResults || result.transportResultCount !== 1) failures.push('transport results[] was not exactly one item')
  if (!result.responseHasResults || result.responseResultCount !== 1) failures.push('response results[] was not exactly one item')
  if (result.accepted !== 0 || result.duplicate !== 0 || result.rejected !== 1) failures.push('expected accepted=0, duplicate=0, rejected=1')
  if (result.firstResult?.observationId !== result.observationId) failures.push('first result observationId did not match the probe')
  if (result.firstResult?.status !== 'rejected') failures.push('probe observation was not rejected')
  if (result.firstResult?.canonicalStatus !== null) failures.push('probe has a canonical status')
  if (result.firstResult?.hasNativeObservationId !== false) failures.push('probe has a nativeObservationId')
  return failures
}

function createProbeRequest(installId: string, connectorDeviceId: string): ConnectorObservationsRequest {
  const now = new Date().toISOString()
  const observationId = `connector_contract_probe_${crypto.randomUUID()}`
  return {
    installId,
    connectorDeviceId,
    batchId: `connector_contract_probe_${crypto.randomUUID()}`,
    observations: [{
      observationId,
      source: 'connector_contract_probe',
      metric: 'heartRate',
      valueNumber: BASE44_CONTRACT_PROBE_VALUE,
      unit: 'bpm',
      startTime: now,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
      capturedAt: now,
      provider: 'ELITE_CONNECTOR_CONTRACT_PROBE',
    }],
  }
}

export async function runBase44ContractProbe(installId: string, connectorDeviceId: string): Promise<Base44ContractProbeResult> {
  const request = createProbeRequest(installId, connectorDeviceId)
  const observationId = request.observations[0].observationId
  const initialEnvironment = getBackendEnvironmentDiagnostics()
  const capture: {
    requestMetadata: ConnectorRequestMetadata
    responseMetadata: ConnectorResponseMetadata | null
    transportBody: Record<string, unknown> | null
  } = {
    requestMetadata: {
      resolvedRequestUrl: initialEnvironment.resolvedObservationsUrl,
      resolvedHost: initialEnvironment.resolvedHost,
      configuredAppId: initialEnvironment.resolvedAppId,
    },
    responseMetadata: null,
    transportBody: null,
  }
  let response: ConnectorObservationsResponse | null = null
  let requestErrorCode: string | null = null

  try {
    response = await connectorObservationService.submitObservations(request, {
      onRequestMetadata: (metadata) => { capture.requestMetadata = metadata },
      onResponseMetadata: (metadata) => { capture.responseMetadata = metadata },
      onResponseBody: (body) => { capture.transportBody = recordOf(body) },
    })
  } catch (error) {
    requestErrorCode = error instanceof ConnectorServiceError ? error.code : 'SERVER_ERROR'
  }

  const transportResults = capture.transportBody?.results
  const responseResults = Array.isArray(response?.results) ? response.results : null
  const rawFirstResult = Array.isArray(transportResults) ? transportResults[0] : undefined
  const firstResult = resultSummary(rawFirstResult ?? responseResults?.[0])
  const baseResult = {
    generatedAt: new Date().toISOString(),
    observationId,
    resolvedRequestUrl: capture.requestMetadata.resolvedRequestUrl,
    resolvedHost: capture.requestMetadata.resolvedHost,
    configuredAppId: capture.requestMetadata.configuredAppId,
    httpStatus: capture.responseMetadata?.httpStatus ?? null,
    topLevelResponseKeys: capture.transportBody ? Object.keys(capture.transportBody).slice(0, 40) : [],
    responseContractVersion: stringValue(capture.transportBody?.responseContractVersion, 120),
    deploymentRevision: stringValue(capture.transportBody?.deploymentRevision, 160),
    transportHasResults: Array.isArray(transportResults),
    transportResultCount: Array.isArray(transportResults) ? transportResults.length : null,
    responseHasResults: responseResults !== null,
    responseResultCount: responseResults?.length ?? null,
    accepted: numberValue(capture.transportBody?.accepted ?? response?.accepted),
    duplicate: numberValue(capture.transportBody?.duplicate ?? response?.duplicate),
    rejected: numberValue(capture.transportBody?.rejected ?? response?.rejected),
    firstResult,
    safeRequestTraceId: capture.responseMetadata?.safeRequestTraceId ?? null,
    requestErrorCode,
  }
  const failures = expectedFailures(baseResult)
  if (requestErrorCode) failures.push(`request failed (${requestErrorCode})`)

  return { ...baseResult, passed: failures.length === 0, failures }
}
