// The long-term memory layer. A fake provider and a hand-driven clock: nothing
// here sleeps, and nothing touches the network.
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLongMemory, disabledLongMemory, formatRecall, longMemoryServer } from '../bridge/longmemory.mjs'

// --- helpers -----------------------------------------------------------------

/** Let every pending promise chain run. */
const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r))
}

/** A tiny manual scheduler: timers only fire when the test advances time. */
function makeClock(start = Date.UTC(2026, 10, 13, 10, 0, 0)) {
  let t = start
  let seq = 0
  const timers = new Map()
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = ++seq
      timers.set(id, { fn, at: t + Math.max(0, Number(ms) || 0) })
      return id
    },
    clearTimer: (id) => {
      timers.delete(id)
    },
    pending: () => timers.size,
    async advance(ms = 0) {
      const end = t + ms
      for (;;) {
        await settle()
        let next = null
        for (const [id, tm] of timers) if (tm.at <= end && (!next || tm.at < next[1].at)) next = [id, tm]
        if (!next) break
        timers.delete(next[0])
        t = Math.max(t, next[1].at)
        next[1].fn()
      }
      t = end
      await settle()
    },
  }
}

const fail = (message, status, retryable) => Object.assign(new Error(message), { status, retryable })

/** A provider that records everything; `failures` is a list of errors thrown by the next sends. */
function fakeProvider(over = {}) {
  const p = {
    name: 'fake',
    label: 'Fake',
    sends: [],
    writes: [],
    failures: [],
    searches: [],
    profiles: [],
    describe: () => 'fake provider',
    async ping() {
      return { ok: true, ms: 3 }
    },
    async writeTurn(turn) {
      p.sends.push(turn)
      const f = p.failures.shift()
      if (f) throw f
      p.writes.push(turn)
      return { session: 'venom-os-2026-11-13', ids: ['a', 'b'] }
    },
    async search(query, opts) {
      p.searches.push({ query, opts })
      return [
        { who: 'owner', text: 'The launch is on Friday', when: '2026-11-10T08:30:00.000Z', session: 'venom-os-2026-11-10' },
        { who: 'venom', text: 'Noted, sir.', when: '2026-11-10T08:30:00.001Z', session: 'venom-os-2026-11-10' },
      ]
    },
    async profile(opts) {
      p.profiles.push(opts)
      return { card: ['Name: Alex', 'Lives in Paris'], representation: 'Runs an online store.' }
    },
    ...over,
  }
  return p
}

const quietLog = () => {
  const lines = { log: [], error: [] }
  return { lines, log: (m) => lines.log.push(m), error: (m) => lines.error.push(m) }
}

