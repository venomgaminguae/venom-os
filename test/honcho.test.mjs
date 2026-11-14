// The Honcho provider. A fake fetch records every request and answers from a
// script, and every config read points at a temp "hermes home", so nothing
// here touches the network, the real key or the real honcho.json.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HonchoError, createHonchoProvider, honchoConfig, sessionIdFor } from '../bridge/honcho.mjs'

const KEY = 'hk-test-SECRET-1234567890'
const homes = []
after(() => {
  for (const h of homes) rmSync(h, { recursive: true, force: true })
})

/** A fresh fake hermes home with optional .env and honcho.json contents. */
function home({ dotenv, json } = {}) {
  const h = mkdtempSync(join(tmpdir(), 'venom-honcho-'))
  homes.push(h)
  if (dotenv !== undefined) writeFileSync(join(h, '.env'), dotenv)
  if (json !== undefined) writeFileSync(join(h, 'honcho.json'), json)
  return h
}

/** A plain config, no files involved. */
const cfg = (over = {}) => ({
  enabled: true,
  why: '',
  baseUrl: 'http://127.0.0.1:9',
  apiKey: KEY,
  workspace: 'hermes',
  aiPeer: 'venom',
  userPeer: 'owner',
  sessionPrefix: 'venom-os',
  timeoutMs: 8000,
  ...over,
})

/**
 * A fake fetch. `answer(call)` returns { status, body } (or throws / returns
 * a promise); every call is recorded with its parsed body.
 */
function fakeFetch(answer = () => ({ status: 200, body: [] })) {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const call = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      signal: init.signal,
    }
    calls.push(call)
    const r = await answer(call, calls.length - 1)
    return new Response(r.body === undefined ? '' : JSON.stringify(r.body), { status: r.status ?? 200 })
  }
  return { calls, fetchImpl }
}

const path = (url) => new URL(url).pathname
const params = (url) => Object.fromEntries(new URL(url).searchParams)

// --- config ----------------------------------------------------------------

test('config: defaults and a key from the environment', () => {
  const c = honchoConfig({ HERMES_HOME: home(), VENOM_HONCHO_API_KEY: KEY })
  assert.equal(c.enabled, true)
  assert.equal(c.why, '')
  assert.equal(c.baseUrl, 'https://api.honcho.dev')
  assert.equal(c.apiKey, KEY)
  assert.equal(c.workspace, 'hermes')
  assert.equal(c.aiPeer, 'venom')
  assert.equal(c.userPeer, 'owner')
  assert.equal(c.sessionPrefix, 'venom-os')
  assert.equal(c.timeoutMs, 8000)
})

test('config: HONCHO_API_KEY is the second choice', () => {
  const c = honchoConfig({ HERMES_HOME: home(), HONCHO_API_KEY: 'k2' })
  assert.equal(c.apiKey, 'k2')
  const d = honchoConfig({ HERMES_HOME: home(), VENOM_HONCHO_API_KEY: 'k1', HONCHO_API_KEY: 'k2' })
  assert.equal(d.apiKey, 'k1')
})

test('config: VENOM_HONCHO=0 turns it off first', () => {
  const c = honchoConfig({ HERMES_HOME: home(), VENOM_HONCHO: '0', VENOM_HONCHO_API_KEY: KEY, NODE_TEST_CONTEXT: 'child' })
  assert.equal(c.enabled, false)
  assert.equal(c.why, 'VENOM_HONCHO=0')
})

test('config: no key means off', () => {
  const c = honchoConfig({ HERMES_HOME: home() })
  assert.equal(c.enabled, false)
  assert.equal(c.why, 'no API key')
  assert.equal(c.apiKey, '')
})

