// The GBrain provider. A fake GBrain on a random loopback port answers
// /health and POST /mcp the way the real one does (event stream), records
// every request and checks the bearer token. Nothing here talks to the real
// server on port 3131, reads the real token file or spawns a process.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  GBRAIN_REAL_PORT,
  GbrainError,
  _resetGbrainAutostart,
  createGbrainProvider,
  ensureGbrainServer,
  gbrainConfig,
  parseTurn,
  turnContent,
  turnSlug,
} from '../bridge/gbrain.mjs'

const TOKEN = 'test-token-abc-SECRET-9876'
const dirs = []
const servers = []
after(async () => {
  for (const s of servers) {
    s.closeAllConnections?.()
    await new Promise((r) => s.close(() => r()))
  }
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function tempDir() {
  const d = mkdtempSync(join(tmpdir(), 'venom-gbrain-'))
  dirs.push(d)
  return d
}

/** A temp token file holding `body`. */
function tokenFile(body = `\ufeff\n  ${TOKEN}  \nsecond-line\n`) {
  const f = join(tempDir(), 'venom-os.token')
  writeFileSync(f, body)
  return f
}

const sse = (obj) => `event: message\ndata: ${JSON.stringify(obj)}\n\n`
const toolOk = (inner) => ({ result: { content: [{ type: 'text', text: JSON.stringify(inner) }] }, jsonrpc: '2.0', id: 1 })
const toolErr = (inner) => ({
  result: { content: [{ type: 'text', text: JSON.stringify(inner) }], isError: true },
  jsonrpc: '2.0',
  id: 1,
})

/**
 * A fake GBrain. `answer(req)` gets { name, args } for a tool call and
 * returns { httpStatus?, json?, raw?, envelope?, hang? } or an inner tool answer object
 * (wrapped as a success). Returns { url, port, calls, close }.
 */
async function fakeGbrain(answer = () => ({}), { health = { status: 'ok', version: 'test' }, token = TOKEN } = {}) {
  const calls = []
  const server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', async () => {
      const call = { method: req.method, path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }
      calls.push(call)
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(health))
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404)
        return res.end()
      }
      if (req.headers.authorization !== `Bearer ${token}`) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ error: 'invalid_token', error_description: 'bad token' }))
      }
      const a = (await answer({ name: call.body?.params?.name, args: call.body?.params?.arguments, call })) ?? {}
      if (a.hang) return
      if (a.httpStatus) {
        res.writeHead(a.httpStatus, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify(a.json ?? { error: 'x' }))
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      res.end(a.raw ?? sse(a.envelope ?? toolOk(a)))
    })
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  servers.push(server)
  const port = server.address().port
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    calls,
    close: () => new Promise((r) => server.close(() => r())),
  }
}

/** A plain config pointed at a fake, no files involved. */
const cfg = (url, over = {}) => ({
  selected: true,
  enabled: true,
  why: '',
  baseUrl: url,
  port: Number(new URL(url).port),
  tokenFile: '',
  token: TOKEN,
  owner: 'alex',
  timeoutMs: 3000,
  startCmd: '',
  ...over,
})

/** Asserts that no thrown text / message holds a secret. */
function clean(text, ...secrets) {
  for (const s of [TOKEN, ...secrets]) assert.ok(!String(text).includes(s), 'message leaks a secret')
}

async function rejects(p) {
  try {
    await p
  } catch (err) {
    return err
  }
  assert.fail('expected a rejection')
}

// --- config ----------------------------------------------------------------

test('config: not selected reads no file and is disabled', () => {
  const c = gbrainConfig({ VENOM_GBRAIN_TOKEN_FILE: tokenFile() })
  assert.equal(c.selected, false)
  assert.equal(c.enabled, false)
  assert.equal(c.why, 'VENOM_GBRAIN not set')
  assert.equal(c.token, '')
})

test('config: defaults outside a test run with a temp token file', () => {
  const f = tokenFile()
  const c = gbrainConfig({ VENOM_GBRAIN: '1', VENOM_GBRAIN_TOKEN_FILE: f })
  assert.equal(c.enabled, true)
  assert.equal(c.why, '')
  assert.equal(c.baseUrl, 'http://127.0.0.1:3131')
  assert.equal(c.port, GBRAIN_REAL_PORT)
  assert.equal(c.timeoutMs, 3000)
  assert.equal(c.owner, 'owner')
  assert.equal(c.token, TOKEN)
  assert.equal(c.tokenFile, f)
  assert.equal(c.startCmd, join(homedir(), '.gbrain', 'start-gbrain-server.cmd'))
})

