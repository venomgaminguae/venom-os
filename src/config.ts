/**
 * VENOM configuration.
 *
 * Everything here is read from Vite env vars (.env.local) so no secrets are
 * committed. See .env.example for the full list.
 */

/**
 * Vite inlines a blank `.env` entry as an empty string, not as undefined, so
 * `??` never falls through to the default — and .env.example ships every
 * optional key blank, which is exactly the shape that used to bite. A blank
 * VITE_BACKEND silently selected the direct path and then complained about a
 * missing API key. Treat whitespace-only as unset everywhere in this file.
 */
function str(raw: unknown): string | undefined {
  const value = typeof raw === 'string' ? raw.trim() : ''
  return value === '' ? undefined : value
}

/**
 * Set only by the desktop app (desktop/static-server.mjs writes it into the
 * page before any module runs). The app has its own bridge on its own port,
 * and no Chrome speech recognition, so it names the bridge and asks for the
 * local wake route. Absent in Chrome, where everything behaves as before.
 */
const desktop = (
  globalThis as { __VENOM_DESKTOP__?: { bridgeUrl?: string; wakeRoute?: string } }
).__VENOM_DESKTOP__
export const DESKTOP = Boolean(desktop)

/**
 * Fixed-choice options. An unrecognised value is nearly always a typo, and
 * quietly falling back to the default hides it until it costs you a take.
 */
function choice<T extends string>(
  name: string,
  raw: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  const value = str(raw)
  if (value === undefined) return fallback
  if ((allowed as readonly string[]).includes(value)) return value as T
  console.warn(
    `[venom] ${name}="${value}" is not one of ${allowed.join(' | ')} — using "${fallback}".`,
  )
  return fallback
}

/** Same, for the on/off options. Accepts true/false and 1/0. */
function flag(name: string, raw: unknown, fallback: boolean): boolean {
  const value = str(raw)?.toLowerCase()
  if (value === undefined) return fallback
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  console.warn(`[venom] ${name}="${value}" is not true or false — using ${fallback}.`)
  return fallback
}

/**
 * Which brain to use.
 *
 *   'bridge' — run `npm run bridge` alongside the app. Authenticates off your
 *              existing Claude Code login (no API key), and every MCP server in
 *              your Claude Code config is available to VENOM, including local
 *              ones like higgsfield, elevenlabs, android and playwright.
 *
 *   'direct' — the browser calls the Claude API itself. Nothing to run and it
 *              deploys as a static site, but it needs VITE_ANTHROPIC_API_KEY in
 *              the bundle and only reaches remote HTTP MCP servers.
 */
export const BACKEND: 'bridge' | 'direct' = choice(
  'VITE_BACKEND',
  import.meta.env.VITE_BACKEND,
  ['bridge', 'direct'] as const,
  'bridge',
)

/**
 * Where the bridge lives. Derived once here rather than in each of the three
 * places that talk to it, so moving off the default port is a single edit.
 * `wss://` maps to `https://` on its own, which is why this is a prefix swap
 * rather than a hardcoded scheme.
 */
export const BRIDGE_WS_URL =
  str(desktop?.bridgeUrl) ?? str(import.meta.env.VITE_BRIDGE_URL) ?? 'ws://localhost:8787'
export const BRIDGE_HTTP_URL = BRIDGE_WS_URL.replace(/^ws/, 'http')

/**
 * Speech output engine.
 *
 * false (default) — the browser's own speechSynthesis. Runs on-device, so
 *   speech starts on the next frame with no request and no download. This is
 *   the fastest option that exists and it's why it's the default.
 *
 * true — ElevenLabs. Noticeably better voice, but every sentence costs a
 *   round trip plus generation, which is the difference between a conversation
 *   and a walkie-talkie. Turn it on when you want the voice more than the pace.
 */
export const USE_ELEVENLABS = flag(
  'VITE_USE_ELEVENLABS',
  import.meta.env.VITE_USE_ELEVENLABS,
  false,
)

