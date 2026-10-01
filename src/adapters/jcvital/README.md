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

### Phase 3C physical validation

Validated on the physical Pro V8, firmware `0.0.8.8`, SDK `v8sdk2.0`:

- Workout wall duration: 605.11 seconds.
- Type-82 workout packets: 600; HR-bearing packets: 600.
- Packet interval median: 994 ms; P5/P95: 977/1,030 ms; 98.83% within
  750–1,250 ms.
- Nonzero HR observations: 591; interval median: 993.5 ms; P5/P95:
  978/1,029 ms; 99.49% within 750–1,250 ms.
- Initial zero-HR packets: 9; first nonzero HR observation was 9,707 ms after
  session start. This is a startup sensor-acquisition delay, not missing-history
  interpolation.
- Heartbeat attempts/sends/skips: 598/598/0. Parse errors: 0.
- `ExerciseTime` progressed from 1 through 600 during approximately ten
  minutes. It is normalized as `WORKOUT_ELAPSED_SECONDS`, unit `second`,
  validation `CONFIRMED_HARDWARE`, while the original vendor string remains in
  `exerciseTimeRaw`.
- Classification: `CONFIRMED_1HZ_HR_OBSERVATION`.

The validated claim is approximately 1 Hz workout HR observations delivered by
the V8 SDK. Repeated identical BPM values remain valid observations and are
reported separately as repeat/run diagnostics. This does not claim 1 Hz raw PPG
or guarantee a newly completed optical calculation each second.

Keep the three heart-rate layers distinct:

- Live workout HR observations: approximately 1 second.
- Continuous historical HR: 5-second series.
- Automatic HR: configurable monitoring schedule; this physical device was set
  to 10 minutes.

The 10-minute run validates this device/configuration only; cadence and startup
behavior may vary by firmware, activity mode, or sensor lock conditions.

## Phase 3D raw-signal implementation preparation

The packaged `android/app/libs/v8sdk2.0.jar` and checked-in Android source were
audited. No implemented `realtimePPGData_V8` or `arrayPPGData` API was found;
`BleConst.realtimePPGData` (`99`) exists as an unused constant in the inspected
SDK source. Do not treat that constant alone as an acquisition method.

### PPG-related Android workflow

- `BleSDK.ppgWithMode(mode, status)` sends `DeviceConst.CMD_Get_Bloodsugar`
  (`0x78`). The Android demo uses mode 1 to start, mode 4 for progress, mode 3
  to stop, mode 2 to report a vendor workflow result, and mode 5 to quit.
- Sample payloads arrive as `DeviceConst.Bloodsugar_data` (`0x3a`), normalized
  by the SDK as `BleConst.Blood_glucose_data` (`119`) with `Time` and `PPG`.
  This is a vendor-named glucose workflow; Phase 3D must expose waveform data
  only as raw PPG and must not represent any workflow result as blood glucose.
- For 153-byte notifications, the parser strips the first three bytes and
  interprets 50 successive 3-byte values as unsigned big-endian integers. Its
  203-byte branch groups by four bytes but repeats the first byte in its
  arithmetic; do not use that branch to redefine raw values. Capture original
  BLE bytes at the native notification boundary and preserve the SDK-decoded
  map separately for comparison.
- No sample rate, packet cadence, sample interval, or reliable packet sequence
  field is documented for this PPG workflow. Keep those fields null until
  measured on hardware.

### Phase 3D-B PPG workflow hardware validation

- `PPG_WORKFLOW_RAW_VENDOR`: `CONFIRMED_HARDWARE` on PRO_V8 firmware 0.0.8.8.
- `203_BYTE_LAYOUT`: `CONFIRMED_HARDWARE`. Observed physical data packets were
  203 bytes; each yields 50 vendor-decoded values.
- 153-byte parser support: implemented but NOT physically observed.
- Sample rate: UNKNOWN (`sampleRateHz` stays null). Unit:
  `UNKNOWN_VENDOR_UNIT`. Not calibrated PPG and not measured glucose.
- Physical run (~20.6 s): 20 packets in 2 chunks, 3,686 bytes (18 x 203-byte,
  2 x 16-byte), 18 vendor type-119 callbacks, 900 decoded values, raw range
  3,510–16,593, 0 parse/storage/render errors, 0 dropped UI summaries.
