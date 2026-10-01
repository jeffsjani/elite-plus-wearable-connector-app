import { Base44Error, createClient, getAccessToken } from '@base44/sdk'
import type { Base44Client } from '@base44/sdk'
import {
  ConnectorServiceError,
  type ConnectorErrorCode,
} from './base44Types'

const appId = import.meta.env.VITE_BASE44_APP_ID ?? ''
const configuredServerUrl = import.meta.env.VITE_BASE44_SERVER_URL ?? ''
const configuredAppBaseUrl = import.meta.env.VITE_BASE44_APP_BASE_URL ?? ''
const functionBaseUrl = import.meta.env.VITE_BASE44_FUNCTION_BASE_URL ?? ''
const normalizedFunctionBaseUrl = functionBaseUrl.replace(/\/+$/, '')
const serverUrl = configuredServerUrl || normalizedFunctionBaseUrl.replace(/\/functions$/, '')

export const base44: Base44Client = createClient({
  appId,
  serverUrl: serverUrl || undefined,
  appBaseUrl: configuredAppBaseUrl || serverUrl || undefined,
  analytics: { enabled: false },
})

function getConfiguredFunctionUrl(functionName: string): string {
  if (!appId || !normalizedFunctionBaseUrl) {
    throw new ConnectorServiceError(
      'SERVER_ERROR',
      'Connector service configuration is missing.',
    )
  }

  return `${normalizedFunctionBaseUrl}/${functionName}`
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
}

function abortedError(): ConnectorServiceError {
  return new ConnectorServiceError('TIMEOUT', 'Connector service request timed out.')
}

export async function invokeConnectorFunction<T>(
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

  try {
    response = await fetch(getConfiguredFunctionUrl(functionName), {
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