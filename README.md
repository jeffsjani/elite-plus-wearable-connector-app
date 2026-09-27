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