import type { NativeObservation } from '../../models/wearableObservation'
import type { JCVitalV8HistoricalSyncResult } from './jcvitalV8Bridge'
import { PpiCertification, type PpiCertificationDependencies, type PpiCertificationInspection } from './PpiCertification'
import { PpiCertificationAttempt, type PpiAttemptEvent, type PpiAttemptRecord } from './PpiCertificationAttempt'
import type { Type42ConnectedContext } from './Type42Certification'

export type PpiCertificationResumeDependencies = Omit<PpiCertificationDependencies, 'acquire'>

export interface PpiResumeOperationCounts {
  /** Count of real `syncHistoricalPpi()` SDK calls made by this resume attempt; must remain 0. */
  syncHistoricalPpiCalls: number
  /** Count of real BLE history acquisitions performed by this resume attempt; must remain 0. */
  bleHistoryAcquisitions: number
}

interface ResumeHistoryDetails {
  syncId: string
  startedAt: string
  completedAt: string
  completionStatus: JCVitalV8HistoricalSyncResult['completionStatus']
  partial: boolean
  recordsReceived: number
  recordGroupsReceived: number
  packetCount: number
}

function historyDetails(event: PpiAttemptEvent): ResumeHistoryDetails {
  const details = event.details as Partial<ResumeHistoryDetails> | null
  if (!details || typeof details.syncId !== 'string' || typeof details.startedAt !== 'string'
    || typeof details.completedAt !== 'string' || typeof details.completionStatus !== 'string'
    || typeof details.partial !== 'boolean' || typeof details.recordsReceived !== 'number'
    || typeof details.recordGroupsReceived !== 'number' || typeof details.packetCount !== 'number') {
    throw new Error('Last PPI attempt has no usable HISTORY_REQUEST_COMPLETED diagnostic to resume from.')
  }
  return details as ResumeHistoryDetails
}

function candidateIds(event: PpiAttemptEvent): string[] {
  const details = event.details as { candidates?: Array<{ sourceEnvelopeId?: unknown }> } | null
  const ids = (details?.candidates ?? []).map((candidate) => candidate.sourceEnvelopeId)
    .filter((id): id is string => typeof id === 'string')
  if (!ids.length) throw new Error('Last PPI attempt recorded zero type-127 certification candidates to resume.')
  return ids
}

/**
 * Resumes PPI certification purely from the last persisted physical attempt's journal evidence. It performs
 * zero `syncHistoricalPpi()` calls and zero BLE history acquisitions: the candidate list and acquisition
 * window it replays are read back from the attempt diagnostic exactly as the live `captureOnce()` recorded
 * them (same deterministic candidate order), and every child observation is reconstructed strictly from the
 * already-durable SDK_RECORD/SDK_CALLBACK/BLE_NOTIFICATION ancestry in the connected journal - never fabricated.
 * It then drives the unchanged `PpiCertification` pipeline (corrected metadata alignment, unchanged PPI mapper,
 * unchanged deterministic slot selection, exact-ID delivery, snapshot save, and certification JSON export).
 */
export class PpiCertificationResume {
  private readonly deps: PpiCertificationResumeDependencies
  readonly service: PpiCertification
  private readonly counts: PpiResumeOperationCounts = { syncHistoricalPpiCalls: 0, bleHistoryAcquisitions: 0 }
  private synthetic: JCVitalV8HistoricalSyncResult | null = null

  constructor(deps: PpiCertificationResumeDependencies) {
    this.deps = deps
    this.service = new PpiCertification({
      ...deps,
      acquire: async () => {
        // Never calls the real plugin's syncHistoricalPpi(): the synthetic sync is pre-built from the journal below.
        if (!this.synthetic) throw new Error('PPI resume sync was not prepared from the last attempt before capture.')
        return this.synthetic
      },
    })
  }

  operationCounts(): PpiResumeOperationCounts { return { ...this.counts } }

  private storage() { return (this.deps.storage ?? (() => localStorage))() }

