import { describe, expect, it, vi } from 'vitest'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { SourceJournalScope } from './jcvitalV8Bridge'
import { PPI_CERTIFICATION_SUCCESS } from './PpiCertification'
import { DEVICE, MAC, TIME, fixture } from './PpiCertification.fixture'
import {
  PPI_CERTIFICATION_KEY_PREFIX, PpiCertificationRecovery, type PpiBase44ReadOnlyTraceRow,
} from './PpiCertificationRecovery'

const NEW_DEVICE = 'jcvital_device_00000000-1111-4222-8333-444455556666'
const OTHER_MAC = 'AA:BB:CC:DD:EE:FF'

function key(owner: string, device: string) {
  return `${PPI_CERTIFICATION_KEY_PREFIX}v1.${encodeURIComponent(owner)}.${encodeURIComponent(device)}`
}

type Fixture = Awaited<ReturnType<typeof fixture>>

/** Read-only recovery wired to the fixture; the journal only answers for the scope it was recorded under. */
function recovery(f: Fixture, options: {
  journalScope?: { accountId: string; deviceScopeId: string }
  trace?: (ids: string[]) => PpiBase44ReadOnlyTraceRow[]
} = {}) {
  const journalScope = options.journalScope ?? { accountId: 'user-1', deviceScopeId: DEVICE }
  const inScope = (scope: SourceJournalScope) => scope.accountId === journalScope.accountId
    && scope.deviceScopeId === journalScope.deviceScopeId
  const exportSourceJournal = vi.fn(async (scope: SourceJournalScope & { afterSequence?: number; limit?: number }) => {
    if (!inScope(scope)) throw new Error('OWNER_MISMATCH')
    const limit = scope.limit ?? 100
    const rows = [...f.journalRows.values()].sort((a, b) => a.sequence - b.sequence)
      .filter((row) => row.sequence > (scope.afterSequence ?? 0))
    const page = rows.slice(0, limit)
    return {
      modelVersion: 'l0-source-envelope-v1',
      envelopes: page.map((row) => {
        const json = JSON.parse(row.envelopeJson ?? '{}') as { kind: string; callbackId?: string; recordIndex?: number }
        return {
          sequence: row.sequence, envelopeId: row.envelopeId, callbackId: json.callbackId ?? null,
          recordIndex: json.recordIndex ?? null, kind: json.kind, receivedAt: TIME, timezone: 'UTC',
          envelopeJson: row.envelopeJson, rawBytesBase64: row.rawBytesBase64,
        }
      }),
      nextSequence: page.at(-1)?.sequence ?? scope.afterSequence ?? 0,
      hasMore: rows.length > limit,
    }
  })
  const getSourceJournalDiagnostics = vi.fn(async () => ({
    modelVersion: 'l0-source-envelope-v1', enabled: true, failedClosed: false, lastOutcome: 'STORED', refusedCount: 0,
    totalEnvelopeCount: f.journalRows.size, totalStoredBytes: 0, maxBytes: 0, maxEnvelopes: 0, maxEntryBytes: 0,
    retentionPolicy: 'RETAIN', rawStorage: 'BASE64',
  }))
  const readSourceEnvelope = vi.fn(async (scope: SourceJournalScope & { envelopeId: string }) => {
    if (!inScope(scope)) throw new Error('OWNER_MISMATCH')
    const entry = f.journalRows.get(scope.envelopeId)
    if (!entry) throw new Error('ENVELOPE_NOT_FOUND')
    return structuredClone(entry)
  })
  const base44ReadOnlyTrace = options.trace
    ? vi.fn(async (query: { observationIds: string[] }) => options.trace!(query.observationIds)) : undefined
  const service = new PpiCertificationRecovery({
    queue: f.deps.queue, journal: { readSourceEnvelope, exportSourceJournal, getSourceJournalDiagnostics },
    connectedContext: f.deps.connectedContext, storage: f.deps.storage, base44ReadOnlyTrace,
  })
  return { service, exportSourceJournal, readSourceEnvelope, base44ReadOnlyTrace }
}

