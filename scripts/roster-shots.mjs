#!/usr/bin/env node
// Screenshots of the HUD's agent tiles and orbs for several team sizes, in a
// silent headless Google Chrome on scratch ports. Not a node:test file.
//
//   node scripts/roster-shots.mjs [--sizes 1,5,12] [--out <dir>] [--settle <ms>] [--view 1366x768]
//
// Starts, and stops again on every exit path, only what it spawns:
//   bridge  a tiny fake bridge (ws) on 8823 that answers every connection with
//           'ready' and a team snapshot of N made-up agents and a few runs;
//   vite    5193 (scripts/mic-proof.vite.config.mjs: the app's own config, a
//           strict port, a dependency cache in the output folder's scratch);
//   chrome  --headless=new, --mute-audio, its own --user-data-dir, no
//           microphone (--deny-permission-prompts), CDP on 9343.
// Never touches 5173 or 8787, never clicks INITIALISE: the HUD is shown with
// the page's own __venom.setPhase('dormant'), as scripts/mic-proof.mjs does.
//
// Per size it saves <out>/agents-NN.png (1920x1080) and prints the measured
// DOM facts: tile count == N, every tile inside the viewport and fully shown
// in its column, no two tiles overlapping, no tile reaching into the core
// ring (ringSize, hermes-mcp/tiles.mjs), no two orb names overlapping.
// Exit 1 if a fact fails or the page never draws the tiles.

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const W = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..').replace(/\\/g, '/')
const require_ = createRequire(W + '/package.json')
const WebSocket = require_('ws')
const { WebSocketServer } = WebSocket
const { ringSize } = await import(pathToFileURL(`${W}/hermes-mcp/tiles.mjs`).href)

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = { vite: 5193, cdp: 9343, bridge: 8823 }
const LIVE = [5173, 8787]
const VIEW_ARG = (process.argv.join(' ').match(/--view (\d{3,4})x(\d{3,4})/) ?? [0, 1920, 1080]).slice(1).map(Number)
const VIEW = { width: VIEW_ARG[0], height: VIEW_ARG[1] }
const ORIGIN = `http://localhost:${PORT.vite}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
for (const p of Object.values(PORT)) if (LIVE.includes(p)) throw new Error('live port in PORT table')

const argv = process.argv.slice(2)
const arg = (name, def) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const SIZES = String(arg('--sizes', '1,5,12'))
  .split(',')
  .map((s) => Math.floor(Number(s)))
  .filter((n) => n >= 1 && n <= 40)
const OUT = path.resolve(arg('--out', os.tmpdir())).replace(/\\/g, '/')
const SETTLE = Math.max(500, Number(arg('--settle', 2500)) || 2500)
const TMP = `${OUT}/.roster-shots`

const T0 = Date.now()
const say = (...a) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1)}s]`, ...a)

// ---------------------------------------------------------------- the team
const NAMES = [
  'Researcher', 'Data Analyst', 'Shop Lead', 'Writer', 'Ops', 'Inbox Triage', 'Designer', 'Coder',
  'Finance Desk', 'QA', 'Social Media', 'Travel Planner', 'Legal Reader', 'Scout', 'Support Desk', 'Editor',
]
const KINDS = ['specialist', 'project', 'advisor']
const slug = (s) => s.toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '')

function team(n) {
  const roster = []
  for (let i = 0; i < n; i++) {
    const base = NAMES[i % NAMES.length]
    const name = i < NAMES.length ? base : `${base} ${String.fromCharCode(65 + Math.floor(i / NAMES.length))}`
    roster.push({ id: slug(name), name, role: `Made-up agent: ${name}`, kind: KINDS[i % KINDS.length], pinned: i < 2 })
  }
  const now = Date.now()
  const SEC = 1000
  const MIN = 60 * SEC
  const hex = ['abcdefab', 'facedbad', 'decafbad', 'beadfeed']
  const runId = (k) => `rostr${'abcdefgh'[k]}-${hex[k % hex.length]}`
  const runs = []
  // working: the first agent; done (inside the 8s hold) with a result line: the
  // second; an older finished job (idle with a job line): the fourth; the
  // rest have no jobs yet.
  if (n >= 1) runs.push({ id: runId(0), agent: roster[0].id, task: 'Compare three laptop reviews and list the trade-offs', state: 'working', startedAt: now - 95 * SEC, endedAt: null, ms: null, steps: [{ text: 'Reading the second review', ts: now - 4 * SEC }], summary: '' })
  if (n >= 2) runs.push({ id: runId(1), agent: roster[1].id, task: 'Summarise last week of sales', state: 'done', startedAt: now - 60 * SEC, endedAt: now - SEC, ms: 59 * SEC, steps: [], summary: 'Sales rose by a fifth; the top seller was the blue mug.' })
  if (n >= 4) runs.push({ id: runId(2), agent: roster[3].id, task: 'Draft the newsletter intro', state: 'done', startedAt: now - 60 * MIN, endedAt: now - 58 * MIN, ms: 2 * MIN, steps: [], summary: 'Draft saved with two headline options.' })
  return { roster, runs }
}

