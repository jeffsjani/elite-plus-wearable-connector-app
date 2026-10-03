import { describe, expect, it } from 'vitest'
import {
  BASE44_PRODUCTION_ENVIRONMENT,
  getBackendEnvironmentDiagnostics,
  resolveConnectorFunctionUrl,
} from './base44Environment'
import { buildPhase3AValidationReport } from '../../adapters/jcvital/Phase3AValidation'

describe('Base44 production environment', () => {
  it('resolves observations to the Waves Elite production host', () => {
    const url = resolveConnectorFunctionUrl(BASE44_PRODUCTION_ENVIRONMENT.observationsFunction)

    expect(url).toBe('https://waves-elite-sync.base44.app/functions/nativeConnectorObservations')
    expect(new URL(url).hostname).toBe('waves-elite-sync.base44.app')
  })

  it('routes registration and observations through the same production environment', () => {
    const diagnostics = getBackendEnvironmentDiagnostics()

    expect(diagnostics.resolvedRegistrationUrl).toBe('https://waves-elite-sync.base44.app/functions/nativeConnectorRegister')
    expect(new URL(diagnostics.resolvedRegistrationUrl).hostname).toBe(new URL(diagnostics.resolvedObservationsUrl).hostname)
    expect(diagnostics.resolvedAppId).toBe('6a89a92c780c9ffa5ba886bc')
    expect(diagnostics.environmentMatch).toBe(true)
  })

  it('flags a wrong host or app identifier as an environment mismatch', () => {
    expect(getBackendEnvironmentDiagnostics({ functionsBaseUrl: 'https://staging.base44.app/functions' }).environmentMatch).toBe(false)
    expect(getBackendEnvironmentDiagnostics({ appId: 'another-app-id' }).environmentMatch).toBe(false)
  })

  it('exports backend routing without credentials or secret headers', () => {
    const report = buildPhase3AValidationReport({ deviceInfo: null, historicalRuns: {} })
    const serialized = JSON.stringify(report)

    expect(report.backendEnvironment.resolvedHost).toBe('waves-elite-sync.base44.app')
    expect(serialized).not.toMatch(/test-token|Authorization|Bearer|cookie|secret/i)
  })
})