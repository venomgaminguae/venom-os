#!/usr/bin/env node
// Proof of which microphones this PC has, how loud each one really is, and
// which one the app's microphone code (src/lib/audio.ts) picks, in a HEADED
// Google Chrome on a COPY of the owner's app profile. Not a node:test file.
//
//   node scripts/mic-proof.mjs [--windowed] [--keep-copy] [--seconds N] [--out <json>] [--scratch <dir>]
//
// Starts, and afterwards stops, only what it spawns:
//   vite    5184 (scripts/mic-proof.vite.config.mjs, own cacheDir in scratch,
//           bridge URL pointed at a closed port so nothing talks to 8787);
//   chrome  headed, chromeArgs() of scripts/open-window.mjs on the profile
//           copy, plus --remote-debugging-port=9334 and --mute-audio.
// Never loads 5173, never connects to 8787, never clicks INITIALISE.
// The microphone permission for the scratch origin is granted over CDP from a
// browser-level socket that stays open for the whole run (Chrome drops the
// grant when that socket closes).

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { chromeArgs, defaultProfile } from './open-window.mjs'

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const WebSocket = createRequire(W + '/package.json')('ws')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = { vite: 5184, cdp: 9334 }
const DEAD_BRIDGE = 8799 // nothing listens there; the page's bridge socket just fails
const LIVE = [5173, 8787]
const ORIGIN = `http://localhost:${PORT.vite}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const WINDOWED = argv.includes('--windowed')
const KEEP_COPY = argv.includes('--keep-copy')
const SECONDS = Math.max(1, Number(arg('--seconds', 3)) || 3)
const S = path.resolve(arg('--scratch', process.env.MIC_PROOF_SCRATCH || path.join(os.tmpdir(), 'venom-mic-proof'))).replace(/\\/g, '/')
const OUT = path.resolve(arg('--out', `${S}/mic-proof.json`)).replace(/\\/g, '/')
const COPY = `${S}/profile-copy`
for (const p of Object.values(PORT)) if (LIVE.includes(p)) throw new Error('live port in PORT table')

const T0 = Date.now()
const say = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)
const R = { started: new Date().toISOString(), args: { windowed: WINDOWED, keepCopy: KEEP_COPY, seconds: SECONDS, scratch: S }, errors: [], console: [] }
const save = () => fs.writeFileSync(OUT, JSON.stringify(R, null, 2))

// ---------------------------------------------------------------- processes
function listeners(port) {
  return execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/)
    .filter((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l))
    .map((l) => Number(l.trim().split(/\s+/).pop()))
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
function startProc(role, cmd, args, opts, port) {
  const fd = fs.openSync(`${S}/${role}.log`, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', fd, fd], windowsHide: role !== 'chrome' })
  child.on('error', (e) => R.errors.push(`${role} spawn: ${e.message}`))
  const rec = { role, pid: child.pid, port }
  say(`started ${role} pid ${child.pid}${port ? ' for :' + port : ''}`)
  return rec
}
async function stopProc(rec, requirePort = true) {
  if (!rec || rec.stopped) return
  const owners = rec.port ? listeners(rec.port) : []
  if (alive(rec.pid) && (!requirePort || !rec.port || owners.includes(rec.pid))) {
    try { process.kill(rec.pid) } catch {}
    for (let i = 0; i < 20 && alive(rec.pid); i++) await sleep(250)
  } else if (alive(rec.pid)) say(`${rec.role} pid ${rec.pid} alive but does not hold :${rec.port} (listeners ${owners.join(',') || 'none'}); not killed`)
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
    ws.on('close', () => { for (const { rej } of this.pending.values()) rej(new Error('socket closed')); this.pending.clear() })
  }
  static async open(url) {
    const ws = new WebSocket(url, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 })
    await new Promise((r, j) => { ws.once('open', r); ws.once('error', j) })
    return new Cdp(ws)
  }
  send(method, params = {}) {
    return new Promise((res, rej) => { const id = ++this.id; this.pending.set(id, { res, rej }); this.ws.send(JSON.stringify({ id, method, params })) })
  }
  on(fn) { this.handlers.push(fn) }
}
async function ev(c, expression, timeoutMs = 120000) {
  const r = await Promise.race([
    c.send('Runtime.evaluate', { expression, userGesture: true, awaitPromise: true, returnByValue: true }),
    sleep(timeoutMs).then(() => { throw new Error(`evaluate timed out after ${timeoutMs} ms`) }),
  ])
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// ---------------------------------------------------------------- step 1: profile
function copyRealProfile() {
  const src = defaultProfile()
  const info = { src, dst: COPY, kept: false }
  if (!fs.existsSync(src)) throw new Error('owner profile not found: ' + src)
  if (KEEP_COPY && fs.existsSync(`${COPY}/Default`)) info.kept = true
  else {
    removeCopy(true)
    const t = Date.now()
    let status = 0
    try {
      execFileSync('robocopy', [src.replace(/\//g, '\\'), COPY.replace(/\//g, '\\'), '/E', '/R:0', '/W:0', '/NFL', '/NDL', '/NJH', '/NP', '/XF', 'lockfile', 'LOCK', 'SingletonLock'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 })
    } catch (e) {
      status = e.status
      info.robocopyTail = String(e.stdout ?? '').trim().split(/\r?\n/).slice(-6).map((l) => l.trim())
    }
    info.robocopyExit = status
    info.copyMs = Date.now() - t
    if (status == null || status >= 16) throw new Error(`robocopy failed (exit ${status}): ${JSON.stringify(info.robocopyTail)}`)
  }
  return info
}
function removeCopy(quiet = false) {
  if (!fs.existsSync(COPY)) return 'absent'
  if (!COPY.endsWith('/profile-copy')) throw new Error('refusing to delete ' + COPY)
  try { fs.rmSync(COPY, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); return fs.existsSync(COPY) ? 'still there' : 'deleted' }
  catch (e) { if (!quiet) say('could not delete', COPY, e.code); return 'failed: ' + e.code }
}
function readPrefs() {
  const out = { file: `${COPY}/Default/Preferences` }
  let p
  try { p = JSON.parse(fs.readFileSync(out.file, 'utf8')) } catch (e) { out.error = String(e); return out }
  out.userPreferenceRanking = p?.media?.audio_input?.user_preference_ranking ?? null
  out.defaultAudioCaptureDevice = p?.media?.default_audio_capture_device ?? null
  // Anything else about audio input/capture devices, wherever it sits.
  const similar = {}
  const walk = (o, at, depth) => {
    if (!o || typeof o !== 'object' || depth > 6) return
    for (const [k, v] of Object.entries(o)) {
      const key = at ? `${at}.${k}` : k
      if (/audio_(input|capture)|default_audio|audio_device|mic(rophone)?_device/i.test(k)) similar[key] = v
      else if (!/^profile\.content_settings/.test(key)) walk(v, key, depth + 1)
    }
  }
  walk(p, '', 0)
  out.similarKeys = similar
  const mic = p?.profile?.content_settings?.exceptions?.media_stream_mic ?? {}
  out.micExceptions = Object.fromEntries(Object.entries(mic).map(([k, v]) => [k, v?.setting]))
  const allowFor = (origin) => Object.entries(mic).some(([k, v]) => k.split(',')[0].replace(/\/$/, '') === origin && v?.setting === 1)
  out.micAllowLive = allowFor('http://localhost:5173')
  out.micAllowScratch = allowFor(ORIGIN)
  return out
}

// ---------------------------------------------------------------- page code
const PAGE_HELPERS = String.raw`(() => {
  if (window.__mp) return 'already'
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const stats = (v) => v.length ? { mean: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(6), min: +Math.min(...v).toFixed(6), max: +Math.max(...v).toFixed(6), n: v.length } : { mean: null, min: null, max: null, n: 0 }
  const M = window.__mp = { sleep, stats }
  M.ctx = async () => {
    if (!M._ctx || M._ctx.state === 'closed') M._ctx = new AudioContext()
    if (M._ctx.state !== 'running') { try { await M._ctx.resume() } catch (e) {} }
    return M._ctx
  }
  M.measure = async (audio, secs) => {
    const t0 = performance.now()
    let s
    try { s = await navigator.mediaDevices.getUserMedia({ audio }) } catch (e) { return { error: e.name + ': ' + e.message } }
    const tr = s.getAudioTracks()[0]
    const st = tr.getSettings()
    const ctx = await M.ctx()
    const src = ctx.createMediaStreamSource(s)
    const an = ctx.createAnalyser(); an.fftSize = 2048
    src.connect(an)
    const buf = new Float32Array(an.fftSize)
    const v = []
    const start = performance.now()
    while (performance.now() - start < secs * 1000 + 200) {
      await sleep(50)
      if (performance.now() - start < 200) continue
      an.getFloatTimeDomainData(buf)
      let sum = 0
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i]
      v.push(Math.sqrt(sum / buf.length))
    }
    try { src.disconnect() } catch (e) {}
    s.getTracks().forEach((t) => t.stop())
    return { label: tr.label, ctxState: ctx.state, sampleRate: st.sampleRate, channelCount: st.channelCount, echoCancellation: st.echoCancellation, noiseSuppression: st.noiseSuppression, autoGainControl: st.autoGainControl, openMs: Math.round(start - t0), ...stats(v) }
  }
  M.micCopy = () => { try { return window.__mic ? JSON.parse(JSON.stringify(window.__mic)) : 'not present' } catch (e) { return 'unreadable: ' + e.message } }
  M.sampleMic = async (secs, every = 100) => {
    if (!window.__mic) return 'not present'
    const v = []
    const end = performance.now() + secs * 1000
    while (performance.now() < end) { const x = Number(window.__mic.rms); if (Number.isFinite(x)) v.push(x); await sleep(every) }
    return stats(v)
  }
  M.useApp = async (waitMs) => {
    const out = {}
    try {
      const a = window.__mpAudio = await import('/src/lib/audio.ts')
      out.exports = Object.keys(a)
      const s = await a.getMic()
      const t = s && s.getAudioTracks ? s.getAudioTracks()[0] : null
      out.track = t ? { label: t.label, readyState: t.readyState, enabled: t.enabled, muted: t.muted, deviceId: (t.getSettings().deviceId || '').slice(0, 8) } : null
    } catch (e) { out.error = String(e && e.stack || e).slice(0, 400); return out }
    await sleep(waitMs)
    out.mic = M.micCopy()
    const t = (await window.__mpAudio.getMic()).getAudioTracks()[0]
    out.trackAfterWait = t ? t.readyState : null
    return out
  }
  return 'installed'
})()`

const short = (id) => (id ? String(id).slice(0, 8) : '')
const shortMic = (m) => {
  if (!m || typeof m !== 'object') return m
  const x = { ...m, deviceId: short(m.deviceId) }
  if (Array.isArray(m.inputs)) x.inputs = m.inputs.map((i) => ({ deviceId: short(i.deviceId), label: i.label }))
  if (m.levels && typeof m.levels === 'object') x.levels = Object.fromEntries(Object.entries(m.levels).map(([k, v]) => [short(k), v]))
  return x
}

// ---------------------------------------------------------------- main
async function main() {
  fs.mkdirSync(S, { recursive: true })
  const busy = Object.values(PORT).filter((p) => listeners(p).length)
  if (busy.length) throw new Error(`refusing to start: port(s) ${busy.join(', ')} already in use`)
  R.liveBefore = Object.fromEntries(LIVE.map((p) => [p, listeners(p).length > 0]))
  const procs = {}
  let b = null, c = null
  try {
    // 1. profile copy + preferences
    R.profile = copyRealProfile()
    say('profile copy', JSON.stringify(R.profile))
    R.prefs = readPrefs()
    say('prefs', JSON.stringify(R.prefs))
    save()

    // 2. scratch Vite
    procs.vite = startProc('vite', process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/mic-proof.vite.config.mjs'], {
      cwd: W,
      env: {
        ...process.env,
        MIC_PROOF_PORT: String(PORT.vite),
        MIC_PROOF_CACHE: `${S}/vite-cache`,
        VITE_BACKEND: 'bridge',
        VITE_BRIDGE_URL: `ws://localhost:${DEAD_BRIDGE}`,
        VITE_USE_ELEVENLABS: 'false',
        VITE_ELEVENLABS_API_KEY: '',
      },
    }, PORT.vite)
    await waitFor('vite', async () => ({ ok: (await fetch(`${ORIGIN}/`)).ok }), 60000)
    if (!listeners(PORT.vite).includes(procs.vite.pid)) throw new Error(`:${PORT.vite} is not held by the spawned vite pid`)
    say('vite up')

    // 3. headed Chrome on the copy
    const flags = [...chromeArgs({ url: `${ORIGIN}/`, profile: COPY.replace(/\//g, '\\'), fullscreen: !WINDOWED }), `--remote-debugging-port=${PORT.cdp}`, '--mute-audio']
    if (!flags.includes('--mute-audio')) throw new Error('no --mute-audio')
    R.chromeFlags = flags
    procs.chrome = startProc('chrome', CHROME, flags, {}, PORT.cdp)
    const v = await waitFor('chrome cdp', async () => ({ ok: true, v: await (await fetch(`http://127.0.0.1:${PORT.cdp}/json/version`)).json() }), 30000)
    R.chromeVersion = v.v.Browser
    b = await Cdp.open(v.v.webSocketDebuggerUrl) // stays open: it holds the permission grant
    try {
      await b.send('Browser.grantPermissions', { origin: ORIGIN, permissions: ['audioCapture'] })
      R.grant = { granted: true, neededOwnGrant: !R.prefs.micAllowScratch, note: R.prefs.micAllowScratch ? 'profile already allowed the scratch origin' : `profile had no mic allow for ${ORIGIN}; granted over CDP` }
    } catch (e) { R.grant = { granted: false, error: e.message } }
    say('grant', JSON.stringify(R.grant))
    const page = await waitFor('page target', async () => {
      const t = (await (await fetch(`http://127.0.0.1:${PORT.cdp}/json`)).json()).find((x) => x.type === 'page' && x.url.startsWith(ORIGIN))
      return { ok: Boolean(t), t }
    }, 30000)
    c = await Cdp.open(page.t.webSocketDebuggerUrl)
    c.on((m) => {
      const p = m.params
      if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(p.type)) R.console.push(`${p.type}: ` + p.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
      else if (m.method === 'Runtime.exceptionThrown') R.console.push('exception: ' + (p.exceptionDetails.exception?.description ?? p.exceptionDetails.text).slice(0, 300))
    })
    for (const m of ['Page.enable', 'Runtime.enable']) await c.send(m)
    await waitFor('document', async () => ({ ok: (await ev(c, 'document.readyState')) === 'complete' }), 30000)
    // Leftover choice from an earlier run would skew 'why'.
    R.savedLabelAtStart = await ev(c, `localStorage.getItem('venom.mic.label')`)
    await ev(c, PAGE_HELPERS)
    R.window = await ev(c, '({ w: innerWidth, h: innerHeight })')

    // 4a. Chrome's default track + device list
    R.defaultTrack = await ev(c, `(async () => {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      const t = s.getAudioTracks()[0]
      const r = { label: t.label, deviceId: (t.getSettings().deviceId || '').slice(0, 8), groupId: (t.getSettings().groupId || '').slice(0, 8) }
      s.getTracks().forEach((x) => x.stop())
      return r
    })()`)
    say('chrome default track:', R.defaultTrack.label)
    const devs = await ev(c, `navigator.mediaDevices.enumerateDevices().then((l) => l.filter((d) => d.kind === 'audioinput').map((d) => ({ deviceId: d.deviceId, label: d.label, groupId: d.groupId })))`)
    R.inputs = devs.map((d) => ({ deviceId: short(d.deviceId), label: d.label, alias: d.deviceId === 'default' || d.deviceId === 'communications' }))
    say('inputs', JSON.stringify(R.inputs))
    save()

    // 4b. raw and processed levels per real device
    const real = devs.filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    R.levels = []
    for (const d of real) {
      const id = JSON.stringify(d.deviceId)
      const raw = await ev(c, `__mp.measure({ deviceId: { exact: ${id} }, echoCancellation: false, noiseSuppression: false, autoGainControl: false }, ${SECONDS})`)
      const proc = await ev(c, `__mp.measure({ deviceId: { exact: ${id} }, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, ${SECONDS})`)
      R.levels.push({ deviceId: short(d.deviceId), label: d.label, raw, processed: proc })
      say(`level ${d.label}: raw mean ${raw.mean} max ${raw.max} | processed mean ${proc.mean} max ${proc.max} | ctx ${raw.ctxState}`)
      save()
    }

    // 4c. the app's own choice
    const app = async (label, waitMs, secs) => {
      const r = await ev(c, `__mp.useApp(${waitMs})`)
      if (r.mic && typeof r.mic === 'object') r.mic = shortMic(r.mic)
      r.meter = await ev(c, `__mp.sampleMic(${secs})`)
      say(`app ${label}:`, JSON.stringify({ track: r.track, why: r.mic?.why, label: r.mic?.label ?? r.mic, meter: r.meter, error: r.error }))
      return r
    }
    R.app = await app('first load', 4000, SECONDS)
    save()

    // 4d. HUD without INITIALISE
    try {
      R.hud = await ev(c, `(async () => {
        const end = performance.now() + 10000
        while (!window.__venom && performance.now() < end) await __mp.sleep(200)
        if (!window.__venom) return { error: '__venom not present' }
        const out = { phaseBefore: __venom.phase }
        try { __venom.setPhase('dormant') } catch (e) { out.setPhaseError = String(e) }
        await __mp.sleep(1500)
        out.phaseAfter = __venom.phase
        const el = document.querySelector('.mic-status')
        out.micStatus = el ? el.textContent : null
        const f = document.querySelector('.mic-meter-fill')
        out.meterFill = f ? { style: f.style.width || null, px: Math.round(f.getBoundingClientRect().width) } : null
        out.initialiseVisible = [...document.querySelectorAll('button')].some((x) => /INITIALI[SZ]E/i.test(x.textContent || '') && x.offsetParent !== null)
        return out
      })()`)
    } catch (e) { R.hud = { error: e.message } }
    try {
      const shot = await c.send('Page.captureScreenshot', { format: 'png' })
      fs.writeFileSync(`${S}/mic-hud.png`, Buffer.from(shot.data, 'base64'))
      R.hud.screenshot = `${S}/mic-hud.png`
    } catch (e) { R.hud.screenshot = 'failed: ' + e.message }
    say('hud', JSON.stringify(R.hud))
    save()

    // 4e. cycling, then a reload to see the saved choice used
    const hasCycle = await ev(c, `typeof (window.__mpAudio && window.__mpAudio.cycleMic) === 'function'`)
    if (!hasCycle) R.cycle = 'cycleMic not exported (old audio.ts)'
    else {
      R.cycle = { steps: [] }
      for (let i = 0; i < real.length; i++) {
        const st = await ev(c, `(async () => {
          let err = null
          try { await window.__mpAudio.cycleMic() } catch (e) { err = String(e) }
          await __mp.sleep(1500)
          const m = window.__mic || {}
          return { error: err, label: m.label ?? null, why: m.why ?? null, state: m.state ?? null, rms: await __mp.sampleMic(1, 50), saved: localStorage.getItem('venom.mic.label') }
        })()`)
        R.cycle.steps.push(st)
        say(`cycle ${i + 1}:`, JSON.stringify(st))
      }
      R.cycle.returnedToStart = R.cycle.steps.at(-1)?.label === (R.app.mic?.label ?? null)
      const savedBefore = await ev(c, `localStorage.getItem('venom.mic.label')`)
      await c.send('Page.reload', { ignoreCache: false })
      await sleep(1000)
      await waitFor('reload', async () => ({ ok: (await ev(c, 'document.readyState')) === 'complete' }), 30000)
      await ev(c, PAGE_HELPERS)
      const after = await app('after reload', 4000, 1)
      R.reload = { savedBefore, mic: after.mic, track: after.track, meter: after.meter, usedSaved: after.mic?.why === 'saved' && after.mic?.label === savedBefore }
    }
    // 4f. saved choice = the quietest input: the page must leave it by itself
    // for one that carries sound, and say so (the owner's failure, replayed).
    const quiet = [...(R.levels ?? [])].filter((l) => typeof l.raw?.mean === 'number').sort((x, y) => x.raw.mean - y.raw.mean)[0]
    const quietFull = quiet && real.find((d) => d.label === quiet.label)
    if (hasCycle && quietFull && real.length > 1) {
      await ev(c, `localStorage.setItem('venom.mic.label', ${JSON.stringify(quietFull.label)})`)
      await c.send('Page.reload', { ignoreCache: false })
      await sleep(1000)
      await waitFor('reload 2', async () => ({ ok: (await ev(c, 'document.readyState')) === 'complete' }), 30000)
      await ev(c, PAGE_HELPERS)
      const first = await app('saved = quietest', 1500, 1)
      const t0 = Date.now()
      let now = null
      while (Date.now() - t0 < 20000) {
        now = await ev(c, `__mp.micCopy()`)
        if (now && typeof now === 'object' && (now.why === 'switched' || now.state === 'silent')) break
        await sleep(500)
      }
      const meter = await ev(c, `__mp.sampleMic(2)`)
      const hudText = await ev(c, `(() => { try { window.__venom && __venom.setPhase('dormant') } catch {} ; return new Promise((r) => setTimeout(() => r(document.querySelector('.mic-status')?.textContent ?? null), 1200)) })()`)
      try {
        const shot = await c.send('Page.captureScreenshot', { format: 'png' })
        fs.writeFileSync(`${S}/mic-hud-switched.png`, Buffer.from(shot.data, 'base64'))
      } catch {}
      R.autoSwitch = { savedQuiet: quietFull.label, startedOn: first.mic?.label, startedWhy: first.mic?.why, afterMs: Date.now() - t0, label: now?.label, why: now?.why, state: now?.state, note: now?.note, levels: now?.levels, meter, hudText, savedStill: await ev(c, `localStorage.getItem('venom.mic.label')`) }
      say('auto switch', JSON.stringify(R.autoSwitch))
    }
    // 4g. the path local hearing uses: MediaRecorder on the shared stream
    // (vad.ts records it and posts the clip to Whisper). Record, decode, measure.
    try {
      R.recorder = await ev(c, `(async () => {
        const stream = await window.__mpAudio.getMic()
        const rec = new MediaRecorder(stream)
        const parts = []
        rec.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data) }
        const done = new Promise((r) => { rec.onstop = r })
        rec.start(); await __mp.sleep(2000); rec.stop(); await done
        const blob = new Blob(parts, { type: rec.mimeType })
        const ac = new AudioContext()
        const buf = await ac.decodeAudioData(await blob.arrayBuffer())
        const d = buf.getChannelData(0)
        let sum = 0; for (let i = 0; i < d.length; i++) sum += d[i] * d[i]
        void ac.close()
        return { mime: rec.mimeType, bytes: blob.size, seconds: Number(buf.duration.toFixed(2)), rms: Math.sqrt(sum / d.length), device: window.__mic && window.__mic.label }
      })()`)
    } catch (e) { R.recorder = { error: e.message } }
    say('recorder', JSON.stringify(R.recorder))
    R.savedLabelRemoved = await ev(c, `(localStorage.removeItem('venom.mic.label'), localStorage.getItem('venom.mic.label') === null)`)
  } catch (e) {
    R.errors.push(String(e?.stack ?? e))
    say('ERROR', e?.message ?? e)
  } finally {
    // 6. cleanup: Chrome, Vite, profile copy, ports
    try { c?.ws.close() } catch {}
    if (procs.chrome) {
      try { if (b) { b.send('Browser.close').catch(() => {}); await sleep(2500) } } catch {}
      try { b?.ws.close() } catch {}
      for (let i = 0; i < 20 && alive(procs.chrome.pid); i++) await sleep(250)
      if (alive(procs.chrome.pid)) await stopProc(procs.chrome, false)
      else { procs.chrome.stopped = true; say(`chrome pid ${procs.chrome.pid} closed`) }
    }
    if (procs.vite) await stopProc(procs.vite)
    for (let i = 0; i < 20 && Object.values(PORT).some((p) => listeners(p).length); i++) await sleep(250)
    R.copyRemoval = KEEP_COPY ? 'kept (--keep-copy)' : removeCopy()
    R.portsAfter = Object.fromEntries(Object.values(PORT).map((p) => [p, listeners(p).length ? `busy (pids ${listeners(p).join(',')})` : 'free']))
    R.processesAfter = Object.fromEntries(Object.entries(procs).map(([k, r]) => [k, { pid: r.pid, alive: alive(r.pid) }]))
    R.liveAfter = Object.fromEntries(LIVE.map((p) => [p, listeners(p).length > 0]))
    save()
  }
  summary()
}

function fmt(x) { return x == null ? '-' : typeof x === 'number' ? x.toFixed(4) : String(x) }
function summary() {
  const L = []
  const p = R.prefs ?? {}
  L.push('================ MIC PROOF SUMMARY ================')
  L.push(`Chrome ${R.chromeVersion ?? '?'}  window ${R.window ? R.window.w + 'x' + R.window.h : '?'}  seconds per measurement ${SECONDS}`)
  L.push(`Profile copy: robocopy exit ${R.profile?.robocopyExit ?? '-'} in ${R.profile?.copyMs ?? '-'} ms`)
  L.push(`Prefs media.audio_input.user_preference_ranking: ${JSON.stringify(p.userPreferenceRanking)}`)
  L.push(`Prefs media.default_audio_capture_device: ${JSON.stringify(p.defaultAudioCaptureDevice)}`)
  L.push(`Prefs other audio-device keys: ${JSON.stringify(p.similarKeys ?? {})}`)
  L.push(`Mic permission in profile: localhost:5173 allow=${p.micAllowLive}  ${ORIGIN} allow=${p.micAllowScratch}  (exceptions ${JSON.stringify(p.micExceptions ?? {})})`)
  L.push(`CDP grant for ${ORIGIN}: ${JSON.stringify(R.grant)}`)
  L.push(`Chrome's default getUserMedia track (what the old code listened on): ${R.defaultTrack?.label ?? '-'} [${R.defaultTrack?.deviceId ?? ''}]`)
  L.push('Inputs (enumerateDevices):')
  for (const i of R.inputs ?? []) L.push(`  ${i.deviceId.padEnd(14)} ${i.label}${i.alias ? '  (alias)' : ''}`)
  L.push(`Levels, RMS per 50 ms frame (SILENT_RMS = 0.0005):`)
  L.push(`  ${'device'.padEnd(52)} ${'raw mean'.padStart(9)} ${'raw min'.padStart(9)} ${'raw max'.padStart(9)} | ${'proc mean'.padStart(9)} ${'proc min'.padStart(9)} ${'proc max'.padStart(9)}  ctx`)
  for (const l of R.levels ?? []) {
    const r = l.raw ?? {}, q = l.processed ?? {}
    L.push(`  ${(l.label + ' [' + l.deviceId + ']').slice(0, 52).padEnd(52)} ${fmt(r.mean).padStart(9)} ${fmt(r.min).padStart(9)} ${fmt(r.max).padStart(9)} | ${fmt(q.mean).padStart(9)} ${fmt(q.min).padStart(9)} ${fmt(q.max).padStart(9)}  ${r.ctxState ?? r.error ?? '-'}${q.error ? ' proc error ' + q.error : ''}`)
  }
  const a = R.app ?? {}
  const m = a.mic
  L.push(`App getMic(): exports [${(a.exports ?? []).join(', ')}]  track ${a.track ? `${a.track.label} [${a.track.deviceId}] ${a.track.readyState}` : '-'}  after wait ${a.trackAfterWait ?? '-'}${a.error ? '  ERROR ' + a.error : ''}`)
  L.push(`window.__mic: ${m && typeof m === 'object' ? `state ${m.state}, label ${m.label}, why ${m.why}, note ${JSON.stringify(m.note ?? '')}, contextState ${m.contextState}, error ${JSON.stringify(m.error ?? null)}` : (m ?? 'not read')}`)
  if (m && typeof m === 'object' && m.levels) L.push(`  __mic.levels: ${JSON.stringify(m.levels)}`)
  L.push(`Live meter __mic.rms over ${SECONDS}s: ${typeof a.meter === 'object' ? `min ${fmt(a.meter.min)} mean ${fmt(a.meter.mean)} max ${fmt(a.meter.max)} (n ${a.meter.n})` : a.meter ?? '-'}`)
  L.push(`HUD: ${R.hud?.error ? 'ERROR ' + R.hud.error : `phase ${R.hud?.phaseBefore} -> ${R.hud?.phaseAfter}; .mic-status ${JSON.stringify(R.hud?.micStatus ?? null)}; meter fill ${JSON.stringify(R.hud?.meterFill ?? null)}; INITIALISE visible ${R.hud?.initialiseVisible}`}; screenshot ${R.hud?.screenshot ?? '-'}`)
  if (typeof R.cycle === 'string' || !R.cycle) L.push(`Cycle: ${R.cycle ?? 'not run'}`)
  else {
    L.push('Cycle (cycleMic):')
    R.cycle.steps.forEach((s, i) => L.push(`  ${i + 1}. ${s.label} (${s.why}, ${s.state}) rms mean ${fmt(s.rms?.mean)} max ${fmt(s.rms?.max)} saved=${JSON.stringify(s.saved)}${s.error ? ' ERROR ' + s.error : ''}`))
    L.push(`  returned to start: ${R.cycle.returnedToStart}`)
    L.push(`Reload: saved ${JSON.stringify(R.reload?.savedBefore)} -> __mic ${R.reload?.mic?.label ?? R.reload?.mic} (why ${R.reload?.mic?.why ?? '-'}); used saved: ${R.reload?.usedSaved}`)
  }
  const s = R.autoSwitch
  if (s) L.push(`Auto switch: saved ${JSON.stringify(s.savedQuiet)} -> started on ${s.startedOn} (${s.startedWhy}) -> after ${s.afterMs} ms: ${s.label} (${s.why}, ${s.state}) note ${JSON.stringify(s.note)}; sampled raw levels ${JSON.stringify(Object.values(s.levels ?? {}).map((v) => Number(v.toFixed(4))))}; meter mean ${fmt(s.meter?.mean)} max ${fmt(s.meter?.max)}; HUD ${JSON.stringify(s.hudText)}; saved choice kept: ${s.savedStill === s.savedQuiet}`)
  if (R.recorder) L.push(`Recorder on the shared stream (what Whisper gets): ${R.recorder.error ? 'ERROR ' + R.recorder.error : `${R.recorder.mime}, ${R.recorder.bytes} bytes, ${R.recorder.seconds} s, decoded RMS ${fmt(R.recorder.rms)}, device ${R.recorder.device}`}`)
  L.push(`venom.mic.label removed: ${R.savedLabelRemoved ?? '-'}  (was at start: ${JSON.stringify(R.savedLabelAtStart ?? null)})`)
  if (R.errors.length) L.push(`Errors: ${R.errors.map((e) => e.split('\n')[0]).join(' | ')}`)
  L.push(`Page console errors/warnings: ${R.console.length}`)
  L.push(`Cleanup: processes ${JSON.stringify(R.processesAfter)}; profile copy ${R.copyRemoval}; ports ${JSON.stringify(R.portsAfter)}; live 5173/8787 listening before ${JSON.stringify(R.liveBefore)} after ${JSON.stringify(R.liveAfter)}`)
  L.push(`Full JSON: ${OUT}`)
  console.log(L.join('\n'))
}

main().catch((e) => { console.error(e); process.exitCode = 1 })
