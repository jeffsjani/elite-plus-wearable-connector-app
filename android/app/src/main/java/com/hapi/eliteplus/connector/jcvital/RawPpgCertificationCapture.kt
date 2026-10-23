package com.hapi.eliteplus.connector.jcvital

import android.util.Base64
import com.jstyle.blesdkv8.Util.BleSDK
import com.jstyle.blesdkv8.callback.DataListener2301
import com.jstyle.blesdkv8.constant.DeviceKey
import org.json.JSONArray
import org.json.JSONObject
import java.io.File
import java.util.TimeZone
import java.util.UUID

/**
 * VC29 — one-shot physical Raw PPG certification capture.
 *
 * Strict order (spec §1): ids → persisted scope → Source Envelope Journal session-open envelope → durable spool
 * registered → restart-persistent attempt claim + ACQUIRING snapshot → PPG_COMMAND_REQUEST envelope (exact bytes)
 * → BLE write → PPG_COMMAND_WRITE_ACK envelope → every notification journaled BEFORE parsing → every SDK
 * callback/parser outcome journaled → every PPG packet appended to the spool in arrival order → finalize only after
 * the quit command is acknowledged and the drain window has elapsed (or a terminal failure is proven).
 *
 * No retries, no second capture, no routing to the normalizer: the waveform is RESEARCH_NATIVE_ONLY and is never
 * glucose. "Bloodsugar" is only the vendor protocol label of opcodes 0x78/0x3A.
 */
