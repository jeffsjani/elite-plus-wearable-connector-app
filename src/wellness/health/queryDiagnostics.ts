export const QUERY_MESSAGES = {
  USAGE_ACCESS_DENIED: 'Usage Access was not allowed by AppOps.',
  USAGE_STATS_UNAVAILABLE: 'Usage Stats service or unlocked user is unavailable.',
  SECURITY_EXCEPTION: 'Android rejected the operation for security reasons.',
  INVALID_QUERY: 'Query interval is invalid or outside the allowed bounds.',
  QUERY_RETURNED_NULL: 'Android returned no UsageEvents object.',
  QUERY_ITERATION_FAILED: 'UsageEvents iteration failed.',
  BRIDGE_FAILURE: 'Native bridge serialization or response validation failed.',
  EVENT_LIMIT_EXCEEDED: 'Supported event limit exceeded.',
  SEMANTIC_PROCESSING_FAILED: 'Digital Wellness result processing failed.',
  QUERY_FAILED: 'Digital Wellness query failed.',
} as const
export type QueryErrorCode = keyof typeof QUERY_MESSAGES
const STAGES = ['ACCESS_CHECK', 'SERVICE_LOOKUP', 'QUERY_EVENTS', 'EVENT_ITERATION',
  'BRIDGE_SERIALIZATION', 'SEMANTIC_PROCESSING', 'UNKNOWN'] as const
export type QueryErrorStage = typeof STAGES[number]
export interface QueryDiagnostics {
  error_code: QueryErrorCode
  error_stage: QueryErrorStage
  native_exception_class: string
  sanitized_error_message: string
  usage_access_at_query: 'GRANTED' | 'DENIED' | 'UNKNOWN'
  usage_stats_service_available: boolean | null
  query_start: number
  query_end: number
  android_api_level: number | null
  appops_result: number | null
  appops_api_branch: 'API_29_PLUS_UNSAFE_CHECK_OP_NO_THROW' | 'UNKNOWN'
  native_validation?: NativeValidationDiagnostics
}
const VALIDATION_RULES = ['START_MISSING', 'END_MISSING', 'START_NOT_NUMERIC', 'END_NOT_NUMERIC',
  'START_NOT_FINITE', 'END_NOT_FINITE', 'START_NOT_INTEGER_MS', 'END_NOT_INTEGER_MS', 'START_OUT_OF_RANGE',
  'END_OUT_OF_RANGE', 'START_NEGATIVE', 'END_NEGATIVE', 'START_NOT_BEFORE_END', 'END_IN_FUTURE',
  'DURATION_EXCEEDS_MAX', 'LOOKBACK_EXCEEDS_MAX'] as const
export type NativeValidationRule = typeof VALIDATION_RULES[number]
export interface NativeValidationDiagnostics {
  validation_rule_failed: NativeValidationRule | null
  native_now: number | null
  requested_start: number | null
  requested_end: number | null
  effective_end: number | null
  duration_ms: number | null
  lookback_ms: number | null
  clock_skew_ms: number | null
}
const VALIDATION_NUMBERS = ['native_now', 'requested_start', 'requested_end', 'effective_end',
  'duration_ms', 'lookback_ms', 'clock_skew_ms'] as const
function nativeValidation(raw: Record<string, unknown>): NativeValidationDiagnostics | undefined {
  const data = isObject(raw.native_validation) ? raw.native_validation : raw
  if (!('validation_rule_failed' in data)) return undefined
  const rule = VALIDATION_RULES.find((item) => item === data.validation_rule_failed) ?? null
  const result = { validation_rule_failed: rule } as NativeValidationDiagnostics
  for (const key of VALIDATION_NUMBERS) {
    const value = data[key]
    result[key] = typeof value === 'number' && Number.isSafeInteger(value) ? value : null
  }
  return result
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}
function object(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}
export function queryDiagnostics(
  value: unknown, start: number, end: number,
  code: QueryErrorCode = 'QUERY_FAILED', stage: QueryErrorStage = 'UNKNOWN',
  previous?: QueryDiagnostics,
): QueryDiagnostics {
  const envelope = object(value)
  const data = object(envelope.data ?? envelope.diagnostics ?? value)
  const rawCode = data.error_code ?? envelope.code
  const errorCode = typeof rawCode === 'string' && Object.hasOwn(QUERY_MESSAGES, rawCode)
    ? rawCode as QueryErrorCode : code
  const errorStage = STAGES.find((item) => item === data.error_stage) ?? stage
  const exception = ['NONE', 'java.lang.SecurityException', 'java.lang.IllegalArgumentException',
    'java.lang.IllegalStateException', 'java.lang.NullPointerException', 'java.lang.RuntimeException']
    .find((item) => item === data.native_exception_class) ?? 'NONE'
  const validation = nativeValidation(data)
  return {
    ...(validation ? { native_validation: validation } : {}),
    error_code: errorCode, error_stage: errorStage, native_exception_class: exception,
    sanitized_error_message: QUERY_MESSAGES[errorCode],
    usage_access_at_query: data.usage_access_at_query === 'GRANTED' || data.usage_access_at_query === 'DENIED'
      ? data.usage_access_at_query : previous?.usage_access_at_query ?? 'UNKNOWN',
    usage_stats_service_available: typeof data.usage_stats_service_available === 'boolean'
      ? data.usage_stats_service_available : previous?.usage_stats_service_available ?? null,
    query_start: start, query_end: end,
    android_api_level: typeof data.android_api_level === 'number' && Number.isInteger(data.android_api_level)
      && data.android_api_level >= 29 && data.android_api_level <= 36
      ? data.android_api_level : previous?.android_api_level ?? null,
    appops_result: typeof data.appops_result === 'number' && Number.isInteger(data.appops_result)
      && data.appops_result >= 0 && data.appops_result <= 4
      ? data.appops_result : previous?.appops_result ?? null,
    appops_api_branch: data.appops_api_branch === 'API_29_PLUS_UNSAFE_CHECK_OP_NO_THROW'
      ? data.appops_api_branch : previous?.appops_api_branch ?? 'UNKNOWN',
  }
}
