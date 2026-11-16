#!/usr/bin/env node
// Silent, unattended end-to-end proof of ONE spoken session of the Venom OS
// desktop app. Not a node:test file on purpose.
//
//   node.exe scripts/turn-proof.mjs --wav <48 kHz mono PCM16 wav> [--dev | --exe <exe>]
//     [--dist <dir>] [--schedule <json>] [--brain fake|real] [--seconds 60]
//     [--standdown-ms 0] [--stop-after-answers K] [--out <dir>] [--data <dir>]
//     [--page-port 4196] [--bridge-port 8795] [--cdp-port 9337]
//
// The app runs muted (--mute-audio, VENOM_APP_SILENT=1) with VENOM_APP_CAPTURE=1,
// which keeps Chromium muted but lets the page's own audio graph carry real
// samples, so the spoken answer is recorded at the node feeding the
// AudioDestinationNode. The microphone is Chromium's fake capture device
// playing --wav (looped). Nothing is clicked unless the page reports
// window.__VENOM_SILENT__ === true and window.__VENOM_CAPTURE__ === true.
//
// Helpers (startProc, listeners, waitFor, ev, Cdp, snapshot/isOurs, stepQuit)
// are copied from scripts/app-proof.mjs; the page recorder takes its WebSocket
// and blob taps from scripts/voice-proof.mjs.

import { spawn, execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const LIVE_DIR = W // this checkout: Electron, dist and the speech models are taken from here
const SC = path.join(os.tmpdir(), 'venom-os-turn-proof').split(path.sep).join('/')
const WebSocket = createRequire(W + '/package.json')('ws')
const FORBIDDEN_PORTS = [4188, 8788, 5173, 8787]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const SILENCE_MS = 650 // src/lib/vad.ts: const SILENCE_MS = 650 (checked at run time below)

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2)
const has = (n) => argv.includes(n)
const arg = (name, def) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] != null && !argv[i + 1].startsWith('--') ? argv[i + 1] : def }
const fwd = (p) => path.resolve(p).replace(/\\/g, '/')
const die = (m) => { console.error(m); process.exit(2) }
const num = (name, def, min, max) => { const v = Number(arg(name, def)); if (!Number.isFinite(v) || v < min || v > max) die(`${name} must be a number ${min}-${max}`); return v }
const DEV = !has('--exe')
const EXE = DEV ? `${fwd(LIVE_DIR)}/node_modules/electron/dist/electron.exe` : fwd(arg('--exe', ''))
const APP_ARGS = DEV ? [`${W}/desktop/main.mjs`] : []
const BRAIN = arg('--brain', 'fake')
if (!['fake', 'real'].includes(BRAIN)) die('--brain must be fake or real')
if (!arg('--wav', null)) die('--wav <48 kHz mono PCM16 wav> is required')
const WAV = fwd(arg('--wav'))
const DIST = fwd(arg('--dist', `${LIVE_DIR}/dist`))
const SCHEDULE = arg('--schedule', null) ? fwd(arg('--schedule')) : null
const SECONDS = num('--seconds', 60, 1, 3600)
const STANDDOWN_MS = num('--standdown-ms', 0, 0, 3600000)
const STOP_AFTER = has('--stop-after-answers') ? num('--stop-after-answers', 1, 1, 1000) : null
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const OUT = fwd(arg('--out', `${SC}/${stamp}`))
const PROFILE = fwd(arg('--data', `${SC}/profile`))
const PORT = { page: num('--page-port', 4196, 1024, 65535), bridge: num('--bridge-port', 8795, 1024, 65535), cdp: num('--cdp-port', 9337, 1024, 65535) }
for (const p of Object.values(PORT)) if (FORBIDDEN_PORTS.includes(p)) die(`port ${p} is reserved (4188/8788/5173/8787); refusing`)
if (new Set(Object.values(PORT)).size !== 3) die('page, bridge and CDP ports must differ')
const lc = (p) => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
for (const [n, p] of [['--out', OUT], ['--data', PROFILE]]) {
  if (lc(p).startsWith(lc(`${LIVE_DIR}/release`)) || lc(p).includes('/.venom')) die(`${n} ${p} is off limits`)
}
if (!DEV && lc(EXE).startsWith(lc(`${LIVE_DIR}/release`))) die('the release folder of this checkout is off limits for the proof; copy the build elsewhere')
const winPath = (p) => p.replace(/\//g, '\\')
const CHROMIUM_ARGS = [`--remote-debugging-port=${PORT.cdp}`, '--mute-audio', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${winPath(WAV)}`]

const T0 = Date.now()
const say = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const result = {
  started: new Date().toISOString(), brain: BRAIN, dev: DEV, exe: EXE, appArgs: APP_ARGS, chromiumArgs: CHROMIUM_ARGS,
  ports: PORT, out: OUT, profile: PROFILE, dist: DIST, wav: WAV, seconds: SECONDS, standdownMs: STANDDOWN_MS, stopAfterAnswers: STOP_AFTER,
  schedule: null, env: null, page: null, silent: null, capture: null, fakeCapture: { flags: CHROMIUM_ARGS.slice(2), wav: null },
  failures: [], notes: [], console: [],
}
const fail = (m) => { result.failures.push(m); say('FAILURE:', m) }
const save = () => { try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(`${OUT}/result.json`, JSON.stringify(result, null, 2)) } catch (e) { console.error('could not save', e.message) } }

// ---------------------------------------------------------------- processes (from app-proof)
function listeners(port) {
  try {
    return [...new Set(execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)
      .filter((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l))
      .map((l) => Number(l.trim().split(/\s+/).pop())))]
  } catch { return [] }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const spawned = []
function startProc(role, cmd, args, opts) {
  fs.mkdirSync(OUT, { recursive: true })
  const fd = fs.openSync(`${OUT}/${role}.stdout.log`, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', fd, fd], windowsHide: false })
  const rec = { role, pid: child.pid, child, exited: false, code: null, signal: null }
  child.on('error', (e) => { rec.exited = true; rec.spawnError = e.message })
  child.on('exit', (code, signal) => { rec.exited = true; rec.code = code; rec.signal = signal; rec.exitedAt = Date.now() })
  spawned.push(rec)
  say(`started ${role} pid ${child.pid}`)
  return rec
}
async function waitFor(label, fn, ms, every = 300) {
  const end = Date.now() + ms
  let last
  while (Date.now() < end) {
    try { last = await fn(); if (last?.ok) return last; if (last?.stop) break } catch (e) { last = { info: String(e?.message ?? e) } }
    await sleep(every)
  }
  throw new Error(`${label} not ready after ${ms} ms: ${last?.info ?? ''}`)
}
const execFileP = (cmd, args, opts = {}) => new Promise((res, rej) => {
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 90000, ...opts }, (err, stdout) => err ? rej(err) : res(stdout))
})
const PS_PROCS = String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$list = Get-CimInstance Win32_Process | ForEach-Object { [pscustomobject]@{ pid = [int]$_.ProcessId; ppid = [int]$_.ParentProcessId; name = $_.Name; exe = $_.ExecutablePath; cmd = $_.CommandLine; created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }) } }
ConvertTo-Json -InputObject @($list) -Compress -Depth 3
`
const norm = (p) => String(p ?? '').replace(/\//g, '\\').toLowerCase()
async function psList() {
  const f = `${OUT}/procs.ps1`
  fs.writeFileSync(f, PS_PROCS)
  const out = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', winPath(f)])
  return JSON.parse(out.slice(out.indexOf('['))).map((p) => ({ ...p, exeN: norm(p.exe), cmdN: norm(p.cmd) }))
}
const known = new Map()
const ts = (x) => Date.parse(x) || 0
async function snapshot(label) {
  try {
    const list = await psList()
    const roots = spawned.map((r) => r.pid)
    for (const pid of [...listeners(PORT.bridge), ...listeners(PORT.page), ...listeners(PORT.cdp)]) if (!roots.includes(pid)) roots.push(pid)
    for (const pid of roots) { const p = list.find((x) => x.pid === pid); if (p && !known.has(pid)) known.set(pid, p.created) }
    let added = true
    while (added) { added = false; for (const p of list) if (!known.has(p.pid) && known.has(p.ppid) && ts(p.created) >= ts(known.get(p.ppid))) { known.set(p.pid, p.created); added = true } }
    result.processTree = result.processTree || {}
    result.processTree[label] = list.filter((p) => known.get(p.pid) === p.created).map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, cmd: String(p.cmd ?? '').slice(0, 200) }))
  } catch (e) { result.notes.push(`process snapshot ${label}: ${e.message}`) }
}
function isOurs(p, list) {
  let cur = p
  for (let i = 0; i < 30 && cur; i++) {
    if (known.get(cur.pid) === cur.created) return true
    if (known.has(cur.ppid) && ts(cur.created) >= ts(known.get(cur.ppid))) return true
    cur = list.find((x) => x.pid === cur.ppid && x.pid !== cur.pid)
  }
  return false
}

