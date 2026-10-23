# Base44 Activity native transport v2: P1-2D handoff

Status: **P1-2D transport contract = PASS; v66 production caller is capability-gated**. The existing
registration response controls eligibility; payloads use the existing durable
queue, sender, batching, ACK and retry path. This document is a local Companion
contract only; it does not publish or modify Base44.

## 1. Baseline, boundary, and implementation inputs

The Base44 read-only audit supplied by the project owner reports:

- Live revision: `nc-observations-2026-10-21-r7-activity-canonical`.
- Live response contract: `native-observations-results-v1`.
- Raw Activity ingestion works, but the existing payload lacks qualified segment
  evidence/local-day/Android-duration semantics. Server-only publication is insufficient.
- Proposed distinct revision: `nc-observations-2026-10-21-r7-activity-canonical`.

These are supplied server findings, not a live query or exported server-source
verification by this preparation pass. They supersede the r5 baseline/r6 candidate
assumptions in the earlier [manual publish package](BASE44_ACTIVITY_MANUAL_PUBLISH_PACKAGE.md).
There is no local Base44 function source or deployment implementation.

Transport identifier: **`jcvital.native.activity.transport.v2`**.

The [transport module](../src/adapters/jcvital/ActivityNativeTransportV2.ts)
returns ordinary `NativeObservationInput` objects for the existing architecture:

`NativeObservation -> durable observation queue -> single sender -> /functions/nativeConnectorObservations`

The v66 production caller enqueues only after the exact registration capability
is verified and sends through the existing sender. The unmodified Activity v65
[canonicalizer](../src/adapters/jcvital/ActivityProductionCanonical.ts) is the
expected-output oracle, not a second server-persistence channel.

The [offline fixture](evidence/p1-2d/activity-native-transport-v2-fixture.json)
contains the **exact outgoing observation objects**, original source records,
full v65 expected canonical records, integrity-withheld reasons, sequential ledger
outcomes, final row identities, and conflict ancestry for nine scenarios.
Regenerate with:

```sh
node scripts/generate-activity-native-transport-v2-fixture.mjs
```

The generator uses Vite only as a local module loader, without a listening server,
dependency discovery, acquisition, queue writes, or network calls. Identifiers and
Type24 values are synthetic; the Type25 date/ten-slot example is from previously
qualified evidence. This is not additional physical evidence.

## 2. Dispatch and backward compatibility

The existing request batching/authentication envelope and
`native-observations-results-v1` response/ACK contract do not change.
Repository wire names are **camelCase**: `valueNumber`, not `value_number`.
The server derives owner from the authenticated existing request, never a payload
owner claim. Install/connector binding continues through the existing authenticated
registration and sender, not a new Activity channel.

The exact marker is `rawSourceMetadata.activityTransportVersion`.
Without it, retain the existing **NATIVE_ONLY** behavior, including the old
`DAILY_EXERCISE_MINUTES` interpretation; never silently upgrade old observations.

All prepared v2 objects also retain `canonicalPolicy: "NATIVE_ONLY"`. This is the
safe legacy default, **not permission to ignore v2** in r7. An explicitly
capability-enabled r7 handler must first route the exact v2 marker into its
qualified Activity validator, preserve the source, then canonicalize only eligible
Type24 fields or a valid Type25 segment anchor. Do not alter the legacy/general
metric dispatch or canonicalize every native scalar.

The new transport metric is **DAILY_EXERCISE_DURATION**. Do not alias it to
`DAILY_EXERCISE_MINUTES`. The latter is rejected by the reported live server and
has ambiguous historical units. No production verification send is performed during
the v66 build.

## 3. Types, nullability, sizes, and rejection

Sizes below are characters (JavaScript UTF-16 code units), except the complete
observation JSON limit, which is **16,384 UTF-8 bytes**. No emitted field is null.
Optional fields are omitted, not null. A server may store nullable entity columns,
but that must not weaken required wire validation.

