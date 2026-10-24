# JCVital V8 adapter

## V50 / Build 32B.13: Engineering queue composition (read-only)

Engineering builds expose local pending-queue counts by metric, vendor data type,
sync/acquisition provenance and requested metric, along with capture-time bounds,
attempt counts, distinct IDs, and duplicate durable observation-ID rows. When the
latest v49 receipt is available, the view reports rows associated with its sync ID,
their FIFO position relative to older pending rows, and preceding Heart Rate rows.
Composition reads use local SQLite/IndexedDB only; they do not acquire, enqueue, claim,
reorder, deliver, or remove observations. The composition query adds no indexes or
schema changes. Rolling observations/batches per minute and average batch latency come
from successfully acknowledged sender batches; estimated drain time is pending rows
divided by measured observations per minute, and remains unavailable before samples
exist. Android Engineering package version is `50` / `1.0.0-rc6.3-queue-observability`;
the athlete build remains version `49`.

## Build 32B.12 / v49: capture provenance and delivery safety

Production receipts now persist per-metric acquisition lifecycle, request and sync
identifiers, connection generation, and per-observation local provenance. Provenance
is stored in the queue's local metadata (SQLite/IndexedDB), is retained when claims are
retried or recovered after restart, and is not included in the Base44 observation body.
`acquisition_request_id` is bound to the native lifecycle/result `syncId`, and the same
identifier is retained with the native sync evidence and each queued observation.
Receipt v1 data is read through a local compatibility mapping; viewing receipt details
does not start acquisition or delivery.

Engineering progress omits unrequested metrics. Server ACCEPTED/DUPLICATE results are
ACKed per observation; missing or ambiguous per-observation results remain retryable.
ACKed rows are purged only after their durable ACK state exists, including safe cleanup
of ACKed leftovers during startup. These changes do not modify canonical identity,
Type27 parsing, Source Journal semantics/capacity, Base44 scoring, or the HTTP contract.

## Build 32B.11 / v47: metric-scoped production sync

The normal athlete **Sync Device Data** request remains Heart Rate, Blood Oxygen and
Temperature. Engineering builds can select a metric subset, including the physical
acceptance action **Test SpO₂ + Temperature**; that selection uses the same production
acquisition, mapping, source journal, durable queue, sender, ACK and purge path. It does
not invoke historical Heart Rate / Type27.

Per-source receipts retain the requested/bridge/native-command/acquisition lifecycle
independently, along with source and observation counts, mapping/deduplication, delivery,
ACK, failure and explicit skip reasons. The latest receipt is stored with the durable
queue store (SQLite on Android and IndexedDB on web), and the Engineering-only receipt
view renders that persisted receipt locally. Sharing is optional and does not control
receipt persistence or visibility.

The v46 Type27 ingress isolation and request ownership, BLE discovery/matching, GATT and
READY handshake, source-journal semantics and 256 MiB policy, durable queue, sender/ACK/
purge behavior, Base44 contract, and canonical/scoring behavior are unchanged.

## Build 32B.10 / v46: Type27 isolation

