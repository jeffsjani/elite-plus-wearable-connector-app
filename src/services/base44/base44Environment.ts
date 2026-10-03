export interface Base44EnvironmentDefinition {
  expectedHost: string
  appId: string
  serverUrl: string
  appBaseUrl: string
  functionsBaseUrl: string
  observationsFunction: string
  registrationFunction: string
}

export interface BackendEnvironmentDiagnostics {
  expectedHost: string
  resolvedHost: string
  resolvedObservationsUrl: string
  resolvedRegistrationUrl: string
  responseContractVersion: string | null
  deploymentRevision: string | null
  environmentMatch: boolean
  expectedAppId: string
  resolvedAppId: string
}

export const BASE44_PRODUCTION_ENVIRONMENT: Readonly<Base44EnvironmentDefinition> = Object.freeze({
  expectedHost: 'waves-elite-sync.base44.app',
  appId: '6a89a92c780c9ffa5ba886bc',
  serverUrl: 'https://base44.app',
  appBaseUrl: 'https://waves-elite-sync.base44.app',
  functionsBaseUrl: 'https://waves-elite-sync.base44.app/functions',
  observationsFunction: 'nativeConnectorObservations',
  registrationFunction: 'nativeConnectorRegister',
})

export interface BackendEnvironmentOverrides {
  appId?: string
  functionsBaseUrl?: string
  responseContractVersion?: string | null
  deploymentRevision?: string | null
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname
  } catch {
    return ''
  }
}

export function resolveConnectorFunctionUrl(functionName: string, functionsBaseUrl = BASE44_PRODUCTION_ENVIRONMENT.functionsBaseUrl): string {
  return `${functionsBaseUrl.replace(/\/+$/, '')}/${functionName}`
}

export function getBackendEnvironmentDiagnostics(overrides: BackendEnvironmentOverrides = {}): BackendEnvironmentDiagnostics {
  const environment = BASE44_PRODUCTION_ENVIRONMENT
  const appId = overrides.appId ?? environment.appId
  const functionsBaseUrl = overrides.functionsBaseUrl ?? environment.functionsBaseUrl
  const resolvedObservationsUrl = resolveConnectorFunctionUrl(environment.observationsFunction, functionsBaseUrl)
  const resolvedRegistrationUrl = resolveConnectorFunctionUrl(environment.registrationFunction, functionsBaseUrl)
  const resolvedHost = hostOf(resolvedObservationsUrl)

  return {
    expectedHost: environment.expectedHost,
    resolvedHost,
    resolvedObservationsUrl,
    resolvedRegistrationUrl,
    responseContractVersion: overrides.responseContractVersion ?? null,
    deploymentRevision: overrides.deploymentRevision ?? null,
    environmentMatch: resolvedHost === environment.expectedHost
      && hostOf(resolvedRegistrationUrl) === environment.expectedHost
      && appId === environment.appId,
    expectedAppId: environment.appId,
    resolvedAppId: appId,
  }
}