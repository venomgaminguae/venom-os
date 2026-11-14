#!/usr/bin/env node
// Proof of the Venom OS desktop app (Electron shell), SILENTLY, on test ports.
// Not a node:test file on purpose (the name must not end in -test.mjs).
//
//   node scripts/app-proof.mjs [--dev] [--exe <path>] [--scratch <dir>] [--out <json>]
//                              [--only a,b,c] [--proof-dist <dir>] [--windowed]
//                              [--keep-profile] [--tray] [--data <dir>] [--page-port <n>]
//
//   --data <dir>      use <dir> as VENOM_APP_DATA (the app profile) instead of
//                     <scratch>/profile; implies --keep-profile and the folder is
//                     NEVER deleted or emptied; app.log / bridge.log are read from
//                     <dir>/logs. The JSON records dataSuppliedByCaller: true.
//   --page-port <n>   page port instead of 4198 (integer 1024-65535, not 5173,
//                     8787, the bridge port or the CDP port); the expected origin
//                     becomes http://localhost:<n>.
//
// Starts, and afterwards stops, only what it spawns:
//   the app  release/Venom OS-win32-x64/Venom OS.exe (or --exe <path>, or --dev:
//            node_modules/electron/dist/electron.exe desktop/main.mjs) with
//            --remote-debugging-port=9335 --mute-audio, VENOM_APP_SILENT=1,
//            page 4198 (or --page-port), bridge 8798, every data folder inside
//            the scratch dir (the app profile: --data if given),
//            the fake Claude CLI (scripts/fake-cli.mjs), no MCP servers.
// Refuses to start if the page port (4198), 8798 or 9335 is already listening;
// never touches 5173/8787. Aborts before any click unless the page reports
// window.__VENOM_SILENT__ === true (the static server's silence guard).
//
// Steps (--only selects; launch + attach and the clean-up always run):
//   a start            spawn -> CDP page target -> #root has children; page globals; 01-start.png
//   b gpu              navigator.gpu.requestAdapter() info
//   c bridge           /health from node (Origin http://localhost:<page port>); mic permission, getUserMedia, inputs
//   d initialise       click INITIALISE (CDP mouse), phase -> dormant, HUD mic/voice lines,
//                      __mic/__voice/__tts, Kokoro cold load (up to 120 s); 02-hud.png
//   e speak            three '#stock' questions through window.__venomAsk (only with a
//                      --proof-dist front end built with scripts/voice-proof.vite.config.mjs)
//   f keys             F11 twice (leave / re-enter full screen), Escape (phase, stays full screen)
//   g second-instance  same exe again: must exit by itself within 10 s, nothing new listens
//   h os-shots         PowerShell CopyFromScreen: 03-desktop.png (windowed, taskbar visible),
//                      04-tray.png with --tray (VENOM_APP_TRAY_POPUP=1, ~4.5 s after the window is up)
//   i quit             close the window over CDP; app, bridge, STT worker, fake CLI must all be gone
//
// Every step is tolerant: a failure is recorded with its reason and the run
// goes on to the clean-up, which is always run (finally).

import { spawn, execFile, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const WebSocket = createRequire(W + '/package.json')('ws')
const DEFAULT_PAGE_PORT = 4198
const LIVE = [5173, 8787]
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---------------------------------------------------------------- arguments
const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const fwd = (p) => path.resolve(p).replace(/\\/g, '/')
const norm0 = (p) => String(p).replace(/\/+$/, '').toLowerCase()
// --page-port N: an integer 1024-65535, never a live port (5173/8787).
const PAGE_PORT_RAW = argv.includes('--page-port') ? arg('--page-port', null) : String(DEFAULT_PAGE_PORT)
if (PAGE_PORT_RAW == null || !/^\d+$/.test(PAGE_PORT_RAW) || Number(PAGE_PORT_RAW) < 1024 || Number(PAGE_PORT_RAW) > 65535) { console.error(`--page-port must be an integer 1024-65535 (got ${JSON.stringify(PAGE_PORT_RAW)})`); process.exit(2) }
const PAGE_PORT = Number(PAGE_PORT_RAW)
if (LIVE.includes(PAGE_PORT)) { console.error(`--page-port ${PAGE_PORT} is a live port (5173/8787); refusing`); process.exit(2) }
const PORT = { page: PAGE_PORT, bridge: 8798, cdp: 9335 }
if (PORT.page === PORT.bridge || PORT.page === PORT.cdp) { console.error(`--page-port ${PAGE_PORT} clashes with the bridge (${PORT.bridge}) or CDP (${PORT.cdp}) port`); process.exit(2) }
const ORIGIN = `http://127.0.0.1:${PORT.page}`
for (const p of Object.values(PORT)) if (LIVE.includes(p)) throw new Error('live port in PORT table')
// --data DIR: a caller-supplied app profile; implies --keep-profile, never deleted.
if (argv.includes('--data') && !arg('--data', null)) { console.error('--data needs a folder'); process.exit(2) }
const DATA = arg('--data', null) ? fwd(arg('--data')) : null
const DEV = argv.includes('--dev')
const WINDOWED = argv.includes('--windowed')
const KEEP_PROFILE = argv.includes('--keep-profile') || Boolean(DATA)
// The tray menu only opens for a real mouse click (Windows closes one opened by the program at once), so there is no tray step here.
const TRAY = false
const S = fwd(arg('--scratch', path.join(os.tmpdir(), 'venom-os-app-proof')))
const OUT = fwd(arg('--out', `${S}/app-proof-result.json`))
if (DATA && (norm0(S) === norm0(DATA) || norm0(S).startsWith(norm0(DATA) + '/') || norm0(DATA).startsWith(norm0(S) + '/shots'))) { console.error(`--data ${DATA} overlaps the scratch dir ${S}; use a different --scratch`); process.exit(2) }
const KOKORO_WAIT_S = Number(arg('--kokoro-wait', 120)) // seconds; a fresh profile downloads ~311 MB
const PROOF_DIST = arg('--proof-dist', null) ? fwd(arg('--proof-dist')) : null
const STEP_NAMES = { a: 'start', b: 'gpu', c: 'bridge', d: 'initialise', e: 'speak', f: 'keys', g: 'second-instance', h: 'os-shots', i: 'quit' }
const ONLY = new Set(String(arg('--only', Object.keys(STEP_NAMES).join(','))).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))
for (const x of ONLY) if (!STEP_NAMES[x]) { console.error(`unknown step '${x}' in --only (steps: ${Object.keys(STEP_NAMES).join(',')})`); process.exit(2) }
ONLY.add('a'); ONLY.add('i') // launch/attach and the clean-up always run
const EXE = DEV ? `${W}/node_modules/electron/dist/electron.exe` : fwd(arg('--exe', `${W}/release/Venom OS-win32-x64/Venom OS.exe`))
const APP_ARGS = DEV ? [`${W}/desktop/main.mjs`] : []
const CHROMIUM_ARGS = [`--remote-debugging-port=${PORT.cdp}`, '--mute-audio']
const PROFILE = DATA ?? `${S}/profile`
const SHOTS = `${S}/shots`
const PS_DIR = `${S}/ps`
const APP_LOG = `${PROFILE}/logs/app.log`
const BRIDGE_LOG = `${PROFILE}/logs/bridge.log`
const CLI_LOG = `${S}/fake-cli.log`
const norm = (p) => String(p ?? '').replace(/\//g, '\\').toLowerCase()
const EXE_N = norm(EXE)

const T0 = Date.now()
const say = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const result = {
  started: new Date().toISOString(),
  args: { dev: DEV, exe: EXE, appArgs: APP_ARGS, chromiumArgs: CHROMIUM_ARGS, scratch: S, out: OUT, only: [...ONLY].sort(), proofDist: PROOF_DIST, windowed: WINDOWED, keepProfile: KEEP_PROFILE, tray: TRAY, pagePort: PORT.page, origin: ORIGIN, data: PROFILE, dataSuppliedByCaller: Boolean(DATA) },
  env: null, steps: {}, screenshots: [], console: [], errors: [], aborted: null,
}
const save = () => { try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2)) } catch (e) { console.error('could not save', OUT, e.message) } }

