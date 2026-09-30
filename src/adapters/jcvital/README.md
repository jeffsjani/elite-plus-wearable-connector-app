# JCVital V8 adapter

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

The native Android bridge covers the physically validated connection lifecycle,
device metadata, battery, realtime heart rate, realtime wearable temperature,
and Phase 3A historical physiology. Phase 3A physical validation passed;
its observations remain on the diagnostic bridge and are not uploaded through
the scalar-only Base44 contract.

## Phase 3A physical validation

Validated 2026-09-30 with a JCVital Pro V8, firmware `0.0.8.8`, and SDK
`v8sdk2.0`. All feeds completed with no parse errors.

### Continuous and automatic heart rate

- Continuous history returned 1,320 accepted samples.
- Median interval: 5 seconds.
- Minimum interval: 5 seconds.
- Maximum observed gap: 130 seconds.
- 99.545% of intervals were between 4 and 6 seconds.
- Classification: `CONFIRMED_HARDWARE_5_SECOND_CONTINUOUS_HR`.
- Automatic HR monitoring was enabled at a 10-minute configured interval,
  from 00:00 through 23:59, seven days per week.

These are separate acquisition concepts: **continuous HR history is a 5-second
series**, while the **automatic HR schedule is configured at 10-minute
intervals**. The automatic schedule must not be used as the historical series
cadence.

### Other physiology

- SpO2 historical ingestion passed. Observed cadence was approximately 30
  minutes; configured monitoring interval was 30 minutes.
- Temperature historical ingestion passed. Observed cadence and configured
  monitoring interval were both 10 minutes. Its canonical label remains
  `wearable_temperature_c`.
- HRV returned physical records at a configured 60-minute interval. Each source
  record emitted vendor HRV, associated HR, stress, estimated systolic BP, and
  estimated diastolic BP. `fatigueDegree` was not emitted.
- The HRV raw payload included `vascularAging`. It remains preserved in
  `rawPayload`; normalized `VASCULAR_AGING_VENDOR_RAW` exposure is deferred to
  Phase 3E because Phase 3A acquisition/parser behavior is frozen. Its status is
  `UNDERDOCUMENTED`, vendor-derived, with unknown unit.
- PPI returned 4 groups with 56 slots per group (224 total slots). Zero values
  remain in the lossless arrays and are diagnosed as probable unused-capacity
  padding, not invalid physiology. Unit remains `UNKNOWN_VENDOR_UNIT` pending
  vendor confirmation.

For HRV diagnostics, `sourceRecordsReceived` counts measurement epochs (2 in
the physical test), while `normalizedObservationsProduced` counts the separate
metrics emitted from those epochs. The latter must not be read as independent
HRV measurement epochs.

## Phase 3A historical physiology

| Feed | SDK command | Vendor data type | Fields | Unit | Timestamp |
| --- | --- | --- | --- | --- | --- |
| Continuous HR | `GetDynamicHRWithMode` | `GetDynamicHR` (`27`) | `date`, `arrayDynamicHR` | bpm | device-local `date`; subsequent samples use the SDK-supported nominal 5-second offset and remain marked with source date and interval |
| Automatic SpO2 | `Oxygen_data` | `GetAutomaticSpo2Monitoring` (`68`) | `date`, `Blood_oxygen` | percent | device-local `date` |
| Temperature | `GetTemperature_historyData` | `Temperature_history` (`59`) | `date`, `temperature` | Celsius | device-local `date` |
| HRV and vendor metrics | `GetHRVDataWithMode` | `GetHRVData` (`42`) | `date`, `hrv`, `heartRate`, `stress`, `highBP`, `lowBP`, optional `fatigueDegree` | bpm for HR; unknown vendor unit for all other fields | device-local `date` |
| PPI groups | `GetPPI` | `GetPPIData` (`127`) | `date`, `serial_number`, `ppiData` | `UNKNOWN_VENDOR_UNIT` | device-local `date` |
| Monitor configuration | `GetAutomatic` for HR, SpO2, temperature, HRV | `GetAutomatic` (`16`) | mode, interval, start/end, weekdays | raw vendor configuration values | receipt time |

