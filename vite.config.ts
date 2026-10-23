import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'

// https://vite.dev/config/
const projectRoot = fileURLToPath(new URL('.', import.meta.url))

export default defineConfig(({ mode }) => {
  const engineering = mode === 'engineering'
  // Keep all connection diagnostics in Engineering and explicit diagnostic builds only.
  const connectionDiagnostic = mode === 'connection-diagnostic'
  const activityV2ProductionVerification = mode === 'activity-v2-verification'
  const consumerIsolation: Plugin = {
    name: 'consumer-engineering-isolation',
    generateBundle(_options, bundle) {
      this.emitFile({
        type: 'asset',
        fileName: 'connector-build.json',
        source: JSON.stringify({ schema: 1, mode: engineering ? 'engineering' : connectionDiagnostic ? 'connection-diagnostic' : activityV2ProductionVerification ? 'activity-v2-verification' : 'consumer' }),
      })
      if (engineering || connectionDiagnostic) return
      const engineeringModule = /\/(?:PipelineDiagnosticV8Panel|ConnectionDiagnosticPanel|V8PipelineDiagnostic[^/]*|V8PhysicalSemanticTests|[^/]*Certification[^/]*View|Base44ContractProbePanel|SyntheticObservationFactory|RookConnectionsPanel|AppleHealthPanel|HealthConnectPanel)\.[jt]sx?$/
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue
        for (const [id, module] of Object.entries(output.modules)) {
          if (module.renderedLength > 0 && engineeringModule.test(id)) {
            this.error(`Engineering/inactive module included in consumer output: ${id}`)
          }
        }
      }
    },
  }
  return {
    plugins: [react(), consumerIsolation],
    resolve: {
      alias: {
        '@engineering-surfaces': resolve(projectRoot, 'src', engineering ? 'EngineeringSurfaces.ts' : 'ConsumerEngineeringStubs.ts'),
        '@jcvital-panel': resolve(
          projectRoot,
          'src/adapters/jcvital',
          engineering ? 'PipelineDiagnosticV8Panel.tsx' : 'ElitePlusV8Panel.tsx',
        ),
        '@connection-diagnostic-panel': resolve(
          projectRoot,
          'src/adapters/jcvital',
          engineering || connectionDiagnostic ? 'ConnectionDiagnosticPanel.tsx' : 'ConnectionDiagnosticPanelStub.tsx',
        ),
        '@v8-physical-semantic-tests': resolve(
          projectRoot,
          'src/adapters/jcvital',
          engineering ? 'V8PhysicalSemanticTests.tsx' : 'V8PhysicalSemanticTestsStub.tsx',
        ),
      },
    },
    define: {
      '__ENGINEERING_VALIDATION__': JSON.stringify(engineering),
      'import.meta.env.VITE_ENGINEERING_DIAGNOSTICS': JSON.stringify(String(engineering)),
      'import.meta.env.VITE_CONNECTION_DIAGNOSTIC': JSON.stringify(String(connectionDiagnostic)),
      'import.meta.env.VITE_ACTIVITY_V2_PRODUCTION_VERIFICATION': JSON.stringify(String(activityV2ProductionVerification)),
    },
  }
})
