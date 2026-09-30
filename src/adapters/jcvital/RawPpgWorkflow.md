# JCVital V8 PPG Workflow Notes

Elite+ labels this capture `PPG_WORKFLOW_RAW_VENDOR`. The checked-in SDK does not implement `realtimePPGData_V8` or `arrayPPGData`; this workflow uses `BleSDK.ppgWithMode` and the vendor's BGEM/blood-glucose-risk UI. Vendor naming is not evidence of a measured glucose result or calibrated generic PPG.

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