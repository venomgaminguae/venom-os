// The agent tiles' rules (hermes-mcp/tiles.mjs): order, what a tile says,
// the layout around the core, run merging and the untrusted-result formatter.
// Pure functions: no files, no real clock, no DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  tileOrder,
  tileFor,
  tileLayout,
  ringSize,
  isRunId,
  RUN_ID,
  mergeRuns,
  linkParts,
  formatResult,
  RESULT_CAP,
  LAYOUT,
} from '../hermes-mcp/tiles.mjs'

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)
const run = (id, agent, startedAt, extra = {}) => ({
  id, agent, task: `Task ${id}. More words`, state: 'done', startedAt, endedAt: startedAt + 1000, ms: 1000,
  steps: [], summary: `Result of ${id}`, ...extra,
})

// ------------------------------------------------------------------- order

/** A roster of `n` agents (a1..an), with the given 1-based positions pinned. */
const roster = (n, pinned = []) =>
  Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, name: `Agent ${i + 1}`, pinned: pinned.includes(i + 1) }))
const ids = (list) => list.map((a) => a.id)

test('tileOrder: pinned entries first in roster order, then the rest in roster order', () => {
  for (const [n, pinned] of [[1, [1]], [5, [2, 4]], [12, [3, 7, 12]]]) {
    const list = roster(n, pinned)
    const order = tileOrder(list)
    const lead = list.filter((a) => a.pinned)
    assert.deepEqual(order.slice(0, lead.length), lead, `n=${n} pinned lead in roster order`)
    assert.deepEqual(order.slice(lead.length), list.filter((a) => !a.pinned), `n=${n} then the rest in roster order`)
    // A permutation of the roster: same entries, each once.
    assert.deepEqual([...ids(order)].sort(), [...ids(list)].sort(), `n=${n} permutation`)
  }
})

test('tileOrder: no pinned entries keeps roster order; only pinned: true counts', () => {
  for (const n of [1, 5, 12]) assert.deepEqual(ids(tileOrder(roster(n))), ids(roster(n)))
  const odd = [{ id: 'a' }, { id: 'b', pinned: 'yes' }, { id: 'c', pinned: 1 }, { id: 'd', pinned: true }]
  assert.deepEqual(ids(tileOrder(odd)), ['d', 'a', 'b', 'c'])
})

test('tileOrder: missing pinned ids are skipped, a custom first list, junk ignored', () => {
  const roster = [{ id: 'b' }, { id: 'a' }, null, { id: 'c' }, { name: 'no id' }]
  assert.deepEqual(tileOrder(roster, ['c', 'zz']).map((a) => a.id), ['c', 'b', 'a'])
  assert.deepEqual(tileOrder(roster).map((a) => a.id), ['b', 'a', 'c'])
  assert.deepEqual(tileOrder(undefined), [])
  assert.deepEqual(tileOrder([]), [])
})

// -------------------------------------------------------------------- tile

test('tileFor: no runs is idle with no job', () => {
  assert.deepEqual(tileFor([], 'coder', NOW), { status: 'idle', working: 0, run: null, step: '', job: null })
})

test('tileFor: working with the latest step, counting live runs', () => {
  const runs = [
    run('a', 'coder', NOW - 5000, { state: 'working', endedAt: null, steps: [{ text: 'Reading a.ts', ts: 1 }, { text: 'Editing x.ts', ts: 2 }] }),
    run('b', 'coder', NOW - 9000, { state: 'working', endedAt: null }),
    run('c', 'coder', NOW - 99000),
    run('d', 'writer', NOW - 1000, { state: 'working', endedAt: null }),
  ]
  const t = tileFor(runs, 'coder', NOW)
  assert.equal(t.status, 'working')
  assert.equal(t.working, 2)
  assert.equal(t.run.id, 'a')
  assert.equal(t.step, 'Editing x.ts')
  assert.deepEqual(t.job, { id: 'a', state: 'working', headline: 'Task a', when: 'now', line: 'Editing x.ts' })
  const quiet = tileFor([run('e', 'coder', NOW, { state: 'working', endedAt: null })], 'coder', NOW)
  assert.equal(quiet.step, '')
  assert.equal(quiet.job.line, 'Working')
})