Production historical HR is acquired only by explicit **Sync Device Data**. Type27 ingress
(wire opcode `0x54`, not GetDeviceVersion's `0x27`) requires a live ACQUIRING request
matching request ID, account, opaque device scope and connection generation. Authorization
precedes raw notification journaling and SDK parsing, including while PPG certification
owns the link. Unsolicited/trailing HR has no payload envelopes, normalization or delivery.
Only constant-space process-lifetime counters (count, first/last time, last reason/generation)
are retained and exposed in Connection Diagnostic; these counters reset on process restart.

HR start/continuation commands carry the same ownership and are revalidated immediately
before GATT write. Ending acquisition purges unissued commands. Recovery and reconnect
never restart HR. Authorized callbacks retain their original bytes and all source records;
continuation remains every 50 packets, and existing scalar dedup/delivery is unchanged.
Other vendor families retain their existing behavior.

Production retains all existing source envelopes and sequences, with a 256 MiB byte budget
and 100,000 envelope limit after the Type27 regression gate passes. Pressure recovery
requires reconciled accounting, no pending journal transaction, existing integrity/account/
device/filesystem gates, and at most 80% utilization of **both** effective byte and envelope
limits (20% operational headroom). Filesystem headroom remains at least four times the
effective byte budget and at least 512 MiB. Recovery history is appended in preferences,
not journal envelopes: legacy `recoveryAudit` remains unchanged, `recoveryAuditHistory`
includes it plus later recoveries, and `latestRecoveryAudit` identifies the newest recovery.
Blocked recovery does not mutate preferences or retained journal rows. No deduplication,
compaction, archival, deletion, Base44 or scoring changes are included.

## VC29: one-shot physical Raw PPG certification

VC28 proved the earlier PPG evidence unrecoverable (no spool, no journal rows, no notifications/callbacks/
command requests). VC29 authorizes exactly one new physical capture per account/device. Activity, Sleep,
Workout, PPI, Type42 and Type82 paths are unchanged; no Base44 code is touched.

Exact vendor command (`BleSDK.ppgWithMode(mode, 0)`, opcode `0x78` = vendor `CMD_Get_Bloodsugar`, 16-byte
frame, byte 15 = sum & 0xFF), written to the V8 write characteristic; data arrives on opcode `0x3A`:

| Role  | Mode | Bytes            | SHA-256 |
|-------|------|------------------|---------|
| START | 1    | `78 01 00×13 79` | `2e482bde5cfd7838a98a3461ba04129592235acdeb5d363385455e34874c65c3` |
| STOP  | 3    | `78 03 00×13 7B` | `624a371897b2dca244bb8dc0673b65b585cfdbd0cab91bd80cc69e99607392e0` |
| QUIT  | 5    | `78 05 00×13 7D` | `b29369d5fa94dcfec94de8eecd323d356233d65e45fa126461ae0f639fb4b341` |

`RawPpgCertificationCapture` order: certificationGroupId/sessionId → persisted scope → `PPG_CERTIFICATION_SESSION_OPEN`
journal envelope → durable spool registered → attempt claim + ACQUIRING snapshot (one SQLite transaction) →
`PPG_COMMAND_REQUEST` envelope (exact bytes, SHA-256, opcode, mode, characteristic) → BLE write →
`PPG_COMMAND_WRITE_ACK`/`_FAILED` (parent = request) → each notification journaled, then spooled, then parsed →
every SDK callback and parser outcome journaled → START, 20 s capture, STOP, QUIT, 2 s drain →
`PPG_CERTIFICATION_TERMINAL` → verification → final immutable snapshot. No retries; a partial failure preserves
evidence, sends at most one journaled QUIT (only if the link is alive) and finalizes `NOT_CERTIFIED`. The claim
survives restart and blocks any second capture until a future engineering build supersedes it. Legacy Start PPG
is disabled.

The waveform is `RESEARCH_NATIVE_ONLY`, `NONE_UNTIL_SEMANTICS_CONFIRMED`, `UNKNOWN_VENDOR_UNIT`, sample rate and
interval `null`, `LOCAL_SOURCE_EVIDENCE_ONLY`. `RAW_PPG_NOT_GLUCOSE`, `NO_GLUCOSE_CANONICAL_MAPPING`,
`NO_GLUCOSE_INFERENCE`, `NO_CGM_SUBSTITUTION`: "Bloodsugar" is only the vendor protocol label. The historical
20-packet / 3,774-byte shape is reported for comparison only; the new capture is authoritative.

Inspect / Show / Copy / Share JSON / Share Raw Spool are offline (0 BLE, 0 network, 0 acquisition).

## VC26: saved VC25 physical framing repair

**VENDOR_SDK_TYPE29_MULTI_RECORD_STRIDE_BUG** is confirmed by the saved physical
80-byte notification, SDK source, bundled JAR bytecode, and an Android regression
that reproduces every original SDK field. Physical boundaries are 0-25, 26-51,
52-77, followed by `5C FF` at 78-79. SDK stride is 25, not 26; its terminal check
also inspects byte 76 rather than 79. The actual callback retains `dataEnd=false`
and acquisition `PARTIAL`, although the parser-outcome envelope is `COMPLETE`.

| Physical frame offset | Interpretation |
| --- | --- |
| 0 | Opcode `5C` |
| 1-2 | Index bytes consistent with uint16 little-endian sequence 0, 1, 2 |
| 3-8 | Vendor hexadecimal timestamp pairs: year suffix, month, day, hour, minute, second |
| 9 | Unsigned `sportModel`, unmapped |
| 10 | Unsigned `heartRate`, statistic unknown |
| 11-12 | uint16 little-endian `ExerciseTime`, physical unit unconfirmed |
| 13-14 | uint16 little-endian `step` |
| 15-16 | Two unsigned `sportModelSpeed` bytes formatted `MM'SS"`, unit/denominator unknown |
| 17-20 | IEEE-754 float32 little-endian `calories` |
| 21-24 | IEEE-754 float32 little-endian `distance` |
| 25 | Preserved unknown trailer: `4E`, `DE`, `1D`; checksum algorithm NOT proven |

The vendor's additive command checksum does **not** validate these record
trailers. No record checksum is claimed. Index endianness is consistent with
this captured sequence, not proven as a general high-index protocol contract.

`Finalize Saved Workout History Certification` is pinned to the original
certificationGroupId/session and exact packet base64/SHA-256. It validates saved
entries against the local journal, source ancestry, COMPLETE parser outcome,
all original SDK values against a 25-byte-stride interpretation, and frame 0
against the aligned SDK record. It writes only the local certification snapshot.
Native persistence accepts this offline transition only if the complete embedded
original STOPPED snapshot matches the existing snapshot; capture is not enabled.
It performs zero BLE commands, acquisition, Base44 calls, enqueue, delivery or
canonicalization. Activity, Sleep, PPI, Type 42 and live Type 82 are unchanged.

Final state is `CERTIFIED`, sourceStatus `CERTIFIED_E2E_LOSSLESS_SOURCE`.
The original stopped snapshot, partial acquisition, callback, records and raw
bytes remain unchanged. Separate `SDK_RECORD_ORIGINAL` and
`PHYSICAL_WIRE_RECORD` representations carry explicit relationships:
record 0 matches; records 1-2 are `SDK_MULTI_RECORD_PARSE_MISALIGNED`.
Packet/frame hashes and exact float32 values accompany vendor-formatted strings.
Inspection/export revalidate after restart, without reacquisition.

Recovered records (no unit claims):

| Index | Vendor timestamp | HR | ExerciseTime | step | sportModelSpeed | calories float32 (vendor format) | distance float32 (vendor format) | mode |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | 2026.09.15 16:23:49 | 125 | 1474 | 274 | `00'00"` | 65.4618911743164 (65.5) | 0 (0) | 0 |
| 1 | 2026.09.15 16:15:45 | 116 | 472 | 201 | `62'32"` | 20.402727127075195 (20.4) | 0.12578701972961426 (0.13) | 0 |
| 2 | 2026.09.14 15:24:10 | 110 | 600 | 536 | `00'00"` | 16.65451431274414 (16.7) | 0 (0) | 9 |

All semantics remain `RESEARCH_NATIVE_ONLY`;
`canonicalAuthority=NONE_UNTIL_SEMANTICS_CONFIRMED`.
METS remains `SDK_FIELD_NOT_EXPOSED`. The vendor JAR is untouched.
The following VC25 description records the original assumptions; its 25-byte
framing validator is **not physical authority** and is not used by VC26 repair.

## VC25: Workout / Exercise History source-only certification

Activity 24/25 and Sleep 26/121 are closed certification paths. VC25 does not
reacquire, modify, or reopen them. The validated live Type 82 ~1 Hz workout HR
path is unchanged. This release adds a separate local history question.

### SDK inspection (before implementation)

The installed Android `v8sdk2.0.jar` factory is
`com.jstyle.blesdkv8.Util.BleSDK.GetActivityModeDataWithMode(byte)`. It produces a
16-byte command: opcode **0x5C**, mode at byte 1, zeros at bytes 2-14, additive
checksum at byte 15. Read starts with **0x00**; continuation is **0x02** after
50 matching callbacks. Mode **0x99** deletes history and returns Type 88;
certification never sends that mode. The single read dataType is **"29"**
(`BleConst.GetActivityModeData`), not 24/25 or 82.

`BleSDK.DataParsingWithData(byte[], DataListener2301)` dispatches 0x5C to
`com.jstyle.blesdkv8.other.ResolveUtil.getExerciseData(byte[])`, then
`DataListener2301.dataCallback(Map)`. The callback contains `dataType`,
`dataEnd`, and `dicData` (a list of record maps). There is no dedicated
historical workout model/factory class: the command factory and parser maps
are the source. The sample `ExerciseHistoryDataActivity` implements 50-callback
pagination; `ActivityModeDataAdapter` displays the following eight fields.

| Exact SDK key | Parser evidence / vendor sample claim | Certification confidence |
| --- | --- | --- |
| `date` | Bytes 3-8 at SDK's erroneous 25-byte stride; `yyyy.MM.dd HH:mm:ss` | Exact vendor string; start vs end role and timezone unknown |
| `sportModel` | Byte 9, unsigned, rendered as string | SDK mode table only; unknown codes retained without mapping |
| `heartRate` | Byte 10, unsigned, rendered as string; sample says bpm | Statistic unknown: not proven average, last, minimum, or maximum |
| `ExerciseTime` | Bytes 11-12, integer string; sample says seconds | Physical meaning/unit unconfirmed |
| `step` | Bytes 13-14, integer string; sample displays steps | Physical count semantics unconfirmed |
| `sportModelSpeed` | Bytes 15-16 formatted as `MM'SS"`; sample calls it pace | No asserted denominator or speed/pace unit |
| `calories` | Bytes 17-20 decoded as float, SDK-formatted string; sample says kcal | Preserve locale/format; physical unit/meaning unconfirmed |
| `distance` | Bytes 21-24 decoded as float, SDK-formatted string; sample says km | Preserve locale/format; physical unit/meaning unconfirmed |

The SDK exposes no separate start/end timestamps, average HR, maximum/minimum
HR, METS, separate speed, laps, or training load. No end time, duration
conversion, HR stream, METS estimate, or other derived value is constructed.
Android METS exposure is **SDK_FIELD_NOT_EXPOSED**. If physical callbacks have
no METS field/value, evidence records **ANDROID_WORKOUT_METS_NOT_OBSERVED**.
If an additional MET/METS SDK callback key is present with only null values,
that is separately reported as **SDK_FIELD_PRESENT_PHYSICAL_VALUE_NOT_OBSERVED**,
rather than fabricating a number. Additional original fields remain lossless
and have unknown semantics.

There is no JCVital iOS vendor SDK or native implementation in this repository;
iOS command/parser/field parity is **not established**, not assumed. Type 82
uses its existing live exercise callback and a separate native live session.
Type 29 has no emitted session identifier linking it to that session and no
per-second HR array. The relationship is
**UNKNOWN_NO_SESSION_LINK_OR_STREAM_RECONSTRUCTION_PROVEN**. Similar mode,
timestamp, or HR values do not establish a link.

### Lossless source and completion contract

The dedicated `syncWorkoutHistoryCertification` path bypasses the legacy workout
normalizer. It retains each raw BLE notification **before invoking the SDK**,
each typed callback and SDK record **before copying/normalization**, and a
parser-outcome envelope. The native source observation embeds the complete
typed SDK record as JSON, with source record/callback/index/session identifiers
and the original vendor timestamp. It is not a canonical `NativeObservation`
and is never emitted to the delivery listener. No filtering, aggregation,
sampling, dedupe, unit conversion, or canonicalization occurs. Repeated records
receive distinct source IDs and remain in callback/record arrival order.

Command-request bytes and successful GATT-write acknowledgements are journaled
with hashes, lengths, and ancestry. Saved certification validates those commands,
all history notification IDs, callbacks, records, native observations, parser
outcomes, hashes, byte lengths, firmware/SDK/device scope, source ordering, and
50-callback pagination. Successful commands are distinct from merely queued
requests. Any parse error, timeout, missing callback, rejected/deduped record,
retry, or source mismatch prevents certification and retains a STOPPED attempt.

**Important SDK caveat:** `getExerciseData` marks any input shorter than 25 bytes
as `dataEnd=true`, even if it has no terminal marker. VC25 therefore requires
complete 25-byte records (the incorrect VC25 assumption), optionally followed by the exact `5C FF` terminal
marker. A standalone `5C FF` with an empty SDK list is valid empty history.
Malformed/short frames without that marker cannot close as valid empty.

Populated history closes as **CERTIFIED E2E / LOSSLESS CERTIFIED** only after
lossless ancestry validation. A valid empty physical response closes as
**CERTIFIED_WITH_LIMITATION**, limitation
**PHYSICAL_WORKOUT_HISTORY_VALID_BUT_EMPTY**; empty is not a failure.
These are source/native claims only:
`canonicalAuthority = NONE_UNTIL_SEMANTICS_CONFIRMED`,
`deliveryDisposition = LOCAL_SOURCE_EVIDENCE_ONLY`, and original fields remain
`RESEARCH_NATIVE_ONLY` / `UNKNOWN_VENDOR_SEMANTICS`.

### Controls, persistence, and physical run

- **Capture Workout History Certification** persists ACQUIRING before BLE.
  A device/account-scoped native acquisition claim permits only one physical
  attempt, including across app restart and interrupted acquisition. Saved
  attempts disable the control; there is no reset/retry/delete control.
- **Inspect Saved Workout History Certification** and **Show / Copy / Share
  Workout Certification JSON** revalidate saved local evidence. They make
  **zero BLE/network calls**, even after disconnect/restart. The account-scoped
  local context pointer is only for finding saved evidence; it never authorizes
  offline acquisition. The native read API requires the saved account/device/
  session and does not configure or enable the BLE journal.
- Generic **Sync Workouts** is not offered by VC25; use only the dedicated
  one-shot controls. A saved attempt also blocks the legacy native generic
  workout-history acquisition API. No enqueue/sender/Base44/allowlist/publish
  step is added.
- Overall Strain, Training Readiness, calories, workout/heart-zone totals,
  daily summaries, recovery, and scoring are unchanged.

Build: `ElitePlus-JCVital-certification-v1-vc25.apk`, versionCode **25**,
versionName **1.0-certification-v1-vc25**. Physical outcome is **PENDING_DEVICE_RUN**:
Codespaces tests are synthetic SDK/native proofs, not a physical V8 acquisition.
Install/update the APK without clearing app data, connect the authenticated
Pro V8, capture once, then inspect/export the actual populated or valid-empty
outcome. Do not rerun Activity/Sleep or create/start a live workout as part of
this history certification. Downstream delivery requires a separate explicit VC.

## VC24: Sleep physical source certification and empty-history closeout

The dedicated Sleep control runs one operator session: type26
`BleSDK.GetDetailSleepDataWithMode(0x00, "")` (BLE command 0x53), then type121
`BleSDK.getObtainDetailedSleepData(0x00, "")` (BLE command 0x6B). Existing SDK
pagination uses mode 0x02; certification never uses delete mode 0x99 or retries.
`BleSDK.DataParsingWithData` invokes `DataListener2301.dataCallback(Map)`.
Dispatch is to `ResolveUtil.getSleepData` / `ResolveUtil.getObtainDetailedSleepData`,
then the native normalizer's `sleepStages` / `sleepMovement` respectively.

Type26 SDK fields are original Strings: `date`, `arraySleepQuality`,
`sleepUnitLength` (the parser emits 1 or 5). Normalized views are SLEEP_EPISODE
and SLEEP_STAGE with unknown canonical stage meaning. Type121 fields are
`date`, `sleepLength`, `Sleep_level`, `ActivityData`: bracketed hexadecimal
nibble tokens must not be mistaken for authoritative stage labels or aligned
movement epochs. The existing normalizer emits SLEEP_STAGE_DETAIL_RAW and
SLEEP_MOVEMENT. All SDK strings, unknown/null fields, repeated records, and
complete raw BLE bytes are retained; normalization is not the lossless authority.

The source-only certification has no enqueue, delivery, canonical or scoring
dependency. `canonicalAuthority` remains `NONE_UNTIL_SEMANTICS_CONFIRMED`.
Both paths must complete with exact callback/record links, valid typed lists,
terminal `dataEnd = true`, zero parse/rejection errors and matching counts.
Empty terminal frames must also contain the raw vendor end marker (type26:
0x53 0xFF trailer; type121: 0xFF). Both SDK parsers otherwise classify arbitrary
short frames as empty/end, which is insufficient for formal empty closeout.
An empty normalized array alone cannot certify empty physical history.
Populated history closes as CERTIFIED; only two valid zero-record histories
close as CERTIFIED_WITH_LIMITATION with
PHYSICAL_SLEEP_HISTORY_VALID_BUT_EMPTY. No record or observation is fabricated.

A durable scoped ACQUIRING checkpoint is saved before acquisition. All saved
attempts block repeat capture, including interrupted/failed attempts; inspect
the source journal rather than reacquiring. Native chunked SQLite snapshots
preserve certification across restart. The acquisition report retains the shared
session and any completed first path when the second path fails; `outcome = FAILED`
and an explicit acquisition error cannot close as empty.
Inspect/Show/Copy/Share revalidate saved
BLE -> callback -> SDK record ancestry without acquisition or network.
The Codespaces build cannot perform physical acquisition. The operator must
install VC24, connect the same authenticated device, use Capture Sleep History
Certification once, then inspect/export the actual populated or empty outcome.

## VC23: native-only targets belong to Activity metadata

VC22 incorrectly required `canonicalTarget === null` on saved transport result
objects. The results contract allows that field to be absent; an absent property
was rejected as `CANONICAL_TARGET_INVALID`, hiding the valid DELIVERED event.
VC23 accepts absent or null result targets but rejects any explicit non-null
target. Every exact eligible persisted Activity child must still have
`canonicalTarget === null`; mixed or non-null metadata fails closed before any
mutation. This rule is also applied during saved reconciliation/restart validation.

Diagnostics include `canonicalTargetsNull` and
`selectionCode = VALID_DELIVERED_BATCH_SELECTED` on successful selection.
Tests reproduce omitted result targets with all 17 metadata targets null, empty
ACK bookkeeping and DELIVERED/PARTIAL history, and check rejection of non-null
targets without mutation. Activity remains native-only with
`NONE_UNTIL_SEMANTICS_CONFIRMED`: no canonical/scoring promotion, network,
acquisition, enqueue, redelivery or ID regeneration.

## VC22: server results are input; local acknowledgment is output

VC21's production-event selector already accepted `acknowledgedIds = []`.
However, its pre-finalization shared validator still validated historical local
receipts, including `receipt.acknowledged === event.acknowledgedIds.includes(id)`.
VC22 separates physical/source validation from that local bookkeeping for the
exact Activity repair. Historical receipt disagreements cannot block a verified
production result. Ordinary queue ACK rules and other certification paths are
unchanged. No actual on-device export is included in this repository, so the
specific failed device predicate cannot be inferred from aggregate counts.

Every server-success predicate is evaluated independently for each matching
historical event. Snapshot/scope IDs, persisted contract/revision, source mapping,
queue payload SHA-256 and provenance, certification-only flags and excluded
exerciseMinutes are reported separately. A failed prerequisite throws
`ACTIVITY FINALIZATION FAILED: <exact_code> · <failed predicate>` with valid-event,
validated-result, NativeObservation-ID, queue, payload-match and purge counts.
The UI shows the full structured report. Validation failures do not mutate the
certification or queue; successful diagnostics are retained in exported JSON.

The exact empty-ACK DELIVERED event followed by same-batch PARTIAL history is
tested with 17 FAILED_PERMANENT transport rows and persisted top-level metadata.
The repair first persists each existing NativeObservation ID, accepted result
and separate local ACK plus a pending reconciliation checkpoint. It then purges
only those 17 IDs, appends the completed local reconciliation event, and saves
COMPLETED. A purge failure can resume from the checkpoint after restart without
enqueue or submission. DELIVERED/PARTIAL events and old receipts are not rewritten.
ExerciseMinutes remains preserved/ineligible; canonical and scoring policies
remain unchanged. No Base44 call, acquisition, type24/type25 command, enqueue,
redelivery or observation-ID generation is performed.

## VC21: select authoritative persisted delivery evidence

VC20 incorrectly required exactly one historical event for the production
batch ID, both during finalization and when validating a saved reconciliation.
The real history has a successful `DELIVERED` event followed by a same-batch
`PARTIAL` local ACK failure. Both are valid historical evidence; the latter is
not a new production submission and must not mask the former.

VC21 uses the persisted `Activity24_25CertificationSnapshot.events` array read
by `snapshot()` from the native Activity certification snapshot (or its scoped
storage equivalent). A shared selector filters the exact production batch for
the full `DELIVERED` 17/17 native-only contract, including null per-result reason
and error code. It validates the snapshot's persisted contract/revision without
consulting sender diagnostics, ACK state or the latest event. Zero valid events
fail `VALID_DELIVERED_BATCH_NOT_FOUND`; distinct valid events fail
`AMBIGUOUS_VALID_DELIVERED_BATCH`. Byte-identical copies are deduplicated only
for selection using SHA-256 of their saved JSON; no history is deleted or
rewritten. Restart validation uses the same selector.

The VC20 exact-ID local reconciliation, excluded exerciseMinutes evidence,
native-only semantics and completion message are unchanged. Finalization makes
no network request, acquisition, SDK history command, enqueue or redelivery.

## VC20: local reconciliation of the saved VC19 delivery

**Finalize Delivered Activity 24/25 Certification** reconciles only the saved
VC19 production response for batch
`b31f2a65-0592-43b7-9260-a7af6d111ad4`. The local gate requires the exact 17
eligible IDs, HTTP 200, 17 accepted / 0 duplicate / 0 rejected, no errors, one
accepted native-only result and non-null NativeObservation ID per child, and
the exact r5 response contract and deployment revision. Every extant transport
row must match its saved payload bytes, SHA-256, observation ID, source envelope
and saved physical-source fingerprint before any mutation.

This is a separate certification-only queue purge path: it accepts an existing
`FAILED_PERMANENT` row after verifying the saved evidence, but rejects a live
claim or canonical-recovery state. It does not claim, enqueue, call the sender,
contact Base44, acquire BLE data, or issue type24/type25 commands. It persists a
`LOCAL_CERTIFICATION_RECONCILIATION_COMPLETED` event and the accepted production
results/NativeObservation IDs before purging the exact 17 rows. Historical
delivery events remain unchanged. Ordinary queue ACK behavior is unchanged.

The final state is `COMPLETED` in the existing certification state model. The
exerciseMinutes child remains excluded and preserved in certification/export
evidence; no unit is inferred. Activity stays native-only, its canonical
authority remains `NONE_UNTIL_SEMANTICS_CONFIRMED`, and type25 slot timing stays
`ELITE_PLUS_NOMINAL_INFERENCE`. Show/Copy/Share and restart inspection remain
local read-only operations.

## VC19: exact-ID transport recovery and redelivery

The VC18 source-level defect was a state eligibility gap, not reuse of the
Activity automatic-drain suppression filter. Its targeted SQL/IndexedDB claim
already skipped that suppression and could bypass `nextAttemptAt`, but still
required `PENDING`/`RETRY_WAIT`. Old `FAILED_PERMANENT` rows were never claimable.
Missing rows were explicitly refused rather than restored. The generic
"No eligible certification rows" response also conflated zero claims with
offline, unauthenticated, or missing backend-device conditions. These are
confirmed code paths, not a claim about the phone's unexported private queue.

VC19 first verifies the unchanged VC17/VC18 physical evidence. Under the existing
sender barrier, it saves diagnostics for all 18 original children: existence,
state, retry/claim fields, attempt count, stored payload SHA-256, byte equivalence,
certification metadata, dedicated claimability, and blocked reason. Missing
eligible rows are restored only by parsing their persisted `payloadJson`; IDs,
values, units, timestamps, provenance and SHA-256 are never regenerated.
Existing rows retain queue identity, attempt history and payload bytes.
Readback must exactly equal the saved payload before any submission.

The dedicated Activity claim accepts only a subset of the exact 17 approved IDs
and can claim `PENDING`, `RETRY_WAIT`, `FAILED_PERMANENT` or `ACKNOWLEDGED` transport
rows after evidence verification. It ignores retry delay but refuses live
`IN_FLIGHT` and `CANONICAL_RECOVERY_REQUIRED` rows. Generic queue filters and
automatic Activity certification suppression are unchanged. Previous valid r5
ACK receipts are skipped on subsequent partial retries.

The exact r5 revision and response-contract gate blocks the entire ACK on
mismatch. Otherwise, only unique per-ID native-only accepted results, or
duplicates backed by a matching persisted r5 NativeObservation receipt and full
provenance, may ACK. Missing, rejected, ambiguous or canonically routed results
remain `RETRY_WAIT` for explicit recovery. Receipts, batch ID, delivery timestamp,
payload fingerprint, NativeObservation ID and confirmed delivery disposition
are persisted before ACK/purge. An interrupted pre-ACK receipt permits proven
idempotent duplicate recovery. No canonical recovery/scoring consumer is added.

UI failures include the stage/code and counts for saved IDs, existing rows,
reconstructed rows, dedicated claimable rows and the excluded semantic-conflict
child. Full per-ID pre/post-recovery diagnostics survive in certification JSON.
Inspection/export after restart remains acquisition/enqueue/network free.
The production backend and all Activity overlap/timing policies are unchanged.

## VC18: resume the saved VC17 Activity certification

**Resume Activity 24/25 Certification Delivery** loads the existing durable
certification (group `9013a80b-28a3-4349-982a-d479e899f973`, acquisition
`3e206300-1ed9-4f64-bbc3-474550cff448`, selected type24 envelope
`d423e9f4-ca4e-4594-b88f-1f40fb2cd782`). It re-verifies all journal ancestry,
fingerprints, raw SHA/length, bounded type25 records, deterministic children and
overlap findings before delivery. Missing or changed evidence fails closed.
It never acquires, enqueues, creates sources or regenerates delivery IDs.

The exact 17-ID allowlist is in `ActivityResumeContract.ts`. Delivery uses the
existing queue/sender at concurrency 1 and ceiling 100; an explicit targeted
claim bypasses retry backoff, but not queue state/ownership checks. Automatic
queue draining holds Activity certification rows for explicit operator resume.
ACK is blocked unless the response contract is `native-observations-results-v1`
and deployment revision is exactly
`nc-observations-5b1-results-2026-10-05-r5-activity-native`, with 17 exact
accepted/native-only results and zero rejects. Each result requires a usable
NativeObservation ID, `canonicalStatus = not_applicable` and explicit null
`canonicalTarget`. Duplicates require an existing matching r5 receipt, including
NativeObservation ID and source/payload fingerprints; unresolved duplicates
fail closed. Receipts and revision are durably saved before ACK/purge.

The exerciseMinutes child remains in the unchanged source and saved JSON with
`PRESERVED_NOT_DELIVERED_SEMANTIC_CONFLICT`,
`exerciseMinutesUnitAuthoritative = false` and
`exerciseMinutesDeliveryEligible = false`. Its queue row is removed only inside
the sender barrier after the preservation snapshot is written. Values are not
asserted to be minutes or inferred to be seconds. Its legacy payload is retained
only as evidence, never submitted, canonicalized or scored.

Step overlap stays 105/105/105, calories 2.86/2.85 and distance 0.06/0.04.
`NONE_UNTIL_SEMANTICS_CONFIRMED` and `ELITE_PLUS_NOMINAL_INFERENCE` are unchanged:
no addition of representations and no activity canonical, scoring, readiness,
strain or recovery promotion. Completed inspection/export after restart is
read-only and performs no acquisition, enqueue or Base44 call.
Base44 is not changed by this build; the production rollout is externally verified.

## VC17: physical Activity 24/25 grouped certification

**Capture + Queue + Targeted Deliver Activity 24/25** is an operator-only action.
The SDK does not return both types from one command: the approved sequence calls
`GetTotalActivityDataWithMode` once, then `GetDetailActivityDataWithMode` once,
with normal continuation pagination, one shared physical session ID, and no
retry acquisition. A durable attempt is saved before the first command.
Subsequent presses inspect that attempt; they cannot reacquire after failure.
Ordinary Activity/Detailed Activity sync and production normalization are unchanged.

### Read-only SDK forensic inventory

Audited the bundled `v8sdk2.0.jar` bytecode: `BleSDK.DataParsingWithData` dispatches
wire commands `0x51` and `0x52` to `ResolveUtil.getTotalStepData` and
`ResolveUtil.getDetailData`. Both return a Map with String `dataType`, Boolean
`dataEnd`, and ordered List `dicData`. Record fields below are runtime **String**.
Byte offsets are zero-based, relative to each physical record.
Every listed field is SDK-decoded vendor source, not Elite+ derivation.

| Type | SDK field | Source bytes / SDK conversion | Existing normalization | Existing canonical target |
| --- | --- | --- | --- | --- |
| 24 | `date` | 2..4; hex-formatted `20YY.MM.DD` | `observedAtSource`; phone-timezone day start | None |
| 24 | `step` | 5..8; little-endian int to String | `DAILY_STEPS`, count | None |
| 24 | `exerciseMinutes` | 9..12; little-endian int to String | `DAILY_EXERCISE_MINUTES`, minute | None |
| 24 | `distance` | 13..16; SDK float accumulation / 100, English number formatting, minimum 2 fractional digits | `DAILY_DISTANCE`, `UNKNOWN_VENDOR_UNIT` | None |
| 24 | `calories` | 17..20; same SDK conversion / 100 | `DAILY_CALORIES`, `UNKNOWN_VENDOR_UNIT` | None |
| 24 | `goal` | 21 for 26-byte records; 21..22 for 27-byte records | `DAILY_GOAL_COMPLETION`, `UNKNOWN_VENDOR_UNIT` | None |
| 25 | `date` | 3..8; hex-formatted `20YY.MM.DD HH:mm:ss` | `observedAtSource`; phone-timezone record start | None |
| 25 | `detailMinterStep` | 9..10; little-endian int to String | `DETAILED_ACTIVITY_STEPS_TOTAL`, count | None |
| 25 | `calories` | 11..12; SDK float accumulation / 100, English formatting, maximum 2 fractional digits | `DETAILED_ACTIVITY_CALORIES`, `UNKNOWN_VENDOR_UNIT` | None |
| 25 | `distance` | 13..14; same SDK conversion / 100 | `DETAILED_ACTIVITY_DISTANCE`, `UNKNOWN_VENDOR_UNIT` | None |
| 25 | `arraySteps` | 15..24; ten unsigned byte values serialized as a space-separated String | ten `DETAILED_ACTIVITY_EPOCH` count values | None |

Type24 stride is selected by the SDK from 26/27-byte divisibility (including
the two-byte end marker). The SDK also computes an integer from the final four
bytes but does **not** insert it into the returned Map. `activeMinutes` is **not**
emitted by this SDK parser; the existing normalizer conditionally supports it as
`DAILY_ACTIVE_MINUTES`, minute, if a future callback provides it. All unknown,
null and optional fields remain in the typed L0 snapshot.

Type25 has a fixed 25-byte stride. A record is a **ten-slot block**, not exactly
one minute. Only the block's date/time is emitted. The production normalizer
uses slot index times 60 seconds; those offsets are **Elite+ nominal inference**,
not explicit vendor per-slot timestamps. No vendor serial/index, duration or
intensity field is emitted. Uninterpreted bytes (type24 byte 1 and type25 bytes
1..2) are not assigned serial semantics. `recordIndex` / `sourceIndex` in L0
are local SDK-list positions, not vendor serials. Repeated dates, equal values
and repeated records are allowed and independently journaled.
Parser/code evidence cannot prove what a connected physical device will emit;
that remains an operator certification gate.

`PhysiologyContract` contains no type24/type25 contracts. Existing Phase3B activity
sync is capture/diagnostics-only; there is no approved Base44/canonical activity
mapper in this repository. With operator approval, VC17 adds **certification-only
native transport** for existing normalized scalars/units, with `canonicalTarget:
null` and `canonicalPolicy: NATIVE_ONLY`. Unknown semantics are explicitly
`UNKNOWN_VENDOR_SEMANTICS`. It does not add production delivery, infer units, or
promote any activity field into canonical metrics or scoring.

### Preservation, overlap and targeted delivery

The certification-specific native request retains record occurrence IDs and
normalized duplicate occurrences; ordinary sync deduplication remains unchanged.
L0 still precedes normalization and captures raw BLE, callback and complete typed
SDK snapshots, all fields, zeros, nulls, unknown fields and original ordering.
Every record is verified through `SDK_RECORD -> SDK_CALLBACK -> BLE_NOTIFICATION`,
including exact callback snapshot membership, raw byte length and SHA-256.

Selection uses native journal sequence ordering: first complete type24 record,
then **all** type25 blocks whose original vendor date matches that summary day.
The bounded day limit is 512 physical blocks; excess/malformed groups stop
certification rather than truncate, compact or silently deduplicate evidence.
Sampling selects first, interior, zero (prefer a zero step, otherwise a zero block
field), midpoint and last slots, deduplicating **selected indexes only**. Delivery
contains the selected summary's supported scalars, selected slots, and the three
existing block scalars for sampled blocks. All unselected acquired records,
including other days and repeated records, retain full local snapshot ancestry.

`overlapAnalysis` compares `step` with both `detailMinterStep` and `arraySteps`,
and compares `calories` and `distance`. Diagnostic sums include repeated blocks.
Matching numbers do not prove decomposition. No corresponding type25 duration
or intensity field exists. `relationshipKnown` remains false and authority is
`NONE_UNTIL_SEMANTICS_CONFIRMED`: neither representation is promoted or added to
canonical/scoring totals. No new reconciliation or double-counting policy is
introduced.

Only selected exact SHA-256 observation IDs enter the existing durable queue and
targeted sender (concurrency **1**, batch ceiling **100**), never a direct POST.
Accepted/duplicate certification results require an exact per-observation
NativeObservation ID and `canonicalStatus: not_applicable`. Failed, missing,
ambiguous or canonicalized results cannot satisfy the certification gates.

### Durable inspection and export

`Activity24_25Certification` is stored transactionally in owner/device-scoped
`activity_certification_chunks` in the independent source journal SQLite database,
not the delivery queue or size-limited WebView localStorage. Snapshot quota is
64 MiB; chunks avoid CursorWindow limits and preserve surrogate pairs.
Asynchronous evidence writes are awaited **before ACK/purge**, preserving source,
mapping, fingerprints, exact receipts, NativeObservation IDs, response contract
version, deployment revision and queue disposition.

After restart, reconnect only to bind the same authenticated journal scope.
**Inspect Saved**, **Show**, **Copy**, and **Share / Save Activity 24/25
Certification JSON** revalidate saved evidence, with zero history acquisition,
enqueue, submission or snapshot writes. The same serialized UTF-8 JSON is shown,
copied and passed to the established Phase/PPI Android cache-file share helper.
Filename: `JCVital Activity 24-25 grouped certification.json`.
Source/delivery success is reported only after every validation gate passes;
vendor activity metric semantics themselves are not declared newly certified.

## VC12: full on-screen PPI JSON and clipboard fallback

**PPI Certification** is visually separate from **Read-Only Recovery Tools**,
with independent status messages. **Show PPI Certification JSON** and **Show
Current PPI Certification JSON** serialize the current validated in-memory group
(or the existing saved snapshot) with the unchanged PPI exporter. **Show Saved
PPI Certification JSON** always loads the saved snapshot and re-reads journal
ancestry; after restart, reconnect the same device to establish journal scope.
None of these actions acquires, enqueues, delivers, or calls Base44.

The entire JSON is displayed directly in a large scrollable readonly textarea,
with its character count, SHA-256 of the exact UTF-8 JSON, and **Select All**.
**Copy PPI Certification JSON** copies that same string using the Clipboard API.
If clipboard access fails or is unavailable, the full JSON remains visible for
manual Select All / Copy. Viewing does not use Filesystem, Share, or permissions.
Missing evidence reports `NO_PPI_CERTIFICATION_GROUP_AVAILABLE`; read, ancestry,
and validation errors retain their explicit diagnostics.

After successful grouped capture/delivery, the UI verifies the exact persisted
snapshot before displaying certification success and
`PPI CERTIFICATION SNAPSHOT SAVED`, including group ID, source envelope ID,
storage key, selected/delivered child counts, and `JSON available = true`.
The JSON is immediately visible. A persistence failure does not show success.
**Export PPI Certification JSON** retains the existing file/share path as an
optional convenience, not a prerequisite for retrieving evidence.

## VC11: read-only PPI saved-evidence recovery

Snapshots are stored at
`elitePlus.ppiCertification.v1.<encodeURIComponent(ownerUserId)>.<encodeURIComponent(deviceScopeId)>`
(unchanged since VC9). The owner is the Base44 user id and `deviceScopeId` comes
from `jcvitalDeviceIdentityMap.v1` for the connected MAC. VC9 saves only after a
fully validated capture. If capture stops early, no snapshot exists.

**Find Saved PPI Certification** lists only `elitePlus.ppiCertification.*` keys
with owner, deviceScopeId, group, source envelope, slot, child and receipt counts.
It then classifies the outcome:

- An exact key gives `PPI_SNAPSHOT_FOUND_EXACT`.
- Exactly one key for the same owner and the same BLE address under another
  deviceScopeId gives `PPI_SNAPSHOT_FOUND_LEGACY_KEY`. That snapshot is read in
  memory and is never copied or rewritten.
- Several such keys fail closed.
- With no snapshot, the connected owner/device L0 journal is scanned for type-127
  `SDK_RECORD`s. Candidates are verified against their callback, BLE bytes and
  slots. The scan selects a candidate only if exactly one is plausible, or if the
  operator enters its `sourceEnvelopeId`.
- VC9's deterministic sample and observation IDs are recomputed with the
  unchanged mapper. Delivery evidence comes only from durable queue ACK rows,
  which certification purges, or from a read-only Base44 trace, which the
  connector does not have today.
- Missing receipts give `PPI_JOURNAL_FOUND_DELIVERY_EVIDENCE_MISSING`, and
  `certificationSuccess` stays false unless every NativeObservation ID is proven.

**Export Recovered PPI Certification JSON** includes `recoverySource` and
`operationCounts`. It makes zero acquisition, enqueue, Base44 write, or storage
write calls.

## VC10: saved PPI export recovery (no reacquisition)

**Saved PPI certification available** is detected from the authenticated owner's
existing VC9 local snapshots, without connecting or issuing a history command.
After restart, reconnect the same device only to bind the existing journal scope.
The unchanged native journal requires that active scope for its read API.
Use **Inspect Saved PPI Certification** or **Export PPI Certification JSON**;
do not use capture or delivery to recover evidence. Both saved operations make
zero acquisition, enqueue, or Base44 calls, even after all selected queue rows
have been acknowledged and purged.

PPI, Type-42, and Phase 3A/3B/3C exports share the cache-file/Capacitor Share path
on Android. PPI creates `JCVital PPI grouped certification.json` with UTF-8
contents; Android infers `application/json` from the encoded `.json` file URI
and FileProvider grants the receiving app read access. No storage permission
or WebView download/navigation is required. Save the file through the share
chooser; the cache file is not a permanent Downloads archive.

PPI export retains the complete original journal ancestry, fingerprint, physical
slot count, ordered slots, selected children, saved receipts, queue dispositions,
and native-only assertions. Snapshot-read, journal-read, evidence-validation,
serialization, filesystem-write, and share failures include their stage and
original code/message in the certification UI. Failure never deletes saved
evidence or triggers capture. A physical VC9 failure's exact exception cannot be
inferred without device diagnostics; VC10 preserves it rather than discarding
native codes during inspection.

## VC8: discovery and journal-bound acquisition

**Start Scan** requires an authenticated account and the existing Android
Bluetooth permissions, but never a journal scope or device ID. Android 12+
uses `BLUETOOTH_SCAN` / `BLUETOOTH_CONNECT`; Android 11 and lower retains the
location permission required for BLE discovery. Scan results remain discovery
metadata and are not physiological acquisition.

**Connect** first establishes GATT and identifies the JCVital services. It
resolves in `INITIALIZING`, with notifications still disabled. The UI then
resolves the existing persisted random opaque Elite+ device ID from the local
transport identity and binds `accountId / deviceScopeId / enabled`. A raw MAC
is never used as journal ownership scope. Firmware is not required to resolve
this existing identity; its SDK response is captured after binding.

Only successful journal bind enables notifications and the journaled SDK
version handshake. `READY` requires that handshake; history, live physiology,
and certification remain blocked until then. `SOURCE_JOURNAL_NOT_READY` or the
specific durable journal failure is displayed explicitly on failure. A failed
bind disconnects safely; discovery remains available. Account changes and
scope disabling terminate prior acquisition; stale GATT callbacks remain
rejected. Initial binding of an identified, unbound transport is not an
owner-scope switch and does not disconnect that transport.

## VC7: grouped type-42 physical certification workflow

The official type-42 path is **Capture + Queue + Targeted Deliver Type 42**.
It retrieves HRV history once, verifies the complete durable type-42 source
record, and selects four eligible mapped children sharing one `sourceEnvelopeId`:
HRV vendor, vendor stress, estimated systolic BP, and estimated diastolic BP.
It never combines children from separate source records. Missing complete
evidence is reported as `NO_COMPLETE_TYPE42_CERTIFICATION_GROUP`.

The group and its original source envelope are persisted before queue insertion.
Delivery uses the existing exact-ID sender, not ordinary FIFO delivery or a
direct POST. Certification queue insertion runs inside the sender's existing
claim barrier, after any active batch finishes, so ordinary workers cannot
claim the four new certification rows first. Local envelope links do not enter
upload JSON. The source journal,
existing scalar mapping/IDs, native-only policies, concurrency of one, and
100-observation batch limit are unchanged. Separate **Certify HRV + Deliver**,
**Certify Stress + Deliver**, and **Certify Estimated BP + Deliver** controls
remain diagnostic-only alternatives; do not use them for the grouped physical test.

Successful certification requires four exact native-only results. Every
accepted row needs a returned NativeObservation ID and `not_applicable`
canonical status. A duplicate needs durable linked backend evidence.
`canonicalized`, rejected, missing, or canonical-recovery results cannot pass.
Success is shown as **1 type-42 record preserved · 4/4 native-only observations delivered**.
`vascularAging` and embedded `heartRate` stay in L0; neither is promoted by
this workflow. `fatigueDegree` is absent/not expected from the type-42 parser.

## VC9: grouped PPI / type-127 physical certification workflow

The official action is **Capture + Queue + Targeted Deliver PPI**. It acquires
type-127 history once, validates one physical `SDK_RECORD` and its
`SDK_CALLBACK` → `BLE_NOTIFICATION` ancestry, and persists the complete source
record and exact ordered slot representation before enqueueing. Original slot
count, indices, values/tokens, zeros, duplicates, and any null/invalid markers
are retained in the evidence. The physical array length is read from the source;
56 is not assumed.

The workflow reuses the existing PPI mapping and selects only the available
first, last, first interior non-zero, first interior zero, and midpoint slots,
deduplicated by slot index. It targets only those selected IDs through the
existing certification sender. Other source slots are never added by this
certification action. All mapped PPI children use the common device-record
timestamp, `UNKNOWN_VENDOR_UNIT`, native-only policy, and no canonical target;
no per-slot time offsets or additional PPI semantics are inferred. A source
array with null/invalid slots remains fully preserved in the L0 journal but is
not certified if the existing normalizer/mapping has compacted it.

The owner/device-scoped
`elitePlus.ppiCertification.v1.<owner>.<device>` evidence survives queue
acknowledgement/purge and restart. **Inspect Saved PPI Certification** does not
acquire or deliver; it re-reads and verifies the saved evidence and complete
journal ancestry. **Export PPI Certification JSON** includes full source
ancestry and slots plus exact selected-child results and delivery fingerprints.
Success requires a non-null NativeObservation ID and `canonicalStatus =
not_applicable` for every selected child. Canonicalized, rejected, failed, or
unproven results fail certification.

### Physical procedure (device only, after approval)

1. Install VC8, sign in to the correct account, allow Bluetooth, scan, and connect
   the physical V8. Wait for READY and confirm the source journal is enabled,
   not failed closed, and has storage headroom.
2. Do not start realtime, workout, ECG, PPG, or another history action.
   Existing history must contain a complete record with four eligible values;
   this action retrieves history rather than inventing or triggering an epoch.
3. Press **Capture + Queue + Targeted Deliver Type 42** once. Do not press the
   three individual metric certification buttons.
4. Require the exact four-child native-only success state, not merely queued
   rows or a batch-level accepted count. Stop on incomplete, pending, rejected,
   canonicalized, or archival-failure evidence.
5. Press **Export Type-42 Certification JSON** and save the linked source and
   exact delivery evidence. Stop the app and restart it.
6. Sign in as the same owner and connect the same device to establish journal
   read scope. Press **Inspect Saved Type-42 Certification**; this inspection
   reads only journal/local evidence and does not acquire, enqueue, or send.
7. Press **Export Type-42 Certification JSON** again. Compare the exact source
   envelope, seven original strings, four observation IDs, and delivery receipts
   against the pre-restart export. Do not reacquire to recover a pending group.
   If a saved group is pending and retry is approved, the grouped capture/deliver
   action reuses that persisted group and targets the same IDs without another
   history command. An already successful saved group is inspected, not resent.
8. Export the ordinary validation JSON as supporting diagnostics, then STOP for
   review. No next metric or semantic promotion is authorized by this workflow.

These exports contain account-scoped health-source data and should be saved or
shared only with the intended reviewer. The dedicated export is based on durable
linked source envelopes, not bounded React diagnostics. Certification evidence
persists independently of acknowledged scalar queue rows.

## VC6: durable local L0 source-envelope journal

New acquisitions require an authenticated account and opaque device scope
configured with `configureSourceJournal` before connection. The native journal
is independent of the sendable observation queue. It stores each BLE notification
and SDK callback occurrence before normalization, filtering, deduplication,
zero suppression, safe-test limits, or diagnostic bounding. Record occurrences
have immutable envelope IDs; repeated identical callbacks remain separate entries.

The typed source snapshot retains every actual SDK map key and value, original
string representation, explicit null versus absent keys, arrays and their
indices, repeated values, unknown enum values, and original record ordering.
Array annotations record tokens and parse validity without replacing the source
copy. Type 42 retains exactly the SDK's seven fields (`date`, `hrv`,
`vascularAging`, `heartRate`, `stress`, `highBP`, `lowBP`) plus any future exposed
keys. No `fatigueDegree` is invented. PPI retains every source slot including zero;
units and per-slot timing remain unknown.