// ---------------------------------------------------------------- CDP (from app-proof)
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw) } catch { return }
      if (m.id && this.pending.has(m.id)) { const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result) }
      else if (m.method) for (const h of this.handlers) { try { h(m) } catch {} }
    })
    ws.on('close', () => { this.closed = true; for (const { rej } of this.pending.values()) rej(new Error('socket closed')); this.pending.clear() })
    ws.on('error', () => {})
  }
  static async open(url) { const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 512 * 1024 * 1024 }); await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) }); return new Cdp(ws) }
  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error('socket closed'))
    return new Promise((res, rej) => {
      const id = ++this.id
      const t = setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); rej(new Error(`${method} timed out after ${timeoutMs} ms`)) } }, timeoutMs)
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v) }, rej: (e) => { clearTimeout(t); rej(e) } })
      try { this.ws.send(JSON.stringify({ id, method, params })) } catch (e) { clearTimeout(t); this.pending.delete(id); rej(e) }
    })
  }
  on(fn) { this.handlers.push(fn) }
  close() { try { this.ws.close() } catch {} }
}
async function ev(c, expression, timeoutMs = 30000) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, timeoutMs)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const cdpJson = async (p) => (await fetch(`http://127.0.0.1:${PORT.cdp}${p}`, { signal: AbortSignal.timeout(3000) })).json()
const isAppUrl = (u) => new RegExp(`^https?://(localhost|127\\.0\\.0\\.1):${PORT.page}(/|$)`).test(String(u))
const PHASE = `(document.querySelector('.hud[data-phase]') ? document.querySelector('.hud[data-phase]').getAttribute('data-phase') : 'offline')`
const KOKORO_EXPR = `(() => { const t = window.__tts; if (!t) return null; try { return JSON.parse(JSON.stringify(t.kokoro || null)) } catch (e) { return { error: String(e) } } })()`

