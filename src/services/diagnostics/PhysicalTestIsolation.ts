import { IS_ENGINEERING_BUILD } from '../../buildMode'

type Effect = 'queue' | 'base44'
const counts: Record<Effect, number> = { queue: 0, base44: 0 }
const inFlight: Record<Effect, number> = { queue: 0, base44: 0 }
let active = false
let blocked: string[] = []
let senderPause: 'PHYSICAL_TEST_QUIESCE_REQUESTED' | 'PHYSICAL_TEST_QUIESCED' | null = null

export function requestPhysicalTestSenderPause() {
  if (!IS_ENGINEERING_BUILD) throw new Error('Engineering build required for physical testing.')
  if (active || senderPause) throw new Error('Physical test or queue/backend operation is already active.')
  senderPause = 'PHYSICAL_TEST_QUIESCE_REQUESTED'
  return {
    quiesced: () => { senderPause = 'PHYSICAL_TEST_QUIESCED' },
    release: () => { senderPause = null },
  }
}

export function physicalTestIsolationSnapshot() {
  return { active, senderPause, counts: { ...counts }, inFlight: { ...inFlight }, blocked: [...blocked] }
}

export function releaseSavedPhysicalTestIsolation() {
  if (!IS_ENGINEERING_BUILD) throw new Error('Engineering build required for physical testing.')
  const previous = { active, senderPause }
  active = false
  senderPause = null
  return previous
}

export function beginPhysicalTestIsolation(): () => void {
  if (!IS_ENGINEERING_BUILD) throw new Error('Engineering build required for physical testing.')
  if (active || inFlight.queue || inFlight.base44) throw new Error('Physical test or queue/backend operation is already active.')
  active = true
  blocked = []
  return () => { active = false }
}

export function physicalTestBlocksSender(): boolean {
  if (!active && !senderPause) return false
  blocked.push('sender')
  console.info('Physical test isolation: background sender deferred.')
  return true
}

export async function physicalTestSideEffect<T>(effect: Effect, operation: () => Promise<T>): Promise<T> {
  if (!IS_ENGINEERING_BUILD) return operation()
  if (active) {
    blocked.push(effect)
    throw new Error(`Physical test isolation blocked ${effect} operation.`)
  }
  counts[effect]++
  inFlight[effect]++
  try {
    return await operation()
  } finally {
    inFlight[effect]--
  }
}
