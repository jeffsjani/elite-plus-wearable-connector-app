import type { JCVitalV8Plugin, JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import type { Type42ConnectedContext } from './Type42Certification'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import { sha256Hex } from './HeartRateSeries'
import { serializeCertificationJson } from './CertificationJsonExport'

export const SLEEP_CERTIFICATION_FILENAME = 'JCVital Sleep history certification.json'
export const SLEEP_EMPTY_LIMITATION = 'PHYSICAL_SLEEP_HISTORY_VALID_BUT_EMPTY'
export const SLEEP_HISTORY_PATHS = [
  { dataType: '26', command: 'GetDetailSleepDataWithMode', commandByte: 0x53,
    parser: 'ResolveUtil.getSleepData', fields: ['date', 'arraySleepQuality', 'sleepUnitLength'] },
  { dataType: '121', command: 'getObtainDetailedSleepData', commandByte: 0x6b,
    parser: 'ResolveUtil.getObtainDetailedSleepData', fields: ['date', 'sleepLength', 'Sleep_level', 'ActivityData'] },
] as const
type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type Acquisition = Awaited<ReturnType<JCVitalV8Plugin['syncSleepCertification']>>
type JsonObject = Record<string, unknown>
export interface SleepCertificationDependencies {
  acquire(): Promise<Acquisition>
  journal: Pick<JCVitalV8Plugin, 'readSourceEnvelope'>
  snapshotStore: Pick<JCVitalV8Plugin, 'readSleepCertificationSnapshot' | 'writeSleepCertificationSnapshot'>
  connectedContext(): Type42ConnectedContext
  owner(): string | null
}
export interface SleepEvidence {
  entries: Entry[]
  fingerprints: Array<{ envelopeId: string; sha256: string }>
  discoveredFields: Array<{ sourceEnvelopeId: string; vendorDataType: string; fields: JsonObject }>
  physicalRecordCount: number
}
export interface SleepCertificationSnapshot {
  kind: 'SleepCertification'
  version: 1
  certificationGroupId: string
  context: Type42ConnectedContext
  capturedAt: string
  finalizedAt: string | null
  state: 'ACQUIRING' | 'CAPTURED' | 'STOPPED' | 'CERTIFIED' | 'CERTIFIED_WITH_LIMITATION'
  limitation: typeof SLEEP_EMPTY_LIMITATION | null
  reason: string | null
  canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
  deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY'
  acquisition: Acquisition | null
  evidence: SleepEvidence | null
}
function object(value: unknown): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('SLEEP_INVALID_TYPED_OBJECT')
  return value as JsonObject
}
function fields(snapshot: unknown): JsonObject {
  const map = object(snapshot)
  if (map.type !== 'Map' || !Array.isArray(map.entries)) throw new Error('SLEEP_SDK_MAP_REQUIRED')
  const result: JsonObject = {}
  for (const entry of map.entries) {
    const item = object(entry)
    const key = object(item.key)
    if (key.type !== 'String' || typeof key.value !== 'string' || Object.hasOwn(result, key.value)) {
      throw new Error('SLEEP_INVALID_OR_DUPLICATE_FIELD')
    }
    Object.defineProperty(result, key.value, { value: item.value, enumerable: true })
  }
  return result
}
function stringValue(value: unknown): string {
  const typed = object(value)
  if (typed.type !== 'String' || typeof typed.value !== 'string') throw new Error('SLEEP_ORIGINAL_STRING_REQUIRED')
  return typed.value
}