Metadata is a flat object of string/number/boolean primitives: at most **64 keys**,
key length at most **64**, each string at most **512**, all numbers finite.
Nested objects/arrays are not the wire representation. Input provenance strings
are nonempty and at most **256** characters; composed source identities must also
fit the metadata 512-character bound. No field is truncated.

The server must support these proposed v2 bounds before advertising capability;
they are **not a claim that current r6 accepts these limits**. The unchanged
queue stores the serialized object losslessly; it performs no v2 evidence
truncation. Tests include queue restart, lease/claim, retry, ACK and purge.

### 3.1 Every emitted top-level observation field

All rows are required/non-null unless marked optional.
`literal` means one of the exact constants described here, bounded by 512
characters; `timestamp` means UTC ISO output (24 characters) unless noted.

| Field(s) | JSON type / maximum | Meaning |
|---|---|---|
| `observationId` | string, 64 lowercase hex | SHA-256 transport delivery identity, described below |
| `source` | string literal `jcvital_native` | Existing native source |
| `provider`, `sourceProvider` | string literal `JCVITAL` | Vendor provenance, not a new integration |
| `sourceConnector` | string literal `JCVITAL_NATIVE` | Direct native connector |
| `sourcePath` | string literal `DIRECT_BLE` | Evidence acquisition ancestry; this preparation performs no BLE |
| `deviceManufacturer` | string literal `JCVital` | Vendor |
| `deviceId`, `sourceId` | string, 256 | Same existing opaque `jcvital_device_...` device scope; never MAC |
| `deviceModel`, `firmwareVersion`, `sdkVersion` | string, 256 | Required nonempty physical qualification scope |
| `metric`, `metricType` | string literal | Same transport metric key in both fields; table below |
| `valueNumber` | number, finite, nonnegative, <= 9007199254740991 | Original scalar value; integers required for steps/duration/slots |
| `unit` | string literal | `count`, `km`, `kcal`, `second`, or `UNKNOWN_VENDOR_UNIT` |
| `startTime`, `observedAt` | timestamp | Same resolved device-local date/slot instant |
| `observedAtSource` | string, 19 | Original vendor date; Type24 is 10 characters, Type25 19 |
| `capturedAt`, `receivedAt` | string, 256, valid date/time | Original source receipt timestamp, not device-local day authority |
| `timezone` | string, 256 | Source-captured IANA timezone, unchanged, validated by local-time resolver |
| `timestampSource` | string literal | `TYPE24_DEVICE_LOCAL_DATE` or `TYPE25_DATE_PLUS_SLOT_MINUTES` |
| `timestampConfidence` | string literal | `DEVICE_LOCAL_CALENDAR_DATE`, `MANUAL_ADJUDICATED_PHYSICAL_HIGH_CONFIDENCE`, or `SOURCE_ONLY_UNQUALIFIED` |
| `timestampTimezoneSource` | string literal `PHONE_TIMEZONE` | Timezone was captured by Companion, not supplied by the watch |
| `acquisitionMode` | string literal `HISTORICAL_SYNC` | Existing saved-history acquisition path, including current-day daily history |
| `measurementContext` | string literal | `DAILY_ACTIVITY` or `DETAIL_ACTIVITY_BLOCK` |
| `sessionId` | string, 256 | Acquisition session, duplicated in metadata |
| `sourceRecordGroupId` | string, 512 | Stable device/type/vendor-date segment or daily source identity |
| `sourceRecordId` | string, 512 | Group + metric + record/slot discriminator |
| `vendorDataType` | string literal `"24"` or `"25"` | SDK type; metadata also carries numeric type |
| `vendorField` | string literal | `step`, `distance`, `calories`, `goal`, `exerciseMinutes`, `arraySteps`, `detailMinterStep` |
| `vendorDerived` | boolean | Mirrors the scalar's derivation flag in metadata |
| `sequenceNumber` | optional integer, 0..N-1 | Type25 array slot only; qualified N=10; invalid arrays remain source-only |
| `samplingIntervalMs` | optional integer literal 60000 | Present with slot; does not grant semantic qualification |
| `rawSourceMetadata` | object, bounds above | Required v2 evidence and provenance, defined next |