/**
 * Speech engine.
 *
 *   'system' — the browser's own speechSynthesis. Starts on the next frame,
 *     costs nothing, but is capped by whatever voices the OS ships; on macOS
 *     the British male option is compact Daniel.
 *
 *   'kokoro' (default) — an 82M-parameter neural TTS running entirely in the
 *     browser via ONNX. Four proper British male voices and far better sound,
 *     nothing leaving the machine. It is the default because the voice is most
 *     of the character, and it is safe to be: the system voice takes over
 *     automatically while the model is still loading, and for good if it
 *     cannot load or keeps failing (see kokoro.ts and tts.ts).
 *
 *     Speed is the open question. An old measurement on a different machine
 *     found q8/WebGPU generating slower than realtime, which is not a
 *     conversation. That is to be re-measured on this PC; if it holds, try
 *     VITE_KOKORO_DTYPE=fp32 first (int8 quantisation often silently falls back
 *     to CPU on WebGPU), and VITE_TTS_ENGINE=system is the way back.
 */
export const TTS_ENGINE: 'kokoro' | 'system' = choice(
  'VITE_TTS_ENGINE',
  import.meta.env.VITE_TTS_ENGINE,
  ['kokoro', 'system'] as const,
  'kokoro',
)

/**
 * Kokoro's pace. Deliberately the same as the system voice's rate in tts.ts and
 * the boot intro: when the model is still loading and the system voice stands
 * in, the character must not suddenly speed up or slow down mid-conversation.
 * Slightly under natural pace — he is never hurried.
 */
export const KOKORO_SPEED = 0.92

/**
 * Kokoro weights precision. Default 'fp32' (see the measurement below). 'q8' is about 86MB and what has always
 * shipped. The others exist so the speed question above can be settled by
 * measurement rather than by editing code: fp32 is ~330MB but avoids the int8
 * WebGPU path that may fall back to CPU.
 */
export const KOKORO_DTYPE: 'q8' | 'fp32' | 'fp16' | 'q4' = choice(
  'VITE_KOKORO_DTYPE',
  import.meta.env.VITE_KOKORO_DTYPE,
  ['q8', 'fp32', 'fp16', 'q4'] as const,
  // Measured in Chrome on this PC (scripts/voice-proof.mjs): q8 on WebGPU took
  // 10.6 s to generate a 4.6 s sentence (2.3x to 7x slower than realtime) and
  // latched over to the system voice; fp32 took 0.5 to 1.2 s (0.09x to 0.3x).
  // The price is a 311 MB first download instead of 93 MB.
  'fp32',
)

/**
 * Speech input engine.
 *
 *   'auto' (default) — use the bridge's transcriber whenever /health reports
 *     one: local Whisper (nothing leaves the machine) or ElevenLabs Scribe.
 *     With neither, Chrome's own recognition.
 *
 *   'browser' — always Chrome's SpeechRecognition, whatever the bridge offers.
 *     The off switch, for when the local path misbehaves on camera.
 */
export const STT_ENGINE: 'auto' | 'browser' = choice(
  'VITE_STT_ENGINE',
  import.meta.env.VITE_STT_ENGINE,
  ['auto', 'browser'] as const,
  'auto',
)

/**
 * Who listens for his name when hearing is local.
 *
 *   'browser' (default) — Chrome recognition, only while he is dormant. It
 *     fires on a partial transcript, mid-word; the local route can only test
 *     for the name after the detector's 650ms end-of-speech gap plus a
 *     transcription, which makes waking him feel sluggish. Requests themselves
 *     are still transcribed locally.
 *
 *   'local' — the wake word goes through local Whisper too, so no audio at all
 *     goes to Google, at the cost of that slower wake.
 */
export const WAKE_ROUTE: 'browser' | 'local' =
  // The desktop app has no Chrome recognition: Whisper hears his name there,
  // whatever the build was told.
  desktop?.wakeRoute === 'local'
    ? 'local'
    : choice('VITE_WAKE_ROUTE', import.meta.env.VITE_WAKE_ROUTE, ['browser', 'local'] as const, 'browser')

