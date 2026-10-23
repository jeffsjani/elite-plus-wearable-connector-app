import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { CONNECTION_DIAGNOSTIC_SCHEMA, REFERENCE_V8, serializeConnectionDiagnostic, type ConnectionDiagnosticReport, type JournalCapacityAnalysis } from './ConnectionDiagnostic'

const mocks = vi.hoisted(() => ({ copyJson: vi.fn(), saveJson: vi.fn(), share: vi.fn() }))
vi.mock('@capacitor/core', () => ({ registerPlugin: () => mocks }))
vi.mock('./CertificationJsonExport', () => ({ saveValidationJson: mocks.share }))

import { ConnectionDiagnosticSummary, JournalStoragePressure, JournalCapacitySummary, diagnosticSaveFilename, exportConnectionDiagnostic, exportJournalCapacityAnalysis } from './ConnectionDiagnosticExport'

const capacity: JournalCapacityAnalysis = {
  schema: 'journal-capacity-analysis/1', generatedAt: '2026-10-12T14:00:00.000Z',
  readOnly: true, limitsScope: 'GLOBAL_DATABASE_ALL_OWNERS', failedClosed: true,
  lastFailureCode: 'STORAGE_PRESSURE', maxBytes: 67108864, totalAccountedBytes: 67038912,
  envelopeJsonBytes: 56288238, rawBlobBytes: 0, perEnvelopeOverheadBytes: 10746880,
  reservedSourceFileBytes: 3794, otherAccountedBytes: 0, accountingMatches: true,
  hotProductionBytes: null, coldCertificationBytes: null, classificationReason: 'Purpose not verified.',
  groups: { accountId: Array.from({ length: 21 }, (_, i) => ({ key: `vendor-${i}`, accountedBytes: 100 - i, envelopes: 1 })),
    vendorBucket: [{ key: '27', accountedBytes: 5, envelopes: 1 }] },
  componentSumBytes: 67038912, reconciliationDifferenceBytes: 0, reconciliationStatus: 'RECONCILED', reconciliationReasons: [],
  topRecords20: [{ sequence: 1, accountId: 'a', deviceScopeId: 'd', vendorDataType: '27', kind: 'SDK_RECORD', timestamp: '2026-10-12T00:00:00.000Z',
    jsonBytes: 10, blobBytes: 0, overheadBytes: 1024, totalAccountedBytes: 1034, sourceRecordId: 'src-1', envelopeId: 'e1' }],
  rawBlobAnalysis: { rawBlobBytesTotal: 0, rawBlobCount: 0, largestRawBlobBytes: 0, topRawBlobFamilies: [],
    duplicateBlobCandidateCount: 0, duplicateBlobCandidateBytes: 0, duplicateBasis: 'GLOBAL_SHA256', topDuplicateGroups: [], removalStatus: 'NOT_SAFE' },
  evidenceInventory: { certificationEvidenceBytes: 0, certificationEvidenceScope: 'INSIDE_MAX_BYTES', diagnosticEvidenceBytes: 0,
    diagnosticEvidenceScope: 'INSIDE_MAX_BYTES', rawPpgEnvelopeBytes: 0, certificationSnapshotBytes: 0, certificationSnapshotScope: 'OUTSIDE_MAX_BYTES',
    reservedSourceFileBytes: 3794, reservedSourceFileScope: 'RESERVED', sourceFileCount: 0, largestSourceFiles: [] },
  recoveryPlanning: { currentBytes: 67038912, maxBytes: 67108864, currentUtilizationPercent: 99.8958, target80PercentBytes: 53687091,
    bytesToRelieveFor80Percent: 13351821, pressureWarning90PercentBytes: 60397977, bytesToRelieveBelow90Percent: 6640935,
    pressureWarning90Active: true, potentialArchivableCertificationBytes: null, markerBasedCertificationBytes: 0,
    potentialDuplicateBlobBytes: 0, potentialColdDiagnosticBytes: 0, candidatesOverlapAndAreNotAdditive: true,
    candidateStatus: 'NOT_SAFE', recoveryThresholdStatus: 'CANDIDATE_80_PERCENT_NOT_AUTHORIZED_POLICY',
    archiveSemantics: 'Copying evidence to an archive does not reduce the active journal\'s accounted bytes.' },
  top5ByteContributors: [], sourceFilesTop20: [], sourceFileCount: 0,
  certificationSnapshotsOutsideBudget: [], duplicateRawCandidatesTop20: [],
  duplicateRawCandidateGroups: 0, duplicateCaveat: 'Hash candidates are not archive proof.',
  expectedNextSyncBytes: null, safeHeadroomForNextWrite: null,
}

