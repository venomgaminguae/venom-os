// scripts/gbrain-import.mjs: reading, sorting and sending past turns.
// Temp folders and invented texts only. No network: the provider is a fake.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isJunk, memoryDirOf, planImport, readSources, runImport } from '../scripts/gbrain-import.mjs'
import { memoryConfig } from '../bridge/memory.mjs'

const T0 = Date.parse('2026-03-01T10:00:00.000Z')
const at = (sec) => new Date(T0 + sec * 1000).toISOString()

function memDir({ outbox, days = {} } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gbimport-'))
  if (outbox !== undefined) writeFileSync(join(dir, 'outbox-honcho.json'), outbox)
  if (Object.keys(days).length) {
    mkdirSync(join(dir, 'conversations'))
    for (const [day, body] of Object.entries(days)) writeFileSync(join(dir, 'conversations', `${day}.jsonl`), body)
  }
  return dir
}

const line = (o) => JSON.stringify(o) + '\n'

test('memoryDirOf: the flag, else the app\'s own log folder (memoryConfig)', () => {
  const dir = join(tmpdir(), 'gbimport-flag')
  assert.equal(memoryDirOf(dir, { VENOM_MEMORY_DIR: join(tmpdir(), 'other') }), dir)
  assert.equal(memoryDirOf('', { VENOM_MEMORY_DIR: dir }), dir)
  assert.equal(memoryDirOf('', {}), memoryConfig({}).logDir)
})