const dirs = []
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'venom-longmem-'))
  dirs.push(d)
  return d
}
const live = []
afterEach(() => {
  for (const m of live.splice(0)) m.stop()
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function make(opts = {}) {
  const clock = opts.clock ?? makeClock()
  const provider = opts.provider ?? fakeProvider()
  const log = opts.log ?? quietLog()
  const mem = createLongMemory({
    provider,
    log,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    ...opts.options,
  })
  live.push(mem)
  return { mem, clock, provider, log }
}

const turn = (n) => ({ session: 's1', user: `question ${n}`, assistant: `answer ${n}` })
const readOutbox = (dir) => JSON.parse(readFileSync(join(dir, 'outbox-fake.json'), 'utf8'))

// --- storing and sending --------------------------------------------------------

test('storeTurn returns at once and sends in the background, oldest first', async () => {
  const { mem, clock, provider } = make()
  const a = mem.storeTurn(turn(1))
  const b = mem.storeTurn({ ...turn(2), ts: '2026-11-12T09:00:00Z' })
  assert.equal(typeof a, 'string')
  assert.notEqual(a, b)
  assert.equal(provider.sends.length, 0, 'nothing is sent inside the call')
  assert.equal(mem.status().queued, 2)
  await clock.advance(0)
  assert.deepEqual(
    provider.writes.map((w) => w.user),
    ['question 1', 'question 2'],
  )
  assert.equal(provider.writes[0].ts, new Date(clock.now()).toISOString())
  assert.equal(provider.writes[1].ts, '2026-11-12T09:00:00.000Z')
  assert.equal(provider.writes[0].session, 's1')
  const s = mem.status()
  assert.equal(s.state, 'ok')
  assert.equal(s.queued, 0)
  assert.equal(s.sent, 2)
  assert.equal(s.lastOkAt, clock.now())
  assert.equal(mem.enabled, true)
  assert.equal(mem.name, 'fake')
  assert.equal(mem.label, 'Fake')
})

test('sends are strictly one at a time', async () => {
  let inFlight = 0
  let most = 0
  const provider = fakeProvider({
    async writeTurn() {
      inFlight++
      most = Math.max(most, inFlight)
      await new Promise((r) => setImmediate(r))
      inFlight--
      return { session: 'x', ids: [] }
    },
  })
  const { mem, clock } = make({ provider })
  for (let i = 0; i < 5; i++) mem.storeTurn(turn(i))
  await clock.advance(0)
  assert.equal(most, 1)
  assert.equal(mem.status().sent, 5)
})

test('a turn missing either side is not stored', () => {
  const { mem, provider } = make()
  assert.equal(mem.storeTurn({ session: 's', user: 'hi', assistant: '' }), null)
  assert.equal(mem.storeTurn({ session: 's', user: '   ', assistant: 'Hello.' }), null)
  assert.equal(mem.storeTurn({ session: 's', user: 'hi', assistant: undefined }), null)
  assert.equal(mem.storeTurn({ session: 's', user: 42, assistant: 'x' }), null)
  assert.equal(mem.storeTurn(), null)
  assert.equal(mem.status().queued, 0)
  assert.equal(provider.sends.length, 0)
})

test('both sides are trimmed and secrets are redacted before the provider sees them', async () => {
  const { mem, clock, provider } = make()
  const key = `sk-${'a1B2'.repeat(6)}`
  mem.storeTurn({
    session: 's',
    user: `  my api key is ${key} and card 4111 1111 1111 1111  `,
    assistant: ` The password is hunter2, noted. `,
  })
  await clock.advance(0)
  const [w] = provider.writes
  assert.ok(!w.user.includes(key))
  assert.ok(!w.user.includes('4111'))
  assert.ok(!w.assistant.includes('hunter2'))
  assert.match(w.user, /\[redacted\]/)
  assert.match(w.assistant, /\[redacted\]/)
  assert.equal(w.user, w.user.trim())
})

// --- holding --------------------------------------------------------------------

test('a held turn waits; amend changes what is sent; release lets it go', async () => {
  const { mem, clock, provider } = make()
  const id = mem.storeTurn(turn(1), { hold: true })
  mem.storeTurn(turn(2))
  await clock.advance(0)
  assert.deepEqual(provider.writes.map((w) => w.user), ['question 2'], 'later turns are not blocked by a held one')
  assert.equal(mem.status().held, 1)
  assert.equal(mem.amend(id, '  answer 1, cut short  '), true)
  assert.equal(mem.amend(id, '   '), false)
  assert.equal(mem.release(id), true)
  assert.equal(mem.release(id), false, 'already released')
  assert.equal(mem.release('no-such-id'), false)
  await clock.advance(0)
  assert.equal(provider.writes[1].assistant, 'answer 1, cut short')
  assert.equal(mem.amend(id, 'too late'), false, 'a sent turn cannot change')
  assert.equal(mem.status().held, 0)
})

test('a held turn is released by itself after holdMs', async () => {
  const { mem, clock, provider } = make({ options: { holdMs: 1000 } })
  const id = mem.storeTurn(turn(1), { hold: true })
  await clock.advance(999)
  assert.equal(provider.sends.length, 0)
  await clock.advance(1)
  assert.equal(provider.writes.length, 1)
  assert.equal(provider.writes[0].assistant, 'answer 1')
  assert.equal(mem.amend(id, 'x'), false)
  assert.equal(mem.release(id), false)
})

test('amend is refused once a turn was auto-released but is still waiting to send', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('down', 503, true))
  const { mem, clock } = make({ provider, options: { holdMs: 10 } })
  const id = mem.storeTurn(turn(1), { hold: true })
  await clock.advance(10)
  assert.equal(mem.status().queued, 1)
  assert.equal(mem.amend(id, 'changed'), false)
})

