# JCVital V8 adapter (Build 7A)

## JCVital Pro V8 physical validation

Tested 2026-09-30:

- scan PASS
- connect PASS
- READY handshake PASS
- device info PASS
- battery PASS
- live HR PASS
- disconnect PASS
- reconnect PASS

## Status

**Update (V8 native SDK phase 1):** the vendor SDK is now in
`vendor/jcvital/android/sdk/` and a native Android bridge exists:
`android/app/src/main/java/com/hapi/eliteplus/connector/jcvital/` (Capacitor
plugin `JCVitalV8`, TS contract `jcvitalV8Bridge.ts`). It covers scan, connect,
device info, battery, and realtime heart rate only. The `EliteJCVital`
contract in `jcvitalBridge.ts` below is still unimplemented natively.

Architecture and TypeScript-side implementation only. **No native Android
bridge exists yet.** See "Blockers" below before extending this adapter.

## Why there is no native Kotlin plugin in this build

Build 7A's instructions require using the actual vendor JCVital V8 SDK and
forbid inventing native API method names. A full workspace and filesystem
search (including Gradle caches) found:

- No `.aar`/`.jar` vendor binary
- No vendor Java/Kotlin source or Android sample project
- No BLE manager/service, command classes, parsers, or callback interfaces
- No firmware/device API documentation

Nothing was attached to this task either. Writing a Kotlin plugin that calls
real BLE GATT services/characteristics for the V8 would have required
inventing UUIDs and class names that cannot be verified — exactly what the
task prohibits. The native bridge (`android/.../EliteJCVitalPlugin.kt`) is
therefore not implemented. `src/adapters/jcvital/jcvitalBridge.ts` defines the
contract it must satisfy so this gap can be closed without redesigning the
TypeScript layer.

## Secondary evidence actually inspected

Per the task, the vendor's published cross-platform wrapper was used as
secondary implementation evidence (not a substitute for the native SDK):

- `@moshenguo/ms-data-sdk@0.1.13` (npm, fetched and extracted for inspection).
  Confirms `V8` as a supported `DeviceType`, and contains the real BLE
  command/protocol encoding used by JStyle/JCVital-family devices
  (`BleConst`, `DeviceKey`, `BleSDK` in `build/sdk/*.d.ts` and
  `dist/index.esm.js`). This is a **protocol parser**, not a Bluetooth
  transport/connection library — it has no GATT service/characteristic UUIDs
  and no Android-native code.
- `ms_ble_data_analysis` (Flutter, V8 branch) — not resolvable on pub.dev at
  the time of this build; could not be inspected.

### Workout-HR cadence evidence

`BleSDK.getHeartData` (`GetDynamicHR`, command byte `0x54`) parses 24-byte
records: 1 BCD timestamp + 15 heart-rate sample bytes per record. Fifteen
samples per timestamped block is consistent with a 5-second per-sample
cadence (15 × 5s = 75s per block). This is the strongest cadence evidence
found and matches the task's default evidence policy
(`STORED_HR_5S_CONFIRMED`, `nominalSamplingIntervalMs = 5000`).

No SDK command, firmware field, sample-rate constant, or OEM statement
indicating **stored** 1-second workout HR was found anywhere in the inspected
evidence. `EnterActivityMode` real-time activity streaming exists (comment:
"the APP must send a data packet to the band every second"), but that
describes the phone-to-band GPS heartbeat during multi-activity mode, not a
band-to-phone 1 Hz HR guarantee, and it is unrelated to *stored* history. The
1-second claim is therefore tracked as `MARKETING_1S_CLAIM_UNVERIFIED`
(`MARKETING_STORED_HR_1S_CLAIM` in `JCVitalCapabilities.ts`) and is never
merged into the confirmed default.

## Files

- `JCVitalCapabilities.ts` — capability/evidence model and registry.
- `HeartRateSeries.ts` — generic series model, cadence diagnostics, chunking,
  deterministic IDs.
- `jcvitalBridge.ts` — Capacitor plugin contract (Elite+-owned surface; no
  native implementation yet).
- `JCVitalAdapter.ts` — orchestration: lifecycle, capability negotiation,
  scalar sync to the Build 3 queue, workout HR series chunking, logout
  isolation. Never calls Base44 directly.
- `JCVitalAdapter.test.ts` — unit tests, including the mandatory workout-HR
  cadence-flexibility tests (A–L) from the Build 7A spec.

## Blockers to close before Build 7B/8A can proceed on this source

1. **Native Android SDK.** Attach the actual vendor AAR/JAR, Kotlin/Java
   source, or Android sample project so the real BLE transport, GATT
   UUIDs, and callback wiring can be implemented in
   `android/.../EliteJCVitalPlugin.kt` against `jcvitalBridge.ts`.
2. **Base44 schema extension.** `NativeObservationInput` only carries a
   scalar `valueNumber`. Workout HR series chunks, PPI/RR interval chunks,
   PPG/ECG chunks, and sleep/movement epoch arrays need either an optional
   series/blob field on `NativeObservationInput` or a dedicated connector
   function (e.g. `nativeConnectorSeriesChunks`). Until decided,
   `JCVitalAdapter.getPendingSeriesChunks()` holds chunks locally and
   `diagnostics.seriesIngestionBlocked` is always `true`.
3. **Physical validation.** 1-second stored workout HR, real-time cadence
   stability, BLE disconnect handling, and battery impact all remain
   `PENDING` device certification per the task's certification policy.
