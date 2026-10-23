import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { QueueRecord } from '../../services/storage/ObservationQueueStore'
import type { BatchDeliveryEvent, CertificationFlushOptions, CertificationFlushReport } from '../../services/sync/ObservationBatchManager'
import { certificationDeliveryState, certificationQueueDisposition } from './CertificationDeliveryState'
import { mappedEvidence, type CertificationObservation } from './JCVitalCertification'

export type TemperatureInspectionState = 'FOUND_PENDING' | 'FOUND_RETRYING' | 'FOUND_SENDING'
  | 'FAILED' | 'RECOVERY_REQUIRED' | 'ACKNOWLEDGED_EVIDENCE' | 'NOT_FOUND'

export interface TemperatureInspection {
  observationId: string
  status: TemperatureInspectionState
  queueState: QueueRecord['state'] | null
  inspectedAt: string
}

interface StoredEvidence {
  samples: CertificationObservation[]
  inspection: TemperatureInspection[]
}

interface Dependencies {
  queue: { getOwnerUserId: () => string | null; getRecord: (id: string) => Promise<QueueRecord | null> }
  flush: (ids: readonly string[], options: CertificationFlushOptions) => Promise<CertificationFlushReport>
  storage?: () => Pick<Storage, 'getItem' | 'setItem'>
}

/**
 * Diagnostic-only wearable (skin) temperature samples/results, mirroring SpO2Certification's architecture.
 * Never stores sendable payloads or schedules delivery; this is the first physical certification attempt
 * for type-59 WEARABLE_TEMPERATURE, so there is no prior hardcoded ID list to recover.
 */
export class TemperatureCertification {
  private readonly deps: Dependencies
  constructor(deps: Dependencies) { this.deps = deps }

  private owner(): string {
    const owner = this.deps.queue.getOwnerUserId()
    if (!owner) throw new Error('Wearable temperature certification requires an authenticated queue owner.')
    return owner
  }

  private storage() { return (this.deps.storage ?? (() => localStorage))() }
  private key(owner: string) { return `elitePlus.temperatureCertification.v1.${owner}` }

  snapshot(): StoredEvidence {
    const text = this.storage().getItem(this.key(this.owner()))
    if (!text) return { samples: [], inspection: [] }
    const parsed: StoredEvidence = JSON.parse(text)
    if (!Array.isArray(parsed.samples) || !Array.isArray(parsed.inspection)
      || parsed.samples.length > 10 || parsed.samples.some((sample) =>
        typeof sample.observationId !== 'string' || !/^[0-9a-f]{64}$/.test(sample.observationId)
        || sample.metric !== 'wearableTemperature' || sample.vendorDataType !== '59')) {
      throw new Error('Stored wearable temperature certification evidence is invalid; no capture or flush was started.')
    }
    return parsed
  }

  private save(evidence: StoredEvidence): void {
    this.storage().setItem(this.key(this.owner()), JSON.stringify(evidence))
  }

  remember(observations: NativeObservationInput[]): void {
    const evidence = this.snapshot()
    for (const input of observations) {
      if (input.metric !== 'wearableTemperature' || input.vendorDataType !== '59') throw new Error('Certification sample must be type-59 wearable temperature.')
      if (evidence.samples.some((sample) => sample.observationId === input.observationId)) continue
      evidence.samples.push(mappedEvidence(input, 'CANONICAL', 'body.wearable_temperature', new Map()))
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

  async inspect(ids?: readonly string[]): Promise<TemperatureInspection[]> {
    const requested = ids ?? this.snapshot().samples.flatMap((sample) => sample.observationId ? [sample.observationId] : [])
    if (!requested.length || requested.length > 5 || requested.some((id) => !/^[0-9a-f]{64}$/.test(id))) {
      throw new Error('Wearable temperature inspection requires 1-5 exact observation IDs.')
    }
    const owner = this.owner()
    const inspection: TemperatureInspection[] = []
    for (const id of requested) {
      const row = await this.deps.queue.getRecord(id)
      if (this.owner() !== owner) throw new Error('Account changed during certification inspection.')
      const evidence = this.snapshot()
      if (row && (row.ownerUserId !== owner || row.payload.metric !== 'wearableTemperature' || row.payload.vendorDataType !== '59')) {
        throw new Error('Requested certification ID does not belong to the current owner/type-59 wearable temperature.')
      }
      let sample = evidence.samples.find((item) => item.observationId === id)
      if (row && !sample) {
        sample = mappedEvidence(row.payload, 'CANONICAL', 'body.wearable_temperature', new Map())
        evidence.samples.push(sample)
      }
      const acknowledged = sample?.deliveryResult?.acknowledged
        || (sample?.deliveryResult?.result?.status === 'accepted' && sample.deliveryResult.result.canonicalStatus === 'canonicalized')
        || sample?.deliveryResult?.result?.status === 'duplicate'
      const status: TemperatureInspectionState = row?.state === 'CANONICAL_RECOVERY_REQUIRED' ? 'RECOVERY_REQUIRED'
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
    if (ids.length !== 5 || new Set(ids).size !== 5) {
      throw new Error('Wearable temperature certification flush requires exactly five distinct observation IDs.')
    }
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
    const incomplete = inspection.filter((item) => !evidence.samples.some((sample) => {
      if (sample.observationId !== item.observationId
        || (sample.deliveryState !== 'DELIVERED_CANONICALIZED' && sample.deliveryState !== 'DELIVERED_DUPLICATE')) return false
      const result = sample.deliveryResult?.result
      return (result?.status === 'accepted' || result?.status === 'duplicate')
        && result.canonicalStatus === 'canonicalized'
        && (result.status !== 'accepted' || Boolean(result.nativeObservationId))
    }))
    return {
      ...report,
      reason: report.reason ?? (incomplete.length
        ? `Targeted delivery incomplete: ${incomplete.map((item) => `${item.observationId.slice(0, 12)}: ${item.status}`).join(', ')}. No new capture was started.`
        : null),
    }
  }
}
