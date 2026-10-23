import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@base44/sdk', async (importOriginal) => {
  const original = await importOriginal<typeof import('@base44/sdk')>()
  return { ...original, createClient: vi.fn(original.createClient), getAccessToken: () => 'test-token' }
})

async function loadClient() {
  vi.resetModules()
  vi.stubEnv('VITE_BASE44_APP_ID', 'app-test')
  vi.stubEnv('VITE_BASE44_FUNCTION_BASE_URL', 'https://example.invalid/functions')
  return import('./Base44Client')
}

describe('invokeConnectorFunction', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  it('pins SDK/auth and connector requests to production despite local/staging environment overrides', async () => {
    vi.stubEnv('VITE_BASE44_SERVER_URL', 'http://localhost:8000')
    vi.stubEnv('VITE_BASE44_APP_BASE_URL', 'https://staging.example.invalid')
    const fetch = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
    vi.stubGlobal('fetch', fetch)
    const { invokeConnectorFunction } = await loadClient()
    const { createClient } = await import('@base44/sdk')
    expect(createClient).toHaveBeenLastCalledWith({
      appId: '6a89a92c780c9ffa5ba886bc',
      serverUrl: 'https://base44.app',
      appBaseUrl: 'https://waves-elite-sync.base44.app',
      analytics: { enabled: false },
    })
    for (const name of ['nativeConnectorRegister', 'nativeConnectorObservations']) {
      await invokeConnectorFunction(name, {})
      expect(fetch).toHaveBeenLastCalledWith(`https://waves-elite-sync.base44.app/functions/${name}`, expect.any(Object))
    }
  })

  it('maps an aborted hung fetch to TIMEOUT', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) => new Promise((_, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    }))
    const { invokeConnectorFunction } = await loadClient()
    const controller = new AbortController()

    const request = invokeConnectorFunction('nativeConnectorObservations', {}, { signal: controller.signal })
    controller.abort()

    await expect(request).rejects.toMatchObject({ code: 'TIMEOUT' })
  })

  it('reports the HTTP status before the body is parsed', async () => {
    const body = { success: true, batchId: 'b', accepted: 100, duplicate: 0, rejected: 0, errors: [], serverTimestamp: 'now' }
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify(body), { status: 200 }))
    const { invokeConnectorFunction } = await loadClient()
    const statuses: number[] = []

    const result = await invokeConnectorFunction('nativeConnectorObservations', {}, { onHttpResponse: (status) => statuses.push(status) })

    expect(statuses).toEqual([200])
    expect(result).toEqual(body)
  })

  it('reports the resolved production URL and only allowlisted response trace headers', async () => {
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: {
        'x-request-id': 'request-123',
        'set-cookie': 'session=must-not-be-reported',
        authorization: 'Bearer must-not-be-reported',
      },
    }))
    const { invokeConnectorFunction } = await loadClient()
    const requestMetadata: unknown[] = []
    const responseMetadata: unknown[] = []

    await invokeConnectorFunction('nativeConnectorObservations', {}, {
      onRequestMetadata: (metadata) => requestMetadata.push(metadata),
      onResponseMetadata: (metadata) => responseMetadata.push(metadata),
    })

    expect(requestMetadata).toEqual([{
      resolvedRequestUrl: 'https://waves-elite-sync.base44.app/functions/nativeConnectorObservations',
      resolvedHost: 'waves-elite-sync.base44.app',
      configuredAppId: '6a89a92c780c9ffa5ba886bc',
    }])
    expect(responseMetadata).toEqual([{
      resolvedRequestUrl: 'https://waves-elite-sync.base44.app/functions/nativeConnectorObservations',
      resolvedHost: 'waves-elite-sync.base44.app',
      configuredAppId: '6a89a92c780c9ffa5ba886bc',
      httpStatus: 200,
      safeRequestTraceId: { header: 'x-request-id', value: 'request-123' },
    }])
    expect(JSON.stringify(responseMetadata)).not.toMatch(/must-not-be-reported|cookie|authorization/i)
  })
})