const report: ConnectionDiagnosticReport = {
  schema: CONNECTION_DIAGNOSTIC_SCHEMA,
  build: { appVersion: '1.0.0-rc4.1-connection-diagnostic', versionCode: 37, variant: 'connection-diagnostic' },
  generatedAt: '2026-10-11T21:00:00.123Z',
  session: { authenticated: true, platform: 'android', appLifecycleAtStart: 'active', appLifecycleAtEnd: 'active' },
  options: { connect: true, scanWindowMs: 15000, readyTimeoutMs: 30000 },
  plugin: { reachable: true, error: null, available: true, bluetoothEnabled: true, initializedAt: '2026-10-11T20:59:00Z' },
  permissions: { normalizedBeforeRun: 'AUTHORIZED', normalizedAfterRun: 'AUTHORIZED', capacitorAlias: 'bluetoothNearby', capacitorAliasState: 'granted',
    android: {
      BLUETOOTH_SCAN: { name: 'SCAN', requiredOnThisSdk: true, declaredInManifest: true, granted: true },
      BLUETOOTH_CONNECT: { name: 'CONNECT', requiredOnThisSdk: true, declaredInManifest: true, granted: false },
      ACCESS_FINE_LOCATION: { name: 'LOCATION', requiredOnThisSdk: false, declaredInManifest: true, granted: false },
      BLUETOOTH: { name: 'BLUETOOTH', requiredOnThisSdk: false, declaredInManifest: true, granted: true },
      BLUETOOTH_ADMIN: { name: 'ADMIN', requiredOnThisSdk: false, declaredInManifest: true, granted: true },
    } },
  bluetoothAdapter: { sdkInt: 34, manufacturer: 'Test', model: 'Phone', bluetoothLeFeature: true, adapterSupported: true,
    bluetoothEnabled: true, adapterState: 'ON', leScannerAvailable: true, locationServicesEnabled: true, inspectionErrors: [] },
  productionPanel: {
    beforeRun: { mounted: true, statusTitle: 'Disconnected', statusMessage: null, scanActionLabel: null, permissionActionPresent: false,
      deviceListCount: 0, connectActionCount: 0, renderedDeviceIds: [] },
    afterScan: null,
    afterRun: { mounted: true, statusTitle: 'Disconnected', statusMessage: null, scanActionLabel: null, permissionActionPresent: false,
      deviceListCount: 0, connectActionCount: 0, renderedDeviceIds: [] },
  },
  scan: { path: 'PRODUCTION_UI', requested: true, startedAt: '2026-10-11T21:00:00Z', activeAtEnd: false, callbackRegistered: true,
    nativeCallbackRegistered: false, advertisementsReceived: 12, devicesDiscovered: 2, v8CandidatesDetected: 1, candidatesFiltered: 1, lastScanError: null },
  discoveredDevices: [],
  connection: { path: 'NOT_REQUESTED', deviceSelected: null, connectRequested: false, gattState: 'NOT_REQUESTED',
    servicesDiscovered: false, notificationsEnabled: false, deviceVersionRequested: false, readyReached: false,
    finalConnectionState: 'DISCONNECTED', lastError: null },
  referenceDevice: { ...REFERENCE_V8, observed: false, observedName: null, acceptedByNativeFilter: null, renderedInProductionList: null },
  events: [{ at: '2026-10-11T21:00:00Z', source: 'native', event: 'SCAN_STARTED', detail: { text: 'Full Unicode payload: \u00e9 ' + 'x'.repeat(200000) } }],
  errors: ['CONNECT permission missing'],
  preRunClassification: { primary: 'C_CONNECT_PERMISSION_MISSING', firstFailedStage: 'CONNECT_PERMISSION', summary: 'Permission missing', supportingEvents: [] },
  classification: { primary: 'C_CONNECT_PERMISSION_MISSING', firstFailedStage: 'CONNECT_PERMISSION', summary: 'Permission missing', supportingEvents: [] },
  fallbackClassification: null, firstFailedStage: 'CONNECT_PERMISSION', nativeTraceDroppedEvents: 0,
}

