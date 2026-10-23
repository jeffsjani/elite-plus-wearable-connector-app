package com.hapi.eliteplus.connector.jcvital

import org.json.JSONObject
import java.io.File

/**
 * VC28 offline Raw PPG saved-evidence diagnostic. Diagnostic only: it never certifies, finalizes, enqueues,
 * delivers, canonicalizes, maps glucose, touches BLE, or requires the live V8/READY/source-journal capture scope.
 *
 * Order is fixed so neither side of the evidence can hide the other:
 * files dir -> spool directory -> candidate spool files (name/size/hash) -> Source Journal correlation.
 * [diagnose] never throws; every failure becomes an explicit code with its stage and exception class/message.
 */
internal class RawPpgSavedEvidenceDiagnostic(
    private val filesDir: File?,
    private val census: (accountId: String?, deviceScopeId: String?) -> Map<String, Any?>,
    private val historicalSessionInMemory: () -> Boolean = { false },
) {
    companion object {
        const val DIAGNOSTIC_DIR = "jcvital-diagnostics"
        const val DIAGNOSTIC_FILE = "raw-ppg-saved-evidence-diagnostic-v1.json"

        const val OK = "PPG_SAVED_EVIDENCE_FOUND_DIAGNOSTIC_ONLY"
        const val SPOOL_DIRECTORY_NOT_FOUND = "PPG_SPOOL_DIRECTORY_NOT_FOUND"
        const val SAVED_EVIDENCE_NOT_FOUND = "PPG_SAVED_EVIDENCE_NOT_FOUND"
        const val SPOOL_FOUND_METADATA_MISSING = "PPG_SPOOL_FOUND_METADATA_MISSING"
        const val SPOOL_FOUND_JOURNAL_MISSING = "PPG_SPOOL_FOUND_JOURNAL_MISSING"
        const val JOURNAL_FOUND_SPOOL_MISSING = "PPG_JOURNAL_FOUND_SPOOL_MISSING"
        const val SCOPE_NOT_RESOLVED = "PPG_SCOPE_NOT_RESOLVED"
        const val MULTIPLE_CANDIDATES_AMBIGUOUS = "PPG_MULTIPLE_CANDIDATES_AMBIGUOUS"
        const val SPOOL_TRUNCATED = "PPG_SPOOL_TRUNCATED"
        const val SPOOL_SHAPE_MISMATCH = "PPG_SPOOL_SHAPE_MISMATCH"
        const val SOURCE_CHAIN_INCOMPLETE = "PPG_SOURCE_CHAIN_INCOMPLETE"
        const val INSPECTION_INTERNAL_ERROR = "PPG_INSPECTION_INTERNAL_ERROR"

        val ALL_CODES = listOf(
            SPOOL_DIRECTORY_NOT_FOUND, SAVED_EVIDENCE_NOT_FOUND, SPOOL_FOUND_METADATA_MISSING, SPOOL_FOUND_JOURNAL_MISSING,
            JOURNAL_FOUND_SPOOL_MISSING, SCOPE_NOT_RESOLVED, MULTIPLE_CANDIDATES_AMBIGUOUS, SPOOL_TRUNCATED,
            SPOOL_SHAPE_MISMATCH, SOURCE_CHAIN_INCOMPLETE, INSPECTION_INTERNAL_ERROR,
        )
    }

    private class StageFailure(val code: String, val stage: String, cause: Throwable) : Exception(cause.message, cause)

    fun diagnose(accountId: String?, deviceScopeId: String?, sessionId: String? = null): Map<String, Any?> {
        val d = linkedMapOf<String, Any?>(
            "kind" to "RawPpgSavedEvidenceDiagnostic", "diagnosticVersion" to 1,
            "generatedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
            "status" to "FAILED", "errorCode" to null, "errorMessage" to null, "failureStage" to null,
            "exceptionClass" to null, "findings" to mutableListOf<String>(),
            "scopeResolved" to false, "accountIdResolved" to false, "deviceScopeIdResolved" to false,
            "scopeSource" to "PERSISTED_AUTHENTICATED_ACCOUNT_NOT_LIVE_CAPTURE_SCOPE",
            "requestedSessionId" to sessionId,
            "appFilesDirAccessible" to false, "spoolDirectoryExists" to false, "spoolDirectoryPath" to null,
            "candidateSpoolCount" to 0, "candidateFilenames" to emptyList<String>(), "candidateByteSizes" to emptyList<Long>(),
            "candidateSha256" to emptyList<String>(), "candidates" to emptyList<Any>(),
            "selectedSessionId" to null,
            "rawPpgPacketStoreMetadataExists" to false,
            "historicalRawPpgSessionExists" to false,
            "historicalRawPpgSessionNote" to "RawPpgSession is in-memory only by design; it is not persisted across restart.",
            "journalQueried" to false, "journalRowsAssociatedWithPpgExist" to false,
            "matchingBleNotificationCount" to 0, "matchingSdkCallbackCount" to 0, "matchingCommandRequestCount" to 0,
            "journalPpgSessions" to emptyList<Any>(), "journalPpgSourceFiles" to emptyList<Any>(),
            "completeSourceChainConstructible" to false, "sourceChainMissing" to emptyList<String>(),
            "certificationTransition" to "NONE_DIAGNOSTIC_ONLY",
            "canonicalAuthority" to "NONE_UNTIL_SEMANTICS_CONFIRMED",
            "bleCommandsIssued" to 0, "deviceConnectionsOpened" to 0, "acquisitionsStarted" to 0,
            "networkCalls" to 0, "base44Calls" to 0, "enqueued" to 0, "delivered" to 0, "canonicalized" to 0,
        )
        @Suppress("UNCHECKED_CAST") val findings = d["findings"] as MutableList<String>
        try {
            run(d, findings, accountId, deviceScopeId, sessionId)
        } catch (failure: StageFailure) {
            fail(d, failure.code, failure.stage, failure.cause ?: failure)
        } catch (error: Throwable) {
            fail(d, INSPECTION_INTERNAL_ERROR, d["failureStage"] as? String ?: "UNKNOWN", error)
        }
        return d
    }

    private fun fail(d: MutableMap<String, Any?>, code: String, stage: String, error: Throwable) {
        d["status"] = "FAILED"; d["errorCode"] = code; d["failureStage"] = stage
        d["exceptionClass"] = error.javaClass.name
        d["errorMessage"] = "$code at $stage: ${error.javaClass.simpleName}: ${error.message ?: "(no message)"}"
        @Suppress("UNCHECKED_CAST") (d["findings"] as MutableList<String>).add(code)
    }

    private fun <T> stage(d: MutableMap<String, Any?>, name: String, block: () -> T): T {
        d["failureStage"] = name
        return try { block() } catch (error: Throwable) { throw StageFailure(INSPECTION_INTERNAL_ERROR, name, error) }
    }

    private fun run(d: MutableMap<String, Any?>, findings: MutableList<String>, accountId: String?, deviceScopeId: String?, sessionId: String?) {
        // 0. Scope: persisted authenticated account; deviceScopeId optional. Not required for filesystem stages.
        val accountOk = !accountId.isNullOrBlank() && accountId.length <= 256
        val deviceOk = deviceScopeId != null && deviceScopeId.matches(Regex("[A-Za-z0-9_-]{1,256}"))
        d["accountIdResolved"] = accountOk
        d["deviceScopeIdResolved"] = deviceOk
        d["scopeResolved"] = accountOk
        if (!accountOk) findings += SCOPE_NOT_RESOLVED
        d["historicalRawPpgSessionExists"] = runCatching(historicalSessionInMemory).getOrDefault(false)

        // 1. App-private files directory.
        val dir = stage(d, "RESOLVE_FILES_DIR") { filesDir?.takeIf { it.isDirectory && it.canRead() } }
        d["appFilesDirAccessible"] = dir != null
        if (dir == null) throw StageFailure(INSPECTION_INTERNAL_ERROR, "RESOLVE_FILES_DIR",
            IllegalStateException("App-private files directory is not accessible"))

        // 2. Spool directory.
        val spoolDir = File(dir, RawPpgSavedEvidence.SPOOL_DIR_NAME)
        d["spoolDirectoryPath"] = spoolDir.absolutePath
        val spoolExists = stage(d, "CHECK_SPOOL_DIRECTORY") { spoolDir.isDirectory }
        d["spoolDirectoryExists"] = spoolExists

        // 3 + 4. Candidate files with filename/size/hash, each parsed in isolation.
        val parsed = stage(d, "LIST_SPOOL_CANDIDATES") { RawPpgSavedEvidence.discoverSpoolFiles(dir) }.map { file ->
            file to runCatching { RawPpgSavedEvidence.parseSpool(file) }
        }
        val candidates = parsed.map { (file, result) ->
            result.fold(
                onSuccess = { RawPpgSavedEvidence.candidateSummary(it) + mapOf("magicValid" to it.magicValid, "readError" to null) },
                onFailure = { linkedMapOf("filename" to file.name, "sessionId" to RawPpgSavedEvidence.sessionIdFromFileName(file.name),
                    "byteLength" to file.length(), "sha256" to null,
                    "readError" to "${it.javaClass.name}: ${it.message}") },
            )
        }
        d["candidates"] = candidates
        d["candidateSpoolCount"] = candidates.size
        d["candidateFilenames"] = candidates.map { it["filename"] }
        d["candidateByteSizes"] = candidates.map { it["byteLength"] }
        d["candidateSha256"] = candidates.map { it["sha256"] }

        // 5. Only now: Source Journal correlation (account-filtered, offline; failure must not hide spool facts).
        var census: Map<String, Any?>? = null
        if (accountOk) {
            d["failureStage"] = "JOURNAL_CORRELATION"
            census = try { census(accountId, deviceScopeId.takeIf { deviceOk }) } catch (error: Throwable) {
                d["journalError"] = "${error.javaClass.name}: ${error.message}"
                findings += if ((error as? JCVitalV8SourceJournal.Failure)?.reason == SCOPE_NOT_RESOLVED) SCOPE_NOT_RESOLVED else INSPECTION_INTERNAL_ERROR
                null
            }
            d["journalQueried"] = census != null
        }
        @Suppress("UNCHECKED_CAST") val sessions = (census?.get("ppgSessions") as? List<Map<String, Any?>>).orEmpty()
        @Suppress("UNCHECKED_CAST") val sourceFiles = (census?.get("ppgSourceFiles") as? List<Map<String, Any?>>).orEmpty()
        d["journalPpgSessions"] = sessions.map { it - "notificationSha256" }
        d["journalPpgSourceFiles"] = sourceFiles
        d["journalRowLimitReached"] = census?.get("rowLimitReached") ?: false
        d["rawPpgPacketStoreMetadataExists"] = sourceFiles.isNotEmpty()
        d["journalRowsAssociatedWithPpgExist"] = sessions.isNotEmpty() || sourceFiles.isNotEmpty()

        d["failureStage"] = "CLASSIFY"
        val journalHasPpg = d["journalRowsAssociatedWithPpgExist"] == true
        if (candidates.isEmpty()) {
            findings += when {
                journalHasPpg -> JOURNAL_FOUND_SPOOL_MISSING
                !spoolExists -> SPOOL_DIRECTORY_NOT_FOUND
                else -> SAVED_EVIDENCE_NOT_FOUND
            }
            if (!spoolExists && journalHasPpg) findings += SPOOL_DIRECTORY_NOT_FOUND
            sumCounts(d, sessions)
            return finish(d, findings)
        }

        // Select exactly one candidate; never guess among several.
        val good = parsed.mapNotNull { it.second.getOrNull() }
        val selected = when {
            sessionId != null -> good.filter { it.sessionId == sessionId }
            good.size == 1 -> good
            else -> good.filter { RawPpgSavedEvidence.matchesDocumentedShape(it) }.ifEmpty { good }
        }
        if (selected.size != 1) {
            findings += if (selected.isEmpty()) SAVED_EVIDENCE_NOT_FOUND else MULTIPLE_CANDIDATES_AMBIGUOUS
            sumCounts(d, sessions)
            return finish(d, findings)
        }
        val spool = selected.single()
        d["selectedSessionId"] = spool.sessionId
        if (spool.truncated) findings += SPOOL_TRUNCATED
        else if (!RawPpgSavedEvidence.matchesDocumentedShape(spool)) findings += SPOOL_SHAPE_MISMATCH

        val session = sessions.firstOrNull { it["sessionId"] == spool.sessionId }
        sumCounts(d, listOfNotNull(session))
        val manifest = sourceFiles.firstOrNull { it["path"] == spool.file.absolutePath || it["sessionId"] == spool.sessionId }
        if (accountOk && census != null) {
            if (manifest == null) findings += SPOOL_FOUND_METADATA_MISSING
            if (session == null) findings += SPOOL_FOUND_JOURNAL_MISSING
        }

        val missing = mutableListOf<String>()
        if (spool.truncated) missing += "packetBoundaries"
        if (manifest == null) missing += "spoolManifest"
        if ((session?.get("bleNotificationCount") as? Int ?: 0) == 0) missing += "bleNotificationAncestry"
        @Suppress("UNCHECKED_CAST")
        val notified = (session?.get("notificationSha256") as? List<String>).orEmpty().toSet()
        val unmatched = spool.packets.count { it.sha256Hex !in notified }
        d["packetsWithoutMatchingNotification"] = unmatched
        if (session != null && unmatched > 0) missing += "packetToNotificationHashLinkage"
        if ((d["matchingSdkCallbackCount"] as Int) == 0) missing += "sdkCallbackAncestry"
        if ((d["matchingCommandRequestCount"] as Int) == 0) missing += "commandRequestAncestry"
        d["sourceChainMissing"] = missing
        d["completeSourceChainConstructible"] = missing.isEmpty()
        if (missing.isNotEmpty() && findings.none { it in listOf(SPOOL_FOUND_METADATA_MISSING, SPOOL_FOUND_JOURNAL_MISSING) }) {
            findings += SOURCE_CHAIN_INCOMPLETE
        }
        finish(d, findings)
    }

    private fun sumCounts(d: MutableMap<String, Any?>, sessions: List<Map<String, Any?>>) {
        fun sum(key: String) = sessions.sumOf { it[key] as? Int ?: 0 }
        d["matchingBleNotificationCount"] = sum("bleNotificationCount")
        d["matchingSdkCallbackCount"] = sum("sdkByteCallbackCount") + sum("sdkMapCallbackCount") + sum("sdkParseOutcomeCount")
        d["matchingCommandRequestCount"] = sum("commandRequestCount")
    }

    private fun finish(d: MutableMap<String, Any?>, findings: MutableList<String>) {
        val distinct = findings.distinct()
        findings.clear(); findings.addAll(distinct)
        // Precedence: the first finding is the primary errorCode; all findings remain listed.
        val priority = listOf(
            INSPECTION_INTERNAL_ERROR, SCOPE_NOT_RESOLVED, MULTIPLE_CANDIDATES_AMBIGUOUS, JOURNAL_FOUND_SPOOL_MISSING,
            SPOOL_DIRECTORY_NOT_FOUND, SAVED_EVIDENCE_NOT_FOUND, SPOOL_TRUNCATED, SPOOL_SHAPE_MISMATCH,
            SPOOL_FOUND_METADATA_MISSING, SPOOL_FOUND_JOURNAL_MISSING, SOURCE_CHAIN_INCOMPLETE,
        )
        val primary = priority.firstOrNull { it in findings }
        if (primary == null) {
            d["status"] = "OK"; d["errorCode"] = OK; d["errorMessage"] = null; d["failureStage"] = null
        } else {
            d["status"] = "FAILED"; d["errorCode"] = primary
            d["failureStage"] = when (primary) {
                SCOPE_NOT_RESOLVED -> "RESOLVE_SCOPE"
                SPOOL_DIRECTORY_NOT_FOUND -> "CHECK_SPOOL_DIRECTORY"
                SAVED_EVIDENCE_NOT_FOUND, MULTIPLE_CANDIDATES_AMBIGUOUS, SPOOL_TRUNCATED, SPOOL_SHAPE_MISMATCH -> "LIST_SPOOL_CANDIDATES"
                else -> "JOURNAL_CORRELATION"
            }
            val detail = if (primary == INSPECTION_INTERNAL_ERROR) " journalError=${d["journalError"]}" else ""
            d["errorMessage"] = "$primary (findings: ${findings.joinToString(", ")})$detail"
        }
    }

    /** org.json drops null map values; keep explicit nulls so every diagnostic field is always present. */
    private fun json(value: Any?): Any = when (value) {
        null -> JSONObject.NULL
        is Map<*, *> -> JSONObject().also { obj -> value.forEach { (k, v) -> obj.put(k.toString(), json(v)) } }
        is Iterable<*> -> org.json.JSONArray().also { arr -> value.forEach { arr.put(json(it)) } }
        else -> value
    }

    fun toJsonString(diagnostic: Map<String, Any?>): String = (json(diagnostic) as JSONObject).toString(2)

    /** Persists the snapshot locally (temp + rename). Returns null on success, or the persistence error. */
    fun persist(diagnostic: Map<String, Any?>): String? = try {
        val dir = File(filesDir ?: error("filesDir unavailable"), DIAGNOSTIC_DIR)
        check(dir.isDirectory || dir.mkdirs()) { "Could not create $DIAGNOSTIC_DIR" }
        val temp = File(dir, "$DIAGNOSTIC_FILE.tmp")
        temp.writeText(toJsonString(diagnostic), Charsets.UTF_8)
        val target = File(dir, DIAGNOSTIC_FILE)
        check(temp.renameTo(target)) { "Could not commit diagnostic snapshot" }
        null
    } catch (error: Throwable) {
        "${error.javaClass.name}: ${error.message}"
    }

    fun readPersisted(): String? = runCatching {
        File(File(filesDir, DIAGNOSTIC_DIR), DIAGNOSTIC_FILE).takeIf { it.isFile }?.readText(Charsets.UTF_8)
    }.getOrNull()
}