Each envelope carries account/device scope, provider/connector, model, firmware
when available, SDK and parser versions, callback/record grouping, original date,
interpreted observed time when available, receipt time/timezone, acquisition mode,
indices, and vendor-derived/semantic-confidence status. Unavailable provenance
is explicit, not fabricated. Historical activity, detailed activity, sleep,
movement, workouts, monitoring, device/configuration callbacks, and raw waveforms
use the same preservation boundary without adding canonical mappings.

`NativeObservation.provenance.sourceEnvelopeId` connects normalized children to
one source record. The queue stores the reference in a nullable **local-only**
field (SQLite/IndexedDB schema v6). It does not enter `NativeObservationInput` or
the Base44 request. Scalar observation IDs and payloads are unchanged. Duplicate
scalar rereads retain the first queue association, while the journal retains
every source occurrence. Acknowledging or purging scalar rows does not delete
source envelopes.

Use `getSourceJournalDiagnostics` for storage pressure and persisted outcomes,
`listSourceEnvelopes` for catalog pages, `readSourceEnvelope` for exact scoped
reads, and `exportSourceJournal` for payload-bearing pages. The diagnostic panel
can read ten envelopes at a time; each export contains local health-source data
and must be handled as sensitive account data. No journal endpoint uploads to
Base44. Disabling or switching scope terminates the old acquisition context.