// --- failures ---------------------------------------------------------------------

test('a retryable failure keeps the turn and backs off, doubling, until it works', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('Honcho 503 on create messages', 503, true), fail('Honcho unreachable', 0, true), new Error('no flag at all'))
  const { mem, clock, log } = make({ provider, options: { retryBaseMs: 100, retryMaxMs: 1000 } })
  mem.storeTurn(turn(1))
  await clock.advance(0)
  assert.equal(provider.sends.length, 1)
  let s = mem.status()
  assert.equal(s.state, 'offline')
  assert.equal(s.lastError, 'Honcho 503 on create messages')
  assert.equal(s.queued, 1)
  mem.storeTurn(turn(2))
  await clock.advance(99)
  assert.equal(provider.sends.length, 1, 'a new turn does not cut the backoff short')
  await clock.advance(1)
  assert.equal(provider.sends.length, 2)
  await clock.advance(199)
  assert.equal(provider.sends.length, 2)
  await clock.advance(1)
  assert.equal(provider.sends.length, 3, 'an error without .retryable counts as retryable')
  assert.equal(mem.status().lastError, 'no flag at all')
  await clock.advance(400)
  s = mem.status()
  assert.equal(s.state, 'ok')
  assert.equal(s.lastError, '')
  assert.equal(s.sent, 2)
  assert.equal(s.queued, 0)
  assert.equal(s.dropped, 0)
  assert.deepEqual(provider.writes.map((w) => w.user), ['question 1', 'question 2'])
  assert.equal(log.lines.error.filter((l) => /offline/.test(l)).length, 1, 'the state change is logged once, not per retry')
  assert.equal(log.lines.log.filter((l) => /reachable again/.test(l)).length, 1)
  // reset on success: the next failure waits the base again
  provider.failures.push(fail('down', 500, true))
  mem.storeTurn(turn(3))
  await clock.advance(0)
  await clock.advance(100)
  assert.equal(mem.status().sent, 3)
})

test('the backoff is capped at retryMaxMs', async () => {
  const provider = fakeProvider()
  for (let i = 0; i < 6; i++) provider.failures.push(fail('down', 502, true))
  const { mem, clock } = make({ provider, options: { retryBaseMs: 100, retryMaxMs: 300 } })
  mem.storeTurn(turn(1))
  await clock.advance(0) // fail 1, wait 100
  await clock.advance(100) // fail 2, wait 200
  await clock.advance(200) // fail 3, wait 300 (cap)
  await clock.advance(300) // fail 4, wait 300
  assert.equal(provider.sends.length, 4)
  await clock.advance(299)
  assert.equal(provider.sends.length, 4)
  await clock.advance(1)
  assert.equal(provider.sends.length, 5)
})

test('a non-retryable failure drops that one turn, without logging its text, and goes on', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('Honcho 422 on create messages', 422, false))
  const { mem, clock, log } = make({ provider })
  mem.storeTurn({ session: 's', user: 'very private words', assistant: 'reply' })
  mem.storeTurn(turn(2))
  await clock.advance(0)
  const s = mem.status()
  assert.equal(s.dropped, 1)
  assert.equal(s.sent, 1)
  assert.equal(s.queued, 0)
  assert.deepEqual(provider.writes.map((w) => w.user), ['question 2'])
  const all = [...log.lines.log, ...log.lines.error].join('\n')
  assert.match(all, /dropped/)
  assert.doesNotMatch(all, /private words/)
})

