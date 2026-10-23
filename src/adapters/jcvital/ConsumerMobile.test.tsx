import { readFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ElitePlusV8Dashboard, type ElitePlusV8DashboardProps } from './ElitePlusV8Dashboard'

vi.mock('../../buildMode', () => ({ IS_ENGINEERING_BUILD: false, IS_CONNECTION_DIAGNOSTIC_BUILD: false }))

const css = ['../../index.css', '../../App.css']
  .map((path) => readFileSync(new URL(path, import.meta.url), 'utf8')).join('\n')
const noop = () => undefined
const props: ElitePlusV8DashboardProps = {
  state: 'READY', pluginAvailable: true, pluginStartupState: 'READY', devices: [],
  permission: { status: 'AUTHORIZED', bluetoothEnabled: true, permissions: [] },
  info: null, battery: { deviceId: 'local', level: 78, charging: false, chargingStateRaw: 0,
    voltageRaw: 0, vendorDataType: 'battery', receiptTimestamp: '2026-10-16T12:00:00Z' },
  lastConnectedAt: '2026-10-16T12:00:00Z', queueStats: null, busy: false, syncBusy: false,
  syncError: '', syncEnabled: true, appVersion: 'candidate',
  onRequestPermission: noop, onStartScan: noop, onConnect: noop, onDisconnect: noop, onSync: noop,
  // Even hostile callers cannot activate Engineering UI in a consumer build.
  engineeringBuild: true, receiptAvailable: true, receiptViewOpen: true,
}
const states: Array<[string, Partial<ElitePlusV8DashboardProps>, string]> = [
  ['connected', {}, 'Connected'],
  ['disconnected', { state: 'DISCONNECTED' }, 'Disconnected'],
  ['connecting', { state: 'CONNECTING', busy: true }, 'Connecting'],
  ['syncing', { syncBusy: true, syncStage: 'READING_BLOOD_OXYGEN', syncMetrics: ['oxygenSaturation'] }, 'Reading Blood Oxygen from V8'],
  ['saved', { syncSummary: { outcome: 'PENDING_DELIVERY', newCount: 3, errorCode: null, completedAt: null } }, 'saved on this phone'],
  ['sending', { queueStats: { pending: 3, retrying: 0, inFlight: 1, acknowledged: 0, failed: 0,
    oldestPendingAgeMs: 0, lastAttemptAt: null, lastSuccessfulUploadAt: null, warnings: [] } }, 'Sending saved data'],
  ['synced', { syncSummary: { outcome: 'UP_TO_DATE', newCount: 3, errorCode: null, completedAt: '2026-10-16T12:00:00Z',
    metrics: [{ metric: 'heartRate', status: 'SUCCESS' }] } }, 'Synced'],
  ['no data', { syncSummary: { outcome: 'UP_TO_DATE', newCount: 0, errorCode: null, completedAt: null,
    metrics: [{ metric: 'oxygenSaturation', status: 'NO_DATA' }] } }, 'No new data'],
  ['failed', { syncSummary: { outcome: 'FAILED', newCount: 0, errorCode: 'DISCONNECTED', completedAt: null,
    metrics: [{ metric: 'wearableTemperature', status: 'FAILED' }] } }, 'Could not sync'],
]
let browser: Browser

beforeAll(async () => { browser = await chromium.launch({ headless: true }) })
afterAll(async () => { await browser?.close() })

describe.each([360, 375, 390, 430, 800])('consumer mobile layout at %ipx (real Chromium)', (width) => {
  it.each(states)('%s fits without clipped text or overlapping controls', async (_name, overrides, copy) => {
    const page = await browser.newPage({ viewport: { width, height: 1000 } })
    try {
      await page.route('**/*', (route) => route.abort())
      await page.setContent(`<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
        <div id="root"><main class="shell elite-app"><div class="elite-content">${
          renderToStaticMarkup(<ElitePlusV8Dashboard {...props} {...overrides} />)
        }</div></main></div>`)
      await page.addStyleTag({ content: css })
      const text = await page.locator('body').innerText()
      expect(text).toContain(copy)
      expect(text).not.toMatch(/Type27|Type68|Type59|Source Journal|JCVITAL_NATIVE|sync_id|acquisition_id|canonicalization|certification|PPG|ECG|Delivery Diagnostics|Queue Composition|View Receipt|Last Acquisition Detail|Test SpO₂/i)
      const layout = await page.evaluate(() => {
        const controls = [...document.querySelectorAll('button, input')].map((element) => {
          const rect = element.getBoundingClientRect()
          return { text: element.textContent, x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
            width: rect.width, height: rect.height }
        })
        const clippedText: string[] = []
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
        while (walker.nextNode()) {
          const node = walker.currentNode
          if (!node.textContent?.trim() || node.parentElement?.closest('style, [aria-hidden="true"]')) continue
          const range = document.createRange()
          range.selectNodeContents(node)
          for (const rect of range.getClientRects()) {
            if (rect.width > 0 && (rect.left < -1 || rect.right > innerWidth + 1)) clippedText.push(node.textContent)
          }
        }
        return { scrollWidth: document.documentElement.scrollWidth, viewport: innerWidth, controls, clippedText }
      })
      expect(layout.scrollWidth).toBeLessThanOrEqual(width)
      expect(layout.clippedText).toEqual([])
      for (const control of layout.controls) {
        expect(control.height, control.text ?? '').toBeGreaterThanOrEqual(48)
        expect(control.width).toBeGreaterThanOrEqual(48)
        expect(control.x).toBeGreaterThanOrEqual(0)
        expect(control.right).toBeLessThanOrEqual(width)
      }
      for (let i = 0; i < layout.controls.length; i++) {
        for (const other of layout.controls.slice(i + 1)) {
          const control = layout.controls[i]
          const overlaps = Math.min(control.right, other.right) - Math.max(control.x, other.x) > 1
            && Math.min(control.bottom, other.bottom) - Math.max(control.y, other.y) > 1
          expect(overlaps, `${control.text} overlaps ${other.text}`).toBe(false)
        }
      }
      if (overrides.syncMetrics) {
        const progress = await page.locator('[aria-label="Sync progress"]').innerText()
        expect(progress).not.toMatch(/Heart Rate|Temperature/)
      }
      if (_name === 'sending') expect(await page.getByRole('button', { name: 'Sync Device Data' }).isEnabled()).toBe(true)
    } finally {
      await page.close()
    }
  })
})
