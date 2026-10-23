package com.hapi.eliteplus.connector.jcvital

import android.content.Context
import android.os.Looper
import android.util.Base64
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import org.json.JSONArray
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertThrows
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.RuntimeEnvironment
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.SQLiteMode
import java.io.ByteArrayOutputStream
import java.io.DataOutputStream
import java.io.File

/** VC29 one-shot physical Raw PPG certification: journal-before-command, lossless spool, one-shot guard. */
@RunWith(RobolectricTestRunner::class)
@Config(sdk = [28], manifest = Config.NONE)
@SQLiteMode(SQLiteMode.Mode.NATIVE)
class RawPpgPhysicalCertificationTest {
    private lateinit var context: Context
    private lateinit var journal: JCVitalV8SourceJournal
    private val account = "account-vc29"
    private val device = "opaque-device-vc29"
    private val writeUuid = "0000fff6-0000-1000-8000-00805f9b34fb"
    private val notifyUuid = "0000fff7-0000-1000-8000-00805f9b34fb"

    private class Write(val name: String, val bytes: ByteArray, val latestKindAtWrite: String?, val latestRawAtWrite: ByteArray?,
        val onAck: (Boolean) -> Unit)

    private inner class FakeTransport(var alive: Boolean = true, val failRoles: Set<Int> = emptySet(), val autoAck: Boolean = true) :
        RawPpgCertificationCapture.Transport {
        val writes = mutableListOf<Write>()
        override fun write(name: String, bytes: ByteArray, onAck: (Boolean) -> Unit) {
            val latest = latestEnvelope()
            val write = Write(name, bytes.copyOf(), latest?.first, latest?.second, onAck)
            writes += write
            if (autoAck) onAck(bytes[1].toInt() !in failRoles)
        }
        override fun linkAlive() = alive
    }

    private class ManualScheduler : RawPpgCertificationCapture.Scheduler {
        val tasks = mutableListOf<Pair<Long, () -> Unit>>()
        override fun schedule(delayMs: Long, task: () -> Unit): Any = (delayMs to task).also { tasks += it }
        override fun cancel(token: Any) { tasks.remove(token) }
        fun runNext() { tasks.removeAt(0).second() }
    }

    @Before
    fun setup() {
        context = RuntimeEnvironment.getApplication()
        context.getSharedPreferences("jcvital-source-journal-outcomes-v1", Context.MODE_PRIVATE).edit().clear().commit()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        File(context.filesDir, "jcvital-source-spool").deleteRecursively()
        journal = JCVitalV8SourceJournal(context)
        journal.configure(account, device, true, null, null, null)
    }

    @After
    fun cleanup() {
        journal.close()
        context.deleteDatabase("jcvital-source-envelope-v1.db")
        File(context.filesDir, "jcvital-source-spool").deleteRecursively()
        BleSDK.ppgWithMode(5, 0)
    }

    private fun latestEnvelope(): Pair<String, ByteArray?>? {
        val all = allEnvelopes()
        val last = all.lastOrNull() ?: return null
        return last.getString("kind") to (last.optString("rawBytesBase64").takeIf { it.isNotEmpty() && it != "null" }
            ?.let { Base64.decode(it, Base64.DEFAULT) })
    }

    private fun allEnvelopes(): List<JSONObject> {
        val out = mutableListOf<JSONObject>()
        var after = 0L
        while (true) {
            val page = journal.list(account, device, after, 100, includePayload = true)
            @Suppress("UNCHECKED_CAST")
            val items = page["envelopes"] as List<Map<String, Any?>>
            items.forEach { out += JSONObject(it) }
            if (items.isEmpty() || page["hasMore"] != true) return out
            after = items.last()["sequence"] as Long
        }
    }

    private val events = mutableListOf<Map<String, Any?>>()
    private var terminal: Map<String, Any?>? = null

