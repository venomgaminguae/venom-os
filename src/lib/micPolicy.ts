/**
 * The rules that decide which microphone VENOM listens on, kept free of
 * imports so `node --test` can load this file directly
 * (test/mic-policy.test.mjs). audio.ts owns the devices; this owns the rules.
 *
 * Why these exist: the page used to take whatever Chrome handed it. On one
 * PC the app profile ranked first a headset microphone that read as near
 * silence (RMS 0.0002) while the real microphone was another device, so
 * listening sessions heard nothing and nothing on screen said so. The choice
 * is now ours: a saved choice, then a preferred label (only when one is set),
 * then the input that is actually carrying sound, then the first real input.
 */

/** Label fragment preferred when nothing is saved. Empty: no preference.
 *  VITE_MIC_PREFER sets one. */
export const DEFAULT_MIC_PREFER = ''
/** localStorage key of the saved choice (the device's label, which survives
 *  the device-id reshuffle that clearing site data causes). */
export const MIC_PREF_KEY = 'venom.mic.label'
/** Raw RMS (no echo cancellation, noise suppression or gain control) under
 *  which an input counts as carrying nothing. */
export const SILENT_RMS = 0.0005
/** Another input must be this many times louder than the current one, and
 *  above SILENT_RMS, before we leave the current one for it. */
export const SWITCH_RATIO = 4
/** The current input must have been silent this long before others are sampled. */
export const SILENT_AFTER_MS = 8000
/** Minimum gap between two samplings of the other inputs. */
export const RESAMPLE_MS = 60_000

export type MicInput = { deviceId: string; label: string }
export type MicWhy = 'saved' | 'preferred' | 'loudest' | 'default' | 'switched' | 'manual'
export type MicChoice = { deviceId: string; label: string; why: MicWhy } | null

/**
 * Chrome lists two aliases, "default" and "communications", beside the real
 * devices. They are the same hardware again under whatever Windows or the
 * profile ranks first, which is exactly the thing not to trust: drop them
 * when a real device exists.
 */
export function realInputs<T extends MicInput>(inputs: T[]): T[] {
  const real = inputs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
  return real.length ? real : inputs
}

