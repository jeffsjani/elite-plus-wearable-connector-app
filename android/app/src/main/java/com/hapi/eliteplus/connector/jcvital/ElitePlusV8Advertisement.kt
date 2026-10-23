package com.hapi.eliteplus.connector.jcvital

import java.util.Locale

object ElitePlusV8Advertisement {
    private val whitespace = Regex("[\\s\\p{Z}]+")
    private val families = listOf("JCV8B", "JCV8", "PRO_V8", "V8")

    fun normalizedName(name: String?): String? =
        name?.replace('\u0000', ' ')?.replace(whitespace, " ")?.trim()?.takeIf { it.isNotEmpty() }

    fun isElitePlusV8Advertisement(name: String?, advertisesJcvitalService: Boolean): Boolean {
        if (advertisesJcvitalService) return true
        val normalized = normalizedName(name)?.uppercase(Locale.US) ?: return false
        return families.any { normalized == it || normalized.startsWith("$it ") }
    }
}
