package com.hapi.eliteplus.connector.jcvital

import java.lang.reflect.Array as ReflectArray
import org.json.JSONArray
import org.json.JSONObject

/** Typed SDK object snapshot: map entries retain null keys, order, and numeric/array types. */
internal object JCVitalV8SourceSnapshot {
    const val VERSION = "sdk-object-snapshot-1"
    const val MODEL_VERSION = "jcvital-l0-source-envelope-1"
    class Unsupported(message: String) : IllegalArgumentException(message)

    fun encode(value: Any?, maxBytes: Int): String {
        val out = StringBuilder()
        var bytes = 0
        fun append(text: String) {
            bytes += text.toByteArray(Charsets.UTF_8).size
            require(bytes <= maxBytes) { "ENTRY_TOO_LARGE" }
            out.append(text)
        }
        fun quote(text: String) {
            append("\"")
            text.forEach { ch ->
                append(when (ch) {
                    '"' -> "\\\""
                    '\\' -> "\\\\"
                    '\b' -> "\\b"
                    '\u000C' -> "\\f"
                    '\n' -> "\\n"
                    '\r' -> "\\r"
                    '\t' -> "\\t"
                    else -> if (ch.code < 32 || ch.isSurrogate()) "\\u%04x".format(ch.code) else ch.toString()
                })
            }
            append("\"")
        }
        val ancestors = java.util.IdentityHashMap<Any, Boolean>()
        fun write(raw: Any?, depth: Int) {
            require(depth <= 64) { "MAX_DEPTH_EXCEEDED" }
            if (raw == null) { append("null"); return }
            val compound = raw is Map<*, *> || raw is List<*> || raw.javaClass.isArray
            if (compound && ancestors.put(raw, true) != null) throw Unsupported("CYCLIC_OBJECT")
            append("{\"type\":")
            when (raw) {
                is String, is Char, is Boolean, is Byte, is Short, is Int, is Long,
                is Float, is Double, is java.math.BigInteger, is java.math.BigDecimal -> {
                    quote(raw.javaClass.simpleName)
                    append(",\"value\":")
                    // Numeric lexical form is a string, preserving non-finite and large values.
                    if (raw is Boolean) append(raw.toString()) else quote(raw.toString())
                }
                is Map<*, *> -> {
                    quote("Map")
                    append(",\"entries\":[")
                    raw.entries.forEachIndexed { index, entry ->
                        if (index > 0) append(",")
                        append("{\"key\":"); write(entry.key, depth + 1)
                        append(",\"value\":"); write(entry.value, depth + 1); append("}")
                    }
                    append("]")
                }
                is List<*> -> {
                    quote("List"); append(",\"values\":[")
                    raw.forEachIndexed { index, item ->
                        if (index > 0) append(",")
                        write(item, depth + 1)
                    }
                    append("]")
                }
                else -> if (raw.javaClass.isArray) {
                    quote(raw.javaClass.componentType.name + "[]")
                    append(",\"values\":[")
                    for (index in 0 until ReflectArray.getLength(raw)) {
                        if (index > 0) append(",")
                        write(ReflectArray.get(raw, index), depth + 1)
                    }
                    append("]")
                } else throw Unsupported("UNSUPPORTED_OBJECT:${raw.javaClass.name}")
            }
            append("}")
            if (compound) ancestors.remove(raw)
        }
        write(value, 0)
        return out.toString()
    }

    /** Detached callback copy; unlike sanitize(), primitive arrays never become JVM identity strings. */
    fun copy(value: Any?, depth: Int = 0): Any? {
        require(depth <= 64) { "MAX_DEPTH_EXCEEDED" }
        return when (value) {
            null, is String, is Char, is Boolean, is Number -> value
            is Map<*, *> -> value.entries.associateTo(LinkedHashMap<Any?, Any?>()) {
                copy(it.key, depth + 1) to copy(it.value, depth + 1)
            }
            is List<*> -> value.map { copy(it, depth + 1) }
            else -> if (value.javaClass.isArray) {
                // Preserve primitive array types and object-array component types.
                val component = value.javaClass.componentType
                val result = ReflectArray.newInstance(if (component.isPrimitive) component else Any::class.java, ReflectArray.getLength(value))
                for (i in 0 until ReflectArray.getLength(value)) ReflectArray.set(result, i, copy(ReflectArray.get(value, i), depth + 1))
                result
            } else throw Unsupported("UNSUPPORTED_OBJECT:${value.javaClass.name}")
        }
    }

    fun lexicalTokens(text: String): List<Map<String, Any?>> =
        Regex("[^,\\s\\[\\]]+|[,\\s\\[\\]]").findAll(text).mapIndexed { index, match ->
            require(index < 4096) { "LEXICAL_TOKEN_LIMIT_EXCEEDED" }
            val delimiter = match.value.length == 1 && (match.value[0].isWhitespace() || match.value[0] in ",[]")
            linkedMapOf(
                "tokenIndex" to index, "start" to match.range.first, "endExclusive" to match.range.last + 1,
                "lexeme" to match.value,
                "kind" to if (delimiter) "DELIMITER" else "VALUE",
                "integerParseStatus" to if (delimiter) "NOT_APPLICABLE" else if (match.value.toIntOrNull() != null) "VALID_INT32" else "INVALID_INT32",
            )
        }.toList()

    fun arrayAnnotations(record: Any?, maxBytes: Int): JSONArray {
        val result = JSONArray()
        if (record !is Map<*, *>) return result
        record.forEach { (key, value) ->
            if (value is List<*> || value?.javaClass?.isArray == true) {
                val length = if (value is List<*>) value.size else ReflectArray.getLength(value)
                val slots = JSONArray()
                for (index in 0 until length) {
                    val item = if (value is List<*>) value[index] else ReflectArray.get(value, index)
                    val snapshot = encode(item, maxBytes)
                    slots.put(JSONObject().put("sourceIndex", index)
                        .put("originalValue", if (item == null) JSONObject.NULL else JSONObject(snapshot))
                        .put("parseStatus", when {
                            item == null -> "NULL"
                            item.toString().toIntOrNull() != null -> "VALID_INT32"
                            else -> "INVALID_INT32"
                        }))
                }
                result.put(JSONObject().put("fieldKeySnapshot", if (key == null) JSONObject.NULL else JSONObject(encode(key, maxBytes)))
                    .put("sourceLength", length).put("slots", slots))
            }
        }
        return result
    }
}
