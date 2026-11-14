// The HUD's layout rules for every team size: the agent tiles (tileLayout,
// hermes-mcp/tiles.mjs) and the orbs' names (orbLayout/orbBox,
// hermes-mcp/orbs.mjs), from 1 agent to 12 and past it (13, 16), at 1920x1080
// and 1366x768. Pure functions only: the tiles are stacked here from the
// heights the CSS gives them (index.css .tiles*), as the browser would.
// scripts/roster-shots.mjs checks the same rules on the real page.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tileLayout, ringSize, LAYOUT } from '../hermes-mcp/tiles.mjs'
import { ORBS, orbLayout, orbPoint, orbFit, orbProject, orbBox } from '../hermes-mcp/orbs.mjs'

const SIZES = [[1920, 1080], [1366, 768]]
const COUNTS = [...Array.from({ length: 12 }, (_, i) => i + 1), 13, 16]
const DEG = Math.PI / 180
const NAMES = ['Researcher', 'Data Analyst', 'Shop Lead', 'Writer', 'Ops', 'Inbox Triage', 'Designer', 'Coder',
  'Finance Desk', 'QA', 'Social Media', 'Travel Planner', 'Legal Reader', 'Scout', 'Support Desk', 'Editor']
/** The longest name the roster may hold (toAgent caps names at 40). */
const LONGEST = 'W'.repeat(40)

const overlap = (a, b) => Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0
const inside = (b, w, h) => b.left >= 0 && b.top >= 0 && b.right <= w && b.bottom <= h
const fmt = (b) => `[${b.left.toFixed(0)},${b.top.toFixed(0)} ${b.right.toFixed(0)},${b.bottom.toFixed(0)}]`
function intoCircle(b, cx, cy, r) {
  const x = Math.max(b.left, Math.min(cx, b.right))
  const y = Math.max(b.top, Math.min(cy, b.bottom))
  return Math.hypot(x - cx, y - cy) < r
}

/**
 * Every tile's box for a layout, stacked the way index.css stacks them:
 * columns at EDGE from TOP to height - BOTTOM, a full tile at least
 * MIN_FULL_TILE tall and a compact one 44px with its gap; column/strip 38px
 * from the edge, 100px to height - 256, 44px (compact) or 32px (chip) a tile.
 */
function tileBoxes(w, h, l) {
  const cols = l.mode === 'columns'
  const edge = cols ? LAYOUT.EDGE : 38
  const top = cols ? LAYOUT.TOP : 100
  const bottom = cols ? h - LAYOUT.BOTTOM : h - 256
  const step = cols ? (l.compact ? 44 : LAYOUT.MIN_FULL_TILE) : l.mode === 'column' ? 44 : 32
  const gap = l.mode === 'strip' ? 2 : 4
  const out = []
  const stack = (count, left, side) => {
    for (let i = 0; i < count; i++) {
      const y = top + i * step
      out.push({ side, i, column: { top, bottom }, box: { left, right: left + l.tileWidth, top: y, bottom: y + step - gap } })
    }
  }
  stack(l.left, edge, 'left')
  stack(l.right, w - edge - l.tileWidth, 'right')
  return out
}

for (const [w, h] of SIZES) {
  const size = `${w}x${h}`
  test(`tileLayout at ${size}: every count keeps every tile on screen, apart, and out of the core ring`, () => {
    const r = ringSize(w, h) / 2
    for (const n of COUNTS) {
      const l = tileLayout(w, h, n)
      const at = `${n} agents at ${size} (${l.mode}${l.left ? `, ${l.left} left` : ''})`
      assert.equal(l.left + l.right, n, `${at}: count preserved`)
      assert.ok(l.left >= l.right || l.left === 0, `${at}: the left column holds the extra tile`)
      const tiles = tileBoxes(w, h, l)
      assert.equal(tiles.length, n)
      for (const t of tiles) {
        assert.ok(inside(t.box, w, h), `${at}: ${t.side} tile ${t.i} ${fmt(t.box)} leaves the viewport`)
        assert.ok(t.box.bottom <= t.column.bottom, `${at}: ${t.side} tile ${t.i} ends at ${t.box.bottom}, past its column's end ${t.column.bottom} (it would scroll away)`)
        assert.ok(!intoCircle(t.box, w / 2, h / 2, r), `${at}: ${t.side} tile ${t.i} ${fmt(t.box)} reaches into the core ring (r ${r.toFixed(0)})`)
      }
      for (let i = 0; i < tiles.length; i++)
        for (let j = i + 1; j < tiles.length; j++)
          assert.ok(!overlap(tiles[i].box, tiles[j].box), `${at}: tiles ${fmt(tiles[i].box)} and ${fmt(tiles[j].box)} overlap`)
    }
  })
}