// ---------------------------------------------------------------- processes
function listeners(port) {
  return execFileSync('netstat', ['-ano'], { encoding: 'utf8' }).split(/\r?\n/)
    .filter((l) => /LISTENING/.test(l) && new RegExp(`:${port}\\s`).test(l))
    .map((l) => Number(l.trim().split(/\s+/).pop()))
}
const alive = (pid) => { try { process.kill(pid, 0); return true } catch { return false } }
const procs = []
function startProc(role, cmd, args, opts) {
  const fd = fs.openSync(`${TMP}/${role}.log`, 'a')
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', fd, fd], windowsHide: true })
  child.on('error', (e) => say(`${role} spawn error: ${e.message}`))
  const rec = { role, pid: child.pid }
  procs.push(rec)
  say(`started ${role} pid ${child.pid}`)
  return rec
}
/** Kills one of OUR processes and its children, by PID only. */
function killTree(rec) {
  if (!rec || rec.stopped) return
  rec.stopped = true
  if (!alive(rec.pid)) return
  try { execFileSync('taskkill', ['/PID', String(rec.pid), '/T', '/F'], { stdio: 'ignore' }) } catch { try { process.kill(rec.pid) } catch {} }
}
let bridge = null
function cleanupSync() {
  for (const p of procs.slice().reverse()) killTree(p)
  try { bridge?.close() } catch {}
  bridge = null
}
process.on('exit', cleanupSync)
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(sig, () => { cleanupSync(); process.exit(1) })

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
    this.ws = ws; this.id = 0; this.pending = new Map()
    ws.on('message', (raw) => {
      const m = JSON.parse(raw)
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id); this.pending.delete(m.id)
        if (m.error) rej(new Error(m.error.message))
        else res(m.result)
      }
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
}
async function ev(c, expression) {
  const r = await c.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}

// ---------------------------------------------------------------- facts
const MEASURE = String.raw`(() => {
  const box = (r) => ({ left: r.left, top: r.top, right: r.right, bottom: r.bottom })
  const tiles = [...document.querySelectorAll('.tile')].map((el) => {
    const col = el.closest('.tiles')
    return { id: el.dataset.agent, box: box(el.getBoundingClientRect()), col: col ? box(col.getBoundingClientRect()) : null,
      compact: el.classList.contains('tile-compact'), name: el.querySelector('.tile-name')?.textContent ?? '',
      nameClipped: (() => { const n = el.querySelector('.tile-name'); return n ? n.scrollWidth > n.clientWidth + 1 : false })() }
  })
  const layer = document.querySelector('.orbs')
  const names = [...document.querySelectorAll('.orb-name')].map((el) => ({ name: el.textContent, box: box(el.getBoundingClientRect()) }))
  return { w: innerWidth, h: innerHeight, mode: document.documentElement.dataset.tiles ?? null, tiles, names,
    orbOpacity: layer ? Number(getComputedStyle(layer).opacity) : null, phase: window.__venom?.phase ?? null,
    initialise: [...document.querySelectorAll('button')].some((b) => /INITIALI[SZ]E/i.test(b.textContent || '') && b.offsetParent !== null) }
})()`

const overlap = (a, b, pad = 0) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > pad && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > pad
/** Whether a rectangle reaches into the circle of radius r at (cx, cy). */
function intoCircle(b, cx, cy, r) {
  const x = Math.max(b.left, Math.min(cx, b.right))
  const y = Math.max(b.top, Math.min(cy, b.bottom))
  return Math.hypot(x - cx, y - cy) < r
}