// ---------------------------------------------------------------- the page recorder
// Installed with Page.addScriptToEvaluateOnNewDocument, so it runs before any
// of the app's scripts. It observes only: nothing is blocked, muted or changed.
const INJECT = String.raw`(() => {
  if (window.__turn) return
  const cfg = __CFG__
  const now = () => performance.now()
  const P = window.__turn = { anchor: { perf: now(), date: Date.now() }, stt: [], ws: [], sent: [], phases: [], standdowns: [], media: [], blobs: [], utt: [], diag: [], ctxs: [], errors: [], installed: {} }
  const clone = (o) => { try { return JSON.parse(JSON.stringify(o, (k, v) => (Array.isArray(v) && v.length > 30 ? v.slice(-30) : typeof v === 'function' ? undefined : v))) } catch (e) { return { cloneError: String(e) } } }
  P.snap = (why) => { P.diag.push({ t: now(), why, voice: clone(window.__voice), mic: clone(window.__mic), tts: clone(window.__tts) }) }
  // 1. hearing: every POST to the bridge's /stt.
  const of = window.fetch
  window.fetch = function (input, init) {
    const u = String(input && input.url ? input.url : input)
    const method = String((init && init.method) || (input && input.method) || 'GET').toUpperCase()
    const p = of.apply(this, arguments)
    if (method === 'POST' && /\/stt(\?|$)/.test(u)) {
      const body = init && init.body
      const rec = { tPost: now(), tResp: null, ms: null, status: null, text: null, bytes: body && typeof body.size === 'number' ? body.size : (body && body.byteLength) || null, type: body && body.type }
      P.stt.push(rec)
      p.then((res) => {
        rec.tResp = now(); rec.ms = Math.round(rec.tResp - rec.tPost); rec.status = res.status
        res.clone().json().then((j) => { rec.text = j && typeof j.text === 'string' ? j.text : null }).catch((e) => { rec.parseError = String(e) })
        setTimeout(() => P.snap('stt+50ms #' + P.stt.indexOf(rec)), 50)
        setTimeout(() => P.snap('stt+1000ms #' + P.stt.indexOf(rec)), 1000)
      }, (e) => { rec.tResp = now(); rec.error = String(e) })
    }
    return p
  }
  P.installed.fetch = true
  // 2. bridge socket (as voice-proof).
  const OWS = window.WebSocket
  class TWS extends OWS {
    constructor(...a) {
      super(...a)
      this.addEventListener('message', (e) => {
        try {
          const m = JSON.parse(e.data)
          if (!m || !m.type || m.type === 'diag') return
          const r = { t: now(), type: m.type }
          if (m.type === 'text') r.delta = m.delta
          else { for (const k of ['text', 'message', 'error', 'ask', 'reason', 'subtype']) if (m[k] != null) r[k] = typeof m[k] === 'string' ? m[k].slice(0, 2000) : m[k] }
          P.ws.push(r)
        } catch (err) {}
      })
    }
    send(data) {
      try { const m = JSON.parse(data); if (m && m.type && m.type !== 'diag' && m.type !== 'ping') P.sent.push({ t: now(), ...clone(m) }) } catch (err) {}
      return super.send(data)
    }
  }
  window.WebSocket = TWS
  P.installed.ws = true
  // 3. phase, every 100 ms; stand-down after cfg.standdownMs away from dormant.
  let last = null, since = now()
  setInterval(() => {
    const el = document.querySelector('.hud[data-phase]')
    const ph = el ? el.getAttribute('data-phase') : 'offline'
    if (ph !== last) { P.phases.push({ t: now(), phase: ph }); last = ph; since = now() }
    if (cfg.standdownMs > 0 && ph !== 'dormant' && ph !== 'offline' && now() - since >= cfg.standdownMs) {
      P.standdowns.push({ t: now(), phase: ph }); since = now()
      window.dispatchEvent(new Event('venom:stand-down'))
    }
  }, 100)
  // 4. speech synthesis: record only (the app keeps system voices at volume 0).
  if (window.speechSynthesis) {
    const ss = window.speechSynthesis, orig = ss.speak.bind(ss)
    ss.speak = function (u) {
      const rec = { text: u.text, voice: u.voice ? u.voice.name : null, volume: u.volume, queued: now(), start: null, end: null, error: null }
      P.utt.push(rec)
      u.addEventListener('start', () => { rec.start = now() })
      u.addEventListener('end', () => { rec.end = now() })
      u.addEventListener('error', (e) => { rec.error = e.error; rec.end = now() })
      return orig(u)
    }
  }
  // 5. media elements: play / playing / ended / pause (no muting here).
  const mp = HTMLMediaElement.prototype, op = mp.play, seen = new WeakSet()
  mp.play = function () {
    if (!seen.has(this)) {
      seen.add(this)
      const tts = window.__tts || {}
      const rec = { src: String(this.src).slice(0, 80), text: tts.lastText || null, engine: tts.engine || null, play: now(), playing: null, ended: null, pause: null, duration: null, muted: this.muted, volume: this.volume }
      P.media.push(rec)
      this.addEventListener('playing', () => { if (rec.playing == null) rec.playing = now(); rec.mutedAtPlaying = this.muted; rec.volumeAtPlaying = this.volume })
      this.addEventListener('ended', () => { if (rec.ended == null) rec.ended = now(); rec.duration = this.duration })
      this.addEventListener('pause', () => { if (rec.pause == null) rec.pause = now() })
      this.addEventListener('error', () => { rec.error = this.error ? this.error.code : 'error' })
    }
    return op.apply(this, arguments)
  }
  // 6. Kokoro blobs (as voice-proof).
  const cou = URL.createObjectURL
  URL.createObjectURL = function (obj) {
    const url = cou.call(URL, obj)
    if (obj instanceof Blob && obj.size > 1000 && /audio|wav|mpeg|octet/.test(obj.type || 'audio')) P.blobs.push({ url, t: now(), size: obj.size, type: obj.type, blob: obj })
    return url
  }
  // 7. output capture at the destination: every node connected to an
  //    AudioDestinationNode is also connected to one recorder per context.
  const oc = AudioNode.prototype.connect
  const recorder = (ctx) => {
    if (ctx.__turnRec) return ctx.__turnRec
    const R = { i: P.ctxs.length, rate: ctx.sampleRate, chunks: [], sources: 0, created: now(), maps: [] }
    P.ctxs.push(R)
    const sp = ctx.createScriptProcessor(4096, 1, 1)
    sp.channelCountMode = 'explicit'; sp.channelInterpretation = 'speakers'
    const z = ctx.createGain(); z.gain.value = 0
    sp.onaudioprocess = (e) => {
      const d = e.inputBuffer.getChannelData(0)
      let pk = 0
      for (let i = 0; i < d.length; i++) { const a = d[i] < 0 ? -d[i] : d[i]; if (a > pk) pk = a }
      let off = null
      try { const o = ctx.getOutputTimestamp(); if (o && o.performanceTime) off = o.performanceTime - o.contextTime * 1000 } catch (err) {}
      if (off != null && (R.maps.length === 0 || R.chunks.length % 200 === 0)) R.maps.push({ ct: e.playbackTime, off })
      // ScriptProcessor latency: this input left the source about two buffers before
      // playbackTime (calibrated against media 'playing' + the blob's own lead silence).
      R.chunks.push({ ct: e.playbackTime - 2 * d.length / ctx.sampleRate, n: d.length, pk, data: pk > 1e-6 ? new Float32Array(d) : null })
    }
    oc.call(sp, z); oc.call(z, ctx.destination)
    ctx.__turnRec = { R, sp }
    return ctx.__turnRec
  }
  AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      if (dest instanceof AudioDestinationNode && !(typeof OfflineAudioContext !== 'undefined' && dest.context instanceof OfflineAudioContext)) {
        const r = recorder(dest.context)
        if (this !== r.sp) { oc.call(this, r.sp, rest[0] || 0); r.R.sources++ }
      }
    } catch (e) { P.errors.push('tap: ' + String(e)) }
    return oc.call(this, dest, ...rest)
  }
  P.installed.connect = true
  // Pulling the capture out: PCM16 (placed by context time) in base64 slices.
  P.build = (i) => {
    const R = P.ctxs[i]
    if (!R || !R.chunks.length) return null
    const t0 = R.chunks[0].ct, last = R.chunks[R.chunks.length - 1]
    const n = Math.round((last.ct - t0) * R.rate) + last.n
    const pcm = new Int16Array(n)
    let peak = 0
    for (const c of R.chunks) {
      if (!c.data) continue
      const at = Math.round((c.ct - t0) * R.rate)
      for (let k = 0; k < c.n && at + k < n; k++) { const s = Math.max(-1, Math.min(1, c.data[k])); if (Math.abs(s) > peak) peak = Math.abs(s); pcm[at + k] = s < 0 ? s * 0x8000 : s * 0x7fff }
    }
    P.pcm = new Uint8Array(pcm.buffer)
    const off = R.maps.length ? R.maps[R.maps.length - 1].off : null
    return { i, rate: R.rate, samples: n, bytes: P.pcm.length, t0ct: t0, perfAtStart: off == null ? null : t0 * 1000 + off, maps: R.maps.slice(0, 50), sources: R.sources, chunks: R.chunks.length, nonSilentChunks: R.chunks.filter((c) => c.data).length, peak }
  }
  P.slice = (from, len) => {
    const u = P.pcm.subarray(from, from + len)
    let s = ''
    for (let k = 0; k < u.length; k += 0x8000) s += String.fromCharCode.apply(null, u.subarray(k, k + 0x8000))
    return btoa(s)
  }
  P.blob64 = (i) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(',')[1]); fr.onerror = () => res(null); fr.readAsDataURL(P.blobs[i].blob) })
})()`

