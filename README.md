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

## Build 6: Direct Android Health Connect

An app-local Capacitor 8 Kotlin bridge uses the official
`androidx.health.connect:connect-client:1.1.0` SDK. The dual-platform Capacitor
health package was not installed: it adds write permissions and an Android API
26 requirement to the app. The official SDK also requires API 26, so the app
retains its existing API 24 minimum with a scoped manifest library override;
the bridge is only registered on API 28+ and reports `UNSUPPORTED` below that.
The target/compile SDK remains 36. Android 14+ uses the system Health Connect
provider; on supported earlier versions the separate provider app may need to
be installed or updated. Availability distinguishes unavailable, missing and
update-required states; permissions are checked from the native controller.

Users choose read types before requesting permissions. The manifest declares
only `READ_HEART_RATE`, `READ_RESTING_HEART_RATE`,
`READ_HEART_RATE_VARIABILITY`, `READ_SLEEP`, `READ_STEPS`,
`READ_ACTIVE_CALORIES_BURNED`, `READ_EXERCISE`, `READ_RESPIRATORY_RATE`,
`READ_OXYGEN_SATURATION`, `READ_WEIGHT`, `READ_HEIGHT`, and
`READ_BODY_TEMPERATURE`. No write, history, or background health permission is
requested. Metrics include sampled heart rate, resting heart rate, HRV RMSSD,
sleep sessions/stages, steps, active calories, exercise duration, respiratory
rate, oxygen saturation, mass, height and body temperature. Health Connect
RMSSD differs from Apple Health's SDNN. Unavailable values are not synthesized.

An initial read covers seven days (configurable) with native page traversal.
The bridge obtains a changes token before reading history and subsequently
consumes paged upsertion and deletion events. Tokens are scoped to the Elite+
owner and selected record types, and advance only after upsertions enter the
durable queue. An expired token triggers a bounded history retry; changes older
than seven days may be missed after expiry. IDs hash owner, `health_connect`,
record ID (plus series entry index), and native last-modified time. This makes
retries idempotent; an updated record creates a distinct version, **not** an
in-place replacement. Deleted record IDs are counted as diagnostics but the
existing Base44 ingestion API offers no deletion operation, so historical
observations are not removed. Device certification must evaluate this policy.

Records retain the origin package as provider, record ID, optional device
manufacturer/model, timezone offset when present, and Health Connect dates and
units. Health Connect aggregates many apps and wearables; records are not
attributed to the phone by default. All measurements flow through
`ObservationQueue.enqueueMany()` and `ObservationBatchManager`, never directly
to Base44. Account switching stops the adapter and the Build 3 queue remains
owner-scoped. Diagnostics show counts and timestamps only.

Code tests are mocked and Android debug compilation is verified in Codespaces;
**physical-device certification is PENDING**. On Windows with Android Studio:

1. Open the `android/` project and connect an Android 9+ phone with a supported Health Connect provider.
2. Install the debug build and sign in to the Elite+ test account.
3. Select the desired types, authorize Health Connect and run Sync Now.
4. Verify safe Base44 delivery and provenance, without inspecting raw values in the mobile UI.
5. Repeat sync, restart the app, sync again and verify stable IDs/no extra uploads.
6. Revoke a permission in Health Connect and verify the Connector returns to Permission Required.

Apple Health device certification and ROOK live-provider certification remain
deferred. Do not interpret code tests as real Android permissions or provider
delivery. Optional provenance fields still need live Base44 ingestion validation.

## Build 7A: JCVital V8 Maximum-Data Integration (architecture only — see blockers)

Build 7A targets the JCVital V8 as a high-resolution sensor acquisition source.
**No native Android JCVital SDK artifact (AAR/JAR/Kotlin/Java source, sample
project, or BLE transport library) was present in this workspace or attached
to this task.** Per the explicit "do not invent native API method names"
requirement, the native Capacitor Kotlin bridge and its Android build/manifest
steps were **not implemented** in this build. Full details, evidence, and the
exact unblock steps are in
[`src/adapters/jcvital/README.md`](src/adapters/jcvital/README.md).