Journal pages use an exclusive `afterSequence` lower bound (`sequence >
afterSequence`) and return records in ascending sequence order. `nextSequence`
is the last sequence in a non-empty page; pass it unchanged for the next page.
An empty terminal page retains its requested cursor and has `hasMore = false`.
Generic journal consumers that need the full payload-bearing inventory continue
to use `exportSourceJournal` with that cursor contract. Activity V2 Preview and
Verify instead use the read-only `getRecentActivitySourceCandidates` query,
scoped to one account/device and filtered to `SDK_RECORD`,
`HISTORICAL_SYNC`, and vendor types 24/25. It returns each type newest-first,
including payloads, capped at 25 candidates per type; the existing production
mapping and qualification logic still selects the valid sources. Preview and
Verify share that selection path, so neither enumerates unrelated journal rows.

Activity V2 Preview also displays bounded queue-backlog aggregates from the
already owner-scoped diagnostic queue read: state counts, oldest/newest pending
times, top observation types and providers, redacted owner/device group counts,
and available attempt/error/provenance markers. It never displays complete
backlog rows and does not alter queue state. The normal Activity Verify sender
continues to use the ordinary FIFO queue claim; this diagnostic does not make
that sender target only the 14 Activity verification IDs.

Limits are configurable through `maxBytes`, `maxEnvelopes`, and `maxEntryBytes`.
Defaults are 64 MiB accounted storage, 100,000 envelopes, and 1 MiB per entry;
limits apply globally across owners while diagnostic record counts are scoped.
Retention is append-only: there is **no automatic eviction** or acknowledgment
purge. Quota exhaustion, invalid scope, serialization failure, or storage failure
is surfaced explicitly and stops acquisition rather than continuing with
unarchived measurements. Existing certification evidence is not evicted. Limits
bound admission, not unlimited device history; database/index/filesystem overhead
requires additional free space. The journal is excluded from Android cloud
backup/device transfer.

