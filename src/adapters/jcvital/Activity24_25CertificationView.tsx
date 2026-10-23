import { useEffect, useRef, useState } from 'react'
import {
  activityCertificationStatus, ActivityFinalizationError,
  type ActivityFinalizationDiagnostics, type Activity24_25Certification,
} from './Activity24_25Certification'
import { activityJsonAction } from './ActivityCertificationJson'

export function ActivityCertificationJsonView({ json }: { json: string }) {
  return <textarea aria-label="Activity 24/25 exact certification JSON" readOnly rows={24} value={json} />
}
export function ActivityFinalizationReportView({ report }: { report: ActivityFinalizationDiagnostics }) {
  return <details open>
    <summary>Activity finalization prerequisite report</summary>
    <pre aria-label="Activity finalization diagnostic report">{JSON.stringify(report, null, 2)}</pre>
  </details>
}

export function Activity24_25CertificationView({
  service, busy, captureDisabled, onSendSavedActivityV2Verification, setBusy, setActiveSync, scopeKey,
}: {
  service: Activity24_25Certification
  busy: boolean
  captureDisabled: boolean
  onSendSavedActivityV2Verification?: () => Promise<string>
  setBusy(value: boolean): void
  setActiveSync(value: string | null): void
  scopeKey: string | null
}) {
  const [status, setStatus] = useState('')
  const [json, setJson] = useState<string | null>(null)
  const [shown, setShown] = useState(false)
  const [finalizationReport, setFinalizationReport] = useState<ActivityFinalizationDiagnostics | null>(null)
  const [evidenceScope, setEvidenceScope] = useState(scopeKey)
  const currentScope = useRef(scopeKey)
  useEffect(() => { currentScope.current = scopeKey }, [scopeKey])
  if (evidenceScope !== scopeKey) {
    setEvidenceScope(scopeKey)
    setJson(null)
    setStatus('')
    setShown(false)
    setFinalizationReport(null)
  }
  const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)
  async function resume() {
    setBusy(true)
    setActiveSync('certification:activity24_25:resume')
    try {
      const inspected = await service.resumeDelivery()
      if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
      setStatus(activityCertificationStatus(inspected))
      const exact = await service.exportSaved()
      if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
      setJson(exact)
    } catch (error) {
      if (currentScope.current === scopeKey) setStatus(`Activity resume stopped: ${errorText(error)}. No physical fallback.`)
    } finally { setBusy(false); setActiveSync(null) }
  }
  async function finalizeDelivered() {
    setBusy(true)
    setFinalizationReport(null)
    setActiveSync('certification:activity24_25:local-finalization')
    try {
      const inspected = await service.finalizeDeliveredCertification()
      if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
      if (inspected.status !== 'ACTIVITY_CERTIFICATION_SUCCESS' || inspected.group?.state !== 'COMPLETED') {
        throw new Error(`FINAL_CERTIFICATION_NOT_COMPLETED: ${inspected.reason ?? inspected.status}`)
      }
      setFinalizationReport(inspected.group.finalizationDiagnostics ?? null)
      setStatus(activityCertificationStatus(inspected))
      const exact = await service.exportSaved()
      if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
      setJson(exact)
    } catch (error) {
      if (currentScope.current === scopeKey) {
        setFinalizationReport(error instanceof ActivityFinalizationError ? error.diagnostics : null)
        setStatus(error instanceof ActivityFinalizationError ? error.message
          : `ACTIVITY FINALIZATION FAILED: FINALIZATION_UI_FAILED · ${errorText(error)}`)
      }
    } finally { setBusy(false); setActiveSync(null) }
  }
  async function capture() {
    setBusy(true)
    setActiveSync('certification:activity24_25')
    try {
      const inspected = await service.captureAndDeliver((stage) => {
        if (currentScope.current === scopeKey) setStatus(stage)
      })
      if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
      setStatus(activityCertificationStatus(inspected))
      if (inspected.group && inspected.status !== 'ACTIVITY_CERTIFICATION_EVIDENCE_INVALID') {
        const exact = await service.exportSaved()
        if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
        setJson(exact)
      }
    } catch (error) {
      if (currentScope.current === scopeKey) setStatus(`Activity certification stopped: ${errorText(error)}. Inspect saved evidence; do not reacquire.`)
    } finally { setBusy(false); setActiveSync(null) }
  }
  async function saved(action: 'inspect' | 'show' | 'copy' | 'share') {
    setBusy(true)
    try {
      const inspected = await service.inspectSaved()
      if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
      setStatus(activityCertificationStatus(inspected))
      if (!inspected.group || inspected.status === 'ACTIVITY_CERTIFICATION_EVIDENCE_INVALID') {
        setJson(null)
        return
      }
      const exact = await service.exportSaved()
      if (currentScope.current !== scopeKey) throw new Error('Activity view scope changed.')
      setJson(exact)
      if (action === 'show') setShown(true)
      if (action === 'copy' || action === 'share') {
        const result = await activityJsonAction(exact, action)
        if (currentScope.current === scopeKey) setStatus(result)
      }
    } catch (error) {
      if (currentScope.current === scopeKey) setStatus(`Activity saved evidence action failed: ${errorText(error)}`)
    }
    finally { setBusy(false) }
  }
  async function sendSavedActivityV2Verification() {
    if (!onSendSavedActivityV2Verification) return
    setBusy(true)
    setActiveSync('activity-v2:saved-verification')
    try {
      const result = await onSendSavedActivityV2Verification()
      if (currentScope.current === scopeKey) setStatus(result)
    } catch (error) {
      if (currentScope.current === scopeKey) setStatus(`Saved Activity v2 verification failed: ${errorText(error)}`)
    } finally { setBusy(false); setActiveSync(null) }
  }
  return <section aria-label="Activity 24/25 Certification">
    <h4>Activity 24/25 Certification</h4>
    <p>Finalize Delivered repairs local acknowledgment from saved production results, including an empty
      acknowledgedIds list. It makes no network call, acquisition, enqueue or redelivery.</p>
    <p>VC19 resume recovers transport rows only from verified saved evidence. It reuses exact IDs and payloads,
      bypasses certification retry scheduling only for the approved IDs, and performs no physical recapture.</p>
    <p>One operator sequence: summary history once, then detailed history once, with normal SDK pagination and no retry.
      Separate source types, zeros and repeated records are preserved. Native-only certification transport does not
      change production canonical or scoring policy. Detailed slot offsets are Elite+ nominal inference.</p>
    <p>After restart, reconnect only to establish journal scope. Inspect, Show, Copy and Share / Save read saved
      evidence with zero history acquisition, enqueue or Base44 submission.</p>
    <div className="wearable-actions">
      <button type="button" disabled={busy || !scopeKey} onClick={() => void resume()}>Resume Activity 24/25 Certification Delivery</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void finalizeDelivered()}>Finalize Delivered Activity 24/25 Certification</button>
      <button type="button" disabled={busy || captureDisabled} onClick={() => void capture()}>Capture + Queue + Targeted Deliver Activity 24/25</button>
      {onSendSavedActivityV2Verification && <button type="button" disabled={busy || !scopeKey}
        onClick={() => void sendSavedActivityV2Verification()}>Send Saved Activity V2 Verification</button>}
      <button type="button" disabled={busy || !scopeKey} onClick={() => void saved('inspect')}>Inspect Saved Activity 24/25 Certification</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void saved('show')}>Show Activity 24/25 Certification JSON</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void saved('copy')}>Copy Activity 24/25 Certification JSON</button>
      <button type="button" disabled={busy || !scopeKey} onClick={() => void saved('share')}>Share / Save Activity 24/25 Certification JSON</button>
    </div>
    {status && <p role="status">{status}</p>}
    {finalizationReport && <ActivityFinalizationReportView report={finalizationReport} />}
    {shown && json && <ActivityCertificationJsonView json={json} />}
  </section>
}
