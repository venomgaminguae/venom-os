// GBrain as the long-term memory, end to end on a real bridge: bridge/server.mjs
// on a free port, its Agent SDK driving scripts/fake-cli.mjs, and a tiny HTTP
// server on loopback playing GBrain. Checked: the switch VENOM_GBRAIN=1 picks
// GBrain, a finished turn reaches it as one `capture` with the right token, a
// GBrain that is down never holds up a turn, the switch off leaves GBrain
// alone, and under a test run the real port 3131 is refused.
//
// Every folder the bridge could write to is a temp dir, VENOM_HONCHO=0 always,
// the token is invented and lives in a temp file, and the only "GBrain" is the
// fake on 127.0.0.1. Nothing here opens a connection to port 3131.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const FAKE_CLI = fileURLToPath(new URL('../scripts/fake-cli.mjs', import.meta.url))
const ORIGIN = 'http://localhost:5173'
const TOKEN = 'test-token-abc'

const dirs = []
const bridges = []
const fakes = []

/** A fresh set of temp folders plus a token file. */
function makeDirs() {
  const dir = mkdtempSync(join(tmpdir(), 'venom-gbrain-bridge-'))
  dirs.push(dir)
  for (const d of ['memory', 'hermes', 'hermes-home', 'workspace', 'agents']) mkdirSync(join(dir, d))
  writeFileSync(join(dir, 'hermes', 'MEMORY.md'), '')
  const tokenFile = join(dir, 'gbrain.token')
  writeFileSync(tokenFile, `${TOKEN}\n`)
  return { dir, memDir: join(dir, 'memory'), tokenFile }
}

/** The fake GBrain: records each request and answers like the real server. */
function startGbrain() {
  const requests = []
  const server = createServer((req, res) => {
    let raw = ''
    req.on('data', (d) => (raw += d))
    req.on('end', () => {
      let body = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = raw
      }
      const path = req.url.split('?')[0]
      const r = { method: req.method, path, body, auth: req.headers.authorization || '', tool: body?.params?.name || '' }
      requests.push(r)
      if (req.method === 'GET' && path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify({ status: 'ok', version: 'test', engine: 'pglite' }))
      }
      if (req.method === 'POST' && path === '/mcp') {
        if (r.auth !== `Bearer ${TOKEN}`) {
          res.writeHead(401, { 'content-type': 'application/json' })
          return res.end(JSON.stringify({ error: 'invalid_token' }))
        }
        const args = body?.params?.arguments ?? {}
        let inner
        if (r.tool === 'whoami') inner = { transport: 'http', token_name: 'test', scopes: ['read', 'write'] }
        else if (r.tool === 'capture') inner = { slug: args.slug, status: 'created_or_updated', chunks: 1 }
        else if (r.tool === 'recall') inner = { facts: [], total: 0, results: [] }
        else if (r.tool === 'entity') inner = { found: false, suggestions: [] }
        else inner = { code: 'unknown_tool', retryable: false, class: 'caller', message: 'no such tool' }
        const result = { content: [{ type: 'text', text: JSON.stringify(inner) }] }
        if (inner.code) result.isError = true
        const msg = { result, jsonrpc: '2.0', id: body?.id ?? 1 }
        res.writeHead(200, { 'content-type': 'text/event-stream' })
        return res.end(`event: message\ndata: ${JSON.stringify(msg)}\n\n`)
      }
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
    })
  })
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => {
      const fake = { server, port: server.address().port, requests, closed: false }
      fakes.push(fake)
      resolve(fake)
    }),
  )
}

const closeFake = (fake) =>
  fake.closed
    ? Promise.resolve()
    : new Promise((r) => {
        fake.closed = true
        fake.server.close(r)
        fake.server.closeAllConnections?.()
      })

/** The env every bridge here gets: temp folders, fake CLI, no Honcho. */
function baseEnv({ dir, memDir }) {
  return {
    VENOM_BRIDGE_PORT: '0',
    VENOM_CLAUDE_EXECUTABLE: FAKE_CLI,
    FAKE_CLI_LOG: join(dir, 'fake-cli.log'),
    VENOM_MCP_SERVERS: '',
    VENOM_DISABLE: 'browser,camera',
    VENOM_LOCAL_STT: '0',
    VENOM_AGENT_ACTIVITY: '0',
    VENOM_AGENTS_DIR: join(dir, 'agents'),
    VENOM_WORKSPACE: join(dir, 'workspace'),
    VENOM_MEMORY: '1',
    VENOM_MEMORY_DIR: memDir,
    VENOM_HERMES_MEMORY_DIR: join(dir, 'hermes'),
    VENOM_ALLOW_NO_ORIGIN: '',
    VENOM_ALLOWED_ORIGINS: '',
    VENOM_HONCHO: '0',
    HERMES_HOME: join(dir, 'hermes-home'),
    VENOM_VAULT_DIR: join(dir, 'vault'),
    VENOM_GRAPH_FILE: join(dir, 'graph.json'),
    VENOM_GBRAIN: '',
    VENOM_GBRAIN_URL: '',
    VENOM_GBRAIN_TOKEN_FILE: '',
    VENOM_GBRAIN_START_CMD: join(dir, 'no-such-start.cmd'),
  }
}

