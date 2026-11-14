import {
  env,
  USE_ELEVENLABS,
  BACKEND,
  TTS_ENGINE,
  KOKORO_VOICE,
  BRIDGE_HTTP_URL,
} from '../config'
import * as kokoro from './kokoro'
import { caps } from './capabilities'
import { createHeardLog } from './heard'
import { createChunker } from './chunker'
import { LOAD_WAIT_MS, pickLocalBackup, whyNotKokoro } from './voicePolicy'

/**
 * Speech output.
 *
 * The browser's own speechSynthesis is the default because it is by far the
 * fastest thing available: it runs on-device, so there is no request, no
 * generation wait and no download — speech starts on the next frame. A cloud
 * voice sounds better but costs a few hundred milliseconds per sentence, and in
 * conversation that gap is much more noticeable than the timbre.
 *
 * Either way, text is cut into clauses and sentences as it streams in (see
 * chunker.ts) and spoken a piece at a time, so VENOM starts talking on the
 * first clause while Claude is still writing.
 *
 * The queue is an explicit array with a single pump rather than a promise
 * chain. A chain cannot be cut: cancelling mid-sentence left the chain's tail
 * unresolved forever, which wedged the whole assistant. An array can simply be
 * emptied.
 */

type Speaker = {
  /** Feed streamed text in. Complete sentences are spoken as they appear. */
  push: (delta: string) => void
  /** Speak a phrase ahead of anything still queued. Used for filler like
   *  "Working on it, sir" while a tool runs. */
  say: (text: string) => void
  /** No more text coming — flush the remainder and resolve when audio ends. */
  end: () => Promise<void>
  /** Cut it off mid-sentence (barge-in). Always settles `end()`. */
  cancel: () => void
  /** 0..1 output loudness for the visualiser. */
  level: () => number
  /** What of the pushed answer has actually sounded, whole words only.
   *  Fillers from say() are not part of the answer and never count. Still
   *  right after cancel(), which measures before it stops anything. */
  heard: () => string
}

// ---------------------------------------------------------------------------
// What he is saying right now
// ---------------------------------------------------------------------------

let speaking = ''
let recent = ''
let recentUntil = 0

/** Recognition lags the speakers by a few hundred milliseconds, so a sentence
 *  keeps arriving at the microphone well after it has finished playing. */
const ECHO_TAIL_MS = 1800

/**
 * Why you cannot hear him.
 *
 * Published on `window.__tts`. Speech has exactly four ways to fail silently —
 * the engine never started, the OS voice errored, every line was cancelled by
 * a barge-in, or nothing was ever queued — and from outside the page they are
 * indistinguishable. This tells them apart at a glance.
 */
/** One spoken (or unspoken) sentence, for the HUD, the bridge log and the proof. */
export type SentenceLog = {
  at: number
  engine: 'system' | 'kokoro' | 'elevenlabs'
  voice: string
  text: string
  /** Sound actually began. */
  started: boolean
  /** Loudest RMS seen on the output node while it played, 0..1. -1 where the
   *  page cannot measure: the operating system plays system voices itself. */
  rms: number
  /** Why this sentence was not Kokoro's; '' when it was. */
  why: string
}

export const diag = {
  engine: 'system' as 'system' | 'kokoro' | 'elevenlabs',
  /** Utterances handed to an engine — the OS voice or an audio element. */
  spoken: 0,
  /**
   * Of those, how many actually began producing sound.
   *
   * Counted for EVERY engine, which it did not used to be: this was incremented
   * only in speakNative's onstart, so on the ElevenLabs path — the good path,
   * the one a configured machine actually uses — it stayed at zero forever.
   * The diagnostics panel reads this to decide whether he is audible at all, so
   * a working cloud voice reported "no sound produced", and the T self-test
   * raised that as an error on screen. The verdict has to be about sound, not
   * about which code path produced it.
   */
  started: 0,
  /** Genuine engine failures, excluding deliberate cancels. */
  failures: 0,
  /** Last SpeechSynthesis error code, e.g. 'synthesis-failed'. */
  lastError: '',
  /** Set once the OS voice has proved unusable; the cloud voice takes over. */
  nativeBroken: false,
  /** Sentences rescued by the bridge's ElevenLabs proxy. */
  rescued: 0,
  voice: '',
  lastText: '',
  /** Why the last sentence was not Kokoro's; '' when it was. */
  why: '',
  /** Sentences no engine managed to sound. */
  silent: 0,
  /** Set when a sentence went unspoken; the HUD shows it until one sounds. */
  alarm: '',
  /** The last 40 sentences, newest last. */
  log: [] as SentenceLog[],
  /** Kokoro's state, read live (JSON.stringify sees it too). */
  get kokoro() {
    return { ...kokoro.status(), ...kokoro.timing, rtf: kokoro.stats.rtf, lastMs: kokoro.stats.lastMs }
  },
  /** The system voice a fallback sentence would use right now. */
  get systemVoice(): string {
    return typeof speechSynthesis === 'undefined' ? '' : (pickVoice()?.name ?? 'default')
  },
}

