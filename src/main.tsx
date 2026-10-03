import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { crashBreadcrumbs, installGlobalCrashHandlers } from './services/diagnostics/CrashBreadcrumbs'

crashBreadcrumbs.startSession()
installGlobalCrashHandlers()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