Refused-write counts, last outcome/failure, and failed-closed state are persisted
across restart. Ordinary scope configuration, logout/login, or increased limits
does not clear an archival failure. Scoped archive reads remain available for
inspection/export, but new acquisition is blocked; no automatic recovery or
destructive journal reset is exposed by this patch.

Raw PPG/ECG files have durable owner-scoped manifests rather than anonymous cache
spools. The ECG preflush storage primitive is regression-tested without enabling
ECG acquisition or interpretation. This patch cannot recover records already
dropped before VC6, and does not claim preservation of unreachable legacy SDK
helpers. No new physical acquisition/certification, canonical promotion, scoring,
delivery concurrency, or Base44 contract change is included.

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
- The HRV raw payload included `vascularAging`. New acquisitions retain it in
  the durable L0 source journal as well as transient `rawPayload`; normalized
  `VASCULAR_AGING_VENDOR_RAW` exposure is deferred to
  Phase 3E because Phase 3A acquisition/parser behavior is frozen. Its status is
  `UNDERDOCUMENTED`, vendor-derived, with unknown unit.
- PPI returned 4 groups with 56 slots per group (224 total slots). Zero values
  remain in the lossless arrays as data; their meaning is unconfirmed. Unit
  remains `UNKNOWN_VENDOR_UNIT` pending vendor confirmation.

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
| HRV and vendor metrics | `GetHRVDataWithMode` | `GetHRVData` (`42`) | `date`, `hrv`, `vascularAging`, `heartRate`, `stress`, `highBP`, `lowBP` (exact SDK strings) | bpm for HR; unknown vendor unit for all other fields | device-local `date` |
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
now durably journaled before the existing sanitized `jcvitalRawVendorData`
and recognized `jcvitalObservation` paths. Unknown keys remain in the L0 journal
even when diagnostic `rawPayload` is bounded or scalar normalization rejects them.