test('readSources reads the outbox and the day files, reports a broken line', (t) => {
  const dir = memDir({
    outbox: JSON.stringify([{ id: 'a', session: 's', user: 'pear colour', assistant: 'green', ts: at(0), held: true }]),
    days: {
      '2026-03-01': line({ ts: at(1), session: 's', user: 'plum size', assistant: 'small' }) + '{broken\n\n' +
        line({ ts: at(2), session: 's', user: 'fig taste', assistant: 'sweet' }),
    },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const s = readSources(dir)
  assert.equal(s.outbox.length, 1)
  assert.equal(s.outbox[0].source, 'outbox')
  assert.deepEqual(s.log.map((x) => x.user), ['plum size', 'fig taste'])
  assert.equal(s.unparsable.length, 1)
  assert.equal(s.unparsable[0].line, 2)
  assert.match(s.unparsable[0].file, /2026-03-01\.jsonl$/)
})

test('readSources: missing files give empty lists', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'gbimport-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  assert.deepEqual(readSources(dir), { outbox: [], log: [], unparsable: [] })
  assert.deepEqual(readSources(join(dir, 'nope')), { outbox: [], log: [], unparsable: [] })
})

test('isJunk: built-in rules and an extra regex', () => {
  assert.equal(isJunk({ user: 'Hey, WHICH MODEL ARE YOU today?', assistant: 'x' }), 'asks which model')
  assert.equal(isJunk({ user: '   ', assistant: 'x' }), 'empty question')
  assert.equal(isJunk({ user: 'q', assistant: ' \n ' }), 'empty answer')
  assert.equal(isJunk({ user: 'q' }), 'empty answer')
  assert.equal(isJunk({ user: 'what is a model train', assistant: 'a toy' }), '')
  assert.equal(isJunk({ user: 'test ping one', assistant: 'pong' }), '')
  assert.match(isJunk({ user: 'test ping one', assistant: 'pong' }, [/^test ping/i]), /--junk/)
  assert.match(isJunk({ user: 'Test Ping', assistant: 'pong' }, ['^test ping']), /--junk/)
})

test('planImport: outbox copy of a log turn collapses to the log version', () => {
  const log = [{ ts: at(3), session: 's', user: 'how  tall is\nthe tree', assistant: 'heard answer', source: 'log' }]
  const outbox = [{ ts: at(0), session: 's', user: ' how tall is the tree ', assistant: 'other answer', source: 'outbox' }]
  const p = planImport({ outbox, log })
  assert.equal(p.copy.length, 1)
  assert.equal(p.copy[0].assistant, 'heard answer')
  assert.equal(p.duplicates.length, 1)
  assert.equal(p.duplicates[0].source, 'outbox')
})

test('planImport: the 5-second window edges', () => {
  const log = [{ ts: at(0), user: 'q', assistant: 'a', source: 'log' }]
  const at5 = planImport({ log, outbox: [{ ts: at(5), user: 'q', assistant: 'b', source: 'outbox' }] })
  assert.equal(at5.duplicates.length, 1)
  const at5001 = planImport({ log, outbox: [{ ts: new Date(T0 + 5001).toISOString(), user: 'q', assistant: 'b', source: 'outbox' }] })
  assert.equal(at5001.duplicates.length, 0)
  assert.equal(at5001.copy.length, 2)
  const before = planImport({ log, outbox: [{ ts: at(-5), user: 'q', assistant: 'b', source: 'outbox' }] })
  assert.equal(before.duplicates.length, 1)
  const otherQ = planImport({ log, outbox: [{ ts: at(1), user: 'q2', assistant: 'a', source: 'outbox' }] })
  assert.equal(otherQ.copy.length, 2)
})

test('planImport: an exact repeat line is a duplicate, junk is counted per rule, order by time', () => {
  const a = { ts: at(100), session: 's', user: 'late one', assistant: 'x', source: 'log' }
  const log = [
    a,
    { ...a },
    { ts: at(10), user: 'which model are you', assistant: 'x', source: 'log' },
    { ts: at(20), user: 'q', assistant: '', source: 'log' },
    { ts: at(30), user: 'Which model are you?', assistant: 'y', source: 'log' },
    { ts: at(50), user: 'early one', assistant: 'x', source: 'log' },
  ]
  const outbox = [{ ts: at(1), user: 'first one', assistant: 'x', source: 'outbox' }]
  const p = planImport({ outbox, log })
  assert.deepEqual(p.copy.map((t) => t.user), ['first one', 'early one', 'late one'])
  assert.equal(p.duplicates.length, 1)
  assert.equal(p.duplicates[0].reason, 'exact repeat')
  const per = {}
  for (const j of p.skippedJunk) per[j.reason] = (per[j.reason] || 0) + 1
  assert.deepEqual(per, { 'asks which model': 2, 'empty answer': 1 })
  const extra = planImport({ outbox, log }, { junk: [/^first/i] })
  assert.equal(extra.skippedJunk.length, 4)
  assert.equal(extra.copy.length, 2)
})

class FakeError extends Error {
  constructor(msg, retryable) {
    super(msg)
    this.retryable = retryable
    this.status = retryable ? 503 : 400
  }
}

const plan3 = { copy: [1, 2, 3].map((i) => ({ ts: at(i), session: 's', user: `q${i}`, assistant: `a${i}` })) }

test('runImport counts stored and already there', async () => {
  const seen = new Set()
  const sent = []
  const provider = {
    async writeTurn(t) {
      sent.push(t.user)
      const dup = seen.has(t.user)
      seen.add(t.user)
      return { session: 'x', ids: ['y'], duplicate: dup }
    },
  }
  assert.deepEqual(await runImport(plan3, provider, { pauseMs: 1 }), { stored: 3, already: 0, failed: 0, error: '' })
  assert.deepEqual(sent, ['q1', 'q2', 'q3'])
  assert.deepEqual(await runImport(plan3, provider, { pauseMs: 1 }), { stored: 0, already: 3, failed: 0, error: '' })
})

test('runImport retries a retryable failure', async () => {
  let calls = 0
  const provider = {
    async writeTurn(t) {
      calls++
      if (t.user === 'q2' && calls < 5) throw new FakeError('GBrain 503 on capture', true)
      return { duplicate: false }
    },
  }
  const res = await runImport(plan3, provider, { pauseMs: 1 })
  assert.deepEqual(res, { stored: 3, already: 0, failed: 0, error: '' })
  // q1, q2 failing 3 times then working on its 3rd retry, q3.
  assert.equal(calls, 6)
})

test('runImport gives up after 3 retries and stops', async () => {
  let calls = 0
  const provider = {
    async writeTurn() {
      calls++
      throw new FakeError('GBrain unreachable: timeout after 3000 ms', true)
    },
  }
  const res = await runImport(plan3, provider, { pauseMs: 1 })
  assert.equal(calls, 4)
  assert.equal(res.failed, 1)
  assert.equal(res.stored, 0)
})

test('runImport stops at a non-retryable failure', async () => {
  const sent = []
  const provider = {
    async writeTurn(t) {
      sent.push(t.user)
      if (t.user === 'q2') throw new FakeError('GBrain refused the key (401) on capture', false)
      return { duplicate: false }
    },
  }
  const res = await runImport(plan3, provider, { pauseMs: 1 })
  assert.deepEqual(res, { stored: 1, already: 0, failed: 1, error: 'GBrain refused the key (401) on capture' })
  assert.deepEqual(sent, ['q1', 'q2'])
})

test('readSources + planImport leave the source files untouched', (t) => {
  const dir = memDir({
    outbox: JSON.stringify([{ id: 'a', session: 's', user: 'kite', assistant: 'red', ts: at(0), held: true }]),
    days: { '2026-03-01': line({ ts: at(1), session: 's', user: 'kite', assistant: 'blue' }) + 'junk line\n' },
  })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const files = [join(dir, 'outbox-honcho.json'), join(dir, 'conversations', '2026-03-01.jsonl')]
  const before = files.map((f) => [readFileSync(f), statSync(f).mtimeMs])
  const p = planImport(readSources(dir))
  assert.equal(p.copy.length, 1)
  files.forEach((f, i) => {
    assert.ok(readFileSync(f).equals(before[i][0]))
    assert.equal(statSync(f).mtimeMs, before[i][1])
  })
})

test('runImport counts a page that exists as already there without writing it', async () => {
  const written = []
  const provider = {
    async exists(t) {
      return t.user !== 'q2'
    },
    async writeTurn(t) {
      written.push(t.user)
      return { duplicate: false }
    },
  }
  assert.deepEqual(await runImport(plan3, provider, { pauseMs: 1 }), { stored: 1, already: 2, failed: 0, error: '' })
  assert.deepEqual(written, ['q2'])
})