/** VC9 physical run: capture once and deliver; the certification flush purges ACKed rows. */
async function vc9(f: Fixture) {
  const capture = await f.service.capture()
  const delivered = await f.service.flushSaved()
  expect(delivered.status).toBe(PPI_CERTIFICATION_SUCCESS)
  f.acquire.mockClear()
  f.enqueueMany.mockClear()
  f.flush.mockClear()
  return capture.group!
}

function expectNoWrites(f: Fixture, storageBefore: Map<string, string>, journalBefore: Map<string, unknown>) {
  expect(f.acquire).not.toHaveBeenCalled()
  expect(f.enqueueMany).not.toHaveBeenCalled()
  expect(f.flush).not.toHaveBeenCalled()
  expect(new Map(f.storageRows)).toEqual(storageBefore)
  expect(new Map(f.journalRows)).toEqual(journalBefore)
}

function ack(observationId: string, payload: QueueRecord['payload'], nativeObservationId: string | null = null): QueueRecord {
  return {
    queueId: observationId, ownerUserId: 'user-1', observationId, payload, state: 'ACKNOWLEDGED',
    createdAt: TIME, updatedAt: TIME, claimedAt: null, attemptCount: 1, nextAttemptAt: null, lastAttemptAt: TIME,
    lastErrorCode: null, lastErrorMessage: null, batchId: 'ppi-batch', acknowledgedAt: TIME,
    nativeObservationId, canonicalFailureAt: null,
  }
}

