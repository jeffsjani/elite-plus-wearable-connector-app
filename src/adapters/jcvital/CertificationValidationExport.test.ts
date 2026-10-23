import { describe, expect, it, vi } from 'vitest'
import { CERTIFICATION_BUILD, buildCertificationValidationExport, serializeCertificationValidationExport } from './CertificationValidationExport'
import { CERTIFICATION_ORDER, mappedEvidence, type CertificationObservation } from './JCVitalCertification'
import { buildPhase3AValidationReport } from './Phase3AValidation'
import { TemperatureCertification } from './TemperatureCertification'

const context = { deviceId: null, firmwareVersion: null, sdkVersion: null, vendorActivityMode: null }
const baseline = () => buildCertificationValidationExport(
  { deviceInfo: null, historicalRuns: {} },
  { ownerUserId: null, physiologyContext: context, workoutContext: context },
)

function restoredTemperatureEvidence() {
  const stored = new Map<string, string>()
  const flush = vi.fn()
  const deps = {
    queue: { getOwnerUserId: () => 'owner-1', getRecord: vi.fn().mockResolvedValue(null) },
    flush,
    storage: () => ({
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
    }),
  }
  const observations = Array.from({ length: 5 }, (_, index) => ({
    observationId: String(index + 1).padStart(64, '0'),
    source: 'JCVITAL_NATIVE', provider: 'JCVITAL', metric: 'wearableTemperature',
    vendorDataType: '59', valueNumber: 36.4, unit: 'celsius',
    startTime: `2026-10-03T10:0${index}:00.000Z`, capturedAt: '2026-10-03T10:05:00.000Z',
    timezone: 'UTC', measurementMethod: 'WEARABLE_SKIN_SENSOR',
  }))
  const certification = new TemperatureCertification(deps)
  certification.remember(observations)
  const ids = observations.map((item) => item.observationId)
  certification.record({
    batchId: 'temperature-batch', attemptedAt: '2026-10-03T10:06:00.000Z',
    outcome: 'DELIVERED', observationIds: ids, acknowledgedIds: ids,
    rejectedIds: [], httpStatus: 200, errorCode: null, accepted: 5, duplicate: 0, rejected: 0,
    results: ids.map((observationId) => ({
      observationId, status: 'accepted', canonicalStatus: 'canonicalized', nativeObservationId: `native-${observationId}`,
    })),
  })
  return { deps, observations, samples: new TemperatureCertification(deps).snapshot().samples }
}

async function exportRestoredTemperature(samples: CertificationObservation[], readQueueRecord?: () => Promise<null>) {
  const payload = await buildCertificationValidationExport(
    { deviceInfo: null, historicalRuns: {} },
    { ownerUserId: 'owner-1', physiologyContext: context, workoutContext: context,
      persistedTemperatureSamples: samples, readQueueRecord },
  )
  return JSON.parse(serializeCertificationValidationExport(payload)).jcvitalCertification.wearableTemperature
}