test('tileLayout: 4 to 6 agents at 1920x1080 keep the full two-column look', () => {
  for (const n of [4, 5, 6]) {
    const l = tileLayout(1920, 1080, n)
    assert.deepEqual(l, { mode: 'columns', left: Math.ceil(n / 2), right: n - Math.ceil(n / 2), compact: false, tileWidth: 384 })
  }
})

test('tileLayout: 1366x768 holds 12 chips in one column, then opens a left column', () => {
  assert.deepEqual(tileLayout(1366, 768, 12), { mode: 'strip', left: 0, right: 12, compact: true, tileWidth: 280 })
  assert.deepEqual(tileLayout(1366, 768, 13), { mode: 'column', left: 7, right: 6, compact: true, tileWidth: 280 })
  assert.deepEqual(tileLayout(1366, 768, 16), { mode: 'column', left: 8, right: 8, compact: true, tileWidth: 280 })
})

/** Every name box at one ring turn (degrees); odd rings turn the other way. */
function nameBoxes(names, w, h, turn) {
  const slots = orbLayout(names.length)
  const fit = orbFit(w, h)
  return slots.map((s, i) => {
    const angle = (s.phase + turn * (s.speed / ORBS.SPEED)) * DEG
    const p = orbProject(orbPoint(s, angle, fit), w, h)
    return { name: names[i], box: orbBox(names[i], p.x, p.y, w, h, p.scale) }
  })
}

function namesClear(names, w, h) {
  const n = names.length
  const l = tileLayout(w, h, n)
  const tiles = tileBoxes(w, h, l)
  for (let turn = 0; turn < 360; turn += 1) {
    const boxes = nameBoxes(names, w, h, turn)
    const at = `${n} agents at ${w}x${h}, turn ${turn}deg`
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++)
        assert.ok(!overlap(boxes[i].box, boxes[j].box), `${at}: names ${boxes[i].name} and ${boxes[j].name} overlap`)
      for (const t of tiles) assert.ok(!overlap(boxes[i].box, t.box), `${at}: name ${boxes[i].name} ${fmt(boxes[i].box)} under a tile ${fmt(t.box)}`)
    }
  }
}

test('orb names: 1 to 12 agents never overlap each other or a tile, at 1920x1080 and 1366x768', () => {
  for (const [w, h] of SIZES)
    for (let n = 1; n <= 12; n++) {
      namesClear(NAMES.slice(0, n), w, h)
      namesClear(Array(n).fill(LONGEST), w, h)
    }
})

test('orb names: one ring holds up to 16 at 1920x1080 without overlaps', () => {
  for (const n of [13, 14, 15, 16]) {
    assert.equal(new Set(orbLayout(n).map((s) => s.ring)).size, 1, `${n} agents on one ring`)
    namesClear(NAMES.slice(0, n), 1920, 1080)
  }
})

test('orbBox: a name longer than NAME_CHARS takes the width of NAME_CHARS characters', () => {
  const a = orbBox('A'.repeat(ORBS.NAME_CHARS), 500, 500, 1920, 1080)
  const b = orbBox(LONGEST, 500, 500, 1920, 1080)
  assert.deepEqual(a, b)
  assert.ok(orbBox('QA', 500, 500, 1920, 1080).right < a.right)
})