/** Start the bridge; resolves once it prints its port. NODE_TEST_CONTEXT is kept. */
function startBridge(env) {
  assert.ok(process.env.NODE_TEST_CONTEXT, 'run under node --test so the bridge sees a test run')
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`bridge did not start: ${out}`))
    }, 20_000)
    child.stdout.on('data', (d) => {
      out += d
      const m = /listening on ws:\/\/\S+?:(\d+)/.exec(out)
      if (m) {
        clearTimeout(timer)
        const b = { child, port: Number(m[1]), output: () => out }
        bridges.push(b)
        resolve(b)
      }
    })
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code}: ${out}`))
    })
  })
}

async function stopBridge(b) {
  if (b && b.child.exitCode === null) {
    const gone = new Promise((r) => b.child.once('exit', r))
    b.child.kill()
    await gone
  }
}

/** Ask one question on a fresh socket; resolves with the `done` frame. */
async function ask(bridge, text, id, ms = 15_000) {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { headers: { Origin: ORIGIN } })
  const frames = []
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no done in ${ms} ms; got ${JSON.stringify(frames)}`)), ms)
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString())
      frames.push(f)
      if (f.type === 'done' && f.ask === id) {
        clearTimeout(timer)
        resolve(f)
      }
    })
  })
  ws.send(JSON.stringify({ type: 'ask', text, id }))
  const t0 = Date.now()
  const f = await done
  const took = Date.now() - t0
  await new Promise((resolve) => {
    ws.once('close', resolve)
    ws.close()
  })
  return { done: f, took }
}

async function health(bridge) {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/health`, { headers: { Origin: ORIGIN } })
  assert.equal(res.status, 200)
  return res.json()
}

/** Poll until `ok()` holds (or give up after `ms`). */
async function until(ok, ms = 3000) {
  const end = Date.now() + ms
  while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 50))
  return ok()
}

/** The turns in the GBrain outbox, or [] when there is no file. */
function outbox(memDir, name = 'gbrain') {
  const file = join(memDir, `outbox-${name}.json`)
  if (!existsSync(file)) return []
  const raw = readFileSync(file, 'utf8').trim()
  return raw ? JSON.parse(raw) : []
}

after(async () => {
  for (const b of bridges) await stopBridge(b)
  for (const f of fakes) await closeFake(f)
  // The fake CLI children can hold the workspace (their cwd) a moment longer.
  for (const d of dirs) rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
})

test('GBrain up: the turn reaches it as one capture with the token', { timeout: 40_000 }, async () => {
  const paths = makeDirs()
  const fake = await startGbrain()
  const bridge = await startBridge({
    ...baseEnv(paths),
    VENOM_GBRAIN: '1',
    VENOM_GBRAIN_URL: `http://127.0.0.1:${fake.port}`,
    VENOM_GBRAIN_TOKEN_FILE: paths.tokenFile,
    VENOM_GBRAIN_HOLD_MS: '300',
  })
  try {
    const h = await health(bridge)
    assert.equal(h.memory.provider, 'gbrain', JSON.stringify(h.memory))
    assert.ok(!bridge.output().includes(TOKEN), 'the token must never be printed')

    const q = 'Is the RTX 5090 in stock? #stock #gbrain UP'
    const { done } = await ask(bridge, q, 'up1')
    assert.equal(done.type, 'done')
    const captures = () => fake.requests.filter((r) => r.tool === 'capture')
    assert.ok(await until(() => captures().length > 0, 5000), JSON.stringify(fake.requests))
    // Give a stray duplicate a moment to show up.
    await new Promise((r) => setTimeout(r, 400))
    const c = captures()
    assert.equal(c.length, 1, JSON.stringify(c))
    assert.equal(c[0].auth, `Bearer ${TOKEN}`)
    assert.ok(String(c[0].body?.params?.arguments?.content).includes(q), JSON.stringify(c[0].body))
    assert.ok(fake.requests.filter((r) => r.path === '/mcp').every((r) => r.auth === `Bearer ${TOKEN}`))

    // The fake CLI got the GBrain wording of the long-term memory block.
    const cliLog = readFileSync(join(paths.dir, 'fake-cli.log'), 'utf8')
    assert.ok(cliLog.includes('facts that VENOM saved'), 'system prompt carries the GBrain recall block')
    assert.ok(!cliLog.includes('and what he says to Hermes in the'), 'not the Honcho wording')

    assert.ok(await until(() => outbox(paths.memDir).length === 0, 3000), 'outbox drained')
    assert.ok(!existsSync(join(paths.memDir, 'outbox-honcho.json')), 'no Honcho outbox')
  } finally {
    await stopBridge(bridge)
    await closeFake(fake)
  }
})

