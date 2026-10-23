import type { JCVitalV8Plugin, WorkoutHistoryAcquisition } from './jcvitalV8Bridge'
import type { Type42ConnectedContext } from './Type42Certification'
import { isOpaqueJCVitalDeviceId } from '../../services/storage/JCVitalDeviceIdentityService'
import { sha256Hex } from './HeartRateSeries'
import { serializeCertificationJson } from './CertificationJsonExport'
import { decodeType29PhysicalPacket, decodeType29VendorFields, TYPE29_WIRE_LAYOUT, VC25_WORKOUT_CAPTURE } from './Type29PhysicalWire'
import type { Type29PhysicalRecord } from './Type29PhysicalWire'

export const WORKOUT_HISTORY_PATH = {
  command: 'GetActivityModeDataWithMode', opcode: 0x5c, dataType: '29',
  parser: 'com.jstyle.blesdkv8.other.ResolveUtil.getExerciseData',
  fields: ['date', 'sportModel', 'heartRate', 'ExerciseTime', 'step', 'sportModelSpeed', 'calories', 'distance'],
} as const
export const WORKOUT_EMPTY_LIMITATION = 'PHYSICAL_WORKOUT_HISTORY_VALID_BUT_EMPTY'
export const WORKOUT_CERTIFICATION_FILENAME = 'JCVital Workout history certification.json'
export const WORKOUT_FIELD_SEMANTICS = {
  date: { sdkShape: 'yyyy.MM.dd HH:mm:ss', timestampRole: 'UNKNOWN_START_VS_END', timezone: 'NOT_ENCODED' },
  sportModel: { sdkShape: 'unsigned byte rendered as string', modeMapping: 'SDK_TABLE_ONLY_NOT_PHYSICALLY_CONFIRMED' },
  heartRate: { vendorSampleUnit: 'bpm', statistic: 'UNKNOWN_NOT_PROVEN_AVERAGE_OR_FINAL' },
  ExerciseTime: { vendorSampleUnit: 'seconds', physicalUnitConfidence: 'NOT_CONFIRMED' },
  step: { vendorSampleUnit: 'step count', physicalUnitConfidence: 'NOT_CONFIRMED' },
  sportModelSpeed: { sdkShape: 'two bytes formatted as MM\'SS"', unit: 'UNKNOWN_VENDOR_SEMANTICS' },
  calories: { vendorSampleUnit: 'kcal', physicalUnitConfidence: 'NOT_CONFIRMED' },
  distance: { vendorSampleUnit: 'km', physicalUnitConfidence: 'NOT_CONFIRMED' },
} as const
type Entry = Awaited<ReturnType<JCVitalV8Plugin['readSourceEnvelope']>>
type ObjectValue = Record<string, unknown>
export interface WorkoutHistoryCertificationDependencies {
  acquire(): Promise<WorkoutHistoryAcquisition>
  journal: Pick<JCVitalV8Plugin, 'readWorkoutSourceEnvelope'>
  snapshotStore: Pick<JCVitalV8Plugin, 'readWorkoutCertificationSnapshot' | 'writeWorkoutCertificationSnapshot'>
  connectedContext(): Type42ConnectedContext | null
  owner(): string | null
  contextStore?: Pick<Storage, 'getItem' | 'setItem'>
}
export interface WorkoutHistoryEvidence {
  sdkPath: typeof WORKOUT_HISTORY_PATH
  fieldSemantics: typeof WORKOUT_FIELD_SEMANTICS
  entries: Entry[]
  fingerprints: Array<{ envelopeId: string; sha256: string }>
  records: Array<{ sourceEnvelopeId: string; callbackId: string; sourceIndex: number; fields: ObjectValue }>
  physicalRecordCount: number
  metsFinding: 'ANDROID_WORKOUT_METS_NOT_OBSERVED' | 'SDK_FIELD_PRESENT_PHYSICAL_VALUE_NOT_OBSERVED' | 'PHYSICAL_VENDOR_FIELD_OBSERVED_SEMANTICS_UNKNOWN'
  sdkMetsExposure: 'SDK_FIELD_NOT_EXPOSED'
  liveType82Relationship: 'UNKNOWN_NO_SESSION_LINK_OR_STREAM_RECONSTRUCTION_PROVEN'
  physicalWire?: {
    layout: typeof TYPE29_WIRE_LAYOUT
    packetSha256: string
    terminal: { byteOffset: number; hex: '5C FF' }
    records: Array<Type29PhysicalRecord & { notificationEnvelopeId: string; sdkRecordEnvelopeId: string }>
    sdkRecordsOriginal: Array<WorkoutHistoryEvidence['records'][number] & { kind: 'SDK_RECORD_ORIGINAL' }>
    relationships: Array<{ sourceIndex: number; sdkRecordEnvelopeId: string; physicalFrameSha256: string
      status: 'SDK_RECORD_0_MATCHES_PHYSICAL_WIRE' | 'SDK_MULTI_RECORD_PARSE_MISALIGNED' }>
    sdkDataEndOriginal: false
    sdkParserOutcomeOriginal: 'COMPLETE'
  }
}
export interface WorkoutHistoryCertificationSnapshot {
  kind: 'WorkoutHistoryCertification'
  version: 1
  certificationGroupId: string
  context: Type42ConnectedContext
  capturedAt: string
  finalizedAt: string | null
  state: 'ACQUIRING' | 'CAPTURED' | 'STOPPED' | 'CERTIFIED' | 'CERTIFIED E2E / LOSSLESS CERTIFIED' | 'CERTIFIED_WITH_LIMITATION'
  limitation: typeof WORKOUT_EMPTY_LIMITATION | null
  reason: string | null
  canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
  deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY'
  acquisition: WorkoutHistoryAcquisition | null
  evidence: WorkoutHistoryEvidence | null
  stoppedSourceCapture: Entry[] | null
  sourceStatus?: 'CERTIFIED_E2E_LOSSLESS_SOURCE'
  diagnostic?: 'VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG'
  semanticClassification?: 'RESEARCH_NATIVE_ONLY'
  localFinalization?: {
    originalStoppedSnapshot: WorkoutHistoryCertificationSnapshot
    originalStoppedSnapshotSha256: string
    effects: { bleCommands: 0; acquisition: 0; base44Calls: 0; enqueue: 0; delivery: 0; canonicalization: 0 }
  }
}
function object(value: unknown): ObjectValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('WORKOUT_TYPED_OBJECT_REQUIRED')
  return value as ObjectValue
}
function fields(value: unknown): ObjectValue {
  const map = object(value)
  if (map.type !== 'Map' || !Array.isArray(map.entries)) throw new Error('WORKOUT_SDK_MAP_REQUIRED')
  const result: ObjectValue = {}
  for (const entry of map.entries) {
    const item = object(entry)
    const key = stringValue(item.key)
    if (Object.hasOwn(result, key)) throw new Error('WORKOUT_DUPLICATE_SDK_KEY')
    Object.defineProperty(result, key, { value: item.value, enumerable: true })
  }
  return result
}
function stringValue(value: unknown): string {
  const typed = object(value)
  if (typed.type !== 'String' || typeof typed.value !== 'string') throw new Error('WORKOUT_ORIGINAL_STRING_REQUIRED')
  return typed.value
}
function ids(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)
    || new Set(value).size !== value.length) throw new Error('WORKOUT_SOURCE_IDS_INVALID')
  return value
}

