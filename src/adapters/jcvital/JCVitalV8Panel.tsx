import { useEffect, useState } from 'react'
import { Capacitor } from '@capacitor/core'
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import {
  JCVitalV8,
  type JCVitalV8Battery,
  type JCVitalV8ConnectionState,
  type JCVitalV8Device,
  type JCVitalV8DeviceInfo,
  type JCVitalV8ErrorEvent,
  type JCVitalV8HistoricalSyncResult,
  type JCVitalV8LiveWorkoutSession,
  type JCVitalV8Observation,
  type JCVitalV8PermissionResult,
  type JCVitalV8RawEcgErrorEvent,
  type JCVitalV8RawEcgSession,
  type JCVitalV8RawPpgErrorEvent,
  type JCVitalV8RawPpgSession,
  type JCVitalV8WorkoutErrorEvent,
  type JCVitalV8WorkoutHeartRateEvent,
} from './jcvitalV8Bridge'
import {
  buildHistoricalFeedResult,
  buildMonitoringFeedResult,
  buildPhase3AValidationReport,
  type HistoricalFeedKey,
  type HistoricalFeedRun,
  type MonitoringFeedRun,
} from './Phase3AValidation'
import {
  buildPhase3BFeedResults,
  buildPhase3BExportResults,
  type Phase3BFeedKey,
  type SleepFeedRun,
} from './Phase3BValidation'
import { phase3bDisabledReason } from './Phase3BBridgeStatus'
import { workoutStartDisabledReason, workoutStopDisabledReason } from './WorkoutCaptureGuard'
import { rawEcgStartDisabledReason, rawEcgStopDisabledReason } from './RawEcgCaptureGuard'
import { rawPpgStartDisabledReason, rawPpgStopDisabledReason } from './RawPpgCaptureGuard'
import { buildRawPpgValidation, EMPTY_RAW_PPG_CHUNK_SUMMARY, includeRawPpgChunk, type RawPpgChunkSummary } from './RawPpgDiagnostics'
import { buildRawEcgValidation, EMPTY_RAW_ECG_CHUNK_SUMMARY, includeRawEcgChunk, type RawEcgChunkSummary } from './RawEcgDiagnostics'
import {
  buildWorkoutLiveValidation,
  computeWorkoutCadenceDiagnostics,
  type LiveWorkoutPacket,
  type LiveWorkoutSession,
} from './WorkoutTelemetry'

type ExportStatus = 'EXPORTING' | 'EXPORT SUCCESS' | 'EXPORT FAILED'

function errorText(error: unknown): string {
  const { code, message } = (error ?? {}) as { code?: string; message?: string }
  return code ? `${code}: ${message ?? ''}` : message ?? 'Unknown error'
}

