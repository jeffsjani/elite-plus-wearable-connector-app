import type { User } from '@base44/sdk'
import { getAccessToken } from '@base44/sdk'
import { base44, mapBase44Error } from './Base44Client'
import type { LocalUser } from './base44Types'

function toLocalUser(user: User): LocalUser {
  return {
    id: user.id,
    email: user.email,
    name: user.full_name ?? undefined,
  }
}

class AuthenticationService {
  async getCurrentUser(): Promise<LocalUser | null> {
    try {
      return toLocalUser(await base44.auth.me())
    } catch (error) {
      const mappedError = mapBase44Error(error)
      if (mappedError.code === 'AUTH_REQUIRED' || mappedError.status === 401) {
        return null
      }
      throw mappedError
    }
  }

  async loginWithEmailPassword(email: string, password: string): Promise<LocalUser> {
    try {
      await base44.auth.loginViaEmailPassword(email, password)
      return toLocalUser(await base44.auth.me())
    } catch (error) {
      throw mapBase44Error(error)
    }
  }

  async logout(): Promise<void> {
    base44.auth.logout(window.location.origin)
  }

  async isAuthenticated(): Promise<boolean> {
    if (!getAccessToken()) return false

    try {
      return await base44.auth.isAuthenticated()
    } catch {
      return false
    }
  }
}

export const authenticationService = new AuthenticationService()