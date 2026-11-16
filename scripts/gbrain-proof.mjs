#!/usr/bin/env node
/**
 * Proof that a Venom OS voice turn reaches GBrain and comes back, end to end,
 * with measured times. Not a test: `npm test` never runs it.
 *
 *   node scripts/gbrain-proof.mjs [--url <base>] [--token-file <path>]
 *     [--write] [--bridge] [--runs N] [--out <json file>] [--real-brain]
 *
 *   (always)   read only: /health, whoami, search timings, profile shape
 *   --write    stores ONE marked exchange, writes it again (must be a no-op),
 *              finds it, and (not on the real brain) times 5 more writes
 *   --bridge   starts a throwaway bridge with the fake CLI against this GBrain,
 *              asks once and finds the turn; then once more against a dead port
 *
 * Safety: on the real brain (port 3131) --bridge is refused, and --write is
 * refused unless --real-brain is also given (then it writes one exchange only).
 * The token is never printed, logged or written anywhere.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { GBRAIN_REAL_PORT, createGbrainProvider, gbrainConfig, turnSlug } from '../bridge/gbrain.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SERVER = join(ROOT, 'bridge', 'server.mjs')
const FAKE_CLI = join(ROOT, 'scripts', 'fake-cli.mjs')
const ORIGIN = 'http://localhost:5173'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  return i >= 0 && i + 1 < args.length ? String(args[i + 1]) : ''
}
const WRITE = flag('--write')
const BRIDGE = flag('--bridge')
const REAL_OK = flag('--real-brain')
const RUNS = Math.max(1, Math.floor(Number(value('--runs'))) || 10)
const OUT = value('--out')

const env = { ...process.env, VENOM_GBRAIN: '1' }
if (value('--url')) env.VENOM_GBRAIN_URL = value('--url')
if (value('--token-file')) env.VENOM_GBRAIN_TOKEN_FILE = value('--token-file')
delete env.NODE_TEST_CONTEXT
const cfg = gbrainConfig(env)
if (!cfg.enabled) {
  console.log(`GBrain is not enabled: ${cfg.why}`)
  process.exit(1)
}
const REAL = cfg.port === GBRAIN_REAL_PORT
console.log(`GBrain at ${cfg.baseUrl} (port ${cfg.port}${REAL ? ', the REAL brain' : ', not the real brain'}) · token: set, not shown`)

if (REAL && BRIDGE) {
  console.log('Refused: --bridge never runs against the real brain on port 3131.')
  process.exit(1)
}
if (REAL && WRITE && !REAL_OK) {
  console.log('Refused: --write on the real brain (port 3131) needs --real-brain as well; nothing was written.')
  process.exit(1)
}

const now = () => performance.now()
const msSince = (t0) => Math.round(now() - t0)
const sleep = (n) => new Promise((r) => setTimeout(r, n))
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b)
  const mid = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2
  return { n: s.length, min: s[0], median: mid, max: s[s.length - 1] }
}
const fmt = (st) => `min ${st.min} / median ${st.median} / max ${st.max} ms (${st.n} runs)`

let failures = 0
const result = { baseUrl: cfg.baseUrl, port: cfg.port, runs: RUNS, steps: {} }
function verdict(ok, step, reason) {
  if (!ok) failures++
  console.log(`${ok ? 'PASS' : 'FAIL'} ${step}: ${reason}`)
  return ok
}

/** One MCP tool call made here (for whoami's scopes). The token stays in the header. */
async function mcp(name, a = {}) {
  const res = await fetch(`${cfg.baseUrl}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${cfg.token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: a } }),
    signal: AbortSignal.timeout(5000),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status} on ${name}`)
  const text = await res.text()
  const line = text.split(/\r?\n/).find((l) => l.startsWith('data:'))
  const envl = JSON.parse(line ? line.slice(5).trim() : text)
  const raw = envl?.result?.content?.find((c) => c?.type === 'text')?.text
  if (envl?.result?.isError) throw new Error(`tool error on ${name}`)
  return JSON.parse(raw)
}

const provider = createGbrainProvider(cfg)