No other top-level fields are emitted by this mapper. Existing optional queue
fields outside this set are not newly required or changed.

### 3.2 Common metadata on every object

| Field | JSON type / maximum | Meaning |
|---|---|---|
| `activityTransportVersion` | string literal | `jcvital.native.activity.transport.v2` |
| `sourceDataType` | integer 24 or 25 | Original SDK type |
| `sourceLocalDate` | string, 10 | `YYYY-MM-DD` copied from vendor calendar components, never receipt/UTC date |
| `timezone` | string, 256 | Same source timezone as top level |
| `timezoneSource` | string literal `PHONE_TIMEZONE` | Timezone provenance |
| `sourceEnvelopeId` | string, 256 | Original decoded evidence envelope |
| `sourceRecordId` | string, 512 | Same scalar/slot source identity as top level |
| `sourceRecordGroupId` | string, 512 | Same segment/day group as top level |
| `acquisitionSessionId` | string, 256 | Same acquisition as `sessionId` |
| `deviceScopeId` | string, 256 | Same opaque scope as `deviceId` |
| `deviceModel`, `firmwareVersion`, `sdkVersion` | string, 256 each | Exact source qualification scope |
| `semanticPolicyVersion` | string literal | `jcvital.type24.daily_activity.v1` or `jcvital.type25.minute_anchor.v1` |
| `normalizerVersion` | string literal | `jcvital.activity.production.v1`, the v65 oracle |
| `sourcePayloadFingerprint` | string, 64 lowercase hex | SHA-256 of JSON original source record with top-level keys sorted ASCII; raw values preserved |
| `canonicalPolicy` | string literal `NATIVE_ONLY` | Legacy-safe default; only explicit r7 v2 dispatch may qualify |
| `sourceField` | string literal | Same as `vendorField` |
| `vendorRawValue` | string, 512 | Exact `String(original field)` before numeric normalization |
| `vendorDerived`, `measured` | boolean each | Explicit semantic flags, not derived from unit/name |
| `canonicalEligible` | boolean | Qualification hint, not trusted server authorization |
| `semanticConfidence` | string literal | `HIGH`, `VENDOR_DERIVED`, `SOURCE_ONLY`, or `WITHHELD` |

The qualified Android record schema is flat: date/scalar fields and Type25
`arraySteps` (integer array or SDK whitespace-separated string). The fingerprint
is an identity/integrity hint, not a cryptographic attestation by the device;
the server must independently validate semantic fields. Native raw-source storage
should preserve the complete received object and authenticated ancestry.

### 3.3 Type24 fields and units

| Source field | Transport metric | Unit | Canonical metric | Derived / measured |
|---|---|---|---|---|
| `step` | `DAILY_STEPS` | count | `DAILY_STEPS` | false / true |
| `distance` | `DAILY_DISTANCE` | km | `DAILY_DISTANCE` | true / false |
| `calories` | `DAILY_CALORIES` | kcal | `DAILY_CALORIES` | true / false |
| `exerciseMinutes` | `DAILY_EXERCISE_DURATION` | second | `EXERCISE_DURATION` | true / false |
| `goal` | `DAILY_GOAL_COMPLETION` | UNKNOWN_VENDOR_UNIT | none; source-only | false / false |

Missing optional source scalars are omitted; do not synthesize them. Invalid
present scalar values cause an explicit contract error, not a success-shaped
fallback. Exercise seconds/steps must be safe integers. Distance/calories/goal
must be nonnegative finite numbers within the bound above.

Additional conditional Type24 metadata:

| Field | JSON type / maximum | Presence / meaning |
|---|---|---|
| `rawUnit` | string literal `second` | Exercise duration only |
| `normalizedMinutes` | finite number <= 9007199254740991 / 60 | Exercise duration only: raw seconds / 60; no integer rounding |
| `semanticLabel` | string literal | Exercise: `V8 Exercise Duration`; calories: `Activity Calories / Activity Energy` |

Preserve `valueNumber` exactly as raw Android seconds, plus original
`vendorRawValue`. In canonical provenance expose
`vendor_exercise_duration_seconds = valueNumber` and
`vendor_exercise_duration_minutes = valueNumber / 60`.
For 1537 seconds the decimal is **25.616666666666667**, not 1537 minutes,
25 integer minutes, MVPA, active minutes, or training load.
No mapping is added for `ExerciseTime` or iOS `activeMinutes`.

### 3.4 Type25 segment carrier and additional metadata

Continue scalar `DETAILED_ACTIVITY_EPOCH` (`arraySteps[i]`, count),
`DETAILED_ACTIVITY_STEPS_TOTAL` (`detailMinterStep`, count), and supporting
`DETAILED_ACTIVITY_DISTANCE`/`DETAILED_ACTIVITY_CALORIES`
(`UNKNOWN_VENDOR_UNIT`). Supporting fields are never daily authority.

The **slot-zero DETAILED_ACTIVITY_EPOCH** is the sole normal segment anchor.
Only it has the complete evidence fields below. Other slots retain integrity
status, but `segmentAnchor=false` and `canonicalEligible=false`; the server must
not expand a segment once per scalar slot. For an empty invalid array only,
`DETAILED_ACTIVITY_STEPS_TOTAL` carries the evidence with `segmentAnchor=true`
and `canonicalEligible=false`; no fabricated zero epoch is emitted.

| Field | JSON type / maximum | Presence / meaning |
|---|---|---|
| `type25IntegrityStatus` | string literal `PASS` / `FAIL` | All Type25 objects |
| `type25ArraySum` | nonnegative safe integer | PASS only; sum of all ten steps |
| `type25IntegrityReason` | string, 512 | FAIL only; explicit policy/integrity reason from oracle policy |
| `segmentAnchor` | boolean | All Type25 objects; only designated carrier true |
| `type25VendorDate` | string, 19 | Anchor: exact original `Type25.date` |
| `type25DetailMinterStep` | string <= 512 or nonnegative safe integer | Anchor: original SDK representation, parsed independently by server |
| `type25ArraySteps` | string, 512 | Anchor: complete comma-separated base-10 integers, no spaces or truncation |
| `type25ArrayLength` | nonnegative integer <= 512 | Anchor: actual slot count; 10 required for qualification |
| `semanticPolicy` | string literal `jcvital.type25.minute_anchor.v1` | Anchor |
| `dateMeaning` | string literal `FIRST_MINUTE` | Anchor |
| `arrayOrdering` | string literal `OLDEST_TO_NEWEST` | Anchor |
| `slotDurationSeconds` | integer literal 60 | Anchor |
| `segmentSlots` | integer literal 10 | Anchor |

Ten maximum-safe integers require only **169 characters** (ten 16-digit values
plus nine commas), well below 512. Invalid-length arrays are retained completely
when representable. Negative, fractional, unsafe or malformed step tokens, invalid
dates/timezones, or oversized representations throw `ActivityTransportContractError`.
The caller must preserve the original source, report that explicit error and
enqueue **none** of that preparation result. The function returns only after all
payloads validate; it cannot partially enqueue. Do not catch and silently drop,
shorten evidence, or send only expanded minutes.

The server must independently:

1. Verify exact version, deviceModel **PRO_V8**, SDK **v8sdk2.0**, firmware **0.0.8.8**,
   and qualified policy constants. Future scope changes require regression qualification.
