// The agent orbs' rules (hermes-mcp/orbs.mjs): the ring layout, where a ball
// lands on screen, that the names never overlap each other or the tiles, when
// a ball feeds the core, and what its hover label says.
// Pure functions: no files, no real clock, no DOM.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ORBS,
  orbLayout,
  orbPoint,
  orbFit,
  orbProject,
  orbFont,
  orbBox,
  orbSignal,
  orbHover,
  orbElapsed,
} from '../hermes-mcp/orbs.mjs'
import { tileFor, tileOrder, tileLayout, LAYOUT } from '../hermes-mcp/tiles.mjs'
import { HEADLINE_CAP, LINE_CAP } from '../hermes-mcp/pinned.mjs'

const NOW = Date.UTC(2026, 10, 10, 12, 0, 0)
const DEG = Math.PI / 180
const run = (id, agent, startedAt, extra = {}) => ({
  id, agent, task: `Task ${id}. More words`, state: 'done', startedAt, endedAt: startedAt + 1000, ms: 1000,
  steps: [], summary: `Result of ${id}`, ...extra,
})
const working = (id, agent, startedAt, extra = {}) => run(id, agent, startedAt, { state: 'working', endedAt: null, ...extra })
const close = (a, b, msg, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${msg}: ${a} != ${b}`)

// Small rosters made up here (the real one is the owner's venom.agents.json).
const NAMES = ['Researcher', 'Coder', 'Operator', 'Writer', 'Reviewer', 'Planner', 'Designer', 'Tester', 'Analyst', 'Editor', 'Scout', 'Archivist']
const roster = (n, pinned = []) =>
  Array.from({ length: n }, (_, i) => ({ id: `a${i + 1}`, name: NAMES[i % NAMES.length], pinned: pinned.includes(i + 1) }))
const ROSTERS = [roster(1, [1]), roster(5, [2, 4]), roster(12, [1, 6, 9])]

// ------------------------------------------------------------------ layout

test('orbLayout: one slot per roster agent', () => {
  for (const list of ROSTERS) assert.equal(orbLayout(list.length).length, list.length)
})

test('orbLayout: up to PER_RING agents share ring 0, evenly spaced', () => {
  for (const n of [1, 2, 5, 12, ORBS.PER_RING]) {
    const slots = orbLayout(n)
    assert.equal(slots.length, n)
    slots.forEach((s, i) => {
      assert.equal(s.ring, 0)
      assert.equal(s.radius, ORBS.RADIUS)
      assert.equal(s.tilt, ORBS.TILT)
      assert.equal(s.speed, ORBS.SPEED)
      close(s.phase, (360 / n) * i, `n=${n} slot ${i} phase`)
    })
  }
})

test('orbLayout: more than PER_RING opens more rings, each holding at most PER_RING', () => {
  for (const n of [ORBS.PER_RING + 1, 30]) {
    const slots = orbLayout(n)
    assert.equal(slots.length, n)
    const rings = new Map()
    for (const s of slots) rings.set(s.ring, (rings.get(s.ring) ?? 0) + 1)
    assert.ok(rings.size >= 2, `n=${n} opens a second ring`)
    assert.equal(rings.size, Math.ceil(n / ORBS.PER_RING))
    for (const [ring, count] of rings) assert.ok(count <= ORBS.PER_RING, `n=${n} ring ${ring} holds ${count}`)
    for (const s of slots) {
      close(s.radius, ORBS.RADIUS + s.ring * ORBS.RING_STEP, `n=${n} ring ${s.ring} radius`)
      assert.equal(s.speed, s.ring % 2 ? -ORBS.SPEED : ORBS.SPEED)
    }
  }
})

test('orbLayout: 0, negative, NaN and undefined give no slots', () => {
  for (const n of [0, -3, NaN, undefined]) assert.deepEqual(orbLayout(n), [])
})

// ---------------------------------------------------------------- geometry

test('orbPoint: angle 0 is radius*fit/2 out on +x, level with the core', () => {
  const [slot] = orbLayout(1)
  const p = orbPoint(slot, 0, 4)
  close(p.x, slot.radius * 4 / 2, 'x')
  close(p.y, 0, 'y')
  close(p.z, 0, 'z')
})

test('orbPoint: with a negative tilt the upper half is behind the core and the lower half nearer', () => {
  const [slot] = orbLayout(1)
  const fit = orbFit(1920, 1080)
  const up = orbPoint(slot, 90 * DEG, fit)
  const down = orbPoint(slot, 270 * DEG, fit)
  assert.equal(Math.sign(up.z), Math.sign(Math.sin(slot.tilt * DEG)))
  assert.ok(slot.tilt < 0)
  assert.ok(up.y > 0 && up.z < 0, 'upper half behind')
  assert.ok(down.y < 0 && down.z > 0, 'lower half nearer')
  assert.ok(orbProject(up, 1920, 1080).scale < 1)
  assert.ok(orbProject(down, 1920, 1080).scale > 1)
})

test('orbProject: the origin is the window centre at scale 1', () => {
  assert.deepEqual(orbProject({ x: 0, y: 0, z: 0 }, 1920, 1080), { x: 960, y: 540, scale: 1 })
})

test('orbFit: a landscape window fits the world height, a portrait one the narrower width', () => {
  const worldH = 2 * ORBS.CAMERA_Z * Math.tan((ORBS.FOV * DEG) / 2)
  close(orbFit(1920, 1080), worldH, 'landscape')
  close(orbFit(800, 1200), (worldH * 800) / 1200, 'portrait')
  assert.ok(orbFit(800, 1200) < worldH)
})

// ------------------------------------------------------- label separation

/** Every name box for one ring turn (degrees), with the agent it belongs to. */
function boxesAt(agents, slots, turn, w, h) {
  const fit = orbFit(w, h)
  return agents.map((a, i) => {
    const angle = (slots[i].phase + turn) * DEG
    const p = orbProject(orbPoint(slots[i], angle, fit), w, h)
    return { name: a.name, box: orbBox(a.name, p.x, p.y, w, h, p.scale) }
  })
}

const overlap = (a, b) => {
  const dx = Math.min(a.right, b.right) - Math.max(a.left, b.left)
  const dy = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top)
  return dx > 0 && dy > 0 ? { dx, dy } : null
}

/** Checks one roster's name boxes over a whole step of the ring's turn. */
function labelsClear(list) {
  const agents = tileOrder(list)
  const n = agents.length
  const slots = orbLayout(n)
  for (const [w, h] of [[1920, 1080], [2560, 1440]]) {
    const size = `${n} agents at ${w}x${h}`
    const tiles = tileLayout(w, h, n)
    // The tile columns only bound the labels when the tiles are in columns.
    const columns = tiles.mode === 'columns'
    const leftEdge = columns ? LAYOUT.EDGE + tiles.tileWidth : 0
    const rightEdge = columns ? w - LAYOUT.EDGE - tiles.tileWidth : w
    const top = LAYOUT.TOP
    const bottom = h - 130
    const step = 360 / n
    for (let turn = 0; turn <= step + 1e-9; turn += 0.25) {
      const at = `${size} turn ${turn.toFixed(2)}deg`
      const boxes = boxesAt(agents, slots, turn, w, h)
      for (let i = 0; i < boxes.length; i++) {
        const { name, box } = boxes[i]
        assert.ok(box.left > leftEdge, `${name} crosses the left tile column at ${at} by ${(leftEdge - box.left).toFixed(1)}px`)
        assert.ok(box.right < rightEdge, `${name} crosses the right tile column at ${at} by ${(box.right - rightEdge).toFixed(1)}px`)
        assert.ok(box.top > top, `${name} crosses the top bar (y=${top}) at ${at} by ${(top - box.top).toFixed(1)}px`)
        assert.ok(box.bottom < bottom, `${name} crosses the transcript (y=${bottom}) at ${at} by ${(box.bottom - bottom).toFixed(1)}px`)
        for (let j = i + 1; j < boxes.length; j++) {
          const o = overlap(box, boxes[j].box)
          assert.equal(o, null, o && `${name} and ${boxes[j].name} overlap at ${at} by ${o.dx.toFixed(1)}px x ${o.dy.toFixed(1)}px`)
        }
      }
    }
  }
}

test('orb labels: never overlap each other, the tile columns, the top bar or the transcript (1, 5 and 12 agents)', () => {
  for (const list of ROSTERS) labelsClear(list)
})

test('orbFont: clamps between FONT_MIN and FONT_MAX', () => {
  assert.equal(orbFont(100), ORBS.FONT_MIN)
  assert.equal(orbFont(10000), ORBS.FONT_MAX)
  close(orbFont(2000), 2000 * ORBS.FONT_VW, 'middle')
})

// ------------------------------------------------------------------ signal

test('orbSignal: a working agent feeds the core with one stream per working run, at most 3', () => {
  const one = orbSignal(tileFor([working('a', 'coder', NOW - 1000)], 'coder', NOW))
  assert.deepEqual(one, { feeding: true, streams: 1, tint: 'purple' })
  const two = [working('a', 'coder', NOW - 1000), working('b', 'coder', NOW - 2000)]
  assert.equal(orbSignal(tileFor(two, 'coder', NOW)).streams, 2)
  const five = [1, 2, 3, 4, 5].map((i) => working(`r${i}`, 'coder', NOW - i * 1000))
  assert.equal(orbSignal(tileFor(five, 'coder', NOW)).streams, 3)
  assert.equal(orbSignal({ status: 'working', working: 0 }).streams, 1)
})

test('orbSignal: idle and done agents are purple and not feeding', () => {
  const idle = tileFor([], 'coder', NOW)
  assert.equal(idle.status, 'idle')
  assert.deepEqual(orbSignal(idle), { feeding: false, streams: 0, tint: 'purple' })
  const done = tileFor([run('a', 'coder', NOW - 3000)], 'coder', NOW)
  assert.equal(done.status, 'done')
  assert.deepEqual(orbSignal(done), { feeding: false, streams: 0, tint: 'purple' })
})

test('orbSignal: a failed or lost newest run tints the ball as an error, not feeding', () => {
  for (const state of ['failed', 'lost']) {
    const t = tileFor([run('a', 'coder', NOW - 60000, { state })], 'coder', NOW)
    assert.equal(t.status, state)
    assert.deepEqual(orbSignal(t), { feeding: false, streams: 0, tint: 'error' })
  }
})

test('orbSignal: a working agent whose older run failed stays purple and feeding', () => {
  const runs = [run('old', 'coder', NOW - 60000, { state: 'failed' }), working('new', 'coder', NOW - 1000)]
  assert.deepEqual(orbSignal(tileFor(runs, 'coder', NOW)), { feeding: true, streams: 1, tint: 'purple' })
})

test('orbSignal: no tile is purple and not feeding', () => {
  for (const t of [null, undefined]) assert.deepEqual(orbSignal(t), { feeding: false, streams: 0, tint: 'purple' })
})

// ------------------------------------------------------------------- hover

test('orbHover: working shows elapsed time, the live step and the task headline', () => {
  const steps = [{ text: 'Reading a.ts', ts: 1 }, { text: 'Editing x.ts', ts: 2 }]
  const t = tileFor([working('a', 'coder', NOW - 185000, { steps })], 'coder', NOW)
  assert.deepEqual(orbHover(t, NOW), { state: 'working', title: 'Working · 3m 05s', lines: ['Now: Editing x.ts', 'Task a'] })
})

test('orbHover: working with no steps yet says Now: Working', () => {
  const t = tileFor([working('a', 'coder', NOW - 45000)], 'coder', NOW)
  assert.deepEqual(orbHover(t, NOW).lines, ['Now: Working', 'Task a'])
})

test('orbHover: two working runs add a +1 more running line', () => {
  const t = tileFor([working('a', 'coder', NOW - 1000), working('b', 'coder', NOW - 5000)], 'coder', NOW)
  assert.deepEqual(orbHover(t, NOW).lines, ['Now: Working', 'Task a', '+1 more running'])
})

test('orbHover: an agent with no runs is idle with no jobs yet', () => {
  assert.deepEqual(orbHover(tileFor([], 'coder', NOW), NOW), { state: 'idle', title: 'Idle', lines: ['No jobs yet'] })
})

test('orbHover: a finished run reads Idle, its headline and when it ended', () => {
  const t = tileFor([run('a', 'coder', NOW - 301000, { endedAt: NOW - 300000 })], 'coder', NOW)
  assert.deepEqual(orbHover(t, NOW), { state: 'idle', title: 'Idle', lines: ['Last: Task a', 'Done 5m ago'] })
})

test('orbHover: a failed run is in the failed state', () => {
  const t = tileFor([run('a', 'coder', NOW - 301000, { state: 'failed', endedAt: NOW - 300000 })], 'coder', NOW)
  assert.deepEqual(orbHover(t, NOW), { state: 'failed', title: 'Idle', lines: ['Last: Task a', 'Failed 5m ago'] })
})

test('orbHover: a lost run is in the failed state and says Lost', () => {
  const t = tileFor([run('a', 'coder', NOW - 2 * 3600000, { state: 'lost', endedAt: NOW - 2 * 3600000 })], 'coder', NOW)
  const hover = orbHover(t, NOW)
  assert.equal(hover.state, 'failed')
  assert.equal(hover.lines[1], 'Lost 2h ago')
})

test('orbHover: huge task and step with newlines and markup come back as capped single plain lines', () => {
  const evil = '<script>alert(1)</script>\n<b>x</b>\r\n' + 'word '.repeat(1000)
  assert.ok(evil.length >= 5000)
  const steps = [{ text: evil, ts: 1 }]
  const t = tileFor([working('a', 'coder', NOW - 1000, { task: evil, steps })], 'coder', NOW)
  const [now, head] = orbHover(t, NOW).lines
  assert.ok(now.startsWith('Now: <script>alert(1)</script> <b>x</b> word'), now)
  assert.ok(now.length <= 'Now: '.length + LINE_CAP, `Now line is ${now.length} long`)
  assert.ok(head.startsWith('<script>alert(1)</script> <b>x</b> word'), head)
  assert.ok(head.length <= HEADLINE_CAP, `headline is ${head.length} long`)
  for (const line of [now, head]) assert.doesNotMatch(line, /[\r\n]/)

  const ended = tileFor([run('b', 'coder', NOW - 60000, { task: evil })], 'coder', NOW)
  const last = orbHover(ended, NOW).lines[0]
  assert.ok(last.startsWith('Last: <script>alert(1)</script>'), last)
  assert.ok(last.length <= 'Last: '.length + HEADLINE_CAP, `Last line is ${last.length} long`)
  assert.doesNotMatch(last, /[\r\n]/)
})

// ----------------------------------------------------------------- elapsed

test('orbElapsed: seconds, minutes and hours in the tiles format', () => {
  assert.equal(orbElapsed(45000), '45s')
  assert.equal(orbElapsed(185000), '3m 05s')
  assert.equal(orbElapsed(3720000), '1h 02m')
})

test('orbElapsed: negative and NaN read 0s', () => {
  assert.equal(orbElapsed(-5000), '0s')
  assert.equal(orbElapsed(NaN), '0s')
})
