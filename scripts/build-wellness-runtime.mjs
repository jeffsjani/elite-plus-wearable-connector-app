import { build } from 'vite'
import { fileURLToPath } from 'node:url'

await build({
  configFile: false,
  root: fileURLToPath(new URL('..', import.meta.url)),
  build: {
    outDir: 'android/app/src/main/assets', emptyOutDir: false, target: 'es2022',
    lib: {
      entry: 'src/wellness/health/digitalWellnessRuntime.ts',
      name: 'EliteWellnessRuntime', formats: ['iife'], fileName: () => 'digital-wellness.js',
    },
    minify: false,
  },
})
