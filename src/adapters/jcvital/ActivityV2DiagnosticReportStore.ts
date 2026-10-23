const DATABASE_NAME = 'eliteplus-activity-v2-e2e-diagnostic-reports'
const STORE_NAME = 'reports'
function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Unable to open Activity v2 diagnostic report storage.'))
    request.onblocked = () => reject(new Error('Activity v2 diagnostic report storage is blocked by another open request.'))
  })
}

export class ActivityV2DiagnosticReportStore {
  async load(key: string): Promise<string | null> {
    const database = await openDatabase()
    try {
      return await new Promise((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readonly')
        const request = transaction.objectStore(STORE_NAME).get(key)
        request.onsuccess = () => resolve(typeof request.result === 'string' ? request.result : null)
        request.onerror = () => reject(request.error ?? new Error('Unable to read Activity v2 diagnostic report.'))
      })
    } finally {
      database.close()
    }
  }

  async save(key: string, report: string): Promise<void> {
    const database = await openDatabase()
    try {
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(STORE_NAME, 'readwrite')
        transaction.objectStore(STORE_NAME).put(report, key)
        transaction.oncomplete = () => resolve()
        transaction.onerror = () => reject(transaction.error ?? new Error('Unable to save Activity v2 diagnostic report.'))
        transaction.onabort = () => reject(transaction.error ?? new Error('Activity v2 diagnostic report save was aborted.'))
      })
    } finally {
      database.close()
    }
  }
}

export const activityV2DiagnosticReportStore = new ActivityV2DiagnosticReportStore()
