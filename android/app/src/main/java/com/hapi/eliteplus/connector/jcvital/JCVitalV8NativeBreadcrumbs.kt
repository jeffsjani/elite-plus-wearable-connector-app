package com.hapi.eliteplus.connector.jcvital

/**
 * Bounded native stage trail persisted on every record so it survives process death. The previous launch's trail is
 * rotated to `previous` on construction. Details hold only small scalar values, never observations or payloads.
 */
class JCVitalV8NativeBreadcrumbs(private val store: Store, private val clock: () -> Long = System::currentTimeMillis) {
    interface Store {
        fun read(key: String): String?

        /** Must be synchronous (e.g. SharedPreferences.commit) so the write survives an immediate crash. */
        fun write(key: String, value: String)
    }

    private val current = ArrayDeque<String>()
    private val previous: String

    init {
        previous = store.read(KEY_CURRENT).orEmpty()
        store.write(KEY_PREVIOUS, previous)
        store.write(KEY_CURRENT, "")
    }

    @Synchronized
    fun record(stage: String, detail: Map<String, Any?> = emptyMap()) {
        val encodedDetail = detail.entries.joinToString(";") { (key, value) -> "${clean(key)}=${scalar(value)}" }
        current.addLast("${JCVitalV8Time.isoUtc(clock())}\t${clean(stage)}\t$encodedDetail")
        while (current.size > MAX_ENTRIES) current.removeFirst()
        try {
            store.write(KEY_CURRENT, current.joinToString("\n"))
        } catch (_: Throwable) {
            // Breadcrumbs must never break a sync.
        }
    }

    @Synchronized
    fun snapshot(): Map<String, Any?> = linkedMapOf(
        "current" to decode(current.joinToString("\n")),
        "previous" to decode(previous),
    )

    private fun scalar(value: Any?): String = when (value) {
        null -> "null"
        is Number, is Boolean -> value.toString()
        else -> clean(value.toString()).take(MAX_TEXT)
    }

    private fun clean(text: String): String = text.replace(Regex("[\\t\\n\\r;=]"), "_")

    companion object {
        const val PREFERENCES_NAME = "elitePlus.jcvital.nativeBreadcrumbs"
        const val MAX_ENTRIES = 60
        private const val KEY_CURRENT = "current"
        private const val KEY_PREVIOUS = "previous"
        private const val MAX_TEXT = 80

        fun decode(encoded: String): List<Map<String, Any?>> = encoded.lineSequence().filter { it.isNotBlank() }.mapNotNull { line ->
            val parts = line.split('\t')
            if (parts.size < 2) return@mapNotNull null
            val detail = linkedMapOf<String, Any?>()
            parts.getOrNull(2)?.split(';')?.filter { it.contains('=') }?.forEach { pair ->
                val (key, raw) = pair.split('=', limit = 2)
                detail[key] = when {
                    raw == "null" -> null
                    raw == "true" || raw == "false" -> raw.toBoolean()
                    else -> raw.toLongOrNull() ?: raw.toDoubleOrNull() ?: raw
                }
            }
            linkedMapOf("at" to parts[0], "stage" to parts[1], "detail" to detail)
        }.toList()
    }
}