2. Parse the complete comma array; require exactly 10 nonnegative safe integers.
3. Require declared length=10 and independently sum all slots; require equality
   with original `detailMinterStep`, supplied sum, and PASS status.
4. Resolve original local vendor date using source timezone, with no receipt-time fallback.
5. Expand `DETAILED_ACTIVITY_MINUTE_STEPS` at
   `Type25.date + i * 60 seconds`, i=0..9. Preserve original seconds, not rounded
   clock-minute boundaries.
6. Otherwise preserve source and explicit withheld reason, emit no canonical minutes.

For `2026.10.20 10:28:53`, America/Los_Angeles, array
`10,0,0,0,0,0,0,0,0,0`, declaration 10: UTC slots are
`2026-10-20T17:28:53.000Z` through `2026-10-20T17:37:53.000Z`.
Do not create absent segments or synthesize zeros between records.

## 4. Identities, replay, correction, authority, and provenance

Source group identity:

```text
JCVITAL_NATIVE:{deviceModel}:{opaqueDeviceId}:{sourceDataType}:{originalVendorDate}
```

Scalar/slot identity appends `|{metric}|record` or `|{metric}|{slotIndex}`.
`observationId` hashes
`{authenticatedOwner}:{sourceRecordId}:{sourcePayloadFingerprint}:{transportVersion}`.
Receipt/envelope changes do not create a new delivery identity for the same source
record/payload. Changed payload does create a new ID, retaining source identity
and allowing conflict detection rather than overwriting.

Server daily canonical identity must be authenticated owner + device + provider/
source + **sourceLocalDate** + canonical metric. Current local day is IN_PROGRESS,
older days FINAL. Repeated reads/corrections update that identity, retaining source
ancestry. Determine "today" in the captured timezone, not server UTC.

Minute canonical identity must include owner/device + source group/record identity
+ resolved timestamp/slot + metric. For the same vendor date and byte-equivalent
source-record representation, replay is idempotent. Same date with different
payload: preserve both source records, mark source conflict, keep the accepted
canonical minute values pending explicit resolution; do not silently replace them.
Use atomic unique indexes/transactions for server upsert/conflict handling.

Type24 alone supplies authoritative daily values. Type25 supporting totals,
distance and calories never replace/sum into them. `goal` stays source-only.
Direct **JCVITAL_NATIVE > ROOK** applies only with evidence linking the same
underlying V8 measurement. Keep both raw sources; canonicalize once. Different
wearables must never be suppressed. Do not introduce a speculative cross-provider
linking heuristic; use verified shared measurement identity.

Every persisted canonical row must retain metric/value/unit plus provider,
connector, device scope/model/FW/SDK, source type/field/envelope/record/group,
acquisition session, original local date/time, timezone/timezone source, semantic
policy, normalizer, confidence, vendorDerived and measured. Type25 additionally
retains original vendor date, source slot index, resolved timestamp, and the
minute-anchor policy. The fixture's full expected v65 output provides the
reference shape; server database-specific IDs may differ, not semantics.

## 5. Exact generated examples

These objects are copied from the fixture's first scenario. The fixture is
authoritative for complete batched examples and expected canonical output.
The next payload demonstrates authoritative raw seconds and decimal minutes:

