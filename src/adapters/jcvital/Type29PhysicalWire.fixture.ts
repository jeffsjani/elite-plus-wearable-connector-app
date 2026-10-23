import { VC25_WORKOUT_CAPTURE, type Type29VendorFields } from './Type29PhysicalWire'

export const vc25PhysicalBytes = () => Uint8Array.from(atob(VC25_WORKOUT_CAPTURE.packetBase64), (c) => c.charCodeAt(0))

export const VC25_SDK_RECORDS_ORIGINAL: Type29VendorFields[] = [
  { date: '2026.09.15 16:23:49', heartRate: '125', distance: '0', sportModelSpeed: '00\'00"',
    ExerciseTime: '1474', step: '274', calories: '65.5', sportModel: '0' },
  { date: '2000.26.09 15:16:15', heartRate: '0', distance: '0', sportModelSpeed: '00\'62"',
    ExerciseTime: '55412', step: '51457', calories: '-0', sportModel: '69' },
  { date: '2002.00.26 09:14:15', heartRate: '16', distance: '0', sportModelSpeed: '24\'02"',
    ExerciseTime: '28169', step: '600', calories: '0', sportModel: '36' },
]
