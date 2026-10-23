import { useEffect, useState, useSyncExternalStore } from 'react'
import type { LocalDigitalWellness } from './health/digitalWellnessLocal'
import { DigitalWellnessValidation } from './DigitalWellnessValidation'
import { DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED, localDate, qualifiedBaseline } from './health/digitalWellnessProduction'

export function DigitalBalance({ wellness }: { wellness: LocalDigitalWellness }) {
  const snapshot = useSyncExternalStore(wellness.subscribe, wellness.getSnapshot)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60000)
    return () => window.clearInterval(timer)
  }, [])
  const granted = snapshot.consent.state === 'GRANTED'
  const saving = snapshot.setup === 'SAVING'
  const disabling = snapshot.setup === 'DISABLING'
  const prompting = !granted && (snapshot.setup === 'CONSENT_PROMPT' || saving || snapshot.state === 'CONSENT_REQUIRED')
  const latest = snapshot.records.at(-1)
  const day = latest?.result.days.at(-1)
  const production = snapshot.production
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const today = production?.days.find((item) => item.local_date === localDate(now, timezone) && item.timezone === timezone)
  const baseline = qualifiedBaseline(production?.days ?? [], timezone)
  return <section aria-label="Digital Wellness">
    <h2>Digital Wellness</h2>
    <p role="status">{granted ? 'On' : 'Off'}</p>
    <p>Track screen-time and device-use patterns to better understand your digital wellness.</p>
    <p>Local only. No readiness or scoring effect.</p>
    <dl aria-label="Digital Wellness access state">
      <dt>Usage Access</dt><dd>{snapshot.access.osAccess === 'GRANTED' ? 'Granted' : 'Required'}</dd>
      <dt>Last Update</dt><dd>{production?.worker_last_run ? new Date(production.worker_last_run).toLocaleString() : 'Not yet'}</dd>
    </dl>
    {__ENGINEERING_VALIDATION__ && <p>{snapshot.state.replaceAll('_', ' ')} · {snapshot.access.continuity}</p>}
    {snapshot.error && <p role="alert">{snapshot.error}</p>}
    {granted && !disabling && <p role="status">{snapshot.osAccess === 'GRANTED'
      ? 'Digital Wellness is on.' : 'Your Elite+ Digital Wellness choice is saved. Android Usage Access is still required before collection can start.'}</p>}
    {prompting ? <div role="dialog" aria-label="Set Up Digital Wellness">
      <p>Elite+ can use device activity patterns such as screen time, unlock/use sessions, and pickup-like activity to help you understand your digital wellness patterns.</p>
      <p>Elite+ does not collect the names of apps you use, websites you visit, notification contents, messages, or screen contents through this feature.</p>
      <p>Turning this on saves your Elite+ choice on this device. Android Usage Access is separate special access that you control in Android Settings; if it is not already allowed, Android Settings opens next. After consent and access are enabled, local collection may refresh in the background and when you return to Elite+.</p>
      <button disabled={saving} onClick={() => void wellness.confirmSetup()}>{saving ? 'Saving your choice…' : 'Turn On Digital Wellness'}</button>
      <button disabled={saving} onClick={() => wellness.cancelSetup()}>Cancel</button>
    </div> : !granted && <button disabled={disabling} onClick={() => wellness.beginSetup()}>Set Up Digital Wellness</button>}
    {granted && <>
      <button disabled={disabling} onClick={() => void wellness.disable()}>{disabling ? 'Disabling…' : 'Disable Digital Wellness'}</button>
      <button disabled={snapshot.state === 'COLLECTING' || disabling} onClick={() => void wellness.runUiAction('REFRESH', () => wellness.refresh())}>
        Refresh Digital Wellness</button>
      {/* Settings access without Elite+ consent would grant OS access while leaving collection off. */}
      <button onClick={() => void wellness.openSettings()}>Open Android Usage Access Settings</button>
    </>}
    <button onClick={() => void wellness.runUiAction('CHECK_USAGE_ACCESS', () => wellness.checkUsageAccess())}>Check Usage Access</button>
    {snapshot.diagnostics.last_ui_error_code === 'ACTION_TIMEOUT' && snapshot.diagnostics.ui_actions_in_flight === 0
      && <p role="status">That took longer than expected. Elite+ is still working in the background; you can try again.</p>}
    {production && <div aria-label="Local Digital Balance observations">
      <p>Today so far</p>
      {today?.coverage_state === 'PARTIAL' && <p>Partial data</p>}
      <dl>
        <dt>Screen Time</dt><dd>{metric(today?.screen_time_minutes, ' min', today?.coverage_state)}</dd>
        <dt>Pickups</dt><dd>{metric(today?.pickups, '', today?.coverage_state)}</dd>
        <dt>First Pickup</dt><dd>{today?.first_pickup ?? 'Unavailable'}</dd>
        <dt>Screen Sessions</dt><dd>{metric(today?.screen_sessions, '', today?.coverage_state)}</dd>
        <dt>Last updated</dt><dd>{today?.updated_at ?? 'Not collected'}</dd>
      </dl>
      {baseline.length ? <p>Qualified history: {baseline.length} days. Average screen time: {
        (baseline.reduce((sum, item) => sum + (item.screen_time_minutes ?? 0), 0) / baseline.length).toFixed(1)
      } min/day.</p> : <p>Building your baseline</p>}
      <p>Only qualified, closed days enter historical summaries. Pickups are a device-event proxy, not physical lifts.</p>
      {__ENGINEERING_VALIDATION__ && <details><summary>Production diagnostics</summary><dl>
        <dt>Worker last run</dt><dd>{production.worker_last_run ?? 'Not run'}</dd>
        <dt>Next eligible run (best-effort)</dt><dd>{production.next_eligible_run ?? 'Inactive'}</dd>
        <dt>Last Usage Access check</dt><dd>{production.last_usage_access_check ?? 'Not checked'}</dd>
        <dt>Active local day state</dt><dd>{today?.coverage_state ?? 'UNKNOWN'}</dd>
        <dt>Checkpoint age (seconds)</dt><dd>{production.checkpoints.at(-1)
          ? Math.max(0, Math.round((now - Date.parse(production.checkpoints.at(-1)!.captured_at)) / 1000)) : 'Unavailable'}</dd>
        <dt>Outbox count</dt><dd>{production.outbox.filter((item) => !item.ack).length}</dd>
        <dt>Cloud flag</dt><dd>{String(DIGITAL_WELLNESS_CLOUD_SYNC_ENABLED)}</dd>
        <dt>Last sender outcome</dt><dd>{production.last_sender_outcome}</dd>
        <dt>Scope</dt><dd>{production.owner_kind}</dd>
      </dl></details>}
    </div>}
    {!production && latest && <div aria-label="Local Digital Balance observations">
      <p>Saved local observations{granted ? '' : ' (collection disabled)'}</p>
      <p>Local day: {day?.date} · {latest.result.observations[0]?.timezone}</p>
      <dl>
        <dt>Screen Time</dt><dd>{metric(day?.screen_time_minutes, ' min', day?.coverage.state)}</dd>
        <dt>Pickups</dt><dd>{metric(day?.pickups, '', day?.coverage.state)}</dd>
        <dt>First Pickup</dt><dd>{day?.first_pickup ?? 'Unknown'}</dd>
        <dt>Screen Sessions</dt><dd>{metric(day?.screen_sessions, '', day?.coverage.state)}</dd>
        <dt>Late-Night Screen Time</dt><dd>{metric(day?.late_night_screen_minutes, ' min', day?.coverage.state)}</dd>
        <dt>Last updated</dt><dd>{latest.capturedAt}</dd>
        <dt>Coverage</dt><dd>{day?.coverage.state ?? 'UNKNOWN'} — Android history completeness is unverified</dd>
      </dl>
      <p>Last 24 hours, split by local day. PARTIAL values are not used for baselines or trends. Pickups are a device-event proxy, not physical lifts.</p>
      <details><summary>Coverage details</summary>
        <p>Confidence: {day?.confidence ?? 'UNKNOWN'}</p>
        <p>{latest.result.qualityReasons.join(', ')}</p>
        <p>{latest.result.semanticVersion} · {snapshot.deliveryCapability}</p>
      </details>
    </div>}
    {__ENGINEERING_VALIDATION__ && <DigitalWellnessValidation wellness={wellness} />}
  </section>
}

function metric(value: number | null | undefined, suffix: string, coverage?: string) {
  if (value == null) return 'Unknown'
  return `${value}${suffix}${coverage === 'PARTIAL' ? ' (PARTIAL)' : ''}`
}
