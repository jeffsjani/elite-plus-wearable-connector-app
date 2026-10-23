import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { RawPpgPhysicalCertificationStatus } from './jcvitalV8Bridge'
import {
  RAW_PPG_CERTIFICATION_CAPTURE_LABEL,
  RAW_PPG_LEGACY_START_DISABLED_REASON,
  RAW_PPG_SEMANTICS,
  RawPpgPhysicalCertificationService,
  assertNoGlucoseKeys,
  rawPpgCertificationCaptureDisabledReason,
  type RawPpgCertificationCaptureGate,
  type RawPpgPhysicalCertificationPlugin,
} from './RawPpgPhysicalCertification'
import { RawPpgPhysicalCertificationControls } from './RawPpgPhysicalCertificationView'

const OPEN: RawPpgPhysicalCertificationStatus = { attempted: false, state: null, claim: null, captureAllowed: true, blockedReason: null }
const ATTEMPTED: RawPpgPhysicalCertificationStatus = {
  attempted: true, state: 'NOT_CERTIFIED', claim: { sessionId: 's1' }, captureAllowed: false, blockedReason: 'PPG_CERTIFICATION_ALREADY_ATTEMPTED',
}
const GATE: RawPpgCertificationCaptureGate = {
  native: true, pluginAvailable: true, ready: true, authenticated: true, busy: false,
  otherActiveMeasurement: null, status: OPEN, statusError: null, inFlight: false,
}

// 20 packets incl. zeros and repeats, mirroring the historical 3,774-byte spool shape.
const SPOOL = Uint8Array.from({ length: 3774 }, (_, index) => (index % 7 === 0 ? 0 : index % 251))
const SPOOL_SHA = createHash('sha256').update(SPOOL).digest('hex')
const SPOOL_BASE64 = Buffer.from(SPOOL).toString('base64')

const CERT_JSON = JSON.stringify({
  kind: 'RawPpgPhysicalCertification', state: 'CERTIFIED', sourceStatus: 'CERTIFIED_E2E_LOSSLESS_SOURCE',
  ...RAW_PPG_SEMANTICS, prohibitions: undefined,
  semanticIsolation: { flags: [...RAW_PPG_SEMANTICS.prohibitions], vendorProtocolLabelNote: 'Bloodsugar is a vendor protocol label only', base44Delivery: 'NONE', canonicalObservationsEmitted: 0 },
  packets: [{ index: 0, byteLength: 203, sha256: 'a'.repeat(64), zeroByteCount: 12, repeatOfPacketIndex: null }],
  spool: { fileSha256: SPOOL_SHA, fileByteLength: SPOOL.length },
})

function plugin(overrides: Partial<RawPpgPhysicalCertificationPlugin> = {}) {
  return {
    captureRawPpgCertification: vi.fn(async () => ({ state: 'ACQUIRING_ONE_PHYSICAL_SESSION', sessionId: 's1' })),
    getRawPpgCertificationStatus: vi.fn(async () => OPEN),
    inspectSavedRawPpgPhysicalCertification: vi.fn(async () => ({
      found: true, attempted: true, state: 'CERTIFIED', unit: 'UNKNOWN_VENDOR_UNIT' as const, sampleRateHz: null, samplingIntervalMs: null,
      onDiskVerification: 'VERIFIED' as const, bleCommands: 0 as const, networkRequests: 0 as const, acquisitions: 0 as const,
    })),
    readSavedRawPpgPhysicalCertification: vi.fn(async () => ({ json: CERT_JSON, claim: { sessionId: 's1' }, deviceScopeId: 'device-1' })),
    exportRawPpgCertificationSpool: vi.fn(async () => ({
      fileName: 's1.ppgspool', byteLength: SPOOL.length, sha256: SPOOL_SHA, base64: SPOOL_BASE64, byteEncoding: 'RAW',
      bleCommands: 0 as const, networkRequests: 0 as const, acquisitions: 0 as const,
    })),
    ...overrides,
  }
}

const scope = () => ({ accountId: 'user-1', deviceScopeId: 'device-1' })

describe('VC29 one-shot capture gate', () => {
  it('allows exactly the READY + authenticated + native + unattempted state', () => {
    expect(rawPpgCertificationCaptureDisabledReason(GATE)).toBeNull()
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, ready: false })).toMatch(/READY/)
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, authenticated: false })).toMatch(/Authenticated/)
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, native: false })).toMatch(/Native/)
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, pluginAvailable: null })).toMatch(/plugin/)
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, busy: true })).not.toBeNull()
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, inFlight: true })).not.toBeNull()
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, status: null })).toMatch(/not loaded/)
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, statusError: 'boom' })).toMatch(/unreadable/)
  })

  it('stays disabled forever after one saved attempt, regardless of READY/authentication', () => {
    for (const state of ['ACQUIRING', 'CERTIFIED', 'NOT_CERTIFIED']) {
      const reason = rawPpgCertificationCaptureDisabledReason({ ...GATE, status: { ...ATTEMPTED, state } })
      expect(reason).toMatch(/PPG_CERTIFICATION_ALREADY_ATTEMPTED/)
      expect(reason).toMatch(/future engineering build/)
    }
    expect(rawPpgCertificationCaptureDisabledReason({ ...GATE, status: { ...OPEN, captureAllowed: false, blockedReason: 'PPG_SCOPE_NOT_RESOLVED' } }))
      .toBe('PPG_SCOPE_NOT_RESOLVED')
  })

  it('renders the one-shot control disabled until the persisted guard is read', () => {
    const html = renderToStaticMarkup(<RawPpgPhysicalCertificationControls service={new RawPpgPhysicalCertificationService(plugin(), scope)}
      gate={GATE} scopeKey="k" />)
    expect(html).toContain(RAW_PPG_CERTIFICATION_CAPTURE_LABEL)
    expect(html).toMatch(/<button type="button" disabled="" title="Attempt guard not loaded yet\."/)
    for (const label of ['Inspect Saved Raw PPG Certification', 'Show Raw PPG Certification JSON', 'Copy Raw PPG Certification JSON',
      'Share Raw PPG Certification JSON', 'Share Raw PPG Raw Spool']) expect(html).toContain(label)
    expect(html).toContain('UNKNOWN_VENDOR_UNIT')
    expect(html).toContain('RAW_PPG_NOT_GLUCOSE')
  })
})

