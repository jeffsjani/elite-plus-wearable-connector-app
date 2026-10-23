export interface ReadinessInputEntry {
  sourceMetric: string
  canonicalMetric: string | null
  semanticVersion: string
  minimumConfidence: string
  minimumCoverage: string
  sourceAuthority: string
  readinessEligible: boolean
  reason: string
}

const notApproved = (sourceMetric: string, canonicalMetric: string | null, reason: string): ReadinessInputEntry => ({
  sourceMetric,
  canonicalMetric,
  semanticVersion: 'UNAPPROVED',
  minimumConfidence: 'NOT_ESTABLISHED',
  minimumCoverage: 'NOT_ESTABLISHED',
  sourceAuthority: 'JCVITAL_NATIVE; no new readiness authority granted',
  readinessEligible: false,
  reason,
})

/** Captured and canonical states are intentionally independent from readiness eligibility. */
export const ReadinessInputRegistry: readonly ReadinessInputEntry[] = [
  notApproved('HEART_RATE_CONTINUOUS', 'body.heart_rate', 'Existing heart-rate mapping is preserved; no new readiness approval in P1-2A.'),
  notApproved('HEART_RATE_WORKOUT', 'body.heart_rate', 'Live workout HR may not be used for readiness without the existing source policy.'),
  notApproved('REALTIME_STEPS', null, 'Real-time Type 23 steps are not an approved readiness input.'),
  notApproved('REALTIME_CALORIES', null, 'Real-time Type 23 calories are not an approved readiness input.'),
  notApproved('REALTIME_DISTANCE', null, 'Real-time Type 23 distance semantics are unqualified.'),
  notApproved('REALTIME_EXERCISE_MINUTES', null, 'Real-time Type 23 exercise-minute semantics are unqualified.'),
  notApproved('REALTIME_ACTIVE_TIME', null, 'Real-time Type 23 ExerciseTime unit and meaning are unqualified.'),
  notApproved('REALTIME_HEART_RATE', null, 'Type 23 realtime HR callback is not approved as a readiness source.'),
  notApproved('REALTIME_TEMPERATURE', null, 'Type 23 temperature signal is not approved as a readiness source.'),
  notApproved('MEASUREMENT_HEART_RATE', null, 'Type 74 measurement HR is not approved as a readiness source.'),
  notApproved('SPO2', 'body.oxygen_saturation', 'Canonical mapping does not independently authorize readiness or scoring.'),
  notApproved('WEARABLE_TEMPERATURE', 'body.wearable_temperature', 'Canonical mapping does not independently authorize readiness or scoring.'),
  notApproved('HRV_VENDOR', null, 'Type 42 HRV unit, definition, cadence and canonical compatibility are unproven.'),
  notApproved('HEART_RATE_AUTOMATIC', null, 'Type 42 embedded HR lacks duplicate/source-policy validation against Types 27/82.'),
  notApproved('STRESS_VENDOR', null, 'Vendor stress is source-only and has no approved Elite+ scoring contract.'),
  notApproved('FATIGUE_VENDOR', null, 'Vendor fatigue scale and meaning are unproven.'),
  notApproved('BP_SYSTOLIC_ESTIMATED', null, 'Estimated vendor BP is not measured BP and has no approved scoring contract.'),
  notApproved('BP_DIASTOLIC_ESTIMATED', null, 'Estimated vendor BP is not measured BP and has no approved scoring contract.'),
  notApproved('VASCULAR_AGING_VENDOR', null, 'Vendor vascular aging must not be treated as chronological age or a readiness input.'),
  notApproved('PPI', null, 'PPI slots cannot be converted to HRV without an approved definition and unit.'),
  notApproved('DAILY_STEPS', null, 'Activity 24/25 summaries and epochs have not reconciled.'),
  notApproved('DAILY_DISTANCE', null, 'Distance unit, window, and summary/epoch reconciliation are unproven.'),
  notApproved('DAILY_CALORIES', null, 'Calorie semantics, window, and summary/epoch reconciliation are unproven.'),
  notApproved('WORKOUT_ELAPSED_SECONDS', null, 'Type 82 elapsed counter reset, pause/resume, and interval semantics are unqualified.'),
  notApproved('DAILY_EXERCISE_MINUTES', null, 'Exercise-minute semantics are not established.'),
  notApproved('DAILY_ACTIVE_MINUTES', null, 'Activity window and ExerciseTime unit are not established.'),
  notApproved('DAILY_GOAL_COMPLETION', null, 'Vendor goal definition and reset boundary are unqualified.'),
  notApproved('DETAILED_ACTIVITY_EPOCH_STEPS', null, 'Type 25 epoch totals must reconcile with Type 24 before readiness use.'),
  notApproved('DETAILED_ACTIVITY_STEPS_TOTAL', null, 'Type 25 summary/epoch relationship is unqualified.'),
  notApproved('DETAILED_ACTIVITY_DISTANCE', null, 'Type 25 distance unit and daily reconciliation are unqualified.'),
  notApproved('DETAILED_ACTIVITY_CALORIES', null, 'Type 25 calorie unit and daily reconciliation are unqualified.'),
  notApproved('SLEEP_DURATION_SOURCE', null, 'Sleep duration unit and episode semantics remain unqualified.'),
  notApproved('SLEEP_STAGE_CODES', null, 'Vendor stage-code semantics are not approved for canonical mapping.'),
  notApproved('SLEEP_STAGE_UNIT_LENGTH', null, 'Stage-array time alignment and unit semantics are unqualified.'),
  notApproved('SLEEP_MOVEMENT_CODES', null, 'Sleep movement codes and alignment are unqualified.'),
  notApproved('WORKOUT_DURATION', null, 'Type 29 duration unit and Type 29/82 linkage remain unqualified.'),
  notApproved('WORKOUT_HR', null, 'Type 29 workout identity/linkage and source policy remain unqualified.'),
  notApproved('WORKOUT_STEPS', null, 'Workout units, mode semantics, timestamps, and identity remain unqualified.'),
  notApproved('WORKOUT_PACE', null, 'Type 29 pace semantics are not qualified.'),
  notApproved('WORKOUT_DISTANCE', null, 'Workout distance unit and session identity remain unqualified.'),
  notApproved('WORKOUT_CALORIES', null, 'Workout calorie semantics and session identity remain unqualified.'),
  notApproved('WORKOUT_LIVE_STEPS', null, 'Type 82 live step counter identity and interval semantics are unqualified.'),
  notApproved('WORKOUT_LIVE_CALORIES', null, 'Type 82 live calorie semantics and session identity are unqualified.'),
]

export function readinessEntryForSource(sourceMetric: string): ReadinessInputEntry | undefined {
  return ReadinessInputRegistry.find((entry) => entry.sourceMetric === sourceMetric)
}
