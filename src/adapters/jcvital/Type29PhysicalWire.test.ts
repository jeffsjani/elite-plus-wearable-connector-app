import { describe, expect, it } from 'vitest'
import { decodeType29PhysicalPacket, decodeType29VendorFields, VC25_WORKOUT_CAPTURE, wireSha256 } from './Type29PhysicalWire'
import { VC25_SDK_RECORDS_ORIGINAL, vc25PhysicalBytes } from './Type29PhysicalWire.fixture'

describe('exact VC25 physical 80-byte regression fixture', () => {
  it('preserves 3 x 26 bytes and exact terminal, packet/frame hashes and aligned SDK anchor', async () => {
    const bytes = vc25PhysicalBytes(), original = bytes.slice()
    expect(bytes.length).toBe(80)
    const packet = await decodeType29PhysicalPacket(bytes)
    expect(packet.packetSha256).toBe(VC25_WORKOUT_CAPTURE.packetSha256)
    expect(packet.rawBytesBase64).toBe(VC25_WORKOUT_CAPTURE.packetBase64)
    expect(packet.terminal).toEqual({ byteOffset: 78, hex: '5C FF' })
    expect(packet.records.map((r) => [r.byteOffset, r.byteLength, r.recordIndex])).toEqual([[0, 26, 0], [26, 26, 1], [52, 26, 2]])
    expect(packet.records[0].fields).toEqual(VC25_SDK_RECORDS_ORIGINAL[0])
    expect(packet.records[0].exactFloat32).toEqual({ calories: 65.4618911743164, distance: 0 })
    for (const record of packet.records) {
      const frame = bytes.slice(record.byteOffset, record.byteOffset + 26)
      expect(record.sha256).toBe(await wireSha256(frame))
      expect(Uint8Array.from(atob(record.rawBytesBase64), (c) => c.charCodeAt(0))).toEqual(frame)
      expect(record.checksumValidation).toBe('NOT_PROVEN_NOT_CLAIMED')
    }
    expect(bytes).toEqual(original)
  })
  it('decodes records 1 and 2 independently with exact float32 values and conservative semantics', async () => {
    const { records } = await decodeType29PhysicalPacket(vc25PhysicalBytes())
    expect(records[1].fields).toEqual({ date: '2026.09.15 16:15:45', sportModel: '0', heartRate: '116',
      ExerciseTime: '472', step: '201', sportModelSpeed: '62\'32"', calories: '20.4', distance: '0.13' })
    expect(records[2].fields).toEqual({ date: '2026.09.14 15:24:10', sportModel: '9', heartRate: '110',
      ExerciseTime: '600', step: '536', sportModelSpeed: '00\'00"', calories: '16.7', distance: '0' })
    expect(records[1].exactFloat32).toEqual({ calories: 20.402727127075195, distance: 0.12578701972961426 })
    expect(records[2].exactFloat32).toEqual({ calories: 16.65451431274414, distance: 0 })
    expect(records.map((r) => r.trailerByte)).toEqual([0x4e, 0xde, 0x1d])
    expect(records.every((r) => r.semanticClassification === 'RESEARCH_NATIVE_ONLY'
      && r.canonicalAuthority === 'NONE_UNTIL_SEMANTICS_CONFIRMED')).toBe(true)
  })
  it('25-byte stride reproduces every captured corrupt SDK field and misses the real end marker', () => {
    const bytes = vc25PhysicalBytes()
    expect([0, 1, 2].map((i) => decodeType29VendorFields(bytes, i * 25).fields)).toEqual(VC25_SDK_RECORDS_ORIGINAL)
    expect(bytes[1 + 3 * 25]).toBe(0)
    expect(bytes[79]).toBe(255)
  })
  it.each([
    ['missing terminal', (b: Uint8Array) => b.slice(0, 78)],
    ['truncated frame', (b: Uint8Array) => Uint8Array.from([...b.slice(0, 77), 0x5c, 0xff])],
    ['extra byte', (b: Uint8Array) => Uint8Array.from([...b.slice(0, 78), 0, 0x5c, 0xff])],
    ['wrong opcode', (b: Uint8Array) => { b[26] = 0x5d; return b }],
    ['wrong sequence', (b: Uint8Array) => { b[53] = 3; return b }],
    ['wrong high index byte', (b: Uint8Array) => { b[28] = 1; return b }],
  ])('fails %s explicitly', async (_, mutate) => {
    await expect(decodeType29PhysicalPacket(mutate(vc25PhysicalBytes()))).rejects.toThrow('TYPE29_')
  })
})