function check(n, m) {
  const fails = []
  const facts = []
  facts.push(`mode ${m.mode}, tiles ${m.tiles.length}/${n}${m.tiles.some((t) => t.compact) ? ' (compact)' : ''}`)
  if (m.tiles.length) {
    const hs = m.tiles.map((t) => t.box.bottom - t.box.top)
    const low = Math.max(...m.tiles.map((t) => t.box.bottom))
    facts.push(`tile height ${Math.min(...hs).toFixed(0)}-${Math.max(...hs).toFixed(0)}px, lowest tile ends at y=${low.toFixed(0)}, columns end at y=${Math.max(...m.tiles.map((t) => t.col?.bottom ?? 0)).toFixed(0)}`)
  }
  if (m.tiles.length !== n) fails.push(`tile count ${m.tiles.length} != ${n}`)
  const E = 0.5
  for (const t of m.tiles) {
    const b = t.box
    if (b.left < -E || b.top < -E || b.right > m.w + E || b.bottom > m.h + E) fails.push(`tile ${t.id} outside the viewport ${JSON.stringify(b)}`)
    if (t.col && (b.top < t.col.top - E || b.bottom > t.col.bottom + E)) fails.push(`tile ${t.id} cut by its column (scrolled out of view): tile ${b.top.toFixed(0)}-${b.bottom.toFixed(0)}, column ${t.col.top.toFixed(0)}-${t.col.bottom.toFixed(0)}`)
    if (t.nameClipped) fails.push(`tile ${t.id} name "${t.name}" is clipped`)
  }
  for (let i = 0; i < m.tiles.length; i++)
    for (let j = i + 1; j < m.tiles.length; j++)
      if (overlap(m.tiles[i].box, m.tiles[j].box)) fails.push(`tiles ${m.tiles[i].id} and ${m.tiles[j].id} overlap`)
  const r = ringSize(m.w, m.h) / 2
  const intoRing = m.tiles.filter((t) => intoCircle(t.box, m.w / 2, m.h / 2, r))
  facts.push(`ring r=${r.toFixed(0)}px: ${intoRing.length} tile(s) reach into it`)
  for (const t of intoRing) fails.push(`tile ${t.id} reaches into the core ring`)
  let gap = Infinity
  for (const t of m.tiles) {
    const b = t.box
    const dx = Math.max(b.left - m.w / 2, m.w / 2 - b.right, 0)
    const dy = Math.max(b.top - m.h / 2, m.h / 2 - b.bottom, 0)
    gap = Math.min(gap, Math.hypot(dx, dy) - r)
  }
  if (m.tiles.length) facts.push(`nearest tile is ${gap.toFixed(0)}px outside the ring`)
  facts.push(`orb names ${m.names.length}, layer opacity ${m.orbOpacity}, phase ${m.phase}`)
  if (m.names.length !== n) fails.push(`orb name count ${m.names.length} != ${n}`)
  for (let i = 0; i < m.names.length; i++)
    for (let j = i + 1; j < m.names.length; j++)
      if (overlap(m.names[i].box, m.names[j].box)) fails.push(`orb names ${m.names[i].name} and ${m.names[j].name} overlap`)
  const onTiles = m.names.filter((o) => m.tiles.some((t) => overlap(o.box, t.box)))
  facts.push(`orb names under a tile: ${onTiles.length}`)
  for (const o of onTiles) fails.push(`orb name ${o.name} is under a tile`)
  return { facts, fails }
}