```json
{
  "observationId": "5770b90d4afbd2252a41f3606729083b9d2c689bbdc5d4a7a696730f2557d830",
  "source": "jcvital_native",
  "provider": "JCVITAL",
  "sourceConnector": "JCVITAL_NATIVE",
  "sourceProvider": "JCVITAL",
  "sourcePath": "DIRECT_BLE",
  "deviceManufacturer": "JCVital",
  "deviceId": "jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b",
  "sourceId": "jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b",
  "deviceModel": "PRO_V8",
  "firmwareVersion": "0.0.8.8",
  "sdkVersion": "v8sdk2.0",
  "metric": "DAILY_EXERCISE_DURATION",
  "metricType": "DAILY_EXERCISE_DURATION",
  "valueNumber": 1537,
  "unit": "second",
  "startTime": "2026-10-20T07:00:00.000Z",
  "observedAt": "2026-10-20T07:00:00.000Z",
  "observedAtSource": "2026.10.20",
  "capturedAt": "2026-10-20T22:00:00.000Z",
  "receivedAt": "2026-10-20T22:00:00.000Z",
  "timezone": "America/Los_Angeles",
  "timestampSource": "TYPE24_DEVICE_LOCAL_DATE",
  "timestampConfidence": "DEVICE_LOCAL_CALENDAR_DATE",
  "timestampTimezoneSource": "PHONE_TIMEZONE",
  "acquisitionMode": "HISTORICAL_SYNC",
  "measurementContext": "DAILY_ACTIVITY",
  "sessionId": "fixture-session-p1-2d",
  "sourceRecordId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:24:2026.10.20|DAILY_EXERCISE_DURATION|record",
  "sourceRecordGroupId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:24:2026.10.20",
  "vendorDataType": "24",
  "vendorField": "exerciseMinutes",
  "vendorDerived": true,
  "rawSourceMetadata": {
    "activityTransportVersion": "jcvital.native.activity.transport.v2",
    "sourceDataType": 24,
    "sourceLocalDate": "2026-10-20",
    "timezone": "America/Los_Angeles",
    "timezoneSource": "PHONE_TIMEZONE",
    "sourceEnvelopeId": "fixture-type24",
    "sourceRecordGroupId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:24:2026.10.20",
    "acquisitionSessionId": "fixture-session-p1-2d",
    "deviceScopeId": "jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b",
    "deviceModel": "PRO_V8",
    "firmwareVersion": "0.0.8.8",
    "sdkVersion": "v8sdk2.0",
    "semanticPolicyVersion": "jcvital.type24.daily_activity.v1",
    "normalizerVersion": "jcvital.activity.production.v1",
    "sourcePayloadFingerprint": "9ccadc5c87c5c41ce5a4018d031b7ec5ecd98a7e5d6c85760d2f2f53e6045ae7",
    "canonicalPolicy": "NATIVE_ONLY",
    "sourceRecordId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:24:2026.10.20|DAILY_EXERCISE_DURATION|record",
    "sourceField": "exerciseMinutes",
    "vendorRawValue": "1537",
    "vendorDerived": true,
    "measured": false,
    "canonicalEligible": true,
    "semanticConfidence": "VENDOR_DERIVED",
    "rawUnit": "second",
    "normalizedMinutes": 25.616666666666667,
    "semanticLabel": "V8 Exercise Duration"
  }
}
```

The exact complete ten-slot Type25 anchor:

