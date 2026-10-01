package com.hapi.eliteplus.connector.jcvital

import android.annotation.SuppressLint
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothDevice
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.BluetoothStatusCodes
import android.bluetooth.le.ScanCallback
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanSettings
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import org.json.JSONObject
import androidx.core.content.ContextCompat
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.AutoTestMode
import com.jstyle.blesdkv8.model.AutoMode
import com.jstyle.blesdkv8.model.ExerciseMode
import java.util.TimeZone
import java.util.UUID

/**
 * Native JCVital Pro V8 transport. Mirrors the vendor reference flow in
 * vendor/jcvital/android/sdk/v8_kotlion/app/src/main/java/com/jstyle/testv8/ble/BleService.kt:
 * connectGatt(TRANSPORT_LE) -> discoverServices after 600 ms -> enable notify on fff7 via CCCD ->
 * write SDK commands to fff6 -> feed notifications into BleSDK.DataParsingWithData.
 *
 * All state is confined to the main looper; public methods may be called from any thread.
 */
@SuppressLint("MissingPermission")
class JCVitalV8Manager(context: Context, private val listener: Listener) {
    fun interface Listener {
        fun onEvent(name: String, payload: Map<String, Any?>)
    }

    private enum class InitStep { NONE, MTU, NOTIFICATIONS, HANDSHAKE }

    private class Command(val name: String, val bytes: ByteArray, val onWriteComplete: ((Boolean) -> Unit)? = null)

    private class PendingRequest(
        val expected: MutableSet<String>,
        val complete: (missing: Set<String>) -> Unit,
    ) {
        var timeout: Runnable? = null
    }

    private class HistoricalRequest(
        val syncId: String,
        val name: String,
        val dataType: String,
        val command: (Byte) -> ByteArray,
        val startedAt: Long,
        val callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit,
    ) {
        val observations = LinkedHashMap<String, Map<String, Any?>>()
        val parseErrors = mutableListOf<Map<String, Any?>>()
        var packetCount = 0
        var recordGroupCount = 0
        var duplicateCount = 0
        var timeout: Runnable? = null
    }

    private class MonitoringRequest(
        val callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit,
    ) {
        val remaining = ArrayDeque(MONITOR_MODES)
        val configurations = LinkedHashMap<String, Any?>()
        var current: Pair<String, AutoMode>? = null
        var timeout: Runnable? = null
    }

    private class WorkoutCapture(
        val session: JCVitalV8WorkoutSession,
        val startCallback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit,
    ) {
        var stopCallback: ((Map<String, Any?>?, JCVitalV8Exception?) -> Unit)? = null
        var startTimeout: Runnable? = null
        var stopTimeout: Runnable? = null
        var heartbeatRunnable: Runnable? = null
        var nextHeartbeatUptime: Long = 0L
        val parseErrors = mutableListOf<Map<String, Any?>>()
    }

    private class RawEcgCapture(
        val session: JCVitalV8RawEcgSession,
        var startCallback: ((Map<String, Any?>?, JCVitalV8Exception?) -> Unit)?,
        val packetStore: JCVitalV8RawEcgPacketStore,
    ) {
        var stopCallback: ((Map<String, Any?>?, JCVitalV8Exception?) -> Unit)? = null
        var startTimeout: Runnable? = null
        var stopTimeout: Runnable? = null
        var noDataTimeout: Runnable? = null
        var controlWriteFailed = false
        var storageErrorCount = 0
        val parseErrors = mutableListOf<Map<String, Any?>>()
        var diagnosticState = "IDLE"
        var startEpochMillis = System.currentTimeMillis()
        var measurementStartCommandQueuedAt: String? = null
        var measurementStartCommandWriteAckAt: String? = null
        var realtimeFlagCommandQueuedAt: String? = null
        var realtimeFlagCommandWriteAckAt: String? = null
        var firstNotificationAfterStartAt: String? = null
        val notificationDiagnostics = JCVitalV8RawEcgNotificationDiagnostics(System.currentTimeMillis())
        var firstCommand07NotificationAt: String? = null
        var lastCommand07NotificationAt: String? = null
        var command07NotificationSamples = mutableListOf<Map<String, Any?>>()
        var firstType64CallbackAt: String? = null
        var lastType64CallbackAt: String? = null
        var type64CallbackCount = 0
        var type64SampleList = mutableListOf<Map<String, Any?>>()
        var vendorDataTypesSeenAfterEcgStart = linkedMapOf<String, MutableMap<String, Any?>>()
        var ecgPpgStatusRequestCount = 0
        var ecgPpgStatusResponseCount = 0
        var traceEcgStatusValues = mutableListOf<Int>()
        var firstEcgStatusAt: String? = null
        var firstDataAvailableStatusAt: String? = null
        var ecgNoDataAfter10s = false
        var diagnosticClassification: String? = null
        val ecgPpgStatusRequestSupport = "NO_REQUEST_METHOD_FOUND"
        val ecgPpgStatusRequestTimes = mutableListOf<String>()

        fun recordQueued(commandName: String) {
            val now = JCVitalV8Time.isoUtc(System.currentTimeMillis())
            when (commandName) {
                "SetDeviceMeasurementWithType(ECG,50000,true)" -> measurementStartCommandQueuedAt = now
                "SetDeviceMeasurementWithType(ECG,50,000,true)" -> measurementStartCommandQueuedAt = now
                "setECGRealtimeDuringHRVEnabled(true)" -> realtimeFlagCommandQueuedAt = now
            }
            if (diagnosticState == "IDLE") diagnosticState = "START_COMMANDS_QUEUED"
        }

        fun recordWriteAck(commandName: String) {
            val now = JCVitalV8Time.isoUtc(System.currentTimeMillis())
            when (commandName) {
                "SetDeviceMeasurementWithType(ECG,50000,true)" -> measurementStartCommandWriteAckAt = now
                "SetDeviceMeasurementWithType(ECG,50,000,true)" -> measurementStartCommandWriteAckAt = now
                "setECGRealtimeDuringHRVEnabled(true)" -> realtimeFlagCommandWriteAckAt = now
            }
            if (diagnosticState == "START_COMMANDS_QUEUED") diagnosticState = "START_COMMANDS_WRITING"
        }

        fun noteFirstNotificationAt(receivedAt: String, notification: ByteArray) {
            if (firstNotificationAfterStartAt == null) firstNotificationAfterStartAt = receivedAt
            if ((notification.firstOrNull()?.toInt()?.and(0xFF)) == JCVitalV8RawEcgSession.ECG_COMMAND_BYTE) {
                noteCommand07Notification(notification, receivedAt)
            }
        }

        fun noteCommand07Notification(notification: ByteArray, receivedAt: String) {
            val isWaveformCandidate = notificationDiagnostics.noteCommand07Notification(notification)
            if (firstCommand07NotificationAt == null) firstCommand07NotificationAt = receivedAt
            lastCommand07NotificationAt = receivedAt
            if (command07NotificationSamples.size < 5) {
                command07NotificationSamples.add(
                    linkedMapOf(
                        "receivedAt" to receivedAt,
                        "notificationLength" to notification.size,
                        "first16BytesHex" to notification.copyOfRange(0, minOf(16, notification.size)).joinToString("") { "%02X".format(it.toInt() and 0xFF) },
                    ),
                )
            }
            if (isWaveformCandidate && (diagnosticState == "WAITING_FOR_DEVICE" || diagnosticState == "START_COMMANDS_WRITING")) {
                diagnosticState = "RECEIVING_RAW"
            }
        }

        fun recordVendorType(dataType: String, receivedAt: String) {
            val existing = vendorDataTypesSeenAfterEcgStart.getOrPut(dataType) { linkedMapOf("dataType" to dataType, "count" to 0, "firstSeenAt" to receivedAt, "lastSeenAt" to receivedAt) }
            existing["count"] = (existing["count"] as? Number)?.toInt()?.plus(1) ?: 1
            existing["lastSeenAt"] = receivedAt
            if (existing["firstSeenAt"] == null) existing["firstSeenAt"] = receivedAt
        }

        fun noteType64(packetId: Int?, sampleValues: List<Int>, receivedAt: String) {
            type64CallbackCount += 1
            if (firstType64CallbackAt == null) firstType64CallbackAt = receivedAt
            lastType64CallbackAt = receivedAt
            if (type64SampleList.size < 5) {
                type64SampleList.add(
                    linkedMapOf(
                        "receivedAt" to receivedAt,
                        "packetID" to packetId,
                        "sampleCount" to sampleValues.size,
                        "firstSamples" to sampleValues.take(8),
                    ),
                )
            }
            if (sampleValues.isNotEmpty()) diagnosticState = "DEVICE_DATA_AVAILABLE"
            if (diagnosticState == "WAITING_FOR_DEVICE") diagnosticState = "DEVICE_DATA_AVAILABLE"
        }

        fun noteEcgStatus(value: Int?, receivedAt: String) {
            if (value == null) return
            traceEcgStatusValues.add(value)
            if (firstEcgStatusAt == null) firstEcgStatusAt = receivedAt
            if (value == 3 && firstDataAvailableStatusAt == null) firstDataAvailableStatusAt = receivedAt
            if (value == 3) diagnosticState = "DEVICE_DATA_AVAILABLE"
        }

        fun snapshotDiagnostics(): Map<String, Any?> {
            val classification = diagnosticClassification ?: when {
                notificationDiagnostics.ecgWaveformCandidate07Count == 0 && type64CallbackCount == 0 -> "NO_DEVICE_DATA"
                notificationDiagnostics.ecgWaveformCandidate07Count > 0 && type64CallbackCount == 0 -> "RAW_NOTIFICATION_NO_TYPE64"
                type64CallbackCount > 0 && type64SampleList.all { (it["sampleCount"] as? Number)?.toInt() == 0 } -> "TYPE64_NO_SAMPLES"
                else -> "RAW_ECG_RECEIVED"
            }
            return linkedMapOf(
                "diagnosticState" to diagnosticState,
                "diagnosticClassification" to classification,
                "measurementStartCommand" to linkedMapOf(
                    "queuedAt" to measurementStartCommandQueuedAt,
                    "writeAckAt" to measurementStartCommandWriteAckAt,
                ),
                "realtimeFlagCommand" to linkedMapOf(
                    "queuedAt" to realtimeFlagCommandQueuedAt,
                    "writeAckAt" to realtimeFlagCommandWriteAckAt,
                ),
                "firstNotificationAfterStartAt" to firstNotificationAfterStartAt,
                "firstNotificationClassification" to notificationDiagnostics.firstNotificationClassification,
                "secondNotificationClassification" to notificationDiagnostics.secondNotificationClassification,
                "genericNotificationsAfterStart" to notificationDiagnostics.genericNotificationsAfterStart,
                "vendorDataTypesSeenAfterEcgStart" to vendorDataTypesSeenAfterEcgStart.values.toList(),
                "anyCommand07NotificationCount" to notificationDiagnostics.anyCommand07NotificationCount,
                "ecgWaveformCandidate07Count" to notificationDiagnostics.ecgWaveformCandidate07Count,
                "firstCommand07NotificationAt" to firstCommand07NotificationAt,
                "lastCommand07NotificationAt" to lastCommand07NotificationAt,
                "command07NotificationSamples" to command07NotificationSamples,
                "type64CallbackCount" to type64CallbackCount,
                "firstType64CallbackAt" to firstType64CallbackAt,
                "lastType64CallbackAt" to lastType64CallbackAt,
                "ecgPpgStatusRequestSupport" to ecgPpgStatusRequestSupport,
                "ecgPpgStatusRequestCount" to ecgPpgStatusRequestCount,
                "ecgPpgStatusRequestTimes" to ecgPpgStatusRequestTimes,
                "ecgPpgStatusResponseCount" to ecgPpgStatusResponseCount,
                "ecgStatusValuesSeen" to traceEcgStatusValues,
                "firstEcgStatusAt" to firstEcgStatusAt,
                "firstDataAvailableStatusAt" to firstDataAvailableStatusAt,
                "ecgNoDataAfter10s" to ecgNoDataAfter10s,
            )
        }
    }

    private class RawPpgCapture(
        val session: RawPpgSession,
        var startCallback: ((Map<String, Any?>?, JCVitalV8Exception?) -> Unit)?,
        val packetStore: RawPpgPacketStore,
    ) {
        var stopCallback: ((Map<String, Any?>?, JCVitalV8Exception?) -> Unit)? = null
        var startTimeout: Runnable? = null
        var stopTimeout: Runnable? = null
        var maxDurationTimeout: Runnable? = null
        var uiUpdateTimeout: Runnable? = null
        var pendingChunkSummary: Map<String, Any?>? = null
        var ppgChunkEventsSentToJs = 0L
        var ppgUiSummaryEventDropped = 0L
        var ppgLastEventPayloadBytes = 0
        var ppgMaxEventPayloadBytes = 0
        var storageFailureHandling = false
        var storageErrorCount = 0
    }

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val bluetoothManager = appContext.getSystemService(BluetoothManager::class.java)
    private val registry = JCVitalV8DeviceRegistry()
    private val normalizer = JCVitalV8EventNormalizer()
    private val workoutNormalizer = JCVitalV8WorkoutNormalizer()
    private val stateMachine = JCVitalV8ConnectionStateMachine { from, to, reason ->
        Log.i(TAG, "state $from -> $to${reason?.let { " ($it)" } ?: ""}")
        emit(
            JCVitalV8EventNormalizer.EVENT_CONNECTION_STATE,
            linkedMapOf(
                "state" to to.name,
                "previousState" to from.name,
                "reason" to reason,
                "deviceId" to connectedDeviceId,
                "timestamp" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
            ),
        )
    }

