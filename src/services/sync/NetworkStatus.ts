export interface NetworkStatus {
  isOnline(): boolean
  subscribe(listener: (online: boolean) => void): () => void
}

export class BrowserNetworkStatus implements NetworkStatus {
  isOnline(): boolean { return typeof navigator === 'undefined' ? true : navigator.onLine }

  subscribe(listener: (online: boolean) => void): () => void {
    if (typeof window === 'undefined') return () => undefined
    const online = () => listener(true); const offline = () => listener(false)
    window.addEventListener('online', online); window.addEventListener('offline', offline)
    return () => { window.removeEventListener('online', online); window.removeEventListener('offline', offline) }
  }
}