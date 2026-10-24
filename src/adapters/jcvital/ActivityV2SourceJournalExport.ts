import { JCVitalV8, type SourceJournalPage, type SourceJournalScope } from './jcvitalV8Bridge'

export type ActivityV2SourceEnvelope = {
  envelopeId: string
  kind: string
  vendorDataType?: string
  acquisitionMode?: string
  sourceDate?: string | null
  sdkSnapshot?: unknown
}

type SourceJournalExporter = (
  options: SourceJournalScope & { afterSequence: number; limit: number },
) => Promise<SourceJournalPage>

function paginationDiagnostic(
  requestedCursor: number,
  page: { envelopes?: Array<{ sequence?: unknown }>; nextSequence?: unknown; hasMore?: unknown },
): string {
  const records = Array.isArray(page.envelopes) ? page.envelopes : []
  return JSON.stringify({
    requestedCursor,
    returnedRecordCount: records.length,
    firstSequence: records[0]?.sequence ?? null,
    lastSequence: records.at(-1)?.sequence ?? null,
    returnedNextCursor: page.nextSequence ?? null,
    hasMore: page.hasMore ?? null,
  })
}

export async function savedActivityEnvelopes(
  scope: SourceJournalScope,
  exportPage: SourceJournalExporter = (options) => JCVitalV8.exportSourceJournal(options),
): Promise<ActivityV2SourceEnvelope[]> {
  const entries: ActivityV2SourceEnvelope[] = []
  const seenSequences = new Set<number>()
  const seenEnvelopeIds = new Set<string>()
  let afterSequence = 0
  for (let pageNumber = 0; pageNumber < 100; pageNumber++) {
    const page = await exportPage({ ...scope, afterSequence, limit: 100 })
    const diagnostic = paginationDiagnostic(afterSequence, page)
    if (!Array.isArray(page.envelopes) || page.envelopes.length > 100 || typeof page.hasMore !== 'boolean') {
      throw new Error(`Saved Activity source journal returned a malformed page. ${diagnostic}`)
    }
    let previousSequence = afterSequence
    for (const entry of page.envelopes) {
      if (!Number.isSafeInteger(entry.sequence) || entry.sequence <= previousSequence
        || !entry.envelopeId || seenSequences.has(entry.sequence) || seenEnvelopeIds.has(entry.envelopeId)) {
        throw new Error(`Saved Activity source journal returned duplicate or unordered records. ${diagnostic}`)
      }
      previousSequence = entry.sequence
      seenSequences.add(entry.sequence)
      seenEnvelopeIds.add(entry.envelopeId)
      if (entry.kind !== 'SDK_RECORD') continue
      if (!entry.envelopeJson) {
        throw new Error(`Saved Activity source journal omitted a source record payload. ${diagnostic}`)
      }
      const envelope = JSON.parse(entry.envelopeJson) as ActivityV2SourceEnvelope
      if (envelope.kind !== 'SDK_RECORD' || envelope.envelopeId !== entry.envelopeId) {
        throw new Error(`Saved source envelope ${entry.envelopeId} failed its identity check.`)
      }
      if (envelope.vendorDataType === '24' || envelope.vendorDataType === '25') entries.push(envelope)
    }
    const lastSequence = page.envelopes.at(-1)?.sequence ?? afterSequence
    if (!Number.isSafeInteger(page.nextSequence) || page.nextSequence !== lastSequence) {
      throw new Error(`Saved Activity source journal returned an invalid cursor. ${diagnostic}`)
    }
    if (!page.hasMore) return entries
    if (!page.envelopes.length || page.nextSequence <= afterSequence) {
      throw new Error(`Saved Activity source journal pagination did not advance. ${diagnostic}`)
    }
    afterSequence = page.nextSequence
  }
  throw new Error('Saved Activity source journal exceeded the 10,000-envelope verification read limit.')
}