The actual bundled type-42 parser does **not** expose `fatigueDegree`. That key
belongs to a separate type-66 helper not reached by the bundled dispatcher;
the existing permissive normalizer is not evidence of SDK emission.

`highBP` and `lowBP` are classified only as vendor-estimated BP. HRV, stress,
fatigue, BP, and PPI units/scales remain unknown until physically or explicitly
documented. The SDK has no separate automatic-HR history command: HR embedded in
HRV history is retained as `HEART_RATE_AUTOMATIC`, while `GetDynamicHRWithMode`
remains the independent continuous stream.

### Storage-volume review

Before VC6, no durable L0 waveform archive was selected in Phase 3A. The Base44 input is
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
  and the legacy `ppiTrailingZeroPaddingCandidate` diagnostic field. That field
  does not classify or filter slots: zero meaning remains unconfirmed, and all
  zero values remain data eligible for native-only delivery.
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
  | accepted | failed | `CANONICAL_RECOVERY_REQUIRED` | not acknowledged as delivered; persist recovery context and pause queue |
  | accepted | null | `DELIVERED` | delivered |
  | duplicate | null | `DELIVERED_DUPLICATE` | delivered (already stored) |
  | rejected | — | `REJECTED` with `reason` / `errorCode` | failed |

  `nativeObservationId` is retained for fresh accepted rows and is not required
  for duplicates or rejections. `errors[]` entries without an `observationId`
  are counted as unattributed. Responses without `results[]` fall back to batch
  totals, attributed per metric only when a batch holds one metric.
- `uniqueObservationsDelivered` is per-ID exact in both modes.

## Build 5B-1 throughput and queue-resume certification

The live Base44 r3 benchmark establishes that larger requests do not improve
fresh canonical HR throughput. Keep the production batch size at 100:

| Fresh canonical HR batch | Processing time | Throughput |
| --- | ---: | ---: |
| 100 | 18.7 s | 5.34 observations/s |
| 250 | 52.3 s | 4.78 observations/s |
| 500 | 97.2 s | 5.15 observations/s |

Duplicate-only processing took 0.7 s / 1.1 s / 1.7 s for 100 / 250 / 500
observations. Three simultaneous fresh 100-row requests completed in 17.8 s:
all 300 were accepted and canonicalized, with no 429 or other errors (about
16.8 observations/s aggregate). Four simultaneous fresh 100-row requests
completed in 20.06 s: all 400 were accepted and canonicalized, all native
observation IDs were present, and there were no 429, 5xx, timeout, duplicate
collision, or canonical failures (about 19.9 observations/s aggregate).
Concurrency 5 is unsafe: Base44 reported 500 accepted with zero canonical
creates in one run, and 14-22 canonical failures per 100-row batch in another.
The sustained physical run invalidated concurrency 4 despite the clean
single-wave benchmark: five 100-row batches reported 500 accepted raw rows and
500 canonical failures, followed by another failed batch after backoff. Sustained
Base44 tests later recorded 0 failures / 1,000 observations at concurrency 1,
588 / 2,000 at concurrency 2, and 1,554 / 3,000 at concurrency 3; concurrency
4 also failed physically. Therefore Build 5B-1 pins batch size, production
default concurrency, and production maximum concurrency to 100 / 1 / 1. All
higher requested concurrency values are clamped to one with a diagnostic
warning. Internal parallel-worker architecture is retained for a future backend
release but cannot start a second request in Build 5B-1. The live backend is
`nc-observations-5b1-results-2026-10-03-r4` and retains the
`native-observations-results-v1` response contract.
Transient failures reduce effective concurrency one step at a time. Canonical
failure now pauses the queue and cannot recover concurrency.

Queue claims are capped at 100 rows and atomically move eligible rows to
`IN_FLIGHT`, assign the unique batch ID, increment the attempt count, and write
`claimedAt`. Acknowledgement, retry, and permanent-failure updates are guarded
by that claim's batch ID and attempt count, so a late response cannot change a
row reclaimed by a later attempt. The SQLite schema migration adds claim time
without clearing/replacing queue rows. The canonical-recovery migration is also
additive and preserves existing queue rows. Startup now restores authentication,
assigns the queue owner, initializes the durable queue, restores/re-registers
the Connector backend ID, recovers stale claims, then resumes queue delivery at the
configured concurrency (default 1, hard ceiling 1). This queue resume is independent of the in-memory physiological
acquisition toggle and does not require a connected V8. Startup diagnostics
include whether resume was attempted/started, any blocking prerequisite, and
whether the Connector identity was restored. Future-due retry rows are
scheduled for their persisted retry time. Installing the certification APK
must preserve app data. Do not clear app storage or repeat the full HR
acquisition.

For a response containing `canonicalStatus: failed` or a positive
`canonical.failed` total, affected rows enter `CANONICAL_RECOVERY_REQUIRED`
instead of being acknowledged or ordinarily retried. Their observation ID,
native observation ID (when returned), batch ID, payload, and failure time are
preserved. The delivery manager pauses all further queue claims and persists a
bounded, payload-free batch diagnostic across restarts. A normal duplicate
response cannot clear this state; wait for Base44's explicit server-side
reconciliation procedure before implementing or enabling recovery.

The full-scale 580/37,230 non-deliverables were expected zero/no-measurement
placeholders and remain excluded by the existing `heartRateHistory` mapping
policy (integer 1-250 bpm); Base44's authoritative physiological validation
remains 20-250 bpm. Per-sync diagnostics report the placeholder count. The
sample-level chronological merge fix and the 37,230-sample regression fixture
remain in place; overlapping timestamps do not cause legitimate observations
to be deduplicated.

## JCVital V8 end-to-end device certification gate

### Baseline export artifact verification

The repository-root `ElitePlus-Connector-debug.apk` is a preserved older artifact:
it contains the r4 backend marker and the same export button label but **does not**
contain `jcvitalCertification`. Do not use that artifact for certification.
The previously built `android/app/build/outputs/apk/debug/app-debug.apk` did contain
the certification builder and attached payload; absence of the field in a
physical export cannot come from that checked serializer (even a missing
builder argument previously serialized the field as null). The phone's installed
artifact is unverified until a new baseline export is reviewed.

The UI now calls `buildCertificationValidationExport`, which always invokes the
certification builder, attaches all 14 metric sections, and adds the top-level
`certificationBuild` marker. `serializeCertificationValidationExport` redacts the
report and refuses to produce JSON if the marker or any certification section
is missing. Native sharing and browser downloading use these same JSON bytes.
The marker is also visible next to the export controls:

```json
{
  "enabled": true,
  "schemaVersion": "jcvital-certification-v1",
  "baselineCommit": "4e31a1c0476fdad49ef853e4b53273d55fd457c6",
  "expectedBase44Revision": "nc-observations-5b1-results-2026-10-03-r4"
}
```

Use the distinctly named `ElitePlus-JCVital-certification-v1.apk` copied from the
new Android build output in the session artifacts. Verify its supplied SHA-256,
install **over** the existing app, and export baseline JSON only. Never uninstall,
clear storage/SQLite, reset the queue, or run Sync HR. Missing local HR samples
require prior physical evidence, not reacquisition. Before SpO2 capture the
section must exist with NOT_CAPTURED and observationCount=0. HOLD until both
top-level objects and preserved baseline evidence are reviewed.

### Physical installation identity (versionCode 5)

The uniquely versioned certification package is
`ElitePlus-JCVital-certification-v1-vc5.apk`, package
`com.hapi.eliteplus.connector`, versionCode `5`, versionName
`1.0-certification-v1-vc5`. This build adds diagnostic-first targeted
wearable-temperature (type 59) certification delivery controls, reusing the
exact vc4 SpO2 architecture (durable SQLite queue, ObservationBatchManager,
PhysiologyContract, Base44Client, concurrency 1, 100-row batches, exact-ID
targeted flush); production defaults, mappings, HR delivery and the Base44 r4
contract remain unchanged. Previous certification artifacts remain preserved.

Android permits a same-versionCode replacement with a compatible signing key
(for example `adb install -r`). Equal versionCode alone does not instruct Android
to retain the old APK, but it makes the old/new installations indistinguishable
in version displays. A failed/canceled install, an old downloaded artifact,
another Android user/work profile, or a different app/browser instance can still
leave the old export in use. Verify rather than infer the installed identity.

Under **Data Sync**, the corrected app must visibly show:

```text
Certification export build: jcvital-certification-v1 (baseline 4e31a1c).
Baseline JSON must contain both certificationBuild and jcvitalCertification before any physical test.
```

For strongest verification, use a computer with Android platform-tools and the
phone's authorized USB debugging connection. Select the correct phone and user
profile (the following commands assume exactly one device and the current user):

```sh
sha256sum ElitePlus-JCVital-certification-v1-vc5.apk
adb devices -l
adb shell am get-current-user
adb install -r ElitePlus-JCVital-certification-v1-vc5.apk
adb shell dumpsys package com.hapi.eliteplus.connector
adb shell pm path --user current com.hapi.eliteplus.connector
```

Require install output `Success`, versionCode `5`, and versionName
`1.0-certification-v1-vc5`. Copy the exact `base.apk` path reported by `pm path`
(remove the `package:` prefix), then:

```sh
adb pull /exact/device/path/from/pm/path/base.apk installed-jcvital-base.apk
sha256sum installed-jcvital-base.apk
```

The pulled APK hash must equal the supplied certification APK hash. If it does
not, STOP: do not clear data, uninstall, use a downgrade flag, or acquire data.
To inspect installed assets locally without running them:

```sh
unzip -p installed-jcvital-base.apk 'assets/public/assets/*.js' |
  grep -oE 'jcvital-certification-v1|certificationBuild|jcvitalCertification' |
  sort -u
```

All three markers must appear. Close/reopen the native app, confirm its visible
marker, and export a freshly generated baseline JSON, not an older shared file.
With multiple devices use `adb -s DEVICE_SERIAL` for every command; with a work
profile verify/install/launch in the same profile rather than assuming the
personal-profile app was updated. An App info version screenshot is useful but
the pulled APK hash is the strongest binary-identity check.

If the installed hash matches but the visible marker/export does not, preserve
the APK hash, version/profile details, screenshot, and newly generated export
for investigation. Do not claim device certification or start SpO2.

Source checkpoint: `4e31a1c0476fdad49ef853e4b53273d55fd457c6`,
`Certify Build 5B-1 sequential JCVital delivery baseline` (41 files).
The checkpoint excludes the generated APK and unrelated vendor import artifacts.
The baseline full suite passed with one Vitest worker and an extended test timeout
(269 tests); Android unit tests passed with the installed Java 21.

