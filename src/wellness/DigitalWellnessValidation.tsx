import { useEffect, useRef, useState } from 'react'
import type { LocalDigitalWellness } from './health/digitalWellnessLocal'
import { digitalWellnessNative } from './health/digitalWellnessNative'
import { appOpsLabel } from './health/digitalWellnessAccess'
import { buildValidationSummary, copyText, type ClipboardEnvironment } from './health/validationSummary'

const TEST_SCRIPT = [
  'TEST A — Permission denied: leave consent OFF or Usage Access DENIED. Refresh must query nothing and show CONSENT_REQUIRED or OS_ACCESS_REQUIRED.',
  'TEST B — Grant flow: Set Up Digital Wellness → read explanation → Turn On Digital Wellness (saves production consent first). If Usage Access is already GRANTED, no Settings screen opens; otherwise grant in Android Settings → return. Production refresh may run after consent and access; the six-hour schedule is best-effort.',
  'TEST C — Locked-screen wake only: lock, wake without unlocking, wait about 10 seconds, then turn screen off. Refresh; pickups must not increase.',
  'TEST D — One normal session: lock, wake, unlock, use about 2 minutes, lock. Refresh; compare event timestamps and approximate screen time, pickup, and session.',
  'TEST E — App switching: switch among at least three apps without locking. Refresh; app switches must not add pickups or sessions. App identities must never appear here.',
  'TEST F — Multiple sessions: perform three unlock/use/lock sessions with waits between. Refresh; compare event timestamps and totals.',
  'TEST G — Revoke Usage Access in Android Settings, return, Refresh. Query must be blocked, state must be PERMISSION_REVOKED, and prior aggregates must not be presented as fresh.',
  'REBOOT — Record state, reboot, reopen, check access, Refresh. Note permission persistence and whether event history/boundaries span reboot.',
  'HISTORY — Repeat bounded queries for 1, 6, 24, and 48 hours. Record earliest/newest events and boundary context. Maximum query window is 48 hours.',
  'TIMEZONE — Verify the displayed IANA timezone and local-day window. Do not change the primary device clock/timezone for this test.',
].join('\n')

