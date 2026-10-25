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

The Activity V2 diagnostic verifier uses a separate exact-ID claim API for its
14 deterministic observations. It acquires the batch manager's delivery
barrier before enqueue, waits for already-running workers/startup recovery to
settle, and atomically claims only owner-matched `PENDING` rows in the supplied
set. Those rows then use the same production submit, response classification,
ACK, and retry path; acknowledged cleanup is limited to the scoped IDs. The
barrier remains held through the final queue snapshot. Ordinary
`ObservationBatchManager.process()` claims remain owner-scoped FIFO batches of
up to 100 and do not use this diagnostic ID filter. Releasing the diagnostic
barrier does not itself restart normal draining; the next existing lifecycle
or delivery trigger resumes it.