// ---- Step 1: read only ----------------------------------------------------
console.log('\n== Step 1: read only')
try {
  let t0 = now()
  const hres = await fetch(`${cfg.baseUrl}/health`, { signal: AbortSignal.timeout(5000) })
  const h = await hres.json()
  const healthMs = msSince(t0)
  console.log(`health: HTTP ${hres.status} status ${h.status} · version ${h.version} · engine ${h.engine} · ${healthMs} ms`)
  result.steps.health = { http: hres.status, status: h.status, version: h.version, engine: h.engine, ms: healthMs }
  verdict(hres.status === 200 && h.status === 'ok', 'health', `status ${h.status}`)

  t0 = now()
  const who = await mcp('whoami')
  const whoMs = msSince(t0)
  const scopes = Array.isArray(who?.scopes) ? who.scopes : []
  console.log(`whoami: scopes [${scopes.join(', ')}] · ${whoMs} ms`)
  const ping = await provider.ping()
  console.log(`provider.ping: ${ping.ok ? 'ok' : 'failed: ' + ping.error} · ${ping.ms} ms`)
  result.steps.whoami = { scopes, ms: whoMs, pingOk: ping.ok, pingMs: ping.ms }
  verdict(ping.ok && scopes.includes('read'), 'whoami/ping', `scopes ${scopes.join(',') || 'none'}, ping ${ping.ok ? 'ok' : 'failed'}`)

  const times = []
  let hits = 0
  for (let i = 0; i < RUNS; i++) {
    t0 = now()
    hits = (await provider.search('venom os proof marker', { limit: 5 })).length
    times.push(msSince(t0))
  }
  const st = stats(times)
  console.log(`search 'venom os proof marker' x${RUNS}: ${hits} hit(s) · ${fmt(st)}`)
  result.steps.search = { hits, ...st }
  verdict(true, 'search', `${RUNS} searches answered`)

  t0 = now()
  const prof = await provider.profile()
  const profMs = msSince(t0)
  console.log(`profile: ${prof.card.length} card line(s), summary ${prof.representation ? 'present' : 'absent'} · ${profMs} ms (text not printed)`)
  result.steps.profile = { cardLines: prof.card.length, summary: Boolean(prof.representation), ms: profMs }
  verdict(true, 'profile', 'answered')
} catch (err) {
  verdict(false, 'step 1', err?.message ?? String(err))
}

// ---- Step 2: one marked write ---------------------------------------------
if (WRITE) {
  console.log('\n== Step 2: write one marked exchange')
  const written = []
  try {
    const marker = 'proof' + Date.now().toString(36)
    const turn = {
      user: `Venom OS proof ${marker}: what is the test word?`,
      assistant: `The test word is ${marker}.`,
      ts: new Date(),
      session: 'gbrain-proof',
    }
    const slug = turnSlug(turn)
    console.log(`marker ${marker}`)
    let t0 = now()
    const w1 = await provider.writeTurn(turn)
    const w1ms = msSince(t0)
    const tWritten = now()
    written.push(w1.ids[0])
    console.log(`write 1: ${w1ms} ms · slug ${w1.ids[0]} · duplicate ${w1.duplicate}`)
    verdict(w1.ids[0] === slug && !w1.duplicate, 'write', `slug ${w1.ids[0]}`)

    t0 = now()
    const w2 = await provider.writeTurn(turn)
    const w2ms = msSince(t0)
    console.log(`write 2 (same turn, same ts): ${w2ms} ms · duplicate ${w2.duplicate}`)
    t0 = now()
    const w3 = await createGbrainProvider(cfg).writeTurn(turn)
    const w3ms = msSince(t0)
    console.log(`write 3 (fresh provider, same turn): ${w3ms} ms · duplicate ${w3.duplicate}`)
    verdict(w2.ids[0] === slug && w3.ids[0] === slug, 'rewrite', 'the same turn again did not throw and kept its slug')

    let found = null
    const end = now() + 5000
    while (!found && now() < end) {
      const r = await provider.search(marker, { limit: 8 })
      if (r.some((h) => h.text.includes(marker))) found = r
      else await sleep(100)
    }
    const findMs = msSince(tWritten)
    const mine = (found || []).filter((h) => h.text.includes(marker))
    const owner = mine.filter((h) => h.who === 'owner').length
    const venom = mine.filter((h) => h.who === 'venom').length
    console.log(`findable ${found ? findMs + ' ms after write 1' : 'NOT within 5 s'} · marker hits: ${mine.length} (owner ${owner}, venom ${venom})`)
    verdict(Boolean(found) && owner === 1 && venom === 1 && mine.length === 2, 'recall', `owner ${owner}, venom ${venom}: stored once`)

    const times = []
    for (let i = 0; i < RUNS; i++) {
      t0 = now()
      await provider.search(marker, { limit: 8 })
      times.push(msSince(t0))
    }
    const st = stats(times)
    console.log(`search for the marker x${RUNS}: ${fmt(st)}`)
    result.steps.write = {
      marker,
      user: turn.user,
      assistant: turn.assistant,
      slug,
      writeMs: w1ms,
      rewriteMs: w2ms,
      rewriteDuplicate: w2.duplicate,
      freshProviderMs: w3ms,
      freshProviderDuplicate: w3.duplicate,
      findableAfterMs: found ? findMs : null,
      markerHits: mine.length,
      search: st,
    }

    if (!REAL) {
      const wt = []
      for (let i = 0; i < 5; i++) {
        const m = `${marker}x${i}`
        t0 = now()
        const w = await provider.writeTurn({ user: `Venom OS proof ${m}: what is the test word?`, assistant: `The test word is ${m}.`, ts: new Date() })
        wt.push(msSince(t0))
        written.push(w.ids[0])
      }
      const ws = stats(wt)
      console.log(`5 more distinct writes: ${fmt(ws)}`)
      result.steps.write.moreWrites = ws
      verdict(true, 'write timing', '5 distinct writes stored')
    }
  } catch (err) {
    verdict(false, 'step 2', err?.message ?? String(err))
  }
  console.log(`slugs written (remove later): ${written.join(' ') || 'none'}`)
  result.steps.slugsWritten = written
}