beforeEach(() => {
  vi.resetAllMocks()
  mocks.copyJson.mockResolvedValue(undefined)
  mocks.saveJson.mockResolvedValue(undefined)
  mocks.share.mockResolvedValue('file')
})

describe('Build 32B.7 capacity analysis', () => {
  it('renders exact accounting, bounded groups, fixed buckets and no recovery authority', () => {
    const before = JSON.stringify(capacity)
    const html = renderToStaticMarkup(<JournalCapacitySummary analysis={capacity} />)
    expect(html).toContain('<th scope="row">TOTAL ACCOUNTED BYTES</th><td data-label="TOTAL ACCOUNTED BYTES">67038912')
    expect(html).toContain('data-label="PER-ENVELOPE OVERHEAD BYTES">10746880')
    expect(html).toContain('data-label="RECONCILIATION DIFFERENCE">0')
    expect(html).toContain('data-label="RECONCILIATION STATUS">RECONCILED')
    expect(html).toContain('Showing 20 of 21; all in JSON')
    expect(html).not.toContain('vendor-20')
    for (const key of ['27', '68', '59', '24/25', '26/121', '42', '127', '29', '118/119', 'OTHER']) expect(html).toContain(`<th scope="row">${key}</th>`)
    for (const key of ['UNDER_24_HOURS', '1_TO_7_DAYS', '8_TO_30_DAYS', '31_TO_90_DAYS', 'OVER_90_DAYS']) expect(html).toContain(`<th scope="row">${key}</th>`)
    expect(html).toContain('Top 20 individual records')
    expect(html).toContain('data-label="TARGET_80_PERCENT_BYTES">53687091')
    expect(html).toContain('data-label="BYTES_TO_RELIEVE_FOR_80_PERCENT">13351821')
    expect(html).toContain('data-label="POTENTIAL_ARCHIVABLE_CERTIFICATION_BYTES">UNKNOWN')
    expect(html).toContain('Copying evidence to an archive does not reduce')
    expect(html).not.toContain('<button')
    expect(JSON.stringify(capacity)).toBe(before)
    const bad = renderToStaticMarkup(<JournalCapacitySummary analysis={{ ...capacity, accountingMatches: false, reconciliationStatus: 'NOT_RECONCILED', reconciliationReasons: ['ROW_BYTES_DIFFER'] }} />)
    expect(bad).toContain('Accounting does not reconcile')
    expect(bad).toContain('ROW_BYTES_DIFFER')
    expect(bad).toContain('data-label="RECONCILIATION STATUS">NOT_RECONCILED')
  })

  it('copies/saves every group and leaves failures explicit', async () => {
    const json = JSON.stringify(capacity, null, 2)
    await exportJournalCapacityAnalysis(capacity, 'copy')
    await exportJournalCapacityAnalysis(capacity, 'save')
    expect(mocks.copyJson).toHaveBeenCalledWith({ json })
    expect(mocks.saveJson).toHaveBeenCalledWith({
      json, filename: 'ElitePlus-V8-Journal-Capacity-2026-10-12T14-00-00-000Z.json',
    })
    expect(json).toContain('vendor-20')
    mocks.saveJson.mockRejectedValue(new Error('Save cancelled'))
    await expect(exportJournalCapacityAnalysis(capacity, 'save')).rejects.toThrow('Save cancelled')
  })

  it('runs capacity analysis only on demand, separate from the connection poller', () => {
    const source = readFileSync(new URL('./ConnectionDiagnosticPanel.tsx', import.meta.url), 'utf8')
    expect(source).toContain('Analyze Journal Capacity (read-only)')
    expect(source.match(/getJournalCapacityAnalysis\(/g)).toHaveLength(1)
    const poller = source.slice(source.indexOf('const poll ='), source.indexOf('void poll()'))
    expect(poller).not.toContain('getJournalCapacityAnalysis')
  })
})

describe('Build 32B.1-D.1 export fallback', () => {
  it('copies and saves the exact untruncated Share payload', async () => {
    const json = serializeConnectionDiagnostic(report)
    expect(await exportConnectionDiagnostic(report, 'copy')).toBe('Diagnostic JSON copied')
    expect(await exportConnectionDiagnostic(report, 'save')).toBe('Diagnostic JSON saved')
    await exportConnectionDiagnostic(report, 'share')
    expect(json.length).toBeGreaterThan(200000)
    expect(mocks.copyJson).toHaveBeenCalledWith({ json })
    expect(mocks.saveJson).toHaveBeenCalledWith({ json, filename: 'ElitePlus-V8-Connection-Diagnostic-2026-10-11T21-00-00-123Z.json' })
    expect(mocks.share.mock.calls[0][1]).toBe(json)
    expect(diagnosticSaveFilename(report.generatedAt)).not.toMatch(/[:/]/)
  })

  it('keeps all summary values visible and the report unchanged after all export methods fail', async () => {
    const before = serializeConnectionDiagnostic(report)
    const summary = renderToStaticMarkup(<ConnectionDiagnosticSummary report={report} />)
    mocks.copyJson.mockRejectedValue(new Error('Clipboard unavailable'))
    mocks.saveJson.mockRejectedValue(Object.assign(new Error('Save cancelled'), { code: 'DIAGNOSTIC_SAVE_CANCELLED' }))
    mocks.share.mockRejectedValue(new Error('Share unavailable'))
    for (const method of ['copy', 'save', 'share'] as const) await expect(exportConnectionDiagnostic(report, method)).rejects.toThrow()
    expect(serializeConnectionDiagnostic(report)).toBe(before)
    expect(renderToStaticMarkup(<ConnectionDiagnosticSummary report={report} />)).toBe(summary)
    for (const key of ['classification', 'firstFailedStage', 'bluetoothEnabled', 'scanPermission', 'connectPermission',
      'pluginInitialized', 'scanRequested', 'scanActive', 'advertisementCount', 'v8CandidateCount', 'connectRequested',
      'gattConnected', 'readyReached', 'lastError']) expect(summary).toContain(`<th scope="row">${key}</th>`)
    expect(summary).toContain('C_CONNECT_PERMISSION_MISSING')
    expect(summary).toContain('data-label="connectPermission">false')
    expect(summary).toContain('data-label="scanPermission">true')
    expect(summary).toContain('data-label="advertisementCount">12')
  })

  it('keeps legacy permission and unknown states explicit', () => {
    const legacy: ConnectionDiagnosticReport = { ...report, permissions: { ...report.permissions,
      android: report.permissions.android && { ...report.permissions.android,
        BLUETOOTH_SCAN: { ...report.permissions.android.BLUETOOTH_SCAN, requiredOnThisSdk: false },
        ACCESS_FINE_LOCATION: { ...report.permissions.android.ACCESS_FINE_LOCATION, requiredOnThisSdk: true },
      } }, bluetoothAdapter: null }
    const html = renderToStaticMarkup(<ConnectionDiagnosticSummary report={legacy} />)
    expect(html).toContain('data-label="scanPermission">false')
    expect(html).toContain('data-label="bluetoothEnabled">Unknown')
  })

  it('shows journal failure and transport gate values in the completed engineering summary', () => {
    const diagnosed: ConnectionDiagnosticReport = { ...report, journalHandshake: {
      journalState: 'JOURNAL_FAILED_CLOSED', journalAccountId: 'account-A', journalDeviceScopeId: 'opaque-device-A',
      journalOpenAttempted: true, journalOpenSucceeded: true, journalFailureCode: 'STORAGE_PRESSURE',
      journalFailureMessage: 'Failure: STORAGE_PRESSURE', journalFailedClosedAtStartup: true,
      failedClosed: true, priorFailureCode: null, priorFailureMessage: null, priorFailureTimestamp: null, recoveryAudit: null,
      journalLastOutcome: 'STORAGE_PRESSURE', journalRefusedCount: 1, journalEnvelopeCount: 123,
      journalInspectionFailureCode: null, journalInspectionFailureMessage: null,
      transportInitializationStarted: false, getDeviceVersionBlockedReason: 'JOURNAL_FAILED_CLOSED',
    } }
    const html = renderToStaticMarkup(<ConnectionDiagnosticSummary report={diagnosed} />)
    expect(html).toContain('data-label="journalFailureCode">STORAGE_PRESSURE')
    expect(html).toContain('data-label="journalFailureMessage">Failure: STORAGE_PRESSURE')
    expect(html).toContain('data-label="journalEnvelopeCount">123')
    expect(html).toContain('data-label="transportInitializationStarted">false')
    expect(html).toContain('data-label="journalDeviceScopeId">opaque-device-A')
    expect(html).toContain('data-label="getDeviceVersionBlockedReason">JOURNAL_FAILED_CLOSED')
  })

  it('wires three separate actions and a summary independent of export status', () => {
    const panel = readFileSync(new URL('./ConnectionDiagnosticPanel.tsx', import.meta.url), 'utf8')
    expect(panel).toContain('{report && <ConnectionDiagnosticSummary report={report} />}')
    for (const label of ['Copy Diagnostic JSON', 'Save Diagnostic JSON', 'Share Connection Diagnostic JSON']) expect(panel).toContain(label)
    for (const label of ['failedClosed', 'priorFailureCode', 'recoveryAudit', 'recoveredAt',
      'transportInitializationStarted', 'getDeviceVersionBlockedReason', 'globalJournalEnvelopeCount',
      'globalJournalAccountedBytes', 'journalMaxBytes', 'READY reached']) expect(panel).toContain(`['${label}'`)
    expect(panel).not.toContain('setReport(null)')
  })

  it('exports global pressure totals and thresholds without treating unavailable metrics as zero', async () => {
    const pressure = {
      globalEnvelopeCount: 10495, globalAccountedBytes: 67108000,
      maxEnvelopes: 100000, maxBytes: 67108864, envelopeHeadroom: 89505, byteHeadroom: 864,
      budgetAtOrOverLimit: false, limitsScope: 'GLOBAL_DATABASE_ALL_OWNERS', metricSource: 'journal_totals',
      triggerRule: 'globalEnvelopeCount + pendingEnvelopeCount > maxEnvelopes OR globalAccountedBytes + pendingBytes > maxBytes',
      pendingEnvelopeCountAtFailure: null, pendingBytesAtFailure: null,
      inspectionErrorCode: null, inspectionErrorMessage: null,
    }
    const diagnosed: ConnectionDiagnosticReport = { ...report, journalHandshake: {
      journalState: 'JOURNAL_READY', journalAccountId: 'account-A', journalDeviceScopeId: 'opaque-device-A',
      journalOpenAttempted: true, journalOpenSucceeded: true, journalFailureCode: null,
      journalFailureMessage: null, journalFailedClosedAtStartup: true,
      failedClosed: false, priorFailureCode: 'STORAGE_PRESSURE', priorFailureMessage: 'STORAGE_PRESSURE',
      priorFailureTimestamp: '2026-10-13T14:30:00.000Z',
      recoveryAudit: { recoveryType: 'STORAGE_PRESSURE_BUDGET_RECOVERY', recoveredAt: '2026-10-13T14:35:00.000Z' },
      recoveryAuditHistory: [
        { priorMaxBytes: 67108864, newMaxBytes: 134217728 },
        { priorMaxBytes: 134217728, newMaxBytes: 268435456 },
      ],
      latestRecoveryAudit: { priorMaxBytes: 134217728, newMaxBytes: 268435456 },
      type27Ingress: {
        unsolicitedType27Count: 5000, firstUnsolicitedAt: '2026-10-14T19:00:00Z',
        lastUnsolicitedAt: '2026-10-14T19:01:00Z', reason: 'NO_EXPLICIT_HR_REQUEST',
        connectionGeneration: 3, lastUnsolicitedConnectionGeneration: 3,
      },
      journalLastOutcome: 'STORAGE_PRESSURE', journalRefusedCount: 1, journalEnvelopeCount: 10495,
      journalInspectionFailureCode: null, journalInspectionFailureMessage: null,
      transportInitializationStarted: false, getDeviceVersionBlockedReason: 'JOURNAL_FAILED_CLOSED',
      journalPressure: pressure,
    } }
    await exportConnectionDiagnostic(diagnosed, 'copy')
    expect(JSON.parse(mocks.copyJson.mock.calls[0][0].json).journalHandshake.journalPressure).toEqual(pressure)
    const html = renderToStaticMarkup(<ConnectionDiagnosticSummary report={diagnosed} />)
    expect(html).toContain('data-label="globalJournalAccountedBytes">67108000')
    expect(html).toContain('data-label="journalMaxBytes">67108864')
    expect(html).toContain('data-label="failedClosed">false')
    expect(html).toContain('data-label="priorFailureCode">STORAGE_PRESSURE')
    expect(html).toContain('data-label="recoveryAudit">{&quot;recoveryType&quot;:&quot;STORAGE_PRESSURE_BUDGET_RECOVERY&quot;,&quot;recoveredAt&quot;:&quot;2026-10-13T14:35:00.000Z&quot;}')
    expect(html).toContain('data-label="journalByteHeadroom">864')
    expect(html).toContain('data-label="journalBudgetAtOrOverLimit">false')
    expect(html).toContain('data-label="recoveryAuditHistory">')
    expect(html).toContain('data-label="latestRecoveryAudit">')
    expect(html).toContain('data-label="type27Ingress">')
    const exported = JSON.parse(mocks.copyJson.mock.calls[0][0].json).journalHandshake
    expect(exported.recoveryAuditHistory).toEqual(diagnosed.journalHandshake!.recoveryAuditHistory)
    expect(exported.latestRecoveryAudit).toEqual(diagnosed.journalHandshake!.latestRecoveryAudit)
    expect(exported.type27Ingress.unsolicitedType27Count).toBe(5000)
    diagnosed.journalHandshake!.journalPressure = { ...pressure, globalAccountedBytes: null,
      byteHeadroom: null, budgetAtOrOverLimit: null, inspectionErrorCode: 'SQLiteException',
      inspectionErrorMessage: 'Unable to read totals' }
    const unavailable = renderToStaticMarkup(<ConnectionDiagnosticSummary report={diagnosed} />)
    expect(unavailable).toContain('data-label="globalJournalAccountedBytes">Unknown')
    expect(unavailable).toContain('data-label="journalBudgetAtOrOverLimit">Unknown')
    expect(unavailable).toContain('Unable to read totals')
  })

  it.each([
    [100001, 67108863, 'ENVELOPE_LIMIT', true, false],
    [99999, 67108865, 'BYTE_LIMIT', false, true],
    [100001, 67108865, 'BOTH', true, true],
    [100000, 67108864, 'UNKNOWN', false, false],
    [10495, 1000000, 'UNKNOWN', false, false],
  ] as const)('shows exact pressure thresholds for %s envelopes / %s bytes', (envelopes, bytes, trigger, envelopeOver, byteOver) => {
    const html = renderToStaticMarkup(<JournalStoragePressure journal={{
      journalState: 'JOURNAL_FAILED_CLOSED', journalAccountId: 'account-A', journalDeviceScopeId: 'device-A',
      journalOpenAttempted: true, journalOpenSucceeded: true, journalFailureCode: 'STORAGE_PRESSURE',
      journalFailureMessage: 'STORAGE_PRESSURE', journalFailedClosedAtStartup: true,
      failedClosed: true, priorFailureCode: null, priorFailureMessage: null, priorFailureTimestamp: null, recoveryAudit: null,
      journalLastOutcome: 'STORAGE_PRESSURE', journalRefusedCount: 1, journalEnvelopeCount: 10495,
      journalInspectionFailureCode: null, journalInspectionFailureMessage: null,
      transportInitializationStarted: false, getDeviceVersionBlockedReason: 'JOURNAL_FAILED_CLOSED',
      journalPressure: {
        globalEnvelopeCount: envelopes, globalAccountedBytes: bytes, maxEnvelopes: 100000, maxBytes: 67108864,
        envelopeHeadroom: 100000 - envelopes, byteHeadroom: 67108864 - bytes,
        budgetAtOrOverLimit: envelopes >= 100000 || bytes >= 67108864,
        limitsScope: 'GLOBAL_DATABASE_ALL_OWNERS', metricSource: 'journal_totals', triggerRule: 'pending write exceeds limit',
        pendingEnvelopeCountAtFailure: null, pendingBytesAtFailure: null,
        inspectionErrorCode: null, inspectionErrorMessage: null,
        largestRecentEnvelopeBytes: 4096, maxEntryBytes: 1048576, reservedSourceFileBytes: 1234,
        safeHeadroomForNextWrite: null,
      },
    }} />)
    expect(html).toContain('Journal Storage Pressure')
    expect(html).toContain(`data-label="STORAGE_PRESSURE_TRIGGER">${trigger}`)
    expect(html).toContain(`data-label="CURRENTLY_OVER_ENVELOPE_LIMIT">${envelopeOver}`)
    expect(html).toContain(`data-label="CURRENTLY_OVER_BYTE_LIMIT">${byteOver}`)
    expect(html).toContain(`data-label="envelopeUtilizationPercent">${(envelopes / 100000 * 100).toFixed(2)}%`)
    expect(html).toContain('data-label="safeHeadroomForNextWrite">UNKNOWN')
    expect(html).toContain('data-label="largestRecentEnvelopeBytes">4096')
    expect(html).toContain('data-label="maxEntryBytes">1048576')
    expect(html).toContain('data-label="reservedSourceFileBytes">1234')
    expect(html).toContain('data-label="failedClosed">true')
  })

  it('shows UNKNOWN pressure and safety values before journal inspection', () => {
    const html = renderToStaticMarkup(<JournalStoragePressure journal={null} />)
    for (const key of ['globalEnvelopeCount', 'globalAccountedBytes', 'pressureCurrentlyActive',
      'safeHeadroomForNextWrite', 'largestRecentEnvelopeBytes', 'CURRENTLY_OVER_BYTE_LIMIT']) {
      expect(html).toContain(`data-label="${key}">UNKNOWN`)
    }
  })
})