test('tileFor: done for the hold, then idle with the job still shown', () => {
  const runs = [run('a', 'researcher', NOW - 60000, { endedAt: NOW - 3000 })]
  assert.equal(tileFor(runs, 'researcher', NOW).status, 'done')
  const later = tileFor(runs, 'researcher', NOW + 10000)
  assert.equal(later.status, 'idle')
  assert.equal(later.job.headline, 'Task a')
  assert.equal(later.job.line, 'Result of a')
  assert.equal(later.job.when, 'just now')
  assert.equal(tileFor(runs, 'researcher', NOW + 2 * 3600000).job.when, '2h ago')
  assert.equal(tileFor(runs, 'researcher', NOW, 1000).status, 'idle')
})

test('tileFor: failed or lost when the newest run is, whatever is older', () => {
  const runs = [run('new', 'researcher', NOW - 100, { state: 'lost' }), run('old', 'researcher', NOW - 9999)]
  const t = tileFor(runs, 'researcher', NOW + 999999)
  assert.equal(t.status, 'lost')
  assert.equal(t.run.id, 'new')
  assert.equal(tileFor([run('f', 'researcher', 1, { state: 'failed' })], 'researcher', NOW).status, 'failed')
  // An older failure under a newer success is not shown as failed.
  assert.equal(tileFor([run('ok', 'researcher', NOW - 5e6), run('f', 'researcher', NOW - 9e6, { state: 'failed' })], 'researcher', NOW).status, 'idle')
})

test('tileFor: a date past a day, sorted whatever the input order', () => {
  const runs = [run('old', 'writer', NOW - 5 * 86400000), run('newer', 'writer', NOW - 3 * 86400000)]
  const t = tileFor(runs, 'writer', NOW)
  assert.equal(t.job.id, 'newer')
  assert.match(t.job.when, /^\d{1,2} (Oct|Nov)$/)
})

// ------------------------------------------------------------------ layout

test('tileLayout: two columns of five at 2560x1440 and 1920x1080, clear of the ring', () => {
  for (const [w, h] of [[2560, 1440], [1920, 1080]]) {
    const l = tileLayout(w, h, 10)
    assert.equal(l.mode, 'columns', `${w}x${h}`)
    assert.equal(l.left, 5)
    assert.equal(l.right, 5)
    assert.equal(l.compact, false)
    const ringLeft = (w - ringSize(w, h)) / 2
    assert.ok(LAYOUT.EDGE + l.tileWidth + LAYOUT.GAP <= ringLeft, `${w}: ${LAYOUT.EDGE + l.tileWidth} vs ring ${ringLeft}`)
  }
  assert.equal(tileLayout(2560, 1440, 10).tileWidth, 480)
  assert.equal(tileLayout(1920, 1080, 10).tileWidth, 384)
})

test('tileLayout: one compact right column at 1400x850 and 1150x800', () => {
  for (const [w, h] of [[1400, 850], [1150, 800]]) {
    const l = tileLayout(w, h, 10)
    assert.equal(l.mode, 'column', `${w}x${h}`)
    assert.equal(l.left, 0)
    assert.equal(l.right, 10)
    assert.equal(l.compact, true)
    const ringLeft = (w - ringSize(w, h)) / 2
    assert.ok(LAYOUT.COLUMN_EDGE + l.tileWidth + LAYOUT.COLUMN_GAP <= ringLeft)
    assert.ok(l.tileWidth >= LAYOUT.MIN_COLUMN)
  }
  assert.equal(tileLayout(1400, 850, 10).tileWidth, 280)
})

test('tileLayout: a short window gets chips at the column width so all ten fit', () => {
  for (const [w, h] of [[1280, 720], [1366, 768]]) {
    const l = tileLayout(w, h, 10)
    assert.equal(l.mode, 'strip', `${w}x${h}`)
    assert.equal(l.tileWidth, 280)
    assert.equal(l.right, 10)
  }
  assert.equal(tileLayout(1280, 800, 10).mode, 'column')
})