The exported validation JSON now includes a read-only `jcvitalCertification`
section for historical HR, live workout HR, SpO2, wearable temperature, HRV,
stress, estimated BP, PPI, activity, detailed activity, sleep, workout history,
PPG, and blocked ECG. Each section includes capture status, counts, first/last
and sampled observations, units, timestamp/delivery policies, canonical targets,
parse/non-deliverable counts, unknown semantics, and certification notes.
Focused capture sections also include every normalized observation's evidence.
The `handoff` contains exact sample identifiers, values, times, policies, and
observed delivery results for Base44 tracing.

Export reuses the existing deterministic mapping functions; it does not enqueue,
claim, acknowledge, resample, or send observations. A computed observation ID is
**not proof of delivery**. Exact per-ID backend results are retained in a bounded
1,000-entry, account-scoped, in-memory diagnostic cache; eviction is reported.
A missing result means UNKNOWN, including after restart or eviction. Legacy
delivery totals remain available but are not attributed as individual successes.
The whole exported report redacts MAC addresses and credential fields, including
legacy raw vendor payloads. Device traceability uses the existing opaque ID.

Historical HR passes are explicitly attributed to the prior, user-provided
physical baseline. They are not fabricated from parser tests or queue counts.
Export reuses first/last streamed samples if still present; otherwise it reads
at most 100 eligible durable rows and selects HR samples without modifying them.
These are samples, not corpus boundaries/totals. If no samples remain, use an
existing physical validation export for Base44's exact-ID trace. Never reacquire
full HR history to fill the report, clear SQLite, regenerate the backlog, or
wait for it to drain. Full-history acquisition is disabled in this gate's UI;
the existing bounded HR regression controls remain available.
Export also reads the queue state of at most ten trace samples per metric.
Missing queue rows do not imply acknowledgement; read errors fail the export
explicitly. Handoff observation windows are separate from capture test windows.

### Diagnostic-first targeted SpO2 certification delivery (vc4)

Install over the existing app; do not uninstall, clear SQLite, Sync HR or test
other metrics. First press **Inspect prior SpO2 certification IDs**. This reads
only the current owner's five supplied SHA-256 IDs; it never captures, claims
or sends. The normal worker may independently continue its ordinary work.
Results are `FOUND_PENDING`, `FOUND_RETRYING`, `FOUND_SENDING`, `FAILED`,
`RECOVERY_REQUIRED`, `ACKNOWLEDGED_EVIDENCE`, or `NOT_FOUND`.

If any prior rows/evidence are present, use **Flush existing SpO2 certification
rows** without reacquisition. It targets only the five known IDs. If all five
are `NOT_FOUND`, the UI reports
`FIRST VC3 ATTEMPT DID NOT LEAVE DURABLE EVIDENCE FOR THE FIVE CERTIFICATION IDS`.
Base44 independently reported no rows for these IDs/type 68. Only then is
**Capture + Queue + Targeted Deliver SpO2** available. It rechecks before capture,
captures once, maps/enqueues the complete history unchanged, and targets only
the first five valid mapped IDs. Remaining observations stay in the ordinary
durable queue. A subsequent captured sample record blocks repeated acquisition;
inspection/flush can resume its saved exact IDs after restart.

The targeted operation blocks NEW ordinary claims, waits at most 60 seconds
for the existing active worker (without canceling it), then atomically claims
only supplied, owner-scoped, eligible IDs. Future-dated retries and existing
sending/recovery/failed rows are not force-claimed. It uses the same
ObservationBatchManager processing loop, Base44Client and normal results/recovery
semantics. It does not call normal stale recovery or owner-wide ACK purge:
targeted purge is restricted to its claimed IDs. No unrelated HR payloads,
IDs, row IDs, states or FIFO timestamps are changed by the targeted operation.
The ordinary worker resumes in `finally` if it was started and is not paused;
canonical recovery is never cleared. The existing HTTP timeout remains in force.
There is no wait for the shared HR backlog to drain and no direct POST bypass.

The UI shows queue inspection, capture/enqueue counts, waiting for the active
batch, sending certification rows and exact delivered counts or pending/failure.
Acquisition loading is released before targeted delivery; export remains
available. The small owner-scoped `elitePlus.spo2Certification.v1` local
diagnostic store retains at most ten sample records, inspections and exact
server results across restart. It is NOT an observation queue: no sendable
payloads, scheduling, retries or ingestion path are added. Targeted responses
are persisted before ACK/purge, then updated with actual ACK evidence.
Storage failures are explicit; they never silently authorize capture.
Exports include restored samples and queue inspection separately from a fresh
physical-capture status; they do not claim a new capture/full-corpus pass.

**Certify HRV + Deliver**, **Certify Stress + Deliver**, and
**Certify Estimated BP + Deliver** select exactly one physiology metric for the
current action. Estimated BP retains both existing component mappings. A
type-42 capture can contain other companion observations, but only the
explicitly selected metric is mapped/enqueued by that action. Generic
**Certify PPI + Deliver** remains diagnostic-only; the grouped workflow below is
the official PPI physical certification path.
The override does not change the master toggle or metric checkboxes and is not
persisted. `CAPTURE_ONLY` explicitly suppresses delivery; ordinary Sync actions
without a scoped override retain the existing master-toggle behavior.
Wearable temperature now has its own dedicated diagnostic-first workflow (vc5,
below) instead of the generic override.

The existing durable queue, single-worker sender, 100-row batches, Base44Client,
per-observation `results[]`, deterministic IDs, and canonical recovery protections
are unchanged. A pre-existing queue backlog may still be sent by that shared
sender; its totals never prove delivery for the focused certification IDs.

The focused action awaits only its bounded targeted sample. When a sender is
already busy, it waits for that worker rather than starting another worker.
Offline, paused, retrying or still-queued rows
produce an explicit incomplete report, never a capture-complete success claim.

Each handoff sample includes `DELIVERY_STATE`, `DELIVERY_RESULT`,
`NATIVE_OBSERVATION_ID`, `QUEUE_STATE`, and `QUEUE_DISPOSITION`, alongside the
unchanged IDs, value, unit, timestamp, vendor type and canonical target.
`DELIVERY_STATE` distinguishes `CAPTURED_NOT_DELIVERED`, `QUEUED`,
`DELIVERED_CANONICALIZED`, `DELIVERED_NATIVE_ONLY`, `DELIVERED_DUPLICATE`,
`CANONICAL_FAILED`, `REJECTED`, and `FAILED`. An acknowledgement without exact
`results[]` remains `DELIVERY_UNKNOWN`, not canonical success.
The unchanged sender purges acknowledged rows. A successful exact-ID
acknowledgement plus a missing queue row is therefore reported with
`QUEUE_STATE=null`, `QUEUE_DISPOSITION=ACKNOWLEDGED_PURGED`, and the proven
delivery state/result. Absence without acknowledgement is `NOT_FOUND`, not proof.
Duplicate responses preserve a native ID only when supplied; IDs are never
fabricated. Awaited certification reports retain exact results even if the
screen's bounded event cache later evicts them.

**Current retest:** SpO2 (vc4) is already certified; its evidence remains
preserved and must not be reacquired. Install vc5 over the existing app
without uninstalling or clearing SQLite. Do not Sync HR. Hold HRV/stress,
estimated BP, PPI, activity, sleep, PPG and ECG; do not start Build 5B-2
scaling. Proceed to the diagnostic-first wearable-temperature workflow below.

### Diagnostic-first targeted wearable temperature certification delivery (vc5)

This is the first physical certification attempt for type-59 wearable
temperature, so unlike vc4 SpO2 there is no prior hardcoded five-ID list to
recover; the small owner-scoped `elitePlus.temperatureCertification.v1` local
diagnostic store is the only recovery source after this attempt. Reuses the
exact vc4 architecture unchanged: the existing type-59 SDK historical path,
the existing temperature normalizer (`WEARABLE_SKIN_SENSOR`, celsius,
`body.wearable_temperature`), `PhysiologyContract`, the durable SQLite
`ObservationQueue`, `ObservationBatchManager`, `Base44Client`, exact-ID
targeted flush, certification evidence persistence, canonical failure
protection, concurrency 1, and 100-row batches. No new queue or API path was
added and the HR backlog is not required to drain first.

Install over the existing app; do not uninstall, clear SQLite, Sync HR or test
other metrics. First press **Inspect persisted wearable temperature
certification IDs**. On a first attempt with nothing yet captured, this
reports `No persisted wearable temperature certification evidence yet. Use
Capture + Queue + Targeted Deliver Temperature.` without capturing, claiming or
sending. If a prior sample is already recorded locally, this reads its exact
five SHA-256 IDs instead: `FOUND_PENDING`, `FOUND_RETRYING`, `FOUND_SENDING`,
`FAILED`, `RECOVERY_REQUIRED`, `ACKNOWLEDGED_EVIDENCE`, or `NOT_FOUND`.

If any prior rows/evidence are present, use **Flush existing wearable
temperature certification rows** without reacquisition; it targets only the
exact previously-recorded IDs. Otherwise, use **Capture + Queue + Targeted
Deliver Temperature**. It requests historical temperature using the existing
type-59 SDK path, captures all returned physical records truthfully, normalizes
them with the existing mapping, durably enqueues every eligible observation,
then selects a bounded certification sample of five valid observations and
persists those exact IDs after enqueue confirmation and before any targeted
send. The targeted action proceeds only when all five valid rows are available.
If fewer than five are available, those rows remain durably queued and their
IDs are retained as evidence, but no targeted request is sent and the UI
reports the incomplete sample. A subsequent captured sample record blocks
repeated acquisition; inspection/flush can resume its saved exact IDs after
restart, and a temperature flush rejects anything other than five distinct
IDs.

The targeted operation blocks NEW ordinary claims, waits at most 60 seconds
for the existing active worker (without canceling it — any active HR batch
finishes normally), then atomically claims only the five supplied, owner-
scoped, eligible IDs. It uses the same ObservationBatchManager processing
loop, Base44Client and normal results/recovery semantics, and resumes ordinary
queue processing afterward. No unrelated HR payloads, IDs, row IDs, states or
FIFO timestamps are changed by the targeted operation. There is no wait for
the shared HR backlog to drain and no direct POST bypass.

The UI shows, in order: Capturing temperature, Temperature observations
normalized, Certification sample queued, Waiting for active batch, Delivering
5 temperature observations, and 5/5 delivered (or the truthful failure/
incomplete state). Each handoff sample includes `DELIVERY_STATE`,
`DELIVERY_RESULT`, `NATIVE_OBSERVATION_ID`, `QUEUE_STATE`, and
`QUEUE_DISPOSITION`, alongside the unchanged observation/source-record IDs,
exact value, exact celsius unit, exact `observedAt`, vendor type `59`, and
canonical target `body.wearable_temperature`. Diagnostics (min, max, median,
observation count, duplicate count, invalid/null count, median/min/max
interval) are computed only from actual captured observations; sampling
frequency is never inferred ahead of the evidence.
Temperature certification reports success only for five exact accepted or
duplicate results that also prove `canonicalStatus=canonicalized`; every
accepted result must include its exact non-null NativeObservation ID. Missing
or incomplete results remain a truthful failure/incomplete state.

