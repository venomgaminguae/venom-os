// The HUD memory line: what the bridge's /health `memory` field turns into.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { memoryLine, memoryRows, memorySummary, ago } from '../src/lib/memoryLine.ts'

test('missing or non-object field shows nothing', () => {
  for (const v of [undefined, null, 'ok', 42, true, [], () => {}]) {
    assert.equal(memoryLine(v), null, String(v))
  }
})

test("state 'off' shows nothing", () => {
  assert.equal(memoryLine({ provider: 'honcho', label: 'Honcho', state: 'off', queued: 0 }), null)
})

test('an unknown or missing state shows nothing', () => {
  assert.equal(memoryLine({ label: 'Honcho' }), null)
  assert.equal(memoryLine({ label: 'Honcho', state: 'weird' }), null)
})

test("state 'ok' -> 'memory · <label> ok', level ok", () => {
  assert.deepEqual(memoryLine({ provider: 'honcho', label: 'Honcho', state: 'ok', queued: 0 }), {
    text: 'memory · Honcho ok',
    level: 'ok',
  })
})

test("state 'offline' with nothing queued -> warn, no waiting count", () => {
  assert.deepEqual(memoryLine({ label: 'Honcho', state: 'offline', queued: 0 }), {
    text: 'memory · Honcho offline',
    level: 'warn',
  })
  assert.deepEqual(memoryLine({ label: 'Honcho', state: 'offline' }), {
    text: 'memory · Honcho offline',
    level: 'warn',
  })
})

test("state 'offline' with a queue -> ' · <n> waiting'", () => {
  assert.deepEqual(memoryLine({ label: 'Honcho', state: 'offline', queued: 3 }), {
    text: 'memory · Honcho offline · 3 waiting',
    level: 'warn',
  })
})

test("state 'offline' ignores a negative or non-numeric queue", () => {
  assert.equal(memoryLine({ label: 'Honcho', state: 'offline', queued: -2 })?.text, 'memory · Honcho offline')
  assert.equal(memoryLine({ label: 'Honcho', state: 'offline', queued: '5' })?.text, 'memory · Honcho offline')
})

test("state 'unknown' -> 'memory · <label> checking', level quiet", () => {
  assert.deepEqual(memoryLine({ label: 'Honcho', state: 'unknown', queued: 0 }), {
    text: 'memory · Honcho checking',
    level: 'quiet',
  })
})

test("label falls back to 'long-term' when missing, empty or not a string", () => {
  assert.equal(memoryLine({ state: 'ok' })?.text, 'memory · long-term ok')
  assert.equal(memoryLine({ label: '', state: 'ok' })?.text, 'memory · long-term ok')
  assert.equal(memoryLine({ label: '   ', state: 'unknown' })?.text, 'memory · long-term checking')
  assert.equal(memoryLine({ label: 7, state: 'offline', queued: 1 })?.text, 'memory · long-term offline · 1 waiting')
})

test('label is cut to 24 characters', () => {
  const long = 'A'.repeat(40)
  assert.equal(memoryLine({ label: long, state: 'ok' })?.text, `memory · ${'A'.repeat(24)} ok`)
  assert.equal(memoryLine({ label: 'B'.repeat(24), state: 'ok' })?.text, `memory · ${'B'.repeat(24)} ok`)
})

test('label is kept as plain text (markup is not interpreted here)', () => {
  assert.equal(memoryLine({ label: '<b>x</b>', state: 'ok' })?.text, 'memory · <b>x</b> ok')
})

// The memory section: what GET /memory/sources turns into.
const NOW = Date.parse('2026-11-14T14:00:00.000Z')
const minsAgo = (m) => new Date(NOW - m * 60_000).toISOString()
const SIX = {
  at: '2026-11-14T14:00:00.000Z',
  rows: [
    { id: 'honcho', label: 'Honcho', state: 'read-only', level: 'warn', detail: '13 waiting · out of credits', updated: minsAgo(41) },
    { id: 'notes', label: 'Hermes notes', state: 'read-only', level: 'ok', detail: '42 entries', updated: minsAgo(60 * 5) },
    { id: 'skills', label: 'Agent skills', state: 'read-only', level: 'ok', detail: '212 skills · 25 in 3 profiles', updated: minsAgo(60 * 24 * 2) },
    { id: 'vault', label: 'Obsidian vault', state: 'read-only', level: 'ok', detail: '12 notes', updated: null },
    { id: 'graph', label: 'Knowledge graph', state: 'read-only', level: 'ok', detail: '1814 nodes', updated: minsAgo(0.2) },
    { id: 'log', label: 'Conversation log', state: 'connected', level: 'ok', detail: '320 turns', updated: minsAgo(3) },
  ],
}

test('ago() buckets', () => {
  assert.equal(ago(minsAgo(0), NOW), 'just now')
  assert.equal(ago(minsAgo(0.9), NOW), 'just now')
  assert.equal(ago(minsAgo(1), NOW), '1 min ago')
  assert.equal(ago(minsAgo(5), NOW), '5 min ago')
  assert.equal(ago(minsAgo(59), NOW), '59 min ago')
  assert.equal(ago(minsAgo(60), NOW), '1 h ago')
  assert.equal(ago(minsAgo(60 * 3 + 20), NOW), '3 h ago')
  assert.equal(ago(minsAgo(60 * 24), NOW), '1 d ago')
  assert.equal(ago(minsAgo(60 * 24 * 2 + 5), NOW), '2 d ago')
})

