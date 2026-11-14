/**
 * The one shared microphone, plus analysers for the reactor and the HUD meter.
 *
 * getMic() hands out ONE stable MediaStream for the whole page life: the
 * output of a MediaStreamAudioDestinationNode. The real device stream feeds
 * that node through a gain "bus", so the device underneath can be changed
 * (by choice, by the M key, or because the current one hears nothing) without
 * any consumer (vad.ts, clap.ts, voice.ts, the reactor) noticing. Everything
 * that needs audio still goes through here.
 *
 * Which device is chosen is decided by the pure rules in micPolicy.ts; this
 * file owns the devices. State is published on `window.__mic`.
 */

import { MIC_PREFER } from '../config'
import {
  MIC_PREF_KEY,
  RESAMPLE_MS,
  SILENT_RMS,
  chooseMic,
  createSilenceWatch,
  nextMic,
  realInputs,
  shortLabel,
  switchTarget,
  type MicInput,
  type MicState,
  type MicWhy,
} from './micPolicy'

export type MicSnapshot = {
  state: MicState
  deviceId: string
  label: string
  why: MicWhy | ''
  note: string
  inputs: MicInput[]
  rms: number
  peak: number
  levels: Record<string, number>
  sampledAt: number
  error: string
  contextState: string
}

const snap: MicSnapshot = {
  state: 'starting',
  deviceId: '',
  label: '',
  why: '',
  note: '',
  inputs: [],
  rms: 0,
  peak: 0,
  levels: {},
  sampledAt: 0,
  error: '',
  contextState: '',
}
;(window as unknown as Record<string, unknown>).__mic = snap

/** The live microphone state (the same object as window.__mic). */
export function micSnapshot(): MicSnapshot {
  return snap
}

// --- the graph ------------------------------------------------------------

let ctx: AudioContext | null = null
let bus: GainNode | null = null
let dest: MediaStreamAudioDestinationNode | null = null
let meter: AnalyserNode | null = null
let meterBuf: Float32Array | null = null
let analyser: AnalyserNode | null = null
let buf: Uint8Array | null = null

/** The device stream currently feeding the bus, and its source node. */
let device: MediaStream | null = null
let source: MediaStreamAudioSourceNode | null = null

let opening: Promise<MediaStream> | null = null
let opened = false

const PROCESSING = { echoCancellation: true, noiseSuppression: true, autoGainControl: true }

const silence = createSilenceWatch()

function getCtx(): AudioContext {
  if (ctx) return ctx
  const c = new AudioContext()
  ctx = c
  void c.resume().catch(() => {})
  // Created before a user gesture it may stay suspended, and a suspended
  // context sends silence down the stable stream. Resume on the first gesture.
  const wake = () => {
    void c.resume().catch(() => {})
    window.removeEventListener('pointerdown', wake, true)
    window.removeEventListener('keydown', wake, true)
  }
  window.addEventListener('pointerdown', wake, true)
  window.addEventListener('keydown', wake, true)
  c.addEventListener('statechange', () => {
    snap.contextState = c.state
  })
  snap.contextState = c.state

  bus = c.createGain()
  dest = c.createMediaStreamDestination()
  bus.connect(dest)
  meter = c.createAnalyser()
  meter.fftSize = 2048
  meterBuf = new Float32Array(meter.fftSize)
  bus.connect(meter)
  return c
}

function deviceIdOf(s: MediaStream): string {
  const t = s.getAudioTracks()[0]
  return t?.getSettings().deviceId ?? ''
}

function stopStream(s: MediaStream | null): void {
  s?.getTracks().forEach((t) => t.stop())
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err)
}

/** Put `s` under the bus, replacing (and stopping) whatever was there. */
function attach(s: MediaStream, input: MicInput, why: MicWhy): void {
  const c = getCtx()
  const next = c.createMediaStreamSource(s)
  next.connect(bus!)
  const oldSource = source
  const oldDevice = device
  source = next
  device = s
  if (oldSource) oldSource.disconnect()
  if (oldDevice && oldDevice !== s) stopStream(oldDevice)

  snap.deviceId = deviceIdOf(s) || input.deviceId
  snap.label = input.label || s.getAudioTracks()[0]?.label || ''
  snap.why = why
  snap.state = 'live'
  snap.error = ''
  silence.reset(performance.now())
  console.info(`[venom] microphone: ${snap.label} (${why})`)
}

function openDevice(deviceId: string): Promise<MediaStream> {
  return navigator.mediaDevices.getUserMedia({
    audio: { deviceId: { exact: deviceId }, ...PROCESSING },
  })
}

async function listInputs(): Promise<MicInput[]> {
  const all = await navigator.mediaDevices.enumerateDevices()
  const inputs = all
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({ deviceId: d.deviceId, label: d.label }))
  snap.inputs = inputs
  return inputs
}