What secondary evidence was available and inspected: the vendor's published
cross-platform wrapper `@moshenguo/ms-data-sdk@0.1.13` (npm), which explicitly
lists `V8` as a `DeviceType` and contains the real BLE command/protocol byte
encoding (`BleConst`, `DeviceKey`, `BleSDK`). The referenced Flutter package
`ms_ble_data_analysis` (V8 branch) was not resolvable on pub.dev and could not
be inspected. This secondary evidence is documentation-grade only — it is a
protocol parser, not an Android transport/connection library — so it cannot
substitute for the native Android SDK required to build the real Bluetooth
bridge, and no CONFIRMED_V8 status was ever assigned purely from it.

**Workout-HR cadence evidence found:** the JStyle/JCVital "dynamic HR" history
records (`GetDynamicHR` / `ArrayDynamicHR`) are 24-byte blocks: one BCD
timestamp per block followed by 15 heart-rate sample bytes. This is consistent
with a 5-second per-sample cadence (15 samples x 5s = 75s per block), matching
the task's default evidence policy. No SDK command, firmware field, or OEM
statement indicating 1-second **stored** workout HR was found. Per Build 7A
policy this remains `MARKETING_1S_CLAIM_UNVERIFIED`, tracked separately from
the confirmed 5-second default, in `JCVitalCapabilities.ts`.

**What was built (TypeScript layer only, fully tested):**

- `src/adapters/jcvital/JCVitalCapabilities.ts` — `WorkoutHrCapability` model,
  `resolveWorkoutHrCapabilityState()` (the six required capability states),
  and `JCVitalCapabilityRegistry` (evidence-graded per capability:
  `CONFIRMED_V8` / `STRONG_SDK_EVIDENCE` / `UNVERIFIED_V8` /
  `MARKETING_CLAIM_UNVERIFIED` / `EXPLICITLY_UNSUPPORTED`).
- `src/adapters/jcvital/HeartRateSeries.ts` — the single generic
  `HeartRateSeries`/`HeartRateSample` model that supports 5-second, 1-second,
  and realtime cadences without a schema fork; per-sample timestamps take
  priority over cadence-derived ones (`timestampDerived` flag); observed-cadence
  diagnostics (`computeCadenceDiagnostics`) never relabel a nominal cadence;
  size-bounded, reassemblable chunking (`chunkHeartRateSeries`,
  `DEFAULT_MAX_CHUNK_BYTES`); deterministic scalar/series/chunk IDs
  (SHA-256 of owner+source+device+native-record-id, with a metric/timestamp
  fallback for series chunks).
- `src/adapters/jcvital/jcvitalBridge.ts` — the Elite+-owned Capacitor plugin
  **contract** (method/event names are Elite+'s own bridge surface, informed
  by but not copied from vendor command names) so the adapter can be built and
  tested now and a native implementation can be dropped in later without a
  redesign. **No native Kotlin implementation exists for this contract yet.**
- `src/adapters/jcvital/JCVitalAdapter.ts` — lifecycle, capability negotiation
  (upgrades cadence only when the connected device runtime actually reports
  it), scalar-history sync to the existing Build 3 durable queue, workout
  history sync producing chunked `HeartRateSeries`, activity-mode label table,
  and logout/account-isolation cleanup. **Never calls Base44 directly.**

**Base44 schema preflight — STOP condition triggered (task section 38):** the
existing `NativeObservationInput` (`src/services/base44/base44Types.ts`) has a
single scalar `valueNumber: number` field. It cannot represent HR series
chunks, PPI/RR interval chunks, PPG/ECG chunks, or sleep/movement epoch
arrays. Per explicit instruction, arrays were **not** encoded into scalar
string fields as a workaround. `JCVitalAdapter` enqueues only genuinely scalar
observations (heart rate, SpO2, temperature, workout calories/steps/distance)
through the existing queue; it buffers workout HR series chunks locally
(`getPendingSeriesChunks()`) and reports `seriesIngestionBlocked: true` with a
reason in its diagnostics. **Required extension to unblock:** either an
optional array/blob payload field on `NativeObservationInput` (e.g. a
`seriesChunk` object matching `HeartRateSeriesChunk`) or a new Base44
connector function/endpoint (e.g. `nativeConnectorSeriesChunks`) accepting
`{ installId, connectorDeviceId, batchId, chunks }`. This is a decision for
the Base44 backend owner, not something this build should assume.

