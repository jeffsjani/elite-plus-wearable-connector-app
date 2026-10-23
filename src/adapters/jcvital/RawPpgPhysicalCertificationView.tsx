import { useCallback, useEffect, useRef, useState } from 'react'
import type { RawPpgPhysicalCertificationEvent, RawPpgPhysicalCertificationStatus } from './jcvitalV8Bridge'
import { saveValidationJson } from './CertificationJsonExport'
import {
  RAW_PPG_CERTIFICATION_CAPTURE_LABEL,
  RAW_PPG_CERTIFICATION_JSON_FILENAME,
  RAW_PPG_SEMANTICS,
  rawPpgCertificationCaptureDisabledReason,
  saveBinaryFile,
  type RawPpgCertificationCaptureGate,
  type RawPpgPhysicalCertificationService,
} from './RawPpgPhysicalCertification'

type SaveJson = (filename: string, json: string, title: string, dialogTitle: string) => Promise<string>
type SaveBinary = typeof saveBinaryFile
type Subscribe = (listener: (event: RawPpgPhysicalCertificationEvent) => void) => Promise<{ remove: () => Promise<void> | void }>

function message(error: unknown): string {
  const record = (typeof error === 'object' && error !== null ? error : {}) as Record<string, unknown>
  const code = typeof record.code === 'string' && record.code ? `${record.code}: ` : ''
  return `${code}${error instanceof Error ? error.message : typeof record.message === 'string' ? record.message : String(error)}`
}

export type RawPpgPhysicalCertificationGateInput = Omit<RawPpgCertificationCaptureGate, 'status' | 'statusError' | 'inFlight'>

/**
 * VC29 controls. Capture is the only device action and is available for exactly one saved attempt per
 * account/device; Inspect / Show / Copy / Share JSON / Share spool are offline (0 BLE, 0 network,
 * 0 acquisition) and stay enabled after restart and without a connected V8.
 */
