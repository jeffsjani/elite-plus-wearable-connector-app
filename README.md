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

## Build 4B: ROOK Cloud Provider Connections

Authenticated users can connect and disconnect Garmin, Oura, Polar, Fitbit,
Withings, WHOOP, and Dexcom. The connector sends only the uppercase provider
`dataSource` to the authenticated Base44 raw functions `rookGetAuthorization`,
`rookAuthorizationStatus`, and `rookRevokeAuthorization`. Base44 derives the
user's ROOK identity; no ROOK SDK, client UUID, Basic Auth, HMAC, or server
secret is shipped in the app. No custom redirect URL is requested in Build 4B.
If a provider requires one, its actual server-side requirement must be confirmed
before adding it.

Provider login opens via `@capacitor/browser` on iOS/Android, never inside a
credential webview. Browser development opens a new tab; if the popup is blocked,
the waiting provider offers an explicit Open Authorization button. Completing
the browser flow does not itself mark the provider connected. On native foreground
return the connector checks only the provider awaiting authorization; Check
Connection and Refresh Connections provide manual status checks. Statuses load
on opening the authenticated screen with at most two concurrent checks. The
client displays only timestamps returned by Base44, and absence of health data
does not imply disconnection. Disconnect requires confirmation and calls
`rookRevokeAuthorization`, then checks server status; historical records remain.

Cloud health records flow directly from ROOK to
`handleRookDataWebhook` on Base44, then through existing server processing.
They never enter the Build 3 local observation queue; no canonical scoring or
webhook processing is performed in the mobile app.

Build 4B automated connection tests are mocked and do not certify a live
provider login. Garmin authorization URL, live provider login, webhook arrival,
and safe server-side data verification remain pending an authenticated test
session and approved Garmin account.

## Build 5: Direct Apple Health

Apple Health is read directly on iOS 15+ through the app-local Capacitor 8 Swift
HealthKit plugin (`EliteHealthKitPlugin`), not through ROOK. The maintained
`@capgo/capacitor-health@8.11.4` was evaluated but **not retained**: its Android
component requires API 26 while this project's Android minimum is 24 and its
manifest would introduce Health Connect permissions. No Android Health Connect
capability or plugin is added. ROOK live-provider testing remains deferred and
does not block this implementation.

The user explicitly selects read types before requesting HealthKit access:
heart rate, resting heart rate, HRV, sleep analysis, steps, active energy,
workouts, respiratory rate, oxygen saturation, body mass, and height. No write
authorization is requested. iOS does not disclose whether individual read
types were denied; a settled permission prompt or an empty read is **not**
treated as evidence of connection. A successfully normalized sample confirms
access for that read, but cannot prove all selected types are authorized.
Actual HealthKit entitlement signing and device permission behavior must be
verified in Xcode on a real iPhone.

Initial synchronization queries the last seven days (configurable in the
adapter). Subsequent runs use owner- and data-type-scoped timestamp checkpoints
with a one-day overlap, preserving the entire gap if the app has been idle for
more than seven days. The native query is capped per day and a saturated result
does not advance its checkpoint. This bridge does **not** implement HealthKit
anchored/deletion queries; late backfills outside the overlap and deleted samples
are not captured. Failed normalization does not advance the affected window's
checkpoint. The user initiates sync; no HealthKit background observer is enabled.

HealthKit sample UUIDs are hashed with owner ID and `apple_health` source to
produce stable observation IDs. Records retain HealthKit source name/bundle ID,
sample UUID, start/end times and supplied value/unit; unknown origin is labeled
as unknown rather than Apple Watch. Each observation goes through
`ObservationQueue.enqueueMany()` and `ObservationBatchManager` to authenticated
Base44 ingestion; the adapter never calls Base44 directly. The queue's existing
owner isolation and local-storage security limitations remain unchanged. Logout
stops HealthKit ingestion, leaves the previous user's queued data intact, and
does not revoke iOS Health permissions (the user manages those in Settings).
Diagnostics display counts, timestamps and queue delivery only, never raw values.

Build 5 TypeScript behavior and queue integration are covered by mocked tests.
Device certification is **PENDING**: Mac/Xcode, signing with the HealthKit
entitlement, a physical iPhone, explicit permissions, actual samples and safe
server-side validation are required. The optional provenance fields in the
observation payload also require validation against production Base44 ingestion
before claiming end-to-end device delivery.