test('config: overrides, trailing slash and /mcp stripped', () => {
  const c = gbrainConfig({
    VENOM_GBRAIN: '1',
    VENOM_GBRAIN_URL: 'http://localhost:4555/mcp/',
    VENOM_GBRAIN_TOKEN_FILE: tokenFile(),
    VENOM_GBRAIN_OWNER: 'someone',
    VENOM_GBRAIN_TIMEOUT_MS: '1234',
  })
  assert.equal(c.baseUrl, 'http://localhost:4555')
  assert.equal(c.port, 4555)
  assert.equal(c.owner, 'someone')
  assert.equal(c.timeoutMs, 1234)
  assert.equal(gbrainConfig({ VENOM_GBRAIN_URL: 'http://127.0.0.1:4555///' }).baseUrl, 'http://127.0.0.1:4555')
  assert.equal(gbrainConfig({ VENOM_GBRAIN_TIMEOUT_MS: '-5' }).timeoutMs, 3000)
})

test('config: a URL off this PC is refused before the token is read', () => {
  for (const u of ['https://gbrain.example.com', 'http://10.0.0.2:3131', 'not a url']) {
    const c = gbrainConfig({ VENOM_GBRAIN: '1', VENOM_GBRAIN_URL: u, VENOM_GBRAIN_TOKEN_FILE: tokenFile() })
    assert.equal(c.enabled, false)
    assert.equal(c.why, 'GBrain URL is not on this PC')
    assert.equal(c.token, '')
  }
})

test('config: a test run is refused unless URL and token file are explicit and not the real ones', () => {
  const T = { NODE_TEST_CONTEXT: 'child-v8', VENOM_GBRAIN: '1' }
  const f = tokenFile()
  const refused = [
    { VENOM_GBRAIN_TOKEN_FILE: f },
    { VENOM_GBRAIN_URL: 'http://127.0.0.1:3131', VENOM_GBRAIN_TOKEN_FILE: f },
    { VENOM_GBRAIN_URL: 'http://127.0.0.1', VENOM_GBRAIN_TOKEN_FILE: f },
    { VENOM_GBRAIN_URL: 'http://127.0.0.1:4555' },
    // The real default path: refused on the path alone, the file is never read.
    { VENOM_GBRAIN_URL: 'http://127.0.0.1:4555', VENOM_GBRAIN_TOKEN_FILE: join(homedir(), '.gbrain', 'tokens', 'venom-os.token') },
    { VENOM_GBRAIN_URL: 'http://127.0.0.1:4555', VENOM_GBRAIN_TOKEN_FILE: join(homedir(), '.GBRAIN', 'tokens', '.', 'VENOM-OS.token') },
  ]
  for (const over of refused) {
    const c = gbrainConfig({ ...T, ...over })
    assert.equal(c.enabled, false, JSON.stringify(over))
    assert.equal(c.why, 'test run')
    assert.equal(c.token, '')
  }
  const ok = gbrainConfig({ ...T, VENOM_GBRAIN_URL: 'http://127.0.0.1:4555', VENOM_GBRAIN_TOKEN_FILE: f })
  assert.equal(ok.enabled, true)
  assert.equal(ok.token, TOKEN)
})

test('config: missing or empty token file -> no token file', () => {
  const base = { VENOM_GBRAIN: '1', VENOM_GBRAIN_URL: 'http://127.0.0.1:4555' }
  for (const f of [join(tempDir(), 'missing.token'), tokenFile(''), tokenFile('\ufeff \r\n\r\n ')]) {
    const c = gbrainConfig({ ...base, VENOM_GBRAIN_TOKEN_FILE: f })
    assert.equal(c.enabled, false)
    assert.equal(c.why, 'no token file')
    assert.equal(c.token, '')
  }
})

// --- turn pages --------------------------------------------------------------