// ---------------------------------------------------------------- processes
function listeners(port) {
  try {
    return [...new Set(execFileSync('netstat', ['-ano'], { encoding: 'utf8', windowsHide: true }).split(/\r?\n/)
      .filter((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l))
      .map((l) => Number(l.trim().split(/\s+/).pop())))]
  } catch (e) { return [] }
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const spawned = [] // { role, pid, child, exited, code, signal }

function startProc(role, cmd, args, opts) {
  fs.mkdirSync(S, { recursive: true })
  const fd = fs.openSync(`${S}/${role}.log`, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', fd, fd], windowsHide: false })
  const rec = { role, pid: child.pid, child, exited: false, code: null, signal: null, spawnedAt: Date.now() }
  child.on('error', (e) => { rec.exited = true; rec.spawnError = e.message; result.errors.push(`${role} spawn: ${e.message}`) })
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
  execFile(cmd, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 60000, ...opts }, (err, stdout, stderr) => {
    if (err) { err.stdout = stdout; err.stderr = stderr; rej(err) } else res({ stdout, stderr })
  })
})

// ---------------------------------------------------------------- PowerShell helpers (script files in scratch)
const PS = {
  procs: String.raw`$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$list = Get-CimInstance Win32_Process | ForEach-Object {
  [pscustomobject]@{
    pid = [int]$_.ProcessId
    ppid = [int]$_.ParentProcessId
    name = $_.Name
    exe = $_.ExecutablePath
    cmd = $_.CommandLine
    created = $(if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' })
  }
}
ConvertTo-Json -InputObject @($list) -Compress -Depth 3
`,
  shot: String.raw`param([string]$Out)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
try { Add-Type -Namespace VenomProof -Name Dpi -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();'; [void][VenomProof.Dpi]::SetProcessDPIAware() } catch { }
$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$f = Get-Item -LiteralPath $Out
@{ width = $b.Width; height = $b.Height; bytes = $f.Length } | ConvertTo-Json -Compress
`,
  keys: String.raw`param([string]$Keys)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.SendKeys]::SendWait($Keys)
'sent'
`,
}
function psFile(name) {
  fs.mkdirSync(PS_DIR, { recursive: true })
  const f = `${PS_DIR}/${name}.ps1`
  fs.writeFileSync(f, PS[name])
  return f.replace(/\//g, '\\')
}
async function ps(name, args = [], timeout = 60000) {
  const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile(name), ...args], { timeout })
  return stdout.trim()
}
async function psList() {
  const out = await ps('procs', [], 90000)
  const list = JSON.parse(out.slice(out.indexOf('[')))
  return list.map((p) => ({ ...p, exeN: norm(p.exe), cmdN: norm(p.cmd) }))
}
async function osShot(file) {
  const out = await ps('shot', [file.replace(/\//g, '\\')], 60000)
  const info = JSON.parse(out.slice(out.indexOf('{')))
  result.screenshots.push(file)
  return { file, ...info, note: 'a locked or sleeping display gives a black (small) image; compare bytes' }
}

// Every process this run started, and their descendants: pid -> creation time.
const known = new Map()
const ts = (x) => Date.parse(x) || 0
async function snapshot(label) {
  try {
    const list = await psList()
    const roots = spawned.map((r) => r.pid)
    for (const pid of [...listeners(PORT.bridge), ...listeners(PORT.page), ...listeners(PORT.cdp)]) if (!roots.includes(pid)) roots.push(pid)
    let added = true
    for (const pid of roots) { const p = list.find((x) => x.pid === pid); if (p && !known.has(pid)) known.set(pid, p.created) }
    while (added) {
      added = false
      for (const p of list) if (!known.has(p.pid) && known.has(p.ppid) && ts(p.created) >= ts(known.get(p.ppid))) { known.set(p.pid, p.created); added = true }
    }
    const ours = list.filter((p) => known.get(p.pid) === p.created)
    result.processTree = result.processTree || {}
    result.processTree[label] = ours.map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, cmd: String(p.cmd ?? '').slice(0, 200) }))
    return list
  } catch (e) {
    result.errors.push(`process snapshot ${label}: ${e.message}`)
    return null
  }
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

// ---------------------------------------------------------------- CDP
class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = []
    ws.on('message', (raw) => {
      let m
      try { m = JSON.parse(raw) } catch { return }
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id)
        m.error ? rej(new Error(`${m.error.message}`)) : res(m.result)
      } else if (m.method) for (const h of this.handlers) { try { h(m) } catch {} }
    })
    ws.on('close', () => { this.closed = true; for (const { rej } of this.pending.values()) rej(new Error('socket closed')); this.pending.clear() })
    ws.on('error', () => {})
  }
  static async open(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
    return new Cdp(ws)
  }
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

async function cdpShot(c, name) {
  const file = `${SHOTS}/${name}`
  fs.mkdirSync(SHOTS, { recursive: true })
  const shot = await c.send('Page.captureScreenshot', { format: 'png' }, 30000)
  fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
  result.screenshots.push(file)
  return file
}
async function key(c, name) {
  const K = { F11: { key: 'F11', code: 'F11', windowsVirtualKeyCode: 122, nativeVirtualKeyCode: 122 }, Escape: { key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 } }[name]
  await c.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...K })
  await c.send('Input.dispatchKeyEvent', { type: 'keyUp', ...K })
}
const FS_EXPR = `({ innerWidth, innerHeight, outerWidth, outerHeight, screenW: screen.width, screenH: screen.height, displayFullscreen: matchMedia('(display-mode: fullscreen)').matches, fullscreenElement: !!document.fullscreenElement, phase: (window.__venom ? window.__venom.phase : (document.querySelector(".hud") ? document.querySelector(".hud").getAttribute("data-phase") : "offline")) })`
const looksFull = (s) => Boolean(s && (s.displayFullscreen || (s.innerHeight >= s.screenH && s.innerWidth >= s.screenW)))

// Output tap, installed at run time (no reload, so the static server's silence
// guard stays exactly as served): an AnalyserNode in parallel on every
// AudioContext destination (it feeds the destination through a zero gain, so
// it adds silence only), and a record per media element (when it played, the
// loudest output RMS while it played). It never unmutes anything.
const TAP = String.raw`(() => {
  if (window.__appProof) return 'already'
  const P = window.__appProof = { media: [], out: { cur: 0, max: 0 }, taps: 0, installedAt: Date.now(), tapError: null }
  const origConnect = AudioNode.prototype.connect
  AudioNode.prototype.connect = function (dest, ...rest) {
    try {
      if (dest instanceof AudioDestinationNode) {
        const ctx = dest.context
        if (!ctx.__appProofTap) {
          const an = ctx.createAnalyser(); an.fftSize = 2048
          const z = ctx.createGain(); z.gain.value = 0
          origConnect.call(an, z); origConnect.call(z, dest)
          const buf = new Float32Array(an.fftSize)
          setInterval(() => {
            an.getFloatTimeDomainData(buf)
            let s = 0; for (let i = 0; i < buf.length; i++) s += buf[i] * buf[i]
            const rms = Math.sqrt(s / buf.length)
            if (rms > P.out.cur) P.out.cur = rms
            if (rms > P.out.max) P.out.max = rms
          }, 40)
          ctx.__appProofTap = an
          P.taps++
        }
        origConnect.call(this, ctx.__appProofTap, rest[0] || 0)
      }
    } catch (e) { P.tapError = String(e) }
    return origConnect.call(this, dest, ...rest)
  }
  P.connectWrapped = AudioNode.prototype.connect !== origConnect
  const mp = HTMLMediaElement.prototype
  const play = mp.play
  const seen = new WeakSet()
  const wrapped = function () {
    try {
      if (!seen.has(this)) {
        seen.add(this)
        const tts = window.__tts || {}
        const rec = { src: String(this.src).slice(0, 60), text: tts.lastText || null, engine: tts.engine || null, play: Date.now(), playing: null, ended: null, outRms: null, mutedAtPlaying: null, volumeAtPlaying: null }
        P.media.push(rec)
        const endTap = () => { if (rec.outRms == null && rec.playing != null) rec.outRms = +P.out.cur.toFixed(4) }
        this.addEventListener('playing', () => { if (rec.playing == null) { rec.playing = Date.now(); P.out.cur = 0 } rec.mutedAtPlaying = this.muted; rec.volumeAtPlaying = this.volume })
        this.addEventListener('ended', () => { endTap(); if (rec.ended == null) rec.ended = Date.now() })
        this.addEventListener('pause', () => { endTap(); if (rec.ended == null) rec.ended = Date.now() })
      }
    } catch (e) {}
    return play.apply(this, arguments)
  }
  try { mp.play = wrapped } catch (e) {}
  P.playWrapped = mp.play === wrapped
  return 'installed'
})()`

