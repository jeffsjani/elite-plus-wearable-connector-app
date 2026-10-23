import { describe, expect, it } from 'vitest'
import { fixture, DEVICE } from './PpiCertification.fixture'
import { PPI_CERTIFICATION_SUCCESS } from './PpiCertification'
import { PpiCertificationAttempt, ppiAttemptKey } from './PpiCertificationAttempt'
import { PpiCertificationResume } from './PpiCertificationResume'

const OWNER = 'user-1'

/** Drives a normal live certification with a wired attempt diagnostic, persisting it like the real app would. */
async function runLiveCertification(f: Awaited<ReturnType<typeof fixture>>) {
  const attempt = new PpiCertificationAttempt(f.deps.storage)
  attempt.start(OWNER, DEVICE, null)
  const { PpiCertification } = await import('./PpiCertification')
  const live = new PpiCertification({ ...f.deps, attemptEvent: (stage, status, details, error) => attempt.event(stage, status, details, error) })
  await live.capture()
  const result = await live.flushSaved()
  attempt.finish(result.status)
  return result
}

function certificationKey() {
  return `elitePlus.ppiCertification.v1.${encodeURIComponent(OWNER)}.${encodeURIComponent(DEVICE)}`
}

describe('VC15 Resume PPI Certification From Last Physical Attempt (read-only replay, zero acquisition)', () => {
  it('resumes successfully from the persisted attempt with zero syncHistoricalPpi()/BLE acquisition calls', async () => {
    const f = await fixture()
    const live = await runLiveCertification(f)
    expect(live.status).toBe(PPI_CERTIFICATION_SUCCESS)
    const acquireCallsBeforeResume = f.acquire.mock.calls.length
    // Drop only the certification snapshot so resume cannot short-circuit via EXISTING_SNAPSHOT_LOOKUP;
    // the persisted attempt diagnostic (a different storage key) is left intact.
    f.storageRows.delete(certificationKey())

    const resume = new PpiCertificationResume({ ...f.deps })
    const result = await resume.resume()

    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    expect(f.acquire.mock.calls.length).toBe(acquireCallsBeforeResume)
    expect(resume.operationCounts()).toEqual({ syncHistoricalPpiCalls: 0, bleHistoryAcquisitions: 0 })
  })

  it('reuses the existing journal ancestry (reads the same durable envelopes, never fabricates source data)', async () => {
    const f = await fixture()
    await runLiveCertification(f)
    f.storageRows.delete(certificationKey())
    f.readSourceEnvelope.mockClear()

    const resume = new PpiCertificationResume({ ...f.deps })
    const result = await resume.resume()

    expect(result.status).toBe(PPI_CERTIFICATION_SUCCESS)
    const readIds = f.readSourceEnvelope.mock.calls.map((call) => call[0].envelopeId)
    expect(readIds).toEqual(expect.arrayContaining(['record-1', 'record-1-callback', 'record-1-ble']))
  })

  it('produces the same child/NativeObservation IDs as the normal successful certification path', async () => {
    const f = await fixture()
    const live = await runLiveCertification(f)
    const liveIds = live.group!.children.map((child) => child.observationId).sort()
    f.storageRows.delete(certificationKey())

    const resume = new PpiCertificationResume({ ...f.deps })
    const result = await resume.resume()
    const resumedIds = result.group!.children.map((child) => child.observationId).sort()

    expect(resumedIds).toEqual(liveIds)
    expect(resumedIds.length).toBeGreaterThan(0)
  })

  it('selects the same deterministic first-valid source group as a normal certification would, without hard-coding it', async () => {
    const f = await fixture()
    f.sync.observations.push(f.addGroup('record-2').native)
    const live = await runLiveCertification(f)
    expect(live.group?.sourceEnvelopeId).toBe('record-1')
    f.storageRows.delete(certificationKey())

    const resume = new PpiCertificationResume({ ...f.deps })
    const result = await resume.resume()

    expect(result.group?.sourceEnvelopeId).toBe(live.group?.sourceEnvelopeId)
  })

  it('delivers only the selected exact child IDs through the existing certification sender', async () => {
    const f = await fixture()
    const live = await runLiveCertification(f)
    const liveIds = live.group!.children.map((child) => child.observationId).sort()
    f.storageRows.delete(certificationKey())
    f.flush.mockClear()

    const resume = new PpiCertificationResume({ ...f.deps })
    await resume.resume()

    const flushedIds = (f.flush.mock.calls.at(-1)?.[0] as readonly string[]).slice().sort()
    expect(flushedIds).toEqual(liveIds)
  })

  it('fails clearly when no last PPI attempt diagnostic is available, without acquiring anything', async () => {
    const f = await fixture()
    const resume = new PpiCertificationResume({ ...f.deps })
    await expect(resume.resume()).rejects.toThrow()
    expect(f.acquire.mock.calls.length).toBe(0)
  })

  it('exposes the last attempt diagnostic read-only, without side effects', async () => {
    const f = await fixture()
    await runLiveCertification(f)
    const resume = new PpiCertificationResume({ ...f.deps })
    const record = resume.readLastAttempt(OWNER, DEVICE)
    expect(record.accountId).toBe(OWNER)
    expect(record.deviceScopeId).toBe(DEVICE)
    expect(f.acquire.mock.calls.length).toBe(1)
  })
})

describe('VC15 Resume: stored attempt key is namespaced separately from certification evidence', () => {
  it('uses the attempt key format elitePlus.ppiCertificationAttempt.v1.<owner>.<device>', () => {
    expect(ppiAttemptKey(OWNER, DEVICE)).toBe(`elitePlus.ppiCertificationAttempt.v1.${encodeURIComponent(OWNER)}.${encodeURIComponent(DEVICE)}`)
  })
})
