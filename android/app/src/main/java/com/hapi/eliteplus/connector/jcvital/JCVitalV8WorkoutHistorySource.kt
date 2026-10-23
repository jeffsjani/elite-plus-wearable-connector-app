package com.hapi.eliteplus.connector.jcvital

import com.jstyle.blesdkv8.constant.DeviceKey

internal object JCVitalV8WorkoutHistorySource {
    val fields = listOf("date", "sportModel", "heartRate", "ExerciseTime", "step", "sportModelSpeed", "calories", "distance")

    fun observations(vendor: Map<String?, Any?>, capture: JCVitalV8SourceJournal.Capture?, sessionId: String): List<JCVitalV8EventNormalizer.Event> {
        val records = vendor[DeviceKey.Data] as? List<*>
            ?: return listOf(error("WORKOUT_HISTORY_LIST_REQUIRED"))
        return records.mapIndexed { index, raw ->
            val record = raw as? Map<*, *> ?: return@mapIndexed error("WORKOUT_HISTORY_RECORD_MAP_REQUIRED")
            if (fields.any { !record.containsKey(it) || (record[it] != null && record[it] !is String) }) {
                return@mapIndexed error("WORKOUT_HISTORY_VENDOR_FIELD_MISSING_OR_MALFORMED")
            }
            val id = capture?.recordIds?.getOrNull(index)
                ?: return@mapIndexed error("WORKOUT_HISTORY_RECORD_ANCESTRY_REQUIRED")
            JCVitalV8EventNormalizer.Event(JCVitalV8EventNormalizer.EVENT_OBSERVATION, linkedMapOf(
                "id" to id, "sourceEnvelopeId" to id, "sourceCallbackId" to capture.callbackId,
                "sourceIndex" to index, "sessionId" to sessionId, "vendorDataType" to "29",
                "metricType" to "WORKOUT_HISTORY_NATIVE_SOURCE", "vendorTimestamp" to record["date"],
                "sdkRecord" to JCVitalV8SourceSnapshot.encode(record, 1024 * 1024),
                "semanticClassification" to "RESEARCH_NATIVE_ONLY",
                "semanticConfidence" to "UNKNOWN_VENDOR_SEMANTICS",
                "canonicalAuthority" to "NONE_UNTIL_SEMANTICS_CONFIRMED",
            ))
        }
    }

    private fun error(message: String) = JCVitalV8EventNormalizer.Event(
        JCVitalV8EventNormalizer.EVENT_PARSE_ERROR, mapOf("message" to message, "vendorDataType" to "29"),
    )
}
