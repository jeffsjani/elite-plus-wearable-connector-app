import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Type42CertificationView } from './Type42CertificationView'

const props = {
  busy: false, captureDisabledReason: null, journalScopeAvailable: true,
  status: '', evidence: null, exportLocation: null,
  onCapture: () => undefined, onInspect: () => undefined, onExport: () => undefined,
}

describe('official type-42 certification controls', () => {
  it('exposes the exact grouped action and source-only inspection/export labels', () => {
    const html = renderToStaticMarkup(<Type42CertificationView {...props} />)
    expect(html).toContain('Capture + Queue + Targeted Deliver Type 42')
    expect(html).toContain('Inspect Saved Type-42 Certification')
    expect(html).toContain('Export Type-42 Certification JSON')
    expect(html).not.toContain('Certify HRV + Deliver')
    expect(html).toContain('No fatigueDegree expected')
  })

  it('allows saved inspection while capture is unavailable after restart', () => {
    const html = renderToStaticMarkup(<Type42CertificationView {...props} captureDisabledReason="V8 not READY" />)
    expect(html).toMatch(/disabled=""[^>]*>Capture \+ Queue \+ Targeted Deliver Type 42/)
    expect(html).toContain('<button type="button">Inspect Saved Type-42 Certification</button>')
    expect(html).toContain('<button type="button">Export Type-42 Certification JSON</button>')
  })

  it('gates every action without owner journal scope or while busy', () => {
    const html = renderToStaticMarkup(<Type42CertificationView {...props} busy journalScopeAvailable={false} />)
    expect(html.match(/disabled=""/g)).toHaveLength(3)
  })

  it('shows exact success and persisted evidence without inventing a canonical pass', () => {
    const status = '1 type-42 record preserved · 4/4 native-only observations delivered'
    const html = renderToStaticMarkup(<Type42CertificationView {...props} status={status} evidence='{"sourceEnvelopeId":"saved"}' />)
    expect(html).toContain(status)
    expect(html).toContain('Saved type-42 source group and exact receipts')
    expect(html).not.toContain('canonicalized')
  })
})
