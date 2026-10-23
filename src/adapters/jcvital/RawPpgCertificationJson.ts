import { CertificationExportError, exportStage, saveValidationJson, serializeCertificationJson } from './CertificationJsonExport'
import { assertNoGlucoseMapping, concatenatePacketPayloadsBase64, isCertifiedLosslessSource } from './RawPpgSavedEvidence'
import type { RawPpgSavedEvidenceCertification } from './jcvitalV8Bridge'

export const RAW_PPG_CERTIFICATION_FILENAME = 'JCVital Raw PPG saved-evidence certification.json'
export const RAW_PPG_SPOOL_BINARY_FILENAME = 'JCVital Raw PPG saved-evidence spool.bin'

/** Builds and validates the targeted PPG certification JSON; refuses to export evidence with a glucose-mapping violation. */
export function buildRawPpgCertificationJson(evidence: RawPpgSavedEvidenceCertification): string {
  assertNoGlucoseMapping(evidence)
  return serializeCertificationJson(evidence)
}

export async function exportRawPpgCertificationFile(evidence: RawPpgSavedEvidenceCertification): Promise<string> {
  const json = buildRawPpgCertificationJson(evidence)
  return saveValidationJson(RAW_PPG_CERTIFICATION_FILENAME, json, 'JCVital Raw PPG saved-evidence certification',
    'Save or share the complete lossless Raw PPG saved-evidence certification')
}

/** Separately shareable .bin containing the exact concatenated packet payload bytes (no length prefixes). */
export async function exportRawPpgSpoolBinaryFile(evidence: RawPpgSavedEvidenceCertification): Promise<string> {
  assertNoGlucoseMapping(evidence)
  const base64 = await exportStage('JSON_SERIALIZATION', () => concatenatePacketPayloadsBase64(evidence))
  return saveValidationJson(RAW_PPG_SPOOL_BINARY_FILENAME.replace('.bin', '.bin.base64.txt'), base64,
    'JCVital Raw PPG saved-evidence spool bytes (base64)', 'Save or share the raw spool bytes (base64-encoded .bin content)')
}

export function requireCertifiedBeforeExport(evidence: RawPpgSavedEvidenceCertification): void {
  if (!isCertifiedLosslessSource(evidence)) {
    throw new CertificationExportError('EVIDENCE_VALIDATION', new Error(
      `PPG_SAVED_EVIDENCE_NOT_CERTIFIABLE: state=${evidence.state} missingEvidence=${evidence.missingEvidence.join(',')}`,
    ))
  }
}
