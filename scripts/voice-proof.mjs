#!/usr/bin/env node
// Browser proof of the VENOM OS voice path (Kokoro / system voice), silently,
// in headless Google Chrome on scratch ports. Not a node:test file on purpose.
//
//   node scripts/voice-proof.mjs [--runs 10] [--only 1,2,3,4,5,6] [--out <json>]
//                                [--scratch <dir>] [--fresh] [--dtype fp32]
//   node scripts/voice-proof.mjs --real-profile [--windowed] [--keep-copy]   (check 7, headed, AUDIBLE; see below)
//
// Starts, and afterwards stops, only what it spawns:
//   bridge  node bridge/server.mjs on 8797, fake CLI (scripts/fake-cli.mjs),
//           memory ON but every folder (memory, Hermes memory, workspace,
//           agents, even USERPROFILE) inside the scratch dir;
//   vite    5181 (VITE_TTS_ENGINE=kokoro) and 5182 (VITE_TTS_ENGINE=system),
//           scripts/voice-proof.vite.config.mjs, own cacheDir in scratch;
//   chrome  headless, CDP 9333, --mute-audio, fake microphone fed a silent WAV.
// Refuses to start if any of 8797/5181/5182/9333 is already listening; never
// touches 5173/8787.
//
// Silence: besides --mute-audio, an injected script forces volume 0 on every
// SpeechSynthesisUtterance (and refuses to speak otherwise), mutes every media
// element, and routes every Web Audio graph into a zero-gain node. The run
// aborts before INITIALISE if any of that is not installed.
//
// Questions are put in through window.__venomAsk (App.tsx, dev server only),
// which calls the same onWake/onUtterance handlers the voice loop calls; the
// answer is spoken by createSpeaker exactly as in production. The interruption
// uses the page's own barge-in trigger: the Space key while he is speaking
// (onSpeechStart, the handler the voice loop's VAD also calls).
//
// --fresh starts check 1 on an empty Chrome profile (model downloaded from
// huggingface.co); without it the cached profile in the scratch dir is reused.
//
//   node scripts/voice-proof.mjs --real-profile [--windowed] [--keep-copy] [--scratch <dir>] [--out <json>]
//
// --real-profile runs check 7 only, AUDIBLY: a robocopy of the owner's Chrome
// profile (~/.venom/chrome-app, read only) into <scratch>/real-profile-copy,
// a HEADED Google Chrome with exactly the owner's window flags (chromeArgs()
// of scripts/open-window.mjs: --app, full screen or with --windowed 1400x850)
// plus only --remote-debugging-port=9333. Nothing is muted: the boot intro
// and three #stock answers play on the speakers. Every sentence's output is
// measured by an AnalyserNode tapped onto each AudioContext destination
// (P.out / outRms) and compared with the app's own __tts.log. The microphone
// permission is granted over CDP; Chrome's (Google) speech recognition stays
// hidden. Cold load (model from huggingface.co), then a warm reload.
// --keep-copy reuses an existing profile copy (then the first load is not cold).

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromeArgs, defaultProfile } from './open-window.mjs'

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const WebSocket = createRequire(W + '/package.json')('ws')
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const PORT = { bridge: 8797, kokoro: 5181, system: 5182, plain: 5183, cdp: 9333 }
const LIVE = [5173, 8787]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const RUNS = Number(arg('--runs', 10))
const REAL = argv.includes('--real-profile')
const WINDOWED = argv.includes('--windowed')
const KEEP_COPY = argv.includes('--keep-copy')
const ONLY = REAL ? new Set([7]) : new Set(String(arg('--only', '1,2,3,4,5,6')).split(',').map((s) => Number(s.trim())))
const S = path.resolve(arg('--scratch', process.env.VOICE_PROOF_SCRATCH || path.join(os.tmpdir(), 'venom-voice-proof'))).replace(/\\/g, '/')
const OUT = path.resolve(arg('--out', `${S}/voice-proof-result.json`)).replace(/\\/g, '/')
const FRESH = argv.includes('--fresh')
const DTYPE = arg('--dtype', 'fp32')
const NETWORK_VOICES = argv.includes('--network-voices')
const PROFILE = `${S}/chrome-profile`
const CLI_LOG = `${S}/fake-cli.log`
const MEM = `${S}/memory`
const SILENT_WAV = `${S}/silence-48k.wav`
for (const p of [5173, 8787, ...LIVE]) if (Object.values(PORT).includes(p)) throw new Error('live port in PORT table')

const result = { started: new Date().toISOString(), args: { RUNS, only: [...ONLY], scratch: S, fresh: FRESH, dtype: DTYPE, realProfile: REAL, windowed: WINDOWED, keepCopy: KEEP_COPY }, chromeFlags: null, checks: {}, jsdelivrRequests: [], ortRequests: [], console: [], errors: [] }
const save = () => fs.writeFileSync(OUT, JSON.stringify(result, null, 2))
const say = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const T0 = Date.now()

// ---------------------------------------------------------------- processes
function listeners(port) {
  return execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/)
    .filter((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l))
    .map((l) => Number(l.trim().split(/\s+/).pop()))
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const spawned = [] // { role, pid, port }

function startProc(role, cmd, args, opts, port) {
  const fd = fs.openSync(`${S}/${role}.log`, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', fd, fd], windowsHide: true })
  const rec = { role, pid: child.pid, port }
  spawned.push(rec)
  say(`started ${role} pid ${child.pid}${port ? ' for :' + port : ''}`)
  return rec
}

async function stopProc(rec) {
  if (!rec || rec.stopped) return
  const owners = rec.port ? listeners(rec.port) : []
  if (alive(rec.pid) && (!rec.port || owners.includes(rec.pid))) {
    try { process.kill(rec.pid) } catch {}
    for (let i = 0; i < 20 && alive(rec.pid); i++) await sleep(250)
  } else if (alive(rec.pid)) {
    say(`${rec.role} pid ${rec.pid} alive but does not hold :${rec.port} (listeners ${owners.join(',') || 'none'}); not killed`)
  }
  rec.stopped = true
  say(`stopped ${rec.role} pid ${rec.pid}; alive=${alive(rec.pid)}`)
}

async function waitFor(label, fn, ms) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last?.ok) return last } catch (e) { last = { info: String(e) } }
    await sleep(400)
  }
  throw new Error(`${label} not ready: ${last?.info ?? ''}`)
}

function silentWav() {
  const rate = 48000, n = rate * 3
  const b = Buffer.alloc(44 + n * 2)
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVE', 8); b.write('fmt ', 12)
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22); b.writeUInt32LE(rate, 24)
  b.writeUInt32LE(rate * 2, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40)
  fs.writeFileSync(SILENT_WAV, b)
}

async function startBridge() {
  for (const d of ['memory', 'hermes-memory', 'workspace', 'agents', 'home']) fs.mkdirSync(`${S}/${d}`, { recursive: true })
  if (!fs.existsSync(`${S}/hermes-memory/MEMORY.md`)) fs.writeFileSync(`${S}/hermes-memory/MEMORY.md`, '')
  const rec = startProc('bridge', process.execPath, ['bridge/server.mjs'], {
    cwd: W,
    env: {
      ...process.env,
      // homedir() follows USERPROFILE: no ~/.claude.json (so no ElevenLabs key
      // and no MCP servers) and no ~/.venom from the bridge's point of view.
      USERPROFILE: `${S}/home`, HOME: `${S}/home`,
      ELEVENLABS_API_KEY: '',
      VENOM_BRIDGE_PORT: String(PORT.bridge),
      VENOM_CLAUDE_EXECUTABLE: `${W}/scripts/fake-cli.mjs`,
      FAKE_CLI_LOG: CLI_LOG,
      VENOM_MCP_SERVERS: '',
      VENOM_DISABLE: 'browser,camera',
      VENOM_AGENT_ACTIVITY: '0',
      VENOM_AGENTS_DIR: `${S}/agents`,
      VENOM_WORKSPACE: `${S}/workspace`,
      VENOM_MEMORY: '1',
      VENOM_MEMORY_DIR: MEM,
      VENOM_HERMES_MEMORY_DIR: `${S}/hermes-memory`,
      VENOM_ALLOW_NO_ORIGIN: '',
      VENOM_ALLOWED_ORIGINS: '',
      // Local Whisper, so the page's hearing never falls back to Chrome's
      // (Google) recognition. The fake microphone only ever plays silence.
      VENOM_LOCAL_STT: '1',
      VENOM_STT_MODEL_DIR: process.env.VENOM_STT_MODEL_DIR || `${W}/desktop/models`,
    },
  }, PORT.bridge)
  const h = await waitFor('bridge', async () => {
    const j = await (await fetch(`http://127.0.0.1:${PORT.bridge}/health`)).json()
    return { ok: j.sttEngine === 'local' || j.sttLocal === true, info: JSON.stringify(j).slice(0, 300), j }
  }, 120000)
  if (h.j.tts) throw new Error('bridge reports an ElevenLabs voice (tts:true); refusing to run')
  if (!listeners(PORT.bridge).includes(rec.pid)) throw new Error('bridge port is not held by the spawned pid')
  result.bridgeHealth = h.j
  return rec
}