    private fun newCapture(transport: FakeTransport, scheduler: ManualScheduler,
        parser: ((ByteArray, DataListener2301) -> Unit)? = null): RawPpgCertificationCapture {
        terminal = null
        return RawPpgCertificationCapture(
            journal = journal, filesDir = context.filesDir, transport = transport, scheduler = scheduler,
            device = RawPpgCertificationCapture.DeviceContext("V8-TEST", "FW-1.0", notifyUuid, writeUuid, 247),
            onUpdate = { events += it }, onTerminal = { terminal = it },
            clock = { System.currentTimeMillis() }, monotonic = { 42L },
            parser = parser ?: { bytes, listener -> BleSDK.DataParsingWithData(bytes, listener) },
        )
    }

    private fun statusPacket(mode: Int) = ByteArray(16).also { it[0] = 0x78; it[1] = mode.toByte(); it[15] = (0x78 + mode).toByte() }
    private fun dataPacket(seed: Int) = ByteArray(203) { ((it * 7 + seed) and 0xFF).toByte() }.also { it[0] = 0x3A; it[1] = seed.toByte() }

    /** 2 status + 18 data, including an all-zero payload and an exact repeat (historical shape: 3774 bytes). */
    private fun physicalPackets(): List<ByteArray> {
        val zeros = ByteArray(203).also { it[0] = 0x3A }
        val data = (0 until 16).map(::dataPacket)
        return listOf(statusPacket(1)) + data.take(8) + listOf(zeros, data[7]) + data.drop(8) + listOf(statusPacket(3))
    }

    private fun runHappyPath(packets: List<ByteArray> = physicalPackets()): Triple<RawPpgCertificationCapture, FakeTransport, ManualScheduler> {
        val transport = FakeTransport()
        val scheduler = ManualScheduler()
        val capture = newCapture(transport, scheduler)
        capture.start()
        packets.forEach(capture::onNotification)
        scheduler.runNext() // 20 s capture window -> stop/quit
        scheduler.runNext() // drain window -> finalize
        return Triple(capture, transport, scheduler)
    }

    private fun expectedSpool(packets: List<ByteArray>): ByteArray = ByteArrayOutputStream().also { out ->
        DataOutputStream(out).use { data ->
            data.write("JCV8PPG1".toByteArray())
            packets.forEach { data.writeInt(it.size); data.write(it) }
        }
    }.toByteArray()

    private fun savedCertification(): JSONObject = JSONObject(journal.readRawPpgPhysicalCertification(account, device)["json"] as String)

    @Test
    fun exactCommandBytesAndShaComeFromVendorSdk() {
        val start = BleSDK.ppgWithMode(1, 0)
        val stop = BleSDK.ppgWithMode(3, 0)
        val quit = BleSDK.ppgWithMode(5, 0)
        assertEquals("78 01 00 00 00 00 00 00 00 00 00 00 00 00 00 79", RawPpgCertificationCapture.hex(start))
        assertEquals("78 03 00 00 00 00 00 00 00 00 00 00 00 00 00 7B", RawPpgCertificationCapture.hex(stop))
        assertEquals("78 05 00 00 00 00 00 00 00 00 00 00 00 00 00 7D", RawPpgCertificationCapture.hex(quit))
        assertArrayEquals(RawPpgCertificationCapture.expectedFrame(1), start)
        assertEquals("2e482bde5cfd7838a98a3461ba04129592235acdeb5d363385455e34874c65c3", RawPpgCertificationCapture.sha(start))
        assertEquals("624a371897b2dca244bb8dc0673b65b585cfdbd0cab91bd80cc69e99607392e0", RawPpgCertificationCapture.sha(stop))
        assertEquals("b29369d5fa94dcfec94de8eecd323d356233d65e45fa126461ae0f639fb4b341", RawPpgCertificationCapture.sha(quit))
    }

