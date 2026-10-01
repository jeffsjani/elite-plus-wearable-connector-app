import { afterEach, describe, expect, it, vi } from 'vitest'
import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { BatchDeliveryListener } from '../../services/sync/ObservationBatchManager'
import { JCVitalDeviceIdentityService } from '../../services/storage/JCVitalDeviceIdentityService'
import type { JCVitalV8WorkoutHeartRateEvent } from './jcvitalV8Bridge'
import {
  buildWorkoutHrObservation,
  buildWorkoutHrSourceRecordId,
  validateWorkoutHrObservation,
  WORKOUT_HR_DELIVERY_POLICY,
  WorkoutHrDeliveryService,
} from './WorkoutHrDelivery'

const TEST_MAC = 'E7:1B:D8:36:78:CF'
const OPAQUE_ID = 'jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b'
const context = { deviceId: OPAQUE_ID, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0', vendorActivityMode: 0 }

class MemoryStorage {
  readonly values = new Map<string, string>()
  getItem(key: string): string | null { return this.values.get(key) ?? null }
  setItem(key: string, value: string): void { this.values.set(key, value) }
}

function hr(packetSequence: number, heartRate = 80 + (packetSequence % 20), sessionId = 'session-1'): JCVitalV8WorkoutHeartRateEvent {
  return {
    sessionId, heartRate, packetSequence, vendorDataType: '82', acquisitionMode: 'WORKOUT_REALTIME',
    receivedAt: new Date(Date.UTC(2026, 9, 1, 10, 0, packetSequence)).toISOString(),
  }
}

/** In-memory stand-in for the durable queue, ObservationBatchManager and an idempotent nativeConnectorObservations backend. */
class Harness {
  owner: string | null = 'user-1'
  outage = false
  failEnqueue = false
  posts: NativeObservationInput[][] = []
  readonly rows = new Map<string, { payload: NativeObservationInput; state: 'PENDING' | 'RETRY_WAIT' }>()
  readonly server = new Map<string, NativeObservationInput>()
  private readonly listeners = new Set<BatchDeliveryListener>()
  private readonly identityStorage = new MemoryStorage()

  readonly deps = {
    resolveDeviceId: (bleAddress: string) => new JCVitalDeviceIdentityService(() => this.identityStorage).resolve(bleAddress),
    queue: {
      getOwnerUserId: () => this.owner,
      enqueue: async (observation: NativeObservationInput) => {
        if (this.failEnqueue) throw new Error('sqlite busy')
        if (this.rows.has(observation.observationId)) return { inserted: false, alreadyQueued: true }
        this.rows.set(observation.observationId, { payload: observation, state: 'PENDING' })
        return { inserted: true, alreadyQueued: false }
      },
    },
    deliver: async () => {
      const batch = [...this.rows.values()].slice(0, 100)
      if (!batch.length) return null
      const ids = batch.map((row) => row.payload.observationId)
      this.posts.push(batch.map((row) => row.payload))
      const attemptedAt = new Date().toISOString()
      if (this.outage) {
        batch.forEach((row) => { row.state = 'RETRY_WAIT' })
        this.listeners.forEach((listener) => listener({ batchId: `b${this.posts.length}`, attemptedAt, outcome: 'RETRYING', observationIds: ids, acknowledgedIds: [], rejectedIds: [], httpStatus: 503, errorCode: 'SERVER_ERROR', accepted: null, duplicate: null, rejected: null }))
        return null
      }
      let accepted = 0
      let duplicate = 0
      for (const row of batch) {
        if (this.server.has(row.payload.observationId)) duplicate++
        else { this.server.set(row.payload.observationId, row.payload); accepted++ }
        this.rows.delete(row.payload.observationId)
      }
      this.listeners.forEach((listener) => listener({ batchId: `b${this.posts.length}`, attemptedAt, outcome: 'DELIVERED', observationIds: ids, acknowledgedIds: ids, rejectedIds: [], httpStatus: 200, errorCode: null, accepted, duplicate, rejected: 0 }))
      return { success: true, accepted, duplicate }
    },
    subscribe: (listener: BatchDeliveryListener) => { this.listeners.add(listener); return () => { this.listeners.delete(listener) } },
  }
}

function service(harness: Harness): WorkoutHrDeliveryService {
  const delivery = new WorkoutHrDeliveryService(harness.deps)
  delivery.setContext({ bleAddress: TEST_MAC, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0', vendorActivityMode: 0 })
  delivery.setEnabled(true)
  delivery.start()
  return delivery
}

describe('JCVital workout HR golden path', () => {
  afterEach(() => vi.useRealTimers())

  it('maps a workout HR packet to a NativeObservation with JCVITAL_NATIVE / DIRECT_BLE provenance', async () => {
    const observation = await buildWorkoutHrObservation('user-1', hr(7, 132), context, 'UTC')
    expect(observation).toMatchObject({
      source: 'jcvital_native', provider: 'JCVITAL', metric: 'heartRate', metricType: 'HEART_RATE', valueNumber: 132, unit: 'bpm',
      sourceConnector: 'JCVITAL_NATIVE', sourceProvider: 'JCVITAL', sourcePath: 'DIRECT_BLE', deviceModel: 'PRO_V8',
      acquisitionMode: 'WORKOUT_REALTIME', measurementContext: 'WORKOUT', sessionId: 'session-1', packetSequence: 7,
      deviceId: OPAQUE_ID, sourceId: OPAQUE_ID, firmwareVersion: '0.0.8.8', sdkVersion: 'v8sdk2.0', vendorDataType: '82',
      observedAt: hr(7).receivedAt, receivedAt: hr(7).receivedAt, startTime: hr(7).receivedAt,
      observedAtSource: 'CONNECTOR_BLE_RECEIPT_TIME', timestampConfidence: 'RECEIPT_TIME_NO_VENDOR_TIMESTAMP',
      rawSourceMetadata: { vendorDataType: '82', vendorTimestamp: null, vendorActivityMode: 0 },
    })
    expect(observation?.sourceRecordId).toBe(buildWorkoutHrSourceRecordId(OPAQUE_ID, 'session-1', 7, hr(7).receivedAt))
    expect(observation).not.toHaveProperty('rawVendorPayload')
    expect(validateWorkoutHrObservation(observation!)).toEqual([])
  })

  it('sends only the opaque device ID and never the BLE MAC', async () => {
    const harness = new Harness()
    const delivery = service(harness)
    for (let sequence = 1; sequence <= 3; sequence++) delivery.handleHeartRate(hr(sequence))
    await delivery.flush('MANUAL')

    const sent = harness.posts.flat()
    expect(sent).toHaveLength(3)
    const backendDeviceId = delivery.getSnapshot().backendDeviceId
    expect(backendDeviceId).toMatch(/^jcvital_device_[0-9a-f-]{36}$/)
    for (const observation of sent) {
      expect(observation.deviceId).toBe(backendDeviceId)
      expect(observation.sourceId).toBe(backendDeviceId)
      expect(observation.sourceRecordId).toContain(backendDeviceId!)
      expect(observation.sourceRecordId).not.toMatch(/E7:1B:D8:36:78:CF/i)
      expect(JSON.stringify(observation)).not.toMatch(/E7[:-]?1B[:-]?D8[:-]?36[:-]?78[:-]?CF/i)
    }
    expect(JSON.stringify(delivery.getSnapshot())).not.toMatch(/E7:1B:D8:36:78:CF/i)
    delivery.dispose()
  })

  it('never places a raw MAC in the payload even if one is passed as context', async () => {
    const observation = await buildWorkoutHrObservation('user-1', hr(1), { ...context, deviceId: TEST_MAC })
    expect(observation?.deviceId).toBe('UNKNOWN_DEVICE')
    expect(JSON.stringify(observation)).not.toContain(TEST_MAC)
    expect(validateWorkoutHrObservation({ ...observation!, deviceId: TEST_MAC })).toEqual(expect.arrayContaining([
      'deviceId must be an opaque jcvital_device_ ID',
      'payload must not contain a Bluetooth MAC address',
    ]))
  })

  it('keeps replayed observation IDs identical across reconnects of the same V8', async () => {
    const harness = new Harness()
    const first = service(harness)
    first.handleHeartRate(hr(5))
    await first.flush('MANUAL')
    first.dispose()

    const reconnected = service(harness)
    reconnected.setContext({ bleAddress: 'e7-1b-d8-36-78-cf' })
    reconnected.handleHeartRate(hr(5))
    await reconnected.flush('MANUAL')

    const [original, replay] = harness.posts.flat()
    expect(replay.observationId).toBe(original.observationId)
    expect(replay.sourceRecordId).toBe(original.sourceRecordId)
    expect(harness.server.size).toBe(1)
    reconnected.dispose()
  })

  it('derives a stable idempotency key from device, session, metric, sequence and observed time', async () => {
    const first = await buildWorkoutHrObservation('user-1', hr(3), context)
    const replay = await buildWorkoutHrObservation('user-1', hr(3), context)
    const nextPacket = await buildWorkoutHrObservation('user-1', hr(4, hr(3).heartRate), context)
    const otherSession = await buildWorkoutHrObservation('user-1', hr(3, undefined, 'session-2'), context)
    expect(first?.observationId).toMatch(/^[0-9a-f]{64}$/)
    expect(replay?.observationId).toBe(first?.observationId)
    expect(nextPacket?.observationId).not.toBe(first?.observationId)
    expect(otherSession?.observationId).not.toBe(first?.observationId)
  })

  it('rejects malformed observations in preflight and never sends zero startup HR', async () => {
    expect(await buildWorkoutHrObservation('user-1', hr(1, 0), context)).toBeNull()
    const valid = (await buildWorkoutHrObservation('user-1', hr(1), context))!
    expect(validateWorkoutHrObservation({ ...valid, unit: 'count' })).toContain('unit must be bpm')
    expect(validateWorkoutHrObservation({ ...valid, sourcePath: 'CLOUD' })).toContain('sourcePath must be DIRECT_BLE')
    expect(validateWorkoutHrObservation({ ...valid, valueNumber: 400 })).toContain('valueNumber must be a positive plausible bpm')
  })

  it('queues captured HR and delivers in batches instead of one request per packet', async () => {
    vi.useFakeTimers()
    const harness = new Harness()
    const delivery = service(harness)
    delivery.handleHeartRate(hr(0, 0))
    for (let sequence = 1; sequence <= 30; sequence++) delivery.handleHeartRate(hr(sequence))
    await delivery.flush('MANUAL')

    const snapshot = delivery.getSnapshot()
    expect(snapshot).toMatchObject({ captured: 31, skippedNonDeliverable: 1, queued: 30, delivered: 30, failed: 0 })
    expect(harness.posts.length).toBeLessThanOrEqual(2)
    expect(harness.posts.flat().map((observation) => observation.packetSequence)).toEqual(Array.from({ length: 30 }, (_, index) => index + 1))
    expect(new Set(harness.posts.flat().map((observation) => observation.observedAt)).size).toBe(30)
    delivery.dispose()
  })

  it('flushes a partial batch on the interval timer', async () => {
    vi.useFakeTimers()
    const harness = new Harness()
    const delivery = service(harness)
    for (let sequence = 1; sequence < WORKOUT_HR_DELIVERY_POLICY.flushObservationCount; sequence++) delivery.handleHeartRate(hr(sequence))
    await vi.waitFor(() => expect(delivery.getSnapshot().queued).toBe(WORKOUT_HR_DELIVERY_POLICY.flushObservationCount - 1))
    expect(harness.posts).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(WORKOUT_HR_DELIVERY_POLICY.flushIntervalMs)
    await vi.waitFor(() => expect(delivery.getSnapshot().delivered).toBe(WORKOUT_HR_DELIVERY_POLICY.flushObservationCount - 1))
    expect(harness.posts).toHaveLength(1)
    delivery.dispose()
  })

  it('keeps observations through a backend outage and retries them successfully', async () => {
    vi.useFakeTimers()
    const harness = new Harness()
    harness.outage = true
    const delivery = service(harness)
    for (let sequence = 1; sequence <= 20; sequence++) delivery.handleHeartRate(hr(sequence))
    await delivery.flush('MANUAL')
    expect(delivery.getSnapshot()).toMatchObject({ queued: 20, retrying: 20, delivered: 0, failed: 0, lastResult: { outcome: 'RETRYING', httpStatus: 503 } })
    expect(harness.rows.size).toBe(20)

    harness.outage = false
    await vi.advanceTimersByTimeAsync(WORKOUT_HR_DELIVERY_POLICY.flushIntervalMs)
    await vi.waitFor(() => expect(delivery.getSnapshot().delivered).toBe(20))
    expect(delivery.getSnapshot()).toMatchObject({ retrying: 0, delivered: 20, lastResult: { outcome: 'DELIVERED' } })
    expect(harness.server.size).toBe(20)
    delivery.dispose()
  })

  it('replays the same observations without creating additional backend records', async () => {
    const harness = new Harness()
    const delivery = service(harness)
    for (let sequence = 1; sequence <= 10; sequence++) delivery.handleHeartRate(hr(sequence))
    await delivery.flush('MANUAL')
    expect(harness.server.size).toBe(10)

    await delivery.replay()
    expect(harness.server.size).toBe(10)
    expect(delivery.getSnapshot()).toMatchObject({ delivered: 10, replayQueued: 10, replayAcknowledged: 10, serverAcceptedInBatches: 10, serverDuplicateInBatches: 10 })

    delivery.handleHeartRate(hr(1))
    await delivery.flush('MANUAL')
    expect(harness.server.size).toBe(10)
    delivery.dispose()
  })

  it('flushes remaining observations once when the workout stops', async () => {
    const harness = new Harness()
    const delivery = service(harness)
    for (let sequence = 1; sequence <= 5; sequence++) delivery.handleHeartRate(hr(sequence))
    await delivery.handleWorkoutEnded('session-1')
    await delivery.handleWorkoutEnded('session-1')
    expect(harness.posts).toHaveLength(1)
    expect(delivery.getSnapshot()).toMatchObject({ delivered: 5, workoutStopFlushes: 1, lastFlushReason: 'WORKOUT_STOP' })
    delivery.dispose()
  })

  it('retains HR that could not be written to the queue and enqueues it on the next flush', async () => {
    const harness = new Harness()
    harness.failEnqueue = true
    const delivery = service(harness)
    delivery.handleHeartRate(hr(1))
    delivery.handleHeartRate(hr(2))
    await delivery.flush('MANUAL')
    // Two capture-time failures plus two failed retries during the flush.
    expect(delivery.getSnapshot()).toMatchObject({ enqueueErrors: 4, awaitingEnqueue: 2, queued: 0 })

    harness.failEnqueue = false
    await delivery.flush('MANUAL')
    expect(delivery.getSnapshot()).toMatchObject({ awaitingEnqueue: 0, queued: 2, delivered: 2 })
    delivery.dispose()
  })

  it('counts capture but does not queue while delivery is disabled', async () => {
    const harness = new Harness()
    const delivery = service(harness)
    delivery.setEnabled(false)
    delivery.handleHeartRate(hr(1))
    await delivery.flush('MANUAL')
    expect(delivery.getSnapshot()).toMatchObject({ captured: 1, capturedWhileDisabled: 1, queued: 0 })
    expect(harness.posts).toHaveLength(0)
    delivery.dispose()
  })
})