internal class RawPpgCertificationCapture(
    private val journal: JCVitalV8SourceJournal,
    private val filesDir: File,
    private val transport: Transport,
    private val scheduler: Scheduler,
    private val device: DeviceContext,
    private val onUpdate: (Map<String, Any?>) -> Unit = {},
    private val onTerminal: (Map<String, Any?>) -> Unit = {},
    private val clock: () -> Long = System::currentTimeMillis,
    private val monotonic: () -> Long = { android.os.SystemClock.elapsedRealtime() },
    private val captureDurationMs: Long = CAPTURE_DURATION_MS,
    private val drainMs: Long = DRAIN_MS,
    private val ackTimeoutMs: Long = ACK_TIMEOUT_MS,
    private val parser: (ByteArray, DataListener2301) -> Unit = { bytes, listener -> BleSDK.DataParsingWithData(bytes, listener) },
) {
    interface Transport {
        /** Write exactly [bytes] to the vendor write characteristic; [onAck] receives the GATT write outcome once. */
        fun write(name: String, bytes: ByteArray, onAck: (Boolean) -> Unit)
        fun linkAlive(): Boolean
    }

    interface Scheduler {
        fun schedule(delayMs: Long, task: () -> Unit): Any
        fun cancel(token: Any)
    }

    data class DeviceContext(
        val deviceId: String?,
        val firmwareVersion: String?,
        val notifyCharacteristicUuid: String?,
        val writeCharacteristicUuid: String?,
        val negotiatedMtu: Int?,
    )

    private class Command(val role: String, val mode: Int, val arg: Int, val bytes: ByteArray) {
        var requestEnvelopeId: String? = null
        var requestedAt: Long = 0
        var ackEnvelopeId: String? = null
        var ackStatus: String? = null
        var ackAt: Long? = null
    }

    private class Packet(
        val index: Int,
        val bytes: ByteArray,
        val notificationEnvelopeId: String,
        val receivedAt: Long,
        val receivedMonotonic: Long,
        val lengthPrefixOffset: Long,
        val payloadOffset: Long,
    ) {
        val callbackIds = mutableListOf<String>()
        val recordEnvelopeIds = mutableListOf<String>()
        val byteCallbackIds = mutableListOf<String>()
        val dataTypes = mutableListOf<String?>()
        val dataEnds = mutableListOf<Boolean?>()
        var parserOutcomeId: String? = null
        var parserStatus: String? = null
        var parserErrorClass: String? = null
    }

    val certificationGroupId: String = UUID.randomUUID().toString()
    val sessionId: String = "ppgcert-" + UUID.randomUUID().toString()
    var state: String = STATE_IDLE
        private set
    private var owner: JCVitalV8SourceJournal.Scope? = null
    private var store: RawPpgPacketStore? = null
    private var sourceFileId: String? = null
    private var sessionOpenEnvelopeId: String? = null
    private var terminalEnvelopeId: String? = null
    private val commands = mutableListOf<Command>()
    private val packets = mutableListOf<Packet>()
    private val nonPpgNotifications = mutableListOf<Map<String, Any?>>()
    private val failures = mutableListOf<String>()
    private var journalFailure: String? = null
    private var stopTask: Any? = null
    private var ackTask: Any? = null
    private var drainTask: Any? = null
    private var drainDeadlineTask: Any? = null
    private var drainCompleted = false
    private var openedAt: Long = 0
    private var finalSnapshot: Map<String, Any?>? = null
    private val timezone: String = TimeZone.getDefault().id

    val active: Boolean get() = state in ACTIVE_STATES

    /**
     * Steps 1–8. Throws [JCVitalV8SourceJournal.Failure] before any BLE command if durable evidence cannot be
     * established; once the claim is committed the attempt is consumed and every outcome is finalized.
     */
    fun start(): Map<String, Any?> {
        check(state == STATE_IDLE) { "PPG_CERTIFICATION_ALREADY_STARTED" }
        state = STATE_PREPARING
        openedAt = clock()
        // 2. persisted authenticated account/device scope.
        val scope = journal.currentScope() ?: fail0("SCOPE_NOT_CONFIGURED")
        if (journal.hasFailedClosed()) fail0("JOURNAL_FAILED_CLOSED")
        if (journal.rawPpgCertificationClaim(scope.accountId, scope.deviceScopeId) != null) fail0("PPG_CERTIFICATION_ALREADY_ATTEMPTED")
        owner = scope
        // 3. Source Envelope Journal initialized for this session.
        stampContext(device.writeCharacteristicUuid)
        sessionOpenEnvelopeId = try {
            journal.appendRaw(null, openedAt, timezone, null, "PPG_CERTIFICATION_SESSION_OPEN", linkedMapOf(
                "certificationGroupId" to certificationGroupId, "certificationSessionId" to sessionId,
                "certificationBuild" to BUILD_VERSION, "attemptPolicy" to "ONE_PHYSICAL_SESSION_NO_RETRY"))
        } catch (error: Exception) { fail0(error.message ?: "JOURNAL_INIT_FAILED") }
        // 4. durable spool created + registered.
        val packetStore = try { RawPpgPacketStore.create(filesDir, sessionId) } catch (error: Exception) { fail0("PPG_SPOOL_CREATE_FAILED") }
        store = packetStore
        sourceFileId = try { journal.registerFile(packetStore.file, sessionId, SPOOL_FORMAT) }
        catch (error: Exception) { packetStore.close(); fail0(error.message ?: "PPG_SPOOL_REGISTER_FAILED") }
        // 5. restart-persistent attempt state (claim + ACQUIRING snapshot, one transaction).
        try { journal.beginRawPpgCertificationAttempt(JSONObject(snapshot(STATE_ACQUIRING)).toString()) }
        catch (error: Exception) { packetStore.close(); fail0((error as? JCVitalV8SourceJournal.Failure)?.reason ?: error.message ?: "PPG_CERTIFICATION_ATTEMPT_PERSIST_FAILED") }
        // 6–8. journaled start command.
        state = STATE_START_REQUESTED
        sendCommand(ROLE_START, MODE_START) { ok ->
            if (!ok) return@sendCommand terminate("PPG_START_COMMAND_WRITE_FAILED", quitIfAlive = true)
            if (state != STATE_START_REQUESTED) return@sendCommand
            state = STATE_CAPTURING
            publish()
            stopTask = scheduler.schedule(captureDurationMs) { stopTask = null; requestStop() }
        }
        publish()
        return status()
    }

    private fun fail0(reason: String): Nothing {
        state = STATE_REJECTED
        throw JCVitalV8SourceJournal.Failure(reason)
    }

    private fun stampContext(characteristic: String?) = journal.setDeviceContext(device.firmwareVersion, "RAW_PPG", sessionId,
        characteristic, device.negotiatedMtu, monotonic())

    private fun journalUsable(): Boolean {
        val current = journal.currentScope()
        return journalFailure == null && !journal.hasFailedClosed() && current != null && current == owner
    }

    /** Steps 6–8 for one command: request envelope committed BEFORE the BLE write; ACK/FAILED envelope after. */
    private fun sendCommand(role: String, mode: Int, onDone: (Boolean) -> Unit) {
        val bytes = BleSDK.ppgWithMode(mode, 0)
        val command = Command(role, mode, 0, bytes.copyOf())
        commands += command
        if (!journalUsable()) { failures += "${role}_COMMAND_NOT_JOURNALED"; return onDone(false) }
        stampContext(device.writeCharacteristicUuid)
        command.requestedAt = clock()
        command.requestEnvelopeId = try {
            journal.appendRaw(bytes, command.requestedAt, timezone, sessionOpenEnvelopeId, "PPG_COMMAND_REQUEST", commandExtra(command))
        } catch (error: Exception) {
            journalFailure = error.message ?: "STORAGE_FAILURE"
            failures += "${role}_COMMAND_REQUEST_JOURNAL_FAILED"
            return onDone(false)
        }
        if (!checkpoint()) return terminateJournal("COMMAND_CHECKPOINT_FAILED")
        var settled = false
        fun settle(ok: Boolean, timedOut: Boolean = false) {
            if (settled) return
            settled = true
            ackTask?.let(scheduler::cancel); ackTask = null
            // A late GATT callback after finalization must not append evidence or trigger further commands.
            if (!active || state == STATE_FINALIZING) return
            command.ackAt = clock()
            command.ackStatus = if (ok) "GATT_SUCCESS" else if (timedOut) "WRITE_ACK_TIMEOUT" else "WRITE_FAILED"
            if (journalUsable()) {
                stampContext(device.writeCharacteristicUuid)
                command.ackEnvelopeId = try {
                    journal.appendRaw(null, command.ackAt!!, timezone, command.requestEnvelopeId,
                        if (ok) "PPG_COMMAND_WRITE_ACK" else "PPG_COMMAND_WRITE_FAILED", linkedMapOf(
                            "certificationGroupId" to certificationGroupId, "commandRole" to role,
                            "commandRequestEnvelopeId" to command.requestEnvelopeId, "commandSha256" to sha(bytes),
                            "writeStatus" to command.ackStatus, "commandCharacteristicUuid" to device.writeCharacteristicUuid))
                } catch (error: Exception) {
                    journalFailure = error.message ?: "STORAGE_FAILURE"
                    failures += "${role}_COMMAND_ACK_JOURNAL_FAILED"
                    null
                }
            }
            if (!ok) failures += "${role}_COMMAND_${command.ackStatus}"
            if (!checkpoint()) return terminateJournal("ACK_CHECKPOINT_FAILED")
            onDone(ok && command.ackEnvelopeId != null)
        }
        ackTask = scheduler.schedule(ackTimeoutMs) { settle(false, timedOut = true) }
        try {
            transport.write("ppgWithMode($mode,0)", bytes) { ok -> settle(ok) }
        } catch (error: Exception) {
            failures += "${role}_TRANSPORT_EXCEPTION:${error.javaClass.name}"
            settle(false)
        }
    }

    private fun commandExtra(command: Command): Map<String, Any?> = linkedMapOf(
        "certificationGroupId" to certificationGroupId,
        "commandRole" to command.role,
        "sdkMethod" to SDK_METHOD,
        "sdkArguments" to JSONObject().put("mode", command.mode).put("arg", command.arg),
        "opcode" to "0x78",
        "vendorProtocolLabel" to "DeviceConst.CMD_Get_Bloodsugar (vendor label only; not glucose)",
        "commandBytesHex" to hex(command.bytes),
        "commandSha256" to sha(command.bytes),
        "commandCharacteristicUuid" to device.writeCharacteristicUuid,
    )

    private fun requestStop() {
        if (state != STATE_CAPTURING) return
        state = STATE_STOP_REQUESTED
        publish()
        sendCommand(ROLE_STOP, MODE_STOP) { ok ->
            if (!ok) return@sendCommand terminate("PPG_STOP_COMMAND_WRITE_FAILED", quitIfAlive = true)
            sendCommand(ROLE_QUIT, MODE_QUIT) { quitOk ->
                if (!quitOk) return@sendCommand terminate("PPG_QUIT_COMMAND_WRITE_FAILED", quitIfAlive = false)
                state = STATE_DRAINING
                publish()
                scheduleDrain()
                drainDeadlineTask = scheduler.schedule(DRAIN_TIMEOUT_MS) {
                    drainDeadlineTask = null
                    terminate("PPG_STOP_NOT_QUIET_BEFORE_DEADLINE", quitIfAlive = false)
                }
            }
        }
    }

    private fun scheduleDrain() {
        drainTask?.let(scheduler::cancel)
        drainTask = scheduler.schedule(drainMs) {
            drainTask = null
            drainCompleted = true
            finalize("CAPTURE_STOPPED_QUIT_ACKNOWLEDGED_DRAIN_COMPLETE")
        }
    }

    /** Partial failure: preserve evidence, at most one best-effort journaled quit, never a retry, then finalize. */
    private fun terminate(reason: String, quitIfAlive: Boolean) {
        if (!active) return
        failures += reason
        stopTask?.let(scheduler::cancel); stopTask = null
        val quitAlreadySent = commands.any { it.role == ROLE_QUIT }
        if (quitIfAlive && !quitAlreadySent && transport.linkAlive() && journalUsable()) {
            state = STATE_ABORTING
            sendCommand(ROLE_QUIT, MODE_QUIT) { finalize(reason) }
        } else {
            finalize(reason)
        }
    }

    /** Link loss / scope change / release / journal failed-closed: no BLE, no retry; finalize NOT_CERTIFIED. */
    fun abort(reason: String) {
        if (!active) return
        failures += reason
        // Reset the vendor SDK's static PPG flag without writing anything (mirrors legacy link-loss handling).
        BleSDK.ppgWithMode(MODE_QUIT, 0)
        finalize(reason)
    }

    /** Steps 9–11 for a notification delivered while the certification capture owns the link. */
    fun onNotification(bytes: ByteArray) {
        if (!active || state == STATE_FINALIZING) return
        val receivedAt = clock()
        val receivedMonotonic = monotonic()
        if (!journalUsable()) return terminateJournal("NOTIFICATION_NOT_JOURNALED_JOURNAL_UNUSABLE")
        stampContext(device.notifyCharacteristicUuid)
        val opcode = bytes.firstOrNull()?.toInt()?.and(0xFF)
        val isPpg = opcode == OPCODE_STATUS || opcode == OPCODE_DATA
        val index = packets.size
        // 9. journal BEFORE parsing or spooling.
        val notificationId = try {
            journal.appendRaw(bytes, receivedAt, timezone, null, "BLE_NOTIFICATION", linkedMapOf(
                "certificationGroupId" to certificationGroupId,
                "certificationPacketIndex" to if (isPpg) index else null,
                "startCommandRequestEnvelopeId" to commands.firstOrNull { it.role == ROLE_START }?.requestEnvelopeId))
        } catch (error: Exception) { return terminateJournal(error.message ?: "STORAGE_FAILURE") }
        var packet: Packet? = null
        if (isPpg) {
            val spool = store ?: return terminate("PPG_SPOOL_UNAVAILABLE", quitIfAlive = true)
            packet = Packet(index, bytes.copyOf(), notificationId, receivedAt, receivedMonotonic,
                spool.byteCount, spool.byteCount + Integer.BYTES)
            packets += packet
        } else {
            nonPpgNotifications += linkedMapOf("notificationEnvelopeId" to notificationId, "opcode" to opcode?.let { "0x%02X".format(it) },
                "byteLength" to bytes.size, "sha256" to sha(bytes), "receivedAt" to JCVitalV8Time.isoUtc(receivedAt))
        }
        // 10. SDK parse with every callback journaled; output is NEVER routed to the normalizer.
        var callbackCount = 0
        var journalError: String? = null
        var status: String
        var errorClass: String? = null
        try {
            parser(bytes, object : DataListener2301 {
                override fun dataCallback(maps: MutableMap<String?, Any?>?) {
                    if (journalError != null) return
                    try {
                        val capture = journal.appendCallback(maps, receivedAt, timezone, notificationId)
                        callbackCount++
                        packet?.callbackIds?.add(capture.callbackId)
                        packet?.recordEnvelopeIds?.addAll(capture.recordIds)
                        packet?.dataTypes?.add(maps?.get(DeviceKey.DataType)?.toString())
                        packet?.dataEnds?.add(maps?.get(DeviceKey.End) as? Boolean)
                    } catch (error: Exception) { journalError = error.message ?: "STORAGE_FAILURE" }
                }

                override fun dataCallback(value: ByteArray?) {
                    if (journalError != null) return
                    try {
                        packet?.byteCallbackIds?.add(journal.appendRaw(value, receivedAt, timezone, notificationId, "SDK_BYTE_CALLBACK"))
                    } catch (error: Exception) { journalError = error.message ?: "STORAGE_FAILURE" }
                }
            })
            status = if (callbackCount == 0) "NO_MAP_CALLBACK" else "COMPLETE"
        } catch (error: Exception) {
            status = if (callbackCount == 0) "PARSE_ERROR" else "PARTIAL_PARSE_ERROR"
            errorClass = error.javaClass.name
        }
        val outcomeId = if (journalError == null) try {
            journal.appendParserOutcome(notificationId, status, callbackCount, errorClass, receivedAt, timezone)
        } catch (error: Exception) { journalError = error.message ?: "STORAGE_FAILURE"; null } else null
        packet?.parserOutcomeId = outcomeId
        packet?.parserStatus = status
        packet?.parserErrorClass = errorClass
        // 11. Preserve the original packet even when parsing or callback journaling failed.
        if (packet != null) {
            val spool = store!!
            try {
                if (journalError == null) journal.reserveFileBytes(spool.file.absolutePath, (Integer.BYTES + bytes.size).toLong())
                spool.appendPacket(bytes)
            } catch (error: Exception) {
                if (error is JCVitalV8SourceJournal.Failure) journalFailure = error.reason
                return terminate("PPG_SPOOL_APPEND_FAILED:${error.javaClass.name}", quitIfAlive = true)
            }
        }
        journalError?.let { return terminateJournal(it) }
        if (!checkpoint()) return terminateJournal("PACKET_CHECKPOINT_FAILED")
        if (errorClass != null) return terminate("PPG_PARSER_ERROR:$errorClass", quitIfAlive = true)
        if (isPpg && state == STATE_DRAINING) scheduleDrain()
        publish()
    }

    private fun terminateJournal(reason: String) {
        journalFailure = journalFailure ?: reason
        // Journal unusable: the evidence chain cannot continue, so no further (unjournaled) BLE is permitted.
        terminate("JOURNAL_FAILURE:$reason", quitIfAlive = false)
    }

    /** Step 12: verify the spool on disk twice, compute checks, persist the immutable final snapshot. */
    private fun finalize(terminalReason: String) {
        if (state == STATE_FINALIZING || state in TERMINAL_STATES) return
        state = STATE_FINALIZING
        listOfNotNull(stopTask, ackTask, drainTask, drainDeadlineTask).forEach(scheduler::cancel)
        stopTask = null; ackTask = null; drainTask = null; drainDeadlineTask = null
        try { store?.close() } catch (error: Exception) { failures += "PPG_SPOOL_CLOSE_FAILED" }
        if (journalUsable()) {
            stampContext(null)
            terminalEnvelopeId = try {
                journal.appendRaw(null, clock(), timezone, sessionOpenEnvelopeId, "PPG_CERTIFICATION_TERMINAL", linkedMapOf(
                    "certificationGroupId" to certificationGroupId, "terminalReason" to terminalReason,
                    "packetCount" to packets.size, "failures" to JSONArray(failures)))
            } catch (error: Exception) { journalFailure = error.message ?: "STORAGE_FAILURE"; null }
        }
        val verdict = verify()
        val finalState = if (verdict.second.isEmpty()) STATE_CERTIFIED else STATE_NOT_CERTIFIED
        val snapshot = snapshot(finalState, terminalReason, verdict.first, verdict.second)
        state = snapshot["state"] as String
        val persisted = try {
            assertNoGlucoseKeys(JSONObject(snapshot))
            journal.finalizeRawPpgCertificationAttempt(JSONObject(snapshot).toString())
            null
        } catch (error: Exception) { (error as? JCVitalV8SourceJournal.Failure)?.reason ?: error.message ?: error.javaClass.simpleName }
        if (persisted != null) {
            state = STATE_NOT_CERTIFIED
            failures += "FINAL_SNAPSHOT_PERSIST_FAILED:$persisted"
        }
        val result = LinkedHashMap(snapshot).apply {
            if (persisted != null) {
                put("state", STATE_NOT_CERTIFIED)
                put("sourceStatus", "NOT_CERTIFIED_EVIDENCE_PRESERVED")
                put("certified", false)
                put("failures", failures.toList())
            }
        }
        result["finalSnapshotPersisted"] = persisted == null
        result["finalSnapshotPersistError"] = persisted
        finalSnapshot = result
        journal.setDeviceContext(device.firmwareVersion)
        onTerminal(result)
    }

    private fun verify(): Pair<Map<String, Any?>, List<String>> {
        val checks = linkedMapOf<String, Any?>()
        val failed = mutableListOf<String>()
        fun check(name: String, passed: Boolean, detail: Any? = null) {
            checks[name] = linkedMapOf("passed" to passed, "detail" to detail)
            if (!passed) failed += name
        }
        val file = store?.file
        val parse1 = file?.let { runCatching { RawPpgSavedEvidence.parseSpool(it) }.getOrNull() }
        val parse2 = file?.let { runCatching { RawPpgSavedEvidence.parseSpool(it) }.getOrNull() }
        val expectedLength = MAGIC_BYTES + packets.sumOf { Integer.BYTES + it.bytes.size.toLong() }
        val reserved = owner?.let { o -> sourceFileId?.let { id ->
            runCatching { (journal.readRawPpgCertificationEnvelope(o, id)["sourceFile"] as? Map<*, *>)?.get("reservedBytes") as? Long }.getOrNull()
        } }
        check("noPriorFailures", failures.isEmpty(), JSONArray(failures))
        check("journalHealthy", journalFailure == null && !journal.hasFailedClosed(), journalFailure)
        for (role in listOf(ROLE_START, ROLE_STOP, ROLE_QUIT)) {
            val command = commands.firstOrNull { it.role == role }
            check("command${role}Requested", command?.requestEnvelopeId != null)
            check("command${role}WriteAck", command?.ackStatus == "GATT_SUCCESS" && command.ackEnvelopeId != null, command?.ackStatus)
        }
        check("commandsNotRetried", commands.groupBy { it.role }.values.all { it.size == 1 }, commands.map { it.role })
        check("physicalPpgNotificationsReceived", packets.isNotEmpty(), packets.size)
        check("physicalPpgDataReceived", packets.any { it.bytes[0].toInt() and 0xFF == OPCODE_DATA })
        check("spoolMagicValid", parse1?.magicValid == true)
        check("spoolNotTruncated", parse1 != null && !parse1.truncated && parse2 != null && !parse2.truncated, parse1?.truncationOffset)
        check("spoolPacketCountMatches", parse1?.packets?.size == packets.size, parse1?.packets?.size)
        check("spoolBytesByteForByte", parse1 != null && parse1.packets.size == packets.size && parse1.packets.zip(packets).all { (p, mine) ->
            p.index == mine.index && p.byteLength == mine.bytes.size && p.sha256Hex == sha(mine.bytes)
                && p.payloadOffset == mine.payloadOffset && p.lengthPrefixOffset == mine.lengthPrefixOffset
                && Base64.decode(p.base64, Base64.DEFAULT).contentEquals(mine.bytes)
        })
        check("spoolLengthMatchesPackets", parse1?.fileByteLength == expectedLength, linkedMapOf("expected" to expectedLength, "actual" to parse1?.fileByteLength))
        check("spoolReservedBytesMatch", reserved == expectedLength && reserved == file?.length(), reserved)
        check("spoolHashStable", parse1 != null && parse2 != null && parse1.fileSha256Hex == parse2.fileSha256Hex, parse1?.fileSha256Hex)
        check("everyPacketHasParserOutcome", packets.all { it.parserOutcomeId != null })
        check("everyDataPacketHasSdkCallback", packets.filter { it.bytes[0].toInt() and 0xFF == OPCODE_DATA }.all { it.callbackIds.isNotEmpty() })
        // Persisted ancestry/order proof read back from the journal (not from memory).
        val ordering = owner?.let { o -> runCatching { ancestryProof(o) }.getOrElse { linkedMapOf("error" to (it.message ?: it.javaClass.simpleName)) } }
        check("journalAncestryAndOrder", ordering?.get("valid") == true, ordering)
        check("terminalProven", commands.firstOrNull { it.role == ROLE_QUIT }?.ackStatus == "GATT_SUCCESS"
            && drainCompleted && failures.isEmpty(), "QUIT_ACKNOWLEDGED_AND_QUIET_WINDOW_DRAINED")
        return checks to failed
    }

    private fun ancestryProof(o: JCVitalV8SourceJournal.Scope): Map<String, Any?> {
        fun seq(id: String?): Long? = id?.let { journal.readRawPpgCertificationEnvelope(o, it)["sequence"] as Long }
        val errors = mutableListOf<String>()
        val open = seq(sessionOpenEnvelopeId)
        var previous = open ?: -1L
        commands.filter { it.role == ROLE_START }.forEach { c ->
            val req = seq(c.requestEnvelopeId); val ack = seq(c.ackEnvelopeId)
            if (req == null || req <= previous) errors += "START_REQUEST_NOT_AFTER_SESSION_OPEN"
            if (ack == null || req == null || ack <= req) errors += "START_ACK_NOT_AFTER_REQUEST"
            val ackJson = c.ackEnvelopeId?.let { JSONObject(journal.readRawPpgCertificationEnvelope(o, it)["envelopeJson"] as String) }
            if (ackJson?.optString("parentEnvelopeId") != c.requestEnvelopeId) errors += "START_ACK_PARENT_MISMATCH"
            previous = req ?: previous
        }
        val packetOrder = mutableListOf<Long>()
        packets.forEach { p ->
            val entry = journal.readRawPpgCertificationEnvelope(o, p.notificationEnvelopeId)
            val n = entry["sequence"] as Long
            if (n <= previous) errors += "NOTIFICATION_${p.index}_OUT_OF_ORDER"
            val raw = (entry["rawBytesBase64"] as? String)?.let { Base64.decode(it, Base64.DEFAULT) }
            if (raw == null || !raw.contentEquals(p.bytes)) errors += "NOTIFICATION_${p.index}_RAW_MISMATCH"
            p.callbackIds.forEach { cb ->
                val c = seq(cb)!!
                if (c <= n) errors += "CALLBACK_BEFORE_NOTIFICATION_${p.index}"
                val parent = JSONObject(journal.readRawPpgCertificationEnvelope(o, cb)["envelopeJson"] as String).optString("notificationEnvelopeId")
                if (parent != p.notificationEnvelopeId) errors += "CALLBACK_PARENT_MISMATCH_${p.index}"
            }
            val outcome = seq(p.parserOutcomeId)
            if (outcome == null || outcome <= n || p.callbackIds.any { seq(it)!! >= outcome }) errors += "PARSER_OUTCOME_ORDER_${p.index}"
            packetOrder += n
            previous = n
        }
        val roles = listOf(ROLE_STOP, ROLE_QUIT).mapNotNull { r -> commands.firstOrNull { it.role == r } }
        var cursor = seq(commands.firstOrNull { it.role == ROLE_START }?.ackEnvelopeId) ?: -1L
        roles.forEach { c ->
            val req = seq(c.requestEnvelopeId); val ack = seq(c.ackEnvelopeId)
            if (req == null || req <= cursor) errors += "${c.role}_REQUEST_ORDER"
            if (ack == null || req == null || ack <= req) errors += "${c.role}_ACK_ORDER"
            cursor = ack ?: cursor
        }
        return linkedMapOf("valid" to errors.isEmpty(), "errors" to JSONArray(errors), "sessionOpenSequence" to open,
            "notificationSequences" to JSONArray(packetOrder))
    }

    fun status(): Map<String, Any?> = finalSnapshot ?: linkedMapOf(
        "certificationGroupId" to certificationGroupId, "sessionId" to sessionId, "state" to state,
        "packetCount" to packets.size, "spoolBytes" to (MAGIC_BYTES + packets.sumOf { Integer.BYTES + it.bytes.size.toLong() }),
        "commands" to commands.map { mapOf("role" to it.role, "ackStatus" to it.ackStatus) },
        "nonPpgNotificationCount" to nonPpgNotifications.size, "failures" to failures.toList(),
        "semanticClassification" to SEMANTIC_CLASSIFICATION, "unit" to UNIT, "sampleRateHz" to null, "samplingIntervalMs" to null,
    )

    private fun publish() = onUpdate(status())

    private fun checkpoint(): Boolean = try {
        journal.checkpointRawPpgCertificationAttempt(JSONObject(snapshot(STATE_ACQUIRING)).toString())
        true
    } catch (error: Exception) {
        journalFailure = error.message ?: "PPG_CHECKPOINT_STORAGE_FAILURE"
        false
    }

    private fun snapshot(requestedState: String, terminalReason: String? = null, checks: Map<String, Any?>? = null,
        failedChecks: List<String>? = null): Map<String, Any?> {
        val scope = owner!!
        val file = store?.file
        val fileBytes = try { file?.takeIf { it.isFile }?.readBytes() } catch (error: Exception) {
            failures += "PPG_SPOOL_READ_FAILED:${error.javaClass.name}"
            null
        }
        val state = if (requestedState == STATE_CERTIFIED && fileBytes == null) STATE_NOT_CERTIFIED else requestedState
        val certified = state == STATE_CERTIFIED
        return linkedMapOf(
            "kind" to JCVitalV8SourceJournal.PPG_PHYSICAL_KIND,
            "modelVersion" to JCVitalV8SourceJournal.MODEL_VERSION,
            "certificationBuild" to BUILD_VERSION,
            "state" to state,
            "sourceStatus" to when (state) {
                STATE_CERTIFIED -> "CERTIFIED_E2E_LOSSLESS_SOURCE"
                STATE_ACQUIRING -> "ACQUIRING_ONE_PHYSICAL_SESSION"
                else -> "NOT_CERTIFIED_EVIDENCE_PRESERVED"
            },
            "semanticClassification" to SEMANTIC_CLASSIFICATION,
            "canonicalAuthority" to CANONICAL_AUTHORITY,
            "deliveryDisposition" to DELIVERY_DISPOSITION,
            "unit" to UNIT,
            "sampleRateHz" to null,
            "samplingIntervalMs" to null,
            "semanticIsolation" to linkedMapOf(
                "flags" to ISOLATION_FLAGS,
                "vendorProtocolLabelNote" to "Vendor names 0x78 CMD_Get_Bloodsugar / 0x3A Bloodsugar_data / BleConst 118,119 are protocol labels only. This waveform is raw optical PPG research data; no physiological value, estimate, score or canonical observation is produced.",
                "base44Delivery" to "NONE",
                "canonicalObservationsEmitted" to 0,
            ),
            "certificationGroupId" to certificationGroupId,
            "sessionId" to sessionId,
            "context" to linkedMapOf(
                "scope" to linkedMapOf("accountId" to scope.accountId, "deviceScopeId" to scope.deviceScopeId),
                "deviceModel" to "PRO_V8", "deviceId" to device.deviceId, "firmwareVersion" to device.firmwareVersion,
                "notifyCharacteristicUuid" to device.notifyCharacteristicUuid, "writeCharacteristicUuid" to device.writeCharacteristicUuid,
                "negotiatedMtu" to device.negotiatedMtu, "sdkVersion" to JCVitalV8EventNormalizer.SDK_VERSION,
            ),
            "attemptGuard" to linkedMapOf("policy" to "ONE_PHYSICAL_SESSION_PER_ACCOUNT_DEVICE", "retry" to false,
                "automaticSecondCapture" to false, "restartPersistent" to true,
                "reenableCondition" to "SUPERSEDED_ONLY_BY_FUTURE_ENGINEERING_BUILD"),
            "timeline" to linkedMapOf("openedAt" to JCVitalV8Time.isoUtc(openedAt),
                "finalizedAt" to if (state == STATE_ACQUIRING) null else JCVitalV8Time.isoUtc(clock()),
                "captureDurationMs" to captureDurationMs, "drainMs" to drainMs, "drainCompleted" to drainCompleted),
            "terminalReason" to terminalReason,
            "journal" to linkedMapOf("sessionOpenEnvelopeId" to sessionOpenEnvelopeId, "sourceFileId" to sourceFileId,
                "terminalEnvelopeId" to terminalEnvelopeId, "journalFailure" to journalFailure),
            "commands" to commands.map { c -> linkedMapOf(
                "role" to c.role, "sdkMethod" to SDK_METHOD, "sdkArguments" to linkedMapOf("mode" to c.mode, "arg" to c.arg),
                "opcode" to "0x78", "modeByte" to "0x%02X".format(c.mode), "bytesHex" to hex(c.bytes),
                "bytesBase64" to Base64.encodeToString(c.bytes, Base64.NO_WRAP), "byteLength" to c.bytes.size, "sha256" to sha(c.bytes),
                "characteristicUuid" to device.writeCharacteristicUuid, "requestEnvelopeId" to c.requestEnvelopeId,
                "requestedAt" to if (c.requestedAt > 0) JCVitalV8Time.isoUtc(c.requestedAt) else null,
                "writeAck" to linkedMapOf("status" to c.ackStatus, "envelopeId" to c.ackEnvelopeId,
                    "parentEnvelopeId" to c.requestEnvelopeId, "at" to c.ackAt?.let(JCVitalV8Time::isoUtc)),
            ) },
            "packets" to packets.map(::packetJson),
            "nonPpgNotifications" to nonPpgNotifications.toList(),
            "spool" to linkedMapOf(
                "fileName" to file?.name, "path" to file?.absolutePath, "sourceFileId" to sourceFileId, "format" to SPOOL_FORMAT,
                "byteEncoding" to RawPpgSavedEvidence.BYTE_ENCODING, "magicBytes" to MAGIC_BYTES,
                "fileByteLength" to fileBytes?.size, "fileSha256" to fileBytes?.let(::sha),
                "packetCount" to packets.size, "payloadByteTotal" to packets.sumOf { it.bytes.size },
                "durability" to "FD_SYNC_AFTER_EACH_PACKET", "truncation" to "NONE_FULL_SPOOL_PRESERVED",
            ),
            "packetShape" to packetShape(fileBytes?.size?.toLong()),
            "checks" to checks,
            "failedChecks" to failedChecks,
            "failures" to failures.toList(),
            "certified" to certified,
            "offlineControls" to linkedMapOf("bleCommands" to 0, "networkRequests" to 0, "acquisitions" to 0),
        )
    }

    private fun packetJson(p: Packet): Map<String, Any?> {
        val opcode = p.bytes[0].toInt() and 0xFF
        val repeatOf = packets.firstOrNull { it.index < p.index && it.bytes.contentEquals(p.bytes) }?.index
        val trailer = p.bytes.last().toInt() and 0xFF
        val sum = p.bytes.dropLast(1).sumOf { it.toInt() and 0xFF } and 0xFF
        return linkedMapOf(
            "index" to p.index, "opcode" to "0x%02X".format(opcode),
            "packetClass" to if (opcode == OPCODE_DATA) "DATA" else "STATUS",
            "byteLength" to p.bytes.size, "sha256" to sha(p.bytes),
            "base64" to Base64.encodeToString(p.bytes, Base64.NO_WRAP),
            "spoolLengthPrefixOffset" to p.lengthPrefixOffset, "spoolPayloadOffset" to p.payloadOffset,
            "zeroByteCount" to p.bytes.count { it.toInt() == 0 }, "repeatOfPacketIndex" to repeatOf,
            "headerHex" to hex(p.bytes.copyOfRange(0, minOf(3, p.bytes.size))),
            "byte1Hex" to p.bytes.getOrNull(1)?.let { "0x%02X".format(it.toInt() and 0xFF) },
            "byte2Hex" to p.bytes.getOrNull(2)?.let { "0x%02X".format(it.toInt() and 0xFF) },
            "trailerHex" to "0x%02X".format(trailer),
            "trailerEqualsByteSumMod256" to (trailer == sum),
            "sequenceFieldInterpretation" to "UNKNOWN_VENDOR_LAYOUT_BYTES_PRESERVED",
            "notificationEnvelopeId" to p.notificationEnvelopeId,
            "receivedAt" to JCVitalV8Time.isoUtc(p.receivedAt), "receivedMonotonicMillis" to p.receivedMonotonic,
            "callbackIds" to p.callbackIds.toList(), "recordEnvelopeIds" to p.recordEnvelopeIds.toList(),
            "byteCallbackIds" to p.byteCallbackIds.toList(), "vendorDataTypes" to p.dataTypes.toList(),
            "vendorDataEnd" to p.dataEnds.toList(),
            "parserOutcomeId" to p.parserOutcomeId, "parserStatus" to p.parserStatus, "parserErrorClass" to p.parserErrorClass,
        )
    }

    private fun packetShape(spoolBytes: Long?): Map<String, Any?> {
        val sizes = packets.groupingBy { it.bytes.size }.eachCount().toSortedMap().mapKeys { it.key.toString() }
        val opcodes = packets.groupingBy { "0x%02X".format(it.bytes[0].toInt() and 0xFF) }.eachCount().toSortedMap()
        val data = packets.count { it.bytes[0].toInt() and 0xFF == OPCODE_DATA }
        val status = packets.size - data
        val diffs = mutableListOf<String>()
        if (packets.size != RawPpgSavedEvidence.EXPECTED_PACKET_COUNT) diffs += "packetCount ${packets.size} != historical ${RawPpgSavedEvidence.EXPECTED_PACKET_COUNT}"
        val data203 = packets.count { it.bytes[0].toInt() and 0xFF == OPCODE_DATA && it.bytes.size == 203 }
        if (data203 != RawPpgSavedEvidence.EXPECTED_DATA_PACKET_COUNT || data != data203) diffs += "data packets: $data total, $data203 x 203 bytes (historical 18 x 203)"
        val status16 = packets.count { it.bytes[0].toInt() and 0xFF == OPCODE_STATUS && it.bytes.size == 16 }
        if (status16 != RawPpgSavedEvidence.EXPECTED_STATUS_PACKET_COUNT || status != status16) diffs += "status packets: $status total, $status16 x 16 bytes (historical 2 x 16)"
        if (spoolBytes != null && spoolBytes != RawPpgSavedEvidence.EXPECTED_SPOOL_BYTES) diffs += "spool bytes $spoolBytes != historical ${RawPpgSavedEvidence.EXPECTED_SPOOL_BYTES}"
        return linkedMapOf(
            "authority" to "NEW_PHYSICAL_CAPTURE_IS_AUTHORITATIVE",
            "actual" to linkedMapOf("packetCount" to packets.size, "dataPacketCount" to data, "statusPacketCount" to status,
                "packetSizes" to packets.map { it.bytes.size }, "sizeHistogram" to sizes, "opcodeHistogram" to opcodes,
                "totalSpoolBytes" to spoolBytes, "orderedOpcodes" to packets.map { "0x%02X".format(it.bytes[0].toInt() and 0xFF) }),
            "historicalExpectation" to linkedMapOf("packetCount" to 20, "dataPackets" to "18 x 203 bytes",
                "statusPackets" to "2 x 16 bytes", "spoolBytes" to 3774, "role" to "EXPECTED_PATTERN_NOT_REQUIREMENT"),
            "matchesHistoricalPattern" to diffs.isEmpty(),
            "differences" to diffs,
        )
    }

    companion object {
        const val BUILD_VERSION = "1.0-certification-v1-vc29"
        const val EVENT_STATUS = "jcvitalRawPpgCertificationStatus"
        const val SDK_METHOD = "BleSDK.ppgWithMode(int,int)"
        const val SPOOL_FORMAT = "PPG_LENGTH_PREFIXED_V1"
        const val OPCODE_STATUS = 0x78
        const val OPCODE_DATA = 0x3A
        const val MODE_START = 1
        const val MODE_STOP = 3
        const val MODE_QUIT = 5
        const val ROLE_START = "START"
        const val ROLE_STOP = "STOP"
        const val ROLE_QUIT = "QUIT"
        const val MAGIC_BYTES = 8L
        const val CAPTURE_DURATION_MS = 20_000L
        const val DRAIN_MS = 2_000L
        const val DRAIN_TIMEOUT_MS = 10_000L
        const val ACK_TIMEOUT_MS = 5_000L
        const val STATE_IDLE = "IDLE"
        const val STATE_REJECTED = "REJECTED_BEFORE_COMMAND"
        const val STATE_PREPARING = "PREPARING"
        const val STATE_ACQUIRING = "ACQUIRING"
        const val STATE_START_REQUESTED = "START_REQUESTED"
        const val STATE_CAPTURING = "CAPTURING"
        const val STATE_STOP_REQUESTED = "STOP_REQUESTED"
        const val STATE_DRAINING = "DRAINING"
        const val STATE_ABORTING = "ABORTING"
        const val STATE_FINALIZING = "FINALIZING"
        const val STATE_CERTIFIED = "CERTIFIED"
        const val STATE_NOT_CERTIFIED = "NOT_CERTIFIED"
        const val SEMANTIC_CLASSIFICATION = "RESEARCH_NATIVE_ONLY"
        const val CANONICAL_AUTHORITY = "NONE_UNTIL_SEMANTICS_CONFIRMED"
        const val DELIVERY_DISPOSITION = "LOCAL_SOURCE_EVIDENCE_ONLY"
        const val UNIT = "UNKNOWN_VENDOR_UNIT"
        val ISOLATION_FLAGS = listOf("RAW_PPG_NOT_GLUCOSE", "NO_GLUCOSE_CANONICAL_MAPPING", "NO_GLUCOSE_INFERENCE", "NO_CGM_SUBSTITUTION")
        private val ACTIVE_STATES = setOf(STATE_START_REQUESTED, STATE_CAPTURING, STATE_STOP_REQUESTED, STATE_DRAINING, STATE_ABORTING, STATE_FINALIZING)
        private val TERMINAL_STATES = setOf(STATE_CERTIFIED, STATE_NOT_CERTIFIED)
        private val FORBIDDEN_KEY = Regex("(?i)(glucose|bloodsugar|blood_sugar|sugar|cgm|mg_?dl|mmol)")

        /** Exact vendor frames, derived from BleSDK.ppgWithMode bytecode: [0x78, mode, 0…, sum(0..14) & 0xFF]. */
        fun expectedFrame(mode: Int): ByteArray = ByteArray(16).also { it[0] = 0x78; it[1] = mode.toByte(); it[15] = ((0x78 + mode) and 0xFF).toByte() }

        fun sha(bytes: ByteArray): String = RawPpgSavedEvidence.sha256Hex(bytes)
        fun hex(bytes: ByteArray): String = bytes.joinToString(" ") { "%02X".format(it.toInt() and 0xFF) }

        /** Hard glucose prohibition: no key anywhere in a persisted/exported certification may name glucose/CGM. */
        fun assertNoGlucoseKeys(value: Any?) {
            when (value) {
                is JSONObject -> value.keys().forEach { key ->
                    if (FORBIDDEN_KEY.containsMatchIn(key)) throw JCVitalV8SourceJournal.Failure("NO_GLUCOSE_CANONICAL_MAPPING")
                    assertNoGlucoseKeys(value.opt(key))
                }
                is JSONArray -> for (i in 0 until value.length()) assertNoGlucoseKeys(value.opt(i))
            }
        }

        /** Offline inspection: 0 BLE, 0 network, 0 acquisition. Re-verifies the on-disk spool and journal ancestry. */
        fun inspect(journal: JCVitalV8SourceJournal, accountId: String?, deviceScopeId: String?): Map<String, Any?> {
            val saved = journal.readRawPpgPhysicalCertification(accountId, deviceScopeId)
            val json = saved["json"] as? String ?: return linkedMapOf("found" to false, "attempted" to (saved["claim"] != null),
                "claim" to saved["claim"], "bleCommands" to 0, "networkRequests" to 0, "acquisitions" to 0)
            val cert = JSONObject(json)
            val owner = JCVitalV8SourceJournal.Scope(accountId!!, saved["deviceScopeId"] as String)
            val spool = cert.getJSONObject("spool")
            val errors = mutableListOf<String>()
            val file = spool.optString("path").takeIf { it.isNotEmpty() }?.let(::File)
            val parsed = file?.takeIf { it.isFile }?.let { RawPpgSavedEvidence.parseSpool(it) }
            if (parsed == null) errors += "SPOOL_MISSING"
            val packets = cert.getJSONArray("packets")
            if (parsed != null) {
                if (!parsed.magicValid) errors += "SPOOL_MAGIC_INVALID"
                if (parsed.truncated) errors += "SPOOL_TRUNCATED"
                if (!spool.isNull("fileSha256") && parsed.fileSha256Hex != spool.getString("fileSha256")) errors += "SPOOL_SHA_MISMATCH"
                if (!spool.isNull("fileByteLength") && parsed.fileByteLength != spool.getLong("fileByteLength")) errors += "SPOOL_LENGTH_MISMATCH"
                if (parsed.packets.size != packets.length()) errors += "PACKET_COUNT_MISMATCH"
                parsed.packets.forEachIndexed { i, p ->
                    val saved = packets.optJSONObject(i) ?: return@forEachIndexed
                    if (p.sha256Hex != saved.getString("sha256") || p.byteLength != saved.getInt("byteLength")) errors += "PACKET_${i}_MISMATCH"
                    if (p.index != saved.getInt("index") || p.payloadOffset != saved.getLong("spoolPayloadOffset")
                        || p.lengthPrefixOffset != saved.getLong("spoolLengthPrefixOffset")) errors += "PACKET_${i}_OFFSET_MISMATCH"
                    val envelope = runCatching { journal.readRawPpgCertificationEnvelope(owner, saved.getString("notificationEnvelopeId")) }.getOrNull()
                    val raw = (envelope?.get("rawBytesBase64") as? String)?.let { Base64.decode(it, Base64.DEFAULT) }
                    if (raw == null || sha(raw) != p.sha256Hex) errors += "PACKET_${i}_JOURNAL_MISMATCH"
                    for (key in listOf("callbackIds", "byteCallbackIds", "parserOutcomeId")) {
                        val ids = if (key == "parserOutcomeId") listOfNotNull(saved.optString(key).takeUnless { it.isEmpty() || it == "null" })
                            else saved.getJSONArray(key).let { a -> (0 until a.length()).map(a::getString) }
                        ids.forEach { id ->
                            val child = runCatching { journal.readRawPpgCertificationEnvelope(owner, id) }.getOrNull()
                            val childJson = (child?.get("envelopeJson") as? String)?.let(::JSONObject)
                            val parentKey = if (key == "byteCallbackIds") "parentEnvelopeId" else "notificationEnvelopeId"
                            if (childJson?.optString(parentKey) != saved.getString("notificationEnvelopeId")
                                || (child?.get("sequence") as? Long ?: -1L) <= (envelope?.get("sequence") as? Long ?: Long.MAX_VALUE)) {
                                errors += "PACKET_${i}_${key}_ANCESTRY_MISMATCH"
                            }
                        }
                    }
                }
            }
            val commands = cert.getJSONArray("commands")
            for (i in 0 until commands.length()) {
                val command = commands.getJSONObject(i)
                if (command.isNull("requestEnvelopeId")) continue
                val requestId = command.getString("requestEnvelopeId")
                val request = runCatching { journal.readRawPpgCertificationEnvelope(owner, requestId) }.getOrNull()
                val raw = (request?.get("rawBytesBase64") as? String)?.let { Base64.decode(it, Base64.DEFAULT) }
                if (raw == null || sha(raw) != command.getString("sha256")) errors += "COMMAND_${i}_REQUEST_MISMATCH"
                val ack = command.getJSONObject("writeAck")
                if (ack.isNull("envelopeId")) continue
                val ackEntry = runCatching { journal.readRawPpgCertificationEnvelope(owner, ack.getString("envelopeId")) }.getOrNull()
                val ackJson = (ackEntry?.get("envelopeJson") as? String)?.let(::JSONObject)
                if (ackJson?.optString("parentEnvelopeId") != requestId || ackJson.optString("writeStatus") != ack.getString("status")
                    || (ackEntry?.get("sequence") as? Long ?: -1L) <= (request?.get("sequence") as? Long ?: Long.MAX_VALUE)) {
                    errors += "COMMAND_${i}_ACK_ANCESTRY_MISMATCH"
                }
            }
            return linkedMapOf(
                "found" to true, "attempted" to true, "state" to cert.getString("state"), "sourceStatus" to cert.getString("sourceStatus"),
                "certificationGroupId" to cert.getString("certificationGroupId"), "sessionId" to cert.getString("sessionId"),
                "semanticClassification" to cert.getString("semanticClassification"), "canonicalAuthority" to cert.getString("canonicalAuthority"),
                "deliveryDisposition" to cert.getString("deliveryDisposition"), "unit" to cert.getString("unit"),
                "sampleRateHz" to null, "samplingIntervalMs" to null,
                "packetCount" to packets.length(), "spoolFileName" to spool.optString("fileName"),
                "spoolByteLength" to parsed?.fileByteLength, "spoolSha256" to parsed?.fileSha256Hex,
                "failedChecks" to cert.opt("failedChecks").takeUnless { it == JSONObject.NULL }?.toString(),
                "onDiskVerification" to if (errors.isEmpty()) "VERIFIED" else "MISMATCH", "verificationErrors" to errors,
                "bleCommands" to 0, "networkRequests" to 0, "acquisitions" to 0,
            )
        }

        /** Offline export of the full raw spool bytes (never truncated). */
        fun exportSpool(journal: JCVitalV8SourceJournal, accountId: String?, deviceScopeId: String?): Map<String, Any?> {
            val json = journal.readRawPpgPhysicalCertification(accountId, deviceScopeId)["json"] as? String
                ?: throw JCVitalV8SourceJournal.Failure("PPG_CERTIFICATION_NOT_FOUND")
            val cert = JSONObject(json)
            val spool = cert.getJSONObject("spool")
            val path = spool.optString("path")
            val file = File(path)
            if (path.isEmpty() || !file.isFile) throw JCVitalV8SourceJournal.Failure("PPG_SPOOL_MISSING")
            val bytes = file.readBytes()
            if (cert.getString("state") != STATE_ACQUIRING) {
                if (!spool.isNull("fileByteLength") && bytes.size.toLong() != spool.getLong("fileByteLength")) {
                    throw JCVitalV8SourceJournal.Failure("PPG_SPOOL_LENGTH_MISMATCH")
                }
                if (!spool.isNull("fileSha256") && sha(bytes) != spool.getString("fileSha256")) {
                    throw JCVitalV8SourceJournal.Failure("PPG_SPOOL_SHA_MISMATCH")
                }
            }
            return linkedMapOf("fileName" to file.name, "byteLength" to bytes.size, "sha256" to sha(bytes),
                "base64" to Base64.encodeToString(bytes, Base64.NO_WRAP), "byteEncoding" to RawPpgSavedEvidence.BYTE_ENCODING,
                "bleCommands" to 0, "networkRequests" to 0, "acquisitions" to 0)
        }

        fun attemptStatus(journal: JCVitalV8SourceJournal, accountId: String?, deviceScopeId: String?): Map<String, Any?> {
            val saved = journal.readRawPpgPhysicalCertification(accountId, deviceScopeId)
            val claim = saved["claim"]
            val state = (saved["json"] as? String)?.let { JSONObject(it).getString("state") }
            return linkedMapOf("attempted" to (claim != null || state != null), "state" to state, "claim" to claim,
                "captureAllowed" to (saved["deviceScopeId"] != null && claim == null && state == null),
                "blockedReason" to when {
                    claim != null || state != null -> "PPG_CERTIFICATION_ALREADY_ATTEMPTED"
                    saved["deviceScopeId"] == null -> "PPG_SCOPE_NOT_RESOLVED"
                    else -> null
                })
        }
    }
}
