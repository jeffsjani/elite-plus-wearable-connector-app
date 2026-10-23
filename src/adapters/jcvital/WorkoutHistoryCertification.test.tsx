import { describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { JCVitalV8Plugin, WorkoutHistoryAcquisition, WorkoutHistoryNativeObservation } from './jcvitalV8Bridge'
import type { Type42ConnectedContext } from './Type42Certification'
import { WorkoutHistoryCertification, WORKOUT_EMPTY_LIMITATION, WORKOUT_HISTORY_PATH, type WorkoutHistoryCertificationDependencies } from './WorkoutHistoryCertification'
import { WorkoutHistoryCertificationView } from './WorkoutHistoryCertificationView'
import { workoutJsonAction } from './WorkoutHistoryCertificationJson'
import { Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { VC25_WORKOUT_CAPTURE } from './Type29PhysicalWire'
import { VC25_SDK_RECORDS_ORIGINAL, vc25PhysicalBytes } from './Type29PhysicalWire.fixture'
import type { WorkoutHistoryCertificationSnapshot } from './WorkoutHistoryCertification'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: vi.fn(() => ({})) }))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: vi.fn(async () => ({ uri: 'file:///cache/workout.json' })) },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn(async () => ({})) } }))

type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
const typed = (value: unknown): unknown => {
  if (value === null) return null
  if (Array.isArray(value)) return { type: 'List', values: value.map(typed) }
  if (value && typeof value === 'object') return {
    type: 'Map', entries: Object.entries(value).map(([key, item]) => ({ key: typed(key), value: typed(item) })),
  }
  return { type: typeof value === 'boolean' ? 'Boolean' : 'String', value }
}
const vendorRecord = {
  date: '2026.10.05 12:03:04', sportModel: '255', heartRate: '0', ExerciseTime: '0', step: '0',
  sportModelSpeed: '00\'00"', calories: '0.0', distance: '0.00', unknownNull: null, unknownZero: '000',
  unknownUnit: 'not-documented', nestedUnknown: { value: null, readings: ['0', 'opaque'] },
}
async function fixture(pages: Array<Array<Record<string, unknown>>> = [[vendorRecord]], physical = false) {
  const context: Type42ConnectedContext = {
    scope: { accountId: 'workout-owner', deviceScopeId: 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b' },
    bleAddress: 'AA:BB:CC:DD:EE:FF', firmwareVersion: '1', sdkVersion: 'v8sdk2.0',
    ready: true, physical: true, native: true,
  }
  let live: Type42ConnectedContext | null = context
  const session = physical ? VC25_WORKOUT_CAPTURE.sessionId : 'workout-history-session'
  const header = { ...context.scope, deviceModel: 'PRO_V8', provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE',
    acquisitionMode: 'HISTORICAL_SYNC', sessionId: session, sdkVersion: 'v8sdk2.0', firmwareVersion: '1' }
  const journal = new Map<string, Entry>()
  async function write(id: string, values: Record<string, unknown>, bytes?: Uint8Array) {
    const sha256 = bytes ? Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('') : null
    journal.set(id, { envelopeId: id, sequence: journal.size + 1,
      envelopeJson: JSON.stringify({ ...header, envelopeId: id, ...values, ...(bytes ? { sha256, byteLength: bytes.length } : {}) }),
      rawBytesBase64: bytes ? btoa(String.fromCharCode(...bytes)) : null, sourceFile: null })
  }
  const observations: WorkoutHistoryNativeObservation[] = []
  const acquisition: WorkoutHistoryAcquisition = {
    syncId: session, deviceId: context.bleAddress, provider: 'JCVITAL', sdkCommand: WORKOUT_HISTORY_PATH.command,
    vendorDataType: '29', startedAt: '2026-10-05T12:10:00.000Z', completedAt: '2026-10-05T12:11:00.000Z',
    recordsReceived: 0, recordGroupsReceived: 0, recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0,
    earliestObservation: null, latestObservation: null, partial: false, completionStatus: 'EMPTY_VALID',
    packetCount: pages.length, parseErrors: [], observations, sourceRecordEnvelopeIds: [], sourceCallbackEnvelopeIds: [],
    sourceCommandEnvelopeIds: [], sourceCommandAckEnvelopeIds: [], sourceNotificationEnvelopeIds: [], sourceParserOutcomeEnvelopeIds: [],
    retryCount: 0, canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED', deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY',
  }
  for (const [page, records] of pages.entries()) {
    if (page % 50 === 0) {
      const id = `command-${page}`
      const bytes = new Uint8Array(16); bytes[0] = 0x5c; bytes[1] = page ? 2 : 0; bytes[15] = bytes[0] + bytes[1]
      await write(id, { kind: 'WORKOUT_COMMAND_REQUEST', sdkCommand: WORKOUT_HISTORY_PATH.command, vendorDataType: '29',
        callbackIdentifier: 'BleSDK.GetActivityModeDataWithMode(byte)' }, bytes)
      await write(`ack-${page}`, { kind: 'WORKOUT_COMMAND_WRITE_ACK', parentEnvelopeId: id,
        sdkCommand: WORKOUT_HISTORY_PATH.command, vendorDataType: '29',
        callbackIdentifier: 'BluetoothGattCallback.onCharacteristicWrite' }, bytes)
      acquisition.sourceCommandEnvelopeIds.push(id); acquisition.sourceCommandAckEnvelopeIds.push(`ack-${page}`)
    }
    const end = page === pages.length - 1
    const bytes = physical ? vc25PhysicalBytes() : new Uint8Array(records.length * 25 + (end ? 2 : 0))
    if (!physical) {
      records.forEach((_, i) => { bytes[i * 25] = 0x5c })
      if (end) { bytes[bytes.length - 2] = 0x5c; bytes[bytes.length - 1] = 0xff }
    }
    const notificationId = `ble-${page}`, callbackId = `callback-${page}`, outcomeId = `outcome-${page}`
    const recordIds = records.map((_, i) => `record-${page}-${i}`)
    await write(notificationId, { kind: 'BLE_NOTIFICATION' }, bytes)
    await write(callbackId, { kind: 'SDK_CALLBACK', callbackId, callbackIdentifier: 'DataListener2301.dataCallback(Map)',
      vendorDataType: '29', notificationEnvelopeId: notificationId, recordEnvelopeIds: recordIds,
      sdkSnapshot: typed({ dataType: '29', dataEnd: physical ? false : end, dicData: records }) })
    for (const [i, record] of records.entries()) {
      const id = recordIds[i]
      await write(id, { kind: 'SDK_RECORD', callbackId, vendorDataType: '29', notificationEnvelopeId: notificationId,
        sourceRecordId: id, sourceRecordGroupId: callbackId, sourceIndex: i, recordIndex: i, sdkSnapshot: typed(record) })
      observations.push({ id, sourceEnvelopeId: id, sourceCallbackId: callbackId, sourceIndex: i, sessionId: session,
        vendorDataType: '29', metricType: 'WORKOUT_HISTORY_NATIVE_SOURCE', vendorTimestamp: record.date === null ? null : String(record.date),
        sdkRecord: JSON.stringify(typed(record)), semanticClassification: 'RESEARCH_NATIVE_ONLY',
        semanticConfidence: 'UNKNOWN_VENDOR_SEMANTICS', canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED' })
    }
    await write(outcomeId, { kind: 'SDK_PARSE_OUTCOME', notificationEnvelopeId: notificationId,
      status: 'COMPLETE', mapCallbackCount: 1, errorClass: null })
    acquisition.sourceNotificationEnvelopeIds.push(notificationId); acquisition.sourceCallbackEnvelopeIds!.push(callbackId)
    acquisition.sourceRecordEnvelopeIds!.push(...recordIds); acquisition.sourceParserOutcomeEnvelopeIds.push(outcomeId)
  }
  acquisition.recordsReceived = observations.length; acquisition.recordGroupsReceived = observations.length
  acquisition.completionStatus = observations.length ? 'COMPLETE' : 'EMPTY_VALID'
  if (physical) { acquisition.completionStatus = 'PARTIAL'; acquisition.partial = true }
  let stored: string | null = null
  const cache = new Map<string, string>()
  const deps: WorkoutHistoryCertificationDependencies = {
    acquire: vi.fn(async () => structuredClone(acquisition)), connectedContext: () => live, owner: () => context.scope.accountId,
    contextStore: { getItem: (key) => cache.get(key) ?? null, setItem: (key, value) => { cache.set(key, value) } },
    journal: { readWorkoutSourceEnvelope: vi.fn(async ({ envelopeId }) => {
      const entry = journal.get(envelopeId)
      if (!entry) throw new Error('Missing envelope')
      return structuredClone(entry)
    }) },
    snapshotStore: {
      readWorkoutCertificationSnapshot: vi.fn(async () => ({ json: stored })),
      writeWorkoutCertificationSnapshot: vi.fn(async ({ json }) => { stored = json; return { saved: true } }),
    },
  }
  const edit = (id: string, change: (json: Record<string, unknown>) => void) => {
    const entry = journal.get(id)!
    const json = JSON.parse(entry.envelopeJson)
    change(json); entry.envelopeJson = JSON.stringify(json)
  }
  return { deps, acquisition, journal, edit, context, service: new WorkoutHistoryCertification(deps),
    disconnect: () => { live = null }, saved: () => JSON.parse(stored!),
    setSaved: (value: unknown) => { stored = JSON.stringify(value) } }
}

async function stoppedPhysicalFixture() {
  const f = await fixture([VC25_SDK_RECORDS_ORIGINAL], true)
  await expect(f.service.capture()).rejects.toThrow('WORKOUT_HISTORY_INCOMPLETE_OR_INVALID')
  const stopped = f.saved()
  stopped.certificationGroupId = VC25_WORKOUT_CAPTURE.certificationGroupId
  f.setSaved(stopped)
  vi.mocked(f.deps.acquire).mockClear()
  vi.mocked(f.deps.snapshotStore.writeWorkoutCertificationSnapshot).mockClear()
  return { ...f, stopped }
}

describe('VC26 saved-only physical finalization', () => {
  const target = { certificationGroupId: VC25_WORKOUT_CAPTURE.certificationGroupId, sessionId: VC25_WORKOUT_CAPTURE.sessionId }
  it.runIf(process.env.VC25_CAPTURE_EXPORT)('replays the supplied complete physical STOPPED export, with original scope and ancestry, offline', async () => {
    const text = readFileSync(process.env.VC25_CAPTURE_EXPORT!, 'utf8')
    const original: WorkoutHistoryCertificationSnapshot = JSON.parse(text.slice(text.indexOf('{')))
    let stored = JSON.stringify(original)
    const entries = new Map(original.stoppedSourceCapture!.map((entry) => [entry.envelopeId, entry]))
    const deps: WorkoutHistoryCertificationDependencies = {
      acquire: vi.fn(async () => { throw new Error('Acquisition prohibited') }),
      connectedContext: () => null, owner: () => original.context.scope.accountId,
      contextStore: { getItem: () => JSON.stringify(original.context), setItem: vi.fn() },
      journal: { readWorkoutSourceEnvelope: vi.fn(async ({ envelopeId }) => {
        const entry = entries.get(envelopeId)
        if (!entry) throw new Error('Missing physical source envelope')
        return structuredClone(entry)
      }) },
      snapshotStore: {
        readWorkoutCertificationSnapshot: vi.fn(async () => ({ json: stored })),
        writeWorkoutCertificationSnapshot: vi.fn(async ({ json }) => { stored = json; return { saved: true } }),
      },
    }
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'))
    try {
      const service = new WorkoutHistoryCertification(deps)
      const certified = await service.finalizeSaved(target)
      expect(certified.state).toBe('CERTIFIED')
      expect(certified.localFinalization!.originalStoppedSnapshot).toEqual(original)
      expect(certified.stoppedSourceCapture).toEqual(original.stoppedSourceCapture)
      expect(certified.acquisition).toEqual(original.acquisition)
      expect(await new WorkoutHistoryCertification(deps).inspectSaved()).toEqual(certified)
      expect(deps.acquire).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
      expect(deps.contextStore!.setItem).not.toHaveBeenCalled()
      expect(deps.snapshotStore.writeWorkoutCertificationSnapshot).toHaveBeenCalledTimes(1)
      const json = await service.exportSaved()
      expect(JSON.parse(json)).toEqual(certified)
      if (process.env.VC26_FINALIZED_EXPORT) writeFileSync(process.env.VC26_FINALIZED_EXPORT, json)
    } finally { network.mockRestore() }
  })
  it('finalizes offline after restart with zero acquisition/network/delivery and preserves the original stopped evidence', async () => {
    const f = await stoppedPhysicalFixture()
    f.disconnect()
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'))
    try {
      const service = new WorkoutHistoryCertification(f.deps)
      const saved = await service.finalizeSaved(target)
      expect(saved).toMatchObject({ state: 'CERTIFIED', sourceStatus: 'CERTIFIED_E2E_LOSSLESS_SOURCE',
        diagnostic: 'VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG', semanticClassification: 'RESEARCH_NATIVE_ONLY',
        canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
        localFinalization: { effects: { bleCommands: 0, acquisition: 0, base44Calls: 0, enqueue: 0, delivery: 0, canonicalization: 0 } } })
      expect(saved.localFinalization!.originalStoppedSnapshot).toEqual(f.stopped)
      expect(saved.acquisition).toEqual(f.stopped.acquisition)
      expect(saved.stoppedSourceCapture).toEqual(f.stopped.stoppedSourceCapture)
      expect(saved.evidence!.physicalWire!.sdkDataEndOriginal).toBe(false)
      expect(saved.evidence!.physicalWire!.sdkRecordsOriginal.map((r) => r.fields))
        .toEqual(VC25_SDK_RECORDS_ORIGINAL.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, typed(v)]))))
      expect(saved.evidence!.physicalWire!.relationships.map((r) => r.status)).toEqual([
        'SDK_RECORD_0_MATCHES_PHYSICAL_WIRE', 'SDK_MULTI_RECORD_PARSE_MISALIGNED', 'SDK_MULTI_RECORD_PARSE_MISALIGNED',
      ])
      expect(saved.evidence!.physicalWire!.packetSha256).toBe(VC25_WORKOUT_CAPTURE.packetSha256)
      const restarted = new WorkoutHistoryCertification(f.deps)
      expect(await restarted.inspectSaved()).toEqual(saved)
      expect(JSON.parse(await restarted.exportSaved())).toEqual(saved)
      expect(await restarted.finalizeSaved(target)).toEqual(saved)
      await expect(restarted.capture()).rejects.toThrow('ALREADY_ATTEMPTED')
      expect(f.deps.acquire).not.toHaveBeenCalled()
      expect(network).not.toHaveBeenCalled()
      expect(f.deps.snapshotStore.writeWorkoutCertificationSnapshot).toHaveBeenCalledTimes(1)
    } finally { network.mockRestore() }
  })
  it.each([
    ['group', (f: Awaited<ReturnType<typeof stoppedPhysicalFixture>>) => { const s = f.saved(); s.certificationGroupId = crypto.randomUUID(); f.setSaved(s) }],
    ['session', (f: Awaited<ReturnType<typeof stoppedPhysicalFixture>>) => { const s = f.saved(); s.acquisition.syncId = 'other'; f.setSaved(s) }],
    ['saved byte changed', (f: Awaited<ReturnType<typeof stoppedPhysicalFixture>>) => { const s = f.saved(); s.stoppedSourceCapture[2].rawBytesBase64 = 'AAAA'; f.setSaved(s) }],
    ['journal changed', (f: Awaited<ReturnType<typeof stoppedPhysicalFixture>>) => { f.edit('ble-0', (j) => { j.sha256 = 'changed' }) }],
    ['parser failed', (f: Awaited<ReturnType<typeof stoppedPhysicalFixture>>) => { f.edit('outcome-0', (j) => { j.status = 'FAILED' }); const s = f.saved(); s.stoppedSourceCapture = [...f.journal.values()]; f.setSaved(s) }],
    ['SDK anchor changed', (f: Awaited<ReturnType<typeof stoppedPhysicalFixture>>) => { const s = f.saved(); s.acquisition.observations[0].sdkRecord = '{}'; f.setSaved(s) }],
    ['extra saved entry', (f: Awaited<ReturnType<typeof stoppedPhysicalFixture>>) => { const s = f.saved(); s.stoppedSourceCapture.push(s.stoppedSourceCapture[0]); f.setSaved(s) }],
  ])('refuses %s without writes, reacquisition or success fallback', async (_, change) => {
    const f = await stoppedPhysicalFixture()
    change(f)
    await expect(f.service.finalizeSaved(target)).rejects.toThrow('WORKOUT_')
    expect(f.saved().state).toBe('STOPPED')
    expect(f.deps.acquire).not.toHaveBeenCalled()
    expect(f.deps.snapshotStore.writeWorkoutCertificationSnapshot).not.toHaveBeenCalled()
  })
  it('rejects wrong explicit target and detects finalization tampering without writing', async () => {
    const f = await stoppedPhysicalFixture()
    await expect(f.service.finalizeSaved({ ...target, sessionId: 'other' })).rejects.toThrow('TARGET_MISMATCH')
    await f.service.finalizeSaved(target)
    const s = f.saved()
    s.evidence.physicalWire.records[1].fields.date = 'corrupted'
    f.setSaved(s)
    await expect(f.service.exportSaved()).rejects.toThrow('SAVED_FINALIZATION_CHANGED')
    expect(f.deps.acquire).not.toHaveBeenCalled()
  })
})