/**
 * Which Kokoro voice. All four are British male:
 *   bm_george — measured RP baritone, closest to the character
 *   bm_fable  — warmer
 *   bm_lewis  — lower
 *   bm_daniel — brighter
 */
export const KOKORO_VOICE = choice(
  'VITE_KOKORO_VOICE',
  import.meta.env.VITE_KOKORO_VOICE,
  ['bm_george', 'bm_fable', 'bm_lewis', 'bm_daniel'] as const,
  'bm_george',
)

/**
 * Which microphone to prefer when none has been chosen with the M key: the
 * first input whose label contains this text (case-insensitive). Empty by
 * default, which means no preference: the input carrying sound, else the
 * first real input Chrome lists. See src/lib/micPolicy.ts.
 */
export const MIC_PREFER = str(import.meta.env.VITE_MIC_PREFER) ?? ''

export const env = {
  anthropicKey: str(import.meta.env.VITE_ANTHROPIC_API_KEY) ?? '',
  elevenKey: str(import.meta.env.VITE_ELEVENLABS_API_KEY) ?? '',
  elevenVoiceId:
    str(import.meta.env.VITE_ELEVENLABS_VOICE_ID) ?? 'JBFqnCBsd6RMkjVDRZzb',
}

/** Direct backend only (the bridge takes its model from bridge/settings.mjs):
 *  the Claude model id the browser asks the API for, from VITE_ANTHROPIC_MODEL.
 *  There is no default; a stronger model answers better, a smaller one trades a little
 *  quality for lower latency if you find responses feel slow on camera. */
export const MODEL = str(import.meta.env.VITE_ANTHROPIC_MODEL) ?? ''

/**
 * Fast mode runs the same Opus 5 at up to 2.5x output speed. It is a research
 * preview on the Claude API and costs $10/$50 per Mtok instead of $5/$25.
 * For a recorded demo the snappiness is worth it; flip to false to save money.
 */
export const FAST_MODE = true

// ---------------------------------------------------------------------------
// MCP servers
// ---------------------------------------------------------------------------

export type McpServer = {
  /** Stable id used as the tool namespace. Lowercase, no spaces. */
  name: string
  /** Human label for the HUD. */
  label: string
  /** Remote MCP endpoint. Must be reachable from Anthropic's servers, not yours. */
  url: string
  /** Bearer token, if the server wants one. Many put the secret in the URL instead. */
  token?: string
  enabled: boolean
}

/**
 * These are passed to the Messages API `mcp_servers` parameter. Anthropic dials
 * the servers itself, so there is no CORS to fight and no local bridge to run —
 * which is what makes a backend-free VENOM possible.
 *
 * Only *remote HTTP* MCP servers work here. Local stdio servers (filesystem,
 * Blender, Playwright) need a machine to run on and are out of scope for a
 * browser-only build.
 *
 * READ THIS BEFORE FILLING ANY OF THESE IN. Every one of them ships to the
 * browser. In direct mode Vite inlines each token below into the JavaScript
 * bundle, and the Zapier and Pipedream URLs *are* secrets — the URL is the
 * credential. Anyone who opens devtools on a deployed build gets your Notion,
 * Linear, GitHub, Stripe, Sentry and Home Assistant access, not just the
 * Anthropic key. This is fine for a demo on your own machine or a recording;
 * it is not fine for anything public. The bridge backend (the default) reads
 * none of this — it uses your Claude Code MCP config, where the secrets stay on
 * your machine — so if you want these integrations without the exposure, run
 * `npm run bridge` instead of filling in this block.
 */
