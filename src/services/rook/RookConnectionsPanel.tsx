import { useEffect, useState } from 'react'
import { App as CapacitorApp } from '@capacitor/app'
import { RookConnections, type ProviderViews } from './RookConnections'
import { rookProviders } from './rookProviderRegistry'

function formatTimestamp(value: string): string {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString()
}

export function RookConnectionsPanel() {
  const [views, setViews] = useState<ProviderViews>(() => Object.fromEntries(rookProviders.map(({ dataSource }) => [dataSource, { state: 'NOT_CONNECTED' }])) as ProviderViews)
  const [controller] = useState(() => new RookConnections(undefined, setViews))

  useEffect(() => {
    void controller.refreshAll()
    let disposed = false
    const listener = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive && !disposed) void controller.refreshAwaiting()
    })
    return () => {
      disposed = true
      controller.reset()
      void listener.then((handle) => handle.remove())
    }
  }, [controller])

  return (
    <section className="wearables" aria-labelledby="wearables-title">
      <div className="wearables-heading"><h2 id="wearables-title">Connected Wearables</h2><button className="secondary" type="button" onClick={() => void controller.refreshAll()}>Refresh Connections</button></div>
      <div className="wearables-list">
        {rookProviders.map(({ dataSource, name }) => {
          const view = views[dataSource]
          const busy = ['CHECKING', 'CONNECTING', 'DISCONNECTING'].includes(view.state)
          const connected = view.status?.authorized === true
          const label = view.state === 'CHECKING' ? 'Checking...' : view.state === 'CONNECTING' ? 'Connecting...' : view.state === 'DISCONNECTING' ? 'Disconnecting...' : view.state === 'WAITING_FOR_AUTHORIZATION' ? 'Waiting for authorization' : view.state === 'ERROR' ? 'Status unavailable' : connected ? 'Connected' : 'Not Connected'
          return (
            <div className="wearable-row" key={dataSource}>
              <div className="wearable-info">
                <strong>{name}</strong>
                <span>Connection: {label}</span>
                {connected && <span>{view.status?.lastDataTimestamp ? `Last Data: ${formatTimestamp(view.status.lastDataTimestamp)}` : 'Data: Waiting for first data'}</span>}
                {connected && view.status?.lastWebhookAt && <span>Last Webhook: {formatTimestamp(view.status.lastWebhookAt)}</span>}
                {view.checkedAt && <span>Last checked: {formatTimestamp(view.checkedAt)}</span>}
                {view.error && <span className="error-message" role="alert">{view.error}</span>}
              </div>
              <div className="wearable-actions">
                {connected ? <button type="button" className="secondary" disabled={busy} onClick={() => { if (window.confirm(`Disconnect ${name}? Your historical health data will remain in Elite+.`)) void controller.disconnect(dataSource) }}>Disconnect</button> : view.state !== 'WAITING_FOR_AUTHORIZATION' && <button type="button" disabled={busy || (controller.awaiting !== null && controller.awaiting !== dataSource)} onClick={() => void controller.connect(dataSource)}>Connect</button>}
                {view.state === 'WAITING_FOR_AUTHORIZATION' && view.authorizationUrl && <button type="button" onClick={() => void controller.openAwaiting(dataSource)}>Open Authorization</button>}
                <button type="button" className="secondary" disabled={busy} onClick={() => void controller.refresh(dataSource)}>Check Connection</button>
              </div>
            </div>
          )
        })}
      </div>
    </section>
  )
}