// ---------------------------------------------------------------- environment
function appEnv() {
  for (const d of ['home', 'memory', 'hermes-memory', 'workspace', 'agents']) fs.mkdirSync(`${OUT}/${d}`, { recursive: true })
  fs.writeFileSync(`${OUT}/hermes-memory/MEMORY.md`, '')
  const env = { ...process.env }
  for (const k of ['ELECTRON_RUN_AS_NODE', 'VENOM_APP_NODE', 'VENOM_BRIDGE_PORT', 'VENOM_ALLOWED_ORIGINS', 'VENOM_ALLOW_NO_ORIGIN', 'HERMES_HOME', 'VENOM_APP_TRAY_POPUP', 'VENOM_CLAUDE_EXECUTABLE', 'FAKE_CLI_STOCK_ALL']) delete env[k]
  Object.assign(env, {
    VENOM_APP_SILENT: '1', VENOM_APP_CAPTURE: '1', VENOM_WINDOWED: '1',
    VENOM_APP_DATA: PROFILE, VENOM_APP_PORT: String(PORT.page), VENOM_APP_BRIDGE_PORT: String(PORT.bridge), VENOM_APP_DIST: DIST,
    // Never reach the real GBrain server, even when the environment or venom.config.json switches it on.
    VENOM_HONCHO: '0', VENOM_GBRAIN: '0', VENOM_MEMORY: '1', VENOM_MEMORY_DIR: `${OUT}/memory`, VENOM_HERMES_MEMORY_DIR: `${OUT}/hermes-memory`,
    VENOM_AGENTS_DIR: `${OUT}/agents`, VENOM_AGENT_ACTIVITY: '0', VENOM_WORKSPACE: `${OUT}/workspace`,
    VENOM_DISABLE: 'browser,camera', ELEVENLABS_API_KEY: '', VENOM_STT_MODEL_DIR: `${fwd(LIVE_DIR)}/desktop/models`,
  })
  if (BRAIN === 'fake') {
    Object.assign(env, { VENOM_CLAUDE_EXECUTABLE: `${W}/scripts/fake-cli.mjs`, FAKE_CLI_STOCK_ALL: '1', FAKE_CLI_LOG: `${OUT}/fake-cli.log`, VENOM_MCP_SERVERS: '', USERPROFILE: `${OUT}/home`, HOME: `${OUT}/home` })
  } else {
    env.VENOM_MCP_SERVERS = 'context7,firecrawl,sequential-thinking' // the app's default list WITHOUT 'hermes'
  }
  // Refuse to start unless every silence / fake-device guard is present.
  const need = { VENOM_APP_SILENT: '1', VENOM_APP_CAPTURE: '1' }
  for (const [k, v] of Object.entries(need)) if (env[k] !== v) throw new Error(`${k} is not ${v}; refusing`)
  for (const a of ['--mute-audio', '--use-fake-device-for-media-stream', `--remote-debugging-port=${PORT.cdp}`]) if (!CHROMIUM_ARGS.includes(a)) throw new Error(`${a} missing; refusing`)
  if (!CHROMIUM_ARGS.some((a) => a.startsWith('--use-file-for-fake-audio-capture=') && a.includes('\\'))) throw new Error('--use-file-for-fake-audio-capture missing; refusing')
  if (BRAIN === 'real' && /hermes/i.test(env.VENOM_MCP_SERVERS)) throw new Error('hermes MCP in real-brain list; refusing')
  return env
}

function checkWav(file) {
  const b = fs.readFileSync(file)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error(`${file} is not a WAV`)
  let p = 12, fmt = null, dataLen = null
  while (p < b.length - 8) {
    const id = b.toString('ascii', p, p + 4), n = b.readUInt32LE(p + 4)
    if (id === 'fmt ') fmt = { format: b.readUInt16LE(p + 8), channels: b.readUInt16LE(p + 10), rate: b.readUInt32LE(p + 12), bits: b.readUInt16LE(p + 22) }
    if (id === 'data') { dataLen = n; break }
    p += 8 + n + (n & 1)
  }
  if (!fmt || fmt.format !== 1 || fmt.channels !== 1 || fmt.rate !== 48000 || fmt.bits !== 16) throw new Error(`${file} must be 48000 Hz mono PCM16 (got ${JSON.stringify(fmt)})`)
  return { ...fmt, seconds: +(dataLen / 2 / 48000).toFixed(3) }
}