async function startVite(port, engine) {
  const rec = startProc(`vite-${port}`, process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/voice-proof.vite.config.mjs'], {
    cwd: W,
    env: {
      ...process.env,
      VOICE_PROOF_PORT: String(port),
      VOICE_PROOF_CACHE: `${S}/vite-cache-${port}`,
      VITE_BACKEND: 'bridge',
      VITE_BRIDGE_URL: `ws://localhost:${PORT.bridge}`,
      VITE_WAKE_ROUTE: 'local',
      VITE_STT_ENGINE: 'auto',
      VITE_TTS_ENGINE: engine,
      VITE_KOKORO_DTYPE: DTYPE,
      VITE_KOKORO_VOICE: 'bm_george',
      VITE_USE_ELEVENLABS: 'false',
      VITE_ELEVENLABS_API_KEY: '',
    },
  }, port)
  await waitFor(`vite ${port}`, async () => {
    const t = await (await fetch(`http://localhost:${port}/`)).text()
    return { ok: t.includes(`localhost:${PORT.bridge}`), info: 'csp has 8797=' + t.includes('8797'), t }
  }, 60000).then((r) => { if (/jsdelivr/i.test(r.t)) throw new Error('the served page still names jsdelivr') })
  return rec
}

// ---------------------------------------------------------------- CDP
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? rej(new Error(`${m.error.message}`)) : res(m.result)
      } else if (m.method) for (const h of this.handlers) h(m)
    })
  }
  static async open(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 })
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  on(fn) { this.handlers.push(fn) }
}

