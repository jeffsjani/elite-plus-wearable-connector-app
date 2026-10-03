import { beforeEach, describe, expect, it, vi } from 'vitest'
import { connectorObservationService } from './ConnectorObservationService'
import { runBase44ContractProbe } from './Base44ContractProbe'

vi.mock('./ConnectorObservationService', () => ({
  connectorObservationService: { submitObservations: vi.fn() },
}))

const requestMetadata = {
  resolvedRequestUrl: 'https://waves-elite-sync.base44.app/functions/nativeConnectorObservations',
  resolvedHost: 'waves-elite-sync.base44.app',
  configuredAppId: '6a89a92c780c9ffa5ba886bc',
}

const responseMetadata = {
  ...requestMetadata,
  httpStatus: 200,
  safeRequestTraceId: { header: 'x-request-id', value: 'req-123' },
}

describe('Base44 contract probe', () => {
  beforeEach(() => vi.resetAllMocks())

  it('sends exactly one out-of-range heartRate observation and passes the required response contract', async () => {
    const submit = vi.mocked(connectorObservationService.submitObservations)
    submit.mockImplementation(async (request, options) => {
      const body = {
        success: true,
        batchId: request.batchId,
        accepted: 0,
        duplicate: 0,
        rejected: 1,
        errors: [],
        serverTimestamp: 'now',
        responseContractVersion: 'native-observations-results-v1',
        deploymentRevision: 'nc-observations-5b1-results-2026-10-03-r4',
        results: [{
          observationId: request.observations[0].observationId,
          status: 'rejected' as const,
          reason: 'valueNumber out of range',
          errorCode: 'VALIDATION_ERROR',
          canonicalStatus: null,
          nativeObservationId: null,
        }],
        authorization: 'Bearer must-not-be-exported',
      }
      options?.onRequestMetadata?.(requestMetadata)
      options?.onResponseMetadata?.(responseMetadata)
      options?.onResponseBody?.(body)
      return body
    })

    const result = await runBase44ContractProbe('install-1', 'device-1')

    expect(submit).toHaveBeenCalledTimes(1)
    const request = submit.mock.calls[0][0]
    expect(request.observations).toHaveLength(1)
    expect(request.observations[0]).toMatchObject({
      observationId: expect.stringMatching(/^connector_contract_probe_/),
      source: 'connector_contract_probe',
      metric: 'heartRate',
      valueNumber: 1_000_000,
      unit: 'bpm',
    })
    expect(result).toMatchObject({
      ...requestMetadata,
      httpStatus: 200,
      topLevelResponseKeys: expect.arrayContaining(['results', 'responseContractVersion', 'deploymentRevision']),
      responseContractVersion: 'native-observations-results-v1',
      deploymentRevision: 'nc-observations-5b1-results-2026-10-03-r4',
      transportHasResults: true,
      transportResultCount: 1,
      responseHasResults: true,
      responseResultCount: 1,
      accepted: 0,
      duplicate: 0,
      rejected: 1,
      firstResult: {
        observationId: request.observations[0].observationId,
        status: 'rejected',
        canonicalStatus: null,
        reason: 'valueNumber out of range',
        errorCode: 'VALIDATION_ERROR',
        hasNativeObservationId: false,
      },
      safeRequestTraceId: responseMetadata.safeRequestTraceId,
      passed: true,
      failures: [],
    })
    expect(JSON.stringify(result)).not.toContain('must-not-be-exported')
  })

  it('fails closed when the production fingerprint or per-observation results are missing', async () => {
    const submit = vi.mocked(connectorObservationService.submitObservations)
    submit.mockImplementation(async (request, options) => {
      const body = {
        success: true,
        batchId: request.batchId,
        accepted: 1,
        duplicate: 0,
        rejected: 0,
        errors: [],
        serverTimestamp: 'now',
        results: [{ observationId: request.observations[0].observationId, status: 'accepted' as const }],
      }
      options?.onRequestMetadata?.(requestMetadata)
      options?.onResponseMetadata?.(responseMetadata)
      options?.onResponseBody?.(body)
      return body
    })

    const result = await runBase44ContractProbe('install-1', 'device-1')

    expect(result.passed).toBe(false)
    expect(result.failures).toEqual(expect.arrayContaining([
      'responseContractVersion mismatch or absent',
      'deploymentRevision mismatch or absent',
      'expected accepted=0, duplicate=0, rejected=1',
      'probe observation was not rejected',
    ]))
  })
})