// ---------------------------------------------------------------- audio helpers (node)
function wavBytes(int16, rate) {
  const o = Buffer.alloc(44 + int16.length * 2)
  o.write('RIFF', 0); o.writeUInt32LE(36 + int16.length * 2, 4); o.write('WAVE', 8); o.write('fmt ', 12)
  o.writeUInt32LE(16, 16); o.writeUInt16LE(1, 20); o.writeUInt16LE(1, 22); o.writeUInt32LE(rate, 24); o.writeUInt32LE(rate * 2, 28); o.writeUInt16LE(2, 32); o.writeUInt16LE(16, 34)
  o.write('data', 36); o.writeUInt32LE(int16.length * 2, 40)
  Buffer.from(int16.buffer, int16.byteOffset, int16.length * 2).copy(o, 44)
  return o
}
function analyse(f32, rate) {
  let peak = 0, sq = 0
  for (const s of f32) { const a = Math.abs(s); if (a > peak) peak = a; sq += s * s }
  // Non-silent stretches: 10 ms frames with a peak >= 0.002; gaps < 300 ms merged.
  const fr = Math.round(rate / 100), gap = 30
  const loud = []
  for (let i = 0; i < f32.length; i += fr) { let p = 0; for (let k = i; k < Math.min(i + fr, f32.length); k++) { const a = Math.abs(f32[k]); if (a > p) p = a } loud.push(p >= 0.002) }
  const st = []
  let cur = null, quiet = 0
  loud.forEach((l, j) => {
    if (l) { if (!cur) cur = { a: j, b: j }; cur.b = j; quiet = 0 } else if (cur) { quiet++; if (quiet >= gap) { st.push(cur); cur = null; quiet = 0 } }
  })
  if (cur) st.push(cur)
  return { peak: +peak.toFixed(4), rms: +Math.sqrt(sq / Math.max(1, f32.length)).toFixed(5), seconds: +(f32.length / rate).toFixed(3), stretches: st.map((s) => ({ startS: +(s.a / 100).toFixed(2), endS: +((s.b + 1) / 100).toFixed(2) })) }
}
function to16k(f32, rate) {
  // Simple box low-pass + linear interpolation (speech only, Whisper is tolerant).
  const k = rate / 16000, w = Math.max(1, Math.round(k))
  const out = new Int16Array(Math.floor(f32.length / k))
  for (let i = 0; i < out.length; i++) {
    const x = i * k, a = Math.floor(x)
    let s = 0, n = 0
    for (let j = a - Math.floor(w / 2); j <= a + Math.floor(w / 2); j++) if (j >= 0 && j < f32.length) { s += f32[j]; n++ }
    const v = Math.max(-1, Math.min(1, n ? s / n : 0))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return out
}
function postStt(buf, origin) {
  return new Promise((res) => {
    const t = Date.now()
    const req = http.request({ host: '127.0.0.1', port: PORT.bridge, path: '/stt', method: 'POST', headers: { 'content-type': 'audio/wav', 'content-length': buf.length, Origin: origin }, timeout: 120000 }, (r) => {
      let body = ''; r.setEncoding('utf8'); r.on('data', (d) => { body += d })
      r.on('end', () => { let text = null; try { text = JSON.parse(body).text } catch {} res({ status: r.statusCode, ms: Date.now() - t, text, raw: text == null ? body.slice(0, 200) : undefined }) })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', (e) => res({ status: null, error: e.message }))
    req.end(buf)
  })
}

// ---------------------------------------------------------------- run
const S_ = { app: null, c: null, browser: null, targetId: null }
const APP_LOG = `${PROFILE}/logs/app.log`, BRIDGE_LOG = `${PROFILE}/logs/bridge.log`
const fileSize = (f) => { try { return fs.statSync(f).size } catch { return 0 } }
const readFrom = (f, off = 0) => { try { const b = fs.readFileSync(f); return b.subarray(Math.min(off, b.length)).toString('utf8') } catch { return '' } }
const logOff = {}

async function launch() {
  if (!fs.existsSync(EXE)) throw new Error(`app executable not found: ${EXE}`)
  if (DEV && !fs.existsSync(APP_ARGS[0])) throw new Error('desktop/main.mjs not found')
  if (!fs.existsSync(`${DIST}/index.html`)) throw new Error(`${DIST} has no index.html`)
  const ENV = appEnv()
  result.env = Object.fromEntries(Object.entries(ENV).filter(([k]) => /^VENOM_/.test(k)))
  logOff.app = fileSize(APP_LOG); logOff.bridge = fileSize(BRIDGE_LOG)
  const t0 = Date.now()
  S_.app = startProc('app', EXE, [...APP_ARGS, ...CHROMIUM_ARGS], { cwd: W, env: ENV })
  const dead = () => S_.app.exited ? { stop: true, info: `app exited code ${S_.app.code}; app.log: ${readFrom(APP_LOG, logOff.app).split(/\r?\n/).slice(-6).join(' | ')}` } : null
  const target = await waitFor('CDP page target', async () => {
    const d = dead(); if (d) return d
    const t = (await cdpJson('/json')).find((x) => x.type === 'page' && isAppUrl(x.url))
    return { ok: Boolean(t), t, info: 'no page target yet' }
  }, 90000, 200)
  result.spawnToTargetMs = Date.now() - t0
  S_.targetId = target.t.id
  S_.c = await Cdp.open(target.t.webSocketDebuggerUrl)
  S_.c.on((m) => {
    const p = m.params
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) result.console.push(`${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    else if (m.method === 'Runtime.exceptionThrown') result.console.push('exception: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300))
  })
  for (const m of ['Runtime.enable', 'Page.enable']) await S_.c.send(m)
  try { const v = await cdpJson('/json/version'); result.browserVersion = v.Browser; S_.browser = await Cdp.open(v.webSocketDebuggerUrl) } catch {}
  const cfg = JSON.stringify({ standdownMs: STANDDOWN_MS })
  await S_.c.send('Page.addScriptToEvaluateOnNewDocument', { source: INJECT.replace('__CFG__', cfg) })
  await S_.c.send('Page.reload', { ignoreCache: false })
  await sleep(500)
  await waitFor('#root children after reload', async () => {
    const d = dead(); if (d) return d
    const n = await ev(S_.c, `(document.querySelector('#root') || { children: [] }).children.length`, 5000)
    return { ok: n > 0, info: `#root children ${n}` }
  }, 60000, 150)
  result.page = await ev(S_.c, `({ silent: window.__VENOM_SILENT__, capture: window.__VENOM_CAPTURE__, desktop: window.__VENOM_DESKTOP__ ? JSON.parse(JSON.stringify(window.__VENOM_DESKTOP__)) : null, origin: location.origin, href: location.href, recorder: window.__turn ? window.__turn.installed : null, phase: ${PHASE} })`)
  result.silent = result.page.silent === true
  result.capture = result.page.capture === true
  result.origin = result.page.origin
  say('page', JSON.stringify(result.page))
  await snapshot('after start')
  if (!result.silent || !result.capture) throw new Error(`ABORT before any click: __VENOM_SILENT__=${JSON.stringify(result.page.silent)} __VENOM_CAPTURE__=${JSON.stringify(result.page.capture)} (both must be true)`)
  if (!result.page.recorder?.connect) throw new Error('ABORT: the page recorder is not installed')
}

async function initialise() {
  const r = result.initialise = {}
  const rect = await waitFor('INITIALISE button', async () => {
    const b = await ev(S_.c, `(() => { const b = [...document.querySelectorAll('button')].find((b) => /INITIALI[SZ]E/i.test(b.textContent || '')); if (!b) return null; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2, w: q.width } })()`)
    return { ok: Boolean(b && b.w > 0), b, info: JSON.stringify(b) }
  }, 15000)
  if (await ev(S_.c, 'window.__VENOM_SILENT__ === true && window.__VENOM_CAPTURE__ === true') !== true) throw new Error('ABORT: silence/capture flags changed before the click')
  const { x, y } = rect.b
  await S_.c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await S_.c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await S_.c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  const tClick = Date.now()
  r.tClickPerf = await ev(S_.c, 'performance.now()')
  await waitFor('phase dormant', async () => { const p = await ev(S_.c, PHASE, 5000); return { ok: p === 'dormant', info: `phase ${p}` } }, 60000, 100)
  r.clickToDormantMs = Date.now() - tClick
  const waitS = result.profileCold ? 600 : 180
  let k = null
  const kEnd = Date.now() + waitS * 1000
  let lastSay = 0
  for (;;) {
    try { k = await ev(S_.c, KOKORO_EXPR, 5000) } catch (e) { k = { error: e.message } }
    if (['ready', 'failed', 'off'].includes(k?.state) || Date.now() > kEnd) break
    if (Date.now() - lastSay > 20000) { say(`waiting for Kokoro: ${JSON.stringify(k).slice(0, 160)}`); lastSay = Date.now() }
    await sleep(500)
  }
  r.kokoro = k
  r.kokoroClickToReadyMs = k?.state === 'ready' ? Date.now() - tClick : null
  r.kokoroLoadMs = k?.loadMs ?? null
  if (k?.state !== 'ready') fail(`Kokoro not ready ${waitS} s after the click: ${JSON.stringify(k).slice(0, 200)}`)
  await sleep(1200)
  r.hud = await ev(S_.c, `(() => { const l = (document.body.innerText || '').split(/\\n/).map((s) => s.trim()); return { memoryLine: l.find((x) => x.startsWith('memory ·')) || null, micLine: l.find((x) => x.startsWith('mic ·')) || null, voiceLine: l.find((x) => x.startsWith('voice ·')) || null } })()`)
  await ev(S_.c, `window.__turn.snap('ready')`)
  r.readyPerf = await ev(S_.c, 'performance.now()')
  say('ready', JSON.stringify({ dormantMs: r.clickToDormantMs, kokoro: k?.state, readyMs: r.kokoroClickToReadyMs, hud: r.hud }))
}

async function record() {
  const t0 = Date.now()
  let lastLog = 0, doneAt = null
  while (Date.now() - t0 < SECONDS * 1000) {
    await sleep(500)
    if (S_.app.exited) { fail('the app exited during the recording'); break }
    const s = await ev(S_.c, `({ phase: ${PHASE}, stt: window.__turn.stt.length, asks: window.__turn.sent.filter((m) => m.type === 'ask').length, done: window.__turn.ws.filter((f) => f.type === 'done').length, playing: window.__turn.media.some((m) => m.playing != null && m.ended == null && m.pause == null), media: window.__turn.media.length, heard: window.__voice ? window.__voice.heard : null })`, 10000).catch(() => null)
    if (!s) continue
    if (Date.now() - lastLog > 10000) { say('recording', JSON.stringify(s)); lastLog = Date.now() }
    if (STOP_AFTER && s.done >= STOP_AFTER && !s.playing && ['dormant', 'listening'].includes(s.phase)) {
      doneAt ??= Date.now()
      if (Date.now() - doneAt >= 2000) { result.stoppedEarly = `after ${s.done} answer(s)`; break }
    } else doneAt = null
  }
  result.recordedS = +((Date.now() - t0) / 1000).toFixed(1)
  await ev(S_.c, `window.__turn.snap('end')`).catch(() => {})
}

async function collect() {
  const P = await ev(S_.c, `(() => { const P = window.__turn; return { anchor: P.anchor, stt: P.stt, ws: P.ws, sent: P.sent, phases: P.phases, standdowns: P.standdowns, media: P.media, utt: P.utt, diag: P.diag, errors: P.errors, blobs: P.blobs.map((b) => ({ t: b.t, size: b.size, type: b.type })), ctxs: P.ctxs.map((R) => ({ i: R.i, rate: R.rate, sources: R.sources, chunks: R.chunks.length, nonSilent: R.chunks.filter((c) => c.data).length })), nowPerf: performance.now() } })()`, 60000)
  result.anchor = P.anchor
  Object.assign(result, { stt: P.stt, frames: P.ws, sent: P.sent, phases: P.phases, standdowns: P.standdowns, media: P.media, utterances: P.utt, diagnostics: P.diag, pageErrors: P.errors, contexts: P.ctxs })
  if (P.utt.length) fail(`speech synthesis spoke ${P.utt.length} utterance(s): the system voice was used instead of Kokoro`)
  // Blobs.
  result.blobs = []
  for (let i = 0; i < P.blobs.length; i++) {
    const b64 = await ev(S_.c, `window.__turn.blob64(${i})`, 60000).catch(() => null)
    const ext = /wav/.test(P.blobs[i].type) ? 'wav' : /mpeg/.test(P.blobs[i].type) ? 'mp3' : 'bin'
    const file = `${OUT}/blob-${i + 1}.${ext}`
    if (b64) fs.writeFileSync(file, Buffer.from(b64, 'base64'))
    result.blobs.push({ ...P.blobs[i], file: b64 ? file : null })
  }
  // Output capture: the context with the most non-silent chunks.
  const best = [...P.ctxs].sort((a, b) => b.nonSilent - a.nonSilent)[0]
  if (!best) { fail('no node was ever connected to an AudioDestinationNode: nothing captured'); return }
  const meta = await ev(S_.c, `window.__turn.build(${best.i})`, 120000)
  const parts = []
  const SLICE = 3 * 1024 * 1024
  for (let off = 0; off < meta.bytes; off += SLICE) parts.push(Buffer.from(await ev(S_.c, `window.__turn.slice(${off}, ${SLICE})`, 120000), 'base64'))
  const raw = Buffer.concat(parts)
  const i16 = new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2)
  fs.writeFileSync(`${OUT}/out-capture.wav`, wavBytes(i16, meta.rate))
  const f32 = Float32Array.from(i16, (v) => v / 32768)
  const a = analyse(f32, meta.rate)
  const perf0 = meta.perfAtStart
  result.outCapture = {
    file: `${OUT}/out-capture.wav`, contextIndex: meta.i, sampleRate: meta.rate, durationS: a.seconds, peak: a.peak, rms: a.rms, sourcesConnected: meta.sources, chunks: meta.chunks, nonSilentChunks: meta.nonSilentChunks,
    perfAtStart: perf0, timeMapping: 'page time = context time * 1000 + (getOutputTimestamp().performanceTime - contextTime * 1000), sampled in the ScriptProcessor callback; a chunk is placed at playbackTime - 2 x 4096 samples (ScriptProcessor latency). Calibration on the first proof run: uncorrected, stretches began ~200 ms after the Kokoro element\'s playing event + the clip\'s own lead silence. OfflineAudioContexts (the page\'s 16 kHz WAV conversion) are not tapped.',
    silenceRule: 'peak below 0.002 for 300 ms (10 ms frames)',
    stretches: a.stretches.map((s) => ({ ...s, tStart: perf0 == null ? null : +(perf0 + s.startS * 1000).toFixed(1), tEnd: perf0 == null ? null : +(perf0 + s.endS * 1000).toFixed(1) })),
    otherContexts: P.ctxs.filter((c) => c.i !== best.i),
  }
  if (a.peak < 0.002) fail('out-capture.wav is silent')
  result._f32 = f32
  // Other contexts that reached a destination with sound: kept for inspection.
  for (const c of P.ctxs.filter((c) => c.i !== best.i && c.nonSilent > 0)) {
    try {
      const m = await ev(S_.c, `window.__turn.build(${c.i})`, 120000)
      const ps = []
      for (let off = 0; off < m.bytes; off += SLICE) ps.push(Buffer.from(await ev(S_.c, `window.__turn.slice(${off}, ${SLICE})`, 120000), 'base64'))
      const b = Buffer.concat(ps), x = new Int16Array(b.buffer, b.byteOffset, b.length / 2)
      const file = `${OUT}/out-capture-ctx${c.i}.wav`
      fs.writeFileSync(file, wavBytes(x, m.rate))
      const an = analyse(Float32Array.from(x, (v) => v / 32768), m.rate)
      Object.assign(result.outCapture.otherContexts.find((o) => o.i === c.i), { file, perfAtStart: m.perfAtStart, durationS: an.seconds, peak: an.peak, rms: an.rms, stretches: an.stretches.map((s) => ({ ...s, tStart: m.perfAtStart == null ? null : +(m.perfAtStart + s.startS * 1000).toFixed(1), tEnd: m.perfAtStart == null ? null : +(m.perfAtStart + s.endS * 1000).toFixed(1) })) })
    } catch (e) { result.notes.push(`context ${c.i} dump: ${e.message}`) }
  }
}

async function backTranscribe() {
  const oc = result.outCapture
  if (!oc || !result._f32) return
  const f32 = result._f32, rate = oc.sampleRate
  result.backTranscript = []
  for (const s of oc.stretches) {
    for (let a = s.startS; a < s.endS; a += 28) {
      const b = Math.min(s.endS, a + 28)
      const seg = f32.subarray(Math.max(0, Math.floor((a - 0.2) * rate)), Math.min(f32.length, Math.ceil((b + 0.2) * rate)))
      const wav = wavBytes(to16k(seg, rate), 16000)
      const r = await postStt(wav, result.origin)
      result.backTranscript.push({ startS: +a.toFixed(2), endS: +b.toFixed(2), tStart: oc.perfAtStart == null ? null : +(oc.perfAtStart + a * 1000).toFixed(1), bytes: wav.length, ...r })
    }
  }
  delete result._f32
}

function turns() {
  const asks = (result.sent ?? []).filter((m) => m.type === 'ask')
  const sent = result.sent ?? []
  const st = result.outCapture?.stretches ?? []
  result.turns = asks.map((a, i) => {
    const next = sent.find((m) => m.t > a.t && (m.type === 'ask' || m.type === 'interrupt'))
    const nextAsk = asks[i + 1]
    const until = nextAsk ? nextAsk.t : Infinity
    const stt = [...(result.stt ?? [])].filter((x) => x.tResp != null && x.tResp <= a.t).pop() ?? null
    const fr = (result.frames ?? []).filter((f) => f.t >= a.t && f.t < until)
    const deltas = fr.filter((f) => f.type === 'text')
    const done = fr.find((f) => f.type === 'done')
    const errs = fr.filter((f) => f.type === 'error')
    const audio = st.filter((s) => s.tStart != null && s.tEnd > a.t && s.tStart < until)
    const tFirstDelta = deltas[0]?.t ?? null
    const tFirstAudio = audio.length ? Math.max(audio[0].tStart, a.t) : null
    const tLastAudio = audio.length ? audio[audio.length - 1].tEnd : null
    const media = (result.media ?? []).filter((m) => m.play >= a.t && m.play < until)
    const playingAtNext = next ? (st.some((s) => s.tStart != null && s.tStart < next.t && s.tEnd > next.t) || media.some((m) => m.playing != null && m.playing < next.t && (m.ended ?? m.pause ?? Infinity) > next.t)) : null
    const r = (x) => (x == null ? null : Math.round(x))
    return {
      n: i + 1, heard: stt?.text ?? null, askText: a.text ?? a.prompt ?? a.question ?? null, ask: a,
      tSttPost: r(stt?.tPost), tSttResp: r(stt?.tResp), tAsk: r(a.t), tFirstDelta: r(tFirstDelta), tDone: r(done?.t), answer: deltas.map((d) => d.delta ?? '').join(''),
      tFirstAudio: r(tFirstAudio), tLastAudio: r(tLastAudio),
      endOfSpeechToFirstAudioMs: stt && tFirstAudio != null ? r(tFirstAudio - (stt.tPost - SILENCE_MS)) : null,
      sttMs: stt ? r(stt.tResp - stt.tPost) : null,
      brainFirstTokenMs: tFirstDelta != null ? r(tFirstDelta - a.t) : null,
      ttsFirstAudioMs: tFirstAudio != null && tFirstDelta != null ? r(tFirstAudio - tFirstDelta) : null,
      spokenS: +(audio.reduce((s, x) => s + (Math.min(x.tEnd, until) - Math.max(x.tStart, a.t)), 0) / 1000).toFixed(2),
      kokoroClips: media.filter((m) => m.src.startsWith('blob:')).length,
      tFirstPlaying: r(media.find((m) => m.src.startsWith('blob:') && m.playing != null)?.playing),
      nextSent: next ? { type: next.type, t: r(next.t) } : null, audioPlayingWhenNextSent: playingAtNext, errors: errs,
    }
  })
  result.turnTimingNote = `all t* are performance.now() of the page (Date.now() anchor in result.anchor). endOfSpeechToFirstAudioMs = tFirstAudio - (tSttPost - ${SILENCE_MS}): the page's detector (src/lib/vad.ts SILENCE_MS = ${SILENCE_MS}) closes a segment after ${SILENCE_MS} ms of silence, then converts it to 16 kHz WAV and POSTs it; the conversion time is NOT subtracted, so the real end of speech is slightly earlier and the true figure slightly larger. tFirstAudio is the first non-silent output sample (>= 0.002) after tAsk.`
}

async function stepQuit() {
  const q = result.quit = { failures: [] }
  const app = S_.app
  await snapshot('before quit')
  if (app && !app.exited) {
    const tries = [
      ['Target.closeTarget', async () => { if (!S_.browser || !S_.targetId) throw new Error('no browser socket'); await S_.browser.send('Target.closeTarget', { targetId: S_.targetId }, 5000) }],
      ['window.close()', async () => { await S_.c.send('Runtime.evaluate', { expression: 'window.close()' }, 5000) }],
      ['Browser.close', async () => { const v = await cdpJson('/json/version'); const b = await Cdp.open(v.webSocketDebuggerUrl); b.send('Browser.close').catch(() => {}); await sleep(500); b.close() }],
    ]
    const t = Date.now()
    q.attempts = []
    for (const [name, fn] of tries) {
      try { await fn(); q.attempts.push(`${name}: sent`) } catch (e) { q.attempts.push(`${name}: ${e.message}`); continue }
      const tEnd = Date.now() + 12000
      while (!app.exited && Date.now() < tEnd) await sleep(200)
      if (app.exited) { q.method = name; break }
    }
    q.closeToExitMs = app.exited ? (app.exitedAt ?? Date.now()) - t : null
    q.appExitCode = app.code
    if (!app.exited) q.failures.push('the app did not exit after being closed')
  } else q.method = app ? 'already exited' : 'never started'
  S_.c?.close(); S_.browser?.close()
  const tP = Date.now()
  while (Date.now() - tP < 10000 && Object.values(PORT).some((p) => listeners(p).length)) await sleep(250)
  await sleep(1000)
  q.ports = Object.fromEntries(Object.values(PORT).map((p) => [p, listeners(p)]))
  let list = null
  try { list = await psList() } catch (e) { q.failures.push('process listing failed: ' + e.message) }
  const outN = norm(OUT), exeN = norm(EXE), mainN = norm(`${W}/desktop/main.mjs`)
  // The shells that started this script carry --out in their command line: skip them.
  const ancestors = new Set()
  for (let pid = process.pid, n = 0; list && pid && n < 30 && !ancestors.has(pid); n++) { ancestors.add(pid); pid = list.find((x) => x.pid === pid)?.ppid }
  const left = list ? list.filter((p) => !ancestors.has(p.pid) && p.ppid !== process.pid && (isOurs(p, list) || p.cmdN.includes(outN) || (p.exeN === exeN && p.cmdN.includes(mainN))) && !/^(powershell|conhost|netstat)\.exe$/i.test(p.name ?? '')) : []
  q.leftover = left.map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, cmd: String(p.cmd ?? '').slice(0, 200) }))
  const busy = Object.entries(q.ports).filter(([, pids]) => pids.length)
  if (left.length || busy.length) {
    q.failures.push(`leak: ${left.length} process(es) left${busy.length ? ', ports listening ' + busy.map(([p]) => p).join(',') : ''}`)
    q.killed = []
    for (const p of left.filter((p) => isOurs(p, list))) { let ok; try { process.kill(p.pid); ok = 'killed' } catch (e) { ok = e.code } q.killed.push({ pid: p.pid, name: p.name, ok }) }
  }
  q.clean = !left.length && !busy.length
  q.roles = 'app (electron), bridge (node bridge/server.mjs), STT worker, brain (fake-cli or claude): all are descendants of the app pid and are covered by the process-tree check'
  for (const f of q.failures) fail('quit: ' + f)
}