    private var scanning = false
    private var scanTimeout: Runnable? = null

    private var gatt: BluetoothGatt? = null
    private var writeCharacteristic: BluetoothGattCharacteristic? = null
    private var notifyCharacteristic: BluetoothGattCharacteristic? = null
    private var connectedDeviceId: String? = null
    private var negotiatedMtu = DEFAULT_ATT_MTU
    private var initStep = InitStep.NONE
    private var pendingConnect: ((JCVitalV8Exception?) -> Unit)? = null
    private var connectTimeout: Runnable? = null
    private var initTimeout: Runnable? = null

    private val commandQueue = ArrayDeque<Command>()
    private var writeInFlight: Command? = null
    private var writeTimeout: Runnable? = null
    private val pendingRequests = mutableListOf<PendingRequest>()
    private var historicalRequest: HistoricalRequest? = null
    private var monitoringRequest: MonitoringRequest? = null
    private var workoutCapture: WorkoutCapture? = null
    private var lastWorkoutSession: Map<String, Any?>? = null
    private var rawEcgCapture: RawEcgCapture? = null
    private var lastRawEcgSession: Map<String, Any?>? = null
    private var rawPpgCapture: RawPpgCapture? = null
    private var lastRawPpgSession: Map<String, Any?>? = null

    private val deviceInfo = LinkedHashMap<String, Any?>()
    private var lastBattery: Map<String, Any?>? = null
    private var realtimeSessionId: String? = null