    @Test
    fun journalInitializedAndCommandEnvelopePersistedBeforeBleWrite() {
        val (_, transport, _) = runHappyPath()
        assertEquals(listOf("ppgWithMode(1,0)", "ppgWithMode(3,0)", "ppgWithMode(5,0)"), transport.writes.map { it.name })
        transport.writes.forEach { write ->
            assertEquals("PPG_COMMAND_REQUEST", write.latestKindAtWrite)
            assertArrayEquals(write.bytes, write.latestRawAtWrite)
        }
        val kinds = allEnvelopes().map { it.getString("kind") }
        val open = kinds.indexOf("PPG_CERTIFICATION_SESSION_OPEN")
        val file = kinds.indexOf("RAW_SESSION_FILE")
        val request = kinds.indexOf("PPG_COMMAND_REQUEST")
        assertTrue(open in 0 until file && file < request)
        // Attempt claim + ACQUIRING snapshot were committed before the first request (claim exists, open precedes).
        val request0 = allEnvelopes()[request]
        val json = JSONObject(request0.getString("envelopeJson"))
        assertEquals("BleSDK.ppgWithMode(int,int)", json.getString("callbackIdentifier"))
        assertEquals("BleSDK.ppgWithMode(int,int)", json.getString("sdkMethod"))
        assertEquals("0x78", json.getString("opcode"))
        assertEquals(1, json.getJSONObject("sdkArguments").getInt("mode"))
        assertEquals(writeUuid, json.getString("characteristicUuid"))
        assertEquals(writeUuid, json.getString("commandCharacteristicUuid"))
        assertEquals("2e482bde5cfd7838a98a3461ba04129592235acdeb5d363385455e34874c65c3", json.getString("commandSha256"))
        assertEquals(json.getString("sha256"), json.getString("commandSha256"))
        assertEquals("RAW_PPG", json.getString("acquisitionMode"))
    }

    @Test
    fun attemptStatePersistedBeforeCommandRequest() {
        val transport = FakeTransport(autoAck = false)
        val capture = newCapture(transport, ManualScheduler())
        capture.start()
        val saved = savedCertification()
        assertEquals("ACQUIRING", saved.getString("state"))
        assertEquals(capture.sessionId, saved.getString("sessionId"))
        assertNotNull(journal.rawPpgCertificationClaim(account, device))
        assertEquals(1, transport.writes.size)
    }

    @Test
    fun writeAckAncestryIsJournaled() {
        runHappyPath()
        val envelopes = allEnvelopes()
        val requests = envelopes.filter { it.getString("kind") == "PPG_COMMAND_REQUEST" }
        val acks = envelopes.filter { it.getString("kind") == "PPG_COMMAND_WRITE_ACK" }
        assertEquals(3, requests.size)
        assertEquals(3, acks.size)
        requests.zip(acks).forEach { (request, ack) ->
            val ackJson = JSONObject(ack.getString("envelopeJson"))
            assertEquals(request.getString("envelopeId"), ackJson.getString("parentEnvelopeId"))
            assertEquals("GATT_SUCCESS", ackJson.getString("writeStatus"))
            assertEquals("BluetoothGattCallback.onCharacteristicWrite", ackJson.getString("callbackIdentifier"))
            assertTrue(ack.getLong("sequence") > request.getLong("sequence"))
        }
        val cert = savedCertification()
        val commands = cert.getJSONArray("commands")
        assertEquals("GATT_SUCCESS", commands.getJSONObject(0).getJSONObject("writeAck").getString("status"))
        assertEquals("78 01 00 00 00 00 00 00 00 00 00 00 00 00 00 79", commands.getJSONObject(0).getString("bytesHex"))
    }

    @Test
    fun notificationPersistedBeforeParserAndCallbacksPersistedBeforeSpool() {
        val transport = FakeTransport()
        val scheduler = ManualScheduler()
        val observed = mutableListOf<Boolean>()
        lateinit var capture: RawPpgCertificationCapture
        capture = newCapture(transport, scheduler) { bytes, listener ->
            val latest = latestEnvelope()!!
            val spoolLength = File(context.filesDir, "jcvital-source-spool").listFiles()!!.single().length()
            val previousBytes = physicalPackets().take(observed.size).sumOf { 4 + it.size }
            observed += latest.first == "BLE_NOTIFICATION" && latest.second!!.contentEquals(bytes) && spoolLength == 8L + previousBytes
            BleSDK.DataParsingWithData(bytes, listener)
        }
        capture.start()
        physicalPackets().forEach(capture::onNotification)
        assertEquals(20, observed.size)
        assertTrue(observed.all { it })
        val saved = savedCertification()
        assertEquals(20, saved.getJSONArray("packets").length())
        assertArrayEquals(expectedSpool(physicalPackets()), File(saved.getJSONObject("spool").getString("path")).readBytes())
    }

