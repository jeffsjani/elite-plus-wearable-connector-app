import type { SourceJournalScope } from './jcvitalV8Bridge'
import type { FailureResult } from './PhysicalSemanticEvidence'

const STORE = 'results'
function key(scope: SourceJournalScope) {
  return `${scope.accountId}:${scope.deviceScopeId}`
}

async function database(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') throw new Error('Saved Activity result store is unavailable.')
  return new Promise((resolve, reject) => {
    let expired = false
    const timer = setTimeout(() => {
      expired = true
      reject(new Error('Opening saved Activity result store timed out.'))
    }, 15_000)
    const request = indexedDB.open('eliteplus.savedActivityFinalization.v1', 1)
    request.onupgradeneeded = () => request.result.createObjectStore(STORE)
    request.onsuccess = () => {
      clearTimeout(timer)
      if (expired) request.result.close()
      else resolve(request.result)
    }
    request.onerror = () => { clearTimeout(timer); reject(request.error) }
    request.onblocked = () => {
      clearTimeout(timer)
      expired = true
      reject(new Error('Saved Activity database upgrade blocked.'))
    }
  })
}

function committed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => transaction.abort(), 15_000)
    transaction.oncomplete = () => { clearTimeout(timer); resolve() }
    transaction.onabort = () => { clearTimeout(timer); reject(transaction.error ?? new Error('Saved Activity transaction aborted or timed out.')) }
    transaction.onerror = () => { clearTimeout(timer); reject(transaction.error) }
  })
}

export async function readSavedActivityFinalization(scope: SourceJournalScope): Promise<FailureResult | null> {
  const db = await database()
  try {
    const transaction = db.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).get(key(scope))
    await committed(transaction)
    return request.result ?? null
  } finally { db.close() }
}

export async function persistSavedActivityFinalization(
  scope: SourceJournalScope, original: FailureResult, result: FailureResult,
): Promise<void> {
  const db = await database()
  try {
    const transaction = db.transaction(STORE, 'readwrite')
    const store = transaction.objectStore(STORE)
    const originalKey = `${key(scope)}:original:${original.attempt_id}`
    const request = store.get(originalKey)
    request.onsuccess = () => {
      if (request.result === undefined) store.add(original, originalKey)
      store.put(result, key(scope))
    }
    await committed(transaction)
  } finally { db.close() }
}
