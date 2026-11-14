/**
 * The rules that decide which voice engine speaks, kept free of imports so
 * `node --test` can load this file directly (test/voice-policy.test.mjs).
 *
 * Why these exist: the first Kokoro build dropped to the system voice FOR THE
 * REST OF THE PAGE after three generations slower than realtime. On this PC a
 * single short clause ("Done.") costs a fixed second or so however short it
 * is, and a busy graphics card (it is shared with a local language model)
 * makes one long sentence take twice its own length now and then. Three such
 * in a row and the natural voice was gone until the next reload, with nothing
 * on screen to say so. Slow is now judged only on clips long enough to judge,
 * and the penalty is a rest, never a permanent switch.
 */

/** A clip shorter than this is all fixed overhead; its speed says nothing. */
export const MIN_JUDGED_SECONDS = 2
/** Slow judged clips in a row before Kokoro rests. */
export const SLOW_STREAK = 3
/** Generation errors in a row before Kokoro rests and reloads. */
export const FAIL_STREAK = 3
/** How long a rest lasts. The system voice speaks meanwhile. Only failures
 *  (a load or three generations in a row) cause a rest; a slow streak does
 *  not, because a slow natural voice is better than a robotic one. */
export const REST_MS = 45_000
/**
 * How long one sentence (and the end of the boot sequence) waits for a model
 * that is still loading before the system voice is allowed to speak it. The
 * owner would rather wait a moment than hear the robotic voice; a load that
 * takes longer than this (a first download on a slow line) is treated like a
 * failure for that one sentence, and the HUD says so.
 */
export const LOAD_WAIT_MS = 20_000
/** A failed model load is retried this many times, a rest apart. */
export const MAX_LOAD_ATTEMPTS = 3

export type PaceVerdict = 'ok' | 'rest'

/**
 * Feed it every finished generation. 'rest' means: enough judged clips in a
 * row were slower than realtime that the listener is hearing gaps.
 */
export function createPacer(streak = SLOW_STREAK, minSeconds = MIN_JUDGED_SECONDS) {
  let slow = 0
  return {
    note(audioSeconds: number, generationMs: number): PaceVerdict {
      if (!(audioSeconds > 0)) return 'ok'
      // Too short to judge: neither counts against him nor clears the count.
      if (audioSeconds < minSeconds) return 'ok'
      const rtf = generationMs / 1000 / audioSeconds
      if (rtf <= 1) {
        slow = 0
        return 'ok'
      }
      slow++
      if (slow < streak) return 'ok'
      slow = 0
      return 'rest'
    },
    streak: () => slow,
  }
}

export type KokoroState = 'off' | 'idle' | 'loading' | 'warming' | 'ready' | 'resting' | 'failed'

export type KokoroStatus = {
  state: KokoroState
  /** 0..1 while the model downloads. */
  progress: number
  lastError: string
  /** Why it is resting, when it is. */
  restWhy: string
  /** Milliseconds of rest left. */
  restMs: number
}

/** One short phrase: why the system voice is speaking instead of Kokoro. '' when Kokoro speaks. */
export function whyNotKokoro(s: KokoroStatus): string {
  switch (s.state) {
    case 'ready':
      return ''
    case 'off':
      return 'natural voice switched off (VITE_TTS_ENGINE=system)'
    case 'idle':
      return 'natural voice not started yet'
    case 'loading':
      return s.progress > 0 && s.progress < 1
        ? `natural voice downloading ${Math.round(s.progress * 100)}%`
        : 'natural voice loading'
    case 'warming':
      return 'natural voice warming up'
    case 'resting':
      return `natural voice resting ${Math.ceil(s.restMs / 1000)}s: ${s.restWhy || 'unknown'}`
    case 'failed':
      return `natural voice failed: ${s.lastError || 'unknown error'}`
  }
}

export type VoiceLine = { text: string; level: 'ok' | 'busy' | 'warn' | 'bad' }

/**
 * What the HUD says about the voice, in one line.
 * `engine` is the engine of the last sentence handed over ('' before any).
 */
export function voiceLine(input: {
  kokoro: KokoroStatus
  kokoroVoice: string
  engine: string
  systemVoice: string
  alarm: string
}): VoiceLine {
  const { kokoro: k, engine, alarm } = input
  if (alarm) return { text: `VOICE FAILED · ${alarm}`, level: 'bad' }
  const sys = input.systemVoice ? `system voice (${input.systemVoice})` : 'system voice'
  if (engine === 'elevenlabs') return { text: 'voice · ElevenLabs', level: 'ok' }
  if (k.state === 'ready') {
    const name = input.kokoroVoice.replace(/^[a-z]{2}_/, '')
    return { text: `voice · Kokoro natural (${name})`, level: 'ok' }
  }
  const why = whyNotKokoro(k)
  if (k.state === 'loading' || k.state === 'warming' || k.state === 'idle') {
    // No system voice while the model loads: he waits for it (LOAD_WAIT_MS).
    return { text: `voice · ${why} · he speaks when it is ready`, level: 'busy' }
  }
  if (k.state === 'off') return { text: `voice · ${sys}`, level: 'ok' }
  return { text: `voice · ${sys} · ${why}`, level: k.state === 'failed' ? 'bad' : 'warn' }
}

export type VoiceInfo = { name: string; lang: string; localService: boolean }

/**
 * The voice of last resort: an installed (local) English voice, used only when
 * the chosen voice produced no sound. Network voices are excluded on purpose:
 * the failure being covered is usually the network voice itself. British and
 * male first, to stay near the character.
 */
export function pickLocalBackup<T extends VoiceInfo>(voices: T[], not = ''): T | null {
  const local = voices.filter((v) => v.localService && /^en/i.test(v.lang) && v.name !== not)
  if (!local.length) return null
  const score = (v: T) => {
    const n = v.name.toLowerCase()
    let s = 0
    if (/en[-_]gb/i.test(v.lang)) s += 20
    if (/\b(george|ryan|thomas|david|mark|guy|daniel|oliver|arthur|james)\b/.test(n)) s += 10
    if (/\b(zira|hazel|susan|jenny|aria|sonia|libby|catherine|linda|heera)\b/.test(n)) s -= 10
    if (n.includes('natural') || n.includes('online')) s += 15
    return s
  }
  return [...local].sort((a, b) => score(b) - score(a))[0]
}
