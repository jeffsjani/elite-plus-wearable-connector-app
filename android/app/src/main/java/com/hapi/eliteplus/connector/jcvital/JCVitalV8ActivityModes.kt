package com.hapi.eliteplus.connector.jcvital

/** Exact active mode table from the vendor Android V8 SDK ExerciseMode.modes array. */
object JCVitalV8ActivityModes {
    private val canonical = mapOf(
        0 to "RUN",
        1 to "CYCLE",
        2 to "BADMINTON",
        3 to "FOOTBALL",
        4 to "TENNIS",
        5 to "YOGA",
        6 to "BREATHING_TRAINING",
        7 to "DANCE",
        8 to "BASKETBALL",
        9 to "WALK",
        10 to "WORKOUT_GENERIC",
        11 to "CRICKET",
        12 to "HIKING",
        13 to "AEROBICS",
        14 to "TABLE_TENNIS",
    )

    fun canonicalType(vendorMode: Int?): String = when (vendorMode) {
        null -> "OTHER_VENDOR_MODE_UNKNOWN"
        else -> canonical[vendorMode] ?: "OTHER_VENDOR_MODE_$vendorMode"
    }
}
