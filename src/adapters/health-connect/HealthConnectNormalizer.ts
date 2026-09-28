import type { NativeObservationInput } from '../../services/base44/base44Types'
import type { HealthConnectRecord } from './healthConnectBridge'

export async function normalizeHealthConnectRecord(ownerUserId: string, record: HealthConnectRecord): Promise<NativeObservationInput> {
  if (!record.recordId || !record.lastModifiedTime || !record.originPackage || !record.metric || !record.unit ||
      typeof record.value !== 'number' || !Number.isFinite(record.value) ||
      !Number.isFinite(Date.parse(record.startTime)) || !Number.isFinite(Date.parse(record.endTime)) ||
      !Number.isFinite(Date.parse(record.lastModifiedTime))) throw new Error('Incomplete Health Connect record.')
  const bytes = new TextEncoder().encode(`${ownerUserId}:health_connect:${record.recordId}:${record.lastModifiedTime}`)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  const observationId = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
  return {
    observationId, source: 'health_connect', sourceRecordId: record.recordId,
    provider: record.originPackage, sourceId: record.originPackage, originPackage: record.originPackage,
    metric: record.metric, valueNumber: record.value, unit: record.unit,
    startTime: record.startTime, endTime: record.endTime, capturedAt: record.lastModifiedTime,
    timezone: record.zoneOffset || Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...(record.deviceManufacturer ? { deviceManufacturer: record.deviceManufacturer } : {}),
    ...(record.deviceModel ? { deviceModel: record.deviceModel } : {}),
  }
}