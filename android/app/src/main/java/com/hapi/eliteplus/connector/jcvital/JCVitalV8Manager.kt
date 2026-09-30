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
import android.util.Log
import androidx.core.content.ContextCompat
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import com.jstyle.blesdkv8.constant.BleConst
import com.jstyle.blesdkv8.constant.DeviceKey
import com.jstyle.blesdkv8.model.AutoTestMode
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

    private class Command(val name: String, val bytes: ByteArray)

    private class PendingRequest(
        val expected: MutableSet<String>,
        val complete: (missing: Set<String>) -> Unit,
    ) {
        var timeout: Runnable? = null
    }

    private val appContext = context.applicationContext
    private val main = Handler(Looper.getMainLooper())
    private val bluetoothManager = appContext.getSystemService(BluetoothManager::class.java)
    private val registry = JCVitalV8DeviceRegistry()
    private val normalizer = JCVitalV8EventNormalizer()
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
                if (status != BluetoothGatt.GATT_SUCCESS) {
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

    private fun enqueue(name: String, bytes: ByteArray) {
        commandQueue.addLast(Command(name, bytes))
        pump()
    }

    private fun pump() {
        if (writeInFlight != null) return
        val g = gatt
        val characteristic = writeCharacteristic
        if (g == null || characteristic == null) {
            commandQueue.clear()
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
            emitError(JCVitalV8ErrorCode.COMMAND_FAILED, "${command.name} write rejected")
            return pump()
        }
        Log.i(TAG, "-> ${command.name}")
        writeInFlight = command
        writeTimeout = Runnable {
            if (writeInFlight !== command) return@Runnable
            writeInFlight = null
            emitError(JCVitalV8ErrorCode.COMMAND_FAILED, "${command.name} write not acknowledged")
            pump()
        }.also { main.postDelayed(it, WRITE_TIMEOUT_MS) }
    }

    // --------------------------------------------------------------- responses

    private fun handleNotification(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        val commandByte = String.format("0x%02X", bytes[0].toInt() and 0xFF)
        val vendorMaps = mutableListOf<Map<String?, Any?>>()
        try {
            BleSDK.DataParsingWithData(bytes, object : DataListener2301 {
                override fun dataCallback(maps: MutableMap<String?, Any?>?) {
                    maps?.let { vendorMaps += HashMap(it) }
                }

                override fun dataCallback(value: ByteArray?) = Unit
            })
        } catch (t: Throwable) {
            Log.w(TAG, "SDK parse failed for $commandByte (${bytes.size} bytes, mtu=$negotiatedMtu): ${t.javaClass.simpleName}")
            emitError(JCVitalV8ErrorCode.RESPONSE_PARSE_FAILED, "SDK could not parse packet $commandByte (${bytes.size} bytes)")
            return
        }
        if (vendorMaps.isEmpty()) {
            Log.d(TAG, "<- $commandByte not handled by SDK")
            return
        }
        vendorMaps.forEach(::routeVendorData)
    }

    private fun routeVendorData(vendor: Map<String?, Any?>) {
        val dataType = vendor[DeviceKey.DataType]?.toString()
        Log.i(TAG, "<- vendor dataType=$dataType")
        val events = try {
            normalizer.normalize(
                vendor,
                JCVitalV8EventNormalizer.Context(
                    deviceId = connectedDeviceId,
                    firmwareVersion = deviceInfo["firmwareVersion"] as? String,
                    sessionId = realtimeSessionId,
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
        if (dataType != null) resolveResponse(dataType)
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
    }

    private fun closeGatt() {
        clearConnectTimeout()
        clearInitTimeout()
        clearWriteTimeout()
        commandQueue.clear()
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
        private const val WRITE_TIMEOUT_MS = 3_000L
        private const val DEFAULT_ATT_MTU = 23
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
    }
}