export const MCP_SERVERS: McpServer[] = [
  // The single highest-leverage integration: one URL, ~8,000 apps, managed
  // OAuth. Wire up Gmail, Google Calendar, Spotify, Slack, Notion and Sheets in
  // the Zapier dashboard and they all arrive through this one endpoint.
  // Get yours at https://mcp.zapier.com -> New MCP Server.
  {
    name: 'zapier',
    label: 'Zapier',
    url: str(import.meta.env.VITE_ZAPIER_MCP_URL) ?? '',
    enabled: Boolean(str(import.meta.env.VITE_ZAPIER_MCP_URL)),
  },

  // Alternative/complementary gateway: ~3,000 apps, free for personal use.
  {
    name: 'pipedream',
    label: 'Pipedream',
    url: str(import.meta.env.VITE_PIPEDREAM_MCP_URL) ?? '',
    enabled: Boolean(str(import.meta.env.VITE_PIPEDREAM_MCP_URL)),
  },

  // Official first-party servers. Each needs its own OAuth token pasted in.
  {
    name: 'notion',
    label: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    token: str(import.meta.env.VITE_NOTION_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_NOTION_TOKEN)),
  },
  {
    name: 'linear',
    label: 'Linear',
    url: 'https://mcp.linear.app/mcp',
    token: str(import.meta.env.VITE_LINEAR_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_LINEAR_TOKEN)),
  },
  {
    name: 'github',
    label: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    token: str(import.meta.env.VITE_GITHUB_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_GITHUB_TOKEN)),
  },
  {
    name: 'stripe',
    label: 'Stripe',
    url: 'https://mcp.stripe.com',
    token: str(import.meta.env.VITE_STRIPE_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_STRIPE_TOKEN)),
  },
  {
    name: 'sentry',
    label: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    token: str(import.meta.env.VITE_SENTRY_TOKEN),
    enabled: Boolean(str(import.meta.env.VITE_SENTRY_TOKEN)),
  },
  // Home Assistant is self-hosted, so this needs a publicly reachable URL
  // (Nabu Casa Cloud, or a Cloudflare tunnel). Worth the setup — "Venom, dim
  // the lights" with the room actually dimming is the best shot in the video.
  // Both halves are required: an instance reachable from Anthropic's servers
  // with no bearer token attached is one that answers 401 to every tool call,
  // which reads on the HUD as connected and behaves as broken.
  {
    name: 'home',
    label: 'Home',
    url: str(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) ?? '',
    token: str(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    enabled: Boolean(
      str(import.meta.env.VITE_HOMEASSISTANT_MCP_URL) &&
        str(import.meta.env.VITE_HOMEASSISTANT_TOKEN),
    ),
  },
]

export const activeServers = () => MCP_SERVERS.filter((s) => s.enabled && s.url)

/** VITE_OWNER_COMPANY, when set, names the company the assistant works for (one line, capped). */
const OWNER_COMPANY = (str(import.meta.env.VITE_OWNER_COMPANY) ?? '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, 80)

/**
 * The persona for the browser-direct path only. The bridge carries its own,
 * fuller version in bridge/server.mjs — that's the one that gets used by
 * default, and the one worth editing.
 */
export const SYSTEM_PROMPT = `You are VENOM OS, ${OWNER_COMPANY ? `the AI assistant of ${OWNER_COMPANY}` : 'a personal AI assistant'}. You are speaking out loud.

THE HARD RULE: your entire reply must be under 60 words. This is not a style
preference — every word is read aloud by a speech synthesiser and the user is
waiting in silence while it plays. A four-paragraph answer is a failure, however
good the content. If a question genuinely needs more, give the headline in two
sentences and offer the detail: "There's more if you want it."

Voice:
- Dry, precise, quietly amused. Understated competence, never fawning.
- Say "sir" at most once per exchange, and not in every exchange.
- Plain spoken prose only. No markdown, no bullet points, no headings, no code,
  no emoji, no asterisks, no numbered lists.
- Write numbers, dates and times the way you'd say them: "eight fifteen",
  "the first of August", not "8:15" or "2026-08-01".

Using tools:
- You have live tools. Use them rather than guessing.
- Never narrate that you're about to use one. No "Let me search for that" or
  "I'll check that now" — go silent, use it, then answer. The user sees a
  spinner; they don't need commentary.
- Never speak a URL, ID or raw JSON aloud unless asked. Summarise.
- If a tool fails or isn't connected, one plain sentence saying so.
- For anything outward-facing or destructive (sending mail, posting, paying,
  deleting) say exactly what you're about to do and wait for confirmation.
- If you don't know, say you don't know.`