After restart, restored type-59 samples export `CAPTURED_PREVIOUSLY_REPORTED`
instead of `NOT_CAPTURED`. Five or more distinct persisted samples all backed
by matching exact-ID accepted/duplicate, canonicalized delivery results export
`PASS_PREVIOUSLY_REPORTED` (accepted results require a NativeObservation ID).
Queue recovery/failure states still prevent a prior-pass claim. This status
describes persisted physical evidence, not a new capture, full-corpus
certification, or downstream/UI verification; export never reacquires or sends.

Wearable temperature is skin-sensor temperature, not core/clinical/fever body
temperature, and is never relabeled as such. Any athlete-facing label uses
Elite+ or Elite+ V8; JCVital is never exposed as the consumer-facing brand,
though it is preserved internally (provider, sourceConnector, vendor type 59).

**Current retest:** install vc5 over the existing app without uninstalling or
clearing SQLite. Do not Sync HR. Inspect persisted wearable temperature IDs
first, then flush existing rows if present; capture once only when the
inspection permits it. Wait for the targeted report, export JSON, and STOP.
Hold type-42, PPI, activity, workouts, sleep, PPG and ECG; do not start Build
5B-2 scaling or test the next metric until this temperature JSON is reviewed.

### Focused physical test procedure

Connect the V8 and wait for READY. Use the following order, **one test at a time**.
After each test, export validation JSON and **STOP for review** before running
the next test or changing any semantics. No connected device or prior artifact
means NOT_CAPTURED, never EMPTY or PASS.

1. Export existing historical HR evidence without acquisition. Base44 traces
   `body.heart_rate` through canonical rows, summary/intelligence, and Elite+ UI.
2. For certification delivery, follow the diagnostic-first vc4 workflow above.
   Its explicit
   `CERTIFICATION_DELIVER` action bypasses the master toggle for SpO2 only,
   without changing or persisting the toggle or metric selections. Ordinary
   **Sync SpO2** retains capture-only behavior with the master toggle off.
   Type 68 values stay percent with no conversion; canonical target is
   `body.oxygen_saturation`. Empty history requires wearing V8 with SpO2
   monitoring enabled, then rerunning this focused sync.
3. For certification delivery, follow the diagnostic-first vc5 workflow above.
   Its explicit `CERTIFICATION_DELIVER` action bypasses the master toggle for
   wearable temperature only, without changing or persisting the toggle or
   metric selections. Ordinary **Sync Temperature** retains capture-only
   behavior with the master toggle off. Type 59 values stay celsius with no
   conversion; canonical target is `body.wearable_temperature`, never
   CORE_TEMPERATURE. Empty history requires wearing V8 with temperature
   monitoring enabled, then rerunning this focused sync.
4. Run **Sync HRV / Stress / Estimated BP (type 42)** only. HRV/stress keep
   UNKNOWN_VENDOR_UNIT and native-only vendor provenance. BP components remain
   separate, linked by sourceRecordGroupId, ESTIMATED_VENDOR_BP,
   cuffMeasured=false, vendorDerived=true.
5. Run **Sync PPI (type 127)** only. Preserve all slots, indexes, and zeros;
   UNKNOWN_VENDOR_UNIT, native-only delivery / research-only interpretation.
6. Run **Sync Activity**, then export/review. Actual fields only; no new mapping.
7. Run **Sync Detailed Activity**, then export/review. Distinct minute epochs,
   source arrays, block/epoch counts, and per-epoch values; no aggregation.
8. Superseded by VC25: use **Capture Workout History Certification** once, then
   inspect/export saved evidence. A valid empty response closes with
   `PHYSICAL_WORKOUT_HISTORY_VALID_BUT_EMPTY`; do not rerun acquisition.
9. With a registered Connector and healthy queue, use **Certify Live Workout HR
   (3 minutes)**. This enables live HR delivery, starts a supported workout,
   collects type 82, then stops/flushes. Alternatively use the existing manual
   workout start/stop controls for 3-5 minutes. Export after stopping. Evidence
   includes session/activity, non-zero HR, packet and HR cadence (median/p5/p95),
   first/last HR, deterministic IDs, receipt timestamp policy, and observed
   delivery results. This requires no historical HR sync and infers no METS.
10. Run **Sync Sleep** (validated stage and movement commands). Physical empty
    is reported only when both commands return clean EMPTY_VALID responses:
    `PHYSICAL_DATA = EMPTY`. Then wear V8 overnight, ensure sleep monitoring
    enabled, and sync the next morning. Raw stage codes stay UNKNOWN; derived
    end/duration fields are labeled as derived, not emitted vendor fields.
11. Reuse existing PPG capture/export. Packet/chunk counts, bytes, notification
    lengths, raw format, and parse errors remain diagnostic/research-only.
    Unknown sample semantics do not establish glucose, BP, SpO2, or ECG.
12. ECG stays BLOCKED_VENDOR_GUIDANCE.

The baseline remains `native-observations-results-v1` /
`nc-observations-5b1-results-2026-10-03-r4`, batch size 100, default and maximum
concurrency 1. Device fit is NOT_DECLARED until physical contracts and Base44
UI consumption are verified. No async canonicalization, worker pool, upload
changes, concurrency/batch increases, or backfill scheduler are part of this gate.

## PPI certification JSON view/copy fallback (VC12)

Build artifact: `ElitePlus-JCVital-certification-v1-vc12.apk`, versionCode 12,
versionName `1.0-certification-v1-vc12`. Install over the existing app; do not
uninstall, clear storage, or reacquire PPI to retrieve existing evidence.

The **PPI Certification** section is visually separate from **Read-Only
Recovery Tools**. **Show PPI Certification JSON** and **Show Current PPI
Certification JSON** use the current validated in-memory group, falling back
to the saved snapshot. **Show Saved PPI Certification JSON** always reads the
saved owner/device snapshot and re-reads its source journal ancestry. After
restart, reconnect the same device to establish journal scope, then use Show
Saved, not Capture.

The entire existing certification export is displayed in a scrollable readonly
textarea, without truncation, with its character count and SHA-256 of the exact
UTF-8 JSON. **Select All** focuses and selects the textarea. **Copy PPI
Certification JSON** displays the full JSON before attempting Clipboard API
copy; clipboard denial or absence leaves that exact JSON visible for manual
Select All / Copy. Viewing requires neither clipboard/file permissions nor
Filesystem or Share. All view/copy actions perform zero acquisitions, enqueues,
deliveries, and Base44 calls; the ordinary sender's independent behavior is
unchanged.

After successful **Capture + Queue + Targeted Deliver PPI**, the UI verifies
that the exact snapshot is persisted before displaying **PPI CERTIFICATION
SNAPSHOT SAVED**, its certificationGroupId, sourceEnvelopeId, storage key,
selected/delivered child counts, and `JSON available = true/false`. Persistence
failure never produces a certification-success claim. Missing current/saved
groups report `NO_PPI_CERTIFICATION_GROUP_AVAILABLE`; corrupt snapshots and
journal failures retain explicit stage diagnostics.

**Export PPI Certification JSON** remains an optional convenience beside Show
and Copy. Its existing Filesystem/Share (Android) and browser-download paths
are unchanged; file export is not required for evidence retrieval. VC12 does
not change acquisition, mapping, journal, deterministic slot selection,
delivery, Base44, canonical policy, concurrency, or batch size.

## PPI capture/persistence attempt diagnostic (VC13)

`ElitePlus-JCVital-certification-v1-vc13.apk` uses versionCode 13 and
versionName `1.0-certification-v1-vc13`. VC13 instruments the existing grouped
PPI certification path; it does not change acquisition, mapping, source journal,
candidate selection, delivery, Base44, canonical policy, concurrency, batch size,
or file export. There is no automatic reacquisition. An operator press invokes
the existing capture once; an existing certification snapshot retains the
existing no-reacquisition guard and reports `ACQUISITION_SKIPPED`.

The visible **PPI Certification Attempt Diagnostic** records button invocation,
physical READY/account/device scope, history start/completion and parse errors,
candidate IDs and slot counts, ancestry and raw byte SHA/length verification,
source/normalized slot alignment, mapping, selected indexes and generated IDs,
enqueue/targeted flush and exact backend statuses/NativeObservation IDs, snapshot
serialization, localStorage save, and exact post-save read-back. Each failure
retains its stage, reported code (null if the source provided none), exception
name/message/stack, and relevant counts/IDs. Rejected candidates remain in the
trace even if a later candidate succeeds; the diagnostic does not change which
candidate the existing code selects.

Read-only journal enumeration reports type-127 SDK_CALLBACK and SDK_RECORD
counts in the connected owner/device history-request time window, separately
from normalized observations. A journal enumeration error reports unknown/null
counts and its exact error, never an invented zero. It neither writes journal
entries nor authorizes acquisition/delivery.

Every diagnostic event is saved and read back under
`elitePlus.ppiCertificationAttempt.v1.<encodeURIComponent(owner)>.<encodeURIComponent(device)>`,
separate from the certification snapshot. Failed attempts persist even when
only the certification snapshot write fails. This diagnostic record always has
`certificationSuccess: false`; its `outcome` reports the observed workflow result,
not independent proof of certification. If localStorage rejects **all** writes,
persistent diagnostics are impossible: the full record stays visible in memory
with `diagnosticPersistence.saved=false` and the exact storage error. Copy it
before closing the app. Missing scope likewise stays explicitly memory-only.

**Show Last PPI Certification Attempt** restores the separate saved diagnostic
after reconnecting the same authenticated device. **Copy Last PPI Certification
Attempt** displays its entire JSON before clipboard copy, with Select All and
manual-copy fallback. These controls never acquire, enqueue, deliver, or call
Base44, and require neither Filesystem nor Share. Install over VC12 without
uninstalling/clearing storage. Retrieve the failed attempt before pressing Capture
again; VC13 does not determine the physical root cause until that trace exists.

## Share/save displayed PPI JSON (VC14)

`ElitePlus-JCVital-certification-v1-vc14.apk` uses versionCode 14 and
versionName `1.0-certification-v1-vc14`. **Share / Save PPI JSON** and
**Share / Save Last PPI Certification Attempt** sit beside the existing
Show/Copy controls. First show the desired JSON; sharing is disabled until
its full JSON is displayed. Copy and Share reuse that exact displayed string,
without re-reading or reserializing it. Show again to refresh the displayed
evidence. The displayed, copied, and shared JSON have identical SHA-256.

Both buttons call the unchanged `saveValidationJson` helper used by the
standard Phase 3A/3B/3C JSON export. On Android this writes the exact UTF-8
JSON to the existing cache directory and invokes Capacitor Share's standard
Android chooser with a readable FileProvider attachment and `application/json`
inferred from the `.json` extension. Filenames are exactly
`JCVital PPI grouped certification.json` and
`JCVital PPI certification attempt.json`. Google Drive, Gmail, Files,
Quick Share, and other compatible installed/enabled share targets can appear;
the app does not select a destination or guarantee a particular installed
target. Chooser completion is not proof of an upload to Drive.

Share/save neither uses Clipboard nor browser download on Android. No
PPI-specific native bridge or second export implementation is added. The
existing standard helper's web download behavior remains unchanged.
Share/save does not acquire, map, enqueue, read/write the journal, submit to
Base44, or change certification snapshots/attempt records. Only transport UI
status and the temporary share file change. Cancellation/failure retains the
displayed JSON and the existing helper's exact error stage/code/message.

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