// ---- Step 3: a throwaway bridge -------------------------------------------
const children = []

/** A loopback port where nothing listens. */
function deadPort() {
  return new Promise((resolve) => {
    const s = createServer()
    s.listen(0, '127.0.0.1', () => {
      const p = s.address().port
      s.close(() => resolve(p))
    })
  })
}

function startBridge(benv) {
  const child = spawn(process.execPath, [SERVER], { env: benv, cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('bridge did not start in 20 s'))
    }, 20_000)
    child.stdout.on('data', (d) => {
      out += d
      const m = /listening on ws:\/\/\S+?:(\d+)/.exec(out)
      if (m && timer) {
        clearTimeout(timer)
        resolve({ child, port: Number(m[1]), output: () => out })
      }
    })
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code}`))
    })
  })
}

async function stopBridge(b) {
  if (b.child.exitCode !== null) return b.child.exitCode
  const gone = new Promise((r) => b.child.once('exit', (code, sig) => r(sig || code)))
  b.child.kill()
  return gone
}

async function ask(b, text, id) {
  const ws = new WebSocket(`ws://127.0.0.1:${b.port}`, { headers: { Origin: ORIGIN } })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no done in 20 s')), 20_000)
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      if (f.type === 'done' && f.ask === id) {
        clearTimeout(timer)
        resolve(f)
      }
    })
  })
  const t0 = now()
  ws.send(JSON.stringify({ type: 'ask', text, id }))
  await done
  const took = msSince(t0)
  const tDone = now()
  ws.close()
  return { took, tDone }
}

const getJson = async (b, path) =>
  (await fetch(`http://127.0.0.1:${b.port}${path}`, { headers: { Origin: ORIGIN }, signal: AbortSignal.timeout(10_000) })).json()

const startLines = (b) =>
  b
    .output()
    .split(/\r?\n/)
    .filter((l) => l.includes('long-term memory'))

function bridgeEnv(dir, url) {
  const benv = {
    ...process.env,
    VENOM_BRIDGE_PORT: '0',
    VENOM_CLAUDE_EXECUTABLE: FAKE_CLI,
    VENOM_MCP_SERVERS: '',
    VENOM_DISABLE: 'browser,camera',
    VENOM_AGENT_ACTIVITY: '0',
    VENOM_LOCAL_STT: '0',
    VENOM_AGENTS_DIR: join(dir, 'agents'),
    VENOM_WORKSPACE: join(dir, 'workspace'),
    VENOM_MEMORY_DIR: join(dir, 'memory'),
    VENOM_HERMES_MEMORY_DIR: join(dir, 'hermes'),
    HERMES_HOME: join(dir, 'hermes-home'),
    VENOM_VAULT_DIR: join(dir, 'vault'),
    VENOM_GRAPH_FILE: join(dir, 'graph.json'),
    VENOM_MEMORY: '1',
    VENOM_HONCHO: '0',
    VENOM_GBRAIN: '1',
    VENOM_GBRAIN_URL: url,
    VENOM_GBRAIN_TOKEN_FILE: cfg.tokenFile,
    VENOM_GBRAIN_HOLD_MS: '300',
    VENOM_GBRAIN_START_CMD: join(dir, 'no-such-start.cmd'),
  }
  delete benv.NODE_TEST_CONTEXT
  return benv
}

function freshDir() {
  const dir = mkdtempSync(join(tmpdir(), 'venom-gbrain-proof-'))
  for (const d of ['memory', 'hermes', 'hermes-home', 'workspace', 'agents']) mkdirSync(join(dir, d))
  writeFileSync(join(dir, 'hermes', 'MEMORY.md'), '')
  return dir
}