describe('VC25 workout source certification', () => {
  it('certifies one populated workout losslessly without semantic or scoring promotion', async () => {
    const f = await fixture()
    const saved = await f.service.capture()
    expect(saved).toMatchObject({ state: 'CERTIFIED E2E / LOSSLESS CERTIFIED', limitation: null,
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED', deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY',
      evidence: { physicalRecordCount: 1, sdkMetsExposure: 'SDK_FIELD_NOT_EXPOSED',
        metsFinding: 'ANDROID_WORKOUT_METS_NOT_OBSERVED',
        liveType82Relationship: 'UNKNOWN_NO_SESSION_LINK_OR_STREAM_RECONSTRUCTION_PROVEN' } })
    expect(saved.evidence!.records[0].fields).toEqual(Object.fromEntries(Object.entries(vendorRecord).map(([k, v]) => [k, typed(v)])))
    expect(saved.acquisition!.observations[0].vendorTimestamp).toBe(vendorRecord.date)
  })
  it('preserves multiple workouts, repeated records, zeros, nulls, unknown fields and unknown units in source order', async () => {
    const nullRecord = { ...vendorRecord, date: null, heartRate: null, distance: null }
    const f = await fixture([[vendorRecord, vendorRecord], [nullRecord]])
    const saved = await f.service.capture()
    expect(saved.evidence!.physicalRecordCount).toBe(3)
    expect(saved.evidence!.records.map((r) => r.sourceEnvelopeId)).toEqual(['record-0-0', 'record-0-1', 'record-1-0'])
    expect(saved.evidence!.records[0].fields).toEqual(saved.evidence!.records[1].fields)
    expect(saved.evidence!.records[2].fields.heartRate).toBeNull()
    expect(saved.acquisition!.observations[2].vendorTimestamp).toBeNull()
    expect(saved.acquisition!.recordsDeduplicated).toBe(0)
    expect(saved.evidence!.records[0].fields.unknownUnit).toEqual(typed('not-documented'))
  })
  it('closes valid empty terminal history, persists after restart, and inspection/export are read-only and offline', async () => {
    const f = await fixture([[]])
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'))
    try {
      const saved = await f.service.capture()
      expect(saved).toMatchObject({ state: 'CERTIFIED_WITH_LIMITATION', limitation: WORKOUT_EMPTY_LIMITATION })
      f.disconnect()
      const restarted = new WorkoutHistoryCertification(f.deps)
      const writes = vi.mocked(f.deps.snapshotStore.writeWorkoutCertificationSnapshot).mock.calls.length
      expect(await restarted.inspectSaved()).toEqual(saved)
      expect(JSON.parse(await restarted.exportSaved())).toEqual(saved)
      expect(restarted.scopeKey()).toContain(f.context.scope.deviceScopeId)
      await expect(restarted.capture()).rejects.toThrow('ALREADY_ATTEMPTED')
      expect(f.deps.acquire).toHaveBeenCalledTimes(1)
      expect(f.deps.snapshotStore.writeWorkoutCertificationSnapshot).toHaveBeenCalledTimes(writes)
      expect(network).not.toHaveBeenCalled()
    } finally { network.mockRestore() }
  })
  it('preserves 50-callback pagination and an empty terminal callback after populated history without retry', async () => {
    const f = await fixture([...Array.from({ length: 50 }, () => [vendorRecord]), []])
    const saved = await f.service.capture()
    expect(saved.evidence!.physicalRecordCount).toBe(50)
    expect(saved.acquisition!.sourceCommandEnvelopeIds).toHaveLength(2)
    expect(saved.acquisition!.retryCount).toBe(0)
  })
  it('coalesces simultaneous capture and blocks a persisted interrupted attempt after restart', async () => {
    const f = await fixture()
    const first = f.service.capture()
    expect(f.service.capture()).toBe(first)
    await first
    await expect(new WorkoutHistoryCertification(f.deps).capture()).rejects.toThrow('ALREADY_ATTEMPTED')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
    const other = await fixture()
    vi.mocked(other.deps.acquire).mockRejectedValue(new Error('interrupted'))
    await expect(other.service.capture()).rejects.toThrow('interrupted')
    expect(other.saved().state).toBe('STOPPED')
    await expect(new WorkoutHistoryCertification(other.deps).capture()).rejects.toThrow('ALREADY_ATTEMPTED')
  })
  it.each([
    ['wrong command', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.sdkCommand = 'wrong' }],
    ['wrong type', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.vendorDataType = '82' }],
    ['timeout', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.completionStatus = 'FAILED' }],
    ['retry', (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.acquisition, { retryCount: 1 }) }],
    ['dedupe', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.recordsDeduplicated = 1 }],
    ['parse error', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.recordsRejected = 1 }],
    ['dropped notification', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.sourceNotificationEnvelopeIds.push('dropped') }],
    ['missing acknowledgement', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.sourceCommandAckEnvelopeIds = [] }],
    ['parser failed', (f: Awaited<ReturnType<typeof fixture>>) => { f.edit('outcome-0', (json) => { json.status = 'PARTIAL_PARSE_ERROR' }) }],
    ['raw hash', (f: Awaited<ReturnType<typeof fixture>>) => { f.edit('ble-0', (json) => { json.sha256 = 'wrong' }) }],
    ['wrong source', (f: Awaited<ReturnType<typeof fixture>>) => { f.edit('ble-0', (json) => { json.deviceModel = 'OTHER' }) }],
    ['raw after callback', (f: Awaited<ReturnType<typeof fixture>>) => { f.journal.get('ble-0')!.sequence = 99 }],
    ['normalization loss', (f: Awaited<ReturnType<typeof fixture>>) => { f.acquisition.observations[0].vendorTimestamp = 'changed' }],
    ['promotion', (f: Awaited<ReturnType<typeof fixture>>) => { Object.assign(f.acquisition.observations[0], { canonicalAuthority: 'PROMOTED' }) }],
  ])('refuses %s without recapture or empty-success fallback', async (_, change) => {
    const f = await fixture()
    change(f)
    await expect(f.service.capture()).rejects.toThrow('WORKOUT_CERTIFICATION_STOPPED')
    expect(f.saved()).toMatchObject({ state: 'STOPPED', limitation: null })
    await expect(f.service.capture()).rejects.toThrow('ALREADY_ATTEMPTED')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('rejects malformed records without dropping original fields', async () => {
    const record = { ...vendorRecord }
    Reflect.deleteProperty(record, 'heartRate')
    const f = await fixture([[record]])
    await expect(f.service.capture()).rejects.toThrow('REQUIRED_VENDOR_FIELD_MISSING')
    expect(f.saved().acquisition.observations).toHaveLength(1)
    expect(f.saved().stoppedSourceCapture.map((entry: Entry) => JSON.parse(entry.envelopeJson).kind))
      .toContain('SDK_RECORD')
  })
  it('rejects a short SDK-ended response without the raw terminal marker', async () => {
    const f = await fixture([[]])
    const bytes = Uint8Array.from([0x5c, 0])
    const entry = f.journal.get('ble-0')!
    entry.rawBytesBase64 = btoa(String.fromCharCode(...bytes))
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
      .map((b) => b.toString(16).padStart(2, '0')).join('')
    f.edit('ble-0', (json) => { json.sha256 = digest })
    await expect(f.service.capture()).rejects.toThrow('TERMINAL_MARKER_INVALID')
  })
  it('detects saved evidence tampering on inspection without acquisition', async () => {
    const f = await fixture()
    await f.service.capture()
    f.edit('record-0-0', (json) => { json.sourceIndex = 3 })
    await expect(f.service.inspectSaved()).rejects.toThrow('RECORD_LINK_INVALID')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('renders dedicated capture, inspect, show, copy, share controls and copies exact JSON', async () => {
    const f = await fixture()
    const html = renderToStaticMarkup(createElement(WorkoutHistoryCertificationView, {
      service: f.service, busy: false, captureDisabled: false, scopeKey: 'owner:device',
      setBusy: vi.fn(), setActiveSync: vi.fn(),
    }))
    for (const label of ['Capture Workout History Certification', 'Inspect Saved Workout History Certification',
      'Show Workout Certification JSON', 'Copy Workout Certification JSON', 'Share Workout Certification JSON',
      'Finalize Saved Workout History Certification']) expect(html).toContain(label)
    const clipboard = { writeText: vi.fn(async () => {}) }
    await workoutJsonAction('{"zero":0,"null":null}', 'copy', clipboard)
    expect(clipboard.writeText).toHaveBeenCalledWith('{"zero":0,"null":null}')
    await expect(workoutJsonAction('{}', 'copy', null)).rejects.toThrow('Clipboard unavailable')
    expect(f.deps.acquire).not.toHaveBeenCalled()
  })
  it('shares only the saved exact JSON using local filesystem and the platform share sheet', async () => {
    const f = await fixture()
    await f.service.capture()
    const json = await f.service.exportSaved()
    const writes = vi.mocked(f.deps.snapshotStore.writeWorkoutCertificationSnapshot).mock.calls.length
    expect(await workoutJsonAction(json, 'share', null)).toContain('workout.json')
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({
      data: json, path: 'JCVital Workout history certification.json',
    }))
    expect(Share.share).toHaveBeenCalledWith(expect.objectContaining({ files: ['file:///cache/workout.json'] }))
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
    expect(f.deps.snapshotStore.writeWorkoutCertificationSnapshot).toHaveBeenCalledTimes(writes)
  })
})
