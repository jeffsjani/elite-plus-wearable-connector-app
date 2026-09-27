# Elite+ Wearable Connector

## Purpose

Standalone Phase 1 native companion for Elite+.

The Connector does not calculate Elite+ scores. Base44 remains the backend and
canonical intelligence system.

## Architecture

```text
Native SDKs
    -> Native adapters
    -> NativeObservation
    -> local synchronization queue
    -> Base44 ingestion
    -> Elite+ canonical intelligence
```

Phase 1 establishes the native application shell, shared connector contracts,
platform detection, and a locally persisted installation identity. No source
permissions are requested and no wearable connection actions are enabled yet.

## Planned Phase 1 sources

- ROOK
- JCVital V8
- Apple HealthKit
- Android Health Connect
- iOS Device Activity
- Android UsageStats

The source names above are future adapter boundaries only. No wearable SDKs,
health integrations, Base44 SDK, or digital behavior APIs are configured in
this baseline.

## Development

```text
npm install
npm run dev
npm run build
npm run lint
npx cap sync
npx cap doctor
```

Native projects live in `ios/` and `android/`. Capacitor serves the production
web output from `dist/`.

## Build 2: Base44 Connection

Build 2 connects the standalone Connector to the existing Elite+ Base44
backend using the official `@base44/sdk` authentication client. The client
uses `auth.loginViaEmailPassword()`, `auth.me()`, `auth.isAuthenticated()`, and
`auth.logout()` for the Base44 session. Connector functions are:

- `nativeConnectorRegister`
- `nativeConnectorStatus`
- `nativeConnectorObservations`

The Connector sends the persisted `installId` when registering. Base44 returns
the account-scoped `connectorDeviceId`, which is replaced on every login and
cleared on logout to protect against cross-account reuse on the same device.
The install ID itself is not deleted during logout.

Synthetic observations use the `connector_test` source and are intended only
for the Build 2 connection, duplicate, and 500-observation development tests.
They are submitted directly without a durable queue.

The mobile Connector does not have permission to assign user ownership to
observations. Ownership is determined server-side from the authenticated
Base44 session, never from a client-supplied `user_id`.

## Build 2A: Live Base44 Certification

The Build 2A live certification passed against the existing Elite+ backend:

- SDK authentication: PASS
- Direct raw function transport: PASS
- Registration: PASS
- Re-registration: PASS
- Status: PASS
- Single observation: PASS
- Duplicate observation: PASS
- 500-observation batch: PASS
- Repeat 500 deduplication: PASS
- Logout and same-user re-login: PASS
- Cross-account client test: NOT RUN; server-side test already passed
- Session-expiration manual test: NOT RUN

The browser harness used `VITE_CONNECTOR_TEST_PLATFORM=ios` for development
validation only. Production uses the real Capacitor platform and does not
override the native platform.

## Build 3: Durable Observation Queue

Build 3 adds a durable, owner-scoped local observation queue between future
source adapters and `ConnectorObservationService`.

- Native iOS/Android storage: `@capacitor-community/sqlite@8.1.1`
- Browser development storage: IndexedDB through `WebQueueStore`
- Native storage: `NativeSQLiteQueueStore`
- Schema: versioned `schema_version` and `observation_queue` tables
- Queue states: `PENDING`, `IN_FLIGHT`, `RETRY_WAIT`, `ACKNOWLEDGED`, `FAILED_PERMANENT`
- Initial batch size: 100 observations
- Retry policy: exponential backoff with jitter, capped at five minutes
- Accepted and duplicate server results both acknowledge local records
- Explicit rejected observation IDs become permanent failures
- Stale `IN_FLIGHT` records recover to retryable state after 15 minutes
- Queue rows are scoped by authenticated `ownerUserId`
- Queue safety warnings appear at 100,000 records or 30 days of pending age;
    records are not silently purged for age or capacity
- `Sync Now`, enqueue, app startup, network restoration, and foreground resume
    can request processing; only one processor runs at a time

The queue stores observation payloads and synchronization metadata only. It does
not store passwords, Base44 session tokens, service credentials, or source
secrets. Future health observations are sensitive local data. The selected
SQLite plugin is configured without encryption in this build; no encryption
claim is made. No wearable SDK or native background scheduler is integrated.

### Build 3 Certification

- Normal queued delivery: PASS
- Offline queue preservation and recovery: PASS (automated)
- Restart persistence: PASS (automated browser store)
- Duplicate enqueue: PASS (automated)
- Uncertain delivery/duplicate retry: PASS (automated and live)
- Partial rejection isolation: PASS (automated)
- Authentication interruption: PASS (automated)
- Account isolation: PASS (automated)
- Stale `IN_FLIGHT` recovery: PASS (automated)
- Retry classification and backoff: PASS (automated)
- Processing lock: PASS (automated)
- Live 100-observation queue delivery: PASS
- Live duplicate retry: PASS

The live queue tests used only synthetic connector observations. No real health
data was sent.