test('a refused key (401, 403) or an empty account (402) keeps the turn, goes offline and waits retryMaxMs', async () => {
  for (const status of [401, 402, 403]) {
    const provider = fakeProvider()
    provider.failures.push(fail(`Honcho ${status} on create messages`, status, false))
    const { mem, clock } = make({ provider, options: { retryBaseMs: 100, retryMaxMs: 5000 } })
    mem.storeTurn(turn(1))
    await clock.advance(0)
    assert.equal(mem.status().state, 'offline')
    assert.equal(mem.status().queued, 1)
    assert.equal(mem.status().dropped, 0)
    assert.equal(mem.status().lastError, `Honcho ${status} on create messages`)
    await clock.advance(4999)
    assert.equal(provider.sends.length, 1)
    await clock.advance(1)
    assert.equal(provider.writes.length, 1)
    assert.equal(mem.status().state, 'ok')
  }
})

test('past maxQueue the oldest turn is dropped and counted', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('down', 503, true))
  const { mem, clock, log } = make({ provider, options: { maxQueue: 3, retryBaseMs: 1000 } })
  mem.storeTurn(turn(1))
  await clock.advance(0) // offline, turn 1 waiting
  mem.storeTurn(turn(2))
  mem.storeTurn(turn(3))
  mem.storeTurn(turn(4))
  const s = mem.status()
  assert.equal(s.queued, 3)
  assert.equal(s.dropped, 1)
  assert.equal(log.lines.error.filter((l) => /queue full/.test(l)).length, 1)
  await clock.advance(1000)
  assert.deepEqual(provider.writes.map((w) => w.user), ['question 2', 'question 3', 'question 4'])
})

test('flush sends now, ignoring the backoff', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('down', 503, true))
  const { mem, clock } = make({ provider, options: { retryBaseMs: 60_000 } })
  mem.storeTurn(turn(1))
  await clock.advance(0)
  assert.equal(mem.status().queued, 1)
  await mem.flush()
  assert.equal(mem.status().queued, 0)
  assert.equal(mem.status().sent, 1)
})

// --- the outbox -----------------------------------------------------------------

test('the outbox is saved atomically on every change and survives a new instance', async () => {
  const dir = join(tempDir(), 'nested', 'outbox')
  const down = fakeProvider({
    async writeTurn() {
      throw fail('down', 503, true)
    },
  })
  const first = make({ provider: down, options: { dir } })
  const a = first.mem.storeTurn(turn(1))
  const b = first.mem.storeTurn(turn(2), { hold: true })
  await first.clock.advance(0)
  let saved = readOutbox(dir)
  assert.deepEqual(saved.map((t) => t.id), [a, b])
  assert.deepEqual(Object.keys(saved[0]).sort(), ['assistant', 'held', 'id', 'session', 'ts', 'user'])
  assert.equal(saved[1].held, true)
  first.mem.amend(b, 'answer 2, as heard')
  saved = readOutbox(dir)
  assert.equal(saved[1].assistant, 'answer 2, as heard')
  assert.deepEqual(readdirSync(dir), ['outbox-fake.json'], 'no temp file left behind')
  first.mem.stop()

  const second = make({ options: { dir } })
  const ping = await second.mem.start()
  assert.deepEqual(ping, { ok: true, ms: 3 })
  assert.equal(second.mem.status().held, 0, 'loaded held turns count as released')
  await second.clock.advance(0)
  assert.deepEqual(
    second.provider.writes.map((w) => [w.user, w.assistant]),
    [
      ['question 1', 'answer 1'],
      ['question 2', 'answer 2, as heard'],
    ],
  )
  assert.equal(existsSync(join(dir, 'outbox-fake.json')), false, 'an empty outbox is removed')
})