## Phase 3B Android SDK audit

The implementation uses only the checked-in Android V8 SDK and its demo. All
five feeds use mode `0x00` to start, `0x02` to continue, and `0x99` to delete.
The demo continues after each 50 callback packets until `DeviceKey.End` is true.

| Feed | Request | Vendor type | Returned keys | Timestamp and units |
| --- | --- | --- | --- | --- |
| Daily activity | `BleSDK.GetTotalActivityDataWithMode(mode, "")` | `GetTotalActivityData` (`24`) | `date`, `step`, `exerciseMinutes`, `distance`, `calories`, `goal` | Device date `yyyy.MM.dd`; steps=count, exercise time=vendor minutes; Android parser divides distance and calories by 100 but does not document their final units, so units remain unknown and raw values are retained. `ExerciseTime` is calculated internally but commented out and not emitted. |
| Detailed activity | `BleSDK.GetDetailActivityDataWithMode(mode, "")` | `GetDetailActivityData` (`25`) | `date`, `detailMinterStep`, `calories`, `distance`, `arraySteps` | Device-local `yyyy.MM.dd HH:mm:ss`; ten `arraySteps` values are documented by Android `DeviceKey` as one-minute steps. Block distance/calorie units remain unknown. |
| Sleep stages | `BleSDK.GetDetailSleepDataWithMode(mode, "")` | `GetDetailSleepData` (`26`) | `date`, `arraySleepQuality`, `sleepUnitLength` | Device-local `yyyy-MM-dd HH:mm:ss`; `sleepUnitLength` is emitted as 1 or 5 minutes and controls epoch timestamps. No Android source/documentation maps stage codes, so every code is retained and canonical stage remains `UNKNOWN` pending physical/vendor validation. |
| Detailed sleep movement | `BleSDK.getObtainDetailedSleepData(mode, "")` | `Obtain_detailed_sleep_data` (`121`) | `date`, `sleepLength`, `Sleep_level`, `ActivityData` | Device-local `yyyy.MM.dd HH:mm:ss`; stage and movement values are nibble-expanded arrays. No interval or alignment is documented, so arrays remain independent, unaligned, and lossless. |
| Workout history | `BleSDK.GetActivityModeDataWithMode(mode)` | `GetActivityModeData` (`29`) | `date`, `sportModel`, `heartRate`, `ExerciseTime`, `step`, `sportModelSpeed`, `distance`, `calories` | Device-local `yyyy.MM.dd HH:mm:ss`; pace is the vendor `MM'SS"` string. Duration, distance, and calorie units are not asserted until hardware validation. Android emits no METS field (`NOT_EMITTED_ANDROID`). |

Workout mode mapping is the active Android `ExerciseMode.modes` table: 0 run,
1 cycling, 2 badminton, 3 football, 4 tennis, 5 yoga, 6 breathing training,
7 dance, 8 basketball, 9 walking, 10 generic workout, 11 cricket, 12 hiking,
13 aerobics, and 14 table tennis. Other integers remain
`OTHER_VENDOR_MODE_<number>`.

History requests use mode `0x00` to start and mode `0x02` to continue after 50
callback packets. `DeviceKey.End` is the completion marker. Every callback is
first emitted as sanitized `jcvitalRawVendorData`; recognized records additionally
emit `jcvitalObservation`. Unknown keys remain in `rawPayload`.

`highBP` and `lowBP` are classified only as vendor-estimated BP. HRV, stress,
fatigue, BP, and PPI units/scales remain unknown until physically or explicitly
documented. The SDK has no separate automatic-HR history command: HR embedded in
HRV history is retained as `HEART_RATE_AUTOMATIC`, while `GetDynamicHRWithMode`
remains the independent continuous stream.

### Storage-volume review

No raw waveform persistence is selected in Phase 3A. The current Base44 input is
scalar-only, so Phase 3A reports `recordsStored: 0` and offers lossless diagnostic
JSON instead of coercing arrays/raw payloads into scalar rows.

Estimates before JSON/database overhead:

- 1 hour workout HR: 3,600 samples at 1 Hz or 720 samples at 5 seconds; about 58 KB or 12 KB at 16 bytes/sample.
- 24 hours continuous HR: 17,280 samples at 5 seconds; about 276 KB at 16 bytes/sample.
- One 8-hour sleep at 1-minute epochs: 480 epochs; about 8 KB at 16 bytes/epoch.
- 5 minutes PPG with 32-bit samples: `sampleRateHz * 1,200` bytes; 30-120 KB at 25-100 Hz. Sample rate is not assumed by the schema.
- 5 minutes ECG with native three-byte samples: `sampleRateHz * 900` bytes; 115-461 KB at 128-512 Hz. Sample rate is not assumed by the schema.

Serialized observation JSON can be several times larger. PPG/ECG therefore must
use chunked native buffering and blob/chunk storage in Phase 3D, never one row or
one Capacitor event per sample.

## Historical implementation note

The earlier architecture-only build had no vendor binary, source, sample, or
firmware documentation. The vendor SDK and sample are now present, and the
native bridge uses their verified APIs rather than inferred command names.

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

## Phase 3C live workout telemetry

Android V8 workout control uses `BleSDK.EnterActivityMode(2, activityMode,
ExerciseMode.Status_*)`: command byte `0x19`, response type `EnterActivityMode`
(`30`). Start, pause, continue, and finish use the SDK's corresponding
`ExerciseMode.Status_*` values. The Android demo documents calling
`BleSDK.sendHeartPackage(float distance, int space, int rssi)` every second.
The native Handler schedules it at 1,000 ms and supplies explicit zero
placeholders for distance, pace, and vendor signal strength because GPS/pace
and an Android RSSI-to-vendor-scale mapping are not available.

The V8 responds as `BleConst.SportData` type `82`. The Android parser returns
`heartRate`, `step`, `calories`, and `ExerciseTime`; the latter is retained as
`exerciseTimeRaw` because its unit/cadence semantics are undocumented. Type 82
does not return distance, pace, METS, temperature, SpO2, or RSSI. Every packet
retains its raw vendor payload and receipt timestamp, and HR-bearing packets
also emit `jcvitalWorkoutHeartRate` separately from packet cadence diagnostics.

Phase 3C software is implemented but **not yet physically validated**. Only a
stopped physical workout can receive a cadence classification. Native
heartbeat attempt/sent/skipped counts and JS packet/HR observation timing are
reported separately; physical V8 testing must establish whether the one-second
request produces one-second packets and whether HR refreshes at that cadence.

## Files

- `JCVitalCapabilities.ts` — capability/evidence model and registry.
- `HeartRateSeries.ts` — generic series model, cadence diagnostics, chunking,
  deterministic IDs.
- `jcvitalV8Bridge.ts` — active Capacitor contract backed by the native Android
  `JCVitalV8Plugin`.
- `jcvitalBridge.ts` — legacy adapter contract retained for the older
  source-agnostic orchestration tests; it is not the native V8 bridge.
- `JCVitalAdapter.ts` — orchestration: lifecycle, capability negotiation,
  scalar sync to the Build 3 queue, workout HR series chunking, logout
  isolation. Never calls Base44 directly.
- `JCVitalAdapter.test.ts` — unit tests, including the mandatory workout-HR
  cadence-flexibility tests (A–L) from the Build 7A spec.

## Remaining blockers

1. **Base44 schema extension.** `NativeObservationInput` only carries a
   scalar `valueNumber`. Workout HR series chunks, PPI/RR interval chunks,
   PPG/ECG chunks, and sleep/movement epoch arrays need either an optional
   series/blob field on `NativeObservationInput` or a dedicated connector
   function (e.g. `nativeConnectorSeriesChunks`). Until decided,
   `JCVitalAdapter.getPendingSeriesChunks()` holds chunks locally and
   `diagnostics.seriesIngestionBlocked` is always `true`.
2. **Vendor semantics.** PPI units and the `vascularAging` scale/unit remain
  undocumented by the vendor.