/** Switch to another device. Keeps the current one if the new one will not open. */
async function switchTo(input: MicInput, why: MicWhy): Promise<boolean> {
  try {
    attach(await openDevice(input.deviceId), input, why)
    return true
  } catch (err) {
    snap.error = `could not open ${shortLabel(input.label)}: ${errText(err)}`
    console.warn('[venom] microphone:', snap.error)
    return false
  }
}

// --- opening ----------------------------------------------------------------

/** The shared, stable microphone stream. Every caller gets the same object. */
export function getMic(): Promise<MediaStream> {
  if (opened && dest) return Promise.resolve(dest.stream)
  if (!opening) {
    opening = openFirst().catch((err: unknown) => {
      opening = null
      throw err
    })
  }
  return opening
}

async function openFirst(): Promise<MediaStream> {
  let perm: MediaStream
  try {
    // Unconstrained first: grants permission and makes the labels readable.
    perm = await navigator.mediaDevices.getUserMedia({ audio: { ...PROCESSING } })
  } catch (err) {
    snap.state = err instanceof DOMException && err.name === 'NotAllowedError' ? 'denied' : 'none'
    snap.error = errText(err)
    throw err
  }
  getCtx()

  let inputs: MicInput[] = []
  try {
    inputs = await listInputs()
  } catch {
    /* fall through to the permission stream */
  }
  const permId = deviceIdOf(perm)
  const permInput: MicInput = { deviceId: permId, label: perm.getAudioTracks()[0]?.label ?? '' }
  const saved = localStorage.getItem(MIC_PREF_KEY) ?? ''
  let choice = chooseMic({ inputs, saved, prefer: MIC_PREFER })
  if (choice && choice.why !== 'saved' && choice.why !== 'preferred') {
    // Nothing named: measure which input actually carries sound.
    const levels = await sampleInputs()
    choice = chooseMic({ inputs, saved, prefer: MIC_PREFER, levels })
  }

  if (!choice || choice.deviceId === permId) {
    attach(perm, choice ?? permInput, choice?.why ?? 'default')
  } else {
    stopStream(perm)
    try {
      attach(await openDevice(choice.deviceId), choice, choice.why)
    } catch (err) {
      console.warn(`[venom] microphone: could not open ${shortLabel(choice.label)}: ${errText(err)}`)
      // Fall back to the device the permission stream had.
      const back = permId
        ? await openDevice(permId)
        : await navigator.mediaDevices.getUserMedia({ audio: { ...PROCESSING } })
      attach(back, permInput, 'default')
      snap.error = `could not open ${shortLabel(choice.label)}: ${errText(err)}`
    }
  }

  opened = true
  startMonitor()
  return dest!.stream
}

// --- sampling ---------------------------------------------------------------

let sampling: Promise<Record<string, number>> | null = null

/**
 * Raw RMS of every real input, one after another, with no echo cancellation,
 * noise suppression or gain control, so a dead input reads as dead. Never two
 * at once: a second call gets the running one.
 */
export function sampleInputs(ms = 700): Promise<Record<string, number>> {
  if (sampling) return sampling
  sampling = doSample(ms).finally(() => {
    sampling = null
  })
  return sampling
}

async function doSample(ms: number): Promise<Record<string, number>> {
  const c = getCtx()
  const inputs = snap.inputs.length ? snap.inputs : await listInputs().catch(() => [] as MicInput[])
  const levels: Record<string, number> = {}
  for (const d of realInputs(inputs)) {
    let s: MediaStream | null = null
    try {
      s = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId: { exact: d.deviceId },
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      })
      levels[d.deviceId] = await measure(c, s, ms)
    } catch {
      levels[d.deviceId] = 0
    } finally {
      stopStream(s)
    }
  }
  snap.levels = levels
  snap.sampledAt = Date.now()
  return levels
}

function measure(c: AudioContext, s: MediaStream, ms: number): Promise<number> {
  const src = c.createMediaStreamSource(s)
  const a = c.createAnalyser()
  a.fftSize = 2048
  src.connect(a)
  const b = new Float32Array(a.fftSize)
  const frames: number[] = []
  const t0 = performance.now()
  return new Promise((resolve) => {
    const id = setInterval(() => {
      const t = performance.now() - t0
      if (t >= 150) {
        a.getFloatTimeDomainData(b as Float32Array<ArrayBuffer>)
        frames.push(rmsOf(b))
      }
      if (t >= ms) {
        clearInterval(id)
        src.disconnect()
        resolve(frames.length ? frames.reduce((x, y) => x + y, 0) / frames.length : 0)
      }
    }, 50)
  })
}

function rmsOf(b: Float32Array): number {
  let sum = 0
  for (let i = 0; i < b.length; i++) sum += b[i] * b[i]
  return Math.sqrt(sum / b.length)
}

// --- monitoring -------------------------------------------------------------

let monitor: ReturnType<typeof setInterval> | null = null
let recent: { at: number; rms: number }[] = []
/** A sampling, switch or re-choice is running. */
let busy = false

function startMonitor(): void {
  if (monitor) return
  monitor = setInterval(tick, 100)
  navigator.mediaDevices.addEventListener('devicechange', () => {
    void onDeviceChange()
  })
}

