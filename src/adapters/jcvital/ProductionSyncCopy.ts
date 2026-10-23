import type { ProductionSyncMetric, ProductionSyncMetricState, ProductionSyncOutcome } from './ProductionV8Sync'

export interface ProductionSyncSummary {
  outcome: ProductionSyncOutcome
  newCount: number
  errorCode: string | null
  completedAt: string | null
  metrics?: Array<{ metric: ProductionSyncMetric; status: ProductionSyncMetricState }>
}

/** Consumer copy only: no vendor, type or engineering terminology. */
export function productionSyncMessage(summary: ProductionSyncSummary): string {
  switch (summary.outcome) {
    case 'UP_TO_DATE':
      return summary.newCount > 0
        ? `${summary.newCount} new ${summary.newCount === 1 ? 'reading' : 'readings'} synced to Elite+.`
        : 'No new readings since your last sync.'
    case 'PENDING_DELIVERY': return 'Your new data is saved on this phone and will sync when your connection returns.'
    case 'PARTIAL': return 'We saved what we could. Keep your Elite+ V8 nearby and try again.'
    case 'FAILED': return 'We couldn’t read your Elite+ V8. Keep it nearby and try again.'
    case 'BLOCKED':
      if (summary.errorCode === 'NOT_AUTHENTICATED' || summary.errorCode === 'OWNER_MISMATCH' || summary.errorCode === 'CONNECTOR_NOT_REGISTERED') {
        return 'Sync is paused for this account. Sign out, sign back in, then try again.'
      }
      return 'Reconnect your Elite+ V8, then try again.'
  }
}
