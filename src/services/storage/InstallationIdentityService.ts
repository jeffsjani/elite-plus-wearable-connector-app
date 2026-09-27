const installIdKey = 'installId'
const installIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function createInstallId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }

  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (character) => {
    const randomValue = Math.random() * 16 | 0
    const value = character === 'x' ? randomValue : randomValue & 0x3 | 0x8
    return value.toString(16)
  })
}

function isValidInstallId(installId: string): boolean {
  return installIdPattern.test(installId)
}

class InstallationIdentityService {
  getInstallId(): string {
    const existingInstallId = localStorage.getItem(installIdKey)

    if (existingInstallId && isValidInstallId(existingInstallId)) {
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