# Synchronization services

`ObservationQueue` owns durable local enqueue/state operations. The
`ObservationBatchManager` selects owner-scoped records in batches of 100,
submits them through the existing connector service, acknowledges accepted or
duplicate observations, and retries transient failures with backoff.

Retries reuse the same observation IDs, so a batch that Base44 committed but
whose response was lost comes back as `duplicate` and creates no new records.
Base44 still logs each receipt as a `WearableIngestionEvent`, so event counts
can exceed unique observations (Build 5A: 104 observations + 61 duplicate
receipts = 165 events). See `src/adapters/jcvital/README.md`.