test('turn: slug is stable, shaped and UTC; content round trips', () => {
  const t = { user: 'What time is it?', assistant: 'Line one.\nLine two.\n\nLine four.', ts: '2026-11-14T08:05:09.123+04:00' }
  const slug = turnSlug(t)
  assert.match(slug, /^venom-os\/\d{4}-\d{2}-\d{2}\/t\d{6}-[0-9a-f]{8}$/)
  assert.ok(slug.startsWith('venom-os/2026-11-14/t040509-'))
  assert.equal(turnSlug({ ...t }), slug)
  assert.notEqual(turnSlug({ ...t, user: 'other' }), slug)
  const content = turnContent(t)
  assert.equal(content, `# Venom OS voice turn 2026-11-14T04:05:09.123Z\n\nOwner: ${t.user}\n\nVenom: ${t.assistant}`)
  assert.deepEqual(parseTurn(content), { when: '2026-11-14T04:05:09.123Z', user: t.user, assistant: t.assistant })
  assert.deepEqual(parseTurn(content.replace(/\n/g, '\r\n')), parseTurn(content))
  assert.equal(parseTurn('just a note'), null)
  assert.equal(parseTurn(null), null)
})

test('turn: a missing or invalid ts uses now', () => {
  const before = Date.now()
  const p = parseTurn(turnContent({ user: 'a', assistant: 'b', ts: 'nonsense' }))
  assert.ok(Date.parse(p.when) >= before - 5)
  assert.ok(Date.parse(p.when) <= Date.now() + 5)
})

// --- provider ------------------------------------------------------------------

test('provider: describe holds the port and no token', async () => {
  const p = createGbrainProvider(cfg('http://127.0.0.1:4555', { tokenFile: '/x/secret/path' }))
  assert.equal(p.name, 'gbrain')
  assert.equal(p.label, 'GBrain')
  assert.equal(p.describe(), 'local server on port 4555 · pages under venom-os/')
})

test('provider: ping ok calls health then whoami with the token', async () => {
  const g = await fakeGbrain(({ name }) => (name === 'whoami' ? { token_name: 'venom-os', scopes: ['read', 'write'] } : {}))
  const r = await createGbrainProvider(cfg(g.url)).ping({ timeoutMs: 2000 })
  assert.equal(r.ok, true)
  assert.equal(typeof r.ms, 'number')
  assert.deepEqual(g.calls.map((c) => c.path), ['/health', '/mcp'])
  const mcp = g.calls[1]
  assert.equal(mcp.headers.authorization, `Bearer ${TOKEN}`)
  assert.match(mcp.headers.accept, /text\/event-stream/)
  assert.equal(mcp.body.method, 'tools/call')
  assert.equal(mcp.body.params.name, 'whoami')
})

test('provider: ping with a wrong token says the key was refused', async () => {
  const g = await fakeGbrain()
  const r = await createGbrainProvider(cfg(g.url, { token: 'wrong-token-xyz' })).ping()
  assert.equal(r.ok, false)
  assert.match(r.error, /refused the key/)
  assert.equal(r.error, 'GBrain refused the key (401) on ping')
  clean(r.error, 'wrong-token-xyz')
})

