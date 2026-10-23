package com.hapi.eliteplus.connector.jcvital

import java.io.File

/**
 * Orchestrates offline inspection/export/certification of already-persisted Raw PPG evidence.
 *
 * Every public function here reads only from app-private storage: the length-prefixed spool file
 * under files/jcvital-source-spool and the independent Source Envelope Journal (SQLite). None of
 * them open a GATT connection, write a BLE characteristic, enqueue a delivery, call Base44, or
 * perform canonicalization. They are safe to call before, during (read-only), or after app restart.
 */
internal class RawPpgSavedEvidenceInspector(
    private val filesDir: File,
    private val sourceJournal: JCVitalV8SourceJournal,
    historicalSessionInMemory: () -> Boolean = { false },
) {
    /** Coded failure that survives the Capacitor bridge as `error.code`. */
    open class CodedException(val code: String, message: String) : IllegalStateException(message)

    class MissingEvidenceException(val missing: List<String>) :
        CodedException(RawPpgSavedEvidenceDiagnostic.SAVED_EVIDENCE_NOT_FOUND,
            "${RawPpgSavedEvidenceDiagnostic.SAVED_EVIDENCE_NOT_FOUND}: missing ${missing.joinToString(",")}")

    val diagnostic = RawPpgSavedEvidenceDiagnostic(filesDir, sourceJournal::ppgEvidenceCensus, historicalSessionInMemory)

    /**
     * VC28: runs the offline diagnostic (filesystem first, then journal), persists the snapshot whether it
     * succeeds or fails, and returns it. Never throws for evidence problems; status/errorCode carry the result.
     */
    fun inspect(accountId: String?, deviceScopeId: String?, sessionId: String? = null): Map<String, Any?> {
        val result = diagnostic.diagnose(accountId, deviceScopeId, sessionId).toMutableMap()
        val candidates = (result["candidates"] as? List<*>).orEmpty().filterIsInstance<Map<*, *>>()
        val exact = candidates.filter { it["matchesDocumentedShape"] == true }
        result["operation"] = "INSPECT_EXISTING_RAW_PPG_EVIDENCE"
        result["candidateCount"] = candidates.size
        result["exactDocumentedShapeMatchCount"] = exact.size
        result["recommendedSessionId"] = exact.singleOrNull()?.get("sessionId")
        result["found"] = candidates.isNotEmpty()
        result["diagnosticPersistenceError"] = diagnostic.persist(result)
        return result
    }

    fun readPersistedDiagnostic(): Map<String, Any?> = mapOf("json" to diagnostic.readPersisted())

    /** Builds the complete, lossless certification-evidence JSON for one exact spool file. */
    fun export(accountId: String?, deviceScopeId: String?, sessionId: String?): Map<String, Any?> {
        val allFiles = RawPpgSavedEvidence.discoverSpoolFiles(filesDir)
        if (allFiles.isEmpty()) throw MissingEvidenceException(listOf("spool", "completeRawBytes", "sourceJournal", "callbackAncestry", "commandAncestry", "packetBoundaries"))
        val parsedAll = allFiles.map { RawPpgSavedEvidence.parseSpool(it) }
        val selected = when {
            sessionId != null -> parsedAll.filter { it.sessionId == sessionId }
            else -> parsedAll.filter { RawPpgSavedEvidence.matchesDocumentedShape(it) }
        }
        if (selected.isEmpty()) throw CodedException(RawPpgSavedEvidenceDiagnostic.SAVED_EVIDENCE_NOT_FOUND,
            "${RawPpgSavedEvidenceDiagnostic.SAVED_EVIDENCE_NOT_FOUND}: no spool matches ${sessionId ?: "the documented 20-packet/~3774-byte shape"}")
        if (selected.size != 1) throw CodedException(RawPpgSavedEvidenceDiagnostic.MULTIPLE_CANDIDATES_AMBIGUOUS,
            "${RawPpgSavedEvidenceDiagnostic.MULTIPLE_CANDIDATES_AMBIGUOUS}: ${selected.size} candidates match; an exact sessionId is required (" +
                selected.mapNotNull { it.sessionId }.joinToString(", ") + ")")
        return buildEvidence(accountId, deviceScopeId, selected.single())
    }

    private fun buildEvidence(accountId: String?, deviceScopeId: String?, parsed: RawPpgSavedEvidence.SpoolParseResult): Map<String, Any?> {
        val missing = mutableListOf<String>()
        if (parsed.truncated) missing += "packetBoundaries"
        val sessionId = parsed.sessionId
        val sourceFiles = sessionId?.let {
            runCatching { sourceJournal.sourceFilesForSession(accountId, deviceScopeId, it) }.getOrDefault(emptyList())
        } ?: emptyList()
        if (sourceFiles.isEmpty()) missing += "sourceJournal"
        val notificationEnvelopes = sessionId?.let {
            runCatching { sourceJournal.rawNotificationEnvelopesForSession(accountId, deviceScopeId, it) }.getOrDefault(emptyList())
        } ?: emptyList()
        if (notificationEnvelopes.isEmpty()) missing += "callbackAncestry"
        val envelopesBySha = notificationEnvelopes.groupBy { it["sha256"] as? String }

        val packets = parsed.packets.map { packet ->
            val ancestry = envelopesBySha[packet.sha256Hex]?.firstOrNull()
            linkedMapOf(
                "index" to packet.index,
                "byteLength" to packet.byteLength,
                "sha256" to packet.sha256Hex,
                "opcode" to "0x%02X".format(packet.opcode),
                "dataTypeClassification" to when (packet.opcode) {
                    RawPpgSavedEvidence.OPCODE_DATA -> "DATA_PACKET"
                    RawPpgSavedEvidence.OPCODE_STATUS -> "STATUS_PACKET"
                    else -> "UNKNOWN_OPCODE"
                },
                "spoolRange" to linkedMapOf(
                    "lengthPrefixOffset" to packet.lengthPrefixOffset,
                    "payloadOffset" to packet.payloadOffset,
                    "payloadEndOffsetExclusive" to packet.payloadOffset + packet.byteLength,
                ),
                "trailerByte" to linkedMapOf(
                    "offsetWithinPayload" to (packet.byteLength - 1),
                    "checksumAlgorithm" to RawPpgSavedEvidence.CHECKSUM_ALGORITHM_NOT_PROVEN,
                ),
                "sampleMeaning" to "NOT_INFERRED_FROM_BYTE_POSITION",
                "base64" to packet.base64,
                "sourceEnvelopeAncestry" to (ancestry ?: linkedMapOf(
                    "status" to "NOT_FOUND_IN_JOURNAL_RETENTION_WINDOW",
                )),
            )
        }
        val structureConfirmed = RawPpgSavedEvidence.matchesDocumentedShape(parsed)

        val packetOrdering = "SEQUENTIAL_BY_SPOOL_APPEND_ORDER_INDEX_0_BASED"
        val sourceFile = sourceFiles.firstOrNull()
        val state = if (!parsed.truncated && structureConfirmed && sourceFile != null && notificationEnvelopes.isNotEmpty()) "CERTIFIED" else "NOT_CERTIFIED"

        return linkedMapOf(
            "kind" to "RawPpgSavedCertification",
            "context" to linkedMapOf("scope" to linkedMapOf("accountId" to accountId, "deviceScopeId" to deviceScopeId)),
            "certificationGroupId" to "RawPpgSavedEvidence:${sessionId ?: parsed.file.name}",
            "sessionId" to sessionId,
            "deviceIdentity" to linkedMapOf(
                "deviceModel" to (notificationEnvelopes.firstOrNull()?.get("deviceModel") ?: "UNKNOWN"),
                "characteristicUuid" to notificationEnvelopes.firstOrNull()?.get("characteristicUuid"),
            ),
            "firmwareVersion" to notificationEnvelopes.firstOrNull()?.get("firmwareVersion"),
            "sdkVersion" to (notificationEnvelopes.firstOrNull()?.get("sdkVersion") ?: JCVitalV8EventNormalizer.SDK_VERSION),
            "sourceSpool" to linkedMapOf(
                "filename" to parsed.file.name,
                "path" to parsed.file.absolutePath,
                "byteLength" to parsed.fileByteLength,
                "sha256" to parsed.fileSha256Hex,
                "byteEncoding" to RawPpgSavedEvidence.BYTE_ENCODING,
                "truncated" to parsed.truncated,
                "truncationOffset" to parsed.truncationOffset,
            ),
            "packetCount" to parsed.packets.size,
            "packetOrdering" to packetOrdering,
            "packets" to packets,
            "structuralConfirmation" to linkedMapOf(
                "expectedShapeConfirmed" to structureConfirmed,
                "expectedPacketCount" to RawPpgSavedEvidence.EXPECTED_PACKET_COUNT,
                "expectedDataPackets" to "${RawPpgSavedEvidence.EXPECTED_DATA_PACKET_COUNT}x${RawPpgSavedEvidence.EXPECTED_DATA_PACKET_LENGTH}",
                "expectedStatusPackets" to "${RawPpgSavedEvidence.EXPECTED_STATUS_PACKET_COUNT}x${RawPpgSavedEvidence.EXPECTED_STATUS_PACKET_LENGTH}",
                "expectedSpoolBytes" to RawPpgSavedEvidence.EXPECTED_SPOOL_BYTES,
                "actualDataPacketCount" to parsed.packets.count { it.byteLength == RawPpgSavedEvidence.EXPECTED_DATA_PACKET_LENGTH },
                "actualStatusPacketCount" to parsed.packets.count { it.byteLength == RawPpgSavedEvidence.EXPECTED_STATUS_PACKET_LENGTH },
            ),
            "sdkInterpretedSampleArray" to linkedMapOf(
                "emitted" to true,
                "channel" to "SDK_CALLBACK_MAP_DATATYPE_119_FIELD_PPG",
                "note" to "Interpreted samples arrive via a separate vendor Map callback (dataType=119, field PPG); " +
                    "they are not persisted byte-for-byte inside this raw notification spool.",
            ),
            "sampling" to linkedMapOf("sampleRateHz" to null, "samplingIntervalMs" to null),
            "unit" to "UNKNOWN_VENDOR_UNIT",
            "glucoseIsolation" to linkedMapOf(
                "RAW_PPG_NOT_GLUCOSE" to true,
                "NO_GLUCOSE_CANONICAL_MAPPING" to true,
                "NO_GLUCOSE_INFERENCE" to true,
                "NO_CGM_SUBSTITUTION" to true,
                "vendorLabelDisclaimer" to "Vendor opcode names (e.g. \"Bloodsugar\") are preserved as unvalidated vendor metadata only.",
            ),
            "sourceEnvelopeJournal" to linkedMapOf(
                "sourceFiles" to sourceFiles,
                "notificationEnvelopeCount" to notificationEnvelopes.size,
                "notificationEnvelopes" to notificationEnvelopes,
            ),
            "commandAncestry" to linkedMapOf(
                "statusOpcodeHex" to "0x%02X".format(RawPpgSavedEvidence.OPCODE_STATUS),
                "dataOpcodeHex" to "0x%02X".format(RawPpgSavedEvidence.OPCODE_DATA),
                "vendorConstantNames" to linkedMapOf(
                    "statusOpcode" to "DeviceConst.CMD_Get_Bloodsugar",
                    "dataOpcode" to "DeviceConst.Bloodsugar_data",
                ),
            ),
            "noTruncationRewriteOrNormalization" to true,
            "state" to state,
            "missingEvidence" to missing,
            "sourceStatus" to if (state == "CERTIFIED") "CERTIFIED_E2E_LOSSLESS_SOURCE" else null,
            "semanticClassification" to if (state == "CERTIFIED") "RESEARCH_NATIVE_ONLY" else null,
            "canonicalAuthority" to "NONE_UNTIL_SEMANTICS_CONFIRMED",
            "deliveryDisposition" to "LOCAL_SOURCE_EVIDENCE_ONLY",
            "base44DeliveryRequired" to false,
            "generatedAt" to JCVitalV8Time.isoUtc(System.currentTimeMillis()),
        )
    }

    /** Persists the CERTIFIED evidence JSON so it survives app restart; requires state==CERTIFIED. */
    fun finalize(accountId: String?, deviceScopeId: String?, sessionId: String?): Map<String, Any?> {
        val evidence = export(accountId, deviceScopeId, sessionId)
        require(evidence["state"] == "CERTIFIED") {
            "PPG_SAVED_EVIDENCE_NOT_CERTIFIABLE: " + (evidence["missingEvidence"] as? List<*> ?: emptyList<Any>()).joinToString(",")
        }
        val json = org.json.JSONObject(evidence).toString()
        sourceJournal.writeRawPpgCertification(accountId, deviceScopeId, json)
        return evidence
    }

    fun readFinalized(accountId: String?, deviceScopeId: String?): Map<String, Any?> =
        sourceJournal.readRawPpgCertification(accountId, deviceScopeId)
}