test('GBrain down: the bridge starts, the turn ends normally and waits in the outbox', { timeout: 40_000 }, async () => {
  const paths = makeDirs()
  const fake = await startGbrain()
  const port = fake.port
  await closeFake(fake) // the port now refuses
  const bridge = await startBridge({
    ...baseEnv(paths),
    VENOM_GBRAIN: '1',
    VENOM_GBRAIN_URL: `http://127.0.0.1:${port}`,
    VENOM_GBRAIN_TOKEN_FILE: paths.tokenFile,
    VENOM_GBRAIN_HOLD_MS: '300',
  })
  try {
    const q = 'Remember the plan #gbrain DOWN'
    const { done, took } = await ask(bridge, q, 'down1')
    assert.equal(done.type, 'done')
    assert.ok(took < 10_000, `turn took ${took} ms`)
    assert.ok(
      await until(() => outbox(paths.memDir).some((t) => t.user === q), 5000),
      JSON.stringify(outbox(paths.memDir)),
    )
    assert.equal(outbox(paths.memDir).length, 1)
    let state = ''
    assert.ok(
      await until(async () => {
        state = (await health(bridge)).memory.state
        return state === 'offline'
      }, 8000),
      `memory.state was ${state}`,
    )
    assert.equal((await health(bridge)).memory.provider, 'gbrain')
    assert.ok(!existsSync(join(paths.memDir, 'outbox-honcho.json')), 'no Honcho outbox')
  } finally {
    await stopBridge(bridge)
  }
})

test('switch off: GBrain is not used and receives nothing', { timeout: 40_000 }, async () => {
  const paths = makeDirs()
  const fake = await startGbrain()
  const bridge = await startBridge({
    ...baseEnv(paths),
    // VENOM_GBRAIN left empty: the switch is off. The rest points at the fake
    // so that any stray call would show up there.
    VENOM_GBRAIN_URL: `http://127.0.0.1:${fake.port}`,
    VENOM_GBRAIN_TOKEN_FILE: paths.tokenFile,
    VENOM_GBRAIN_HOLD_MS: '300',
  })
  try {
    const h = await health(bridge)
    assert.notEqual(h.memory.provider, 'gbrain', JSON.stringify(h.memory))
    const { done } = await ask(bridge, 'Hello #gbrain OFF', 'off1')
    assert.equal(done.type, 'done')
    await new Promise((r) => setTimeout(r, 800))
    assert.equal(fake.requests.length, 0, JSON.stringify(fake.requests))
    assert.ok(!existsSync(join(paths.memDir, 'outbox-gbrain.json')))
  } finally {
    await stopBridge(bridge)
    await closeFake(fake)
  }
})

test('guard: under a test run the real GBrain port is refused and memory is off', { timeout: 40_000 }, async () => {
  const paths = makeDirs()
  const bridge = await startBridge({
    ...baseEnv(paths),
    VENOM_GBRAIN: '1',
    // Never contacted: gbrainConfig refuses port 3131 under NODE_TEST_CONTEXT.
    VENOM_GBRAIN_URL: 'http://127.0.0.1:3131',
    VENOM_GBRAIN_TOKEN_FILE: paths.tokenFile,
    VENOM_GBRAIN_HOLD_MS: '300',
  })
  try {
    const h = await health(bridge)
    assert.equal(h.memory.state, 'off', JSON.stringify(h.memory))
    assert.notEqual(h.memory.provider, 'gbrain')
    assert.match(bridge.output(), /long-term memory off \(test run\)/)
    const { done } = await ask(bridge, 'Hello #gbrain GUARD', 'guard1')
    assert.equal(done.type, 'done')
    await new Promise((r) => setTimeout(r, 600))
    assert.ok(!existsSync(join(paths.memDir, 'outbox-gbrain.json')), 'nothing queued for GBrain')
    assert.ok(!bridge.output().includes(TOKEN))
  } finally {
    await stopBridge(bridge)
  }
})
