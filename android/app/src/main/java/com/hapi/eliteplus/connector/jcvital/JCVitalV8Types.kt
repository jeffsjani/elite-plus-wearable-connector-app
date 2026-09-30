package com.hapi.eliteplus.connector.jcvital

import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone

enum class JCVitalV8PermissionStatus { AUTHORIZED, DENIED, NOT_REQUESTED, BLUETOOTH_DISABLED, BLUETOOTH_UNAVAILABLE }

enum class JCVitalV8ConnectionState { DISCONNECTED, SCANNING, CONNECTING, CONNECTED, INITIALIZING, READY, ERROR }

enum class JCVitalV8ErrorCode {
    BLUETOOTH_UNAVAILABLE,
    BLUETOOTH_DISABLED,
    PERMISSION_DENIED,
    SCAN_FAILED,
    DEVICE_NOT_FOUND,
    CONNECTION_FAILED,
    CONNECTION_LOST,
    SERVICE_DISCOVERY_FAILED,
    NOTIFICATION_SETUP_FAILED,
    SDK_INITIALIZATION_FAILED,
    COMMAND_FAILED,
    RESPONSE_PARSE_FAILED,
    UNSUPPORTED_OPERATION,
}

class JCVitalV8Exception(val code: JCVitalV8ErrorCode, message: String) : Exception(message)

data class JCVitalV8DiscoveredDevice(
    val id: String,
    val name: String?,
    val macAddress: String,
    val rssi: Int,
    val bonded: Boolean,
    val connectable: Boolean,
    val lastSeenAt: Long,
    val advertisesJcvitalService: Boolean,
) {
    fun toMap(): Map<String, Any?> = linkedMapOf(
        "id" to id,
        "name" to name,
        "macAddress" to macAddress,
        "rssi" to rssi,
        "bonded" to bonded,
        "connectable" to connectable,
        "lastSeenAt" to JCVitalV8Time.isoUtc(lastSeenAt),
        "advertisesJcvitalService" to advertisesJcvitalService,
    )
}

object JCVitalV8Time {
    fun isoUtc(epochMillis: Long): String {
        val format = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
        format.timeZone = TimeZone.getTimeZone("UTC")
        return format.format(Date(epochMillis))
    }
}
