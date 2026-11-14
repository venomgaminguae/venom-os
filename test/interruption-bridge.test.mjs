// Interruption memory, end to end on a real bridge: a copy of bridge/server.mjs
// on a free port, its Agent SDK driving scripts/fake-cli.mjs instead of
// the claude CLI. The owner asks, VENOM answers in three sentences, he cuts it
// off having heard only the first, then asks again. Checked on both sides:
// what reached the model with the next question, and what the conversation
// log on disk says VENOM answered.
//
// Every folder the bridge could write to is a temp dir (memory, Hermes memory,
// workspace, agents), so nothing here touches the real ~/.venom or Hermes.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { interruptNote, interruptedAnswer } from '../bridge/interruption.mjs'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const FAKE_CLI = fileURLToPath(new URL('../scripts/fake-cli.mjs', import.meta.url))
const ORIGIN = 'http://localhost:5173'

const FIRST = 'The RTX 5090 is in stock at three sellers.'
const FULL = `${FIRST} The cheapest is 9,499 dollars. Shall I open the listing?`
const Q2 = 'Which seller is that?'

let dir, cliLog, memDir, bridge

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
  const next = (pred, ms = 20_000) =>
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

/** Every user message the fake CLI has received, in order. */
function prompts() {
  if (!existsSync(cliLog)) return []
  return readFileSync(cliLog, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((e) => e.stdin)
    .map((e) => JSON.parse(e.stdin))
    .filter((m) => m.type === 'user')
    .map((m) => m.message.content)
}

/** Every line of the conversation log (all day files), in order. */
function logged() {
  const conv = join(memDir, 'conversations')
  if (!existsSync(conv)) return []
  return readdirSync(conv)
    .sort()
    .flatMap((f) => readFileSync(join(conv, f), 'utf8').split('\n').filter(Boolean))
    .map((l) => JSON.parse(l))
}

/**
 * One scenario on a fresh connection: ask Q1, cut it off via `interrupt`
 * (which sends the interrupt frame at the right moment), ask Q2 and wait for
 * its answer. Returns the prompt the model got for Q2 and the log lines this
 * scenario added.
 */
async function scenario(q1, interrupt, report) {
  const p0 = prompts().length
  const l0 = logged().length
  const c = await connect()
  c.send({ type: 'ask', text: q1, id: 'a1' })
  await interrupt(c)
  c.send({ type: 'ask', text: Q2, id: 'a2' })
  await c.next((f) => f.type === 'done' && f.ask === 'a2')
  await c.close()
  const sent = prompts().slice(p0)
  // Q2's line is written just after its 'done' goes out; let it land.
  await until(() => logged().slice(l0).at(-1)?.user === Q2)
  assert.equal(sent.length, 2, `expected 2 prompts, got ${JSON.stringify(sent)}`)
  assert.equal(sent[0], q1, 'Q1 reaches the model untouched')
  const lines = logged().slice(l0)
  // What the model was really told, and what the log really says, on record.
  report?.(`Q2 prompt: ${JSON.stringify(sent[1].slice(0, 300))}`)
  report?.(`log lines: ${JSON.stringify(lines.map(({ user, assistant }) => ({ user, assistant })))}`)
  return { prompt: sent[1], lines, frames: c.frames }
}

/** Poll until `ok()` holds (or give up after `ms`). */
async function until(ok, ms = 5000) {
  const end = Date.now() + ms
  while (!ok() && Date.now() < end) await new Promise((r) => setTimeout(r, 20))
}

/** The assertions every "heard only the first sentence" case shares. */
function assertHeardFirstOnly(prompt) {
  assert.ok(prompt.startsWith('[The owner interrupted your previous answer.'), prompt)
  assert.ok(prompt.startsWith(interruptNote(FIRST)), prompt)
  assert.ok(prompt.includes(FIRST), prompt)
  assert.ok(!prompt.includes('cheapest'), prompt)
  assert.ok(!prompt.includes('Shall I open'), prompt)
  assert.ok(prompt.endsWith(`\n\n${Q2}`), prompt)
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'venom-interrupt-bridge-'))
  for (const d of ['memory', 'hermes', 'workspace', 'agents']) mkdirSync(join(dir, d))
  memDir = join(dir, 'memory')
  cliLog = join(dir, 'fake-cli.log')
  writeFileSync(join(dir, 'hermes', 'MEMORY.md'), '')
  bridge = await startBridge({
    VENOM_BRIDGE_PORT: '0',
    VENOM_CLAUDE_EXECUTABLE: FAKE_CLI,
    FAKE_CLI_LOG: cliLog,
    FAKE_CLI_PAUSE_MS: '5000',
    VENOM_MCP_SERVERS: '',
    VENOM_DISABLE: 'browser,camera',
    VENOM_LOCAL_STT: '0',
    VENOM_AGENT_ACTIVITY: '0',
    VENOM_AGENTS_DIR: join(dir, 'agents'),
    VENOM_WORKSPACE: join(dir, 'workspace'),
    VENOM_MEMORY: '1',
    VENOM_HONCHO: '0',
    VENOM_MEMORY_DIR: memDir,
    VENOM_HERMES_MEMORY_DIR: join(dir, 'hermes'),
    VENOM_ALLOW_NO_ORIGIN: '',
    VENOM_ALLOWED_ORIGINS: '',
  })
})

