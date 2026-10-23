import type { ConnectorObservationResult } from '../../services/base44/base44Types'

export type CertificationDeliveryState =
  | 'CAPTURED_NOT_DELIVERED' | 'QUEUED'
  | 'DELIVERED_CANONICALIZED' | 'DELIVERED_NATIVE_ONLY' | 'DELIVERED_DUPLICATE'
  | 'CANONICAL_FAILED' | 'REJECTED' | 'FAILED' | 'DELIVERY_UNKNOWN'

export interface ExactDeliveryEvidence {
  acknowledged: boolean
  outcome: string
  result: ConnectorObservationResult | null
}

export interface CertificationDeliveryResult extends ExactDeliveryEvidence {
  batchId: string
  at: string
}

export type CertificationQueueDisposition = 'NOT_READ' | 'ROW_PRESENT' | 'NOT_FOUND' | 'ACKNOWLEDGED_PURGED'

export function certificationQueueDisposition(evidence: ExactDeliveryEvidence | null, queueState: string | null): CertificationQueueDisposition {
  return queueState ? 'ROW_PRESENT' : evidence?.acknowledged ? 'ACKNOWLEDGED_PURGED' : 'NOT_FOUND'
}

/** Queue recovery and exact results take precedence over totals or a generic acknowledgement. */
export function certificationDeliveryState(
  evidence: ExactDeliveryEvidence | null,
  queueState: string | null,
  fallback: CertificationDeliveryState = 'CAPTURED_NOT_DELIVERED',
): CertificationDeliveryState {
  if (queueState === 'CANONICAL_RECOVERY_REQUIRED' || evidence?.result?.canonicalStatus === 'failed'
    || evidence?.outcome === 'CANONICAL_RECOVERY_REQUIRED') return 'CANONICAL_FAILED'
  if (evidence?.result?.status === 'rejected') return 'REJECTED'
  if (queueState === 'FAILED_PERMANENT' || evidence?.outcome === 'FAILED') return 'FAILED'
  if (queueState === 'PENDING' || queueState === 'IN_FLIGHT' || queueState === 'RETRY_WAIT') return 'QUEUED'
  if (evidence?.acknowledged) {
    if (evidence.result?.status === 'duplicate') return 'DELIVERED_DUPLICATE'
    if (evidence.result?.canonicalStatus === 'canonicalized') return 'DELIVERED_CANONICALIZED'
    if (evidence.result?.canonicalStatus === 'not_applicable') return 'DELIVERED_NATIVE_ONLY'
    return 'DELIVERY_UNKNOWN'
  }
  if (queueState === 'ACKNOWLEDGED') return fallback === 'CAPTURED_NOT_DELIVERED' ? 'DELIVERY_UNKNOWN' : fallback
  return fallback
}
