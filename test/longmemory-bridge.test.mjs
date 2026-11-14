// Long-term memory, end to end on a real bridge: bridge/server.mjs on a free
// port, its Agent SDK driving scripts/fake-cli.mjs, and a tiny HTTP server on
// loopback playing Honcho. Checked: the banner, /health, that a finished turn
// reaches "Honcho" as the two texts the local log gets, that a late interrupt
// cuts the stored turn back to what was heard, and that a failing service
// never holds up a turn.
//
// Every folder the bridge could write to is a temp dir, HERMES_HOME is an
// empty temp dir (so no real honcho.json or key is read), and the only
// "Honcho" is the fake on 127.0.0.1.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { interruptedAnswer } from '../bridge/interruption.mjs'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const FAKE_CLI = fileURLToPath(new URL('../scripts/fake-cli.mjs', import.meta.url))
const ORIGIN = 'http://localhost:5173'
const KEY = 'test-key-not-real'

const FIRST = 'The RTX 5090 is in stock at three sellers.'
const FULL = `${FIRST} The cheapest is 9,499 dollars. Shall I open the listing?`

/** Today's date, local, as the bridge names its day files and sessions. */
function today() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
const MESSAGES_PATH = `/v3/workspaces/testws/sessions/venom-os-${today()}/messages`

let dir, memDir, bridge, honcho
/** Every request the fake Honcho received. */
const requests = []
/** When set, the fake answers the messages POST with this status. */
let failMessages = 0

/** The fake Honcho: records each request and answers like the real API. */
function startHoncho() {
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
      const r = { method: req.method, path, body, auth: Boolean(req.headers.authorization), status: 0 }
      requests.push(r)
      const reply = (status, obj) => {
        r.status = status
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(obj))
      }
      if (req.method === 'POST' && path.endsWith('/sessions')) return reply(200, { id: body?.id ?? 's' })
      if (req.method === 'POST' && path.endsWith('/messages')) {
        if (failMessages) return reply(failMessages, { detail: 'unavailable' })
        return reply(201, [{ id: 'm1' }, { id: 'm2' }])
      }
      if (req.method === 'GET' && path.endsWith('/card')) return reply(200, { peer_card: [] })
      if (req.method === 'GET' && path.endsWith('/context')) {
        return reply(200, { peer_id: 'venom', target_id: 'owner', representation: '', peer_card: [] })
      }
      if (req.method === 'POST' && path.endsWith('/search')) return reply(200, [])
      reply(404, { detail: 'not found' })
    })
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })))
}

/** Start the bridge; resolves once it prints its port. */
function startBridge(env) {
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
        resolve({ child, port: Number(m[1]), output: () => out })
      }
    })
    child.stderr.on('data', (d) => (out += d))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code}: ${out}`))
    })
  })
}

/** A socket to the bridge plus `next(pred)`, which waits for a matching frame. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${bridge.port}`, { headers: { Origin: ORIGIN } })
  const frames = []
  const waiters = []
  ws.on('message', (raw) => {
    const f = JSON.parse(raw.toString())
    frames.push(f)
    for (const w of [...waiters]) if (w.pred(f)) w.hit(f)
  })
  await new Promise((resolve, reject) => {
    ws.once('open', resolve)
    ws.once('error', reject)
  })
  const next = (pred, ms = 15_000) =>
    new Promise((resolve, reject) => {
      const seen = frames.find(pred)
      if (seen) return resolve(seen)
      const w = {
        pred,
        hit: (f) => {
          clearTimeout(timer)
          waiters.splice(waiters.indexOf(w), 1)
          resolve(f)
        },
      }
      const timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(w), 1)
        reject(new Error(`no matching frame in ${ms} ms; got ${JSON.stringify(frames)}`))
      }, ms)
      waiters.push(w)
    })
  const send = (o) => ws.send(JSON.stringify(o))
  const close = () =>
    new Promise((resolve) => {
      ws.once('close', resolve)
      ws.close()
    })
  return { send, next, close, frames }
}

/** Poll until `ok()` holds (or give up after `ms`). */
async function until(ok, ms = 3000) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
  return ok()
}

/** The messages POSTs whose owner message is `q`. */
const postsFor = (q) =>
  requests.filter((r) => r.method === 'POST' && r.path === MESSAGES_PATH && r.body?.messages?.[0]?.content === q)

/** Today's local conversation log lines. */
function logged() {
  const file = join(memDir, 'conversations', `${today()}.jsonl`)
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
}

async function health() {
  const res = await fetch(`http://127.0.0.1:${bridge.port}/health`, { headers: { Origin: ORIGIN } })
  assert.equal(res.status, 200)
  return res.json()
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'venom-longmem-bridge-'))
  for (const d of ['memory', 'hermes', 'hermes-home', 'workspace', 'agents']) mkdirSync(join(dir, d))
  memDir = join(dir, 'memory')
  writeFileSync(join(dir, 'hermes', 'MEMORY.md'), '')
  honcho = await startHoncho()
  bridge = await startBridge({
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
    VENOM_HONCHO: '1',
    VENOM_HONCHO_URL: `http://127.0.0.1:${honcho.port}`,
    VENOM_HONCHO_API_KEY: KEY,
    VENOM_HONCHO_WORKSPACE: 'testws',
    VENOM_HONCHO_HOLD_MS: '300',
    HERMES_HOME: join(dir, 'hermes-home'),
    VENOM_VAULT_DIR: join(dir, 'vault'),
    VENOM_GRAPH_FILE: join(dir, 'graph.json'),
  })
})

