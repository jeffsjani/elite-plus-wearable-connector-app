import { Capacitor } from '@capacitor/core'
import type { ConnectorPlatform } from '../models/connector'

export function getPlatform(): ConnectorPlatform {
  const platform = Capacitor.getPlatform()

  if (platform === 'ios' || platform === 'android') {
    return platform
  }

  return 'web'
}

export function getRegistrationPlatform(): ConnectorPlatform {
  const testPlatform = import.meta.env.VITE_CONNECTOR_TEST_PLATFORM

  if (import.meta.env.DEV && (testPlatform === 'ios' || testPlatform === 'android')) {
    return testPlatform
  }

  return getPlatform()
}