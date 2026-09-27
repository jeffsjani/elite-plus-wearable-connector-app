import { Capacitor } from '@capacitor/core'
import type { ObservationQueueStore } from './ObservationQueueStore'
import { NativeSQLiteQueueStore } from './NativeSQLiteQueueStore'
import { WebQueueStore } from './WebQueueStore'

let store: ObservationQueueStore | null = null

export function getQueueStore(): ObservationQueueStore {
  if (!store) {
    store = Capacitor.getPlatform() === 'ios' || Capacitor.getPlatform() === 'android'
      ? new NativeSQLiteQueueStore()
      : new WebQueueStore()
  }
  return store
}