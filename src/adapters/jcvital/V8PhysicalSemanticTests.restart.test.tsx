// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { persistPhysicalTestResult, V8PhysicalSemanticTests } from './V8PhysicalSemanticTests'

const share = vi.hoisted(() => vi.fn(async (_filename: string, _json: string) => 'saved result.json'))
vi.mock('./CertificationJsonExport', () => ({
  serializeCertificationJson: (value: unknown) => JSON.stringify(value, null, 2),
  saveValidationJson: share,
}))

afterEach(() => { localStorage.clear(); vi.unstubAllGlobals() })

describe('physical test restart UX without a connected device', () => {
  it('restores both results after remount, supports Show/Copy/Save, and does not expose another owner', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
    const copy = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } })
    const scope = { accountId: 'owner', deviceScopeId: 'device' }
    localStorage.setItem('v8PhysicalSemanticTest.scope.v1:owner', JSON.stringify(scope))
    const activity = {
      kind: 'ACTIVITY_24_25_SEMANTIC_TEST', version: 1, capturedAt: '2026-10-18T10:00:00Z',
      commands: { type24: true, type25: true }, sameLocalDay: '2026-10-18',
      type24: null, type25: {}, reconciliation: {}, classifications: {},
      isolation: { queueWrites: 0, base44Writes: 0, passed: true },
    }
    const workout = {
      kind: 'WORKOUT_29_82_LINKAGE_TEST', version: 1, capturedAt: '2026-10-18T10:01:00Z',
      type82: {}, type29: {}, linkageEvidence: {}, result: 'LINKAGE_NOT_PROVEN',
      isolation: { queueWrites: 0, base44Writes: 0, passed: true },
    }
    persistPhysicalTestResult('activity', scope, activity)
    persistPhysicalTestResult('workout', scope, workout)
    const container = document.createElement('div')
    document.body.append(container)
    let root = createRoot(container)
    const render = async (ownerUserId = 'owner') => {
      await act(async () => root.render(<V8PhysicalSemanticTests
        context={null} ownerUserId={ownerUserId} setBusy={() => undefined}
        eligibility={{ ready: false, authenticatedOwner: ownerUserId, connectorOwner: ownerUserId,
          journalScope: null, sourceJournalBound: false, connectionBusy: false, productionSyncActive: false,
          physicalTestActive: false, workoutControlAvailable: true }}
        workoutActive={false} onTestActiveChange={() => undefined}
      />))
    }
    try {
      await render()
      await act(async () => root.unmount())
      root = createRoot(container)
      await render()
      for (const [kind, title, expected] of [
        ['activity', 'ACTIVITY 24/25 SEMANTIC TEST', activity],
        ['workout', 'WORKOUT 29/82 LINKAGE TEST', workout],
      ] as const) {
        const section = container.querySelector(`section[aria-label="Test ${kind === 'activity' ? 'Activity 24 + 25' : 'Workout 29 + 82'}"]`)!
        const buttons = Array.from(section.querySelectorAll('button'))
        expect(buttons.map((button) => button.textContent)).toEqual(['Run', 'Show Result', 'Copy Result JSON', 'Save Result JSON'])
        expect(buttons[0].disabled).toBe(true)
        await act(async () => buttons[1].click())
        expect(container.textContent).toContain(title)
        await act(async () => buttons[2].click())
        expect(JSON.parse(copy.mock.calls.at(-1)![0] as string)).toEqual(expected)
        await act(async () => buttons[3].click())
        expect(JSON.parse(share.mock.calls.at(-1)![1] as string)).toEqual(expected)
      }
      await render('different-owner')
      expect(container.textContent).not.toContain('2026-10-18T10:00:00Z')
      const showButtons = Array.from(container.querySelectorAll('button')).filter((button) => button.textContent === 'Show Result')
      expect(showButtons.every((button) => button.disabled)).toBe(true)
    } finally {
      await act(async () => root.unmount())
      container.remove()
    }
  })
})