test('config: inside node --test a remote URL is refused, loopback allowed', () => {
  const h = home()
  const remote = honchoConfig({ HERMES_HOME: h, VENOM_HONCHO_API_KEY: KEY, NODE_TEST_CONTEXT: 'child-v8' })
  assert.equal(remote.enabled, false)
  assert.equal(remote.why, 'test run')
  const remote2 = honchoConfig({ HERMES_HOME: h, NODE_TEST_CONTEXT: '1', VENOM_HONCHO_URL: 'https://honcho.example.com' })
  assert.equal(remote2.why, 'test run')
  for (const url of ['http://localhost:8000', 'http://127.0.0.1:8000/', 'http://[::1]:8000/v3']) {
    const c = honchoConfig({ HERMES_HOME: h, VENOM_HONCHO_API_KEY: KEY, NODE_TEST_CONTEXT: '1', VENOM_HONCHO_URL: url })
    assert.equal(c.enabled, true, url)
  }
  const nokey = honchoConfig({ HERMES_HOME: h, NODE_TEST_CONTEXT: '1', VENOM_HONCHO_URL: 'http://localhost:1' })
  assert.equal(nokey.why, 'no API key')
})

test('config: base URL loses trailing slashes and /v3', () => {
  const h = home()
  assert.equal(honchoConfig({ HERMES_HOME: h, VENOM_HONCHO_URL: 'http://localhost:8000/v3/' }).baseUrl, 'http://localhost:8000')
  assert.equal(honchoConfig({ HERMES_HOME: h, VENOM_HONCHO_URL: 'http://localhost:8000///' }).baseUrl, 'http://localhost:8000')
})

test('config: key from the .env file, with quotes, export and comments', () => {
  const cases = [
    ['HONCHO_API_KEY=plain-key\n', 'plain-key'],
    ['# HONCHO_API_KEY=commented\nHONCHO_API_KEY="double-q"\n', 'double-q'],
    ["OTHER=1\r\nexport HONCHO_API_KEY='single-q'\r\n", 'single-q'],
    ['\ufeffHONCHO_API_KEY=after-bom\n', 'after-bom'],
    ['NOT_HONCHO_API_KEY=x\nANTHROPIC_API_KEY=y\n', ''],
  ]
  for (const [dotenv, want] of cases) {
    const c = honchoConfig({ HERMES_HOME: home({ dotenv }) })
    assert.equal(c.apiKey, want, JSON.stringify(dotenv))
    assert.equal(c.enabled, want !== '')
  }
  // The environment beats the file.
  const c = honchoConfig({ HERMES_HOME: home({ dotenv: 'HONCHO_API_KEY=file\n' }), VENOM_HONCHO_API_KEY: 'env' })
  assert.equal(c.apiKey, 'env')
})

test('config: hermes home falls back to LOCALAPPDATA/hermes', () => {
  const root = mkdtempSync(join(tmpdir(), 'venom-honcho-lad-'))
  homes.push(root)
  assert.equal(honchoConfig({ LOCALAPPDATA: root }).why, 'no API key')
  mkdirSync(join(root, 'hermes'))
  writeFileSync(join(root, 'hermes', '.env'), 'HONCHO_API_KEY=from-localappdata\n')
  const c = honchoConfig({ LOCALAPPDATA: root })
  assert.equal(c.apiKey, 'from-localappdata')
  assert.equal(c.enabled, true)
})

test('config: honcho.json values, BOM tolerated, env overrides them', () => {
  const json = '\ufeff' + JSON.stringify({ hosts: { hermes: { workspace: 'my ws', aiPeer: 'bot.one', peerName: 'Ali Q' } } })
  const h = home({ json })
  const c = honchoConfig({ HERMES_HOME: h })
  assert.equal(c.workspace, 'my-ws')
  assert.equal(c.aiPeer, 'bot-one')
  assert.equal(c.userPeer, 'Ali-Q')
  const d = honchoConfig({
    HERMES_HOME: h,
    VENOM_HONCHO_WORKSPACE: 'w2',
    VENOM_HONCHO_AI_PEER: 'a2',
    VENOM_HONCHO_USER_PEER: 'u@2',
    VENOM_HONCHO_TIMEOUT_MS: '1500',
  })
  assert.equal(d.workspace, 'w2')
  assert.equal(d.aiPeer, 'a2')
  assert.equal(d.userPeer, 'u-2')
  assert.equal(d.timeoutMs, 1500)
})

