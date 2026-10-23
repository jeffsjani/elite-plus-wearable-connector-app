// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyPhysicalResultJson, savePhysicalResultJson } from './PhysicalResultExport'
import { saveValidationJson } from './CertificationJsonExport'

vi.mock('./CertificationJsonExport', () => ({ saveValidationJson: vi.fn(async () => 'saved') }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('physical result export guards', () => {
  it('hard-fails empty JSON before clipboard or filesystem access', async () => {
    const write = vi.fn()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: write } })
    await expect(copyPhysicalResultJson('')).rejects.toThrow('RESULT_JSON_EMPTY')
    await expect(savePhysicalResultJson('test.json', '', 'activity')).rejects.toThrow('RESULT_JSON_EMPTY')
    expect(write).not.toHaveBeenCalled()
    expect(saveValidationJson).not.toHaveBeenCalled()
  })

  it('bounds a WebView clipboard write that never settles rather than claiming success', async () => {
    vi.useFakeTimers()
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: () => new Promise(() => {}) } })
    const result = expect(copyPhysicalResultJson('{"complete":true}')).rejects.toThrow('CLIPBOARD_TIMEOUT')
    await vi.advanceTimersByTimeAsync(2000)
    await result
  })
})