    private val bluetoothStateReceiver = object : BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: Intent) {
            if (intent.action != BluetoothAdapter.ACTION_STATE_CHANGED) return
            val adapterState = intent.getIntExtra(BluetoothAdapter.EXTRA_STATE, BluetoothAdapter.ERROR)
            main.post { onAdapterStateChanged(adapterState) }
        }
    }

    init {
        ContextCompat.registerReceiver(
            appContext,
            bluetoothStateReceiver,
            IntentFilter(BluetoothAdapter.ACTION_STATE_CHANGED),
            ContextCompat.RECEIVER_NOT_EXPORTED,
        )
    }

    private val adapter: BluetoothAdapter? get() = bluetoothManager?.adapter

    val state: JCVitalV8ConnectionState get() = stateMachine.state

    fun isAvailable(): Boolean =
        adapter != null && appContext.packageManager.hasSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE)

    fun isEnabled(): Boolean = try {
        adapter?.isEnabled == true
    } catch (_: SecurityException) {
        false
    }

    fun discoveredDevices(): List<Map<String, Any?>> = registry.all().map { it.toMap() }

    fun connectedDeviceId(): String? = connectedDeviceId

    // ---------------------------------------------------------------- scanning

    fun startScan(timeoutMs: Long, callback: (JCVitalV8Exception?) -> Unit) = onMain {
        try {
            requireUsable()
            if (stateMachine.isLinkActive) {
                throw JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Disconnect before scanning")
            }
            if (scanning) return@onMain callback(null)
            val scanner = adapter?.bluetoothLeScanner
                ?: throw JCVitalV8Exception(JCVitalV8ErrorCode.BLUETOOTH_DISABLED, "BLE scanner unavailable")
            registry.clear()
            // Vendor DeviceScanActivity scans without filters and lets the user pick; match that.
            val settings = ScanSettings.Builder().setScanMode(ScanSettings.SCAN_MODE_LOW_LATENCY).setReportDelay(0).build()
            scanner.startScan(null, settings, scanCallback)
            scanning = true
            stateMachine.transition(JCVitalV8ConnectionState.SCANNING, "scan started")
            Log.i(TAG, "scan started (timeout ${timeoutMs}ms)")
            scanTimeout = Runnable { stopScanInternal("scan timeout") }.also { main.postDelayed(it, timeoutMs) }
            callback(null)
        } catch (t: Throwable) {
            val error = JCVitalV8Errors.fromThrowable(t, JCVitalV8ErrorCode.SCAN_FAILED)
            emitError(error.code, error.message ?: "Scan failed")
            callback(error)
        }
    }

    fun stopScan() = onMain { stopScanInternal("scan stopped") }

    private fun stopScanInternal(reason: String) {
        scanTimeout?.let(main::removeCallbacks)
        scanTimeout = null
        if (!scanning) return
        scanning = false
        try {
            if (isEnabled()) adapter?.bluetoothLeScanner?.stopScan(scanCallback)
        } catch (t: Throwable) {
            Log.w(TAG, "stopScan failed: ${t.message}")
        }
        Log.i(TAG, "$reason (${registry.all().size} devices)")
        stateMachine.transition(JCVitalV8ConnectionState.DISCONNECTED, reason)
    }

    private val scanCallback = object : ScanCallback() {
        override fun onScanResult(callbackType: Int, result: ScanResult) {
            main.post { handleScanResult(result) }
        }

        override fun onBatchScanResults(results: MutableList<ScanResult>) {
            main.post { results.forEach(::handleScanResult) }
        }

        override fun onScanFailed(errorCode: Int) {
            main.post {
                scanning = false
                scanTimeout?.let(main::removeCallbacks)
                val reason = JCVitalV8Errors.scanFailureReason(errorCode)
                Log.w(TAG, "scan failed: $reason")
                emitError(JCVitalV8ErrorCode.SCAN_FAILED, reason)
                stateMachine.transition(JCVitalV8ConnectionState.DISCONNECTED, reason)
            }
        }
    }

    private fun handleScanResult(result: ScanResult) {
        if (!scanning) return
        val device = result.device ?: return
        val record = result.scanRecord
        val name = record?.deviceName?.takeIf { it.isNotBlank() } ?: safeName(device)
        val advertisesService = record?.serviceUuids?.any { it.uuid == SERVICE_UUID } == true
        // Unnamed, non-JCVital advertisers are background noise the user cannot identify.
        if (name.isNullOrBlank() && !advertisesService) return
        val upsert = registry.upsert(
            address = device.address,
            name = name,
            rssi = result.rssi,
            bonded = safeBonded(device),
            connectable = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) result.isConnectable else true,
            advertisesJcvitalService = advertisesService,
            seenAt = System.currentTimeMillis(),
        )
        if (upsert.isNew) {
            Log.i(TAG, "discovered ${upsert.device.name} ${upsert.device.id} rssi=${upsert.device.rssi} fff0=$advertisesService")
        }
        if (upsert.shouldEmit) emit(JCVitalV8EventNormalizer.EVENT_SCAN_RESULT, upsert.device.toMap())
    }

    // -------------------------------------------------------------- connection

    fun connect(deviceId: String, callback: (JCVitalV8Exception?) -> Unit) = onMain {
        try {
            requireUsable()
            val id = JCVitalV8DeviceRegistry.normalizeId(deviceId)
            if (stateMachine.isLinkActive) {
                if (id == connectedDeviceId && state == JCVitalV8ConnectionState.READY) return@onMain callback(null)
                throw JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Already connected to $connectedDeviceId; disconnect first")
            }
            if (registry.get(id) == null && !BluetoothAdapter.checkBluetoothAddress(id)) {
                throw JCVitalV8Exception(JCVitalV8ErrorCode.DEVICE_NOT_FOUND, "Unknown device $deviceId")
            }
            stopScanInternal("scan stopped for connect")
            val device = adapter!!.getRemoteDevice(id)
            resetSession()
            connectedDeviceId = id
            deviceInfo["deviceId"] = id
            registry.get(id)?.name?.let { deviceInfo["advertisedName"] = it }
            pendingConnect = callback
            stateMachine.transition(JCVitalV8ConnectionState.CONNECTING, "connect $id")
            Log.i(TAG, "connectGatt $id")
            gatt = openGatt(device)
                ?: return@onMain fail(JCVitalV8ErrorCode.CONNECTION_FAILED, "connectGatt returned null")
            connectTimeout = Runnable {
                if (state == JCVitalV8ConnectionState.CONNECTING) fail(JCVitalV8ErrorCode.CONNECTION_FAILED, "Connection timed out")
            }.also { main.postDelayed(it, CONNECT_TIMEOUT_MS) }
        } catch (t: Throwable) {
            val error = JCVitalV8Errors.fromThrowable(t, JCVitalV8ErrorCode.CONNECTION_FAILED)
            emitError(error.code, error.message ?: "Connection failed")
            if (pendingConnect === callback) pendingConnect = null
            if (state == JCVitalV8ConnectionState.CONNECTING) {
                closeGatt()
                stateMachine.transition(JCVitalV8ConnectionState.ERROR, error.code.name)
            }
            callback(error)
        }
    }

    private fun openGatt(device: BluetoothDevice): BluetoothGatt? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            // Vendor prefers LE 2M when supported; 1M is kept in the mask so the initial link can still form.
            val phy = if (adapter?.isLe2MPhySupported == true) BluetoothDevice.PHY_LE_1M_MASK or BluetoothDevice.PHY_LE_2M_MASK
            else BluetoothDevice.PHY_LE_1M_MASK
            device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE, phy)
        } else {
            device.connectGatt(appContext, false, gattCallback, BluetoothDevice.TRANSPORT_LE)
        }

    fun disconnect(callback: () -> Unit = {}) = onMain {
        stopScanInternal("scan stopped for disconnect")
        val hadLink = gatt != null
        Log.i(TAG, "disconnect requested (link=$hadLink)")
        endWorkoutForLinkLoss("Disconnected by user")
        endRawEcgForLinkLoss("Disconnected by user")
        endRawPpgForLinkLoss("Disconnected by user")
        closeGatt()
        stateMachine.transition(JCVitalV8ConnectionState.DISCONNECTED, "user disconnect")
        failPendingWork(JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, "Disconnected by user"))
        callback()
    }

    private val gattCallback = object : BluetoothGattCallback() {
        override fun onConnectionStateChange(g: BluetoothGatt, status: Int, newState: Int) {
            main.post {
                if (g !== gatt) {
                    g.close()
                    return@post
                }
                Log.i(TAG, "gatt connectionState status=$status newState=$newState")
                if (status == BluetoothGatt.GATT_SUCCESS && newState == BluetoothProfile.STATE_CONNECTED) {
                    clearConnectTimeout()
                    stateMachine.transition(JCVitalV8ConnectionState.CONNECTED, "gatt connected")
                    main.postDelayed({
                        if (g === gatt && state == JCVitalV8ConnectionState.CONNECTED && !g.discoverServices()) {
                            fail(JCVitalV8ErrorCode.SERVICE_DISCOVERY_FAILED, "discoverServices() rejected")
                        }
                    }, SERVICE_DISCOVERY_DELAY_MS)
                } else if (newState == BluetoothProfile.STATE_DISCONNECTED || status != BluetoothGatt.GATT_SUCCESS) {
                    val code = JCVitalV8Errors.forLinkDrop(state, status, userInitiated = false)
                    if (code == null) {
                        endWorkoutForLinkLoss("V8 disconnected")
                        endRawEcgForLinkLoss("V8 disconnected")
                        endRawPpgForLinkLoss("V8 disconnected")
                        closeGatt()
                        stateMachine.transition(JCVitalV8ConnectionState.DISCONNECTED, "gatt disconnected")
                    } else {
                        fail(code, "GATT link dropped (status=$status)")
                    }
                }
            }
        }

        override fun onServicesDiscovered(g: BluetoothGatt, status: Int) {
            main.post {
                if (g !== gatt) return@post
                Log.i(TAG, "servicesDiscovered status=$status count=${g.services.size}")
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    return@post fail(JCVitalV8ErrorCode.SERVICE_DISCOVERY_FAILED, "Service discovery failed (status=$status)")
                }
                val service = g.getService(SERVICE_UUID)
                    ?: return@post fail(JCVitalV8ErrorCode.SERVICE_DISCOVERY_FAILED, "JCVital service $SERVICE_UUID not found; not a JCVital V8")
                val write = service.getCharacteristic(WRITE_CHARACTERISTIC_UUID)
                val notify = service.getCharacteristic(NOTIFY_CHARACTERISTIC_UUID)
                val cccd = notify?.getDescriptor(CCCD_UUID)
                Log.i(TAG, "characteristics write=${write != null} notify=${notify != null} cccd=${cccd != null}")
                if (write == null || notify == null || cccd == null) {
                    return@post fail(JCVitalV8ErrorCode.SERVICE_DISCOVERY_FAILED, "Required JCVital characteristics missing")
                }
                writeCharacteristic = write
                notifyCharacteristic = notify
                stateMachine.transition(JCVitalV8ConnectionState.INITIALIZING, "services discovered")
                initTimeout = Runnable {
                    if (state != JCVitalV8ConnectionState.INITIALIZING) return@Runnable
                    val code = if (initStep == InitStep.HANDSHAKE) JCVitalV8ErrorCode.SDK_INITIALIZATION_FAILED
                    else JCVitalV8ErrorCode.NOTIFICATION_SETUP_FAILED
                    fail(code, "Initialization timed out at $initStep")
                }.also { main.postDelayed(it, INIT_TIMEOUT_MS) }
                // Realtime packets are 25+ bytes; the default 23-byte ATT MTU would truncate them.
                initStep = InitStep.MTU
                if (!g.requestMtu(REQUESTED_MTU)) {
                    Log.w(TAG, "requestMtu rejected; continuing with default MTU")
                    enableNotifications(g)
                }
            }
        }

        override fun onMtuChanged(g: BluetoothGatt, mtu: Int, status: Int) {
            main.post {
                if (g !== gatt) return@post
                Log.i(TAG, "mtuChanged mtu=$mtu status=$status")
                if (status == BluetoothGatt.GATT_SUCCESS) negotiatedMtu = mtu
                if (initStep == InitStep.MTU) enableNotifications(g)
            }
        }

        override fun onDescriptorWrite(g: BluetoothGatt, descriptor: BluetoothGattDescriptor, status: Int) {
            main.post {
                if (g !== gatt || descriptor.uuid != CCCD_UUID || initStep != InitStep.NOTIFICATIONS) return@post
                if (status != BluetoothGatt.GATT_SUCCESS) {
                    return@post fail(JCVitalV8ErrorCode.NOTIFICATION_SETUP_FAILED, "CCCD write failed (status=$status)")
                }
                Log.i(TAG, "notifications enabled on $NOTIFY_CHARACTERISTIC_UUID")
                g.requestConnectionPriority(BluetoothGatt.CONNECTION_PRIORITY_HIGH)
                initStep = InitStep.HANDSHAKE
                // READY requires a full SDK round-trip, not just a GATT link.
                awaitResponses(setOf(BleConst.GetDeviceVersion), INIT_TIMEOUT_MS) { missing ->
                    if (missing.isEmpty()) markReady()
                    else if (state == JCVitalV8ConnectionState.INITIALIZING) {
                        fail(JCVitalV8ErrorCode.SDK_INITIALIZATION_FAILED, "No response to GetDeviceVersion")
                    }
                }
                enqueue("GetDeviceVersion", BleSDK.GetDeviceVersion())
            }
        }

        override fun onCharacteristicWrite(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, status: Int) {
            main.post {
                if (g !== gatt) return@post
                val command = writeInFlight
                clearWriteTimeout()
                writeInFlight = null
                val success = status == BluetoothGatt.GATT_SUCCESS
                command?.onWriteComplete?.invoke(success)
                if (!success) {
                    emitError(JCVitalV8ErrorCode.COMMAND_FAILED, "${command?.name ?: "command"} write failed (status=$status)")
                }
                pump()
            }
        }

        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic, value: ByteArray) {
            val copy = value.copyOf()
            main.post { if (g === gatt) handleNotification(copy) }
        }

        @Deprecated("Used on Android 12L and lower")
        override fun onCharacteristicChanged(g: BluetoothGatt, characteristic: BluetoothGattCharacteristic) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return
            @Suppress("DEPRECATION")
            val copy = characteristic.value?.copyOf() ?: return
            main.post { if (g === gatt) handleNotification(copy) }
        }
    }

    private fun enableNotifications(g: BluetoothGatt) {
        initStep = InitStep.NOTIFICATIONS
        val notify = notifyCharacteristic ?: return fail(JCVitalV8ErrorCode.NOTIFICATION_SETUP_FAILED, "Notify characteristic missing")
        val cccd = notify.getDescriptor(CCCD_UUID) ?: return fail(JCVitalV8ErrorCode.NOTIFICATION_SETUP_FAILED, "CCCD missing")
        if (!g.setCharacteristicNotification(notify, true)) {
            return fail(JCVitalV8ErrorCode.NOTIFICATION_SETUP_FAILED, "setCharacteristicNotification rejected")
        }
        val accepted = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            g.writeDescriptor(cccd, BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE) == BluetoothStatusCodes.SUCCESS
        } else {
            @Suppress("DEPRECATION")
            cccd.value = BluetoothGattDescriptor.ENABLE_NOTIFICATION_VALUE
            @Suppress("DEPRECATION")
            g.writeDescriptor(cccd)
        }
        if (!accepted) fail(JCVitalV8ErrorCode.NOTIFICATION_SETUP_FAILED, "CCCD write rejected")
    }

    private fun markReady() {
        clearInitTimeout()
        initStep = InitStep.NONE
        if (!stateMachine.transition(JCVitalV8ConnectionState.READY, "JCVital SDK responding (mtu=$negotiatedMtu)")) return
        pendingConnect?.invoke(null)
        pendingConnect = null
    }

    // ---------------------------------------------------------------- commands

    fun requestDeviceInfo(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        awaitResponses(DEVICE_INFO_RESPONSES, COMMAND_TIMEOUT_MS) { missing ->
            callback(deviceInfoSnapshot(missing), null)
        }
        enqueue("GetDeviceName", BleSDK.GetDeviceName())
        enqueue("GetDeviceMacAddress", BleSDK.GetDeviceMacAddress())
        enqueue("GetDeviceVersion", BleSDK.GetDeviceVersion())
        enqueue("GetPersonalInfo", BleSDK.GetPersonalInfo())
        enqueue("GetDeviceBatteryLevel", BleSDK.GetDeviceBatteryLevel())
    }

    fun requestBattery(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        awaitResponses(setOf(BleConst.GetDeviceBatteryLevel), COMMAND_TIMEOUT_MS) { missing ->
            val battery = lastBattery
            if (missing.isEmpty() && battery != null) callback(battery, null)
            else callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "No battery response from device"))
        }
        enqueue("GetDeviceBatteryLevel", BleSDK.GetDeviceBatteryLevel())
    }

    /** V8 docs: RealTimeStep streams HR only while SetDeviceMeasurementWithType(AutoHeartRate) is open (>30 s). */
    fun startRealtime(measurementSeconds: Long, callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        val blocked = JCVitalV8WorkoutGuard.blockedReason(workoutCapture?.session, realtimeSessionId != null, historicalRequest != null, monitoringRequest != null, rawEcgCapture != null)
        if (blocked != null) return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, blocked))
        val seconds = measurementSeconds.coerceIn(MIN_MEASUREMENT_SECONDS, MAX_MEASUREMENT_SECONDS)
        val sessionId = UUID.randomUUID().toString()
        realtimeSessionId = sessionId
        enqueue("RealTimeStep(enable)", BleSDK.RealTimeStep(true, false))
        enqueue("SetDeviceMeasurementWithType(AutoHeartRate,open,${seconds}s)", BleSDK.SetDeviceMeasurementWithType(AutoTestMode.AutoHeartRate, seconds, true))
        callback(linkedMapOf("sessionId" to sessionId, "measurementSeconds" to seconds), null)
    }

    fun stopRealtime(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        val sessionId = realtimeSessionId
        enqueue("SetDeviceMeasurementWithType(AutoHeartRate,close)", BleSDK.SetDeviceMeasurementWithType(AutoTestMode.AutoHeartRate, 0, false))
        enqueue("RealTimeStep(disable)", BleSDK.RealTimeStep(false, false))
        realtimeSessionId = null
        callback(linkedMapOf("sessionId" to sessionId), null)
    }

    fun syncHistoricalHeartRate(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetDynamicHRWithMode", BleConst.GetDynamicHR, { mode -> BleSDK.GetDynamicHRWithMode(mode, "") }, callback,
    )

    fun syncHistoricalSpo2(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "Oxygen_data", BleConst.GetAutomaticSpo2Monitoring, { mode -> BleSDK.Oxygen_data(mode, "") }, callback,
    )

    fun syncHistoricalTemperature(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetTemperature_historyData", BleConst.Temperature_history, { mode -> BleSDK.GetTemperature_historyData(mode, "") }, callback,
    )

    fun syncHistoricalHrv(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetHRVDataWithMode", BleConst.GetHRVData, { mode -> BleSDK.GetHRVDataWithMode(mode, "") }, callback,
    )

    fun syncHistoricalPpi(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetPPI", BleConst.GetPPIData, { mode -> BleSDK.GetPPI(mode, "") }, callback,
    )

    fun startWorkoutCapture(activityMode: Int, callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        val blocked = JCVitalV8WorkoutGuard.blockedReason(
            workoutCapture?.session,
            realtimeSessionId != null,
            historicalRequest != null,
            monitoringRequest != null,
            rawEcgCapture != null,
        )
        if (blocked != null) return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, blocked))
        if (activityMode !in 0..14) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Unsupported V8 activity mode $activityMode"))
        }
        val session = JCVitalV8WorkoutSession(
            sessionId = UUID.randomUUID().toString(),
            deviceId = connectedDeviceId,
            firmwareVersion = deviceInfo["firmwareVersion"] as? String,
            activityMode = activityMode,
            activityType = JCVitalV8ActivityModes.canonicalType(activityMode),
            startedAtMillis = System.currentTimeMillis(),
        )
        val capture = WorkoutCapture(session, callback)
        workoutCapture = capture
        emitWorkoutStatus(capture)
        capture.startTimeout = Runnable {
            if (workoutCapture !== capture || session.status != JCVitalV8WorkoutSession.STATUS_STARTING) return@Runnable
            workoutCapture = null
            session.markError(System.currentTimeMillis())
            lastWorkoutSession = workoutSessionPayload(capture)
            emitWorkoutStatus(capture)
            emitWorkoutError(session.sessionId, "No EnterActivityMode start response")
            callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "No EnterActivityMode start response"))
        }.also { main.postDelayed(it, COMMAND_TIMEOUT_MS) }
        enqueue(
            "EnterActivityMode(start,mode=$activityMode)",
            BleSDK.EnterActivityMode(2, activityMode, ExerciseMode.Status_START),
        )
    }

    fun pauseWorkoutCapture(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        val capture = workoutCapture
        if (capture == null || capture.session.status != JCVitalV8WorkoutSession.STATUS_RUNNING) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Workout capture is not running"))
        }
        try {
            capture.session.markPaused()
            cancelWorkoutHeartbeat(capture)
            enqueue("EnterActivityMode(pause)", BleSDK.EnterActivityMode(2, capture.session.activityMode, ExerciseMode.Status_PAUSE))
            emitWorkoutStatus(capture)
            callback(workoutSessionPayload(capture), null)
        } catch (error: Throwable) {
            callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, error.message ?: "Could not pause workout"))
        }
    }

    fun resumeWorkoutCapture(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        val capture = workoutCapture
        if (capture == null || capture.session.status != JCVitalV8WorkoutSession.STATUS_PAUSED) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Workout capture is not paused"))
        }
        try {
            enqueue("EnterActivityMode(resume)", BleSDK.EnterActivityMode(2, capture.session.activityMode, ExerciseMode.Status_CONTUINE))
            capture.session.markRunning()
            scheduleWorkoutHeartbeat(capture)
            emitWorkoutStatus(capture)
            callback(workoutSessionPayload(capture), null)
        } catch (error: Throwable) {
            callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, error.message ?: "Could not resume workout"))
        }
    }

    fun stopWorkoutCapture(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        val capture = workoutCapture
            ?: return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "No workout capture is active"))
        if (capture.session.status != JCVitalV8WorkoutSession.STATUS_RUNNING && capture.session.status != JCVitalV8WorkoutSession.STATUS_PAUSED) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Workout is not ready to stop (status=${capture.session.status})"))
        }
        cancelWorkoutHeartbeat(capture)
        capture.session.markStopping()
        capture.stopCallback = callback
        emitWorkoutStatus(capture)
        capture.stopTimeout = Runnable {
            failWorkoutCapture(capture, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "No EnterActivityMode finish response"))
        }.also { main.postDelayed(it, COMMAND_TIMEOUT_MS) }
        enqueue("EnterActivityMode(finish)", BleSDK.EnterActivityMode(2, capture.session.activityMode, ExerciseMode.Status_FINISH)) { written ->
            if (!written) failWorkoutCapture(capture, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "Workout finish command write failed"))
        }
    }

    fun workoutCaptureStatus(): Map<String, Any?> = workoutCapture?.let(::workoutSessionPayload)
        ?: lastWorkoutSession
        ?: idleWorkoutPayload()

    fun startRawPpg(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        val blocked = rawPpgStartBlockedReason()
        if (blocked != null) return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, blocked))
        val sessionId = UUID.randomUUID().toString()
        val packetStore = try {
            RawPpgPacketStore.create(appContext.cacheDir, sessionId)
        } catch (error: Throwable) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "Could not create PPG session store: ${error.message}"))
        }
        val session = RawPpgSession(
            sessionId = sessionId,
            deviceId = connectedDeviceId,
            firmwareVersion = deviceInfo["firmwareVersion"] as? String,
            startedAt = JCVitalV8Time.isoUtc(System.currentTimeMillis()),
            source = linkedMapOf(
                "connector" to "JCVITAL_NATIVE",
                "provider" to "JCVITAL",
                "deviceModel" to "PRO_V8",
                "deviceId" to connectedDeviceId,
                "firmwareVersion" to deviceInfo["firmwareVersion"],
                "sdkVersion" to JCVitalV8EventNormalizer.SDK_VERSION,
            ),
        )
        session.start()
        val capture = RawPpgCapture(session, callback, packetStore)
        rawPpgCapture = capture
        emitRawPpgStatus(capture)
        capture.startTimeout = Runnable {
            if (rawPpgCapture === capture && session.status == RawPpgSession.STATUS_STARTING) {
                failRawPpgCapture(capture, "PPG mode-1 start write acknowledgment timed out")
            }
        }.also { main.postDelayed(it, COMMAND_TIMEOUT_MS) }
        enqueue("ppgWithMode(1,0)", BleSDK.ppgWithMode(1, 0)) { written ->
            if (!written) {
                failRawPpgCapture(capture, "PPG mode-1 start command write failed")
            } else if (rawPpgCapture === capture && session.status == RawPpgSession.STATUS_STARTING) {
                capture.startTimeout?.let(main::removeCallbacks)
                capture.startTimeout = null
                session.markRunning()
                val result = rawPpgPayload(capture)
                capture.startCallback?.invoke(result, null)
                capture.startCallback = null
                emitRawPpgStatus(capture)
                capture.maxDurationTimeout = Runnable {
                    if (rawPpgCapture === capture && session.status == RawPpgSession.STATUS_RUNNING) {
                        stopRawPpg { _, error -> error?.let { Log.e(TAG, "20-second PPG safe-test stop failed: ${it.message}") } }
                    }
                }.also { main.postDelayed(it, RAW_PPG_SAFE_TEST_DURATION_MS) }
            }
        }
    }

    private fun rawPpgStartBlockedReason(): String? = when {
        rawPpgCapture != null -> "A PPG workflow capture is already active"
        rawEcgCapture != null -> "Raw ECG capture is active"
        workoutCapture?.session?.status in setOf(
            JCVitalV8WorkoutSession.STATUS_STARTING,
            JCVitalV8WorkoutSession.STATUS_RUNNING,
            JCVitalV8WorkoutSession.STATUS_PAUSED,
            JCVitalV8WorkoutSession.STATUS_STOPPING,
        ) -> "Workout capture is active"
        realtimeSessionId != null -> "Manual realtime measurement is active"
        historicalRequest != null -> "Historical sync is active"
        monitoringRequest != null -> "Monitoring configuration request is active"
        else -> null
    }

    fun stopRawPpg(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        val capture = rawPpgCapture
            ?: return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "No raw PPG workflow capture is active"))
        if (capture.session.status != RawPpgSession.STATUS_RUNNING) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Raw PPG workflow capture is not running"))
        }
        capture.session.markStopping()
        capture.stopCallback = callback
        capture.maxDurationTimeout?.let(main::removeCallbacks)
        capture.maxDurationTimeout = null
        emitRawPpgStatus(capture)
        capture.stopTimeout = Runnable { failRawPpgCapture(capture, "PPG mode-3/mode-5 stop write acknowledgment timed out") }
            .also { main.postDelayed(it, COMMAND_TIMEOUT_MS * 2) }
        enqueue("ppgWithMode(3,0)", BleSDK.ppgWithMode(3, 0)) { written ->
            if (!written || rawPpgCapture !== capture) {
                failRawPpgCapture(capture, "PPG mode-3 stop command write failed")
            } else {
                enqueue("ppgWithMode(5,0)", BleSDK.ppgWithMode(5, 0)) { quitWritten ->
                    if (!quitWritten) {
                        failRawPpgCapture(capture, "PPG mode-5 quit command write failed")
                    } else if (rawPpgCapture === capture && capture.session.status == RawPpgSession.STATUS_STOPPING) {
                        capture.stopTimeout?.let(main::removeCallbacks)
                        capture.stopTimeout = null
                        finishRawPpgCapture(capture, RawPpgSession.STATUS_STOPPED)
                    }
                }
            }
        }
    }

    fun rawPpgStatus(): Map<String, Any?> = rawPpgCapture?.let { rawPpgPayload(it) }
        ?: lastRawPpgSession
        ?: linkedMapOf(
            "sessionId" to null,
            "deviceId" to connectedDeviceId,
            "status" to RawPpgSession.STATUS_IDLE,
            "signalType" to RawPpgSession.SIGNAL_TYPE,
            "packetCount" to 0,
            "chunkCount" to 0,
            "bytesReceived" to 0,
            "bufferHighWaterMark" to 0,
            "parseErrorCount" to 0,
            "notificationLengthCounts" to linkedMapOf("153" to 0, "203" to 0, "other" to 0),
            "notificationLengthsExactCounts" to emptyMap<String, Int>(),
            "vendorDataType119Count" to 0,
            "firstPacketAt" to null,
            "lastPacketAt" to null,
            "decodedSampleCount" to 0,
            "minimumRawDecodedValue" to null,
            "maximumRawDecodedValue" to null,
            "sampleRateHz" to null,
            "sampleIntervalMs" to null,
            "unit" to RawPpgSession.UNKNOWN_UNIT,
            "sampleFormat" to "UNKNOWN_VENDOR_LAYOUT",
            "rawSampleDiagnostics" to emptyMap<String, Any>(),
            "decodedFieldNames" to emptyList<String>(),
            "vendorDerivedFields" to emptyList<Any>(),
            "temporaryStorePath" to null,
            "persistedPacketCount" to 0,
            "persistedBytes" to 0,
            "storageErrorCount" to 0,
            "ppgNativePacketCount" to 0,
            "ppgNativeChunkCount" to 0,
            "ppgChunkEventsSentToJs" to 0,
            "ppgUiSummaryEventDropped" to 0,
            "ppgLastEventPayloadBytes" to 0,
            "ppgMaxEventPayloadBytes" to 0,
            "parseErrors" to emptyList<Any>(),
        )

    private fun rawPpgPayload(capture: RawPpgCapture, includeChunkSamples: Boolean = false): Map<String, Any?> =
        LinkedHashMap(capture.session.toMap()).apply {
            put("temporaryStorePath", capture.packetStore.file.absolutePath)
            put("persistedPacketCount", capture.packetStore.packetCount)
            put("persistedBytes", capture.packetStore.byteCount)
            put("storageErrorCount", capture.storageErrorCount)
            put("ppgNativePacketCount", capture.session.packetCount)
            put("ppgNativeChunkCount", capture.session.chunkCount)
            put("ppgChunkEventsSentToJs", capture.ppgChunkEventsSentToJs)
            put("ppgUiSummaryEventDropped", capture.ppgUiSummaryEventDropped)
            put("ppgLastEventPayloadBytes", capture.ppgLastEventPayloadBytes)
            put("ppgMaxEventPayloadBytes", capture.ppgMaxEventPayloadBytes)
            if (includeChunkSamples) {
                put("first3Chunks", capture.packetStore.firstThreeChunks())
                put("last3Chunks", capture.packetStore.lastThreeChunks())
            }
        }

    private fun emitRawPpgStatus(capture: RawPpgCapture) {
        val payload = rawPpgPayload(capture)
        emitRawPpgBridgeEvent(capture, JCVitalV8EventNormalizer.EVENT_RAW_PPG_STATUS, payload)
    }

    private fun flushRawPpg(capture: RawPpgCapture, chunk: RawPpgChunkFlush?) {
        if (chunk == null) return
        try {
            capture.packetStore.appendChunk(chunk.rawPackets, chunk.exportSample)
        } catch (error: Throwable) {
            capture.storageErrorCount++
            val message = "RAW_CAPTURE_LOSS: Could not persist raw PPG chunk: ${error.message}"
            capture.session.recordParseError(message, JCVitalV8Time.isoUtc(System.currentTimeMillis()))
            emitRawPpgError(capture, message)
            if (!capture.storageFailureHandling && rawPpgCapture === capture) {
                capture.storageFailureHandling = true
                endRawPpgForError(message)
            }
            return
        }
        val pending = capture.pendingChunkSummary
        if (pending != null) capture.ppgUiSummaryEventDropped++
        capture.pendingChunkSummary = mergeRawPpgChunkSummaries(pending, chunk.liveSummary)
        queueRawPpgUiUpdate(capture)
    }

    private fun queueRawPpgUiUpdate(capture: RawPpgCapture) {
        if (capture.uiUpdateTimeout != null) return
        capture.uiUpdateTimeout = Runnable {
            capture.uiUpdateTimeout = null
            if (rawPpgCapture !== capture) return@Runnable
            val chunk = capture.pendingChunkSummary
            capture.pendingChunkSummary = null
            if (chunk != null) {
                capture.ppgChunkEventsSentToJs++
                emitRawPpgBridgeEvent(capture, JCVitalV8EventNormalizer.EVENT_RAW_PPG_CHUNK, chunk)
            }
            emitRawPpgStatus(capture)
        }.also { main.postDelayed(it, RAW_PPG_UI_UPDATE_INTERVAL_MS) }
    }

    private fun flushPendingRawPpgChunkSummary(capture: RawPpgCapture) {
        capture.uiUpdateTimeout?.let(main::removeCallbacks)
        capture.uiUpdateTimeout = null
        capture.pendingChunkSummary?.let { summary ->
            capture.ppgChunkEventsSentToJs++
            emitRawPpgBridgeEvent(capture, JCVitalV8EventNormalizer.EVENT_RAW_PPG_CHUNK, summary)
            capture.pendingChunkSummary = null
        }
    }

    private fun mergeRawPpgChunkSummaries(
        first: Map<String, Any?>?,
        next: Map<String, Any?>,
    ): Map<String, Any?> {
        if (first == null) return next
        fun count(summary: Map<String, Any?>, field: String) = (summary[field] as? Number)?.toLong() ?: 0L
        fun nested(summary: Map<String, Any?>, field: String): Map<String, Any?> = summary[field] as? Map<String, Any?> ?: emptyMap()
        fun mergeLayout(field: String): Map<String, Any?> {
            val left = nested(first, field)
            val right = nested(next, field)
            val leftMin = (left["minimumRawDecodedValue"] as? Number)?.toInt()
            val rightMin = (right["minimumRawDecodedValue"] as? Number)?.toInt()
            val leftMax = (left["maximumRawDecodedValue"] as? Number)?.toInt()
            val rightMax = (right["maximumRawDecodedValue"] as? Number)?.toInt()
            return linkedMapOf(
                "packetCount" to (count(left, "packetCount") + count(right, "packetCount")),
                "decodedSampleCount" to (count(left, "decodedSampleCount") + count(right, "decodedSampleCount")),
                "minimumRawDecodedValue" to listOfNotNull(leftMin, rightMin).minOrNull(),
                "maximumRawDecodedValue" to listOfNotNull(leftMax, rightMax).maxOrNull(),
            )
        }
        val leftLengths = nested(first, "notificationLengthCounts")
        val rightLengths = nested(next, "notificationLengthCounts")
        val leftStart = count(first, "sequenceStart")
        val rightEnd = count(next, "sequenceEnd")
        return linkedMapOf(
            "sessionId" to next["sessionId"],
            "sequenceStart" to minOf(leftStart, count(next, "sequenceStart")),
            "sequenceEnd" to maxOf(count(first, "sequenceEnd"), rightEnd),
            "packetCount" to (count(first, "packetCount") + count(next, "packetCount")),
            "chunkCount" to (count(first, "chunkCount") + count(next, "chunkCount")),
            "wireBytes" to (count(first, "wireBytes") + count(next, "wireBytes")),
            "firstReceivedAt" to first["firstReceivedAt"],
            "lastReceivedAt" to next["lastReceivedAt"],
            "notificationLengthCounts" to linkedMapOf(
                "153" to (count(leftLengths, "153") + count(rightLengths, "153")),
                "203" to (count(leftLengths, "203") + count(rightLengths, "203")),
                "other" to (count(leftLengths, "other") + count(rightLengths, "other")),
            ),
            "vendorType119Count" to (count(first, "vendorType119Count") + count(next, "vendorType119Count")),
            "decoded153Summary" to mergeLayout("decoded153Summary"),
            "decoded203Summary" to mergeLayout("decoded203Summary"),
            "parseErrorCount" to (count(first, "parseErrorCount") + count(next, "parseErrorCount")),
        )
    }

    private fun emitRawPpgBridgeEvent(capture: RawPpgCapture, event: String, payload: Map<String, Any?>) {
        val mutablePayload = payload as? MutableMap<String, Any?>
        var payloadBytes = JSONObject(payload).toString().toByteArray(Charsets.UTF_8).size
        repeat(3) {
            capture.ppgLastEventPayloadBytes = payloadBytes
            capture.ppgMaxEventPayloadBytes = maxOf(capture.ppgMaxEventPayloadBytes, payloadBytes)
            if (event == JCVitalV8EventNormalizer.EVENT_RAW_PPG_STATUS) {
                mutablePayload?.apply {
                    put("ppgLastEventPayloadBytes", capture.ppgLastEventPayloadBytes)
                    put("ppgMaxEventPayloadBytes", capture.ppgMaxEventPayloadBytes)
                }
                payloadBytes = JSONObject(payload).toString().toByteArray(Charsets.UTF_8).size
            }
        }
        emit(event, payload)
    }

    private fun closeRawPpgStore(capture: RawPpgCapture) {
        try {
            capture.packetStore.close()
        } catch (error: Throwable) {
            capture.storageErrorCount++
            capture.session.recordParseError("Could not close raw PPG store: ${error.message}", JCVitalV8Time.isoUtc(System.currentTimeMillis()))
        }
    }

    private fun finishRawPpgCapture(capture: RawPpgCapture, finalStatus: String, reason: String? = null) {
        flushRawPpg(capture, when (finalStatus) {
            RawPpgSession.STATUS_STOPPED -> capture.session.stop(JCVitalV8Time.isoUtc(System.currentTimeMillis()))
            RawPpgSession.STATUS_DISCONNECTED -> capture.session.disconnect(JCVitalV8Time.isoUtc(System.currentTimeMillis()))
            else -> capture.session.fail(JCVitalV8Time.isoUtc(System.currentTimeMillis()))
        })
        capture.maxDurationTimeout?.let(main::removeCallbacks)
        capture.maxDurationTimeout = null
        flushPendingRawPpgChunkSummary(capture)
        closeRawPpgStore(capture)
        rawPpgCapture = null
        reason?.let { emitRawPpgError(capture, it) }
        emitRawPpgStatus(capture)
        val result = rawPpgPayload(capture, includeChunkSamples = true)
        lastRawPpgSession = result
        capture.startCallback?.invoke(if (finalStatus == RawPpgSession.STATUS_STOPPED) result else null, if (finalStatus == RawPpgSession.STATUS_STOPPED) null else JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, reason ?: finalStatus))
        capture.startCallback = null
        capture.stopCallback?.invoke(if (finalStatus == RawPpgSession.STATUS_STOPPED) result else null, if (finalStatus == RawPpgSession.STATUS_STOPPED) null else JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, reason ?: finalStatus))
        capture.stopCallback = null
    }

    private fun failRawPpgCapture(capture: RawPpgCapture, message: String) {
        if (rawPpgCapture !== capture) return
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        capture.maxDurationTimeout?.let(main::removeCallbacks)
        capture.uiUpdateTimeout?.let(main::removeCallbacks)
        finishRawPpgCapture(capture, RawPpgSession.STATUS_ERROR, message)
    }

    private fun endRawPpgForLinkLoss(reason: String) {
        val capture = rawPpgCapture ?: return
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        capture.maxDurationTimeout?.let(main::removeCallbacks)
        BleSDK.ppgWithMode(5, 0)
        flushRawPpg(capture, capture.session.disconnect(JCVitalV8Time.isoUtc(System.currentTimeMillis())))
        flushPendingRawPpgChunkSummary(capture)
        closeRawPpgStore(capture)
        rawPpgCapture = null
        emitRawPpgError(capture, reason)
        emitRawPpgStatus(capture)
        val result = rawPpgPayload(capture, includeChunkSamples = true)
        lastRawPpgSession = result
        capture.startCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, reason))
        capture.startCallback = null
        capture.stopCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, reason))
        capture.stopCallback = null
    }

    private fun endRawPpgForError(reason: String) {
        val capture = rawPpgCapture ?: return
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        capture.maxDurationTimeout?.let(main::removeCallbacks)
        capture.uiUpdateTimeout?.let(main::removeCallbacks)
        BleSDK.ppgWithMode(5, 0)
        flushRawPpg(capture, capture.session.fail(JCVitalV8Time.isoUtc(System.currentTimeMillis())))
        flushPendingRawPpgChunkSummary(capture)
        closeRawPpgStore(capture)
        rawPpgCapture = null
        emitRawPpgError(capture, reason)
        emitRawPpgStatus(capture)
        val result = rawPpgPayload(capture, includeChunkSamples = true)
        lastRawPpgSession = result
        val error = JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, reason)
        capture.startCallback?.invoke(null, error)
        capture.startCallback = null
        capture.stopCallback?.invoke(null, error)
        capture.stopCallback = null
    }

    private fun emitRawPpgError(capture: RawPpgCapture, message: String) {
        emitRawPpgBridgeEvent(
            capture,
            JCVitalV8EventNormalizer.EVENT_RAW_PPG_ERROR,
            linkedMapOf(
                "sessionId" to capture.session.sessionId,
                "message" to message,
                "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
                "parseErrorCount" to capture.session.parseErrorCount,
            ),
        )
    }

    fun startRawEcg(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        val blocked = JCVitalV8WorkoutGuard.blockedReason(
            workoutCapture?.session,
            realtimeSessionId != null,
            historicalRequest != null,
            monitoringRequest != null,
            rawEcgCapture != null,
        )
        if (blocked != null) return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, blocked))
        val sessionId = UUID.randomUUID().toString()
        val packetStore = try {
            JCVitalV8RawEcgPacketStore.create(appContext.cacheDir, sessionId)
        } catch (error: Throwable) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "Could not create ECG session store: ${error.message}"))
        }
        val session = JCVitalV8RawEcgSession(
            sessionId = sessionId,
            deviceId = connectedDeviceId,
            firmwareVersion = deviceInfo["firmwareVersion"] as? String,
            startedAt = JCVitalV8Time.isoUtc(System.currentTimeMillis()),
            source = linkedMapOf(
                "connector" to "JCVITAL_NATIVE",
                "provider" to "JCVITAL",
                "deviceModel" to "PRO_V8",
                "deviceId" to connectedDeviceId,
                "firmwareVersion" to deviceInfo["firmwareVersion"],
                "sdkVersion" to JCVitalV8EventNormalizer.SDK_VERSION,
            ),
        )
        session.start()
        val capture = RawEcgCapture(session, callback, packetStore)
        rawEcgCapture = capture
        capture.diagnosticState = "START_COMMANDS_QUEUED"
        emitRawEcgStatus(capture)
        capture.startTimeout = Runnable {
            if (rawEcgCapture === capture && session.status == JCVitalV8RawEcgSession.STATUS_STARTING) {
                failRawEcgCapture(capture, "ECG start command write acknowledgment timed out")
            }
        }.also { main.postDelayed(it, COMMAND_TIMEOUT_MS) }
        capture.noDataTimeout = Runnable {
            if (rawEcgCapture === capture && capture.notificationDiagnostics.ecgWaveformCandidate07Count == 0 && capture.type64CallbackCount == 0) {
                capture.ecgNoDataAfter10s = true
                capture.diagnosticState = "NO_DATA_AFTER_10S"
                emitRawEcgStatus(capture)
            }
        }.also { main.postDelayed(it, 10_000L) }

        val measurementStartCommand = BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, ECG_DEMO_DURATION_ARGUMENT, true)
        capture.notificationDiagnostics.recordMeasurementCommand(measurementStartCommand)
        enqueue("SetDeviceMeasurementWithType(ECG,50000,true)", measurementStartCommand) { written ->
            if (written) capture.recordWriteAck("SetDeviceMeasurementWithType(ECG,50000,true)")
            else capture.controlWriteFailed = true
            if (written) capture.notificationDiagnostics.recordMeasurementCommandAck(System.currentTimeMillis())
            capture.diagnosticState = "START_COMMANDS_WRITING"
        }
        capture.recordQueued("SetDeviceMeasurementWithType(ECG,50000,true)")
        val realtimeFlagCommand = BleSDK.setECGRealtimeDuringHRVEnabled(true)
        capture.notificationDiagnostics.recordRealtimeFlagCommand(realtimeFlagCommand)
        enqueue("setECGRealtimeDuringHRVEnabled(true)", realtimeFlagCommand) { written ->
            if (!written || capture.controlWriteFailed) {
                failRawEcgCapture(capture, "ECG start command write failed")
            } else if (rawEcgCapture === capture && session.status == JCVitalV8RawEcgSession.STATUS_STARTING) {
                capture.recordWriteAck("setECGRealtimeDuringHRVEnabled(true)")
                capture.notificationDiagnostics.recordRealtimeFlagCommandAck(System.currentTimeMillis())
                capture.startTimeout?.let(main::removeCallbacks)
                capture.startTimeout = null
                capture.diagnosticState = "WAITING_FOR_DEVICE"
                session.markRunning()
                val result = rawEcgPayload(capture)
                capture.startCallback?.invoke(result, null)
                capture.startCallback = null
                emitRawEcgStatus(capture)
            }
        }
        capture.recordQueued("setECGRealtimeDuringHRVEnabled(true)")
    }

    fun stopRawEcg(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        val capture = rawEcgCapture
            ?: return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "No raw ECG session is active"))
        if (capture.session.status != JCVitalV8RawEcgSession.STATUS_RUNNING) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "Raw ECG session is not running"))
        }
        sessionStopCommands(capture, callback)
    }

    private fun sessionStopCommands(capture: RawEcgCapture, callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) {
        capture.session.markStopping()
        capture.controlWriteFailed = false
        capture.stopCallback = callback
        emitRawEcgStatus(capture)
        capture.stopTimeout = Runnable {
            failRawEcgCapture(capture, "ECG stop command write acknowledgment timed out")
        }.also { main.postDelayed(it, COMMAND_TIMEOUT_MS) }
        capture.diagnosticState = "STOPPING"
        enqueue(
            "SetDeviceMeasurementWithType(ECG,0,false)",
            BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, 0, false),
        ) { written ->
            if (!written) capture.controlWriteFailed = true
        }
        capture.recordQueued("SetDeviceMeasurementWithType(ECG,0,false)")
        enqueue("setECGRealtimeDuringHRVEnabled(false)", BleSDK.setECGRealtimeDuringHRVEnabled(false)) { written ->
            if (!written || capture.controlWriteFailed) {
                failRawEcgCapture(capture, "ECG stop command write failed")
            } else if (rawEcgCapture === capture && capture.session.status == JCVitalV8RawEcgSession.STATUS_STOPPING) {
                capture.recordWriteAck("setECGRealtimeDuringHRVEnabled(false)")
                capture.stopTimeout?.let(main::removeCallbacks)
                capture.stopTimeout = null
                capture.noDataTimeout?.let(main::removeCallbacks)
                capture.diagnosticState = "STOPPED"
                flushRawEcg(capture, capture.session.stop(JCVitalV8Time.isoUtc(System.currentTimeMillis())))
                closeRawEcgStore(capture)
                rawEcgCapture = null
                val result = rawEcgPayload(capture)
                lastRawEcgSession = result
                emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_STATUS, result)
                capture.stopCallback?.invoke(result, null)
                capture.stopCallback = null
            }
        }
        capture.recordQueued("setECGRealtimeDuringHRVEnabled(false)")
    }

    fun rawEcgStatus(): Map<String, Any?> = rawEcgCapture?.let(::rawEcgPayload)
        ?: lastRawEcgSession
        ?: linkedMapOf(
            "sessionId" to null,
            "deviceId" to connectedDeviceId,
            "status" to JCVitalV8RawEcgSession.STATUS_IDLE,
            "packetCount" to 0,
            "sampleCount" to 0,
            "missingPacketCount" to 0,
            "duplicatePacketCount" to 0,
            "outOfOrderPacketCount" to 0,
            "parseErrorCount" to 0,
            "bytesReceived" to 0,
            "chunksEmitted" to 0,
            "sampleRateHz" to null,
            "sampleIntervalMs" to null,
            "sampleFormat" to JCVitalV8RawEcgSession.SAMPLE_FORMAT,
            "unit" to JCVitalV8RawEcgSession.UNKNOWN_UNIT,
            "temporaryStorePath" to null,
            "persistedPacketCount" to 0,
            "persistedBytes" to 0,
            "storageErrorCount" to 0,
            "parseErrors" to emptyList<Any>(),
        )

    private fun rawEcgPayload(capture: RawEcgCapture): Map<String, Any?> = LinkedHashMap(capture.session.toMap()).apply {
        put("parseErrors", capture.parseErrors.toList())
        put("temporaryStorePath", capture.packetStore.file.absolutePath)
        put("persistedPacketCount", capture.packetStore.packetCount)
        put("persistedBytes", capture.packetStore.byteCount)
        put("storageErrorCount", capture.storageErrorCount)
        put("diagnosticState", capture.diagnosticState)
        put("ecgStartDiagnostics", capture.snapshotDiagnostics())
    }

    private fun idleWorkoutPayload(): Map<String, Any?> = linkedMapOf(
        "sessionId" to null,
        "deviceId" to connectedDeviceId,
        "activityType" to null,
        "vendorActivityMode" to null,
        "startedAt" to null,
        "stoppedAt" to null,
        "status" to JCVitalV8WorkoutSession.STATUS_IDLE,
        "packetCount" to 0,
        "firstPacketAt" to null,
        "lastPacketAt" to null,
        "heartbeatAttemptCount" to 0,
        "heartbeatSentCount" to 0,
        "heartbeatSkippedCount" to 0,
        "heartbeatIntervalMs" to JCVitalV8WorkoutSession.HEARTBEAT_INTERVAL_MS,
        "firmwareVersion" to (deviceInfo["firmwareVersion"] as? String),
        "sdkVersion" to JCVitalV8EventNormalizer.SDK_VERSION,
        "parseErrors" to emptyList<Any>(),
    )

    fun syncHistoricalActivity(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetTotalActivityDataWithMode", BleConst.GetTotalActivityData, { mode -> BleSDK.GetTotalActivityDataWithMode(mode, "") }, callback,
    )

    fun syncDetailedActivity(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetDetailActivityDataWithMode", BleConst.GetDetailActivityData, { mode -> BleSDK.GetDetailActivityDataWithMode(mode, "") }, callback,
    )

    fun syncHistoricalSleepStages(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetDetailSleepDataWithMode", BleConst.GetDetailSleepData, { mode -> BleSDK.GetDetailSleepDataWithMode(mode, "") }, callback,
    )

    fun syncHistoricalSleepMovement(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "getObtainDetailedSleepData", BleConst.Obtain_detailed_sleep_data, { mode -> BleSDK.getObtainDetailedSleepData(mode, "") }, callback,
    )

    fun syncHistoricalWorkouts(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = startHistorical(
        "GetActivityModeDataWithMode", BleConst.GetActivityModeData, { mode -> BleSDK.GetActivityModeDataWithMode(mode) }, callback,
    )

    fun requestMonitoringConfiguration(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit) = onMain {
        if (!requireReady(callback)) return@onMain
        val blocked = JCVitalV8WorkoutGuard.blockedReason(workoutCapture?.session, realtimeSessionId != null, historicalRequest != null, monitoringRequest != null, rawEcgCapture != null)
        if (blocked != null) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, blocked))
        }
        val request = MonitoringRequest(callback)
        monitoringRequest = request
        requestNextMonitorMode(request)
    }

    private fun startHistorical(
        name: String,
        dataType: String,
        command: (Byte) -> ByteArray,
        callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit,
    ) = onMain {
        if (!requireReady(callback)) return@onMain
        val blocked = JCVitalV8WorkoutGuard.blockedReason(workoutCapture?.session, realtimeSessionId != null, historicalRequest != null, monitoringRequest != null, rawEcgCapture != null)
        if (blocked != null) {
            return@onMain callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, blocked))
        }
        val request = HistoricalRequest(UUID.randomUUID().toString(), name, dataType, command, System.currentTimeMillis(), callback)
        historicalRequest = request
        armHistoricalTimeout(request)
        enqueue("$name(start)", command(HISTORY_MODE_START))
    }

    private fun enqueue(name: String, bytes: ByteArray, onWriteComplete: ((Boolean) -> Unit)? = null) {
        commandQueue.addLast(Command(name, bytes, onWriteComplete))
        pump()
    }

    private fun pump() {
        if (writeInFlight != null) return
        val g = gatt
        val characteristic = writeCharacteristic
        if (g == null || characteristic == null) {
            while (commandQueue.isNotEmpty()) commandQueue.removeFirst().onWriteComplete?.invoke(false)
            return
        }
        val command = commandQueue.removeFirstOrNull() ?: return
        val accepted = try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                g.writeCharacteristic(characteristic, command.bytes, BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT) == BluetoothStatusCodes.SUCCESS
            } else {
                characteristic.writeType = BluetoothGattCharacteristic.WRITE_TYPE_DEFAULT
                @Suppress("DEPRECATION")
                characteristic.value = command.bytes
                @Suppress("DEPRECATION")
                g.writeCharacteristic(characteristic)
            }
        } catch (t: Throwable) {
            Log.w(TAG, "write ${command.name} threw: ${t.message}")
            false
        }
        if (!accepted) {
            command.onWriteComplete?.invoke(false)
            emitError(JCVitalV8ErrorCode.COMMAND_FAILED, "${command.name} write rejected")
            return pump()
        }
        Log.i(TAG, "-> ${command.name}")
        writeInFlight = command
        writeTimeout = Runnable {
            if (writeInFlight !== command) return@Runnable
            writeInFlight = null
            command.onWriteComplete?.invoke(false)
            emitError(JCVitalV8ErrorCode.COMMAND_FAILED, "${command.name} write not acknowledged")
            pump()
        }.also { main.postDelayed(it, WRITE_TIMEOUT_MS) }
    }

    // --------------------------------------------------------------- responses

    private fun handleNotification(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val notificationReceivedAtMillis = System.currentTimeMillis()
        val notificationReceivedAt = JCVitalV8Time.isoUtc(notificationReceivedAtMillis)
        val capture = rawEcgCapture
        capture?.noteFirstNotificationAt(notificationReceivedAt, bytes)
        val notificationTrace = capture?.notificationDiagnostics?.captureNotification(
            bytes,
            notificationReceivedAt,
            notificationReceivedAtMillis,
        )
        val ppgCapture = rawPpgCapture
        val ppgNotificationCapture = if (
            bytes[0] == DeviceConst.CMD_Get_Bloodsugar || bytes[0] == DeviceConst.Bloodsugar_data
        ) {
            ppgCapture?.session?.captureNotification(bytes, notificationReceivedAt)
        } else {
            null
        }
        ppgNotificationCapture?.completedChunk?.let { completedChunk ->
            ppgCapture?.let { flushRawPpg(it, completedChunk) }
        }
        val ppgSequenceNumber = ppgNotificationCapture?.sequenceNumber
        val commandByte = String.format("0x%02X", bytes[0].toInt() and 0xFF)
        if ((bytes[0].toInt() and 0xFF) == JCVitalV8RawEcgSession.ECG_COMMAND_BYTE &&
            bytes.size > ECG_STREAM_MIN_NOTIFICATION_BYTES && rawEcgCapture != null
        ) {
            handleRawEcgNotification(bytes)
        }
        val vendorMaps = mutableListOf<Map<String?, Any?>>()
        try {
            BleSDK.DataParsingWithData(bytes, object : DataListener2301 {
                override fun dataCallback(maps: MutableMap<String?, Any?>?) {
                    maps?.let {
                        val copy = HashMap(it)
                        if (notificationTrace != null) {
                            capture?.notificationDiagnostics?.recordParserResult(
                                notificationTrace,
                                copy[DeviceKey.DataType]?.toString(),
                                copy[DeviceKey.End] as? Boolean,
                            )
                        }
                        vendorMaps += copy
                    }
                }

                override fun dataCallback(value: ByteArray?) {
                    if (value != null && notificationTrace != null) {
                        capture?.notificationDiagnostics?.recordParserResult(notificationTrace, null, null)
                    }
                }
            })
        } catch (t: Throwable) {
            if (ppgCapture != null && ppgSequenceNumber != null) {
                ppgCapture.session.recordParseError("SDK parse failed (${t.javaClass.simpleName})", notificationReceivedAt, bytes.size)
                flushRawPpg(ppgCapture, ppgCapture.session.completeNotification(ppgSequenceNumber))
                queueRawPpgUiUpdate(ppgCapture)
            }
            if (notificationTrace != null && capture != null) {
                capture.notificationDiagnostics.finishNotification(notificationTrace, bytes)
                emitRawEcgStatus(capture)
            }
            Log.w(TAG, "SDK parse failed for $commandByte (${bytes.size} bytes, mtu=$negotiatedMtu): ${t.javaClass.simpleName}")
            if ((bytes[0].toInt() and 0xFF) == JCVitalV8RawEcgSession.ECG_COMMAND_BYTE) {
                rawEcgCapture?.let { capture ->
                    capture.session.recordSdkParseError()
                    val error = linkedMapOf<String, Any?>(
                        "sessionId" to capture.session.sessionId,
                        "vendorDataType" to BleConst.GetECG,
                        "message" to "SDK parse failed (${t.javaClass.simpleName})",
                        "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
                        "rawPacketBytes" to bytes.map { it.toInt() and 0xFF },
                    )
                    capture.parseErrors.add(error)
                    emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_ERROR, error)
                    emitRawEcgStatus(capture)
                }
            }
            emitError(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, "SDK could not parse packet $commandByte (${bytes.size} bytes)")
            return
        }
        if (vendorMaps.isEmpty()) {
            Log.d(TAG, "<- $commandByte not handled by SDK")
            if (ppgCapture != null && ppgSequenceNumber != null) {
                flushRawPpg(ppgCapture, ppgCapture.session.completeNotification(ppgSequenceNumber))
                queueRawPpgUiUpdate(ppgCapture)
            }
            if (notificationTrace != null && capture != null) {
                capture.notificationDiagnostics.finishNotification(notificationTrace, bytes)
                emitRawEcgStatus(capture)
            }
            return
        }
        vendorMaps.forEach { vendor ->
            val dataType = vendor[DeviceKey.DataType]?.toString()
            if (ppgCapture != null && ppgSequenceNumber != null) {
                val fields = vendor[DeviceKey.Data] as? Map<*, *>
                ppgCapture.session.recordParserOutput(
                    ppgSequenceNumber,
                    dataType,
                    vendor[DeviceKey.End] as? Boolean,
                    fields,
                    notificationReceivedAt,
                )
            }
            if (dataType == BleConst.GetECG && rawEcgCapture != null) {
                val fields = vendor[DeviceKey.Data] as? Map<*, *> ?: emptyMap<Any?, Any?>()
                val sampleValues = fields[DeviceKey.arrayEcgRawData]?.toString()
                    ?.split(',')
                    ?.mapNotNull { token -> token.trim().toIntOrNull() }
                    ?: emptyList()
                rawEcgCapture?.noteType64(fields[DeviceKey.packetID]?.toString()?.toIntOrNull(), sampleValues, JCVitalV8Time.isoUtc(System.currentTimeMillis()))
            }
            routeVendorData(vendor)
        }
        if (ppgCapture != null && ppgSequenceNumber != null) {
            flushRawPpg(ppgCapture, ppgCapture.session.completeNotification(ppgSequenceNumber))
            queueRawPpgUiUpdate(ppgCapture)
        }
        if (notificationTrace != null && capture != null) {
            capture.notificationDiagnostics.finishNotification(notificationTrace, bytes)
            emitRawEcgStatus(capture)
        }
    }

    private fun routeVendorData(vendor: Map<String?, Any?>) {
        val dataType = vendor[DeviceKey.DataType]?.toString()
        if (rawEcgCapture != null && dataType != null) {
            val now = JCVitalV8Time.isoUtc(System.currentTimeMillis())
            rawEcgCapture?.recordVendorType(dataType, now)
            if (dataType == BleConst.GetEcgPpgStatus) {
                val payload = vendor[DeviceKey.Data] as? Map<*, *> ?: emptyMap<Any?, Any?>()
                val status = (payload[DeviceKey.EcgStatus] as? Number)?.toInt() ?: payload[DeviceKey.EcgStatus]?.toString()?.toIntOrNull()
                rawEcgCapture?.let {
                    it.ecgPpgStatusResponseCount += 1
                    it.noteEcgStatus(status, now)
                }
            }
        }
        Log.i(TAG, "<- vendor dataType=$dataType")
        val events = try {
            normalizer.normalize(
                vendor,
                JCVitalV8EventNormalizer.Context(
                    deviceId = connectedDeviceId,
                    firmwareVersion = deviceInfo["firmwareVersion"] as? String,
                    sessionId = historicalRequest?.syncId ?: realtimeSessionId,
                    receiptMillis = System.currentTimeMillis(),
                    timezone = TimeZone.getDefault().id,
                ),
            )
        } catch (t: Throwable) {
            val error = JCVitalV8Errors.fromThrowable(t, JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED)
            emitError(error.code, error.message ?: "Could not normalize vendor dataType=$dataType")
            return
        }
        for (event in events) {
            if (event.name == JCVitalV8EventNormalizer.EVENT_RAW_VENDOR_DATA &&
                ((dataType == BleConst.GetECG && rawEcgCapture != null) ||
                    (rawPpgCapture != null && (dataType == BleConst.Blood_glucose_status || dataType == BleConst.Blood_glucose_data)))
            ) continue
            when (event.name) {
                JCVitalV8EventNormalizer.EVENT_DEVICE_INFO -> {
                    deviceInfo.putAll(event.payload)
                    emit(event.name, deviceInfoSnapshot(emptySet()))
                }
                JCVitalV8EventNormalizer.EVENT_BATTERY -> {
                    lastBattery = event.payload
                    emit(event.name, event.payload)
                }
                else -> emit(event.name, event.payload)
            }
        }
        handleWorkoutResponse(dataType, vendor)
        handleWorkoutPacket(dataType, vendor)
        handleHistoricalResponse(dataType, vendor, events)
        handleMonitoringResponse(dataType, vendor)
        if (dataType != null) resolveResponse(dataType)
    }

    private fun handleRawEcgNotification(notification: ByteArray) {
        val capture = rawEcgCapture ?: return
        val receivedAt = JCVitalV8Time.isoUtc(System.currentTimeMillis())
        val result = capture.session.acceptNotification(notification, receivedAt)
        result.parseError?.let { error ->
            capture.parseErrors.add(error)
            emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_ERROR, error)
        }
        result.chunk?.let { flushRawEcg(capture, it) }
        emitRawEcgStatus(capture)
    }

    private fun emitRawEcgStatus(capture: RawEcgCapture) {
        val payload = rawEcgPayload(capture)
        if (rawEcgCapture !== capture && capture.session.status != JCVitalV8RawEcgSession.STATUS_RUNNING) {
            lastRawEcgSession = payload
        }
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_STATUS, payload)
    }

    private fun flushRawEcg(capture: RawEcgCapture, chunk: Map<String, Any?>?) {
        if (chunk == null) return
        try {
            @Suppress("UNCHECKED_CAST")
            capture.packetStore.appendPackets(chunk["rawPacketBytes"] as List<List<Int>>)
        } catch (error: Throwable) {
            capture.storageErrorCount++
            capture.session.recordSdkParseError()
            val storageError = linkedMapOf<String, Any?>(
                "sessionId" to capture.session.sessionId,
                "message" to "Could not persist raw ECG chunk: ${error.message}",
                "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
                "chunkSequence" to chunk["sequenceNumber"],
            )
            capture.parseErrors.add(storageError)
            emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_ERROR, storageError)
        }
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_CHUNK, chunk)
    }

    private fun closeRawEcgStore(capture: RawEcgCapture) {
        try {
            capture.packetStore.close()
        } catch (error: Throwable) {
            capture.storageErrorCount++
            capture.session.recordSdkParseError()
            capture.parseErrors.add(
                linkedMapOf(
                    "sessionId" to capture.session.sessionId,
                    "message" to "Could not close raw ECG store: ${error.message}",
                    "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
                ),
            )
        }
    }

    private fun failRawEcgCapture(capture: RawEcgCapture, message: String) {
        if (rawEcgCapture !== capture) return
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        capture.noDataTimeout?.let(main::removeCallbacks)
        val chunk = capture.session.fail(JCVitalV8Time.isoUtc(System.currentTimeMillis()))
        flushRawEcg(capture, chunk)
        closeRawEcgStore(capture)
        BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, 0, false)
        BleSDK.setECGRealtimeDuringHRVEnabled(false)
        rawEcgCapture = null
        val error = linkedMapOf<String, Any?>("sessionId" to capture.session.sessionId, "message" to message, "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()))
        capture.parseErrors.add(error)
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_ERROR, error)
        val result = rawEcgPayload(capture)
        lastRawEcgSession = result
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_STATUS, result)
        capture.startCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, message))
        capture.startCallback = null
        capture.stopCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, message))
        capture.stopCallback = null
    }

    private fun endRawEcgForLinkLoss(reason: String) {
        val capture = rawEcgCapture ?: return
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, 0, false)
        BleSDK.setECGRealtimeDuringHRVEnabled(false)
        val chunk = capture.session.disconnect(JCVitalV8Time.isoUtc(System.currentTimeMillis()))
        flushRawEcg(capture, chunk)
        closeRawEcgStore(capture)
        rawEcgCapture = null
        val error = linkedMapOf<String, Any?>("sessionId" to capture.session.sessionId, "message" to reason, "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()))
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_ERROR, error)
        val result = rawEcgPayload(capture)
        lastRawEcgSession = result
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_STATUS, result)
        capture.startCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, reason))
        capture.startCallback = null
        capture.stopCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, reason))
        capture.stopCallback = null
    }

    private fun endRawEcgForError(reason: String) {
        val capture = rawEcgCapture ?: return
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        BleSDK.SetDeviceMeasurementWithType(AutoTestMode.ECG, 0, false)
        BleSDK.setECGRealtimeDuringHRVEnabled(false)
        flushRawEcg(capture, capture.session.fail(JCVitalV8Time.isoUtc(System.currentTimeMillis())))
        closeRawEcgStore(capture)
        rawEcgCapture = null
        val error = linkedMapOf<String, Any?>("sessionId" to capture.session.sessionId, "message" to reason, "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()))
        capture.parseErrors.add(error)
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_ERROR, error)
        val result = rawEcgPayload(capture)
        lastRawEcgSession = result
        emit(JCVitalV8EventNormalizer.EVENT_RAW_ECG_STATUS, result)
        capture.startCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, reason))
        capture.startCallback = null
        capture.stopCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, reason))
        capture.stopCallback = null
    }

    private fun handleWorkoutResponse(dataType: String?, vendor: Map<String?, Any?>) {
        if (dataType != BleConst.EnterActivityMode) return
        val capture = workoutCapture ?: return
        val isStarting = capture.session.status == JCVitalV8WorkoutSession.STATUS_STARTING
        val isStopping = capture.session.status == JCVitalV8WorkoutSession.STATUS_STOPPING
        if (!isStarting && !isStopping) return
        if (isStarting) {
            capture.startTimeout?.let(main::removeCallbacks)
            capture.startTimeout = null
        }
        @Suppress("UNCHECKED_CAST")
        val data = JCVitalV8EventNormalizer.sanitize(vendor[DeviceKey.Data]) as? Map<String, Any?> ?: emptyMap()
        val responseCode = data[DeviceKey.enterActivityModeSuccess]?.toString()?.toIntOrNull()
        if (isStopping) {
            if (responseCode == null || responseCode == 0) {
                failWorkoutCapture(
                    capture,
                    JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "V8 did not acknowledge workout finish"),
                )
            } else {
                capture.stopTimeout?.let(main::removeCallbacks)
                capture.stopTimeout = null
                capture.session.stop(System.currentTimeMillis())
                workoutCapture = null
                val result = workoutSessionPayload(capture)
                lastWorkoutSession = result
                emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_STATE, result)
                capture.stopCallback?.invoke(result, null)
                capture.stopCallback = null
            }
            return
        }
        if (responseCode == null) {
            capture.session.markError(System.currentTimeMillis())
            workoutCapture = null
            lastWorkoutSession = workoutSessionPayload(capture)
            val error = JCVitalV8Exception(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, "EnterActivityMode response did not contain ${DeviceKey.enterActivityModeSuccess}")
            capture.startCallback(null, error)
            emitWorkoutError(capture.session.sessionId, error.message ?: "Workout start response malformed")
            emitWorkoutStatus(capture)
            return
        }
        if (responseCode == 0) {
            capture.session.markError(System.currentTimeMillis())
            workoutCapture = null
            lastWorkoutSession = workoutSessionPayload(capture)
            val error = JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "V8 rejected the exercise start request")
            capture.startCallback(null, error)
            emitWorkoutError(capture.session.sessionId, error.message ?: "Workout start rejected")
            emitWorkoutStatus(capture)
            return
        }
        capture.session.markRunning()
        scheduleWorkoutHeartbeat(capture)
        val result = workoutSessionPayload(capture)
        capture.startCallback(result, null)
        emitWorkoutStatus(capture)
    }

    private fun handleWorkoutPacket(dataType: String?, vendor: Map<String?, Any?>) {
        if (dataType != BleConst.SportData) return
        val capture = workoutCapture ?: return
        if (capture.session.status != JCVitalV8WorkoutSession.STATUS_RUNNING) return
        val receivedAt = JCVitalV8Time.isoUtc(System.currentTimeMillis())
        val sequence = capture.session.recordPacket(receivedAt)
        val packet = try {
            workoutNormalizer.normalize(
                vendor,
                JCVitalV8WorkoutNormalizer.Context(
                    sessionId = capture.session.sessionId,
                    deviceId = connectedDeviceId,
                    firmwareVersion = deviceInfo["firmwareVersion"] as? String,
                    packetSequence = sequence,
                    receivedAt = receivedAt,
                    activityMode = capture.session.activityMode,
                ),
            )
        } catch (error: Throwable) {
            val normalized = JCVitalV8Errors.fromThrowable(error, JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED)
            val parseError = linkedMapOf<String, Any?>(
                "vendorDataType" to dataType,
                "message" to (normalized.message ?: "Could not normalize workout packet"),
                "receivedAt" to receivedAt,
                "rawVendorPayload" to JCVitalV8EventNormalizer.sanitize(vendor),
            )
            capture.parseErrors.add(parseError)
            emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_PARSE_ERROR, parseError)
            emitWorkoutError(capture.session.sessionId, normalized.message ?: "Could not normalize workout packet")
            return
        }
        emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_PACKET, packet)
        val heartRate = packet["heartRate"] as? Int
        if (heartRate != null) {
            emit(
                JCVitalV8EventNormalizer.EVENT_WORKOUT_HEART_RATE,
                linkedMapOf(
                    "sessionId" to capture.session.sessionId,
                    "heartRate" to heartRate,
                    "receivedAt" to receivedAt,
                    "packetSequence" to sequence,
                    "vendorDataType" to dataType,
                    "acquisitionMode" to "WORKOUT_REALTIME",
                ),
            )
        }
    }

    private fun scheduleWorkoutHeartbeat(capture: WorkoutCapture) {
        cancelWorkoutHeartbeat(capture)
        capture.nextHeartbeatUptime = SystemClock.uptimeMillis() + JCVitalV8WorkoutSession.HEARTBEAT_INTERVAL_MS
        val heartbeat = object : Runnable {
            override fun run() {
                if (workoutCapture !== capture || capture.session.status != JCVitalV8WorkoutSession.STATUS_RUNNING) return
                capture.session.recordHeartbeatAttempt()
                if (gatt != null && writeInFlight == null && commandQueue.isEmpty()) {
                    // GPS distance, pace, and the vendor 0-6 signal scale are unavailable; zero is explicit, not inferred.
                    enqueue("sendHeartPackage(1Hz)", BleSDK.sendHeartPackage(0f, 0, 0)) { written ->
                        if (written) capture.session.recordHeartbeatSent() else capture.session.recordHeartbeatSkipped()
                        emitWorkoutStatus(capture)
                    }
                } else {
                    capture.session.recordHeartbeatSkipped()
                }
                capture.nextHeartbeatUptime += JCVitalV8WorkoutSession.HEARTBEAT_INTERVAL_MS
                val now = SystemClock.uptimeMillis()
                if (capture.nextHeartbeatUptime <= now) {
                    val missed = ((now - capture.nextHeartbeatUptime) / JCVitalV8WorkoutSession.HEARTBEAT_INTERVAL_MS) + 1
                    capture.session.recordHeartbeatAttempt(missed)
                    capture.session.recordHeartbeatSkipped(missed)
                    capture.nextHeartbeatUptime += missed * JCVitalV8WorkoutSession.HEARTBEAT_INTERVAL_MS
                }
                emitWorkoutStatus(capture)
                main.postAtTime(this, capture.nextHeartbeatUptime)
            }
        }
        capture.heartbeatRunnable = heartbeat
        main.postAtTime(heartbeat, capture.nextHeartbeatUptime)
    }

    private fun cancelWorkoutHeartbeat(capture: WorkoutCapture) {
        capture.heartbeatRunnable?.let(main::removeCallbacks)
        capture.heartbeatRunnable = null
    }

    private fun workoutSessionPayload(capture: WorkoutCapture): Map<String, Any?> =
        LinkedHashMap(capture.session.toMap()).apply {
            put("parseErrors", capture.parseErrors.toList())
            put("classification", "PENDING")
        }

    private fun emitWorkoutStatus(capture: WorkoutCapture) {
        updateWorkoutSnapshot(capture)
        emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_STATE, workoutSessionPayload(capture))
    }

    private fun updateWorkoutSnapshot(capture: WorkoutCapture) {
        if (workoutCapture !== capture && capture.session.status != JCVitalV8WorkoutSession.STATUS_RUNNING) {
            lastWorkoutSession = workoutSessionPayload(capture)
        }
    }

    private fun emitWorkoutError(sessionId: String, message: String) {
        emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_ERROR, linkedMapOf(
            "sessionId" to sessionId,
            "message" to message,
            "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
        ))
    }

    private fun endWorkoutForLinkLoss(reason: String) {
        val capture = workoutCapture ?: return
        val wasStarting = capture.session.status == JCVitalV8WorkoutSession.STATUS_STARTING
        cancelWorkoutHeartbeat(capture)
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        capture.session.stop(System.currentTimeMillis(), JCVitalV8WorkoutSession.STATUS_DISCONNECTED)
        workoutCapture = null
        val result = workoutSessionPayload(capture)
        lastWorkoutSession = result
        if (wasStarting) capture.startCallback(null, JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, "Connection lost during workout start"))
        capture.stopCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, reason))
        capture.stopCallback = null
        emitWorkoutError(capture.session.sessionId, reason)
        emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_STATE, result)
    }

    private fun endWorkoutForError(reason: String) {
        val capture = workoutCapture ?: return
        val wasStarting = capture.session.status == JCVitalV8WorkoutSession.STATUS_STARTING
        cancelWorkoutHeartbeat(capture)
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        capture.session.markError(System.currentTimeMillis())
        workoutCapture = null
        val result = workoutSessionPayload(capture)
        lastWorkoutSession = result
        if (wasStarting) capture.startCallback(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, reason))
        capture.stopCallback?.invoke(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, reason))
        capture.stopCallback = null
        emitWorkoutError(capture.session.sessionId, reason)
        emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_STATE, result)
    }

    private fun failWorkoutCapture(capture: WorkoutCapture, error: JCVitalV8Exception) {
        if (workoutCapture !== capture) return
        val wasStarting = capture.session.status == JCVitalV8WorkoutSession.STATUS_STARTING
        cancelWorkoutHeartbeat(capture)
        capture.startTimeout?.let(main::removeCallbacks)
        capture.stopTimeout?.let(main::removeCallbacks)
        capture.session.markError(System.currentTimeMillis())
        workoutCapture = null
        val result = workoutSessionPayload(capture)
        lastWorkoutSession = result
        if (wasStarting) capture.startCallback(null, error)
        capture.stopCallback?.invoke(null, error)
        capture.stopCallback = null
        emitWorkoutError(capture.session.sessionId, error.message ?: "Workout capture failed")
        emit(JCVitalV8EventNormalizer.EVENT_WORKOUT_STATE, result)
    }

    private fun requestNextMonitorMode(request: MonitoringRequest) {
        request.timeout?.let(main::removeCallbacks)
        val next = request.remaining.removeFirstOrNull()
        if (next == null) {
            monitoringRequest = null
            request.callback(
                linkedMapOf(
                    "deviceId" to connectedDeviceId,
                    "provider" to "JCVITAL",
                    "acquisitionMode" to "DEVICE_CONFIGURATION",
                    "receivedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
                    "configurations" to request.configurations,
                ),
                null,
            )
            return
        }
        request.current = next
        request.timeout = Runnable {
            if (monitoringRequest !== request) return@Runnable
            monitoringRequest = null
            request.callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.COMMAND_FAILED, "No ${next.first} monitoring configuration response"))
        }.also { main.postDelayed(it, COMMAND_TIMEOUT_MS) }
        enqueue("GetAutomatic(${next.first})", BleSDK.GetAutomatic(next.second))
    }

    private fun handleMonitoringResponse(dataType: String?, vendor: Map<String?, Any?>) {
        val request = monitoringRequest ?: return
        if (dataType != BleConst.GetAutomatic) return
        val mode = request.current ?: return
        @Suppress("UNCHECKED_CAST")
        val raw = JCVitalV8EventNormalizer.sanitize(vendor[DeviceKey.Data]) as? Map<String, Any?> ?: emptyMap()
        request.configurations[mode.first] = linkedMapOf(
            "enabledModeRaw" to raw[DeviceKey.WorkMode],
            "intervalMinutesRaw" to raw[DeviceKey.IntervalTime],
            "startHourRaw" to raw[DeviceKey.StartTime],
            "startMinuteRaw" to raw[DeviceKey.KHeartStartMinter],
            "endHourRaw" to raw[DeviceKey.EndTime],
            "endMinuteRaw" to raw[DeviceKey.KHeartEndMinter],
            "weekdaysRaw" to raw[DeviceKey.Weeks],
            "vendorDataType" to dataType,
            "rawPayload" to JCVitalV8EventNormalizer.sanitize(vendor),
        )
        request.current = null
        requestNextMonitorMode(request)
    }

    private fun handleHistoricalResponse(dataType: String?, vendor: Map<String?, Any?>, events: List<JCVitalV8EventNormalizer.Event>) {
        val request = historicalRequest ?: return
        if (dataType != request.dataType) return
        request.packetCount++
        val records = vendor[DeviceKey.Data] as? List<*>
        request.recordGroupCount += records?.size ?: 0
        events.filter { it.name == JCVitalV8EventNormalizer.EVENT_OBSERVATION }.forEach { event ->
            val id = event.payload["id"]?.toString()
            if (id == null) request.parseErrors.add(linkedMapOf("message" to "Observation has no id", "payload" to event.payload))
            else if (request.observations.putIfAbsent(id, event.payload) != null) request.duplicateCount++
        }
        request.parseErrors.addAll(events.filter { it.name == JCVitalV8EventNormalizer.EVENT_PARSE_ERROR }.map { it.payload })
        if (vendor[DeviceKey.End] == true) {
            finishHistorical(request, if (request.observations.isEmpty()) "EMPTY_VALID" else "COMPLETE")
            return
        }
        armHistoricalTimeout(request)
        if (request.packetCount % HISTORY_PAGE_PACKETS == 0) enqueue("${request.name}(continue)", request.command(HISTORY_MODE_CONTINUE))
    }

    private fun armHistoricalTimeout(request: HistoricalRequest) {
        request.timeout?.let(main::removeCallbacks)
        request.timeout = Runnable {
            if (historicalRequest !== request) return@Runnable
            finishHistorical(request, if (request.observations.isEmpty()) "FAILED" else "PARTIAL")
        }.also { main.postDelayed(it, HISTORY_TIMEOUT_MS) }
    }

    private fun finishHistorical(request: HistoricalRequest, completionStatus: String) {
        if (historicalRequest !== request) return
        request.timeout?.let(main::removeCallbacks)
        historicalRequest = null
        val observations = request.observations.values.toList()
        val times = observations.mapNotNull { it["observedAt"] as? String }.sorted()
        request.callback(
            linkedMapOf(
                "syncId" to request.syncId,
                "deviceId" to connectedDeviceId,
                "provider" to "JCVITAL",
                "sdkCommand" to request.name,
                "vendorDataType" to request.dataType,
                "startedAt" to JCVitalV8Time.isoUtc(request.startedAt),
                "completedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
                "recordsReceived" to observations.size,
                "recordGroupsReceived" to request.recordGroupCount,
                "recordsStored" to 0,
                "recordsDeduplicated" to request.duplicateCount,
                "recordsRejected" to request.parseErrors.size,
                "earliestObservation" to times.firstOrNull(),
                "latestObservation" to times.lastOrNull(),
                "partial" to (completionStatus == "PARTIAL"),
                "completionStatus" to completionStatus,
                "packetCount" to request.packetCount,
                "parseErrors" to request.parseErrors,
                "observations" to observations,
            ),
            null,
        )
    }

    private fun awaitResponses(dataTypes: Set<String>, timeoutMs: Long, complete: (missing: Set<String>) -> Unit) {
        val request = PendingRequest(dataTypes.toMutableSet(), complete)
        request.timeout = Runnable {
            if (pendingRequests.remove(request)) request.complete(request.expected.toSet())
        }.also { main.postDelayed(it, timeoutMs) }
        pendingRequests += request
    }

    private fun resolveResponse(dataType: String) {
        val done = pendingRequests.filter { it.expected.remove(dataType) && it.expected.isEmpty() }
        done.forEach { request ->
            pendingRequests.remove(request)
            request.timeout?.let(main::removeCallbacks)
            request.complete(emptySet())
        }
    }

    private fun deviceInfoSnapshot(missing: Set<String>): Map<String, Any?> {
        val snapshot = LinkedHashMap<String, Any?>(deviceInfo)
        lastBattery?.let {
            snapshot["batteryLevel"] = it["level"]
            snapshot["charging"] = it["charging"]
        }
        snapshot["sdkVersion"] = JCVitalV8EventNormalizer.SDK_VERSION
        snapshot["missingFields"] = missing.mapNotNull { DATA_TYPE_FIELDS[it] }
        return snapshot
    }

    // ------------------------------------------------------------ housekeeping

    private fun onAdapterStateChanged(adapterState: Int) {
        Log.i(TAG, "bluetooth adapter state=$adapterState")
        if (adapterState != BluetoothAdapter.STATE_TURNING_OFF && adapterState != BluetoothAdapter.STATE_OFF) return
        if (scanning) {
            scanning = false
            scanTimeout?.let(main::removeCallbacks)
            stateMachine.transition(JCVitalV8ConnectionState.DISCONNECTED, "bluetooth off")
        }
        if (gatt != null || stateMachine.isLinkActive) {
            fail(JCVitalV8ErrorCode.BLUETOOTH_DISABLED, "Bluetooth was turned off")
        }
    }

    /** Tears down the link after an unexpected failure and moves to ERROR. */
    private fun fail(code: JCVitalV8ErrorCode, message: String) {
        Log.w(TAG, "$code: $message")
        endWorkoutForError(message)
        endRawEcgForError(message)
        endRawPpgForError(message)
        closeGatt()
        emitError(code, message)
        // Leave INITIALIZING before completing pending work so the handshake callback cannot re-enter fail().
        stateMachine.transition(JCVitalV8ConnectionState.ERROR, code.name)
        failPendingWork(JCVitalV8Exception(code, message))
    }

    private fun failPendingWork(error: JCVitalV8Exception) {
        pendingConnect?.invoke(error)
        pendingConnect = null
        val requests = pendingRequests.toList()
        pendingRequests.clear()
        requests.forEach { request ->
            request.timeout?.let(main::removeCallbacks)
            request.complete(request.expected.toSet())
        }
        historicalRequest?.let { request ->
            request.timeout?.let(main::removeCallbacks)
            historicalRequest = null
            request.callback(null, error)
        }
        monitoringRequest?.let { request ->
            request.timeout?.let(main::removeCallbacks)
            monitoringRequest = null
            request.callback(null, error)
        }
    }

    private fun closeGatt() {
        clearConnectTimeout()
        clearInitTimeout()
        clearWriteTimeout()
        while (commandQueue.isNotEmpty()) commandQueue.removeFirst().onWriteComplete?.invoke(false)
        writeInFlight?.onWriteComplete?.invoke(false)
        writeInFlight = null
        initStep = InitStep.NONE
        realtimeSessionId = null
        writeCharacteristic = null
        notifyCharacteristic = null
        val g = gatt ?: return
        gatt = null
        try {
            g.disconnect()
            g.close()
        } catch (t: Throwable) {
            Log.w(TAG, "gatt close failed: ${t.message}")
        }
        Log.i(TAG, "gatt closed")
    }

    private fun resetSession() {
        closeGatt()
        deviceInfo.clear()
        lastBattery = null
        negotiatedMtu = DEFAULT_ATT_MTU
    }

    fun release() = onMain {
        try {
            appContext.unregisterReceiver(bluetoothStateReceiver)
        } catch (_: IllegalArgumentException) {
        }
        stopScanInternal("released")
        endWorkoutForLinkLoss("Plugin released")
        endRawEcgForLinkLoss("Plugin released")
        endRawPpgForLinkLoss("Plugin released")
        closeGatt()
        stateMachine.transition(JCVitalV8ConnectionState.DISCONNECTED, "released")
        failPendingWork(JCVitalV8Exception(JCVitalV8ErrorCode.CONNECTION_LOST, "Plugin released"))
    }

    private fun requireUsable() {
        if (!isAvailable()) throw JCVitalV8Exception(JCVitalV8ErrorCode.BLUETOOTH_UNAVAILABLE, "Bluetooth LE is not available")
        val missing = JCVitalV8Permissions.requiredPermissions(Build.VERSION.SDK_INT)
            .filter { ContextCompat.checkSelfPermission(appContext, it) != PackageManager.PERMISSION_GRANTED }
        if (missing.isNotEmpty()) throw JCVitalV8Exception(JCVitalV8ErrorCode.PERMISSION_DENIED, "Missing ${missing.joinToString()}")
        if (!isEnabled()) throw JCVitalV8Exception(JCVitalV8ErrorCode.BLUETOOTH_DISABLED, "Bluetooth is turned off")
    }

    private fun requireReady(callback: (Map<String, Any?>?, JCVitalV8Exception?) -> Unit): Boolean {
        if (state == JCVitalV8ConnectionState.READY && gatt != null) return true
        callback(null, JCVitalV8Exception(JCVitalV8ErrorCode.UNSUPPORTED_OPERATION, "V8 is not READY (state=$state)"))
        return false
    }

    private fun emitError(code: JCVitalV8ErrorCode, message: String) {
        emit(JCVitalV8EventNormalizer.EVENT_ERROR, JCVitalV8Errors.toPayload(code, message, state, connectedDeviceId, System.currentTimeMillis()))
    }

    private fun emit(name: String, payload: Map<String, Any?>) {
        try {
            listener.onEvent(name, payload)
        } catch (t: Throwable) {
            Log.w(TAG, "listener failed for $name: ${t.message}")
        }
    }

    private fun clearConnectTimeout() {
        connectTimeout?.let(main::removeCallbacks)
        connectTimeout = null
    }

    private fun clearInitTimeout() {
        initTimeout?.let(main::removeCallbacks)
        initTimeout = null
    }

    private fun clearWriteTimeout() {
        writeTimeout?.let(main::removeCallbacks)
        writeTimeout = null
    }

    private fun safeName(device: BluetoothDevice): String? = try {
        device.name
    } catch (_: SecurityException) {
        null
    }

    private fun safeBonded(device: BluetoothDevice): Boolean = try {
        device.bondState == BluetoothDevice.BOND_BONDED
    } catch (_: SecurityException) {
        false
    }

    private inline fun onMain(crossinline block: () -> Unit) {
        if (Looper.myLooper() == Looper.getMainLooper()) block() else main.post { block() }
    }

    companion object {
        private const val TAG = "JCVitalV8"

        // GATT layout from vendor BleService (identical in v8_kotlion and v8test).
        val SERVICE_UUID: UUID = UUID.fromString("0000fff0-0000-1000-8000-00805f9b34fb")
        val WRITE_CHARACTERISTIC_UUID: UUID = UUID.fromString("0000fff6-0000-1000-8000-00805f9b34fb")
        val NOTIFY_CHARACTERISTIC_UUID: UUID = UUID.fromString("0000fff7-0000-1000-8000-00805f9b34fb")
        val CCCD_UUID: UUID = UUID.fromString("00002902-0000-1000-8000-00805f9b34fb")

        const val DEFAULT_SCAN_TIMEOUT_MS = 30_000L
        const val DEFAULT_MEASUREMENT_SECONDS = 60L
        private const val MIN_MEASUREMENT_SECONDS = 31L
        private const val MAX_MEASUREMENT_SECONDS = 0xFFFFL
        private const val SERVICE_DISCOVERY_DELAY_MS = 600L
        private const val CONNECT_TIMEOUT_MS = 20_000L
        private const val INIT_TIMEOUT_MS = 10_000L
        private const val COMMAND_TIMEOUT_MS = 8_000L
        private const val RAW_PPG_UI_UPDATE_INTERVAL_MS = 750L
        private const val RAW_PPG_SAFE_TEST_DURATION_MS = 20_000L
        private const val HISTORY_TIMEOUT_MS = 15_000L
        private const val HISTORY_PAGE_PACKETS = 50
        private const val HISTORY_MODE_START: Byte = 0x00
        private const val HISTORY_MODE_CONTINUE: Byte = 0x02
        private const val WRITE_TIMEOUT_MS = 3_000L
        private const val DEFAULT_ATT_MTU = 23
        private const val ECG_STREAM_MIN_NOTIFICATION_BYTES = 17
        private const val ECG_DEMO_DURATION_ARGUMENT = 50_000L
        // V8 reports MTUlength=244 in its SetDeviceTime response; 247 ATT MTU = 244-byte payload.
        private const val REQUESTED_MTU = 247

        private val DEVICE_INFO_RESPONSES = setOf(
            BleConst.CMD_Get_Name,
            BleConst.GetDeviceMacAddress,
            BleConst.GetDeviceVersion,
            BleConst.GetPersonalInfo,
            BleConst.GetDeviceBatteryLevel,
        )

        private val DATA_TYPE_FIELDS = mapOf(
            BleConst.CMD_Get_Name to "deviceName",
            BleConst.GetDeviceMacAddress to "macAddress",
            BleConst.GetDeviceVersion to "firmwareVersion",
            BleConst.GetPersonalInfo to "vendorDeviceId",
            BleConst.GetDeviceBatteryLevel to "batteryLevel",
        )

        private val MONITOR_MODES = listOf(
            "HEART_RATE" to AutoMode.AutoHeartRate,
            "SPO2" to AutoMode.AutoSpo2,
            "TEMPERATURE" to AutoMode.AutoTemp,
            "HRV" to AutoMode.AutoHrv,
        )
    }
}