- Spool integrity: 3,686 raw bytes + 88 framing/header bytes (8-byte magic +
  4-byte length prefix per packet) = 3,774 persisted bytes; 20 persisted packets.
- Exports carry bounded first/last three chunk summaries only (sequence range,
  packet count, wire bytes, length counts, timestamps, layout and type-119
  counts); raw packet bytes stay in the native spool.

### ECG Android stream

- Start: `BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, duration, true)`
  plus `BleSDK.setECGRealtimeDuringHRVEnabled(true)`. The latter sends
  `DeviceConst.PPG` (`0x07`) and enables the SDK's ECG raw parser. The Android
  demo passes `50 * 1000` as its duration; the unit interpretation needs
  verification before using that literal in a new session controller.
- Stop: the same measurement call with `open=false`, followed by
  `setECGRealtimeDuringHRVEnabled(false)`.
- Notifications on command byte `0x07` with the SDK gate enabled and packet
  length above 16 are parsed as `BleConst.GetECG` (`64`). `arrayEcgRawData`
  contains unsigned 24-bit little-endian values rendered as comma-separated
  decimal integers; `packetID` is notification byte 1. The SDK reports
  `End=false` for each packet.
- Sample frequency and packet cadence are not provided by Android source.
  Preserve the original byte triplets; do not convert to millivolts or infer a
  sample rate.

### Phase 3D boundary

Raw ECG can be captured from native notifications while retaining the SDK
packet ID and parsed fields. Raw PPG should be captured from `0x3a` notification
bytes because the SDK parser transforms the frame and has inconsistent 153/203
byte decoding paths. Both feeds require native bounded buffering, session
lifecycle, sequence/drop accounting, and chunk transfer/storage; they must not
emit each sample individually through Capacitor. The existing GATT receive path
already owns the raw notification bytes, so implementation should add a
session-scoped buffer at that boundary without replacing transport behavior.
PPG start/stop semantics, ECG duration units, sample frequency, rates, and
buffer-loss behavior require Phase 3D hardware validation.

## Build 5A workout HR delivery — physical pass

JCVital Pro V8 type-82 workout HR was delivered end-to-end from the native
Connector to Elite+ and verified in Base44 for one physical session:

| Evidence | Count |
| --- | --- |
| NativeObservation (unique) | 104 |
| Canonical `body.heart_rate` (unique) | 104 |
| WearableIngestionEvent rows | 165 |
| Duplicate/retry receipt events | 61 |
| Duplicate NativeObservation / canonical rows | 0 / 0 |
| Rejected | 0 |
| FAILED / DEAD_LETTER | 0 / 0 |

- Canonical metric: `body.heart_rate`.
- Source provenance: `JCVITAL_NATIVE` / `DIRECT_BLE`, retained on every record.
- Device identity: opaque `jcvital_device_<uuid>` only; the BLE MAC stays local.
- Timestamps: type-82 packets carry no device clock, so `observedAt` is the
  Connector's BLE receipt time and each payload states
  `observedAtSource` and `timestampSource` = `CONNECTOR_BLE_RECEIPT_TIME`, with
  `timestampConfidence` = `RECEIPT_TIME_NO_VENDOR_TIMESTAMP`. `timestampSource`
  is not part of the idempotency key, so observation IDs are unchanged.

### Reading event and delivery counts

Base44 `WearableIngestionEvent` count may exceed the unique observation count
because duplicate/retry receipts are intentionally retained as audit events.
In the session above, 104 unique observations + 61 duplicate receipt events =
165 `WearableIngestionEvent` rows. This is expected and is **not** duplicate
physiological data: NativeObservation and canonical rows stayed at 104.

Connector diagnostics report two kinds of numbers:

- `uniqueObservationsDelivered` — unique Connector observation IDs that reached
  an acknowledged delivered state, whether the final successful response
  classified them as accepted or duplicate. For the session above this is 104.
  It counts acknowledged Connector IDs only and makes no claim about backend
  table counts.
