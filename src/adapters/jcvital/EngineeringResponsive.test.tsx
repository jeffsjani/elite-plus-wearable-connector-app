import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ElitePlusV8Dashboard, type ElitePlusV8DashboardProps } from './ElitePlusV8Dashboard'
import { PipelineEvidenceTable, V8PipelineDiagnosticView } from './V8PipelineDiagnosticView'

vi.mock('../../buildMode', () => ({
  IS_ENGINEERING_BUILD: true,
  IS_CONNECTION_DIAGNOSTIC_BUILD: false,
  IS_ACTIVITY_V2_PRODUCTION_VERIFICATION_BUILD: false,
}))

const css = readFileSync(new URL('../../App.css', import.meta.url), 'utf8')
const app = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const panel = readFileSync(new URL('./PipelineDiagnosticV8Panel.tsx', import.meta.url), 'utf8')
const diagnostic = readFileSync(new URL('./V8PipelineDiagnosticView.tsx', import.meta.url), 'utf8')
const vite = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')
const gradle = readFileSync(new URL('../../../android/app/build.gradle', import.meta.url), 'utf8')
const widths = [320, 360, 375, 390, 412, 430, 600]

function rule(selector: string) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(`${escaped}\\s*\\{([^}]+)\\}`))
  expect(match, selector).not.toBeNull()
  return match?.[1] ?? ''
}

const connectionProps: ElitePlusV8DashboardProps = {
  state: 'DISCONNECTED', pluginAvailable: true, devices: [],
  permission: { status: 'AUTHORIZED', bluetoothEnabled: true, permissions: [] },
  info: null, battery: null, lastConnectedAt: null, queueStats: null, busy: false,
  syncBusy: false, syncError: '', syncEnabled: false, appVersion: '1.0.0-rc3.1-diagnostic',
  connectionOnly: true, onRequestPermission: vi.fn(), onStartScan: vi.fn(),
  onConnect: vi.fn(), onDisconnect: vi.fn(), onSync: vi.fn(),
}

