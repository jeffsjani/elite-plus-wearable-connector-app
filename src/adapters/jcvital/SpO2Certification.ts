import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent, CertificationFlushOptions, CertificationFlushReport } from '../../services/sync/ObservationBatchManager'
import { certificationDeliveryState, certificationQueueDisposition } from './CertificationDeliveryState'
import { mappedEvidence, type CertificationObservation } from './JCVitalCertification'

export const PRIOR_SPO2_CERTIFICATION_IDS = [
  '10069d63a46bbd44468999897ec9c148734c4b2b20e0aaca2fa09f6ac8ccf498',
  '89f1dc02f6fd096fc41c3ede63904d5d329b51d4ffb6b32aadc3aa9ad06c3b0a',
  '2595ed9a9cb1e3f3a2d2fb7c6d3ae9350b81e805ae9a2fec0fa61e3115e9f40b',
  'f29b1e86057a537dd8af87d2710473dc6f69d6a139ad50642261907c7d54554f',
  '52bab90f10685fdeefca0c121fdef8a62d6f93d2968d9cf3d278f90e975bb462',
] as const

export type SpO2InspectionState = 'FOUND_PENDING' | 'FOUND_RETRYING' | 'FOUND_SENDING'
  | 'FAILED' | 'RECOVERY_REQUIRED' | 'ACKNOWLEDGED_EVIDENCE' | 'NOT_FOUND'

export interface SpO2Inspection {
  observationId: string
  status: SpO2InspectionState
  queueState: QueueRecord['state'] | null
  inspectedAt: string
}

interface StoredEvidence {
  samples: CertificationObservation[]
  inspection: SpO2Inspection[]
}

interface Dependencies {
  queue: { getOwnerUserId: () => string | null; getRecord: (id: string) => Promise<QueueRecord | null> }
  flush: (ids: readonly string[], options: CertificationFlushOptions) => Promise<CertificationFlushReport>
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>
}

/** Diagnostic-only samples/results. Never stores sendable payloads or schedules delivery. */
export class SpO2Certification {
  private readonly deps: Dependencies
  constructor(deps: Dependencies) { this.deps = deps }