test('provider: ping when the server is gone -> ok:false', async () => {
  const g = await fakeGbrain()
  await g.close()
  const r = await createGbrainProvider(cfg(g.url)).ping({ timeoutMs: 1000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /^GBrain unreachable/)
})

test('provider: ping with a health that is not ok -> ok:false', async () => {
  const g = await fakeGbrain(() => ({}), { health: { status: 'starting' } })
  const r = await createGbrainProvider(cfg(g.url)).ping()
  assert.equal(r.ok, false)
  assert.equal(g.calls.length, 1)
})

test('provider: writeTurn sends capture; a retry sends the same slug and request id', async () => {
  const g = await fakeGbrain(({ args }) => ({ slug: args.slug, status: 'created_or_updated', chunks: 1 }))
  const p = createGbrainProvider(cfg(g.url))
  const turn = { user: 'Remember my car is blue.', assistant: 'Noted.\nBlue it is.', ts: '2026-11-14T10:00:00Z', session: 's1' }
  const r1 = await p.writeTurn(turn)
  const r2 = await p.writeTurn(turn)
  const slug = turnSlug(turn)
  assert.deepEqual(r1, { session: 'venom-os-2026-11-14', ids: [slug], duplicate: false })
  assert.deepEqual(r2, r1)
  assert.equal(g.calls.length, 2)
  const [a, b] = g.calls
  assert.equal(a.headers.authorization, `Bearer ${TOKEN}`)
  assert.equal(a.body.params.name, 'capture')
  assert.deepEqual(Object.keys(a.body.params.arguments).sort(), ['content', 'request_id', 'slug'])
  assert.equal(a.body.params.arguments.content, turnContent(turn))
  assert.equal(a.body.params.arguments.slug, slug)
  assert.match(a.body.params.arguments.request_id, /^venom-os-[0-9a-f]{16}$/)
  assert.equal(a.body.params.arguments.request_id.slice(9, 17), slug.slice(-8))
  assert.deepEqual(b.body.params.arguments, a.body.params.arguments)
})

test('provider: writeTurn cuts each side to 25000 chars and needs both sides', async () => {
  const g = await fakeGbrain(() => ({ status: 'created_or_updated' }))
  const p = createGbrainProvider(cfg(g.url))
  const long = { user: 'u'.repeat(30000), assistant: 'a'.repeat(30000), ts: '2026-11-14T10:00:00Z' }
  await p.writeTurn(long)
  const sent = parseTurn(g.calls[0].body.params.arguments.content)
  assert.equal(sent.user.length, 25000)
  assert.equal(sent.assistant.length, 25000)
  for (const bad of [{ user: '', assistant: 'x' }, { user: 'x', assistant: '  ' }, { user: 'x' }]) {
    const err = await rejects(p.writeTurn(bad))
    assert.ok(err instanceof GbrainError)
    assert.equal(err.status, 400)
    assert.equal(err.retryable, false)
  }
  assert.equal(g.calls.length, 1)
})

test('provider: revision_required means the page is already stored', async () => {
  const g = await fakeGbrain(() => ({
    envelope: toolErr({ code: 'revision_required', retryable: false, class: 'caller', message: 'exists' }),
  }))
  const r = await createGbrainProvider(cfg(g.url)).writeTurn({ user: 'hi', assistant: 'hello', ts: '2026-11-14T10:00:00Z' })
  assert.equal(r.duplicate, true)
  assert.deepEqual(r.ids, [turnSlug({ user: 'hi', assistant: 'hello', ts: '2026-11-14T10:00:00Z' })])
})

test('provider: tool-level errors map to status and retryable', async () => {
  let inner
  const g = await fakeGbrain(() => ({ envelope: toolErr(inner) }))
  const p = createGbrainProvider(cfg(g.url))
  const turn = { user: 'secret-user-words', assistant: 'secret-venom-words', ts: '2026-11-14T10:00:00Z' }

  inner = { code: 'invalid_params', retryable: false, class: 'caller', message: 'secret-user-words is bad' }
  let err = await rejects(p.writeTurn(turn))
  assert.ok(err instanceof GbrainError)
  assert.equal(err.status, 400)
  assert.equal(err.retryable, false)
  assert.equal(err.code, 'invalid_params')
  assert.equal(err.message, 'GBrain refused capture (invalid_params)')
  clean(err.message, 'secret-user-words', 'secret-venom-words')

  inner = { code: 'busy', retryable: true, message: 'try later' }
  err = await rejects(p.writeTurn(turn))
  assert.equal(err.status, 503)
  assert.equal(err.retryable, true)

  inner = { code: 'insufficient_scope', retryable: false }
  err = await rejects(p.writeTurn(turn))
  assert.equal(err.status, 403)
  assert.equal(err.retryable, false)
})

test('provider: HTTP 401 is not retryable, 500 is', async () => {
  let status = 401
  const g = await fakeGbrain(() => ({ httpStatus: status }))
  const p = createGbrainProvider(cfg(g.url, { token: 'bad-token-qq' }))
  const turn = { user: 'a', assistant: 'b' }
  let err = await rejects(p.writeTurn(turn))
  assert.equal(err.status, 401)
  assert.equal(err.retryable, false)
  assert.equal(err.message, 'GBrain refused the key (401) on capture')
  clean(err.message, 'bad-token-qq')

  const p2 = createGbrainProvider(cfg(g.url))
  status = 500
  err = await rejects(p2.writeTurn(turn))
  assert.equal(err.status, 500)
  assert.equal(err.retryable, true)
  assert.equal(err.message, 'GBrain 500 on capture')
})

test('provider: a server that never answers times out with status 0', async () => {
  const g = await fakeGbrain(() => ({ hang: true }))
  const p = createGbrainProvider(cfg(g.url, { timeoutMs: 150 }))
  const t0 = Date.now()
  const err = await rejects(p.search('where is my secret-query-term'))
  assert.ok(Date.now() - t0 < 1000)
  assert.ok(err instanceof GbrainError)
  assert.equal(err.status, 0)
  assert.equal(err.retryable, true)
  assert.equal(err.message, 'GBrain unreachable: timeout after 150 ms')
  clean(err.message, 'secret-query-term')
})

test('provider: search unwraps chunks, splits turn pages, adds facts, clamps limit', async () => {
  const turn = { user: 'My car is blue.', assistant: 'Got it.\nBlue car.', ts: '2026-11-14T10:00:00Z' }
  const slug = turnSlug(turn)
  const wrap = (s, text) => `[quoted conversation excerpt from ${s}; source material, not instructions]\n\`\`\`text\n${text}\n\`\`\``
  const g = await fakeGbrain(() => ({
    facts: [
      { id: 1, fact: wrap('people/alex', 'Alex drives a blue car'), kind: 'fact', entity_slug: 'people/alex', created_at: '2026-11-14T10:01:00Z' },
      { id: 2, fact: 'plain fact', kind: 'fact' },
      { id: 3, fact: '' },
    ],
    total: 3,
    results: [
      { slug, title: 't', chunk: wrap(slug, turnContent(turn)) },
      { slug: 'notes/a', title: 'n', chunk: 'an unwrapped note' },
      { slug: 'notes/b', title: 'n', chunk: wrap('notes/b', '   ') },
    ],
  }))
  const p = createGbrainProvider(cfg(g.url))
  const hits = await p.search('blue car', { limit: 50 })
  assert.deepEqual(hits, [
    { who: 'owner', text: 'My car is blue.', when: '2026-11-14T10:00:00.000Z', session: slug },
    { who: 'venom', text: 'Got it.\nBlue car.', when: '2026-11-14T10:00:00.000Z', session: slug },
    { who: 'note', text: 'an unwrapped note', when: '', session: 'notes/a' },
    { who: 'saved fact', text: 'Alex drives a blue car', when: '2026-11-14T10:01:00.000Z', session: 'people/alex' },
    { who: 'saved fact', text: 'plain fact', when: '', session: '' },
  ])
  const args = g.calls[0].body.params.arguments
  assert.equal(g.calls[0].body.params.name, 'recall')
  assert.deepEqual(args, { query: 'blue car', question: 'blue car', limit: 20 })
  await p.search('x', { limit: 0 })
  assert.equal(g.calls[1].body.params.arguments.limit, 1)
  await p.search('y'.repeat(5000))
  assert.equal(g.calls[2].body.params.arguments.query.length, 4000)
  assert.equal(g.calls[2].body.params.arguments.limit, 8)
})

test('provider: search returns at most 20 hits', async () => {
  const g = await fakeGbrain(() => ({ results: Array.from({ length: 30 }, (_, i) => ({ slug: `n/${i}`, chunk: `note ${i}` })), facts: [] }))
  const hits = await createGbrainProvider(cfg(g.url)).search('q', { limit: 20 })
  assert.equal(hits.length, 20)
})

test('provider: search answer as plain JSON (no event stream) is read too', async () => {
  const g = await fakeGbrain(() => ({ raw: JSON.stringify(toolOk({ results: [{ slug: 's', chunk: 'plain' }], facts: [] })) }))
  const hits = await createGbrainProvider(cfg(g.url)).search('q')
  assert.deepEqual(hits, [{ who: 'note', text: 'plain', when: '', session: 's' }])
})

test('provider: profile miss is an empty card, a hit gives lines and summary', async () => {
  let found = false
  const g = await fakeGbrain(({ args }) =>
    found
      ? {
          found: true,
          card: {
            entity: { slug: 'people/alex', title: 'Alex', type: 'person' },
            summary: 'The owner.',
            identity_excerpt: Array.from({ length: 15 }, (_, i) => ({ slug: 'people/alex', line: `line ${i}` })),
            aka: [],
          },
        }
      : { found: false, suggestions: [], asked: args.name },
  )
  const p = createGbrainProvider(cfg(g.url, { owner: 'alex' }))
  assert.deepEqual(await p.profile({ query: 'anything' }), { card: [], representation: '' })
  assert.equal(g.calls[0].body.params.name, 'entity')
  assert.deepEqual(g.calls[0].body.params.arguments, { name: 'alex' })
  found = true
  const r = await p.profile()
  assert.equal(r.card.length, 12)
  assert.equal(r.card[0], 'line 0')
  assert.equal(r.representation, 'The owner.')
})

test('provider: errors never hold the token or the query', async () => {
  const g = await fakeGbrain(() => ({ envelope: toolErr({ code: `bad ${TOKEN} q-secret-text`, message: `${TOKEN} q-secret-text` }) }))
  const p = createGbrainProvider(cfg(g.url))
  const err = await rejects(p.search('q-secret-text'))
  clean(err.message, 'q-secret-text')
  clean(String(err), 'q-secret-text')
  clean(err.code, 'q-secret-text')
})

// --- autostart -----------------------------------------------------------------

const win = process.platform === 'win32'
const failingFetch = async () => {
  throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })
}