**Not implemented in Build 7A (blocked, not skipped):** native Kotlin plugin,
BLE pairing UI, Android manifest/permission changes, `npx cap sync android`
and `./gradlew assembleDebug`, and Base44 delivery of any series/raw-signal
data. All of these require either the actual vendor Android SDK artifact or a
Base44 schema decision; both are external inputs this build could not invent.

Certification: `BUILD_7A_CODE_CERTIFIED` = **PARTIAL** (TypeScript capability
model, HeartRateSeries model, and adapter architecture are code-certified and
covered by unit tests; native bridge and Base44 series delivery are not yet
implemented). `BUILD_7A_DEVICE_CERTIFIED` = **PENDING** (no hardware, no
native SDK).

## Build 5A: JCVital Workout HR → Elite+ Ingestion Golden Path

Only physically validated V8 live workout HR (vendor type 82,
`jcvitalWorkoutHeartRate`) is delivered. Native acquisition is unchanged; PPG,
ECG and other V8 metrics are not uploaded.

- Transport: existing Base44 `nativeConnectorObservations` through the Build 3
  durable queue and `ObservationBatchManager`; no new endpoint or credential.
- Auth: the user's Base44 session bearer token plus `X-App-Id` and the
  registered `connectorDeviceId`; ownership is derived server-side.
- Mapping (`src/adapters/jcvital/WorkoutHrDelivery.ts`): `source=jcvital_native`,
  `provider=JCVITAL`, `metric=heartRate` (same metric name as the Apple Health
  and Health Connect HR feeds), `metricType=HEART_RATE`, `unit=bpm`, plus
  optional provenance fields `sourceConnector=JCVITAL_NATIVE`,
  `sourcePath=DIRECT_BLE`, `deviceModel=PRO_V8`, opaque `deviceId`, `firmwareVersion`,
  `sdkVersion`, `sessionId`, `packetSequence`, `acquisitionMode=WORKOUT_REALTIME`,
  `measurementContext=WORKOUT`, `vendorDataType=82` and a small
  `rawSourceMetadata`. Raw workout sessions are never attached.
- Time: type-82 packets carry no device timestamp. `observedAt`/`startTime`
  is the Connector's native BLE receipt time
  (`observedAtSource=CONNECTOR_BLE_RECEIPT_TIME`,
  `timestampConfidence=RECEIPT_TIME_NO_VENDOR_TIMESTAMP`); `receivedAt` is kept
  separately.
- Idempotency: `sourceRecordId = JCVITAL_NATIVE:PRO_V8:{backendDeviceId}:{sessionId}:HEART_RATE:{packetSequence}:{observedAt}`;
  `observationId = SHA-256(ownerUserId:sourceRecordId)`. The queue is unique on
  owner + observationId; the backend deduplicates by observationId.
- Device identity: the Bluetooth MAC stays local (scan/connect/reconnect and
  the mapping key). `JCVitalDeviceIdentityService` maps the normalized MAC to a
  random `jcvital_device_<uuid v4>` persisted in Connector `localStorage`
  (`jcvitalDeviceIdentityMap.v1`, same durability as `installId`). Only that
  opaque ID is sent as `deviceId`/`sourceId`; payloads containing a MAC fail
  preflight. Clearing app data creates a new ID for the same band.
- Zero/implausible HR (startup sensor acquisition) is counted, not sent.
- Batching: each HR is written to the durable queue at capture; delivery is
  requested every 15 observations or 15 s, and on workout stop. Each request
  carries up to 100 observations with individual timestamps. Network/5xx/408/429
  failures stay queued with backoff and are retried by the 15 s timer.
- Diagnostics: "Elite+ Delivery · Workout HR" in the V8 panel and
  `workoutHrDelivery` in the validation export. Delivery is opt-in per session.

**Backend blocker:** the Base44 backend source is not in this repository. It
must be confirmed server-side that `nativeConnectorObservations` accepts
`source=jcvital_native`, persists the optional provenance fields on
NativeObservation, and that canonical processing maps `heartRate`/`bpm` from
this source into the existing canonical heart-rate metric with a source
reference and no elevated source priority.