test('a turn stored before start() does not wipe what an earlier run left', async () => {
  const dir = tempDir()
  writeFileSync(
    join(dir, 'outbox-fake.json'),
    JSON.stringify([{ id: 'old-1', session: 's0', user: 'old q', assistant: 'old a', ts: '2026-11-01T00:00:00.000Z', held: true }]),
  )
  const { mem, clock, provider } = make({ options: { dir } })
  mem.storeTurn(turn(1))
  await clock.advance(0)
  assert.deepEqual(provider.writes.map((w) => w.user), ['old q', 'question 1'])
})

test('a bad or missing outbox file is an empty queue', async () => {
  const dir = tempDir()
  writeFileSync(join(dir, 'outbox-fake.json'), '{ not json')
  const { mem } = make({ options: { dir } })
  await mem.start()
  assert.equal(mem.status().queued, 0)
  const other = make({ options: { dir: join(tempDir(), 'missing') } })
  await other.mem.start()
  assert.equal(other.mem.status().queued, 0)
})

test('a disk error never escapes storeTurn and is logged once', async () => {
  const root = tempDir()
  const blocker = join(root, 'not-a-folder')
  writeFileSync(blocker, 'x')
  const provider = fakeProvider()
  provider.failures.push(fail('down', 503, true))
  const { mem, clock, log } = make({ provider, options: { dir: blocker } })
  assert.equal(typeof mem.storeTurn(turn(1)), 'string')
  assert.equal(typeof mem.storeTurn(turn(2)), 'string')
  assert.equal(mem.status().queued, 2)
  assert.equal(log.lines.error.filter((l) => /outbox/.test(l)).length, 1)
  await clock.advance(5000)
  assert.equal(mem.status().sent, 2, 'the queue in memory still goes out')
})

// --- start ----------------------------------------------------------------------

test('start() with an unreachable provider goes offline, and storeTurn still queues', async () => {
  const provider = fakeProvider({
    async ping() {
      return { ok: false, ms: 8000, error: 'Honcho unreachable: timeout after 8000 ms' }
    },
    async writeTurn() {
      throw fail('Honcho unreachable', 0, true)
    },
    async profile() {
      throw fail('Honcho unreachable', 0, true)
    },
  })
  const { mem, clock } = make({ provider })
  const r = await mem.start()
  assert.deepEqual(r, { ok: false, ms: 8000, error: 'Honcho unreachable: timeout after 8000 ms' })
  assert.equal(mem.status().state, 'offline')
  assert.equal(mem.status().lastError, 'Honcho unreachable: timeout after 8000 ms')
  assert.equal(typeof mem.storeTurn(turn(1)), 'string')
  await clock.advance(0)
  assert.equal(mem.status().queued, 1)
  assert.equal(mem.profileText(), '')
})

test('start() survives a ping that throws, and kicks off a profile refresh without waiting', async () => {
  let resolveProfile
  const provider = fakeProvider({
    async ping() {
      throw new Error('boom')
    },
    profile: () => new Promise((r) => (resolveProfile = r)),
  })
  const { mem, clock } = make({ provider })
  const r = await mem.start()
  assert.equal(r.ok, false)
  assert.equal(r.error, 'boom')
  assert.equal(mem.profileText(), '')
  resolveProfile({ card: ['Name: Alex'], representation: null })
  await clock.advance(0)
  assert.equal(mem.profileText(), '- Name: Alex')
})

test('stop() clears every timer', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('down', 503, true))
  const { mem, clock } = make({ provider })
  mem.storeTurn(turn(1), { hold: true })
  mem.storeTurn(turn(2))
  await clock.advance(0)
  assert.ok(clock.pending() >= 2)
  mem.stop()
  assert.equal(clock.pending(), 0)
})

test('with real timers nothing keeps the process alive', async () => {
  const mem = createLongMemory({ provider: fakeProvider(), log: quietLog() })
  live.push(mem)
  mem.storeTurn(turn(1), { hold: true })
  mem.storeTurn(turn(2))
  await new Promise((r) => setTimeout(r, 5))
  assert.equal(mem.status().sent, 1)
  mem.stop()
})