    @Test
    fun parserExceptionPreservesRawAndCallbacksAndFailsClosedWithoutRetry() {
        val transport = FakeTransport()
        val scheduler = ManualScheduler()
        val capture = newCapture(transport, scheduler) { bytes, listener ->
            BleSDK.DataParsingWithData(bytes, listener)
            throw IllegalStateException("injected parser failure after callback")
        }
        capture.start()
        val bytes = dataPacket(1)
        capture.onNotification(bytes)
        val saved = savedCertification()
        assertEquals("NOT_CERTIFIED", capture.state)
        assertEquals("PARTIAL_PARSE_ERROR", saved.getJSONArray("packets").getJSONObject(0).getString("parserStatus"))
        assertTrue(saved.getJSONArray("packets").getJSONObject(0).getJSONArray("callbackIds").length() > 0)
        assertArrayEquals(expectedSpool(listOf(bytes)), File(saved.getJSONObject("spool").getString("path")).readBytes())
        assertEquals(listOf("ppgWithMode(1,0)", "ppgWithMode(5,0)"), transport.writes.map { it.name })
        assertTrue(scheduler.tasks.isEmpty())
        assertThrows(JCVitalV8SourceJournal.Failure::class.java) { newCapture(FakeTransport(), ManualScheduler()).start() }
    }

    @Test
    fun interruptedCaptureKeepsCheckpointMetadataAndFullOfflineSpoolAfterRestart() {
        val transport = FakeTransport()
        val capture = newCapture(transport, ManualScheduler())
        capture.start()
        val partial = physicalPackets().take(4)
        partial.forEach(capture::onNotification)
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        val saved = savedCertification()
        assertEquals("ACQUIRING", saved.getString("state"))
        assertEquals(4, saved.getJSONArray("packets").length())
        assertEquals("GATT_SUCCESS", saved.getJSONArray("commands").getJSONObject(0).getJSONObject("writeAck").getString("status"))
        assertEquals("VERIFIED", RawPpgCertificationCapture.inspect(journal, account, device)["onDiskVerification"])
        val spool = RawPpgCertificationCapture.exportSpool(journal, account, device)
        assertArrayEquals(expectedSpool(partial), Base64.decode(spool["base64"] as String, Base64.DEFAULT))
        assertFalse(RawPpgCertificationCapture.attemptStatus(journal, account, device)["captureAllowed"] as Boolean)
        journal.configure(account, device, true, null, null, null)
        val second = FakeTransport()
        assertThrows(JCVitalV8SourceJournal.Failure::class.java) { newCapture(second, ManualScheduler()).start() }
        assertTrue(second.writes.isEmpty())
    }

    @Test
    fun callbackAndParserOutcomeAncestry() {
        runHappyPath()
        val cert = savedCertification()
        val envelopes = allEnvelopes().associateBy { it.getString("envelopeId") }
        val packets = cert.getJSONArray("packets")
        for (i in 0 until packets.length()) {
            val p = packets.getJSONObject(i)
            val notification = envelopes.getValue(p.getString("notificationEnvelopeId"))
            assertEquals("BLE_NOTIFICATION", notification.getString("kind"))
            val outcome = envelopes.getValue(p.getString("parserOutcomeId"))
            assertEquals(p.getString("notificationEnvelopeId"), JSONObject(outcome.getString("envelopeJson")).getString("notificationEnvelopeId"))
            assertTrue(outcome.getLong("sequence") > notification.getLong("sequence"))
            val callbacks = p.getJSONArray("callbackIds")
            if (p.getString("opcode") == "0x3A") {
                assertTrue(callbacks.length() >= 1)
                assertEquals("119", p.getJSONArray("vendorDataTypes").getString(0))
            }
            for (c in 0 until callbacks.length()) {
                val callback = envelopes.getValue(callbacks.getString(c))
                assertEquals(p.getString("notificationEnvelopeId"), JSONObject(callback.getString("envelopeJson")).getString("notificationEnvelopeId"))
                assertTrue(callback.getLong("sequence") in (notification.getLong("sequence") + 1) until outcome.getLong("sequence"))
            }
        }
        assertTrue(cert.getJSONObject("checks").getJSONObject("journalAncestryAndOrder").getBoolean("passed"))
    }

