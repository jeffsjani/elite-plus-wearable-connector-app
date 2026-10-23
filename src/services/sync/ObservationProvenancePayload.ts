import type { NativeObservationInput } from '../base44/base44Types'
import type { AcquisitionQueueProvenance } from '../storage/ObservationQueueStore'

export interface SenderProvenanceFields {
  sync_id: string
  acquisition_id: string
  acquisition_request_id: string
  requested_metric: string
  connection_generation: number | null
  acquisition_started_at: string
  acquisition_completed_at: string | null
  client_queued_at: string
}

export type OutboundObservation = NativeObservationInput & Partial<SenderProvenanceFields>

export const BASE44_PROVENANCE_TRANSMISSION_ENABLED = false

export function addAcquisitionProvenance(
  payload: NativeObservationInput,
  provenance: AcquisitionQueueProvenance | undefined,
  enabled: boolean,
): OutboundObservation {
  if (!enabled || !provenance) return payload

  return {
    ...payload,
    sync_id: provenance.syncId,
    acquisition_id: provenance.acquisitionId,
    acquisition_request_id: provenance.acquisitionRequestId,
    requested_metric: provenance.requestedMetric,
    connection_generation: provenance.connectionGeneration,
    acquisition_started_at: provenance.acquisitionStartedAt,
    acquisition_completed_at: provenance.acquisitionCompletedAt,
    client_queued_at: provenance.clientQueuedAt,
  }
}