// --- recall ---------------------------------------------------------------------

test('recall runs search and profile together and passes the timeouts', async () => {
  const { mem, provider } = make({ options: { recallTimeoutMs: 1234, profileTimeoutMs: 2345 } })
  const r = await mem.recall('launch date', { limit: 5 })
  assert.equal(r.ok, true)
  assert.equal(r.hits.length, 2)
  assert.deepEqual(r.hits[0], {
    who: 'owner',
    text: 'The launch is on Friday',
    when: '2026-11-10T08:30:00.000Z',
    session: 'venom-os-2026-11-10',
  })
  assert.deepEqual(r.profile, { card: ['Name: Alex', 'Lives in Paris'], representation: 'Runs an online store.' })
  assert.deepEqual(provider.searches, [{ query: 'launch date', opts: { limit: 5, timeoutMs: 1234 } }])
  assert.deepEqual(provider.profiles, [{ query: 'launch date', timeoutMs: 2345 }])
  assert.equal(mem.status().state, 'ok')
})

test('recall reports a failed search, keeps a profile that worked, and never throws', async () => {
  const provider = fakeProvider({
    async search() {
      throw fail('Honcho 503 on search', 503, true)
    },
  })
  const { mem } = make({ provider })
  const r = await mem.recall('x')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Honcho 503 on search')
  assert.deepEqual(r.hits, [])
  assert.equal(r.profile.card.length, 2)
  assert.equal(mem.status().state, 'unknown', 'a failed search does not change the state')

  const broken = make({
    provider: fakeProvider({
      search() {
        throw new Error('sync throw')
      },
      profile() {
        throw new Error('also')
      },
    }),
  })
  const r2 = await broken.mem.recall('x')
  assert.equal(r2.ok, false)
  assert.equal(r2.error, 'sync throw')
  assert.equal(r2.profile, null)
})

test('a provider that never answers hits recall’s own timeout', async () => {
  const provider = fakeProvider({
    search: () => new Promise(() => {}),
    profile: () => new Promise(() => {}),
  })
  const { mem, clock } = make({ provider, options: { recallTimeoutMs: 4000, profileTimeoutMs: 3000 } })
  let result = null
  mem.recall('anything').then((r) => (result = r))
  await clock.advance(3999)
  assert.equal(result, null)
  await clock.advance(1)
  assert.equal(result.ok, false)
  assert.match(result.error, /timed out after 4000 ms/)
  assert.equal(result.profile, null)
  assert.equal(clock.pending(), 0)
})

// --- the profile snapshot --------------------------------------------------------

test('profileText: empty at first, then the cached snapshot, cut to profileMaxChars', async () => {
  const { mem, provider } = make({ options: { profileMaxChars: 40 } })
  provider.profile = async () => ({ card: ['Name: Alex'], representation: 'x'.repeat(100) })
  assert.equal(mem.profileText(), '')
  await mem.refreshProfile()
  const t = mem.profileText()
  assert.equal(t.length, 40)
  assert.ok(t.startsWith('- Name: Alex\nxxx'))
  assert.ok(t.endsWith('…'))
})

test('profileText refreshes in the background when stale and still answers at once', async () => {
  const { mem, clock, provider } = make({ options: { profileTtlMs: 10_000 } })
  await mem.refreshProfile()
  assert.equal(provider.profiles.length, 1)
  assert.equal(mem.profileText(), '- Name: Alex\n- Lives in Paris\nRuns an online store.')
  await clock.advance(5_000)
  mem.profileText()
  await settle()
  assert.equal(provider.profiles.length, 1, 'fresh: no network')

  let resolve
  provider.profile = () => new Promise((r) => (resolve = r))
  await clock.advance(6_000)
  assert.equal(mem.profileText(), '- Name: Alex\n- Lives in Paris\nRuns an online store.', 'old text right away')
  mem.profileText()
  resolve({ card: ['Name: Alex'], representation: 'Now sells sneakers.' })
  await clock.advance(0)
  assert.equal(mem.profileText(), '- Name: Alex\nNow sells sneakers.')
})

