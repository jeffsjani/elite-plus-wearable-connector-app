import type { NativeObservationInput } from '../base44/base44Types'
import type { QueueRecord } from './ObservationQueueStore'
import { ACTIVITY_RESUME_IDS } from '../../adapters/jcvital/ActivityResumeContract'
import { nativeJcvitalConnector } from '../../models/wearableObservation'

export interface ActivityTransportEvidence {
  observationId: string
  payloadJson: string
  payloadFingerprint: string
  sourceEnvelopeId: string
}

export function assertActivityRecoveryIds(ids: readonly string[]): void {
  if (!ids.length || ids.length > 17 || new Set(ids).size !== ids.length
    || ids.some((id) => !ACTIVITY_RESUME_IDS.some((approved) => approved === id))) {
    throw new Error('ACTIVITY_RECOVERY_IDS_INVALID: only approved eligible Activity IDs may be recovered.')
  }
}

export async function transportFingerprint(json: string): Promise<string> {
  const bytes = new TextEncoder().encode(json)
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function verifyActivityTransport(evidence: ActivityTransportEvidence): Promise<NativeObservationInput> {
  assertActivityRecoveryIds([evidence.observationId])
  const payload: NativeObservationInput = JSON.parse(evidence.payloadJson)
  if (JSON.stringify(payload) !== evidence.payloadJson || payload.observationId !== evidence.observationId
    || await transportFingerprint(evidence.payloadJson) !== evidence.payloadFingerprint
    || payload.provider !== 'JCVITAL' || payload.sourceConnector !== nativeJcvitalConnector
    || !['24', '25'].includes(payload.vendorDataType ?? '')
    || payload.rawSourceMetadata?.certificationOnly !== true || payload.rawSourceMetadata?.canonicalPolicy !== 'NATIVE_ONLY'
    || payload.rawSourceMetadata?.canonicalTarget !== null || payload.rawSourceMetadata?.sourceEnvelopeId !== evidence.sourceEnvelopeId
    || !payload.sourceRecordGroupId || !payload.vendorField
    || !['DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES', 'DAILY_GOAL_COMPLETION', 'DETAILED_ACTIVITY_EPOCH',
      'DETAILED_ACTIVITY_STEPS_TOTAL', 'DETAILED_ACTIVITY_DISTANCE', 'DETAILED_ACTIVITY_CALORIES'].includes(payload.metricType ?? '')) {
    throw new Error('ACTIVITY_RECOVERY_PAYLOAD_INVALID: saved transport bytes/fingerprint/provenance differ.')
  }
  return payload
}

export function activityTransportClaimable(row: QueueRecord): boolean {
  return ['PENDING', 'RETRY_WAIT', 'FAILED_PERMANENT', 'ACKNOWLEDGED'].includes(row.state)
    && row.payload.rawSourceMetadata?.certificationOnly === true
    && row.payload.rawSourceMetadata?.canonicalPolicy === 'NATIVE_ONLY'
    && ['24', '25'].includes(row.payload.vendorDataType ?? '')
    && row.payload.metricType !== 'DAILY_EXERCISE_MINUTES'
}
