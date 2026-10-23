# JCVital V8 PPG Workflow Notes

Elite+ labels this capture `PPG_WORKFLOW_RAW_VENDOR`. The checked-in SDK does not implement `realtimePPGData_V8` or `arrayPPGData`; this workflow uses `BleSDK.ppgWithMode` and the vendor's BGEM/blood-glucose-risk UI. Vendor naming is not evidence of a measured glucose result or calibrated generic PPG.

## Hardware Validation Status

| Capability | Status |
| --- | --- |
| PPG workflow (`PPG_WORKFLOW_RAW_VENDOR`) | `CONFIRMED_HARDWARE` on PRO_V8 firmware 0.0.8.8 |
| Observed physical packet layout | 203 bytes (`203_BYTE_LAYOUT` = `CONFIRMED_HARDWARE`) |
| Values | 50 vendor-decoded values per data packet |
| 153-byte parser support | Implemented but NOT physically observed |
| Sample rate | UNKNOWN |
| Unit | `UNKNOWN_VENDOR_UNIT` |

No calibrated PPG unit, `sampleRateHz`, or measured-glucose mapping is assigned.

## VC29 One-Shot Physical Certification

VC28 recovery is closed. VC29 authorizes one **new** physical attempt per authenticated
account and opaque device scope; it does not recover or certify historical evidence.
Use **Capture Raw PPG Certification — ONE PHYSICAL SESSION** only while READY.
Legacy Raw PPG start is disabled in this build.

Before BLE, the capture creates group/session IDs, commits the owner/session-open journal
envelope, creates and registers an fsynced spool, atomically persists the attempt claim
and initial snapshot, then persists the exact command request and a progress checkpoint.
The native GATT write callback journals the ACK with the request as its parent.
Each notification is journaled before parsing; SDK callbacks and parser outcomes are
journaled before the original packet is appended and fsynced. Progress checkpoints
retain packet offsets, bytes, hashes and ancestry across process restart.

The checked-in vendor JAR generates these `BleSDK.ppgWithMode(mode, 0)` frames on write
characteristic `0000fff6-0000-1000-8000-00805f9b34fb` (the connected characteristic is
recorded, not assumed). Notifications use `0000fff7-0000-1000-8000-00805f9b34fb`.

| Role | Mode | Exact command bytes | SHA-256 |
| --- | --- | --- | --- |
| Start | 1 | `78 01 00 00 00 00 00 00 00 00 00 00 00 00 00 79` | `2e482bde5cfd7838a98a3461ba04129592235acdeb5d363385455e34874c65c3` |
| Stop | 3 | `78 03 00 00 00 00 00 00 00 00 00 00 00 00 00 7B` | `624a371897b2dca244bb8dc0673b65b585cfdbd0cab91bd80cc69e99607392e0` |
| Quit | 5 | `78 05 00 00 00 00 00 00 00 00 00 00 00 00 00 7D` | `b29369d5fa94dcfec94de8eecd323d356233d65e45fa126461ae0f639fb4b341` |

The capture window is 20 seconds after the start ACK, then one stop and one quit.
Successful closeout requires their journaled ACKs and a two-second quiet drain window;
any PPG packet in that window is preserved and restarts the quiet timer. A ten-second
drain deadline fails closed if the device continues sending. Write ACK timeout is five
seconds. Parser exceptions, link loss and storage failures preserve available evidence
and never restart acquisition. A partial failure may issue at most one journaled
best-effort quit, never another start. The persisted claim is not reset by restart,
failure, logout or finalization; only a future engineering build may explicitly supersede
it. Clearing app data/uninstalling removes app-private evidence and is not a supported
guard reset.

The spool is `JCV8PPG1` plus big-endian 32-bit lengths and each original packet.
Zeros, repeats, status/data packets and nonhistorical lengths are preserved. The
historical 20-packet / 3,774-byte spool pattern is informational only; actual packet
sizes, opcodes and uninterpreted header/index/trailer bytes are authoritative. Sequence
field meaning remains unknown. SDK parsing follows the vendor behavior described below,
with no normalization, units or physiological inference.

Only complete verified source evidence can become `CERTIFIED` /
`CERTIFIED_E2E_LOSSLESS_SOURCE`. All outcomes remain `RESEARCH_NATIVE_ONLY`,
`NONE_UNTIL_SEMANTICS_CONFIRMED`, `LOCAL_SOURCE_EVIDENCE_ONLY`,
`UNKNOWN_VENDOR_UNIT`, with null sample rate and sampling interval. Enforced flags:
`RAW_PPG_NOT_GLUCOSE`, `NO_GLUCOSE_CANONICAL_MAPPING`, `NO_GLUCOSE_INFERENCE`,
`NO_CGM_SUBSTITUTION`. Vendor Bloodsugar naming is a protocol label only.

**Inspect Saved Raw PPG Certification**, **Show / Copy / Share Raw PPG Certification
JSON**, and **Share Raw PPG Raw Spool** read only local persisted evidence: zero BLE,
network or acquisition, and no Base44 or canonical delivery. Interrupted attempts remain
uncertified and exportable offline; there is no restart-triggered capture. Inspect
rechecks bytes, hashes, offsets and journal ancestry; terminal spool sharing rejects
length/hash changes. Physical certification must be completed on the device: passing
fixture tests or building the APK does not constitute a physical ACK/capture.

## Commands and Status

`ppgWithMode` creates a 16-byte command beginning with `DeviceConst.CMD_Get_Bloodsugar` (`0x78`) and uses the final byte as the low byte of the sum of all preceding bytes. Modes are documented as 1=start, 2=send measurement result, 3=stop, 4=send progress, and 5=quit/exit. The builder sets its static `startBloodsugar` flag true only for mode 1.

The vendor demo starts with mode 1, stops with mode 3 when its five-minute timer finishes, and sends mode 5 when the activity is destroyed. It also sends modes 2 and 4 during its result/progress workflow. The SDK source comment incorrectly says the method turns on ECG measurement, while the demos and surrounding parser route it through the BGEM/blood-glucose-risk screen.

While `startBloodsugar` is true, command `0x78` is decoded as vendor type 118 with only the `Type` status field. The demo treats status 0 as normal/continue, 2 as battery below 10%, and 3 as unable to start while running. These are vendor workflow states, not blood-glucose measurements.

Command `0x3A` is decoded as vendor type 119 (`Blood_glucose_data`, `End=false`). The parser returns `Time` (host wall-clock receipt time) and `PPG` only for lengths 153 and 203. It exposes no sequence number or explicit PPG quality field. Type 119 is retained as a vendor type, not converted to a canonical glucose observation.

## Payload Layout Inconsistency

Both supported parser branches skip the first three notification bytes and return 50 integer values, but their byte operations differ:

- 153 bytes: 150 bytes are read in groups of three as `b0 * 65536 + b1 * 256 + b2`.
- 203 bytes: 200 bytes remain, but the loop advances by four while computing `b0 * 16777216 + b0 * 65536 + b1 * 256 + b2`; it reuses `b0`, skips the fourth byte, and still returns 50 values.

The 203-byte behavior is preserved as observed source behavior rather than normalized to the 153-byte layout. Both use the vendor field name `PPG`, but physical optical meaning, scale, timing, packet structure, and calibration remain unvalidated. Unknown lengths are retained losslessly and reported separately.

The SDK defines fields such as `bloodTestValue` and `bloodPercent`, but the type-119 parser shown here does not populate them. If any callback does provide such keys, the capture preserves their original names and values under `VENDOR_DERIVED_BIOMARKER`; it never maps them to measured glucose or mg/dL.