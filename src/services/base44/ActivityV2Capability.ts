import {
  ACTIVITY_NATIVE_TRANSPORT_V2,
  ACTIVITY_V2_CAPABILITY,
  activityV2CapabilityDecision,
  extractActivityV2RegistrationEnvelope,
  type ActivityV2CapabilityPredicates,
  type ActivityV2HandshakeScope,
} from '../../adapters/jcvital/ActivityNativeTransportV2'

const STORAGE_KEY = 'elitePlus.activityV2Capability.v1'
const HANDSHAKE_DIAGNOSTICS_KEY = 'elitePlus.activityV2HandshakeDiagnostics.v1'
type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export interface ActivityV2CapabilityRecord extends ActivityV2HandshakeScope {
  capabilityReceived: boolean
  capabilitySupported: boolean
  productionDeliveryEnabled: boolean
  reason: string
  receivedAt: string
  evaluatedAt: string
  advertisedCapability: string | null
  responseContractVersion: string | null
  deploymentRevision: string | null
  predicates: ActivityV2CapabilityPredicates
}

export interface ActivityV2HandshakeDiagnostics extends ActivityV2HandshakeScope {
  attemptedAt: string
  httpStatus: number | null
  responseReceived: boolean
  responseJson: string
  rawServerCapabilities: string
  parsedCapabilities: string[]
  capabilityRawPresent: boolean
  capabilityRecognized: boolean
  resolvedRegistrationUrl: string
  environmentMatch: boolean
}

export interface ActivityV2HandshakeCapture {
  attemptedAt: string
  httpStatus: number | null
  responseReceived: boolean
  responseBody: unknown
  resolvedRegistrationUrl: string
  environmentMatch: boolean
}

function serverCapabilities(response: unknown): unknown {
  if (!response || typeof response !== 'object' || Array.isArray(response)) return undefined
  const candidate = response as Record<string, unknown>
  for (const field of ['SERVER_CAPABILITIES', 'serverCapabilities', 'server_capabilities', 'capabilities']) {
    if (Object.prototype.hasOwnProperty.call(candidate, field)) return candidate[field]
  }
  return serverCapabilities(candidate.data) ?? serverCapabilities(candidate.result)
}

function parsedCapabilityNames(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === 'string')
  if (!value || typeof value !== 'object') return []
  return Object.entries(value as Record<string, unknown>)
    .filter(([, advertised]) => typeof advertised === 'string')
    .map(([name]) => name)
}

function redactDiagnosticValue(value: unknown, key = ''): unknown {
  if (/(token|secret|authorization|password|credential|cookie)/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') {
    return value.replace(/(Bearer\s+)\S+/gi, '$1[REDACTED]')
      .replace(/((?:access|refresh)?_?token\s*[:=]\s*)[^,\s&]+/gi, '$1[REDACTED]')
  }
  if (Array.isArray(value)) return value.map((item) => redactDiagnosticValue(item))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .map(([childKey, child]) => [childKey, redactDiagnosticValue(child, childKey)]))
}

function blockedPredicates(): ActivityV2CapabilityPredicates {
  return {
    registrationResponseAvailable: false,
    registrationSuccess: false,
    registrationStatusValid: false,
    productionEnvironmentValid: false,
    capabilityRawPresent: false,
    capabilityRecognized: false,
    scopeValid: false,
    contractValid: false,
    registrationIdentityValid: false,
    freshnessValid: false,
  }
}

function allPredicatesValid(predicates: ActivityV2CapabilityPredicates): boolean {
  return Object.keys(blockedPredicates()).every((key) =>
    predicates[key as keyof ActivityV2CapabilityPredicates] === true)
}

function isCapabilityPredicates(value: unknown): value is ActivityV2CapabilityPredicates {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const predicates = value as Record<string, unknown>
  return Object.keys(blockedPredicates()).every((key) => typeof predicates[key] === 'boolean')
}

export class ActivityV2CapabilityStore {
  private readonly storage: () => StorageLike

  constructor(storage: () => StorageLike = () => localStorage) { this.storage = storage }

  recordPending(ownerUserId: string, installId: string, connectorDeviceId: string | null): ActivityV2CapabilityRecord {
    const now = new Date().toISOString()
    return this.save({
      ownerUserId, installId, connectorDeviceId: connectorDeviceId ?? '',
      capabilityReceived: false, capabilitySupported: false, productionDeliveryEnabled: false, reason: 'REGISTRATION_PENDING',
      receivedAt: '', evaluatedAt: now, advertisedCapability: null, responseContractVersion: null, deploymentRevision: null,
      predicates: blockedPredicates(),
    })
  }

