import type { JCVitalV8ConnectionState } from './jcvitalV8Bridge'

export interface Phase3BControlGate {
  pluginAvailable: boolean | null
  methodAvailable: boolean
  connectionState: JCVitalV8ConnectionState
  activeSync: string | null
}

export function phase3bDisabledReason(gate: Phase3BControlGate): string | null {
  if (gate.pluginAvailable !== true) return gate.pluginAvailable === null ? 'native plugin availability is checking' : 'native plugin unavailable'
  if (!gate.methodAvailable) return 'native method unavailable'
  if (gate.connectionState !== 'READY') return 'V8 not READY'
  if (gate.activeSync !== null) return `another sync is active (${gate.activeSync})`
  return null
}