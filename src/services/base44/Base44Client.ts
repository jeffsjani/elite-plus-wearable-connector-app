import { Base44Error, createClient, getAccessToken } from '@base44/sdk'
import type { Base44Client } from '@base44/sdk'
import { physicalTestSideEffect } from '../diagnostics/PhysicalTestIsolation'
import {
  ConnectorServiceError,
  type ConnectorErrorCode,
} from './base44Types'
import {
  BASE44_PRODUCTION_ENVIRONMENT,
  getBackendEnvironmentDiagnostics,
  resolveConnectorFunctionUrl,
} from './base44Environment'

const { appId, serverUrl, appBaseUrl } = BASE44_PRODUCTION_ENVIRONMENT

export const base44: Base44Client = createClient({
  appId,
  serverUrl,
  appBaseUrl,
  analytics: { enabled: false },
})

function getConfiguredFunctionUrl(functionName: string): string {
  const environment = getBackendEnvironmentDiagnostics()
  if (!environment.environmentMatch) {
    throw new ConnectorServiceError('SERVER_ERROR', 'BACKEND ENVIRONMENT MISMATCH')
  }

  return resolveConnectorFunctionUrl(functionName)
}

function getErrorCode(status: number | undefined): ConnectorErrorCode {
  if (status === 401) return 'AUTH_REQUIRED'
  if (status === 403) return 'FORBIDDEN'
  if (status !== undefined && status >= 500) return 'SERVER_ERROR'
  return 'INVALID_RESPONSE'
}

export function mapBase44Error(error: unknown): ConnectorServiceError {
  if (error instanceof ConnectorServiceError) {
    return error
  }

  if (error instanceof Base44Error) {
    const code = getErrorCode(error.status)
    return new ConnectorServiceError(code, error.message, error.status)
  }

  if (error instanceof TypeError) {
    return new ConnectorServiceError('NETWORK_ERROR', 'Unable to reach the connector service.')
  }

  return new ConnectorServiceError('SERVER_ERROR', 'Connector service request failed.')
}

export interface InvokeOptions {
  signal?: AbortSignal
  /** Called as soon as HTTP headers arrive, before the body is read. */
  onHttpResponse?: (status: number) => void
  /** Called with the parsed JSON body exactly as received, before any service-level handling. */
  onResponseBody?: (body: unknown) => void
  onRequestMetadata?: (metadata: ConnectorRequestMetadata) => void
  onResponseMetadata?: (metadata: ConnectorResponseMetadata) => void
}

export interface ConnectorRequestMetadata {
  resolvedRequestUrl: string
  resolvedHost: string
  configuredAppId: string
}

export interface ConnectorResponseMetadata extends ConnectorRequestMetadata {
  httpStatus: number
  safeRequestTraceId: { header: string; value: string } | null
}

const SAFE_TRACE_HEADERS = ['x-request-id', 'request-id', 'x-correlation-id', 'x-trace-id', 'traceparent']

function safeRequestTraceId(headers: Headers): ConnectorResponseMetadata['safeRequestTraceId'] {
  for (const header of SAFE_TRACE_HEADERS) {
    const value = headers.get(header)?.trim()
    if (value && value.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(value)) return { header, value }
  }
  return null
}

function abortedError(): ConnectorServiceError {
  return new ConnectorServiceError('TIMEOUT', 'Connector service request timed out.')
}

export async function invokeConnectorFunction<T>(
  functionName: string,
  payload: object,
  options: InvokeOptions = {},
): Promise<T> {
  return physicalTestSideEffect('base44', () => invokeUnisolatedConnectorFunction<T>(functionName, payload, options))
}

async function invokeUnisolatedConnectorFunction<T>(
  functionName: string,
  payload: object,
  options: InvokeOptions = {},
): Promise<T> {
  const token = getAccessToken()

  if (!token) {
    throw new ConnectorServiceError(
      'AUTH_REQUIRED',
      'Your Elite+ session is required for this action.',
    )
  }

  let response: Response
  const resolvedRequestUrl = getConfiguredFunctionUrl(functionName)
  const requestMetadata: ConnectorRequestMetadata = {
    resolvedRequestUrl,
    resolvedHost: new URL(resolvedRequestUrl).hostname,
    configuredAppId: appId,
  }
  options.onRequestMetadata?.(requestMetadata)

  try {
    response = await fetch(resolvedRequestUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'X-App-Id': appId,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: options.signal,
    })
  } catch {
    if (options.signal?.aborted) throw abortedError()
    throw new ConnectorServiceError('NETWORK_ERROR', 'Unable to reach the connector service.')
  }

  options.onHttpResponse?.(response.status)
  options.onResponseMetadata?.({ ...requestMetadata, httpStatus: response.status, safeRequestTraceId: safeRequestTraceId(response.headers) })
  let responseBody: unknown

  try {
    responseBody = await response.json()
  } catch {
    if (options.signal?.aborted) throw new ConnectorServiceError('TIMEOUT', 'Connector service response body timed out.', response.status)
    throw new ConnectorServiceError(
      response.ok ? 'INVALID_RESPONSE' : getErrorCode(response.status),
      'Connector service returned an invalid response.',
      response.status,
    )
  }

  options.onResponseBody?.(responseBody)

  if (!response.ok) {
    const message =
      typeof responseBody === 'object' && responseBody !== null
        ? 'message' in responseBody
          ? String(responseBody.message)
          : 'error' in responseBody
            ? String(responseBody.error)
            : 'detail' in responseBody
              ? String(responseBody.detail)
              : 'Connector service rejected the request.'
        : 'Connector service rejected the request.'
    throw new ConnectorServiceError(getErrorCode(response.status), message, response.status)
  }

  return responseBody as T
}

export function logConnectorError(functionName: string, error: unknown, batchId?: string): void {
  const mappedError = mapBase44Error(error)
  console.error('Connector service request failed', {
    functionName,
    batchId,
    status: mappedError.status,
    code: mappedError.code,
  })
}