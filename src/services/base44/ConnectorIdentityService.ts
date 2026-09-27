const connectorDeviceIdKey = 'connectorDeviceId'

class ConnectorIdentityService {
  getConnectorDeviceId(): string | null {
    return localStorage.getItem(connectorDeviceIdKey)
  }

  setConnectorDeviceId(connectorDeviceId: string): void {
    localStorage.setItem(connectorDeviceIdKey, connectorDeviceId)
  }

  clearConnectorDeviceId(): void {
    localStorage.removeItem(connectorDeviceIdKey)
  }
}

export const connectorIdentityService = new ConnectorIdentityService()