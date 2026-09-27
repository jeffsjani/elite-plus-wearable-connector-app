import { Base44Error, createClient, getAccessToken } from '@base44/sdk'
import type { Base44Client } from '@base44/sdk'
import {
  ConnectorServiceError,
  type ConnectorErrorCode,
} from './base44Types'

const appId = import.meta.env.VITE_BASE44_APP_ID ?? ''
const functionBaseUrl = import.meta.env.VITE_BASE44_FUNCTION_BASE_URL ?? ''
const normalizedFunctionBaseUrl = functionBaseUrl.replace(/\/+$/, '')
const serverUrl = normalizedFunctionBaseUrl.replace(/\/functions$/, '')

export const base44: Base44Client = createClient({
  appId,
  serverUrl: serverUrl || undefined,
  appBaseUrl: serverUrl || undefined,
  analytics: { enabled: false },
})

function getConfiguredFunctionUrl(functionName: string): string {
  if (!appId || !normalizedFunctionBaseUrl) {
    throw new ConnectorServiceError(
      'SERVER_ERROR',
      'Base44 client configuration is missing.',
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
    return new ConnectorServiceError('NETWORK_ERROR', 'Unable to reach Base44.')
  }

  return new ConnectorServiceError('SERVER_ERROR', 'Base44 request failed.')
}

export async function invokeConnectorFunction<T>(
  functionName: string,
  payload: object,
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
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    })
  } catch {
    throw new ConnectorServiceError('NETWORK_ERROR', 'Unable to reach Base44.')
  }

  let responseBody: unknown

  try {
    responseBody = await response.json()
  } catch {
    throw new ConnectorServiceError(
      response.ok ? 'INVALID_RESPONSE' : getErrorCode(response.status),
      'Base44 returned an invalid response.',
      response.status,
    )
  }

  if (!response.ok) {
    const message =
      typeof responseBody === 'object' && responseBody !== null && 'message' in responseBody
        ? String(responseBody.message)
        : 'Base44 rejected the request.'
    throw new ConnectorServiceError(getErrorCode(response.status), message, response.status)
  }

  return responseBody as T
}

export function logConnectorError(functionName: string, error: unknown, batchId?: string): void {
  const mappedError = mapBase44Error(error)
  console.error('Base44 connector request failed', {
    functionName,
    batchId,
    status: mappedError.status,
    code: mappedError.code,
  })
}