test('refreshProfile never runs twice at once and never throws', async () => {
  let calls = 0
  let resolve
  const provider = fakeProvider({
    profile: () => {
      calls++
      return new Promise((r) => (resolve = r))
    },
  })
  const { mem, clock } = make({ provider })
  const a = mem.refreshProfile()
  const b = mem.refreshProfile()
  assert.equal(calls, 1)
  resolve({ card: [], representation: 'r' })
  await Promise.all([a, b])
  await clock.advance(0)

  provider.profile = async () => {
    throw new Error('down')
  }
  await mem.refreshProfile()
  assert.equal(mem.profileText(), 'r', 'a failed refresh keeps the old snapshot')
})

// --- formatting and the tool --------------------------------------------------------

test('formatRecall: unreachable, nothing found, profile only, and hits', () => {
  assert.equal(
    formatRecall({ ok: false, hits: [], profile: null, error: 'Honcho 503 on search' }),
    'Long-term memory could not be reached (Honcho 503 on search). Use memory_search for spoken conversations on this PC.',
  )
  assert.equal(formatRecall({ ok: true, hits: [], profile: null }), 'Nothing found in long-term memory.')
  assert.equal(formatRecall({ ok: true, hits: [], profile: { card: [], representation: '' } }), 'Nothing found in long-term memory.')
  assert.equal(
    formatRecall({ ok: true, hits: [], profile: { card: ['Name: Alex'], representation: 'Likes tea.' } }),
    'What is known about the owner:\n- Name: Alex\nLikes tea.',
  )

  const when = new Date(2026, 10, 10, 9, 5).toISOString()
  const out = formatRecall({
    ok: true,
    profile: { card: ['Name: Alex'], representation: '' },
    hits: [
      { who: 'owner', text: 'Launch\n  on Friday', when, session: 'venom-os-2026-11-10' },
      { who: 'venom', text: 'y'.repeat(1000), when, session: 'venom-os-2026-11-10' },
      { who: 'hermes', text: 'From the chat.', when, session: 'telegram-1' },
    ],
  })
  const [about, past] = out.split('\n\n')
  assert.equal(about, 'What is known about the owner:\n- Name: Alex')
  const lines = past.split('\n')
  assert.equal(lines[0], "Past messages (all of the owner's conversations, chat and voice):")
  assert.equal(lines[1], '2026-11-10 09:05 · venom-os-2026-11-10 · Owner: Launch on Friday')
  assert.ok(lines[2].startsWith('2026-11-10 09:05 · venom-os-2026-11-10 · Venom: yyy'))
  assert.ok(lines[2].endsWith('…'))
  assert.equal(lines[2].split('Venom: ')[1].length, 600)
  assert.equal(lines[3], '2026-11-10 09:05 · telegram-1 · hermes: From the chat.')

  const many = { ok: true, profile: null, hits: Array.from({ length: 50 }, () => ({ who: 'owner', text: 'z'.repeat(500), when, session: 's' })) }
  assert.equal(formatRecall(many).length, 3500)
  assert.equal(formatRecall(many, { maxChars: 200 }).length, 200)
})

test('disabledLongMemory answers every call and does nothing', async () => {
  const off = disabledLongMemory('no API key')
  assert.equal(off.enabled, false)
  assert.equal(off.storeTurn(turn(1), { hold: true }), null)
  assert.equal(off.amend('x', 'y'), false)
  assert.equal(off.release('x'), false)
  assert.deepEqual(await off.recall('q'), { ok: false, hits: [], profile: null, error: 'Long-term memory is off.' })
  assert.equal(off.profileText(), '')
  await off.refreshProfile()
  assert.deepEqual(off.status(), {
    provider: 'none',
    label: 'off',
    state: 'off',
    why: 'no API key',
    queued: 0,
    held: 0,
    sent: 0,
    dropped: 0,
    lastOkAt: null,
    lastError: '',
    writeFault: false,
    lastStatus: 0,
  })
  assert.deepEqual(await off.check(), { ok: false, ms: 0 })
  assert.deepEqual(await off.start(), { ok: false, ms: 0, error: 'no API key' })
  await off.flush()
  off.stop()
  for (const k of ['storeTurn', 'amend', 'release', 'recall', 'profileText', 'refreshProfile', 'status', 'start', 'flush', 'stop']) {
    assert.equal(typeof off[k], 'function', k)
  }
})