async function ev(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// Installed on every new document before any page script runs.
const INJECT = String.raw`(() => {
  if (window.__proof) return
  const cfg = window.__proofCfg || {}
  const P = window.__proof = { utt: [], ws: [], sent: [], media: [], blobs: [], gpu: { adapters: 0, devices: 0, submits: 0 }, installed: {}, blockedFetch: [] }
  // No Chrome (Google) speech recognition: if local hearing is not up, the
  // page must fail to listen rather than stream the microphone to Google.
  for (const k of ['SpeechRecognition', 'webkitSpeechRecognition']) {
    try { Object.defineProperty(window, k, { value: undefined, configurable: false, writable: false }) } catch (e) {}
  }
  P.installed.noRecognition = window.SpeechRecognition === undefined && window.webkitSpeechRecognition === undefined
  // Chrome's Google voices are network voices that never start in headless
  // mode; by default only the OS (local) voices are offered, so the app's own
  // pickVoice() fallback chooses one of them.
  if (cfg.localVoicesOnly && window.speechSynthesis) {
    const gv = speechSynthesis.getVoices.bind(speechSynthesis)
    P.allVoices = () => gv().map((v) => v.name + (v.localService ? '' : ' (network)'))
    Object.defineProperty(speechSynthesis, 'getVoices', { value: () => gv().filter((v) => v.localService), configurable: false, writable: false })
  }
  const now = () => performance.now()
  const cut = (why) => {
    if (!P.armCut) return
    P.armCut = false
    P.cutAt = now(); P.cutAfter = why
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Space', key: ' ', bubbles: true }))
  }
  if (cfg.noGpu) {
    try { Object.defineProperty(Navigator.prototype, 'gpu', { get: () => undefined, configurable: true }) } catch (e) {}
    P.installed.noGpu = navigator.gpu === undefined
  } else if (navigator.gpu) {
    const ra = GPU.prototype.requestAdapter
    GPU.prototype.requestAdapter = async function (...a) {
      P.gpu.adapters++
      const ad = await ra.apply(this, a)
      if (ad) P.gpu.adapter = { vendor: ad.info && ad.info.vendor, architecture: ad.info && ad.info.architecture, fallback: ad.isFallbackAdapter || (ad.info && ad.info.isFallbackAdapter) || false }
      return ad
    }
    const rd = GPUAdapter.prototype.requestDevice
    GPUAdapter.prototype.requestDevice = async function (...a) { P.gpu.devices++; return rd.apply(this, a) }
    const sub = GPUQueue.prototype.submit
    GPUQueue.prototype.submit = function (...a) { P.gpu.submits++; return sub.apply(this, a) }
  }
  // 1. The OS / Chrome speech engine: volume 0 on every utterance, or no speech.
  if (window.speechSynthesis) {
    const ss = window.speechSynthesis
    const orig = ss.speak.bind(ss)
    const seen = new WeakMap()
    const speak = function (u) {
      if (!cfg.audible) {
        u.volume = 0
        if (u.volume !== 0) throw new Error('voice-proof: refusing to speak at volume ' + u.volume)
      }
      let rec = seen.get(u)
      if (rec) rec.requeued = (rec.requeued || 0) + 1
      else {
        rec = { text: u.text, voice: u.voice ? u.voice.name : null, voiceLocal: u.voice ? u.voice.localService : null, volume: u.volume, queued: now(), start: null, end: null, error: null, boundaries: 0 }
        seen.set(u, rec)
        P.utt.push(rec)
        u.addEventListener('start', () => { rec.start = now(); rec.volumeAtStart = u.volume })
        u.addEventListener('boundary', () => { rec.boundaries++ })
        u.addEventListener('end', () => { rec.end = now(); cut('utterance end') })
        u.addEventListener('error', (e) => { rec.error = e.error; rec.end = now() })
      }
      // check 8: an engine that accepts the utterance and never speaks it.
      if (cfg.deadSpeech) return undefined
      return orig(u)
    }
    speak.__proof = true
    Object.defineProperty(ss, 'speak', { value: speak, configurable: false, writable: false })
    P.installed.speech = ss.speak === speak
  }
  // 2. Media elements: always muted, volume 0.
  const mp = HTMLMediaElement.prototype
  const origPlay = mp.play
  const seenEl = new WeakSet()
  P.out = { max: 0, cur: 0 }
  mp.play = function () {
    if (!cfg.audible) { this.muted = true; this.volume = 0 }
    if (!seenEl.has(this)) {
      seenEl.add(this)
      const tts = window.__tts || {}
      const rec = { src: String(this.src).slice(0, 80), text: tts.lastText || null, engine: tts.engine || null, play: now(), playing: null, ended: null, pause: null, duration: null, outRms: null }
      P.media.push(rec)
      // Output tap: the loudest RMS at the speakers between playing and ended/pause.
      const endTap = () => { if (rec.outRms == null && rec.playing != null) rec.outRms = +P.out.cur.toFixed(4) }
      this.addEventListener('playing', () => { if (rec.playing == null) { rec.playing = now(); P.out.cur = 0 } rec.mutedAtPlaying = this.muted && this.volume === 0 })
      this.addEventListener('ended', () => { endTap(); rec.ended = now(); rec.duration = this.duration; if (String(this.src).startsWith('blob:')) cut('audio ended') })
      this.addEventListener('pause', () => { endTap(); if (rec.pause == null) rec.pause = now() })
      if (!cfg.audible) this.addEventListener('volumechange', () => { if (!this.muted || this.volume !== 0) { this.muted = true; this.volume = 0 } })
    }
    return origPlay.call(this)
  }
  P.installed.media = HTMLMediaElement.prototype.play !== origPlay
  // 3. Web Audio: every path to the speakers goes through a zero gain
  //    (audible mode: straight to the speakers, plus an analyser tap).
  const origConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (dest, ...rest) {
    if (dest instanceof AudioDestinationNode && cfg.audible) {
      const ctx = dest.context
      if (!ctx.__proofTap) {
        const an = ctx.createAnalyser(); an.fftSize = 2048
        const z = ctx.createGain(); z.gain.value = 0
        origConnect.call(an, z); origConnect.call(z, dest) // keeps the analyser pulled; adds silence only
        const buf = new Float32Array(an.fftSize)
        setInterval(() => {
          an.getFloatTimeDomainData(buf)
          let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
          const rms = Math.sqrt(s / buf.length)
          if (rms > P.out.cur) P.out.cur = rms
          if (rms > P.out.max) P.out.max = rms
        }, 40)
        ctx.__proofTap = an
      }
      try { origConnect.call(this, ctx.__proofTap, rest[0] || 0) } catch (e) {}
      return origConnect.call(this, dest, ...rest)
    }
    if (dest instanceof AudioDestinationNode) {
      const ctx = dest.context
      if (!ctx.__proofMute) { const g = ctx.createGain(); g.gain.value = 0; origConnect.call(g, dest); ctx.__proofMute = g }
      origConnect.call(this, ctx.__proofMute, ...rest)
      return dest
    }
    return origConnect.call(this, dest, ...rest)
  }
  P.installed.webaudio = AudioNode.prototype.connect !== origConnect
  P.installed.audible = !!cfg.audible
  // 4. Keep each generated audio blob, with Kokoro's stats at that moment.
  const origCOU = URL.createObjectURL
  URL.createObjectURL = function (obj) {
    const url = origCOU.call(URL, obj)
    if (obj instanceof Blob && obj.size > 1000) {
      const k = window.__proofK
      P.blobs.push({ url, t: now(), size: obj.size, type: obj.type, blob: obj, stats: k ? { lastMs: k.stats.lastMs, rtf: k.stats.rtf } : null })
    }
    return url
  }
  // 5. Bridge socket: arrival time of every frame, and what the page sends.
  const OWS = window.WebSocket
  class PWS extends OWS {
    constructor(...a) {
      super(...a)
      this.addEventListener('message', (e) => {
        try { const m = JSON.parse(e.data); if (m && m.type && m.type !== 'diag') P.ws.push({ t: now(), type: m.type, ask: m.ask, delta: m.type === 'text' ? m.delta : undefined }) } catch (err) {}
      })
    }
    send(data) {
      try { const m = JSON.parse(data); if (m && (m.type === 'ask' || m.type === 'interrupt')) P.sent.push({ t: now(), ...m }) } catch (err) {}
      return super.send(data)
    }
  }
  window.WebSocket = PWS
  P.installed.ws = true
  // 6. No cloud voice, ever.
  const origFetch = window.fetch
  window.fetch = function (input, init) {
    const u = String(input && input.url ? input.url : input)
    if (/elevenlabs|:8797\/tts|:8787/.test(u)) { P.blockedFetch.push(u); return Promise.reject(new Error('voice-proof: blocked ' + u)) }
    return origFetch.call(this, input, init)
  }
})()`

async function startChrome(profile, label, real = null) {
  fs.mkdirSync(profile, { recursive: true })
  // real: { flags } = the owner's headed window flags (plus CDP); nothing muted.
  const flags = real ? [...real.flags, `--remote-debugging-port=${PORT.cdp}`] : ['--headless=new', `--remote-debugging-port=${PORT.cdp}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--mute-audio', '--autoplay-policy=no-user-gesture-required', '--window-size=1400,850',
    '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${SILENT_WAV.replace(/\//g, '\\')}`]
  if (!real && !flags.includes('--mute-audio')) throw new Error('no --mute-audio')
  if (real && flags.some((f) => /headless|mute-audio|fake|autoplay/.test(f))) throw new Error('real mode flags must be the owner\'s own')
  result.chromeFlags = real ? flags : flags.map((f) => f.replace(profile, '<profile>'))
  const rec = startProc(`chrome-${label}`, CHROME, real ? flags : [...flags, 'about:blank'], {}, PORT.cdp)
  const page = await waitFor('chrome', async () => {
    const t = (await (await fetch(`http://127.0.0.1:${PORT.cdp}/json`)).json()).find((x) => x.type === 'page' && (!real || x.url.includes(`localhost:${PORT.kokoro}`)))
    return { ok: Boolean(t), t }
  }, 30000)
  const c = await Cdp.open(page.t.webSocketDebuggerUrl)
  const sess = { c, rec, net: new Map(), blocked: [], profile }
  c.on((m) => {
    const p = m.params
    if (m.method === 'Network.requestWillBeSent') {
      sess.net.set(p.requestId, { url: p.request.url, method: p.request.method, t: Date.now() })
      // Every page of the run, blocked or not: the runtime must never be asked of the CDN.
      if (/jsdelivr/i.test(p.request.url)) result.jsdelivrRequests.push(`${label} ${p.request.url.slice(0, 200)}`)
    }
    else if (m.method === 'Network.responseReceived') { const r = sess.net.get(p.requestId); if (r) Object.assign(r, { status: p.response.status, mime: p.response.mimeType, fromCache: p.response.fromDiskCache || p.response.fromServiceWorker || false }) }
    else if (m.method === 'Network.loadingFinished') { const r = sess.net.get(p.requestId); if (r) { r.bytes = p.encodedDataLength; if (/\/ort\//.test(r.url)) result.ortRequests.push(`${label} ${r.status} ${r.fromCache ? 'cache' : r.bytes} ${r.url}`) } }
    else if (m.method === 'Network.loadingFailed') { const r = sess.net.get(p.requestId); if (r) { r.failed = p.errorText; r.blockedReason = p.blockedReason } if (p.blockedReason) sess.blocked.push(r?.url ?? p.requestId) }
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) result.console.push(`${label} ${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    else if (m.method === 'Runtime.exceptionThrown') result.console.push(`${label} exception: ` + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300))
  })
  for (const m of ['Page.enable', 'Runtime.enable', 'Network.enable']) await c.send(m)
  return sess
}

async function stopChrome(sess) {
  if (!sess || sess.rec.stopped) return
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT.cdp}/json/version`)).json()
    const b = await Cdp.open(v.webSocketDebuggerUrl)
    b.send('Browser.close').catch(() => {})
    await sleep(2500)
  } catch {}
  try { sess.c.ws.close() } catch {}
  if (alive(sess.rec.pid)) await stopProc(sess.rec)
  else { sess.rec.stopped = true; say(`chrome pid ${sess.rec.pid} closed`) }
}

const externalNet = (sess) => [...sess.net.values()].filter((r) => !/^(https?|wss?):\/\/(localhost|127\.0\.0\.1)/.test(r.url) && /^https?:/.test(r.url))

/** Load the app with the silence guards, check them, click INITIALISE, wait for dormant. */
async function openApp(sess, port, cfg = {}) {
  const { c } = sess
  cfg = { localVoicesOnly: !NETWORK_VOICES, ...cfg }
  for (const identifier of sess.scripts ?? []) await c.send('Page.removeScriptToEvaluateOnNewDocument', { identifier })
  sess.scripts = [
    (await c.send('Page.addScriptToEvaluateOnNewDocument', { source: `window.__proofCfg = ${JSON.stringify(cfg)};` })).identifier,
    (await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })).identifier,
  ]
  if (cfg.block) await c.send('Network.setBlockedURLs', { urls: cfg.block })
  await c.send('Page.bringToFront')
  await c.send('Page.navigate', { url: `http://localhost:${port}/` })
  await sleep(1500)
  if (!cfg.audible) await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 850, deviceScaleFactor: 1, mobile: false })
  const guard = await waitFor('silence guard', async () => {
    const g = await ev(c, `(() => { const P = window.__proof; if (!P) return null; return { ...P.installed, speakWrapped: speechSynthesis.speak.__proof === true, gpu: !!navigator.gpu, innerWidth, innerHeight } })()`)
    return { ok: g && g.speech && g.speakWrapped && g.media && g.webaudio && g.ws && g.noRecognition && (!cfg.noGpu || g.noGpu) && (!cfg.audible || g.audible), info: JSON.stringify(g), g }
  }, 20000)
  // The page itself must reach the scratch bridge (CSP), or hearing would not be local.
  const health = await ev(c, `fetch('http://localhost:${PORT.bridge}/health').then((r) => r.json()).catch((e) => ({ error: String(e) }))`)
  if (!health.stt || health.sttEngine !== 'local' || health.tts) throw new Error('page cannot use the scratch bridge: ' + JSON.stringify(health))
  const env = await waitFor('app modules', async () => {
    const e = await ev(c, `Promise.all([import(location.origin + '/src/config.ts'), import(location.origin + '/src/lib/kokoro.ts')]).then(([cf, k]) => { window.__proofK = k; return { tts: cf.TTS_ENGINE, wake: cf.WAKE_ROUTE, eleven: cf.USE_ELEVENLABS, dtype: cf.KOKORO_DTYPE, voice: cf.KOKORO_VOICE, bridge: cf.BRIDGE_WS_URL, ask: typeof window.__venomAsk } })`)
    return { ok: e && e.ask === 'function', info: JSON.stringify(e), e }
  }, 30000)
  if (env.e.wake !== 'local' || env.e.eleven !== false || !env.e.bridge.includes(String(PORT.bridge))) throw new Error('unsafe page config ' + JSON.stringify(env.e))
  const rect = await waitFor('INITIALISE', async () => {
    const r = await ev(c, `(() => { const b = [...document.querySelectorAll('button')].find((b) => /INITIALISE/.test(b.textContent)); if (!b) return null; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`)
    return { ok: Boolean(r), r }
  }, 30000)
  const clickT = await ev(c, 'performance.now()')
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, x: rect.r.x, y: rect.r.y, button: 'left', clickCount: 1 })
  const tClick = Date.now()
  let readyAt = null
  let s
  for (let i = 0; i < (cfg.audible ? 1200 : 400); i++) {
    s = await ev(c, `({ phase: window.__venom && window.__venom.phase, ready: window.__proofK.isReady(), unavailable: window.__proofK.isUnavailable(), wakeRoute: window.__voice && window.__voice.wakeRoute })`)
    if (s.ready && readyAt == null) readyAt = Date.now() - tClick
    if (s.phase === 'dormant' || s.phase === 'offline') break
    await sleep(100)
  }
  if (s.phase !== 'dormant') {
    const dbg = await ev(c, `(async () => { let mic = null; try { mic = (await navigator.permissions.query({ name: 'microphone' })).state } catch (e) { mic = String(e) } const v = window.__venom || {}; return { mic, voice: JSON.parse(JSON.stringify(window.__voice || null)), error: v.error ?? null, bootNote: v.bootNote ?? null, media: window.__proof.media.length, utt: window.__proof.utt.map((u) => ({ text: (u.text || '').slice(0, 40), voice: u.voice, start: u.start, end: u.end, error: u.error })), body: document.body.innerText.slice(0, 300) } })()`).catch((e) => String(e))
    throw new Error('app did not reach dormant: ' + JSON.stringify(s) + ' debug ' + JSON.stringify(dbg).slice(0, 2500))
  }
  if (s.wakeRoute !== 'local') throw new Error('wake route is not local: ' + s.wakeRoute)
  return { guard: guard.g, env: env.e, clickT, tClick, readyAt, bootMs: Date.now() - tClick, atDormant: s }
}

