import { Capacitor } from '@capacitor/core'
import type { ConnectorPlatform } from '../models/connector'

export function getPlatform(): ConnectorPlatform {
  const platform = Capacitor.getPlatform()

  if (platform === 'ios' || platform === 'android') {
    return platform
  }

  return 'web'
}