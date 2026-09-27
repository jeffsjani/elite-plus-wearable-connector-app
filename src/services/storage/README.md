# Storage services

Build 3 uses `NativeSQLiteQueueStore` for Capacitor iOS/Android and
`WebQueueStore` with IndexedDB for browser development. The queue database is
versioned and stores only owner-scoped observation payloads and synchronization
metadata. Session credentials are never stored here.