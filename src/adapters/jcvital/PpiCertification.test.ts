import { describe, expect, it, vi } from 'vitest'
import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import { mapPhysiologyObservation } from './PhysiologyContract'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import {
  NO_COMPLETE_PPI_CERTIFICATION_GROUP, PPI_CERTIFICATION_SUCCESS, PpiCertification,
  selectPpiCertificationSlots,
} from './PpiCertification'
import { DEVICE, TIME, fixture, slots, typed } from './PpiCertification.fixture'

describe('VC9 grouped type-127 PPI certification', () => {
  it('selects first, last, first interior non-zero, first interior zero, and midpoint deterministically without duplicates', () => {
    const selected = selectPpiCertificationSlots(slots([7, 0, 5, 0, 9, 0, 8]))
    expect(selected.map(({ slot }) => slot.index)).toEqual([0, 1, 2, 3, 6])
    expect(selected[2].categories).toContain('firstInteriorNonZero')
    expect(selected[1].categories).toEqual(['firstInteriorZero'])
    expect(selected[3].categories).toEqual(['midpointInterior'])
    expect(selectPpiCertificationSlots(slots([7, 0, 5, 0, 9, 0, 8]))).toEqual(selected)
  })

  it('does not invent a missing category and truthfully selects an all-zero record', () => {
    const zero = selectPpiCertificationSlots(slots([0, 0, 0, 0, 0]))
    expect(zero.map(({ slot }) => slot.index)).toEqual([0, 1, 2, 4])
    expect(zero.every(({ slot }) => slot.value === 0)).toBe(true)
    expect(zero.some(({ categories }) => categories.includes('firstInteriorNonZero'))).toBe(false)
    expect(selectPpiCertificationSlots(slots([8])).map(({ slot, categories }) => [slot.index, categories]))
      .toEqual([[0, ['first', 'last']]])
  })

  it('acquires exactly once, preserves every source slot, selects one group, and delivers only selected IDs', async () => {
    const f = await fixture()
    const originalEnvelope = f.journalRows.get('record-1')!.envelopeJson
    const capture = await f.service.capture()
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(capture.group?.sourceArrayLength).toBe(7)
    expect(capture.group?.originalSlots.map((slot) => slot.index)).toEqual([0, 1, 2, 3, 4, 5, 6])
    expect(capture.group?.originalSlots.map((slot) => slot.value)).toEqual([11, 0, 22, 0, 22, 0, 33])
    expect(capture.group?.originalSlots[1].value).toBe(0)
    expect(capture.group?.originalSlots[2].value).toBe(capture.group?.originalSlots[4].value)
    expect(capture.group?.sourceEnvelopeJson).toBe(originalEnvelope)
    expect(capture.group?.children.map((child) => child.slotIndex)).toEqual([0, 1, 2, 3, 6])
    expect(capture.group?.children.every((child) => child.sourceEnvelopeId === 'record-1')).toBe(true)
    expect(capture.group?.children.every((child) => child.payload.sourceRecordGroupId === capture.group?.sourceRecordGroupId)).toBe(true)
    expect(capture.group?.children.every((child) => child.payload.unit === 'UNKNOWN_VENDOR_UNIT'
      && child.payload.rawSourceMetadata?.canonicalPolicy === 'NATIVE_ONLY'
      && child.canonicalTarget === null && child.payload.observedAt === TIME
      && child.payload.startTime === TIME)).toBe(true)
    const everyMappedSlot = await mapPhysiologyObservation('user-1', f.sync.observations[0], {
      deviceId: DEVICE, firmwareVersion: f.context.firmwareVersion, sdkVersion: f.context.sdkVersion,
    })
    expect(everyMappedSlot.every((slot) => slot.status === 'MAPPED'
      && slot.observation.observedAt === TIME
      && slot.observation.timestampSource === 'DEVICE_HISTORY_RECORD_TIME'
      && slot.observation.timestampConfidence === 'DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE'
      && slot.observation.unit === 'UNKNOWN_VENDOR_UNIT'
      && slot.observation.rawSourceMetadata?.canonicalPolicy === 'NATIVE_ONLY')).toBe(true)
    const delivered = await f.service.flushSaved()
    expect(delivered.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(f.acquire).toHaveBeenCalledTimes(1)
    expect(f.flush.mock.calls[0][0]).toEqual(capture.group?.children.map((child) => child.observationId))
    expect(f.queueRows.size).toBe(0)
  })

  it('persists the full source across queue purge and restart; inspection performs no acquisition or delivery', async () => {
    const f = await fixture()
    const initial = await f.service.capture()
    await f.service.flushSaved()
    const savedSlots = f.service.snapshot()!.originalSlots
    const restarted = new PpiCertification(f.deps)
    f.acquire.mockClear()
    f.flush.mockClear()
    const inspected = await restarted.inspectSaved()
    expect(inspected.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(inspected.group?.originalSlots).toEqual(savedSlots)
    expect(inspected.group?.sourceArrayLength).toBe(7)
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
    expect(f.enqueueMany).toHaveBeenCalledTimes(1)
    expect(f.journalRows.get('record-1')!.envelopeJson).toBe(initial.group?.sourceEnvelopeJson)
    const exported = JSON.parse(await restarted.exportSaved())
    expect(exported.slotEvidence).toEqual(savedSlots)
    expect(exported.assertions).toMatchObject({
      originalOrderingPreserved: true, zeroValuesPreserved: true,
      duplicateValuesPreserved: true, noSlotCompaction: true, noPerSlotTimingInferred: true,
      unit: 'UNKNOWN_VENDOR_UNIT', nativeOnly: true, noCanonicalPromotion: true,
    })
    expect(exported.deliveryTotals).toMatchObject({
      selected: initial.group?.children.length, accepted: initial.group?.children.length,
      rejected: 0, canonicalRows: 0, canonicalFailures: 0,
    })
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
  })

  it('detects source-array changes during saved inspection without reacquiring or sending', async () => {
    const f = await fixture()
    await f.service.capture()
    const record = f.journalRows.get('record-1')!
    const json = JSON.parse(record.envelopeJson)
    json.sourceArrays[0].slots[1].originalValue = typed('Int', '4')
    record.envelopeJson = JSON.stringify(json)
    f.acquire.mockClear()
    const inspection = await f.service.inspectSaved()
    expect(inspection.status).toBe('PPI_CERTIFICATION_EVIDENCE_INVALID')
    expect(inspection.reason).toMatch(/array annotation differs/)
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
  })

  it('exports identical saved certification content after restart and ACK purge with zero acquisition/enqueue/Base44 calls', async () => {
    const f = await fixture()
    await f.service.capture()
    await f.service.flushSaved()
    expect(f.queueRows.size).toBe(0)
    const beforeRestart = await f.service.exportSaved()
    f.acquire.mockClear()
    f.enqueueMany.mockClear()
    f.flush.mockClear()
    const backend = vi.spyOn(connectorObservationService, 'submitObservations')
    try {
      const restarted = new PpiCertification(f.deps)
      f.context.ready = false
      expect(restarted.hasSavedEvidence()).toBe(true)
      expect((await restarted.inspectSaved()).status).toBe(PPI_CERTIFICATION_SUCCESS)
      expect(await restarted.exportSaved()).toBe(beforeRestart)
      const exported = JSON.parse(beforeRestart)
      expect(exported.sourceRecord.sourceArrayLength).toBe(7)
      expect(exported.sourceRecord.fullAncestry).toHaveLength(3)
      expect(exported.selectedDeliveryChildren.every((child: { nativeObservationId: string; queueDisposition: string }) =>
        child.nativeObservationId && child.queueDisposition === 'ACKNOWLEDGED_PURGED')).toBe(true)
      expect(f.acquire).not.toHaveBeenCalled()
      expect(f.enqueueMany).not.toHaveBeenCalled()
      expect(f.flush).not.toHaveBeenCalled()
      expect(backend).not.toHaveBeenCalled()
    } finally { backend.mockRestore() }
  })

  it('retains native journal error codes/messages instead of reducing them to export failed', async () => {
    const f = await fixture()
    await f.service.capture()
    f.readSourceEnvelope.mockRejectedValue({ code: 'SOURCE_JOURNAL_SCOPE_NOT_CONFIGURED', message: 'Reconnect only' })
    await expect(f.service.exportSaved()).rejects.toThrow('JOURNAL_READ: SOURCE_JOURNAL_SCOPE_NOT_CONFIGURED: Reconnect only')
  })

  it('identifies snapshot read failures explicitly without acquisition or delivery', async () => {
    const f = await fixture()
    f.deps.connectedContext = () => { throw new Error('Connect the authenticated physical V8 to establish its source-journal scope.') }
    await expect(f.service.exportSaved()).rejects.toThrow(/SNAPSHOT_READ: Connect/)
    expect(f.acquire).not.toHaveBeenCalled()
    expect(f.enqueueMany).not.toHaveBeenCalled()
    expect(f.flush).not.toHaveBeenCalled()
  })

  it('leaves malformed/null original slot representations intact and refuses a compacted normalized group', async () => {
    const f = await fixture([8, null, 'invalid', 0, 8])
    const before = f.journalRows.get('record-1')!.envelopeJson
    const result = await f.service.capture()
    expect(result.status).toBe(NO_COMPLETE_PPI_CERTIFICATION_GROUP)
    expect(f.acquire).toHaveBeenCalledTimes(1)
    const savedRecord = JSON.parse(f.journalRows.get('record-1')!.envelopeJson)
    const rawValues = savedRecord.sdkSnapshot.entries.find((entry: { key: { value: string } }) => entry.key.value === 'ppiData').value.values
    expect(rawValues).toEqual([typed('Int', '8'), typed('null'), typed('String', 'invalid'), typed('Int', '0'), typed('Int', '8')])
    expect(savedRecord.sourceArrays[0].slots.map((slot: { sourceIndex: number; parseStatus: string }) => [slot.sourceIndex, slot.parseStatus]))
      .toEqual([[0, 'VALID_INT32'], [1, 'NULL'], [2, 'INVALID_INT32'], [3, 'VALID_INT32'], [4, 'VALID_INT32']])
    expect(f.journalRows.get('record-1')!.envelopeJson).toBe(before)
    expect(f.enqueueMany).not.toHaveBeenCalled()
  })

  it('does not select children from a second source group', async () => {
    const f = await fixture()
    const second = f.addGroup('record-2')
    f.sync.observations.push(second.native)
    f.sync.recordsReceived++
    f.sync.recordGroupsReceived++
    const capture = await f.service.capture()
    expect(capture.group?.children.every((child) => child.sourceEnvelopeId === capture.group?.sourceEnvelopeId)).toBe(true)
    expect(capture.group?.sourceEnvelopeId).toBe('record-1')
    expect(capture.group?.children.some((child) => child.sourceEnvelopeId === 'record-2')).toBe(false)
  })

  it('rejects canonicalized results and accepted results without NativeObservation IDs', async () => {
    const canonicalized = await fixture()
    await canonicalized.service.capture()
    canonicalized.setResults((ids) => ids.map((observationId) => ({
      observationId, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: `native-${observationId}`,
    })))
    expect((await canonicalized.service.flushSaved()).status).toBe('PPI_CERTIFICATION_INCOMPLETE')

    const missingNativeId = await fixture()
    await missingNativeId.service.capture()
    missingNativeId.setResults((ids) => ids.map((observationId) => ({
      observationId, status: 'accepted', canonicalStatus: 'not_applicable', nativeObservationId: null,
    })))
    expect((await missingNativeId.service.flushSaved()).status).toBe('PPI_CERTIFICATION_INCOMPLETE')
  })

  it('keeps unrelated queued backlog unchanged and calls only the targeted sender for selected children', async () => {
    const f = await fixture()
    const unrelated = 'a'.repeat(64)
    const backlog: QueueRecord = {
      queueId: unrelated, ownerUserId: 'user-1', observationId: unrelated, sourceEnvelopeId: undefined,
      payload: {} as NativeObservationInput, state: 'PENDING', createdAt: TIME, updatedAt: TIME,
      claimedAt: null, attemptCount: 0, nextAttemptAt: null, lastAttemptAt: null, lastErrorCode: null,
      lastErrorMessage: null, batchId: null, acknowledgedAt: null, nativeObservationId: null, canonicalFailureAt: null,
    }
    f.queueRows.set(unrelated, backlog)
    await f.service.capture()
    const completed = await f.service.flushSaved()
    expect(completed.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(f.flush.mock.calls[0][0]).toEqual(completed.group?.children.map((child) => child.observationId))
    expect(f.queueRows.get(unrelated)).toEqual(backlog)
  })
})

describe('VC15 SOURCE_METADATA_ALIGNMENT semantic equality (fixes the false-negative predicate)', () => {
  function alignmentEvent(events: Array<{ stage: string; status: string; details: unknown }>) {
    return events.find((event) => event.stage === 'SOURCE_METADATA_ALIGNMENT')!
  }

  it('passes when source date text and the normalized source date text are exactly equal', async () => {
    const f = await fixture()
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details) => events.push({ stage, status, details }) })
    await service.capture()
    const result = await service.flushSaved()
    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    const event = alignmentEvent(events)
    expect(event.status).toBe('PASSED')
    expect(event.details).toMatchObject({ sourceDateMatches: true, observedAtMatches: true, serialMatches: true, metadataAlignmentPass: true })
  })

  it('passes when the source and normalized observed timestamps are the same instant in different ISO text', async () => {
    const f = await fixture()
    const envelope = JSON.parse(f.journalRows.get('record-1')!.envelopeJson)
    expect(envelope.observedAt).toBe(TIME)
    envelope.observedAt = '2026-10-04T12:00:00Z' // same instant as TIME ('2026-10-04T12:00:00.000Z'), different text
    f.journalRows.get('record-1')!.envelopeJson = JSON.stringify(envelope)
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details) => events.push({ stage, status, details }) })
    await service.capture()
    const result = await service.flushSaved()
    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(alignmentEvent(events).details).toMatchObject({ observedAtMatches: true, metadataAlignmentPass: true })
  })

  it('passes when an equivalent Date object is compared by value, never by reference identity', async () => {
    const f = await fixture()
    // Simulates a bridging layer that normalized the observed timestamp into a Date instance instead of a string.
    ;(f.sync.observations[0] as unknown as { observedAt: Date }).observedAt = new Date(TIME)
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details) => events.push({ stage, status, details }) })
    await service.capture()
    const result = await service.flushSaved()
    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(alignmentEvent(events).details).toMatchObject({ observedAtMatches: true, metadataAlignmentPass: true })
  })

  it('passes when the vendor serial is represented as equivalent numeric and string values', async () => {
    const f = await fixture()
    const recordEntry = f.journalRows.get('record-1')!
    const callbackEntry = f.journalRows.get('record-1-callback')!
    const setSerial = (entries: Array<{ key: { value: string }; value: unknown }>) => {
      const field = entries.find((entry) => entry.key.value === 'serial_number')!
      field.value = typed('String', '42')
    }
    const recordEnvelope = JSON.parse(recordEntry.envelopeJson)
    setSerial(recordEnvelope.sdkSnapshot.entries)
    recordEntry.envelopeJson = JSON.stringify(recordEnvelope)
    const callbackEnvelope = JSON.parse(callbackEntry.envelopeJson)
    const dicData = callbackEnvelope.sdkSnapshot.entries.find((entry: { key: { value: string } }) => entry.key.value === 'dicData')
    setSerial(dicData.value.values[0].entries)
    callbackEntry.envelopeJson = JSON.stringify(callbackEnvelope)
    ;(f.sync.observations[0] as unknown as { packetId: number }).packetId = 42
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details) => events.push({ stage, status, details }) })
    await service.capture()
    const result = await service.flushSaved()
    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(alignmentEvent(events).details).toMatchObject({ serialMatches: true, metadataAlignmentPass: true })
  })


  it('fails when the normalized observed timestamp is an actually different instant', async () => {
    const f = await fixture()
    f.sync.observations[0].observedAt = '2026-10-04T12:00:01.000Z'
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details) => events.push({ stage, status, details }) })
    const result = await service.capture()
    expect(result.status).toBe(NO_COMPLETE_PPI_CERTIFICATION_GROUP)
    expect(result.reason).toMatch(/timestamp or group serial differs/)
    const event = alignmentEvent(events)
    expect(event.status).toBe('FAILED')
    expect(event.details).toMatchObject({ observedAtMatches: false, metadataAlignmentPass: false })
  })

  it('fails when the normalized packet/group serial is an actually different vendor value', async () => {
    const f = await fixture()
    f.sync.observations[0].packetId = 'serial-9'
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details) => events.push({ stage, status, details }) })
    const result = await service.capture()
    expect(result.status).toBe(NO_COMPLETE_PPI_CERTIFICATION_GROUP)
    const event = alignmentEvent(events)
    expect(event.status).toBe('FAILED')
    expect(event.details).toMatchObject({ serialMatches: false, metadataAlignmentPass: false })
  })

  it('fails when the normalized source date text does not match the original SDK source date', async () => {
    const f = await fixture()
    f.sync.observations[0].observedAtSource = '2026.10.04 12:00:01'
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details) => events.push({ stage, status, details }) })
    const result = await service.capture()
    expect(result.status).toBe(NO_COMPLETE_PPI_CERTIFICATION_GROUP)
    const event = alignmentEvent(events)
    expect(event.status).toBe('FAILED')
    expect(event.details).toMatchObject({ sourceDateMatches: false, metadataAlignmentPass: false })
  })

  it('selects the first complete valid candidate deterministically when multiple candidates exist', async () => {
    const f = await fixture()
    f.sync.observations.push(f.addGroup('record-2').native)
    await f.service.capture()
    const result = await f.service.flushSaved()
    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(result.group?.sourceEnvelopeId).toBe('record-1')
  })

  it('keeps all 56 slots aligned end to end for a full-size physical PPI group', async () => {
    const values = Array.from({ length: 56 }, (_value, index) => (index % 5 === 0 ? 0 : (index + 1) * 10))
    const f = await fixture(values)
    await f.service.capture()
    const result = await f.service.flushSaved()
    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(result.group?.sourceArrayLength).toBe(56)
    expect(result.group?.originalSlots.map((slot) => slot.value)).toEqual(values)
    expect(result.group?.originalSlots.every((slot) => slot.parseStatus === 'VALID_INT32')).toBe(true)
  })

  it('advances the attempt-journal diagnostic cursor correctly across multiple pages without undercounting', async () => {
    const f = await fixture()
    const allEnvelopes = [...f.journalRows.entries()].map(([envelopeId, entry]) => {
      const json = JSON.parse(entry.envelopeJson)
      return { sequence: entry.sequence, envelopeId, callbackId: json.callbackId ?? null, recordIndex: json.recordIndex ?? null,
        kind: json.kind, receivedAt: f.sync.startedAt, timezone: 'UTC', envelopeJson: entry.envelopeJson, rawBytesBase64: entry.rawBytesBase64 }
    }).sort((a, b) => a.sequence - b.sequence)
    expect(allEnvelopes.length).toBe(3)
    const listSourceEnvelopes = vi.fn(async ({ afterSequence = 0 }: { afterSequence?: number }) => {
      // Force one page per envelope so the cursor must advance more than once to be correct.
      const remaining = allEnvelopes.filter((entry) => entry.sequence > afterSequence)
      const page = remaining.slice(0, 1)
      return { modelVersion: 'L0', envelopes: page, nextSequence: page.at(-1)?.sequence ?? afterSequence, hasMore: remaining.length > page.length }
    })
    const events: Array<{ stage: string; status: string; details: unknown }> = []
    const service = new PpiCertification({
      ...f.deps, attemptJournal: { listSourceEnvelopes },
      attemptEvent: (stage, status, details) => events.push({ stage, status, details }),
    })
    const result = await service.capture()
    expect(result.group).toBeTruthy()
    expect(listSourceEnvelopes.mock.calls.length).toBeGreaterThan(1)
    const counts = events.find((event) => event.stage === 'TYPE_127_JOURNAL_COUNTS' && event.status === 'PASSED')!
    expect(counts.details).toMatchObject({ callbackCount: 1, sdkRecordCount: 1 })
  })
})