after(async () => {
  if (bridge && bridge.child.exitCode === null) {
    const gone = new Promise((r) => bridge.child.once('exit', r))
    bridge.child.kill()
    await gone
  }
  // The fake CLI children can hold the workspace (their cwd) a moment longer.
  if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
  // Belt and braces: none of this test's questions may have reached the
  // owner's real conversation log.
  const real = join(homedir(), '.venom', 'memory', 'conversations')
  if (existsSync(real)) {
    for (const f of readdirSync(real)) {
      assert.ok(!readFileSync(join(real, f), 'utf8').includes('#stock'), `test turn leaked into ${f}`)
    }
  }
})

test('A: interrupt after the answer was written: note on the next prompt, logged line cut back', { timeout: 60_000 }, async (t) => {
  const q1 = 'Is the RTX 5090 in stock? #stock A'
  const { prompt, lines } = await scenario(q1, async (c) => {
    const done = await c.next((f) => f.type === 'done' && f.ask === 'a1')
    assert.equal(done.text, FULL, 'the model wrote the whole answer')
    // The full answer is on disk now, as the model wrote it. (The bridge
    // writes it just after sending 'done', so this process can get there first.)
    await until(() => logged().at(-1)?.user === q1)
    assert.equal(logged().at(-1)?.assistant, FULL)
    // ...and the voice had spoken only the first sentence.
    c.send({ type: 'interrupt', spoken: FIRST })
  }, (m) => t.diagnostic(m))
  assertHeardFirstOnly(prompt)
  assert.equal(lines.length, 2, JSON.stringify(lines))
  assert.equal(lines[0].user, q1)
  assert.equal(lines[0].assistant, interruptedAnswer(FIRST))
  assert.ok(!JSON.stringify(lines[0]).includes('cheapest'))
  assert.equal(lines[1].user, Q2, 'the log keeps his own words, without the note')
  assert.equal(lines[1].session, lines[0].session)
})

test('B: interrupt mid-stream: note on the next prompt, log holds only what was heard', { timeout: 60_000 }, async (t) => {
  const q1 = 'Is the RTX 5090 in stock? #stock #slow B'
  const { prompt, lines, frames } = await scenario(q1, async (c) => {
    await c.next((f) => f.type === 'text' && f.ask === 'a1')
    c.send({ type: 'interrupt', spoken: FIRST })
  }, (m) => t.diagnostic(m))
  assertHeardFirstOnly(prompt)
  const a1 = frames.filter((f) => f.ask === 'a1')
  assert.ok(!a1.some((f) => f.type === 'done' || f.type === 'error'), JSON.stringify(a1))
  assert.ok(!a1.some((f) => f.type === 'text' && f.delta.includes('cheapest')), 'the stream really was cut')
  assert.equal(lines.length, 2, JSON.stringify(lines))
  assert.equal(lines[0].user, q1)
  assert.equal(lines[0].assistant, interruptedAnswer(FIRST))
  assert.equal(lines[1].user, Q2)
})

test('C: an old-style interrupt with no `spoken` adds no note and leaves the log alone', { timeout: 60_000 }, async (t) => {
  const q1 = 'Is the RTX 5090 in stock? #stock C'
  const { prompt, lines } = await scenario(q1, async (c) => {
    await c.next((f) => f.type === 'done' && f.ask === 'a1')
    c.send({ type: 'interrupt' })
  }, (m) => t.diagnostic(m))
  assert.equal(prompt, Q2)
  assert.equal(lines.length, 2, JSON.stringify(lines))
  assert.equal(lines[0].assistant, FULL)
  assert.equal(lines[1].user, Q2)
})

test("D: interrupted mid-stream before anything was spoken: 'heard none' note, nothing logged for Q1", { timeout: 60_000 }, async (t) => {
  const q1 = 'Is the RTX 5090 in stock? #stock #slow D'
  const { prompt, lines } = await scenario(q1, async (c) => {
    await c.next((f) => f.type === 'text' && f.ask === 'a1')
    c.send({ type: 'interrupt', spoken: '' })
  }, (m) => t.diagnostic(m))
  assert.equal(prompt, `${interruptNote('')}\n\n${Q2}`)
  assert.ok(prompt.includes('He heard none of it.'))
  assert.ok(!prompt.includes('RTX'))
  assert.equal(lines.length, 1, JSON.stringify(lines))
  assert.equal(lines[0].user, Q2)
  assert.ok(!lines.some((l) => l.user === q1))
})
