import { afterEach, describe, expect, it, vi } from 'vitest'
import { ACTIVITY_V2_CAPABILITY } from '../../adapters/jcvital/ActivityNativeTransportV2'
import { connectorIdentityService } from './ConnectorIdentityService'
import { activityV2CapabilityStore } from './ActivityV2Capability'

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }))
vi.mock('./Base44Client', () => ({ invokeConnectorFunction: invoke }))

import { connectorRegistrationService } from './ConnectorRegistrationService'

afterEach(() => {
  vi.restoreAllMocks()
  connectorIdentityService.clearConnectorDeviceId()
  vi.unstubAllGlobals()
})

describe('Connector registration Activity v2 capability gate', () => {
  const request = { installId: 'install-1', platform: 'android' as const, appVersion: 'v66' }
  const scope = { ownerUserId: 'owner-1', installId: request.installId, connectorDeviceId: 'connector-1' }
  const response = {
    success: true,
    connectorDeviceId: scope.connectorDeviceId,
    installId: scope.installId,
    status: 'active',
    registeredAt: '2026-10-21T00:00:00.000Z',
    serverTimestamp: '2026-10-21T00:00:00.000Z',
    sources: [],
    capabilities: [ACTIVITY_V2_CAPABILITY],
  }

  function installStorage() {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    return values
  }

  it('enables v2 only after the existing registration endpoint advertises the exact capability', async () => {
    installStorage()
    invoke.mockResolvedValue(response)
    await connectorRegistrationService.registerConnector(request, scope.ownerUserId)
    expect(activityV2CapabilityStore.isEnabled(scope)).toBe(true)
    expect(invoke).toHaveBeenCalledWith('nativeConnectorRegister', request, expect.any(Object))
  })

  it('keeps valid legacy registration active while Activity v2 remains disabled', async () => {
    installStorage()
    invoke.mockResolvedValue({ ...response, capabilities: undefined })
    await connectorRegistrationService.registerConnector(request, scope.ownerUserId)
    expect(activityV2CapabilityStore.isEnabled(scope)).toBe(false)
    expect(activityV2CapabilityStore.getDecision(scope).reason).toBe('CAPABILITY_ABSENT')
  })

  it('records malformed registration as fail-closed and rejects it', async () => {
    installStorage()
    connectorIdentityService.setConnectorDeviceId(scope.connectorDeviceId)
    invoke.mockResolvedValue(null)
    await expect(connectorRegistrationService.registerConnector(request, scope.ownerUserId))
      .rejects.toThrow('invalid registration')
    expect(activityV2CapabilityStore.isEnabled(scope)).toBe(false)
    expect(activityV2CapabilityStore.getDecision(scope).reason).toBe('INVALID_REGISTRATION_RESPONSE')
  })

  it('refreshes only the scoped registration capability and records a redacted handshake', async () => {
    installStorage()
    connectorIdentityService.setConnectorDeviceId(scope.connectorDeviceId)
    const uppercaseResponse = {
      ...response,
      capabilities: undefined,
      SERVER_CAPABILITIES: [ACTIVITY_V2_CAPABILITY],
      access_token: 'never-persist-this',
    }
    invoke.mockImplementation(async (_name: string, _request: unknown, options: {
      onRequestMetadata: (metadata: { resolvedRequestUrl: string }) => void
      onHttpResponse: (status: number) => void
      onResponseBody: (body: unknown) => void
    }) => {
      options.onRequestMetadata({ resolvedRequestUrl: 'https://waves-elite-sync.base44.app/functions/nativeConnectorRegister' })
      options.onHttpResponse(200)
      options.onResponseBody(uppercaseResponse)
      return uppercaseResponse
    })

    const decision = await connectorRegistrationService.refreshBase44Capabilities(request, scope)
    const diagnostic = activityV2CapabilityStore.getHandshakeDiagnostics(scope)

    expect(decision.productionDeliveryEnabled).toBe(true)
    expect(connectorIdentityService.getConnectorDeviceId()).toBe(scope.connectorDeviceId)
    expect(invoke).toHaveBeenCalledWith('nativeConnectorRegister', request, expect.any(Object))
    expect(diagnostic).toMatchObject({
      httpStatus: 200, responseReceived: true,
      resolvedRegistrationUrl: 'https://waves-elite-sync.base44.app/functions/nativeConnectorRegister',
      environmentMatch: true, capabilityRawPresent: true, capabilityRecognized: true,
      parsedCapabilities: [ACTIVITY_V2_CAPABILITY],
    })
    expect(diagnostic?.responseJson).not.toContain('never-persist-this')
  })

  it('keeps a recognized capability disabled when the resolved registration URL is non-production', async () => {
    installStorage()
    connectorIdentityService.setConnectorDeviceId(scope.connectorDeviceId)
    invoke.mockImplementation(async (_name: string, _request: unknown, options: {
      onRequestMetadata: (metadata: { resolvedRequestUrl: string }) => void
      onHttpResponse: (status: number) => void
      onResponseBody: (body: unknown) => void
    }) => {
      options.onRequestMetadata({ resolvedRequestUrl: 'https://staging.example.test/functions/nativeConnectorRegister' })
      options.onHttpResponse(200)
      options.onResponseBody(response)
      return response
    })

    const decision = await connectorRegistrationService.refreshBase44Capabilities(request, scope)
    const diagnostic = activityV2CapabilityStore.getHandshakeDiagnostics(scope)

    expect(decision.productionDeliveryEnabled).toBe(false)
    expect(decision.reason).toBe('PRODUCTION_ENVIRONMENT_MISMATCH')
    expect(decision.predicates).toMatchObject({
      productionEnvironmentValid: false,
      capabilityRawPresent: true,
      capabilityRecognized: true,
    })
    expect(diagnostic?.environmentMatch).toBe(false)
  })

  it.each([
    { advertised: ['JCVITAL_ACTIVITY_TRANSPORT_V2'], rawPresent: true, parsed: ['JCVITAL_ACTIVITY_TRANSPORT_V2'], enabled: true },
    { advertised: [], rawPresent: false, parsed: [], enabled: false },
    { advertised: ['UNKNOWN_CAPABILITY'], rawPresent: false, parsed: ['UNKNOWN_CAPABILITY'], enabled: false },
  ])('recognizes exact camelCase serverCapabilities and keeps the gate fail-closed for %j', async ({ advertised, rawPresent, parsed, enabled }) => {
    installStorage()
    connectorIdentityService.setConnectorDeviceId(scope.connectorDeviceId)
    const responseWithServerCapabilities = {
      ...response,
      capabilities: undefined,
      serverCapabilities: advertised,
    }
    invoke.mockResolvedValue(responseWithServerCapabilities)

    const decision = await connectorRegistrationService.refreshBase44Capabilities(request, scope)
    const diagnostic = activityV2CapabilityStore.getHandshakeDiagnostics(scope)

    expect(diagnostic).toMatchObject({
      rawServerCapabilities: JSON.stringify(advertised),
      parsedCapabilities: parsed,
      capabilityRawPresent: rawPresent,
      capabilityRecognized: rawPresent,
    })
    expect(activityV2CapabilityStore.isEnabled(scope)).toBe(enabled)
    expect(decision.productionDeliveryEnabled).toBe(enabled)
  })

  it('recognizes the exact token in diagnostics while keeping an invalid-scope gate closed', async () => {
    installStorage()
    connectorIdentityService.setConnectorDeviceId(scope.connectorDeviceId)
    const responseWithMismatchedInstall = {
      ...response,
      installId: 'another-install',
      capabilities: undefined,
      serverCapabilities: ['JCVITAL_ACTIVITY_TRANSPORT_V2'],
    }
    invoke.mockResolvedValue(responseWithMismatchedInstall)

    await expect(connectorRegistrationService.refreshBase44Capabilities(request, scope))
      .rejects.toThrow('did not match the current account, install, and device')

    const diagnostic = activityV2CapabilityStore.getHandshakeDiagnostics(scope)
    expect(diagnostic).toMatchObject({
      rawServerCapabilities: '["JCVITAL_ACTIVITY_TRANSPORT_V2"]',
      parsedCapabilities: ['JCVITAL_ACTIVITY_TRANSPORT_V2'],
      capabilityRawPresent: true,
      capabilityRecognized: true,
    })
    expect(activityV2CapabilityStore.isEnabled(scope)).toBe(false)
    expect(activityV2CapabilityStore.getDecision(scope).reason).toBe('REGISTRATION_SCOPE_MISMATCH')
  })

  it.each(['data', 'result'] as const)('accepts the server capability under a %s registration envelope', async (envelope) => {
    installStorage()
    const wrapped = { [envelope]: { ...response, capabilities: undefined, SERVER_CAPABILITIES: [ACTIVITY_V2_CAPABILITY] } }
    invoke.mockResolvedValue(wrapped)

    await connectorRegistrationService.registerConnector(request, scope.ownerUserId)

    expect(activityV2CapabilityStore.isEnabled(scope)).toBe(true)
    expect(activityV2CapabilityStore.getHandshakeDiagnostics(scope)?.capabilityRawPresent).toBe(true)
  })

  it('retains an outer server-capabilities field around a nested registration envelope', async () => {
    installStorage()
    invoke.mockResolvedValue({
      SERVER_CAPABILITIES: [ACTIVITY_V2_CAPABILITY],
      data: { ...response, capabilities: undefined },
    })

    await connectorRegistrationService.registerConnector(request, scope.ownerUserId)

    expect(activityV2CapabilityStore.isEnabled(scope)).toBe(true)
    expect(activityV2CapabilityStore.getHandshakeDiagnostics(scope)?.capabilityRecognized).toBe(true)
  })
})