async function main() {
  if (!fs.existsSync(WAV)) throw new Error(`--wav ${WAV} not found`)
  result.fakeCapture.wav = checkWav(WAV)
  if (SCHEDULE) result.schedule = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'))
  const vad = readFrom(`${W}/src/lib/vad.ts`).match(/const SILENCE_MS = (\d+)/)
  result.silenceMsInVadTs = vad ? Number(vad[1]) : null
  if (result.silenceMsInVadTs !== SILENCE_MS) result.notes.push(`vad.ts SILENCE_MS is ${result.silenceMsInVadTs}, the script assumes ${SILENCE_MS}`)
  const busy = Object.values(PORT).filter((p) => listeners(p).length)
  if (busy.length) { result.aborted = `refusing to start: port(s) ${busy.join(', ')} already listening`; throw new Error(result.aborted) }
  result.profileCold = !fs.existsSync(PROFILE) || !fs.readdirSync(PROFILE).length
  fs.mkdirSync(OUT, { recursive: true })
  if (BRAIN === 'real') console.log('\n!!!!!!!! --brain real: this run uses the OWNER\'S CLAUDE ALLOWANCE (real USERPROFILE/HOME login, MCP context7,firecrawl,sequential-thinking) !!!!!!!!\n')
  await launch()
  await initialise()
  say(`recording ${SECONDS} s`)
  await record()
  await collect()
  turns()
  save()
  say('back-transcribing the captured output')
  await backTranscribe()
}