// ---------------------------------------------------------------- run state
const S_ = { app: null, c: null, browser: null, targetId: null, frames: [], net: new Map(), abort: null, rootAt: null, targetAt: null }

function attachHandlers(c) {
  c.on((m) => {
    const p = m.params
    if (m.method === 'Network.webSocketFrameReceived') {
      try { const j = JSON.parse(p.response.payloadData); if (j && j.type && j.type !== 'diag') S_.frames.push({ t: Date.now(), type: j.type }) } catch {}
    } else if (m.method === 'Network.requestWillBeSent') S_.net.set(p.requestId, { url: p.request.url })
    else if (m.method === 'Network.loadingFinished') { const r = S_.net.get(p.requestId); if (r) r.bytes = p.encodedDataLength }
    else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) result.console.push(`${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
    else if (m.method === 'Runtime.exceptionThrown') result.console.push('exception: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300))
  })
}
const hfBytes = () => [...S_.net.values()].filter((r) => /huggingface\.co|hf\.co|xethub/i.test(r.url)).reduce((a, r) => a + (r.bytes || 0), 0)
const mb = (b) => +(b / 1048576).toFixed(1)

function appEnv() {
  for (const d of ['home', 'memory', 'hermes-memory', 'workspace', 'agents']) fs.mkdirSync(`${S}/${d}`, { recursive: true })
  if (!fs.existsSync(`${S}/hermes-memory/MEMORY.md`)) fs.writeFileSync(`${S}/hermes-memory/MEMORY.md`, '')
  const env = { ...process.env }
  // Anything that would change how the app runs, from the caller's shell.
  for (const k of ['ELECTRON_RUN_AS_NODE', 'VENOM_WINDOWED', 'VENOM_APP_TRAY_POPUP', 'VENOM_APP_DIST', 'VENOM_APP_NODE', 'VENOM_BRIDGE_PORT', 'VENOM_ALLOWED_ORIGINS', 'VENOM_ALLOW_NO_ORIGIN']) delete env[k]
  Object.assign(env, {
    VENOM_APP_SILENT: '1',
    VENOM_APP_DATA: PROFILE,
    VENOM_APP_PORT: String(PORT.page),
    VENOM_APP_BRIDGE_PORT: String(PORT.bridge),
    // As voice-proof: the bridge's homedir() follows USERPROFILE, so no
    // ~/.claude.json (no ElevenLabs key, no MCP servers) and no ~/.venom.
    USERPROFILE: `${S}/home`, HOME: `${S}/home`,
    ELEVENLABS_API_KEY: '',
    VENOM_CLAUDE_EXECUTABLE: `${W}/scripts/fake-cli.mjs`,
    FAKE_CLI_LOG: CLI_LOG,
    VENOM_MCP_SERVERS: '',
    VENOM_DISABLE: 'browser,camera',
    VENOM_AGENT_ACTIVITY: '0',
    VENOM_AGENTS_DIR: `${S}/agents`,
    VENOM_WORKSPACE: `${S}/workspace`,
    VENOM_MEMORY: '1',
    VENOM_MEMORY_DIR: `${S}/memory`,
    VENOM_HERMES_MEMORY_DIR: `${S}/hermes-memory`,
    VENOM_HONCHO: '0',
    VENOM_STT_MODEL_DIR: `${W}/desktop/models`,
  })
  if (WINDOWED) env.VENOM_WINDOWED = '1'
  if (TRAY) env.VENOM_APP_TRAY_POPUP = '1'
  if (PROOF_DIST) env.VENOM_APP_DIST = PROOF_DIST
  if (env.VENOM_APP_SILENT !== '1') throw new Error('VENOM_APP_SILENT is not 1; refusing to start the app')
  if (!CHROMIUM_ARGS.includes('--mute-audio')) throw new Error('no --mute-audio; refusing to start the app')
  return env
}
let ENV = null

function readFrom(file, offset = 0) {
  try { const b = fs.readFileSync(file); return b.subarray(Math.min(offset, b.length)).toString('utf8') } catch { return '' }
}
const fileSize = (f) => { try { return fs.statSync(f).size } catch { return 0 } }
const tail = (f, n = 15) => readFrom(f).split(/\r?\n/).filter(Boolean).slice(-n)

/** The page's diagnostics, as the bridge logs them: `[venom] voice {"tts":{...},...}`. */
function bridgeTts(fromOffset = 0) {
  const lines = readFrom(BRIDGE_LOG, fromOffset).split(/\r?\n/).filter((l) => l.includes('[venom] voice '))
  const out = []
  for (const l of lines) {
    const raw = l.slice(l.indexOf('[venom] voice ') + 14)
    let tts = null
    try { tts = JSON.parse(raw).tts ?? null } catch {
      const m = raw.match(/"tts":(\{[^{}]*\})/)
      if (m) try { tts = JSON.parse(m[1]) } catch {}
    }
    if (tts) out.push(tts)
  }
  return { lines: lines.length, states: [...new Set(out.map((t) => t.k).filter(Boolean))], engines: [...new Set(out.map((t) => t.e).filter(Boolean))], last: out.at(-1) ?? null }
}

// ---------------------------------------------------------------- steps
async function runStep(letter, fn) {
  const name = STEP_NAMES[letter]
  if (!ONLY.has(letter)) { result.steps[letter] = { name, status: 'not selected' }; return }
  if (S_.abort && letter !== 'i') { result.steps[letter] = { name, status: 'skipped', reason: 'run aborted: ' + S_.abort }; save(); return }
  const r = result.steps[letter] = { name, status: 'running', failures: [] }
  const t = Date.now()
  say(`step ${letter} ${name}`)
  try {
    await fn(r)
    if (r.status === 'running') r.status = r.failures.length ? 'failed' : 'ok'
  } catch (e) {
    r.status = 'failed'
    r.error = String(e?.message ?? e)
    r.failures.push(r.error)
    say(`step ${letter} FAILED: ${r.error}`)
  }
  r.stepMs = Date.now() - t
  say(`step ${letter} ${name}: ${r.status}${r.failures.length ? ' (' + r.failures.join('; ').slice(0, 300) + ')' : ''}`)
  save()
}

async function stepStart(r) {
  if (!fs.existsSync(EXE)) throw new Error(`app executable not found: ${EXE}${DEV ? '' : ' (build it with scripts/build-app.mjs, or use --dev / --exe)'}`)
  if (DEV && !fs.existsSync(APP_ARGS[0])) throw new Error('desktop/main.mjs not found')
  if (PROOF_DIST && !fs.existsSync(`${PROOF_DIST}/index.html`)) r.failures.push(`--proof-dist ${PROOF_DIST} has no index.html`)
  ENV = appEnv()
  result.env = Object.fromEntries(Object.entries(ENV).filter(([k]) => /^(VENOM_|FAKE_CLI|USERPROFILE$|HOME$|ELEVENLABS)/.test(k)))
  const t0 = Date.now()
  S_.app = startProc('app', EXE, [...APP_ARGS, ...CHROMIUM_ARGS], { cwd: W, env: ENV })
  r.pid = S_.app.pid
  const appDead = () => S_.app.exited ? { stop: true, info: `app exited code ${S_.app.code} signal ${S_.app.signal}${S_.app.spawnError ? ' ' + S_.app.spawnError : ''}; app.log: ${tail(APP_LOG, 6).join(' | ')}` } : null
  const target = await waitFor('CDP page target', async () => {
    const d = appDead(); if (d) return d
    const t = (await cdpJson('/json')).find((x) => x.type === 'page' && isAppUrl(x.url))
    return { ok: Boolean(t), t, info: 'no page target on the app origin yet' }
  }, 90000, 200)
  S_.targetAt = Date.now()
  r.spawnToTargetMs = S_.targetAt - t0
  S_.targetId = target.t.id
  r.targetUrl = target.t.url
  S_.c = await Cdp.open(target.t.webSocketDebuggerUrl)
  attachHandlers(S_.c)
  for (const m of ['Runtime.enable', 'Page.enable', 'Network.enable']) await S_.c.send(m).catch((e) => r.failures.push(`${m}: ${e.message}`))
  try {
    const v = await cdpJson('/json/version')
    r.browserVersion = v.Browser
    S_.browser = await Cdp.open(v.webSocketDebuggerUrl)
  } catch (e) { r.browserSocket = 'failed: ' + e.message }
  await waitFor('#root children', async () => {
    const d = appDead(); if (d) return d
    const n = await ev(S_.c, `(document.querySelector('#root') || { children: [] }).children.length`, 5000)
    return { ok: n > 0, info: `#root children ${n}` }
  }, 60000, 100)
  S_.rootAt = Date.now()
  r.spawnToRootMs = S_.rootAt - t0
  r.page = await ev(S_.c, `(() => ({
    desktop: window.__VENOM_DESKTOP__ ? JSON.parse(JSON.stringify(window.__VENOM_DESKTOP__)) : null,
    desktopFrozen: window.__VENOM_DESKTOP__ ? Object.isFrozen(window.__VENOM_DESKTOP__) : null,
    silent: window.__VENOM_SILENT__,
    origin: location.origin, href: location.href, title: document.title, userAgent: navigator.userAgent,
    displayFullscreen: matchMedia('(display-mode: fullscreen)').matches,
    innerWidth, innerHeight, screenW: screen.width, screenH: screen.height, devicePixelRatio,
    speakNative: typeof speechSynthesis !== 'undefined' ? /\\[native code\\]/.test(String(speechSynthesis.speak)) : null,
    playNative: /\\[native code\\]/.test(String(HTMLMediaElement.prototype.play)),
    initialiseButton: [...document.querySelectorAll('button')].some((b) => /INITIALI[SZ]E/i.test(b.textContent || '')),
    phase: (window.__venom ? window.__venom.phase : (document.querySelector(".hud") ? document.querySelector(".hud").getAttribute("data-phase") : "offline")),
    askHook: typeof window.__venomAsk,
  }))()`)
  say('page', JSON.stringify(r.page))
  if (r.page.silent !== true) {
    S_.abort = `window.__VENOM_SILENT__ is ${JSON.stringify(r.page.silent)}, not true: the silence guard is not installed; nothing is clicked`
    r.failures.push(S_.abort)
  }
  if (r.page.desktop?.wakeRoute !== 'local') r.failures.push(`__VENOM_DESKTOP__.wakeRoute is ${r.page.desktop?.wakeRoute}`)
  if (!String(r.page.desktop?.bridgeUrl ?? '').includes(`:${PORT.bridge}`)) r.failures.push(`__VENOM_DESKTOP__.bridgeUrl is ${r.page.desktop?.bridgeUrl}`)
  if (!r.page.initialiseButton) r.failures.push('no INITIALISE button on the start screen')
  if (!WINDOWED && !looksFull(r.page)) r.failures.push('window does not look full screen')
  try { r.screenshot = await cdpShot(S_.c, '01-start.png') } catch (e) { r.failures.push('screenshot: ' + e.message) }
  r.listeners = { page: listeners(PORT.page), bridge: listeners(PORT.bridge), cdp: listeners(PORT.cdp) }
  r.appLog = tail(APP_LOG, 20)
  await snapshot('after start')
}