test('ago() is empty when missing, invalid or in the future', () => {
  for (const v of [undefined, null, '', 'yesterday', 42, {}, minsAgo(-5)]) assert.equal(ago(v, NOW), '', String(v))
})

test('memoryRows: bad payloads give []', () => {
  for (const v of [undefined, null, 'x', 7, [], {}, { rows: 'x' }, { rows: {} }, { rows: [] }, { rows: [null, 1, 'a', []] }]) {
    assert.deepEqual(memoryRows(v, NOW), [], JSON.stringify(v))
  }
})

test('memoryRows: a realistic payload keeps all six in order with ages', () => {
  const rows = memoryRows(SIX, NOW)
  assert.deepEqual(rows.map((r) => r.id), ['honcho', 'notes', 'skills', 'vault', 'graph', 'log'])
  assert.deepEqual(rows[0], {
    id: 'honcho', label: 'Honcho', state: 'read-only', level: 'warn', detail: '13 waiting · out of credits', age: '41 min ago',
  })
  assert.deepEqual(rows.map((r) => r.age), ['41 min ago', '5 h ago', '2 d ago', '', 'just now', '3 min ago'])
})

test('memoryRows: unknown ids dropped, duplicates ignored, fixed order', () => {
  const rows = memoryRows({ rows: [
    { id: 'log', state: 'connected', level: 'ok', detail: '1 turns' },
    { id: 'secrets', state: 'connected', level: 'ok', detail: 'x' },
    { id: 'honcho', state: 'off', level: 'quiet', detail: 'off' },
    { id: 'log', state: 'off', level: 'quiet', detail: 'dup' },
  ] }, NOW)
  assert.deepEqual(rows.map((r) => [r.id, r.state]), [['honcho', 'off'], ['log', 'connected']])
})

test('memoryRows: state/level fallbacks, default labels and caps', () => {
  const [r] = memoryRows({ rows: [{ id: 'graph', label: 'L'.repeat(40), state: 'exploded', level: 'purple', detail: 'D'.repeat(80) }] }, NOW)
  assert.equal(r.state, 'not found')
  assert.equal(r.level, 'warn')
  assert.equal(r.label, 'L'.repeat(24))
  assert.equal(r.detail, 'D'.repeat(48))
  assert.equal(r.age, '')
  const [d] = memoryRows({ rows: [{ id: 'vault', label: 5, state: 'read-only', level: 'ok', detail: 9 }] }, NOW)
  assert.equal(d.label, 'Obsidian vault')
  assert.equal(d.detail, '')
})

test('memoryRows: a detail holding <script> stays a plain string', () => {
  const [r] = memoryRows({ rows: [{ id: 'notes', state: 'read-only', level: 'ok', detail: '<script>alert(1)</script>' }] }, NOW)
  assert.equal(r.detail, '<script>alert(1)</script>')
  assert.equal(typeof r.detail, 'string')
  assert.match(memorySummary([{ ...r, level: 'warn', state: 'offline', detail: '<b>x</b>' }]).text, /<b>x<\/b>/)
})

test('memorySummary: compact text for the realistic payload', () => {
  const s = memorySummary(memoryRows(SIX, NOW))
  assert.equal(s.text, 'memory · Honcho read-only 13 waiting · notes 42 · skills 212 · vault 12 · graph 1814 · log 320')
  assert.equal(s.level, 'warn')
  assert.ok(s.text.length <= 110)
})

test('memorySummary: worst level wins (bad > warn > ok > quiet)', () => {
  const rows = memoryRows(SIX, NOW)
  const at = (levels) => memorySummary(rows.map((r, i) => ({ ...r, level: levels[i] }))).level
  assert.equal(at(['ok', 'ok', 'ok', 'ok', 'ok', 'ok']), 'ok')
  assert.equal(at(['quiet', 'ok', 'ok', 'ok', 'ok', 'ok']), 'ok')
  assert.equal(at(['quiet', 'quiet', 'quiet', 'quiet', 'quiet', 'quiet']), 'quiet')
  assert.equal(at(['ok', 'warn', 'quiet', 'ok', 'ok', 'ok']), 'warn')
  assert.equal(at(['warn', 'ok', 'bad', 'quiet', 'ok', 'ok']), 'bad')
})

test('memorySummary: other states show the state word; long text is cut', () => {
  const rows = memoryRows({ rows: [
    { id: 'honcho', state: 'offline', level: 'warn', detail: 'not answering' },
    { id: 'notes', state: 'off', level: 'quiet', detail: 'off' },
    { id: 'graph', state: 'read-only', level: 'warn', detail: 'unreadable' },
    { id: 'log', state: 'connected', level: 'ok', detail: '0 turns' },
    { id: 'vault', state: 'not found', level: 'warn', detail: '' },
  ] }, NOW)
  assert.equal(memorySummary(rows).text,
    'memory · Honcho offline not answering · notes off · vault not found · graph read-only unreadable · log 0')
  const many = memoryRows({ rows: ['honcho', 'notes', 'skills', 'vault', 'graph', 'log'].map((id) => (
    { id, state: 'not found', level: 'warn', detail: 'check failed' })) }, NOW)
  assert.ok(memorySummary(many).text.length <= 110)
  assert.deepEqual(memorySummary([]), { text: 'memory · no sources', level: 'quiet' })
})

test("memorySummary: 'not found' is not followed by its detail", () => {
  const rows = memoryRows({ rows: [{ id: 'vault', label: 'Obsidian vault', state: 'not found', level: 'warn', detail: 'no vault', updated: null }] }, Date.now())
  assert.equal(memorySummary(rows).text, 'memory · vault not found')
})