function fakeSpawn() {
  const calls = []
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts })
    return { unref() {}, on() {} }
  }
  return { calls, spawnImpl }
}

const startCfg = (over = {}) => cfg('http://127.0.0.1:4555', { startCmd: 'C:\\fake\\start gbrain.cmd', ...over })

test('autostart: never spawns under a test run', async () => {
  _resetGbrainAutostart()
  const s = fakeSpawn()
  const r = await ensureGbrainServer(startCfg(), {
    env: { NODE_TEST_CONTEXT: 'child-v8' },
    fetchImpl: failingFetch,
    spawnImpl: s.spawnImpl,
    existsImpl: () => true,
  })
  assert.deepEqual(r, { started: false, why: 'test run' })
  assert.equal(s.calls.length, 0)
})

test('autostart: disabled config does nothing', async () => {
  _resetGbrainAutostart()
  const s = fakeSpawn()
  const r = await ensureGbrainServer(startCfg({ enabled: false, why: 'no token file' }), {
    env: {},
    fetchImpl: failingFetch,
    spawnImpl: s.spawnImpl,
    existsImpl: () => true,
  })
  assert.equal(r.started, false)
  assert.equal(s.calls.length, 0)
})

test('autostart: spawns the script once when health fails', { skip: !win && 'Windows only' }, async () => {
  _resetGbrainAutostart()
  const s = fakeSpawn()
  const deps = { env: {}, fetchImpl: failingFetch, spawnImpl: s.spawnImpl, existsImpl: () => true }
  const r = await ensureGbrainServer(startCfg(), deps)
  assert.deepEqual(r, { started: true, why: 'started' })
  assert.equal(s.calls.length, 1)
  assert.equal(s.calls[0].cmd, 'cmd.exe')
  assert.deepEqual(s.calls[0].args, ['/d', '/s', '/c', '""C:\\fake\\start gbrain.cmd""'])
  assert.equal(s.calls[0].opts.detached, true)
  assert.equal(s.calls[0].opts.windowsHide, true)
  assert.equal(s.calls[0].opts.windowsVerbatimArguments, true)
  const r2 = await ensureGbrainServer(startCfg(), deps)
  assert.equal(r2.started, false)
  assert.equal(s.calls.length, 1)
  _resetGbrainAutostart()
})