if (BRIDGE) {
  const dirs = []
  result.steps.bridge = {}
  // (a) GBrain up.
  console.log('\n== Step 3a: throwaway bridge, GBrain up')
  let b = null
  try {
    const dir = freshDir()
    dirs.push(dir)
    b = await startBridge(bridgeEnv(dir, cfg.baseUrl))
    await sleep(1500) // the reachability line comes after the listening line
    console.log(`bridge on port ${b.port}`)
    for (const l of startLines(b)) console.log(`  | ${l}`)
    const h = await getJson(b, '/health')
    console.log(`/health memory: ${JSON.stringify(h.memory)}`)
    const src = await getJson(b, '/memory/sources')
    const r0 = src?.rows?.[0] || {}
    console.log(`/memory/sources row 0: id ${r0.id} · label ${r0.label} · state ${r0.state} · detail ${r0.detail}`)
    verdict(h.memory?.provider === 'gbrain', 'bridge up start', `memory provider ${h.memory?.provider}, state ${h.memory?.state}`)

    const marker = 'proofb' + Date.now().toString(36)
    const { took, tDone } = await ask(b, `Venom OS bridge proof ${marker}: what is the test word?`, 'proof-up')
    console.log(`ask -> done: ${took} ms`)
    let found = false
    const end = now() + 10_000
    while (!found && now() < end) {
      const r = await provider.search(marker, { limit: 8 })
      found = r.some((x) => x.who === 'owner' && x.text.includes(marker))
      if (!found) await sleep(100)
    }
    const after = msSince(tDone)
    console.log(`turn findable in GBrain: ${found ? after + ' ms after done' : 'NOT within 10 s'}`)
    const h2 = await getJson(b, '/health')
    console.log(`/health memory: state ${h2.memory?.state} · queued ${h2.memory?.queued}`)
    result.steps.bridge.up = { askToDoneMs: took, findableAfterDoneMs: found ? after : null, marker, state: h2.memory?.state, queued: h2.memory?.queued }
    verdict(found && h2.memory?.queued === 0, 'bridge up turn', found ? 'written by the bridge and found by search' : 'not found')
  } catch (err) {
    verdict(false, 'step 3a', err?.message ?? String(err))
  } finally {
    if (b) console.log(`bridge stopped: exit ${await stopBridge(b)}`)
  }

  // (b) GBrain down.
  console.log('\n== Step 3b: throwaway bridge, GBrain down')
  b = null
  try {
    const dir = freshDir()
    dirs.push(dir)
    const port = await deadPort()
    b = await startBridge(bridgeEnv(dir, `http://127.0.0.1:${port}`))
    // Wait for the reachability verdict line.
    const tEnd = now() + 8000
    while (!startLines(b).some((l) => /reachable/.test(l)) && now() < tEnd) await sleep(100)
    console.log(`bridge on port ${b.port}, GBrain URL on dead port ${port}`)
    for (const l of startLines(b)) console.log(`  | ${l}`)
    const notReach = startLines(b).some((l) => l.includes('NOT reachable'))
    const { took } = await ask(b, `Venom OS bridge proof down ${Date.now().toString(36)}: hello`, 'proof-down')
    console.log(`ask -> done: ${took} ms`)
    let mem = null
    const end = now() + 8000
    while (now() < end) {
      mem = (await getJson(b, '/health')).memory
      if (mem?.state === 'offline' && mem?.queued === 1) break
      await sleep(200)
    }
    console.log(`/health memory: ${JSON.stringify(mem)}`)
    const file = join(dir, 'memory', 'outbox-gbrain.json')
    let n = -1
    if (existsSync(file)) {
      const raw = readFileSync(file, 'utf8').trim()
      n = raw ? JSON.parse(raw).length : 0
    }
    console.log(`outbox-gbrain.json: ${n < 0 ? 'missing' : n + ' turn(s)'}`)
    result.steps.bridge.down = { askToDoneMs: took, state: mem?.state, queued: mem?.queued, outboxTurns: n }
    verdict(notReach && mem?.state === 'offline' && mem?.queued === 1 && n === 1 && took < 10_000, 'bridge down', `NOT reachable line ${notReach ? 'seen' : 'missing'}, state ${mem?.state}, queued ${mem?.queued}, outbox ${n}`)
  } catch (err) {
    verdict(false, 'step 3b', err?.message ?? String(err))
  } finally {
    if (b) console.log(`bridge stopped: exit ${await stopBridge(b)}`)
  }

  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  const left = children.filter((c) => c.exitCode === null && c.signalCode === null).length
  const gone = dirs.every((d) => !existsSync(d))
  verdict(left === 0 && gone, 'cleanup', `${left} bridge child(ren) left, temp dirs ${gone ? 'removed' : 'NOT removed'}`)
}

result.failures = failures
if (OUT) {
  writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n')
  console.log(`numbers written to ${OUT}`)
}
console.log(`\n${failures ? 'FAIL' : 'PASS'}: ${failures} failure(s)`)
process.exit(failures ? 1 : 0)
