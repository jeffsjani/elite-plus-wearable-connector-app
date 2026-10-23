import { Capacitor } from '@capacitor/core'
import { Directory, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { exportStage } from './CertificationJsonExport'
import type {
  JCVitalV8Plugin,
  RawPpgPhysicalCertificationEvent,
  RawPpgPhysicalCertificationInspection,
  RawPpgPhysicalCertificationSpool,
  RawPpgPhysicalCertificationStatus,
  RawPpgSavedEvidenceScope,
} from './jcvitalV8Bridge'

/**
 * VC29 one-shot physical Raw PPG certification. Only `capture()` touches the device (exactly one native
 * session, journaled before any BLE command). Every other method is offline against app-private storage:
 * 0 BLE, 0 network, 0 acquisition, 0 Base44, 0 enqueue, 0 canonicalization.
 *
 * The waveform is RESEARCH_NATIVE_ONLY raw optical data. The vendor "Bloodsugar" name is only a protocol
 * label: no glucose value, estimate, score, CGM substitute or canonical glucose observation exists here.
 */
export type RawPpgPhysicalCertificationPlugin = Pick<
  JCVitalV8Plugin,
  'captureRawPpgCertification' | 'getRawPpgCertificationStatus' | 'inspectSavedRawPpgPhysicalCertification'
  | 'readSavedRawPpgPhysicalCertification' | 'exportRawPpgCertificationSpool'
>

export const RAW_PPG_CERTIFICATION_CAPTURE_LABEL = 'Capture Raw PPG Certification — ONE PHYSICAL SESSION'
export const RAW_PPG_CERTIFICATION_JSON_FILENAME = 'JCVital Raw PPG physical certification.json'
export const RAW_PPG_LEGACY_START_DISABLED_REASON =
  'VC29: legacy Raw PPG capture is disabled; use the one-shot Raw PPG certification capture.'
export const RAW_PPG_SEMANTICS = Object.freeze({
  semanticClassification: 'RESEARCH_NATIVE_ONLY',
  canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
  deliveryDisposition: 'LOCAL_SOURCE_EVIDENCE_ONLY',
  unit: 'UNKNOWN_VENDOR_UNIT',
  sampleRateHz: null,
  samplingIntervalMs: null,
  prohibitions: ['RAW_PPG_NOT_GLUCOSE', 'NO_GLUCOSE_CANONICAL_MAPPING', 'NO_GLUCOSE_INFERENCE', 'NO_CGM_SUBSTITUTION'],
} as const)

const GLUCOSE_KEY = /(glucose|bloodsugar|blood_sugar|sugar|cgm|mg_?dl|mmol)/i

/** Rejects any object key that could carry a glucose meaning (values such as the prohibition flags are allowed). */
export function assertNoGlucoseKeys(value: unknown, path = '$'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoGlucoseKeys(item, `${path}[${index}]`))
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (GLUCOSE_KEY.test(key)) throw new Error(`RAW_PPG_NOT_GLUCOSE: prohibited key ${path}.${key}`)
      assertNoGlucoseKeys(child, `${path}.${key}`)
    }
  }
}

export interface RawPpgCertificationCaptureGate {
  native: boolean
  pluginAvailable: boolean | null
  ready: boolean
  authenticated: boolean
  busy: boolean
  otherActiveMeasurement: string | null
  status: RawPpgPhysicalCertificationStatus | null
  statusError: string | null
  inFlight: boolean
}

