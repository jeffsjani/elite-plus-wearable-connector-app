import { Component, type ErrorInfo, type ReactNode } from 'react'
import { crashBreadcrumbs } from './services/diagnostics/CrashBreadcrumbs'

type State = { hasError: boolean }

export class AppErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { hasError: false }

  static getDerivedStateFromError(): State {
    return { hasError: true }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    crashBreadcrumbs.recordError('lastUnhandledJsError', error, info.componentStack ?? undefined)
  }

  render() {
    if (this.state.hasError) {
      return (
        <main className="shell">
          <section className="status-panel" aria-labelledby="app-error-title">
            <div className="elite-v8-brand" aria-label="Elite Plus">Elite<span>+</span></div>
            <h1 id="app-error-title">We hit a problem connecting to your Elite+ V8.</h1>
            <p className="lede">Your saved data is safe. Try again to reload the app.</p>
            <button type="button" onClick={() => window.location.reload()}>Try Again</button>
          </section>
        </main>
      )
    }
    return this.props.children
  }
}
