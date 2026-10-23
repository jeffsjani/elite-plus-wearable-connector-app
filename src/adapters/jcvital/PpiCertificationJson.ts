import { CertificationExportError, serializeCertificationJson } from './CertificationJsonExport'
import { sha256Hex } from './HeartRateSeries'
import { type PpiCertification, type PpiCertificationInspection } from './PpiCertification'

export const NO_PPI_CERTIFICATION_GROUP_AVAILABLE = 'NO_PPI_CERTIFICATION_GROUP_AVAILABLE'

export interface PpiCertificationJson {
  json: string
  characterCount: number
  sha256: string
}

export async function readPpiCertificationJson(
  service: Pick<PpiCertification, 'hasSavedEvidence' | 'inspectSaved' | 'exportBody'>,
  current?: PpiCertificationInspection | null,
): Promise<PpiCertificationJson> {
  if (!current && !service.hasSavedEvidence()) {
    throw new CertificationExportError('SNAPSHOT_READ', new Error(NO_PPI_CERTIFICATION_GROUP_AVAILABLE))
  }
  const inspection = current ?? await service.inspectSaved()
  if (!inspection.group && !inspection.diagnostic) {
    throw new CertificationExportError('SNAPSHOT_READ', new Error(NO_PPI_CERTIFICATION_GROUP_AVAILABLE))
  }
  const json = serializeCertificationJson(service.exportBody(inspection))
  return { json, characterCount: json.length, sha256: await sha256Hex(json) }
}

export function ppiSnapshotSavedStatus(inspection: PpiCertificationInspection, key: string, jsonAvailable: boolean): string {
  if (!inspection.group) throw new Error(NO_PPI_CERTIFICATION_GROUP_AVAILABLE)
  return `PPI CERTIFICATION SNAPSHOT SAVED\ncertificationGroupId: ${inspection.group.certificationGroupId}`
    + `\nsourceEnvelopeId: ${inspection.group.sourceEnvelopeId}\nsnapshot storage key: ${key}`
    + `\nselected child count: ${inspection.group.children.length}\ndelivered child count: ${inspection.delivered}`
    + `\nJSON available = ${jsonAvailable}`
}

export async function copyPpiCertificationJson(
  evidence: PpiCertificationJson,
  clipboard?: Pick<Clipboard, 'writeText'>,
): Promise<string> {
  try {
    const availableClipboard = clipboard ?? globalThis.navigator?.clipboard
    if (!availableClipboard) throw new Error('Clipboard API unavailable.')
    await availableClipboard.writeText(evidence.json)
    return 'PPI CERTIFICATION JSON COPIED'
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return `PPI CERTIFICATION JSON COPY FAILED: ${message}. Full JSON remains visible; use Select All and Copy manually.`
  }
}