async function waitKokoro(sess, tClick, ms) {
  const end = Date.now() + ms
  for (;;) {
    const s = await ev(sess.c, `({ ready: window.__proofK.isReady(), unavailable: window.__proofK.isUnavailable(), lastError: window.__proofK.lastError, progress: window.__proofK.loadProgress() })`)
    if (s.ready || s.unavailable || Date.now() > end) return { ...s, ms: Date.now() - tClick }
    await sleep(100)
  }
}

/** Ask through the real wiring and wait until the answer has been spoken. */
async function ask(sess, text, { timeout = 90000, armCut = false } = {}) {
  const { c } = sess
  const mark = await ev(c, `(() => { const P = window.__proof; ${armCut ? 'P.armCut = true; P.cutAt = null;' : ''} return { ws: P.ws.length, utt: P.utt.length, media: P.media.length, blobs: P.blobs.length, sent: P.sent.length, submits: P.gpu.submits, t: performance.now() } })()`)
  await ev(c, `window.__venomAsk(${JSON.stringify(text)})`)
  const end = Date.now() + timeout
  let st
  for (;;) {
    st = await ev(c, `(() => { const P = window.__proof; const ws = P.ws.slice(${mark.ws}); return { phase: window.__venom.phase, done: ws.some((m) => m.type === 'done' || m.type === 'error'), texts: ws.filter((m) => m.type === 'text').length, cutAt: P.cutAt } })()`)
    if (st.done && ['listening', 'dormant'].includes(st.phase) && (!armCut || st.cutAt)) break
    if (Date.now() > end) break
    await sleep(100)
  }
  await sleep(150)
  const d = await ev(c, `(() => { const P = window.__proof; return {
    ws: P.ws.slice(${mark.ws}), utt: P.utt.slice(${mark.utt}), media: P.media.slice(${mark.media}).filter((m) => m.src.startsWith('blob:')), sent: P.sent.slice(${mark.sent}),
    blobs: P.blobs.slice(${mark.blobs}).map(({ blob, ...b }) => b), blobBase: ${mark.blobs}, submits: P.gpu.submits - ${mark.submits},
    cutAt: P.cutAt, tts: JSON.parse(JSON.stringify(window.__tts)), kokoro: { ready: window.__proofK.isReady(), unavailable: window.__proofK.isUnavailable(), lastError: window.__proofK.lastError, stats: { ...window.__proofK.stats } } } })()`)
  const firstDelta = d.ws.find((m) => m.type === 'text')?.t ?? null
  const sounds = [
    ...d.utt.filter((u) => u.start != null).map((u) => ({ t: u.start, end: u.end, engine: 'system', voice: u.voice, text: u.text, error: u.error })),
    ...d.media.filter((m) => m.playing != null).map((m) => ({ t: m.playing, end: m.ended ?? m.pause, engine: m.engine, voice: m.engine, text: m.text, duration: m.duration })),
  ].sort((a, b) => a.t - b.t)
  const queued = [
    ...d.utt.map((u) => ({ t: u.queued, engine: 'system', text: u.text, started: u.start != null, error: u.error })),
    ...d.media.map((m) => ({ t: m.play, engine: m.engine, text: m.text, started: m.playing != null })),
  ].sort((a, b) => a.t - b.t)
  const r = {
    question: text, timedOut: !(st.done && ['listening', 'dormant'].includes(st.phase)),
    answer: d.ws.filter((m) => m.type === 'text').map((m) => m.delta).join(''),
    deltas: d.ws.filter((m) => m.type === 'text').map((m) => m.delta),
    firstDeltaToSoundMs: firstDelta != null && sounds[0] ? Math.round(sounds[0].t - firstDelta) : null,
    firstSoundEngine: sounds[0]?.engine ?? null,
    askToFirstDeltaMs: firstDelta != null ? Math.round(firstDelta - mark.t) : null,
    chunks: queued, sounds: sounds.map((s) => ({ ...s, t: Math.round(s.t - mark.t), end: s.end != null ? Math.round(s.end - mark.t) : null })),
    blobs: d.blobs, blobBase: d.blobBase, gpuSubmits: d.submits, sent: d.sent, cutAt: d.cutAt != null ? Math.round(d.cutAt - mark.t) : null,
    tts: d.tts, kokoro: d.kokoro, media: d.media, utt: d.utt,
  }
  return r
}

function wavStats(buf) {
  let off = 12, fmt = null, data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4), size = buf.readUInt32LE(off + 4)
    if (id === 'fmt ') fmt = { format: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), rate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) }
    if (id === 'data') { data = buf.subarray(off + 8, off + 8 + size); break }
    off += 8 + size + (size % 2)
  }
  if (!fmt || !data) return { error: 'not a wav' }
  const n = data.length / (fmt.bits / 8) / fmt.channels
  let peak = 0, sum = 0
  for (let i = 0; i < n; i++) {
    const v = fmt.format === 3 ? data.readFloatLE(i * 4 * fmt.channels) : data.readInt16LE(i * 2 * fmt.channels) / 32768
    const a = Math.abs(v); if (a > peak) peak = a; sum += v * v
  }
  return { format: fmt.format === 3 ? 'float32' : `pcm${fmt.bits}`, rate: fmt.rate, durationS: +(n / fmt.rate).toFixed(3), peak: +peak.toFixed(4), rms: +Math.sqrt(sum / n).toFixed(4) }
}

/** Decode (and optionally save) the Kokoro blobs of one answer. */
async function blobAudio(sess, r, saveAs) {
  const out = []
  for (let i = 0; i < r.blobs.length; i++) {
    const b64 = await ev(sess.c, `(async () => { const b = new Uint8Array(await window.__proof.blobs[${r.blobBase + i}].blob.arrayBuffer()); let s = ''; for (let k = 0; k < b.length; k += 0x8000) s += String.fromCharCode.apply(null, b.subarray(k, k + 0x8000)); return btoa(s) })()`)
    const buf = Buffer.from(b64, 'base64')
    if (saveAs) { fs.mkdirSync(path.dirname(saveAs), { recursive: true }); fs.writeFileSync(`${saveAs}-${i + 1}.wav`, buf) }
    out.push({ bytes: buf.length, type: r.blobs[i].type, kokoroStats: r.blobs[i].stats, ...wavStats(buf) })
  }
  return out
}

