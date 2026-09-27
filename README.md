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