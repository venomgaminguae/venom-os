/**
 * Neural speech, entirely in the browser.
 *
 * `speechSynthesis` is limited to whatever voices the operating system ships,
 * and on macOS the British male option is Daniel — a compact concatenative
 * voice from over a decade ago. It is the honest ceiling of the built-in API
 * and it sounds like a satnav.
 *
 * Kokoro is an 82M-parameter TTS model that runs on WebGPU via ONNX. No cloud,
 * no API key, nothing leaves the machine — but it sounds like a person. It
 * carries four British male voices, which is what this project actually wants.
 *
 * The cost is a one-time model download (311 MB at the default fp32), cached
 * by the browser afterwards. It's fetched during the boot sequence so the
 * first "Hey Venom" isn't waiting on it, and anything that goes wrong falls
 * back to the system voice, visibly (status() feeds the HUD) and never for
 * good: see voicePolicy.ts.
 */

import { KOKORO_DTYPE, KOKORO_SPEED, KOKORO_VOICE, TTS_ENGINE } from '../config'
import {
  createPacer,
  FAIL_STREAK,
  MAX_LOAD_ATTEMPTS,
  REST_MS,
  type KokoroState,
  type KokoroStatus,
} from './voicePolicy'

type Kokoro = {
  generate: (
    text: string,
    opts: { voice: string; speed?: number },
  ) => Promise<{ toBlob: () => Blob; audio?: Float32Array; sampling_rate?: number }>
}

let model: Kokoro | null = null
let loading: Promise<Kokoro | null> | null = null
let state: KokoroState = 'idle'
let restUntil = 0
let restWhy = ''
let loadAttempts = 0

/** 0..1 while the model downloads, for the boot readout. */
let progress = 0
export const loadProgress = () => progress

/** A rest that has run out ends here, on the next question anyone asks. */
function wake() {
  if (state !== 'resting' || Date.now() < restUntil) return
  restWhy = ''
  if (model) {
    state = 'ready'
  } else {
    state = 'idle'
    void load()
  }
}

/** In memory, warmed up and not resting: the next sentence can be his. */
export const isReady = () => {
  wake()
  return state === 'ready' && model !== null
}
/** Not usable right now (resting) or at all (failed). The system voice speaks. */
export const isUnavailable = () => {
  wake()
  return state === 'failed' || state === 'resting'
}

/** Exposed for diagnosis — the console warning alone is easy to miss. */
export let lastError = ''

/** How long the last load took (fetch + session, then the warm-up clips), and
 *  how the engine has behaved since. */
export const timing = {
  loadMs: 0,
  warmMs: 0,
  rests: 0,
  /** Times three judged sentences in a row were slower than realtime. */
  slowStreaks: 0,
  generated: 0,
  device: 'webgpu',
  dtype: KOKORO_DTYPE as string,
}

/** Everything the HUD and the bridge log need to explain the voice. */
export function status(): KokoroStatus {
  wake()
  return {
    state: TTS_ENGINE === 'kokoro' ? state : 'off',
    progress,
    lastError,
    restWhy,
    restMs: state === 'resting' ? Math.max(0, restUntil - Date.now()) : 0,
  }
}

function rest(why: string, dropModel = false) {
  state = 'resting'
  restUntil = Date.now() + REST_MS
  restWhy = why
  lastError = why
  timing.rests++
  if (dropModel) model = null
  console.warn(`[venom] kokoro resting ${REST_MS / 1000}s (${why}); the system voice speaks meanwhile.`)
}

/**
 * British male voices, in the order they suit the character. George is the
 * closest to a measured RP baritone; Fable is warmer, Lewis lower, Daniel
 * brighter.
 */
export const VOICES = ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const

/**
 * A voice id the model doesn't carry throws inside generate(), once per
 * sentence, for the life of the page — and a typo in an env var is the likeliest
 * way to get there. Check it once at module load and fall back audibly in the
 * console instead.
 */
function resolveVoice(): string {
  if ((VOICES as readonly string[]).includes(KOKORO_VOICE)) return KOKORO_VOICE
  console.warn(
    `[venom] VITE_KOKORO_VOICE="${KOKORO_VOICE}" is not one of ${VOICES.join(', ')} — using ${VOICES[0]}.`,
  )
  return VOICES[0]
}

const voice = resolveVoice()

let failures = 0
const pacer = createPacer()

/** Last generation: how long it took, and that time over the audio's length
 *  (below 1 is faster than realtime). */
export const stats = { lastMs: 0, rtf: 0 }

/**
 * Spoken to nobody right after the model loads. The first generations on a
 * fresh WebGPU session measured 1.3 to 3 seconds each here whatever their
 * length; paying that during the boot sequence keeps it out of the first
 * answer.
 */
const WARMUP = ['Yes, sir.', 'All systems are online, and I am ready when you are.']