function dirSize(dir) {
  let n = 0
  if (!fs.existsSync(dir)) return 0
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    n += e.isDirectory() ? dirSize(p) : fs.statSync(p).size
  }
  return n
}
const mb = (b) => +(b / 1048576).toFixed(1)
const stat = (xs) => { const v = xs.filter((x) => x != null).sort((a, b) => a - b); return { n: v.length, median: v.length ? v[Math.floor((v.length - 1) / 2)] + (v.length % 2 ? 0 : (v[v.length / 2] - v[Math.floor((v.length - 1) / 2)]) / 2) : null, worst: v.at(-1) ?? null, best: v[0] ?? null } }

// ---------------------------------------------------------------- checks
async function check1(sess, open, fresh) {
  const c1 = { profileFresh: fresh, bootMs: open.bootMs, readyBeforeDormant: open.readyAt }
  // Asked the moment he is up: who answers while the model is still loading?
  const k0 = await ev(sess.c, `({ ready: window.__proofK.isReady(), progress: window.__proofK.loadProgress() })`)
  c1.atFirstAsk = k0
  const during = await ask(sess, 'Is the RTX 5090 in stock? #stock (asked during load)')
  c1.duringLoadAnswer = { firstSoundEngine: during.firstSoundEngine, firstDeltaToSoundMs: during.firstDeltaToSoundMs, chunks: during.chunks.map((x) => `${x.engine}${x.started ? '' : '(not started)'}: ${x.text}`), voices: [...new Set(during.sounds.map((s) => s.voice))] }
  const k = await waitKokoro(sess, open.tClick, 900000)
  // Ready is polled from the click on; readyAt is set when it came before dormant.
  c1.loadMs = open.readyAt ?? (k.ready ? k.ms : null)
  c1.kokoroAfterLoad = k
  const warm = await ask(sess, 'Is the RTX 5090 in stock? #stock (first Kokoro answer)')
  c1.firstKokoroAnswer = { firstDeltaToSoundMs: warm.firstDeltaToSoundMs, gpuSubmitsDuringAnswer: warm.gpuSubmits, chunks: warm.chunks.map((x) => `${x.engine}: ${x.text}`) }
  c1.duringLoadAnswer.gpuSubmits = during.gpuSubmits
  const withAudio = [during, warm].find((r) => r.blobs.length) ?? warm
  c1.audioFrom = withAudio === during ? 'first answer (asked at dormant)' : 'second answer'
  c1.audio = await blobAudio(sess, withAudio, `${S}/wav/kokoro-stock`)
  c1.wavSaved = `${S}/wav/kokoro-stock-*.wav`
  c1.tts = warm.tts
  c1.kokoro = warm.kokoro
  c1.gpu = await ev(sess.c, 'window.__proof.gpu')
  c1.network = externalNet(sess).map((r) => ({ url: r.url.slice(0, 160), status: r.status, bytes: r.bytes ?? null, fromCache: r.fromCache, failed: r.failed }))
  c1.networkBytes = c1.network.reduce((a, r) => a + (r.bytes || 0), 0)
  c1.cacheStorage = await ev(sess.c, `(async () => { const out = []; for (const name of await caches.keys()) { const cache = await caches.open(name); const entries = []; for (const req of await cache.keys()) { const res = await cache.match(req); const size = res ? (await res.blob()).size : null; entries.push({ url: req.url.slice(0, 160), size }) } out.push({ name, entries }) } return out })()`)
  const dir = `${sess.profile}/Default/Service Worker/CacheStorage`
  c1.cacheDir = dir
  c1.cacheDirMB = mb(dirSize(dir))
  return c1
}

async function check2(sess, engine, runs, port) {
  if (engine === 'system') await ask(sess, 'warm-up #stock')
  const rows = []
  for (let i = 0; i < runs; i++) {
    let reloaded = false
    let warmup = null
    if (engine === 'kokoro') {
      // kokoro.ts rests (isUnavailable() true, system voice) for 45 s after
      // three slow generations, then comes back; a resting page is reloaded
      // (model from cache) so every run measures Kokoro, then one sentence is
      // generated (not played) through kokoro.speak() so the model is warm.
      const st = await ev(sess.c, `({ ready: window.__proofK.isReady(), unavailable: window.__proofK.isUnavailable() })`)
      if (st.unavailable || !st.ready) {
        const o = await openApp(sess, port)
        await waitKokoro(sess, o.tClick, 300000)
        reloaded = true
      }
      warmup = await ev(sess.c, `(async () => { const t = performance.now(); const u = await window.__proofK.speak('Warming up, sir.'); if (u) URL.revokeObjectURL(u); return { ms: Math.round(performance.now() - t), stats: { ...window.__proofK.stats } } })()`)
    }
    const r = await ask(sess, `Is the RTX 5090 in stock? #stock run ${i + 1}`)
    rows.push({ ms: r.firstDeltaToSoundMs, engine: r.firstSoundEngine, voice: r.sounds[0]?.voice, chunks: r.chunks.map((x) => x.engine + (x.started ? '' : '(not started)')), timedOut: r.timedOut, reloaded, warmup, kokoroStats: r.blobs.map((b) => b.stats), latchedAfter: r.kokoro.lastError || null })
    say(`check2 ${engine} run ${i + 1}: ${r.firstDeltaToSoundMs} ms (${r.firstSoundEngine}${reloaded ? ', page reloaded' : ''})`)
  }
  return { engine, values: rows.map((r) => r.ms), ...stat(rows.map((r) => r.ms)), rows }
}

async function check3(sess, engine) {
  const r = await ask(sess, 'What is my balance? #money')
  const chunks = r.chunks.map((x) => x.text)
  const tokens = ['USD 6,635.01', '10:30', 'RTX 5090']
  const whole = Object.fromEntries(tokens.map((t) => [t, chunks.filter((ch) => ch && ch.includes(t)).length === 1]))
  const truncated = engine === 'kokoro' && chunks.some((ch) => ch && ch.length >= 60) // __tts.lastText keeps 60 chars
  return { engine, deltas: r.deltas, chunks, whole, pass: Object.values(whole).every(Boolean) && !truncated, truncatedTextPossible: truncated, engines: r.chunks.map((x) => x.engine) }
}

async function check5(sess) {
  const a = await ask(sess, 'Is the RTX 5090 in stock? #stock (to be interrupted)', { armCut: true })
  const sentInterrupt = a.sent.find((m) => m.type === 'interrupt')
  await sleep(500)
  const before = fs.existsSync(CLI_LOG) ? fs.readFileSync(CLI_LOG, 'utf8').split('\n').length : 0
  const b = await ask(sess, 'Which seller is that?')
  const userLines = fs.readFileSync(CLI_LOG, 'utf8').split('\n').slice(before - 1).filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.stdin)
    .map((e) => JSON.parse(e.stdin)).filter((m) => m.type === 'user').map((m) => m.message.content)
  const prompt = userLines.at(-1) ?? null
  const conv = `${MEM}/conversations`
  const logLines = fs.existsSync(conv) ? fs.readdirSync(conv).sort().flatMap((f) => fs.readFileSync(`${conv}/${f}`, 'utf8').split('\n').filter(Boolean)).map((l) => JSON.parse(l)) : []
  const stored = logLines.filter((l) => /to be interrupted/.test(l.user)).at(-1)?.assistant ?? null
  const heard = sentInterrupt?.spoken ?? null
  return {
    trigger: 'Space keydown while speaking -> App onSpeechStart (same handler as the voice loop barge-in), dispatched in the page the instant the first answer chunk ended',
    cutAfter: a.cutAt, spokenBeforeCut: a.sounds.map((s) => `${s.engine}: ${s.text} [${s.t}-${s.end} ms]`),
    interruptFrame: sentInterrupt ?? null, nextPrompt: prompt, storedAssistant: stored,
    pass: Boolean(heard && prompt && prompt.includes('[The owner interrupted') && prompt.includes(heard) && !prompt.includes('cheapest') && stored === `${heard} [interrupted by the owner here]`),
    secondAnswer: b.answer,
  }
}