function tick(): void {
  if (!meter || !meterBuf) return
  if (ctx) snap.contextState = ctx.state
  meter.getFloatTimeDomainData(meterBuf as Float32Array<ArrayBuffer>)
  const rms = rmsOf(meterBuf)
  const now = performance.now()
  snap.rms = rms
  recent.push({ at: now, rms })
  while (recent.length && now - recent[0].at > 3000) recent.shift()
  snap.peak = recent.reduce((m, r) => Math.max(m, r.rms), 0)

  if (rms >= SILENT_RMS && snap.state === 'silent') snap.state = 'live'
  // A suspended context reads as silence that is not the microphone's fault.
  if (ctx && ctx.state !== 'running') {
    silence.reset(now)
    return
  }
  if (!silence.note(rms, now) || busy || sampling) return
  if (snap.sampledAt && Date.now() - snap.sampledAt < RESAMPLE_MS) return
  void checkSilence()
}

async function checkSilence(): Promise<void> {
  busy = true
  try {
    const inputs = await listInputs().catch(() => snap.inputs)
    const levels = await sampleInputs()
    const currentId = snap.deviceId
    const target = switchTarget(inputs, currentId, levels)
    if (target) {
      const old = snap.label
      if (await switchTo(target, 'switched')) {
        // Not saved: the owner's own choice stays what he chose.
        snap.note = `switched from ${shortLabel(old)}: no signal`
      }
    } else if ((levels[currentId] ?? 0) < SILENT_RMS) {
      snap.state = 'silent'
    } else {
      // A quiet room on a working microphone is not an alarm.
      snap.state = 'live'
    }
  } finally {
    busy = false
  }
}

async function onDeviceChange(): Promise<void> {
  let inputs: MicInput[]
  try {
    inputs = await listInputs()
  } catch {
    return
  }
  if (!opened || busy) return
  if (inputs.some((d) => d.deviceId === snap.deviceId)) return
  // The device in use went away: choose again.
  busy = true
  try {
    const choice = chooseMic({
      inputs,
      saved: localStorage.getItem(MIC_PREF_KEY) ?? '',
      prefer: MIC_PREFER,
      levels: snap.levels,
    })
    if (!choice) {
      snap.state = 'none'
      return
    }
    await switchTo(choice, choice.why)
  } finally {
    busy = false
  }
}

// --- choosing by hand -------------------------------------------------------

/** Move to the next input (the M key) and remember it. Returns the label in use. */
export async function cycleMic(): Promise<string> {
  if (!opened || busy) return snap.label
  const inputs = await listInputs().catch(() => snap.inputs)
  if (realInputs(inputs).length < 2) return snap.label
  const next = nextMic(inputs, snap.deviceId)
  if (!next || next.deviceId === snap.deviceId) return snap.label
  busy = true
  try {
    if (await switchTo(next, 'manual')) {
      localStorage.setItem(MIC_PREF_KEY, next.label)
      snap.note = ''
      silence.reset(performance.now())
    }
  } finally {
    busy = false
  }
  return snap.label
}

/** Open a specific input now, under the stable stream. Does not save it. */
export async function useMic(deviceId: string, why: MicWhy): Promise<void> {
  await getMic()
  const inputs = snap.inputs.length ? snap.inputs : await listInputs()
  const input = inputs.find((d) => d.deviceId === deviceId) ?? { deviceId, label: '' }
  await switchTo(input, why)
}

// --- the reactor ------------------------------------------------------------

export async function startAnalyser(): Promise<void> {
  if (analyser) return
  await getMic()
  const c = getCtx()
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.75
  bus!.connect(a)
  buf = new Uint8Array(a.frequencyBinCount)
  analyser = a
}

/** 0..1 loudness. Returns 0 before the analyser is up. */
export function micLevel(): number {
  if (!analyser || !buf) return 0
  analyser.getByteFrequencyData(buf as Uint8Array<ArrayBuffer>)
  let sum = 0
  // Skip the lowest bins — they're mostly rumble and mains hum.
  for (let i = 4; i < buf.length; i++) sum += buf[i]
  const avg = sum / (buf.length - 4) / 255
  // Voice sits low in this range; stretch it so the visuals actually move.
  return Math.min(1, avg * 3.2)
}

/** Analyser fed from an <audio> element, so the orb reacts while VENOM talks. */
export function attachOutputAnalyser(el: HTMLAudioElement): () => number {
  const c = new AudioContext()
  const src = c.createMediaElementSource(el)
  const a = c.createAnalyser()
  a.fftSize = 512
  a.smoothingTimeConstant = 0.7
  src.connect(a)
  a.connect(c.destination)
  const b = new Uint8Array(a.frequencyBinCount)
  return () => {
    a.getByteFrequencyData(b as Uint8Array<ArrayBuffer>)
    let sum = 0
    for (let i = 2; i < b.length; i++) sum += b[i]
    return Math.min(1, sum / (b.length - 2) / 255 * 3)
  }
}