  recordRegistrationResponse(
    response: unknown,
    scope: ActivityV2HandshakeScope,
    productionEnvironmentValid: boolean,
    receivedAtMs = Date.now(),
  ): ActivityV2CapabilityRecord {
    const decision = activityV2CapabilityDecision(
      response, scope, scope, receivedAtMs, Date.now(), productionEnvironmentValid,
    )
    const candidate = extractActivityV2RegistrationEnvelope(response) ?? {}
    const rawCapabilities = serverCapabilities(response)
    const names = parsedCapabilityNames(rawCapabilities)
    return this.save({
      ...scope,
      ...decision,
      receivedAt: new Date(receivedAtMs).toISOString(),
      evaluatedAt: new Date().toISOString(),
      capabilityReceived: names.includes(ACTIVITY_V2_CAPABILITY),
      advertisedCapability: decision.capabilitySupported ? ACTIVITY_NATIVE_TRANSPORT_V2 : null,
      responseContractVersion: typeof candidate.responseContractVersion === 'string' ? candidate.responseContractVersion : null,
      deploymentRevision: typeof candidate.deploymentRevision === 'string' ? candidate.deploymentRevision : null,
      predicates: decision.predicates,
    })
  }

  recordHandshakeDiagnostics(
    scope: ActivityV2HandshakeScope,
    capture: ActivityV2HandshakeCapture,
    response: unknown,
  ): ActivityV2HandshakeDiagnostics {
    const rawCapabilities = serverCapabilities(response)
    const names = parsedCapabilityNames(rawCapabilities)
    const redactedResponse = capture.responseReceived ? redactDiagnosticValue(response) : null
    const redactedCapabilities = rawCapabilities === undefined ? undefined : redactDiagnosticValue(rawCapabilities)
    const record: ActivityV2HandshakeDiagnostics = {
      ...scope,
      attemptedAt: capture.attemptedAt,
      httpStatus: capture.httpStatus,
      responseReceived: capture.responseReceived,
      responseJson: redactedResponse === null ? '' : JSON.stringify(redactedResponse, null, 2),
      rawServerCapabilities: redactedCapabilities === undefined ? 'Not present' : JSON.stringify(redactedCapabilities),
      parsedCapabilities: names,
      capabilityRawPresent: names.includes(ACTIVITY_V2_CAPABILITY),
      capabilityRecognized: names.includes(ACTIVITY_V2_CAPABILITY),
      resolvedRegistrationUrl: capture.resolvedRegistrationUrl,
      environmentMatch: capture.environmentMatch,
    }
    this.storage().setItem(HANDSHAKE_DIAGNOSTICS_KEY, JSON.stringify(record))
    return record
  }

  getHandshakeDiagnostics(scope: ActivityV2HandshakeScope): ActivityV2HandshakeDiagnostics | null {
    try {
      const stored = this.storage().getItem(HANDSHAKE_DIAGNOSTICS_KEY)
      if (!stored) return null
      const parsed = JSON.parse(stored) as Partial<ActivityV2HandshakeDiagnostics>
      if (parsed.ownerUserId !== scope.ownerUserId || parsed.installId !== scope.installId
        || parsed.connectorDeviceId !== scope.connectorDeviceId
        || typeof parsed.attemptedAt !== 'string' || !Number.isFinite(Date.parse(parsed.attemptedAt))
        || (parsed.httpStatus !== null && typeof parsed.httpStatus !== 'number')
        || typeof parsed.responseReceived !== 'boolean' || typeof parsed.responseJson !== 'string'
        || typeof parsed.rawServerCapabilities !== 'string' || !Array.isArray(parsed.parsedCapabilities)
        || typeof parsed.capabilityRawPresent !== 'boolean' || typeof parsed.capabilityRecognized !== 'boolean'
        || typeof parsed.resolvedRegistrationUrl !== 'string' || typeof parsed.environmentMatch !== 'boolean') return null
      return parsed as ActivityV2HandshakeDiagnostics
    } catch {
      return null
    }
  }

