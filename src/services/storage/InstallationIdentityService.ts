const installIdKey = 'installId'

function createInstallId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return `${Date.now()}-${Math.random().toString(16).slice(2)}`
}

class InstallationIdentityService {
  getInstallId(): string {
    const existingInstallId = localStorage.getItem(installIdKey)

    if (existingInstallId) {
      return existingInstallId
    }

    const installId = createInstallId()
    localStorage.setItem(installIdKey, installId)
    return installId
  }

  resetForDevelopment(): string {
    if (!import.meta.env.DEV) {
      throw new Error('Installation identity reset is available only in development builds.')
    }

    const installId = createInstallId()
    localStorage.setItem(installIdKey, installId)
    return installId
  }
}

export const installationIdentityService = new InstallationIdentityService()