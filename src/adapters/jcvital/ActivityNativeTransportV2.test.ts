import 'fake-indexeddb/auto'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ACTIVITY_NATIVE_TRANSPORT_V2, ACTIVITY_V2_CAPABILITY, ACTIVITY_V2_PRODUCTION_ENABLED,
  activityV2CapabilityDecision, isActivityNativeTransportV2, prepareActivityNativeTransportV2,
} from './ActivityNativeTransportV2'
import {
  ACTIVITY_V2_FIXTURE_CONTEXT as context, activityV2FixtureSource as source, generateActivityNativeTransportV2Fixture,
} from './ActivityNativeTransportV2Fixtures'
import { activeActivityObservations, applyActivityCanonicalObservations, emptyActivityLedger, mapActivitySourceRecords } from './ActivityProductionCanonical'
import { WebQueueStore } from '../../services/storage/WebQueueStore'
import { observationQueue } from '../../services/sync/ObservationQueue'
import { ObservationBatchManager } from '../../services/sync/ObservationBatchManager'
import { authenticationService } from '../../services/base44/AuthenticationService'
import { connectorIdentityService } from '../../services/base44/ConnectorIdentityService'
import { activityV2CapabilityStore } from '../../services/base44/ActivityV2Capability'
import { installationIdentityService } from '../../services/storage/InstallationIdentityService'
import { connectorObservationService } from '../../services/base44/ConnectorObservationService'
import type { NetworkStatus } from '../../services/sync/NetworkStatus'
import { ConnectorServiceError } from '../../services/base44/base44Types'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('P1-2D native Activity v2 offline preparation', () => {
  it('preserves local date/timezone and qualified daily units without using receipt/UTC date', async () => {
    const record = source('24')
    record.receivedAt = '2026-10-21T05:30:00.000Z'
    const result = await prepareActivityNativeTransportV2(record, context)
    expect(result.payloads.map((p) => p.metric)).toEqual([
      'DAILY_STEPS', 'DAILY_DISTANCE', 'DAILY_CALORIES', 'DAILY_EXERCISE_DURATION',
    ])
    expect(result.payloads.map((p) => [p.valueNumber, p.unit])).toEqual([
      [4321, 'count'], [12.345, 'km'], [153.47, 'kcal'], [1537, 'second'],
    ])
    for (const payload of result.payloads) {
      expect(payload).toMatchObject({
        timezone: 'America/Los_Angeles', observedAtSource: '2026.10.20', startTime: '2026-10-20T07:00:00.000Z',
        rawSourceMetadata: { activityTransportVersion: ACTIVITY_NATIVE_TRANSPORT_V2, sourceLocalDate: '2026-10-20',
          sourceDataType: 24, timezoneSource: 'PHONE_TIMEZONE', deviceScopeId: context.deviceId },
      })
    }
    const duration = result.payloads.find((p) => p.metric === 'DAILY_EXERCISE_DURATION')!
    expect(duration).toMatchObject({ valueNumber: 1537, unit: 'second', vendorField: 'exerciseMinutes', vendorDerived: true,
      rawSourceMetadata: { rawUnit: 'second', normalizedMinutes: 1537 / 60, semanticLabel: 'V8 Exercise Duration', measured: false } })
    expect(Number.isInteger(duration.rawSourceMetadata?.normalizedMinutes)).toBe(false)
    expect(result.payloads.some((p) => p.metric === 'DAILY_EXERCISE_MINUTES')).toBe(false)
    expect(result.payloads.some((p) => p.metric === 'DAILY_GOAL_COMPLETION')).toBe(false)
  })

  it('carries complete physical Type25 evidence on the existing slot-0 anchor', async () => {
    const record = source('25')
    const before = structuredClone(record)
    const result = await prepareActivityNativeTransportV2(record, context)
    const epochs = result.payloads.filter((p) => p.metric === 'DETAILED_ACTIVITY_EPOCH')
    expect(epochs).toHaveLength(10)
    expect(epochs[0]).toMatchObject({
      valueNumber: 10, sequenceNumber: 0, startTime: '2026-10-20T17:28:53.000Z',
      rawSourceMetadata: {
        type25VendorDate: '2026.10.20 10:28:53', type25DetailMinterStep: '10',
        type25ArraySteps: '10,0,0,0,0,0,0,0,0,0', type25ArrayLength: 10, type25ArraySum: 10,
        type25IntegrityStatus: 'PASS', semanticPolicy: 'jcvital.type25.minute_anchor.v1',
        dateMeaning: 'FIRST_MINUTE', arrayOrdering: 'OLDEST_TO_NEWEST', slotDurationSeconds: 60, segmentSlots: 10,
        segmentAnchor: true, canonicalEligible: true,
      },
    })
    expect(epochs[9].startTime).toBe('2026-10-20T17:37:53.000Z')
    expect(epochs.slice(1).every((p) => p.rawSourceMetadata?.segmentAnchor === false
      && p.rawSourceMetadata?.canonicalEligible === false && p.rawSourceMetadata?.type25ArraySteps === undefined)).toBe(true)
    expect(result.payloads).toHaveLength(10)
    expect(record).toEqual(before)
    expect(result.source).toEqual(before)
  })

  it.each([
    [{ arraySteps: '10 0 0 0 0 0 0 0 0' }, 'ARRAY_LENGTH_NOT_10'],
    [{ detailMinterStep: '11' }, 'SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP'],
    [{ arraySteps: '', detailMinterStep: '0' }, 'ARRAY_LENGTH_NOT_10'],
  ])('preserves integrity-failed source and withholds canonical output for %j', async (fields, reason) => {
    const record = source('25', fields)
    const result = await prepareActivityNativeTransportV2(record, context)
    if (!result.payloads.length) {
      expect('arraySteps' in fields && fields.arraySteps === '').toBe(true)
      expect(result.reference.observations).toEqual([])
      expect(result.reference.withheld[0].reason).toBe(reason)
      return
    }
    const anchor = result.payloads.find((p) => p.rawSourceMetadata?.segmentAnchor === true)!
    expect(anchor.rawSourceMetadata).toMatchObject({ type25IntegrityStatus: 'FAIL', type25IntegrityReason: reason, canonicalEligible: false })
    expect(anchor.rawSourceMetadata).not.toHaveProperty('type25ArraySum')
    expect(result.reference.observations).toEqual([])
    expect(result.reference.withheld[0].reason).toBe(reason)
    expect(result.source).toEqual(record)
  })

  it('serializes ten maximum safe integers without truncation, retaining sum mismatch evidence', async () => {
    const steps = Array.from({ length: 10 }, () => Number.MAX_SAFE_INTEGER)
    const result = await prepareActivityNativeTransportV2(source('25', { arraySteps: steps, detailMinterStep: '0' }), context)
    const metadata = result.payloads[0].rawSourceMetadata!
    expect(metadata.type25ArraySteps).toBe(steps.join(','))
    expect(String(metadata.type25ArraySteps).split(',')).toHaveLength(10)
    expect(String(metadata.type25ArraySteps).length).toBeLessThan(512)
    expect(metadata.type25IntegrityStatus).toBe('FAIL')
  })

  it('fails explicitly instead of shortening oversized or malformed evidence', async () => {
    await expect(prepareActivityNativeTransportV2(source('25', {
      arraySteps: Array.from({ length: 100 }, () => Number.MAX_SAFE_INTEGER),
    }), context)).rejects.toThrow('never truncate')
    await expect(prepareActivityNativeTransportV2(source('25', { arraySteps: '10 0 x 0 0 0 0 0 0 0' }), context))
      .rejects.toThrow('Preserve the source')
    await expect(prepareActivityNativeTransportV2({ ...source('24'), sourceEnvelopeId: 'x'.repeat(257) }, context))
      .rejects.toThrow('never truncated')
  })

  it('fails closed for unknown scope or unavailable local time rather than substituting receipt time', async () => {
    await expect(prepareActivityNativeTransportV2(source('25'), { ...context, firmwareVersion: null })).rejects.toThrow('firmwareVersion')
    const changed = await prepareActivityNativeTransportV2(source('25'), { ...context, firmwareVersion: '0.0.8.9' })
    expect(changed.payloads[0].rawSourceMetadata).toMatchObject({ type25IntegrityStatus: 'FAIL', type25IntegrityReason: 'POLICY_SCOPE_MISMATCH', canonicalEligible: false })
    await expect(prepareActivityNativeTransportV2({ ...source('24'), timezone: null }, context)).rejects.toThrow('timezone')
  })

  it('does not mark or reinterpret legacy payloads when the production gate is enabled', async () => {
    const payload = (await prepareActivityNativeTransportV2(source('24'), context)).payloads[0]
    const legacy = { ...payload, rawSourceMetadata: { canonicalPolicy: 'NATIVE_ONLY' } }
    const bytes = JSON.stringify(legacy)
    expect(isActivityNativeTransportV2(legacy)).toBe(false)
    expect(JSON.stringify(legacy)).toBe(bytes)
    expect(isActivityNativeTransportV2(payload)).toBe(true)
    expect(ACTIVITY_V2_PRODUCTION_ENABLED).toBe(true)
  })

  it('generates exactly the checked-in offline fixture and the unchanged v65 oracle for every action', async () => {
    const fixture = await generateActivityNativeTransportV2Fixture()
    const saved = JSON.parse(readFileSync(new URL('../../../docs/evidence/p1-2d/activity-native-transport-v2-fixture.json', import.meta.url), 'utf8'))
    expect(fixture).toEqual(saved)
    for (const scenario of fixture.scenarios) {
      let ledger = emptyActivityLedger()
      for (const action of scenario.actions) {
        const reference = await mapActivitySourceRecords([action.source], context, Date.parse(action.source.receivedAt))
        expect(action.expectedCanonicalOutput).toEqual(reference.observations)
        expect(action.expectedWithheld).toEqual(reference.withheld)
        const first = action.outgoingNativeObservations[0]
        const anchor = action.outgoingNativeObservations.find((p) => p.rawSourceMetadata?.segmentAnchor === true)
        const record: Record<string, unknown> = { date: first.observedAtSource }
        for (const payload of action.outgoingNativeObservations) {
          if (payload.vendorField && payload.vendorField !== 'arraySteps') record[payload.vendorField] = payload.rawSourceMetadata?.vendorRawValue
        }
        if (anchor) {
          record.date = anchor.rawSourceMetadata?.type25VendorDate
          record.arraySteps = String(anchor.rawSourceMetadata?.type25ArraySteps).split(',').join(' ')
          record.detailMinterStep = anchor.rawSourceMetadata?.type25DetailMinterStep
        }
        const fromWire = await mapActivitySourceRecords([{
          ...action.source, record, timezone: first.timezone, sourceEnvelopeId: String(first.rawSourceMetadata?.sourceEnvelopeId),
          acquisitionSessionId: String(first.rawSourceMetadata?.acquisitionSessionId),
        }], {
          ownerUserId: context.ownerUserId, deviceId: first.deviceId ?? null, deviceModel: first.deviceModel ?? null,
          firmwareVersion: first.firmwareVersion ?? null, sdkVersion: first.sdkVersion ?? null,
        }, Date.parse(first.receivedAt!))
        const withoutSourceFingerprint = (observations: typeof reference.observations) => observations.map((observation) => ({
          ...observation,
          provenance: { ...observation.provenance, sourcePayloadFingerprint: '[bounded source evidence]' },
        }))
        expect(withoutSourceFingerprint(fromWire.observations)).toEqual(withoutSourceFingerprint(reference.observations))
        expect(fromWire.withheld).toEqual(reference.withheld)
        const applied = applyActivityCanonicalObservations(ledger, reference.observations)
        expect(action.expectedLedgerOutcomes).toEqual(applied.outcomes)
        ledger = applied.state
      }
      expect(scenario.expectedFinalCanonicalRows).toHaveLength(activeActivityObservations(ledger).length)
    }
    expect(fixture.scenarios.find((s) => s.name === 'type24-same-day-correction')?.expectedFinalCanonicalRows).toHaveLength(4)
    expect(fixture.scenarios.find((s) => s.name === 'type25-exact-replay')?.expectedFinalCanonicalRows).toHaveLength(10)
    expect(fixture.scenarios.find((s) => s.name === 'type25-conflicting-replay')?.expectedSourceConflicts).toHaveLength(10)
    const gap = fixture.scenarios.find((s) => s.name === 'type25-missing-segment')!.expectedFinalCanonicalRows
    expect(gap).toHaveLength(20)
    expect(gap.some((row) => row.observedAt === '2026-10-20T17:30:06.000Z')).toBe(false)
    const authority = fixture.scenarios.find((s) => s.name === 'type25-never-replaces-type24-daily-authority')!.expectedFinalCanonicalRows
    expect(authority.filter((row) => row.metric.startsWith('DAILY_')).map((row) => row.value).sort((a, b) => a - b)).toEqual([12.345, 153.47, 4321])
  })

  it('round-trips exact v2 payload bytes through existing queue schema, restart, claim, ACK and purge', async () => {
    const store = new WebQueueStore()
    await store.initialize()
    expect(store.getSchemaVersion()).toBe(8)
    const payloads = [
      ...(await prepareActivityNativeTransportV2(source('24'), context)).payloads,
      ...(await prepareActivityNativeTransportV2(source('25'), context)).payloads,
      ...(await prepareActivityNativeTransportV2(source('25', {
        detailMinterStep: '12', arraySteps: '12 0 0 0 0 0 0 0 0 0',
      }, 'fixture-queued-conflict'), context)).payloads,
    ]
    const anchors = payloads.filter((payload) => payload.rawSourceMetadata?.segmentAnchor === true)
    expect(anchors).toHaveLength(2)
    expect(anchors[0].sourceRecordId).toBe(anchors[1].sourceRecordId)
    expect(anchors[0].observationId).not.toBe(anchors[1].observationId)
    const owner = 'p1-2d-store-owner'
    await store.enqueueMany(owner, payloads)
    const duplicates = await store.enqueueMany(owner, payloads)
    expect(duplicates.every((row) => row.alreadyQueued)).toBe(true)
    const reopened = new WebQueueStore()
    const claims = await reopened.claimPending(owner, 100, 'p1-2d-batch')
    expect(claims.map((row) => JSON.stringify(row.payload))).toEqual(payloads.map((row) => JSON.stringify(row)))
    await reopened.acknowledgeClaims(claims.map((row) => ({
      queueId: row.queueId, batchId: row.batchId!, attemptCount: row.attemptCount,
    })), owner)
    expect((await reopened.getRecord(owner, payloads[0].observationId))?.state).toBe('ACKNOWLEDGED')
    expect(await reopened.purgeAcknowledged(owner)).toBe(payloads.length)
    expect(await reopened.getRecord(owner, payloads[0].observationId)).toBeNull()
  })

  it('keeps complete contract examples identical to the generated outgoing payloads', async () => {
    const contract = readFileSync(new URL('../../../docs/BASE44_ACTIVITY_NATIVE_TRANSPORT_V2_CONTRACT.md', import.meta.url), 'utf8')
    const examples = [...contract.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]))
    const fixture = await generateActivityNativeTransportV2Fixture()
    const outgoing = fixture.scenarios[0].actions.flatMap((action) => action.outgoingNativeObservations)
    expect(examples).toHaveLength(3)
    expect(examples[0]).toEqual(outgoing.find((payload) => payload.metric === 'DAILY_EXERCISE_DURATION'))
    expect(examples[1]).toEqual(outgoing.find((payload) => payload.rawSourceMetadata?.segmentAnchor === true))
    expect(examples[2].capabilities).toEqual([ACTIVITY_V2_CAPABILITY])
  })

  it('uses the existing single sender unchanged in a mocked retry/duplicate-ACK integration test only', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } })
    const payloads = (await prepareActivityNativeTransportV2(source('24'), context)).payloads
    observationQueue.setOwnerUserId('p1-2d-sender-test')
    await observationQueue.initialize()
    await observationQueue.enqueueMany(payloads)
    connectorIdentityService.setConnectorDeviceId('p1-2d-test-device')
    activityV2CapabilityStore.recordRegistrationResponse({
      success: true,
      installId: installationIdentityService.getInstallId(),
      connectorDeviceId: 'p1-2d-test-device',
      status: 'active',
      registeredAt: '2026-10-21T00:00:00.000Z',
      serverTimestamp: '2026-10-21T00:00:00.000Z',
      sources: [],
      responseContractVersion: 'native-observations-results-v1',
      deploymentRevision: 'nc-observations-2026-10-21-r7-activity-canonical',
      capabilities: { [ACTIVITY_V2_CAPABILITY]: ACTIVITY_NATIVE_TRANSPORT_V2 },
    }, {
      ownerUserId: 'p1-2d-sender-test',
      installId: installationIdentityService.getInstallId(),
      connectorDeviceId: 'p1-2d-test-device',
    }, true)
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
      .mockRejectedValueOnce(new ConnectorServiceError('NETWORK_ERROR', 'mock offline'))
      .mockResolvedValue({
        success: true, batchId: 'fixture-server-batch', accepted: 0, duplicate: payloads.length, rejected: 0,
        errors: [], serverTimestamp: '2026-10-21T00:00:00Z',
        results: payloads.map((p) => ({ observationId: p.observationId, status: 'duplicate', canonicalStatus: 'not_applicable' })),
      })
    const network: NetworkStatus = { isOnline: () => true, subscribe: () => () => undefined }
    const manager = new ObservationBatchManager({ retryBaseMs: 1, retryMaxMs: 1 }, network)
    await manager.process()
    expect((await observationQueue.getRecord(payloads[0].observationId))?.state).toBe('RETRY_WAIT')
    await vi.waitFor(async () => { await manager.process(); expect(upload).toHaveBeenCalledTimes(2) })
    for (const [request] of upload.mock.calls) {
      expect(request.observations.map((p) => JSON.stringify(p))).toEqual(payloads.map((p) => JSON.stringify(p)))
    }
    expect(await observationQueue.getRecord(payloads[0].observationId)).toBeNull()
  })

  it('holds already-queued v2 rows when registration no longer advertises support', async () => {
    const values = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
      removeItem: (key: string) => { values.delete(key) },
    })
    const owner = 'p1-2d-disabled-sender-test'
    const payloads = (await prepareActivityNativeTransportV2(source('24'), { ...context, ownerUserId: owner })).payloads
    observationQueue.setOwnerUserId(owner)
    await observationQueue.initialize()
    await observationQueue.enqueueMany(payloads)
    connectorIdentityService.setConnectorDeviceId('p1-2d-disabled-device')
    vi.spyOn(authenticationService, 'isAuthenticated').mockResolvedValue(true)
    const upload = vi.spyOn(connectorObservationService, 'submitObservations')
    const network: NetworkStatus = { isOnline: () => true, subscribe: () => () => undefined }
    const manager = new ObservationBatchManager({}, network)
    await manager.process()
    expect(upload).not.toHaveBeenCalled()
    expect((await observationQueue.getRecord(payloads[0].observationId))?.state).toBe('PENDING')
  })
})