describe('VC11 read-only PPI saved-evidence recovery', () => {
  it('proves the VC9/VC10 lookup key formula and detects an old-device key the current lookup misses', async () => {
    const f = await fixture()
    const group = await vc9(f)
    expect([...f.storageRows.keys()]).toEqual([key('user-1', DEVICE)])
    // Same physical V8, but the identity map now resolves a different deviceScopeId.
    f.context.scope.deviceScopeId = NEW_DEVICE
    f.storageRows.set('jcvitalDeviceIdentityMap.v1', JSON.stringify({ [MAC]: NEW_DEVICE, 'AA:AA:AA:AA:AA:AA': 'other-scope' }))
    const current = await f.service.inspectSaved()
    expect(current.status).not.toBe(PPI_CERTIFICATION_SUCCESS)
    expect(current.reason).toBe('No saved PPI group for this owner/device.')
    const r = recovery(f)
    const report = r.service.findSavedCertifications()
    expect(report.exactStorageKey).toBe(key('user-1', NEW_DEVICE))
    expect(report.exactKeyPresent).toBe(false)
    expect(report.ppiCertificationKeyCount).toBe(1)
    expect(report.entries[0]).toMatchObject({
      storageKey: key('user-1', DEVICE), keyOwnerId: 'user-1', keyDeviceScopeId: DEVICE,
      savedOwnerId: 'user-1', savedDeviceScopeId: DEVICE, certificationGroupId: group.certificationGroupId,
      sourceEnvelopeId: 'record-1', capturedAt: group.capturedAt, sourceRecordGroupId: group.sourceRecordGroupId,
      slotCount: 7, selectedChildCount: 5, deliveryReceiptCount: 5, savedBleAddressMatchesConnected: true,
      compatibility: 'LEGACY_KEY_COMPATIBLE',
    })
    expect(report.identityMap).toMatchObject({
      entryCount: 2, connectedAddressMapped: true, connectedMappedDeviceScopeId: NEW_DEVICE,
      connectedMappingMatchesCurrentScope: true, otherDeviceScopeIds: ['other-scope'],
    })
    // Unrelated storage content is never surfaced.
    expect(JSON.stringify(report)).not.toContain(MAC)
  })

  it('discovers old owner and other-device keys without treating them as compatible', async () => {
    const f = await fixture()
    await vc9(f)
    const saved = f.storageRows.get(key('user-1', DEVICE))!
    const otherDevice = JSON.parse(saved)
    otherDevice.context.bleAddress = OTHER_MAC
    otherDevice.context.scope.deviceScopeId = 'device-other'
    f.storageRows.set(key('user-1', 'device-other'), JSON.stringify(otherDevice))
    f.storageRows.set('unrelated.secret', 'token-value')
    f.setOwner('user-2')
    const r = recovery(f)
    const report = r.service.findSavedCertifications()
    expect(report.ppiCertificationKeyCount).toBe(2)
    expect(report.entries.map((entry) => [entry.keyOwnerId, entry.keyDeviceScopeId, entry.compatibility])).toEqual([
      ['user-1', 'device-other', 'OWNER_MISMATCH'], ['user-1', DEVICE, 'OWNER_MISMATCH'],
    ])
    expect(JSON.stringify(report)).not.toContain('token-value')
    const recovered = await r.service.recover()
    expect(recovered.classification).toBe('PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE')
    expect(recovered.certificationSuccess).toBe(false)

    f.setOwner('user-1')
    const sameOwner = recovery(f).service.findSavedCertifications()
    expect(sameOwner.entries.map((entry) => entry.compatibility)).toEqual(['DEVICE_MISMATCH', 'EXACT_KEY'])
  })

  it('reports an exact snapshot as PPI_SNAPSHOT_FOUND_EXACT', async () => {
    const f = await fixture()
    await vc9(f)
    const storageBefore = new Map(f.storageRows)
    const journalBefore = new Map(f.journalRows)
    const r = recovery(f)
    const recovered = await r.service.recover()
    expect(recovered).toMatchObject({
      classification: 'PPI_SNAPSHOT_FOUND_EXACT', recoverySource: 'EXACT_SAVED_SNAPSHOT', certificationSuccess: true,
      journalCrossCheck: 'VERIFIED_AGAINST_CONNECTED_JOURNAL', adoptedStorageKey: key('user-1', DEVICE),
    })
    expectNoWrites(f, storageBefore, journalBefore)
  })

  it('adopts exactly one compatible legacy snapshot read-only under the current lookup context', async () => {
    const f = await fixture()
    const group = await vc9(f)
    f.context.scope.deviceScopeId = NEW_DEVICE
    const storageBefore = new Map(f.storageRows)
    const journalBefore = new Map(f.journalRows)
    const r = recovery(f, { journalScope: { accountId: 'user-1', deviceScopeId: NEW_DEVICE } })
    const recovered = await r.service.recover()
    expect(recovered).toMatchObject({
      classification: 'PPI_SNAPSHOT_FOUND_LEGACY_KEY', recoverySource: 'LEGACY_SNAPSHOT_KEY', certificationSuccess: true,
      journalCrossCheck: 'VERIFIED_AGAINST_SAVED_ANCESTRY_ONLY', adoptedStorageKey: key('user-1', DEVICE),
    })
    expect(recovered.group?.children.map((child) => child.observationId)).toEqual(group.children.map((child) => child.observationId))
    expect(r.readSourceEnvelope).not.toHaveBeenCalled()
    const exported = JSON.parse(await r.service.exportRecovered())
    expect(exported.recoverySource).toBe('LEGACY_SNAPSHOT_KEY')
    expect(exported.originalSnapshotModified).toBe(false)
    expect(exported.certification.slotEvidence).toEqual(group.originalSlots)
    expect(f.storageRows.has(key('user-1', NEW_DEVICE))).toBe(false)
    expectNoWrites(f, storageBefore, journalBefore)
    expect(r.service.operationCounts()).toEqual({ ppiAcquisitionCalls: 0, enqueueCalls: 0, base44Writes: 0, storageWrites: 0 })
  })

  it('fails closed when multiple compatible legacy snapshots exist', async () => {
    const f = await fixture()
    await vc9(f)
    const copy = JSON.parse(f.storageRows.get(key('user-1', DEVICE))!)
    copy.context.scope.deviceScopeId = 'device-older'
    f.storageRows.set(key('user-1', 'device-older'), JSON.stringify(copy))
    f.context.scope.deviceScopeId = NEW_DEVICE
    const r = recovery(f)
    const recovered = await r.service.recover()
    expect(recovered.keyReport.entries.filter((entry) => entry.compatibility === 'LEGACY_KEY_COMPATIBLE')).toHaveLength(2)
    expect(recovered).toMatchObject({ classification: 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE', certificationSuccess: false, group: null })
    expect(r.exportSourceJournal).not.toHaveBeenCalled()
    await expect(r.service.exportRecovered()).rejects.toThrow('PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE')
  })

  it('reconstructs a single type-127 journal candidate and the identical VC9 child IDs after ACK purge', async () => {
    const f = await fixture()
    const group = await vc9(f)
    expect(f.queueRows.size).toBe(0)
    f.storageRows.clear()
    const journalBefore = new Map(f.journalRows)
    const r = recovery(f)
    const recovered = await r.service.recover()
    expect(recovered.journal).toMatchObject({
      sdkRecordCount: 1, type127RecordCount: 1, selectionMode: 'SINGLE_PLAUSIBLE_CANDIDATE', selectedSourceEnvelopeId: 'record-1',
      envelopesOutsideCurrentScope: 0,
    })
    const candidate = recovered.journal!.candidates[0]
    expect(candidate).toMatchObject({
      sourceEnvelopeId: 'record-1', journalSourceRecordGroupId: 'record-1-callback', sourceRecordGroupId: group.sourceRecordGroupId,
      observedAt: TIME, receivedAt: TIME, vendorDataType: '127', slotCount: 7, plausible: true, queueEvidenceCount: 0,
    })
    expect(candidate.slots).toEqual(group.originalSlots)
    expect(candidate.ancestry.map((entry) => entry.kind)).toEqual(['SDK_RECORD', 'SDK_CALLBACK', 'BLE_NOTIFICATION'])
    expect(candidate.rawNotification).toMatchObject({ envelopeId: 'record-1-ble', byteLength: 4 })
    expect(candidate.reconstructedChildIds).toEqual(group.children.map((child) => child.observationId))
    expect(recovered.reconstructed?.children.map((child) => child.slotIndex)).toEqual([0, 1, 2, 3, 6])
    expect(recovered.reconstructed?.children.map((child) => [child.sourceRecordId, child.categories])).toEqual(
      group.children.map((child) => [child.payload.sourceRecordId, child.categories]))
    expect(recovered.reconstructed?.sourceFingerprint).toBe(group.sourceFingerprint)
    // ACK purge removed queue rows and no read-only Base44 path exists: delivery is honestly missing.
    expect(recovered).toMatchObject({
      classification: 'PPI_JOURNAL_FOUND_DELIVERY_EVIDENCE_MISSING', recoverySource: 'L0_JOURNAL_SOURCE_ONLY',
      certificationSuccess: false,
    })
    expect(recovered.reconstructed?.deliveryGate).toBe('MISSING')
    expect(recovered.reconstructed?.base44ReadOnlyLookup).toBe('UNAVAILABLE_NO_READ_ONLY_PATH')
    expect(f.storageRows.size).toBe(0)
    expectNoWrites(f, new Map(), journalBefore)
  })

  it('lists multiple type-127 journal candidates, selects none automatically, and honours an explicit operator choice', async () => {
    const f = await fixture()
    f.addGroup('record-2', [5, 0, 6])
    const r = recovery(f)
    const recovered = await r.service.recover()
    expect(recovered.classification).toBe('PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE')
    expect(recovered.reason).toContain('2 plausible type-127 journal candidates')
    expect(recovered.journal?.candidates.map((candidate) => candidate.sourceEnvelopeId)).toEqual(['record-1', 'record-2'])
    expect(recovered.journal?.selectionMode).toBe('NONE')
    expect(recovered.journal?.selectionCriteria.length).toBeGreaterThan(0)
    const chosen = await r.service.recover({ sourceEnvelopeId: 'record-2' })
    expect(chosen.journal?.selectionMode).toBe('OPERATOR_SPECIFIED')
    expect(chosen.reconstructed?.originalSlots.map((slot) => slot.value)).toEqual([5, 0, 6])
    expect(chosen.classification).toBe('PPI_JOURNAL_FOUND_DELIVERY_EVIDENCE_MISSING')
    const unknown = await r.service.recover({ sourceEnvelopeId: 'record-404' })
    expect(unknown.classification).toBe('PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE')
  })

  it('rejects malformed type-127 records as candidates', async () => {
    const f = await fixture()
    f.journalRows.clear()
    f.addGroup('record-bad', [1, null, 2])
    const recovered = await recovery(f).service.recover()
    expect(recovered.journal?.candidates[0]).toMatchObject({ plausible: false })
    expect(recovered.journal?.candidates[0].rejectionReason).toBeTruthy()
    expect(recovered.classification).toBe('PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE')
  })

  it('uses durable queue ACKs as delivery evidence but never certifies without proven NativeObservation IDs', async () => {
    const f = await fixture()
    const group = await vc9(f)
    f.storageRows.clear()
    for (const child of group.children) f.queueRows.set(child.observationId, ack(child.observationId, child.payload))
    const recovered = await recovery(f).service.recover()
    expect(recovered).toMatchObject({
      classification: 'PPI_RECONSTRUCTABLE_FROM_JOURNAL', recoverySource: 'L0_JOURNAL_PLUS_DURABLE_RECEIPTS',
      certificationSuccess: false,
    })
    expect(recovered.reconstructed?.deliveryGate).toBe('ACKNOWLEDGED_WITHOUT_NATIVE_IDS')
    expect(recovered.reconstructed?.children.every((child) => child.delivery.queuePayloadMatchesReconstruction === true)).toBe(true)
  })

  it('does not certify from partial delivery evidence', async () => {
    const f = await fixture()
    const group = await vc9(f)
    f.storageRows.clear()
    const [first] = group.children
    f.queueRows.set(first.observationId, ack(first.observationId, first.payload))
    const recovered = await recovery(f, {
      trace: (ids) => ids.slice(0, 2).map((observationId) => ({ observationId, nativeObservationId: `native-${observationId}` })),
    }).service.recover()
    expect(recovered.classification).toBe('PPI_JOURNAL_FOUND_DELIVERY_EVIDENCE_MISSING')
    expect(recovered.certificationSuccess).toBe(false)
    expect(recovered.reason).toContain('3/5')
    await expect(recovery(f).service.exportRecovered()).resolves.toContain('"certificationSuccess": false')
  })

  it('certifies from journal only when a read-only Base44 trace proves every NativeObservation ID', async () => {
    const f = await fixture()
    const group = await vc9(f)
    f.storageRows.clear()
    const r = recovery(f, {
      trace: (ids) => ids.map((observationId) => ({ observationId, nativeObservationId: `native-${observationId}` })),
    })
    const recovered = await r.service.recover()
    expect(recovered).toMatchObject({
      classification: 'PPI_RECONSTRUCTABLE_FROM_JOURNAL', recoverySource: 'L0_JOURNAL_PLUS_BASE44_READ_ONLY_TRACE',
      certificationSuccess: true,
    })
    expect(r.base44ReadOnlyTrace).toHaveBeenCalledWith(expect.objectContaining({
      observationIds: group.children.map((child) => child.observationId), sourceRecordGroupId: group.sourceRecordGroupId,
    }))
  })

  it('exports recovered evidence with zero acquisition, enqueue, Base44 writes, and storage writes', async () => {
    const f = await fixture()
    const group = await vc9(f)
    f.storageRows.clear()
    const submit = vi.spyOn(connectorObservationService, 'submitObservations')
    const journalBefore = new Map(f.journalRows)
    const r = recovery(f)
    const exported = JSON.parse(await r.service.exportRecovered())
    expect(exported).toMatchObject({
      recoverySource: 'L0_JOURNAL_SOURCE_ONLY', classification: 'PPI_JOURNAL_FOUND_DELIVERY_EVIDENCE_MISSING',
      certificationSuccess: false, originalSnapshotModified: false, certification: null,
      operationCounts: { ppiAcquisitionCalls: 0, enqueueCalls: 0, base44Writes: 0, storageWrites: 0 },
    })
    expect(exported.reconstructed.originalSlots).toEqual(group.originalSlots)
    expect(exported.reconstructed.children.map((child: { observationId: string }) => child.observationId))
      .toEqual(group.children.map((child) => child.observationId))
    expect(submit).not.toHaveBeenCalled()
    expectNoWrites(f, new Map(), journalBefore)
    submit.mockRestore()
  })

  it('reports not recoverable when neither a snapshot nor a type-127 journal record exists', async () => {
    const f = await fixture()
    f.journalRows.clear()
    const r = recovery(f)
    const recovered = await r.service.recover()
    expect(recovered).toMatchObject({
      classification: 'PPI_EXISTING_EVIDENCE_NOT_RECOVERABLE', recoverySource: null, certificationSuccess: false,
    })
    expect(recovered.reason).toContain('no type-127 record')
    await expect(r.service.exportRecovered()).rejects.toThrow('NOT_RECOVERABLE')
  })
})