export function DigitalWellnessValidation({ wellness, clipboard }: {
  wellness: LocalDigitalWellness
  clipboard?: ClipboardEnvironment
}) {
  const snapshot = wellness.getSnapshot()
  const latestRecord = snapshot.records.at(-1)
  const latestDay = latestRecord?.result.days.at(-1)
  const latestReceipt = snapshot.validationReceipts.at(-1)
  const eventSequence = snapshot.eventSequence
  const metricValues = latestReceipt?.resulting_metrics ?? latestDay
  const coverage = latestReceipt?.coverage ?? latestDay?.coverage.state
  const eventBounds = eventSequence.reduce<{ earliest: string | null; newest: string | null }>(
    (bounds, event) => ({
      earliest: bounds.earliest === null || event.timestamp < bounds.earliest ? event.timestamp : bounds.earliest,
      newest: bounds.newest === null || event.timestamp > bounds.newest ? event.timestamp : bounds.newest,
    }),
    { earliest: null, newest: null },
  )
  const [platform, setPlatform] = useState<'ANDROID' | 'Unavailable'>('ANDROID')
  const [androidVersion, setAndroidVersion] = useState('Checking…')
  const [hours, setHours] = useState<1 | 6 | 24 | 48>(24)
  const [lateStart, setLateStart] = useState('22:00')
  const [lateEnd, setLateEnd] = useState('06:00')
  const [testStartedAt, setTestStartedAt] = useState<string | null>(null)
  const [copyState, setCopyState] = useState('')
  const [manualSummary, setManualSummary] = useState<string | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const diagnostics = snapshot.diagnostics

  useEffect(() => {
    let active = true
    void digitalWellnessNative.getPlatformInfo().then((info) => {
      if (active) {
        setPlatform(info.platform)
        setAndroidVersion(info.androidVersion)
      }
    }, () => {
      if (active) {
        setPlatform('Unavailable')
        setAndroidVersion('Unavailable')
      }
    })
    return () => { active = false }
  }, [])

  const copySummary = async () => {
    setManualSummary(null)
    setCopyState('Copying…')
    let summary = ''
    const outcome = await wellness.runUiAction('COPY_VALIDATION_SUMMARY', async () => {
      summary = buildValidationSummary(wellness.getSnapshot(), {
        platform, androidVersion, generatedAt: new Date().toISOString(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown',
      })
      if (await copyText(summary, clipboard) !== 'COPIED') throw Object.assign(new Error('COPY_FAILED'), { code: 'COPY_FAILED' })
    })
    if (!mounted.current) return
    if (outcome === 'COMPLETED') {
      setCopyState('Copied')
    } else {
      setCopyState('Copy failed — select manually')
      setManualSummary(summary || null)
    }
  }

  return <section aria-label="Digital Wellness Validation">
    <h3>Digital Wellness Validation</h3>
    <p>Engineering-only diagnostics. Production refresh uses dedicated best-effort WorkManager; no network delivery. The validation event sequence is memory-only.</p>
    <section aria-label="Native Usage Access probe">
      <button onClick={() => void wellness.runUiAction('CHECK_NATIVE_USAGE_ACCESS', () => wellness.checkNativeUsageAccess())}>
        Check Native Usage Access</button>
      <dl>
        <dt>Native AppOps:</dt><dd>{snapshot.nativeProbe?.osAccess ?? 'NOT_CHECKED'}</dd>
        <dt>AppOps result:</dt><dd>{snapshot.nativeProbe
          ? snapshot.nativeProbe.error ?? appOpsLabel(snapshot.nativeProbe.appOpsResult) : 'NOT_CHECKED'}</dd>
        <dt>Last native check:</dt><dd>{snapshot.nativeProbe?.checkedAt ?? 'Never'}</dd>
      </dl>
    </section>
    {latestReceipt?.query_diagnostics && <section aria-label="Query failure diagnostics">
      <h4>Query failed</h4>
      <dl>
        <dt>Stage:</dt><dd>{latestReceipt.query_diagnostics.error_stage}</dd>
        <dt>Error code:</dt><dd>{latestReceipt.query_diagnostics.error_code}</dd>
        <dt>Usage Access:</dt><dd>{latestReceipt.query_diagnostics.usage_access_at_query}</dd>
        <dt>Android API:</dt><dd>{latestReceipt.query_diagnostics.android_api_level ?? 'UNKNOWN'}</dd>
        <dt>Service available:</dt><dd>{latestReceipt.query_diagnostics.usage_stats_service_available === null
          ? 'UNKNOWN' : latestReceipt.query_diagnostics.usage_stats_service_available ? 'YES' : 'NO'}</dd>
        <dt>Sanitized message:</dt><dd>{latestReceipt.query_diagnostics.sanitized_error_message}</dd>
        {latestReceipt.query_diagnostics.native_validation && <>
          <dt>Validation rule failed:</dt>
          <dd>{latestReceipt.query_diagnostics.native_validation.validation_rule_failed ?? 'NONE'}</dd>
          {([['Native now', 'native_now'], ['Requested start', 'requested_start'], ['Requested end', 'requested_end'],
            ['Effective end', 'effective_end'], ['Duration ms', 'duration_ms'], ['Lookback ms', 'lookback_ms'],
            ['Clock skew ms', 'clock_skew_ms']] as const).map(([label, key]) => <FragmentCount key={key}
            label={`${label}:`} value={latestReceipt.query_diagnostics?.native_validation?.[key] ?? 'UNKNOWN'} />)}
        </>}
      </dl>
    </section>}
    <dl>
      <dt>Consent state</dt><dd>{snapshot.access.consent}</dd>
      <dt>Usage Access state</dt><dd>{snapshot.access.osAccess}</dd>
      <dt>Collection state</dt><dd>{snapshot.access.collection}</dd>
      <dt>Continuity (history only)</dt><dd>{snapshot.access.continuity}</dd>
      <dt>Platform / Android version</dt><dd>{platform} / {androidVersion}</dd>
      <dt>IANA timezone</dt><dd>{Intl.DateTimeFormat().resolvedOptions().timeZone || 'Unknown'}</dd>
      <dt>Query start</dt><dd>{latestReceipt?.query_window.start ?? latestRecord?.queryStart ?? 'Not queried'}</dd>
      <dt>Query end</dt><dd>{latestReceipt?.query_window.end ?? latestRecord?.queryEnd ?? 'Not queried'}</dd>
      <dt>Query duration</dt><dd>{latestReceipt?.query_window.duration_hours ?? '—'} hours</dd>
      <dt>Collection timestamp</dt><dd>{latestReceipt && latestReceipt.permission_state !== 'GRANTED'
        ? 'No collection in this validation' : latestRecord?.capturedAt ?? 'Not collected'}</dd>
      {(['SCREEN_INTERACTIVE', 'SCREEN_NON_INTERACTIVE', 'KEYGUARD_SHOWN', 'KEYGUARD_HIDDEN'] as const)
        .map((type) => <FragmentCount key={type} label={`${type} count`} value={latestReceipt?.event_counts[type] ?? 'Not queried'} />)}
      <dt>Total supported events</dt><dd>{latestReceipt?.total_supported_events ?? 'Not queried'}</dd>
      <dt>Deduplicated events</dt><dd>{latestReceipt?.deduplicated_count ?? 'Not queried'}</dd>
      <dt>Earliest supported event</dt><dd>{eventBounds.earliest ?? 'Not returned in this refresh'}</dd>
      <dt>Newest supported event</dt><dd>{eventBounds.newest ?? 'Not returned in this refresh'}</dd>
      <dt>Screen Time</dt><dd>{metric(metricValues?.screen_time_minutes, ' min', coverage)}</dd>
      <dt>Pickups</dt><dd>{metric(metricValues?.pickups, '', coverage)}</dd>
      <dt>First Pickup</dt><dd>{metricValues?.first_pickup ?? (coverage === 'PARTIAL' ? 'Unavailable (PARTIAL)' : 'Unknown')}</dd>
      <dt>Screen Sessions</dt><dd>{metric(metricValues?.screen_sessions, '', coverage)}</dd>
      <dt>Late-Night Screen Time</dt><dd>{metric(metricValues?.late_night_screen_minutes, ' min', coverage)}</dd>
      <dt>Coverage</dt><dd>{coverage ?? 'UNKNOWN'}</dd>
      <dt>Confidence</dt><dd>{latestReceipt?.confidence ?? latestDay?.confidence ?? 'UNKNOWN'}</dd>
      <dt>Quality Reasons</dt><dd>{latestReceipt?.quality_reasons.join(', ') || latestDay?.qualityReasons.join(', ') || 'Not measured'}</dd>
      <dt>Semantic Version</dt><dd>{latestRecord?.result.semanticVersion ?? 'android.digital_balance.v1'}</dd>
      <dt>Delivery Capability</dt><dd>{latestRecord?.deliveryCapability ?? 'LOCAL_ONLY'}</dd>
    </dl>
    <fieldset>
      <legend>History retention query window</legend>
      <label>Hours
        <select value={hours} onChange={(event) => setHours(Number(event.target.value) as 1 | 6 | 24 | 48)}>
          {[1, 6, 24, 48].map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
      </label>
      <label>Late-night start (local HH:mm)
        <input type="time" value={lateStart} onChange={(event) => setLateStart(event.target.value)} />
      </label>
      <label>Late-night end (local HH:mm)
        <input type="time" value={lateEnd} onChange={(event) => setLateEnd(event.target.value)} />
      </label>
      <p>Configured Late-Night Window: {lateStart}–{lateEnd} local ({Intl.DateTimeFormat().resolvedOptions().timeZone || 'unknown timezone'})</p>
      <button disabled={snapshot.state === 'COLLECTING'} onClick={() => void wellness.runUiAction('REFRESH', () => wellness.refresh({
        hours, validation: true, lateNightWindow: { start: lateStart, end: lateEnd },
      }))}>Refresh / Test Result</button>
    </fieldset>
    <button onClick={() => setTestStartedAt(new Date().toISOString())}>Start Controlled Validation</button>
    {testStartedAt && <p role="status">Test started at {testStartedAt}. No background collection started. Perform the physical steps, then use Refresh / Test Result.</p>}
    <details><summary>Controlled physical test script</summary><ol>{TEST_SCRIPT.split('\n').map((step) => <li key={step}>{step}</li>)}</ol></details>
    <details><summary>Access continuity ledger</summary>
      {snapshot.continuityLedger.length
        ? <ol>{snapshot.continuityLedger.map((entry, index) => <li key={`${entry.timestamp}-${index}`}>
          {entry.timestamp} — {entry.usageAccess ? `ACCESS_${entry.usageAccess}` : 'ACCESS_NOT_CHECKED'};
          CONSENT_{entry.consent}; {entry.reason}
        </li>)}</ol> : <p>No access observations recorded.</p>}
      <p>Absence of a DENIED record does not prove uninterrupted Usage Access.</p>
    </details>
    <details><summary>Latest validation receipt</summary>
      {latestReceipt ? <pre>{JSON.stringify(latestReceipt, null, 2)}</pre> : <p>No validation refresh completed.</p>}
    </details>
    <details><summary>Sanitized event sequence (memory only)</summary>
      {eventSequence.length
        ? <ol>{eventSequence.slice(0, 100).map((event, index) => <li key={`${event.timestamp}-${index}`}>
          {event.timestamp} — {event.eventType}
        </li>)}</ol> : <p>No supported events returned in the latest validation refresh.</p>}
      {eventSequence.length > 100 && <p>Showing first 100 of {eventSequence.length}. Timestamps are not persisted.</p>}
    </details>
    <details><summary>UI responsiveness diagnostics</summary><dl aria-label="UI responsiveness diagnostics">
      {(Object.keys(diagnostics) as Array<keyof typeof diagnostics>).map((key) =>
        <FragmentCount key={key} label={key} value={diagnostics[key] === null ? 'None' : String(diagnostics[key])} />)}
    </dl></details>
    <button onClick={() => void copySummary()}>Copy Validation Summary</button>
    {copyState && <p role="status">{copyState}</p>}
    {manualSummary && <textarea aria-label="Validation summary (select manually)" readOnly rows={12}
      value={manualSummary} onFocus={(event) => event.currentTarget.select()} />}
  </section>
}

function FragmentCount({ label, value }: { label: string; value: number | string }) {
  return <><dt>{label}</dt><dd>{value}</dd></>
}

function metric(value: number | null | undefined, suffix: string, coverage?: string) {
  if (value == null) return coverage === 'UNKNOWN' ? 'Unknown' : 'Unavailable'
  return `${value}${suffix}${coverage === 'PARTIAL' ? ' (PARTIAL)' : ''}`
}