describe('final certification validation export used by native share and browser download', () => {
  it('exports five persisted exact accepted/canonicalized temperature results as a prior pass after restart without reacquisition or delivery', async () => {
    const { deps, samples } = restoredTemperatureEvidence()
    const temperature = await exportRestoredTemperature(samples, deps.queue.getRecord)
    expect(temperature.physicalCaptureStatus).toBe('PASS_PREVIOUSLY_REPORTED')
    expect(temperature.physicalCaptureStatus).not.toBe('NOT_CAPTURED')
    expect(temperature.observationCount).toBe(5)
    expect(temperature.observations).toEqual(samples.map((sample) => ({ ...sample, queueDisposition: 'ACKNOWLEDGED_PURGED' })))
    expect(deps.queue.getRecord).toHaveBeenCalledTimes(5)
    expect(deps.flush).not.toHaveBeenCalled()
  })

  it.each(['missing', 'mismatched-id', 'canonical-failed', 'missing-native-id', 'rejected', 'unacknowledged'] as const)(
    'does not claim a persisted temperature pass with %s exact delivery evidence',
    async (failure) => {
      const { samples } = restoredTemperatureEvidence()
      const evidence = samples[0].deliveryResult!
      const result = evidence.result!
      if (failure === 'missing') samples[0].deliveryResult = null
      if (failure === 'mismatched-id') result.observationId = 'f'.repeat(64)
      if (failure === 'canonical-failed') result.canonicalStatus = 'failed'
      if (failure === 'missing-native-id') result.nativeObservationId = null
      if (failure === 'rejected') result.status = 'rejected'
      if (failure === 'unacknowledged') evidence.acknowledged = false
      expect((await exportRestoredTemperature(samples)).physicalCaptureStatus).toBe('CAPTURED_PREVIOUSLY_REPORTED')
    },
  )

  it('accepts exact canonicalized duplicates but does not override queue recovery evidence', async () => {
    const { samples } = restoredTemperatureEvidence()
    samples[0].deliveryResult!.result!.status = 'duplicate'
    samples[0].deliveryResult!.result!.nativeObservationId = null
    expect((await exportRestoredTemperature(samples)).physicalCaptureStatus).toBe('PASS_PREVIOUSLY_REPORTED')
    samples[0].queueState = 'CANONICAL_RECOVERY_REQUIRED'
    expect((await exportRestoredTemperature(samples)).physicalCaptureStatus).toBe('CAPTURED_PREVIOUSLY_REPORTED')
  })

  it('reports persisted capture without turning computed IDs or fewer than five successes into a pass', async () => {
    const { observations, samples } = restoredTemperatureEvidence()
    const captured = observations.map((input) => mappedEvidence(input, 'CANONICAL', 'body.wearable_temperature', new Map()))
    expect((await exportRestoredTemperature(captured)).physicalCaptureStatus).toBe('CAPTURED_PREVIOUSLY_REPORTED')
    expect((await exportRestoredTemperature(samples.slice(0, 4))).physicalCaptureStatus).toBe('CAPTURED_PREVIOUSLY_REPORTED')
    expect((await exportRestoredTemperature([...samples.slice(0, 4), samples[0]])).physicalCaptureStatus).toBe('CAPTURED_PREVIOUSLY_REPORTED')
    expect((await exportRestoredTemperature([])).physicalCaptureStatus).toBe('NOT_CAPTURED')
  })

  it('attaches the build marker and all 14 certification sections even before capture', async () => {
    const payload = await baseline()
    expect(payload.certificationBuild).toEqual({
      enabled: true,
      schemaVersion: 'jcvital-certification-v1',
      baselineCommit: '4e31a1c0476fdad49ef853e4b53273d55fd457c6',
      expectedBase44Revision: 'nc-observations-5b1-results-2026-10-03-r4',
    })
    expect(CERTIFICATION_ORDER).toHaveLength(14)
    for (const key of CERTIFICATION_ORDER) expect(payload.jcvitalCertification[key]).toBeDefined()
    expect(payload.jcvitalCertification.spo2).toMatchObject({ physicalCaptureStatus: 'NOT_CAPTURED', observationCount: 0 })
    expect(payload.jcvitalCertification.historicalHeartRate).toMatchObject({
      evidenceOrigin: 'PRESERVED_QUEUE_SAMPLE_OR_PRIOR_REPORT_REQUIRED',
      sampleObservations: [], corpusObservationCountKnown: false, observationCount: null,
      reportedGateSource: 'USER_PROVIDED_BUILD_5B_1_PHYSICAL_CERTIFICATION_BASELINE',
    })
  })

  it('preserves every section in the exact final serialized JSON, not only the builder object', async () => {
    const payload = await baseline()
    const serialized = serializeCertificationValidationExport(payload)
    const parsed = JSON.parse(serialized)
    expect(parsed.certificationBuild).toEqual(CERTIFICATION_BUILD)
    for (const key of CERTIFICATION_ORDER) {
      expect(parsed.jcvitalCertification[key]).toEqual(payload.jcvitalCertification[key])
    }
    expect(parsed.jcvitalCertification.spo2.physicalCaptureStatus).not.toBe('PASS')
    expect(Object.keys(parsed)).toEqual(expect.arrayContaining([
      'reportType', 'generatedAt', 'device', 'syncSession', 'backendEnvironment', 'feedResults',
      'certificationBuild', 'jcvitalCertification',
    ]))
  })

  it('refuses an older report serializer result rather than saving incomplete JSON', () => {
    const legacy = buildPhase3AValidationReport({ deviceInfo: null, historicalRuns: {} })
    expect(() => serializeCertificationValidationExport(legacy)).toThrow('certificationBuild')
  })

  it.each(CERTIFICATION_ORDER)('refuses a final payload missing metric section %s', async (metric) => {
    const payload = await baseline()
    const { [metric]: _missing, ...certification } = payload.jcvitalCertification
    expect(() => serializeCertificationValidationExport({ ...payload, jcvitalCertification: certification }))
      .toThrow(`jcvitalCertification.${metric}`)
  })

  it.each([undefined, null, {}])('refuses a missing or null certification payload (%s)', async (certification) => {
    const payload = await baseline()
    expect(() => serializeCertificationValidationExport({ ...payload, jcvitalCertification: certification }))
      .toThrow('jcvitalCertification.historicalHeartRate')
  })

  it('redacts credentials and BLE addresses before the shared JSON bytes are produced', async () => {
    const payload = await buildCertificationValidationExport({
      deviceInfo: null, historicalRuns: {},
      additionalFeedResults: { local: { macAddress: 'AA:BB:CC:DD:EE:FF', password: 'DO_NOT_EXPORT', addressInText: 'Device AA:BB:CC:DD:EE:FF' } },
    }, { ownerUserId: null, physiologyContext: context, workoutContext: context })
    const serialized = serializeCertificationValidationExport(payload)
    expect(serialized).not.toContain('DO_NOT_EXPORT')
    expect(serialized).not.toContain('AA:BB:CC:DD:EE:FF')
    expect(JSON.parse(serialized).certificationBuild.enabled).toBe(true)
  })
})