describe('Build 32A.1 engineering layout contracts (static; physical viewport verification pending)', () => {
  it('audits the actual engineering entry point and places connection before backend evidence', () => {
    expect(vite).toContain("engineering ? 'PipelineDiagnosticV8Panel.tsx' : 'ElitePlusV8Panel.tsx'")
    expect(panel).toContain('<ProductionPanel {...props} />')
    expect(panel).not.toContain('connectionOnly')
    expect(panel.indexOf('<ProductionPanel')).toBeLessThan(panel.indexOf('<V8PipelineDiagnosticView'))
    const shell = app.slice(app.indexOf('<main className="shell engineering-shell">'))
    expect(shell.indexOf('<JCVitalV8Panel')).toBeLessThan(shell.indexOf('<BackendEnvironmentPanel'))
    expect(shell.indexOf('<JCVitalV8Panel')).toBeLessThan(shell.indexOf('<Base44ContractProbePanel'))
    expect(panel).not.toMatch(/from '\.\/JCVitalV8Panel'|SourceCapabilityMatrix/)
  })

  it.each(widths)('has shrinkable, wrapping, single-column engineering contracts at %ipx', (width) => {
    expect(width).toBeLessThanOrEqual(640)
    for (const selector of ['.shell.engineering-shell', '.engineering-content']) {
      expect(rule(selector)).toMatch(/width:\s*100%/)
      expect(rule(selector)).toMatch(/min-width:\s*0/)
      expect(rule(selector)).not.toMatch(/overflow-x:\s*(hidden|clip)/)
    }
    expect(rule('.shell.engineering-shell')).toContain('display: block')
    expect(rule('.engineering-content')).toContain('max-width: 640px')
    expect(rule('.engineering-content')).toContain('margin: 0 auto')
    expect(rule('.engineering-content')).toContain('max(16px, env(safe-area-inset-left))')
    expect(rule('.engineering-content')).toContain('max(16px, env(safe-area-inset-right))')
    const children = rule('.engineering-content :where(*)')
    for (const declaration of ['min-width: 0', 'max-width: 100%', 'overflow-wrap: anywhere', 'word-break: break-word']) {
      expect(children).toContain(declaration)
    }
    expect(css).toMatch(/@media \(max-width: 640px\)\s*\{\s*\.shell \.engineering-content/)
    expect(css).toMatch(/\.engineering-evidence-table td\s*\{\s*display: block;\s*width: 100%;\s*min-width: 0;/)
    expect(rule('.engineering-evidence-table')).toContain('table-layout: fixed')
    expect(rule('.engineering-evidence-table thead')).toContain('display: none')
    expect(rule('.engineering-content button')).toContain('width: 100%')
    expect(rule('.engineering-content summary')).toContain('min-height: 48px')
    expect(rule('.engineering-content summary')).toContain('font-size: 1rem')
  })

  it('renders every evidence family as labeled rows with nested wrapping values, not inline JSON', () => {
    const longValue = 'deviceScopeId_sourceRecordId_hash_UUID_error_'.repeat(100)
    for (const label of ['Account Binding', 'Acquisition', 'Queue', 'Delivery', 'Source timestamps']) {
      const html = renderToStaticMarkup(<PipelineEvidenceTable label={label} values={{
        'Authenticated owner': longValue, 'Queue owner': longValue,
        'Device scope': { deviceScopeId: longValue, errors: [longValue] },
      }} />)
      expect(html).toContain(`aria-label="${label}"`)
      expect(html).toContain('<th scope="row">Authenticated owner</th>')
      expect(html).toContain('data-label="Queue owner"')
      expect(html).toContain(longValue)
      expect(html).not.toContain('<pre')
      expect(html).not.toContain('style=')
    }
  })

  it('exposes read-only queue composition and measured drain values in Engineering only', () => {
    const queueComposition = {
      totalPending: 4,
      byMetric: [{ key: 'heartRate', count: 2 }, { key: 'oxygenSaturation', count: 1 }, { key: 'wearableTemperature', count: 1 }],
      byVendorDataType: [{ key: '27', count: 2 }, { key: '68', count: 1 }, { key: '59', count: 1 }],
      bySyncId: [{ key: '(missing)', count: 2 }, { key: 'v49-sync', count: 2 }],
      byAcquisitionId: [{ key: 'acq-spo2', count: 1 }, { key: 'acq-temp', count: 1 }],
      byRequestedMetric: [{ key: 'oxygenSaturation', count: 1 }, { key: 'wearableTemperature', count: 1 }],
      oldestPendingAt: '2026-10-16T10:00:00.000Z', newestPendingAt: '2026-10-16T11:00:00.000Z',
      oldestObservedAt: '2026-10-16T08:00:00.000Z', newestObservedAt: '2026-10-16T09:00:00.000Z',
      attemptCount: { zero: 4, one: 0, two: 0, threePlus: 0 },
      distinctObservationIds: 4, duplicateObservationIdRows: 0,
      currentV49SyncId: 'v49-sync', currentV49SyncPending: 2,
      currentV49MetricPending: [{ key: 'oxygenSaturation', count: 1 }, { key: 'wearableTemperature', count: 1 }],
      currentV49FirstPosition: 3, currentV49LastPosition: 4, currentV49RowsAhead: 2,
      heartRateRowsAheadCurrentV49: 2, priorSyncPending: 2,
    }
    const engineeringHtml = renderToStaticMarkup(<ElitePlusV8Dashboard {...connectionProps} connectionOnly={false} engineeringBuild
      queueComposition={queueComposition} deliveryDiagnostics={{
        requestTimeoutMs: 30_000, staleSendingMs: 60_000, activeBatch: null, activeBatches: [],
        configuredConcurrency: 1, configWarning: null, effectiveConcurrency: 1, activeWorkerCount: 0,
        senderActive: false, senderGeneration: 1, observationsPerMinute: 300, batchesPerMinute: 3,
        averageBatchLatencyMs: 1_000, medianBatchDurationMs: 1_000, p95BatchDurationMs: 1_000,
        successfulBatches: 3, retryBatches: 0, failedBatches: 0, canonicalFailureCount: 0,
        canonicalFailureAlert: null, canonicalRecoveryRequired: false, canonicalRecoveryObservationCount: 0,
        canonicalRecoveryBatchCount: 0, lastCanonicalFailureBatchId: null, lastCanonicalFailureAt: null,
        canonicalRecoveryBatches: [], queuePausedForCanonicalFailure: false, pauseReason: null,
        previousEffectiveConcurrency: null, newEffectiveConcurrency: null, queueStats: null, queueStatsError: null,
        estimatedMinutesRemaining: 1, lastBatch: null, retryScheduledAt: null, lastStaleRecovery: null,
        startupQueueResumeAttempted: false, startupQueueResumeStarted: false, startupQueueResumeBlockedReason: null,
        restoredBackendDeviceId: false, persistedDeliveryEnablement: false, recentResponseShapes: [],
      }} />)
    const athleteHtml = renderToStaticMarkup(<ElitePlusV8Dashboard {...connectionProps} connectionOnly={false} engineeringBuild={false}
      queueComposition={queueComposition} />)

    expect(engineeringHtml).toContain('Queue Composition · Read only')
    expect(engineeringHtml).toContain('Rows ahead of v49 SpO₂/Temperature')
    expect(engineeringHtml).toContain('300.00')
    expect(engineeringHtml).toContain('v49-sync')
    expect(athleteHtml).not.toContain('Queue Composition · Read only')
  })

  it('keeps identity before actions and source details after delivery, with JSON collapsed', () => {
    const sections = ['Account Binding', 'Diagnostic actions/export', 'Acquisition', 'Queue', 'Delivery', 'Source/timestamp details']
    const positions = sections.map((label) => diagnostic.indexOf(`aria-label="${label}"`))
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect(positions).toEqual([...positions].sort((left, right) => left - right))
    expect(diagnostic).toContain('<details className="engineering-raw-json">')
    expect(diagnostic).toContain('<summary>Show Raw JSON</summary>')
    expect(diagnostic.match(/<pre>/g)).toHaveLength(1)
    expect(rule('.engineering-content code')).toContain('white-space: pre-wrap')
    expect(rule('.engineering-content pre')).toContain('overflow: auto')
    const html = renderToStaticMarkup(<V8PipelineDiagnosticView ownerUserId="owner" />)
    for (const label of ['Export Pre-Sync Diagnostic', 'Run Normal Sync Diagnostic', 'Export Post-Sync Diagnostic']) {
      expect(html).toContain(label)
    }
  })

  it.each(['DISCONNECTED', 'SCANNING', 'CONNECTING', 'CONNECTED', 'INITIALIZING', 'READY'] as const)(
    'exposes Build31 connection controls/state %s without large dashboard content', (state) => {
      const html = renderToStaticMarkup(<ElitePlusV8Dashboard {...connectionProps} state={state} devices={[{
        id: 'AA:BB:CC:DD:EE:FF', name: 'PRO V8', rssi: -42, advertisesJcvitalService: true, v8Candidate: true,
        macAddress: 'AA:BB:CC:DD:EE:FF', bonded: false, connectable: true, lastSeenAt: '2026-10-09T15:00:00Z',
      }]} />)
      expect(html).toContain(`Connection state: ${state}`)
      expect(html).not.toContain('Data from your Elite+ V8')
      expect(html).not.toContain('Device Details')
      if (['DISCONNECTED', 'SCANNING'].includes(state)) {
        expect(html).toContain('PRO V8')
        expect(html).toContain('>Connect</button>')
      }
      if (state === 'DISCONNECTED') expect(html).toContain('Scan for Elite+ V8')
      if (state === 'CONNECTING') expect(html).toContain('Connecting')
      if (state === 'READY') expect(html).toContain('>Disconnect</button>')
    },
  )

  it('keeps the permanent Connector identity and increments the current Engineering version for Companion', () => {
    const build = JSON.parse(readFileSync(new URL('../../../companion-build.json', import.meta.url), 'utf8'))
    expect(build.versionCode).toBe(build.previousVersionCode + 1)
    expect(gradle).toContain('versionCode companionVersion.versionCode')
    expect(gradle).toContain('versionName companionVersion.versionName')
    expect(build.versionName).toContain('p1-2f-source-pagination-fix')
    /*
    1-2E — BASE44 CAPABILITY HANDSHAKE DIAGNOSTIC
The installed P1-2E APK shows:
Verify Activity V2 E2E = DISABLED
Base44 capability = NOT PRESENT

Base44 production has already been published and independently verified as:
LIVE_REVISION =
nc-observations-2026-10-21-r7-activity-canonical

SERVER_CAPABILITIES includes:
JCVITAL_ACTIVITY_TRANSPORT_V2

BASE44_R7_POST_PUBLISH = PASS
READY_FOR_COMPANION_V66 = YES

Therefore diagnose only the Companion registration/capability path.

Do not perform Activity acquisition.
Do not press Sync Activity.
Do not clear storage.
Do not alter queue, sender, ACK, Base44 ingestion, readiness, scoring or Digital Wellness.
1. Verify installed build
Confirm the P1-2E APK contains the expected capability-gated code and report:
package
versionCode
versionName
APK SHA-256
build mode

Confirm this is actually the intended:
ElitePlus-Companion-Phase1-P1-2E-Activity-V2-E2E.apk

and not v65 or another earlier build.
2. Verify Base44 environment
Confirm the installed build is registering against production:
https://waves-elite-sync.base44.app

and uses:
/functions/nativeConnectorRegister

Report the exact resolved register URL/environment.
3. Inspect registration response
Add/read-only diagnostic output for the most recent registration handshake:
registration attempted at
HTTP status
response received
response JSON
serverCapabilities raw
parsed capabilities
JCVITAL_ACTIVITY_TRANSPORT_V2 present raw = YES/NO
JCVITAL_ACTIVITY_TRANSPORT_V2 recognized = YES/NO

Redact credentials/tokens.

Do not send observations.
4. Check stale capability caching
Determine whether the Companion cached a pre-r7 registration response before Base44 was published.

If yes, add a safe:
Refresh Base44 Capabilities

Engineering action that:
re-runs registration only
does not clear app storage
does not modify owner/device evidence
does not touch observation queue
does not send Activity observations

Existing persisted evidence must remain intact.
5. Check schema/parser mismatch
Base44 reports:
SERVER_CAPABILITIES =
["JCVITAL_ACTIVITY_TRANSPORT_V2"]

Verify the Companion accepts the exact server field name/casing/shape.

Look specifically for mismatches such as:
serverCapabilities vs SERVER_CAPABILITIES
capabilities vs server_capabilities
array nested under data/result
parser expecting another response envelope

Do not change Base44 merely to compensate for an incorrect client parser unless necessary.
6. Fail-closed behavior
Preserve:
capability absent/unrecognized
→ Activity V2 production caller OFF
→ Verify Activity V2 E2E disabled

That safety behavior is correct.
7. Final report
Return:
P1_2E_CAPABILITY_DIAGNOSTIC = PASS/FAIL

INSTALLED_BUILD_CORRECT = YES/NO
PRODUCTION_BASE44_ENDPOINT = YES/NO
REGISTRATION_HTTP_STATUS =

RAW_SERVER_CAPABILITIES =
PARSED_SERVER_CAPABILITIES =

ACTIVITY_V2_CAPABILITY_RAW_PRESENT = YES/NO
ACTIVITY_V2_CAPABILITY_RECOGNIZED = YES/NO

STALE_CAPABILITY_CACHE = YES/NO
CLIENT_RESPONSE_SCHEMA_BUG = YES/NO

ACTIVITY_V2_PRODUCTION_CALLER_ENABLED = YES/NO
ACTIVITY_SYNC_RUN = NO
QUEUE_CHANGED = NO
BASE44_OBSERVATION_CALLS = 0

READY_FOR_ACTIVITY_V2_E2E = YES/NO

If a client parser/cache defect is found, fix only that defect, run regression tests, and package the smallest install-over build needed. Do not start the Activity E2E tesP1-2E.2 — CAPABILITY RECOGNITION GATE FIX

ON-DEVICE EVIDENCE NOW CONFIRMS:

HTTP status = 200

Response received = true

Register URL =
https://waves-elite-sync.base44.app/functions/nativeConnectorRegister

Production environment match = true

serverCapabilities raw =
["JCVITAL_ACTIVITY_TRANSPORT_V2"]

Parsed capabilities =
JCVITAL_ACTIVITY_TRANSPORT_V2

JCVITAL_ACTIVITY_TRANSPORT_V2 raw present = true

BUT:

JCVITAL_ACTIVITY_TRANSPORT_V2 recognized = false

Therefore Base44 production, registration transport, response extraction, and capability parsing are now proven correct.

DIAGNOSE ONLY THE CLIENT CAPABILITY RECOGNITION/GATING PATH.

Do not modify Base44.

Do not perform Activity acquisition.

Do not press Verify Activity V2 E2E.

Do not run Sync Activity.

Do not clear app storage.

Do not alter owner/device evidence.

Do not alter queue, sender, ACK, ingestion, readiness, scoring, Digital Wellness, or Activity canonicalization.

Do not broaden scope.

1. TRACE EXACT RECOGNITION LOGIC

Trace the code path that produces:

JCVITAL_ACTIVITY_TRANSPORT_V2 recognized = false

Identify:

- the canonical client capability constant
- the exact parsed input value
- any normalization applied
- the membership/comparison function
- any capability aliases
- the state value used by the Activity V2 production gate
- whether refresh updates that state immediately

Report the exact comparison currently being made.

The server value is exactly:

JCVITAL_ACTIVITY_TRANSPORT_V2

The client must recognize that exact value.

2. CHECK FOR CLIENT-SIDE MISMATCH

Look specifically for:

- wrong capability constant
- lowercase/uppercase mismatch
- hyphen/underscore mismatch
- trailing/leading whitespace
- comparison against `jcvital.native.activity.transport.v2`
- old capability identifier
- wrong enum value
- checking object keys instead of array values
- stale memoized/derived capability state
- refresh updating diagnostics but not production gate state
- gate reading a different capability store than diagnostics
- capability recognized before parser state is persisted
- React state/cache not being refreshed after registration

Do not weaken the fail-closed gate.

3. REQUIRED REGRESSION TEST

Add a focused test using exactly:

["JCVITAL_ACTIVITY_TRANSPORT_V2"]

Assert:

raw present = true
parsed capability contains exact value
recognized = true
Activity V2 capability gate = true

Also test:

[]
→ recognized = false

and:

["UNKNOWN_CAPABILITY"]
→ recognized = false

Fail-closed behavior must remain intact.

4. FIX ONLY THE RECOGNITION DEFECT

If a defect is found, fix only the capability recognition/state propagation path.

Do not modify Activity acquisition or transport.

Do not modify Base44.

Do not send observations.

If the installed v67 cannot receive the fix without a new APK, create the smallest install-over replacement using the same package and signer with the next versionCode.

Do not reuse versionCode 67 if Android requires a higher versionCode for install-over.

5. VERIFY BUILD

Report:

package
versionCode
versionName
SHA-256
signer compatibility
build mode

Confirm diagnostic UI remains present.

6. ON-DEVICE SUCCESS CRITERIA

After installing the corrected build over the existing app WITHOUT uninstalling or clearing storage:

Use only:

Refresh Base44 Capabilities

Expected:

HTTP status = 200

serverCapabilities raw =
["JCVITAL_ACTIVITY_TRANSPORT_V2"]

Parsed capabilities =
JCVITAL_ACTIVITY_TRANSPORT_V2

JCVITAL_ACTIVITY_TRANSPORT_V2 raw present = true

JCVITAL_ACTIVITY_TRANSPORT_V2 recognized = true

Base44 capability = PRESENT

Verify Activity V2 E2E = ENABLED

STOP THERE.

DO NOT PRESS Verify Activity V2 E2E.

7. FINAL REPORT

Return:

P1_2E_CAPABILITY_RECOGNITION_FIX = PASS/FAIL

ROOT_CAUSE =

CLIENT_CAPABILITY_CONSTANT =
PARSED_CAPABILITY_VALUE =
COMPARISON_RESULT_BEFORE = FALSE
COMPARISON_RESULT_AFTER = TRUE/FALSE

CAPABILITY_STATE_REFRESHED = YES/NO
PRODUCTION_GATE_USES_SAME_CAPABILITY_STATE = YES/NO

REGRESSION_TEST_EXACT_CAPABILITY = PASS/FAIL
REGRESSION_TEST_EMPTY_CAPABILITY = PASS/FAIL
REGRESSION_TEST_UNKNOWN_CAPABILITY = PASS/FAIL

NEW_APK_REQUIRED = YES/NO

PACKAGE =
VERSION_CODE =
VERSION_NAME =
APK_SHA256 =
SIGNER_COMPATIBLE = YES/NO

ACTIVITY_SYNC_RUN = NO
ACTIVITY_ACQUISITION_RUN = NO
QUEUE_CHANGED = NO
BASE44_OBSERVATION_CALLS = 0
OWNER_DEVICE_EVIDENCE_CHANGED = NO

ON_DEVICE_RAW_PRESENT = YES/NO
ON_DEVICE_RECOGNIZED = YES/NO
BASE44_CAPABILITY_UI = PRESENT/NOT_PRESENT
VERIFY_ACTIVITY_V2_E2E_ENABLED = YES/NO

READY_FOR_ACTIVITY_V2_E2E = YES/NO

READY_FOR_ACTIVITY_V2_E2E may be YES only when on-device recognized = YES and Base44 capability visibly reports PRESENT.

Do not begin Activity V2 E2E in this task.P1-2E.2 — CAPABILITY RECOGNITION GATE FIX

ON-DEVICE EVIDENCE NOW CONFIRMS:

HTTP status = 200

Response received = true

Register URL =
https://waves-elite-sync.base44.app/functions/nativeConnectorRegister

Production environment match = true

serverCapabilities raw =
["JCVITAL_ACTIVITY_TRANSPORT_V2"]

Parsed capabilities =
JCVITAL_ACTIVITY_TRANSPORT_V2

JCVITAL_ACTIVITY_TRANSPORT_V2 raw present = true

BUT:

JCVITAL_ACTIVITY_TRANSPORT_V2 recognized = false

Therefore Base44 production, registration transport, response extraction, and capability parsing are now proven correct.

DIAGNOSE ONLY THE CLIENT CAPABILITY RECOGNITION/GATING PATH.

Do not modify Base44.

Do not perform Activity acquisition.

Do not press Verify Activity V2 E2E.

Do not run Sync Activity.

Do not clear app storage.

Do not alter owner/device evidence.

Do not alter queue, sender, ACK, ingestion, readiness, scoring, Digital Wellness, or Activity canonicalization.

Do not broaden scope.

1. TRACE EXACT RECOGNITION LOGIC

Trace the code path that produces:

JCVITAL_ACTIVITY_TRANSPORT_V2 recognized = false

Identify:

- the canonical client capability constant
- the exact parsed input value
- any normalization applied
- the membership/comparison function
- any capability aliases
- the state value used by the Activity V2 production gate
- whether refresh updates that state immediately

Report the exact comparison currently being made.

The server value is exactly:

JCVITAL_ACTIVITY_TRANSPORT_V2

The client must recognize that exact value.

2. CHECK FOR CLIENT-SIDE MISMATCH

Look specifically for:

- wrong capability constant
- lowercase/uppercase mismatch
- hyphen/underscore mismatch
- trailing/leading whitespace
- comparison against `jcvital.native.activity.transport.v2`
- old capability identifier
- wrong enum value
- checking object keys instead of array values
- stale memoized/derived capability state
- refresh updating diagnostics but not production gate state
- gate reading a different capability store than diagnostics
- capability recognized before parser state is persisted
- React state/cache not being refreshed after registration

Do not weaken the fail-closed gate.

3. REQUIRED REGRESSION TEST

Add a focused test using exactly:

["JCVITAL_ACTIVITY_TRANSPORT_V2"]

Assert:

raw present = true
parsed capability contains exact value
recognized = true
Activity V2 capability gate = true

Also test:

[]
→ recognized = false

and:

["UNKNOWN_CAPABILITY"]
→ recognized = false

Fail-closed behavior must remain intact.

4. FIX ONLY THE RECOGNITION DEFECT

If a defect is found, fix only the capability recognition/state propagation path.

Do not modify Activity acquisition or transport.

Do not modify Base44.

Do not send observations.

If the installed v67 cannot receive the fix without a new APK, create the smallest install-over replacement using the same package and signer with the next versionCode.

Do not reuse versionCode 67 if Android requires a higher versionCode for install-over.

5. VERIFY BUILD

Report:

package
versionCode
versionName
SHA-256
signer compatibility
build mode

Confirm diagnostic UI remains present.

6. ON-DEVICE SUCCESS CRITERIA

After installing the corrected build over the existing app WITHOUT uninstalling or clearing storage:

Use only:

Refresh Base44 Capabilities

Expected:

HTTP status = 200

serverCapabilities raw =
["JCVITAL_ACTIVITY_TRANSPORT_V2"]

Parsed capabilities =
JCVITAL_ACTIVITY_TRANSPORT_V2

JCVITAL_ACTIVITY_TRANSPORT_V2 raw present = true

JCVITAL_ACTIVITY_TRANSPORT_V2 recognized = true

Base44 capability = PRESENT

Verify Activity V2 E2E = ENABLED

STOP THERE.

DO NOT PRESS Verify Activity V2 E2E.

7. FINAL REPORT

Return:

P1_2E_CAPABILITY_RECOGNITION_FIX = PASS/FAIL

ROOT_CAUSE =

CLIENT_CAPABILITY_CONSTANT =
PARSED_CAPABILITY_VALUE =
COMPARISON_RESULT_BEFORE = FALSE
COMPARISON_RESULT_AFTER = TRUE/FALSE

CAPABILITY_STATE_REFRESHED = YES/NO
PRODUCTION_GATE_USES_SAME_CAPABILITY_STATE = YES/NO

REGRESSION_TEST_EXACT_CAPABILITY = PASS/FAIL
REGRESSION_TEST_EMPTY_CAPABILITY = PASS/FAIL
REGRESSION_TEST_UNKNOWN_CAPABILITY = PASS/FAIL

NEW_APK_REQUIRED = YES/NO

PACKAGE =
VERSION_CODE =
VERSION_NAME =
APK_SHA256 =
SIGNER_COMPATIBLE = YES/NO

ACTIVITY_SYNC_RUN = NO
ACTIVITY_ACQUISITION_RUN = NO
QUEUE_CHANGED = NO
BASE44_OBSERVATION_CALLS = 0
OWNER_DEVICE_EVIDENCE_CHANGED = NO

ON_DEVICE_RAW_PRESENT = YES/NO
ON_DEVICE_RECOGNIZED = YES/NO
BASE44_CAPABILITY_UI = PRESENT/NOT_PRESENT
VERIFY_ACTIVITY_V2_E2E_ENABLED = YES/NO

READY_FOR_ACTIVITY_V2_E2E = YES/NO

READY_FOR_ACTIVITY_V2_E2E may be YES only when on-device recognized = YES and Base44 capability visibly reports PRESENT.

Do not begin Activity V2 E2E in this task.t until the capability visibly reports PRESENT.')
    */
    expect(gradle).toContain('buildConfigField "boolean", "CONNECTION_DIAGNOSTIC", "${connectionDiagnostic}"')
    expect(gradle).toContain('applicationId "com.hapi.eliteplus.connector"')
  })
})