if (typeof window !== 'undefined') {
  ;(window as unknown as Record<string, unknown>).__tts = diag
}

/**
 * Once the OS voice has failed, stop asking it.
 *
 * A broken system voice is not a transient condition — it fails identically on
 * every sentence — so retrying it per line would make the whole answer stutter
 * through the same dead path. After the first real failure everything routes to
 * the bridge's speech proxy instead, which holds an ElevenLabs key already.
 */
let nativeBroken = false

let speakingAt = 0

/** When the current sentence started, or 0 if nothing is being spoken. The
 *  voice loop uses this to refuse to interrupt him in his own first syllable. */
export function speakingSince(): number {
  return speaking ? speakingAt : 0
}

function setSpeaking(text: string) {
  if (text) {
    speaking = text
    speakingAt = Date.now()
    return
  }
  if (speaking) {
    recent = speaking
    recentUntil = Date.now() + ECHO_TAIL_MS
  }
  speaking = ''
}

/**
 * What the microphone is likely to be hearing from the speakers right now.
 *
 * The voice loop reads this to recognise itself: the mic stays open while he
 * talks, so it hears every word he says and would otherwise treat his own
 * answer as a barge-in. Includes a short tail of the previous sentence,
 * because the gap between two sentences is exactly when the echo of the first
 * one lands. See `isEcho` in voice.ts.
 */
export function speakingNow(): string {
  const tail = Date.now() < recentUntil ? recent : ''
  return `${speaking} ${tail}`.trim()
}

// ---------------------------------------------------------------------------
// Voice selection
// ---------------------------------------------------------------------------

const VOICE_PREF_KEY = 'venom.voice.v2'
const OLD_VOICE_PREF_KEY = 'venom.voice'

/** Set when the chosen system voice produced no sound and an installed one
 *  did: that one speaks every later fallback sentence on this page. */
let localOverride: SpeechSynthesisVoice | null = null

/**
 * Rank installed voices by how close they are to the character: a British
 * male, low and level, not a novelty voice.
 *
 * The big win on macOS is the Enhanced/Premium variant of Daniel. The stock
 * "Daniel" is a compact voice from a decade ago and sounds it; the Enhanced
 * download is free (System Settings → Accessibility → Spoken Content → System
 * Voice → Manage Voices) and once installed it appears here automatically.
 */
function score(v: SpeechSynthesisVoice): number {
  const n = v.name.toLowerCase()
  let s = 0

  // Venom speaks with Google's voices in Chrome: the British male first, then
  // the other Google English voices. Microsoft voices are kept out entirely
  // (the user's choice), so they never win even when nothing else matches.
  if (n.includes('google uk english male')) s += 120
  else if (n.startsWith('google') && /^en/i.test(v.lang)) s += 70
  else if (n.startsWith('daniel')) s += 100
  else if (/\b(oliver|arthur|jamie|malcolm)\b/.test(n)) s += 80
  // Newer macOS en-GB male voices — casual, but serviceable.
  else if (/\b(reed|rocko|eddy)\b/.test(n)) s += 40

  // Higher-quality variants of whatever matched above.
  if (n.includes('premium')) s += 30
  else if (n.includes('enhanced')) s += 20

  if (/en[-_]gb/i.test(v.lang)) s += 25
  else if (/^en/i.test(v.lang)) s += 5

  // Voices that clearly aren't a butler.
  if (/grandma|grandpa|bubbles|jester|bells|boing|whisper|zarvox|superstar|trinoids|wobble|bahh|organ|cellos|bad news|good news/.test(n)) {
    s -= 200
  }
  if (n.includes('microsoft')) s -= 300
  // Female-presenting names across the English sets.
  if (/\b(flo|sandy|shelley|kate|serena|fiona|moira|karen|tessa|samantha|zoe|allison|ava|susan)\b/.test(n)) {
    s -= 60
  }

  return s
}

