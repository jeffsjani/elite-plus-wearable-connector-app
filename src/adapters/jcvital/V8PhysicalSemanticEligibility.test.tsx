// @vitest-environment jsdom
import { act } from 'react'
import { IDBFactory } from 'fake-indexeddb'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { markPhysicalTestAttempt, V8PhysicalSemanticTests, type PhysicalSemanticEligibility } from './V8PhysicalSemanticTests'
import type { Type42ConnectedContext } from './Type42Certification'
import { newPhysicalResult } from './PhysicalSemanticEvidence'

const scope = { accountId: 'authenticated-owner-123456', deviceScopeId: 'jcvital_device_123456' }
const ready: PhysicalSemanticEligibility = {
  ready: true, authenticatedOwner: scope.accountId, connectorOwner: scope.accountId,
  journalScope: scope, sourceJournalBound: true, connectionBusy: false,
  productionSyncActive: false, physicalTestActive: false, workoutControlAvailable: true,
}
const connected: Type42ConnectedContext = {
  scope, bleAddress: 'AA:BB:CC:DD:EE:FF', firmwareVersion: 'test',
  sdkVersion: 'test', ready: true, physical: true, native: true,
}
let root: Root
let container: HTMLDivElement
const activeChanged = vi.fn()
const setBusy = vi.fn()

beforeEach(() => {
  vi.stubGlobal('indexedDB', new IDBFactory())
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  localStorage.clear()
  activeChanged.mockClear()
  setBusy.mockClear()
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
})

async function render(changes: Partial<PhysicalSemanticEligibility> = {}, context: Type42ConnectedContext | null = connected) {
  await act(async () => root.render(<V8PhysicalSemanticTests
    context={context} ownerUserId={scope.accountId} eligibility={{ ...ready, ...changes }}
    setBusy={setBusy} workoutActive={false} onTestActiveChange={activeChanged}
  />))
}
function runButton(kind: 'Activity 24 + 25' | 'Workout 29 + 82') {
  return container.querySelector<HTMLButtonElement>(`section[aria-label="Test ${kind}"] button`)!
}
function eligibilityText() {
  return container.querySelector('section[aria-label="Physical Semantic Test Eligibility"]')!.textContent!
}