test('tileLayout: the strip at 900x700 and smaller, and odd input', () => {
  const l = tileLayout(900, 700, 10)
  assert.equal(l.mode, 'strip')
  assert.equal(l.compact, true)
  assert.ok(l.tileWidth >= LAYOUT.MIN_STRIP)
  assert.equal(tileLayout(320, 480, 10).mode, 'strip')
  assert.equal(tileLayout(NaN, -1, 'x').mode, 'strip')
  // A wide window too short for columns, or for ten compact tiles or chips in
  // one column: two compact columns of five.
  assert.equal(tileLayout(2560, 600, 10).mode, 'column')
  // Columns go compact when there is little height per tile.
  const c = tileLayout(1920, 800, 10)
  assert.equal(c.mode, 'columns')
  assert.equal(c.compact, true)
  // An odd count puts the extra tile on the left.
  assert.deepEqual([tileLayout(1920, 1080, 9).left, tileLayout(1920, 1080, 9).right], [5, 4])
})

// -------------------------------------------------------------------- runs

test('isRunId: the activity log id shape only', () => {
  assert.ok(isRunId('mhx2k3a9-1f2e3d4c'))
  assert.ok(isRunId('abc123-deadbeef'))
  for (const bad of ['', 'abc-deadbeef', 'ABCDEF-deadbeef', 'abcdef-DEADBEEF', 'abcdef-deadbee', '../etc-deadbeef', 'abcdef-deadbeef\n', 'abcdefabcdefa-deadbeef', null, 42]) {
    assert.equal(isRunId(bad), false, String(bad))
  }
  assert.equal(RUN_ID.source, '^[0-9a-z]{6,12}-[0-9a-f]{8}$')
})

test('mergeRuns: newest first, live replaces fetched, keeps longer steps, task and full', () => {
  const steps = Array.from({ length: 30 }, (_, i) => ({ text: `s${i}`, ts: i + 1 }))
  const fetched = [
    run('a', 'researcher', 100, { state: 'working', endedAt: null, steps, full: false, task: 'x'.repeat(900) }),
    run('b', 'researcher', 50, { full: true }),
  ]
  const live = [
    run('a', 'researcher', 100, { state: 'done', steps: [{ text: 's29', ts: 30 }, { text: 'last', ts: 31 }], task: 'x'.repeat(300), summary: 'fin' }),
    run('c', 'researcher', 200),
  ]
  const m = mergeRuns(fetched, live)
  assert.deepEqual(m.map((r) => r.id), ['c', 'a', 'b'])
  const a = m[1]
  assert.equal(a.state, 'done')
  assert.equal(a.summary, 'fin')
  assert.equal(a.steps.length, 31)
  assert.equal(a.steps[30].text, 'last')
  assert.equal(a.task.length, 900)
  assert.equal(a.full, false)
  assert.equal(m[2].full, true)
  // A live run with its own steps list as long or longer keeps it, and its own full flag.
  const own = mergeRuns([run('z', 'researcher', 1, { steps: [{ text: 'f', ts: 1 }], full: false })], [run('z', 'researcher', 1, { steps: [{ text: 'l', ts: 2 }], full: true })])
  assert.deepEqual(own[0].steps, [{ text: 'l', ts: 2 }])
  assert.equal(own[0].full, true)
  // A result attached after the run ended: the fetched flag wins over the live run's false.
  const late = mergeRuns([run('y', 'researcher', 1, { full: true })], [run('y', 'researcher', 1, { full: false })])
  assert.equal(late[0].full, true)
  assert.deepEqual(mergeRuns(null, undefined), [])
})

// ------------------------------------------------------------------- links

const hrefs = (parts) => parts.filter((p) => p.href).map((p) => p.href)
const joined = (parts) => parts.map((p) => p.text).join('')

test('linkParts: plain text is one part, and text is kept exactly', () => {
  assert.deepEqual(linkParts('hello world'), [{ text: 'hello world' }])
  assert.deepEqual(linkParts(''), [])
  assert.deepEqual(linkParts(undefined), [])
})

test('linkParts: bare http(s) URLs become links without trailing punctuation', () => {
  const s = 'See https://example.com/a?b=1, and (http://x.org/p). Done; https://y.io/z;'
  const p = linkParts(s)
  assert.deepEqual(hrefs(p), ['https://example.com/a?b=1', 'http://x.org/p', 'https://y.io/z'])
  assert.equal(joined(p), s)
  assert.deepEqual(linkParts('https://en.wikipedia.org/wiki/Foo_(bar).').map((x) => x.text), ['https://en.wikipedia.org/wiki/Foo_(bar)', '.'])
})

test('linkParts: markdown links become the label, only for http(s)', () => {
  assert.deepEqual(linkParts('Read [the docs](https://a.com/d) now'), [
    { text: 'Read ' }, { text: 'the docs', href: 'https://a.com/d' }, { text: ' now' },
  ])
})