test('the tool is registered as memory_recall and returns the formatted text', async () => {
  const { mem } = make()
  const server = longMemoryServer(mem)
  const tools = server.instance?._registeredTools ?? {}
  assert.deepEqual(Object.keys(tools), ['memory_recall'])
  assert.equal(server.name, 'venom_recall')
  const handler = tools.memory_recall.handler ?? tools.memory_recall.callback
  assert.equal(typeof handler, 'function')
  const ok = await handler({ query: 'launch', limit: 3 }, {})
  assert.match(ok.content[0].text, /Owner: The launch is on Friday/)
  assert.equal(ok.isError, undefined)
  const bad = longMemoryServer(disabledLongMemory('off')).instance._registeredTools.memory_recall
  const r = await (bad.handler ?? bad.callback)({ query: 'x' }, {})
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /could not be reached \(Long-term memory is off\.\)/)
})

test('a read that works does not call the service healthy while writes are refused', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('Honcho is out of credits (402) on create messages', 402, false))
  const { mem, clock } = make({ provider, options: { retryBaseMs: 100, retryMaxMs: 5000 } })
  mem.storeTurn(turn(1))
  await clock.advance(0)
  assert.equal(mem.status().state, 'offline')
  const r = await mem.recall('launch')
  assert.equal(r.ok, true)
  assert.equal(mem.status().state, 'offline')
  assert.equal(mem.status().queued, 1)
  assert.match(mem.status().lastError, /out of credits/)
  // Once a send goes through, it is healthy again.
  await clock.advance(5000)
  assert.equal(provider.writes.length, 1)
  assert.equal(mem.status().state, 'ok')
  assert.equal(mem.status().queued, 0)
})

test('status() reports writeFault and lastStatus after a 402, and clears them once a write works', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('Honcho is out of credits (402) on create messages', 402, false))
  const { mem, clock } = make({ provider, options: { retryMaxMs: 5000 } })
  assert.equal(mem.status().writeFault, false)
  assert.equal(mem.status().lastStatus, 0)
  mem.storeTurn(turn(1))
  await clock.advance(0)
  assert.equal(mem.status().writeFault, true)
  assert.equal(mem.status().lastStatus, 402)
  await clock.advance(5000)
  assert.equal(mem.status().writeFault, false)
  assert.equal(mem.status().lastStatus, 0)
})

test('check() pings without flipping a write fault to ok, never throws and never returns an error text', async () => {
  const provider = fakeProvider()
  provider.failures.push(fail('refused', 401, false))
  const { mem, clock } = make({ provider, options: { retryMaxMs: 60_000 } })
  mem.storeTurn(turn(1))
  await clock.advance(0)
  assert.equal(mem.status().state, 'offline')
  const r = await mem.check()
  assert.deepEqual(Object.keys(r).sort(), ['ms', 'ok'])
  assert.equal(r.ok, true)
  assert.equal(mem.status().state, 'offline', 'a write fault keeps the state')
  assert.equal(mem.status().writeFault, true)

  const down = make({ provider: fakeProvider({ ping: async () => { throw new Error('ECONNREFUSED secret') } }) })
  assert.deepEqual(await down.mem.check(), { ok: false, ms: 0 })
  assert.equal(down.mem.status().state, 'offline')
  const fine = make()
  assert.equal((await fine.mem.check()).ok, true)
  assert.equal(fine.mem.status().state, 'ok')
})
