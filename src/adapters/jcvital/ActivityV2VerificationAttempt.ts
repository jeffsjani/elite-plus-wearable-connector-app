type AttemptStorage = Pick<Storage, 'getItem' | 'setItem'>

export function beginActivityV2VerificationAttempt(
  storage: AttemptStorage,
  key: string,
  sourceEnvelopeIds: { type24: string; type25: string },
): boolean {
  if (storage.getItem(key) !== null) return false
  storage.setItem(key, JSON.stringify({
    state: 'STARTED',
    startedAt: new Date().toISOString(),
    sourceEnvelopeIds,
  }))
  return true
}

export function completeActivityV2VerificationAttempt(
  storage: AttemptStorage,
  key: string,
  report: string,
): void {
  storage.setItem(key, JSON.stringify({ state: 'COMPLETE', report }))
}
