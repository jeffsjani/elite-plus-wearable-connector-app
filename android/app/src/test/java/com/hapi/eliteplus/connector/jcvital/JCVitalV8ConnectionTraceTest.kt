package com.hapi.eliteplus.connector.jcvital

import android.app.Application
import android.bluetooth.BluetoothAdapter
import android.bluetooth.BluetoothGatt
import android.bluetooth.BluetoothGattCallback
import android.bluetooth.BluetoothGattCharacteristic
import android.bluetooth.BluetoothGattDescriptor
import android.bluetooth.BluetoothGattService
import android.bluetooth.BluetoothManager
import android.bluetooth.BluetoothProfile
import android.bluetooth.le.ScanResult
import android.bluetooth.le.ScanRecord
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Looper
import com.jstyle.blesdkv8.Util.BleSDK
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.json.JSONArray
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.time.Duration

/** Build 32B.1-D: the engineering connection trace observes scan -> connect -> READY without changing it. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 31], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class JCVitalV8ConnectionTraceTest {
    private lateinit var context: Context
    private lateinit var adapter: BluetoothAdapter
    private lateinit var manager: JCVitalV8Manager
    private lateinit var trace: JCVitalV8ConnectionTrace
    private var clock = 1_000L
    private val address = "E7:1B:D8:36:78:CF"
    private val account = "account-A"
    private val opaque = "jcvital_device_11111111-2222-4333-8444-555555555555"

    @Before fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        shadowOf(context as Application).grantPermissions(
            "${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION",
            *JCVitalV8Permissions.requiredPermissions(Build.VERSION.SDK_INT).toTypedArray(),
        )
        shadowOf(context.packageManager).setSystemFeature(PackageManager.FEATURE_BLUETOOTH_LE, true)
        adapter = context.getSystemService(BluetoothManager::class.java).adapter
        shadowOf(adapter).setEnabled(true)
        trace = JCVitalV8ConnectionTrace(enabled = true, clock = { clock++ })
        manager = JCVitalV8Manager(context, trace) { _, _ -> }
    }

    @After fun cleanup() {
        manager.release()
        idle()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()
    private fun gatt(): BluetoothGatt? = JCVitalV8Manager::class.java.getDeclaredField("gatt")
        .apply { isAccessible = true }.get(manager) as BluetoothGatt?
    private fun callback(): BluetoothGattCallback = JCVitalV8Manager::class.java.getDeclaredField("gattCallback")
        .apply { isAccessible = true }.get(manager) as BluetoothGattCallback

    @Suppress("UNCHECKED_CAST")
    private fun events(): List<String> = (trace.snapshot()["events"] as List<Map<String, Any?>>).map { it["event"] as String }

    @Suppress("UNCHECKED_CAST")
    private fun candidates(): List<Map<String, Any?>> = trace.snapshot()["candidates"] as List<Map<String, Any?>>

    private fun scanAdvertisements() {
        manager.startScan(30000) { assertNull(it) }
        idle()
        val v8 = adapter.getRemoteDevice(address)
        shadowOf(v8).setName("JCV8B")
        val unnamed = adapter.getRemoteDevice("11:22:33:44:55:66")
        val callback = shadowOf(adapter.bluetoothLeScanner).scanCallbacks.single()
        callback.onScanResult(0, ScanResult(unnamed, null, -80, 0))
        callback.onScanResult(0, ScanResult(v8, null, -50, 0))
        idle()
    }

    @Test fun disabledTraceIsANoOp() {
        val disabled = JCVitalV8ConnectionTrace(enabled = false)
        disabled.pluginLoaded()
        disabled.scanRequested(1000)
        disabled.advertisement(address, "JCV8B", -50, emptyList(), false, true, true, null)
        val snapshot = disabled.snapshot()
        assertEquals(false, snapshot["enabled"])
        assertEquals(emptyList<Any>(), snapshot["events"])
        assertEquals(emptyList<Any>(), snapshot["candidates"])
        assertFalse(JCVitalV8Manager(context) { _, _ -> }.connectionTrace.enabled)
    }

    @Test fun recordsScanAdvertisementsAndNativeFilterDecisions() {
        trace.pluginLoaded()
        scanAdvertisements()
        val names = events()
        assertEquals(listOf("PLUGIN_INITIALIZED", "SCAN_REQUESTED", "SCAN_STARTED", "ADVERTISEMENT_RECEIVED", "ADVERTISEMENT_RECEIVED", "V8_CANDIDATE_MATCHED"), names)
        val snapshot = trace.snapshot()
        assertEquals(1L, snapshot["scanRequestedCount"])
        assertEquals(true, snapshot["scanActive"])
        assertEquals(true, snapshot["scanCallbackRegistered"])
        assertEquals(2L, snapshot["advertisementsReceived"])
        val byAddress = candidates().associateBy { it["address"] }
        assertEquals(false, byAddress["11:22:33:44:55:66"]!!["acceptedByNativeFilter"])
        assertEquals("NOT_ELITE_PLUS_V8_ADVERTISEMENT", byAddress["11:22:33:44:55:66"]!!["rejectionReason"])
        assertEquals(true, byAddress[address]!!["v8Candidate"])
        assertEquals(true, byAddress[address]!!["acceptedByNativeFilter"])
        assertEquals(-50, byAddress[address]!!["rssi"])
        assertEquals(address, manager.discoveredDevices().single()["id"])
    }

    @Test fun recordsScanResultEmissionWithListenerStateAndScanStop() {
        scanAdvertisements()
        trace.scanResultEmitted(address, jsListenerRegistered = false)
        trace.scanResultEmitted(address, jsListenerRegistered = true)
        val v8 = candidates().single { it["address"] == address }
        assertEquals(2, v8["emittedToJs"])
        assertEquals(1, v8["emittedWithJsListener"])
        manager.stopScan()
        idle()
        assertTrue(events().contains("SCAN_RESULT_EMITTED_TO_JS"))
        assertTrue(events().contains("SCAN_STOPPED"))
        assertEquals(false, trace.snapshot()["scanActive"])
        assertEquals(false, trace.snapshot()["scanCallbackRegistered"])
    }

    @Test fun recordsScanStartFailureWhenAdapterOff() {
        shadowOf(adapter).setEnabled(false)
        var error: JCVitalV8Exception? = null
        manager.startScan(30000) { error = it }
        idle()
        assertEquals(JCVitalV8ErrorCode.BLUETOOTH_DISABLED, error?.code)
        assertEquals(listOf("SCAN_REQUESTED", "SCAN_START_FAILED"), events())
    }

    @Test fun recordsConnectGattServicesNotificationsVersionAndReadyInOrder() {
        var connected = false
        manager.connect(address) { failure -> assertNull(failure); connected = true }
        idle()
        val g = gatt()!!
        val shadow = shadowOf(g)
        shadow.setGattCallback(callback())
        val service = BluetoothGattService(JCVitalV8Manager.SERVICE_UUID, BluetoothGattService.SERVICE_TYPE_PRIMARY)
        service.addCharacteristic(BluetoothGattCharacteristic(JCVitalV8Manager.WRITE_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_WRITE, BluetoothGattCharacteristic.PERMISSION_WRITE))
        val notify = BluetoothGattCharacteristic(JCVitalV8Manager.NOTIFY_CHARACTERISTIC_UUID,
            BluetoothGattCharacteristic.PROPERTY_NOTIFY, BluetoothGattCharacteristic.PERMISSION_READ)
        notify.addDescriptor(BluetoothGattDescriptor(JCVitalV8Manager.CCCD_UUID,
            BluetoothGattDescriptor.PERMISSION_READ or BluetoothGattDescriptor.PERMISSION_WRITE))
        service.addCharacteristic(notify)
        shadow.addDiscoverableService(service)
        shadow.allowCharacteristicNotification(notify)
        callback().onConnectionStateChange(g, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofMillis(600))
        assertTrue(connected)
        manager.configureSourceJournal(account, opaque, true, null, null, null) { _, failure -> assertNull(failure) }
        idle()
        val version = ByteArray(16).also { it[0] = BleSDK.GetDeviceVersion()[0]; it[1] = 1; it[2] = 2; it[3] = 3 }
        val characteristic = g.getService(JCVitalV8Manager.SERVICE_UUID).getCharacteristic(JCVitalV8Manager.NOTIFY_CHARACTERISTIC_UUID)
        characteristic.value = version
        @Suppress("DEPRECATION")
        callback().onCharacteristicChanged(g, characteristic)
        idle()
        assertEquals(JCVitalV8ConnectionState.READY, manager.state)
        val names = events()
        val ordered = listOf("CONNECT_REQUESTED", "GATT_CONNECT_REQUESTED", "GATT_CONNECTED", "SERVICES_DISCOVERED",
            "NOTIFICATIONS_ENABLED", "DEVICE_VERSION_REQUESTED", "READY")
        val indexes = ordered.map { names.indexOf(it) }
        assertTrue("missing stage in $names", indexes.all { it >= 0 })
        assertEquals(indexes.sorted(), indexes)
        for (field in listOf("historicalRequest", "workoutCapture", "rawEcgCapture", "rawPpgCapture", "rawPpgCertification")) {
            assertNull("$field must not be started by connection", JCVitalV8Manager::class.java.getDeclaredField(field)
                .apply { isAccessible = true }.get(manager))
        }
    }

    @Test fun serviceDiscoveryFailureIsNotRecordedAsSuccessfulDiscovery() {
        manager.connect(address) { }
        idle()
        callback().onServicesDiscovered(gatt()!!, BluetoothGatt.GATT_FAILURE)
        idle()
        assertTrue(events().contains("SERVICE_DISCOVERY_FAILED"))
        assertFalse(events().contains("SERVICES_DISCOVERED"))
    }

    @Test fun repeatedScansKeepFilteringAndListenerEvidenceScopedToEachSession() {
        scanAdvertisements()
        trace.scanResultEmitted(address, jsListenerRegistered = true)
        manager.stopScan()
        idle()
        scanAdvertisements()
        val observed = candidates().filter { it["address"] == address }
        assertEquals(2, observed.size)
        assertEquals(1, observed[0]["emittedWithJsListener"])
        assertEquals(0, observed[1]["emittedWithJsListener"])
        assertEquals(2L, observed[1]["scanSession"])
    }

    @Test fun recordsGattFailure() {
        manager.connect(address) { }
        idle()
        val g = gatt()!!
        callback().onConnectionStateChange(g, 133, BluetoothProfile.STATE_DISCONNECTED)
        idle()
        assertTrue(events().contains("CONNECT_REQUESTED"))
        assertTrue(events().any { it == "GATT_FAILED" || it == "GATT_DISCONNECTED" })
        assertTrue(events().contains("CONNECTION_FAILURE"))
    }

    @Test fun boundsEventsAndCandidates() {
        val small = JCVitalV8ConnectionTrace(enabled = true, maxEvents = 3, maxCandidates = 1)
        repeat(5) { small.record("E$it") }
        small.advertisement("AA:AA:AA:AA:AA:01", "X", -1, emptyList(), false, null, true, null)
        small.advertisement("AA:AA:AA:AA:AA:02", "Y", -1, emptyList(), false, null, true, null)
        val snapshot = small.snapshot()
        assertEquals(3, (snapshot["events"] as List<*>).size)
        assertTrue((snapshot["droppedEvents"] as Long) >= 2L)
        assertEquals(1, (snapshot["candidates"] as List<*>).size)
        assertEquals(1L, snapshot["droppedCandidates"])
    }

    @Test fun v8CandidateAnnotationDoesNotDependOnTheReferenceMac() {
        assertTrue(JCVitalV8ConnectionTrace.isV8Candidate("JCV8B", false))
        assertTrue(JCVitalV8ConnectionTrace.isV8Candidate("PRO_V8", false))
        assertTrue(JCVitalV8ConnectionTrace.isV8Candidate(null, true))
        assertFalse(JCVitalV8ConnectionTrace.isV8Candidate("Living Room TV", false))
        assertFalse(JCVitalV8ConnectionTrace.isV8Candidate(null, false))
    }

    @Test fun unrelatedAdvertisementVolumeCannotCrowdOutANameOnlyV8() {
        val small = JCVitalV8ConnectionTrace(enabled = true, maxCandidates = 1)
        small.scanStarted()
        small.advertisement("AA:AA:AA:AA:AA:01", "WHOOP 1234", -50, emptyList(), false, true, false, "NOT_ELITE_PLUS_V8_ADVERTISEMENT")
        small.advertisement(address, "JCV8B 3678CF", -50, emptyList(), false, true, true, null)
        small.scanResultEmitted(address, true)
        val snapshot = small.snapshot()
        val candidate = (snapshot["candidates"] as List<*>).single() as Map<*, *>
        assertEquals(address, candidate["address"])
        assertEquals(true, candidate["v8Candidate"])
        assertEquals(1, candidate["emittedWithJsListener"])
        assertEquals(1L, snapshot["droppedCandidates"])
    }

    @Test fun physicalAdvertisementFixturesAgreeAcrossMatcherRegistryBridgeAndTrace() {
        val json = javaClass.getResourceAsStream("/v8-advertisements.json")!!.bufferedReader().use { it.readText() }
        val fixtures = JSONArray(json)
        for (index in 0 until fixtures.length()) {
            val fixture = fixtures.getJSONObject(index)
            val address = fixture.getString("address")
            val name = if (fixture.isNull("name")) null else fixture.getString("name")
            val services = fixture.getJSONArray("serviceUuids").let { values ->
                (0 until values.length()).map { values.getString(it) }
            }
            val advertises = services.contains(JCVitalV8Manager.SERVICE_UUID.toString())
            val expected = fixture.getBoolean("v8Candidate")
            val registry = JCVitalV8DeviceRegistry()
            val upsert = registry.upsert(address, name, -50, false, true, advertises, 1_000L)
            assertEquals(name, expected, ElitePlusV8Advertisement.isElitePlusV8Advertisement(name, advertises))
            assertEquals(name, expected, upsert.device.toMap()["v8Candidate"])
            assertEquals(name, expected, upsert.shouldEmit)
            assertEquals(name, if (expected) 1 else 0, registry.all().size)
            val localTrace = JCVitalV8ConnectionTrace(enabled = true)
            localTrace.scanStarted()
            localTrace.advertisement(address, name, -50, services, advertises, true, expected, null)
            val candidate = (localTrace.snapshot()["candidates"] as List<*>).single() as Map<*, *>
            assertEquals(name, expected, candidate["v8Candidate"])
        }
    }

    @Test fun advertisementNameOverridesCachedNameAndWorksWithoutServiceUuids() {
        manager.startScan(30000) { assertNull(it) }
        idle()
        val device = adapter.getRemoteDevice(address)
        shadowOf(device).setName("Bose cached name")
        val advertisedName = "JCV8B 3678CF".toByteArray(Charsets.UTF_8)
        val bytes = byteArrayOf((advertisedName.size + 1).toByte(), 0x09) + advertisedName + byteArrayOf(0)
        val record = ScanRecord::class.java.getDeclaredMethod("parseFromBytes", ByteArray::class.java)
            .apply { isAccessible = true }.invoke(null, bytes) as ScanRecord
        shadowOf(adapter.bluetoothLeScanner).scanCallbacks.single()
            .onScanResult(0, ScanResult(device, record, -45, 0))
        idle()
        val discovered = manager.discoveredDevices().single()
        assertEquals("JCV8B 3678CF", discovered["name"])
        assertEquals(true, discovered["v8Candidate"])
        assertEquals(false, discovered["advertisesJcvitalService"])
        assertEquals(true, candidates().single()["v8Candidate"])
        assertEquals(emptyList<String>(), candidates().single()["serviceUuids"])
    }

    @Test fun stateReaderReportsEachPermissionAndAdapterStateSeparately() {
        @Suppress("UNCHECKED_CAST")
        fun permissions(state: Map<String, Any?>) = state["permissions"] as Map<String, Map<String, Any?>>
        val on = JCVitalV8ConnectionDiagnosticState.read(context)
        assertEquals(true, on["adapterSupported"])
        assertEquals(true, on["bluetoothEnabled"])
        assertEquals("ON", on["adapterState"])
        val sdk = Build.VERSION.SDK_INT
        val required = JCVitalV8Permissions.requiredPermissions(sdk)
        val reported = permissions(on).values.associateBy { it["name"] }
        for (name in required) {
            assertEquals("$name should be required", true, reported[name]?.get("requiredOnThisSdk"))
            assertEquals(true, reported[name]?.get("granted"))
        }
        if (sdk >= 31) {
            shadowOf(context as Application).denyPermissions(android.Manifest.permission.BLUETOOTH_CONNECT)
            val denied = permissions(JCVitalV8ConnectionDiagnosticState.read(context))
            assertEquals(true, denied["BLUETOOTH_SCAN"]!!["granted"])
            assertEquals(false, denied["BLUETOOTH_CONNECT"]!!["granted"])
            assertEquals(false, denied["ACCESS_FINE_LOCATION"]!!["requiredOnThisSdk"])
        } else {
            assertEquals(false, permissions(on)["BLUETOOTH_SCAN"]!!["requiredOnThisSdk"])
        }
        shadowOf(adapter).setEnabled(false)
        val off = JCVitalV8ConnectionDiagnosticState.read(context)
        assertEquals(false, off["bluetoothEnabled"])
        assertEquals("OFF", off["adapterState"])
    }
}