```json
{
  "observationId": "270841b54d61eb9fb6b3ebecef617d3bb6d903e91b6ebeeb16d29991653f0954",
  "source": "jcvital_native",
  "provider": "JCVITAL",
  "sourceConnector": "JCVITAL_NATIVE",
  "sourceProvider": "JCVITAL",
  "sourcePath": "DIRECT_BLE",
  "deviceManufacturer": "JCVital",
  "deviceId": "jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b",
  "sourceId": "jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b",
  "deviceModel": "PRO_V8",
  "firmwareVersion": "0.0.8.8",
  "sdkVersion": "v8sdk2.0",
  "metric": "DETAILED_ACTIVITY_EPOCH",
  "metricType": "DETAILED_ACTIVITY_EPOCH",
  "valueNumber": 10,
  "unit": "count",
  "startTime": "2026-10-20T17:28:53.000Z",
  "observedAt": "2026-10-20T17:28:53.000Z",
  "observedAtSource": "2026.10.20 10:28:53",
  "capturedAt": "2026-10-20T22:00:00.000Z",
  "receivedAt": "2026-10-20T22:00:00.000Z",
  "timezone": "America/Los_Angeles",
  "timestampSource": "TYPE25_DATE_PLUS_SLOT_MINUTES",
  "timestampConfidence": "MANUAL_ADJUDICATED_PHYSICAL_HIGH_CONFIDENCE",
  "timestampTimezoneSource": "PHONE_TIMEZONE",
  "acquisitionMode": "HISTORICAL_SYNC",
  "measurementContext": "DETAIL_ACTIVITY_BLOCK",
  "sessionId": "fixture-session-p1-2d",
  "sourceRecordId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:25:2026.10.20 10:28:53|DETAILED_ACTIVITY_EPOCH|0",
  "sourceRecordGroupId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:25:2026.10.20 10:28:53",
  "vendorDataType": "25",
  "vendorField": "arraySteps",
  "vendorDerived": false,
  "sequenceNumber": 0,
  "samplingIntervalMs": 60000,
  "rawSourceMetadata": {
    "activityTransportVersion": "jcvital.native.activity.transport.v2",
    "sourceDataType": 25,
    "sourceLocalDate": "2026-10-20",
    "timezone": "America/Los_Angeles",
    "timezoneSource": "PHONE_TIMEZONE",
    "sourceEnvelopeId": "023d885d-bfec-40d2-823c-bb36b8553407",
    "sourceRecordGroupId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:25:2026.10.20 10:28:53",
    "acquisitionSessionId": "fixture-session-p1-2d",
    "deviceScopeId": "jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b",
    "deviceModel": "PRO_V8",
    "firmwareVersion": "0.0.8.8",
    "sdkVersion": "v8sdk2.0",
    "semanticPolicyVersion": "jcvital.type25.minute_anchor.v1",
    "normalizerVersion": "jcvital.activity.production.v1",
    "sourcePayloadFingerprint": "ef8a3e0b4238e28e9657fc977f5f57486d5782324eca071dc56c4ef9a5b62edf",
    "canonicalPolicy": "NATIVE_ONLY",
    "sourceRecordId": "JCVITAL_NATIVE:PRO_V8:jcvital_device_3f2b8c1e-9a4d-4b6e-8f10-2c3d4e5f6a7b:25:2026.10.20 10:28:53|DETAILED_ACTIVITY_EPOCH|0",
    "sourceField": "arraySteps",
    "vendorRawValue": "10 0 0 0 0 0 0 0 0 0",
    "type25IntegrityStatus": "PASS",
    "type25ArraySum": 10,
    "type25VendorDate": "2026.10.20 10:28:53",
    "type25DetailMinterStep": "10",
    "type25ArraySteps": "10,0,0,0,0,0,0,0,0,0",
    "type25ArrayLength": 10,
    "semanticPolicy": "jcvital.type25.minute_anchor.v1",
    "dateMeaning": "FIRST_MINUTE",
    "arrayOrdering": "OLDEST_TO_NEWEST",
    "slotDurationSeconds": 60,
    "segmentSlots": 10,
    "segmentAnchor": true,
    "canonicalEligible": true,
    "vendorDerived": false,
    "measured": true,
    "semanticConfidence": "HIGH"
  }
}
```

## 6. Offline acceptance matrix and server requirements

| Fixture scenario | Required outcome |
|---|---|
| Type24 current day + qualified Type25 | 4 daily rows, 10 minutes; steps 4321, distance 12.345 km, calories 153.47 kcal, duration 1537 seconds / 25.616666666666667 minutes |
| Type24 same-day correction | Same four daily identities; updated values; both source ancestries |
| Historical replay | Four FINAL rows, no duplicate canonical rows |
| Type25 exact replay | Ten rows, DUPLICATE outcome, no duplicate epochs |
| Type25 conflicting same-date payload | Both raw records retained; CONFLICT_PRESERVED, accepted ten rows unchanged |
| Invalid array length | FAIL / ARRAY_LENGTH_NOT_10, no canonical minutes |
| Sum mismatch | FAIL / SUM_ARRAY_STEPS_NE_DETAIL_MINTER_STEP, no canonical minutes |
| Missing middle segment | Only twenty returned slots, no generated gap minutes |
| Type25 large supporting totals | No change to any Type24 authoritative daily value |