  /** Read-only: the last attempt diagnostic this resume would replay, without acquiring or delivering anything. */
  readLastAttempt(owner: string, deviceScopeId: string): PpiAttemptRecord {
    return new PpiCertificationAttempt(() => this.storage()).read(owner, deviceScopeId)
  }

  async resume(): Promise<PpiCertificationInspection> {
    const context = structuredClone(this.deps.connectedContext())
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner || owner !== context.scope.accountId) throw new Error('PPI resume requires the authenticated connected owner.')
    const record = this.readLastAttempt(owner, context.scope.deviceScopeId)
    const history = record.events.find((event) => event.stage === 'HISTORY_REQUEST_COMPLETED')
    const candidateGroups = record.events.find((event) => event.stage === 'CANDIDATE_GROUPS')
    if (!history || !candidateGroups) throw new Error('Last PPI attempt has no recorded acquisition to resume from.')
    const details = historyDetails(history)
    const ids = candidateIds(candidateGroups)
    // Same deterministic order the normal certification path recorded; never re-derived or hard-coded.
    const observations = await Promise.all(ids.map((id) => this.reconstruct(context, id)))
    this.synthetic = {
      syncId: details.syncId, deviceId: context.bleAddress, provider: 'JCVITAL', sdkCommand: 'RESUME_FROM_EXISTING_JOURNAL',
      vendorDataType: '127', startedAt: details.startedAt, completedAt: details.completedAt,
      recordsReceived: details.recordsReceived, recordGroupsReceived: details.recordGroupsReceived,
      recordsStored: 0, recordsDeduplicated: 0, recordsRejected: 0, earliestObservation: null, latestObservation: null,
      partial: details.partial, completionStatus: details.completionStatus, packetCount: details.packetCount,
      parseErrors: [], observations,
    }
    const captured = await this.service.capture()
    return captured.group ? this.service.flushSaved() : captured
  }

  /**
   * Reconstructs the exact NativeObservation the live acquisition would have normalized, straight from the
   * already-durable journal ancestry (SDK_RECORD -> SDK_CALLBACK -> BLE_NOTIFICATION, fully re-verified by
   * `readSourceEvidence`); it never invents source data.
   */
  private async reconstruct(context: Type42ConnectedContext, id: string): Promise<NativeObservation> {
    const source = await this.service.readSourceEvidence(context, id)
    const r = source.record.json as { sourceDate?: unknown; observedAt?: unknown; receivedAt?: unknown; timezone?: unknown; sessionId?: unknown }
    if (typeof r.sourceDate !== 'string' || typeof r.observedAt !== 'string' || typeof r.receivedAt !== 'string') {
      throw new Error(`PPI journal record ${id} is missing required source metadata to resume.`)
    }
    return {
      id: `resumed-${id}`,
      source: {
        connector: 'JCVITAL_NATIVE', provider: 'JCVITAL', deviceModel: 'PRO_V8', deviceId: context.bleAddress,
        macAddress: context.bleAddress, firmwareVersion: context.firmwareVersion, sdkVersion: context.sdkVersion,
      },
      metricType: 'PPI', observedAt: r.observedAt, observedAtSource: r.sourceDate, receivedAt: r.receivedAt,
      timezone: typeof r.timezone === 'string' ? r.timezone : null,
      value: null, values: source.slots.map((slot) => slot.value), unit: 'UNKNOWN_VENDOR_UNIT',
      acquisitionMode: 'HISTORICAL_SYNC', measurementContext: 'PPI_HISTORY',
      sessionId: typeof r.sessionId === 'string' ? r.sessionId : null, packetId: source.serialNumber,
      sequenceNumber: null, samplingIntervalMs: null, sampleRateHz: null, signalQuality: null, completeness: 'COMPLETE',
      vendorDataType: '127', vendorField: 'ppiData', vendorDerived: false, rawPayload: null,
      provenance: { sourceEnvelopeId: id, sourceRecordId: id, sourceConnector: 'JCVITAL_NATIVE', provider: 'JCVITAL' },
    }
  }
}
