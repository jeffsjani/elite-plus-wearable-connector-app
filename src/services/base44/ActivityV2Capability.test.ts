import { describe, expect, it } from 'vitest'
import { ACTIVITY_NATIVE_TRANSPORT_V2, ACTIVITY_V2_CAPABILITY } from '../../adapters/jcvital/ActivityNativeTransportV2'
import { ActivityV2CapabilityStore } from './ActivityV2Capability'

describe('Activity v2 registration capability persistence', () => {
  const scope = { ownerUserId: 'owner-1', installId: 'install-1', connectorDeviceId: 'connector-1' }
  const supportedResponse = {
    success: true,
    installId: scope.installId,
    connectorDeviceId: scope.connectorDeviceId,
    status: 'active',
    registeredAt: '2026-10-21T00:00:00.000Z',
    serverTimestamp: '2026-10-21T00:00:00.000Z',
    sources: ['JCVITAL'],
    capabilities: [ACTIVITY_V2_CAPABILITY],
  }

  function storeWith(values = new Map<string, string>()) {
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    return { store: new ActivityV2CapabilityStore(() => storage), values }
  }

  it('enables and persists v2 only for the exact advertised capability and matching scope', () => {
    const { store, values } = storeWith()
    const decision = store.recordRegistrationResponse(supportedResponse, scope, true)
    expect(decision).toMatchObject({
      capabilityReceived: true, capabilitySupported: true, productionDeliveryEnabled: true,
      reason: 'CAPABILITY_SUPPORTED', advertisedCapability: ACTIVITY_NATIVE_TRANSPORT_V2,
      predicates: {
        registrationResponseAvailable: true, registrationSuccess: true, registrationStatusValid: true,
        productionEnvironmentValid: true, capabilityRawPresent: true, capabilityRecognized: true,
        scopeValid: true, contractValid: true, registrationIdentityValid: true, freshnessValid: true,
      },
    })
    expect(Date.parse(decision.evaluatedAt)).not.toBeNaN()
    expect(store.isEnabled(scope)).toBe(true)
    expect(values.size).toBe(1)
    expect(store.isEnabled({ ...scope, ownerUserId: 'another-owner' })).toBe(false)
    expect(store.isEnabled({ ...scope, installId: 'another-install' })).toBe(false)
    expect(store.isEnabled({ ...scope, connectorDeviceId: 'another-connector' })).toBe(false)
  })

  it('does not require or infer capability from a deployment revision', () => {
    const { store } = storeWith()
    const response = { ...supportedResponse, deploymentRevision: undefined }
    const decision = store.recordRegistrationResponse(response, scope, true)
    expect(decision.productionDeliveryEnabled).toBe(true)

    const revisionOnly = { ...supportedResponse, capabilities: {} }
    expect(store.recordRegistrationResponse(revisionOnly, scope, true).productionDeliveryEnabled).toBe(false)
    expect(store.recordRegistrationResponse(supportedResponse, scope, false).reason)
      .toBe('PRODUCTION_ENVIRONMENT_MISMATCH')
  })

  it.each([
    null,
    {},
    { ...supportedResponse, capabilities: undefined },
    { ...supportedResponse, capabilities: [] },
    { ...supportedResponse, capabilities: { [ACTIVITY_V2_CAPABILITY]: true } },
    { ...supportedResponse, registeredAt: 'malformed' },
  ])('fails closed for absent or malformed registration responses: %j', (response) => {
    const { store } = storeWith()
    const decision = store.recordRegistrationResponse(response, scope, true)
    expect(decision.productionDeliveryEnabled).toBe(false)
    expect(store.isEnabled(scope)).toBe(false)
  })

  it('disables a previously enabled capability while a fresh registration is pending', () => {
    const { store } = storeWith()
    store.recordRegistrationResponse(supportedResponse, scope, true)
    store.recordPending(scope.ownerUserId, scope.installId, scope.connectorDeviceId)
    expect(store.isEnabled(scope)).toBe(false)
    expect(store.getDecision(scope).reason).toBe('REGISTRATION_PENDING')
  })

  it('fails closed on corrupt persisted diagnostics', () => {
    const values = new Map([['elitePlus.activityV2Capability.v1', '{bad json']])
    const { store } = storeWith(values)
    expect(store.isEnabled(scope)).toBe(false)
    expect(store.getDecision(scope).reason).toBe('PERSISTED_DECISION_INVALID')
  })

  it('fails closed when a persisted success record has an invalid gate predicate', () => {
    const { store, values } = storeWith()
    store.recordRegistrationResponse(supportedResponse, scope, true)
    const saved = JSON.parse(values.get('elitePlus.activityV2Capability.v1') ?? '{}')
    saved.predicates.contractValid = false
    values.set('elitePlus.activityV2Capability.v1', JSON.stringify(saved))

    expect(store.isEnabled(scope)).toBe(false)
    expect(store.getDecision(scope).reason).toBe('PERSISTED_DECISION_INVALID')
  })
})
