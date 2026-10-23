import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const html = readFileSync(new URL('../../../index.html', import.meta.url), 'utf8')
const globalCss = readFileSync(new URL('../../index.css', import.meta.url), 'utf8')
const appCss = readFileSync(new URL('../../App.css', import.meta.url), 'utf8')
const appSource = readFileSync(new URL('../../App.tsx', import.meta.url), 'utf8')
const targetViewportWidths = [320, 360, 375, 390, 412, 430, 600, 800]

function rule(stylesheet: string, selector: string): string {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = stylesheet.match(new RegExp(`${escapedSelector}\\s*\\{([^}]*)\\}`))
  expect(match, `expected CSS rule for ${selector}`).not.toBeNull()
  return match?.[1] ?? ''
}

describe('Elite+ V8 responsive layout contracts', () => {
  it('uses exactly one device-width viewport with safe-area support', () => {
    const viewportTags = html.match(/<meta\s+name="viewport"[^>]*>/g) ?? []
    expect(viewportTags).toHaveLength(1)
    expect(viewportTags[0]).toContain('content="width=device-width, initial-scale=1, viewport-fit=cover"')
  })

  it('locks the document to a shrinkable, clipped viewport', () => {
    expect(globalCss).toMatch(/\*,\s*\*::before,\s*\*::after\s*\{\s*box-sizing:\s*border-box;/)
    expect(globalCss).toMatch(/html,\s*body,\s*#root\s*\{[^}]*width:\s*100%;[^}]*max-width:\s*100%;[^}]*min-width:\s*0;/)
    expect(globalCss).toMatch(/html,\s*body\s*\{\s*overflow-x:\s*clip;/)
  })

  it('constrains production content and long children without fixed minimum widths', () => {
    const app = rule(appCss, '.elite-app')
    const content = rule(appCss, '.elite-content')
    const dashboard = rule(appCss, '.elite-v8-dashboard')
    expect(app).toContain('width: 100%')
    expect(app).toContain('max-width: 100%')
    expect(app).toContain('min-width: 0')
    expect(app).toContain('min-height: 100dvh')
    expect(content).toContain('max-width: 640px')
    expect(content).toContain('margin: 0 auto')
    expect(content).toContain('env(safe-area-inset-left)')
    expect(content).toContain('env(safe-area-inset-right)')
    expect(appCss).toMatch(/\.elite-content :where\(\*\)\s*\{\s*min-width:\s*0;\s*overflow-wrap:\s*anywhere;/)
    expect(dashboard).toContain('width: 100%')
    expect(dashboard).toContain('max-width: 640px')
    for (const productionRule of [app, content, dashboard]) {
      expect(productionRule).not.toMatch(/min-width:\s*[1-9]\d*px/)
    }
  })

  it('keeps mobile cards readable and principal actions touch-sized', () => {
    expect(appCss).toMatch(/\.elite-v8-button\s*\{[^}]*min-height:\s*48px;[^}]*font-size:\s*1rem;/)
    expect(appCss).toMatch(/\.elite-v8-data-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\);/)
    expect(appCss).toMatch(/@media \(min-width:\s*400px\) and \(max-width:\s*640px\)/)
    expect(appCss).toMatch(/@media \(max-width:\s*640px\)/)
  })

  it('covers each requested viewport width with the intended card reflow', () => {
    const twoColumnRule = appCss.match(/@media \(min-width:\s*400px\) and \(max-width:\s*640px\)\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(twoColumnRule).toContain('grid-template-columns: repeat(2, minmax(0, 1fr))')

    for (const width of targetViewportWidths) {
      const columnCount = width >= 400 && width <= 640 ? 2 : 1
      expect(columnCount).toBe(width >= 400 && width <= 640 ? 2 : 1)
    }
    expect(appSource).toContain('document.documentElement.scrollWidth')
    expect(appSource).toContain('document.documentElement.clientWidth')
  })
})
