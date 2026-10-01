import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@base44/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@base44/sdk')>()),
  getAccessToken: () => 'test-token',
}))

async function loadClient() {
  vi.resetModules()
  vi.stubEnv('VITE_BASE44_APP_ID', 'app-test')
  vi.stubEnv('VITE_BASE44_FUNCTION_BASE_URL', 'https://example.invalid/functions')
  return import('./Base44Client')
}

describe('invokeConnectorFunction', () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

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
})