/** Null only when the single physical attempt is still available. Disabled forever once attempted. */
export function rawPpgCertificationCaptureDisabledReason(gate: RawPpgCertificationCaptureGate): string | null {
  if (gate.inFlight) return 'Raw PPG certification capture in progress.'
  if (gate.status?.attempted) return `PPG_CERTIFICATION_ALREADY_ATTEMPTED · state=${gate.status.state ?? 'ACQUIRING'} · superseded only by a future engineering build`
  if (!gate.native) return 'Native Android build required.'
  if (gate.pluginAvailable !== true) return 'JCVitalV8 plugin unavailable.'
  if (!gate.authenticated) return 'Authenticated account required.'
  if (!gate.ready) return 'Connected V8 in READY state required.'
  if (gate.busy) return 'Another operation is running.'
  if (gate.otherActiveMeasurement) return `Stop ${gate.otherActiveMeasurement} first.`
  if (gate.statusError) return `Attempt guard unreadable: ${gate.statusError}`
  if (!gate.status) return 'Attempt guard not loaded yet.'
  if (!gate.status.captureAllowed) return gate.status.blockedReason ?? 'PPG_CERTIFICATION_CAPTURE_NOT_ALLOWED'
  return null
}

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export interface VerifiedRawPpgSpool extends RawPpgPhysicalCertificationSpool {
  bytes: Uint8Array
}

export class RawPpgPhysicalCertificationService {
  private readonly plugin: RawPpgPhysicalCertificationPlugin
  private readonly scope: () => RawPpgSavedEvidenceScope

  constructor(plugin: RawPpgPhysicalCertificationPlugin, scope: () => RawPpgSavedEvidenceScope) {
    this.plugin = plugin
    this.scope = scope
  }

  private resolvedScope(): RawPpgSavedEvidenceScope {
    const { accountId, deviceScopeId } = this.scope()
    return { accountId: accountId || null, ...(deviceScopeId ? { deviceScopeId } : {}) }
  }

  /** The one physical session. The native side owns the one-shot guard; no retry happens here. */
  async capture(): Promise<RawPpgPhysicalCertificationEvent> {
    return this.plugin.captureRawPpgCertification()
  }

  status(): Promise<RawPpgPhysicalCertificationStatus> {
    return this.plugin.getRawPpgCertificationStatus(this.resolvedScope())
  }

  async inspect(): Promise<RawPpgPhysicalCertificationInspection> {
    const inspection = await this.plugin.inspectSavedRawPpgPhysicalCertification(this.resolvedScope())
    assertNoGlucoseKeys(inspection)
    return inspection
  }

  /** Full saved certification JSON, pretty-printed but otherwise untouched (never summarized/truncated). */
  async certificationJson(): Promise<string> {
    const { json } = await this.plugin.readSavedRawPpgPhysicalCertification(this.resolvedScope())
    if (!json) throw new Error('PPG_CERTIFICATION_NOT_FOUND')
    const parsed: unknown = JSON.parse(json)
    assertNoGlucoseKeys(parsed)
    return JSON.stringify(parsed, null, 2)
  }

  /** Full raw spool; re-verifies byte length and SHA-256 after the bridge round-trip. */
  async spool(): Promise<VerifiedRawPpgSpool> {
    const spool = await this.plugin.exportRawPpgCertificationSpool(this.resolvedScope())
    const bytes = decodeBase64(spool.base64)
    if (bytes.length !== spool.byteLength) throw new Error(`PPG_SPOOL_LENGTH_MISMATCH: ${bytes.length} != ${spool.byteLength}`)
    const sha = await sha256Hex(bytes)
    if (sha !== spool.sha256) throw new Error(`PPG_SPOOL_SHA_MISMATCH: ${sha} != ${spool.sha256}`)
    return { ...spool, bytes }
  }
}

/** Writes the exact spool bytes (base64 → binary, no text encoding) and opens the share sheet. */
export async function saveBinaryFile(filename: string, base64: string, bytes: Uint8Array, title: string, dialogTitle: string): Promise<string> {
  if (Capacitor.isNativePlatform()) {
    const saved = await exportStage('FILESYSTEM_WRITE', () => Filesystem.writeFile({ path: filename, data: base64, directory: Directory.Cache }))
    await exportStage('SHARE', () => Share.share({ title, text: filename, files: [new URL(saved.uri).href], dialogTitle }))
    return `${filename} · ${saved.uri}`
  }
  const url = await exportStage('BLOB_CREATION', () => URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' })))
  try {
    await exportStage('BROWSER_DOWNLOAD', () => {
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
    })
    return filename
  } finally {
    URL.revokeObjectURL(url)
  }
}
