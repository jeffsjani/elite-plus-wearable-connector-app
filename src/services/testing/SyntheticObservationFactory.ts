import type { NativeObservationInput } from '../base44/base44Types'

function createObservationId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function getTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

export function createSyntheticObservation(metric = 'connector_test'): NativeObservationInput {
  const timestamp = new Date().toISOString()

  return {
    observationId: createObservationId(),
    source: 'connector_test',
    metric,
    valueNumber: 1,
    unit: 'count',
    startTime: timestamp,
    timezone: getTimezone(),
    capturedAt: timestamp,
    provider: 'elite_connector',
  }
}

export function createSyntheticObservations(
  count: number,
  metric = 'connector_batch_test',
): NativeObservationInput[] {
  return Array.from({ length: count }, () => createSyntheticObservation(metric))
}