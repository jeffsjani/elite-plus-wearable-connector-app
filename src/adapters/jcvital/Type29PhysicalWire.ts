export const VC25_WORKOUT_CAPTURE = {
  certificationGroupId: '8bf28f13-6a62-4874-8f46-dbfd9e36394f',
  sessionId: '3c6fa4f3-69fe-4509-9812-987b1b48d063',
  packetBase64: 'XAAAJgkVFiNJAH3CBRIBAAB97IJCAAAAAE5cAQAmCRUWFUUAdNgByQA+IMk4o0FQzgA+3lwCACYJFBUkEAluWAIYAgAAcjyFQQAAAAAdXP8=',
  packetSha256: '914bd3f2f4fd47c46cb15414cc091505e1054c4780407cdeb303993f5a0c361f',
} as const

export const TYPE29_WIRE_LAYOUT = {
  recordLength: 26, sdkStride: 25, opcode: 0x5c,
  index: { offsets: [1, 2], interpretation: 'UINT16_LE_CONSISTENT_WITH_CAPTURED_SEQUENCE' },
  date: { offsets: [3, 4, 5, 6, 7, 8], interpretation: 'VENDOR_HEX_PAIRS' },
  sportModel: [9], heartRate: [10], ExerciseTime: [11, 12], step: [13, 14],
  sportModelSpeed: [15, 16], caloriesFloat32LE: [17, 18, 19, 20],
  distanceFloat32LE: [21, 22, 23, 24],
  trailer: { offset: 25, interpretation: 'UNKNOWN_CHECKSUM_ALGORITHM_NOT_PROVEN' },
  terminal: [0x5c, 0xff],
} as const

export type Type29VendorFields = {
  date: string; sportModel: string; heartRate: string; ExerciseTime: string; step: string
  sportModelSpeed: string; calories: string; distance: string
}
export interface Type29PhysicalRecord {
  kind: 'PHYSICAL_WIRE_RECORD'
  sourceIndex: number
  byteOffset: number
  byteLength: 26
  recordIndex: number
  rawBytesBase64: string
  sha256: string
  packetSha256: string
  trailerByte: number
  checksumValidation: 'NOT_PROVEN_NOT_CLAIMED'
  fields: Type29VendorFields
  exactFloat32: { calories: number; distance: number }
  semanticClassification: 'RESEARCH_NATIVE_ONLY'
  canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED'
}

export async function wireSha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))))
    .map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

// Mirrors only vendor field decoding. Stride callers are explicit; this is not a canonical workout model.
export function decodeType29VendorFields(bytes: Uint8Array, offset: number): {
  fields: Type29VendorFields; exactFloat32: { calories: number; distance: number }
} {
  if (offset < 0 || offset + 25 > bytes.length) throw new Error('TYPE29_FIELD_BYTES_TRUNCATED')
  const view = new DataView(bytes.buffer, bytes.byteOffset + offset, 25)
  const hex = (i: number) => view.getUint8(i).toString(16).padStart(2, '0')
  const decimal = (i: number) => String(view.getUint8(i)).padStart(2, '0')
  const calories = view.getFloat32(17, true), distance = view.getFloat32(21, true)
  if (!Number.isFinite(calories) || !Number.isFinite(distance)) throw new Error('TYPE29_NONFINITE_VENDOR_FLOAT')
  const format = (value: number, digits: number) =>
    new Intl.NumberFormat('en-US', { maximumFractionDigits: digits, useGrouping: false }).format(value)
  return {
    fields: {
      date: `20${hex(3)}.${hex(4)}.${hex(5)} ${hex(6)}:${hex(7)}:${hex(8)}`,
      sportModel: String(view.getUint8(9)), heartRate: String(view.getUint8(10)),
      ExerciseTime: String(view.getUint16(11, true)), step: String(view.getUint16(13, true)),
      sportModelSpeed: `${decimal(15)}'${decimal(16)}"`,
      calories: format(calories, 1), distance: format(distance, 2),
    },
    exactFloat32: { calories, distance },
  }
}

export async function decodeType29PhysicalPacket(bytes: Uint8Array): Promise<{
  packetSha256: string; rawBytesBase64: string; terminal: { byteOffset: number; hex: '5C FF' }
  records: Type29PhysicalRecord[]
}> {
  if (bytes.length < 2 || bytes.at(-2) !== 0x5c || bytes.at(-1) !== 0xff) {
    throw new Error('TYPE29_TERMINAL_MARKER_REQUIRED')
  }
  if (bytes.length === 2 || (bytes.length - 2) % 26 !== 0) throw new Error('TYPE29_EXACT_26_BYTE_FRAMES_REQUIRED')
  const packetSha256 = await wireSha256(bytes)
  const records: Type29PhysicalRecord[] = []
  for (let offset = 0; offset < bytes.length - 2; offset += 26) {
    const frame = bytes.slice(offset, offset + 26)
    const sourceIndex = offset / 26
    if (frame[0] !== 0x5c) throw new Error('TYPE29_FRAME_OPCODE_INVALID')
    const recordIndex = frame[1] + frame[2] * 256
    if (recordIndex !== sourceIndex) throw new Error('TYPE29_FRAME_SEQUENCE_INVALID')
    records.push({
      kind: 'PHYSICAL_WIRE_RECORD', sourceIndex, byteOffset: offset, byteLength: 26, recordIndex,
      rawBytesBase64: btoa(String.fromCharCode(...frame)), sha256: await wireSha256(frame), packetSha256,
      trailerByte: frame[25], checksumValidation: 'NOT_PROVEN_NOT_CLAIMED',
      ...decodeType29VendorFields(frame, 0),
      semanticClassification: 'RESEARCH_NATIVE_ONLY', canonicalAuthority: 'NONE_UNTIL_SEMANTICS_CONFIRMED',
    })
  }
  return { packetSha256, rawBytesBase64: btoa(String.fromCharCode(...bytes)),
    terminal: { byteOffset: bytes.length - 2, hex: '5C FF' }, records }
}