test('config: bad honcho.json and bad timeout fall back to defaults, never throw', () => {
  const c = honchoConfig({ HERMES_HOME: home({ json: '{ not json' }), VENOM_HONCHO_TIMEOUT_MS: '-5' })
  assert.equal(c.workspace, 'hermes')
  assert.equal(c.userPeer, 'owner')
  assert.equal(c.timeoutMs, 8000)
  assert.equal(honchoConfig({ HERMES_HOME: home(), VENOM_HONCHO_TIMEOUT_MS: 'abc' }).timeoutMs, 8000)
  const e = honchoConfig({ HERMES_HOME: home({ json: JSON.stringify({ hosts: null }) }) })
  assert.equal(e.aiPeer, 'venom')
})

// --- session ids -----------------------------------------------------------

test('sessionIdFor uses the local date', () => {
  assert.equal(sessionIdFor(new Date(2026, 10, 13, 0, 5)), 'venom-os-2026-11-13')
  assert.equal(sessionIdFor(new Date(2026, 0, 2, 23, 59)), 'venom-os-2026-01-02')
  assert.equal(sessionIdFor(new Date(2026, 0, 2), 'x'), 'x-2026-01-02')
})

// --- errors ----------------------------------------------------------------

test('HonchoError: retryable classification per status', () => {
  for (const s of [0, 408, 425, 429, 500, 502, 503, 504]) assert.equal(new HonchoError('x', s).retryable, true, String(s))
  for (const s of [400, 401, 403, 404, 413, 422]) assert.equal(new HonchoError('x', s).retryable, false, String(s))
  const e = new HonchoError('m', 503)
  assert.ok(e instanceof Error)
  assert.equal(e.status, 503)
})

// --- writeTurn -------------------------------------------------------------

test('writeTurn: creates the session once, then one messages call in order', async () => {
  const { calls, fetchImpl } = fakeFetch((c) =>
    c.url.endsWith('/messages') ? { status: 201, body: [{ id: 'm1' }, { id: 'm2' }] } : { status: 201, body: { id: 's' } },
  )
  const p = createHonchoProvider(cfg(), { fetchImpl })
  const ts = new Date(2026, 10, 13, 10, 30, 0, 0)
  const r = await p.writeTurn({ user: 'hello', assistant: 'hi there', ts, session: 'abc' })
  assert.deepEqual(r, { session: 'venom-os-2026-11-13', ids: ['m1', 'm2'] })
  assert.equal(calls.length, 2)

  const [s, m] = calls
  assert.equal(s.method, 'POST')
  assert.equal(path(s.url), '/v3/workspaces/hermes/sessions')
  assert.equal(s.headers.Authorization, `Bearer ${KEY}`)
  assert.equal(s.headers['Content-Type'], 'application/json')
  assert.deepEqual(s.body, {
    id: 'venom-os-2026-11-13',
    metadata: { source: 'venom-os' },
    peers: {
      owner: { observe_me: true, observe_others: true },
      venom: { observe_me: true, observe_others: true },
    },
  })

  assert.equal(m.method, 'POST')
  assert.equal(path(m.url), '/v3/workspaces/hermes/sessions/venom-os-2026-11-13/messages')
  assert.deepEqual(m.body, {
    messages: [
      { peer_id: 'owner', content: 'hello', created_at: ts.toISOString(), metadata: { source: 'venom-os', bridge_session: 'abc' } },
      {
        peer_id: 'venom',
        content: 'hi there',
        created_at: new Date(ts.getTime() + 1).toISOString(),
        metadata: { source: 'venom-os', bridge_session: 'abc' },
      },
    ],
  })

  // Same day again: no session call.
  await p.writeTurn({ user: 'again', assistant: 'yes', ts: ts.toISOString() })
  assert.equal(calls.length, 3)
  assert.ok(calls[2].url.endsWith('/messages'))
  assert.equal(calls[2].body.messages[0].metadata.bridge_session, '')

  // Next day: a new session call.
  await p.writeTurn({ user: 'a', assistant: 'b', ts: new Date(2026, 10, 14, 9) })
  assert.equal(calls.length, 5)
  assert.equal(calls[3].body.id, 'venom-os-2026-11-14')
})