// --tray: the app pops its tray menu 3 s after the window shows. The window
// shows on ready-to-show (about when #root first has children), so the shot
// is taken about 4.5 s after that, then the menu is closed with Escape.
async function trayShot() {
  const r = result.steps.h = result.steps.h || { name: STEP_NAMES.h, status: 'running', failures: [] }
  try {
    // Wait for the app's own log line, then give the menu a moment to draw.
    const until = Date.now() + 60000
    while (Date.now() < until && !readFrom(APP_LOG).includes('tray popup (test hook)')) await sleep(100)
    await sleep(700)
    r.tray = { msAfterRoot: Date.now() - (S_.rootAt ?? Date.now()), ...(await osShot(`${SHOTS}/04-tray.png`)) }
    r.tray.appLogTray = readFrom(APP_LOG).split(/\r?\n/).filter((l) => /tray/i.test(l)).slice(-5)
    // No key is sent to close it (a key would go to whatever window has the focus): the app closes its own menu after 2.5 s.
    await sleep(2500)
    say('tray shot', JSON.stringify(r.tray))
  } catch (e) { r.failures.push('tray shot: ' + e.message) }
  save()
}

async function stepGpu(r) {
  r.adapter = await ev(S_.c, `(async () => {
    if (!navigator.gpu) return 'no navigator.gpu'
    const a = await navigator.gpu.requestAdapter()
    if (!a) return 'no adapter'
    const i = a.info || {}
    return { vendor: i.vendor, architecture: i.architecture, device: i.device, description: i.description, isFallbackAdapter: i.isFallbackAdapter ?? a.isFallbackAdapter ?? null, features: [...a.features].length }
  })()`, 30000)
  if (typeof r.adapter === 'string') r.failures.push(r.adapter)
}

function getJson(url, headers) {
  return new Promise((res, rej) => {
    const req = http.get(url, { headers, timeout: 10000 }, (resp) => {
      let body = ''
      resp.setEncoding('utf8')
      resp.on('data', (d) => { body += d })
      resp.on('end', () => { try { res({ status: resp.statusCode, headers: resp.headers, json: JSON.parse(body) }) } catch { res({ status: resp.statusCode, headers: resp.headers, text: body.slice(0, 300) }) } })
    })
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', rej)
  })
}

async function stepBridge(r) {
  const h = await getJson(`http://127.0.0.1:${PORT.bridge}/health`, { Origin: ORIGIN })
  r.health = h.json ?? h.text
  r.healthStatus = h.status
  r.allowOrigin = h.headers['access-control-allow-origin'] ?? null
  if (h.json?.sttEngine !== 'local') r.failures.push(`/health sttEngine is ${h.json?.sttEngine}, not 'local'`)
  if (h.json?.tts) r.failures.push('bridge reports an ElevenLabs voice (tts: true)')
  r.listeners = { bridge: listeners(PORT.bridge), page: listeners(PORT.page) }
  r.permissions = await ev(S_.c, `(async () => {
    const out = {}
    try { out.microphone = (await navigator.permissions.query({ name: 'microphone' })).state } catch (e) { out.microphone = 'query failed: ' + e.message }
    const t = performance.now()
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      const tr = s.getAudioTracks()[0]
      out.getUserMedia = { ok: true, label: tr ? tr.label : null, ms: Math.round(performance.now() - t) }
      s.getTracks().forEach((x) => x.stop())
    } catch (e) { out.getUserMedia = { ok: false, error: e.name + ': ' + e.message, ms: Math.round(performance.now() - t) } }
    try { out.microphoneAfter = (await navigator.permissions.query({ name: 'microphone' })).state } catch (e) {}
    try { out.inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput').map((d) => d.label || '(no label)') } catch (e) { out.inputs = 'failed: ' + e.message }
    return out
  })()`, 20000)
  if (!r.permissions.getUserMedia?.ok) r.failures.push('getUserMedia failed: ' + r.permissions.getUserMedia?.error)
  if (r.permissions.microphone !== 'granted' && r.permissions.microphoneAfter !== 'granted') r.notes = [`permissions.query microphone = ${r.permissions.microphone}/${r.permissions.microphoneAfter} (Electron answers this through the permission CHECK handler)`]
}