- `serverAcceptedInBatches` / `serverDuplicateInBatches` /
  `serverRejectedInBatches` — raw per-response counters summed across every
  batch, including retries and replays. Accepted + duplicate can exceed the
  unique count and must not be read as physiological record counts.

## Build 5B-1 historical physiology delivery

`PhysiologyContract.ts` maps native Phase 3A historical observations to
`NativeObservationInput`; `PhysiologyDelivery.ts` enqueues them in the durable
queue and drains through the unchanged Build 5A `ObservationBatchManager`
(≤100 per `nativeConnectorObservations` request, 30 s timeout, backoff retry).
Delivery is off by default and runs only after a sync completes.

| Metric | Connector metricType | `metric` | Unit | Vendor type / field | Canonical target | vendorDerived | Canonicalized | timestampSource / timestampConfidence | timestampTimezoneSource |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Continuous HR history | `HEART_RATE` | `heartRate` | bpm | 27 / `arrayDynamicHR` | `body.heart_rate` | no | yes (existing 5A route) | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_RECORDED` (first sample of each record), `DEVICE_HISTORY_RECORD_TIME_PLUS_NOMINAL_INTERVAL` / `NOMINAL_INTERVAL_DERIVED` (+5 s × index) | `PHONE_TIMEZONE` |
| SpO2 | `SPO2` | `oxygenSaturation` | percent (0–100) | 68 / `Blood_oxygen` | `body.oxygen_saturation` | no | yes (Base44 certified) | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE` | `PHONE_TIMEZONE` |
| Wearable temperature | `WEARABLE_TEMPERATURE` | `wearableTemperature` | celsius | 59 / `temperature` | `body.wearable_temperature` (skin; never core body temperature) | no | yes (Base44 certified) | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE` | `PHONE_TIMEZONE` |
| HRV | `HRV_VENDOR` | `hrvVendor` | `UNKNOWN_VENDOR_UNIT` | 42 / `hrv` | — | yes | **no — NativeObservation only** | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE` | `PHONE_TIMEZONE` |
| Stress | `STRESS_VENDOR` | `stressVendor` | `UNKNOWN_VENDOR_UNIT` | 42 / `stress` | — (source input for the Elite+ stress engine; never replaces it) | yes | **no — NativeObservation only** | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE` | `PHONE_TIMEZONE` |
| Estimated BP systolic | `BP_SYSTOLIC_ESTIMATED` | `bloodPressureSystolicEstimated` | `UNKNOWN_VENDOR_UNIT` | 42 / `highBP` | — (`ESTIMATED_VENDOR_BP`, never cuff BP) | yes | **no — NativeObservation only** | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE` | `PHONE_TIMEZONE` |
| Estimated BP diastolic | `BP_DIASTOLIC_ESTIMATED` | `bloodPressureDiastolicEstimated` | `UNKNOWN_VENDOR_UNIT` | 42 / `lowBP` | — (`ESTIMATED_VENDOR_BP`, never cuff BP) | yes | **no — NativeObservation only** | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE` | `PHONE_TIMEZONE` |
| PPI | `PPI` | `ppiVendorRaw` | `UNKNOWN_VENDOR_UNIT` (no ms assumption) | 127 / `ppiData` | — | no | **no — NativeObservation only** | `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE` (group time; per-slot offsets unknown) | `PHONE_TIMEZONE` |
| Workout HR (5A, type 82) | `HEART_RATE` | `heartRate` | bpm | 82 | `body.heart_rate` | no | yes | `CONNECTOR_BLE_RECEIPT_TIME` / `RECEIPT_TIME_NO_VENDOR_TIMESTAMP` | absent |

- Every row: `source=jcvital_native`, `provider=JCVITAL`, `JCVITAL_NATIVE` /
  `DIRECT_BLE`, `deviceModel=PRO_V8`, opaque `jcvital_device_<uuid>`, firmware
  and SDK version. The native observation's MAC-bearing `source`, `id`,
  `provenance` and `rawPayload` are never forwarded.
- `observedAt` is the device history record time (device-local `date` in the
  phone time zone); `receivedAt` is BLE receipt. Records without a parseable
  source date are not delivered. `CONNECTOR_BLE_RECEIPT_TIME` stays reserved
  for type-82 workout HR.
- Timestamp provenance has two independent parts; the top-level fields are
  authoritative and `rawSourceMetadata` carries no timestamp keys:
  - **Derivation** — `timestampSource` + `timestampConfidence`: continuous HR
    first sample of each record `DEVICE_HISTORY_RECORD_TIME` / `DEVICE_RECORDED`;
    later samples `DEVICE_HISTORY_RECORD_TIME_PLUS_NOMINAL_INTERVAL` /
    `NOMINAL_INTERVAL_DERIVED` (`samplingIntervalMs = 5000`); SpO2, temperature,
    HRV, stress, estimated BP and PPI `DEVICE_HISTORY_RECORD_TIME` /
    `DEVICE_LOCAL_CLOCK_PHONE_TIMEZONE`.
  - **Timezone interpretation** — `timestampTimezoneSource` (optional):
    `PHONE_TIMEZONE` on every 5B-1 historical observation. It means: the device
    supplied a local date/time with no explicit timezone offset; the Connector
    interpreted that timestamp using the phone's current timezone. Type-82
    workout HR omits it because receipt time is already absolute.
  - Neither part participates in `sourceRecordId` or `observationId`.
- IDs: `sourceRecordId = JCVITAL_NATIVE:PRO_V8:<deviceId>:<metricType>:<vendorType>:<vendor date>|<group serial or ->|<index>`;
  `observationId = sha256(owner:sourceRecordId)`. Values and phone time zone are
  excluded, so repeating a sync yields duplicates only.
- One HRV record becomes four observations (HRV, stress, systolic, diastolic)
  sharing `sourceRecordGroupId`. HR embedded in type 42 (`HEART_RATE_AUTOMATIC`),
  `fatigueDegree` and `vascularAging` are not delivered in 5B-1.
- One PPI group becomes one observation per slot (zeros kept), each with
  `ppiSlotIndex`, `ppiGroupSlotCount`, `ppiGroupNonZeroCount`, `ppiZeroValue`
  and `ppiTrailingZeroPaddingCandidate`.
- No-measurement placeholders are not sent: HR ≤0 or >250, SpO2 ≤0 or >100,
  temperature/HRV/BP ≤0. Stress 0 is delivered; PPI 0 is delivered.
- NativeObservation-only metrics (HRV, stress, estimated BP, PPI) are a
  successful ingestion outcome: Base44 records `WearableIngestionEvent`
  `COMPLETE / CANONICAL_NOT_APPLICABLE`. The Connector counts them as delivered
  once acknowledged and never as failed for lacking a canonical row.
- Build 5B-1 writes no Brain Readiness, Overall Strain or WearableDailySummary
  rows; it validates ingestion and canonical storage only.
- `timestampTimezoneSource` is persisted by Base44 as NativeObservation
  `timestamp_timezone_source` (`PHONE_TIMEZONE` for 5B-1 historical rows;
  null for 5A workout HR and legacy sources).
- Per-observation response handling. `results[]` (one entry per observation
  with a usable `observationId`) is the primary truth; `errors[]` (capped at 50,
  `{observationId, reason}`) is supplementary and also feeds queue rejection so
  nothing beyond the cap is acknowledged by mistake.

  | `status` | `canonicalStatus` | Connector outcome | Counted as |
  | --- | --- | --- | --- |
  | accepted | canonicalized | `DELIVERED_CANONICALIZED` | delivered, canonicalized |
  | accepted | not_applicable | `DELIVERED_NATIVE_ONLY` | delivered, native only (success) |
  | accepted | failed | `CANONICAL_FAILED` | delivered to NativeObservation, canonical failed (surfaced, not a delivery failure) |
  | accepted | null | `DELIVERED` | delivered |
  | duplicate | null | `DELIVERED_DUPLICATE` | delivered (already stored) |
  | rejected | — | `REJECTED` with `reason` / `errorCode` | failed |

  `nativeObservationId` is retained for fresh accepted rows and is not required
  for duplicates or rejections. `errors[]` entries without an `observationId`
  are counted as unattributed. Responses without `results[]` fall back to batch
  totals, attributed per metric only when a batch holds one metric.
- `uniqueObservationsDelivered` is per-ID exact in both modes.

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