test('writeTurn: a failed session create is not remembered', async () => {
  let fail = true
  const { calls, fetchImpl } = fakeFetch((c) => {
    if (c.url.endsWith('/sessions') && fail) return { status: 503, body: { detail: 'down' } }
    return { status: 201, body: [] }
  })
  const p = createHonchoProvider(cfg(), { fetchImpl })
  const ts = new Date(2026, 10, 13, 12)
  await assert.rejects(p.writeTurn({ user: 'u', assistant: 'a', ts }), (e) => {
    assert.ok(e instanceof HonchoError)
    assert.equal(e.status, 503)
    assert.equal(e.retryable, true)
    assert.match(e.message, /Honcho 503 on create session/)
    return true
  })
  assert.equal(calls.length, 1)
  fail = false
  await p.writeTurn({ user: 'u', assistant: 'a', ts })
  assert.equal(calls.length, 3)
  assert.ok(calls[1].url.endsWith('/sessions'))
  assert.ok(calls[2].url.endsWith('/messages'))
})

test('writeTurn: messages failure carries the status', async () => {
  const { fetchImpl } = fakeFetch((c) => (c.url.endsWith('/messages') ? { status: 422 } : { status: 200, body: {} }))
  const p = createHonchoProvider(cfg(), { fetchImpl })
  await assert.rejects(p.writeTurn({ user: 'u', assistant: 'a' }), (e) => {
    assert.equal(e.status, 422)
    assert.equal(e.retryable, false)
    assert.equal(e.message, 'Honcho 422 on create messages')
    return true
  })
})

test('writeTurn: empty sides throw 400 without any network call', async () => {
  const { calls, fetchImpl } = fakeFetch()
  const p = createHonchoProvider(cfg(), { fetchImpl })
  for (const t of [{ user: '', assistant: 'a' }, { user: 'u', assistant: '  ' }, { user: 5, assistant: 'a' }, {}]) {
    await assert.rejects(p.writeTurn(t), (e) => e instanceof HonchoError && e.status === 400 && e.retryable === false)
  }
  assert.equal(calls.length, 0)
})

test('writeTurn: content is cut to 25000 characters', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 201, body: [] }))
  const p = createHonchoProvider(cfg(), { fetchImpl })
  await p.writeTurn({ user: 'u'.repeat(30000), assistant: 'a'.repeat(25001) })
  const msgs = calls[1].body.messages
  assert.equal(msgs[0].content.length, 25000)
  assert.equal(msgs[1].content.length, 25000)
})

test('path segments are URI-encoded', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: { peer_card: [] } }))
  // Normally sanitised by the config; a hand-made config still must not break the path.
  const p = createHonchoProvider(cfg({ workspace: 'w s', aiPeer: 'a/b' }), { fetchImpl })
  await p.ping()
  assert.ok(calls[0].url.includes('/v3/workspaces/w%20s/peers/a%2Fb/card'), calls[0].url)
})

// --- timeouts and network errors -------------------------------------------

test('a fetch that honours the abort signal times out as status 0', async () => {
  const fetchImpl = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
    })
  const p = createHonchoProvider(cfg({ timeoutMs: 30 }), { fetchImpl })
  await assert.rejects(p.search('x'), (e) => {
    assert.ok(e instanceof HonchoError)
    assert.equal(e.status, 0)
    assert.equal(e.retryable, true)
    assert.equal(e.message, 'Honcho unreachable: timeout after 30 ms')
    return true
  })
})

test('a fetch that ignores the signal still times out (per-call override)', async () => {
  const fetchImpl = () => new Promise(() => {})
  const p = createHonchoProvider(cfg({ timeoutMs: 60000 }), { fetchImpl })
  const t0 = Date.now()
  await assert.rejects(p.profile({ timeoutMs: 25 }), (e) => e.status === 0 && /timeout after 25 ms/.test(e.message))
  assert.ok(Date.now() - t0 < 5000)
})