  recordFailure(ownerUserId: string, installId: string, connectorDeviceId: string | null, reason: string): ActivityV2CapabilityRecord {
    return this.save({
      ownerUserId, installId, connectorDeviceId: connectorDeviceId ?? '',
      capabilityReceived: false, capabilitySupported: false, productionDeliveryEnabled: false, reason,
      receivedAt: '', evaluatedAt: new Date().toISOString(), advertisedCapability: null,
      responseContractVersion: null, deploymentRevision: null,
      predicates: blockedPredicates(),
    })
  }

  getDecision(scope: ActivityV2HandshakeScope): ActivityV2CapabilityRecord {
    let stored: string | null
    try {
      stored = this.storage().getItem(STORAGE_KEY)
    } catch {
      return this.blocked(scope, 'CAPABILITY_STORAGE_UNAVAILABLE')
    }
    if (!stored) return this.blocked(scope, 'CAPABILITY_NOT_REGISTERED')
    try {
      const parsed = JSON.parse(stored) as Partial<ActivityV2CapabilityRecord>
      if (typeof parsed.ownerUserId !== 'string' || typeof parsed.installId !== 'string'
        || typeof parsed.connectorDeviceId !== 'string' || typeof parsed.reason !== 'string'
        || typeof parsed.capabilityReceived !== 'boolean' || typeof parsed.receivedAt !== 'string'
        || (parsed.receivedAt !== '' && !Number.isFinite(Date.parse(parsed.receivedAt)))
        || typeof parsed.evaluatedAt !== 'string' || !Number.isFinite(Date.parse(parsed.evaluatedAt))
        || (parsed.advertisedCapability !== null && typeof parsed.advertisedCapability !== 'string')
        || typeof parsed.capabilitySupported !== 'boolean' || typeof parsed.productionDeliveryEnabled !== 'boolean'
        || !isCapabilityPredicates(parsed.predicates)) {
        return this.blocked(scope, 'PERSISTED_DECISION_INVALID')
      }
      if (parsed.ownerUserId !== scope.ownerUserId || parsed.installId !== scope.installId
        || parsed.connectorDeviceId !== scope.connectorDeviceId) return this.blocked(scope, 'HANDSHAKE_SCOPE_MISMATCH')
      if (parsed.capabilitySupported && parsed.productionDeliveryEnabled
        && (parsed.reason !== 'CAPABILITY_SUPPORTED'
          || parsed.advertisedCapability !== ACTIVITY_NATIVE_TRANSPORT_V2
          || !allPredicatesValid(parsed.predicates as ActivityV2CapabilityPredicates))) {
        return this.blocked(scope, 'PERSISTED_DECISION_INVALID')
      }
      return {
        ownerUserId: parsed.ownerUserId, installId: parsed.installId, connectorDeviceId: parsed.connectorDeviceId,
        capabilityReceived: parsed.capabilityReceived,
        capabilitySupported: parsed.capabilitySupported,
        productionDeliveryEnabled: parsed.capabilitySupported && parsed.productionDeliveryEnabled
          && parsed.reason === 'CAPABILITY_SUPPORTED'
          && allPredicatesValid(parsed.predicates as ActivityV2CapabilityPredicates)
          && parsed.advertisedCapability === 'jcvital.native.activity.transport.v2',
        reason: parsed.reason, receivedAt: parsed.receivedAt, evaluatedAt: parsed.evaluatedAt,
        advertisedCapability: parsed.advertisedCapability,
        responseContractVersion: typeof parsed.responseContractVersion === 'string' ? parsed.responseContractVersion : null,
        deploymentRevision: typeof parsed.deploymentRevision === 'string' ? parsed.deploymentRevision : null,
        predicates: parsed.predicates as ActivityV2CapabilityPredicates,
      }
    } catch {
      return this.blocked(scope, 'PERSISTED_DECISION_INVALID')
    }
  }

  isEnabled(scope: ActivityV2HandshakeScope): boolean {
    return this.getDecision(scope).productionDeliveryEnabled
  }

  private blocked(scope: ActivityV2HandshakeScope, reason: string): ActivityV2CapabilityRecord {
    return {
      ...scope, capabilityReceived: false, capabilitySupported: false, productionDeliveryEnabled: false, reason,
      receivedAt: '', evaluatedAt: '', advertisedCapability: null,
      responseContractVersion: null, deploymentRevision: null,
      predicates: blockedPredicates(),
    }
  }

  private save(record: ActivityV2CapabilityRecord): ActivityV2CapabilityRecord {
    this.storage().setItem(STORAGE_KEY, JSON.stringify(record))
    return record
  }
}

export const activityV2CapabilityStore = new ActivityV2CapabilityStore()
