import { describe, expect, it } from 'vitest'
import {
  beginActivityV2VerificationAttempt,
  completeActivityV2VerificationAttempt,
} from './ActivityV2VerificationAttempt'

describe('saved Activity v2 verification attempt identity', () => {
  it('allows one attempt and blocks a repeat press without replacing its source scope', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    const sources = { type24: 'saved-day-envelope', type25: 'saved-segment-envelope' }

    expect(beginActivityV2VerificationAttempt(storage, 'scope', sources)).toBe(true)
    const first = values.get('scope')
    expect(beginActivityV2VerificationAttempt(storage, 'scope', sources)).toBe(false)
    expect(values.get('scope')).toBe(first)
    expect(JSON.parse(first!).sourceEnvelopeIds).toEqual(sources)
  })

  it('retains the completed report for later presses instead of resending', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value) },
    }
    beginActivityV2VerificationAttempt(storage, 'scope', { type24: 'day', type25: 'segment' })
    completeActivityV2VerificationAttempt(storage, 'scope', '{"acknowledged":14}')
    expect(JSON.parse(values.get('scope')!)).toEqual({ state: 'COMPLETE', report: '{"acknowledged":14}' })
    expect(beginActivityV2VerificationAttempt(storage, 'scope', { type24: 'day', type25: 'segment' })).toBe(false)
  })
})