const KOKORO_EXPR = `(() => { const t = window.__tts; if (!t) return null; try { return JSON.parse(JSON.stringify(t.kokoro || null)) } catch (e) { return { error: String(e) } } })()`

async function stepInitialise(r) {
  const silent = await ev(S_.c, 'window.__VENOM_SILENT__')
  if (silent !== true) { S_.abort = '__VENOM_SILENT__ not true before INITIALISE'; throw new Error(S_.abort) }
  try { r.tap = await ev(S_.c, TAP); r.tapState = await ev(S_.c, `({ connectWrapped: window.__appProof.connectWrapped, playWrapped: window.__appProof.playWrapped })`) } catch (e) { r.tap = 'failed: ' + e.message }
  const bridgeLogOffset = fileSize(BRIDGE_LOG)
  const rect = await waitFor('INITIALISE button', async () => {
    const b = await ev(S_.c, `(() => { const b = [...document.querySelectorAll('button')].find((b) => /INITIALI[SZ]E/i.test(b.textContent || '')); if (!b) return null; b.scrollIntoView({ block: 'center' }); const q = b.getBoundingClientRect(); return { x: q.x + q.width / 2, y: q.y + q.height / 2, w: q.width, h: q.height } })()`)
    return { ok: Boolean(b && b.w > 0), b, info: JSON.stringify(b) }
  }, 15000)
  r.phaseBefore = await ev(S_.c, '(window.__venom ? window.__venom.phase : (document.querySelector(".hud") ? document.querySelector(".hud").getAttribute("data-phase") : "offline"))')
  const { x, y } = rect.b
  await S_.c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
  await S_.c.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 })
  await S_.c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 })
  const tClick = Date.now()
  S_.tClick = tClick
  let kokoroReadyAt = null
  const phases = []
  const st = await waitFor('phase dormant', async () => {
    const s = await ev(S_.c, `({ phase: (window.__venom ? window.__venom.phase : (document.querySelector(".hud") ? document.querySelector(".hud").getAttribute("data-phase") : "offline")), k: ${KOKORO_EXPR} })`, 5000)
    if (phases.at(-1) !== s.phase) phases.push(s.phase)
    if (s.k?.state === 'ready' && kokoroReadyAt == null) kokoroReadyAt = Date.now() - tClick
    return { ok: s.phase === 'dormant', info: `phase ${s.phase}` }
  }, 60000, 100)
  void st
  r.clickToDormantMs = Date.now() - tClick
  r.phases = phases
  await sleep(1500) // the HUD lines settle
  r.hud = await ev(S_.c, `(() => {
    const lines = (document.body.innerText || '').split(/\\n/).map((s) => s.trim())
    const q = (s) => document.querySelector(s)
    return {
      micLine: lines.find((l) => l.startsWith('mic ·')) || null,
      voiceLine: lines.find((l) => l.startsWith('voice ·')) || null,
      micStatus: q('.mic-status') ? q('.mic-status').textContent : null,
      voiceStatus: q('.voice-status') ? q('.voice-status').textContent : null,
      voiceClass: q('.voice-status') ? q('.voice-status').className : null,
      banner: q('.error') ? q('.error').textContent : null,
    }
  })()`)
  r.mic = await ev(S_.c, `(async () => {
    const m = window.__mic
    if (!m) return 'window.__mic not present'
    const v = []
    for (let i = 0; i < 20; i++) { const x = Number(m.rms); if (Number.isFinite(x)) v.push(x); await new Promise((r) => setTimeout(r, 100)) }
    return { state: m.state, label: m.label, why: m.why, note: m.note, error: m.error, contextState: m.contextState, inputs: (m.inputs || []).map((i) => i.label), rms: m.rms, peak: m.peak,
      rms2s: v.length ? { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(5), max: +Math.max(...v).toFixed(5) } : null }
  })()`)
  r.voice = await ev(S_.c, `(() => { const v = window.__voice; if (!v) return 'window.__voice not present'; return { engine: v.engine, wakeRoute: v.wakeRoute, running: v.running, mode: v.mode, lastError: v.lastError, dropped: v.dropped, wakes: v.wakes } })()`)
  if (typeof r.voice === 'object') {
    if (r.voice.wakeRoute !== 'local') r.failures.push(`__voice.wakeRoute is ${r.voice.wakeRoute}`)
    if (r.voice.engine !== 'local') r.failures.push(`__voice.engine is ${r.voice.engine}`)
    if (!r.voice.running) r.failures.push('__voice.running is false')
  } else r.failures.push(r.voice)
  if (!r.hud.micLine) r.failures.push('no HUD line starting with "mic ·"')
  if (!r.hud.voiceLine) r.failures.push('no HUD line starting with "voice ·"')
  // Kokoro: up to 120 s after dormant (a fresh profile downloads ~311 MB).
  let k = null
  const kEnd = Date.now() + KOKORO_WAIT_S * 1000
  for (;;) {
    try { k = await ev(S_.c, KOKORO_EXPR, 5000) } catch (e) { k = { error: e.message } }
    if (k?.state === 'ready' && kokoroReadyAt == null) kokoroReadyAt = Date.now() - tClick
    if (['ready', 'failed', 'off'].includes(k?.state) || Date.now() > kEnd) break
    await sleep(250)
  }
  r.kokoro = k
  r.kokoroClickToReadyMs = kokoroReadyAt
  r.kokoroLoadMs = k?.loadMs ?? null
  r.kokoroColdProfile = !result.profileReused
  r.huggingfaceBytesSeenByPage = hfBytes()
  r.huggingfaceNote = 'only requests made by the page itself; a model fetched inside a worker is not seen here'
  if (k?.state !== 'ready') r.failures.push(`Kokoro not ready ${KOKORO_WAIT_S} s after dormant: ${JSON.stringify(k).slice(0, 200)}`)
  await sleep(1200)
  r.hudAfterKokoro = await ev(S_.c, `(() => { const l = (document.body.innerText || '').split(/\\n/).map((s) => s.trim()); return { micLine: l.find((x) => x.startsWith('mic ·')) || null, voiceLine: l.find((x) => x.startsWith('voice ·')) || null } })()`)
  if (k?.state === 'ready' && !/Kokoro natural/.test(r.hudAfterKokoro.voiceLine ?? '')) r.failures.push(`voice line after Kokoro ready: ${r.hudAfterKokoro.voiceLine}`)
  r.tts = await ev(S_.c, `(() => { const t = window.__tts; if (!t) return null; return { engine: t.engine, voice: t.voice, spoken: t.spoken, started: t.started, silent: t.silent, alarm: t.alarm, why: t.why, systemVoice: t.systemVoice } })()`)
  r.bridgeLogTts = bridgeTts(bridgeLogOffset)
  try { r.screenshot = await cdpShot(S_.c, '02-hud.png') } catch (e) { r.failures.push('screenshot: ' + e.message) }
  await snapshot('after initialise')
}

