# Synchronization services

`ObservationQueue` owns durable local enqueue/state operations. The
`ObservationBatchManager` selects owner-scoped records in batches of 100,
submits them through the existing connector service, acknowledges accepted or
duplicate observations, and retries transient failures with backoff.