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
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Looper
import org.json.JSONObject
import com.jstyle.blesdkv8.Util.BleSDK
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import org.robolectric.shadows.ShadowStatFs
import java.time.Duration

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28, 31], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class JCVitalV8DiscoveryLifecycleTest {
    private lateinit var context: Context
    private lateinit var adapter: BluetoothAdapter
    private lateinit var manager: JCVitalV8Manager
    private val events = ArrayList<Pair<String, Map<String, Any?>>>()
    private val address = "AA:BB:CC:DD:EE:FF"
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
        manager = JCVitalV8Manager(context) { name, payload -> events.add(name to payload) }
    }

    @After fun cleanup() {
        manager.release()
        idle()
        ShadowStatFs.reset()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
    }

    private fun idle() = shadowOf(Looper.getMainLooper()).idle()
    private fun gatt(): BluetoothGatt? = JCVitalV8Manager::class.java.getDeclaredField("gatt")
        .apply { isAccessible = true }.get(manager) as BluetoothGatt?
    private fun callback(): BluetoothGattCallback = JCVitalV8Manager::class.java.getDeclaredField("gattCallback")
        .apply { isAccessible = true }.get(manager) as BluetoothGattCallback

    private fun identify(): BluetoothGatt {
        var completed = false
        var error: JCVitalV8Exception? = null
        manager.connect(address) { failure -> completed = true; error = failure }
        idle()
        assertNull(error)
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
        assertNull(error)
        assertTrue(completed)
        assertEquals(JCVitalV8ConnectionState.INITIALIZING, manager.state)
        assertNull(shadow.latestWrittenBytes)
        return g
    }

    private fun versionPacket(): ByteArray = ByteArray(16).also {
        it[0] = BleSDK.GetDeviceVersion()[0]
        it[1] = 1; it[2] = 2; it[3] = 3
    }

    private fun notify(g: BluetoothGatt, bytes: ByteArray) {
        val characteristic = g.getService(JCVitalV8Manager.SERVICE_UUID)
            .getCharacteristic(JCVitalV8Manager.NOTIFY_CHARACTERISTIC_UUID)
        characteristic.value = bytes
        @Suppress("DEPRECATION")
        callback().onCharacteristicChanged(g, characteristic)
        idle()
    }

    private fun bind(g: BluetoothGatt) {
        var completed = false
        var error: Throwable? = null
        manager.configureSourceJournal(account, opaque, true, null, null, null) { _, failure ->
            completed = true; error = failure
        }
        idle()
        assertNull(error)
        assertFalse(completed)
        assertSame(g, gatt())
        assertTrue(manager.sourceJournal.captureEnabled())
        assertArrayEquals(BleSDK.GetDeviceVersion(), shadowOf(g).latestWrittenBytes)
        notify(g, versionPacket())
        assertNull(error)
        assertTrue(completed)
        assertEquals(JCVitalV8ConnectionState.READY, manager.state)
    }

    private fun acknowledgeWrite(g: BluetoothGatt) {
        callback().onCharacteristicWrite(g, g.getService(JCVitalV8Manager.SERVICE_UUID)
            .getCharacteristic(JCVitalV8Manager.WRITE_CHARACTERISTIC_UUID), BluetoothGatt.GATT_SUCCESS)
        idle()
    }

    private fun hrPacket(second: Int = 0): ByteArray = ByteArray(24).also {
        it[0] = 0x54
        it[3] = 0x26; it[4] = 0x10; it[5] = 0x14
        it[6] = 0x12; it[7] = 0x00; it[8] = second.toByte()
        for (index in 9..23) it[index] = 72
    }

    private fun metrics(): Triple<Long, Long, Long> = manager.sourceJournal.readableDatabase.rawQuery(
        "SELECT envelopes,bytes,COALESCE((SELECT MAX(sequence) FROM envelopes),0) FROM journal_totals", null,
    ).use { it.moveToFirst(); Triple(it.getLong(0), it.getLong(1), it.getLong(2)) }

    private fun queuedCommands(): Collection<*> = JCVitalV8Manager::class.java.getDeclaredField("commandQueue")
        .apply { isAccessible = true }.get(manager) as Collection<*>

    private fun holdWrites() {
        val commandClass = JCVitalV8Manager::class.java.declaredClasses.single { it.simpleName == "Command" }
        val constructor = commandClass.declaredConstructors.single { it.parameterCount == 5 }.apply { isAccessible = true }
        val command = constructor.newInstance("test-held-write", BleSDK.GetDeviceVersion(), null, null, null)
        JCVitalV8Manager::class.java.getDeclaredField("writeInFlight").apply { isAccessible = true }.set(manager, command)
    }

    @Test fun startupConnectReadyDiagnosticsAndThousandsOfUnsolicitedPacketsNeverAcquireOrGrowJournal() {
        assertEquals(0L, manager.type27IngressSnapshot()["unsolicitedType27Count"])
        assertFalse(manager.sourceJournal.captureEnabled())
        val g = identify()
        bind(g)
        acknowledgeWrite(g)
        val before = metrics()
        val written = shadowOf(g).latestWrittenBytes!!.copyOf()
        repeat(5000) { notify(g, hrPacket()) }
        repeat(5) {
            manager.journalHandshakeSnapshot()
            manager.sourceJournal.capacityAnalysis()
        }
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(20))
        assertEquals(before, metrics())
        assertArrayEquals(written, shadowOf(g).latestWrittenBytes)
        assertTrue(queuedCommands().isEmpty())
        assertEquals(5000L, manager.type27IngressSnapshot()["unsolicitedType27Count"])
        assertEquals("NO_EXPLICIT_HR_REQUEST", manager.type27IngressSnapshot()["reason"])
        assertNotNull(manager.type27IngressSnapshot()["firstUnsolicitedAt"])
        assertNotNull(manager.type27IngressSnapshot()["lastUnsolicitedAt"])
        assertFalse(events.any { it.first == JCVitalV8EventNormalizer.EVENT_OBSERVATION ||
            it.first == JCVitalV8EventNormalizer.EVENT_HISTORICAL_HR_CHUNK })
    }

    @Test fun reconnectNeverRestartsHrAndRejectsOldGattAndNewUnsolicitedPackets() {
        val first = identify()
        bind(first)
        acknowledgeWrite(first)
        manager.syncHistoricalHeartRate(null) { _, _ -> }
        idle()
        manager.disconnect()
        idle()
        manager.configureSourceJournal(null, null, false, null, null, null) { _, error -> assertNull(error) }
        idle()
        val second = identify()
        bind(second)
        acknowledgeWrite(second)
        val before = metrics()
        notify(first, hrPacket())
        notify(second, hrPacket())
        assertEquals(before, metrics())
        assertArrayEquals(BleSDK.GetDeviceVersion(), shadowOf(second).latestWrittenBytes)
        assertTrue(queuedCommands().isEmpty())
    }

    @Test fun explicitHrIsLosslessContinuesAt50AndTrailingPacketsAreNotJournaled() {
        val g = identify()
        bind(g)
        acknowledgeWrite(g)
        val before = metrics()
        var result: Map<String, Any?>? = null
        var failure: JCVitalV8Exception? = null
        manager.syncHistoricalHeartRate(null) { value, error -> result = value; failure = error }
        idle()
        assertArrayEquals(BleSDK.GetDynamicHRWithMode(0, ""), shadowOf(g).latestWrittenBytes)
        acknowledgeWrite(g)
        repeat(49) { notify(g, hrPacket()) }
        assertArrayEquals(BleSDK.GetDynamicHRWithMode(0, ""), shadowOf(g).latestWrittenBytes)
        notify(g, hrPacket())
        assertArrayEquals(BleSDK.GetDynamicHRWithMode(2, ""), shadowOf(g).latestWrittenBytes)
        assertEquals(before.first + 200, metrics().first)
        manager.sourceJournal.readableDatabase.rawQuery(
            "SELECT json,raw FROM envelopes WHERE sequence>? ORDER BY sequence", arrayOf(before.third.toString()),
        ).use { cursor ->
            var rawCount = 0
            var recordCount = 0
            var requestId: String? = null
            while (cursor.moveToNext()) {
                val json = JSONObject(cursor.getString(0))
                assertEquals(account, json.getString("accountId"))
                assertEquals(opaque, json.getString("deviceScopeId"))
                assertEquals(manager.type27IngressSnapshot()["connectionGeneration"], json.getLong("connectionGeneration"))
                if (requestId == null) requestId = json.getString("requestId")
                assertEquals(requestId, json.getString("requestId"))
                if (json.getString("kind") == "BLE_NOTIFICATION") {
                    assertArrayEquals(hrPacket(), cursor.getBlob(1))
                    rawCount++
                }
                if (json.getString("kind") == "SDK_RECORD") {
                    assertEquals("2026.10.14 12:00:00", json.getString("sourceDate"))
                    assertTrue(json.getJSONObject("sdkSnapshot").toString().contains("72 72 72"))
                    recordCount++
                }
            }
            assertEquals(50, rawCount)
            assertEquals(50, recordCount)
        }
        notify(g, byteArrayOf(0x54, -1))
        val ended = metrics()
        repeat(1000) { notify(g, hrPacket()) }
        assertEquals(ended, metrics())
        assertEquals("HR_NOT_ACQUIRING", manager.type27IngressSnapshot()["reason"])
        assertTrue(events.any { it.first == JCVitalV8EventNormalizer.EVENT_HISTORICAL_HR_CHUNK })
        assertTrue(queuedCommands().isEmpty())
        events.filter { it.first == JCVitalV8EventNormalizer.EVENT_HISTORICAL_HR_CHUNK }.forEach { (_, chunk) ->
            manager.ackHistoricalHrChunk(chunk["syncSessionId"] as String, chunk["chunkIndex"] as Int)
        }
        idle()
        assertNull(failure)
        assertNotNull(result)
    }

    @Test fun timeoutPurgesQueuedStartAndContinuationBeforeGattCanWrite() {
        val g = identify()
        bind(g)
        holdWrites()
        manager.syncHistoricalHeartRate(null) { _, _ -> }
        idle()
        repeat(50) { notify(g, hrPacket()) }
        assertEquals(2, queuedCommands().size)
        shadowOf(Looper.getMainLooper()).idleFor(Duration.ofSeconds(16))
        assertTrue(queuedCommands().isEmpty())
        acknowledgeWrite(g)
        assertArrayEquals(BleSDK.GetDeviceVersion(), shadowOf(g).latestWrittenBytes)
        val before = metrics()
        notify(g, hrPacket())
        assertEquals(before, metrics())
    }

    @Test fun previousGenerationCommandCannotReachGattOrJournal() {
        val g = identify()
        bind(g)
        holdWrites()
        manager.syncHistoricalHeartRate(null) { _, _ -> }
        idle()
        assertEquals(1, queuedCommands().size)
        val generation = JCVitalV8Manager::class.java.getDeclaredField("connectionGeneration").apply { isAccessible = true }
        generation.setLong(manager, generation.getLong(manager) + 1)
        acknowledgeWrite(g)
        assertTrue(queuedCommands().isEmpty())
        assertArrayEquals(BleSDK.GetDeviceVersion(), shadowOf(g).latestWrittenBytes)
        val before = metrics()
        notify(g, hrPacket())
        assertEquals(before, metrics())
        assertEquals("CONNECTION_GENERATION_MISMATCH", manager.type27IngressSnapshot()["reason"])
    }

    @Test fun completedRequestPurgesUnwrittenStartBeforeGattAcknowledgement() {
        val g = identify()
        bind(g)
        holdWrites()
        manager.syncHistoricalHeartRate(null) { _, _ -> }
        idle()
        assertEquals(1, queuedCommands().size)
        notify(g, byteArrayOf(0x54, -1))
        assertTrue(queuedCommands().isEmpty())
        acknowledgeWrite(g)
        assertArrayEquals(BleSDK.GetDeviceVersion(), shadowOf(g).latestWrittenBytes)
        val before = metrics()
        notify(g, hrPacket())
        assertEquals(before, metrics())
    }

    @Test fun queuedCommandAndIngressRejectChangedAccountAndDeviceScope() {
        val g = identify()
        bind(g)
        holdWrites()
        manager.syncHistoricalHeartRate(null) { _, _ -> }
        idle()
        manager.sourceJournal.configure("account-B", opaque, true, null, null, null)
        val before = metrics()
        notify(g, hrPacket())
        assertEquals(before, metrics())
        assertEquals("HR_SCOPE_MISMATCH", manager.type27IngressSnapshot()["reason"])
        acknowledgeWrite(g)
        assertTrue(queuedCommands().isEmpty())
        assertArrayEquals(BleSDK.GetDeviceVersion(), shadowOf(g).latestWrittenBytes)
        manager.sourceJournal.configure(account, "different-device", true, null, null, null)
        notify(g, hrPacket())
        assertEquals(before, metrics())
        assertEquals("HR_SCOPE_MISMATCH", manager.type27IngressSnapshot()["reason"])
    }

    @Test fun otherHistoryFamiliesStillReachTheJournalWithoutHrOwnership() {
        val g = identify()
        bind(g)
        acknowledgeWrite(g)
        val factories = listOf(
            { BleSDK.Oxygen_data(0, "") },
            { BleSDK.GetTemperature_historyData(0, "") },
            { BleSDK.GetPPI(0, "") },
            { BleSDK.GetTotalActivityDataWithMode(0, "") },
            { BleSDK.GetDetailActivityDataWithMode(0, "") },
            { BleSDK.GetDetailSleepDataWithMode(0, "") },
            { BleSDK.GetActivityModeDataWithMode(0) },
            { BleSDK.ppgWithMode(1, 0) },
        )
        factories.forEach { factory ->
            val before = metrics()
            val opcode = factory()[0]
            notify(g, byteArrayOf(opcode, -1))
            assertTrue("Opcode ${opcode.toInt() and 255} must remain journaled", metrics().first > before.first)
        }
        assertEquals(0L, manager.type27IngressSnapshot()["unsolicitedType27Count"])
    }

    @Test fun startScanAndResultsWorkBeforeAnyJournalScope() {
        var completed = false
        var error: JCVitalV8Exception? = null
        manager.startScan(30000) { failure -> completed = true; error = failure }
        idle()
        assertTrue(completed)
        assertNull(error)
        assertFalse(manager.sourceJournal.captureEnabled())
        assertEquals(JCVitalV8ConnectionState.SCANNING, manager.state)
        val device = adapter.getRemoteDevice(address)
        shadowOf(device).setName("PRO_V8")
        val scan = shadowOf(adapter.bluetoothLeScanner)
        scan.scanCallbacks.single().onScanResult(0, ScanResult(device, null, -45, 0))
        idle()
        assertEquals(address, manager.discoveredDevices().single()["id"])
        assertTrue(events.any { it.first == JCVitalV8EventNormalizer.EVENT_SCAN_RESULT && it.second["id"] == address })
        assertEquals(0L, manager.sourceJournal.diagnostics(null, null)["totalEnvelopeCount"])
    }

    @Test fun scanStillRequiresPlatformPermissions() {
        shadowOf(context as Application).denyPermissions(*JCVitalV8Permissions.requiredPermissions(Build.VERSION.SDK_INT).toTypedArray())
        var error: JCVitalV8Exception? = null
        manager.startScan(30000) { error = it }
        idle()
        assertEquals(JCVitalV8ErrorCode.PERMISSION_DENIED, error?.code)
        assertEquals(JCVitalV8ConnectionState.DISCONNECTED, manager.state)
    }

    @Test fun transportIdentifiesWithoutJournalAndDoesNotSubscribeOrAcquire() {
        val g = identify()
        assertFalse(manager.sourceJournal.captureEnabled())
        var error: JCVitalV8Exception? = null
        manager.syncHistoricalHrv { _, failure -> error = failure }
        idle()
        assertEquals("SCOPE_NOT_CONFIGURED", error?.message)
        manager.startRealtime(5) { _, failure -> error = failure }
        idle()
        assertEquals("SCOPE_NOT_CONFIGURED", error?.message)
        notify(g, versionPacket())
        assertTrue(events.any { it.first == "sourceJournalOutcome" && it.second["status"] == "DISABLED_NO_SCOPE" })
        assertFalse(events.any { it.first == JCVitalV8EventNormalizer.EVENT_DEVICE_INFO })
        assertNull(shadowOf(g).latestWrittenBytes)
    }

    @Test fun initialBindKeepsGattAndJournalsHandshakeBeforeReadyThenAllowsHistory() {
        val g = identify()
        assertEquals(false, manager.journalHandshakeSnapshot()["transportInitializationStarted"])
        assertEquals("SCOPE_NOT_CONFIGURED", manager.journalHandshakeSnapshot()["getDeviceVersionBlockedReason"])
        bind(g)
        assertEquals("JOURNAL_READY", manager.journalHandshakeSnapshot()["journalState"])
        assertEquals(true, manager.journalHandshakeSnapshot()["transportInitializationStarted"])
        assertNull(manager.journalHandshakeSnapshot()["getDeviceVersionBlockedReason"])
        val rows = manager.sourceJournal.list(account, opaque, 0, 100, true)["envelopes"] as List<*>
        assertTrue(rows.isNotEmpty())
        assertTrue(rows.any { (it as Map<*, *>)["kind"] == "BLE_NOTIFICATION" })
        assertTrue(events.any { it.first == JCVitalV8EventNormalizer.EVENT_DEVICE_INFO })
        var error: JCVitalV8Exception? = null
        manager.syncHistoricalHrv { _, failure -> error = failure }
        idle()
        assertNull(error)
        assertArrayEquals(BleSDK.GetHRVDataWithMode(0, ""), shadowOf(g).latestWrittenBytes)
    }

    @Test fun storagePressureRecoveryBindsBeforeTransportInitializationAndReachesReady() {
        manager.release()
        val retainedJournal = JCVitalV8SourceJournal(context)
        retainedJournal.configure(account, opaque, true, 64L * 1024 * 1024, 100_000, null)
        retainedJournal.appendRaw(byteArrayOf(1, 2, 3), System.currentTimeMillis(), "UTC")
        val priorEnvelope = retainedJournal.list(account, opaque, 0, 10, true)["envelopes"] as List<*>
        retainedJournal.failClosed("STORAGE_PRESSURE")
        retainedJournal.close()
        manager = JCVitalV8Manager(context, JCVitalV8ConnectionTrace(enabled = true)) { name, payload -> events.add(name to payload) }
        ShadowStatFs.registerStats(context.filesDir, 4096, 600_000, 400_000)

        val g = identify()
        var bindCompleted = false
        var bindFailure: Throwable? = null
        manager.configureSourceJournal(account, opaque, true, null, null, null) { _, error ->
            bindCompleted = true
            bindFailure = error
        }
        idle()

        val recovered = manager.journalHandshakeSnapshot()
        assertEquals("JOURNAL_READY", recovered["journalState"])
        assertEquals(false, recovered["failedClosed"])
        assertEquals("STORAGE_PRESSURE", recovered["priorFailureCode"])
        assertEquals(256L * 1024 * 1024, (recovered["journalPressure"] as Map<*, *>)["maxBytes"])
        assertEquals(true, recovered["transportInitializationStarted"])
        assertNull(recovered["getDeviceVersionBlockedReason"])
        assertNotNull(shadowOf(g).latestWrittenBytes)
        val handshakeEvents = manager.connectionTrace.snapshot()["events"] as List<*>
        assertTrue(handshakeEvents.toString(),
            handshakeEvents.any { (it as Map<*, *>)["event"] == "DEVICE_VERSION_REQUESTED" })
        assertEquals("STORAGE_PRESSURE_BUDGET_RECOVERY",
            (recovered["recoveryAudit"] as JSONObject).getString("recoveryType"))
        assertFalse(bindCompleted)
        assertNull(bindFailure)
        assertEquals(priorEnvelope, manager.sourceJournal.list(account, opaque, 0, 10, true)["envelopes"].let {
            (it as List<*>).take(priorEnvelope.size)
        })

        notify(g, versionPacket())
        assertTrue(bindCompleted)
        assertNull(bindFailure)
        assertEquals(JCVitalV8ConnectionState.READY, manager.state)
        assertTrue(events.any { it.first == JCVitalV8EventNormalizer.EVENT_DEVICE_INFO })
    }

    @Test fun historyRemainsBlockedWhileJournalHandshakeIsPending() {
        val g = identify()
        manager.configureSourceJournal(account, opaque, true, null, null, null) { _, _ -> }
        idle()
        var error: JCVitalV8Exception? = null
        manager.syncHistoricalHrv { _, failure -> error = failure }
        idle()
        assertTrue(error?.message?.contains("not READY") == true)
        assertArrayEquals(BleSDK.GetDeviceVersion(), shadowOf(g).latestWrittenBytes)
    }

    @Test fun failedBindClosesGattBlocksAcquisitionButScanStillWorks() {
        val g = identify()
        manager.sourceJournal.failClosed("STORAGE_PRESSURE")
        var failure: Throwable? = null
        manager.configureSourceJournal(account, opaque, true, null, null, null) { _, error -> failure = error }
        idle()
        val diagnostic = manager.journalHandshakeSnapshot()
        assertEquals("JOURNAL_FAILED_CLOSED", diagnostic["journalState"])
        assertEquals("STORAGE_PRESSURE", diagnostic["journalFailureCode"])
        assertEquals("STORAGE_PRESSURE", diagnostic["journalFailureMessage"])
        assertEquals(account, diagnostic["journalAccountId"])
        assertEquals(opaque, diagnostic["journalDeviceScopeId"])
        assertEquals(false, diagnostic["journalOpenSucceeded"])
        assertEquals(false, diagnostic["transportInitializationStarted"])
        assertEquals("JOURNAL_FAILED_CLOSED", diagnostic["getDeviceVersionBlockedReason"])
        assertNull(shadowOf(g).latestWrittenBytes)
        assertNotNull(failure)
        assertEquals("JOURNAL_RECOVERY_DATABASE_MISSING", (failure as JCVitalV8SourceJournal.Failure).reason)
        assertTrue(shadowOf(g).isClosed)
        assertNull(gatt())
        var commandError: JCVitalV8Exception? = null
        manager.syncHistoricalHrv { _, error -> commandError = error }
        idle()
        assertEquals("SCOPE_NOT_CONFIGURED", commandError?.message)
        var scanError: JCVitalV8Exception? = null
        manager.startScan(30000) { scanError = it }
        idle()
        assertNull(scanError)
        assertEquals(JCVitalV8ConnectionState.SCANNING, manager.state)
        assertTrue(manager.sourceJournal.hasFailedClosed())
    }

    @Test fun retainedJournalReconnectReusesScopeAndPreservesAllEnvelopes() {
        val first = identify()
        bind(first)
        val before = manager.sourceJournal.list(account, opaque, 0, 100, true)["envelopes"] as List<*>
        manager.disconnect()
        idle()
        manager.configureSourceJournal(null, null, false, null, null, null) { _, error -> assertNull(error) }
        idle()
        val second = identify()
        assertNull(shadowOf(second).latestWrittenBytes)
        bind(second)
        assertEquals(JCVitalV8ConnectionState.READY, manager.state)
        assertEquals(opaque, manager.journalHandshakeSnapshot()["journalDeviceScopeId"])
        val after = manager.sourceJournal.list(account, opaque, 0, 100, true)["envelopes"] as List<*>
        assertEquals(before, after.take(before.size))
        assertTrue(after.size > before.size)
    }

    @Test fun disablingScopeDisconnectsEvenUnboundIdentificationTransport() {
        val g = identify()
        manager.configureSourceJournal(null, null, false, null, null, null) { _, error -> assertNull(error) }
        idle()
        assertTrue(shadowOf(g).isClosed)
        assertFalse(manager.sourceJournal.captureEnabled())
        assertEquals(JCVitalV8ConnectionState.DISCONNECTED, manager.state)
    }

    @Test fun disablingScopeDuringHandshakeCompletesBindWithFailureExactlyOnce() {
        val g = identify()
        var completions = 0
        var failure: Throwable? = null
        manager.configureSourceJournal(account, opaque, true, null, null, null) { _, error ->
            completions++; failure = error
        }
        idle()
        assertEquals(0, completions)
        manager.configureSourceJournal(null, null, false, null, null, null) { _, error -> assertNull(error) }
        idle()
        assertEquals(1, completions)
        assertNotNull(failure)
        assertTrue(shadowOf(g).isClosed)
        notify(g, versionPacket())
        assertEquals(1, completions)
        assertEquals(JCVitalV8ConnectionState.DISCONNECTED, manager.state)
    }

    @Test fun invalidReconfigurationDoesNotStrandPendingJournalBind() {
        val g = identify()
        var bindCompletions = 0
        var bindFailure: Throwable? = null
        manager.configureSourceJournal(account, opaque, true, null, null, null) { _, error ->
            bindCompletions++; bindFailure = error
        }
        idle()
        var reconfigurationCompletions = 0
        manager.configureSourceJournal(account, opaque, true, 1L, null, null) { _, error ->
            reconfigurationCompletions++
            assertNotNull(error)
        }
        idle()
        assertEquals(1, bindCompletions)
        assertNotNull(bindFailure)
        assertEquals(1, reconfigurationCompletions)
        assertTrue(shadowOf(g).isClosed)
        assertFalse(manager.sourceJournal.captureEnabled())
    }

    @Test fun accountSwitchTerminatesAcquisitionAndStaleGattCannotNormalizeIntoNewScope() {
        val old = identify()
        bind(old)
        manager.configureSourceJournal("account-B", opaque, true, null, null, null) { _, error -> assertNull(error) }
        idle()
        assertTrue(shadowOf(old).isClosed)
        assertEquals(JCVitalV8ConnectionState.DISCONNECTED, manager.state)
        events.clear()
        notify(old, versionPacket())
        callback().onConnectionStateChange(old, BluetoothGatt.GATT_SUCCESS, BluetoothProfile.STATE_CONNECTED)
        callback().onServicesDiscovered(old, BluetoothGatt.GATT_SUCCESS)
        idle()
        assertEquals(JCVitalV8ConnectionState.DISCONNECTED, manager.state)
        assertFalse(events.any { it.first == JCVitalV8EventNormalizer.EVENT_DEVICE_INFO })
        assertTrue(events.any { it.first == "sourceJournalOutcome" && it.second["status"] == "PRIOR_ACQUISITION_CONTEXT_REJECTED" })
        assertEquals(0L, manager.sourceJournal.diagnostics("account-B", opaque)["totalEnvelopeCount"])
    }

    @Test fun rawMacCannotBindOwnershipAndDiscoveryRemainsAvailableAfterRejection() {
        identify()
        var error: Throwable? = null
        manager.configureSourceJournal(account, address, true, null, null, null) { _, failure -> error = failure }
        idle()
        assertTrue(error?.message?.contains("INVALID_OPAQUE_DEVICE_SCOPE") == true)
        assertFalse(manager.sourceJournal.captureEnabled())
        var scanError: JCVitalV8Exception? = null
        manager.startScan(30000) { scanError = it }
        idle()
        assertNull(scanError)
    }
}
