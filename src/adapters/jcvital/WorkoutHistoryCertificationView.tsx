import { useEffect, useRef, useState } from 'react'
import type { WorkoutHistoryCertification } from './WorkoutHistoryCertification'
import { workoutJsonAction } from './WorkoutHistoryCertificationJson'

export function WorkoutHistoryCertificationView({ service, busy, captureDisabled, scopeKey, setBusy, setActiveSync }: {
  service: WorkoutHistoryCertification
  busy: boolean
  captureDisabled: boolean
  scopeKey: string | null
  setBusy(value: boolean): void
  setActiveSync(value: string | null): void
}) {
  const [status, setStatus] = useState('')
  const [json, setJson] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [attempted, setAttempted] = useState(true)
  const [evidenceScope, setEvidenceScope] = useState(scopeKey)
  const currentScope = useRef(scopeKey)
  if (scopeKey !== evidenceScope) {
    setEvidenceScope(scopeKey)
    setStatus(''); setJson(null); setShown(false); setAttempted(true)
  }
  useEffect(() => {
    currentScope.current = scopeKey
    let active = true
    if (scopeKey) void service.snapshot().then((saved) => {
      if (active) {
        setAttempted(saved !== null)
        if (saved) setStatus(`${saved.state} · saved attempt; capture locked`)
      }
    }).catch((error: unknown) => {
      if (active) setStatus(`WORKOUT SAVED ATTEMPT CHECK FAILED: ${error instanceof Error ? error.message : String(error)}`)
    })
    return () => { active = false }
  }, [scopeKey, service])
  async function action(kind: 'capture' | 'finalize' | 'inspect' | 'show' | 'copy' | 'share') {
    setBusy(true)
    if (kind === 'capture') { setAttempted(true); setActiveSync('certification:workout-history') }
    try {
      let saved = kind === 'capture' ? await service.capture() : await service.inspectSaved()
      if (kind === 'finalize') {
        if (!saved?.acquisition) throw new Error('Saved Workout History acquisition required.')
        saved = await service.finalizeSaved({ certificationGroupId: saved.certificationGroupId,
          sessionId: saved.acquisition.syncId })
      }
      if (currentScope.current !== scopeKey) throw new Error('Workout view scope changed.')
      setStatus(saved ? `${saved.state}${saved.limitation ? ` · ${saved.limitation}` : ''}`
        + ` · ${saved.evidence?.physicalRecordCount ?? 0} physical records${saved.reason ? ` · ${saved.reason}` : ''}`
        : 'NO_SAVED_WORKOUT_CERTIFICATION')
      if (!saved) { setJson(null); return }
      const exact = await service.exportSaved()
      if (currentScope.current !== scopeKey) throw new Error('Workout view scope changed.')
      setJson(exact)
      if (kind === 'show') setShown(true)
      if (kind === 'copy' || kind === 'share') {
        const result = await workoutJsonAction(exact, kind)
        if (currentScope.current === scopeKey) setStatus(result)
      }
    } catch (error) {
      if (currentScope.current === scopeKey) setStatus(`WORKOUT CERTIFICATION STOPPED: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(false)
      if (kind === 'capture') setActiveSync(null)
    }
  }
  return <section aria-label="Workout History Certification">
    <h4>Workout / Exercise History Certification</h4>
    <p>One physical Pro V8 acquisition: GetActivityModeDataWithMode, opcode 0x5C, Type 29.
      Continuation after 50 callbacks is pagination, not retry. A saved attempt permanently prevents recapture.</p>
    <p>Local source evidence only. Original SDK values, nulls, zeros, repeats, timestamps and BLE ancestry
      remain unmodified. No Base44, canonical workout authority, totals or scoring.
      canonicalAuthority = NONE_UNTIL_SEMANTICS_CONFIRMED.</p>
    <p>Valid terminal empty history closes as CERTIFIED_WITH_LIMITATION:
      PHYSICAL_WORKOUT_HISTORY_VALID_BUT_EMPTY. Historical linkage to live Type 82 remains unknown;
      this does not reconstruct its validated ~1 Hz HR stream. METS is not calculated or fabricated.</p>
    <div className="wearable-actions">
      <button type="button" disabled={busy || captureDisabled || attempted || !scopeKey} onClick={() => void action('capture')}>Capture Workout History Certification</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('inspect')}>Inspect Saved Workout History Certification</button>
      <button type="button" disabled={busy || !scopeKey || !attempted} onClick={() => void action('finalize')}>Finalize Saved Workout History Certification</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('show')}>Show Workout Certification JSON</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('copy')}>Copy Workout Certification JSON</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void action('share')}>Share Workout Certification JSON</button>
    </div>
    <p>Saved VC25 finalization only: 26-byte physical frames, original misaligned SDK records retained.
      No acquisition, BLE commands, network, enqueue, delivery or canonicalization.
      The trailing byte is preserved; its checksum algorithm is not proven.</p>
    {status && <p role="status">{status}</p>}
    {shown && json && <textarea aria-label="Workout exact certification JSON" rows={24} readOnly value={json} />}
  </section>
}