    @Test
    fun certifiedSpoolCompleteByteForByteWithStableOrderZerosAndRepeats() {
        val packets = physicalPackets()
        runHappyPath(packets)
        val cert = savedCertification()
        assertEquals("CERTIFIED", cert.getString("state"))
        assertEquals("CERTIFIED_E2E_LOSSLESS_SOURCE", cert.getString("sourceStatus"))
        assertEquals("RESEARCH_NATIVE_ONLY", cert.getString("semanticClassification"))
        assertEquals("NONE_UNTIL_SEMANTICS_CONFIRMED", cert.getString("canonicalAuthority"))
        assertEquals("LOCAL_SOURCE_EVIDENCE_ONLY", cert.getString("deliveryDisposition"))
        assertEquals(0, cert.getJSONArray("failedChecks").length())
        val spoolFile = File(cert.getJSONObject("spool").getString("path"))
        val expected = expectedSpool(packets)
        assertArrayEquals(expected, spoolFile.readBytes())
        assertEquals(3774, expected.size)
        assertEquals(3774, cert.getJSONObject("spool").getInt("fileByteLength"))
        assertEquals(RawPpgCertificationCapture.sha(expected), cert.getJSONObject("spool").getString("fileSha256"))
        val saved = cert.getJSONArray("packets")
        assertEquals(20, saved.length())
        var offset = 8L
        packets.forEachIndexed { i, bytes ->
            val p = saved.getJSONObject(i)
            assertEquals(i, p.getInt("index"))
            assertArrayEquals(bytes, Base64.decode(p.getString("base64"), Base64.DEFAULT))
            assertEquals(RawPpgCertificationCapture.sha(bytes), p.getString("sha256"))
            assertEquals(offset, p.getLong("spoolLengthPrefixOffset"))
            assertEquals(offset + 4, p.getLong("spoolPayloadOffset"))
            offset += 4 + bytes.size
        }
        assertEquals(202, saved.getJSONObject(9).getInt("zeroByteCount"))
        assertEquals(8, saved.getJSONObject(10).getInt("repeatOfPacketIndex"))
        val shape = cert.getJSONObject("packetShape")
        assertTrue(shape.getBoolean("matchesHistoricalPattern"))
        assertEquals(18, shape.getJSONObject("actual").getInt("dataPacketCount"))
        assertEquals(2, shape.getJSONObject("actual").getInt("statusPacketCount"))
    }

    @Test
    fun differingPacketShapeIsReportedNotRejected() {
        val packets = listOf(statusPacket(1), dataPacket(1), ByteArray(153) { 9 }.also { it[0] = 0x3A }, statusPacket(3))
        runHappyPath(packets)
        val cert = savedCertification()
        assertEquals("CERTIFIED", cert.getString("state"))
        val shape = cert.getJSONObject("packetShape")
        assertFalse(shape.getBoolean("matchesHistoricalPattern"))
        assertTrue(shape.getJSONArray("differences").length() > 0)
        assertEquals("NEW_PHYSICAL_CAPTURE_IS_AUTHORITATIVE", shape.getString("authority"))
    }

