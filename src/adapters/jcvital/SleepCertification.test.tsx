import { afterEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import type { NativeObservation } from '../../models/wearableObservation'
import type { JCVitalV8HistoricalSyncResult, JCVitalV8Plugin, JCVitalV8SleepCertificationResult } from './jcvitalV8Bridge'
import type { Type42ConnectedContext } from './Type42Certification'
import { SleepCertification, SLEEP_EMPTY_LIMITATION, SLEEP_HISTORY_PATHS, type SleepCertificationDependencies } from './SleepCertification'
import { SleepCertificationJsonView, SleepCertificationView } from './SleepCertificationView'
import { sleepJsonAction } from './SleepCertificationJson'
import { findPhysiologyContract } from './PhysiologyContract'

vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true }, registerPlugin: vi.fn(() => ({})) }))
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' }, Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile: vi.fn(async () => ({ uri: 'file:///cache/sleep.json' })) },
}))
vi.mock('@capacitor/share', () => ({ Share: { share: vi.fn(async () => ({})) } }))
afterEach(() => vi.restoreAllMocks())

type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
const TIME = '2026-10-05T00:00:00.000Z'
const SESSION = 'physical-sleep-session'
const typed = (value: unknown): unknown => {
  if (value === null) return null
  if (Array.isArray(value)) return { type: 'List', values: value.map(typed) }
  if (value && typeof value === 'object') return {
    type: 'Map', entries: Object.entries(value).map(([key, item]) => ({ key: typed(key), value: typed(item) })),
  }
  return { type: typeof value === 'boolean' ? 'Boolean' : 'String', value }
}
async function fixture(populated = false, mixed = false) {
  const context: Type42ConnectedContext = {
    scope: { accountId: 'sleep-owner', deviceScopeId: 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b' },
    bleAddress: 'AA:BB:CC:DD:EE:FF', firmwareVersion: '1', sdkVersion: 'v8sdk2.0',
    ready: true, physical: true, native: true,
  }
  const header = {
    ...context.scope, provider: 'JCVITAL', sourceConnector: 'JCVITAL_NATIVE',
    acquisitionMode: 'HISTORICAL_SYNC', sessionId: SESSION, sdkVersion: context.sdkVersion, firmwareVersion: context.firmwareVersion,
  }
  const journal = new Map<string, Entry>()
  function write(id: string, values: Record<string, unknown>, rawBytesBase64: string | null = null) {
    journal.set(id, { envelopeId: id, sequence: journal.size + 1, envelopeJson: JSON.stringify({
      ...header, envelopeId: id, ...values,
    }), rawBytesBase64, sourceFile: null })
  }
  const results: JCVitalV8HistoricalSyncResult[] = []
  for (const [index, path] of SLEEP_HISTORY_PATHS.entries()) {
    const hasRecords = populated && (!mixed || index === 0)
    const original = path.dataType === '26'
      ? { date: '2026-10-04 23:00:00', arraySleepQuality: '0 1 2 0 ', sleepUnitLength: '1', unknownNull: null }
      : { date: '2026.10.04 23:00:00', sleepLength: '2', Sleep_level: '[0, A, F, 0]', ActivityData: '[0, B, 0, C]', unknownZero: '000' }
    const records = hasRecords ? (index === 0 ? [original, original] : [original]) : []
    const ids = records.map((_, recordIndex) => `${path.dataType}-record-${recordIndex}`)
    const callbackId = `${path.dataType}-callback`
    const bleId = `${path.dataType}-ble`
    const raw = Uint8Array.from([path.commandByte, 0xff])
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')
    write(bleId, { kind: 'BLE_NOTIFICATION', byteLength: raw.length, sha256: digest }, btoa(String.fromCharCode(...raw)))
    write(callbackId, { kind: 'SDK_CALLBACK', callbackId, callbackIdentifier: 'DataListener2301.dataCallback(Map)',
      vendorDataType: path.dataType, notificationEnvelopeId: bleId, recordEnvelopeIds: ids,
      sdkSnapshot: typed({ dataType: path.dataType, dataEnd: true, dicData: records }) })
    for (const [recordIndex, id] of ids.entries()) write(id, {
      kind: 'SDK_RECORD', vendorDataType: path.dataType, callbackId, notificationEnvelopeId: bleId,
      sourceRecordId: id, sourceRecordGroupId: callbackId, recordIndex, sourceIndex: recordIndex, sdkSnapshot: typed(records[recordIndex]),
    })
    const observations: NativeObservation[] = ids.map((id) => ({
      id: `normalized-${id}`, source: { connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8',
        deviceId: context.bleAddress, macAddress: context.bleAddress, firmwareVersion: '1', sdkVersion: context.sdkVersion },
      metricType: index === 0 ? 'SLEEP_EPISODE' : 'SLEEP_MOVEMENT', observedAt: TIME, observedAtSource: original.date,
      receivedAt: TIME, timezone: 'UTC', value: null, values: [0, 1, 2, 0], unit: 'source_stage_code',
      acquisitionMode: 'SLEEP', measurementContext: 'UNKNOWN_VENDOR_SEMANTICS', sessionId: SESSION,
      packetId: null, sequenceNumber: null, samplingIntervalMs: null, sampleRateHz: null, signalQuality: null,
      completeness: 'COMPLETE', vendorDataType: path.dataType, vendorField: index === 0 ? 'arraySleepQuality' : 'ActivityData',
      vendorDerived: false, rawPayload: {}, provenance: { sourceEnvelopeId: id, sourceRecordId: id,
        sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
    }))
    results.push({ syncId: SESSION, deviceId: context.bleAddress, provider: 'JCVITAL',
      sdkCommand: path.command, vendorDataType: path.dataType, startedAt: TIME, completedAt: TIME,
      recordsReceived: observations.length, recordGroupsReceived: ids.length, recordsStored: 0,
      recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: hasRecords ? TIME : null,
      latestObservation: hasRecords ? TIME : null, partial: false, completionStatus: hasRecords ? 'COMPLETE' : 'EMPTY_VALID',
      packetCount: 1, parseErrors: [], observations, sourceRecordEnvelopeIds: ids, sourceCallbackEnvelopeIds: [callbackId] })
  }
  const acquisition: JCVitalV8SleepCertificationResult = {
    acquisitionSessionId: SESSION, outcome: 'COMPLETE', acquisitionError: null, results,
  }
  const stored = new Map<string, string>()
  const key = (scope: { accountId: string; deviceScopeId: string }) => JSON.stringify(scope)
  const deps: SleepCertificationDependencies = {
    acquire: vi.fn(async () => structuredClone(acquisition)), owner: () => context.scope.accountId,
    connectedContext: () => context,
    journal: { readSourceEnvelope: vi.fn(async ({ envelopeId }) => {
      const entry = journal.get(envelopeId)
      if (!entry) throw new Error('Missing source')
      return structuredClone(entry)
    }) },
    snapshotStore: {
      readSleepCertificationSnapshot: vi.fn(async (scope) => ({ json: stored.get(key(scope)) ?? null })),
      writeSleepCertificationSnapshot: vi.fn(async ({ json, ...scope }) => { stored.set(key(scope), json); return { saved: true } }),
    },
  }
  const edit = (id: string, change: (json: Record<string, unknown>) => void) => {
    const entry = journal.get(id)!
    const json = JSON.parse(entry.envelopeJson)
    change(json)
    entry.envelopeJson = JSON.stringify(json)
  }
  return { deps, context, acquisition, journal, stored, edit, service: new SleepCertification(deps) }
}

describe('VC24 Sleep history source certification', () => {
  it('closes two physically evidenced empty histories with the formal limitation and persists after restart', async () => {
    const f = await fixture()
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network prohibited'))
    const saved = await f.service.capture()
    expect(saved).toMatchObject({ state: 'CERTIFIED_WITH_LIMITATION', limitation: SLEEP_EMPTY_LIMITATION,
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED', deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY',
      evidence: { physicalRecordCount: 0, discoveredFields: [] } })
    expect(saved.evidence!.entries.map((entry) => JSON.parse(entry.envelopeJson).kind))
      .toEqual(['SDK_CALLBACK', 'BLE_NOTIFICATION', 'SDK_CALLBACK', 'BLE_NOTIFICATION'])
    expect(saved.evidence!.entries.filter((entry) => entry.rawBytesBase64)).toHaveLength(2)
    const restarted = new SleepCertification(f.deps)
    f.context.ready = false
    expect(await restarted.inspectSaved()).toEqual(saved)
    expect(JSON.parse(await restarted.exportSaved())).toEqual(saved)
    await expect(restarted.capture()).rejects.toThrow('SLEEP_CAPTURE_ALREADY_ATTEMPTED')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
    expect(network).not.toHaveBeenCalled()
  })
  it.each([false, true])('certifies populated history without losing repeated records original strings hex zeros or unknown fields (mixed=%s)', async (mixed) => {
    const f = await fixture(true, mixed)
    const saved = await f.service.capture()
    expect(saved.state).toBe('CERTIFIED')
    expect(saved.limitation).toBeNull()
    expect(saved.evidence!.physicalRecordCount).toBe(mixed ? 2 : 3)
    expect(saved.evidence!.discoveredFields[0].fields).toMatchObject({
      arraySleepQuality: { type: 'String', value: '0 1 2 0 ' }, unknownNull: null,
    })
    expect(saved.evidence!.discoveredFields[1].fields).toEqual(saved.evidence!.discoveredFields[0].fields)
    expect(saved.acquisition!.results.flatMap((result) => result.observations)
      .every((observation) => findPhysiologyContract(observation) === null)).toBe(true)
    if (!mixed) expect(saved.evidence!.discoveredFields[2].fields).toMatchObject({
      Sleep_level: { type: 'String', value: '[0, A, F, 0]' },
      ActivityData: { type: 'String', value: '[0, B, 0, C]' }, unknownZero: { type: 'String', value: '000' },
    })
    const json = await new SleepCertification(f.deps).exportSaved()
    expect(JSON.parse(json)).toEqual(saved)
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('joins concurrent capture calls and saves the acquisition latch before touching the device', async () => {
    const f = await fixture()
    vi.mocked(f.deps.acquire).mockImplementationOnce(async () => {
      expect((await f.service.snapshot())!.state).toBe('ACQUIRING')
      return f.acquisition
    })
    const first = f.service.capture()
    expect(f.service.capture()).toBe(first)
    await first
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('preserves completed first-path evidence and the native failure without claiming empty closeout', async () => {
    const f = await fixture(true)
    f.acquisition.outcome = 'FAILED'
    f.acquisition.acquisitionError = { code: 'CONNECTION_LOST', message: 'Movement history disconnected' }
    f.acquisition.results.pop()
    await expect(f.service.capture()).rejects.toThrow('CONNECTION_LOST')
    const saved = await f.service.snapshot()
    expect(saved).toMatchObject({ state: 'STOPPED', limitation: null, acquisition: {
      acquisitionSessionId: SESSION, outcome: 'FAILED', acquisitionError: { code: 'CONNECTION_LOST' },
    } })
    expect(saved!.acquisition!.results[0].sourceRecordEnvelopeIds).toHaveLength(2)
    expect(JSON.parse(await new SleepCertification(f.deps).exportSaved()).acquisition).toEqual(f.acquisition)
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('blocks reacquisition after an interrupted durable ACQUIRING checkpoint', async () => {
    const f = await fixture()
    await f.service.capture()
    const [key, json] = [...f.stored.entries()][0]
    f.stored.set(key, JSON.stringify({ ...JSON.parse(json), state: 'ACQUIRING', evidence: null, acquisition: null, limitation: null }))
    await expect(new SleepCertification(f.deps).capture()).rejects.toThrow('SLEEP_CAPTURE_ALREADY_ATTEMPTED')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('retains ordered pagination callbacks including the final zero-record terminal packet', async () => {
    const f = await fixture(true)
    const result = f.acquisition.results[0]
    f.edit('26-callback', (json) => {
      const original = [
        { date: '2026-10-04 23:00:00', arraySleepQuality: '0 1 2 0 ', sleepUnitLength: '1', unknownNull: null },
        { date: '2026-10-04 23:00:00', arraySleepQuality: '0 1 2 0 ', sleepUnitLength: '1', unknownNull: null },
      ]
      json.sdkSnapshot = typed({ dataType: '26', dataEnd: false, dicData: original })
    })
    const terminal = structuredClone(f.journal.get('26-callback')!)
    terminal.envelopeId = '26-terminal-callback'
    terminal.sequence = f.journal.size + 1
    const json = JSON.parse(terminal.envelopeJson)
    Object.assign(json, { envelopeId: terminal.envelopeId, callbackId: terminal.envelopeId,
      recordEnvelopeIds: [], sdkSnapshot: typed({ dataType: '26', dataEnd: true, dicData: [] }) })
    terminal.envelopeJson = JSON.stringify(json)
    f.journal.set(terminal.envelopeId, terminal)
    result.sourceCallbackEnvelopeIds!.push(terminal.envelopeId)
    result.packetCount++
    const saved = await f.service.capture()
    expect(saved.state).toBe('CERTIFIED')
    expect(saved.evidence!.physicalRecordCount).toBe(3)
    expect(saved.evidence!.entries.some((entry) => entry.envelopeId === terminal.envelopeId)).toBe(true)
    expect((await new SleepCertification(f.deps).inspectSaved())!.state).toBe('CERTIFIED')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it.each([0, 1])('does not accept SDK short-frame empty status without physical terminal evidence on path %i', async (index) => {
    const f = await fixture()
    const path = SLEEP_HISTORY_PATHS[index]
    const raw = Uint8Array.from([path.commandByte, 0])
    const sha = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
      .map((byte) => byte.toString(16).padStart(2, '0')).join('')
    f.journal.get(`${path.dataType}-ble`)!.rawBytesBase64 = btoa(String.fromCharCode(...raw))
    f.edit(`${path.dataType}-ble`, (json) => { json.sha256 = sha })
    await expect(f.service.capture()).rejects.toThrow('SLEEP_EMPTY_TERMINAL_MARKER_MISSING')
    expect((await f.service.snapshot())!.state).toBe('STOPPED')
  })
  it.each(['failed', 'partial', 'rejected', 'deduplicated', 'packetCount', 'missingCallbacks', 'missingRecords', 'missingPath',
    'wrongType', 'wrongCommand', 'wrongSession', 'wrongDevice', 'counts', 'zeroNormalizedPopulated'] as const)(
    'fails closed for %s instead of certifying empty history', async (kind) => {
      const f = await fixture(kind === 'zeroNormalizedPopulated')
      const result = f.acquisition.results[0]
      if (kind === 'failed') result.completionStatus = 'FAILED'
      if (kind === 'partial') result.partial = true
      if (kind === 'rejected') result.recordsRejected = 1
      if (kind === 'deduplicated') result.recordsDeduplicated = 1
      if (kind === 'packetCount') result.packetCount = 0
      if (kind === 'missingCallbacks') delete result.sourceCallbackEnvelopeIds
      if (kind === 'missingRecords') delete result.sourceRecordEnvelopeIds
      if (kind === 'missingPath') f.acquisition.results.pop()
      if (kind === 'wrongType') result.vendorDataType = '24'
      if (kind === 'wrongCommand') result.sdkCommand = 'GetTotalActivityDataWithMode'
      if (kind === 'wrongSession') result.syncId = 'other'
      if (kind === 'wrongDevice') result.deviceId = 'other'
      if (kind === 'counts') result.recordGroupsReceived = 1
      if (kind === 'zeroNormalizedPopulated') {
        result.completionStatus = 'EMPTY_VALID'
        result.observations = []
        result.recordsReceived = 0
      }
      await expect(f.service.capture()).rejects.toThrow('SLEEP_CERTIFICATION_STOPPED')
      expect(await f.service.snapshot()).toMatchObject({ state: 'STOPPED', limitation: null })
      await expect(new SleepCertification(f.deps).capture()).rejects.toThrow('SLEEP_CAPTURE_ALREADY_ATTEMPTED')
      expect(f.deps.acquire).toHaveBeenCalledTimes(1)
    },
  )
  it.each(['end', 'list', 'callbackScope', 'callbackSession', 'rawHash', 'rawLength', 'rawCommand', 'rawMissing',
    'recordLink', 'recordSnapshot', 'recordField'] as const)('rejects corrupt %s source evidence', async (kind) => {
    const f = await fixture(kind.startsWith('record'))
    if (kind === 'end' || kind === 'list') f.edit('26-callback', (json) => {
      json.sdkSnapshot = typed({ dataType: '26', dataEnd: kind !== 'end', dicData: kind === 'list' ? {} : [] })
    })
    if (kind === 'callbackScope') f.edit('26-callback', (json) => { json.accountId = 'other' })
    if (kind === 'callbackSession') f.edit('26-callback', (json) => { json.sessionId = 'other' })
    if (kind === 'rawHash') f.edit('26-ble', (json) => { json.sha256 = 'bad' })
    if (kind === 'rawLength') f.edit('26-ble', (json) => { json.byteLength = 50 })
    if (kind === 'rawCommand') f.journal.get('26-ble')!.rawBytesBase64 = btoa(String.fromCharCode(0x51, 0xff))
    if (kind === 'rawMissing') f.journal.get('26-ble')!.rawBytesBase64 = null
    if (kind === 'recordLink') f.edit('26-record-0', (json) => { json.recordIndex = 3 })
    if (kind === 'recordSnapshot') f.edit('26-record-0', (json) => { json.sdkSnapshot = typed({ date: 'invented' }) })
    if (kind === 'recordField') {
      const invalid = { date: TIME, arraySleepQuality: '0 1', sleepUnitLength: null }
      f.edit('26-record-0', (json) => { json.sdkSnapshot = typed(invalid) })
      f.edit('26-callback', (json) => { json.sdkSnapshot = typed({ dataType: '26', dataEnd: true, dicData: [invalid, invalid] }) })
    }
    await expect(f.service.capture()).rejects.toThrow('SLEEP_CERTIFICATION_STOPPED')
    expect((await f.service.snapshot())!.state).toBe('STOPPED')
  })
  it.each(['ready', 'native', 'physical'] as const)('requires %s for capture but never for local export', async (flag) => {
    const f = await fixture()
    f.context[flag] = false
    await expect(f.service.capture()).rejects.toThrow('SLEEP_PHYSICAL_NATIVE_READY_REQUIRED')
    expect(f.deps.acquire).not.toHaveBeenCalled()
    expect(f.stored.size).toBe(0)
  })
  it('refuses acquisition when the initial durable checkpoint is not confirmed', async () => {
    const f = await fixture()
    vi.mocked(f.deps.snapshotStore.writeSleepCertificationSnapshot).mockResolvedValueOnce({ saved: false })
    await expect(f.service.capture()).rejects.toThrow('SLEEP_PERSISTENCE_NOT_CONFIRMED')
    expect(f.deps.acquire).not.toHaveBeenCalled()
  })
  it('does not certify acquisition rejection as empty or retry after restart', async () => {
    const f = await fixture()
    vi.mocked(f.deps.acquire).mockRejectedValueOnce(new Error('Disconnected'))
    await expect(f.service.capture()).rejects.toThrow('Disconnected')
    expect(await f.service.snapshot()).toMatchObject({ state: 'STOPPED', reason: 'Disconnected' })
    await expect(new SleepCertification(f.deps).capture()).rejects.toThrow('SLEEP_CAPTURE_ALREADY_ATTEMPTED')
  })
  it('revalidates the journal before export and does not reacquire if source evidence changes', async () => {
    const f = await fixture()
    await f.service.capture()
    f.edit('26-ble', (json) => { json.sha256 = 'modified' })
    await expect(new SleepCertification(f.deps).exportSaved()).rejects.toThrow('SLEEP_RAW_BLE_HASH_LENGTH_OR_COMMAND_INVALID')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('prevents account/device scope leakage', async () => {
    const f = await fixture()
    await f.service.capture()
    f.context.scope.accountId = 'other-owner'
    expect(await new SleepCertification(f.deps).inspectSaved()).toBeNull()
    await expect(f.service.exportSaved()).rejects.toThrow('NO_SAVED_SLEEP_CERTIFICATION')
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
  it('renders all dedicated controls and displays full unchanged JSON without acquisition', async () => {
    const f = await fixture()
    const json = await f.service.capture().then(() => f.service.exportSaved())
    const controls = renderToStaticMarkup(createElement(SleepCertificationView, {
      service: f.service, busy: false, captureDisabled: true, scopeKey: 'scope',
      setBusy: vi.fn(), setActiveSync: vi.fn(),
    }))
    for (const label of ['Capture Sleep History Certification', 'Inspect Saved Sleep Certification',
      'Show Sleep Certification JSON', 'Copy Sleep Certification JSON', 'Share / Save Sleep Certification JSON']) expect(controls).toContain(label)
    const display = renderToStaticMarkup(createElement(SleepCertificationJsonView, { json }))
    expect(display).toContain(SLEEP_EMPTY_LIMITATION)
    const clipboard = { writeText: vi.fn(async () => {}) }
    await sleepJsonAction(json, 'copy', clipboard)
    expect(clipboard.writeText).toHaveBeenCalledWith(json)
    await sleepJsonAction(json, 'share')
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ data: json }))
    expect(Share.share).toHaveBeenCalled()
    expect(f.deps.acquire).toHaveBeenCalledTimes(1)
  })
})