describe('rendered physical semantic eligibility panel', () => {
  it.each([
    [{ ready: false }, 'V8_NOT_READY'],
    [{ authenticatedOwner: null }, 'AUTHENTICATED_OWNER_REQUIRED'],
    [{ connectorOwner: 'other-owner' }, 'OWNER_SCOPE_MISMATCH'],
    [{ connectorOwner: null }, 'OWNER_SCOPE_NOT_RESOLVED'],
    [{ sourceJournalBound: false }, 'SOURCE_JOURNAL_NOT_BOUND'],
    [{ journalScope: { ...scope, deviceScopeId: '' } }, 'DEVICE_SCOPE_NOT_RESOLVED'],
  ] satisfies Array<[Partial<PhysicalSemanticEligibility>, string]>)('a safe saved retry does not bypass prerequisite %s', async (changes, reason) => {
    const prior = newPhysicalResult('activity', {
      v8_state: 'READY', authenticated_owner_resolved: true, owner_scope_resolved: true,
      journal_bound: true, device_scope_resolved: true,
    })
    prior.status = 'FAILED'
    prior.retry_disposition = 'SAFE_TO_RETRY_NO_DEVICE_COMMAND'
    localStorage.setItem(`v8PhysicalSemanticTest.v1:activity:${scope.accountId}:${scope.deviceScopeId}`, JSON.stringify(prior))
    await render(changes)
    expect(runButton('Activity 24 + 25').disabled).toBe(true)
    expect(eligibilityText()).toContain(reason)
  })

  it('enables Activity but blocks Workout until saved Activity finalization and export; mounting starts nothing', async () => {
    await render()
    expect(runButton('Activity 24 + 25').disabled).toBe(false)
    expect(runButton('Workout 29 + 82').disabled).toBe(true)
    expect(eligibilityText()).toContain('Activity test: ENABLED')
    expect(eligibilityText()).toContain('Workout test: BLOCKED — SAVED_ACTIVITY_FINALIZATION_AND_EXPORT_REQUIRED')
    expect(container.querySelector('[aria-label="Physical Semantic Test Eligibility"]')!.nextElementSibling)
      .toBe(container.querySelector('[aria-label="Test Activity 24 + 25"]'))
    expect(setBusy).not.toHaveBeenCalled()
    expect(activeChanged).not.toHaveBeenCalled()
  })

  it.each([
    [{ sourceJournalBound: false }, 'SOURCE_JOURNAL_NOT_BOUND'],
    [{ authenticatedOwner: null }, 'AUTHENTICATED_OWNER_REQUIRED'],
    [{ connectorOwner: 'different-owner-654321' }, 'OWNER_SCOPE_MISMATCH'],
    [{ connectionBusy: true }, 'CONNECTION_BUSY'],
    [{ ready: false }, 'V8_NOT_READY'],
    [{ connectorOwner: null }, 'OWNER_SCOPE_NOT_RESOLVED'],
    [{ journalScope: { ...scope, deviceScopeId: '' } }, 'DEVICE_SCOPE_NOT_RESOLVED'],
    [{ physicalTestActive: true }, 'PHYSICAL_TEST_ACTIVE'],
  ] satisfies Array<[Partial<PhysicalSemanticEligibility>, string]>)('fails closed for %j and exposes %s once per test', async (changes, reason) => {
    await render(changes)
    expect(runButton('Activity 24 + 25').disabled).toBe(true)
    expect(runButton('Workout 29 + 82').disabled).toBe(true)
    const statuses = container.querySelectorAll('[aria-label="Physical Semantic Test Eligibility"] [role="status"]')
    for (const status of statuses) {
      expect(status.textContent).toContain(`BLOCKED — ${reason}`)
      expect(status.textContent!.split(reason)).toHaveLength(2)
    }
  })

  it('reports all failed prerequisites, not only a priority-selected reason', async () => {
    await render({ authenticatedOwner: null, sourceJournalBound: false, connectionBusy: true })
    expect(eligibilityText()).toContain('AUTHENTICATED_OWNER_REQUIRED, SOURCE_JOURNAL_NOT_BOUND, CONNECTION_BUSY')
  })

  it('exposes workout capability separately without blocking Activity', async () => {
    await render({ workoutControlAvailable: false })
    expect(runButton('Activity 24 + 25').disabled).toBe(false)
    expect(runButton('Workout 29 + 82').disabled).toBe(true)
    expect(eligibilityText()).toContain('Workout test: BLOCKED — WORKOUT_CONTROL_UNAVAILABLE')
  })

  it('reports production sync as diagnostic state, not an eligibility gate; manual entry still refuses acquisition overlap', async () => {
    await render({ productionSyncActive: true })
    expect(runButton('Activity 24 + 25').disabled).toBe(false)
    expect(runButton('Workout 29 + 82').disabled).toBe(true)
    expect(eligibilityText()).toContain('production sync activeYES')
    await act(async () => runButton('Activity 24 + 25').click())
    expect(container.textContent).toContain('BLOCKED — PRODUCTION_SYNC_ACTIVE')
    expect(setBusy).not.toHaveBeenCalled()
    expect(activeChanged).not.toHaveBeenCalled()
  })

  it('rejects a physical context owned by another account without disclosing full owner IDs', async () => {
    await render({}, { ...connected, scope: { ...scope, accountId: 'other-owner-654321' } })
    expect(runButton('Activity 24 + 25').disabled).toBe(true)
    expect(eligibilityText()).toContain('OWNER_SCOPE_MISMATCH')
    expect(eligibilityText()).toContain('aut...456')
    expect(eligibilityText()).not.toContain(scope.accountId)
    expect(eligibilityText()).not.toContain('other-owner-654321')
  })

  it('preserves the one-shot acquisition guard and explains it', async () => {
    markPhysicalTestAttempt('activity', scope)
    await render()
    expect(runButton('Activity 24 + 25').disabled).toBe(true)
    expect(eligibilityText()).toContain('Activity test: BLOCKED — ACTIVITY_SCOPE_ALREADY_ATTEMPTED')
    expect(runButton('Workout 29 + 82').disabled).toBe(true)
  })
})