    @Test
    fun oneShotGuardSurvivesRestartAndBlocksBeforeAnyCommand() {
        runHappyPath()
        val second = FakeTransport()
        val error = assertThrows(JCVitalV8SourceJournal.Failure::class.java) { newCapture(second, ManualScheduler()).start() }
        assertEquals("PPG_CERTIFICATION_ALREADY_ATTEMPTED", error.reason)
        assertTrue(second.writes.isEmpty())
        // Restart: brand-new journal instance, offline read with the persisted owner (no live scope required).
        journal.close()
        journal = JCVitalV8SourceJournal(context)
        val offline = journal.readRawPpgPhysicalCertification(account, null)
        assertEquals("CERTIFIED", JSONObject(offline["json"] as String).getString("state"))
        val status = RawPpgCertificationCapture.attemptStatus(journal, account, device)
        assertEquals(true, status["attempted"])
        assertEquals(false, status["captureAllowed"])
        assertEquals("PPG_CERTIFICATION_ALREADY_ATTEMPTED", status["blockedReason"])
        journal.configure(account, device, true, null, null, null)
        val afterRestart = FakeTransport()
        val again = assertThrows(JCVitalV8SourceJournal.Failure::class.java) { newCapture(afterRestart, ManualScheduler()).start() }
        assertEquals("PPG_CERTIFICATION_ALREADY_ATTEMPTED", again.reason)
        assertTrue(afterRestart.writes.isEmpty())
    }

    @Test
    fun finalSnapshotIsImmutable() {
        val (capture, _, _) = runHappyPath()
        val final = savedCertification()
        val tampered = JSONObject(final.toString()).put("state", "NOT_CERTIFIED")
        assertThrows(Exception::class.java) { journal.finalizeRawPpgCertificationAttempt(tampered.toString()) }
        assertThrows(Exception::class.java) {
            journal.checkpointRawPpgCertificationAttempt(JSONObject(final.toString()).put("state", "ACQUIRING").toString())
        }
        assertEquals(final.toString(), savedCertification().toString())
        assertEquals("CERTIFIED", capture.state)
    }

    @Test
    fun startWriteFailureFailsClosedWithSingleQuitAndNoRetry() {
        val transport = FakeTransport(failRoles = setOf(1))
        val capture = newCapture(transport, ManualScheduler())
        capture.start()
        assertEquals("NOT_CERTIFIED", capture.state)
        assertEquals(listOf("ppgWithMode(1,0)", "ppgWithMode(5,0)"), transport.writes.map { it.name })
        val cert = savedCertification()
        assertEquals("NOT_CERTIFIED", cert.getString("state"))
        assertEquals("NOT_CERTIFIED_EVIDENCE_PRESERVED", cert.getString("sourceStatus"))
        assertTrue(cert.getJSONArray("failures").toString().contains("PPG_START_COMMAND_WRITE_FAILED"))
        val kinds = allEnvelopes().map { it.getString("kind") }
        assertTrue("PPG_COMMAND_WRITE_FAILED" in kinds)
        assertThrows(JCVitalV8SourceJournal.Failure::class.java) { newCapture(FakeTransport(), ManualScheduler()).start() }
    }

    @Test
    fun linkLossMidCapturePreservesPartialEvidenceAndStops() {
        val transport = FakeTransport()
        val scheduler = ManualScheduler()
        val capture = newCapture(transport, scheduler)
        capture.start()
        val partial = physicalPackets().take(5)
        partial.forEach(capture::onNotification)
        transport.alive = false
        capture.abort("V8 disconnected")
        assertEquals("NOT_CERTIFIED", capture.state)
        assertEquals(1, transport.writes.size)
        assertTrue(scheduler.tasks.isEmpty())
        val cert = savedCertification()
        assertEquals(5, cert.getJSONArray("packets").length())
        assertArrayEquals(expectedSpool(partial), File(cert.getJSONObject("spool").getString("path")).readBytes())
        assertTrue(cert.getJSONArray("failedChecks").toString().contains("commandQUITWriteAck"))
        capture.onNotification(dataPacket(99))
        assertEquals(5, savedCertification().getJSONArray("packets").length())
    }

    @Test
    fun ackTimeoutFailsClosed() {
        val transport = FakeTransport(autoAck = false, alive = false)
        val scheduler = ManualScheduler()
        val capture = newCapture(transport, scheduler)
        capture.start()
        scheduler.runNext() // ACK timeout
        assertEquals("NOT_CERTIFIED", capture.state)
        transport.writes.single().onAck(true) // late ACK is ignored
        assertEquals("NOT_CERTIFIED", savedCertification().getString("state"))
        assertEquals(1, transport.writes.size)
    }