export class WorkoutHistoryCertification {
  private operation: Promise<WorkoutHistoryCertificationSnapshot> | null = null
  private readonly deps: WorkoutHistoryCertificationDependencies
  constructor(deps: WorkoutHistoryCertificationDependencies) { this.deps = deps }
  private context() {
    const owner = this.deps.owner()
    const live = this.deps.connectedContext()
    const cached = owner ? this.deps.contextStore?.getItem(`workoutCertificationContext.v1:${owner}`) : null
    const context: Type42ConnectedContext | null = live ?? (cached ? { ...JSON.parse(cached), ready: false } : null)
    if (!context) throw new Error('WORKOUT_SAVED_OR_CONNECTED_CONTEXT_REQUIRED')
    if (!this.deps.owner() || this.deps.owner() !== context.scope.accountId
      || !isOpaqueJCVitalDeviceId(context.scope.deviceScopeId)) throw new Error('WORKOUT_AUTHENTICATED_SCOPE_REQUIRED')
    return structuredClone(context)
  }
  scopeKey(): string | null {
    const owner = this.deps.owner()
    const context = this.deps.connectedContext()
    if (context) return `${owner}:${context.scope.deviceScopeId}`
    const cached = owner ? this.deps.contextStore?.getItem(`workoutCertificationContext.v1:${owner}`) : null
    if (!cached) return null
    const saved: Type42ConnectedContext = JSON.parse(cached)
    if (saved.scope.accountId !== owner || !isOpaqueJCVitalDeviceId(saved.scope.deviceScopeId)) {
      throw new Error('WORKOUT_SAVED_CONTEXT_INVALID')
    }
    return `${owner}:${saved.scope.deviceScopeId}`
  }
  private assertScope(context: Type42ConnectedContext) {
    if (JSON.stringify(this.context().scope) !== JSON.stringify(context.scope)) throw new Error('WORKOUT_SCOPE_CHANGED')
  }
  private async save(snapshot: WorkoutHistoryCertificationSnapshot) {
    this.assertScope(snapshot.context)
    const result = await this.deps.snapshotStore.writeWorkoutCertificationSnapshot({
      ...snapshot.context.scope, json: JSON.stringify(snapshot),
    })
    this.assertScope(snapshot.context)
    if (!result.saved) throw new Error('WORKOUT_PERSISTENCE_NOT_CONFIRMED')
  }
  async snapshot(): Promise<WorkoutHistoryCertificationSnapshot | null> {
    const context = this.context()
    const { json } = await this.deps.snapshotStore.readWorkoutCertificationSnapshot(context.scope)
    this.assertScope(context)
    if (!json) return null
    const saved: WorkoutHistoryCertificationSnapshot = JSON.parse(json)
    if (saved.kind !== 'WorkoutHistoryCertification' || saved.version !== 1
      || JSON.stringify(saved.context.scope) !== JSON.stringify(context.scope)
      || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(saved.certificationGroupId)
      || saved.canonicalAuthority !== 'NONE_UNTIL_SEMANTICS_CONFIRMED'
      || saved.deliveryDisposition !== 'LOCAL_SOURCE_EVIDENCE_ONLY'
      || !saved.context.native || !saved.context.physical || !saved.context.ready
      || !Number.isFinite(Date.parse(saved.capturedAt))
      || !['ACQUIRING', 'CAPTURED', 'STOPPED', 'CERTIFIED', 'CERTIFIED E2E / LOSSLESS CERTIFIED', 'CERTIFIED_WITH_LIMITATION'].includes(saved.state)) {
      throw new Error('WORKOUT_SAVED_SCHEMA_OR_SCOPE_INVALID')
    }
    return saved
  }
  private async evidence(context: Type42ConnectedContext, result: WorkoutHistoryAcquisition,
    stoppedSourceCapture?: Entry[]): Promise<WorkoutHistoryEvidence> {
    const repair = stoppedSourceCapture !== undefined
    const callbacks = ids(result.sourceCallbackEnvelopeIds)
    const recordIds = ids(result.sourceRecordEnvelopeIds)
    const notifications = ids(result.sourceNotificationEnvelopeIds)
    const outcomes = ids(result.sourceParserOutcomeEnvelopeIds)
    const commands = ids(result.sourceCommandEnvelopeIds)
    const acks = ids(result.sourceCommandAckEnvelopeIds)
    if (result.sdkCommand !== WORKOUT_HISTORY_PATH.command || result.vendorDataType !== '29'
      || result.provider !== 'JCVITAL' || result.deviceId !== context.bleAddress || !result.syncId
      || !Number.isFinite(Date.parse(result.startedAt)) || !Number.isFinite(Date.parse(result.completedAt))
      || Date.parse(result.completedAt) < Date.parse(result.startedAt)
      || (repair ? result.completionStatus !== 'PARTIAL' || !result.partial
        : !['COMPLETE', 'EMPTY_VALID'].includes(result.completionStatus) || result.partial)
      || result.parseErrors.length || result.recordsRejected !== 0 || result.recordsDeduplicated !== 0
      || result.recordsStored !== 0 || result.retryCount !== 0
      || result.canonicalAuthority !== 'NONE_UNTIL_SEMANTICS_CONFIRMED'
      || result.deliveryDisposition !== 'LOCAL_SOURCE_EVIDENCE_ONLY'
      || !callbacks.length || result.packetCount !== callbacks.length
      || notifications.length !== callbacks.length || outcomes.length !== notifications.length
      || commands.length !== Math.floor((callbacks.length - 1) / 50) + 1 || acks.length !== commands.length) {
      throw new Error('WORKOUT_HISTORY_INCOMPLETE_OR_INVALID')
    }
    const entries = new Map<string, Entry>()
    const records: WorkoutHistoryEvidence['records'] = []
    let physicalWire: WorkoutHistoryEvidence['physicalWire']
    const read = async (id: string, kind: string) => {
      const entry = await this.deps.journal.readWorkoutSourceEnvelope({ ...context.scope, envelopeId: id })
      this.assertScope(context)
      if (repair && JSON.stringify(entry) !== JSON.stringify(stoppedSourceCapture.find((item) => item.envelopeId === id))) {
        throw new Error('WORKOUT_STOPPED_SOURCE_CHANGED')
      }
      const json = object(JSON.parse(entry.envelopeJson))
      if (entry.envelopeId !== id || json.envelopeId !== id || json.kind !== kind
        || json.accountId !== context.scope.accountId || json.deviceScopeId !== context.scope.deviceScopeId
        || json.deviceModel !== 'PRO_V8' || json.provider !== 'JCVITAL' || json.sourceConnector !== 'JCVITAL_NATIVE'
        || json.acquisitionMode !== 'HISTORICAL_SYNC' || json.sessionId !== result.syncId
        || json.sdkVersion !== context.sdkVersion || json.firmwareVersion !== context.firmwareVersion
        || !Number.isInteger(entry.sequence) || entry.sequence < 1) throw new Error('WORKOUT_SOURCE_ANCESTRY_INVALID')
      if (entries.has(id) && JSON.stringify(entries.get(id)) !== JSON.stringify(entry)) throw new Error('WORKOUT_SOURCE_CHANGED')
      entries.set(id, entry)
      return { entry, json }
    }
    const raw = async (id: string, kind: string) => {
      const source = await read(id, kind)
      const base64 = source.entry.rawBytesBase64
      if (!base64 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) {
        throw new Error('WORKOUT_RAW_BYTES_REQUIRED')
      }
      const bytes = Uint8Array.from(atob(base64), (ch) => ch.charCodeAt(0))
      const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
        .map((byte) => byte.toString(16).padStart(2, '0')).join('')
      if (bytes[0] !== 0x5c || bytes.length !== source.json.byteLength || digest !== source.json.sha256) {
        throw new Error('WORKOUT_RAW_HASH_LENGTH_OR_OPCODE_INVALID')
      }
      return { ...source, bytes }
    }
    const commandSequences: number[] = []
    for (const [index, id] of commands.entries()) {
      const request = await raw(id, 'WORKOUT_COMMAND_REQUEST')
      const ack = await raw(acks[index], 'WORKOUT_COMMAND_WRITE_ACK')
      if (request.bytes.length !== 16 || request.bytes[1] !== (index === 0 ? 0 : 2)
        || request.json.sdkCommand !== WORKOUT_HISTORY_PATH.command || ack.json.sdkCommand !== WORKOUT_HISTORY_PATH.command
        || request.json.vendorDataType !== '29' || ack.json.vendorDataType !== '29'
        || request.json.callbackIdentifier !== 'BleSDK.GetActivityModeDataWithMode(byte)'
        || ack.json.callbackIdentifier !== 'BluetoothGattCallback.onCharacteristicWrite'
        || request.bytes.slice(2, 15).some((byte) => byte !== 0)
        || request.bytes[15] !== (request.bytes.slice(0, 15).reduce((sum, byte) => sum + byte, 0) & 255)
        || ack.json.parentEnvelopeId !== id || ack.json.sha256 !== request.json.sha256
        || ack.entry.sequence <= request.entry.sequence) throw new Error('WORKOUT_COMMAND_OR_ACK_INVALID')
      commandSequences.push(request.entry.sequence)
    }
    let previousCallbackSequence = 0
    for (const [index, callbackId] of callbacks.entries()) {
      const callback = await read(callbackId, 'SDK_CALLBACK')
      const c = callback.json
      const original = fields(c.sdkSnapshot)
      const data = object(original.dicData)
      const end = object(original.dataEnd)
      const terminal = index === callbacks.length - 1
      if (c.callbackId !== callbackId || c.vendorDataType !== '29'
        || c.callbackIdentifier !== 'DataListener2301.dataCallback(Map)'
        || stringValue(original.dataType) !== '29' || data.type !== 'List' || !Array.isArray(data.values)
        || end.type !== 'Boolean' || end.value !== (repair ? false : terminal)
        || c.notificationEnvelopeId !== notifications[index]) throw new Error('WORKOUT_CALLBACK_INVALID')
      const linkedIds = ids(c.recordEnvelopeIds)
      if (linkedIds.length !== data.values.length) throw new Error('WORKOUT_RECORD_COUNT_INVALID')
      const notification = await raw(notifications[index], 'BLE_NOTIFICATION')
      const outcome = await read(outcomes[index], 'SDK_PARSE_OUTCOME')
      if (outcome.json.notificationEnvelopeId !== notifications[index] || outcome.json.status !== 'COMPLETE'
        || outcome.json.mapCallbackCount !== 1 || outcome.json.errorClass !== null
        || notification.entry.sequence >= callback.entry.sequence || outcome.entry.sequence <= callback.entry.sequence
        || callback.entry.sequence <= previousCallbackSequence
        || commandSequences[Math.floor(index / 50)] >= notification.entry.sequence) {
        throw new Error('WORKOUT_PARSER_OR_SOURCE_ORDER_INVALID')
      }
      previousCallbackSequence = callback.entry.sequence
      const stride = repair ? 26 : 25
      const expectedLength = linkedIds.length * stride + (terminal ? 2 : 0)
      if (notification.bytes.length !== expectedLength
        || (terminal && (notification.bytes.at(-2) !== 0x5c || notification.bytes.at(-1) !== 0xff))
        || (!terminal && linkedIds.length === 0)
        || linkedIds.some((_, i) => notification.bytes[i * stride] !== 0x5c)) {
        throw new Error('WORKOUT_RAW_RECORD_FRAMING_OR_TERMINAL_MARKER_INVALID')
      }
      if (repair) {
        const packet = await decodeType29PhysicalPacket(notification.bytes)
        if (callbacks.length !== 1 || packet.records.length !== 3 || notification.bytes.length !== 80
          || packet.rawBytesBase64 !== VC25_WORKOUT_CAPTURE.packetBase64
          || packet.packetSha256 !== VC25_WORKOUT_CAPTURE.packetSha256) {
          throw new Error('WORKOUT_EXACT_VC25_PACKET_REQUIRED')
        }
        physicalWire = {
          layout: TYPE29_WIRE_LAYOUT, packetSha256: packet.packetSha256, terminal: packet.terminal,
          records: packet.records.map((record, i) => ({ ...record, notificationEnvelopeId: notifications[index],
            sdkRecordEnvelopeId: linkedIds[i] })),
          sdkRecordsOriginal: [], relationships: [], sdkDataEndOriginal: false, sdkParserOutcomeOriginal: 'COMPLETE',
        }
      }
      for (const [sourceIndex, id] of linkedIds.entries()) {
        const source = await read(id, 'SDK_RECORD')
        const r = source.json
        if (r.callbackId !== callbackId || r.vendorDataType !== '29' || r.notificationEnvelopeId !== notifications[index]
          || r.sourceRecordId !== id || r.sourceRecordGroupId !== callbackId
          || r.sourceIndex !== sourceIndex || r.recordIndex !== sourceIndex
          || source.entry.sequence !== callback.entry.sequence + sourceIndex + 1 || source.entry.sequence >= outcome.entry.sequence
          || JSON.stringify(r.sdkSnapshot) !== JSON.stringify(data.values[sourceIndex])) throw new Error('WORKOUT_RECORD_LINK_INVALID')
        const vendorFields = fields(r.sdkSnapshot)
        for (const name of WORKOUT_HISTORY_PATH.fields) {
          if (!Object.hasOwn(vendorFields, name)) throw new Error('WORKOUT_REQUIRED_VENDOR_FIELD_MISSING')
          if (vendorFields[name] !== null) stringValue(vendorFields[name])
        }
        records.push({ sourceEnvelopeId: id, callbackId, sourceIndex, fields: vendorFields })
        if (physicalWire) {
          const decoded = decodeType29VendorFields(notification.bytes, sourceIndex * 25).fields
          const frame = physicalWire.records[sourceIndex]
          for (const name of WORKOUT_HISTORY_PATH.fields) {
            if (stringValue(vendorFields[name]) !== decoded[name]
              || (sourceIndex === 0 && stringValue(vendorFields[name]) !== frame.fields[name])) {
              throw new Error('WORKOUT_VENDOR_STRIDE_OR_FIRST_FRAME_ANCHOR_MISMATCH')
            }
          }
          physicalWire.sdkRecordsOriginal.push({ ...records.at(-1)!, kind: 'SDK_RECORD_ORIGINAL' })
          physicalWire.relationships.push({ sourceIndex, sdkRecordEnvelopeId: id, physicalFrameSha256: frame.sha256,
            status: sourceIndex === 0 ? 'SDK_RECORD_0_MATCHES_PHYSICAL_WIRE' : 'SDK_MULTI_RECORD_PARSE_MISALIGNED' })
        }
        const observation = result.observations[records.length - 1]
        if (!observation || observation.id !== id || observation.sourceEnvelopeId !== id
          || observation.sourceCallbackId !== callbackId || observation.sourceIndex !== sourceIndex
          || observation.vendorDataType !== '29' || observation.sessionId !== result.syncId
          || observation.metricType !== 'WORKOUT_HISTORY_NATIVE_SOURCE'
          || observation.canonicalAuthority !== 'NONE_UNTIL_SEMANTICS_CONFIRMED'
          || observation.semanticClassification !== 'RESEARCH_NATIVE_ONLY'
          || observation.semanticConfidence !== 'UNKNOWN_VENDOR_SEMANTICS'
          || observation.vendorTimestamp !== (vendorFields.date === null ? null : stringValue(vendorFields.date))
          || JSON.stringify(JSON.parse(observation.sdkRecord)) !== JSON.stringify(r.sdkSnapshot)) {
          throw new Error('WORKOUT_NATIVE_OBSERVATION_NOT_LOSSLESS')
        }
      }
    }
    if (JSON.stringify(records.map((record) => record.sourceEnvelopeId)) !== JSON.stringify(recordIds)
      || result.recordsReceived !== records.length || result.recordGroupsReceived !== records.length
      || result.observations.length !== records.length
      || result.completionStatus !== (repair ? 'PARTIAL' : records.length ? 'COMPLETE' : 'EMPTY_VALID')) throw new Error('WORKOUT_FINAL_COUNTS_INVALID')
    const ordered = [...entries.values()].sort((a, b) => a.sequence - b.sequence)
    if (new Set(ordered.map((entry) => entry.sequence)).size !== ordered.length) throw new Error('WORKOUT_DUPLICATE_SOURCE_SEQUENCE')
    const metsValues = records.flatMap((record) => Object.entries(record.fields)
      .filter(([name]) => /^mets?$/i.test(name)).map(([, value]) => value))
    return {
      sdkPath: WORKOUT_HISTORY_PATH, fieldSemantics: WORKOUT_FIELD_SEMANTICS,
      entries: ordered,
      fingerprints: await Promise.all(ordered.map(async (entry) => ({
        envelopeId: entry.envelopeId, sha256: await sha256Hex(entry.envelopeJson),
      }))),
      records, physicalRecordCount: records.length,
      sdkMetsExposure: 'SDK_FIELD_NOT_EXPOSED',
      metsFinding: !metsValues.length ? 'ANDROID_WORKOUT_METS_NOT_OBSERVED'
        : metsValues.every((value) => value === null) ? 'SDK_FIELD_PRESENT_PHYSICAL_VALUE_NOT_OBSERVED'
          : 'PHYSICAL_VENDOR_FIELD_OBSERVED_SEMANTICS_UNKNOWN',
      liveType82Relationship: 'UNKNOWN_NO_SESSION_LINK_OR_STREAM_RECONSTRUCTION_PROVEN',
      ...(physicalWire ? { physicalWire } : {}),
    }
  }
  capture(): Promise<WorkoutHistoryCertificationSnapshot> {
    if (this.operation) return this.operation
    this.operation = this.captureOnce().finally(() => { this.operation = null })
    return this.operation
  }
  private async captureOnce(): Promise<WorkoutHistoryCertificationSnapshot> {
    if (await this.snapshot()) throw new Error('WORKOUT_CAPTURE_ALREADY_ATTEMPTED: inspect saved evidence')
    const context = this.context()
    if (!context.native || !context.physical || !context.ready) throw new Error('WORKOUT_PHYSICAL_NATIVE_READY_REQUIRED')
    const saved: WorkoutHistoryCertificationSnapshot = {
      kind: 'WorkoutHistoryCertification', version: 1, certificationGroupId: crypto.randomUUID(), context,
      capturedAt: new Date().toISOString(), finalizedAt: null, state: 'ACQUIRING', limitation: null, reason: null,
      canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED', deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY',
      acquisition: null, evidence: null,
      stoppedSourceCapture: null,
    }
    await this.save(saved)
    this.deps.contextStore?.setItem(`workoutCertificationContext.v1:${context.scope.accountId}`, JSON.stringify(context))
    try {
      saved.acquisition = await this.deps.acquire()
      this.assertScope(context)
      saved.state = 'CAPTURED'
      await this.save(saved)
      saved.stoppedSourceCapture = []
      const sourceIds = new Set([
        ...ids(saved.acquisition.sourceCommandEnvelopeIds), ...ids(saved.acquisition.sourceCommandAckEnvelopeIds),
        ...ids(saved.acquisition.sourceNotificationEnvelopeIds), ...ids(saved.acquisition.sourceParserOutcomeEnvelopeIds),
        ...ids(saved.acquisition.sourceCallbackEnvelopeIds), ...ids(saved.acquisition.sourceRecordEnvelopeIds),
      ])
      for (const envelopeId of sourceIds) {
        saved.stoppedSourceCapture.push(await this.deps.journal.readWorkoutSourceEnvelope({ ...context.scope, envelopeId }))
        this.assertScope(context)
      }
      saved.stoppedSourceCapture.sort((a, b) => a.sequence - b.sequence)
      await this.save(saved)
      saved.evidence = await this.evidence(context, saved.acquisition)
      if (JSON.stringify(saved.evidence.entries) !== JSON.stringify(saved.stoppedSourceCapture)) {
        throw new Error('WORKOUT_SOURCE_CHANGED_DURING_VALIDATION')
      }
      saved.stoppedSourceCapture = null
      saved.state = saved.evidence.physicalRecordCount ? 'CERTIFIED E2E / LOSSLESS CERTIFIED' : 'CERTIFIED_WITH_LIMITATION'
      saved.limitation = saved.evidence.physicalRecordCount ? null : WORKOUT_EMPTY_LIMITATION
      saved.finalizedAt = new Date().toISOString()
      await this.save(saved)
      return saved
    } catch (error) {
      saved.state = 'STOPPED'
      saved.reason = error instanceof Error ? error.message : String(error)
      saved.limitation = null
      saved.finalizedAt = null
      await this.save(saved)
      throw new Error(`WORKOUT_CERTIFICATION_STOPPED: ${saved.reason}`, { cause: error })
    }
  }
  async inspectSaved(): Promise<WorkoutHistoryCertificationSnapshot | null> {
    const saved = await this.snapshot()
    if (!saved) return null
    if (saved.state === 'CERTIFIED') {
      const original = saved.localFinalization?.originalStoppedSnapshot
      if (!original || !saved.evidence) throw new Error('WORKOUT_LOCAL_FINALIZATION_PROOF_REQUIRED')
      this.assertRepairTarget(original)
      const current = await this.evidence(original.context, original.acquisition!, original.stoppedSourceCapture!)
      if (saved.certificationGroupId !== original.certificationGroupId
        || JSON.stringify(saved.context) !== JSON.stringify(original.context)
        || saved.capturedAt !== original.capturedAt
        || JSON.stringify(saved.acquisition) !== JSON.stringify(original.acquisition)
        || JSON.stringify(saved.stoppedSourceCapture) !== JSON.stringify(original.stoppedSourceCapture)
        || JSON.stringify(current) !== JSON.stringify(saved.evidence)
        || saved.localFinalization!.originalStoppedSnapshotSha256 !== await sha256Hex(JSON.stringify(original))
        || saved.sourceStatus !== 'CERTIFIED_E2E_LOSSLESS_SOURCE'
        || saved.diagnostic !== 'VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG'
        || saved.semanticClassification !== 'RESEARCH_NATIVE_ONLY'
        || saved.reason !== null || saved.limitation !== null
        || !saved.finalizedAt || !Number.isFinite(Date.parse(saved.finalizedAt))
        || JSON.stringify(saved.localFinalization!.effects) !== JSON.stringify(this.localEffects())) {
        throw new Error('WORKOUT_SAVED_FINALIZATION_CHANGED')
      }
      return saved
    }
    if (saved.state === 'CERTIFIED E2E / LOSSLESS CERTIFIED' || saved.state === 'CERTIFIED_WITH_LIMITATION') {
      if (!saved.acquisition || !saved.evidence) throw new Error('WORKOUT_CERTIFIED_EVIDENCE_MISSING')
      const current = await this.evidence(saved.context, saved.acquisition)
      if (JSON.stringify(current) !== JSON.stringify(saved.evidence)
        || saved.state !== (current.physicalRecordCount ? 'CERTIFIED E2E / LOSSLESS CERTIFIED' : 'CERTIFIED_WITH_LIMITATION')
        || saved.limitation !== (current.physicalRecordCount ? null : WORKOUT_EMPTY_LIMITATION)
        || saved.stoppedSourceCapture !== null || saved.reason !== null
        || !saved.finalizedAt || !Number.isFinite(Date.parse(saved.finalizedAt))) {
        throw new Error('WORKOUT_SAVED_EVIDENCE_CHANGED')
      }
    }
    return saved
  }
  private localEffects() {
    return { bleCommands: 0, acquisition: 0, base44Calls: 0, enqueue: 0, delivery: 0, canonicalization: 0 } as const
  }
  private assertRepairTarget(saved: WorkoutHistoryCertificationSnapshot) {
    if (saved.state !== 'STOPPED' || saved.reason !== 'WORKOUT_HISTORY_INCOMPLETE_OR_INVALID'
      || saved.certificationGroupId !== VC25_WORKOUT_CAPTURE.certificationGroupId
      || saved.acquisition?.syncId !== VC25_WORKOUT_CAPTURE.sessionId
      || saved.acquisition.recordsReceived !== 3 || saved.acquisition.packetCount !== 1
      || !saved.stoppedSourceCapture || saved.stoppedSourceCapture.length !== 8
      || new Set(saved.stoppedSourceCapture.map((entry) => entry.envelopeId)).size !== 8
      || saved.evidence !== null || saved.finalizedAt !== null || saved.limitation !== null
      || saved.localFinalization || saved.sourceStatus || saved.diagnostic
      || saved.canonicalAuthority !== 'NONE_UNTIL_SEMANTICS_CONFIRMED'
      || saved.deliveryDisposition !== 'LOCAL_SOURCE_EVIDENCE_ONLY') {
      throw new Error('WORKOUT_EXACT_VC25_STOPPED_SNAPSHOT_REQUIRED')
    }
  }
  finalizeSaved(expected: { certificationGroupId: string; sessionId: string }): Promise<WorkoutHistoryCertificationSnapshot> {
    if (expected.certificationGroupId !== VC25_WORKOUT_CAPTURE.certificationGroupId
      || expected.sessionId !== VC25_WORKOUT_CAPTURE.sessionId) {
      return Promise.reject(new Error('WORKOUT_FINALIZATION_TARGET_MISMATCH'))
    }
    if (this.operation) return Promise.reject(new Error('WORKOUT_OPERATION_IN_PROGRESS'))
    this.operation = this.finalizeSavedOnce().finally(() => { this.operation = null })
    return this.operation
  }
  private async finalizeSavedOnce(): Promise<WorkoutHistoryCertificationSnapshot> {
    const saved = await this.snapshot()
    if (!saved) throw new Error('NO_SAVED_WORKOUT_CERTIFICATION')
    if (saved.state === 'CERTIFIED') return (await this.inspectSaved())!
    this.assertRepairTarget(saved)
    const evidence = await this.evidence(saved.context, saved.acquisition!, saved.stoppedSourceCapture!)
    if (JSON.stringify(evidence.entries) !== JSON.stringify(saved.stoppedSourceCapture)) {
      throw new Error('WORKOUT_STOPPED_SOURCE_CHANGED')
    }
    const original = structuredClone(saved)
    saved.evidence = evidence
    saved.state = 'CERTIFIED'
    saved.sourceStatus = 'CERTIFIED_E2E_LOSSLESS_SOURCE'
    saved.diagnostic = 'VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG'
    saved.semanticClassification = 'RESEARCH_NATIVE_ONLY'
    saved.reason = null
    saved.finalizedAt = new Date().toISOString()
    saved.localFinalization = { originalStoppedSnapshot: original,
      originalStoppedSnapshotSha256: await sha256Hex(JSON.stringify(original)), effects: this.localEffects() }
    await this.save(saved)
    return (await this.inspectSaved())!
  }
  async exportSaved(): Promise<string> {
    const saved = await this.inspectSaved()
    if (!saved) throw new Error('NO_SAVED_WORKOUT_CERTIFICATION')
    return serializeCertificationJson(saved)
  }
}