async function ask(text, timeout = 90000) {
  const c = S_.c
  const before = await ev(c, `({ now: Date.now(), media: window.__appProof ? window.__appProof.media.length : 0, phase: (window.__venom ? window.__venom.phase : (document.querySelector(".hud") ? document.querySelector(".hud").getAttribute("data-phase") : "offline")) })`)
  const f0 = S_.frames.length
  await ev(c, `window.__venomAsk(${JSON.stringify(text)})`)
  const end = Date.now() + timeout
  let left = false, st = null, doneAt = null
  for (;;) {
    st = await ev(c, `({ phase: (window.__venom ? window.__venom.phase : (document.querySelector(".hud") ? document.querySelector(".hud").getAttribute("data-phase") : "offline")), logN: ((window.__tts && window.__tts.log) || []).filter((e) => e.at >= ${before.now}).length, playing: window.__appProof ? window.__appProof.media.slice(${before.media}).some((m) => m.ended == null) : false })`, 5000)
    if (!['listening', 'dormant'].includes(st.phase)) left = true
    const frameDone = S_.frames.slice(f0).some((f) => f.type === 'done' || f.type === 'error')
    const settled = ['listening', 'dormant'].includes(st.phase) && !st.playing && (frameDone || (left && st.logN > 0))
    if (settled) { doneAt ??= Date.now(); if (Date.now() - doneAt > 1200) break } else doneAt = null
    if (Date.now() > end) break
    await sleep(150)
  }
  const d = await ev(c, `(() => ({
    log: JSON.parse(JSON.stringify(((window.__tts && window.__tts.log) || []).filter((e) => e.at >= ${before.now}))),
    media: window.__appProof ? window.__appProof.media.slice(${before.media}).filter((m) => m.src.startsWith('blob:')) : [],
    out: window.__appProof ? { ...window.__appProof.out } : null,
    tts: (() => { const t = window.__tts || {}; return { silent: t.silent, alarm: t.alarm, why: t.why } })(),
  }))()`)
  const nrm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
  const used = new Set()
  const rows = d.log.map((e) => {
    const t = nrm(e.text)
    const i = d.media.findIndex((m, j) => !used.has(j) && m.text && (nrm(m.text) === t || t.startsWith(nrm(m.text)) || nrm(m.text).startsWith(t)))
    if (i >= 0) used.add(i)
    const m = i >= 0 ? d.media[i] : null
    return { text: e.text, engine: e.engine, voice: e.voice, started: e.started, appRms: e.rms, why: e.why, tapOutRms: m ? m.outRms : null, mutedAtPlaying: m ? m.mutedAtPlaying : null, volumeAtPlaying: m ? m.volumeAtPlaying : null }
  })
  d.media.forEach((m, j) => { if (!used.has(j)) rows.push({ text: m.text, engine: m.engine, voice: null, started: m.playing != null, appRms: null, tapOutRms: m.outRms, onlyInTap: true }) })
  return { question: text, timedOut: Date.now() > end, phaseAfter: st?.phase, framesDone: S_.frames.slice(f0).filter((f) => f.type === 'done').length, sentences: rows, tts: d.tts, outMax: d.out?.max ?? null }
}

async function stepSpeak(r) {
  const hook = await ev(S_.c, 'typeof window.__venomAsk')
  if (hook !== 'function') { r.status = 'skipped'; r.reason = 'skipped: production build has no __venomAsk (pass --proof-dist <dir built with scripts/voice-proof.vite.config.mjs>)'; return }
  if (await ev(S_.c, 'window.__VENOM_SILENT__') !== true) { S_.abort = '__VENOM_SILENT__ not true before speaking'; throw new Error(S_.abort) }
  if (!(await ev(S_.c, '!!window.__appProof'))) r.tap = await ev(S_.c, TAP)
  const off = fileSize(BRIDGE_LOG)
  r.answers = []
  for (let i = 1; i <= 3; i++) {
    const a = await ask(`Is the RTX 5090 in stock? #stock app ${i}`)
    r.answers.push(a)
    say(`answer ${i}: ${a.sentences.map((x) => `${x.engine} started=${x.started} app ${x.appRms} tap ${x.tapOutRms}`).join(' | ')}${a.timedOut ? ' (TIMED OUT)' : ''}`)
    if (a.timedOut) r.failures.push(`answer ${i} timed out`)
    if (!a.sentences.length) r.failures.push(`answer ${i}: no sentence recorded`)
    for (const s of a.sentences) if (s.engine !== 'kokoro') r.failures.push(`answer ${i} "${String(s.text).slice(0, 40)}": engine ${s.engine} (${s.why})`)
    save()
  }
  r.levelNote = 'the app runs muted (Chromium --mute-audio and the silence guard forces every media element muted); tapOutRms is the AnalyserNode on the AudioContext destination, appRms the app\'s own __tts.log rms. Zero levels with started=true mean the guard\'s muted element feeds silence into the graph.'
  r.bridgeLogTts = bridgeTts(off)
  r.fakeCliLines = readFrom(CLI_LOG).split(/\r?\n/).filter(Boolean).length
}

async function stepKeys(r) {
  const c = S_.c
  r.before = await ev(c, FS_EXPR)
  await key(c, 'F11'); await sleep(1500)
  r.afterF11 = await ev(c, FS_EXPR)
  await key(c, 'F11'); await sleep(1500)
  r.afterSecondF11 = await ev(c, FS_EXPR)
  r.f11Toggled = looksFull(r.before) !== looksFull(r.afterF11) || r.before.innerHeight !== r.afterF11.innerHeight
  r.f11Restored = looksFull(r.before) === looksFull(r.afterSecondF11) && r.before.innerHeight === r.afterSecondF11.innerHeight
  if (!r.f11Toggled) r.failures.push('F11 did not change the window (full screen / size unchanged)')
  if (!r.f11Restored) r.failures.push('second F11 did not restore the window')
  r.beforeEsc = await ev(c, FS_EXPR)
  await key(c, 'Escape'); await sleep(1200)
  r.afterEsc = await ev(c, FS_EXPR)
  r.escKeptWindow = looksFull(r.beforeEsc) === looksFull(r.afterEsc) && r.beforeEsc.innerHeight === r.afterEsc.innerHeight
  r.escPhase = `${r.beforeEsc.phase} -> ${r.afterEsc.phase}`
  r.appAlive = !S_.app.exited
  if (!r.escKeptWindow) r.failures.push('Escape changed the window size / left full screen')
  if (!r.appAlive) r.failures.push('the app exited after Escape')
  if (r.beforeEsc.phase !== 'offline' && r.afterEsc.phase !== 'dormant') r.failures.push(`phase after Escape is ${r.afterEsc.phase}, expected dormant`)
  r.appLogF11 = readFrom(APP_LOG).split(/\r?\n/).filter((l) => /F11|full screen/i.test(l)).slice(-6)
}

async function stepSecond(r) {
  const before = { bridge: listeners(PORT.bridge), page: listeners(PORT.page) }
  r.before = before
  const off = fileSize(APP_LOG)
  // No --remote-debugging-port: the port belongs to the first instance.
  const rec = startProc('second', EXE, [...APP_ARGS, '--mute-audio'], { cwd: W, env: ENV })
  const t = Date.now()
  while (!rec.exited && Date.now() - t < 10000) await sleep(100)
  r.exited = rec.exited
  r.exitMs = rec.exited ? (rec.exitedAt ?? Date.now()) - t : null
  r.exitCode = rec.code
  if (!rec.exited) {
    r.failures.push('second instance still running after 10 s')
    await snapshot('second instance stuck')
    const list = await psList().catch(() => null)
    const kids = list ? list.filter((p) => p.ppid === rec.pid && isOurs(p, list)).map((p) => p.pid) : []
    for (const pid of [...kids, rec.pid]) try { process.kill(pid) } catch {}
    await sleep(1000)
    r.killed = { pid: rec.pid, children: kids, alive: alive(rec.pid) }
  }
  await sleep(1500)
  r.after = { bridge: listeners(PORT.bridge), page: listeners(PORT.page) }
  if (r.after.bridge.length !== 1) r.failures.push(`${r.after.bridge.length} processes listen on ${PORT.bridge}`)
  if (r.after.page.length !== 1) r.failures.push(`${r.after.page.length} processes listen on ${PORT.page}`)
  if (JSON.stringify(r.after) !== JSON.stringify(before)) r.failures.push(`listeners changed: ${JSON.stringify(before)} -> ${JSON.stringify(r.after)}`)
  r.firstStillAlive = !S_.app.exited
  if (!r.firstStillAlive) r.failures.push('the first instance exited')
  const newLines = readFrom(APP_LOG, off).split(/\r?\n/).filter(Boolean)
  r.appLogNew = newLines.slice(-10)
  r.secondInstanceLine = newLines.find((l) => /second|another instance/i.test(l)) ?? null
  if (!r.secondInstanceLine) r.failures.push('no second-instance line in app.log')
}

