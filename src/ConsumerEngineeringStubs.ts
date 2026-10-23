import type { NativeObservationInput } from './services/base44/base44Types'

export function Base44ContractProbePanel(
  _props: Parameters<typeof import('./services/base44/Base44ContractProbePanel').Base44ContractProbePanel>[0],
) { return null }
export function RookConnectionsPanel() { return null }
export function AppleHealthPanel(_props: { ownerUserId: string }) { return null }
export function HealthConnectPanel(_props: { ownerUserId: string }) { return null }

export function createSyntheticObservation(): NativeObservationInput {
  throw new Error('Engineering data generation is unavailable in consumer builds.')
}
export function createSyntheticObservations(): NativeObservationInput[] {
  throw new Error('Engineering data generation is unavailable in consumer builds.')
}