/** The ask hook must not exist on a page served with the normal config (vite.config.ts). */
async function check6() {
  startProc('vite-plain', process.execPath, ['scripts/voice-proof.plain-server.mjs'], {
    cwd: W,
    // No VITE_* engine settings: this is the app as vite.config.ts serves it.
    // The bridge URL alone is moved off the live 8787 (and 8787 is blocked below).
    env: { ...process.env, VOICE_PROOF_PORT: String(PORT.plain), VOICE_PROOF_CACHE: `${S}/vite-cache-${PORT.plain}`, VITE_BRIDGE_URL: `ws://localhost:${PORT.bridge}` },
  }, PORT.plain)
  const html = (await waitFor('vite plain', async () => {
    const t = await (await fetch(`http://localhost:${PORT.plain}/`)).text()
    return { ok: t.includes('Content-Security-Policy'), t }
  }, 60000)).t
  if (/jsdelivr/i.test(html)) throw new Error('the normally served page names jsdelivr')
  const prof = `${S}/chrome-profile-plain-${Date.now()}`
  const sess = await startChrome(prof, '6plain')
  try {
    const { c } = sess
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: 'window.__proofCfg = {};' })
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT })
    await c.send('Network.setBlockedURLs', { urls: LIVE.map((p) => `*:${p}*`) })
    await c.send('Page.bringToFront')
    await c.send('Page.navigate', { url: `http://localhost:${PORT.plain}/` })
    // Same point at which openApp() requires the hook on the proof page: the
    // app is mounted (its INITIALISE button is up), nothing clicked.
    await waitFor('plain page mounted', async () => {
      const ok = await ev(c, `[...document.querySelectorAll('button')].some((b) => /INITIALISE/.test(b.textContent))`)
      return { ok: Boolean(ok) }
    }, 60000)
    await sleep(2000)
    const page = await ev(c, `({ ask: typeof window.__venomAsk, venom: typeof window.__venom, flag: typeof __VENOM_PROOF_ASK__ === 'undefined' ? 'undefined' : String(__VENOM_PROOF_ASK__), csp: document.querySelector('meta[http-equiv="Content-Security-Policy"]').content.replace(/\\s+/g, ' ').trim() })`)
    const proofAsk = result.pageEnv?.ask ?? null
    return {
      // The dev server hands a define to the page as a global, so the flag reads false here (it is compiled out of a build).
      pass: page.ask === 'undefined' && ['undefined', 'false'].includes(page.flag) && page.venom !== 'undefined',
      normalConfig: page, proofConfigAsk: proofAsk, scriptSrc: (page.csp.match(/script-src([^;]*);/) || [])[1]?.trim() ?? null,
      liveRequests: [...sess.net.values()].filter((r) => LIVE.some((p) => r.url.includes(`:${p}`))).map((r) => `${r.blockedReason ?? r.status ?? '?'} ${r.url.slice(0, 80)}`),
    }
  } finally {
    await stopChrome(sess)
    try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch (e) { say('could not delete', prof, e.code) }
  }
}

async function check4(kind) {
  const prof = kind === 'blocked' ? `${S}/chrome-profile-blocked-${Date.now()}` : PROFILE
  const sess = await startChrome(prof, `4${kind}`)
  try {
    const cfg = kind === 'blocked' ? { block: ['*huggingface.co*', '*hf.co*', '*xethub*'] } : { noGpu: true }
    const open = await openApp(sess, PORT.kokoro, cfg)
    const first = await ask(sess, 'Is the RTX 5090 in stock? #stock (fallback, at dormant)')
    const k = await waitKokoro(sess, open.tClick, 180000)
    const second = await ask(sess, 'Is the RTX 5090 in stock? #stock (fallback, after load settled)')
    const full = 'The RTX 5090 is in stock at three sellers. The cheapest is 9,499 dollars. Shall I open the listing?'
    const spoken = (r) => r.sounds.map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim()
    return {
      kind, flagsOrInjection: cfg, navigatorGpu: open.guard.gpu, blockedRequests: sess.blocked.slice(0, 10), blockedCount: sess.blocked.length,
      kokoro: k, kokoroLastError: k.lastError,
      first: { engine: first.firstSoundEngine, firstDeltaToSoundMs: first.firstDeltaToSoundMs, spoken: spoken(first), whole: spoken(first) === full, chunks: first.chunks.map((x) => `${x.engine}${x.started ? '' : '(not started)'}: ${x.text}`) },
      second: { engine: second.firstSoundEngine, firstDeltaToSoundMs: second.firstDeltaToSoundMs, spoken: spoken(second), whole: spoken(second) === full, kokoroStats: second.blobs.map((b) => b.stats), tts: second.tts },
    }
  } finally {
    await stopChrome(sess)
    if (kind === 'blocked') try { fs.rmSync(prof, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }) } catch (e) { say('could not delete', prof, e.code) }
  }
}

// ---------------------------------------------------------------- check 7 (real profile, headed, audible)
const HF = /huggingface\.co|hf\.co|xethub/i
const netSum = (sess, re) => [...sess.net.values()].filter((r) => !re || re.test(r.url)).filter((r) => /^https?:/.test(r.url) && !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(r.url)).reduce((a, r) => a + (r.bytes || 0), 0)