after(async () => {
  if (bridge && bridge.child.exitCode === null) {
    const gone = new Promise((r) => bridge.child.once('exit', r))
    bridge.child.kill()
    await gone
  }
  if (honcho) await new Promise((r) => honcho.server.close(r))
  // The fake CLI children can hold the workspace (their cwd) a moment longer.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  // None of this test's questions may have reached the owner's real log.
  const real = join(homedir(), '.venom', 'memory', 'conversations')
  if (existsSync(real)) {
    for (const f of readdirSync(real)) {
      assert.ok(!readFileSync(join(real, f), 'utf8').includes('#longmem'), `test turn leaked into ${f}`)
    }
  }
})

test('a: the banner says long-term memory is on and reachable, and never shows the key', async () => {
  const ok = await until(() => /long-term memory: Honcho reachable \(\d+ ms\)/.test(bridge.output()), 8000)
  assert.ok(ok, bridge.output())
  assert.ok(bridge.output().includes('long-term memory'))
  assert.ok(!bridge.output().includes('NOT reachable'), bridge.output())
  assert.ok(!bridge.output().includes(KEY), 'the key must never be printed')
  // The ping reached the fake, with the key in the header only.
  assert.ok(requests.some((r) => r.method === 'GET' && r.path.endsWith('/card')), JSON.stringify(requests))
  assert.ok(requests.every((r) => r.auth), 'every call carries Authorization')
})

test('b: /health reports the long-term memory state and nothing secret', async () => {
  const h = await health()
  assert.equal(h.ok, true)
  assert.equal(h.memory.label, 'Honcho')
  assert.equal(h.memory.state, 'ok')
  assert.deepEqual(Object.keys(h.memory).sort(), ['label', 'provider', 'queued', 'state'])
  const ms = await (await fetch(`http://127.0.0.1:${bridge.port}/memory/sources`, { headers: { Origin: ORIGIN } })).json()
  assert.deepEqual(ms.rows.map((r) => r.id), ['honcho', 'notes', 'skills', 'vault', 'graph', 'log'])
  assert.ok(!JSON.stringify(ms).includes(KEY) && !JSON.stringify(ms).includes('venom-longmem-bridge-'))
  assert.ok(!JSON.stringify(h).includes(KEY))
})

test('c: a finished turn reaches Honcho as one messages call, after the local log', { timeout: 20_000 }, async () => {
  const q = 'Is the RTX 5090 in stock? #stock #longmem C'
  const c = await connect()
  c.send({ type: 'ask', text: q, id: 'c1' })
  const done = await c.next((f) => f.type === 'done' && f.ask === 'c1')
  assert.equal(done.text, FULL)
  assert.ok(await until(() => postsFor(q).length > 0, 2500), JSON.stringify(requests))
  // Give a stray duplicate a moment to show up.
  await new Promise((r) => setTimeout(r, 200))
  await c.close()
  const posts = postsFor(q)
  assert.equal(posts.length, 1, JSON.stringify(posts))
  const [owner, venom] = posts[0].body.messages
  assert.equal(posts[0].body.messages.length, 2)
  assert.equal(owner.peer_id, 'owner')
  assert.equal(owner.content, q)
  assert.equal(venom.peer_id, 'venom')
  assert.equal(venom.content, FULL)
  assert.equal(owner.metadata.source, 'venom-os')
  assert.equal(venom.metadata.source, 'venom-os')
  // The session was created before its first message, once.
  const sessions = requests.filter((r) => r.method === 'POST' && r.path === '/v3/workspaces/testws/sessions')
  assert.equal(sessions.length, 1, JSON.stringify(sessions))
  assert.equal(sessions[0].body.id, `venom-os-${today()}`)
  assert.ok(requests.indexOf(sessions[0]) < requests.indexOf(posts[0]))
  // The local log is the record and has the same turn.
  assert.ok(logged().some((l) => l.user === q && l.assistant === FULL), JSON.stringify(logged()))
})

test('d: a late interrupt cuts the stored turn back to what was heard', { timeout: 20_000 }, async () => {
  const q = 'Is the RTX 5090 in stock? #stock #longmem D'
  const c = await connect()
  c.send({ type: 'ask', text: q, id: 'd1' })
  await c.next((f) => f.type === 'done' && f.ask === 'd1')
  // Well inside the 300 ms hold: he had heard only the first sentence.
  c.send({ type: 'interrupt', spoken: FIRST })
  assert.ok(await until(() => postsFor(q).length > 0, 2500), JSON.stringify(requests))
  await new Promise((r) => setTimeout(r, 200))
  await c.close()
  const posts = postsFor(q)
  assert.equal(posts.length, 1, JSON.stringify(posts))
  const venom = posts[0].body.messages[1]
  assert.equal(venom.content, interruptedAnswer(FIRST))
  assert.ok(venom.content.includes('[interrupted by the owner here]'), venom.content)
  assert.ok(!venom.content.includes('cheapest'), venom.content)
  // The local log was cut back the same way.
  const line = logged().find((l) => l.user === q)
  assert.equal(line?.assistant, interruptedAnswer(FIRST))
})

test('e: a failing Honcho never holds up a turn; the turn waits in the queue', { timeout: 20_000 }, async () => {
  failMessages = 503
  const q = 'Remember the plan #longmem E'
  const c = await connect()
  c.send({ type: 'ask', text: q, id: 'e1' })
  const done = await c.next((f) => f.type === 'done' && f.ask === 'e1')
  assert.equal(done.text, 'Noted.')
  // The send is tried after the hold and refused.
  assert.ok(await until(() => postsFor(q).some((r) => r.status === 503), 3000), JSON.stringify(requests))
  await c.close()
  const h = await health()
  assert.ok(h.memory.queued >= 1, JSON.stringify(h.memory))
  assert.ok(logged().some((l) => l.user === q), 'the local log has it regardless')
})
