import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { ActivityV2DiagnosticReportStore } from './ActivityV2DiagnosticReportStore'

describe('ActivityV2DiagnosticReportStore', () => {
  it('persists and reloads diagnostic reports separately by key', async () => {
    const store = new ActivityV2DiagnosticReportStore()
    const key = `test:${crypto.randomUUID()}`
    const report = JSON.stringify({ previewStatus: 'PASS', expectedObservationCount: 14 })

    expect(await store.load(key)).toBeNull()
    await store.save(key, report)
    expect(await store.load(key)).toBe(report)
    expect(await store.load(`${key}:other-scope`)).toBeNull()
  })
})