/** Only voices that scored on a name match, not merely on being English —
 *  otherwise the picker cycles through a dozen US novelty voices. */
const USABLE = 40

/** Best-first list of usable voices — also what the voice picker cycles. */
export function candidateVoices(): SpeechSynthesisVoice[] {
  return speechSynthesis
    .getVoices()
    .filter((v) => /^en/i.test(v.lang))
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s >= USABLE)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.v)
}

let cachedVoice: SpeechSynthesisVoice | null | undefined

function pickVoice(): SpeechSynthesisVoice | null {
  if (localOverride) return localOverride
  if (cachedVoice !== undefined) return cachedVoice
  const all = speechSynthesis.getVoices()
  if (!all.length) return null // not loaded yet — try again next utterance

  // Honour an explicit choice made with the voice picker. A saved name that no
  // longer resolves is dropped rather than left to resurrect itself silently
  // if that voice is ever reinstalled.
  localStorage.removeItem(OLD_VOICE_PREF_KEY)
  const saved = localStorage.getItem(VOICE_PREF_KEY)
  if (saved) {
    const hit = /microsoft/i.test(saved) ? undefined : all.find((v) => v.name === saved)
    if (hit) return (cachedVoice = hit)
    localStorage.removeItem(VOICE_PREF_KEY)
  }

  const english = all.filter((v) => /^en/i.test(v.lang))
  cachedVoice =
    candidateVoices()[0] ??
    english.find((v) => /^google/i.test(v.name)) ??
    english.find((v) => !/microsoft/i.test(v.name)) ??
    english[0] ??
    null
  return cachedVoice
}

/** What the HUD should show. Reports the engine actually in use rather than
 *  always naming a speechSynthesis voice that a cloud or neural engine has
 *  quietly replaced. */
export function currentVoiceName(): string {
  if (USE_ELEVENLABS || caps().tts) return 'ElevenLabs'
  if (TTS_ENGINE === 'kokoro' && kokoro.isReady()) {
    return KOKORO_VOICE.replace(/^bm_/, '')
  }
  return pickVoice()?.name ?? 'default'
}

/** Step to the next candidate — lets you audition voices on your own machine
 *  rather than trusting a ranking to be right about how they sound. */
export function cycleVoice(): string {
  const list = candidateVoices()
  if (!list.length) return 'default'
  const now = pickVoice()
  const i = list.findIndex((v) => v.name === now?.name)
  const next = list[(i + 1) % list.length]
  localStorage.setItem(VOICE_PREF_KEY, next.name)
  localOverride = null
  cachedVoice = next
  return next.name
}

// Voices load asynchronously in Chrome; the first call usually returns nothing.
if (typeof speechSynthesis !== 'undefined') {
  speechSynthesis.addEventListener('voiceschanged', () => {
    cachedVoice = undefined
    pickVoice()
  })
  pickVoice()
}

// ---------------------------------------------------------------------------
// Shared output analyser
// ---------------------------------------------------------------------------

/**
 * One AudioContext for every sentence ever spoken.
 *
 * Blink caps a document at roughly six concurrent hardware contexts. Building
 * one per sentence and never closing it meant the visualiser died partway
 * through the first long answer, silently, because the constructor throw was
 * caught and ignored.
 */
let outCtx: AudioContext | null = null