async function stepOsShots(r) {
  const c = S_.c
  const st = await ev(c, FS_EXPR)
  r.wasFull = looksFull(st)
  if (r.wasFull) { await key(c, 'F11'); await sleep(2000) }
  r.windowedState = await ev(c, FS_EXPR)
  if (looksFull(r.windowedState)) r.failures.push('could not leave full screen for the taskbar shot')
  try { r.desktop = await osShot(`${SHOTS}/03-desktop.png`) } catch (e) { r.failures.push('desktop shot: ' + String(e.stderr || e.message).trim().slice(0, 300)) }
  if (r.wasFull) { await key(c, 'F11'); await sleep(1500); r.restored = looksFull(await ev(c, FS_EXPR)) }
  if (!TRAY) r.trayNote = 'no 04-tray.png: run with --tray (VENOM_APP_TRAY_POPUP=1)'
  else if (!r.tray) r.failures.push('tray shot missing')
}

async function stepQuit(r) {
  const app = S_.app
  r.listenersBefore = { page: listeners(PORT.page), bridge: listeners(PORT.bridge), cdp: listeners(PORT.cdp) }
  await snapshot('before quit')
  r.method = null
  if (app && !app.exited) {
    const tries = [
      ['Target.closeTarget', async () => { if (!S_.browser || !S_.targetId) throw new Error('no browser socket'); await S_.browser.send('Target.closeTarget', { targetId: S_.targetId }, 5000) }],
      ['window.close()', async () => { await S_.c.send('Runtime.evaluate', { expression: 'window.close()' }, 5000) }],
      ['Browser.close', async () => { const v = await cdpJson('/json/version'); const b = await Cdp.open(v.webSocketDebuggerUrl); b.send('Browser.close').catch(() => {}); await sleep(500); b.close() }],
    ]
    const t = Date.now()
    r.attempts = []
    for (const [name, fn] of tries) {
      try { await fn(); r.attempts.push(`${name}: sent`) } catch (e) { r.attempts.push(`${name}: ${e.message}`); continue }
      const tEnd = Date.now() + (name === 'Browser.close' ? 15000 : 10000)
      while (!app.exited && Date.now() < tEnd) await sleep(200)
      if (app.exited) { r.method = name; break }
    }
    r.closeToExitMs = app.exited ? (app.exitedAt ?? Date.now()) - t : null
    r.appExitCode = app.code
    if (!app.exited) r.failures.push('the app did not exit within 15 s of being closed')
  } else r.method = app ? 'already exited' : 'never started'
  try { S_.c?.close() } catch {}
  try { S_.browser?.close() } catch {}
  // Children (bridge, STT worker, fake CLI) are given a moment to go.
  const tPorts = Date.now()
  while (Date.now() - tPorts < 10000 && Object.values(PORT).some((p) => listeners(p).length)) await sleep(250)
  await sleep(1000)
  r.ports = Object.fromEntries(Object.values(PORT).map((p) => [p, listeners(p)]))
  let list = null
  try { list = await psList() } catch (e) { r.failures.push('process listing failed: ' + e.message) }
  const scratchN = norm(S)
  const left = [], other = []
  const ancestors = new Set()
  for (let pid = process.ppid, n = 0; list && pid && n < 20 && !ancestors.has(pid); n++) {
    ancestors.add(pid)
    pid = list.find((x) => x.pid === pid)?.ppid
  }
  if (list) {
    for (const p of list) {
      if (ancestors.has(p.pid) || p.pid === process.pid || (p.ppid === process.pid && /^(powershell|conhost|netstat)\.exe$/i.test(p.name ?? ''))) continue // the shells that started this script, this script and its helpers
      const ours = isOurs(p, list)
      const match = p.exeN === EXE_N || p.cmdN.includes(scratchN) || /bridge[\\/]server\.mjs/i.test(p.cmd ?? '') || /fake-cli\.mjs/i.test(p.cmd ?? '')
      if (ours || (match && (p.exeN === EXE_N || p.cmdN.includes(scratchN)))) left.push(p)
      else if (match) other.push(p)
    }
  }
  r.leftover = left.map((p) => ({ pid: p.pid, ppid: p.ppid, name: p.name, ours: list ? isOurs(p, list) : null, cmd: String(p.cmd ?? '').slice(0, 220) }))
  r.otherMatchingUntouched = other.map((p) => ({ pid: p.pid, name: p.name, cmd: String(p.cmd ?? '').slice(0, 160) }))
  const busy = Object.entries(r.ports).filter(([, pids]) => pids.length)
  if (left.length || busy.length) {
    r.failures.push(`closing stops everything: FAILED (${left.length} process(es) left${busy.length ? ', ports still listening ' + busy.map(([p]) => p).join(',') : ''})`)
    // Kill only what this run started (or their children), deepest first.
    const depth = (p) => { let d = 0, cur = p; while (cur && d < 30) { cur = list.find((x) => x.pid === cur.ppid && x.pid !== cur.pid); d++ } return d }
    const killable = left.filter((p) => isOurs(p, list)).sort((a, b) => depth(b) - depth(a))
    r.killed = []
    for (const p of killable) {
      let ok
      try { process.kill(p.pid); ok = 'killed' } catch (e) { ok = e.code === 'ESRCH' ? 'already gone' : 'kill failed: ' + e.code }
      r.killed.push({ pid: p.pid, name: p.name, result: ok })
    }
    r.notKilledNotOurs = left.filter((p) => !isOurs(p, list)).map((p) => p.pid)
    await sleep(1500)
    r.portsAfterKill = Object.fromEntries(Object.values(PORT).map((p) => [p, listeners(p)]))
  }
  r.closingStopsEverything = !left.length && !busy.length
}

