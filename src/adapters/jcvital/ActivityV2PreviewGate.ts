import type { ActivityV2CapabilityRecord } from '../../services/base44/ActivityV2Capability'

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export function activityV2PreviewCanVerify(
  previewJson: string,
  capability: Pick<ActivityV2CapabilityRecord, 'capabilitySupported' | 'productionDeliveryEnabled' | 'reason'>,
  identity: { ownerUserId: string; installId: string; connectorDeviceId: string; accountId: string; deviceScopeId: string },
): boolean {
  if (!capability.capabilitySupported || !capability.productionDeliveryEnabled || capability.reason !== 'CAPABILITY_SUPPORTED') return false
  try {
    const preview = object(JSON.parse(previewJson))
    const scope = object(preview.selectionScope)
    const type24 = object(preview.type24)
    const type25 = object(preview.type25)
    const queue = object(preview.queue)
    const observations = Array.isArray(preview.observations) ? preview.observations : []
    const ids = observations.map((entry) => object(entry).observationId)
    return preview.previewStatus === 'PASS' && preview.expectedObservationCount === 14
      && type24.mappingValid === true && typeof type24.sourceEnvelopeId === 'string' && Boolean(type24.sourceEnvelopeId)
      && type25.qualification === 'PASS' && typeof type25.sourceEnvelopeId === 'string' && Boolean(type25.sourceEnvelopeId)
      && queue.queueConflict === false
      && queue.TEST_OBSERVATION_COLLISION_COUNT === 0
      && preview.SCOPED_E2E_SUPPORTED === 'YES' && preview.SCOPED_E2E_SAFE === 'YES'
      && preview.DIAGNOSTIC_WORKER_RACE_PREVENTED === 'YES'
      && preview.NORMAL_FIFO_BACKLOG_PROCESSING_BYPASSED_FOR_DIAGNOSTIC === 'YES'
      && observations.length === 14 && ids.every((id) => typeof id === 'string' && id.length > 0)
      && new Set(ids).size === 14
      && scope.ownerUserId === identity.ownerUserId && scope.installId === identity.installId
      && scope.connectorDeviceId === identity.connectorDeviceId
      && scope.accountId === identity.accountId && scope.deviceScopeId === identity.deviceScopeId
  } catch {
    return false
  }
}