function outputContext(): AudioContext | null {
  try {
    if (!outCtx) outCtx = new AudioContext()
    if (outCtx.state === 'suspended') void outCtx.resume()
    return outCtx
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------

/**
 * Nudge the delivery toward VENOM's cadence.
 *
 * speechSynthesis ignores SSML, so punctuation is the only prosody control
 * available — the engine pauses on commas and full stops. Making sure the
 * vocative "sir" is always set off by a comma buys the small beat before it
 * that does most of the characterisation.
 */
function shape(text: string): string {
  return (
    text
      // Models leak markdown even when told not to, and a synthesiser will
      // happily read "https colon slash slash" out loud. Strip the syntax and
      // keep the words.
      .replace(/^\s*Sources?:.*$/gim, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // [label](url) -> label
      // Stop before trailing punctuation, so "See https://x.com." keeps the
      // full stop that ends the sentence rather than having it eaten.
      .replace(/https?:\/\/[^\s]*[^\s.,;:!?)\]]/g, '')
      .replace(/[*_`#>]+/g, '')
      .replace(/^\s*[-•]\s+/gm, '')
      // The vocative wants its comma — that small beat before "sir" does most
      // of the characterisation. Anchored to a following pause or end of line
      // so the honorific is left alone: "Sir Isaac Newton" is not a vocative.
      .replace(/([^,\s])\s+(sir)(\s*[.,!?;:]|\s*$)/gi, '$1, $2$3')
      .replace(/\s+/g, ' ')
      .trim()
  )
}

type Item = {
  text: string
  /** Generation starts one sentence ahead, not all at once. */
  audio?: Promise<string | null> | null
  /** From say(): spoken, but not part of the answer he is told. */
  filler?: boolean
  /** The engine chosen when generation was started, and why not Kokoro. */
  engine?: SentenceLog['engine']
  why?: string
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

/** Is there a cloud voice to ask at all? Without one, asking is a wasted
 *  request and, worse, used to stand in front of Kokoro. */
const cloudVoice = () => USE_ELEVENLABS || caps().tts

function logSentence(item: Item): SentenceLog {
  const entry: SentenceLog = {
    at: Date.now(),
    engine: item.engine ?? 'system',
    voice: '',
    text: item.text.slice(0, 80),
    started: false,
    rms: -1,
    why: item.why ?? '',
  }
  diag.log.push(entry)
  if (diag.log.length > 40) diag.log.shift()
  return entry
}

export function createSpeaker(): Speaker {
  const queue: Item[] = []
  // Decides where streamed text may be cut: first clause out early, and never
  // inside a number, time, price, URL or abbreviation.
  const chunker = createChunker()
  let cancelled = false
  let outLevel = 0
  let pumping = false

  let currentAudio: HTMLAudioElement | null = null
  let nativeInFlight = false
  let drained: Array<() => void> = []

  /**
   * What he has actually heard of the answer, for interruption memory.
   * `measure` reads the live position of whatever answer chunk is sounding
   * right now; null when nothing of the answer is playing.
   */
  const log = createHeardLog()
  let measure: (() => void) | null = null

  const settleDrained = () => {
    const waiting = drained
    drained = []
    for (const r of waiting) r()
  }

  const enqueue = (sentence: string, priority = false) => {
    if (cancelled) return
    // Shape once here so both engines get the same text — stripped markdown,
    // and the comma before "sir" that buys the beat.
    const text = shape(sentence)
    if (!text) return

    const item: Item = { text, filler: priority }
    if (priority) {
      // Genuinely ahead of the queue this time. The old `say()` appended to the
      // same chain and only appeared to preempt because it was called when the
      // queue happened to be empty.
      queue.unshift(item)
    } else {
      queue.push(item)
    }
    // The next sentence in line is generated while the current one plays.
    // The pump only primes what is already queued when a sentence starts, so a
    // sentence that arrived during playback used to wait for the end of it:
    // about a second of silence after the first sentence of every answer.
    if (pumping && queue[0] === item) prime(item)
    void pump()
  }

  /**
   * Choose the engine for one sentence and start generating. `audio` null
   * means "no audio pipeline, use the system voice directly".
   *
   * Order matters. A cloud voice is used only when one exists. This used to
   * read `USE_ELEVENLABS || caps().tts || nativeBroken`: one system-voice
   * sentence that was slow to start (a network voice, while the Kokoro model
   * was still downloading) set nativeBroken, and from then on every sentence
   * asked a cloud voice that was never configured and fell back to the system
   * voice, with Kokoro never asked again until the page was reloaded.
   */
  function synthesise(text: string): Pick<Item, 'audio' | 'engine' | 'why'> {
    if (cloudVoice()) {
      // Recorded at the moment the tier is chosen, so the panel names the
      // engine that is actually about to speak.
      return { audio: fetchCloudAudio(text).catch(() => null), engine: 'elevenlabs', why: '' }
    }
    if (TTS_ENGINE === 'kokoro') {
      // Only once the model is in memory. Until then he waits for it (see
      // below); load() is idempotent and is also kicked off at boot.
      // One failed generation gets a second go before the system voice is
      // allowed to speak the sentence.
      const natural = () =>
        kokoro
          .speak(text)
          .then((url) => url ?? (kokoro.isReady() ? kokoro.speak(text) : null))
          .catch(() => null)
      if (kokoro.isReady()) {
        return { audio: natural(), engine: 'kokoro', why: '' }
      }
      if (!kokoro.isUnavailable()) {
        void kokoro.load()
        // Still loading or warming up: wait for it rather than speak in the
        // robotic system voice (the owner's choice). The HUD line says the
        // voice is loading meanwhile. Only a load that outlasts LOAD_WAIT_MS,
        // or fails, hands this sentence to the system voice.
        const waited = (async () => {
          const until = Date.now() + LOAD_WAIT_MS
          while (Date.now() < until && !kokoro.isReady() && !kokoro.isUnavailable()) await sleep(150)
          return kokoro.isReady() ? natural() : null
        })()
        return { audio: waited, engine: 'kokoro', why: '' }
      }
    }
    return { audio: null, engine: 'system', why: whyNotKokoro(kokoro.status()) }
  }

  /** Start generating an item's audio if it hasn't begun. */
  const prime = (item: Item | undefined) => {
    if (item && item.audio === undefined) Object.assign(item, synthesise(item.text))
  }

  async function pump(): Promise<void> {
    if (pumping) return
    pumping = true
    try {
      for (;;) {
        if (cancelled) break
        const item = queue.shift()
        if (!item) break

        prime(item)
        // Exactly one sentence ahead. Priming the whole queue fires every
        // request at once — four parallel cloud POSTs, or four concurrent
        // generations against a single ONNX session.
        prime(queue[0])

        await speakOne(item)
      }
    } finally {
      pumping = false
      if (cancelled || !queue.length) settleDrained()
    }
  }

  /**
   * Speak one sentence, and do not give up while any engine is left: the
   * chosen engine, the system voice, an installed backup voice, a cloud voice
   * where one exists, Kokoro again. If all of them stay silent, say so on the
   * HUD (diag.alarm) instead of answering in silence.
   */
  async function speakOne(item: Item): Promise<void> {
    if (cancelled) return
    setSpeaking(item.text)
    const entry = logSentence(item)
    const track = !item.filler
    try {
      const url = item.audio ? await item.audio : null
      if (cancelled) return
      if (url) {
        entry.engine = diag.engine = item.engine === 'elevenlabs' ? 'elevenlabs' : 'kokoro'
        diag.why = ''
        if (await playUrl(url, item.text, track, entry)) return
        if (cancelled) return
        entry.why = `${entry.engine} audio did not play (${diag.lastError || 'unknown'})`
      } else if (item.engine === 'kokoro') {
        entry.why = `natural voice produced nothing (${kokoro.lastError || 'not ready in time'})`
      } else if (item.engine === 'elevenlabs') {
        entry.why = 'cloud voice failed'
      }

      // The system voice: the planned engine while Kokoro loads or rests, and
      // the fallback when a generation failed. A failed generation is not a
      // failed turn.
      entry.engine = diag.engine = 'system'
      diag.why = entry.why
      if (await speakNative(item.text, track, entry)) return
      if (cancelled) return

      // The chosen voice produced no sound (Chrome's Google voices need the
      // network). An installed voice is worse to listen to and far better
      // than nothing.
      const chosen = pickVoice()
      const backup = pickLocalBackup(speechSynthesis.getVoices(), chosen?.name ?? '')
      if (backup) {
        console.warn(`[venom] "${chosen?.name ?? 'default'}" produced no sound — trying "${backup.name}"`)
        if (await speakNative(item.text, track, entry, backup)) {
          localOverride = backup
          return
        }
        if (cancelled) return
      }
      if (!nativeBroken) {
        nativeBroken = true
        diag.nativeBroken = true
        console.warn('[venom] the system voices are not producing sound')
      }

      // A cloud voice, where one is configured (the bridge's speech proxy
      // holds an ElevenLabs key borrowed from the MCP config).
      if (cloudVoice() || env.elevenKey) {
        const rescue = await fetchCloudAudio(item.text).catch(() => null)
        if (cancelled) return
        if (rescue) {
          diag.rescued++
          entry.engine = diag.engine = 'elevenlabs'
          if (await playUrl(rescue, item.text, track, entry)) return
          if (cancelled) return
        }
      }

      // Kokoro, if it is up by now (back from a rest, or just finished loading).
      if (TTS_ENGINE === 'kokoro' && kokoro.isReady()) {
        const again = await kokoro.speak(item.text).catch(() => null)
        if (cancelled) return
        if (again) {
          entry.engine = diag.engine = 'kokoro'
          if (await playUrl(again, item.text, track, entry)) return
          if (cancelled) return
        }
      }

      diag.silent++
      diag.alarm = `nothing could speak "${item.text.slice(0, 40)}" (${entry.why || diag.lastError || 'no engine produced sound'})`
      console.error(`[venom] ${diag.alarm}`)
    } finally {
      if (entry.started) diag.alarm = ''
      if (speaking === item.text) setSpeaking('')
    }
  }

  const speakNative = (
    text: string,
    track = false,
    entry?: SentenceLog,
    forced?: SpeechSynthesisVoice,
  ) =>
    new Promise<boolean>((resolve) => {
      // Chrome's speechSynthesis wedges after cancel().
      //
      // This is the single most likely reason a whole session goes silent. The
      // engine is a global singleton, `cancel()` can leave its queue in a state
      // where every subsequent speak() is accepted and then never spoken — no
      // error, no events, just silence for the rest of the page's life. Barge-in
      // calls cancel() constantly now that the microphone stays open, so what
      // used to be a rare quirk became the common case.
      //
      // resume() is the documented un-wedge. It is a no-op when nothing is
      // paused, so it is safe to fire before every utterance.
      speechSynthesis.resume()

      const u = new SpeechSynthesisUtterance(text)
      const voice = forced ?? pickVoice()
      if (voice) u.voice = voice
      if (entry) entry.voice = voice?.name ?? 'default'
      u.lang = voice?.lang ?? 'en-GB'
      // Deliberate, and deliberately invariant — the character's pace does not
      // change with stakes, and that steadiness is most of the effect. This
      // lands around 130 wpm, below the median for film dialogue.
      u.rate = 0.92
      // Mid-baritone, and *not* pushed lower for gravitas. The voice is
      // clarity-weighted rather than chest-weighted; dropping it further reads
      // as a film-trailer voiceover, which is the wrong character entirely.
      u.pitch = 0.95

      // speechSynthesis exposes no amplitude, so drive the reactor from a
      // synthetic envelope. It only has to look like speech, not match it.
      let raf = 0
      let t = 0
      const tick = () => {
        t += 0.08
        outLevel =
          0.35 +
          Math.abs(Math.sin(t * 2.1)) * 0.3 +
          Math.abs(Math.sin(t * 5.7)) * 0.2
        raf = requestAnimationFrame(tick)
      }
      tick()

      let done = false
      let started = false
      let watchdog: ReturnType<typeof setTimeout> | null = null
      let keepalive: ReturnType<typeof setInterval> | null = null

      // How far into this sentence he is. Word boundaries are exact where
      // Chrome reports them (local voices); Google's network voices often
      // report none, so fall back to elapsed time against ~14 characters a
      // second at this rate, capped below the end because a guess must never
      // claim the last word was said.
      let ownMeasure: (() => void) | null = null
      let bounded = false

      const finish = () => {
        if (done) return
        done = true
        if (ownMeasure && measure === ownMeasure) {
          ownMeasure()
          log.abandon()
          measure = null
        }
        nativeInFlight = false
        if (watchdog) clearTimeout(watchdog)
        if (keepalive) clearInterval(keepalive)
        cancelAnimationFrame(raf)
        // Held rather than zeroed, so the orb doesn't collapse in the gap
        // between two sentences of the same answer.
        outLevel = 0.12
        // The whole point of the boolean: `true` only if sound actually began.
        resolve(started)
      }

      u.onstart = () => {
        started = true
        if (entry) entry.started = true
        diag.started++
        diag.lastError = ''
        if (track && !cancelled && !ownMeasure) {
          log.begin(text)
          const t0 = Date.now()
          ownMeasure = () => {
            if (!bounded) log.progress(Math.min(0.95, (Date.now() - t0) / 1000 / (text.length / 14)))
          }
          measure = ownMeasure
        }
        if (watchdog) clearTimeout(watchdog)
        // Chrome stops speaking after roughly fifteen seconds unless the engine
        // is nudged. A pause/resume pair is the standard keepalive and is
        // inaudible; without it long answers cut off mid-sentence.
        keepalive = setInterval(() => {
          if (done) return
          speechSynthesis.pause()
          speechSynthesis.resume()
        }, 5000)
      }
      u.onboundary = (e) => {
        if (!ownMeasure || measure !== ownMeasure) return
        bounded = true
        log.charIndex(e.charIndex)
      }
      u.onend = () => {
        if (ownMeasure && measure === ownMeasure) {
          log.finish()
          measure = null
        }
        finish()
      }
      // Swallowing this was a mistake. When the OS voice fails there is no
      // other signal at all — no exception, no silence you can detect from
      // code — so an unlogged onerror turns a broken voice into an unexplained
      // quiet app, which is exactly the bug that took three attempts to find.
      u.onerror = (e) => {
        const code = String((e as SpeechSynthesisErrorEvent).error ?? 'unknown')
        diag.lastError = code
        // 'interrupted' and 'canceled' are us, cancelling deliberately on a
        // barge-in. Everything else means the engine could not speak.
        if (code !== 'interrupted' && code !== 'canceled') {
          diag.failures++
          console.error(`[venom] speech failed (${code}) on voice "${u.voice?.name ?? 'default'}"`)
        }
        finish()
      }

      // If `start` never arrives the engine has swallowed the utterance, and
      // nothing else will ever tell us — no error fires. Un-wedge and try once
      // more; if that also goes nowhere, resolve rather than hang, because a
      // silent sentence is recoverable and a stuck queue is not.
      watchdog = setTimeout(() => {
        if (done || started) return
        console.warn('[venom] speech did not start — un-wedging the engine')
        speechSynthesis.cancel()
        speechSynthesis.resume()
        try {
          speechSynthesis.speak(u)
        } catch {
          finish()
          return
        }
        watchdog = setTimeout(() => {
          if (done || started) return
          console.error('[venom] speech engine is not responding — switching to the cloud voice')
          diag.failures++
          diag.lastError = diag.lastError || 'no-start'
          finish()
        }, voice && !voice.localService ? 3000 : 1500)
      }, voice && !voice.localService ? 2500 : 700)
      diag.spoken++
      diag.lastText = text.slice(0, 60)
      diag.voice = u.voice?.name ?? 'default'
      nativeInFlight = true
      speechSynthesis.speak(u)
    })

  /** Resolves true once sound has begun and the clip ended or was cut;
   *  false when the element never played. */
  const playUrl = (url: string, text: string, track = false, entry?: SentenceLog) =>
    new Promise<boolean>((resolve) => {
      const audio = new Audio(url)
      currentAudio = audio
      // The generated path is an engine speaking just as much as the OS voice
      // is, so it keeps the same books. `spoken` counts the hand-off, `started`
      // is only incremented once the element reports it is actually playing —
      // see the onplaying handler below.
      diag.spoken++
      diag.lastText = text.slice(0, 60)
      diag.voice = diag.engine === 'kokoro' ? KOKORO_VOICE : 'ElevenLabs'
      if (entry) entry.voice = diag.voice
      let began = false

      let read: (() => number) | null = null
      const ctx = outputContext()
      if (ctx && ctx.state === 'running') {
        try {
          const analyser = ctx.createAnalyser()
          analyser.fftSize = 256
          ctx.createMediaElementSource(audio).connect(analyser)
          analyser.connect(ctx.destination)
          const bins = new Uint8Array(analyser.frequencyBinCount)
          const wave = new Float32Array(analyser.fftSize)
          if (entry) entry.rms = 0
          read = () => {
            // The evidence that sound is leaving the page, not only that
            // play() was called: the level on the node feeding the speakers.
            if (entry) {
              analyser.getFloatTimeDomainData(wave as Float32Array<ArrayBuffer>)
              let sq = 0
              for (let i = 0; i < wave.length; i++) sq += wave[i] * wave[i]
              const rms = Math.round(Math.sqrt(sq / wave.length) * 10000) / 10000
              if (rms > entry.rms) entry.rms = rms
            }
            analyser.getByteFrequencyData(bins as Uint8Array<ArrayBuffer>)
            let sum = 0
            for (let i = 2; i < bins.length; i++) sum += bins[i]
            return Math.min(1, (sum / (bins.length - 2) / 255) * 3.5)
          }
        } catch {
          /* the analyser is a nice-to-have */
        }
      }

      let raf = 0
      const tick = () => {
        outLevel = read ? read() : 0.4
        raf = requestAnimationFrame(tick)
      }
      tick()

      let done = false
      // Where in the sentence the element is; see ownMeasure in speakNative.
      let ownMeasure: (() => void) | null = null
      const finish = () => {
        if (done) return
        done = true
        if (ownMeasure && measure === ownMeasure) {
          ownMeasure()
          log.abandon()
          measure = null
        }
        cancelAnimationFrame(raf)
        outLevel = 0.12
        URL.revokeObjectURL(url)
        if (currentAudio === audio) currentAudio = null
        resolve(began)
      }
      // Sound is genuinely coming out. This is the cloud/neural counterpart of
      // SpeechSynthesisUtterance.onstart, and it is what makes the diagnostics
      // verdict — and the T self-test — tell the truth on the premium path.
      audio.onplaying = () => {
        began = true
        if (entry) entry.started = true
        diag.alarm = ''
        diag.started++
        diag.lastError = ''
        if (track && !cancelled && !ownMeasure) {
          log.begin(text)
          ownMeasure = () => {
            const d = audio.duration
            if (!(d > 0) || !Number.isFinite(d)) return
            // The element pauses a moment before it reports the end, and a
            // position a few hundredths short would drop the last word.
            log.progress(audio.ended || d - audio.currentTime < 0.08 ? 1 : audio.currentTime / d)
          }
          measure = ownMeasure
        }
      }
      audio.ontimeupdate = () => {
        if (ownMeasure && measure === ownMeasure) ownMeasure()
      }
      audio.onended = () => {
        if (ownMeasure && measure === ownMeasure) {
          log.finish()
          measure = null
        }
        finish()
      }
      audio.onerror = () => {
        // A decode or network failure on a blob we already hold is rare, but
        // silent when it happens: the sentence simply never plays and the queue
        // moves on. Count it rather than letting it look like nothing was said.
        diag.failures++
        diag.lastError = 'audio-element'
        finish()
      }
      // The one that matters for barge-in: cancel() pauses the element, and a
      // paused element never fires `ended`. Without this the promise never
      // settles and every await behind it hangs for the life of the page.
      audio.onpause = finish
      void audio.play().catch((err) => {
        diag.failures++
        diag.lastError = String((err as Error)?.name ?? 'play-rejected')
        finish()
      })
    })

  return {
    say(text) {
      enqueue(text, true)
    },
    push(delta) {
      if (cancelled) return
      for (const chunk of chunker.push(delta)) enqueue(chunk)
    },
    async end() {
      for (const chunk of chunker.flush()) enqueue(chunk)
      if (cancelled) return
      if (!pumping && !queue.length) return
      await new Promise<void>((resolve) => drained.push(resolve))
    },
    cancel() {
      if (cancelled) return
      // Measure before stopping anything: once paused or cancelled, the
      // position of the sentence he was hearing is gone.
      if (measure) {
        measure()
        log.abandon()
        measure = null
      }
      cancelled = true
      queue.length = 0
      // Keep the echo tail: the words already in the air still have to be
      // recognised and discarded, even though he has stopped adding to them.
      setSpeaking('')

      // Only reach for the global cancel if this speaker actually has a native
      // utterance out — speechSynthesis.cancel() is document-wide and would
      // otherwise silence an unrelated speaker mid-word.
      if (nativeInFlight) {
        nativeInFlight = false
        speechSynthesis.cancel()
        // Always pair the cancel with a resume — see the note in speakNative.
        // Leaving the engine cancelled is what silences every later sentence.
        speechSynthesis.resume()
      }
      if (currentAudio) {
        currentAudio.pause()
        currentAudio = null
      }
      outLevel = 0
      settleDrained()
    },
    level: () => outLevel,
    heard() {
      measure?.()
      return log.text()
    },
  }
}

/** Only used when USE_ELEVENLABS is on. Bridge proxy first (it already holds
 *  the key), then a direct key, then null to fall back to the native voice. */
async function fetchCloudAudio(text: string): Promise<string | null> {
  if (BACKEND === 'bridge') {
    try {
      const res = await fetch(`${BRIDGE_HTTP_URL}/tts`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text }),
      })
      if (res.ok) return URL.createObjectURL(await res.blob())
    } catch {
      /* fall through */
    }
  }

  if (env.elevenKey) {
    try {
      const res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${env.elevenVoiceId}/stream` +
          `?output_format=mp3_22050_32&optimize_streaming_latency=3`,
        {
          method: 'POST',
          headers: {
            'xi-api-key': env.elevenKey,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_flash_v2_5',
            voice_settings: {
              stability: 0.4,
              similarity_boost: 0.75,
              speed: 1.05,
            },
          }),
        },
      )
      if (res.ok) return URL.createObjectURL(await res.blob())
    } catch {
      /* fall through */
    }
  }

  return null
}