async function cleanupFallback() {
  // Last line of defence when the quit step itself threw: kill our pids.
  for (const rec of [...spawned].reverse()) if (!rec.exited && alive(rec.pid)) { try { process.kill(rec.pid) } catch {} }
  const list = await psList().catch(() => null)
  if (list) for (const p of list) if (p.pid !== process.pid && isOurs(p, list) && alive(p.pid)) { try { process.kill(p.pid) } catch {} }
}

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(S, { recursive: true })
  fs.mkdirSync(SHOTS, { recursive: true })
  const busy = Object.values(PORT).filter((p) => listeners(p).length)
  if (busy.length) { result.aborted = `refusing to start: port(s) ${busy.join(', ')} already in use`; console.error(result.aborted); return false }
  result.liveBefore = Object.fromEntries(LIVE.map((p) => [p, listeners(p).length > 0]))
  // A fresh app profile unless --keep-profile (then the Kokoro load is not cold).
  // A caller-supplied --data folder is never deleted or emptied.
  result.dataSuppliedByCaller = Boolean(DATA)
  result.profileReused = KEEP_PROFILE && fs.existsSync(PROFILE)
  if (!DATA && !KEEP_PROFILE && fs.existsSync(PROFILE)) {
    if (!PROFILE.endsWith('/profile') || !PROFILE.startsWith(S + '/')) throw new Error('refusing to delete ' + PROFILE)
    fs.rmSync(PROFILE, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
  }
  for (const f of fs.existsSync(SHOTS) ? fs.readdirSync(SHOTS) : []) if (/^0\d-.*\.png$/.test(f)) try { fs.rmSync(`${SHOTS}/${f}`) } catch {}
  const tStart = Date.now()
  // The open tray menu holds the app's main process, so the shot runs beside step a, not after it.
  const trayDone = TRAY && ONLY.has('h') ? trayShot() : null
  await runStep('a', stepStart)
  if (trayDone) await trayDone
  if (!S_.c && !S_.abort) S_.abort = 'no CDP connection to the app page'
  await runStep('b', stepGpu)
  await runStep('c', stepBridge)
  await runStep('d', stepInitialise)
  await runStep('e', stepSpeak)
  await runStep('f', stepKeys)
  await runStep('g', stepSecond)
  if (ONLY.has('h') && !S_.abort) {
    const pre = result.steps.h
    await runStep('h', async (r) => { if (pre?.tray) r.tray = pre.tray; if (pre?.failures?.length) r.failures.push(...pre.failures); await stepOsShots(r) })
  } else await runStep('h', stepOsShots)
  // None of this run's questions may reach the owner's real memory.
  const leaks = []
  const walk = (d) => { try { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (fs.statSync(p).mtimeMs >= tStart && /#stock app/.test(fs.readFileSync(p, 'utf8'))) leaks.push(p) } } catch {} }
  walk(path.join(os.homedir(), '.venom', 'memory'))
  result.realMemoryLeaks = leaks
  return true
}

let cleaned = false
async function finish() {
  if (cleaned) return
  cleaned = true
  try {
    if (S_.app || spawned.length) await runStep('i', stepQuit)
    else result.steps.i = { name: STEP_NAMES.i, status: 'skipped', reason: 'nothing was started' }
  } catch (e) { result.errors.push('quit: ' + String(e?.stack ?? e)) }
  if (spawned.some((r) => !r.exited && alive(r.pid))) { await cleanupFallback(); result.errors.push('fallback clean-up was needed') }
  result.portsAfter = Object.fromEntries([...Object.values(PORT), ...LIVE].map((p) => [p, listeners(p).length ? 'LISTENING' : 'free']))
  result.liveAfter = Object.fromEntries(LIVE.map((p) => [p, listeners(p).length > 0]))
  result.processesAfter = spawned.map((r) => ({ role: r.role, pid: r.pid, exited: r.exited, code: r.code, alive: alive(r.pid) }))
  result.appLogTail = tail(APP_LOG, 30)
  result.bridgeLogTail = tail(BRIDGE_LOG, 15)
  result.finished = new Date().toISOString()
  save()
  summary()
}

process.on('SIGINT', () => { say('interrupted; cleaning up'); result.errors.push('interrupted (SIGINT)'); finish().finally(() => process.exit(130)) })

let ok = false
try {
  ok = await main()
} catch (e) {
  result.errors.push(String(e?.stack ?? e))
  console.error('FAILED:', e?.message ?? e)
} finally {
  await finish()
}
const failedSteps = Object.values(result.steps).filter((s) => s.status === 'failed')
process.exit(ok && !failedSteps.length && !result.aborted && !S_.abort ? 0 : 1)

function summary() {
  const st = result.steps
  const L = ['================ APP PROOF SUMMARY ================']
  L.push(`exe ${EXE}${DEV ? ' (dev)' : ''}  ${result.args.windowed ? 'windowed' : 'full screen'}${PROOF_DIST ? '  dist ' + PROOF_DIST : ''}${TRAY ? '  tray popup' : ''}`)
  if (result.aborted) L.push(`ABORTED: ${result.aborted}`)
  if (S_.abort) L.push(`ABORTED: ${S_.abort}`)
  const line = (k, text) => { const s = st[k]; if (!s) return; L.push(`${k} ${s.name.padEnd(16)} ${String(s.status).toUpperCase().padEnd(12)} ${s.status === 'not selected' ? '' : text ?? ''}`); if (s.failures?.length) L.push(`    failures: ${s.failures.join('; ')}`); if (s.reason) L.push(`    ${s.reason}`) }
  const a = st.a ?? {}
  line('a', a.page ? `target ${a.spawnToTargetMs} ms, #root ${a.spawnToRootMs} ms; silent=${a.page.silent} desktop=${JSON.stringify(a.page.desktop)} origin ${a.page.origin} title ${JSON.stringify(a.page.title)} display-mode fullscreen=${a.page.displayFullscreen} ${a.page.innerWidth}x${a.page.innerHeight} (screen ${a.page.screenW}x${a.page.screenH})` : '')
  const b = st.b ?? {}
  line('b', typeof b.adapter === 'object' ? JSON.stringify(b.adapter) : b.adapter)
  const c = st.c ?? {}
  line('c', c.health ? `health ${c.healthStatus} sttEngine=${c.health.sttEngine} allow-origin ${c.allowOrigin}; mic permission ${c.permissions?.microphone}/${c.permissions?.microphoneAfter}; getUserMedia ${c.permissions?.getUserMedia?.ok ? 'ok ' + c.permissions.getUserMedia.label : c.permissions?.getUserMedia?.error}; inputs ${JSON.stringify(c.permissions?.inputs)}` : '')
  const d = st.d ?? {}
  line('d', d.clickToDormantMs != null ? `click->dormant ${d.clickToDormantMs} ms (${(d.phases ?? []).join('>')}); Kokoro ${d.kokoro?.state} click->ready ${d.kokoroClickToReadyMs} ms loadMs ${d.kokoroLoadMs} (${d.kokoroColdProfile ? 'fresh profile' : 'reused profile'}); HUD ${JSON.stringify(d.hudAfterKokoro?.micLine ?? d.hud?.micLine)} / ${JSON.stringify(d.hudAfterKokoro?.voiceLine ?? d.hud?.voiceLine)}; __voice ${JSON.stringify(d.voice)}; __mic ${d.mic?.label} ${d.mic?.state} rms mean ${d.mic?.rms2s?.mean}` : '')
  const e = st.e ?? {}
  line('e', e.answers ? `${e.answers.length} answers` : '')
  for (const [i, x] of (e.answers ?? []).entries()) for (const s of x.sentences) L.push(`    ${i + 1}. ${s.engine} ${s.voice ?? ''} started=${s.started} appRms ${s.appRms} tapOutRms ${s.tapOutRms} ${JSON.stringify(String(s.text ?? '').slice(0, 60))}`)
  const f = st.f ?? {}
  line('f', f.before ? `F11 toggled=${f.f11Toggled} (${f.before.innerWidth}x${f.before.innerHeight} -> ${f.afterF11?.innerWidth}x${f.afterF11?.innerHeight}) restored=${f.f11Restored}; Esc phase ${f.escPhase}, window kept=${f.escKeptWindow}` : '')
  const g = st.g ?? {}
  line('g', g.before ? `exited=${g.exited} in ${g.exitMs} ms code ${g.exitCode}; listeners ${JSON.stringify(g.before)} -> ${JSON.stringify(g.after)}; log ${JSON.stringify(g.secondInstanceLine)}` : '')
  const h = st.h ?? {}
  line('h', `${h.desktop ? `03 ${h.desktop.width}x${h.desktop.height} ${h.desktop.bytes} bytes` : ''}${h.tray ? `; 04 ${h.tray.bytes} bytes at +${h.tray.msAfterRoot} ms` : ''}${h.trayNote ? '; ' + h.trayNote : ''}`)
  const q = st.i ?? {}
  line('i', `method ${q.method} exit ${q.closeToExitMs} ms code ${q.appExitCode}; closing stops everything: ${q.closingStopsEverything ? 'YES' : 'NO'}${q.leftover?.length ? ' left ' + JSON.stringify(q.leftover) : ''}${q.killed?.length ? ' killed ' + JSON.stringify(q.killed) : ''}`)
  L.push(`screenshots: ${result.screenshots.join(', ') || 'none'}`)
  L.push(`ports after: ${JSON.stringify(result.portsAfter)}; live 5173/8787 before ${JSON.stringify(result.liveBefore)} after ${JSON.stringify(result.liveAfter)}`)
  if (result.realMemoryLeaks?.length) L.push(`REAL MEMORY LEAKS: ${result.realMemoryLeaks.join(', ')}`)
  if (result.errors.length) L.push('errors: ' + result.errors.map((x) => x.split('\n')[0]).join(' | '))
  L.push(`page console errors/warnings: ${result.console.length}`)
  L.push(`result JSON: ${OUT}`)
  console.log('\n' + L.join('\n'))
}
