// The bridge's team endpoints, /team/runs and /team/run, against a real bridge
// on a free port. The activity log and full results live in a temp folder
// (VENOM_AGENTS_DIR); nothing here touches the real ~/.venom/agents, and the
// bridge only reads that folder.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { request } from 'node:http'
import { mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { activityConfig } from '../hermes-mcp/activity.mjs'
import { writeRunFile } from '../hermes-mcp/runfiles.mjs'

const SERVER = fileURLToPath(new URL('../bridge/server.mjs', import.meta.url))
const ORIGIN = 'http://localhost:5173'

/** Start a bridge on a free port; resolves once it says where it is listening. */
function startBridge(env) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      VENOM_BRIDGE_PORT: '0',
      VENOM_LOCAL_STT: '0',
      VENOM_MEMORY: '0',
      VENOM_HONCHO: '0',
      VENOM_MCP_SERVERS: '',
      VENOM_ALLOW_NO_ORIGIN: '',
      VENOM_ALLOWED_ORIGINS: '',
      VENOM_AGENT_ACTIVITY: '1',
      // Never the owner's venom.agents.json: no file means the starter set.
      VENOM_ROSTER_FILE: join(tmpdir(), `venom-no-roster-${process.pid}`, 'venom.agents.json'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let log = ''
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`bridge did not start: ${log}`))
    }, 15_000)
    child.stdout.on('data', (d) => {
      log += d
      const m = /bridge listening on ws:\/\/(\S+):(\d+)/.exec(log)
      if (m) {
        clearTimeout(timer)
        resolve({ child, port: Number(m[2]) })
      }
    })
    child.stderr.on('data', (d) => (log += d))
    child.on('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`bridge exited ${code}: ${log}`))
    })
  })
}

/** GET a path; resolves { status, headers, body (parsed JSON when it is) }. */
function get(port, path, headers = { origin: ORIGIN }) {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers: { host: `127.0.0.1:${port}`, ...headers }, timeout: 5000 }, (res) => {
      let raw = ''
      res.setEncoding('utf8')
      res.on('data', (d) => (raw += d))
      res.on('end', () => {
        let body = raw
        try {
          body = JSON.parse(raw)
        } catch {
          // Not JSON (the generic 403s are plain text).
        }
        resolve({ status: res.statusCode, headers: res.headers, body })
      })
    })
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.end()
  })
}

const T0 = Date.UTC(2026, 10, 10, 8)
const KEPT = `${T0.toString(36)}-0123abcd`
const NOT_KEPT = `${(T0 + 60_000).toString(36)}-4567cdef`
const CODER = `${(T0 + 120_000).toString(36)}-89abcdef`
const line = (o) => `${JSON.stringify(o)}\n`

let dir
let workspace // the bridge mkdirs its workspace at startup: keep it off the real ~/.venom
let bridge
let open // no-Origin clients allowed, activity off
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'venom-endpoints-'))
  workspace = mkdtempSync(join(tmpdir(), 'venom-endpoints-ws-'))
  const cfg = activityConfig({ VENOM_AGENTS_DIR: dir })
  writeFileSync(
    cfg.file,
    line({ t: 'start', id: KEPT, agent: 'researcher', task: 'Audit one', ts: T0, pid: 1 }) +
      line({ t: 'end', id: KEPT, ok: true, ms: 5000, summary: 'Twelve fixes.', ts: T0 + 5000, full: true }) +
      line({ t: 'start', id: NOT_KEPT, agent: 'researcher', task: 'Audit two', ts: T0 + 60_000, pid: 1 }) +
      line({ t: 'step', id: NOT_KEPT, text: 'Editing a.md', ts: T0 + 61_000 }) +
      line({ t: 'end', id: NOT_KEPT, ok: false, ms: 9000, summary: 'Failed.', ts: T0 + 69_000 }) +
      line({ t: 'start', id: CODER, agent: 'coder', task: 'Code', ts: T0 + 120_000, pid: 1 }),
  )
  assert.equal(writeRunFile(KEPT, '# Audit\n\nTwelve fixes.\n\n1. Titles', cfg), true)
  ;[bridge, open] = await Promise.all([
    startBridge({ VENOM_AGENTS_DIR: dir, VENOM_WORKSPACE: workspace }),
    startBridge({ VENOM_AGENTS_DIR: dir, VENOM_WORKSPACE: workspace, VENOM_ALLOW_NO_ORIGIN: '1', VENOM_AGENT_ACTIVITY: '0' }),
  ])
})
after(() => {
  bridge?.child.kill()
  open?.child.kill()
  rmSync(dir, { recursive: true, force: true })
  if (workspace) rmSync(workspace, { recursive: true, force: true })
})