/** Source certification only; this service has no transport or scoring dependency. */
export class SleepCertification {
  private readonly deps: SleepCertificationDependencies
  private operation: Promise<SleepCertificationSnapshot> | null = null
  constructor(deps: SleepCertificationDependencies) { this.deps = deps }
  private context(): Type42ConnectedContext {
    const context = this.deps.connectedContext()
    if (!this.deps.owner() || this.deps.owner() !== context.scope.accountId
      || !isOpaqueJCVitalDeviceId(context.scope.deviceScopeId)) throw new Error('SLEEP_AUTHENTICATED_SCOPE_REQUIRED')
    return structuredClone(context)
  }
  private assertScope(context: Type42ConnectedContext) {
    const current = this.context()
    if (JSON.stringify(current.scope) !== JSON.stringify(context.scope)) throw new Error('SLEEP_SCOPE_CHANGED')
  }
  private async save(snapshot: SleepCertificationSnapshot) {
    this.assertScope(snapshot.context)
    const saved = await this.deps.snapshotStore.writeSleepCertificationSnapshot({
      ...snapshot.context.scope, json: JSON.stringify(snapshot),
    })
    this.assertScope(snapshot.context)
    if (!saved.saved) throw new Error('SLEEP_PERSISTENCE_NOT_CONFIRMED')
  }
  async snapshot(): Promise<SleepCertificationSnapshot | null> {
    const context = this.context()
    const { json } = await this.deps.snapshotStore.readSleepCertificationSnapshot(context.scope)
    this.assertScope(context)
    if (!json) return null
    const saved: SleepCertificationSnapshot = JSON.parse(json)
    if (saved.kind !== 'SleepCertification' || saved.version !== 1
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.certificationGroupId)
      || JSON.stringify(saved.context.scope) !== JSON.stringify(context.scope)
      || saved.canonicalAuthority !== 'NONE_UNTIL_SEMANTICS_CONFIRMED'
      || saved.deliveryDisposition !== 'LOCAL_SOURCE_EVIDENCE_ONLY'
      || !saved.context.native || !saved.context.physical || !saved.context.ready
      || !Number.isFinite(Date.parse(saved.capturedAt))
      || !['ACQUIRING', 'CAPTURED', 'STOPPED', 'CERTIFIED', 'CERTIFIED_WITH_LIMITATION'].includes(saved.state)) {
      throw new Error('SLEEP_SAVED_SCHEMA_OR_SCOPE_INVALID')
    }
    return saved
  }
  private async evidence(context: Type42ConnectedContext, acquisition: Acquisition): Promise<SleepEvidence> {
    if (acquisition.outcome !== 'COMPLETE' || acquisition.acquisitionError !== null) {
      throw new Error(`SLEEP_ACQUISITION_FAILED: ${acquisition.acquisitionError?.code ?? acquisition.outcome}`
        + `${acquisition.acquisitionError ? `: ${acquisition.acquisitionError.message}` : ''}`)
    }
    if (!acquisition.acquisitionSessionId || acquisition.results.length !== 2) throw new Error('SLEEP_BOTH_HISTORY_PATHS_REQUIRED')
    const entries = new Map<string, Entry>()
    const fingerprints: SleepEvidence['fingerprints'] = []
    const discoveredFields: SleepEvidence['discoveredFields'] = []
    let physicalRecordCount = 0
    const read = async (id: string, kind: string) => {
      if (!id) throw new Error('SLEEP_SOURCE_ENVELOPE_ID_MISSING')
      const entry = await this.deps.journal.readSourceEnvelope({ ...context.scope, envelopeId: id })
      this.assertScope(context)
      const json = object(JSON.parse(entry.envelopeJson))
      if (entry.envelopeId !== id || json.envelopeId !== id || json.kind !== kind
        || json.accountId !== context.scope.accountId || json.deviceScopeId !== context.scope.deviceScopeId
        || json.provider !== 'JCVITAL' || json.sourceConnector !== 'JCVITAL_NATIVE'
        || json.acquisitionMode !== 'HISTORICAL_SYNC' || json.sessionId !== acquisition.acquisitionSessionId
        || json.sdkVersion !== context.sdkVersion || json.firmwareVersion !== context.firmwareVersion) {
        throw new Error('SLEEP_SOURCE_ANCESTRY_INVALID')
      }
      if (!entries.has(id)) {
        entries.set(id, entry)
        fingerprints.push({ envelopeId: id, sha256: await sha256Hex(entry.envelopeJson) })
      } else if (JSON.stringify(entries.get(id)) !== JSON.stringify(entry)) throw new Error('SLEEP_SOURCE_CHANGED_DURING_READ')
      return { entry, json }
    }
    for (const [pathIndex, path] of SLEEP_HISTORY_PATHS.entries()) {
      const result: JCVitalV8HistoricalSyncResult = acquisition.results[pathIndex]
      const callbackIds = result.sourceCallbackEnvelopeIds
      const recordIds = result.sourceRecordEnvelopeIds
      if (result.vendorDataType !== path.dataType || result.sdkCommand !== path.command
        || result.syncId !== acquisition.acquisitionSessionId || result.deviceId !== context.bleAddress
        || result.provider !== 'JCVITAL' || !Number.isFinite(Date.parse(result.startedAt))
        || !Number.isFinite(Date.parse(result.completedAt)) || Date.parse(result.completedAt) < Date.parse(result.startedAt)
        || !['COMPLETE', 'EMPTY_VALID'].includes(result.completionStatus) || result.partial
        || result.parseErrors.length || result.recordsRejected !== 0 || result.recordsDeduplicated !== 0
        || result.recordsStored !== 0 || result.recordsReceived !== result.observations.length
        || !callbackIds?.length || new Set(callbackIds).size !== callbackIds.length
        || result.packetCount !== callbackIds.length || !recordIds || new Set(recordIds).size !== recordIds.length) {
        throw new Error(`SLEEP_HISTORY_NOT_COMPLETE_OR_VALID: ${path.dataType}`)
      }
      const linkedRecordIds: string[] = []
      for (const [index, callbackId] of callbackIds.entries()) {
        const callback = await read(callbackId, 'SDK_CALLBACK')
        const c = callback.json
        const snapshotFields = fields(c.sdkSnapshot)
        const data = object(snapshotFields.dicData)
        const end = object(snapshotFields.dataEnd)
        if (c.vendorDataType !== path.dataType || c.callbackId !== callbackId
          || c.callbackIdentifier !== 'DataListener2301.dataCallback(Map)'
          || stringValue(snapshotFields.dataType) !== path.dataType
          || data.type !== 'List' || !Array.isArray(data.values) || !Array.isArray(c.recordEnvelopeIds)
          || c.recordEnvelopeIds.length !== data.values.length
          || end.type !== 'Boolean' || end.value !== (index === callbackIds.length - 1)
          || typeof c.notificationEnvelopeId !== 'string') throw new Error('SLEEP_CALLBACK_COMPLETENESS_INVALID')
        const notification = await read(c.notificationEnvelopeId, 'BLE_NOTIFICATION')
        const base64 = notification.entry.rawBytesBase64
        if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
          throw new Error('SLEEP_RAW_BLE_BYTES_MISSING')
        }
        const raw = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
        const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', raw)))
          .map((byte) => byte.toString(16).padStart(2, '0')).join('')
        if (raw.length < 2 || raw[0] !== path.commandByte || raw.length !== notification.json.byteLength
          || digest !== notification.json.sha256) throw new Error('SLEEP_RAW_BLE_HASH_LENGTH_OR_COMMAND_INVALID')
        // Both SDK parsers label short frames empty/end even without a terminal marker.
        if (data.values.length === 0 && end.value === true
          && (raw.at(-1) !== 0xff || (path.dataType === '26' && raw.at(-2) !== path.commandByte))) {
          throw new Error('SLEEP_EMPTY_TERMINAL_MARKER_MISSING')
        }
        for (const [recordIndex, recordId] of c.recordEnvelopeIds.entries()) {
          if (typeof recordId !== 'string') throw new Error('SLEEP_RECORD_LINK_INVALID')
          const record = await read(recordId, 'SDK_RECORD')
          const r = record.json
          if (r.vendorDataType !== path.dataType || r.callbackId !== callbackId
            || r.notificationEnvelopeId !== c.notificationEnvelopeId || r.sourceRecordId !== recordId
            || r.sourceRecordGroupId !== callbackId || r.recordIndex !== recordIndex || r.sourceIndex !== recordIndex
            || JSON.stringify(r.sdkSnapshot) !== JSON.stringify(data.values[recordIndex])) throw new Error('SLEEP_RECORD_LINK_INVALID')
          const original = fields(r.sdkSnapshot)
          path.fields.forEach((name) => { stringValue(original[name]) })
          discoveredFields.push({ sourceEnvelopeId: recordId, vendorDataType: path.dataType, fields: original })
          linkedRecordIds.push(recordId)
        }
      }
      if (JSON.stringify(linkedRecordIds) !== JSON.stringify(recordIds) || result.recordGroupsReceived !== recordIds.length
        || (result.completionStatus === 'EMPTY_VALID' && (recordIds.length !== 0 || result.observations.length !== 0))
        || (result.completionStatus === 'COMPLETE' && (recordIds.length === 0 || result.observations.length === 0))) {
        throw new Error('SLEEP_RECORD_COUNTS_OR_EMPTY_STATE_INVALID')
      }
      for (const observation of result.observations) {
        if (!recordIds.includes(observation.provenance.sourceEnvelopeId ?? '')
          || observation.sessionId !== acquisition.acquisitionSessionId || observation.vendorDataType !== path.dataType
          || observation.source.connector !== 'JCVITAL_NATIVE' || observation.source.provider !== 'JCVITAL'
          || !['SLEEP_EPISODE', 'SLEEP_STAGE', 'SLEEP_STAGE_DETAIL_RAW', 'SLEEP_MOVEMENT'].includes(observation.metricType)) {
          throw new Error('SLEEP_NORMALIZED_SOURCE_LINK_INVALID')
        }
      }
      physicalRecordCount += recordIds.length
    }
    return { entries: [...entries.values()], fingerprints, discoveredFields, physicalRecordCount }
  }
  capture(): Promise<SleepCertificationSnapshot> {
    if (this.operation) return this.operation
    this.operation = this.captureOnce().finally(() => { this.operation = null })
    return this.operation
  }
  private async captureOnce(): Promise<SleepCertificationSnapshot> {
    if (await this.snapshot()) throw new Error('SLEEP_CAPTURE_ALREADY_ATTEMPTED: inspect saved evidence; no automatic reacquisition')
    const context = this.context()
    if (!context.ready || !context.native || !context.physical) throw new Error('SLEEP_PHYSICAL_NATIVE_READY_REQUIRED')
    const saved: SleepCertificationSnapshot = {
      kind: 'SleepCertification', version: 1, certificationGroupId: crypto.randomUUID(), context,
      capturedAt: new Date().toISOString(), finalizedAt: null, state: 'ACQUIRING', reason: null, limitation: null,
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED', deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY',
      acquisition: null, evidence: null,
    }
    await this.save(saved)
    try {
      saved.acquisition = await this.deps.acquire()
      this.assertScope(context)
      saved.state = 'CAPTURED'
      await this.save(saved)
      saved.evidence = await this.evidence(context, saved.acquisition)
      saved.state = saved.evidence.physicalRecordCount ? 'CERTIFIED' : 'CERTIFIED_WITH_LIMITATION'
      saved.limitation = saved.evidence.physicalRecordCount ? null : SLEEP_EMPTY_LIMITATION
      saved.finalizedAt = new Date().toISOString()
      await this.save(saved)
      return saved
    } catch (error) {
      saved.state = 'STOPPED'
      saved.limitation = null
      saved.finalizedAt = null
      saved.reason = error instanceof Error ? error.message : String(error)
      await this.save(saved)
      throw new Error(`SLEEP_CERTIFICATION_STOPPED: ${saved.reason}`, { cause: error })
    }
  }
  async inspectSaved(): Promise<SleepCertificationSnapshot | null> {
    const saved = await this.snapshot()
    if (!saved) return null
    if (saved.state === 'CERTIFIED' || saved.state === 'CERTIFIED_WITH_LIMITATION') {
      if (!saved.acquisition || !saved.evidence) throw new Error('SLEEP_CERTIFIED_EVIDENCE_MISSING')
      const current = await this.evidence(saved.context, saved.acquisition)
      if (JSON.stringify(current) !== JSON.stringify(saved.evidence)
        || saved.state !== (current.physicalRecordCount ? 'CERTIFIED' : 'CERTIFIED_WITH_LIMITATION')
        || saved.limitation !== (current.physicalRecordCount ? null : SLEEP_EMPTY_LIMITATION)
        || saved.reason !== null || !saved.finalizedAt || !Number.isFinite(Date.parse(saved.finalizedAt))) {
        throw new Error('SLEEP_CERTIFICATION_EVIDENCE_CHANGED')
      }
    }
    return saved
  }
  async exportSaved(): Promise<string> {
    const saved = await this.inspectSaved()
    if (!saved) throw new Error('NO_SAVED_SLEEP_CERTIFICATION')
    return serializeCertificationJson(saved)
  }
}
