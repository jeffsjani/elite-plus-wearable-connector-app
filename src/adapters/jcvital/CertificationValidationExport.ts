import { buildJCVitalCertification, CERTIFICATION_ORDER, sanitizeCertificationExport, type CertificationOptions } from './JCVitalCertification'
import { buildPhase3AValidationReport } from './Phase3AValidation'

export const CERTIFICATION_BUILD = Object.freeze({
  enabled: true,
  schemaVersion: 'jcvital-certification-v1',
  baselineCommit: '4e31a1c0476fdad49ef853e4b53273d55fd457c6',
  expectedBase44Revision: 'nc-observations-5b1-results-2026-10-03-r4',
})

type ReportOptions = Omit<Parameters<typeof buildPhase3AValidationReport>[0], 'jcvitalCertification'>
type EvidenceOptions = Omit<CertificationOptions, 'historicalRuns'>

/** The UI's single export path: certification is mandatory for both native share and browser download. */
export async function buildCertificationValidationExport(report: ReportOptions, evidence: EvidenceOptions) {
  const jcvitalCertification = await buildJCVitalCertification({ ...evidence, historicalRuns: report.historicalRuns })
  return {
    ...buildPhase3AValidationReport({ ...report, jcvitalCertification }),
    certificationBuild: CERTIFICATION_BUILD,
    jcvitalCertification,
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : null
}

/** Fail explicitly before saving/sharing rather than exporting an incomplete success-shaped report. */
export function serializeCertificationValidationExport(payload: unknown): string {
  const sanitized = sanitizeCertificationExport(payload)
  const report = object(sanitized)
  const marker = object(report?.certificationBuild)
  if (!marker || Object.entries(CERTIFICATION_BUILD).some(([key, expected]) => marker[key] !== expected)) {
    throw new Error('Certification export is missing or has an invalid certificationBuild marker. No JSON was saved.')
  }
  const certification = object(report?.jcvitalCertification)
  for (const metric of CERTIFICATION_ORDER) {
    if (!object(certification?.[metric])) {
      throw new Error(`Certification export is missing jcvitalCertification.${metric}. No JSON was saved.`)
    }
  }
  return JSON.stringify(sanitized, null, 2)
}