  private owner(): string {
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) throw new Error('SpO2 certification requires an authenticated queue owner.')
    return owner
  }

  private storage() { return (this.deps.storage ?? (() => localStorage))() }
  private key(owner: string) { return `elitePlus.spo2Certification.v1.${owner}` }

  snapshot(): StoredEvidence {
    const text = this.storage().getItem(this.key(this.owner()))
    if (!text) return { samples: [], inspection: [] }
    const parsed: StoredEvidence = JSON.parse(text)
    if (!Array.isArray(parsed.samples) || !Array.isArray(parsed.inspection)
      || parsed.samples.length > 10 || parsed.samples.some((sample) =>
        typeof sample.observationId !== 'string' || !/^[0-9a-f]{64}$/.test(sample.observationId)
        || sample.metric !== 'oxygenSaturation' || sample.vendorDataType !== '68')) {
      throw new Error('Stored SpO2 certification evidence is invalid; no capture or flush was started.')
    }
    return parsed
  }

  private save(evidence: StoredEvidence): void {
    this.storage().setItem(this.key(this.owner()), JSON.stringify(evidence))
  }

  remember(observations: NativeObservationInput[]): void {
    const evidence = this.snapshot()
    for (const input of observations) {
      if (input.metric !== 'oxygenSaturation' || input.vendorDataType !== '68') throw new Error('Certification sample must be type-68 SpO2.')
      if (evidence.samples.some((sample) => sample.observationId === input.observationId)) continue
      evidence.samples.push(mappedEvidence(input, 'CANONICAL', 'body.oxygen_saturation', new Map()))
    }
    evidence.samples = evidence.samples.slice(-10)
    this.save(evidence)
  }

  record(event: BatchDeliveryEvent): void {
    const evidence = this.snapshot()
    const results = new Map((event.results ?? []).map((result) => [result.observationId, result]))
    let changed = false
    for (const sample of evidence.samples) {
      if (!sample.observationId || !event.observationIds.includes(sample.observationId)) continue
      const result = results.get(sample.observationId) ?? null
      sample.deliveryResult = {
        batchId: event.batchId, at: event.attemptedAt,
        outcome: event.canonicalFailedIds?.includes(sample.observationId) ? 'CANONICAL_RECOVERY_REQUIRED' : event.outcome,
        acknowledged: event.acknowledgedIds.includes(sample.observationId) && !event.canonicalFailedIds?.includes(sample.observationId),
        result,
      }
      sample.nativeObservationId = result?.nativeObservationId ?? sample.nativeObservationId
      sample.deliveryState = certificationDeliveryState(sample.deliveryResult, null)
      sample.queueDisposition = sample.deliveryResult.acknowledged ? 'ACKNOWLEDGED_PURGED' : 'NOT_READ'
      changed = true
    }
    if (changed) this.save(evidence)
  }

  async inspect(ids: readonly string[] = PRIOR_SPO2_CERTIFICATION_IDS): Promise<SpO2Inspection[]> {
    if (!ids.length || ids.length > 5 || ids.some((id) => !/^[0-9a-f]{64}$/.test(id))) throw new Error('SpO2 inspection requires 1-5 exact observation IDs.')
    const owner = this.owner()
    const inspection: SpO2Inspection[] = []
    for (const id of ids) {
      const row = await this.deps.queue.getRecord(id)
      if (this.owner() !== owner) throw new Error('Account changed during certification inspection.')
      const evidence = this.snapshot()
      if (row && (row.ownerUserId !== owner || row.payload.metric !== 'oxygenSaturation' || row.payload.vendorDataType !== '68')) {
        throw new Error('Requested certification ID does not belong to the current owner/type-68 SpO2.')
      }
      let sample = evidence.samples.find((item) => item.observationId === id)
      if (row && !sample) {
        sample = mappedEvidence(row.payload, 'CANONICAL', 'body.oxygen_saturation', new Map())
        evidence.samples.push(sample)
      }
      const acknowledged = sample?.deliveryResult?.acknowledged
        || (sample?.deliveryResult?.result?.status === 'accepted' && sample.deliveryResult.result.canonicalStatus === 'canonicalized')
        || sample?.deliveryResult?.result?.status === 'duplicate'
      const status: SpO2InspectionState = row?.state === 'CANONICAL_RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED'
        : row?.state === 'PENDING' ? 'FOUND_PENDING'
          : row?.state === 'RETRY_WAIT' ? 'FOUND_RETRYING'
            : row?.state === 'IN_FLIGHT' ? 'FOUND_SENDING'
              : row?.state === 'FAILED_PERMANENT' ? 'FAILED'
                : row?.state === 'ACKNOWLEDGED' || acknowledged ? 'ACKNOWLEDGED_EVIDENCE' : 'NOT_FOUND'
      inspection.push({ observationId: id, status, queueState: row?.state ?? null, inspectedAt: new Date().toISOString() })
      if (sample) {
        sample.queueState = row?.state ?? null
        sample.deliveryState = certificationDeliveryState(sample.deliveryResult, sample.queueState)
        sample.queueDisposition = certificationQueueDisposition(sample.deliveryResult, sample.queueState)
        sample.nativeObservationId ??= row?.nativeObservationId ?? null
      }
      evidence.inspection = inspection
      evidence.samples = evidence.samples.slice(-10)
      this.save(evidence)
    }
    return inspection
  }

  async flush(ids: readonly string[], onStage?: CertificationFlushOptions['onStage']): Promise<CertificationFlushReport> {
    await this.inspect(ids)
    const owner = this.owner()
    const report = await this.deps.flush(ids, {
      onStage,
      persistEvidence: (event) => {
        if (this.owner() !== owner) throw new Error('Account changed while persisting certification results.')
        this.record(event)
      },
    })
    if (this.owner() !== owner) throw new Error('Account changed during certification flush.')
    for (const event of report.events) this.record(event)
    const inspection = await this.inspect(ids)
    const evidence = this.snapshot()
    const incomplete = inspection.filter((item) => !evidence.samples.some((sample) => sample.observationId === item.observationId
      && (sample.deliveryState === 'DELIVERED_CANONICALIZED' || sample.deliveryState === 'DELIVERED_DUPLICATE')))
    return {
      ...report,
      reason: report.reason ?? (incomplete.length
        ? `Targeted delivery incomplete: ${incomplete.map((item) => `${item.observationId.slice(0, 12)}: ${item.status}`).join(', ')}. No new capture was started.`
        : null),
    }
  }
}