export function RawPpgPhysicalCertificationControls({
  service,
  gate,
  scopeKey,
  subscribe,
  saveJson = saveValidationJson,
  saveBinary = saveBinaryFile,
  copyText = (text: string) => navigator.clipboard.writeText(text),
}: {
  service: RawPpgPhysicalCertificationService
  gate: RawPpgPhysicalCertificationGateInput
  scopeKey: string
  subscribe?: Subscribe
  saveJson?: SaveJson
  saveBinary?: SaveBinary
  copyText?: (text: string) => Promise<void>
}) {
  const [attempt, setAttempt] = useState<RawPpgPhysicalCertificationStatus | null>(null)
  const [attemptError, setAttemptError] = useState<string | null>(null)
  const [inFlight, setInFlight] = useState(false)
  const [offlineBusy, setOfflineBusy] = useState(false)
  const [live, setLive] = useState<RawPpgPhysicalCertificationEvent | null>(null)
  const [status, setStatus] = useState('')
  const [json, setJson] = useState<string | null>(null)
  const captureStarted = useRef(false)
  const [captureUsed, setCaptureUsed] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setAttempt(await service.status())
      setAttemptError(null)
    } catch (error) {
      setAttemptError(message(error))
    }
  }, [service])

  useEffect(() => { void refresh() }, [refresh, scopeKey])

  useEffect(() => {
    if (!subscribe) return undefined
    let handle: { remove: () => Promise<void> | void } | null = null
    let disposed = false
    void subscribe((event) => {
      if (!event || typeof event !== 'object') return
      setLive(event)
      if (event.terminal) void refresh()
    }).then((h) => { if (disposed) void h.remove(); else handle = h }).catch((error: unknown) => {
      if (!disposed) setAttemptError(`Certification status subscription failed: ${message(error)}`)
    })
    return () => { disposed = true; void handle?.remove() }
  }, [subscribe, refresh])

  const captureReason = rawPpgCertificationCaptureDisabledReason({
    ...gate, status: attempt, statusError: attemptError, inFlight: inFlight || captureUsed,
  })

  async function capture() {
    if (captureReason !== null || captureStarted.current) return
    captureStarted.current = true
    setCaptureUsed(true)
    setInFlight(true)
    setStatus('Raw PPG certification: journaling session, spool, attempt and command before BLE write…')
    try {
      const started = await service.capture()
      setLive(started)
      setStatus(`Raw PPG certification started · ${started.state} · session=${started.sessionId ?? '—'}`)
    } catch (error) {
      setStatus(`Raw PPG certification capture: ${message(error)}`)
    } finally {
      setInFlight(false)
      await refresh()
    }
  }

  async function offline(label: string, action: () => Promise<void>) {
    setOfflineBusy(true)
    try { await action() } catch (error) { setStatus(`${label}: ${message(error)}`) } finally { setOfflineBusy(false) }
  }

  const inspect = () => offline('Inspect Saved Raw PPG Certification', async () => {
    const inspection = await service.inspect()
    setStatus(inspection.found
      ? `${inspection.state} · ${inspection.sourceStatus} · onDisk=${inspection.onDiskVerification}`
        + ` · packets=${inspection.packetCount} · spoolBytes=${inspection.spoolByteLength} · spoolSha256=${inspection.spoolSha256}`
        + (inspection.verificationErrors?.length ? ` · errors=${inspection.verificationErrors.join(',')}` : '')
      : `No saved Raw PPG certification · attempted=${inspection.attempted}`)
    setJson(JSON.stringify(inspection, null, 2))
  })

  const showJson = () => offline('Show Raw PPG Certification JSON', async () => {
    const text = await service.certificationJson()
    setJson(text)
    setStatus(`Raw PPG certification JSON · ${text.length} chars`)
  })

  const copyJson = () => offline('Copy Raw PPG Certification JSON', async () => {
    const text = await service.certificationJson()
    setJson(text)
    await copyText(text)
    setStatus('Raw PPG certification JSON copied')
  })

  const shareJson = () => offline('Share Raw PPG Certification JSON', async () => {
    const text = await service.certificationJson()
    setJson(text)
    const saved = await saveJson(RAW_PPG_CERTIFICATION_JSON_FILENAME, text, 'JCVital Raw PPG physical certification',
      'Share Raw PPG certification JSON (research-native raw optical data, not glucose)')
    setStatus(`Raw PPG certification JSON shared · ${saved}`)
  })

  const shareSpool = () => offline('Share Raw PPG Raw Spool', async () => {
    const spool = await service.spool()
    const saved = await saveBinary(spool.fileName, spool.base64, spool.bytes, 'JCVital Raw PPG raw spool',
      'Share Raw PPG raw spool (lossless, research-native only)')
    setStatus(`Raw PPG raw spool shared · ${spool.byteLength} bytes · sha256=${spool.sha256} · ${saved}`)
  })

  return (
    <section aria-label="Raw PPG physical certification">
      <h3>Raw PPG physical certification (VC29)</h3>
      <small>
        {RAW_PPG_SEMANTICS.semanticClassification} · {RAW_PPG_SEMANTICS.canonicalAuthority} · unit={RAW_PPG_SEMANTICS.unit}
        {' '}· sampleRateHz=unknown · {RAW_PPG_SEMANTICS.prohibitions.join(' · ')}
      </small>
      <div className="diagnostic-control">
        <button type="button" disabled={captureReason !== null} title={captureReason ?? RAW_PPG_CERTIFICATION_CAPTURE_LABEL}
          onClick={() => void capture()}>{RAW_PPG_CERTIFICATION_CAPTURE_LABEL}</button>
        <small>{captureReason ?? 'One physical attempt available for this account/device.'}</small>
      </div>
      {live && <p>Live: {live.state} · packets={live.packetCount ?? '—'}{live.spoolBytes != null ? ` · spoolBytes=${live.spoolBytes}` : ''}
        {live.terminal ? ` · terminal · ${live.sourceStatus ?? ''}` : ''}</p>}
      <div className="diagnostic-control">
        <button type="button" disabled={offlineBusy} onClick={() => void inspect()}>Inspect Saved Raw PPG Certification</button>
        <button type="button" disabled={offlineBusy} onClick={() => void showJson()}>Show Raw PPG Certification JSON</button>
        <button type="button" disabled={offlineBusy} onClick={() => void copyJson()}>Copy Raw PPG Certification JSON</button>
        <button type="button" disabled={offlineBusy} onClick={() => void shareJson()}>Share Raw PPG Certification JSON</button>
        <button type="button" disabled={offlineBusy} onClick={() => void shareSpool()}>Share Raw PPG Raw Spool</button>
      </div>
      <p role="status">{status}</p>
      {json && <textarea aria-label="Raw PPG physical certification JSON" rows={20} readOnly value={json} />}
    </section>
  )
}