    @Test
    fun exportAndInspectAreOffline() {
        val (_, transport, scheduler) = runHappyPath()
        val writesBefore = transport.writes.size
        journal.close()
        journal = JCVitalV8SourceJournal(context) // restart, no live scope configured
        val inspection = RawPpgCertificationCapture.inspect(journal, account, null)
        assertEquals("VERIFIED", inspection["onDiskVerification"])
        assertEquals("CERTIFIED", inspection["state"])
        assertEquals(0, inspection["bleCommands"])
        assertEquals(0, inspection["networkRequests"])
        assertEquals(0, inspection["acquisitions"])
        val export = RawPpgCertificationCapture.exportSpool(journal, account, null)
        assertArrayEquals(expectedSpool(physicalPackets()), Base64.decode(export["base64"] as String, Base64.DEFAULT))
        assertEquals(3774, export["byteLength"])
        assertEquals(writesBefore, transport.writes.size)
        assertTrue(scheduler.tasks.isEmpty())
        assertNull(journal.currentScope())
    }

    @Test
    fun inspectDetectsTamperedSpool() {
        runHappyPath()
        val path = savedCertification().getJSONObject("spool").getString("path")
        val bytes = File(path).readBytes()
        bytes[bytes.size - 1] = (bytes[bytes.size - 1] + 1).toByte()
        File(path).writeBytes(bytes)
        assertEquals("MISMATCH", RawPpgCertificationCapture.inspect(journal, account, device)["onDiskVerification"])
        val error = assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            RawPpgCertificationCapture.exportSpool(journal, account, device)
        }
        assertEquals("PPG_SPOOL_SHA_MISMATCH", error.reason)
    }

    @Test
    fun statusPacketsAloneCannotCertifyAWaveform() {
        runHappyPath(listOf(statusPacket(1), statusPacket(3)))
        assertEquals("NOT_CERTIFIED", savedCertification().getString("state"))
        assertTrue(savedCertification().getJSONArray("failedChecks").toString().contains("physicalPpgDataReceived"))
    }

    @Test
    fun latePacketDuringDrainIsPreservedAndRequiresNewQuietWindow() {
        val transport = FakeTransport()
        val scheduler = ManualScheduler()
        val capture = newCapture(transport, scheduler)
        capture.start()
        capture.onNotification(dataPacket(1))
        scheduler.runNext()
        val oldDrain = scheduler.tasks.first { it.first == RawPpgCertificationCapture.DRAIN_MS }
        capture.onNotification(dataPacket(2))
        assertFalse(scheduler.tasks.contains(oldDrain))
        scheduler.tasks.first { it.first == RawPpgCertificationCapture.DRAIN_MS }.second()
        assertEquals("CERTIFIED", savedCertification().getString("state"))
        assertEquals(2, savedCertification().getJSONArray("packets").length())
        assertTrue(savedCertification().getJSONObject("timeline").getBoolean("drainCompleted"))
    }

    @Test
    fun continuingNotificationsAfterQuitFailClosedAtDrainDeadline() {
        val transport = FakeTransport()
        val scheduler = ManualScheduler()
        val capture = newCapture(transport, scheduler)
        capture.start()
        capture.onNotification(dataPacket(1))
        scheduler.runNext()
        capture.onNotification(dataPacket(2))
        scheduler.tasks.first { it.first == RawPpgCertificationCapture.DRAIN_TIMEOUT_MS }.second()
        assertEquals("NOT_CERTIFIED", savedCertification().getString("state"))
        assertTrue(savedCertification().getJSONArray("failures").toString().contains("PPG_STOP_NOT_QUIET_BEFORE_DEADLINE"))
        assertEquals(3, transport.writes.size)
    }

    @Test
    fun noCanonicalizationNoGlucoseUnknownUnitAndSampleRate() {
        runHappyPath()
        val cert = savedCertification()
        RawPpgCertificationCapture.assertNoGlucoseKeys(cert)
        assertTrue(cert.isNull("sampleRateHz"))
        assertTrue(cert.isNull("samplingIntervalMs"))
        assertEquals("UNKNOWN_VENDOR_UNIT", cert.getString("unit"))
        val flags = cert.getJSONObject("semanticIsolation").getJSONArray("flags")
        assertEquals(listOf("RAW_PPG_NOT_GLUCOSE", "NO_GLUCOSE_CANONICAL_MAPPING", "NO_GLUCOSE_INFERENCE", "NO_CGM_SUBSTITUTION"),
            (0 until flags.length()).map(flags::getString))
        assertEquals(0, cert.getJSONObject("semanticIsolation").getInt("canonicalObservationsEmitted"))
        assertEquals("NONE", cert.getJSONObject("semanticIsolation").getString("base44Delivery"))
        // Only status updates are emitted; no observation/normalizer/Base44 events.
        assertTrue(events.all { it["semanticClassification"] == "RESEARCH_NATIVE_ONLY" && it["unit"] == "UNKNOWN_VENDOR_UNIT" })
        assertTrue(events.none { it.containsKey("observations") || it.containsKey("canonical") })
        assertNotNull(terminal)
        assertThrows(JCVitalV8SourceJournal.Failure::class.java) {
            RawPpgCertificationCapture.assertNoGlucoseKeys(JSONObject().put("nested", JSONArray().put(JSONObject().put("glucoseMgDl", 1))))
        }
    }

    @Test
    fun startRejectedWithoutScopeAndSendsNothing() {
        journal.configure(null, null, false, null, null, null)
        val transport = FakeTransport()
        val error = assertThrows(JCVitalV8SourceJournal.Failure::class.java) { newCapture(transport, ManualScheduler()).start() }
        assertEquals("SCOPE_NOT_CONFIGURED", error.reason)
        assertTrue(transport.writes.isEmpty())
    }

    @Test
    fun managerDelegatesNotificationsToActiveCertificationWithoutObservationsAndBlocksLegacyStart() {
        journal.close()
        shadowOf(RuntimeEnvironment.getApplication()).grantPermissions("${context.packageName}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION")
        val emitted = mutableListOf<String>()
        val manager = JCVitalV8Manager(context) { name, _ -> emitted.add(name) }
        try {
            manager.sourceJournal.configure(account, device, true, null, null, null)
            journal = manager.sourceJournal
            var legacyError: JCVitalV8Exception? = null
            manager.startRawPpg { _, error -> legacyError = error }
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(JCVitalV8Manager.RAW_PPG_LEGACY_CAPTURE_DISABLED, legacyError?.message)
            val transport = FakeTransport(autoAck = false)
            val capture = newCapture(transport, ManualScheduler())
            JCVitalV8Manager::class.java.getDeclaredField("rawPpgCertification").apply { isAccessible = true }.set(manager, capture)
            capture.start()
            val notify = JCVitalV8Manager::class.java.getDeclaredMethod("handleNotification", ByteArray::class.java).apply { isAccessible = true }
            transport.writes.single().onAck(true)
            physicalPackets().take(3).forEach { notify.invoke(manager, it) }
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals(3, capture.status()["packetCount"])
            assertFalse(emitted.contains(JCVitalV8EventNormalizer.EVENT_OBSERVATION))
            assertFalse(emitted.contains(JCVitalV8EventNormalizer.EVENT_RAW_PPG_CHUNK))
            assertFalse(emitted.contains(JCVitalV8EventNormalizer.EVENT_RAW_VENDOR_DATA))
            val status = manager.rawPpgCertificationStatus(account, device)
            assertEquals(true, status["active"])
            assertEquals(false, status["captureAllowed"])
            manager.disconnect()
            shadowOf(Looper.getMainLooper()).idle()
            assertEquals("NOT_CERTIFIED", capture.state)
            assertEquals(3, savedCertification().getJSONArray("packets").length())
            assertEquals("PPG_CERTIFICATION_ALREADY_ATTEMPTED", manager.rawPpgCertificationStatus(account, device)["blockedReason"])
        } finally { manager.release(); shadowOf(Looper.getMainLooper()).idle() }
        journal = JCVitalV8SourceJournal(context)
    }
}