test('a rejected fetch becomes a retryable status 0 error', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED ${KEY}`), { code: 'ECONNREFUSED' }) })
  }
  const p = createHonchoProvider(cfg(), { fetchImpl })
  await assert.rejects(p.writeTurn({ user: 'secret words', assistant: 'b' }), (e) => {
    assert.equal(e.status, 0)
    assert.equal(e.retryable, true)
    assert.match(e.message, /^Honcho unreachable/)
    assert.ok(!e.message.includes(KEY))
    assert.ok(!e.message.includes('secret words'))
    return true
  })
})

// --- search ----------------------------------------------------------------

test('search: request shape, peer mapping, empty content skipped', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({
    status: 200,
    body: [
      { id: '1', content: 'I like tea', peer_id: 'owner', session_id: 's1', metadata: {}, created_at: '2026-11-01T10:00:00Z' },
      { id: '2', content: 'Noted', peer_id: 'venom', session_id: 's1', metadata: {}, created_at: '2026-11-01T10:00:00.001Z' },
      { id: '3', content: '', peer_id: 'owner', session_id: 's1', created_at: '2026-11-01T10:00:00Z' },
      { id: '4', content: 'from chat', peer_id: 'hermes', session_id: 's2', created_at: '2026-11-02T08:00:00Z' },
    ],
  }))
  const p = createHonchoProvider(cfg(), { fetchImpl })
  const hits = await p.search('tea')
  assert.equal(calls[0].method, 'POST')
  assert.equal(path(calls[0].url), '/v3/workspaces/hermes/search')
  assert.deepEqual(calls[0].body, { query: 'tea', limit: 8 })
  assert.deepEqual(hits, [
    { who: 'owner', text: 'I like tea', when: '2026-11-01T10:00:00.000Z', session: 's1' },
    { who: 'venom', text: 'Noted', when: '2026-11-01T10:00:00.001Z', session: 's1' },
    { who: 'hermes', text: 'from chat', when: '2026-11-02T08:00:00.000Z', session: 's2' },
  ])
})

test('search: limit clamped to 1..20, query cut to 4000', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({ status: 200, body: [] }))
  const p = createHonchoProvider(cfg(), { fetchImpl })
  await p.search('q', { limit: 500 })
  await p.search('q', { limit: 0 })
  await p.search('q', { limit: -3 })
  await p.search('x'.repeat(5000))
  assert.equal(calls[0].body.limit, 20)
  assert.equal(calls[1].body.limit, 1)
  assert.equal(calls[2].body.limit, 1)
  assert.equal(calls[3].body.query.length, 4000)
})

test('search: an error status throws HonchoError', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 401 }))
  const p = createHonchoProvider(cfg(), { fetchImpl })
  await assert.rejects(p.search('x'), (e) => e.status === 401 && e.retryable === false && e.message === 'Honcho refused the key (401) on search')
})

// --- profile ---------------------------------------------------------------

test('profile: observer venom, target owner, optional search_query', async () => {
  const { calls, fetchImpl } = fakeFetch(() => ({
    status: 200,
    body: { peer_id: 'venom', target_id: 'owner', representation: 'Alex runs a store.', peer_card: ['Name: Alex', 'Lives in Paris'] },
  }))
  const p = createHonchoProvider(cfg(), { fetchImpl })
  const r = await p.profile()
  assert.deepEqual(r, { card: ['Name: Alex', 'Lives in Paris'], representation: 'Alex runs a store.' })
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].body, undefined)
  assert.equal(path(calls[0].url), '/v3/workspaces/hermes/peers/venom/context')
  assert.deepEqual(params(calls[0].url), { target: 'owner' })
  await p.profile({ query: 'coffee order' })
  assert.deepEqual(params(calls[1].url), { target: 'owner', search_query: 'coffee order' })
})

test('profile: nulls become empty values', async () => {
  const { fetchImpl } = fakeFetch(() => ({ status: 200, body: { representation: null, peer_card: null } }))
  const p = createHonchoProvider(cfg(), { fetchImpl })
  assert.deepEqual(await p.profile(), { card: [], representation: '' })
})

// --- ping and describe -----------------------------------------------------

test('ping: reads the card and never throws', async () => {
  const ok = fakeFetch(() => ({ status: 200, body: { peer_card: null } }))
  const p = createHonchoProvider(cfg(), { fetchImpl: ok.fetchImpl })
  const r = await p.ping()
  assert.equal(r.ok, true)
  assert.equal(typeof r.ms, 'number')
  assert.equal(path(ok.calls[0].url), '/v3/workspaces/hermes/peers/venom/card')
  assert.deepEqual(params(ok.calls[0].url), { target: 'owner' })

  const bad = createHonchoProvider(cfg(), { fetchImpl: fakeFetch(() => ({ status: 401 })).fetchImpl })
  const b = await bad.ping()
  assert.equal(b.ok, false)
  assert.equal(b.error, 'Honcho refused the key (401) on ping')

  const boom = createHonchoProvider(cfg(), {
    fetchImpl: () => {
      throw new Error(`sync explosion ${KEY}`)
    },
  })
  const c = await boom.ping()
  assert.equal(c.ok, false)
  assert.ok(!c.error.includes(KEY))

  const slow = createHonchoProvider(cfg(), { fetchImpl: () => new Promise(() => {}) })
  const d = await slow.ping({ timeoutMs: 20 })
  assert.equal(d.ok, false)
  assert.match(d.error, /timeout after 20 ms/)
})

test('describe: names the workspace, peers and session, never the key or URL', () => {
  const p = createHonchoProvider(cfg({ baseUrl: 'http://localhost:9?token=zzz' }), { fetchImpl: fakeFetch().fetchImpl })
  const d = p.describe()
  assert.equal(p.name, 'honcho')
  assert.equal(p.label, 'Honcho')
  assert.equal(d, `workspace hermes · peers owner/venom · session ${sessionIdFor(new Date())}`)
  assert.ok(!d.includes(KEY))
  assert.ok(!d.includes('localhost'))
})

test('no error message ever contains the key', async () => {
  const statuses = [400, 401, 403, 404, 408, 413, 422, 425, 429, 500, 503]
  for (const s of statuses) {
    const { fetchImpl } = fakeFetch(() => ({ status: s, body: { detail: `bad key ${KEY}` } }))
    const p = createHonchoProvider(cfg(), { fetchImpl })
    for (const run of [() => p.writeTurn({ user: 'u', assistant: 'a' }), () => p.search('q'), () => p.profile({ query: 'q' })]) {
      await assert.rejects(run(), (e) => {
        assert.ok(e instanceof HonchoError)
        assert.equal(e.status, s)
        assert.ok(!e.message.includes(KEY))
        assert.ok(!e.message.includes('?'))
        return true
      })
    }
    const pr = await p.ping()
    assert.ok(!pr.error.includes(KEY))
  }
})

test('config: a Hermes profile folder also reads the key and honcho.json of its root', () => {
  const root = mkdtempSync(join(tmpdir(), 'venom-honcho-prof-'))
  homes.push(root)
  const profile = join(root, 'profiles', 'venom')
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(root, '.env'), 'HONCHO_API_KEY=root-key-not-real\n')
  writeFileSync(join(root, 'honcho.json'), JSON.stringify({ hosts: { hermes: { peerName: 'owner1', aiPeer: 'ai1' } } }))
  const cfg = honchoConfig({ HERMES_HOME: profile })
  assert.equal(cfg.enabled, true)
  assert.equal(cfg.apiKey, 'root-key-not-real')
  assert.equal(cfg.userPeer, 'owner1')
  assert.equal(cfg.aiPeer, 'ai1')
  // The profile's own files win when they exist.
  writeFileSync(join(profile, '.env'), 'HONCHO_API_KEY=profile-key-not-real\n')
  assert.equal(honchoConfig({ HERMES_HOME: profile }).apiKey, 'profile-key-not-real')
  // A folder that is not a profile never looks above itself.
  const plain = join(root, 'elsewhere', 'venom')
  mkdirSync(plain, { recursive: true })
  assert.equal(honchoConfig({ HERMES_HOME: plain }).why, 'no API key')
})

test('writeTurn: an account out of credits is said in words and is not retryable', async () => {
  const { fetchImpl } = fakeFetch((c) =>
    c.url.endsWith('/messages') ? { status: 402, body: { detail: 'Payment required: add credits at https://example.invalid/billing' } } : { status: 200, body: {} },
  )
  const p = createHonchoProvider(cfg(), { fetchImpl })
  await assert.rejects(
    p.writeTurn({ user: 'hello', assistant: 'hi', ts: new Date(), session: 's' }),
    (e) =>
      e.status === 402 &&
      e.retryable === false &&
      e.message === 'Honcho is out of credits (402) on create messages' &&
      !e.message.includes('billing'),
  )
})