describe('VC29 offline inspection/export', () => {
  it('never captures: inspect/show/spool use only offline plugin reads with the persisted scope', async () => {
    const p = plugin()
    const service = new RawPpgPhysicalCertificationService(p, scope)
    await service.status()
    const inspection = await service.inspect()
    await service.certificationJson()
    await service.spool()
    expect(p.captureRawPpgCertification).not.toHaveBeenCalled()
    expect(p.exportRawPpgCertificationSpool).toHaveBeenCalledWith({ accountId: 'user-1', deviceScopeId: 'device-1' })
    expect(inspection).toMatchObject({ bleCommands: 0, networkRequests: 0, acquisitions: 0 })
  })

  it('exports the complete spool byte-for-byte, preserving zeros and order, and verifies the hash', async () => {
    const spool = await new RawPpgPhysicalCertificationService(plugin(), scope).spool()
    expect(spool.bytes).toEqual(SPOOL)
    expect(spool.bytes.length).toBe(3774)
    expect(spool.bytes.filter((b) => b === 0).length).toBe(SPOOL.filter((b) => b === 0).length)
  })

  it('fails closed when the bridged spool is truncated or altered', async () => {
    const truncated = plugin({ exportRawPpgCertificationSpool: vi.fn(async () => ({
      fileName: 'x', byteLength: SPOOL.length, sha256: SPOOL_SHA, base64: Buffer.from(SPOOL.slice(0, 100)).toString('base64'), byteEncoding: 'RAW',
      bleCommands: 0 as const, networkRequests: 0 as const, acquisitions: 0 as const,
    })) })
    await expect(new RawPpgPhysicalCertificationService(truncated, scope).spool()).rejects.toThrow(/PPG_SPOOL_LENGTH_MISMATCH/)
    const altered = SPOOL.slice(); altered[10] ^= 1
    const tampered = plugin({ exportRawPpgCertificationSpool: vi.fn(async () => ({
      fileName: 'x', byteLength: SPOOL.length, sha256: SPOOL_SHA, base64: Buffer.from(altered).toString('base64'), byteEncoding: 'RAW',
      bleCommands: 0 as const, networkRequests: 0 as const, acquisitions: 0 as const,
    })) })
    await expect(new RawPpgPhysicalCertificationService(tampered, scope).spool()).rejects.toThrow(/PPG_SPOOL_SHA_MISMATCH/)
  })

  it('returns the full JSON (not a summary) with unknown unit/sample rate', async () => {
    const parsed = JSON.parse(await new RawPpgPhysicalCertificationService(plugin(), scope).certificationJson())
    expect(parsed).toEqual(JSON.parse(CERT_JSON))
    expect(parsed).toMatchObject({ unit: 'UNKNOWN_VENDOR_UNIT', sampleRateHz: null, samplingIntervalMs: null,
      semanticClassification: 'RESEARCH_NATIVE_ONLY', canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
      deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY' })
    expect(parsed.semanticIsolation.canonicalObservationsEmitted).toBe(0)
  })
})

describe('VC29 glucose prohibition and isolation', () => {
  it('rejects any glucose-shaped key while allowing the prohibition flags as values', () => {
    expect(() => assertNoGlucoseKeys(JSON.parse(CERT_JSON))).not.toThrow()
    for (const key of ['glucose', 'bloodSugar', 'blood_sugar', 'cgmValue', 'mgdl', 'mg_dl', 'mmol']) {
      expect(() => assertNoGlucoseKeys({ nested: [{ [key]: 1 }] })).toThrow(/RAW_PPG_NOT_GLUCOSE/)
    }
  })

  it('refuses to surface a saved JSON that carries a glucose mapping', async () => {
    const p = plugin({ readSavedRawPpgPhysicalCertification: vi.fn(async () => ({ json: JSON.stringify({ glucoseMgDl: 100 }), claim: null, deviceScopeId: null })) })
    await expect(new RawPpgPhysicalCertificationService(p, scope).certificationJson()).rejects.toThrow(/RAW_PPG_NOT_GLUCOSE/)
  })

  it('has no Base44, network, queue or canonicalization dependency and disables legacy PPG start', () => {
    const sources = ['./RawPpgPhysicalCertification.ts', './RawPpgPhysicalCertificationView.tsx']
      .map((file) => readFileSync(new URL(file, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, ''))
    for (const source of sources) {
      expect(source).not.toMatch(/base44|fetch\(|XMLHttpRequest|ObservationQueue|enqueue\(|canonicaliz|Normaliz/i)
    }
    const panel = readFileSync(new URL('./JCVitalV8Panel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('startDisabledReason={RAW_PPG_LEGACY_START_DISABLED_REASON}')
    expect(panel).toContain('<RawPpgPhysicalCertificationControls')
    expect(RAW_PPG_LEGACY_START_DISABLED_REASON).toMatch(/VC29/)
  })
})
