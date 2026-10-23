import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const engineering = process.argv.includes('--engineering')
const connectionDiagnostic = process.argv.includes('--connection-diagnostic')
const activityV2Verification = process.argv.includes('--activity-v2-verification')
const consumerLabels = [
  'Elite+ Companion',
  'Home',
  'Connect',
  'Connections',
  'Settings',
  'Digital Wellness',
  'Set Up Digital Wellness',
  'Turn On Digital Wellness',
  'Usage Access',
  'Elite+ V8',
  'Connected',
  'Disconnected',
  'Battery',
  'Last connected',
  'Sync Device Data',
  'Sync Activity',
  'Last successful sync',
  'Heart Rate',
  'Blood Oxygen',
  'Temperature',
  'Synced',
  'No new data',
  'Could not sync',
  'Sending saved data…',
]
const engineeringLabels = [
  ...consumerLabels,
  'Test SpO₂ + Temperature',
  'Last Production Sync',
  'Last Acquisition Detail',
  'Delivery Diagnostics',
  'Queue Composition',
  'Test Activity 24 + 25',
  'Validate Type25 Minute Anchor',
  'Test Workout 29 + 82',
  'Copy Result JSON',
  'Retry Activity Test',
  'Finalize Saved Activity 24 + 25 Test',
  'Show Finalizer Diagnostic',
  'Copy Finalizer Diagnostic JSON',
  'Save Finalizer Diagnostic JSON',
  'Finalizer action received',
  'Finalizer still waiting',
  'FINALIZER_ACTION_TIMEOUT',
  'FINALIZER_REQUESTED',
  'Preparing Activity Test…',
  'Preparing Retry…',
  'RESULT_JSON_EMPTY',
  'JSON SHA-256:',
  'Save Result JSON',
  'View Receipt',
  'Share Receipt',
]
const diagnosticLabels = [
  'Run Connection Diagnostic',
  'Copy Diagnostic JSON',
  'Save Diagnostic JSON',
  'failedClosed',
  'priorFailureCode',
  'recoveryAudit',
  'recoveredAt',
  'transportInitializationStarted',
  'getDeviceVersionBlockedReason',
  'globalJournalEnvelopeCount',
  'globalJournalAccountedBytes',
  'journalMaxBytes',
  'READY reached',
]
const consumerForbiddenLabels = [
  'Finalize Saved Activity 24 + 25 Test',
  'Show Finalizer Diagnostic',
  'Copy Finalizer Diagnostic JSON',
  'Save Finalizer Diagnostic JSON',
  'Finalizer action received',
  'Finalizer still waiting',
  'FINALIZER_ACTION_TIMEOUT',
  'FINALIZER_REQUESTED',
  'Test Activity 24 + 25',
  'Validate Type25 Minute Anchor',
  'Refresh Saved Type25 Anchor History',
  'Show Saved Type25 Analysis JSON',
  'Copy Original Type25 Physical Attempt JSON',
  'Test Workout 29 + 82',
  'ACTIVITY 24/25 SEMANTIC TEST',
  'WORKOUT 29/82 LINKAGE TEST',
  'Digital Wellness Validation',
  'Test SpO₂ + Temperature',
  'Last Production Sync',
  'Last Acquisition Detail',
  'Delivery Diagnostics',
  'Queue Composition',
  'View Receipt',
  'Share Receipt',
  'Type27',
  'Type68',
  'Type59',
  'JCVITAL_NATIVE',
  'Source Journal',
  'acquisition IDs',
  'sync IDs',
  'queue internals',
  'Base44 batch IDs',
  'canonicalization',
  'Connection state:',
  'Base44 batch',
  'Run Connection Diagnostic',
  'Copy Diagnostic JSON',
  'Save Diagnostic JSON',
  'Run Pipeline Diagnostic',
  'Raw PPG',
  'ECG diagnostic',
  'acquisition_id',
  'acquisition_request_id',
  'connection_generation',
  'acquisition_started_at',
  'acquisition_completed_at',
  'client_queued_at',
]
const requiredLabels = engineering
  ? engineeringLabels
  : connectionDiagnostic ? [...consumerLabels, ...diagnosticLabels]
    : activityV2Verification ? [...consumerLabels, 'Verify Activity V2 E2E'] : consumerLabels

function collectFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) files.push(...collectFiles(fullPath))
    else files.push(fullPath)
  }
  return files
}

const directoryArgument = process.argv.indexOf('--dist-dir')
if (directoryArgument >= 0 && !process.argv[directoryArgument + 1]) {
  throw new Error('--dist-dir requires a directory')
}
const distDir = directoryArgument >= 0 ? process.argv[directoryArgument + 1] : join(process.cwd(), 'dist')
const metadata = JSON.parse(readFileSync(join(distDir, 'connector-build.json'), 'utf8'))
const expectedMode = engineering ? 'engineering' : connectionDiagnostic ? 'connection-diagnostic'
  : activityV2Verification ? 'activity-v2-verification' : 'consumer'
if (metadata.schema !== 1 || metadata.mode !== expectedMode) {
  throw new Error(`Packaged web mode must be ${expectedMode}; rebuild and stage the matching web assets`)
}
const found = new Set()
const files = collectFiles(distDir)
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  for (const label of requiredLabels) {
    if (text.includes(label)) found.add(label)
  }
}

const missing = requiredLabels.filter((label) => !found.has(label))
if (missing.length) {
  console.error('Missing required physical-acceptance labels in bundled JS:')
  for (const label of missing) console.error(`- ${label}`)
  process.exit(1)
}

if (!engineering && !connectionDiagnostic) {
  const forbidden = new Set()
  const forbiddenLabels = activityV2Verification
    ? consumerForbiddenLabels.filter((label) => label !== 'JCVITAL_NATIVE')
    : consumerForbiddenLabels
  for (const file of files) {
    const text = readFileSync(file, 'utf8')
    for (const label of forbiddenLabels) {
      if (text.includes(label)) forbidden.add(label)
    }
    // requested_metrics_json and sync_id are established local SQLite schema, not wire/UI fields.
    if (/\brequested_metric\b/.test(text)) forbidden.add('requested_metric')
    if (/\bsync_id\s*:/.test(text)) forbidden.add('sync_id wire property')
  }
  if (forbidden.size) {
    console.error('Engineering-only labels found in the consumer bundle:')
    for (const label of forbidden) console.error(`- ${label}`)
    process.exit(1)
  }
  console.log(activityV2Verification
    ? 'Activity v2 production verification control included; all other Engineering controls and inactive provenance wire fields excluded. JCVITAL_NATIVE is retained only for exact saved-source ancestry validation.'
    : 'Consumer Engineering controls and inactive provenance wire fields excluded. Allowed non-UI internals: existing SQLite sync_id/requested_metrics_json, native-only certification metadata, SDK localhost fallback constants (production routing is pinned and tested).')
}

console.log(`Verified ${requiredLabels.length} physical acceptance labels in ${files.length} bundle files.`)
