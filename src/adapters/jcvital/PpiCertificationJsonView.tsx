import { useRef } from 'react'
import type { PpiCertificationJson } from './PpiCertificationJson'

export function PpiCertificationJsonView({ evidence, label = 'Full PPI Certification JSON' }: {
  evidence: PpiCertificationJson | null
  label?: string
}) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  if (!evidence) return null
  return <section aria-label="PPI certification JSON evidence">
    <p>Character count: {evidence.characterCount} · SHA-256: <code>{evidence.sha256}</code></p>
    <button type="button" onClick={() => {
      textarea.current?.focus()
      textarea.current?.select()
    }}>Select All</button>
    <textarea ref={textarea} aria-label={label} readOnly value={evidence.json}
      spellCheck={false} wrap="off" rows={24}
      style={{ width: '100%', minHeight: '24rem', overflow: 'auto', fontFamily: 'monospace' }} />
  </section>
}