test('/team/runs: one agent\'s runs, newest first, with whether the full result is kept', async () => {
  const r = await get(bridge.port, '/team/runs?agent=researcher')
  assert.equal(r.status, 200)
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(r.headers['cache-control'], 'no-store')
  assert.equal(r.headers['x-content-type-options'], 'nosniff')
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN)
  assert.equal(r.body.agent, 'researcher')
  assert.deepEqual(r.body.runs.map((x) => [x.id, x.state, x.full]), [[NOT_KEPT, 'failed', false], [KEPT, 'done', true]])
  assert.deepEqual(r.body.runs[0].steps, [{ text: 'Editing a.md', ts: T0 + 61_000 }])
  assert.ok(r.body.runs.every((x) => !('pid' in x)))
  // A working run of a connector that has gone is lost.
  const coder = await get(bridge.port, '/team/runs?agent=coder')
  assert.deepEqual(coder.body.runs.map((x) => x.id), [CODER])
})

test('/team/runs: an agent not on the roster is 400', async () => {
  for (const q of ['?agent=nobody', '?agent=', '', '?agent=../researcher', '?agent=RESEARCHER']) {
    const r = await get(bridge.port, `/team/runs${q}`)
    assert.equal(r.status, 400, q)
    assert.equal(typeof r.body.error, 'string')
  }
})

test('/team/run: the kept text for a good id', async () => {
  const r = await get(bridge.port, `/team/run?id=${KEPT}`)
  assert.equal(r.status, 200)
  assert.deepEqual(r.body, { id: KEPT, text: '# Audit\n\nTwelve fixes.\n\n1. Titles' })
  assert.equal(r.headers['content-type'], 'application/json; charset=utf-8')
  assert.equal(r.headers['access-control-allow-origin'], ORIGIN)
})

test('/team/run: malformed ids are 400, an id with no file is 404', async () => {
  const bad = [
    '../activity.jsonl',
    '..%2F..%2Factivity.jsonl',
    `${KEPT}%2F..`,
    `..%5C${KEPT}`,
    `${KEPT}/../x`,
    KEPT.toUpperCase(),
    `${'1'.repeat(13)}-0123abcd`,
    `${KEPT}.md`,
    '',
  ]
  for (const id of bad) {
    const r = await get(bridge.port, `/team/run?id=${id}`)
    assert.equal(r.status, 400, id)
  }
  const missing = await get(bridge.port, `/team/run?id=${NOT_KEPT}`)
  assert.equal(missing.status, 404)
  assert.deepEqual(missing.body, { error: 'not kept' })
})

test('both: a foreign Origin is 403, and so is no Origin by default', async () => {
  for (const path of ['/team/runs?agent=researcher', `/team/run?id=${KEPT}`]) {
    assert.equal((await get(bridge.port, path, { origin: 'https://attacker.example' })).status, 403, path)
    assert.equal((await get(bridge.port, path, { origin: 'http://localhost:8080' })).status, 403, path)
    const none = await get(bridge.port, path, {})
    assert.equal(none.status, 403, path)
    assert.equal(none.headers['access-control-allow-origin'], undefined)
  }
  // A foreign Host is refused before anything else.
  assert.equal((await get(bridge.port, '/team/runs?agent=researcher', { host: 'attacker.example', origin: ORIGIN })).status, 403)
})

test('with VENOM_ALLOW_NO_ORIGIN=1 no Origin is served; with activity off there are no runs', async () => {
  const runs = await get(open.port, '/team/runs?agent=researcher', {})
  assert.equal(runs.status, 200)
  assert.deepEqual(runs.body, { agent: 'researcher', runs: [] })
  assert.equal((await get(open.port, `/team/run?id=${KEPT}`, {})).status, 404)
})

test('the bridge only reads the agents folder', () => {
  assert.deepEqual(readdirSync(dir).sort(), ['activity.jsonl', 'runs'])
  assert.deepEqual(readdirSync(join(dir, 'runs')), [`${KEPT}.md`])
  assert.ok(statSync(join(dir, 'activity.jsonl')).size > 0)
})
