import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = resolve('scripts/assert-physical-acceptance-labels.mjs')
const labels = ['Elite+ Companion', 'Home', 'Connections', 'Settings', 'Digital Wellness',
  'Set Up Digital Wellness', 'Turn On Digital Wellness', 'Usage Access',
  'Elite+ V8', 'Connected', 'Disconnected', 'Battery', 'Last connected', 'Sync Device Data',
  'Sync Activity',
  'Last successful sync', 'Heart Rate', 'Blood Oxygen', 'Temperature', 'Synced', 'No new data',
  'Could not sync', 'Sending saved data…'].join('\n')

function check(extra: string, base = labels, mode: string | null = 'consumer', args: string[] = []) {
  const directory = mkdtempSync(join(tmpdir(), 'elite-consumer-policy-'))
  try {
    mkdirSync(join(directory, 'dist'))
    writeFileSync(join(directory, 'dist', 'bundle.js'), base + '\n' + extra)
    if (mode) writeFileSync(join(directory, 'dist', 'connector-build.json'), JSON.stringify({ schema: 1, mode }))
    return spawnSync(process.execPath, [script, ...args], { cwd: directory, encoding: 'utf8' })
  } finally {
    rmSync(directory, { recursive: true })
  }
}

describe('consumer bundle exclusion gate', () => {
  it('includes only the scoped Activity E2E action in the explicit verification build', () => {
    const base = labels + '\nVerify Activity V2 E2E'
    expect(check('JCVITAL_NATIVE', base, 'activity-v2-verification', ['--activity-v2-verification']).status).toBe(0)
    for (const label of ['Test Activity 24 + 25', 'Test Workout 29 + 82', 'Run Connection Diagnostic']) {
      expect(check(label, base, 'activity-v2-verification', ['--activity-v2-verification']).status).toBe(1)
    }
    expect(check('', labels, 'activity-v2-verification', ['--activity-v2-verification']).status).toBe(1)
  })
  it('accepts established non-visible local storage and transport internals', () => {
    expect(check('sync_id TEXT NOT NULL; requested_metrics_json TEXT; certificationOnly; http://localhost').status).toBe(0)
  })
  it.each(['Digital Wellness Validation', 'Test SpO₂ + Temperature', 'Last Acquisition Detail', 'Delivery Diagnostics', 'Queue Composition',
    'Test Activity 24 + 25', 'Test Workout 29 + 82', 'ACTIVITY 24/25 SEMANTIC TEST', 'WORKOUT 29/82 LINKAGE TEST',
    'View Receipt', 'Source Journal', 'JCVITAL_NATIVE', 'Type27', 'Type68', 'Type59', 'Base44 batch',
    'canonicalization', 'Run Connection Diagnostic', 'Raw PPG', 'ECG diagnostic', 'acquisition_id',
    'acquisition_request_id', 'requested_metric', 'connection_generation', 'sync_id:'])('rejects %s', (label) => {
    const result = check(label)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Engineering-only labels')
  })
  it('fails when a required consumer concept is missing', () => {
    expect(check('', labels.replace('Last successful sync', '')).status).toBe(1)
  })
  it.each(['engineering', 'connection-diagnostic', null])('rejects missing or mismatched build metadata: %s', (mode) => {
    expect(check('', labels, mode).status).not.toBe(0)
  })
})