export async function load(): Promise<Kokoro | null> {
  wake()
  if (model && state === 'ready') return model
  if (state === 'failed' || state === 'resting') return null
  if (loading) return loading

  loading = (async () => {
    const t0 = performance.now()
    state = 'loading'
    try {
      const { KokoroTTS, env } = await import('kokoro-js')
      // The ONNX runtime comes from this origin (scripts/ort-runtime.mjs
      // serves the installed copy at /ort/). Left unset, transformers.js
      // fetches it from cdn.jsdelivr.net, which the page's script-src refuses.
      env.wasmPaths = `${location.origin}/ort/`
      const tts = (await KokoroTTS.from_pretrained(
        'onnx-community/Kokoro-82M-v1.0-ONNX',
        {
          // fp32 by default (config.ts): q8 measured slower than realtime on
          // WebGPU here. Overridable (VITE_KOKORO_DTYPE) so the speed can be
          // measured.
          dtype: KOKORO_DTYPE,
          device: 'webgpu',
          // The callback is a union across several event shapes; only the
          // download-progress one carries a percentage.
          progress_callback: (p: unknown) => {
            const pct = (p as { progress?: number })?.progress
            if (typeof pct === 'number') progress = pct / 100
          },
        },
      )) as unknown as Kokoro
      progress = 1
      timing.loadMs = Math.round(performance.now() - t0)
      state = 'warming'
      const t1 = performance.now()
      for (const text of WARMUP) await tts.generate(text, { voice, speed: KOKORO_SPEED })
      timing.warmMs = Math.round(performance.now() - t1)
      model = tts
      state = 'ready'
      loadAttempts = 0
      failures = 0
      lastError = ''
      console.info(
        `[venom] kokoro ready: load ${timing.loadMs} ms, warm-up ${timing.warmMs} ms (${KOKORO_DTYPE}, webgpu)`,
      )
      return model
    } catch (err) {
      console.warn('[venom] kokoro unavailable, using the system voice:', err)
      const message = String((err as Error)?.message ?? err)
      model = null
      loadAttempts++
      if (loadAttempts >= MAX_LOAD_ATTEMPTS) {
        state = 'failed'
        lastError = message
      } else {
        // A dropped download or a busy graphics card is worth another go; a
        // machine without WebGPU fails the same way three times and stops.
        rest(`could not load (attempt ${loadAttempts} of ${MAX_LOAD_ATTEMPTS}): ${message}`.slice(0, 200))
      }
      return null
    } finally {
      loading = null
    }
  })()

  return loading
}

/** Synthesise one sentence. Returns null if the model isn't usable. */
export async function speak(text: string): Promise<string | null> {
  const tts = await load()
  if (!tts) return null
  try {
    const t0 = performance.now()
    const audio = await tts.generate(text, {
      voice,
      // Slightly under natural pace — the character is never hurried, and the
      // steadiness is most of the characterisation. Shared with the system
      // voice so a fallback mid-conversation does not change his pace.
      speed: KOKORO_SPEED,
    })
    failures = 0
    timing.generated++
    // Keeping up is part of working. Each sentence is generated while the one
    // before it plays, so slower than realtime means growing gaps mid-answer.
    // The pacer decides (voicePolicy.ts): clips too short to judge are left
    // out, and the penalty is a rest, not the end of the natural voice.
    const ms = performance.now() - t0
    const seconds = audio.audio && audio.sampling_rate ? audio.audio.length / audio.sampling_rate : 0
    if (seconds > 0) {
      stats.lastMs = Math.round(ms)
      stats.rtf = Math.round((ms / 1000 / seconds) * 100) / 100
      if (pacer.note(seconds, ms) === 'rest') {
        // Counted and logged, but he keeps the natural voice: resting meant
        // 45 s of the robotic system voice, which is worse than a gap.
        timing.slowStreaks++
        console.warn(
          `[venom] kokoro slower than realtime (${stats.rtf}x) three sentences running; keeping the natural voice.`,
        )
      }
    }
    return URL.createObjectURL(audio.toBlob())
  } catch (err) {
    // Surfaced rather than swallowed: a silent null here just looks like the
    // voice quietly reverting to the system one with no explanation.
    console.error('[venom] kokoro generation failed:', err)
    lastError = String((err as Error)?.message ?? err)
    failures++
    if (failures >= FAIL_STREAK) {
      // A lost WebGPU device fails every sentence the same way. Drop the
      // session and build a new one after the rest.
      failures = 0
      rest(`generation failed ${FAIL_STREAK} times running: ${lastError}`.slice(0, 200), true)
    }
    return null
  }
}

/** Voice ids this build of the model actually carries. */
export async function availableVoices(): Promise<string[]> {
  const tts = (await load()) as unknown as { voices?: Record<string, unknown> } | null
  return tts?.voices ? Object.keys(tts.voices) : []
}
