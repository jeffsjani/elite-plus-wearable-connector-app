import 'fake-indexeddb/auto'
import { describe, expect, it, vi } from 'vitest'
import { beginPhysicalTestIsolation, physicalTestBlocksSender, physicalTestIsolationSnapshot, physicalTestSideEffect, requestPhysicalTestSenderPause } from './PhysicalTestIsolation'
import { cleanupSavedPhysicalTest } from './PhysicalTestQuiescence'
import { ObservationQueue } from '../sync/ObservationQueue'
import { WebQueueStore } from '../storage/WebQueueStore'
import { ObservationBatchManager } from '../sync/ObservationBatchManager'
import { invokeConnectorFunction } from '../base44/Base44Client'

vi.mock('../../buildMode', () => ({ IS_ENGINEERING_BUILD: true }))

describe('physical-test exclusive side-effect barrier', () => {
  it('blocks real queue mutations, ACK changes, sender launch and backend requests, preserving durable rows', async () => {
    const queue = new ObservationQueue(new WebQueueStore())
    queue.setOwnerUserId('physical-test-owner')
    await queue.initialize()
    const before = await queue.listDiagnosticRecords()
    const counts = physicalTestIsolationSnapshot().counts
    const release = beginPhysicalTestIsolation()
    try {
      await expect(queue.enqueueMany([])).rejects.toThrow('blocked queue')
      await expect(queue.claimPending(1, 'test-batch')).rejects.toThrow('blocked queue')
      await expect(queue.acknowledgeClaims([])).rejects.toThrow('blocked queue')
      await expect(queue.purgeAcknowledged()).rejects.toThrow('blocked queue')
      await expect(invokeConnectorFunction('must-not-run', {})).rejects.toThrow('blocked base44')
      const sender = new ObservationBatchManager()
      const generation = sender.getDeliveryDiagnostics().senderGeneration
      expect(await sender.process()).toBeNull()
      expect(sender.getDeliveryDiagnostics().senderGeneration).toBe(generation)
      expect(await queue.listDiagnosticRecords()).toEqual(before)
      expect(physicalTestIsolationSnapshot().counts).toEqual(counts)
      expect(physicalTestIsolationSnapshot().blocked).toEqual(['queue', 'queue', 'queue', 'queue', 'base44', 'sender'])
    } finally {
      release()
    }
    expect(physicalTestBlocksSender()).toBe(false)
    expect(await physicalTestSideEffect('queue', async () => 'restored')).toBe('restored')
  })

  it('refuses entry while any queue/backend operation is already in flight or another test owns the barrier', async () => {
    let finish!: () => void
    const pending = physicalTestSideEffect('base44', () => new Promise<void>((resolve) => { finish = resolve }))
    expect(() => beginPhysicalTestIsolation()).toThrow('already active')
    finish()
    await pending
    const release = beginPhysicalTestIsolation()
    try {
      expect(() => beginPhysicalTestIsolation()).toThrow('already active')
    } finally {
      release()
    }
  })

  it.each(['idle', 'active', 'startup', 'paused', 'stopped', 'resume-error'] as const)(
    'cleans up a saved isolation with sender %s without changing delivery policy or duplicating workers', (mode) => {
      requestPhysicalTestSenderPause()
      beginPhysicalTestIsolation()
      const sender = {
        getPhysicalTestSenderState: () => ({
          started: mode !== 'stopped', paused: mode === 'paused', pauseReason: mode === 'paused' ? 'DELIVERY_PAUSED' : null,
          activeRequest: mode === 'active', activeWorkers: mode === 'active' ? 1 : 0,
          claimOwner: mode === 'active' ? 'sender' : null, startupOperations: mode === 'startup' ? 1 : 0,
          lastBatchId: 'last-batch', lastSenderError: null, lastInflightCompletedAt: null,
        }),
        resumeAfterPhysicalTest: vi.fn(() => { if (mode === 'resume-error') throw new Error('resume failed') }),
      }
      const cleanup = cleanupSavedPhysicalTest(sender)
      expect(physicalTestIsolationSnapshot().active).toBe(false)
      expect(physicalTestIsolationSnapshot().senderPause).toBeNull()
      expect(cleanup.isolationReleasedAt).toBeTruthy()
      expect(sender.resumeAfterPhysicalTest).toHaveBeenCalledTimes(mode === 'active' || mode === 'startup' ? 0 : 1)
      if (mode === 'paused' || mode === 'stopped' || mode === 'resume-error') {
        expect(cleanup.senderResumedAt).toBeNull()
        expect(cleanup.errors).toHaveLength(1)
      } else {
        expect(cleanup.senderResumedAt).toBeTruthy()
        expect(cleanup.errors).toEqual([])
      }
    })

  it('inspects sender in finally even if isolation release throws', () => {
    const sender = {
      getPhysicalTestSenderState: vi.fn(() => { throw new Error('sender state unavailable') }),
      resumeAfterPhysicalTest: vi.fn(),
    }
    const cleanup = cleanupSavedPhysicalTest(sender, () => { throw new Error('release failed') })
    expect(sender.getPhysicalTestSenderState).toHaveBeenCalledOnce()
    expect(cleanup.isolationReleasedAt).toBeNull()
    expect(cleanup.senderResumedAt).toBeNull()
    expect(cleanup.errors).toEqual(['Isolation release: release failed', 'Sender resume: sender state unavailable'])
  })
})