/** Diagnostic panel for the JCVital Pro V8 native bridge (Android). Displays data only; nothing is queued for upload. */
export function JCVitalV8Panel() {
  const [permission, setPermission] = useState<JCVitalV8PermissionResult | null>(null)
  const [state, setState] = useState<JCVitalV8ConnectionState>('DISCONNECTED')
  const [devices, setDevices] = useState<JCVitalV8Device[]>([])
  const [info, setInfo] = useState<JCVitalV8DeviceInfo | null>(null)
  const [battery, setBattery] = useState<JCVitalV8Battery | null>(null)
  const [heartRate, setHeartRate] = useState<JCVitalV8Observation | null>(null)
  const [realtime, setRealtime] = useState(false)
  const [lastError, setLastError] = useState<JCVitalV8ErrorEvent | null>(null)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [pluginAvailable, setPluginAvailable] = useState<boolean | null>(null)
  const [activeSync, setActiveSync] = useState<string | null>(null)
  const [workoutSession, setWorkoutSession] = useState<JCVitalV8LiveWorkoutSession | null>(null)
  const [workoutPackets, setWorkoutPackets] = useState<LiveWorkoutPacket[]>([])
  const [workoutParseErrors, setWorkoutParseErrors] = useState<Array<Record<string, unknown>>>([])
  const [workoutHeartRateEvent, setWorkoutHeartRateEvent] = useState<JCVitalV8WorkoutHeartRateEvent | null>(null)
  const [workoutError, setWorkoutError] = useState<JCVitalV8WorkoutErrorEvent | null>(null)
  const [workoutClock, setWorkoutClock] = useState(Date.now())
  const [activityMode, setActivityMode] = useState(0)
  const [rawEcgSession, setRawEcgSession] = useState<JCVitalV8RawEcgSession | null>(null)
  const [rawEcgChunks, setRawEcgChunks] = useState<RawEcgChunkSummary>(EMPTY_RAW_ECG_CHUNK_SUMMARY)
  const [rawEcgParseErrors, setRawEcgParseErrors] = useState<Array<Record<string, unknown>>>([])
  const [rawEcgError, setRawEcgError] = useState<JCVitalV8RawEcgErrorEvent | null>(null)
  const [rawEcgClock, setRawEcgClock] = useState(Date.now())
  const [rawPpgSession, setRawPpgSession] = useState<JCVitalV8RawPpgSession | null>(null)
  const [rawPpgChunks, setRawPpgChunks] = useState<RawPpgChunkSummary>(EMPTY_RAW_PPG_CHUNK_SUMMARY)
  const [rawPpgParseErrors, setRawPpgParseErrors] = useState<Array<Record<string, unknown>>>([])
  const [rawPpgError, setRawPpgError] = useState<JCVitalV8RawPpgErrorEvent | null>(null)
  const [rawPpgClock, setRawPpgClock] = useState(Date.now())
  const [historicalRuns, setHistoricalRuns] = useState<Partial<Record<HistoricalFeedKey, HistoricalFeedRun>>>({})
  const [monitoringRun, setMonitoringRun] = useState<MonitoringFeedRun | undefined>()
  const [phase3bRuns, setPhase3bRuns] = useState<Partial<Record<Exclude<Phase3BFeedKey, 'sleep'>, HistoricalFeedRun>>>({})
  const [sleepRun, setSleepRun] = useState<SleepFeedRun>({})
  const [exportStatus, setExportStatus] = useState<ExportStatus | null>(null)
  const [exportLocation, setExportLocation] = useState<string | null>(null)

  useEffect(() => {
    const handles = [
      JCVitalV8.addListener('jcvitalScanResult', (device) =>
        setDevices((current) => [device, ...current.filter((item) => item.id !== device.id)].sort((a, b) => Number(b.advertisesJcvitalService) - Number(a.advertisesJcvitalService) || b.rssi - a.rssi))),
      JCVitalV8.addListener('jcvitalConnectionState', (event) => {
        setState(event.state)
        if (event.state !== 'READY') {
          setRealtime(false)
          setActiveSync((current) => current === 'manual:realtime' ? null : current)
        }
      }),
      JCVitalV8.addListener('jcvitalDeviceInfo', setInfo),
      JCVitalV8.addListener('jcvitalBattery', setBattery),
      JCVitalV8.addListener('jcvitalHeartRate', setHeartRate),
      JCVitalV8.addListener('jcvitalError', setLastError),
      JCVitalV8.addListener('jcvitalWorkoutState', (session) => {
        setWorkoutSession(session)
        if (['IDLE', 'STOPPED', 'ERROR', 'DISCONNECTED'].includes(session.status)) {
          setActiveSync((current) => current?.startsWith('workout:') ? null : current)
        } else {
          setActiveSync((current) => current ?? 'workout:capture')
        }
      }),
      JCVitalV8.addListener('jcvitalWorkoutPacket', (packet) => {
        setWorkoutPackets((current) => current.length && current[current.length - 1].sessionId === packet.sessionId
          ? [...current, packet]
          : [packet])
      }),
      JCVitalV8.addListener('jcvitalWorkoutHeartRate', setWorkoutHeartRateEvent),
      JCVitalV8.addListener('jcvitalWorkoutError', setWorkoutError),
      JCVitalV8.addListener('jcvitalWorkoutParseError', (error) => {
        setWorkoutParseErrors((current) => [...current, typeof error === 'object' && error !== null ? error as Record<string, unknown> : { error }])
      }),
      JCVitalV8.addListener('jcvitalRawEcgStatus', (session) => {
        setRawEcgSession(session)
        if (['STARTING', 'RUNNING', 'STOPPING'].includes(session.status)) setActiveSync((current) => current ?? 'raw-ecg')
        else setActiveSync((current) => current?.startsWith('raw-ecg') ? null : current)
      }),
      JCVitalV8.addListener('jcvitalRawEcgChunk', (chunk) => {
        setRawEcgChunks((current) => includeRawEcgChunk(current, chunk))
      }),
      JCVitalV8.addListener('jcvitalRawEcgError', (error) => {
        setRawEcgError(error)
        setRawEcgParseErrors((current) => [...current, error as unknown as Record<string, unknown>])
      }),
      JCVitalV8.addListener('jcvitalRawPpgStatus', (session) => {
        setRawPpgSession(session)
        if (['STARTING', 'RUNNING', 'STOPPING'].includes(session.status)) setActiveSync((current) => current ?? 'raw-ppg')
        else setActiveSync((current) => current?.startsWith('raw-ppg') ? null : current)
      }),
      JCVitalV8.addListener('jcvitalRawPpgChunk', (chunk) => {
        setRawPpgChunks((current) => includeRawPpgChunk(current, chunk))
      }),
      JCVitalV8.addListener('jcvitalRawPpgError', (error) => {
        setRawPpgError(error)
        setRawPpgParseErrors((current) => [...current, error as unknown as Record<string, unknown>])
      }),
    ]
    void JCVitalV8.isAvailable().then((result) => setPluginAvailable(result.available)).catch(() => setPluginAvailable(false))
    void JCVitalV8.getPermissionStatus().then(setPermission).catch((error) => setMessage(errorText(error)))
    void JCVitalV8.getConnectionState().then((result) => setState(result.state)).catch(() => undefined)
    void JCVitalV8.getWorkoutCaptureStatus().then((session) => {
      setWorkoutSession(session)
      if (!['IDLE', 'STOPPED', 'ERROR', 'DISCONNECTED'].includes(session.status)) setActiveSync('workout:capture')
    }).catch(() => undefined)
    void JCVitalV8.getRawEcgStatus().then((session) => {
      setRawEcgSession(session)
      if (['STARTING', 'RUNNING', 'STOPPING'].includes(session.status)) setActiveSync((current) => current ?? 'raw-ecg')
    }).catch(() => undefined)
    void JCVitalV8.getRawPpgStatus().then((session) => {
      setRawPpgSession(session)
      if (['STARTING', 'RUNNING', 'STOPPING'].includes(session.status)) setActiveSync((current) => current ?? 'raw-ppg')
    }).catch(() => undefined)
    return () => { handles.forEach((handle) => void handle.then((h) => h.remove())) }
  }, [])

  useEffect(() => {
    if (!workoutSession || !['RUNNING', 'PAUSED', 'STARTING', 'STOPPING'].includes(workoutSession.status)) return
    const timer = window.setInterval(() => setWorkoutClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [workoutSession?.status, workoutSession?.sessionId])

  useEffect(() => {
    if (!rawEcgSession || !['STARTING', 'RUNNING', 'STOPPING'].includes(rawEcgSession.status)) return
    const timer = window.setInterval(() => setRawEcgClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [rawEcgSession?.status, rawEcgSession?.sessionId])

  useEffect(() => {
    if (!rawPpgSession || !['STARTING', 'RUNNING', 'STOPPING'].includes(rawPpgSession.status)) return
    const timer = window.setInterval(() => setRawPpgClock(Date.now()), 1000)
    return () => window.clearInterval(timer)
  }, [rawPpgSession?.status, rawPpgSession?.sessionId])

  async function run(action: () => Promise<unknown>): Promise<void> {
    setBusy(true)
    setMessage('')
    try { await action() } catch (error) { setMessage(errorText(error)) } finally { setBusy(false) }
  }

  async function executeHistoricalSync(key: HistoricalFeedKey, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const result = await action()
      setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      setHistoricalRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function runSync(key: HistoricalFeedKey, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    setBusy(true)
    setActiveSync(`phase3a:${key}`)
    setMessage('')
    try { await executeHistoricalSync(key, action) } finally { setActiveSync(null); setBusy(false) }
  }

  async function syncHrvAndPpi(): Promise<void> {
    setBusy(true)
    setActiveSync('phase3a:hrv-ppi')
    setMessage('')
    try {
      await executeHistoricalSync('hrv', () => JCVitalV8.syncHistoricalHrv())
      await executeHistoricalSync('ppi', () => JCVitalV8.syncHistoricalPpi())
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function syncMonitoringConfiguration(): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setBusy(true)
    setActiveSync('monitoring-configuration')
    setMessage('')
    setMonitoringRun({ requestStartedAt, requestCompletedAt: null, result: null, error: null })
    try {
      const result = await JCVitalV8.getMonitoringConfiguration()
      setMonitoringRun({ requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null })
    } catch (error) {
      const text = errorText(error)
      setMonitoringRun({ requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text })
      setMessage(text)
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function executePhase3BSync(
    key: Exclude<Phase3BFeedKey, 'sleep'>,
    action: () => Promise<JCVitalV8HistoricalSyncResult>,
  ): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const result = await action()
      setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      setPhase3bRuns((current) => ({ ...current, [key]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function runPhase3BSync(
    key: Exclude<Phase3BFeedKey, 'sleep'>,
    action: () => Promise<JCVitalV8HistoricalSyncResult>,
  ): Promise<void> {
    setBusy(true)
    setActiveSync(`phase3b:${key}`)
    setMessage('')
    try { await executePhase3BSync(key, action) } finally { setActiveSync(null); setBusy(false) }
  }

  async function executeSleepSyncPart(part: keyof SleepFeedRun, action: () => Promise<JCVitalV8HistoricalSyncResult>): Promise<void> {
    const requestStartedAt = new Date().toISOString()
    setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: null, result: null, error: null } }))
    try {
      const result = await action()
      setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result, error: null } }))
    } catch (error) {
      const text = errorText(error)
      setSleepRun((current) => ({ ...current, [part]: { requestStartedAt, requestCompletedAt: new Date().toISOString(), result: null, error: text } }))
      setMessage((current) => current ? `${current}; ${text}` : text)
    }
  }

  async function syncSleep(): Promise<void> {
    setBusy(true)
    setActiveSync('phase3b:sleep')
    setMessage('')
    try {
      await executeSleepSyncPart('stages', () => JCVitalV8.syncHistoricalSleepStages())
      await executeSleepSyncPart('movement', () => JCVitalV8.syncHistoricalSleepMovement())
    } finally {
      setActiveSync(null)
      setBusy(false)
    }
  }

  async function startWorkout(): Promise<void> {
    setWorkoutPackets([])
    setWorkoutParseErrors([])
    setWorkoutHeartRateEvent(null)
    setWorkoutError(null)
    setActiveSync('workout:capture')
    setBusy(true)
    setMessage('')
    try {
      setWorkoutSession(await JCVitalV8.startWorkoutCapture({ activityMode }))
    } catch (error) {
      setActiveSync(null)
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function stopWorkout(): Promise<void> {
    setActiveSync('workout:stopping')
    setBusy(true)
    setMessage('')
    try {
      setWorkoutSession(await JCVitalV8.stopWorkoutCapture())
      setActiveSync(null)
    } catch (error) {
      setMessage(errorText(error))
      try { setWorkoutSession(await JCVitalV8.getWorkoutCaptureStatus()) } catch { /* keep last state */ }
      setActiveSync((current) => current === 'workout:stopping' ? 'workout:capture' : current)
    } finally {
      setBusy(false)
    }
  }

  async function changeWorkoutState(action: 'pause' | 'resume'): Promise<void> {
    setBusy(true)
    setMessage('')
    try {
      const session = action === 'pause'
        ? await JCVitalV8.pauseWorkoutCapture()
        : await JCVitalV8.resumeWorkoutCapture()
      setWorkoutSession(session)
    } catch (error) {
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function startRawEcg(): Promise<void> {
    setRawEcgChunks(EMPTY_RAW_ECG_CHUNK_SUMMARY)
    setRawEcgParseErrors([])
    setRawEcgError(null)
    setActiveSync('raw-ecg')
    setBusy(true)
    setMessage('')
    try {
      setRawEcgSession(await JCVitalV8.startRawEcg())
    } catch (error) {
      setActiveSync(null)
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function stopRawEcg(): Promise<void> {
    setActiveSync('raw-ecg:stopping')
    setBusy(true)
    setMessage('')
    try {
      setRawEcgSession(await JCVitalV8.stopRawEcg())
      setActiveSync(null)
    } catch (error) {
      setMessage(errorText(error))
      try { setRawEcgSession(await JCVitalV8.getRawEcgStatus()) } catch { /* keep last state */ }
      setActiveSync((current) => current === 'raw-ecg:stopping' ? 'raw-ecg' : current)
    } finally {
      setBusy(false)
    }
  }

  async function startRawPpg(): Promise<void> {
    setRawPpgChunks(EMPTY_RAW_PPG_CHUNK_SUMMARY)
    setRawPpgParseErrors([])
    setRawPpgError(null)
    setActiveSync('raw-ppg')
    setBusy(true)
    setMessage('')
    try {
      setRawPpgSession(await JCVitalV8.startRawPpg())
    } catch (error) {
      setActiveSync(null)
      setMessage(errorText(error))
    } finally {
      setBusy(false)
    }
  }

  async function stopRawPpg(): Promise<void> {
    setActiveSync('raw-ppg:stopping')
    setBusy(true)
    setMessage('')
    try {
      setRawPpgSession(await JCVitalV8.stopRawPpg())
      setActiveSync(null)
    } catch (error) {
      setMessage(errorText(error))
      try { setRawPpgSession(await JCVitalV8.getRawPpgStatus()) } catch { /* keep last state */ }
      setActiveSync((current) => current === 'raw-ppg:stopping' ? 'raw-ppg' : current)
    } finally {
      setBusy(false)
    }
  }

  async function exportValidationReport(): Promise<void> {
    setExportStatus('EXPORTING')
    setExportLocation(null)
    try {
      let deviceInfo = info
      if (!deviceInfo && ready) {
        deviceInfo = await JCVitalV8.getDeviceInfo()
        setInfo(deviceInfo)
      }
      const phase3bFeedResults = buildPhase3BExportResults({
        activity: phase3bRuns.activity,
        detailedActivity: phase3bRuns.detailedActivity,
        sleep: sleepRun,
        workouts: phase3bRuns.workouts,
      })
      const payload = buildPhase3AValidationReport({
        deviceInfo, historicalRuns, monitoringRun,
        additionalFeedResults: {
          ...phase3bFeedResults,
          workoutLiveValidation,
          ecgStartDiagnostics: rawEcgSession?.ecgStartDiagnostics ?? null,
          rawEcgValidation: buildRawEcgValidation(rawEcgSession, rawEcgChunks, rawEcgParseErrors),
          rawPpgValidation: buildRawPpgValidation(rawPpgSession, rawPpgChunks, rawPpgParseErrors),
        },
      })
      const filename = `jcvital-v8-phase3abc-validation-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
      const json = JSON.stringify(payload, null, 2)

      if (Capacitor.isNativePlatform()) {
        const saved = await Filesystem.writeFile({ path: filename, data: json, directory: Directory.Cache, encoding: Encoding.UTF8 })
        await Share.share({
          title: 'JCVital V8 Phase 3A/3B/3C Validation',
          text: filename,
          files: [saved.uri],
          dialogTitle: 'Save or share Phase 3A/3B/3C validation JSON',
        })
        setExportLocation(`${filename} · ${saved.uri}`)
      } else {
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }))
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = filename
        anchor.click()
        URL.revokeObjectURL(url)
        setExportLocation(filename)
      }
      setExportStatus('EXPORT SUCCESS')
    } catch (error) {
      setExportStatus('EXPORT FAILED')
      setExportLocation(errorText(error))
    }
  }

  const ready = state === 'READY'
  const linked = state === 'CONNECTING' || state === 'CONNECTED' || state === 'INITIALIZING' || ready
  const feedDiagnostics = {
    heartRate: buildHistoricalFeedResult('heartRate', historicalRuns.heartRate),
    spo2: buildHistoricalFeedResult('spo2', historicalRuns.spo2),
    temperature: buildHistoricalFeedResult('temperature', historicalRuns.temperature),
    hrv: buildHistoricalFeedResult('hrv', historicalRuns.hrv),
    ppi: buildHistoricalFeedResult('ppi', historicalRuns.ppi),
    monitoringConfiguration: buildMonitoringFeedResult(monitoringRun),
  }
  const phase3bDiagnostics = buildPhase3BFeedResults({
    activity: phase3bRuns.activity,
    detailedActivity: phase3bRuns.detailedActivity,
    sleep: sleepRun,
    workouts: phase3bRuns.workouts,
  })
  const automaticHrInterval = monitoringRun?.result?.configurations.HEART_RATE.intervalMinutesRaw ?? null
  const historicalHrDiagnostics = feedDiagnostics.heartRate.sampleDiagnostics as { medianIntervalSeconds?: number | null } | null
  const phase3bMethods = {
    activity: typeof JCVitalV8.syncHistoricalActivity === 'function',
    detailedActivity: typeof JCVitalV8.syncDetailedActivity === 'function',
    sleep: typeof JCVitalV8.syncHistoricalSleepStages === 'function' && typeof JCVitalV8.syncHistoricalSleepMovement === 'function',
    workouts: typeof JCVitalV8.syncHistoricalWorkouts === 'function',
  }
  const phase3bDisabledReasons = {
    activity: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.activity, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
    detailedActivity: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.detailedActivity, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
    sleep: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.sleep, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
    workouts: phase3bDisabledReason({ pluginAvailable, methodAvailable: phase3bMethods.workouts, connectionState: state, activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null) }),
  }
  const workoutMethods = {
    start: typeof JCVitalV8.startWorkoutCapture === 'function',
    stop: typeof JCVitalV8.stopWorkoutCapture === 'function',
    pause: typeof JCVitalV8.pauseWorkoutCapture === 'function',
    resume: typeof JCVitalV8.resumeWorkoutCapture === 'function',
  }
  const workoutGate = {
    pluginAvailable,
    startMethodAvailable: workoutMethods.start,
    stopMethodAvailable: workoutMethods.stop,
    connectionState: state,
    activeSync,
    manualMeasurementActive: realtime,
    workoutStatus: workoutSession?.status ?? 'IDLE' as const,
  }
  const workoutStartReason = workoutStartDisabledReason(workoutGate)
  const workoutStopReason = workoutStopDisabledReason(workoutGate)
  const workoutSessionForDiagnostics = workoutSession as LiveWorkoutSession | null
  const workoutIsTerminal = workoutSession?.status === 'STOPPED' || workoutSession?.status === 'ERROR' || workoutSession?.status === 'DISCONNECTED'
  const workoutDiagnostics = workoutSessionForDiagnostics
    ? computeWorkoutCadenceDiagnostics(workoutSessionForDiagnostics, workoutPackets, workoutIsTerminal)
    : null
  const currentWorkoutPacket = workoutPackets.at(-1) ?? null
  const currentWorkoutHr = [...workoutPackets].reverse().find((packet) => packet.heartRate !== null)?.heartRate ?? null
  const workoutElapsedSeconds = workoutSession?.startedAt
    ? Math.max(0, ((workoutSession.stoppedAt ? Date.parse(workoutSession.stoppedAt) : workoutClock) - Date.parse(workoutSession.startedAt)) / 1000)
    : 0
  const lastWorkoutPacketAgeSeconds = currentWorkoutPacket
    ? Math.max(0, (workoutClock - Date.parse(currentWorkoutPacket.receivedAt)) / 1000)
    : null
  const workoutLiveValidation = buildWorkoutLiveValidation(workoutSessionForDiagnostics, workoutPackets, workoutParseErrors)
  const rawEcgMethods = {
     start: typeof JCVitalV8.startRawEcg === 'function',
    stop: typeof JCVitalV8.stopRawEcg === 'function',
  }
  const rawEcgGate = {
    pluginAvailable,
    startMethodAvailable: rawEcgMethods.start,
    stopMethodAvailable: rawEcgMethods.stop,
    connectionState: state,
    activeSync: activeSync ?? (realtime ? 'manual HR measurement' : null),
    manualMeasurementActive: realtime,
    workoutStatus: workoutSession?.status ?? 'IDLE' as const,
    rawEcgStatus: rawEcgSession?.status ?? 'IDLE',
  }
  const rawEcgStartReason = rawEcgStartDisabledReason(rawEcgGate)
  const rawEcgStopReason = rawEcgStopDisabledReason(rawEcgGate)
  const rawEcgElapsedSeconds = rawEcgSession?.startedAt
    ? Math.max(0, ((rawEcgSession.stoppedAt ? Date.parse(rawEcgSession.stoppedAt) : rawEcgClock) - Date.parse(rawEcgSession.startedAt)) / 1000)
    : 0
  const rawEcgValidation = buildRawEcgValidation(rawEcgSession, rawEcgChunks, rawEcgParseErrors)
  const rawPpgGate = {
    pluginAvailable,
    startMethodAvailable: typeof JCVitalV8.startRawPpg === 'function',
    stopMethodAvailable: typeof JCVitalV8.stopRawPpg === 'function',
    connectionState: state,
    activeSync,
    manualMeasurementActive: realtime,
    workoutStatus: workoutSession?.status ?? 'IDLE',
    rawEcgStatus: rawEcgSession?.status ?? 'IDLE',
    rawPpgStatus: rawPpgSession?.status ?? 'IDLE',
  }
  const rawPpgStartReason = rawPpgStartDisabledReason(rawPpgGate)
  const rawPpgStopReason = rawPpgStopDisabledReason(rawPpgGate)
  const rawPpgElapsedSeconds = rawPpgSession?.startedAt
    ? Math.max(0, ((rawPpgSession.stoppedAt ? Date.parse(rawPpgSession.stoppedAt) : rawPpgClock) - Date.parse(rawPpgSession.startedAt)) / 1000)
    : 0
  const rawPpgValidation = buildRawPpgValidation(rawPpgSession, rawPpgChunks, rawPpgParseErrors)
  const otherActiveMeasurement = activeSync ?? (realtime ? 'manual HR measurement' : null)
  const workoutStatus = workoutSession?.status ?? 'IDLE'
  const workoutActive = ['STARTING', 'RUNNING', 'PAUSED', 'STOPPING'].includes(workoutStatus)
  return (
    <section className="wearables" aria-labelledby="jcvital-v8-title">
      <div className="wearables-heading"><h2 id="jcvital-v8-title">JCVital Pro V8</h2><strong>{state}</strong></div>
      <p>Bluetooth: {permission ? `${permission.status}${permission.bluetoothEnabled ? '' : ' (Bluetooth off)'}` : 'Checking…'}</p>
      <div className="wearable-actions">
        <button type="button" disabled={busy} onClick={() => void run(async () => setPermission(await JCVitalV8.requestPermissions()))}>Allow Bluetooth</button>
        <button type="button" disabled={busy || linked || state === 'SCANNING'} onClick={() => void run(async () => { setDevices([]); await JCVitalV8.startScan({ timeoutMs: 30000 }) })}>Start Scan</button>
        <button type="button" className="secondary" disabled={state !== 'SCANNING'} onClick={() => void run(() => JCVitalV8.stopScan())}>Stop Scan</button>
      </div>
      {!linked && devices.length > 0 && <ul className="jcvital-devices">
        {devices.map((device) => <li key={device.id}>
          <button type="button" disabled={busy} onClick={() => void run(async () => { setInfo(null); setBattery(null); setHeartRate(null); await JCVitalV8.connect({ deviceId: device.id }); setInfo(await JCVitalV8.getDeviceInfo()) })}>Connect</button>
          {' '}{device.name ?? 'Unnamed'} · {device.macAddress} · {device.rssi} dBm{device.advertisesJcvitalService ? ' · JCVital service' : ''}{device.bonded ? ' · bonded' : ''}
        </li>)}
      </ul>}
      {linked && <div className="wearable-actions">
        <button type="button" disabled={busy || !ready} onClick={() => void run(async () => setInfo(await JCVitalV8.getDeviceInfo()))}>Device Info</button>
        <button type="button" disabled={busy || !ready} onClick={() => void run(async () => setBattery(await JCVitalV8.getBattery()))}>Battery</button>
        <button type="button" disabled={busy || !ready || realtime || activeSync !== null} onClick={() => void run(async () => {
          setActiveSync('manual:realtime')
          try {
            await JCVitalV8.startRealtimeData({ measurementSeconds: 60 })
            setRealtime(true)
          } catch (error) {
            setActiveSync(null)
            throw error
          }
        })}>Start Realtime</button>
        <button type="button" disabled={busy || !ready || !realtime} onClick={() => void run(async () => { await JCVitalV8.stopRealtimeData(); setRealtime(false); setActiveSync(null) })}>Stop Realtime</button>
        <button type="button" className="secondary" disabled={busy} onClick={() => void run(() => JCVitalV8.disconnect())}>Disconnect</button>
      </div>}
      {info && <p>Device: {info.deviceName ?? info.advertisedName ?? '—'} · MAC {info.macAddress ?? info.deviceId} · Firmware {info.firmwareVersion ?? '—'} · ID {info.vendorDeviceId ?? '—'} · SDK {info.sdkVersion}{info.missingFields.length ? ` · missing: ${info.missingFields.join(', ')}` : ''}</p>}
      {battery && <p>Battery: {battery.level ?? '—'}%{battery.charging === null ? '' : battery.charging ? ' (charging)' : ' (not charging)'}</p>}
      {heartRate && <p>Heart rate: <strong>{heartRate.value} {heartRate.unit}</strong> · received {new Date(heartRate.receiptTimestamp).toLocaleTimeString()} · packet type {heartRate.vendorDataType}</p>}
      <h3>Data Sync</h3>
      <div className="wearable-actions">
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void runSync('heartRate', () => JCVitalV8.syncHistoricalHeartRate())}>Sync HR</button>
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void runSync('spo2', () => JCVitalV8.syncHistoricalSpo2())}>Sync SpO2</button>
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void runSync('temperature', () => JCVitalV8.syncHistoricalTemperature())}>Sync Temperature</button>
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void syncHrvAndPpi()}>Sync HRV/PPI</button>
        <button type="button" disabled={busy || !ready || otherActiveMeasurement !== null} onClick={() => void syncMonitoringConfiguration()}>Sync Automatic Monitoring / Configuration</button>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.activity !== null} onClick={() => void runPhase3BSync('activity', () => JCVitalV8.syncHistoricalActivity())}>Sync Activity</button>
          {phase3bDisabledReasons.activity && <small>Disabled: {phase3bDisabledReasons.activity}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.detailedActivity !== null} onClick={() => void runPhase3BSync('detailedActivity', () => JCVitalV8.syncDetailedActivity())}>Sync Detailed Activity</button>
          {phase3bDisabledReasons.detailedActivity && <small>Disabled: {phase3bDisabledReasons.detailedActivity}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.sleep !== null} onClick={() => void syncSleep()}>Sync Sleep</button>
          {phase3bDisabledReasons.sleep && <small>Disabled: {phase3bDisabledReasons.sleep}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={phase3bDisabledReasons.workouts !== null} onClick={() => void runPhase3BSync('workouts', () => JCVitalV8.syncHistoricalWorkouts())}>Sync Workouts</button>
          {phase3bDisabledReasons.workouts && <small>Disabled: {phase3bDisabledReasons.workouts}</small>}
        </div>
        <button type="button" className="secondary" disabled={!Object.keys(historicalRuns).length && !monitoringRun && !Object.keys(phase3bRuns).length && !sleepRun.stages && !sleepRun.movement && !workoutSession} onClick={() => void exportValidationReport()}>Export Phase 3A/3B/3C Validation JSON</button>
      </div>
      <div className="phase3b-bridge-status">
        <strong>Phase 3B bridge</strong>
        <span>activity: {phase3bMethods.activity ? 'AVAILABLE' : 'MISSING'}</span>
        <span>detailedActivity: {phase3bMethods.detailedActivity ? 'AVAILABLE' : 'MISSING'}</span>
        <span>sleep: {phase3bMethods.sleep ? 'AVAILABLE' : 'MISSING'}</span>
        <span>workouts: {phase3bMethods.workouts ? 'AVAILABLE' : 'MISSING'}</span>
        <span>connectionState: {state}</span>
        <span>pluginAvailable: {pluginAvailable === null ? 'CHECKING' : pluginAvailable ? 'AVAILABLE' : 'MISSING'}</span>
        <span>activeSync: {activeSync ?? 'NONE'}</span>
      </div>
      <p><strong>Automatic HR monitoring interval:</strong> {automaticHrInterval === null ? '—' : `${automaticHrInterval} minutes (vendor configuration)`}</p>
      <p><strong>Historical HR observed median interval:</strong> {historicalHrDiagnostics?.medianIntervalSeconds == null ? '—' : `${historicalHrDiagnostics.medianIntervalSeconds} seconds (observed data)`}</p>
      {exportStatus && <p role="status"><strong>{exportStatus}</strong>{exportLocation ? ` · ${exportLocation}` : ''}</p>}
      {Object.entries(feedDiagnostics).map(([key, diagnostics]) => {
        const showAllRecords = key === 'spo2' || key === 'hrv' || key === 'ppi' || key === 'monitoringConfiguration'
        return <details key={key} className="jcvital-diagnostics">
          <summary>{key}: {diagnostics.completionStatus} · {diagnostics.recordsAccepted} accepted · {diagnostics.parseErrors.length} parse errors</summary>
          <p>Started: {diagnostics.requestStartedAt ?? '—'} · Completed: {diagnostics.requestCompletedAt ?? '—'}</p>
          <p>Source records received: {diagnostics.sourceRecordsReceived} · Normalized observations produced: {diagnostics.normalizedObservationsProduced}</p>
          <p>Accepted: {diagnostics.recordsAccepted} · Deduplicated: {diagnostics.recordsDeduplicated} · Rejected: {diagnostics.recordsRejected}</p>
          <p>Earliest: {diagnostics.earliestObservation ?? '—'} · Latest: {diagnostics.latestObservation ?? '—'}</p>
          <p>Vendor type: {diagnostics.vendorDataType ?? '—'} · Acquisition: {diagnostics.acquisitionMode ?? '—'}</p>
          <strong>Sample diagnostics</strong><pre>{JSON.stringify(diagnostics.sampleDiagnostics, null, 2)}</pre>
          <strong>Parse errors</strong><pre>{JSON.stringify(diagnostics.parseErrors, null, 2)}</pre>
          <strong>First 5 normalized observations</strong><pre>{JSON.stringify(diagnostics.firstFive, null, 2)}</pre>
          <strong>Last 5 normalized observations</strong><pre>{JSON.stringify(diagnostics.lastFive, null, 2)}</pre>
          {showAllRecords && <><strong>All returned diagnostic records</strong><pre>{JSON.stringify(diagnostics.allRecords, null, 2)}</pre></>}
        </details>
      })}
      <h3>Phase 3B History</h3>
      {Object.entries(phase3bDiagnostics).map(([key, diagnostics]) => <details key={key} className="jcvital-diagnostics">
        <summary>{key}: {diagnostics.completionStatus} · {diagnostics.recordsAccepted} accepted · {diagnostics.parseErrors.length} parse errors</summary>
        <p>Source records received: {diagnostics.sourceRecordsReceived} · Normalized observations produced: {diagnostics.normalizedObservationsProduced}</p>
        <p>Accepted: {diagnostics.recordsAccepted} · Deduplicated: {diagnostics.recordsDeduplicated} · Rejected: {diagnostics.recordsRejected}</p>
        <p>Earliest: {diagnostics.earliestObservation ?? '—'} · Latest: {diagnostics.latestObservation ?? '—'}</p>
        <strong>Diagnostics</strong><pre>{JSON.stringify(diagnostics.sampleDiagnostics, null, 2)}</pre>
        <strong>Parse errors</strong><pre>{JSON.stringify(diagnostics.parseErrors, null, 2)}</pre>
        <strong>First 5</strong><pre>{JSON.stringify(diagnostics.firstFive, null, 2)}</pre>
        <strong>Last 5</strong><pre>{JSON.stringify(diagnostics.lastFive, null, 2)}</pre>
      </details>)}
      <h3>Raw Capture</h3>
      <div className="wearable-actions">
        <div className="diagnostic-control">
          <button type="button" disabled={busy || rawPpgStartReason !== null} title={rawPpgStartReason ?? 'Start PPG Workflow Capture'} onClick={() => void startRawPpg()}>Start PPG</button>
          {rawPpgStartReason && <small>Disabled: {rawPpgStartReason}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={busy || rawPpgStopReason !== null} title={rawPpgStopReason ?? 'Stop PPG Workflow Capture'} onClick={() => void stopRawPpg()}>Stop PPG</button>
          {rawPpgStopReason && <small>Disabled: {rawPpgStopReason}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={rawEcgStartReason !== null || busy} title={rawEcgStartReason ?? 'Start raw ECG capture'} onClick={() => void startRawEcg()}>Start ECG</button>
          {rawEcgStartReason && <small>Disabled: {rawEcgStartReason}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={rawEcgStopReason !== null || busy} title={rawEcgStopReason ?? 'Stop raw ECG capture'} onClick={() => void stopRawEcg()}>Stop ECG</button>
          {rawEcgStopReason && <small>Disabled: {rawEcgStopReason}</small>}
        </div>
      </div>
      <section className="workout-live-diagnostics" aria-label="PPG workflow capture diagnostics">
        <strong>PPG Workflow Capture · {rawPpgSession?.status ?? 'IDLE'}</strong>
        <span>Session ID: {rawPpgSession?.sessionId ?? '—'}</span>
        <span>Elapsed time: {Math.floor(rawPpgElapsedSeconds / 60).toString().padStart(2, '0')}:{Math.floor(rawPpgElapsedSeconds % 60).toString().padStart(2, '0')}</span>
        <span>Packets: {rawPpgSession?.packetCount ?? 0} · chunks: {rawPpgSession?.chunkCount ?? rawPpgChunks.chunkCount} · bytes: {rawPpgSession?.bytesReceived ?? rawPpgChunks.totalBytes}</span>
        <span>Notification lengths: 153={rawPpgSession?.notificationLengthCounts['153'] ?? 0} · 203={rawPpgSession?.notificationLengthCounts['203'] ?? 0} · unsupported={rawPpgSession?.notificationLengthCounts.other ?? 0}</span>
        <span>First packet: {rawPpgSession?.firstPacketAt ?? '—'} · last packet: {rawPpgSession?.lastPacketAt ?? '—'}</span>
        <span>Type-119 callbacks: {rawPpgSession?.vendorDataType119Count ?? rawPpgChunks.vendorDataType119Count} · decoded values: {rawPpgSession?.decodedSampleCount ?? rawPpgChunks.decodedSampleCount}</span>
        <span>153-byte decoded values: {rawPpgSession?.rawSampleDiagnostics['153']?.decodedSampleCount ?? 0} · min/max: {rawPpgSession?.rawSampleDiagnostics['153']?.minimumRawDecodedValue ?? '—'} / {rawPpgSession?.rawSampleDiagnostics['153']?.maximumRawDecodedValue ?? '—'}</span>
        <span>203-byte decoded values: {rawPpgSession?.rawSampleDiagnostics['203']?.decodedSampleCount ?? 0} · min/max: {rawPpgSession?.rawSampleDiagnostics['203']?.minimumRawDecodedValue ?? '—'} / {rawPpgSession?.rawSampleDiagnostics['203']?.maximumRawDecodedValue ?? '—'}</span>
        <span>Decoded raw min/max: {rawPpgSession?.minimumRawDecodedValue ?? '—'} / {rawPpgSession?.maximumRawDecodedValue ?? '—'} · parse errors: {rawPpgSession?.parseErrorCount ?? rawPpgParseErrors.length}</span>
        {rawPpgError && <span role="alert">Last PPG workflow error: {rawPpgError.message}</span>}
      </section>
      <details className="jcvital-diagnostics">
        <summary>PPG workflow validation · first {rawPpgChunks.firstThreeChunks.length}, last {rawPpgChunks.lastThreeChunks.length}</summary>
        <strong>Validation summary</strong><pre>{JSON.stringify(rawPpgValidation, null, 2)}</pre>
      </details>
      <section className="workout-live-diagnostics" aria-label="Raw ECG diagnostics">
        <strong>Status: {rawEcgSession?.status ?? 'IDLE'}</strong>
        <span>Session ID: {rawEcgSession?.sessionId ?? '—'}</span>
        <span>Elapsed wall time: {Math.floor(rawEcgElapsedSeconds / 60).toString().padStart(2, '0')}:{Math.floor(rawEcgElapsedSeconds % 60).toString().padStart(2, '0')}</span>
        <span>Packets: {rawEcgSession?.packetCount ?? 0} · samples: {rawEcgSession?.sampleCount ?? 0} · chunks: {rawEcgSession?.chunksEmitted ?? rawEcgChunks.chunkCount}</span>
        <span>Last packet ID: {rawEcgSession?.lastPacketId ?? '—'} · missing: {rawEcgSession?.missingPacketCount ?? 0} · duplicates: {rawEcgSession?.duplicatePacketCount ?? 0} · out of order: {rawEcgSession?.outOfOrderPacketCount ?? 0}</span>
        <span>Average samples/packet: {rawEcgSession?.averageSamplesPerPacket?.toFixed(1) ?? '—'} · raw min/max: {rawEcgSession?.minimumRawSample ?? rawEcgChunks.minRawSample ?? '—'} / {rawEcgSession?.maximumRawSample ?? rawEcgChunks.maxRawSample ?? '—'}</span>
        <span>Bytes received: {rawEcgSession?.bytesReceived ?? rawEcgChunks.totalBytes} · buffered estimate: {rawEcgSession?.maxBufferedEstimateBytes ?? 0}/{rawEcgSession?.hardChunkBufferLimitBytes ?? '—'} bytes</span>
        <span>Parse errors: {rawEcgSession?.parseErrorCount ?? rawEcgParseErrors.length} · stored packets/bytes: {rawEcgSession?.persistedPacketCount ?? 0}/{rawEcgSession?.persistedBytes ?? 0} · storage errors: {rawEcgSession?.storageErrorCount ?? 0}</span>
        <span>Sample format: {rawEcgSession?.sampleFormat ?? 'UINT24_LE'} · unit: {rawEcgSession?.unit ?? 'UNKNOWN_VENDOR_UNIT'} · sample rate: {rawEcgSession?.sampleRateHz ?? 'unknown'}</span>
        {rawEcgError && <span role="alert">Last raw ECG error: {rawEcgError.message}</span>}
      </section>
      <details className="jcvital-diagnostics">
        <summary>Raw ECG chunk summaries · first {rawEcgChunks.firstThreeChunks.length}, last {rawEcgChunks.lastThreeChunks.length}</summary>
        <strong>ECG start diagnostics</strong><pre>{JSON.stringify(rawEcgSession?.ecgStartDiagnostics ?? null, null, 2)}</pre>
        <strong>First chunks</strong><pre>{JSON.stringify(rawEcgChunks.firstThreeChunks, null, 2)}</pre>
        <strong>Last chunks</strong><pre>{JSON.stringify(rawEcgChunks.lastThreeChunks, null, 2)}</pre>
        <strong>Validation summary</strong><pre>{JSON.stringify(rawEcgValidation, null, 2)}</pre>
      </details>
      <h3>Workout Test</h3>
      <div className="wearable-actions">
        <label className="workout-mode">Activity mode
          <select value={activityMode} disabled={busy || workoutActive} onChange={(event) => setActivityMode(Number(event.target.value))}>
            {['Run', 'Cycling', 'Badminton', 'Football', 'Tennis', 'Yoga', 'Breathing training', 'Dance', 'Basketball', 'Walk', 'Workout', 'Cricket', 'Hiking', 'Aerobics', 'Table tennis'].map((label, mode) => <option key={mode} value={mode}>{mode}: {label}</option>)}
          </select>
        </label>
        <div className="diagnostic-control">
          <button type="button" disabled={workoutStartReason !== null || busy} onClick={() => void startWorkout()}>Start Workout Capture</button>
          {workoutStartReason && <small>Disabled: {workoutStartReason}</small>}
        </div>
        <div className="diagnostic-control">
          <button type="button" disabled={workoutStopReason !== null || busy} onClick={() => void stopWorkout()}>Stop Workout Capture</button>
          {workoutStopReason && <small>Disabled: {workoutStopReason}</small>}
        </div>
        <button type="button" disabled={busy || !workoutMethods.pause || workoutStatus !== 'RUNNING'} onClick={() => void changeWorkoutState('pause')}>Pause</button>
        <button type="button" disabled={busy || !workoutMethods.resume || workoutStatus !== 'PAUSED'} onClick={() => void changeWorkoutState('resume')}>Resume</button>
      </div>
      <p>Target: 10:00 · manual stop</p>
      <section className="workout-live-diagnostics" aria-label="Live workout diagnostics">
        <strong>Status: {workoutStatus}</strong>
        <span>Session ID: {workoutSession?.sessionId ?? '—'}</span>
        <span>Elapsed wall time: {Math.floor(workoutElapsedSeconds / 60).toString().padStart(2, '0')}:{Math.floor(workoutElapsedSeconds % 60).toString().padStart(2, '0')}</span>
        <span>Session packet count: {workoutSession?.packetCount ?? 0} · received here: {workoutPackets.length}</span>
        <span>HR packets: {workoutDiagnostics?.hrPacketCount ?? 0}</span>
        <span>Current HR: {currentWorkoutHr ?? '—'} bpm</span>
        <span>Current steps: {currentWorkoutPacket?.steps ?? '—'} · calories: {currentWorkoutPacket?.calories ?? '—'}</span>
        <span>ExerciseTime: {currentWorkoutPacket?.elapsedSeconds ?? '—'} s · raw vendor value: {currentWorkoutPacket?.exerciseTimeRaw ?? '—'} · {currentWorkoutPacket?.exerciseTimeValidationStatus ?? 'not emitted'}</span>
        <span>Last packet age: {lastWorkoutPacketAgeSeconds === null ? '—' : `${lastWorkoutPacketAgeSeconds.toFixed(1)} s`}</span>
        <span>Heartbeat attempts/sent/skipped: {workoutSession?.heartbeatAttemptCount ?? 0}/{workoutSession?.heartbeatSentCount ?? 0}/{workoutSession?.heartbeatSkippedCount ?? 0}</span>
          <span>App-supplied sendHeartPackage inputs: distance {workoutSession?.heartbeatInputs?.distanceKm ?? '—'} km · pace {workoutSession?.heartbeatInputs?.paceSeconds ?? '—'} s · signal {workoutSession?.heartbeatInputs?.rssiStrength ?? '—'} (vendor scale, not Android dBm)</span>
          <span>Type 82 band-returned fields: heartRate, step, calories, ExerciseTime. Not returned: distance, pace, METS, temperature, SpO2, RSSI.</span>
        <span>Packet interval median/P95: {workoutDiagnostics?.medianPacketIntervalMs?.toFixed(0) ?? '—'} / {workoutDiagnostics?.p95PacketIntervalMs?.toFixed(0) ?? '—'} ms</span>
        <span>Packets 750–1250 ms: {workoutDiagnostics?.percentagePacketsBetween750And1250Ms?.toFixed(1) ?? '—'}%</span>
        <span>HR-bearing interval median/P95: {workoutDiagnostics?.medianHrPacketIntervalMs?.toFixed(0) ?? '—'} / {workoutDiagnostics?.p95HrPacketIntervalMs?.toFixed(0) ?? '—'} ms</span>
        <span>Nonzero HR observation interval median/P95: {workoutDiagnostics?.medianNonZeroHrIntervalMs?.toFixed(0) ?? '—'} / {workoutDiagnostics?.p95NonZeroHrIntervalMs?.toFixed(0) ?? '—'} ms</span>
        <span>Zero HR: {workoutDiagnostics?.zeroHrCount ?? 0} · missing HR: {workoutDiagnostics?.missingHrCount ?? 0}</span>
        <span>Unique nonzero HR values: {workoutDiagnostics?.uniqueHrValueCount ?? 0} · consecutive repeats: {workoutDiagnostics?.consecutiveRepeatedHrCount ?? 0} · longest repeated run: {workoutDiagnostics?.longestRepeatedHrRun ?? 0}</span>
        <span>Classification: {workoutDiagnostics?.classification ?? 'PENDING'}</span>
        {workoutHeartRateEvent && <span>Last dedicated HR event: {workoutHeartRateEvent.heartRate} bpm · seq {workoutHeartRateEvent.packetSequence}</span>}
        {workoutError && <span role="alert">Workout error: {workoutError.message}</span>}
      </section>
      <div className="workout-packet-table-wrap">
        <table className="workout-packet-table">
          <thead><tr><th>Seq</th><th>Received</th><th>HR</th><th>Steps</th><th>Calories</th><th>ExerciseTime raw</th></tr></thead>
          <tbody>{workoutPackets.slice(-10).map((packet) => <tr key={`${packet.sessionId}-${packet.packetSequence}`}>
            <td>{packet.packetSequence}</td><td>{new Date(packet.receivedAt).toLocaleTimeString()}</td><td>{packet.heartRate ?? '—'}</td>
            <td>{packet.steps ?? '—'}</td><td>{packet.calories ?? '—'}</td><td>{packet.elapsedSeconds ?? '—'} s ({packet.exerciseTimeRaw ?? '—'})</td>
          </tr>)}</tbody>
        </table>
      </div>
      {message && <p className="error-message" role="alert">{message}</p>}
      {lastError && <p>Last native error: {lastError.code} — {lastError.message}</p>}
    </section>
  )
}