/** robocopy the owner's profile (read only) into the scratch dir. */
function copyRealProfile() {
  const src = defaultProfile()
  const dst = `${S}/real-profile-copy`
  const info = { src, dst, kept: false }
  if (!fs.existsSync(src)) throw new Error('owner profile not found: ' + src)
  if (KEEP_COPY && fs.existsSync(`${dst}/Default`)) info.kept = true
  else {
    if (fs.existsSync(dst)) {
      if (!dst.endsWith('real-profile-copy')) throw new Error('refusing to delete ' + dst)
      fs.rmSync(dst, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
    }
    const t = Date.now()
    let status = 0
    try {
      execFileSync('robocopy', [src.replace(/\//g, '\\'), dst.replace(/\//g, '\\'), '/E', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NP', '/XF', 'lockfile', 'LOCK', 'SingletonLock'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    } catch (e) {
      status = e.status
      info.robocopyTail = String(e.stdout ?? '').trim().split(/\r?\n/).slice(-8).map((l) => l.trim())
    }
    info.robocopyExit = status
    info.copyMs = Date.now() - t
    if (status == null || status >= 16) throw new Error(`robocopy failed (exit ${status}): ${JSON.stringify(info.robocopyTail)}`)
  }
  try { info.sizeMB = mb(dirSize(dst)) } catch (e) { info.sizeMB = null; info.sizeError = String(e) }
  return info
}

// Both engines dead: no WebGPU (Kokoro cannot load) and a speech engine that
// swallows every utterance. Nothing can sound, so the page has to say so: the
// alarm in window.__tts, the red banner and the HUD voice line.
async function check8() {
  const sess = await startChrome(PROFILE, '8silent')
  try {
    await openApp(sess, PORT.kokoro, { noGpu: true, deadSpeech: true })
    const r = await ask(sess, 'Is the RTX 5090 in stock? #stock (nothing can speak)', { timeout: 120000 })
    await sleep(700)
    const page = await ev(sess.c, `(() => { const t = window.__tts; const q = (sel) => document.querySelector(sel); return { silent: t.silent, alarm: t.alarm, nativeBroken: t.nativeBroken, kokoro: t.kokoro.state, log: t.log.slice(-3).map((e) => ({ engine: e.engine, voice: e.voice, started: e.started, why: e.why })), banner: q('.error') ? q('.error').textContent : null, voiceLine: q('.voice-status') ? q('.voice-status').textContent : null, voiceClass: q('.voice-status') ? q('.voice-status').className : null } })()`)
    const pass = !r.timedOut && page.silent >= 1 && /nothing could speak/.test(page.alarm) && /Voice failed/.test(page.banner ?? '') && /VOICE FAILED/.test(page.voiceLine ?? '') && /voice-bad/.test(page.voiceClass ?? '')
    return { pass, timedOut: r.timedOut, soundsStarted: r.sounds.length, ...page }
  } finally {
    await stopChrome(sess)
  }
}

async function check7() {
  const c7 = result.checks[7] = { pass: false, failures: [], fullscreen: !WINDOWED, answers: [] }
  const fail = (s) => c7.failures.push(s)
  c7.profile = copyRealProfile()
  say('profile copy', JSON.stringify(c7.profile))
  save()
  const flags = chromeArgs({ url: `http://localhost:${PORT.kokoro}/`, profile: c7.profile.dst.replace(/\//g, '\\'), fullscreen: !WINDOWED })
  const sess = await startChrome(c7.profile.dst, 'real', { flags })
  let b = null
  try {
    const v = await (await fetch(`http://127.0.0.1:${PORT.cdp}/json/version`)).json()
    // Chrome drops CDP permission overrides when the client that set them
    // disconnects, so this browser-level connection stays open until the end.
    b = await Cdp.open(v.webSocketDebuggerUrl)
    try { await b.send('Browser.grantPermissions', { origin: `http://localhost:${PORT.kokoro}`, permissions: ['audioCapture'] }); c7.micGranted = true }
    catch (e) { c7.micGranted = String(e); fail('microphone permission not granted: ' + e.message) }
    const cfg = { audible: true, localVoicesOnly: false }
    const pageState = () => ev(sess.c, `(() => { const t = window.__tts || {}; return { silent: t.silent, alarm: t.alarm, why: t.why, systemVoice: t.systemVoice, out: window.__proof.out } })()`)
    const load = async (label) => {
      sess.net.clear()
      const open = await openApp(sess, PORT.kokoro, cfg)
      const k = await waitKokoro(sess, open.tClick, 300000)
      const kok = await ev(sess.c, 'JSON.parse(JSON.stringify((window.__tts && window.__tts.kokoro) || null))')
      const tm = kok?.timing ?? kok ?? {}
      const L = {
        label, window: { w: open.guard.innerWidth, h: open.guard.innerHeight }, guard: open.guard,
        clickToReadyMs: open.readyAt ?? (k.ready ? k.ms : null), ready: k.ready, kokoroPoll: k, ttsKokoro: kok,
        state: kok?.state ?? kok?.status?.state ?? null, loadMs: tm.loadMs ?? null, warmMs: tm.warmMs ?? null,
        hfBytes: netSum(sess, HF), hfRequests: [...sess.net.values()].filter((r) => HF.test(r.url)).length, externalBytes: netSum(sess),
      }
      c7.window = L.window
      if (!k.ready) fail(`${label} load: Kokoro not ready (${JSON.stringify(k).slice(0, 200)})`)
      say(`check7 ${label} load: ready=${k.ready} in ${L.clickToReadyMs} ms, loadMs ${L.loadMs}, warmMs ${L.warmMs}, huggingface ${mb(L.hfBytes)} MB`)
      save()
      return L
    }
    const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
    const answer = async (q) => {
      const before = await ev(sess.c, 'Date.now()')
      const r = await ask(sess, q)
      const log = await ev(sess.c, `JSON.parse(JSON.stringify(((window.__tts && window.__tts.log) || []).filter((e) => e.at >= ${before})))`)
      const used = new Set()
      const match = (text) => {
        const t = norm(text)
        const i = log.findIndex((e, j) => !used.has(j) && t && (norm(e.text) === t || norm(e.text).startsWith(t) || t.startsWith(norm(e.text))))
        if (i < 0) return null
        used.add(i)
        return log[i]
      }
      const slim = (e) => e && { engine: e.engine, voice: e.voice, started: e.started, rms: e.rms, why: e.why }
      const rows = [
        ...r.media.map((m) => ({ t: m.play, text: m.text, engine: m.engine, voice: null, started: m.playing != null, outRms: m.outRms })),
        ...r.utt.map((u) => ({ t: u.queued, text: u.text, engine: 'system', voice: u.voice, voiceLocal: u.voiceLocal, started: u.start != null, outRms: null, error: u.error })),
      ].sort((a, b) => a.t - b.t).map(({ t, ...x }) => { const e = match(x.text); return { ...x, text: e ? e.text : x.text, voice: x.voice ?? e?.voice ?? null, log: slim(e) } })
      log.forEach((e, j) => { if (!used.has(j)) rows.push({ text: e.text, engine: e.engine, voice: e.voice, started: false, outRms: null, onlyInLog: true, log: slim(e) }) })
      const A = { question: q, answer: r.answer, timedOut: r.timedOut, firstDeltaToSoundMs: r.firstDeltaToSoundMs, rows }
      if (r.timedOut) fail(`"${q}": timed out`)
      if (!rows.length) fail(`"${q}": no sentence recorded`)
      for (const x of rows) {
        const why = []
        if (x.engine !== 'kokoro' || (x.log && x.log.engine !== 'kokoro')) why.push(`engine ${x.engine}/${x.log?.engine}`)
        if (!x.started || (x.log && !x.log.started)) why.push('not started')
        if (!(x.outRms > 0.01)) why.push(`tap outRms ${x.outRms}`)
        if (!(x.log?.rms > 0.01)) why.push(`app rms ${x.log?.rms}`)
        if (why.length) fail(`"${norm(x.text).slice(0, 50)}": ${why.join(', ')}`)
      }
      c7.answers.push(A)
      say(`check7 answer: ${rows.map((x) => `${x.engine} out ${x.outRms} app ${x.log?.rms}`).join(' | ')}`)
      save()
      return A
    }
    // (a) cold load, (b) two answers, (c) warm reload and one answer, (d) diagnostics.
    c7.cold = await load('cold')
    if (c7.profile.kept) c7.cold.note = 'profile copy reused (--keep-copy): this load was not cold'
    if (c7.cold.ready) {
      await answer('Is the RTX 5090 in stock? #stock real 1')
      await answer('Is the RTX 5090 in stock? #stock real 2')
    }
    c7.afterCold = await pageState()
    // What the owner would see: the footer's voice line is part of the fix.
    try {
      c7.footer = await ev(sess.c, `(document.querySelector('.voice-status') || {}).textContent || null`)
      const shot = await sess.c.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`${S}/real-hud.png`, Buffer.from(shot.data, 'base64'))
      c7.screenshot = `${S}/real-hud.png`
    } catch (e) { c7.screenshot = 'failed: ' + e.message }
    c7.warm = await load('warm')
    if (c7.warm.ready) await answer('Is the RTX 5090 in stock? #stock real 3')
    c7.afterWarm = await pageState()
    c7.voices = await ev(sess.c, `speechSynthesis.getVoices().map((v) => v.name + (v.localService ? ' (local)' : ' (network)'))`)
    c7.systemVoice = c7.afterWarm.systemVoice ?? null
    c7.silent = (c7.afterCold.silent ?? NaN) + (c7.afterWarm.silent ?? NaN)
    c7.alarm = [c7.afterCold.alarm, c7.afterWarm.alarm].filter(Boolean).join(' | ')
    for (const [n, st] of [['cold page', c7.afterCold], ['warm page', c7.afterWarm]]) {
      if (st.silent !== 0) fail(`${n}: __tts.silent = ${st.silent}`)
      if ((st.alarm ?? '') !== '') fail(`${n}: __tts.alarm = ${JSON.stringify(st.alarm)}`)
    }
    c7.pass = c7.failures.length === 0
    return c7
  } finally {
    try { b?.ws.close() } catch {}
    await stopChrome(sess)
  }
}

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(S, { recursive: true })
  const busy = Object.values(PORT).filter((p) => listeners(p).length)
  if (busy.length) { console.error(`refusing to start: port(s) ${busy.join(', ')} already in use`); process.exit(2) }
  result.liveBefore = Object.fromEntries(LIVE.map((p) => [p, listeners(p).length > 0]))
  silentWav()
  if (FRESH && fs.existsSync(PROFILE)) fs.renameSync(PROFILE, `${PROFILE}-old-${Date.now()}`)
  const realVenom = path.join(os.homedir(), '.venom')
  const tStart = Date.now()

  await startBridge()
  const needK = [1, 2, 3, 4, 5, 7].some((n) => ONLY.has(n))
  if (needK) await startVite(PORT.kokoro, 'kokoro')
  if (ONLY.has(2) || ONLY.has(3)) await startVite(PORT.system, 'system')

  const kokoroChecks = [1, 2, 3, 5].some((n) => ONLY.has(n))
  if (kokoroChecks) {
    const fresh = !fs.existsSync(`${PROFILE}/Default`)
    let sess = await startChrome(PROFILE, 'k1')
    let open = await openApp(sess, PORT.kokoro)
    result.silenceGuard = open.guard
    result.pageEnv = open.env
    say('silence guard', JSON.stringify(open.guard), 'env', JSON.stringify(open.env))
    if (ONLY.has(1)) {
      result.checks[1] = await check1(sess, open, fresh)
      save()
      say('check1 load', result.checks[1].loadMs, 'ms; network', mb(result.checks[1].networkBytes), 'MB')
      // Second start, from the browser cache.
      await stopChrome(sess)
      sess = await startChrome(PROFILE, 'k2')
      open = await openApp(sess, PORT.kokoro)
      const k = await waitKokoro(sess, open.tClick, 300000)
      result.checks[1].secondStart = { loadMs: open.readyAt ?? (k.ready ? k.ms : null), readyBeforeDormant: open.readyAt, kokoro: k, networkBytes: externalNet(sess).reduce((a, r) => a + (r.bytes || 0), 0), network: externalNet(sess).map((r) => `${r.status} ${r.bytes ?? '?'} ${r.url.slice(0, 120)}`) }
      save()
    } else {
      const k = await waitKokoro(sess, open.tClick, 900000)
      if (!k.ready) throw new Error('kokoro not ready: ' + JSON.stringify(k))
    }
    if (ONLY.has(2)) { result.checks[2] = { kokoro: await check2(sess, 'kokoro', RUNS, PORT.kokoro) }; save() }
    if (ONLY.has(3)) { result.checks[3] = { kokoro: await check3(sess, 'kokoro') }; save() }
    if (ONLY.has(5)) {
      // A fresh page if Kokoro has latched to the system voice, so the cut is on the default engine.
      if (await ev(sess.c, 'window.__proofK.isUnavailable()')) { const o = await openApp(sess, PORT.kokoro); await waitKokoro(sess, o.tClick, 300000) }
      result.checks[5] = await check5(sess); save()
    }
    if (ONLY.has(2) || ONLY.has(3)) {
      await openApp(sess, PORT.system)
      if (ONLY.has(2)) {
        result.checks[2] = result.checks[2] || {}
        result.checks[2].system = await check2(sess, 'system', RUNS, PORT.system)
        result.checks[2].system.voicesAvailable = await ev(sess.c, `window.__proof.allVoices ? window.__proof.allVoices() : speechSynthesis.getVoices().map((v) => v.name + (v.localService ? '' : ' (network)'))`)
        result.checks[2].system.voicesOffered = NETWORK_VOICES ? 'all' : 'local (OS) voices only; Google network voices hidden (they never start in headless Chrome)'
      }
      if (ONLY.has(3)) { result.checks[3] = result.checks[3] || {}; result.checks[3].system = await check3(sess, 'system') }
      save()
    }
    await stopChrome(sess)
  }
  if (ONLY.has(4)) {
    result.checks[4] = { blocked: await check4('blocked') }; save()
    result.checks[4].noWebGPU = await check4('nogpu'); save()
  }
  if (ONLY.has(6)) { result.checks[6] = await check6(); save() }
  if (ONLY.has(7)) { await check7(); save() }
  if (ONLY.has(8)) { result.checks[8] = await check8(); save() }
  // None of this run's questions may have reached the owner's real memory.
  const leaks = []
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.statSync(p).mtimeMs >= tStart && /#stock|#money|Which seller is that/.test(fs.readFileSync(p, 'utf8'))) leaks.push(p) } }
  walk(path.join(realVenom, 'memory'))
  result.realMemoryLeaks = leaks
}

let failed = false
try {
  await main()
} catch (e) {
  failed = true
  result.errors.push(String(e?.stack ?? e))
  console.error('FAILED:', e?.message ?? e)
} finally {
  for (const rec of [...spawned].reverse()) {
    if (rec.role.startsWith('chrome') && !rec.stopped && alive(rec.pid)) await stopChrome({ rec, c: { ws: { close() {} } } })
    await stopProc(rec)
  }
  await sleep(500)
  result.portsAfter = Object.fromEntries([...Object.values(PORT), ...LIVE].map((p) => [p, listeners(p).length ? 'LISTENING' : 'free']))
  result.finished = new Date().toISOString()
  save()
  summary()
  process.exit(failed ? 1 : 0)
}

function summary() {
  const c = result.checks
  const L = []
  if (c[1]) {
    const a = c[1]
    L.push(`CHECK 1 Kokoro load: ${a.profileFresh ? 'fresh profile' : 'cached profile'}, load ${a.loadMs} ms, network ${mb(a.networkBytes)} MB in ${a.network.length} requests; cache ${a.cacheStorage.map((x) => x.name).join(',')} = ${a.cacheDirMB} MB on disk; second start ${a.secondStart?.loadMs} ms (network ${mb(a.secondStart?.networkBytes ?? 0)} MB)`)
    L.push(`  while loading: first sound by ${a.duringLoadAnswer.firstSoundEngine} (${a.duringLoadAnswer.voices.join(', ')}); WebGPU devices ${a.gpu.devices}, submits during an answer ${a.firstKokoroAnswer.gpuSubmitsDuringAnswer}, adapter ${JSON.stringify(a.gpu.adapter)}`)
    for (const x of a.audio) L.push(`  sentence: ${x.durationS}s rms ${x.rms} peak ${x.peak} gen ${x.kokoroStats?.lastMs} ms rtf ${x.kokoroStats?.rtf}`)
    L.push(`  __tts: ${JSON.stringify(a.tts)}`)
  }
  if (c[2]) for (const k of ['kokoro', 'system']) if (c[2][k]) L.push(`CHECK 2 ${k}: first delta -> first sound median ${c[2][k].median} ms, worst ${c[2][k].worst} ms; values ${c[2][k].values.join(', ')}; voice ${[...new Set(c[2][k].rows.map((r) => r.voice))].join(', ')}`)
  if (c[3]) for (const k of ['kokoro', 'system']) if (c[3][k]) L.push(`CHECK 3 ${k}: ${c[3][k].pass ? 'PASS' : 'FAIL'} chunks ${JSON.stringify(c[3][k].chunks)}`)
  if (c[4]) for (const k of ['blocked', 'noWebGPU']) if (c[4][k]) { const x = c[4][k]; L.push(`CHECK 4 ${k}: blocked requests ${x.blockedCount}; kokoro ${x.kokoro.ready ? 'READY' : x.kokoro.unavailable ? 'unavailable' : 'still loading'} lastError="${x.kokoroLastError}"; first answer ${x.first.engine} ${x.first.firstDeltaToSoundMs} ms whole=${x.first.whole}; second ${x.second.engine} ${x.second.firstDeltaToSoundMs} ms whole=${x.second.whole}`) }
  if (c[5]) L.push(`CHECK 5 interruption: ${c[5].pass ? 'PASS' : 'FAIL'}; stored assistant ${JSON.stringify(c[5].storedAssistant)}; next prompt ${JSON.stringify((c[5].nextPrompt ?? '').slice(0, 260))}`)
  if (c[8]) L.push(`CHECK 8 nothing can speak: ${c[8].pass ? 'PASS' : 'FAIL'}; unspoken ${c[8].silent}, sounds started ${c[8].soundsStarted}; alarm ${JSON.stringify(c[8].alarm)}; banner ${JSON.stringify(c[8].banner)}; HUD line ${JSON.stringify(c[8].voiceLine)} (${c[8].voiceClass})`)
  if (c[6]) L.push(`CHECK 6 ask hook: ${c[6].pass ? 'PASS' : 'FAIL'}; normal config typeof __venomAsk = ${c[6].normalConfig.ask} (flag ${c[6].normalConfig.flag}), proof config = ${c[6].proofConfigAsk}; script-src ${c[6].scriptSrc}`)
  if (c[7]) {
    const x = c[7]
    L.push(`CHECK 7 real profile headed: ${x.pass ? 'PASS' : 'FAIL'}; window ${x.window?.w}x${x.window?.h} fullscreen=${x.fullscreen}; cold load ${x.cold?.clickToReadyMs} ms (${mb(x.cold?.hfBytes ?? 0)} MB from network${x.profile?.kept ? ', profile copy reused: NOT cold' : ''}), warm load ${x.warm?.clickToReadyMs} ms (${mb(x.warm?.hfBytes ?? 0)} MB); kokoro loadMs ${x.cold?.loadMs}/${x.warm?.loadMs} warmMs ${x.cold?.warmMs}/${x.warm?.warmMs}; silent ${x.silent} alarm ${JSON.stringify(x.alarm ?? null)}; system voice ${JSON.stringify(x.systemVoice ?? null)}; profile copy ${x.profile?.sizeMB} MB (robocopy exit ${x.profile?.robocopyExit ?? 'kept'})`)
    for (const a of x.answers ?? []) for (const r of a.rows) L.push(`  ${r.engine} ${r.voice} ${r.started ? 'started' : 'NOT started'} outRms ${r.outRms} appRms ${r.log?.rms ?? null} ${JSON.stringify(r.text)}`)
    if (x.failures?.length) L.push(`  failures: ${x.failures.join('; ')}`)
  }
  L.push(`jsdelivr requests: ${result.jsdelivrRequests.length}${result.jsdelivrRequests.length ? ' ' + JSON.stringify(result.jsdelivrRequests.slice(0, 5)) : ''}; /ort/ requests served locally: ${result.ortRequests.length}${result.ortRequests.length ? ' ' + JSON.stringify([...new Set(result.ortRequests.map((x) => x.split(' ').slice(1).join(' ')))].slice(0, 6)) : ''}`)
  if (result.errors.length) L.push('ERRORS: ' + result.errors.join('\n'))
  L.push(`ports after: ${JSON.stringify(result.portsAfter)}`)
  L.push(`result JSON: ${OUT}`)
  console.log('\n' + L.join('\n'))
}