describe('P1-2D registration capability gate', () => {
  const scope = { ownerUserId: 'fixture-owner', installId: 'fixture-install', connectorDeviceId: 'fixture-connector' }
  const response = {
    success: true, installId: scope.installId, connectorDeviceId: scope.connectorDeviceId,
    status: 'active',
    registeredAt: '2026-10-21T00:00:00.000Z',
    serverTimestamp: '2026-10-21T00:00:00.000Z',
    sources: ['JCVITAL'],
    capabilities: [ACTIVITY_V2_CAPABILITY],
  }
  const decision = (value: unknown, environmentValid = true) =>
    activityV2CapabilityDecision(value, scope, scope, 1000, 2000, environmentValid)

  it.each([null, {}, { ...response, capabilities: undefined },
    { ...response, capabilities: { [ACTIVITY_V2_CAPABILITY]: true } },
    { ...response, capabilities: { [ACTIVITY_V2_CAPABILITY]: 'v1' } },
  ])('absent or ambiguous capability cannot enable production: %j', (value) => {
    expect(decision(value)).toMatchObject({ capabilitySupported: false, productionDeliveryEnabled: false })
  })

  it('accepts the current production response without the obsolete responseContractVersion field', () => {
    expect(decision(response)).toMatchObject({
      capabilitySupported: true,
      productionDeliveryEnabled: true,
      reason: 'CAPABILITY_SUPPORTED',
      predicates: {
        registrationResponseAvailable: true,
        registrationSuccess: true,
        registrationStatusValid: true,
        productionEnvironmentValid: true,
        capabilityRawPresent: true,
        capabilityRecognized: true,
        scopeValid: true,
        contractValid: true,
        registrationIdentityValid: true,
        freshnessValid: true,
      },
    })
  })

  it('fails closed for absent, unknown, non-production, failed, or invalid-identity registrations', () => {
    expect(decision({ ...response, capabilities: [] }).reason).toBe('CAPABILITY_ABSENT')
    expect(decision({ ...response, capabilities: ['UNKNOWN_CAPABILITY'] }).reason).toBe('CAPABILITY_ABSENT')
    expect(decision(response, false).reason).toBe('PRODUCTION_ENVIRONMENT_MISMATCH')
    expect(decision({ ...response, success: false }).capabilitySupported).toBe(false)
    expect(decision({ ...response, installId: 'other' }).reason).toBe('REGISTRATION_IDENTITY_MISMATCH')
    expect(decision({ ...response, connectorDeviceId: 'other' }).reason).toBe('REGISTRATION_IDENTITY_MISMATCH')
    expect(decision({ ...response, status: 'disabled' }).reason).toBe('REGISTRATION_STATUS_INVALID')
    expect(decision({ ...response, registeredAt: 'invalid' }).reason).toBe('REGISTRATION_CONTRACT_INVALID')
    expect(activityV2CapabilityDecision(response, scope, { ...scope, ownerUserId: 'other' }, 1000, 2000, true).reason).toBe('HANDSHAKE_SCOPE_MISMATCH')
    expect(activityV2CapabilityDecision(response, scope, { ...scope, installId: 'other' }, 1000, 2000, true).reason).toBe('HANDSHAKE_SCOPE_MISMATCH')
    expect(activityV2CapabilityDecision(response, scope, { ...scope, connectorDeviceId: 'other' }, 1000, 2000, true).reason).toBe('HANDSHAKE_SCOPE_MISMATCH')
    expect(activityV2CapabilityDecision(response, scope, scope, 1000, 301000, true).capabilitySupported).toBe(true)
    expect(activityV2CapabilityDecision(response, scope, scope, 1000, 301001, true).reason).toBe('HANDSHAKE_STALE')
    expect(activityV2CapabilityDecision(response, scope, scope, 3000, 2000, true).reason).toBe('HANDSHAKE_STALE')
  })

  it.each([
    { ...response, SERVER_CAPABILITIES: [ACTIVITY_V2_CAPABILITY], capabilities: undefined },
    { ...response, server_capabilities: [ACTIVITY_V2_CAPABILITY], capabilities: undefined },
    { ...response, result: { ...response, capabilities: undefined, SERVER_CAPABILITIES: [ACTIVITY_V2_CAPABILITY] }, capabilities: undefined },
  ])('recognizes the production SERVER_CAPABILITIES registration shape: %j', (value) => {
    expect(decision(value)).toMatchObject({ capabilitySupported: true, productionDeliveryEnabled: true })
  })
})