Local tests reconstruct source values from outgoing wire fields and compare the
resulting v65 canonical records/withheld reasons with the original-source oracle.
They also check deterministic regeneration of the entire checked-in fixture.
The existing WebQueueStore schema remains **8**; tests exercise the existing
queue and batch sender under mocked registration/auth/network, including exact
replay, retry and duplicate ACK. They do not constitute a deployed-server test.

Base44 must implement the same matrix in its own non-production harness, including
authenticated owner isolation, atomic upsert/replay/conflict persistence, complete
provenance, mixed legacy/v2 batches, and regression tests for all non-Activity paths.
Do not advertise capability until those tests pass. No change is authorized to
HR, SpO2, temperature, Type42, PPI, sleep, Workout29, Live82, readiness, scoring,
training load, Digital Wellness, queue ordering, ACK/retry/batching/purge behavior,
sender concurrency, or the existing endpoint.

## 7. Fail-closed capability gate

Use the existing **nativeConnectorRegister** success response, not a new polling
endpoint or sender. The current production response advertises the capability as
an exact token in the `capabilities` array:

```json
{
  "success": true,
  "installId": "existing-install-id",
  "connectorDeviceId": "existing-registered-connector-id",
  "status": "active",
  "registeredAt": "2026-10-23T18:59:55.503Z",
  "serverTimestamp": "2026-10-23T18:59:55.503Z",
  "sources": ["JCVITAL"],
  "capabilities": ["JCVITAL_ACTIVITY_TRANSPORT_V2"]
}
```

The Activity V2 gate requires a successful active/registered response, valid
registration timestamps and sources, exact install/connector identity, matching
authenticated owner/install/connector scope, the expected production registration
environment, a fresh response, and the exact capability token. The capability
identifier itself selects this transport; `responseContractVersion`,
`deploymentRevision`, and a separate `activityTransport` field are not required
by the current production registration response.

The registration service now persists and logs the result of
`activityV2CapabilityDecision`. It verifies:

- Successful active/registered response with valid registration timestamps and
  sources, plus exact current install/connector identity.
- Captured authenticated owner/install/connector scope still equals current scope.
- The expected production registration URL/environment and exact capability token.
- A finite handshake receipt time no more than five minutes old, not in the future.
- Exact capability is required to enable production delivery.

The decision is scoped to the authenticated owner, install and connector IDs.
Missing, unknown, malformed or stale capability responses fail closed; legacy
Activity behavior remains unchanged. Engineering diagnostics show the persisted
decision. No revision-name inference is used.

The existing sender intentionally delivers the payload it is given. Capability
loss does not rewrite or purge already-durable queue items. Server rollback must
retain v2 raw-source acceptance/ACK compatibility or first drain/hold outstanding
v2 delivery under a separately reviewed rollout.

## 8. Release and stop conditions

1. Base44 r7 is already live and verified per the project owner. This Companion
   pass does not change or republish Base44.
2. Validate the v66 Companion build, package identity and signer before install.
3. The saved-evidence verification action is manual after installation; it is
   not run during build and must not acquire Activity over BLE.
4. Workout29/82 remains a separate later phase.

The v65 APK remains unchanged and provides the signer identity for comparison:

```text
versionCode = 65
versionName = 1.0.0-phase1-p1-2c-activity-production-final
SHA-256 = f919fcf1dcb528b9cd44fab599f1af0e6c9f430b56a8c5054fb0e6b6402a4856
Signer certificate SHA-256 = 3ec2c0e680eafa236b20fdee3b16305135ae54914d4711379c41b654ee7cb697
```
