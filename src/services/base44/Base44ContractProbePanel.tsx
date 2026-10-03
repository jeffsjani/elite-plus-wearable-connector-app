import { useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { getBackendEnvironmentDiagnostics } from './base44Environment'
import { runBase44ContractProbe, type Base44ContractProbeResult } from './Base44ContractProbe'

interface Base44ContractProbePanelProps {
  installId: string
  connectorDeviceId: string | null
}

export function Base44ContractProbePanel({ installId, connectorDeviceId }: Base44ContractProbePanelProps) {
  const [running, setRunning] = useState(false)
  const [exporting, setExporting] = useState(false)
  const [result, setResult] = useState<Base44ContractProbeResult | null>(null)
  const environment = getBackendEnvironmentDiagnostics()

  async function runProbe(): Promise<void> {
    if (!connectorDeviceId || !environment.environmentMatch) return
    setRunning(true)
    setResult(null)
    try {
      setResult(await runBase44ContractProbe(installId, connectorDeviceId))
    } catch {
      setResult(null)
    } finally {
      setRunning(false)
    }
  }

  async function exportProbe(): Promise<void> {
    if (!result) return
    setExporting(true)
    try {
      const filename = `base44-contract-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      const json = JSON.stringify(result, null, 2)
      if (Capacitor.isNativePlatform()) {
        const saved = await Filesystem.writeFile({ path: filename, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 })
        await Share.share({ title: 'Base44 Contract Probe', text: filename, files: [saved.uri], dialogTitle: 'Save or share Base44 probe diagnostics' })
      } else {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.click()
        URL.revokeObjectURL(url)
      }
    } finally {
      setExporting(false)
    }
  }

  return (
    <section className="diagnostics" aria-label="Base44 contract probe">
      <h2>Base44 Contract Probe</h2>
      <p>One authenticated, out-of-range heartRate observation. No V8 connection or queue delivery.</p>
      <div className="actions">
        <button type="button" disabled={running || exporting || !connectorDeviceId || !environment.environmentMatch} onClick={() => void runProbe()}>
          {running ? 'Running Probe...' : 'Base44 Contract Probe'}
        </button>
        {result && <button type="button" className="secondary" disabled={running || exporting} onClick={() => void exportProbe()}>
          {exporting ? 'Preparing JSON...' : 'Export Probe JSON'}
        </button>}
      </div>
      {!connectorDeviceId && <p role="status">Connector registration is required; a V8 connection is not.</p>}
      {!environment.environmentMatch && <p className="error-message" role="alert"><strong>BACKEND ENVIRONMENT MISMATCH · PROBE BLOCKED</strong></p>}
      {!result && <p>Contract probe required before any physical HR certification.</p>}
      {result && <>
        <p role={result.passed ? 'status' : 'alert'}><strong>{result.passed ? 'PROBE PASSED' : 'STOP PHYSICAL CERTIFICATION'}</strong>{result.failures.length > 0 ? ` · ${result.failures.join('; ')}` : ''}</p>
        <pre>{JSON.stringify(result, null, 2)}</pre>
      </>}
    </section>
  )
}