test('linkParts: hostile schemes never become links', () => {
  for (const s of [
    '[x](javascript:alert(1))',
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    '[d](data:text/html,<script>alert(1)</script>)',
    'data:text/html;base64,PHNjcmlwdD4=',
    'file:///C:/Windows/win.ini',
    '[f](file:///etc/passwd)',
    'vbscript:msgbox(1)',
    'mailto:a@b.c',
    '[m](mailto:a@b.c)',
    '//evil.example/x',
    '[p](//evil.example)',
    'http://',
    'https://',
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<a href="javascript:alert(1)">x</a>',
  ]) {
    const p = linkParts(s)
    assert.deepEqual(hrefs(p), [], s)
    assert.equal(joined(p), s, s)
  }
  // An http link right next to markup links only the URL itself.
  const p = linkParts('<a href="https://ok.com/x">y</a>')
  assert.deepEqual(hrefs(p), ['https://ok.com/x'])
  for (const h of hrefs(linkParts('x https://a.b/c"onmouseover=alert(1) y'))) assert.ok(!h.includes('"'))
})

// ------------------------------------------------------------------ format

test('formatResult: headings, bullets, rules, paragraphs, code and tables', () => {
  const text = [
    '# Audit',
    '## **Summary**',
    'First line of a paragraph',
    'second line with https://site.com/x.',
    '',
    '- one',
    '  * nested **bold** bit',
    '1. numbered',
    '---',
    '```',
    '<b>code</b>',
    '',
    'more',
    '```',
    '| Page | Score |',
    '|---|---|',
    '| / | 90 |',
    '##### deep',
    'tail',
  ].join('\n')
  const b = formatResult(text)
  assert.deepEqual(b.map((x) => x.type), ['heading', 'heading', 'para', 'bullet', 'bullet', 'bullet', 'rule', 'code', 'code', 'heading', 'para'])
  assert.deepEqual(b[0], { type: 'heading', level: 1, parts: [{ text: 'Audit' }] })
  assert.deepEqual(b[1].parts, [{ text: 'Summary' }])
  assert.equal(joined(b[2].parts), 'First line of a paragraph\nsecond line with https://site.com/x.')
  assert.deepEqual(hrefs(b[2].parts), ['https://site.com/x'])
  assert.deepEqual([b[3].depth, b[4].depth], [0, 1])
  assert.equal(joined(b[4].parts), 'nested bold bit')
  assert.equal(joined(b[5].parts), 'numbered')
  assert.equal(b[7].text, '<b>code</b>\n\nmore')
  assert.equal(b[8].text, '| Page | Score |\n|---|---|\n| / | 90 |')
  assert.equal(b[9].level, 4)
})

test('formatResult: CRLF, hostile markup stays literal text, no html anywhere', () => {
  const text = '# T\r\n<script>alert(1)</script>\r\n\r\n- [x](javascript:alert(1))\r\n<img src=x onerror=alert(1)>\r\n'
  const b = formatResult(text)
  assert.deepEqual(b.map((x) => x.type), ['heading', 'para', 'bullet', 'para'])
  assert.equal(joined(b[1].parts), '<script>alert(1)</script>')
  assert.equal(joined(b[2].parts), '[x](javascript:alert(1))')
  assert.equal(joined(b[3].parts), '<img src=x onerror=alert(1)>')
  for (const blk of b) {
    for (const p of blk.parts ?? []) assert.ok(!('href' in p))
    assert.ok(!JSON.stringify(blk).includes('\r'))
  }
})

test('formatResult: huge input is capped in characters and blocks', () => {
  const huge = 'word '.repeat(200000) // 1 MB in one paragraph
  const one = formatResult(huge)
  assert.equal(one.length, 1)
  assert.ok(joined(one[0].parts).length <= RESULT_CAP)
  const many = formatResult('- x\n'.repeat(50000))
  assert.ok(many.length <= 4000)
  assert.equal(formatResult('- x\n'.repeat(100), 10).length, 10)
  assert.deepEqual(formatResult(''), [])
  assert.deepEqual(formatResult(null), [])
  // An unclosed fence still comes out as code.
  assert.deepEqual(formatResult('```\nabc'), [{ type: 'code', text: 'abc' }])
})
