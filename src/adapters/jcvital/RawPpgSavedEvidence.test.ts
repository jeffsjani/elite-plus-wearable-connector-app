import { describe, expect, it, vi } from 'vitest'
import type { RawPpgSavedEvidenceCertification, RawPpgSavedEvidenceInspection, SourceJournalScope } from './jcvitalV8Bridge'
import {
  assertNoGlucoseMapping, concatenatePacketPayloadsBase64, isCertifiedLosslessSource,
  RAW_PPG_GLUCOSE_ISOLATION_KEYS, RawPpgSavedEvidenceError, RawPpgSavedEvidenceService, toRawPpgSavedEvidenceError,
} from './RawPpgSavedEvidence'
import { RAW_PPG_SAVED_EVIDENCE_FAILURE_CODES } from './jcvitalV8Bridge'
import { buildRawPpgCertificationJson, requireCertifiedBeforeExport } from './RawPpgCertificationJson'

const SCOPE: SourceJournalScope = { accountId: 'owner-1', deviceScopeId: 'device-1' }

function certifiedFixture(overrides: Partial<RawPpgSavedEvidenceCertification> = {}): RawPpgSavedEvidenceCertification {
  const packets = [
    { index: 0, byteLength: 203, sha256: 'a'.repeat(64), opcode: '0x3A', dataTypeClassification: 'DATA_PACKET' as const,
      spoolRange: { lengthPrefixOffset: 8, payloadOffset: 12, payloadEndOffsetExclusive: 215 },
      trailerByte: { offsetWithinPayload: 202, checksumAlgorithm: 'CHECKSUM_ALGORITHM_NOT_PROVEN' as const },
      sampleMeaning: 'NOT_INFERRED_FROM_BYTE_POSITION' as const, base64: Buffer.from(new Uint8Array(203)).toString('base64'),
      sourceEnvelopeAncestry: {} },
    { index: 1, byteLength: 16, sha256: 'b'.repeat(64), opcode: '0x78', dataTypeClassification: 'STATUS_PACKET' as const,
      spoolRange: { lengthPrefixOffset: 215, payloadOffset: 219, payloadEndOffsetExclusive: 235 },
      trailerByte: { offsetWithinPayload: 15, checksumAlgorithm: 'CHECKSUM_ALGORITHM_NOT_PROVEN' as const },
      sampleMeaning: 'NOT_INFERRED_FROM_BYTE_POSITION' as const, base64: Buffer.from(new Uint8Array(16).fill(7)).toString('base64'),
      sourceEnvelopeAncestry: {} },
  ]
  return {
    kind: 'RawPpgSavedCertification', context: { scope: SCOPE },
    certificationGroupId: 'group-1', sessionId: 'session-1',
    deviceIdentity: { deviceModel: 'V8', characteristicUuid: 'uuid' }, firmwareVersion: '1.2.3', sdkVersion: 'jcv8-1.0',
    sourceSpool: { filename: 'jcvital-ppg-session-1-abc.bin', path: '/data/.../jcvital-ppg-session-1-abc.bin',
      byteLength: 3774, sha256: 'c'.repeat(64), byteEncoding: 'RAW', truncated: false, truncationOffset: null },
    packetCount: 20, packetOrdering: 'SPOOL_APPEND_ORDER', packets,
    structuralConfirmation: { expectedShapeConfirmed: true, expectedPacketCount: 20, expectedDataPackets: '18x203', expectedStatusPackets: '2x16',
      expectedSpoolBytes: 3774, actualDataPacketCount: 18, actualStatusPacketCount: 2 },
    sdkInterpretedSampleArray: { emitted: true, channel: 'DataType=119 field=PPG', note: 'separate Map callback, not persisted in spool' },
    sampling: { sampleRateHz: null, samplingIntervalMs: null }, unit: 'UNKNOWN_VENDOR_UNIT',
    glucoseIsolation: {
      RAW_PPG_NOT_GLUCOSE: true, NO_GLUCOSE_CANONICAL_MAPPING: true, NO_GLUCOSE_INFERENCE: true, NO_CGM_SUBSTITUTION: true,
      vendorLabelDisclaimer: 'Any vendor "blood sugar" label is metadata only and is not independently validated.',
    },
    sourceEnvelopeJournal: { sourceFiles: [], notificationEnvelopeCount: 20, notificationEnvelopes: [] },
    commandAncestry: { statusOpcodeHex: '0x78', dataOpcodeHex: '0x3A', vendorConstantNames: { statusOpcode: 'CMD_Get_Bloodsugar', dataOpcode: 'Bloodsugar_data' } },
    noTruncationRewriteOrNormalization: true,
    state: 'CERTIFIED', missingEvidence: [],
    sourceStatus: 'CERTIFIED_E2E_LOSSLESS_SOURCE', semanticClassification: 'RESEARCH_NATIVE_ONLY', canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
    deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY', base44DeliveryRequired: false, generatedAt: '2024-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('VC27 Raw PPG saved-evidence TS service', () => {
  it('delegates inspect/export/finalize/readFinalized to the plugin with the resolved scope, issuing 0 BLE/network calls', async () => {
    const inspection: RawPpgSavedEvidenceInspection = {
      kind: 'RawPpgSavedEvidenceDiagnostic', generatedAt: '2024-01-01T00:00:00Z', status: 'FAILED',
      errorCode: 'PPG_SOURCE_CHAIN_INCOMPLETE', errorMessage: 'commandRequestAncestry missing', failureStage: 'CLASSIFY',
      operation: 'INSPECT_EXISTING_RAW_PPG_EVIDENCE', bleCommandsIssued: 0, deviceConnectionsOpened: 0, acquisitionsStarted: 0,
      candidateCount: 1, candidates: [], exactDocumentedShapeMatchCount: 1, recommendedSessionId: 'session-1', found: true,
    }
    const evidence = certifiedFixture()
    const plugin = {
      inspectSavedRawPpgEvidence: vi.fn().mockResolvedValue(inspection),
      exportSavedRawPpgEvidence: vi.fn().mockResolvedValue(evidence),
      finalizeSavedRawPpgCertification: vi.fn().mockResolvedValue(evidence),
      readSavedRawPpgCertification: vi.fn().mockResolvedValue({ json: JSON.stringify(evidence) }),
      readSavedRawPpgDiagnostic: vi.fn().mockResolvedValue({ json: JSON.stringify(inspection) }),
    }
    const service = new RawPpgSavedEvidenceService(plugin, () => SCOPE, null)

    expect(await service.inspectExisting()).toBe(inspection)
    expect(plugin.inspectSavedRawPpgEvidence).toHaveBeenCalledWith(SCOPE)

    expect(await service.exportExisting('session-1')).toBe(evidence)
    expect(plugin.exportSavedRawPpgEvidence).toHaveBeenCalledWith({ ...SCOPE, sessionId: 'session-1' })

    expect(await service.finalizeCertification()).toBe(evidence)
    expect(plugin.finalizeSavedRawPpgCertification).toHaveBeenCalledWith({ ...SCOPE, sessionId: undefined })

    expect(await service.readFinalizedCertification()).toEqual(evidence)
    expect((await service.readDiagnostic()).native).toEqual(inspection)

    for (const fn of Object.values(plugin)) expect(fn).toHaveBeenCalledTimes(1)
  })

  it('returns null when no finalized certification is persisted yet', async () => {
    const plugin = {
      inspectSavedRawPpgEvidence: vi.fn(), exportSavedRawPpgEvidence: vi.fn(), finalizeSavedRawPpgCertification: vi.fn(),
      readSavedRawPpgCertification: vi.fn().mockResolvedValue({ json: null }), readSavedRawPpgDiagnostic: vi.fn(),
    }
    const service = new RawPpgSavedEvidenceService(plugin, () => SCOPE, null)
    expect(await service.readFinalizedCertification()).toBeNull()
  })

  it('asserts all four hard glucose-isolation keys and the unauthoritative unit', () => {
    expect(RAW_PPG_GLUCOSE_ISOLATION_KEYS).toEqual([
      'RAW_PPG_NOT_GLUCOSE', 'NO_GLUCOSE_CANONICAL_MAPPING', 'NO_GLUCOSE_INFERENCE', 'NO_CGM_SUBSTITUTION',
    ])
    expect(() => assertNoGlucoseMapping(certifiedFixture())).not.toThrow()
  })

  it('throws if any glucose-isolation assertion is not true', () => {
    const evidence = certifiedFixture({
      glucoseIsolation: { ...certifiedFixture().glucoseIsolation, NO_GLUCOSE_INFERENCE: false as unknown as true },
    })
    expect(() => assertNoGlucoseMapping(evidence)).toThrow(/NO_GLUCOSE_INFERENCE/)
  })

  it('throws if unit is not UNKNOWN_VENDOR_UNIT', () => {
    const evidence = certifiedFixture({ unit: 'mV' as unknown as 'UNKNOWN_VENDOR_UNIT' })
    expect(() => assertNoGlucoseMapping(evidence)).toThrow(/RAW_PPG_UNIT_NOT_AUTHORITATIVE/)
  })

  it('recognizes CERTIFIED_E2E_LOSSLESS_SOURCE only when every certification field matches', () => {
    expect(isCertifiedLosslessSource(certifiedFixture())).toBe(true)
    expect(isCertifiedLosslessSource(certifiedFixture({ state: 'NOT_CERTIFIED', missingEvidence: ['spool'] }))).toBe(false)
    expect(isCertifiedLosslessSource(certifiedFixture({ base44DeliveryRequired: true as unknown as false }))).toBe(false)
  })

  it('reconstructs exact concatenated packet payload bytes regardless of packet array order, with no rewrite/rescale', () => {
    const evidence = certifiedFixture()
    const inOrder = concatenatePacketPayloadsBase64(evidence)
    const reversed = concatenatePacketPayloadsBase64({ packets: [...evidence.packets].reverse() })
    expect(reversed).toBe(inOrder)
    const decoded = Buffer.from(inOrder, 'base64')
    expect(decoded.length).toBe(203 + 16)
    expect(decoded.subarray(0, 203).every((byte) => byte === 0)).toBe(true)
    expect(decoded.subarray(203).every((byte) => byte === 7)).toBe(true)
  })
})

describe('VC27 Raw PPG saved-evidence certification JSON export', () => {
  it('serializes the full certification with complete packet bytes and refuses a glucose-isolation violation', () => {
    const json = buildRawPpgCertificationJson(certifiedFixture())
    const parsed = JSON.parse(json)
    expect(parsed.packetCount).toBe(20)
    expect(parsed.packets).toHaveLength(2)
    expect(parsed.packets[0].base64.length).toBeGreaterThan(0)
    expect(parsed.glucoseIsolation.RAW_PPG_NOT_GLUCOSE).toBe(true)
    expect(parsed.unit).toBe('UNKNOWN_VENDOR_UNIT')
    expect(parsed.sampling).toEqual({ sampleRateHz: null, samplingIntervalMs: null })

    const violatingEvidence = certifiedFixture({
      glucoseIsolation: { ...certifiedFixture().glucoseIsolation, RAW_PPG_NOT_GLUCOSE: false as unknown as true },
    })
    expect(() => buildRawPpgCertificationJson(violatingEvidence)).toThrow(/RAW_PPG_GLUCOSE_ISOLATION_VIOLATED/)
  })

  it('refuses to export before certification state is CERTIFIED_E2E_LOSSLESS_SOURCE', () => {
    expect(() => requireCertifiedBeforeExport(certifiedFixture())).not.toThrow()
    expect(() => requireCertifiedBeforeExport(certifiedFixture({ state: 'NOT_CERTIFIED', sourceStatus: null, semanticClassification: null, missingEvidence: ['spool'] })))
      .toThrow(/PPG_SAVED_EVIDENCE_NOT_CERTIFIABLE/)
  })

  it('round-trips JSON byte-stable across repeated serializations of the identical evidence object', () => {
    const evidence = certifiedFixture()
    expect(buildRawPpgCertificationJson(evidence)).toBe(buildRawPpgCertificationJson(evidence))
  })
})

function memoryStorage() {
  const map = new Map<string, string>()
  return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => { map.set(k, v) } }
}

function vc28Plugin(overrides: Record<string, unknown> = {}) {
  return {
    inspectSavedRawPpgEvidence: vi.fn(), exportSavedRawPpgEvidence: vi.fn(), finalizeSavedRawPpgCertification: vi.fn(),
    readSavedRawPpgCertification: vi.fn(), readSavedRawPpgDiagnostic: vi.fn().mockResolvedValue({ json: null }),
    ...overrides,
  }
}

describe('VC28 Raw PPG saved-evidence failure diagnostic', () => {
  it('calls native with the persisted account even when no live source-journal scope exists (restart/disconnected)', async () => {
    const plugin = vc28Plugin({ inspectSavedRawPpgEvidence: vi.fn().mockResolvedValue({ status: 'FAILED' }) })
    const service = new RawPpgSavedEvidenceService(plugin, () => ({ accountId: 'owner-1', deviceScopeId: null }), null)
    await service.inspectExisting()
    expect(plugin.inspectSavedRawPpgEvidence).toHaveBeenCalledWith({ accountId: 'owner-1' })
  })

  it('never throws a scope error before native; an unresolvable scope is forwarded so native reports PPG_SCOPE_NOT_RESOLVED', async () => {
    const plugin = vc28Plugin({ inspectSavedRawPpgEvidence: vi.fn().mockResolvedValue({ errorCode: 'PPG_SCOPE_NOT_RESOLVED' }) })
    const service = new RawPpgSavedEvidenceService(plugin, () => { throw new Error('Source journal scope is unavailable.') }, null)
    expect((await service.inspectExisting()).errorCode).toBe('PPG_SCOPE_NOT_RESOLVED')
    expect(plugin.inspectSavedRawPpgEvidence).toHaveBeenCalledWith({ accountId: null })
  })

  it('preserves the native error code/message/exceptionClass across the bridge unchanged', async () => {
    const nativeError = Object.assign(new Error('PPG_MULTIPLE_CANDIDATES_AMBIGUOUS: CodedException: 2 candidates'), {
      code: 'PPG_MULTIPLE_CANDIDATES_AMBIGUOUS',
      data: { errorCode: 'PPG_MULTIPLE_CANDIDATES_AMBIGUOUS', exceptionClass: 'com.hapi.eliteplus.connector.jcvital.RawPpgSavedEvidenceInspector$CodedException' },
    })
    const storage = memoryStorage()
    const plugin = vc28Plugin({ exportSavedRawPpgEvidence: vi.fn().mockRejectedValue(nativeError) })
    const service = new RawPpgSavedEvidenceService(plugin, () => SCOPE, storage)
    const failure = await service.exportExisting().catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(RawPpgSavedEvidenceError)
    expect(failure).toMatchObject({
      code: 'PPG_MULTIPLE_CANDIDATES_AMBIGUOUS',
      message: 'PPG_MULTIPLE_CANDIDATES_AMBIGUOUS: CodedException: 2 candidates',
      exceptionClass: 'com.hapi.eliteplus.connector.jcvital.RawPpgSavedEvidenceInspector$CodedException',
      failureStage: 'BRIDGE_EXPORT',
    })
    const { bridgeFailure } = await service.readDiagnostic()
    expect(bridgeFailure).toMatchObject({ status: 'FAILED', errorCode: 'PPG_MULTIPLE_CANDIDATES_AMBIGUOUS', failureStage: 'BRIDGE_EXPORT' })
  })

  it('maps a code-less bridge rejection to PPG_INSPECTION_INTERNAL_ERROR, never generic FAILED', () => {
    const failure = toRawPpgSavedEvidenceError(new TypeError('plugin not implemented'), 'BRIDGE_INSPECT')
    expect(failure.code).toBe('PPG_INSPECTION_INTERNAL_ERROR')
    expect(failure.exceptionClass).toBe('TypeError')
    expect(failure.message).toBe('plugin not implemented')
  })

  it('keeps the diagnostic JSON exportable after failure, including when the native read itself fails', async () => {
    const storage = memoryStorage()
    const plugin = vc28Plugin({
      inspectSavedRawPpgEvidence: vi.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'PPG_INSPECTION_INTERNAL_ERROR' })),
      readSavedRawPpgDiagnostic: vi.fn().mockRejectedValue(new Error('bridge down')),
    })
    const service = new RawPpgSavedEvidenceService(plugin, () => SCOPE, storage)
    await expect(service.inspectExisting()).rejects.toMatchObject({ code: 'PPG_INSPECTION_INTERNAL_ERROR' })
    const exported = JSON.parse(await service.diagnosticJson())
    expect(exported.latestBridgeFailure.errorCode).toBe('PPG_INSPECTION_INTERNAL_ERROR')
    expect(exported.nativeDiagnosticReadError).toContain('bridge down')
    expect(exported.certificationTransition).toBe('NONE_DIAGNOSTIC_ONLY')
    expect(exported.canonicalAuthority).toBe('NONE_UNTIL_SEMANTICS_CONFIRMED')
  })

  it('declares exactly the eleven explicit failure codes', () => {
    expect(RAW_PPG_SAVED_EVIDENCE_FAILURE_CODES).toHaveLength(11)
    expect(RAW_PPG_SAVED_EVIDENCE_FAILURE_CODES).not.toContain('FAILED')
  })

  it('issues zero BLE/network calls: only offline plugin methods are touched', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const plugin = vc28Plugin({ inspectSavedRawPpgEvidence: vi.fn().mockResolvedValue({ status: 'OK' }) })
    const service = new RawPpgSavedEvidenceService(plugin, () => SCOPE, null)
    await service.inspectExisting()
    await service.diagnosticJson()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(Object.keys(plugin).sort()).toEqual([
      'exportSavedRawPpgEvidence', 'finalizeSavedRawPpgCertification', 'inspectSavedRawPpgEvidence',
      'readSavedRawPpgCertification', 'readSavedRawPpgDiagnostic',
    ])
    expect(plugin.finalizeSavedRawPpgCertification).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})