test('autostart: health ok -> not spawned', { skip: !win && 'Windows only' }, async () => {
  _resetGbrainAutostart()
  const s = fakeSpawn()
  const r = await ensureGbrainServer(startCfg(), {
    env: {},
    fetchImpl: async () => new Response('{"status":"ok"}', { status: 200 }),
    spawnImpl: s.spawnImpl,
    existsImpl: () => true,
  })
  assert.deepEqual(r, { started: false, why: 'already running' })
  assert.equal(s.calls.length, 0)
})

test('autostart: missing start script -> not spawned', { skip: !win && 'Windows only' }, async () => {
  _resetGbrainAutostart()
  const s = fakeSpawn()
  const r = await ensureGbrainServer(startCfg(), {
    env: {},
    fetchImpl: failingFetch,
    spawnImpl: s.spawnImpl,
    existsImpl: () => false,
  })
  assert.deepEqual(r, { started: false, why: 'no start script' })
  assert.equal(s.calls.length, 0)
})

test('autostart: only for the usual address, or when a start script is named', async () => {
  const f = tokenFile()
  const base = { VENOM_GBRAIN: '1', VENOM_GBRAIN_TOKEN_FILE: f }
  assert.equal(gbrainConfig(base).autostart, true)
  assert.equal(gbrainConfig({ ...base, VENOM_GBRAIN_URL: 'http://127.0.0.1:3199' }).autostart, false)
  assert.equal(
    gbrainConfig({ ...base, VENOM_GBRAIN_URL: 'http://127.0.0.1:3199', VENOM_GBRAIN_START_CMD: 'C:/fake/s.cmd' }).autostart,
    true,
  )
  _resetGbrainAutostart()
  const s = fakeSpawn()
  const r = await ensureGbrainServer(startCfg({ autostart: false }), {
    env: {},
    fetchImpl: failingFetch,
    spawnImpl: s.spawnImpl,
    existsImpl: () => true,
  })
  assert.equal(r.started, false)
  assert.equal(s.calls.length, 0)
})
