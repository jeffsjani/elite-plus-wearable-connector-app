import type { NativeObservationInput } from '../../services/base44/base44Types'

/**
 * Build 32B — persistent cross-sync dedup ledger for production V8 history.
 *
 * The durable queue purges rows as soon as Base44 ACKs them, so it cannot tell
 * whether a re-read V8 history record was already delivered. This ledger
 * remembers, per owner + device scope, every source slot that was durably
 * enqueued. Keys are derived from the existing deterministic source identity
 * (sourceRecordGroupId + slot index == sourceRecordId); nothing new is invented.
 */

type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const STORAGE_PREFIX = 'elitePlus.v8ProductionSyncLedger.v1'
export const PRODUCTION_SYNC_LEDGER_MAX_GROUPS = 12_000

interface LedgerGroup {
  /** Sorted, non-overlapping inclusive slot-index ranges. */
  r: Array<[number, number]>
  /** Device observedAt (ms) of the newest slot in the group; used for pruning. */
  t: number
  /** Vendor data type of the group. */
  d: string
}

interface LedgerState {
  v: 1
  owner: string
  scope: string
  groups: Record<string, LedgerGroup>
  /** Per vendor type: device observedAt (ms) at or below which pruned groups lived. */
  floors: Record<string, number>
}

export interface LedgerSlotKey {
  groupKey: string
  vendorDataType: string
  index: number
  observedAtMs: number
}

export function ledgerSlotKey(observation: NativeObservationInput): LedgerSlotKey | null {
  const groupKey = observation.sourceRecordGroupId
  const vendorDataType = observation.vendorDataType
  const index = observation.sequenceNumber
  const observedAtMs = Date.parse(observation.observedAt ?? observation.startTime)
  if (!groupKey || !vendorDataType || typeof index !== 'number' || !Number.isInteger(index) || index < 0 || !Number.isFinite(observedAtMs)) return null
  return { groupKey, vendorDataType, index, observedAtMs }
}

function insertRange(ranges: Array<[number, number]>, index: number): Array<[number, number]> {
  const next: Array<[number, number]> = []
  let placed = false
  for (const [start, end] of ranges) {
    if (index >= start && index <= end) return ranges
    if (!placed && index < start) { next.push([index, index]); placed = true }
    next.push([start, end])
  }
  if (!placed) next.push([index, index])
  const merged: Array<[number, number]> = []
  for (const range of next) {
    const last = merged[merged.length - 1]
    if (last && range[0] <= last[1] + 1) last[1] = Math.max(last[1], range[1])
    else merged.push([range[0], range[1]])
  }
  return merged
}

export class ProductionSyncLedger {
  private readonly storage: () => KeyValueStorage
  private readonly maxGroups: number
  private cache: LedgerState | null = null

  constructor(storage: () => KeyValueStorage = () => localStorage, maxGroups = PRODUCTION_SYNC_LEDGER_MAX_GROUPS) {
    this.storage = storage
    this.maxGroups = maxGroups
  }

  private key(owner: string, scope: string): string { return `${STORAGE_PREFIX}:${owner}:${scope}` }

  private load(owner: string, scope: string): LedgerState {
    if (this.cache?.owner === owner && this.cache.scope === scope) return this.cache
    let state: LedgerState = { v: 1, owner, scope, groups: {}, floors: {} }
    try {
      const parsed = JSON.parse(this.storage().getItem(this.key(owner, scope)) ?? 'null') as LedgerState | null
      if (parsed && parsed.v === 1 && parsed.owner === owner && parsed.scope === scope && parsed.groups && parsed.floors) state = parsed
    } catch { /* corrupt ledger => start empty; server dedup by observationId stays authoritative */ }
    this.cache = state
    return state
  }

  has(owner: string, scope: string, slot: LedgerSlotKey): boolean {
    const state = this.load(owner, scope)
    const floor = state.floors[slot.vendorDataType]
    if (floor !== undefined && slot.observedAtMs <= floor) return true
    return state.groups[slot.groupKey]?.r.some(([start, end]) => slot.index >= start && slot.index <= end) ?? false
  }

  /** Records durably enqueued slots and persists. */
  record(owner: string, scope: string, slots: LedgerSlotKey[]): void {
    if (!slots.length) return
    const state = this.load(owner, scope)
    for (const slot of slots) {
      const group = state.groups[slot.groupKey] ?? { r: [], t: slot.observedAtMs, d: slot.vendorDataType }
      group.r = insertRange(group.r, slot.index)
      group.t = Math.max(group.t, slot.observedAtMs)
      state.groups[slot.groupKey] = group
    }
    const entries = Object.entries(state.groups)
    if (entries.length > this.maxGroups) {
      entries.sort((a, b) => a[1].t - b[1].t)
      for (const [groupKey, group] of entries.slice(0, entries.length - this.maxGroups)) {
        state.floors[group.d] = Math.max(state.floors[group.d] ?? Number.NEGATIVE_INFINITY, group.t)
        delete state.groups[groupKey]
      }
    }
    this.storage().setItem(this.key(owner, scope), JSON.stringify(state))
  }

  size(owner: string, scope: string): number { return Object.keys(this.load(owner, scope).groups).length }
}

export const productionSyncLedger = new ProductionSyncLedger()
