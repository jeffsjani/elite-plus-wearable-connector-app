import { useEffect, useRef, useState } from 'react'
import type { SleepCertification } from './SleepCertification'
import { sleepJsonAction } from './SleepCertificationJson'

export function SleepCertificationJsonView({ json }: { json: string }) {
  return <textarea aria-label="Sleep exact certification JSON" rows={24} readOnly value={json} />
}
export function SleepCertificationView({ service, busy, captureDisabled, scopeKey, setBusy, setActiveSync }: {
  service: SleepCertification
  busy: boolean
  captureDisabled: boolean
  scopeKey: string | null
  setBusy(value: boolean): void
  setActiveSync(value: string | null): void
}) {
  const [status, setStatus] = useState('')
  const [json, setJson] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [evidenceScope, setEvidenceScope] = useState(scopeKey)
  const currentScope = useRef(scopeKey)
  useEffect(() => { currentScope.current = scopeKey }, [scopeKey])
  if (scopeKey !== evidenceScope) {
    setEvidenceScope(scopeKey)
    setStatus('')
    setJson(null)
    setShown(false)
  }
  async function action(kind: 'capture' | 'inspect' | 'show' | 'copy' | 'share') {
    setBusy(true)
    if (kind === 'capture') setActiveSync('certification:sleep')
    try {
      const saved = kind === 'capture' ? await service.capture() : await service.inspectSaved()
      if (currentScope.current !== scopeKey) throw new Error('Sleep view scope changed.')
      setStatus(saved ? `${saved.state}${saved.limitation ? ` · ${saved.limitation}` : ''}`
        + ` · ${saved.evidence?.physicalRecordCount ?? 0} physical records${saved.reason ? ` · ${saved.reason}` : ''}`
        : 'NO_SAVED_SLEEP_CERTIFICATION')
      if (!saved) { setJson(null); return }
      const exact = await service.exportSaved()
      if (currentScope.current !== scopeKey) throw new Error('Sleep view scope changed.')
      setJson(exact)
      if (kind === 'show') setShown(true)
      if (kind === 'copy' || kind === 'share') {
        const result = await sleepJsonAction(exact, kind)
        if (currentScope.current === scopeKey) setStatus(result)
      }
    } catch (error) {
      if (currentScope.current === scopeKey) {
        setStatus(`SLEEP CERTIFICATION FAILED: ${error instanceof Error ? error.message : String(error)}`)
      }
    } finally {
      setBusy(false)
      if (kind === 'capture') setActiveSync(null)
    }
  }
  return <section aria-label="Sleep History Certification">
    <h4>Sleep History Certification</h4>
    <p>One physical session: Sleep stages (26), then detailed Sleep/movement (121), with normal SDK
      pagination and no retry or delete command. Existing saved attempts prevent recapture.</p>
    <p>Both verified terminal histories must be empty to close as CERTIFIED_WITH_LIMITATION:
      PHYSICAL_SLEEP_HISTORY_VALID_BUT_EMPTY. Populated SDK records, original fields, repeated
      records and raw BLE ancestry are preserved losslessly. Vendor stage meaning and detail alignment
      remain unconfirmed; canonicalAuthority is NONE_UNTIL_SEMANTICS_CONFIRMED.</p>
    <p>Local source certification only: no enqueue, Base44 submission, canonicalization or scoring.
      Inspect, Show, Copy and Share / Save read saved evidence without acquisition.</p>
    <div className="wearable-actions">
      <button type="button" disabled={busy || captureDisabled} onClick={() => void action('capture')}>Capture Sleep History Certification (one physical session)</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('inspect')}>Inspect Saved Sleep Certification</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('show')}>Show Sleep Certification JSON</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('copy')}>Copy Sleep Certification JSON</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('share')}>Share / Save Sleep Certification JSON</button>
    </div>
    {status && <p role="status">{status}</p>}
    {shown && json && <SleepCertificationJsonView json={json} />}
  </section>
}
