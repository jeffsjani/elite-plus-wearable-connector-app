import 'fake-indexeddb/auto'
import { describe, expect, it } from 'vitest'
import { WebQueueStore } from './WebQueueStore'

describe('durable production sync receipt storage', () => {
  it('loads the saved receipt from a fresh store instance after a simulated restart', async () => {
    const original = new WebQueueStore()
    const record = {
      ownerUserId: 'receipt-owner',
      syncId: 'sync-first',
      startedAt: '2026-10-14T10:00:00.000Z',
      completedAt: null,
      overallState: 'ACQUIRING',
      requestedMetricsJson: '["oxygenSaturation","wearableTemperature"]',
      receiptJson: '{"syncId":"sync-first","overallState":"ACQUIRING"}',
    }
    await original.saveProductionSyncReceipt(record)

    const afterRestart = new WebQueueStore()
    expect(await afterRestart.loadLatestProductionSyncReceipt('receipt-owner')).toBe(record.receiptJson)
    expect(await afterRestart.loadLatestProductionSyncReceipt('different-owner')).toBeNull()
  })

  it('replaces the account latest receipt with the newer sync result', async () => {
    const store = new WebQueueStore()
    await store.saveProductionSyncReceipt({
      ownerUserId: 'receipt-owner',
      syncId: 'sync-old',
      startedAt: '2026-10-13T10:00:00.000Z',
      completedAt: '2026-10-13T10:01:00.000Z',
      overallState: 'UP_TO_DATE',
      requestedMetricsJson: '["heartRate"]',
      receiptJson: '{"syncId":"sync-old"}',
    })
    await store.saveProductionSyncReceipt({
      ownerUserId: 'receipt-owner',
      syncId: 'sync-new',
      startedAt: '2026-10-14T10:00:00.000Z',
      completedAt: '2026-10-14T10:01:00.000Z',
      overallState: 'UP_TO_DATE',
      requestedMetricsJson: '["oxygenSaturation"]',
      receiptJson: '{"syncId":"sync-new"}',
    })
    expect(await store.loadLatestProductionSyncReceipt('receipt-owner')).toBe('{"syncId":"sync-new"}')
  })
})