// ---------------------------------------------------------------- main
async function main() {
  if (!SIZES.length) throw new Error('no sizes')
  fs.mkdirSync(TMP, { recursive: true })
  const busy = Object.values(PORT).filter((p) => listeners(p).length)
  if (busy.length) throw new Error(`refusing to start: port(s) ${busy.join(', ')} already in use`)

  // 1. the fake bridge: answers with whatever team is current
  let current = SIZES[0]
  bridge = new WebSocketServer({ port: PORT.bridge, host: '127.0.0.1' })
  bridge.on('connection', (socket) => {
    socket.on('error', () => {})
    socket.on('message', () => {}) // face, diag, ask: ignored
    socket.send(JSON.stringify({ type: 'ready', servers: [] }))
    const t = team(current) // built now, so the done run is inside its 8s hold
    socket.send(JSON.stringify({ type: 'team', roster: t.roster, runs: t.runs }))
  })
  await new Promise((r, j) => { bridge.once('listening', r); bridge.once('error', j) })
  say(`fake bridge on 127.0.0.1:${PORT.bridge}`)

  // 2. scratch vite
  const vite = startProc('vite', process.execPath, ['node_modules/vite/bin/vite.js', '--config', 'scripts/mic-proof.vite.config.mjs'], {
    cwd: W,
    env: {
      ...process.env,
      MIC_PROOF_PORT: String(PORT.vite),
      MIC_PROOF_CACHE: `${TMP}/vite-cache`,
      VITE_BACKEND: 'bridge',
      VITE_BRIDGE_URL: `ws://127.0.0.1:${PORT.bridge}`,
      VITE_USE_ELEVENLABS: 'false',
      VITE_ELEVENLABS_API_KEY: '',
    },
  })
  await waitFor('vite', async () => ({ ok: (await fetch(`${ORIGIN}/`)).ok }), 90e3)
  if (!listeners(PORT.vite).includes(vite.pid)) throw new Error(`:${PORT.vite} is not held by the spawned vite pid`)

  // 3. silent headless chrome
  const flags = ['--headless=new', `--remote-debugging-port=${PORT.cdp}`, `--user-data-dir=${TMP}/profile`, '--no-first-run',
    '--no-default-browser-check', '--mute-audio', '--deny-permission-prompts', '--disable-extensions',
    `--window-size=${VIEW.width},${VIEW.height}`, '--hide-scrollbars', 'about:blank']
  startProc('chrome', CHROME, flags, {})
  const page = await waitFor('chrome page', async () => {
    const t = (await (await fetch(`http://127.0.0.1:${PORT.cdp}/json`)).json()).find((x) => x.type === 'page')
    return { ok: Boolean(t), t }
  }, 30e3)
  const c = await Cdp.open(page.t.webSocketDebuggerUrl)
  await c.send('Page.enable')
  await c.send('Runtime.enable')
  await c.send('Emulation.setDeviceMetricsOverride', { width: VIEW.width, height: VIEW.height, deviceScaleFactor: 1, mobile: false })

  let failed = 0
  const shots = []
  for (const n of SIZES) {
    current = n
    await c.send('Page.navigate', { url: `${ORIGIN}/` })
    await sleep(500)
    await waitFor('document', async () => ({ ok: (await ev(c, 'document.readyState')) === 'complete' }), 90e3)
    // Show the HUD without INITIALISE (no audio): the page's own phase hook
    // (dev-only __venom, src/store.ts) hides the ignition overlay, and the
    // app's own bridge module opens its socket (warmBridge, which INITIALISE
    // would call) so the fake bridge's team snapshot lands in the store.
    await waitFor('tiles', async () => {
      const k = await ev(c, `(() => {
        try { if (window.__venom && window.__venom.phase !== 'dormant') window.__venom.setPhase('dormant') } catch {}
        if (!window.__rosterWarm) window.__rosterWarm = import('/src/lib/bridge.ts').then((m) => m.warmBridge()).catch((e) => { window.__rosterWarm = null; return String(e) })
        return document.querySelectorAll('.tile').length
      })()`)
      return { ok: k === n, info: `${k} tiles` }
    }, 90e3)
    await sleep(SETTLE)
    const m = await ev(c, MEASURE)
    const file = `${OUT}/agents-${String(n).padStart(2, '0')}${VIEW.width === 1920 && VIEW.height === 1080 ? '' : `-${VIEW.width}x${VIEW.height}`}.png`
    const shot = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: VIEW.width, height: VIEW.height, scale: 1 } })
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    shots.push(file)
    const { facts, fails } = check(n, m)
    console.log(`\n== ${n} agent(s) at ${m.w}x${m.h}: ${fails.length ? 'FAIL' : 'PASS'}`)
    for (const f of facts) console.log(`   ${f}`)
    for (const f of fails) console.log(`   FAIL ${f}`)
    if (m.initialise) console.log('   (INITIALISE still showing: not clicked)')
    console.log(`   png ${file}`)
    if (fails.length) failed++
  }
  try { c.ws.close() } catch {}
  console.log(`\nPNGs:\n${shots.join('\n')}`)
  return failed
}

let code = 1
try {
  code = (await main()) ? 1 : 0
} catch (e) {
  console.error('ERROR', e?.stack ?? e)
  code = 1
} finally {
  cleanupSync()
  await sleep(500)
  const left = procs.filter((p) => alive(p.pid))
  const ports = Object.values(PORT).filter((p) => listeners(p).length)
  say(`cleanup: our processes alive ${left.length ? left.map((p) => p.role + ' ' + p.pid).join(', ') : 'none'}; ports busy ${ports.join(', ') || 'none'}`)
}
process.exit(code)