/** "Microphone (Studio Mic) (abcd:ef01)" -> "Studio Mic". */
export function shortLabel(label: string): string {
  let s = (label || '').trim()
  s = s.replace(/^(Default|Communications)\s*-\s*/i, '')
  s = s.replace(/\s*\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
  const m = /^[^()]*\((.+)\)$/.exec(s)
  if (m && m[1].trim()) s = m[1].trim()
  return s || 'unnamed microphone'
}

const has = (label: string, part: string) =>
  Boolean(part.trim()) && label.toLowerCase().includes(part.trim().toLowerCase())

/**
 * Which input to open.
 *   1. the saved label, when that device is present;
 *   2. the first input whose label contains `prefer`, when `prefer` is not blank;
 *   3. the loudest input, when levels were measured and one is above silence;
 *   4. the first real input.
 * `levels` maps deviceId to raw RMS. null = there is no input at all.
 */
export function chooseMic(input: {
  inputs: MicInput[]
  saved?: string
  prefer?: string
  levels?: Record<string, number>
}): MicChoice {
  const list = realInputs(input.inputs)
  if (!list.length) return null
  const saved = (input.saved ?? '').trim()
  if (saved) {
    const d = list.find((x) => x.label === saved) ?? list.find((x) => shortLabel(x.label) === shortLabel(saved))
    if (d) return { ...d, why: 'saved' }
  }
  const prefer = (input.prefer ?? DEFAULT_MIC_PREFER).trim()
  const p = prefer ? list.find((x) => has(x.label, prefer)) : undefined
  if (p) return { ...p, why: 'preferred' }
  const loud = loudest(list, input.levels ?? {})
  if (loud) return { ...loud, why: 'loudest' }
  return { ...list[0], why: 'default' }
}

/** The loudest input above SILENT_RMS, or null when every one is silent or unmeasured. */
export function loudest<T extends MicInput>(inputs: T[], levels: Record<string, number>): T | null {
  let best: T | null = null
  let bestLevel = SILENT_RMS
  for (const d of realInputs(inputs)) {
    const v = levels[d.deviceId] ?? 0
    if (v > bestLevel) {
      best = d
      bestLevel = v
    }
  }
  return best
}

/**
 * The current input reads as silent: is there another one to move to?
 * Returns it only when it carries signal (above SILENT_RMS and SWITCH_RATIO
 * times the current input's level). A quiet room on a working microphone is
 * not a reason to move: every input is then equally quiet and this is null.
 */
export function switchTarget<T extends MicInput>(
  inputs: T[],
  currentId: string,
  levels: Record<string, number>,
): T | null {
  const cur = levels[currentId] ?? 0
  if (cur >= SILENT_RMS) return null
  const others = realInputs(inputs).filter((d) => d.deviceId !== currentId)
  const best = loudest(others, levels)
  if (!best) return null
  return (levels[best.deviceId] ?? 0) >= Math.max(SILENT_RMS, cur * SWITCH_RATIO) ? best : null
}

/** The input after the current one, wrapping. null when there is none to cycle to. */
export function nextMic<T extends MicInput>(inputs: T[], currentId: string): T | null {
  const list = realInputs(inputs)
  if (!list.length) return null
  const i = list.findIndex((d) => d.deviceId === currentId)
  return list[(i + 1) % list.length]
}

/** Follows the level and remembers how long it has been under SILENT_RMS. */
export function createSilenceWatch(silentAfterMs = SILENT_AFTER_MS, floor = SILENT_RMS) {
  let lastSound = -1
  return {
    /** Feed the raw RMS and a clock in ms. True once silent for silentAfterMs. */
    note(rms: number, now: number): boolean {
      if (lastSound < 0) lastSound = now
      if (rms >= floor) lastSound = now
      return now - lastSound >= silentAfterMs
    },
    reset(now: number): void {
      lastSound = now
    },
  }
}

export type MicState = 'starting' | 'live' | 'silent' | 'none' | 'denied'
export type MicLine = { text: string; level: 'ok' | 'busy' | 'warn' | 'bad' }

const WHY: Record<MicWhy, string> = {
  saved: 'your choice',
  manual: 'your choice',
  preferred: 'preferred',
  loudest: 'loudest input',
  default: 'first input',
  switched: 'switched',
}

/**
 * What the HUD says about the microphone, in one line (the meter is drawn
 * beside it).
 *   honoured: false when the engine hearing the owner is Chrome's own
 *   recogniser, which opens Chrome's microphone whatever the page chose.
 *   note: one-off message such as "switched from X: no signal".
 */
export function micLine(input: {
  state: MicState
  label: string
  why: MicWhy | ''
  count: number
  honoured: boolean
  note?: string
}): MicLine {
  const { state } = input
  if (state === 'denied') return { text: 'MIC BLOCKED · allow the microphone for this page', level: 'bad' }
  if (state === 'none') return { text: 'NO MICROPHONE FOUND', level: 'bad' }
  if (state === 'starting') return { text: 'mic · starting', level: 'busy' }
  const name = shortLabel(input.label)
  const key = input.count > 1 ? ' · M changes it' : ''
  if (state === 'silent') {
    return { text: `NO MIC SIGNAL · ${name} hears nothing${input.count > 1 ? ' · press M for another microphone' : ''}`, level: 'bad' }
  }
  if (!input.honoured) {
    return { text: `mic · ${name} · Chrome's recogniser uses Chrome's own microphone, not this one`, level: 'warn' }
  }
  if (input.note) return { text: `mic · ${name} · ${input.note}${key}`, level: 'warn' }
  const why = input.why ? ` (${WHY[input.why]})` : ''
  return { text: `mic · ${name}${why}${key}`, level: 'ok' }
}

/** Meter fill 0..1 from a raw RMS: -60 dBFS is empty, -12 dBFS is full. */
export function meterFill(rms: number): number {
  if (!(rms > 0)) return 0
  const db = 20 * Math.log10(rms)
  return Math.max(0, Math.min(1, (db + 60) / 48))
}
