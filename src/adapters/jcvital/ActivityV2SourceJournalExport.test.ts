import { describe, expect, it, vi } from 'vitest'
import type { SourceJournalPage } from './jcvitalV8Bridge'
import { savedActivityEnvelopes } from './ActivityV2SourceJournalExport'

const scope = { accountId: 'owner-1', deviceScopeId: 'device-1' }

function record(sequence: number) {
  const envelopeId = `source-${sequence}`
  return {
    sequence,
    envelopeId,
    callbackId: null,
    recordIndex: null,
    kind: 'SDK_RECORD',
    receivedAt: '2026-10-24T12:00:00.000Z',
    timezone: 'UTC',
    envelopeJson: JSON.stringify({
      kind: 'SDK_RECORD',
      envelopeId,
      vendorDataType: '24',
      acquisitionMode: 'HISTORICAL_SYNC',
    }),
    rawBytesBase64: null,
  }
}

function page(envelopes: SourceJournalPage['envelopes'], nextSequence: number, hasMore: boolean): SourceJournalPage {
  return { modelVersion: 'L0', envelopes, nextSequence, hasMore }
}

describe('Activity V2 generic source-journal pagination', () => {
  it('forwards the exclusive cursor and consumes ordered pages', async () => {
    const rows = Array.from({ length: 250 }, (_, index) => record(index + 1))
    const requests: Array<{ afterSequence?: number; limit?: number }> = []
    const exportPage = vi.fn(async (request: typeof requests[number]) => {
      requests.push(request)
      const remaining = rows.filter((entry) => entry.sequence > (request.afterSequence ?? 0))
      const envelopes = remaining.slice(0, request.limit)
      return page(envelopes, envelopes.at(-1)?.sequence ?? request.afterSequence ?? 0, remaining.length > envelopes.length)
    })

    const result = await savedActivityEnvelopes(scope, exportPage)

    expect(requests).toEqual([
      { ...scope, afterSequence: 0, limit: 100 },
      { ...scope, afterSequence: 100, limit: 100 },
      { ...scope, afterSequence: 200, limit: 100 },
    ])
    expect(result).toHaveLength(250)
  })

  it('rejects duplicate pages and unordered rows', async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => record(index + 1))
    const duplicatePage = vi.fn()
      .mockResolvedValueOnce(page(firstPage, 100, true))
      .mockResolvedValueOnce(page(firstPage, 100, true))
    await expect(savedActivityEnvelopes(scope, duplicatePage))
      .rejects.toThrow('Saved Activity source journal returned duplicate or unordered records.')

    await expect(savedActivityEnvelopes(scope, async () => page([record(2), record(1)], 1, false)))
      .rejects.toThrow('Saved Activity source journal returned duplicate or unordered records.')
  })

  it('accepts hasMore=false as terminal without cursor advance', async () => {
    const exportPage = vi.fn()
      .mockResolvedValueOnce(page([record(1), record(2)], 2, true))
      .mockResolvedValueOnce(page([], 2, false))
    await expect(savedActivityEnvelopes(scope, exportPage)).resolves.toHaveLength(2)
  })

  it('fails closed when hasMore=true has an empty non-advancing page', async () => {
    await expect(savedActivityEnvelopes(scope, async () => page([], 0, true)))
      .rejects.toThrow('Saved Activity source journal pagination did not advance.')
  })
})
