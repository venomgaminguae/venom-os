import { BACKEND, BRIDGE_HTTP_URL, env } from '../config'

/**
 * What speech engines are actually available, decided once at boot.
 *
 * The whole point is that the app runs for anyone. A student who has done
 * nothing but install Claude Code and log in gets the browser's own speech
 * recognition and voice — no keys, no accounts, it just works. A student who
 * also has an ElevenLabs key (in their Claude Code config or a .env) gets Scribe
 * transcription and the ElevenLabs voice instead, automatically, with no flag to
 * set. This module is how the rest of the app learns which of those two worlds
 * it is in, so voice.ts and tts.ts never have to guess.
 *
 * The premium paths both live behind the bridge — it holds the key and makes
 * the calls, so the browser never sees a secret. In direct mode (no bridge)
 * only a key baked into the bundle could reach ElevenLabs for speech, and that
 * is not a path worth encouraging, so direct mode is treated as browser-only.
 */

export type Capabilities = {
  /** The bridge has a READY transcriber — local Whisper or ElevenLabs Scribe. */
  stt: boolean
  /** ElevenLabs text-to-speech is reachable via the bridge. */
  tts: boolean
  /** The ready transcriber is the bridge's local Whisper, which wants WAV. */
  sttLocal: boolean
  /** The local model is still loading — `stt` may turn true in a few seconds. */
  sttLoading: boolean
  /** Local model and device, for the HUD only (e.g. whisper-base.en, dml). */
  sttModel: string | null
  sttDevice: string | null
}

const NONE: Capabilities = {
  stt: false,
  tts: false,
  sttLocal: false,
  sttLoading: false,
  sttModel: null,
  sttDevice: null,
}

/** Browser-only until the probe says otherwise. Safe default: the app works. */
let current: Capabilities = NONE
let probed = false

/** The last known capabilities. Read synchronously by the voice and speech
 *  layers; accurate once `probeCapabilities` has resolved during boot. */
export function caps(): Capabilities {
  return current
}

export function capabilitiesProbed(): boolean {
  return probed
}

/**
 * Ask the bridge what it can do, once. Called during the boot sequence, before
 * the voice loop starts, so the first "Hey Venom" already uses the right
 * engine. Never throws: a failed probe simply leaves the browser fallback in
 * place, which is the correct behaviour when the bridge is unreachable.
 */
export async function probeCapabilities(): Promise<Capabilities> {
  if (BACKEND !== 'bridge') {
    // No bridge to ask. Direct mode has no server-side speech, so browser only.
    current = NONE
    probed = true
    return current
  }
  try {
    const res = await fetch(`${BRIDGE_HTTP_URL}/health`, {
      signal: AbortSignal.timeout(3000),
    })
    if (res.ok) {
      const h = (await res.json()) as {
        stt?: boolean
        tts?: boolean
        sttEngine?: string | null
        sttLoading?: boolean
        sttModel?: string | null
        sttDevice?: string | null
      }
      current = {
        stt: Boolean(h.stt),
        tts: Boolean(h.tts),
        sttLocal: Boolean(h.stt) && h.sttEngine === 'local',
        sttLoading: Boolean(h.sttLoading),
        sttModel: h.sttModel ?? null,
        sttDevice: h.sttDevice ?? null,
      }
    }
  } catch {
    // Bridge down or slow — stay on the browser engines rather than blocking
    // boot on a health check that is only an optimisation.
  }
  probed = true
  return current
}

/**
 * Wait for the local transcriber if, and only if, it is still loading.
 *
 * The bridge and the page are usually started together, and the page wins the
 * race: its one boot probe lands while Whisper is still loading, says stt:false,
 * and the whole session would then go to Chrome — to Google — for want of a few
 * seconds. So re-ask briefly. When the last probe did not say "loading" this
 * returns at once, so nothing that does not need it ever waits.
 */
export async function awaitLocalStt(maxMs = 8000): Promise<Capabilities> {
  const until = Date.now() + maxMs
  while (current.sttLoading && !current.stt && Date.now() < until) {
    await new Promise((r) => setTimeout(r, 500))
    await probeCapabilities()
  }
  return current
}

/** A short human label for the HUD: what voice stack is actually in play. */
export function engineLabel(): string {
  const c = current
  if (c.sttLocal) return c.tts ? 'local hearing · ElevenLabs voice' : 'local hearing'
  if (c.stt && c.tts) return 'ElevenLabs'
  if (c.tts) return 'ElevenLabs voice'
  // env.elevenKey is only meaningful in direct mode; harmless to mention.
  if (env.elevenKey && BACKEND !== 'bridge') return 'ElevenLabs (direct)'
  return 'browser speech'
}