let ok = false
try { ok = await main() ?? true } catch (e) { fail(String(e?.message ?? e)); ok = false }
finally {
  delete result._f32
  try { if (S_.app || spawned.length) await stepQuit() } catch (e) { fail('quit threw: ' + e.message) }
  for (const rec of spawned) if (!rec.exited && alive(rec.pid)) { try { process.kill(rec.pid) } catch {} }
  for (const [n, f, off] of [['app.log', APP_LOG, logOff.app], ['bridge.log', BRIDGE_LOG, logOff.bridge]]) { try { fs.writeFileSync(`${OUT}/${n}`, readFrom(f, off ?? 0)) } catch {} }
  result.portsAfter = Object.fromEntries(Object.values(PORT).map((p) => [p, listeners(p).length ? 'LISTENING' : 'free']))
  result.finished = new Date().toISOString()
  save()
  summary()
}
process.exit(ok && !result.failures.length ? 0 : 1)

function summary() {
  const L = ['================ TURN PROOF SUMMARY ================']
  L.push(`brain ${BRAIN}  ${DEV ? 'dev' : EXE}  silent=${result.silent} capture=${result.capture}  profile ${result.profileCold ? 'COLD' : 'warm'}`)
  const i = result.initialise ?? {}
  L.push(`initialise: dormant ${i.clickToDormantMs} ms, Kokoro ${i.kokoro?.state} after ${i.kokoroClickToReadyMs} ms (loadMs ${i.kokoroLoadMs}); HUD ${JSON.stringify(i.hud)}`)
  for (const s of result.stt ?? []) L.push(`stt: ${s.ms} ms ${s.status} ${JSON.stringify(s.text)}`)
  const v = (result.diagnostics ?? []).at(-1)?.voice
  if (v) L.push(`__voice: wokeBy=${JSON.stringify(v.wokeBy)} wakes=${v.wakes} accepted=${v.accepted} dropped=${JSON.stringify(v.dropped)} lastError=${JSON.stringify(v.lastError)} engine=${v.engine}`)
  for (const t of result.turns ?? []) L.push(`turn ${t.n}: heard ${JSON.stringify(t.heard)} ask ${JSON.stringify(t.askText)} answer ${JSON.stringify(t.answer)}; stt ${t.sttMs} brain ${t.brainFirstTokenMs} tts ${t.ttsFirstAudioMs} endOfSpeech->audio ${t.endOfSpeechToFirstAudioMs} ms; spoken ${t.spokenS} s`)
  const o = result.outCapture
  if (o) L.push(`out-capture: ${o.durationS} s @ ${o.sampleRate} Hz peak ${o.peak} rms ${o.rms}; stretches ${JSON.stringify(o.stretches.map((s) => [s.startS, s.endS]))}`)
  for (const b of result.backTranscript ?? []) L.push(`back: [${b.startS}-${b.endS}] ${JSON.stringify(b.text)}`)
  L.push(`utterances (system voice): ${(result.utterances ?? []).length}; media elements ${(result.media ?? []).length}; blobs ${(result.blobs ?? []).length}`)
  L.push(`quit: ${result.quit?.method} clean=${result.quit?.clean} ports ${JSON.stringify(result.portsAfter)}`)
  if (result.failures.length) L.push('FAILURES: ' + result.failures.join(' | '))
  L.push(`result: ${OUT}/result.json`)
  console.log('\n' + L.join('\n'))
}
